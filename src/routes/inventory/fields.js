// Columns manager: the fields of a records tab (/inventory/t/:id/columns) or of a stock
// category (/inventory/stock/categories/:id/fields). Add, rename, change type, hide /
// show, required, width, delete (with a count of records that have data). Dragging
// column headers in a table posts the new order here (saved for everyone). Profiles and
// record pages manage fields too (add, rename, change type, move, hide, delete, drag),
// posting a "back" address so the user returns to the page they were on.
const express = require('express');
const { pool, transaction } = require('../../db');
const { requireId, flash, notFound, safePath } = require('../../lib/http');
const { getTab, dataTab, logInv } = require('../../lib/inventory/records');
const { getCategory } = require('../../lib/inventory/stock');
const {
  FIELD_TYPES, CATEGORY_TYPES, SECRET_TYPES, listFields, readFieldForm,
} = require('../../lib/inventory/fields');

const router = express.Router();

// Scope = which tab or category the fields belong to, with its URLs.
async function tabScope(id) {
  const tab = await dataTab(pool, await getTab(pool, id));
  if (tab.kind === 'stock') throw notFound();
  return {
    kind: 'tab', id: tab.id, name: tab.name, owner: { tabId: tab.id }, isEmployees: tab.kind === 'employees',
    url: `/inventory/t/${tab.id}/columns`, back: `/inventory/t/${tab.id}`, types: Object.keys(FIELD_TYPES), table: 'inventory_values',
  };
}
async function categoryScope(id) {
  const cat = await getCategory(pool, id);
  return {
    kind: 'category', id: cat.id, name: cat.name, owner: { categoryId: cat.id },
    url: `/inventory/stock/categories/${cat.id}/fields`, back: '/inventory/stock/categories', types: CATEGORY_TYPES, table: 'stock_values',
  };
}
async function fieldScope(field) {
  return field.tab_id ? tabScope(field.tab_id) : categoryScope(field.category_id);
}

const backTo = (req, scope) => safePath(req.body.back || req.query.back, scope.url);

async function getField(id) {
  const [[field]] = await pool.query('SELECT * FROM inventory_fields WHERE id = ?', [id]);
  if (!field) throw notFound();
  return field;
}

// How many records / items have a value in each field.
async function dataCounts(scope, fields) {
  if (!fields.length) return {};
  const valueCol = scope.table === 'inventory_values' ? '(value IS NOT NULL OR value_enc IS NOT NULL)' : 'value IS NOT NULL';
  const [rows] = await pool.query(
    `SELECT field_id, COUNT(*) AS n FROM ${scope.table} WHERE field_id IN (?) AND ${valueCol} GROUP BY field_id`,
    [fields.map((f) => f.id)]
  );
  return Object.fromEntries(rows.map((r) => [r.field_id, Number(r.n)]));
}

async function showManager(res, scope) {
  const fields = await listFields(pool, scope.owner);
  res.render('inventory/fields/index', {
    title: `Columns · ${scope.name}`, scope, fields, counts: await dataCounts(scope, fields),
    types: Object.fromEntries(scope.types.map((t) => [t, FIELD_TYPES[t]])),
  });
}

router.get('/t/:id/columns', async (req, res) => showManager(res, await tabScope(requireId(req.params.id))));
router.get('/stock/categories/:id/fields', async (req, res) => showManager(res, await categoryScope(requireId(req.params.id))));

async function addField(req, res, scope) {
  const { field, error } = readFieldForm(req.body, scope.types);
  if (error) {
    flash(req, 'error', error);
    return res.redirect(backTo(req, scope));
  }
  await transaction(async (conn) => {
    const col = scope.owner.tabId ? 'tab_id' : 'category_id';
    const [[{ next }]] = await conn.query(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM inventory_fields WHERE ${col} = ?`, [scope.id]);
    await conn.query(
      `INSERT INTO inventory_fields (${col}, label, field_type, options, sort_order, visible, required, width) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [scope.id, field.label, field.field_type, field.options, next, field.visible, field.required, field.width]
    );
    await logInv(conn, req.user, {
      type: 'inv_config', action: 'created', subject: scope.name,
      summary: `Added the column "${field.label}" (${FIELD_TYPES[field.field_type]}) to ${scope.name}`,
    });
  });
  flash(req, 'success', `"${field.label}" added.`);
  res.redirect(backTo(req, scope));
}
router.post('/t/:id/columns', async (req, res) => addField(req, res, await tabScope(requireId(req.params.id))));
router.post('/stock/categories/:id/fields', async (req, res) => addField(req, res, await categoryScope(requireId(req.params.id))));

