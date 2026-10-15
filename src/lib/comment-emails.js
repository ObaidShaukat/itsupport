// Emails for ticket comments, sent after the comment is saved, one email per recipient via
// the SMTP mailer (every attempt in email_log):
//   - a new comment: every admin (all portal users are admins) except the author gets
//     "New comment on #{id} {title} ({client})": author, time, the comment, its attachments,
//     the ticket status / priority and an Open ticket button;
//   - a person @mentioned in it (from the mention picker, stored in comment_mentions) gets ONE
//     email instead, "{Author} mentioned you on #{id} {title}", with the mention highlighted
//     at the top;
//   - an edited comment only emails the people newly mentioned in it.
// Emails always go, whatever the user's notification preference; the bell (popup) and
// desktop notifications for mentions follow it (recordMentions / pushMentionsTo).
const { pool } = require('../db');
const { TICKET_STATUSES, TICKET_PRIORITIES } = require('./tickets');
const { channelsOf } = require('./notify');
const { formattersFor } = require('./dates');

const mailer = () => require('./mailer'); // eslint-disable-line global-require
const FONT = 'font-family: Arial, Helvetica, sans-serif;';
const ukTime = (d) => formattersFor('d_mon_yyyy').fmtDate(d);
const sizeText = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Admins who get comment emails (everyone except the author).
async function commentRecipients(db, authorId) {
  const [users] = await db.query(`
    SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, u.username, u.notify_channels
    FROM users u WHERE u.role = 'admin' AND u.id <> ? ORDER BY name
  `, [authorId]);
  return users;
}

