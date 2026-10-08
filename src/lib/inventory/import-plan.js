// Inventory import, part 2: turning mapped spreadsheet rows into a plan (create / update /
// no change / skip, with errors and warnings) and applying it. The same planner runs for
// the Preview and, inside the Confirm transaction, again before anything is written, so
// what is saved always matches what the checks allowed. Rows with errors are skipped,
// never guessed. Secrets are only ever shown masked and are encrypted when saved.
//
// Matching: Employees by User-ID (else Email), Writers by Official-ID, Old Accounts by
// Gmail-ID, other tabs by their name field, Stock by Serial / Asset number.
const { londonDate } = require('../activity');
const {
  FIELD_TYPES, CATEGORY_TYPES, STOCK_STATUSES, MASK, isSecret, listFields, readValues, saveValues,
} = require('./fields');
const { recordTitle, listRecords, employeesTab, logInv } = require('./records');
const { listCategories, listItems, getItem, itemLabel, assignItem, returnItem, returnAll } = require('./stock');
const { getPrefix, normalizeId, lowestFree } = require('./userids');
const { normHeader, parseAccess, parseDate } = require('./import-files');

// ---- Mapping targets ----

const STOCK_CORE = [
  ['category', 'Category', ['category', 'type']],
  ['brand', 'Brand', ['brand', 'make', 'manufacturer']],
  ['model', 'Model', ['model']],
  ['serial', 'Serial / Asset number', ['serial', 'serialno', 'serialnumber', 'assetnumber', 'assetno', 'serialassetnumber', 'serialassetno', 'assettag', 'tag']],
  ['status', 'Status', ['status']],
  ['assigned', 'Assigned to', ['assignedto', 'assigned', 'employee', 'user', 'usedby', 'holder']],
  ['notes', 'Notes', ['notes', 'note', 'comments']],
];

// What a column can be mapped to: [{ value, label, norms: [...] }].
async function targetsFor(db, scope) {
  if (scope.kind === 'stock') {
    const cats = await listCategories(db, { withFields: true });
    const extras = new Map();
    for (const c of cats) for (const f of c.fields) if (!extras.has(normHeader(f.label))) extras.set(normHeader(f.label), f.label);
    return [
      ...STOCK_CORE.map(([value, label, norms]) => ({ value, label, norms })),
      ...[...extras].map(([norm, label]) => ({ value: `x:${norm}`, label: `${label} (category field)`, norms: [norm] })),
    ];
  }
  const fields = await listFields(db, { tabId: scope.tab.id });
  const list = fields.map((f) => ({ value: `f:${f.id}`, label: f.label, norms: [normHeader(f.label)], type: f.field_type }));
  if (scope.tab.kind === 'employees') {
    list.push({ value: 'status', label: 'Status (Active / Inactive)', norms: ['status', 'employeestatus'] });
    list.push({ value: 'leaving', label: 'Leaving date', norms: ['leavingdate', 'leftdate', 'leavedate', 'enddate', 'left'] });
  }
  return list;
}

// Header -> target value by name (case and punctuation ignored); unmatched -> 'skip'.
function autoMatch(headers, targets) {
  const used = new Set();
  return headers.map((h) => {
    const n = normHeader(h);
    const t = targets.find((x) => !used.has(x.value) && x.norms.includes(n));
    if (!t) return { target: 'skip', type: 'text' };
    used.add(t.value);
    return { target: t.value, type: 'text' };
  });
}

const distinct = (rows, col) => [...new Set(rows.map((r) => String(r[col] || '').trim()).filter(Boolean))].slice(0, 100);

// Columns marked "create a new field": [{ col, label, type, options }].
function newFieldSpecs(mapping, headers, rows, allowed) {
  return mapping.map((m, col) => ({ m, col })).filter(({ m }) => m.target === 'new').map(({ m, col }) => {
    const type = allowed.includes(m.type) ? m.type : 'text';
    return {
      col, label: String(headers[col]).trim().slice(0, 100) || `Column ${col + 1}`, type,
      options: type === 'dropdown' ? distinct(rows, col).join('\n') : null,
    };
  });
}

