// Microsoft > Email Services checks (public DNS only, read only): every 6 hours with the
// Cloudflare checks (index.js), "Check now" for one domain and for all, and straight after
// domains are added. For each domain:
//   - the records in dns.js are looked up and saved (m365_checks, the latest per record);
//   - Microsoft 365 or not: uses_m365 yes / no, or auto = detected when MX, SPF,
//     Autodiscover or the MS=ms verification record points to Microsoft;
//   - status: not_m365; healthy when MX, SPF and Autodiscover are all right; issues when any
//     of them is not; error (with the reason) when the domain cannot be looked up;
//   - DNS provider (from the nameservers) and managed by: "Us" when the domain is one of our
//     Cloudflare domains, else "Customer";
//   - a status change is an m365_events row; Healthy <-> Issues changes are alerted once
//     (sendStatusAlerts), never for hidden domains. Everything is logged (entity_type 'm365').
const { pool } = require('../../db');
const { logActivity } = require('../activity');
const { checkDns, CORE, LABELS } = require('./dns');
const { getSettings, saveSetting } = require('./data');
const { providersLabel } = require('../cloudflare/lookups');
const { chosenUsers, brandedEmail, deliver } = require('../alert-deliver');

let running = false;
const log = (user, entry) => logActivity(null, user, { type: 'm365', subject: 'Email Services', ...entry }).catch((err) => console.error('Email Services log failed:', err.message));
const ALERTED = new Set(['healthy>issues', 'issues>healthy']);

async function checkOne(d, user = null) {
  const r = await checkDns(d.domain);
  const [[cf]] = await pool.query('SELECT COUNT(*) AS n FROM domains WHERE name = ? AND deleted_at IS NULL', [d.domain]);
  const managedBy = Number(cf.n) ? 'Us' : 'Customer';
  let status;
  let reason = null;
  let issues = null;
  let detected = d.detected_m365;
  if (r.error) {
    status = 'error';
    reason = r.error.slice(0, 255);
  } else {
    for (const [record, v] of Object.entries(r.records)) {
      await pool.query(`
        INSERT INTO m365_checks (domain_id, record, ok, found, expected, checked_at) VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE ok = VALUES(ok), found = VALUES(found), expected = VALUES(expected), checked_at = NOW()
      `, [d.id, record, v.ok ? 1 : 0, String(v.found || '').slice(0, 5000), String(v.expected || '').slice(0, 500)]);
    }
    detected = r.detected ? 1 : 0;
    const uses = d.uses_m365 === 'yes' || (d.uses_m365 === 'auto' && r.detected);
    const failing = CORE.filter((k) => !r.records[k].ok);
    if (!uses) status = 'not_m365';
    else status = failing.length ? 'issues' : 'healthy';
    issues = uses && failing.length ? failing.join(',') : null;
  }
  const provider = r.nameservers ? providersLabel(r.nameservers) : d.dns_provider;
  const changed = (d.status || null) !== status;
  await pool.query(`
    UPDATE m365_domains SET detected_m365 = ?, status = ?, status_reason = ?, issues = ?, nameservers = ?, dns_provider = ?, managed_by = ?,
      last_checked = NOW() ${changed ? ', last_status_change = NOW()' : ''}
    WHERE id = ?
  `, [detected, status, reason, issues, r.nameservers ? JSON.stringify(r.nameservers) : d.nameservers, provider, managedBy, d.id]);
  if (changed) {
    const alert = ALERTED.has(`${d.status}>${status}`) && !d.hidden_at;
    await pool.query(
      `INSERT INTO m365_events (domain_id, type, old_status, new_status, details, user_id, alerted_at) VALUES (?, 'status_changed', ?, ?, ?, ?, ${alert ? 'NULL' : 'NOW()'})`,
      [d.id, d.status || null, status, JSON.stringify({ issues: issues ? issues.split(',') : [], reason }), user ? user.id : null]
    );
    await log(user, {
      id: d.id, action: 'updated',
      summary: `Email Services: ${d.domain} is now ${status === 'not_m365' ? 'not Microsoft 365' : status}${issues ? ` (${issues.split(',').map((k) => LABELS[k]).join(', ')})` : ''}${reason ? ` (${reason})` : ''}${d.status ? ` (was ${d.status})` : ''}`,
    });
  }
  return { status, changed };
}

