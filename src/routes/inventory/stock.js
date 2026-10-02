// Inventory > Stock: bulk accessories counted by quantity.
// Available = total - assigned - damaged (calculated, never stored).
const express = require('express');
const { pool, transaction } = require('../../db');
const { str, requireId, toId, flash, notFound, safePath } = require('../../lib/http');
const { londonDate } = require('../../lib/activity');
const inv = require('../../lib/inventory');
const cf = require('../../lib/custom-fields');
const { giveStock } = require('../../lib/inventory-actions');

const router = express.Router();

const qty = (value) => {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : null;
};

function readStock(body) {
  return {
    category_id: toId(body.category_id),
    brand: str(body.brand, 100),
    model: str(body.model, 255),
    connection: Object.hasOwn(inv.CONNECTIONS, body.connection) ? body.connection : 'na',
    location: str(body.location, 150),
    total_qty: qty(body.total_qty),
    damaged_qty: qty(body.damaged_qty) ?? 0,
    notes: str(body.notes, 5000),
  };
}

const fieldsForCategory = (fields, categoryId) => fields.filter((f) => !f.category_id || f.category_id === categoryId);

router.get('/stock', async (req, res) => {
  const fields = await cf.fieldsFor('stock');
  const filter = cf.filterCondition('stock', 's', fields, req.query);
  const categoryId = toId(req.query.category);
  const where = [...filter.where];
  const params = [...filter.params];
  if (categoryId) { where.push('s.category_id = ?'); params.push(categoryId); }
  const [rows] = await pool.query(`${inv.STOCK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.name, s.brand, s.model`, params);
  const stock = rows.map(inv.withAvailability);
  res.render('inventory/stock/index', {
    title: 'Stock',
    stock,
    fields,
    listFields: fields.filter((f) => f.show_in_list),
    filterFields: cf.filterableFields(fields),
    activeFilters: filter.active,
    values: await cf.valuesFor('stock', stock.map((s) => s.id)),
    lists: await inv.loadLists(),
    categoryId,
    lowStock: inv.LOW_STOCK,
  });
});

async function renderForm(res, statusCode, item, error) {
  const lists = await inv.loadLists();
  res.status(statusCode).render('inventory/stock/form', {
    title: item.id ? `Edit ${inv.stockLabel(item)}` : 'New stock item',
    item,
    lists,
    stockCategories: lists.categories.filter((c) => c.kind === 'stock' || c.id === item.category_id),
    fields: await cf.fieldsFor('stock'),
    values: item.cf || {},
    error,
  });
}

function validate(item, assigned = 0) {
  const errors = [];
  if (!item.model) errors.push('Model or description is required.');
  if (item.total_qty === null) errors.push('Enter the total quantity (0 or more).');
  else if (item.damaged_qty + assigned > item.total_qty) {
    errors.push(`Total must be at least ${item.damaged_qty + assigned} (${assigned} assigned + ${item.damaged_qty} damaged).`);
  }
  return errors;
}

router.get('/stock/new', (req, res) => renderForm(res, 200, { connection: 'na', total_qty: 0, damaged_qty: 0, category_id: toId(req.query.category), cf: {} }, null));

