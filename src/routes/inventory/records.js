// Records tabs (Employees, Ex Employees, Writers, Old Accounts, custom tabs): lists,
// add / edit / delete, the employee profile with access switches and equipment, making
// an employee inactive (leaving date, all kit back to stock) and reactivating them.
const express = require('express');
const { pool, transaction } = require('../../db');
const { requireId, toId, flash, notFound, backPath } = require('../../lib/http');
const { londonDate } = require('../../lib/activity');
const { isDate } = require('../../lib/report');
const {
  getTab, dataTab, listRecords, getRecord, recordTitle, fieldByRole, logInv,
} = require('../../lib/inventory/records');
const {
  FIELD_TYPES, SECRET_TYPES, listFields, readValues, saveValues, readFieldForm, optionsOf,
} = require('../../lib/inventory/fields');
const {
  listExtras, getExtra, readExtraDef, readExtraValue, updateExtra, deleteExtra, moveExtra, makeShared, extrasText, asField,
} = require('../../lib/inventory/extras');
const { looksLikeValue } = require('../../lib/inventory/field-admin');
const {
  getPrefix, suggestId, checkId, resolveId, lockEmployees, activeIds, isTaken, lowestFree,
} = require('../../lib/inventory/userids');
const { fieldColumns, fixedColumn, fieldCells } = require('../../lib/inventory/grid');
const {
  listCategories, listItems, getItem, assignItem, returnAll, assignmentsFor,
} = require('../../lib/inventory/stock');

const router = express.Router();

const isEmployees = (tab) => tab.kind === 'employees';

// The Employees User-ID field (role 'user_id'), when it is on the form.
const userIdField = (tab, fields) => (isEmployees(tab) ? fields.find((f) => f.role === 'user_id' && f.visible) || null : null);
// "Aisha Khan (MDP-013)" for log lines, so people sharing a reused User-ID stay distinct.
const withUserId = (title, uid) => (uid ? `${title} (${uid})` : title);

// Normalises and checks the typed User-ID before validation. Returns an error or null;
// on success the form value is replaced by the normalised one ('' = assign automatically).
async function prepareUserId(req, tab, fields, recordId = 0) {
  const field = userIdField(tab, fields);
  if (!field) return null;
  const result = await checkId(pool, tab.id, field.id, req.body[`f_${field.id}`], recordId);
  if (result.error) return result.error;
  req.body[`f_${field.id}`] = result.value;
  return null;
}

// Inside the save transaction: lock, then take the typed User-ID (if still free) or the
// lowest free one, and put it into the values being saved. Returns the User-ID.
async function settleUserId(conn, tab, fields, values, recordId = 0) {
  // A hidden User-ID column still gets a number on create; on edit it is left alone.
  const field = isEmployees(tab) ? fields.find((f) => f.role === 'user_id') : null;
  if (!field || (!field.visible && recordId)) return null;
  await lockEmployees(conn, tab.id);
  const typed = values.get(field.id)?.value || '';
  const result = await resolveId(conn, tab.id, field.id, typed, recordId);
  if (result.error) throw Object.assign(new Error(result.error), { status: 409 });
  values.set(field.id, { value: result.value });
  return result.value;
}

// The tab in the URL (not Stock) and the tab whose fields / records it shows.
async function tabContext(req) {
  const tab = await getTab(pool, requireId(req.params.id));
  if (tab.kind === 'stock') throw notFound();
  const data = await dataTab(pool, tab);
  const fields = await listFields(pool, { tabId: data.id });
  return { tab, data, fields };
}

// Activity for a record's History: its own entries, revealed secrets and (employees) the
// kit assigned to or returned from them. Old inventory rows are left out.
async function recordHistory(recordId) {
  const [rows] = await pool.query(`
    SELECT l.id, l.user_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS username, l.entity_type, l.entity_id,
           l.action, l.subject, l.summary, l.changes, l.created_at
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE (l.entity_type IN ('inv_record', 'inv_secret') AND l.entity_id = ?)
       OR (l.entity_type = 'inv_item' AND l.related_person_id = ?)
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 300
  `, [recordId, recordId]);
  return rows;
}