// ---- Records tabs ----

const lower = (s) => String(s || '').trim().toLowerCase();

function keyFieldFor(tab, fields) {
  if (tab.kind === 'employees') return null; // User-ID, then Email (below)
  const byNorm = (n) => fields.find((f) => normHeader(f.label) === n);
  return byNorm('officialid') || byNorm('gmailid') || fields.find((f) => f.role === 'title') || null;
}

// Plan for a records tab. mapping uses 'f:<id>' (existing or already-created fields),
// 'new' (virtual fields, preview only), 'status', 'leaving', 'skip'.
async function planRecords(db, { tab, mapping, headers, rows }) {
  const realFields = await listFields(db, { tabId: tab.id });
  const specs = newFieldSpecs(mapping, headers, rows, Object.keys(FIELD_TYPES));
  const virtual = specs.map((s, i) => ({
    id: -(i + 1), label: s.label, field_type: s.type, options: s.options, optionList: s.options ? s.options.split('\n') : [],
    visible: true, required: false, role: null, isNew: true,
  }));
  const fields = [...realFields, ...virtual];
  const colField = mapping.map((m, col) => {
    if (m.target === 'new') return virtual[specs.findIndex((s) => s.col === col)];
    if (String(m.target).startsWith('f:')) return realFields.find((f) => f.id === Number(m.target.slice(2))) || null;
    return null;
  });
  const colOf = (target) => mapping.findIndex((m) => m.target === target);
  const isEmp = tab.kind === 'employees';
  const uidField = isEmp ? realFields.find((f) => f.role === 'user_id') : null;
  const emailField = isEmp ? realFields.find((f) => f.role === 'email') : null;
  const keyField = keyFieldFor(tab, realFields);
  const uidCol = uidField ? colField.findIndex((f) => f && f.id === uidField.id) : -1;
  const emailCol = emailField ? colField.findIndex((f) => f && f.id === emailField.id) : -1;
  const keyCol = keyField ? colField.findIndex((f) => f && f.id === keyField.id) : -1;
  const statusCol = colOf('status');
  const leavingCol = colOf('leaving');
  const prefix = isEmp ? await getPrefix(db) : null;

  const existing = await listRecords(db, tab.id);
  const index = (field) => {
    const map = new Map();
    if (!field) return map;
    for (const r of existing) {
      const v = r.values.get(field.id)?.value;
      if (!v) continue;
      const k = lower(v);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return map;
  };
  const byUid = index(uidField);
  const byEmail = index(emailField);
  const byKey = index(keyField);
  const activeIds = new Set(uidField ? existing.filter((r) => r.status === 'active').map((r) => r.values.get(uidField.id)?.value).filter(Boolean).map((v) => v.toUpperCase()) : []);
  const seen = new Map();
  const notes = [];
  if (isEmp && uidCol < 0 && emailCol < 0) notes.push('There is no User-ID or Email column, so every row is added as a new employee.');
  if (!isEmp && keyCol < 0 && keyField) notes.push(`There is no ${keyField.label} column, so every row is added as new.`);

  const pick = (list, label) => {
    if (!list || !list.length) return { record: null };
    const active = list.filter((r) => r.status === 'active');
    if (active.length === 1) return { record: active[0] };
    if (active.length > 1) return { error: `More than one active record has this ${label}.` };
    if (list.length === 1) return { record: list[0] };
    return { error: `More than one record has this ${label}.` };
  };

  const reserved = new Set();
  if (isEmp && uidField) {
    for (const cells of rows) {
      const n = uidCol >= 0 && cells[uidCol] ? normalizeId(prefix, cells[uidCol]) : {};
      const wantsActive = !(statusCol >= 0 && /^(inactive|left|ex|former|ex employee)$/i.test(String(cells[statusCol] || '').trim()));
      if (!n.value || !wantsActive) continue;
      const list = byUid.get(lower(n.value)) || [];
      const ownerIsActive = list.some((r) => r.status === 'active');
      if (!ownerIsActive) reserved.add(n.value.toUpperCase()); // new with this ID, or an ex employee coming back
    }
  }
  const freeId = (except) => lowestFree(prefix, [...activeIds, ...[...reserved].filter((x) => x !== except)]);

  const out = rows.map((cells, i) => {
    const row = { n: i + 2, errors: [], warnings: [], display: [], action: 'create', title: '' };
    // Which record this row is.
    let record = null;
    let uid = '';
    let keyText = '';
    if (isEmp) {
      if (uidCol >= 0 && cells[uidCol]) {
        const n = normalizeId(prefix, cells[uidCol]);
        if (n.error) row.errors.push(n.error);
        else uid = n.value;
      }
      const email = emailCol >= 0 ? lower(cells[emailCol]) : '';
      const found = uid ? pick(byUid.get(lower(uid)), 'User-ID') : email ? pick(byEmail.get(email), 'email') : { record: null };
      if (found.error) row.errors.push(found.error);
      record = found.record;
      keyText = uid ? `uid:${uid.toUpperCase()}` : email ? `email:${email}` : '';
    } else if (keyCol >= 0 && cells[keyCol]) {
      const found = pick(byKey.get(lower(cells[keyCol])), keyField.label);
      if (found.error) row.errors.push(found.error);
      record = found.record;
      keyText = `key:${lower(cells[keyCol])}`;
    }
    if (keyText) {
      if (seen.has(keyText)) row.errors.push(`Same ${isEmp ? 'User-ID / email' : keyField.label} as row ${seen.get(keyText)}.`);
      else seen.set(keyText, row.n);
    }
    row.action = record ? 'update' : 'create';
    const before = record ? record.values : new Map();

    // Field values, through the same checks as the forms.
    const body = {};
    const used = [];
    colField.forEach((f, col) => {
      if (!f || (uidField && f.id === uidField.id)) return;
      const text = cells[col];
      if (f.field_type === 'access') {
        const g = parseAccess(text);
        if (g === null) row.errors.push(`${f.label}: "${text}" is not Yes / No.`);
        else {
          body[`f_${f.id}`] = g ? 'granted' : '';
          row.display.push({ label: f.label, text: g ? 'Granted' : 'Not granted' });
          used.push(f);
        }
        return;
      }
      if (record && !text) return; // empty cells leave saved values alone
      let value = text;
      if (f.field_type === 'date' && text) {
        value = parseDate(text);
        if (value === null) {
          row.errors.push(`${f.label}: "${text}" is not a valid date.`);
          return;
        }
      }
      body[`f_${f.id}`] = value;
      used.push(f);
      if (text) row.display.push({ label: f.label, text: isSecret(f) ? MASK : value });
    });
    const { values, errors } = readValues(body, used, before);
    row.errors.push(...errors.filter((e) => !e.startsWith('ENCRYPTION_KEY')));
    if (errors.some((e) => e.startsWith('ENCRYPTION_KEY'))) row.errors.push(errors.find((e) => e.startsWith('ENCRYPTION_KEY')));

    // Name.
    const after = new Map(before);
    for (const [k, c] of values) if ('value' in c) after.set(k, { value: c.value });
    row.title = recordTitle(record || { id: '' }, fields, after);
    const titleField = fields.find((f) => f.role === 'title');
    if (!record && titleField && !after.get(titleField.id)?.value && !row.errors.some((e) => e.startsWith(`${titleField.label} is required`))) {
      row.errors.push(`Missing ${titleField.label.toLowerCase()}.`);
    }

    // Employees: status, leaving date, User-ID.
    let status = record ? record.status : 'active';
    let leaving = record ? record.leaving_date : null;
    let newUid = null;
    if (isEmp) {
      if (statusCol >= 0 && cells[statusCol]) {
        const s = lower(cells[statusCol]);
        if (['active', 'current'].includes(s)) status = 'active';
        else if (['inactive', 'left', 'ex', 'former', 'ex employee'].includes(s)) status = 'inactive';
        else row.errors.push(`Status "${cells[statusCol]}" is not Active or Inactive.`);
      }
      if (leavingCol >= 0 && cells[leavingCol]) {
        const d = parseDate(cells[leavingCol]);
        if (d === null) row.errors.push(`Leaving date "${cells[leavingCol]}" is not a valid date.`);
        else leaving = d;
      }
      if (status === 'active') leaving = null;
      else if (!leaving) row.warnings.push('Inactive without a leaving date.');
      const oldUid = record && uidField ? record.values.get(uidField.id)?.value || '' : '';
      const wasActive = record && record.status === 'active';
      if (!row.errors.length && uidField) {
        if (status === 'active') {
          const wanted = uid || oldUid;
          const takenByOther = (id) => activeIds.has(id.toUpperCase()) && !(wasActive && oldUid && oldUid.toUpperCase() === id.toUpperCase());
          if (wanted && !takenByOther(wanted)) newUid = wanted;
          else if (wanted && uid && (!record || uid.toUpperCase() !== oldUid.toUpperCase())) row.errors.push(`${uid} is already used by another active employee.`);
          else {
            newUid = freeId(wanted ? wanted.toUpperCase() : null);
            row.warnings.push(record && oldUid ? `User-ID changed from ${oldUid} to ${newUid} on reactivation.` : `User-ID ${newUid} will be given.`);
          }
          if (newUid && !row.errors.length) activeIds.add(newUid.toUpperCase());
        } else {
          newUid = uid || oldUid || '';
          if (!newUid) row.warnings.push('No User-ID (ex employees keep whatever they had).');
        }
      }
      if (record && record.status !== status) row.warnings.push(status === 'inactive' ? 'Will be marked inactive; their equipment returns to stock.' : 'Will be reactivated.');
      row.display.unshift({ label: 'Status', text: status === 'active' ? 'Active' : `Inactive${leaving ? ` (left ${leaving})` : ''}` });
      if (newUid) row.display.unshift({ label: uidField.label, text: newUid });
    }

    if (row.errors.length) row.action = 'skip';
    else if (record) {
      const plainChanged = [...values].some(([k, c]) => c.secret || c.clear || (before.get(k)?.value || null) !== (c.value || null));
      const uidChanged = newUid !== null && uidField && (record.values.get(uidField.id)?.value || '') !== newUid;
      if (!plainChanged && !uidChanged && record.status === status && (record.leaving_date || null) === (leaving || null)) row.action = 'unchanged';
    }
    row.apply = { recordId: record ? record.id : null, values, status, leaving, uid: newUid, wasStatus: record ? record.status : null, before };
    return row;
  });
  return summarise(out, { notes, newFields: specs.map((s) => `${s.label} (${FIELD_TYPES[s.type]})`) });
}

function summarise(rows, extra) {
  const counts = { create: 0, update: 0, unchanged: 0, skip: 0 };
  for (const r of rows) counts[r.action] += 1;
  return { rows, counts, ...extra };
}

// Applies a records plan (inside the confirm transaction, fields already created).
async function applyRecords(conn, user, { tab, plan, fileName }) {
  const fields = await listFields(conn, { tabId: tab.id });
  const uidField = tab.kind === 'employees' ? fields.find((f) => f.role === 'user_id') : null;
  for (const row of plan.rows) {
    if (row.action === 'skip' || row.action === 'unchanged') continue;
    const a = row.apply;
    if (uidField && a.uid !== null && a.uid !== undefined) a.values.set(uidField.id, { value: a.uid || null });
    if (row.action === 'create') {
      const [r] = await conn.query(
        'INSERT INTO inventory_records (tab_id, status, leaving_date, created_by, updated_by) VALUES (?, ?, ?, ?, ?)',
        [tab.id, a.status, a.leaving || null, user.id, user.id]
      );
      await saveValues(conn, r.insertId, fields, a.values);
      await logInv(conn, user, { type: 'inv_record', id: r.insertId, action: 'created', subject: row.title, summary: `Added ${row.title} to ${tab.name} (import from ${fileName})` });
      continue;
    }
    const labels = await saveValues(conn, a.recordId, fields, a.values, a.before);
    if (a.wasStatus === 'active' && a.status === 'inactive') {
      await returnAll(conn, user, { id: a.recordId, title: row.title }, a.leaving || londonDate());
    }
    if (a.wasStatus !== a.status) labels.push('status');
    await conn.query('UPDATE inventory_records SET status = ?, leaving_date = ?, updated_by = ? WHERE id = ?',
      [a.status, a.leaving || null, user.id, a.recordId]);
    await logInv(conn, user, {
      type: 'inv_record', id: a.recordId, action: 'updated', subject: row.title, changes: labels,
      summary: `Updated ${row.title} (import from ${fileName})${labels.length ? `: ${labels.join(', ')}` : ''}`,
    });
  }
}

// ---- Stock ----

const STATUS_BY_TEXT = Object.fromEntries(Object.entries(STOCK_STATUSES).flatMap(([k, label]) => [[k, k], [label.toLowerCase(), k]]));
STATUS_BY_TEXT['in use'] = 'assigned';
STATUS_BY_TEXT.spare = 'available';
STATUS_BY_TEXT.broken = 'damaged';

async function employeeIndex(db) {
  const tab = await employeesTab(db);
  if (!tab) return { byUid: new Map(), byName: new Map(), prefix: await getPrefix(db) };
  const fields = await listFields(db, { tabId: tab.id });
  const uidField = fields.find((f) => f.role === 'user_id');
  const records = (await listRecords(db, tab.id)).map((r) => ({ ...r, title: recordTitle(r, fields, r.values) }));
  const add = (map, k, r) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(r); };
  const byUid = new Map();
  const byName = new Map();
  for (const r of records) {
    add(byUid, uidField ? lower(r.values.get(uidField.id)?.value) : '', r);
    add(byName, lower(r.title), r);
  }
  return { byUid, byName, prefix: await getPrefix(db) };
}

