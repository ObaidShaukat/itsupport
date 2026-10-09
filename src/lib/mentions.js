// @mentions in ticket comments. The comment box offers portal users after "@" and inserts
// "@Display Name"; on save the server finds every "@Name" of a portal user in the text
// (longest names first, so "@Ali Khan" is not also "@Ali"), stores them in
// comment_mentions, gives each mentioned user (except the author) a bell notification
// and emails them. Comments show mentions highlighted (mentionHtml).
const { pool } = require('../db');

const USER_NAME = "COALESCE(NULLIF(u.display_name, ''), u.username)";
const escapeHtml = (text) => String(text == null ? '' : text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "@Name" at the start or after a space / bracket / quote (so not an email address), and
// not followed by another letter or digit. ";" allows the escaped quotes in mentionHtml.
const mentionPattern = (name, flags = 'giu') => new RegExp(`(?<![^\\s(\\[{"';])@${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, flags);

async function mentionUsers(db = pool) {
  const [users] = await db.query(`SELECT u.id, ${USER_NAME} AS name, u.username FROM users u ORDER BY name`);
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

// Inside the comment transaction: stores the mentions and the bell notifications.
// Returns the users to email (everyone mentioned except the author).
async function recordMentions(conn, { commentId, ticket, author, body }) {
  const users = findMentioned(body, await mentionUsers(conn));
  for (const u of users) await conn.query('INSERT IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?, ?)', [commentId, u.id]);
  const others = users.filter((u) => u.id !== author.id);
  const title = `${author.name} mentioned you on #${ticket.id} ${ticket.title}`.slice(0, 255);
  for (const u of others) {
    await conn.query(
      "INSERT INTO notifications (user_id, channel, type, title, body, link) VALUES (?, 'portal', 'mention', ?, ?, ?)",
      [u.id, title, String(body).replace(/\s+/g, ' ').slice(0, 300), `/tickets/${ticket.id}#comment-${commentId}`]
    );
  }
  return { mentioned: users, notify: others };
}

function mentionEmail({ author, ticket, body, commentId }) {
  const { escapeHtml: e, appUrl } = require('./mailer'); // eslint-disable-line global-require
  const base = appUrl();
  const link = base ? `${base}/tickets/${ticket.id}#comment-${commentId}` : '';
  const subject = `${author.name} mentioned you on #${ticket.id} ${ticket.title}`.replace(/\s+/g, ' ').slice(0, 200);
  const font = 'font-family: Arial, Helvetica, sans-serif;';
  const row = (label, value) => `<tr><td style="${font} padding: 6px 12px 6px 0; color: #6E6E73; font-size: 13px; vertical-align: top; white-space: nowrap;">${label}</td>`
    + `<td style="${font} padding: 6px 0; color: #000000; font-size: 14px;">${value}</td></tr>`;
  const html = `<!doctype html><html><body style="margin: 0; padding: 0; background: #F5F5F7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #F5F5F7; padding: 24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; overflow: hidden;">
<tr><td style="${font} background: #200D6C; color: #FFFFFF; padding: 18px 24px; font-size: 16px; font-weight: bold;">Cleartwo <span style="color: #B9A6F0; font-weight: normal;">IT Support</span></td></tr>
<tr><td style="padding: 24px;">
<p style="${font} margin: 0 0 6px; color: #6741C3; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">You were mentioned</p>
<p style="${font} margin: 0 0 16px; color: #200D6C; font-size: 18px; font-weight: bold; line-height: 1.35;">${e(author.name)} mentioned you on #${ticket.id} ${e(ticket.title)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 16px;">
${row('Client', e(ticket.client_name))}
${row('Ticket', `#${ticket.id} ${e(ticket.title)}`)}
</table>
<div style="${font} margin: 0 0 22px; padding: 12px 14px; background: #F5F5F7; border-left: 3px solid #6741C3; border-radius: 6px; font-size: 14px; color: #000000; white-space: pre-line;">${e(body)}</div>
${link
    ? `<a href="${e(link)}" style="${font} display: inline-block; background: #0390D7; color: #FFFFFF; text-decoration: none; font-weight: bold; font-size: 14px; padding: 12px 22px; border-radius: 999px;">Open ticket #${ticket.id}</a>`
    : `<p style="${font} margin: 0; font-size: 14px;">Open ticket #${ticket.id} in the IT Support portal.</p>`}
</td></tr>
</table>
</td></tr></table></body></html>`;
  const text = [`${author.name} mentioned you on #${ticket.id} ${ticket.title}`, '', `Client: ${ticket.client_name}`, '', body, link ? `\nOpen the ticket: ${link}` : ''].join('\n');
  return { subject, html, text };
}

// After the comment is saved: one email per mentioned user (From: MAIL_FROM). Problems
// are logged in email_log and never break the comment.
async function emailMentions({ users, author, ticket, body, commentId }) {
  const { mailStatus, sendMail, logSkipped, userEmail } = require('./mailer'); // eslint-disable-line global-require
  if (!users.length || !mailStatus().enabled) return;
  const message = mentionEmail({ author, ticket, body, commentId });
  for (const u of users) {
    const to = userEmail(u);
    const meta = { kind: 'mention', userId: u.id };
    if (!to) {
      await logSkipped({ ...message, to: u.username }, meta, 'This user has no email address (their username is not an email address).');
      continue;
    }
    await sendMail({ ...message, to }, meta);
  }
}

module.exports = { mentionUsers, findMentioned, mentionHtml, mentionNames, recordMentions, emailMentions, mentionEmail };