// ---- Lists ----

router.get('/t/:id', async (req, res) => {
  const { tab, data, fields } = await tabContext(req);
  const status = tab.kind === 'employees' ? 'active' : tab.kind === 'ex_employees' ? 'inactive' : null;
  const records = await listRecords(pool, data.id, status);
  const widths = res.locals.invWidths;
  const columns = fieldColumns(fields, widths);
  if (tab.kind === 'ex_employees') columns.push(fixedColumn('ex:left', 'Left', 110, widths, { sort: 'date' }));
  // Extra fields (this record only) are not columns: one "Extra" column shows "+N"
  // with their names; its text ("Name: value | ...", passwords masked) feeds search / CSV.
  const extras = await listExtras(pool, records.map((r) => r.id));
  const anyExtras = [...extras.values()].some((list) => list.length);
  if (anyExtras) columns.push(fixedColumn('extras', 'Extra', 80, widths, { sort: 'number', filter: { type: 'text' } }));
  const rows = records.map((r) => {
    const cells = fieldCells(fields, r.values, r.id);
    if (tab.kind === 'ex_employees') cells.push({ kind: 'date', value: r.leaving_date, sort: r.leaving_date || '', text: r.leaving_date || '' });
    if (anyExtras) {
      const list = extras.get(r.id) || [];
      cells.push({ kind: 'extras', count: list.length, names: list.map((x) => x.name), sort: String(list.length), text: extrasText(list, { mask: '(hidden)' }) });
    }
    return { href: `/inventory/r/${r.id}`, title: recordTitle(r, fields, r.values), cells };
  });
  res.render('inventory/records/index', {
    title: tab.name, tab, data, columns, rows,
    orderUrl: `/inventory/t/${data.id}/columns/order`,
  });
});

// ---- Add / edit ----

function renderForm(res, { tab, fields, record = null, title = '', input = {}, error = null, hints = {} }) {
  res.render('inventory/records/form', {
    title: record ? `Edit ${title}` : `Add to ${tab.name}`,
    tab, fields: fields.filter((f) => f.visible), record, recordTitle: title, input, error, hints,
    action: record ? `/inventory/r/${record.id}` : `/inventory/t/${tab.id}`,
    back: record ? `/inventory/r/${record.id}` : `/inventory/t/${tab.id}`,
  });
}

// Plain values the user typed, to fill the form again after an error (never secrets).
const typedValues = (body, fields) => Object.fromEntries(fields
  .filter((f) => !['password', 'pin'].includes(f.field_type))
  .map((f) => [f.id, typeof body[`f_${f.id}`] === 'string' ? body[`f_${f.id}`] : '']));

router.get('/t/:id/new', async (req, res) => {
  const { tab, data, fields } = await tabContext(req);
  if (tab.kind === 'ex_employees') return res.redirect(`/inventory/t/${data.id}/new`);
  const uid = userIdField(data, fields);
  const input = {};
  const hints = {};
  if (uid) {
    input[uid.id] = await suggestId(pool, data.id, uid.id);
    hints[uid.id] = `Suggested: the lowest number not used by an active employee. You can change it to any free ${await getPrefix(pool)} number.`;
  }
  renderForm(res, { tab: data, fields, input, hints });
});

