// Shared alert delivery for the monitoring sections (Cloudflare, Microsoft Email Services):
// each user gets an alert the way they chose (users.notify_channels): popup (a notifications
// row of the given type, shown under "Alerts" in the bell), email (black-and-white branded,
// sendMail -> email_log) and desktop (Web Push).
const { pool } = require('../db');
const { channelsOf } = require('./notify');
const { pushToUser } = require('./push');

const mailer = () => require('./mailer'); // eslint-disable-line global-require
const USER_SQL = "SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, u.username, u.notify_channels FROM users u";

// The users chosen in a section's settings: alert_users "all" (default) or a comma list of ids.
async function chosenUsers(alertUsers, db = pool) {
  const [users] = await db.query(`${USER_SQL} ORDER BY name`);
  if (String(alertUsers || 'all') === 'all') return users;
  const ids = new Set(String(alertUsers).split(',').map(Number).filter(Boolean));
  return users.filter((u) => ids.has(u.id));
}

// Black-and-white branded email. rows: [[label, value]]; link: a portal path.
function brandedEmail({ section, subject, heading, rows = [], link, buttonText = 'Open in the portal' }) {
  const { escapeHtml: e, appUrl } = mailer();
  const base = appUrl();
  const url = base && link ? `${base}${link}` : '';
  const font = 'font-family: Arial, Helvetica, sans-serif;';
  const rowHtml = rows.map(([label, value]) => `<tr><td style="${font} padding: 5px 12px 5px 0; color: #5C5C66; font-size: 13px; vertical-align: top; white-space: nowrap;">${e(label)}</td>`
    + `<td style="${font} padding: 5px 0; color: #0B0B0F; font-size: 14px;">${e(value)}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin: 0; padding: 0; background: #E7E8EC;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #E7E8EC; padding: 24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; background: #FFFFFF; border: 1px solid #E4E5EA; border-radius: 18px; overflow: hidden;">
<tr><td style="${font} background: #0B0B0F; color: #FFFFFF; padding: 18px 24px; font-size: 16px; font-weight: bold;">Cleartwo <span style="color: #D5D6DC; font-weight: normal;">IT Support</span></td></tr>
<tr><td style="padding: 24px;">
<p style="${font} margin: 0 0 6px; color: #5C5C66; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">${e(section)}</p>
<p style="${font} margin: 0 0 16px; color: #0B0B0F; font-size: 19px; font-weight: bold; line-height: 1.35;">${e(heading)}</p>
${rowHtml ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 20px;">${rowHtml}</table>` : ''}
${url ? `<a href="${e(url)}" style="${font} display: inline-block; background: #0B0B0F; color: #FFFFFF; text-decoration: none; font-weight: bold; font-size: 14px; padding: 12px 22px; border-radius: 999px;">${e(buttonText)}</a>` : ''}
</td></tr></table>
<p style="${font} color: #5C5C66; font-size: 12px; margin: 14px 0 0;">You get this because you receive ${e(section)} alerts in the IT Support portal.</p>
</td></tr></table></body></html>`;
  const text = [heading, '', ...rows.map(([l, v]) => `${l}: ${v}`), url ? `\n${buttonText}: ${url}` : ''].join('\n');
  return { subject: subject.replace(/\s+/g, ' ').slice(0, 200), html, text };
}

// Sends one alert to each user by their channels. Returns the names reached.
async function deliver(users, { type, title, body, link, email, tag }) {
  const { mailStatus, sendMail, logSkipped, userEmail } = mailer();
  const mailOn = mailStatus().enabled;
  const reached = [];
  for (const u of users) {
    const ch = channelsOf(u);
    let any = false;
    if (ch.has('popup')) {
      await pool.query("INSERT INTO notifications (user_id, channel, type, title, body, link) VALUES (?, 'portal', ?, ?, ?, ?)",
        [u.id, type, title.slice(0, 255), String(body || '').slice(0, 500), link]);
      any = true;
    }
    if (ch.has('email') && email && mailOn) {
      const to = userEmail(u);
      const meta = { kind: type, userId: u.id };
      if (to) { await sendMail({ to, ...email }, meta); any = true; } else await logSkipped({ to: u.username, ...email }, meta, 'This user has no email address (their username is not an email address).');
    }
    if (ch.has('desktop') && await pushToUser(u.id, { title, body, url: link, tag }).catch(() => 0)) any = true;
    if (any) reached.push(u.name);
  }
  return reached;
}

module.exports = { chosenUsers, brandedEmail, deliver };