// One domain now (Check now, after adding).
async function checkDomain(user, id) {
  const [[d]] = await pool.query('SELECT * FROM m365_domains WHERE id = ?', [id]);
  if (!d) return { ok: false, error: 'That domain no longer exists.' };
  const r = await checkOne(d, user);
  const alerts = await sendStatusAlerts();
  return { ok: true, domain: d.domain, ...r, alerts };
}

// Every domain, a few at a time.
async function runChecks(user = null, { trigger = 'schedule', ids = null } = {}) {
  if (running) return { ok: false, error: 'An Email Services check is already running. Try again in a minute.' };
  running = true;
  try {
    const [rows] = ids && ids.length
      ? await pool.query('SELECT * FROM m365_domains WHERE id IN (?)', [ids])
      : await pool.query('SELECT * FROM m365_domains');
    let i = 0;
    let changed = 0;
    const worker = async () => {
      while (i < rows.length) {
        const d = rows[i];
        i += 1;
        try {
          if ((await checkOne(d, user)).changed) changed += 1;
        } catch (err) {
          console.error(`Email Services check of ${d.domain} failed:`, err.message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    const alerts = await sendStatusAlerts();
    if (!ids) await saveSetting(pool, 'last_run', new Date().toISOString());
    await log(user, { action: 'synced', summary: `Email Services check (${trigger}): ${rows.length} domain${rows.length === 1 ? '' : 's'}, ${changed} status change${changed === 1 ? '' : 's'}, ${alerts} alert${alerts === 1 ? '' : 's'}` });
    return { ok: true, count: rows.length, changed, alerts };
  } finally {
    running = false;
  }
}

// Alerts for Healthy <-> Issues changes not alerted yet, once each.
async function sendStatusAlerts() {
  const [events] = await pool.query(`
    SELECT e.*, d.domain, d.hidden_at, d.dns_provider FROM m365_events e JOIN m365_domains d ON d.id = e.domain_id
    WHERE e.alerted_at IS NULL ORDER BY e.id
  `);
  if (!events.length) return 0;
  const users = await chosenUsers((await getSettings(pool)).alert_users);
  let sent = 0;
  for (const ev of events) {
    const [claim] = await pool.query('UPDATE m365_events SET alerted_at = NOW() WHERE id = ? AND alerted_at IS NULL', [ev.id]);
    if (claim.affectedRows !== 1 || ev.hidden_at || !users.length) continue;
    let details = {};
    try { details = JSON.parse(ev.details || '{}') || {}; } catch (err) { details = {}; }
    const records = (details.issues || []).map((k) => LABELS[k] || k).join(', ');
    const bad = ev.new_status === 'issues';
    const title = bad ? `${ev.domain}: Microsoft 365 email issues (${records})` : `${ev.domain}: Microsoft 365 email is healthy again`;
    const link = `/microsoft/email-services/${ev.domain_id}`;
    const rows = [['Domain', ev.domain], ['Status', bad ? 'Issues' : 'Healthy'], ...(bad ? [['Records', records]] : []), ...(ev.dns_provider ? [['DNS provider', ev.dns_provider]] : [])];
    const email = brandedEmail({ section: 'Microsoft Email Services', subject: `Microsoft: ${title}`, heading: title, rows, link, buttonText: 'Open the domain' });
    const reached = await deliver(users, { type: 'm365', title, body: rows.map(([l, v]) => `${l}: ${v}`).join(' · '), link, email, tag: `m365-${ev.id}` });
    sent += 1;
    await log(null, { id: ev.domain_id, action: 'sent', summary: `Email Services alert "${title}" sent to ${reached.join(', ') || 'nobody (no channel reached)'}` });
  }
  return sent;
}

module.exports = { runChecks, checkDomain, sendStatusAlerts };