// The comment as HTML (escaped, line breaks kept) with "@Name" of the mentioned people
// highlighted; the recipient's own mention stands out most.
function commentHtml(body, mentionedNames, youName) {
  const { escapeHtml: e } = mailer();
  let html = e(body || '');
  const marks = [];
  for (const name of [...new Set(mentionedNames)].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[\\s(\\[{"';])(@${escapeRegex(e(name))})(?![\\p{L}\\p{N}_])`, 'gu');
    html = html.replace(re, (m, before, at) => {
      const you = name === youName;
      marks.push(`<span style="background: ${you ? '#6741C3' : '#EDE7FB'}; color: ${you ? '#FFFFFF' : '#6741C3'}; font-weight: bold; padding: 0 3px; border-radius: 4px;">${at}</span>`);
      return `${before}\u0000${marks.length - 1}\u0000`;
    });
  }
  return html.replace(/\u0000(\d+)\u0000/g, (m, i) => marks[Number(i)]).replace(/\n/g, '<br>');
}

// One email: { subject, html, text }. mentionOf = the recipient's name when they were mentioned.
function buildEmail({ ticket, author, comment, files, mentionedNames, mentionOf }) {
  const { escapeHtml: e, appUrl } = mailer();
  const base = appUrl();
  const link = base ? `${base}/tickets/${ticket.id}#comment-${comment.id}` : '';
  const when = ukTime(comment.created_at || new Date());
  const status = TICKET_STATUSES[ticket.status] || ticket.status || '';
  const priority = TICKET_PRIORITIES[ticket.priority] || ticket.priority || '';
  const subject = (mentionOf
    ? `${author.name} mentioned you on #${ticket.id} ${ticket.title}`
    : `New comment on #${ticket.id} ${ticket.title} (${ticket.client_name})`).replace(/\s+/g, ' ').slice(0, 200);
  const row = (label, value) => `<tr><td style="${FONT} padding: 5px 12px 5px 0; color: #6E6E73; font-size: 13px; vertical-align: top; white-space: nowrap;">${label}</td>`
    + `<td style="${FONT} padding: 5px 0; color: #000000; font-size: 14px;">${value}</td></tr>`;
  const bodyHtml = comment.body ? commentHtml(comment.body, mentionedNames, mentionOf) : '<span style="color: #6E6E73;">(No text: attachments only.)</span>';
  const filesHtml = files.length
    ? `<p style="${FONT} margin: 0 0 6px; color: #6E6E73; font-size: 13px;">Attachments (${files.length})</p>
<ul style="${FONT} margin: 0 0 18px; padding-left: 18px; font-size: 14px; color: #000000;">${files.map((f) => `<li>${e(f.original_name)} <span style="color: #6E6E73;">(${sizeText(f.size_bytes)})</span></li>`).join('')}</ul>`
    : '';
  const top = mentionOf
    ? `<p style="${FONT} margin: 0 0 6px; color: #6741C3; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">You were mentioned</p>
<p style="${FONT} margin: 0 0 14px; color: #200D6C; font-size: 18px; font-weight: bold; line-height: 1.35;">${e(author.name)} mentioned you on #${ticket.id} ${e(ticket.title)}</p>
<div style="${FONT} margin: 0 0 18px; padding: 14px 16px; background: #F3EFFC; border-left: 4px solid #6741C3; border-radius: 6px; font-size: 14px; line-height: 1.5; color: #000000;">${bodyHtml}</div>`
    : `<p style="${FONT} margin: 0 0 6px; color: #6741C3; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">New comment</p>
<p style="${FONT} margin: 0 0 14px; color: #200D6C; font-size: 18px; font-weight: bold; line-height: 1.35;">#${ticket.id} ${e(ticket.title)}</p>
<div style="${FONT} margin: 0 0 18px; padding: 12px 14px; background: #F5F5F7; border-left: 3px solid #0390D7; border-radius: 6px; font-size: 14px; line-height: 1.5; color: #000000;">${bodyHtml}</div>`;
  const html = `<!doctype html><html><body style="margin: 0; padding: 0; background: #F5F5F7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #F5F5F7; padding: 24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; overflow: hidden;">
<tr><td style="${FONT} background: #200D6C; color: #FFFFFF; padding: 18px 24px; font-size: 16px; font-weight: bold;">Cleartwo <span style="color: #B9A6F0; font-weight: normal;">IT Support</span></td></tr>
<tr><td style="padding: 24px;">
${top}
${filesHtml}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 20px;">
${row('By', e(author.name))}
${row('When', e(when))}
${row('Client', e(ticket.client_name))}
${row('Ticket', `#${ticket.id} ${e(ticket.title)}`)}
${row('Status', e(status))}
${row('Priority', e(priority))}
</table>
${link
    ? `<a href="${e(link)}" style="${FONT} display: inline-block; background: #0390D7; color: #FFFFFF; text-decoration: none; font-weight: bold; font-size: 14px; padding: 12px 22px; border-radius: 999px;">Open ticket #${ticket.id}</a>`
    : `<p style="${FONT} margin: 0; font-size: 14px;">Open ticket #${ticket.id} in the IT Support portal.</p>`}
</td></tr></table>
<p style="${FONT} color: #6E6E73; font-size: 12px; margin: 14px 0 0;">You get this because you are an IT Support portal user.</p>
</td></tr></table></body></html>`;
  const text = [
    mentionOf ? `${author.name} mentioned you on #${ticket.id} ${ticket.title}` : `New comment on #${ticket.id} ${ticket.title} (${ticket.client_name})`,
    '', comment.body || '(No text: attachments only.)',
    ...(files.length ? ['', 'Attachments:', ...files.map((f) => `- ${f.original_name} (${sizeText(f.size_bytes)})`)] : []),
    '', `By: ${author.name}`, `When: ${when}`, `Client: ${ticket.client_name}`, `Status: ${status}`, `Priority: ${priority}`,
    link ? `\nOpen the ticket: ${link}` : '',
  ].join('\n');
  return { subject, html, text };
}

// After the comment is saved. isNew: a new comment (everyone except the author); otherwise
// an edit (only newly mentioned people). notify: the newly mentioned users (never the author).
async function sendCommentEmails({ ticket, author, comment, files = [], mentionedNames = [], notify = [], isNew }) {
  const { mailStatus, sendMail, logSkipped, userEmail } = mailer();
  const mentionedIds = new Set(notify.map((u) => u.id));
  const recipients = isNew ? await commentRecipients(pool, author.id) : notify;
  // Newly mentioned people who are not admins still get their mention email.
  if (isNew) for (const u of notify) if (!recipients.some((r) => r.id === u.id)) recipients.push(u);
  const status = mailStatus();
  let sent = 0;
  for (const u of recipients) {
    if (u.id === author.id) continue;
    const mention = mentionedIds.has(u.id);
    const message = buildEmail({ ticket, author, comment, files, mentionedNames, mentionOf: mention ? u.name : null });
    const meta = { kind: mention ? 'mention' : 'comment', userId: u.id };
    const to = userEmail(u);
    if (!to) {
      await logSkipped({ ...message, to: u.username }, meta, 'This user has no email address (their username is not an email address).');
      continue;
    }
    if (!status.enabled) {
      await logSkipped({ ...message, to }, meta, status.message);
      continue;
    }
    const r = await sendMail({ ...message, to }, meta);
    if (r.ok) sent += 1;
  }
  return sent;
}

// Desktop notifications for the newly mentioned people who want them.
async function pushMentionsTo({ users, author, ticket, body, commentId }) {
  const { pushToUsers } = require('./push'); // eslint-disable-line global-require
  const ids = users.filter((u) => channelsOf(u).has('desktop')).map((u) => u.id);
  if (!ids.length) return;
  await pushToUsers(ids, {
    title: `${author.name} mentioned you on #${ticket.id} ${ticket.title}`,
    body: body || 'Open the ticket to see the comment.',
    url: `/tickets/${ticket.id}#comment-${commentId}`,
    tag: `mention-${commentId}`,
  });
}

module.exports = { sendCommentEmails, pushMentionsTo, buildEmail, commentHtml, commentRecipients };