router.post('/t/:id', async (req, res) => {
  const { tab, data, fields } = await tabContext(req);
  if (tab.kind === 'ex_employees') throw notFound();
  const visible = fields.filter((f) => f.visible);
  const uidError = await prepareUserId(req, data, fields);
  const { values, errors } = readValues(req.body, visible);
  if (uidError) errors.unshift(uidError);
  if (errors.length) {
    res.status(400);
    return renderForm(res, { tab: data, fields, input: typedValues(req.body, visible), error: errors.join(' ') });
  }
  const id = await transaction(async (conn) => {
    const uid = await settleUserId(conn, data, fields, values);
    const [r] = await conn.query('INSERT INTO inventory_records (tab_id, created_by, updated_by) VALUES (?, ?, ?)', [data.id, req.user.id, req.user.id]);
    await saveValues(conn, r.insertId, fields, values);
    const plain = new Map([...values].filter(([, c]) => 'value' in c).map(([k, c]) => [k, { value: c.value }]));
    const title = recordTitle({ id: r.insertId }, fields, plain);
    await logInv(conn, req.user, {
      type: 'inv_record', id: r.insertId, action: 'created', subject: title, summary: `Added ${withUserId(title, uid)} to ${data.name}`,
    });
    return r.insertId;
  });
  flash(req, 'success', 'Saved.');
  res.redirect(`/inventory/r/${id}`);
});

router.get('/r/:id/edit', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  if (isEmployees(ctx.tab) && ctx.record.status === 'inactive') {
    flash(req, 'error', 'Reactivate this employee before editing.');
    return res.redirect(`/inventory/r/${ctx.record.id}`);
  }
  const input = Object.fromEntries(ctx.fields.map((f) => [f.id, ctx.values.get(f.id)?.value || '']));
  const secretsSet = Object.fromEntries(ctx.fields.map((f) => [f.id, Boolean(ctx.values.get(f.id)?.hasSecret)]));
  renderForm(res, { tab: ctx.tab, fields: ctx.fields, record: { ...ctx.record, secretsSet }, title: ctx.title, input });
});

router.post('/r/:id', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  if (isEmployees(ctx.tab) && ctx.record.status === 'inactive') throw notFound();
  const visible = ctx.fields.filter((f) => f.visible);
  const uidError = await prepareUserId(req, ctx.tab, ctx.fields, ctx.record.id);
  const { values, errors } = readValues(req.body, visible, ctx.values);
  if (uidError) errors.unshift(uidError);
  if (errors.length) {
    res.status(400);
    const secretsSet = Object.fromEntries(ctx.fields.map((f) => [f.id, Boolean(ctx.values.get(f.id)?.hasSecret)]));
    return renderForm(res, {
      tab: ctx.tab, fields: ctx.fields, record: { ...ctx.record, secretsSet }, title: ctx.title,
      input: typedValues(req.body, visible), error: errors.join(' '),
    });
  }
  const changed = await transaction(async (conn) => {
    await settleUserId(conn, ctx.tab, ctx.fields, values, ctx.record.id);
    const labels = await saveValues(conn, ctx.record.id, ctx.fields, values, ctx.values);
    if (!labels.length) return labels;
    await conn.query('UPDATE inventory_records SET updated_by = ? WHERE id = ?', [req.user.id, ctx.record.id]);
    const after = new Map(ctx.values);
    for (const [k, c] of values) if ('value' in c) after.set(k, { value: c.value });
    const title = recordTitle(ctx.record, ctx.fields, after);
    await logInv(conn, req.user, {
      type: 'inv_record', id: ctx.record.id, action: 'updated', subject: title, changes: labels,
      summary: `Edited ${title} (${ctx.tab.name}): ${labels.join(', ')}`,
    });
    return labels;
  });
  flash(req, 'success', changed.length ? 'Saved.' : 'No changes.');
  res.redirect(`/inventory/r/${ctx.record.id}`);
});

router.post('/r/:id/delete', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  await transaction(async (conn) => {
    // Kit goes back to stock first, so nothing stays "assigned" to nobody.
    if (isEmployees(ctx.tab)) await returnAll(conn, req.user, { id: ctx.record.id, title: ctx.title }, londonDate());
    await conn.query('DELETE FROM inventory_records WHERE id = ?', [ctx.record.id]);
    await logInv(conn, req.user, {
      type: 'inv_record', id: ctx.record.id, action: 'deleted', subject: ctx.title, summary: `Deleted ${ctx.title} from ${ctx.tab.name}`,
    });
  });
  flash(req, 'success', `${ctx.title} deleted.`);
  const back = isEmployees(ctx.tab) && ctx.record.status === 'inactive' ? '/inventory' : `/inventory/t/${ctx.tab.id}`;
  res.redirect(back);
});

