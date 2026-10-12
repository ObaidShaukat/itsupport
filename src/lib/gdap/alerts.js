// GDAP alerts. Each goes once (gdap_alerts): per relationship at the alert days in
// settings (default 30, 14, 7 and 1) before the end date and when it has expired (can be
// turned off); hidden relationships never alert; the client secret 30 and 7 days before it
// expires; a failed sync once a day. Recipients follow their own notification
// preference: popup (bell, notifications type 'gdap'), email and desktop (Web Push).
// Expiry alerts go to the users chosen in GDAP settings (default: everyone); the secret
// and sync failure alerts go to admins. Every alert is logged (entity_type 'gdap',
// action 'sent'), never on the Daily Report.
const { pool } = require('../../db');
const { logActivity, londonDate } = require('../activity');
const { channelsOf } = require('../notify');
const { pushToUser } = require('../push');
const {
  getSettings, listRelationships, thresholdFor, LIVE,
} = require('./data');

const mailer = () => require('../mailer'); // eslint-disable-line global-require
const USER_SQL = "SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, u.username, u.notify_channels, u.date_format, u.role FROM users u";

// Users chosen for GDAP alerts ("all", or a comma list of ids).
async function alertUsers(db = pool, settings = null) {
  const s = settings || await getSettings(db);
  const [users] = await db.query(`${USER_SQL} ORDER BY name`);
  if (String(s.alert_users || 'all') === 'all') return users;
  const ids = new Set(String(s.alert_users).split(',').map(Number).filter(Boolean));
  return users.filter((u) => ids.has(u.id));
}

async function adminUsers(db = pool) {
  const [users] = await db.query(`${USER_SQL} WHERE u.role = 'admin' ORDER BY name`);
  return users;
}

// Records an alert key; false when it was already sent.
async function claim(db, key, threshold, endDate) {
  const [r] = await db.query('INSERT IGNORE INTO gdap_alerts (relationship_id, threshold, end_date) VALUES (?, ?, ?)', [key, threshold, endDate]);
  return r.affectedRows === 1;
}

