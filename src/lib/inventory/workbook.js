// The full inventory workbook: export (one sheet per tab with all fields and data, plus
// Instructions) and import of every sheet in order: Employees, then Stock (so "Assigned
// to" can match employees from the same file), then Writers, Old Accounts and other tabs,
// then sheets that become new tabs. Each sheet uses the single-tab import planner.
const { STOCK_STATUSES, isSecret, listFields } = require('./fields');
const { decrypt } = require('./secrets');
const { listTabs, listRecords, recordTitle, employeesTab, logInv } = require('./records');
const { listItems, listCategories } = require('./stock');
const { buildBook, recordsColumns, stockColumns } = require('./template');
const { normHeader } = require('./import-files');
const planner = require('./import-plan');
const { lockEmployees } = require('./userids');

const dateCell = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? new Date(`${v}T00:00:00Z`) : v || '');

// Passwords / PINs of a tab, decrypted in memory (only when "Include passwords" is ticked).
async function tabSecrets(db, tabId) {
  const [rows] = await db.query(`
    SELECT v.record_id, v.field_id, v.value_enc FROM inventory_values v
    JOIN inventory_records r ON r.id = v.record_id
    WHERE r.tab_id = ? AND v.value_enc IS NOT NULL
  `, [tabId]);
  const out = new Map();
  for (const r of rows) {
    try { out.set(`${r.record_id}:${r.field_id}`, decrypt(r.value_enc)); } catch (err) { /* left blank */ }
  }
  return out;
}

// Returns { book, sheets: [{ name, rows }], secrets } (secrets = values written decrypted).
async function exportWorkbook(db, { includeSecrets = false } = {}) {
  const tabs = await listTabs(db);
  const sheets = [];
  let secrets = 0;
  const ordered = [
    ...tabs.filter((t) => t.kind === 'employees'),
    ...tabs.filter((t) => t.kind === 'stock'),
    ...tabs.filter((t) => t.kind === 'records'),
  ];
  for (const tab of ordered) {
    if (tab.kind === 'stock') {
      const columns = await stockColumns(db, { all: true });
      const items = await listItems(db);
      const emp = await employeesTab(db);
      const uidOf = new Map();
      if (emp) {
        const uidField = (await listFields(db, { tabId: emp.id })).find((f) => f.role === 'user_id');
        for (const r of await listRecords(db, emp.id)) if (uidField && r.values.get(uidField.id)?.value) uidOf.set(r.id, r.values.get(uidField.id).value);
      }
      const cats = new Map((await listCategories(db, { withFields: true })).map((c) => [c.id, c]));
      const rows = items.map((it) => columns.map((c) => {
        if (c.key === 'category') return it.category_name;
        if (c.key === 'brand') return it.brand || '';
        if (c.key === 'model') return it.model || '';
        if (c.key === 'serial') return it.serial || '';
        if (c.key === 'status') return STOCK_STATUSES[it.status];
        if (c.key === 'assigned') return it.employee_id ? uidOf.get(it.employee_id) || it.employee_name || '' : '';
        if (c.key === 'notes') return it.notes || '';
        const f = (cats.get(it.category_id)?.fields || []).find((x) => normHeader(x.label) === c.extraNorm);
        const v = f ? it.values.get(f.id)?.value : '';
        return f && f.field_type === 'date' ? dateCell(v) : f && f.field_type === 'number' && v ? Number(v) : v || '';
      }));
      sheets.push({ name: tab.name, title: 'Stock', columns, rows });
      continue;
    }
    const columns = await recordsColumns(db, tab, { all: true });
    const records = await listRecords(db, tab.id);
    const plain = includeSecrets ? await tabSecrets(db, tab.id) : new Map();
    const rows = records.map((r) => columns.map((c) => {
      if (c.role === 'status') return r.status === 'active' ? 'Active' : 'Inactive';
      if (c.role === 'leaving') return dateCell(r.leaving_date);
      const f = c.field;
      const v = r.values.get(f.id);
      if (isSecret(f)) {
        const p = includeSecrets ? plain.get(`${r.id}:${f.id}`) : null;
        if (p) secrets += 1;
        return p || '';
      }
      if (f.field_type === 'access') return v && v.value === 'granted' ? 'Yes' : 'No';
      if (!v || !v.value) return '';
      if (f.field_type === 'date') return dateCell(v.value);
      if (f.field_type === 'number') return Number(v.value);
      return v.value;
    }));
    sheets.push({ name: tab.name, title: tab.kind === 'employees' ? 'Employees (active and ex employees)' : tab.name, columns, rows });
  }
  return { book: buildBook(sheets), sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })), secrets };
}

// ---- Import ----