// ---- Record page / employee profile ----

// The record's saved User-ID (employees), or ''.
const uidOf = (ctx) => {
  const f = ctx.fields.find((x) => x.role === 'user_id');
  return f ? ctx.values.get(f.id)?.value || '' : '';
};

router.get('/r/:id', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  const history = await recordHistory(ctx.record.id);
  ctx.extras = (await listExtras(pool, [ctx.record.id])).get(ctx.record.id) || [];
  if (!isEmployees(ctx.tab)) {
    return res.render('inventory/records/show', { title: ctx.title, ...ctx, history });
  }
  const categories = await listCategories(pool, { withFields: true });
  const held = await listItems(pool, { employeeId: ctx.record.id });
  const available = ctx.record.status === 'active' ? await listItems(pool, { status: 'available' }) : [];
  const assignments = await assignmentsFor(pool, ctx.record.id);
  const equipment = categories.map((c) => ({
    ...c,
    items: held.filter((i) => i.category_id === c.id),
    available: available.filter((i) => i.category_id === c.id),
  }));
  res.render('inventory/employee', {
    title: ctx.title, ...ctx, history, equipment,
    pastAssignments: assignments.filter((a) => a.returned_on),
    userIdField: fieldByRole(ctx.fields, 'user_id'),
    emailField: fieldByRole(ctx.fields, 'email'),
    readOnly: ctx.record.status === 'inactive',
    today: londonDate(),
  });
});

// One field's value, edited in place on a record page (or from the field's "⋯" menu).
// Same rules as the full edit form: type checks, required fields, passwords / PINs
// encrypted (empty keeps the saved one, clear_<id> removes it) and Employee User-IDs.
// fetch() (Accept: application/json) gets { ok, html } with the new display; forms
// are redirected back with a message.
router.post('/r/:id/value', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  const json = (req.get('Accept') || '').includes('application/json');
  const back = backPath(req, `/inventory/r/${ctx.record.id}`);
  const fail = (status, error) => {
    if (json) return res.status(status).json({ ok: false, error });
    flash(req, 'error', error);
    return res.redirect(back);
  };
  if (isEmployees(ctx.tab) && ctx.record.status === 'inactive') return fail(400, 'Reactivate this employee before editing.');
  const field = ctx.fields.find((f) => f.id === toId(req.body.field_id));
  if (!field || field.field_type === 'access') return fail(400, 'That field is not on this record.');
  const uidError = field.role === 'user_id' ? await prepareUserId(req, ctx.tab, ctx.fields, ctx.record.id) : null;
  if (uidError) return fail(400, uidError);
  // Only this field: make sure it is read even if the column is hidden.
  const { values, errors } = readValues(req.body, [{ ...field, visible: true }], ctx.values);
  if (errors.length) return fail(400, errors.join(' '));
  let labels = [];
  try {
    labels = await transaction(async (conn) => {
      if (field.role === 'user_id' && values.has(field.id)) await settleUserId(conn, ctx.tab, ctx.fields.map((f) => (f.id === field.id ? { ...f, visible: true } : f)), values, ctx.record.id);
      const changed = await saveValues(conn, ctx.record.id, ctx.fields, values, ctx.values);
      if (!changed.length) return changed;
      await conn.query('UPDATE inventory_records SET updated_by = ? WHERE id = ?', [req.user.id, ctx.record.id]);
      const after = new Map(ctx.values);
      for (const [k, c] of values) if ('value' in c) after.set(k, { value: c.value });
      const title = recordTitle(ctx.record, ctx.fields, after);
      await logInv(conn, req.user, {
        type: 'inv_record', id: ctx.record.id, action: 'updated', subject: title, changes: changed,
        summary: `Edited ${title} (${ctx.tab.name}): ${changed.join(', ')}`,
      });
      return changed;
    });
  } catch (err) {
    if (err.status) return fail(err.status === 409 ? 409 : 400, err.message);
    console.error(`Saving inventory field ${field.id} on record ${ctx.record.id} failed:`, err);
    return fail(500, 'The value could not be saved because of a database error. Nothing was changed.');
  }
  if (!json) {
    flash(req, 'saved', labels.length ? `Saved. ${field.label} updated.` : 'Saved. Nothing changed.');
    return res.redirect(back);
  }
  const [[row]] = await pool.query('SELECT value, value_enc FROM inventory_values WHERE record_id = ? AND field_id = ?', [ctx.record.id, field.id]);
  const v = row ? { value: row.value, hasSecret: Boolean(row.value_enc) } : undefined;
  res.render('inventory/_value-display', { field, v, recordId: ctx.record.id, layout: false }, (err, html) => {
    if (err) return res.status(500).json({ ok: false, error: 'Saved, but the page could not be refreshed. Reload to see it.' });
    return res.json({ ok: true, changed: labels.length > 0, value: v && !v.hasSecret ? v.value || '' : '', html });
  });
});