async function planStock(db, { mapping, headers, rows }) {
  const categories = await listCategories(db, { withFields: true });
  const catByName = new Map(categories.map((c) => [lower(c.name), c]));
  const items = await listItems(db);
  const bySerial = new Map();
  for (const it of items) if (it.serial) { const k = lower(it.serial); if (!bySerial.has(k)) bySerial.set(k, []); bySerial.get(k).push(it); }
  const knownModels = new Set(items.map((it) => `${it.category_id}|${lower(it.brand)}|${lower(it.model)}`));
  const emp = await employeeIndex(db);
  const specs = newFieldSpecs(mapping, headers, rows, CATEGORY_TYPES);
  const colOf = (t) => mapping.findIndex((m) => m.target === t);
  const cols = Object.fromEntries(STOCK_CORE.map(([t]) => [t, colOf(t)]));
  // Category extra columns: [{ col, norm, label, spec? }]
  const extraCols = mapping.map((m, col) => ({ m, col })).filter(({ m }) => String(m.target).startsWith('x:') || m.target === 'new')
    .map(({ m, col }) => (m.target === 'new'
      ? { col, norm: normHeader(headers[col]), label: specs.find((s) => s.col === col).label, spec: specs.find((s) => s.col === col) }
      : { col, norm: m.target.slice(2), label: null }));
  // Type of a category field label anywhere (for fields created in new categories).
  const typeOfNorm = new Map();
  for (const c of categories) for (const f of c.fields) if (!typeOfNorm.has(normHeader(f.label))) typeOfNorm.set(normHeader(f.label), f);

  const newCategories = new Set();
  const newModels = new Set();
  const needFields = new Map(); // category name -> Map(norm -> { label, type, options })
  const notes = [];
  if (cols.serial < 0) notes.push('There is no Serial / Asset number column, so every row is added as a new item.');
  if (cols.category < 0) notes.push('There is no Category column: every row needs one, so all rows are skipped.');
  const seenSerial = new Map();

  const out = rows.map((cells, i) => {
    const row = { n: i + 2, errors: [], warnings: [], display: [], action: 'create', title: '' };
    const text = (t) => (cols[t] >= 0 ? String(cells[cols[t]] || '').trim() : '');
    const catName = text('category');
    let cat = catByName.get(lower(catName)) || null;
    if (!catName) row.errors.push('Missing category.');
    else if (!cat) {
      newCategories.add(catName);
      cat = { id: null, name: catName, fields: [] };
      catByName.set(lower(catName), cat);
    }
    const serial = text('serial');
    let item = null;
    if (serial) {
      if (seenSerial.has(lower(serial))) row.errors.push(`Duplicate serial / asset number (also row ${seenSerial.get(lower(serial))}).`);
      else seenSerial.set(lower(serial), row.n);
      const found = bySerial.get(lower(serial)) || [];
      if (found.length > 1) row.errors.push('More than one item already has this serial / asset number.');
      else item = found[0] || null;
    } else row.warnings.push('No serial / asset number: always added as a new item.');
    row.action = item ? 'update' : 'create';
    const brand = text('brand') || (item ? item.brand : '') || '';
    const model = text('model') || (item ? item.model : '') || '';
    const notesText = text('notes');
    row.title = itemLabel({ category_name: cat ? cat.name : catName, brand, model, serial });

    // Status and who has it.
    let status = null;
    if (text('status')) {
      status = STATUS_BY_TEXT[lower(text('status'))] || null;
      if (!status) row.errors.push(`Status "${text('status')}" is not one of ${Object.values(STOCK_STATUSES).join(', ')}.`);
    }
    let holder = null;
    const who = text('assigned');
    if (who) {
      const n = normalizeId(emp.prefix, who);
      let list = !n.error && n.value ? emp.byUid.get(lower(n.value)) || [] : [];
      if (!list.length) list = emp.byName.get(lower(who)) || [];
      const active = list.filter((r) => r.status === 'active');
      if (!list.length) row.errors.push(`Unknown employee "${who}" in Assigned to.`);
      else if (active.length > 1 || (!active.length && list.length > 1)) row.errors.push(`"${who}" matches more than one employee; use their User-ID.`);
      else holder = active[0] || list[0];
    }
    let finalStatus = status || (item ? item.status : 'available');
    if (holder && holder.status === 'active') {
      if (status && status !== 'assigned') row.warnings.push(`Status ${STOCK_STATUSES[status]} ignored: assigned to ${holder.title}.`);
      finalStatus = 'assigned';
    } else if (holder) {
      if (finalStatus === 'assigned') finalStatus = 'available';
      row.warnings.push(`${holder.title} is an ex employee: kept ${STOCK_STATUSES[finalStatus]}, added to their Equipment held.`);
    } else if (finalStatus === 'assigned' && !(item && item.employee_id)) {
      row.errors.push('Status Assigned needs an employee in Assigned to.');
    }
    if (item && item.employee_id && holder && holder.id !== item.employee_id) row.warnings.push(`Moves from ${item.employee_name} to ${holder.title}.`);
    if (item && item.employee_id && !holder && finalStatus !== 'assigned') row.warnings.push(`Returned from ${item.employee_name} to stock.`);

    // Category extra fields.
    const extras = [];
    for (const x of extraCols) {
      const value = String(cells[x.col] || '').trim();
      if (!value || !cat) continue;
      let field = cat.fields.find((f) => normHeader(f.label) === x.norm);
      if (!field) {
        const template = x.spec ? { label: x.spec.label, field_type: x.spec.type, options: x.spec.options } : (cat.id ? null : typeOfNorm.get(x.norm));
        if (!template) {
          row.warnings.push(`${headers[x.col]} ignored: ${cat.name} has no such field.`);
          continue;
        }
        if (!needFields.has(cat.name)) needFields.set(cat.name, new Map());
        needFields.get(cat.name).set(x.norm, { label: template.label, type: template.field_type, options: template.options || null });
        field = { id: null, label: template.label, field_type: template.field_type, optionList: String(template.options || '').split('\n').filter(Boolean) };
      }
      let v = value;
      if (field.field_type === 'date') {
        v = parseDate(value);
        if (v === null) { row.errors.push(`${field.label}: "${value}" is not a valid date.`); continue; }
      }
      if (field.field_type === 'dropdown' && field.optionList.length && !field.optionList.some((o) => lower(o) === lower(v))) {
        row.errors.push(`${field.label}: "${value}" is not one of ${field.optionList.join(', ')}.`);
        continue;
      }
      if (field.field_type === 'dropdown') v = field.optionList.find((o) => lower(o) === lower(v)) || v;
      extras.push({ norm: x.norm, label: field.label, value: v });
      row.display.push({ label: field.label, text: v });
    }
    if (cat && (brand || model) && !knownModels.has(`${cat.id}|${lower(brand)}|${lower(model)}`)) newModels.add(`${cat.name}: ${[brand, model].filter(Boolean).join(' ')}`);
    row.display.unshift(...[
      { label: 'Category', text: cat ? cat.name : catName }, { label: 'Brand', text: brand }, { label: 'Model', text: model },
      { label: 'Serial', text: serial }, { label: 'Status', text: STOCK_STATUSES[finalStatus] || '' },
      ...(holder ? [{ label: 'Assigned to', text: holder.title }] : []),
    ].filter((d) => d.text));

    if (row.errors.length) row.action = 'skip';
    else if (item) {
      const same = (a, b) => lower(a) === lower(b);
      const extrasSame = extras.every((x) => {
        const f = cat.fields.find((ff) => normHeader(ff.label) === x.norm);
        return f && f.id && same(item.values.get(f.id)?.value, x.value);
      });
      if (same(item.category_name, cat.name) && same(item.brand, brand) && same(item.model, model) && same(item.status, finalStatus)
        && (!notesText || same(item.notes, notesText)) && (holder ? holder.id === item.employee_id : true) && extrasSame) row.action = 'unchanged';
    }
    row.apply = { itemId: item ? item.id : null, catName: cat ? cat.name : catName, brand: brand || null, model: model || null, serial: serial || null,
      notes: notesText || (item ? item.notes : null), status: finalStatus, holder: holder ? { id: holder.id, title: holder.title, status: holder.status, leaving: holder.leaving_date } : null, extras };
    return row;
  });
  return summarise(out, {
    notes, newCategories: [...newCategories], newModels: [...newModels].slice(0, 200),
    newFields: [...needFields].flatMap(([c, m]) => [...m.values()].map((f) => `${c}: ${f.label} (${FIELD_TYPES[f.type]})`)),
    needFields,
  });
}

