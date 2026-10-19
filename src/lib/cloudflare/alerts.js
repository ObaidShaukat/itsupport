// Cloudflare alerts: one per event (domain_events.alerted_at), to the users chosen in
// Cloudflare settings (default everyone), by each user's own preference: popup (bell,
// notifications type 'cloudflare'), email and desktop (Web Push). Hidden domains never
// alert. Events that are not alerts (moved, re_added, back_to_cloudflare) are only marked.
//   ns_changed  "{domain} stopped using Cloudflare nameservers: now {provider} ({nameservers})"
//   deleted     "{domain} was removed from Cloudflare on {date} by {who}"
//   expiring    "{domain} expires in {n} days"      expired  "{domain} has expired"
//   access_lost "Lost access to Cloudflare account {name}"
// Every alert sent is logged (entity_type 'cloudflare', action 'sent'), never on the Daily Report.
const { pool } = require('../../db');
const { logActivity } = require('../activity');
const { channelsOf } = require('../notify');
const { pushToUser } = require('../push');
const { getSettings } = require('./data');
const { providersLabel } = require('./lookups');

const mailer = () => require('../mailer'); // eslint-disable-line global-require
const ukDay = (d) => require('../dates').formattersFor('d_mon_yyyy').fmtDay(d); // eslint-disable-line global-require
const USER_SQL = "SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, u.username, u.notify_channels FROM users u";
const ALERT_TYPES = new Set(['ns_changed', 'deleted', 'expiring', 'expired', 'access_lost']);

async function alertUsers(db = pool) {
  const s = await getSettings(db);
  const [users] = await db.query(`${USER_SQL} ORDER BY name`);
  if (String(s.alert_users || 'all') === 'all') return users;
  const ids = new Set(String(s.alert_users).split(',').map(Number).filter(Boolean));
  return users.filter((u) => ids.has(u.id));
}

