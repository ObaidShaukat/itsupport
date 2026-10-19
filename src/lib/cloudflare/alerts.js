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
const { getSettings } = require('./data');
const { chosenUsers, brandedEmail, deliver } = require('../alert-deliver');
const { providersLabel } = require('./lookups');

const ukDay = (d) => require('../dates').formattersFor('d_mon_yyyy').fmtDay(d); // eslint-disable-line global-require
const ALERT_TYPES = new Set(['ns_changed', 'deleted', 'expiring', 'expired', 'access_lost']);
// The users chosen in Cloudflare settings (default everyone).
const alertUsers = async (db = pool) => chosenUsers((await getSettings(db)).alert_users, db);

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
    const email = brandedEmail({ section: 'Cloudflare', subject: `Cloudflare: ${m.title}`, heading: m.title, rows: m.rows, link: m.link, buttonText: ev.domain_id ? 'Open the domain' : 'Open Cloudflare accounts' });
    const reached = await deliver(users, { type: 'cloudflare', title: `Cloudflare: ${m.title}`, body: m.rows.map(([l, v]) => `${l}: ${v}`).join(' · '), link: m.link, email, tag: `cf-${ev.id}` });
    sent += 1;
    await logActivity(null, null, {
      type: 'cloudflare', id: ev.domain_id, action: 'sent', subject: 'Cloudflare', clientId: ev.client_id, clientName: ev.client_name,
      summary: `Cloudflare alert "${m.title}" sent to ${reached.join(', ') || 'nobody (no channel reached)'}`,
    }).catch((err) => console.error('Cloudflare log failed:', err.message));
  }
  return sent;
}

module.exports = { sendEventAlerts, alertUsers, message };
