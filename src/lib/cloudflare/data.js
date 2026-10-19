// Cloudflare data for the pages: domains and accounts shaped for the views, the status
// rules, settings and client links.
const { pool } = require('../../db');
const { londonDate } = require('../activity');
const { matchKey, clientIndex } = require('../gdap/data');
const { providersLabel, nsList } = require('./lookups');

const parseList = (json) => {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? nsList(v) : [];
  } catch (err) {
    return [];
  }
};

// Whole UK days from today to a DATE ('YYYY-MM-DD'); negative once it has passed.
const daysUntil = (day) => (day ? Math.round((Date.parse(String(day).slice(0, 10)) - Date.parse(londonDate())) / 86400000) : null);

const STATUS_LABELS = {
  active: 'Active', pending: 'Pending', ns_changed: 'NS changed', moved: 'Moved', deactivated: 'Deactivated', deleted: 'Deleted',
};
// Problems first on the page (lower = more urgent).
const STATUS_RANK = { deleted: 0, moved: 1, deactivated: 1, ns_changed: 2, pending: 4, active: 5 };

// A domains row (with client_name, account_name, account_lost) ready for the views.
function shapeDomain(d) {
  const assigned = parseList(d.assigned_ns);
  const current = parseList(d.current_ns);
  let status;
  if (d.deleted_at) status = 'deleted';
  else if (d.cf_status === 'moved') status = 'moved';
  else if (d.cf_status === 'deactivated') status = 'deactivated';
  // A pending zone is not on Cloudflare's nameservers yet: that is expected, not a change.
  else if (d.cf_status !== 'pending' && d.nameservers_ok === 0) status = 'ns_changed';
  else if (d.cf_status === 'pending') status = 'pending';
  else status = 'active';
  const days = daysUntil(d.expires_on);
  const expired = days !== null && days < 0;
  const expiring = days !== null && days >= 0 && days <= 30;
  const problem = ['deleted', 'moved', 'deactivated', 'ns_changed'].includes(status) || expired;
  return {
    ...d,
    assigned,
    current,
    status,
    statusLabel: STATUS_LABELS[status],
    days,
    expired,
    expiring,
    problem,
    // LED: red = a problem, amber = expiring within 30 days.
    led: problem ? 'urgent' : expiring ? 'high' : null,
    healthy: !problem && !expiring && status === 'active',
    hidden: Boolean(d.hidden_at),
    provider: current.length ? providersLabel(current) : (d.nameservers_ok === null ? 'Not checked' : 'None'),
    assignedProvider: assigned.length ? providersLabel(assigned) : '',
    // Why the expiry is not known (tooltip on "Unknown").
    expiryReason: d.expires_on ? '' : d.rdap_note || (d.rdap_checked_at ? 'The registry did not give an expiry date' : 'Not looked up yet'),
    daysLabel: days === null ? '' : expired ? `expired ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'expires today' : `${days} day${days === 1 ? '' : 's'} left`,
  };
}

const DOMAIN_SQL = `
  SELECT d.*, c.name AS client_name, a.name AS account_name, a.account_id AS cf_account_key, a.access_lost AS account_lost,
         COALESCE(NULLIF(hu.display_name, ''), hu.username) AS hidden_by_name
  FROM domains d
  LEFT JOIN clients c ON c.id = d.client_id
  LEFT JOIN cf_accounts a ON a.id = d.cf_account_id
  LEFT JOIN users hu ON hu.id = d.hidden_by`;

async function listDomains(db = pool, { clientId = null } = {}) {
  const [rows] = await db.query(`${DOMAIN_SQL} ${clientId ? 'WHERE d.client_id = ?' : ''} ORDER BY d.name`, clientId ? [clientId] : []);
  return rows.map(shapeDomain);
}

async function getDomain(id, db = pool) {
  const [[row]] = await db.query(`${DOMAIN_SQL} WHERE d.id = ?`, [id]);
  return row ? shapeDomain(row) : null;
}

// Default order: problems first (most urgent first), expiring soon next, then A-Z.
function defaultOrder(rows) {
  const rank = (d) => (d.problem ? STATUS_RANK[d.status] ?? 3 : d.expiring ? 3 : STATUS_RANK[d.status] ?? 5);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

async function listAccounts(db = pool) {
  const [rows] = await db.query(`
    SELECT a.*, c.name AS client_name,
           (SELECT COUNT(*) FROM domains d WHERE d.cf_account_id = a.id AND d.deleted_at IS NULL) AS domain_count
    FROM cf_accounts a LEFT JOIN clients c ON c.id = a.client_id
    ORDER BY a.name
  `);
  const domains = await listDomains(db);
  return rows.map((a) => ({
    ...a,
    domain_count: Number(a.domain_count),
    problems: domains.filter((d) => d.cf_account_id === a.id && !d.hidden && (d.problem || d.expiring)).length,
  }));
}

// Settings (cf_settings): alert_users "all" or a comma list of ids.
async function getSettings(db = pool) {
  const [rows] = await db.query('SELECT name, value FROM cf_settings');
  const s = { alert_users: 'all' };
  for (const r of rows) s[r.name] = r.value;
  return s;
}
const saveSetting = (db, name, value) => db.query('INSERT INTO cf_settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [name, value]);

async function lastCheck(db = pool) {
  const [[last]] = await db.query(`
    SELECT l.*, COALESCE(NULLIF(u.display_name, ''), u.username) AS user_name FROM cf_check_log l
    LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 1
  `);
  const [[ok]] = await db.query("SELECT MAX(finished_at) AS at FROM cf_check_log WHERE status = 'ok' AND trigger_type <> 'domain'");
  return { last: last || null, lastOkAt: ok ? ok.at : null };
}

// Domains inherit their account's client unless set by hand on the domain.
async function inheritClients(db, accountId = null) {
  await db.query(`
    UPDATE domains d JOIN cf_accounts a ON a.id = d.cf_account_id
    SET d.client_id = a.client_id
    WHERE d.client_manual = 0 AND NOT (d.client_id <=> a.client_id) ${accountId ? 'AND a.id = ?' : ''}
  `, accountId ? [accountId] : []);
}

// Links accounts to clients by name (lower case, no punctuation, Ltd / Limited ignored, only
// a unique match), except accounts linked by hand. Returns how many got a new link.
async function autoLink(db = pool) {
  const [clients] = await db.query('SELECT id, name FROM clients');
  const index = clientIndex(clients);
  const [accounts] = await db.query('SELECT id, name, client_id FROM cf_accounts WHERE link_manual = 0');
  let linked = 0;
  for (const a of accounts) {
    const match = index.get(matchKey(a.name)) || null;
    if (match !== a.client_id) {
      await db.query('UPDATE cf_accounts SET client_id = ? WHERE id = ?', [match, a.id]);
      if (match) linked += 1;
    }
  }
  await inheritClients(db);
  return linked;
}

module.exports = {
  STATUS_LABELS, shapeDomain, listDomains, getDomain, defaultOrder, listAccounts, getSettings, saveSetting, lastCheck,
  inheritClients, autoLink, daysUntil, parseList,
};