// Saves a field edit (full column form, or one of the small profile actions built on it).
async function applyEdit(req, res, before, body) {
  const scope = await fieldScope(before);
  const back = backTo(req, scope);
  // Access toggles stay access toggles; other fields cannot become one from here.
  const types = before.field_type === 'access' ? ['access'] : scope.types.filter((t) => t !== 'access' || body.field_type === 'access');
  const { field, error } = readFieldForm(body, types);
  if (error) {
    flash(req, 'error', error);
    return res.redirect(back);
  }
  // Encrypted and plain values cannot be converted into each other.
  const wasSecret = SECRET_TYPES.includes(before.field_type);
  const isSecret = SECRET_TYPES.includes(field.field_type);
  if (wasSecret !== isSecret) {
    const counts = await dataCounts(scope, [before]);
    if (counts[before.id]) {
      flash(req, 'error', `"${before.label}" has data in ${counts[before.id]} record${counts[before.id] === 1 ? '' : 's'}, so it cannot change between a password / PIN and a plain type. Add a new field instead.`);
      return res.redirect(back);
    }
  }
  const changes = [];
  if (before.label !== field.label) changes.push(`renamed "${before.label}" to "${field.label}"`);
  if (before.field_type !== field.field_type) changes.push(`type ${FIELD_TYPES[before.field_type]} → ${FIELD_TYPES[field.field_type]}`);
  if ((before.options || null) !== field.options) changes.push('options');
  if (Boolean(before.visible) !== Boolean(field.visible)) changes.push(field.visible ? 'shown' : 'hidden');
  if (Boolean(before.required) !== Boolean(field.required)) changes.push(field.required ? 'required' : 'optional');
  if (before.width !== field.width) changes.push(`width ${field.width}px`);
  if (!changes.length) {
    flash(req, 'success', 'No changes.');
    return res.redirect(back);
  }
  await transaction(async (conn) => {
    await conn.query(
      'UPDATE inventory_fields SET label = ?, field_type = ?, options = ?, visible = ?, required = ?, width = ? WHERE id = ?',
      [field.label, field.field_type, field.options, field.visible, field.required, field.width, before.id]
    );
    await logInv(conn, req.user, {
      type: 'inv_config', action: 'updated', subject: scope.name,
      summary: `Changed the column "${before.label}" in ${scope.name}: ${changes.join(', ')}`,
    });
  });
  flash(req, 'success', `"${field.label}" saved.`);
  res.redirect(back);
}

// The field as a column form body, so a small change can go through applyEdit.
const asBody = (f) => ({
  label: f.label, field_type: f.field_type, options: f.options || '', width: String(f.width),
  required: f.required ? '1' : '', visible: f.visible ? '1' : '0',
});

router.post('/fields/:id', async (req, res) => {
  const before = await getField(requireId(req.params.id));
  return applyEdit(req, res, before, req.body);
});
router.post('/fields/:id/rename', async (req, res) => {
  const before = await getField(requireId(req.params.id));
  return applyEdit(req, res, before, { ...asBody(before), label: req.body.label });
});
router.post('/fields/:id/type', async (req, res) => {
  const before = await getField(requireId(req.params.id));
  return applyEdit(req, res, before, { ...asBody(before), field_type: req.body.field_type, options: req.body.options || before.options || '' });
});
router.post('/fields/:id/hide', async (req, res) => {
  const before = await getField(requireId(req.params.id));
  return applyEdit(req, res, before, { ...asBody(before), visible: '0' });
});

// Move up / down among the fields of the same kind (Details fields or Access toggles),
// skipping hidden ones; the order is the one the tables use too.
router.post('/fields/:id/move', async (req, res) => {
  const field = await getField(requireId(req.params.id));
  const scope = await fieldScope(field);
  const fields = await listFields(pool, scope.owner);
  const sameGroup = (f) => (f.field_type === 'access') === (field.field_type === 'access') && f.visible;
  const group = fields.filter(sameGroup);
  const i = group.findIndex((f) => f.id === field.id);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= group.length) return res.redirect(backTo(req, scope));
  const order = fields.map((f) => f.id);
  const a = order.indexOf(group[i].id);
  const b = order.indexOf(group[j].id);
  [order[a], order[b]] = [order[b], order[a]];
  await transaction(async (conn) => {
    for (const [k, id] of order.entries()) await conn.query('UPDATE inventory_fields SET sort_order = ? WHERE id = ?', [k, id]);
    await logInv(conn, req.user, {
      type: 'inv_config', action: 'updated', subject: scope.name,
      summary: `Moved "${field.label}" ${req.body.dir === 'up' ? 'up' : 'down'} in ${scope.name}`,
    });
  });
  res.redirect(backTo(req, scope));
});