// ---- Field popups ("⋯" menu): one Save for name, value and type ----

const recordBack = (req, ctx) => backPath(req, `/inventory/r/${ctx.record.id}#details`);
const editable = (ctx) => !(isEmployees(ctx.tab) && ctx.record.status === 'inactive');
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Shared field (all records): name and type change for every record in the tab (same
// checks as the Columns page); the value only for this record (same checks as the edit
// form, User-IDs included). Everything is saved together, or nothing.
router.post('/r/:id/fields/:fid', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  const back = recordBack(req, ctx);
  const before = ctx.fields.find((f) => f.id === toId(req.params.fid));
  if (!before) throw notFound();
  const isAccess = before.field_type === 'access';
  const { field: def, error } = readFieldForm({
    label: req.body.label, field_type: isAccess ? 'access' : req.body.field_type,
    options: typeof req.body.options === 'string' ? req.body.options : before.options || '',
    width: String(before.width), required: before.required ? '1' : '', visible: before.visible ? '1' : '0',
  }, isAccess ? ['access'] : Object.keys(FIELD_TYPES).filter((t) => t !== 'access'));
  if (error) {
    flash(req, 'error', error);
    return res.redirect(back);
  }
  const defChanges = [];
  if (def.label !== before.label) defChanges.push(`renamed "${before.label}" to "${def.label}"`);
  if (def.field_type !== before.field_type) defChanges.push(`type ${FIELD_TYPES[before.field_type]} → ${FIELD_TYPES[def.field_type]}`);
  if ((before.options || null) !== def.options) defChanges.push('options');
  const wasSecret = SECRET_TYPES.includes(before.field_type);
  if (wasSecret !== SECRET_TYPES.includes(def.field_type)) {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM inventory_values WHERE field_id = ? AND (value IS NOT NULL OR value_enc IS NOT NULL)', [before.id]);
    if (Number(n)) {
      flash(req, 'error', `"${before.label}" has data in ${n} record${Number(n) === 1 ? '' : 's'}, so it cannot change between a password / PIN and a plain type. Add a new field instead.`);
      return res.redirect(back);
    }
  }
  // The value for this record, checked against the (possibly new) type.
  const after = { ...before, ...def, id: before.id, optionList: optionsOf(def), visible: true };
  let values = new Map();
  const valueSent = !isAccess && editable(ctx) && (`f_${before.id}` in req.body || `clear_${before.id}` in req.body);
  if (valueSent) {
    const uidError = before.role === 'user_id' ? await prepareUserId(req, ctx.tab, ctx.fields, ctx.record.id) : null;
    const read = readValues(req.body, [after], ctx.values);
    const errors = [uidError, ...read.errors].filter(Boolean);
    if (errors.length) {
      flash(req, 'error', `Nothing was saved: ${errors.join(' ')}`);
      return res.redirect(back);
    }
    values = read.values;
  }
  let labels = [];
  try {
    labels = await transaction(async (conn) => {
      if (defChanges.length) {
        await conn.query('UPDATE inventory_fields SET label = ?, field_type = ?, options = ? WHERE id = ?', [def.label, def.field_type, def.options, before.id]);
        await logInv(conn, req.user, {
          type: 'inv_config', action: 'updated', subject: ctx.tab.name,
          summary: `Changed the column "${before.label}" in ${ctx.tab.name}: ${defChanges.join(', ')}`,
        });
      }
      const fields = ctx.fields.map((f) => (f.id === before.id ? after : f));
      if (before.role === 'user_id' && values.has(before.id)) await settleUserId(conn, ctx.tab, fields, values, ctx.record.id);
      const changed = values.size ? await saveValues(conn, ctx.record.id, fields, values, ctx.values) : [];
      if (changed.length) {
        await conn.query('UPDATE inventory_records SET updated_by = ? WHERE id = ?', [req.user.id, ctx.record.id]);
        await logInv(conn, req.user, {
          type: 'inv_record', id: ctx.record.id, action: 'updated', subject: ctx.title, changes: changed,
          summary: `Edited ${ctx.title} (${ctx.tab.name}): ${changed.join(', ')}`,
        });
      }
      return [...defChanges, ...changed.map((l) => `${l} value`)];
    });
  } catch (err) {
    if (!err.status) console.error(`Saving field ${before.id} on record ${ctx.record.id} failed:`, err);
    flash(req, 'error', `Nothing was saved: ${err.status ? err.message : 'a database error occurred.'}`);
    return res.redirect(back);
  }
  flash(req, 'saved', labels.length ? `Saved. ${def.label}: ${labels.join(', ')}.` : 'Saved. Nothing changed.');
  res.redirect(back);
});

