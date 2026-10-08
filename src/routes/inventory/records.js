// Records tabs (Employees, Ex Employees, Writers, Old Accounts, custom tabs): lists,
// add / edit / delete, the employee profile with access switches and equipment, making
// an employee inactive (leaving date, all kit back to stock) and reactivating them.
const express = require('express');
const { pool, transaction } = require('../../db');
const { requireId, toId, flash, notFound, safePath } = require('../../lib/http');
const { londonDate } = require('../../lib/activity');
const { isDate } = require('../../lib/report');
const {
  getTab, dataTab, listRecords, getRecord, recordTitle, fieldByRole, logInv,
} = require('../../lib/inventory/records');
const { listFields, readValues, saveValues } = require('../../lib/inventory/fields');
const { fieldColumns, fixedColumn, fieldCells } = require('../../lib/inventory/grid');
const {
  listCategories, listItems, getItem, assignItem, returnAll, assignmentsFor,
} = require('../../lib/inventory/stock');

const router = express.Router();

const isEmployees = (tab) => tab.kind === 'employees';

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
  const rows = records.map((r) => {
    const cells = fieldCells(fields, r.values, r.id);
    if (tab.kind === 'ex_employees') cells.push({ kind: 'date', value: r.leaving_date, sort: r.leaving_date || '', text: r.leaving_date || '' });
    return { href: `/inventory/r/${r.id}`, title: recordTitle(r, fields, r.values), cells };
  });
  res.render('inventory/records/index', {
    title: tab.name, tab, data, columns, rows,
    orderUrl: `/inventory/t/${data.id}/columns/order`,
  });
});

// ---- Add / edit ----

function renderForm(res, { tab, fields, record = null, title = '', input = {}, error = null }) {
  res.render('inventory/records/form', {
    title: record ? `Edit ${title}` : `Add to ${tab.name}`,
    tab, fields: fields.filter((f) => f.visible), record, recordTitle: title, input, error,
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
  renderForm(res, { tab: data, fields });
});

router.post('/t/:id', async (req, res) => {
  const { tab, data, fields } = await tabContext(req);
  if (tab.kind === 'ex_employees') throw notFound();
  const visible = fields.filter((f) => f.visible);
  const { values, errors } = readValues(req.body, visible);
  if (errors.length) {
    res.status(400);
    return renderForm(res, { tab: data, fields, input: typedValues(req.body, visible), error: errors.join(' ') });
  }
  const id = await transaction(async (conn) => {
    const [r] = await conn.query('INSERT INTO inventory_records (tab_id, created_by, updated_by) VALUES (?, ?, ?)', [data.id, req.user.id, req.user.id]);
    await saveValues(conn, r.insertId, fields, values);
    const plain = new Map([...values].filter(([, c]) => 'value' in c).map(([k, c]) => [k, { value: c.value }]));
    const title = recordTitle({ id: r.insertId }, fields, plain);
    await logInv(conn, req.user, {
      type: 'inv_record', id: r.insertId, action: 'created', subject: title, summary: `Added ${title} to ${data.name}`,
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
  const { values, errors } = readValues(req.body, visible, ctx.values);
  if (errors.length) {
    res.status(400);
    const secretsSet = Object.fromEntries(ctx.fields.map((f) => [f.id, Boolean(ctx.values.get(f.id)?.hasSecret)]));
    return renderForm(res, {
      tab: ctx.tab, fields: ctx.fields, record: { ...ctx.record, secretsSet }, title: ctx.title,
      input: typedValues(req.body, visible), error: errors.join(' '),
    });
  }
  const changed = await transaction(async (conn) => {
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

router.get('/r/:id', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  const history = await recordHistory(ctx.record.id);
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
  res.redirect(`${safePath(req.body.back, `/inventory/r/${ctx.record.id}`)}`);
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
      summary: `Marked ${ctx.title} as inactive (left ${leaving})${count ? `; ${count} item${count === 1 ? '' : 's'} returned to stock` : ''}`,
    });
    return count;
  });
  flash(req, 'success', `${ctx.title} moved to Ex Employees${returned ? ` and ${returned} item${returned === 1 ? '' : 's'} returned to stock` : ''}.`);
  res.redirect(`/inventory/r/${ctx.record.id}`);
});

router.post('/r/:id/reactivate', async (req, res) => {
  const ctx = await getRecord(pool, requireId(req.params.id));
  if (!isEmployees(ctx.tab) || ctx.record.status !== 'inactive') throw notFound();
  await transaction(async (conn) => {
    await conn.query("UPDATE inventory_records SET status = 'active', leaving_date = NULL, updated_by = ? WHERE id = ?", [req.user.id, ctx.record.id]);
    await logInv(conn, req.user, {
      type: 'inv_record', id: ctx.record.id, action: 'status_changed', subject: ctx.title, summary: `Reactivated ${ctx.title}`,
    });
  });
  flash(req, 'success', `${ctx.title} is active again.`);
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
