// Employee User-IDs: PREFIX-001, PREFIX-002 … (3 digits, more when needed). A new
// employee gets the lowest number not used by an ACTIVE employee, so a leaver's number is
// reused. Ex employees keep theirs for history, so uniqueness is only among active
// employees; records are always told apart by their internal id. The prefix (default
// MDP) is a setting (inventory_settings 'user_id_prefix'); changing it does not rename
// existing IDs. Callers lock the Employees tab row (lockEmployees) inside their
// transaction so two saves at once cannot take the same number.
const DEFAULT_PREFIX = 'MDP';
const PREFIX_PATTERN = /^[A-Za-z0-9]{1,10}$/;

async function getPrefix(db) {
  const [[row]] = await db.query("SELECT value FROM inventory_settings WHERE name = 'user_id_prefix'");
  return row && PREFIX_PATTERN.test(row.value) ? row.value : DEFAULT_PREFIX;
}

const formatId = (prefix, n) => `${prefix}-${String(n).padStart(3, '0')}`;

// "21", "mdp21", "MDP-021" -> { value: 'MDP-021', number: 21 }; '' -> { value: '' } (auto).
function normalizeId(prefix, raw) {
  const text = String(raw || '').trim();
  if (!text) return { value: '' };
  const m = /^(\d{1,6})$/.exec(text) || new RegExp(`^${prefix}\\s*-?\\s*(\\d{1,6})$`, 'i').exec(text);
  if (!m || Number(m[1]) < 1) return { error: `User-ID must look like ${formatId(prefix, 1)} (or just the number, e.g. 1).` };
  return { value: formatId(prefix, Number(m[1])), number: Number(m[1]) };
}

// User-IDs of active employees (optionally leaving one record out).
async function activeIds(db, tabId, fieldId, excludeRecordId = 0) {
  const [rows] = await db.query(`
    SELECT v.value FROM inventory_values v
    JOIN inventory_records r ON r.id = v.record_id
    WHERE r.tab_id = ? AND r.status = 'active' AND v.field_id = ? AND v.value IS NOT NULL AND r.id <> ?
  `, [tabId, fieldId, excludeRecordId || 0]);
  return rows.map((r) => String(r.value));
}

const isTaken = (ids, value) => ids.some((v) => v.toUpperCase() === String(value).toUpperCase());

function lowestFree(prefix, ids) {
  const used = new Set(ids.map((v) => normalizeId(prefix, v).number).filter(Boolean));
  let n = 1;
  while (used.has(n)) n += 1;
  return formatId(prefix, n);
}

async function suggestId(db, tabId, fieldId) {
  return lowestFree(await getPrefix(db), await activeIds(db, tabId, fieldId));
}

// Checks a typed User-ID for a (new or existing) active employee. Returns { value } (''
// means "assign the lowest free one") or { error }.
async function checkId(db, tabId, fieldId, raw, recordId = 0) {
  const prefix = await getPrefix(db);
  const n = normalizeId(prefix, raw);
  if (n.error || !n.value) return n;
  if (isTaken(await activeIds(db, tabId, fieldId, recordId), n.value)) {
    return { error: `${n.value} is already used by another active employee. The lowest free User-ID is ${lowestFree(prefix, await activeIds(db, tabId, fieldId, recordId))}.` };
  }
  return { value: n.value };
}

// Final value inside the save transaction (after lockEmployees): the typed one if still
// free, else an error; empty means the lowest free number.
async function resolveId(conn, tabId, fieldId, value, recordId = 0) {
  const prefix = await getPrefix(conn);
  const ids = await activeIds(conn, tabId, fieldId, recordId);
  if (!value) return { value: lowestFree(prefix, ids) };
  if (isTaken(ids, value)) return { error: `${value} was just taken by another active employee. Try again.` };
  return { value };
}

const lockEmployees = (conn, tabId) => conn.query('SELECT id FROM inventory_tabs WHERE id = ? FOR UPDATE', [tabId]);

module.exports = {
  DEFAULT_PREFIX, PREFIX_PATTERN, getPrefix, formatId, normalizeId, activeIds, isTaken, lowestFree,
  suggestId, checkId, resolveId, lockEmployees,
};