// Extra field (this record only): the record, its extra field, or 404 / not editable.
async function extraContext(req) {
  const ctx = await getRecord(pool, requireId(req.params.id));
  const extra = await getExtra(pool, requireId(req.params.xid));
  if (!extra || extra.record_id !== ctx.record.id) throw notFound();
  return { ctx, extra };
}

// Name, type and value of an extra field together.
router.post('/r/:id/extras/:xid', async (req, res) => {
  const { ctx, extra } = await extraContext(req);
  const back = recordBack(req, ctx);
  const fail = (message) => { flash(req, 'error', message); return res.redirect(back); };
  if (!editable(ctx)) return fail('Reactivate this employee before editing.');
  const def = readExtraDef(req.body);
  if (def.error) return fail(def.error);
  if (looksLikeValue(def.name) && def.name !== extra.name && req.body.name_ok !== '1') {
    return fail(`"${def.name}" looks like a value, not a field name. Put it in Value instead (or tick "Use it as the field name anyway").`);
  }
  const sentValue = 'value' in req.body || req.body.clear === '1';
  const read = sentValue ? readExtraValue(def, req.body.value, { clear: req.body.clear === '1', hasSecret: extra.hasSecret }) : { change: null };
  if (read.error) return fail(`Nothing was saved: ${read.error}`);
  try {
    const changes = await transaction((conn) => updateExtra(conn, req.user, ctx, extra, { name: def.name, type: def.type, change: read.change }));
    flash(req, 'saved', changes.length ? `Saved. ${def.name}: ${changes.join(', ')}.` : 'Saved. Nothing changed.');
  } catch (err) {
    if (!err.status) console.error(`Saving extra field ${extra.id} failed:`, err);
    return fail(`Nothing was saved: ${err.status ? err.message : 'a database error occurred.'}`);
  }
  res.redirect(back);
});