router.post('/stock', async (req, res) => {
  const item = readStock(req.body);
  const fields = fieldsForCategory(await cf.fieldsFor('stock'), item.category_id);
  const { values, errors } = cf.readValues(fields, req.body);
  errors.unshift(...validate(item));
  if (errors.length) return renderForm(res, 400, { ...item, cf: values }, errors.join(' '));
  const id = await transaction(async (conn) => {
    const [r] = await conn.query(`
      INSERT INTO inv_stock (category_id, brand, model, connection, location, total_qty, damaged_qty, notes, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [item.category_id, item.brand || null, item.model, item.connection, item.location || null, item.total_qty,
      item.damaged_qty, item.notes || null, req.user.id, req.user.id]);
    await cf.saveValues(conn, 'stock', r.insertId, fields, values);
    await inv.logInv(conn, req.user, { type: 'inv_stock', id: r.insertId, action: 'created', subject: inv.stockLabel(item),
      summary: `Added stock: ${item.total_qty} × ${inv.stockLabel(item)}.` });
    return r.insertId;
  });
  flash(req, 'success', 'Stock item added.');
  res.redirect(`/inventory/stock/${id}`);
});

router.get('/stock/:id', async (req, res) => {
  const item = await inv.stockById(requireId(req.params.id));
  if (!item) throw notFound();
  const [assignments] = await pool.query(`
    SELECT sa.*, p.name AS person_name, p.status AS person_status FROM inv_stock_assignments sa
    JOIN inv_people p ON p.id = sa.person_id
    WHERE sa.stock_id = ? ORDER BY sa.returned_at IS NOT NULL, p.name
  `, [item.id]);
  const [people] = await pool.query("SELECT id, name FROM inv_people WHERE status = 'active' ORDER BY name");
  const [log] = await pool.query(`
    SELECT l.action, l.summary, l.created_at, u.username FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.entity_type = 'inv_stock' AND l.entity_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT 100
  `, [item.id]);
  const fields = fieldsForCategory(await cf.fieldsFor('stock'), item.category_id);
  res.render('inventory/stock/show', {
    title: inv.stockLabel(item), item, assignments, people, log, fields,
    values: (await cf.valuesFor('stock', [item.id])).get(item.id) || {},
  });
});

router.get('/stock/:id/edit', async (req, res) => {
  const item = await inv.stockById(requireId(req.params.id));
  if (!item) throw notFound();
  await renderForm(res, 200, { ...item, cf: (await cf.valuesFor('stock', [item.id])).get(item.id) || {} }, null);
});

router.post('/stock/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const before = await inv.stockById(id);
  if (!before) throw notFound();
  const item = { ...readStock(req.body), id };
  const fields = fieldsForCategory(await cf.fieldsFor('stock'), item.category_id);
  const { values, errors } = cf.readValues(fields, req.body);
  errors.unshift(...validate(item, before.assigned_qty));
  if (errors.length) return renderForm(res, 400, { ...item, cf: values }, errors.join(' '));
  await transaction(async (conn) => {
    await conn.query(`
      UPDATE inv_stock SET category_id = ?, brand = ?, model = ?, connection = ?, location = ?, total_qty = ?, damaged_qty = ?, notes = ?, updated_by = ?
      WHERE id = ?
    `, [item.category_id, item.brand || null, item.model, item.connection, item.location || null, item.total_qty,
      item.damaged_qty, item.notes || null, req.user.id, id]);
    const changedCf = await cf.saveValues(conn, 'stock', id, fields, values);
    const parts = [];
    if (before.total_qty !== item.total_qty) parts.push(`total ${before.total_qty} → ${item.total_qty}`);
    if (before.damaged_qty !== item.damaged_qty) parts.push(`damaged ${before.damaged_qty} → ${item.damaged_qty}`);
    await inv.logInv(conn, req.user, { type: 'inv_stock', id, action: 'updated', subject: inv.stockLabel(item), changes: changedCf,
      summary: `Updated stock ${inv.stockLabel(item)}${parts.length ? ` (${parts.join(', ')})` : ''}.` });
  });
  flash(req, 'success', 'Stock item saved.');
  res.redirect(`/inventory/stock/${id}`);
});

router.post('/stock/:id/assign', async (req, res) => {
  const id = requireId(req.params.id);
  const back = safePath(req.body.back, `/inventory/stock/${id}`);
  try {
    await giveStock(req.user, id, toId(req.body.person_id), qty(req.body.quantity) || 1);
    flash(req, 'success', 'Stock assigned.');
  } catch (err) {
    if (err.status !== 400) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(back);
});

router.post('/stock/assignments/:aid/return', async (req, res) => {
  const aid = requireId(req.params.aid);
  const [[a]] = await pool.query(`
    SELECT sa.*, p.name AS person_name FROM inv_stock_assignments sa JOIN inv_people p ON p.id = sa.person_id WHERE sa.id = ?
  `, [aid]);
  if (!a) throw notFound();
  const item = await inv.stockById(a.stock_id);
  if (!a.returned_at) {
    await pool.query('UPDATE inv_stock_assignments SET returned_at = ? WHERE id = ?', [londonDate(), aid]);
    await inv.logInv(null, req.user, { type: 'inv_stock', id: a.stock_id, action: 'updated', subject: inv.stockLabel(item), personId: a.person_id,
      summary: `Returned ${a.quantity} × ${inv.stockLabel(item)} from ${a.person_name}.` });
  }
  flash(req, 'success', 'Marked as returned.');
  res.redirect(safePath(req.body.back, `/inventory/stock/${a.stock_id}`));
});

router.post('/stock/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const item = await inv.stockById(id);
  if (!item) throw notFound();
  if (item.assigned_qty > 0) {
    flash(req, 'error', 'Some of this item is still assigned. Mark it returned first.');
    return res.redirect(`/inventory/stock/${id}`);
  }
  await inv.logInv(null, req.user, { type: 'inv_stock', id, action: 'deleted', subject: inv.stockLabel(item),
    summary: `Deleted stock item ${inv.stockLabel(item)}.` });
  await pool.query("DELETE FROM custom_field_values WHERE entity_type = 'stock' AND entity_id = ?", [id]);
  await pool.query('DELETE FROM inv_stock WHERE id = ?', [id]);
  flash(req, 'success', 'Stock item deleted.');
  res.redirect('/inventory/stock');
});

module.exports = router;