// Branded email: heading, intro, rows (label/value), optional list, button to the page.
function alertEmail({ subject, heading, intro, rows = [], list = null, buttonText = 'Open Microsoft Partner' }) {
  const { escapeHtml: e, appUrl } = mailer();
  const base = appUrl();
  const link = base ? `${base}/microsoft-partner` : '';
  const font = 'font-family: Arial, Helvetica, sans-serif;';
  const rowHtml = rows.map(([label, value]) => `<tr><td style="${font} padding: 5px 12px 5px 0; color: #6E6E73; font-size: 13px; vertical-align: top; white-space: nowrap;">${e(label)}</td>`
    + `<td style="${font} padding: 5px 0; color: #000000; font-size: 14px;">${e(value)}</td></tr>`).join('');
  const listHtml = list ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 20px; border-collapse: collapse;">
<tr>${['Customer', 'End date', 'Days left', 'Auto-extend'].map((h) => `<th align="left" style="${font} font-size: 12px; color: #6E6E73; padding: 6px 8px; border-bottom: 1px solid #E5E5EA;">${h}</th>`).join('')}</tr>
${list.map((r) => `<tr>${[r.customer, r.end, r.days, r.extend].map((v, i) => `<td style="${font} font-size: 13px; padding: 6px 8px; border-bottom: 1px solid #F0F0F3; ${i === 2 ? `color: ${r.colour}; font-weight: bold;` : ''}">${e(v)}</td>`).join('')}</tr>`).join('')}
</table>` : '';
  const html = `<!doctype html><html><body style="margin: 0; padding: 0; background: #F5F5F7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #F5F5F7; padding: 24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; overflow: hidden;">
<tr><td style="${font} background: #200D6C; color: #FFFFFF; padding: 18px 24px; font-size: 16px; font-weight: bold;">Cleartwo <span style="color: #B9A6F0; font-weight: normal;">IT Support</span></td></tr>
<tr><td style="padding: 24px;">
<p style="${font} margin: 0 0 6px; color: #6741C3; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Microsoft Partner</p>
<p style="${font} margin: 0 0 12px; color: #200D6C; font-size: 19px; font-weight: bold; line-height: 1.35;">${e(heading)}</p>
${intro ? `<p style="${font} margin: 0 0 16px; color: #000000; font-size: 14px; line-height: 1.5;">${e(intro)}</p>` : ''}
${rowHtml ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 20px;">${rowHtml}</table>` : ''}
${listHtml}
${link ? `<a href="${e(link)}" style="${font} display: inline-block; background: #0390D7; color: #FFFFFF; text-decoration: none; font-weight: bold; font-size: 14px; padding: 12px 22px; border-radius: 999px;">${e(buttonText)}</a>` : `<p style="${font} margin: 0; font-size: 14px;">Open Microsoft Partner in the IT Support portal.</p>`}
</td></tr></table>
<p style="${font} color: #6E6E73; font-size: 12px; margin: 14px 0 0;">You get this because you receive Microsoft Partner (GDAP) alerts in the IT Support portal.</p>
</td></tr></table></body></html>`;
  const text = [heading, '', intro || '', ...rows.map(([l, v]) => `${l}: ${v}`),
    ...(list ? ['', ...list.map((r) => `- ${r.customer}: ends ${r.end} (${r.days}), auto-extend ${r.extend}`)] : []),
    link ? `\nOpen Microsoft Partner: ${link}` : ''].join('\n');
  return { subject: subject.replace(/\s+/g, ' ').slice(0, 200), html, text };
}

// Sends one alert to each user by their preference. email: { subject, html, text }.
async function deliver(users, { title, body, link, email, tag }) {
  const { mailStatus, sendMail, logSkipped, userEmail } = mailer();
  const mailOn = mailStatus().enabled;
  const reached = [];
  for (const u of users) {
    const ch = channelsOf(u);
    let any = false;
    if (ch.has('popup')) {
      await pool.query("INSERT INTO notifications (user_id, channel, type, title, body, link) VALUES (?, 'portal', 'gdap', ?, ?, ?)",
        [u.id, title.slice(0, 255), String(body || '').slice(0, 500), link]);
      any = true;
    }
    if (ch.has('email') && email && mailOn) {
      const to = userEmail(u);
      const meta = { kind: 'gdap', userId: u.id };
      if (to) { await sendMail({ to, ...email }, meta); any = true; } else await logSkipped({ to: u.username, ...email }, meta, 'This user has no email address (their username is not an email address).');
    }
    if (ch.has('desktop')) {
      if (await pushToUser(u.id, { title, body, url: link, tag }).catch(() => 0)) any = true;
    }
    if (any) reached.push(u.name);
  }
  return reached;
}

const log = (user, entry) => logActivity(null, user, { type: 'gdap', subject: 'Microsoft Partner', ...entry }).catch((err) => console.error('GDAP log failed:', err.message));
const fmtFor = (format) => require('../dates').formattersFor(format); // eslint-disable-line global-require
const ukDay = (d) => fmtFor('d_mon_yyyy').fmtDay(d);

// Expiry alerts for every live relationship that reached a threshold it has not had.
async function runExpiryAlerts() {
  const { rows, settings } = await listRelationships(pool);
  const users = await alertUsers(pool, settings);
  let sent = 0;
  for (const r of rows) {
    // Hidden relationships never alert.
    if (r.removed || r.hidden || !r.end_at || !LIVE.has(r.status)) continue;
    const t = thresholdFor(r, settings);
    if (t === null) continue;
    const endDate = londonDate(new Date(r.end_at));
    if (!(await claim(pool, r.relationship_id, t, endDate))) continue;
    const customer = r.customer_name || r.display_name || 'Unknown customer';
    const roles = r.roleList.map((x) => x.name).join(', ') || 'None';
    const subject = t === 0 ? `Microsoft Partner: GDAP expired: ${customer}` : `Microsoft Partner: GDAP expiring in ${r.days} day${r.days === 1 ? '' : 's'}: ${customer}`;
    const title = subject;
    const body = `${r.display_name || 'Relationship'} · ends ${ukDay(r.end_at)} · auto-extend ${r.autoExtendText}`;
    const email = alertEmail({
      subject,
      heading: t === 0 ? `The GDAP relationship with ${customer} has expired` : `The GDAP relationship with ${customer} ends in ${r.days} day${r.days === 1 ? '' : 's'}`,
      intro: t === 0 ? 'Delegated admin access to this customer has ended. Ask the customer to approve a new relationship in Partner Center.' : 'Renew it in Partner Center before it ends, or delegated admin access to this customer will stop.',
      rows: [['Customer', customer], ['Relationship', r.display_name || '–'], ['Roles', roles], ['End date', ukDay(r.end_at)], ['Auto-extend', r.autoExtendText], ...(r.client_name ? [['Portal client', r.client_name]] : [])],
    });
    if (!users.length) continue;
    const reached = await deliver(users, { title, body, link: `/microsoft-partner#gdap-${r.id}`, email, tag: `gdap-${r.id}-${t}` });
    sent += 1;
    await log(null, {
      id: r.id, action: 'sent', clientId: r.client_id, clientName: r.client_name,
      summary: `GDAP alert "${subject}" sent to ${reached.join(', ') || 'nobody (no channel reached)'}`,
    });
  }
  return sent;
}

