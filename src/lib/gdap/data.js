// GDAP data helpers: settings, days left and colours, client name matching, and the
// relationships shaped for the page and the client card.
const { pool } = require('../../db');
const { londonDate } = require('../activity');
const { rolesOf, GLOBAL_ADMIN } = require('./roles');

const DEFAULT_PARTNER_URL = 'https://partner.microsoft.com/dashboard/commerce2/customers/{tenantId}';
const SETTING_DEFAULTS = { partner_center_url: DEFAULT_PARTNER_URL, alert_users: 'all', digest: '0', secret_expires_on: '' };
const THRESHOLDS = [30, 14, 7, 1];
const STATUS_LABELS = {
  active: 'Active', expired: 'Expired', terminated: 'Terminated', terminating: 'Terminating', terminationRequested: 'Termination requested',
  approvalPending: 'Approval pending', approved: 'Approved', activating: 'Activating', created: 'Created', unknownFutureValue: 'Unknown', removed: 'Removed',
};

async function getSettings(db = pool) {
  const [rows] = await db.query('SELECT name, value FROM gdap_settings');
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) if (Object.hasOwn(out, r.name) && r.value !== null) out[r.name] = r.value;
  return out;
}

async function saveSetting(db, name, value) {
  await db.query('INSERT INTO gdap_settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [name, value]);
}

// "P730D" / "P2Y" / "PT0S" -> days (approximate for months / years); 0 for none.
function durationDays(iso) {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || '').trim());
  if (!m) return 0;
  const [, y, mo, w, d, h] = m.map((v) => Number(v || 0));
  return y * 365 + mo * 30 + w * 7 + d + Math.floor(h / 24);
}
const durationText = (iso) => {
  const days = durationDays(iso);
  return days ? `${days} day${days === 1 ? '' : 's'}` : '';
};
const autoExtendOn = (iso) => durationDays(iso) > 0;

// Whole UK calendar days from today to the end date (negative once past); expired when
// the end time has passed.
function daysInfo(endAt, now = new Date()) {
  if (!endAt) return { days: null, expired: false };
  const end = new Date(endAt);
  const diff = Math.round((Date.parse(londonDate(end)) - Date.parse(londonDate(now))) / 86400000);
  return { days: diff, expired: end.getTime() <= now.getTime() };
}

// Colour band: ok (> 30 days), warn (8-30), bad (<= 7), expired; none without a date.
function band({ days, expired }) {
  if (expired) return 'expired';
  if (days === null) return 'none';
  if (days <= 7) return 'bad';
  if (days <= 30) return 'warn';
  return 'ok';
}

// The alert threshold reached (0 = expired, else 1 / 7 / 14 / 30), or null.
function thresholdFor({ days, expired }) {
  if (expired) return 0;
  if (days === null) return null;
  const hit = [...THRESHOLDS].reverse().find((t) => days <= t);
  return hit === undefined ? null : hit;
}

const daysText = ({ days, expired }) => {
  if (expired) return 'Expired';
  if (days === null) return '–';
  if (days === 0) return 'Today';
  return `${days} day${days === 1 ? '' : 's'}`;
};

// Customer / client names for matching: case-insensitive, no punctuation, "&" = "and",
// and the words Ltd / Limited ignored.
function matchKey(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(ltd|limited)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Map matchKey -> client id, only for names that match exactly one client.
function clientIndex(clients) {
  const map = new Map();
  for (const c of clients) {
    const key = matchKey(c.name);
    if (!key) continue;
    map.set(key, map.has(key) ? null : c.id);
  }
  return map;
}

const partnerLink = (template, tenantId) => (tenantId ? String(template || DEFAULT_PARTNER_URL).replace(/\{tenantId\}/g, encodeURIComponent(tenantId)) : '');

// A gdap_relationships row (with client_name) ready for the views.
function shape(row, settings, now = new Date()) {
  let roles = row.roles;
  if (typeof roles === 'string') { try { roles = JSON.parse(roles); } catch (err) { roles = []; } }
  const info = daysInfo(row.end_at, now);
  const removed = Boolean(row.removed_at);
  const status = removed ? 'removed' : (row.status || 'unknownFutureValue');
  return {
    ...row,
    roleList: rolesOf(roles),
    hasGlobal: (roles || []).map((r) => String(r).toLowerCase()).includes(GLOBAL_ADMIN),
    ...info,
    band: removed ? 'removed' : band(info),
    daysLabel: daysText(info),
    statusKey: status,
    statusLabel: STATUS_LABELS[status] || status,
    autoExtend: autoExtendOn(row.auto_extend_duration),
    autoExtendText: autoExtendOn(row.auto_extend_duration) ? durationText(row.auto_extend_duration) : 'Off',
    durationText: durationText(row.duration),
    partnerUrl: partnerLink(settings.partner_center_url, row.customer_tenant_id),
    removed,
  };
}

const ROW_SQL = `
  SELECT g.*, c.name AS client_name FROM gdap_relationships g LEFT JOIN clients c ON c.id = g.client_id
`;

async function listRelationships(db = pool, { clientId } = {}) {
  const settings = await getSettings(db);
  const [rows] = await db.query(`${ROW_SQL} ${clientId ? 'WHERE g.client_id = ? AND g.removed_at IS NULL' : ''}
    ORDER BY g.removed_at IS NOT NULL, g.end_at IS NULL, g.end_at, g.customer_name`, clientId ? [clientId] : []);
  return { settings, rows: rows.map((r) => shape(r, settings)) };
}

async function lastSync(db = pool) {
  const [[last]] = await db.query('SELECT * FROM gdap_sync_log ORDER BY id DESC LIMIT 1');
  const [[ok]] = await db.query("SELECT * FROM gdap_sync_log WHERE status = 'ok' ORDER BY id DESC LIMIT 1");
  return { last: last || null, lastOk: ok || null };
}

// Statuses that still give access (or just ran out): alerts and summary counts use them.
const LIVE = new Set(['active', 'expired']);

module.exports = {
  DEFAULT_PARTNER_URL, THRESHOLDS, STATUS_LABELS, LIVE,
  getSettings, saveSetting, daysInfo, band, thresholdFor, daysText, matchKey, clientIndex, partnerLink, shape, listRelationships, lastSync,
  durationText, autoExtendOn,
};