// The tab a sheet name means: { target: 'tab:<id>' | 'stock' | 'skip', defaultStatus }.
// "Ex Employees" goes to Employees, as inactive unless a Status column says otherwise.
function matchSheet(name, tabs) {
  const n = normHeader(name);
  const employees = tabs.find((t) => t.kind === 'employees');
  if (['exemployees', 'formeremployees', 'leavers'].includes(n) && employees) return { target: `tab:${employees.id}`, defaultStatus: 'inactive' };
  const tab = tabs.find((t) => normHeader(t.name) === n);
  if (!tab) return { target: 'skip', defaultStatus: 'active', unknown: true };
  if (tab.kind === 'stock') return { target: 'stock', defaultStatus: 'active' };
  if (tab.kind === 'ex_employees' && employees) return { target: `tab:${employees.id}`, defaultStatus: 'inactive' };
  return { target: `tab:${tab.id}`, defaultStatus: 'active' };
}

// Mapping for a sheet and its target: auto-matched, or (new tab) every column a new text field.
async function defaultMapping(db, sheet, tabs) {
  if (sheet.target === 'skip') return sheet.headers.map(() => ({ target: 'skip', type: 'text' }));
  if (sheet.target === 'newtab') return sheet.headers.map(() => ({ target: 'new', type: 'text' }));
  const scope = scopeFor(sheet, tabs);
  return planner.autoMatch(sheet.headers, await planner.targetsFor(db, scope));
}

function scopeFor(sheet, tabs) {
  if (sheet.target === 'stock') return { kind: 'stock', name: 'Stock' };
  if (sheet.target === 'newtab') return { kind: 'newtab', name: sheet.newTabName || sheet.name };
  if (String(sheet.target).startsWith('tab:')) {
    const tab = tabs.find((t) => t.id === Number(sheet.target.slice(4)));
    if (tab) return { kind: 'records', tab, name: tab.name };
  }
  return { kind: 'skip', name: 'Skipped' };
}

// Processing order: Employees, Stock, other tabs in tab order, then new tabs.
function ordered(sheets, tabs) {
  const weight = (s) => {
    const scope = scopeFor(s, tabs);
    if (scope.kind === 'records' && scope.tab.kind === 'employees') return 0;
    if (scope.kind === 'stock') return 1;
    if (scope.kind === 'records') return 2 + tabs.findIndex((t) => t.id === scope.tab.id) / 1000;
    if (scope.kind === 'newtab') return 3;
    return 9;
  };
  return sheets.map((s, index) => ({ ...s, index })).filter((s) => s.target !== 'skip').sort((a, b) => weight(a) - weight(b) || a.index - b.index);
}

// Plans every sheet (preview, or inside the confirm transaction with apply = true).
async function planAll(db, stage, user, { apply = false } = {}) {
  const tabs = await listTabs(db);
  const results = [];
  const pendingEmployees = [];
  for (const sheet of ordered(stage.sheets, tabs)) {
    const scope = scopeFor(sheet, tabs);
    const base = { mapping: sheet.mapping, headers: sheet.headers, rows: sheet.rows };
    let plan;
    if (scope.kind === 'stock') {
      if (apply) {
        const first = await planner.planStock(db, base);
        await planner.prepareStock(db, user, first);
      }
      plan = await planner.planStock(db, { ...base, extraEmployees: apply ? [] : pendingEmployees });
      if (apply) await planner.applyStock(db, user, { plan, fileName: `${stage.fileName} / ${sheet.name}` });
    } else {
      let tab = scope.kind === 'newtab' ? { id: 0, kind: 'records', name: scope.name } : scope.tab;
      let { mapping } = sheet;
      if (apply) {
        if (scope.kind === 'newtab') {
          const [[{ next }]] = await db.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM inventory_tabs');
          const [r] = await db.query("INSERT INTO inventory_tabs (kind, name, sort_order) VALUES ('records', ?, ?)", [scope.name.slice(0, 60), next]);
          tab = { id: r.insertId, kind: 'records', name: scope.name.slice(0, 60) };
          await logInv(db, user, { type: 'inv_config', action: 'created', subject: tab.name, summary: `Added the inventory tab "${tab.name}" (import from ${stage.fileName})` });
        }
        if (tab.kind === 'employees') await lockEmployees(db, tab.id);
        mapping = await planner.createRecordFields(db, user, { tab, mapping, headers: sheet.headers, rows: sheet.rows, newTab: scope.kind === 'newtab' });
      }
      plan = await planner.planRecords(db, {
        tab, mapping, headers: sheet.headers, rows: sheet.rows, defaultStatus: sheet.defaultStatus || 'active', newTab: scope.kind === 'newtab' && !apply,
      });
      if (apply) await planner.applyRecords(db, user, { tab, plan, fileName: `${stage.fileName} / ${sheet.name}` });
      if (tab.kind === 'employees') {
        for (const r of plan.rows) if (r.action === 'create') pendingEmployees.push({ title: r.title, uid: r.apply.uid, status: r.apply.status });
      }
    }
    if (apply) {
      const c = plan.counts;
      await logInv(db, user, {
        type: 'inv_config', action: 'uploaded', subject: scope.name,
        summary: `Imported sheet "${sheet.name}" of ${stage.fileName} into ${scope.name}: ${c.create} created, ${c.update} updated, ${c.unchanged} unchanged, ${c.skip} skipped`,
      });
    }
    results.push({ sheet, scope, plan });
  }
  return results;
}

module.exports = { exportWorkbook, matchSheet, defaultMapping, scopeFor, ordered, planAll };