// Inline value of an extra field (fetch JSON, like /r/:id/value).
router.post('/r/:id/extras/:xid/value', async (req, res) => {
  const { ctx, extra } = await extraContext(req);
  if (!editable(ctx)) return res.status(400).json({ ok: false, error: 'Reactivate this employee before editing.' });
  const read = readExtraValue({ name: extra.name, type: extra.field_type }, req.body.value, { clear: req.body.clear === '1', hasSecret: extra.hasSecret });
  if (read.error) return res.status(400).json({ ok: false, error: read.error });
  let changes = [];
  try {
    changes = await transaction((conn) => updateExtra(conn, req.user, ctx, extra, { name: extra.name, type: extra.field_type, change: read.change }));
  } catch (err) {
    if (!err.status) console.error(`Saving extra field ${extra.id} failed:`, err);
    return res.status(err.status || 500).json({ ok: false, error: err.status ? err.message : 'The value could not be saved because of a database error.' });
  }
  const now = await getExtra(pool, extra.id);
  const v = { value: now.value, hasSecret: now.hasSecret };
  res.render('inventory/_value-display', { field: asField(now), v, recordId: ctx.record.id, extraId: now.id }, (err, html) => {
    if (err) return res.status(500).json({ ok: false, error: 'Saved, but the page could not be refreshed. Reload to see it.' });
    return res.json({ ok: true, changed: changes.length > 0, value: now.value || '', html });
  });
});

router.post('/r/:id/extras/:xid/delete', async (req, res) => {
  const { ctx, extra } = await extraContext(req);
  const back = recordBack(req, ctx);
  if (!editable(ctx)) { flash(req, 'error', 'Reactivate this employee before editing.'); return res.redirect(back); }
  await transaction((conn) => deleteExtra(conn, req.user, ctx, extra));
  flash(req, 'saved', `"${extra.name}" deleted from this record only.`);
  res.redirect(back);
});

router.post('/r/:id/extras/:xid/move', async (req, res) => {
  const { ctx, extra } = await extraContext(req);
  if (editable(ctx)) await transaction((conn) => moveExtra(conn, req.user, ctx, extra, req.body.dir === 'up' ? 'up' : 'down'));
  res.redirect(recordBack(req, ctx));
});

// "Make shared (add to all records)": becomes a field of every record in the tab.
router.post('/r/:id/extras/:xid/share', async (req, res) => {
  const { ctx, extra } = await extraContext(req);
  const back = recordBack(req, ctx);
  if (!editable(ctx)) { flash(req, 'error', 'Reactivate this employee before editing.'); return res.redirect(back); }
  try {
    await transaction((conn) => makeShared(conn, req.user, ctx, extra));
    flash(req, 'saved', `"${extra.name}" is now a field for every record in ${ctx.tab.name} (empty for the others).`);
  } catch (err) {
    if (!err.status) console.error(`Making extra field ${extra.id} shared failed:`, err);
    flash(req, 'error', err.status ? err.message : 'It could not be made shared because of a database error. Nothing was changed.');
  }
  res.redirect(back);
});

// Access switch on the profile: Granted / Not granted.
router.post('/r/:id/access', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  const field = ctx.fields.find((f) => f.id === toId(req.body.field_id) && f.field_type === 'access');
  if (!field || (isEmployees(ctx.tab) && ctx.record.status === 'inactive')) throw notFound();
  const granted = req.body.value === 'granted';
  const before = ctx.values.get(field.id)?.value === 'granted';
  if (granted !== before) {
    await transaction(async (conn) => {
      await saveValues(conn, ctx.record.id, ctx.fields, new Map([[field.id, { value: granted ? 'granted' : null }]]), ctx.values);
      await conn.query('UPDATE inventory_records SET updated_by = ? WHERE id = ?', [req.user.id, ctx.record.id]);
      await logInv(conn, req.user, {
        type: 'inv_record', id: ctx.record.id, action: 'updated', subject: ctx.title, changes: [field.label],
        summary: `${granted ? 'Granted' : 'Removed'} ${field.label} access ${granted ? 'to' : 'from'} ${ctx.title}`,
      });
    });
  }
  res.redirect(backPath(req, `/inventory/r/${ctx.record.id}`));
});