// Creates the new categories and category fields a stock plan needs.
async function prepareStock(conn, user, plan) {
  for (const name of plan.newCategories) {
    const [[{ next }]] = await conn.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM stock_categories');
    await conn.query('INSERT IGNORE INTO stock_categories (name, sort_order) VALUES (?, ?)', [name.slice(0, 100), next]);
    await logInv(conn, user, { type: 'inv_config', action: 'created', subject: name, summary: `Added the stock category "${name}" (import)` });
  }
  const cats = await listCategories(conn);
  for (const [catName, map] of plan.needFields) {
    const cat = cats.find((c) => lower(c.name) === lower(catName));
    if (!cat) continue;
    for (const f of map.values()) {
      const [[{ next }]] = await conn.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM inventory_fields WHERE category_id = ?', [cat.id]);
      await conn.query('INSERT INTO inventory_fields (category_id, label, field_type, options, sort_order, width) VALUES (?, ?, ?, ?, ?, 160)',
        [cat.id, f.label, f.type, f.options, next]);
      await logInv(conn, user, { type: 'inv_config', action: 'created', subject: cat.name, summary: `Added the field "${f.label}" to ${cat.name} (import)` });
    }
  }
}

async function applyStock(conn, user, { plan, fileName }) {
  const cats = await listCategories(conn, { withFields: true });
  const catOf = (name) => cats.find((c) => lower(c.name) === lower(name));
  const today = londonDate();
  for (const row of plan.rows) {
    if (row.action === 'skip' || row.action === 'unchanged') continue;
    const a = row.apply;
    const cat = catOf(a.catName);
    const values = new Map();
    for (const x of a.extras) {
      const f = cat.fields.find((ff) => normHeader(ff.label) === x.norm);
      if (f) values.set(f.id, { value: x.value });
    }
    let itemId = a.itemId;
    const status = a.holder && a.holder.status === 'active' ? 'available' : a.status;
    if (!itemId) {
      const [r] = await conn.query(
        'INSERT INTO stock_items (category_id, brand, model, serial, status, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [cat.id, a.brand, a.model, a.serial, status, a.notes, user.id, user.id]
      );
      itemId = r.insertId;
      await saveValues(conn, itemId, cat.fields, values, new Map(), 'stock_values');
      await logInv(conn, user, { type: 'inv_item', id: itemId, action: 'created', subject: row.title, summary: `Added ${row.title} to stock (import from ${fileName})` });
    } else {
      let item = await getItem(conn, itemId, { lock: true });
      // Leaving its current holder (moved to someone else, or status no longer Assigned).
      if (item.employee_id && (a.holder ? a.holder.id !== item.employee_id : a.status !== 'assigned')) {
        await returnItem(conn, user, item, { status: a.holder ? 'available' : a.status, reason: 'import' });
        item = await getItem(conn, itemId, { lock: true });
      }
      const keepAssigned = item.employee_id && (!a.holder || a.holder.id === item.employee_id);
      if (item.category_id !== cat.id) await conn.query('DELETE FROM stock_values WHERE item_id = ?', [itemId]);
      await conn.query('UPDATE stock_items SET category_id = ?, brand = ?, model = ?, serial = ?, status = ?, notes = ?, updated_by = ? WHERE id = ?',
        [cat.id, a.brand, a.model, a.serial, keepAssigned ? 'assigned' : status, a.notes, user.id, itemId]);
      const labels = await saveValues(conn, itemId, cat.fields, values, item.category_id === cat.id ? item.values : new Map(), 'stock_values');
      await logInv(conn, user, { type: 'inv_item', id: itemId, action: 'updated', subject: row.title, changes: labels, summary: `Updated ${row.title} (import from ${fileName})` });
    }
    if (a.holder && a.holder.status === 'active') {
      const item = await getItem(conn, itemId, { lock: true });
      if (item.employee_id !== a.holder.id && item.status === 'available') await assignItem(conn, user, item, { id: a.holder.id, title: a.holder.title });
    } else if (a.holder) {
      // Ex employee: the item stays in stock; their profile lists it under Equipment held.
      const on = a.holder.leaving || today;
      await conn.query(`
        INSERT INTO stock_assignments (item_id, employee_id, category_name, brand, model, serial, assigned_on, returned_on, assigned_by, returned_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [itemId, a.holder.id, cat.name, a.brand, a.model, a.serial, on, on, user.id, user.id]);
      await logInv(conn, user, {
        type: 'inv_item', id: itemId, action: 'returned', subject: row.title, personId: a.holder.id,
        summary: `Recorded ${row.title} as held by ${a.holder.title} (ex employee, import from ${fileName})`,
      });
    }
  }
}

// Creates the "new field" columns of a records import and points the mapping at them.
async function createRecordFields(conn, user, { tab, mapping, headers, rows }) {
  const specs = newFieldSpecs(mapping, headers, rows, Object.keys(FIELD_TYPES));
  const out = mapping.map((m) => ({ ...m }));
  for (const s of specs) {
    const [[{ next }]] = await conn.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM inventory_fields WHERE tab_id = ?', [tab.id]);
    const [r] = await conn.query('INSERT INTO inventory_fields (tab_id, label, field_type, options, sort_order, width) VALUES (?, ?, ?, ?, ?, 160)',
      [tab.id, s.label, s.type, s.options, next]);
    out[s.col] = { target: `f:${r.insertId}` };
    await logInv(conn, user, { type: 'inv_config', action: 'created', subject: tab.name, summary: `Added the column "${s.label}" (${FIELD_TYPES[s.type]}) to ${tab.name} (import)` });
  }
  return out;
}

module.exports = {
  STOCK_CORE, targetsFor, autoMatch, planRecords, applyRecords, createRecordFields, planStock, prepareStock, applyStock,
};
