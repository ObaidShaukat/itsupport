// Inventory tabs and records (employees, writers, old accounts, custom tabs), plus the
// activity logging every inventory write goes through. Inventory history is in the
// activity log but never on the Daily Report.
const { pool } = require('../../db');
const { notFound } = require('../http');
const { logActivity } = require('../activity');
const { listFields, loadValues, displayText } = require('./fields');

const TAB_KINDS = ['employees', 'ex_employees', 'stock', 'records'];
const tabUrl = (tab) => (tab.kind === 'stock' ? '/inventory/stock' : `/inventory/t/${tab.id}`);

async function listTabs(db = pool) {
  const [tabs] = await db.query('SELECT id, kind, name, sort_order FROM inventory_tabs ORDER BY sort_order, id');
  return tabs;
}

// The tab, or 404.
async function getTab(db, id) {
  const [[tab]] = await db.query('SELECT id, kind, name, sort_order FROM inventory_tabs WHERE id = ?', [id]);
  if (!tab) throw notFound();
  return tab;
}

// Employees and Ex Employees share the Employees tab's fields and records.
async function employeesTab(db = pool) {
  const [[tab]] = await db.query("SELECT id, kind, name FROM inventory_tabs WHERE kind = 'employees' ORDER BY id LIMIT 1");
  return tab || null;
}

// The tab whose fields and records a tab shows (Ex Employees -> Employees).
async function dataTab(db, tab) {
  if (tab.kind === 'ex_employees') {
    const employees = await employeesTab(db);
    if (!employees) throw notFound();
    return employees;
  }
  return tab;
}

// A record's display name: its title field, else the first filled text-like field.
function recordTitle(record, fields, values) {
  const v = values || new Map();
  const title = fields.find((f) => f.role === 'title');
  if (title && v.get(title.id)?.value) return v.get(title.id).value;
  for (const f of fields) {
    if (['text', 'email', 'phone'].includes(f.field_type) && v.get(f.id)?.value) return v.get(f.id).value;
  }
  return `#${record.id}`;
}

const fieldByRole = (fields, role) => fields.find((f) => f.role === role) || null;

// Records of a data tab with their values. status: 'active' / 'inactive' / null (all).
async function listRecords(db, tabId, status = null) {
  const [records] = await db.query(`
    SELECT id, tab_id, status, leaving_date, created_at, updated_at FROM inventory_records
    WHERE tab_id = ? ${status ? 'AND status = ?' : ''}
    ORDER BY id
  `, status ? [tabId, status] : [tabId]);
  const values = await loadValues(db, records.map((r) => r.id));
  return records.map((r) => ({ ...r, values: values.get(r.id) || new Map() }));
}

// One record with its tab, fields and values, or 404.
async function getRecord(db, id) {
  const [[record]] = await db.query(`
    SELECT r.id, r.tab_id, r.status, r.leaving_date, r.created_at, r.updated_at,
           COALESCE(NULLIF(cu.display_name, ''), cu.username) AS created_by_name,
           COALESCE(NULLIF(uu.display_name, ''), uu.username) AS updated_by_name
    FROM inventory_records r
    LEFT JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users uu ON uu.id = r.updated_by
    WHERE r.id = ?
  `, [id]);
  if (!record) throw notFound();
  const tab = await getTab(db, record.tab_id);
  const fields = await listFields(db, { tabId: tab.id });
  const values = (await loadValues(db, [record.id])).get(record.id) || new Map();
  return { record, tab, fields, values, title: recordTitle(record, fields, values) };
}

// Employee names by record id (for stock lists and reports).
async function employeeNames(db, ids) {
  const out = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  const tab = await employeesTab(db);
  if (!tab) return out;
  const fields = await listFields(db, { tabId: tab.id });
  const values = await loadValues(db, unique);
  for (const id of unique) out.set(id, recordTitle({ id }, fields, values.get(id)));
  return out;
}

// Inventory activity: entity types inv_record / inv_item / inv_config / inv_secret.
// personId puts the entry on that employee's History too.
const logInv = (db, user, entry) => logActivity(db, user, {
  type: entry.type, id: entry.id, action: entry.action, summary: entry.summary, subject: entry.subject,
  changes: entry.changes, personId: entry.personId,
});

module.exports = {
  TAB_KINDS, tabUrl, listTabs, getTab, employeesTab, dataTab, recordTitle, fieldByRole, listRecords, getRecord,
  employeeNames, logInv, displayText,
};