// Inactive: needs a leaving date; every assigned item goes back to stock (the profile
// keeps them under "Equipment held"). The record moves to Ex Employees, fields intact.
router.post('/r/:id/deactivate', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  if (!isEmployees(ctx.tab) || ctx.record.status !== 'active') throw notFound();
  const leaving = isDate(req.body.leaving_date) ? req.body.leaving_date : null;
  if (!leaving) {
    flash(req, 'error', 'Enter the leaving date.');
    return res.redirect(`/inventory/r/${ctx.record.id}`);
  }
  const returned = await transaction(async (conn) => {
    const count = await returnAll(conn, req.user, { id: ctx.record.id, title: ctx.title }, leaving);
    await conn.query("UPDATE inventory_records SET status = 'inactive', leaving_date = ?, updated_by = ? WHERE id = ?", [leaving, req.user.id, ctx.record.id]);
    await logInv(conn, req.user, {
      type: 'inv_record', id: ctx.record.id, action: 'status_changed', subject: ctx.title,
      summary: `Marked ${withUserId(ctx.title, uidOf(ctx))} as inactive (left ${leaving})${count ? `; ${count} item${count === 1 ? '' : 's'} returned to stock` : ''}`,
    });
    return count;
  });
  flash(req, 'success', `${ctx.title} moved to Ex Employees${returned ? ` and ${returned} item${returned === 1 ? '' : 's'} returned to stock` : ''}.`);
  res.redirect(`/inventory/r/${ctx.record.id}`);
});

router.post('/r/:id/reactivate', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  if (!isEmployees(ctx.tab) || ctx.record.status !== 'inactive') throw notFound();
  // They get their old User-ID back if no active employee has it, else the lowest free one.
  const field = ctx.fields.find((f) => f.role === 'user_id');
  const note = await transaction(async (conn) => {
    let change = '';
    let uid = field ? ctx.values.get(field.id)?.value || '' : '';
    if (field) {
      await lockEmployees(conn, ctx.tab.id);
      const ids = await activeIds(conn, ctx.tab.id, field.id, ctx.record.id);
      if (!uid || isTaken(ids, uid)) {
        const next = lowestFree(await getPrefix(conn), ids);
        change = uid ? `User-ID changed from ${uid} to ${next} on reactivation` : `User-ID ${next} given on reactivation`;
        await conn.query(
          'INSERT INTO inventory_values (record_id, field_id, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
          [ctx.record.id, field.id, next]
        );
        uid = next;
      }
    }
    await conn.query("UPDATE inventory_records SET status = 'active', leaving_date = NULL, updated_by = ? WHERE id = ?", [req.user.id, ctx.record.id]);
    await logInv(conn, req.user, {
      type: 'inv_record', id: ctx.record.id, action: 'status_changed', subject: ctx.title, changes: change ? [field.label] : undefined,
      summary: `Reactivated ${withUserId(ctx.title, uid)}${change ? `; ${change}` : ''}`,
    });
    return change;
  });
  flash(req, 'success', `${ctx.title} is active again.${note ? ` ${note}.` : ''}`);
  res.redirect(`/inventory/r/${ctx.record.id}`);
});

// Assign an available item to this (active) employee.
router.post('/r/:id/assign', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  if (!isEmployees(ctx.tab) || ctx.record.status !== 'active') throw notFound();
  const itemId = toId(req.body.item_id);
  if (!itemId) throw notFound();
  try {
    await transaction(async (conn) => {
      const item = await getItem(conn, itemId, { lock: true });
      await assignItem(conn, req.user, item, { id: ctx.record.id, title: ctx.title });
    });
    flash(req, 'success', 'Assigned.');
  } catch (err) {
    if (err.status !== 400) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(`/inventory/r/${ctx.record.id}#equipment`);
});

module.exports = router;
module.exports.recordHistory = recordHistory;
