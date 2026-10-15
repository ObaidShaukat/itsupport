// @mentions in ticket comments. The comment box offers portal users after "@" and inserts
// "@Display Name"; the picker also posts the picked user ids (mention_ids). On save a user is
// mentioned only when they were picked (or were already mentioned in that comment) AND their
// "@Name" is still in the text at the start or after a space / bracket / quote, so an "@"
// inside an email address is never a mention. Mentions are stored in comment_mentions; each
// newly mentioned user (except the author) gets a bell notification when their preference
// includes popup, and one email (src/lib/comment-emails.js). Comments show mentions
// highlighted (mentionHtml).
const { pool } = require('../db');

const USER_NAME = "COALESCE(NULLIF(u.display_name, ''), u.username)";
const escapeHtml = (text) => String(text == null ? '' : text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "@Name" at the start or after a space / bracket / quote (so not an email address), and
// not followed by another letter or digit. ";" allows the escaped quotes in mentionHtml.
const mentionPattern = (name, flags = 'giu') => new RegExp(`(?<![^\\s(\\[{"';])@${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, flags);

async function mentionUsers(db = pool) {
  const [users] = await db.query(`SELECT u.id, ${USER_NAME} AS name, u.username, u.notify_channels FROM users u ORDER BY name`);
  return users;
}

// Users mentioned in a comment text.
function findMentioned(text, users) {
  let rest = String(text || '');
  const found = [];
  for (const u of [...users].sort((a, b) => b.name.length - a.name.length)) {
    const re = mentionPattern(u.name);
    if (re.test(rest)) {
      found.push(u);
      rest = rest.replace(mentionPattern(u.name), ' ');
    }
  }
  return found;
}

// Escaped comment text with the given names' mentions wrapped in <span class="mention">.
function mentionHtml(text, names = []) {
  let html = escapeHtml(text);
  const marks = [];
  for (const name of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    html = html.replace(mentionPattern(escapeHtml(name)), (m) => {
      marks.push(`<span class="mention">${m}</span>`);
      return `\u0000${marks.length - 1}\u0000`;
    });
  }
  return html.replace(/\u0000(\d+)\u0000/g, (m, i) => marks[Number(i)]);
}

// Names mentioned in each of the given comments: Map commentId -> [name].
async function mentionNames(db, commentIds) {
  const out = new Map(commentIds.map((id) => [id, []]));
  if (!commentIds.length) return out;
  const [rows] = await db.query(`
    SELECT cm.comment_id, ${USER_NAME} AS name FROM comment_mentions cm JOIN users u ON u.id = cm.user_id WHERE cm.comment_id IN (?)
  `, [commentIds]);
  for (const r of rows) out.get(r.comment_id).push(r.name);
  return out;
}

// Picked user ids from the form ("3,7" or several fields), as numbers.
const pickedIds = (value) => [...new Set([].concat(value || []).join(',').split(',').map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];

// Inside the comment transaction (new or edited comment): stores the mentions and a bell
// notification (popup preference) for each newly mentioned user. picked: the ids the
// mention picker posted. Returns { mentioned, notify }: notify is who to email / push (newly
// mentioned, never the author). On an edit, people who were already mentioned are not
// notified again and removed mentions are dropped.
async function recordMentions(conn, { commentId, ticket, author, body, picked = [] }) {
  const [before] = await conn.query('SELECT user_id FROM comment_mentions WHERE comment_id = ?', [commentId]);
  const already = new Set(before.map((r) => r.user_id));
  const allowed = new Set([...pickedIds(picked), ...already]);
  const users = findMentioned(body, (await mentionUsers(conn)).filter((u) => allowed.has(u.id)));
  const keep = new Set(users.map((u) => u.id));
  const gone = [...already].filter((id) => !keep.has(id));
  if (gone.length) await conn.query('DELETE FROM comment_mentions WHERE comment_id = ? AND user_id IN (?)', [commentId, gone]);
  for (const u of users) await conn.query('INSERT IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?, ?)', [commentId, u.id]);
  const others = users.filter((u) => u.id !== author.id && !already.has(u.id));
  const title = `${author.name} mentioned you on #${ticket.id} ${ticket.title}`.slice(0, 255);
  const { channelsOf } = require('./notify'); // eslint-disable-line global-require
  for (const u of others.filter((x) => channelsOf(x).has('popup'))) {
    await conn.query(
      "INSERT INTO notifications (user_id, channel, type, title, body, link) VALUES (?, 'portal', 'mention', ?, ?, ?)",
      [u.id, title, String(body).replace(/\s+/g, ' ').slice(0, 300), `/tickets/${ticket.id}#comment-${commentId}`]
    );
  }
  return { mentioned: users, notify: others };
}

module.exports = { mentionUsers, findMentioned, mentionHtml, mentionNames, recordMentions, pickedIds };
