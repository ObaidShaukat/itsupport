// Microsoft > Email Services data: domains shaped for the views, the latest record checks,
// the status history and settings.
const { pool } = require('../../db');
const { LABELS, RECORDS, CORE } = require('./dns');

const STATUS_LABELS = {
  healthy: 'Healthy', issues: 'Issues', not_m365: 'Not Microsoft', error: 'Error', unchecked: 'Not checked',
};
// Default order: problems first (issues, errors, not checked yet), then healthy, then not Microsoft.
const STATUS_RANK = { issues: 0, error: 1, unchecked: 2, healthy: 3, not_m365: 4 };

const parseList = (json) => {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch (err) {
    return [];
  }
};

function shapeDomain(d) {
  const status = d.status || 'unchecked';
  const issueList = String(d.issues || '').split(',').filter(Boolean);
  return {
    ...d,
    statusKey: status,
    statusLabel: STATUS_LABELS[status] || status,
    issueList,
    issueLabels: issueList.map((r) => LABELS[r] || r),
    nameserverList: parseList(d.nameservers),
    hidden: Boolean(d.hidden_at),
    // Red LED: email issues or a failed check.
    led: status === 'issues' || status === 'error' ? 'urgent' : null,
    usesM365: d.uses_m365 === 'yes' || (d.uses_m365 === 'auto' && Boolean(d.detected_m365)),
  };
}

const DOMAIN_SQL = `
  SELECT d.*, COALESCE(NULLIF(hu.display_name, ''), hu.username) AS hidden_by_name
  FROM m365_domains d LEFT JOIN users hu ON hu.id = d.hidden_by`;

async function listDomains(db = pool) {
  const [rows] = await db.query(`${DOMAIN_SQL} ORDER BY d.domain`);
  return rows.map(shapeDomain);
}

async function getDomain(id, db = pool) {
  const [[row]] = await db.query(`${DOMAIN_SQL} WHERE d.id = ?`, [id]);
  return row ? shapeDomain(row) : null;
}

const defaultOrder = (rows) => [...rows].sort((a, b) => (STATUS_RANK[a.statusKey] ?? 9) - (STATUS_RANK[b.statusKey] ?? 9) || a.domain.localeCompare(b.domain));

// The latest result per record, in the fixed order (records never checked are left out).
async function recordsFor(domainId, db = pool) {
  const [rows] = await db.query('SELECT * FROM m365_checks WHERE domain_id = ?', [domainId]);
  const byRecord = new Map(rows.map((r) => [r.record, r]));
  return RECORDS.filter((r) => byRecord.has(r)).map((r) => ({ ...byRecord.get(r), label: LABELS[r], core: CORE.includes(r) }));
}

async function getSettings(db = pool) {
  const [rows] = await db.query('SELECT name, value FROM m365_settings');
  const s = { alert_users: 'all', include_cloudflare: '0' };
  for (const r of rows) s[r.name] = r.value;
  return s;
}
const saveSetting = (db, name, value) => db.query('INSERT INTO m365_settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [name, value]);

// "example.com" from what was pasted ("https://www.Example.com/path", "example.com."); null
// when it is not a domain name. A leading "www." is kept off (the domain is what has the mail).
function cleanDomain(value) {
  let v = String(value || '').trim().toLowerCase();
  v = v.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
  if (v.length > 253) return null;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(v) ? v : null;
}

// The dashboard "Email services" card (views/partials/dash-email.ejs): domains with Issues (not
// hidden), worst first (most failing core records, then the longest-standing), each with a
// short reason ("MX, SPF missing" / "SPF wrong"), and the healthy count and last check time
// for the all-healthy state. null when no domains have been added.
async function dashboardEmail(db = pool, limit = 5) {
  const all = (await listDomains(db)).filter((d) => !d.hidden);
  if (!all.length) return null;
  const issues = all.filter((d) => d.statusKey === 'issues');
  const since = (d) => (d.last_status_change ? new Date(d.last_status_change).getTime() : Infinity);
  issues.sort((a, b) => b.issueList.length - a.issueList.length || since(a) - since(b) || a.domain.localeCompare(b.domain));
  const top = issues.slice(0, limit);
  const found = new Map();
  if (top.length) {
    const [rows] = await db.query('SELECT domain_id, record, found FROM m365_checks WHERE domain_id IN (?) AND record IN (?)', [top.map((d) => d.id), CORE]);
    for (const r of rows) found.set(`${r.domain_id}:${r.record}`, r.found);
  }
  const reasonOf = (d) => {
    const missing = d.issueList.filter((k) => !found.get(`${d.id}:${k}`));
    const wrong = d.issueList.filter((k) => found.get(`${d.id}:${k}`));
    const part = (keys, word) => (keys.length ? `${keys.map((k) => LABELS[k] || k).join(', ')} ${word}` : '');
    return [part(missing, 'missing'), part(wrong, 'wrong')].filter(Boolean).join(' · ') || 'Email records not right';
  };
  const checked = all.map((d) => (d.last_checked ? new Date(d.last_checked).getTime() : 0)).filter(Boolean);
  return {
    issues: issues.length,
    healthy: all.filter((d) => d.statusKey === 'healthy').length,
    errors: all.filter((d) => d.statusKey === 'error').length,
    m365: all.filter((d) => d.usesM365 || ['healthy', 'issues'].includes(d.statusKey)).length,
    lastChecked: checked.length ? new Date(Math.max(...checked)) : null,
    items: top.map((d) => ({
      id: d.id, domain: d.domain, reason: reasonOf(d), provider: d.dns_provider, managedBy: d.managed_by, since: d.last_status_change,
    })),
  };
}

module.exports = {
  dashboardEmail,
  STATUS_LABELS, STATUS_RANK, shapeDomain, listDomains, getDomain, defaultOrder, recordsFor, getSettings, saveSetting, cleanDomain, parseList,
};