// Black-and-white branded email.
function alertEmail({ subject, heading, rows = [], link, buttonText = 'Open in the portal' }) {
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
<p style="${font} margin: 0 0 6px; color: #5C5C66; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Cloudflare</p>
<p style="${font} margin: 0 0 16px; color: #0B0B0F; font-size: 19px; font-weight: bold; line-height: 1.35;">${e(heading)}</p>
${rowHtml ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 20px;">${rowHtml}</table>` : ''}
${url ? `<a href="${e(url)}" style="${font} display: inline-block; background: #0B0B0F; color: #FFFFFF; text-decoration: none; font-weight: bold; font-size: 14px; padding: 12px 22px; border-radius: 999px;">${e(buttonText)}</a>` : ''}
</td></tr></table>
<p style="${font} color: #5C5C66; font-size: 12px; margin: 14px 0 0;">You get this because you receive Cloudflare alerts in the IT Support portal.</p>
</td></tr></table></body></html>`;
  const text = [heading, '', ...rows.map(([l, v]) => `${l}: ${v}`), url ? `\n${buttonText}: ${url}` : ''].join('\n');
  return { subject: subject.replace(/\s+/g, ' ').slice(0, 200), html, text };
}

async function deliver(users, { title, body, link, email, tag }) {
  const { mailStatus, sendMail, logSkipped, userEmail } = mailer();
  const mailOn = mailStatus().enabled;
  const reached = [];
  for (const u of users) {
    const ch = channelsOf(u);
    let any = false;
    if (ch.has('popup')) {
      await pool.query("INSERT INTO notifications (user_id, channel, type, title, body, link) VALUES (?, 'portal', 'cloudflare', ?, ?, ?)",
        [u.id, title.slice(0, 255), String(body || '').slice(0, 500), link]);
      any = true;
    }
    if (ch.has('email') && email && mailOn) {
      const to = userEmail(u);
      const meta = { kind: 'cloudflare', userId: u.id };
      if (to) { await sendMail({ to, ...email }, meta); any = true; } else await logSkipped({ to: u.username, ...email }, meta, 'This user has no email address (their username is not an email address).');
    }
    if (ch.has('desktop') && await pushToUser(u.id, { title, body, url: link, tag }).catch(() => 0)) any = true;
    if (any) reached.push(u.name);
  }
  return reached;
}

const parse = (t) => { try { return JSON.parse(t || '{}') || {}; } catch (err) { return {}; } };

// The message for one event row (joined with its domain / account).
function message(ev) {
  const d = parse(ev.details);
  const name = ev.domain_name;
  const where = ev.domain_id ? `/cloudflare/domains/${ev.domain_id}` : '/cloudflare/accounts';
  const rows = [
    ...(name ? [['Domain', name]] : []),
    ...(ev.account_name ? [['Cloudflare account', ev.account_name]] : []),
    ...(ev.client_name ? [['Portal client', ev.client_name]] : []),
  ];
  if (ev.type === 'ns_changed') {
    const list = (d.new || []).join(', ');
    const title = d.new && d.new.length
      ? `${name} stopped using Cloudflare nameservers: now ${providersLabel(d.new)} (${list})`
      : `${name} stopped using Cloudflare nameservers: no nameservers found`;
    return { title, link: where, rows: [...rows, ['Now', list || 'none'], ['Cloudflare\'s', (d.assigned || []).join(', ')]] };
  }
  if (ev.type === 'deleted') {
    const when = d.at ? ukDay(d.at) : ukDay(ev.detected_at);
    return { title: `${name} was removed from Cloudflare on ${when} by ${d.by || 'someone (not in the audit log)'}`, link: where, rows: [...rows, ['Removed', when], ['By', d.by || 'Not known']] };
  }
  if (ev.type === 'expiring') {
    return { title: `${name} expires in ${d.days} day${d.days === 1 ? '' : 's'}`, link: where, rows: [...rows, ['Expires', ukDay(d.expires_on)]] };
  }
  if (ev.type === 'expired') return { title: `${name} has expired`, link: where, rows: [...rows, ['Expired', ukDay(d.expires_on)]] };
  return { title: `Lost access to Cloudflare account ${ev.account_name || d.account || ''}`.trim(), link: '/cloudflare/accounts', rows };
}

// Sends every event not alerted yet; returns how many alerts went out.
async function sendEventAlerts() {
  const [events] = await pool.query(`
    SELECT e.*, d.name AS domain_name, d.hidden_at, d.client_id, c.name AS client_name,
           COALESCE(a.name, da.name) AS account_name
    FROM domain_events e
    LEFT JOIN domains d ON d.id = e.domain_id
    LEFT JOIN clients c ON c.id = d.client_id
    LEFT JOIN cf_accounts a ON a.id = e.cf_account_id
    LEFT JOIN cf_accounts da ON da.id = d.cf_account_id
    WHERE e.alerted_at IS NULL
    ORDER BY e.id
  `);
  if (!events.length) return 0;
  const users = await alertUsers(pool);
  let sent = 0;
  for (const ev of events) {
    // Claim first, so two runs never send the same alert.
    const [claim] = await pool.query('UPDATE domain_events SET alerted_at = NOW() WHERE id = ? AND alerted_at IS NULL', [ev.id]);
    if (claim.affectedRows !== 1) continue;
    if (!ALERT_TYPES.has(ev.type) || ev.hidden_at || !users.length) continue;
    const m = message(ev);
    const email = alertEmail({ subject: `Cloudflare: ${m.title}`, heading: m.title, rows: m.rows, link: m.link, buttonText: ev.domain_id ? 'Open the domain' : 'Open Cloudflare accounts' });
    const reached = await deliver(users, { title: `Cloudflare: ${m.title}`, body: m.rows.map(([l, v]) => `${l}: ${v}`).join(' · '), link: m.link, email, tag: `cf-${ev.id}` });
    sent += 1;
    await logActivity(null, null, {
      type: 'cloudflare', id: ev.domain_id, action: 'sent', subject: 'Cloudflare', clientId: ev.client_id, clientName: ev.client_name,
      summary: `Cloudflare alert "${m.title}" sent to ${reached.join(', ') || 'nobody (no channel reached)'}`,
    }).catch((err) => console.error('Cloudflare log failed:', err.message));
  }
  return sent;
}

module.exports = { sendEventAlerts, alertUsers, message };