// One email listing everything ending in the next 30 days (daily, when turned on).
async function runDigest() {
  const settings = await getSettings(pool);
  if (settings.digest !== '1') return false;
  const { rows } = await listRelationships(pool);
  const soon = rows.filter((r) => !r.removed && !r.hidden && LIVE.has(r.status) && r.end_at && !r.expired && r.days !== null && r.days <= 30);
  if (!soon.length) return false;
  const users = (await alertUsers(pool, settings)).filter((u) => channelsOf(u).has('email'));
  const { mailStatus, sendMail, userEmail } = mailer();
  if (!mailStatus().enabled || !users.length) return false;
  if (!(await claim(pool, '__digest__', 0, londonDate()))) return false;
  const colour = { bad: '#C4281C', warn: '#B26B00', ok: '#1D7A46' };
  const email = alertEmail({
    subject: `Microsoft Partner: GDAP digest: ${soon.length} relationship${soon.length === 1 ? '' : 's'} ending in the next 30 days`,
    heading: `${soon.length} GDAP relationship${soon.length === 1 ? '' : 's'} ending in the next 30 days`,
    intro: 'Soonest first.',
    list: soon.map((r) => ({ customer: r.customer_name || r.display_name || '–', end: ukDay(r.end_at), days: r.daysLabel, extend: r.autoExtendText, colour: colour[r.band] || '#000000' })),
  });
  const names = [];
  for (const u of users) {
    const to = userEmail(u);
    if (!to) continue;
    await sendMail({ to, ...email }, { kind: 'gdap', userId: u.id });
    names.push(u.name);
  }
  await log(null, { action: 'sent', summary: `GDAP daily digest (${soon.length} ending within 30 days) sent to ${names.join(', ') || 'nobody'}` });
  return true;
}

// Client secret expiry reminder to admins, 30 and 7 days before (and once expired).
async function runSecretReminder() {
  const settings = await getSettings(pool);
  const day = settings.secret_expires_on;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return false;
  // Whole UK days until the expiry date (the secret works through that day).
  const days = Math.round((Date.parse(day) - Date.parse(londonDate())) / 86400000);
  const info = { days, expired: days < 0 };
  const t = info.expired ? 0 : info.days <= 7 ? 7 : info.days <= 30 ? 30 : null;
  if (t === null) return false;
  if (!(await claim(pool, '__secret__', t, day))) return false;
  const when = fmtFor('d_mon_yyyy').fmtDay(day);
  const subject = t === 0 ? 'Microsoft Partner: the Microsoft client secret has expired' : `Microsoft Partner: the Microsoft client secret expires in ${info.days} day${info.days === 1 ? '' : 's'}`;
  const email = alertEmail({
    subject,
    heading: subject.replace('Microsoft Partner: t', 'T'),
    intro: 'Create a new client secret for the GDAP app in Entra ID (App registrations > Certificates & secrets), put it in MS_CLIENT_SECRET in .env, restart the portal, and update "Client secret expires on" in Microsoft Partner settings. Until then GDAP syncs will fail.',
    rows: [['Expires on', when]],
    buttonText: 'Open Microsoft Partner settings',
  });
  const reached = await deliver(await adminUsers(pool), { title: subject, body: `Expires on ${when}. Renew it before GDAP syncing stops.`, link: '/microsoft-partner/settings', email, tag: 'gdap-secret' });
  await log(null, { action: 'sent', summary: `${subject} (sent to ${reached.join(', ') || 'nobody'})` });
  return true;
}

// A failed sync: red banner on the page, and admins alerted (once a day).
async function alertSyncFailure(error) {
  if (!(await claim(pool, '__sync__', 0, londonDate()))) return false;
  const email = alertEmail({
    subject: 'Microsoft Partner: GDAP sync failed',
    heading: 'The GDAP sync with Microsoft failed',
    intro: 'GDAP end dates and alerts are not being updated until this is fixed.',
    rows: [['Error', String(error).slice(0, 500)]],
  });
  const reached = await deliver(await adminUsers(pool), { title: 'Microsoft Partner: GDAP sync failed', body: String(error).slice(0, 300), link: '/microsoft-partner', email, tag: 'gdap-sync' });
  await log(null, { action: 'sent', summary: `GDAP sync failure alert sent to ${reached.join(', ') || 'nobody'}` });
  return true;
}

// Expiry alerts, digest and the secret reminder (after the daily sync).
async function runDailyChecks() {
  const out = {};
  for (const [key, fn] of [['alerts', runExpiryAlerts], ['digest', runDigest], ['secret', runSecretReminder]]) {
    try {
      out[key] = await fn();
    } catch (err) {
      console.error(`GDAP ${key} failed:`, err.message);
    }
  }
  return out;
}

module.exports = {
  alertUsers, adminUsers, runExpiryAlerts, runDigest, runSecretReminder, alertSyncFailure, runDailyChecks, alertEmail,
};