// Delete: a confirmation page first, saying how many records have data in it.
router.get('/fields/:id/delete', async (req, res) => {
  const field = await getField(requireId(req.params.id));
  const scope = await fieldScope(field);
  const count = (await dataCounts(scope, [field]))[field.id] || 0;
  res.render('inventory/fields/delete', { title: `Delete · ${field.label}`, field, scope, count, back: backTo(req, scope) });
});

router.post('/fields/:id/delete', async (req, res) => {
  const field = await getField(requireId(req.params.id));
  const scope = await fieldScope(field);
  const count = (await dataCounts(scope, [field]))[field.id] || 0;
  await transaction(async (conn) => {
    await conn.query('UPDATE stock_categories SET group_by = \'none\', group_field_id = NULL WHERE group_field_id = ?', [field.id]);
    await conn.query('DELETE FROM inventory_fields WHERE id = ?', [field.id]);
    await logInv(conn, req.user, {
      type: 'inv_config', action: 'deleted', subject: scope.name,
      summary: `Deleted the column "${field.label}" from ${scope.name}${count ? ` (data in ${count} record${count === 1 ? '' : 's'} removed)` : ''}`,
    });
  });
  flash(req, 'success', `"${field.label}" deleted.`);
  res.redirect(backTo(req, scope));
});

// New column order (field ids). From the Columns page it lists every field; from a table
// header drag only the visible ones, and hidden fields keep their places.
async function saveOrder(req, res, scope) {
  const fields = await listFields(pool, scope.owner);
  const ids = String(req.body.order || '').split(',').map(Number).filter(Boolean);
  const known = new Set(fields.map((f) => f.id));
  if (!ids.length || ids.some((id) => !known.has(id)) || new Set(ids).size !== ids.length) {
    return res.status(400).json({ ok: false, error: 'That order does not match the columns.' });
  }
  let order;
  if (ids.length === fields.length) order = ids;
  else {
    const visible = fields.filter((f) => f.visible).map((f) => f.id);
    if (ids.length !== visible.length || ids.some((id) => !visible.includes(id))) {
      return res.status(400).json({ ok: false, error: 'That order does not match the columns.' });
    }
    const queue = [...ids];
    order = fields.map((f) => (f.visible ? queue.shift() : f.id));
  }
  await transaction(async (conn) => {
    for (const [i, id] of order.entries()) await conn.query('UPDATE inventory_fields SET sort_order = ? WHERE id = ?', [i, id]);
    await logInv(conn, req.user, { type: 'inv_config', action: 'updated', subject: scope.name, summary: `Reordered the columns of ${scope.name}` });
  });
  res.json({ ok: true });
}
router.post('/t/:id/columns/order', async (req, res) => saveOrder(req, res, await tabScope(requireId(req.params.id))));

// Drag within Details (group=details) or Access (group=access) on a record page: only
// that group's visible fields change places; everything else keeps its position.
router.post('/t/:id/columns/group-order', async (req, res) => {
  const scope = await tabScope(requireId(req.params.id));
  const fields = await listFields(pool, scope.owner);
  const isAccess = req.body.group === 'access';
  const inGroup = (f) => f.visible && (f.field_type === 'access') === isAccess;
  const ids = String(req.body.order || '').split(',').map(Number).filter(Boolean);
  const group = fields.filter(inGroup).map((f) => f.id);
  if (ids.length !== group.length || ids.some((id) => !group.includes(id)) || new Set(ids).size !== ids.length) {
    return res.status(400).json({ ok: false, error: 'That order does not match the fields.' });
  }
  const queue = [...ids];
  const order = fields.map((f) => (inGroup(f) ? queue.shift() : f.id));
  await transaction(async (conn) => {
    for (const [k, id] of order.entries()) await conn.query('UPDATE inventory_fields SET sort_order = ? WHERE id = ?', [k, id]);
    await logInv(conn, req.user, {
      type: 'inv_config', action: 'updated', subject: scope.name,
      summary: `Reordered the ${isAccess ? 'access toggles' : 'fields'} of ${scope.name}`,
    });
  });
  res.json({ ok: true });
});
router.post('/stock/categories/:id/fields/order', async (req, res) => saveOrder(req, res, await categoryScope(requireId(req.params.id))));

module.exports = router;
