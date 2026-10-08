// Stock (mounted at /inventory/stock): items (one record per physical item, laptops
// included), add one / add multiple, item page with assign / return, categories with
// their own extra fields, the per-category summary and the breakdown report (CSV / Excel).
const express = require('express');
const ExcelJS = require('exceljs');
const { pool, transaction } = require('../../db');
const { requireId, toId, str, flash, notFound, safePath } = require('../../lib/http');
const { employeesTab, listRecords, recordTitle, logInv } = require('../../lib/inventory/records');
const { listFields, readValues, saveValues, STOCK_STATUSES } = require('../../lib/inventory/fields');
const { fieldColumns, fixedColumn, fieldCells } = require('../../lib/inventory/grid');
const {
  listCategories, getCategory, itemLabel, listItems, getItem, assignItem, returnItem, summary, breakdown,
} = require('../../lib/inventory/stock');

const router = express.Router();

// Active employees for "Assign to" pickers, A-Z.
async function activeEmployees() {
  const tab = await employeesTab(pool);
  if (!tab) return [];
  const fields = await listFields(pool, { tabId: tab.id });
  const records = await listRecords(pool, tab.id, 'active');
  return records.map((r) => ({ id: r.id, name: recordTitle(r, fields, r.values) })).sort((a, b) => a.name.localeCompare(b.name));
}

// Brand / model / serial / status / notes from a form.
function readItem(body) {
  return {
    brand: str(body.brand, 100) || null,
    model: str(body.model, 150) || null,
    serial: str(body.serial, 150) || null,
    status: Object.hasOwn(STOCK_STATUSES, body.status) ? body.status : 'available',
    notes: str(body.notes, 5000) || null,
  };
}

// ---- Items list ----

router.get('/', async (req, res) => {
  const categories = await listCategories(pool, { withFields: true });
  const category = categories.find((c) => c.id === toId(req.query.category)) || null;
  const status = Object.hasOwn(STOCK_STATUSES, req.query.status) ? req.query.status : '';
  const holder = ['assigned', 'unassigned'].includes(req.query.holder) ? req.query.holder : '';
  const brand = str(req.query.brand, 100);
  let items = await listItems(pool, { categoryId: category && category.id, status });
  if (holder) items = items.filter((i) => (holder === 'assigned' ? i.employee_id : !i.employee_id));
  if (brand) items = items.filter((i) => (i.brand || '').toLowerCase() === brand.toLowerCase());
  const brands = [...new Set((await listItems(pool)).map((i) => i.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const w = res.locals.invWidths;
  const columns = [
    ...(category ? [] : [fixedColumn('stock:category', 'Category', 130, w)]),
    fixedColumn('stock:brand', 'Brand', 120, w),
    fixedColumn('stock:model', 'Model', 180, w),
    fixedColumn('stock:serial', 'Serial / asset no.', 160, w),
    fixedColumn('stock:status', 'Status', 110, w, { filter: { type: 'select', options: Object.values(STOCK_STATUSES) } }),
    fixedColumn('stock:employee', 'Assigned to', 160, w),
    ...(category ? fieldColumns(category.fields, w) : []),
    fixedColumn('stock:notes', 'Notes', 200, w),
  ];
  const rows = items.map((i) => ({
    href: `/inventory/stock/${i.id}`,
    title: itemLabel(i),
    cells: [
      ...(category ? [] : [{ kind: 'text', value: i.category_name, text: i.category_name, sort: i.category_name }]),
      { kind: 'text', value: i.brand, text: i.brand || '', sort: i.brand || '' },
      { kind: 'text', value: i.model, text: i.model || '', sort: i.model || '' },
      { kind: 'text', value: i.serial, text: i.serial || '', sort: i.serial || '' },
      { kind: 'stock_status', value: i.status, text: STOCK_STATUSES[i.status], sort: STOCK_STATUSES[i.status] },
      { kind: 'employee', value: i.employee_name, id: i.employee_id, text: i.employee_name || '', sort: i.employee_name || '' },
      ...(category ? fieldCells(category.fields, i.values, i.id) : []),
      { kind: 'longtext', value: i.notes, text: i.notes || '', sort: i.notes || '' },
    ],
  }));
  res.render('inventory/stock/index', {
    title: 'Stock', categories, category, status, holder, brand, brands, columns, rows,
    orderUrl: category ? `/inventory/stock/categories/${category.id}/fields/order` : null,
  });
});

// ---- Summary and breakdown report ----

router.get('/summary', async (req, res) => {
  const rows = await summary();
  const totals = rows.reduce((t, r) => ({
    total: t.total + r.total, assigned: t.assigned + r.assigned, available: t.available + r.available, repair: t.repair + r.repair, gone: t.gone + r.gone,
  }), { total: 0, assigned: 0, available: 0, repair: 0, gone: 0 });
  res.render('inventory/stock/summary', { title: 'Stock summary', rows, totals });
});

router.get('/report', async (req, res) => {
  res.render('inventory/stock/report', { title: 'Stock breakdown', report: await breakdown() });
});

// Flat rows of the breakdown for CSV / Excel, with brand and category totals.
function reportRows(report) {
  const rows = [['Category', 'Group', 'Brand', 'Model', 'Quantity', 'Available', 'Employees using it']];
  for (const cat of report) {
    if (!cat.total) continue;
    for (const g of cat.groups) {
      for (const b of g.brands) {
        for (const m of b.models) rows.push([cat.name, g.name || '', b.brand, m.model, m.quantity, m.available, m.employees.join(', ')]);
        rows.push([cat.name, g.name || '', `${b.brand} total`, '', b.total, '', '']);
      }
      if (g.name) rows.push([cat.name, `${g.name} total`, '', '', g.total, '', '']);
    }
    rows.push([`${cat.name} total`, '', '', '', cat.total, '', '']);
  }
  return rows;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  // Leading = + - @ would be run as a formula by Excel: prefix with a quote.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

router.get('/report.csv', async (req, res) => {
  const csv = reportRows(await breakdown()).map((r) => r.map(csvCell).join(',')).join('\r\n');
  res.attachment('stock-breakdown.csv').type('text/csv').send(`﻿${csv}`);
});

router.get('/report.xlsx', async (req, res) => {
  const rows = reportRows(await breakdown());
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Stock breakdown');
  sheet.addRows(rows);
  sheet.getRow(1).font = { bold: true };
  sheet.columns = [{ width: 18 }, { width: 14 }, { width: 18 }, { width: 28 }, { width: 10 }, { width: 10 }, { width: 50 }];
  rows.forEach((r, i) => {
    if (i && /total$/.test(String(r[0]) + String(r[1]) + String(r[2]))) sheet.getRow(i + 1).font = { bold: true };
  });
  res.attachment('stock-breakdown.xlsx');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await book.xlsx.write(res);
  res.end();
});

// ---- Categories ----

router.get('/categories', async (req, res) => {
  const categories = await listCategories(pool, { withFields: true });
  const [counts] = await pool.query('SELECT category_id, COUNT(*) AS n FROM stock_items GROUP BY category_id');
  res.render('inventory/stock/categories', {
    title: 'Stock categories', categories, counts: Object.fromEntries(counts.map((c) => [c.category_id, Number(c.n)])),
  });
});

router.post('/categories', async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) {
    flash(req, 'error', 'Give the category a name.');
    return res.redirect('/inventory/stock/categories');
  }
  try {
    await transaction(async (conn) => {
      const [[{ next }]] = await conn.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM stock_categories');
      await conn.query('INSERT INTO stock_categories (name, sort_order) VALUES (?, ?)', [name, next]);
      await logInv(conn, req.user, { type: 'inv_config', action: 'created', subject: name, summary: `Added the stock category "${name}"` });
    });
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    flash(req, 'error', `There is already a category called "${name}".`);
    return res.redirect('/inventory/stock/categories');
  }
  flash(req, 'success', `Category "${name}" added.`);
  res.redirect('/inventory/stock/categories');
});

router.post('/categories/order', async (req, res) => {
  const cats = await listCategories(pool);
  const ids = String(req.body.order || '').split(',').map(Number).filter(Boolean);
  if (ids.length !== cats.length || ids.some((id) => !cats.some((c) => c.id === id))) {
    return res.status(400).json({ ok: false, error: 'That order does not match the categories.' });
  }
  await transaction(async (conn) => {
    for (const [i, id] of ids.entries()) await conn.query('UPDATE stock_categories SET sort_order = ? WHERE id = ?', [i, id]);
    await logInv(conn, req.user, { type: 'inv_config', action: 'updated', subject: 'Stock categories', summary: 'Reordered the stock categories' });
  });
  res.json({ ok: true });
});

// Rename, and how the breakdown report groups it (none / Windows-Apple / by a field).
router.post('/categories/:id', async (req, res) => {
  const cat = await getCategory(pool, requireId(req.params.id));
  const name = str(req.body.name, 100);
  const fields = await listFields(pool, { categoryId: cat.id });
  let groupBy = ['none', 'platform', 'field'].includes(req.body.group_by) ? req.body.group_by : 'none';
  const groupField = groupBy === 'field' ? fields.find((f) => f.id === toId(req.body.group_field_id) && f.field_type === 'dropdown') : null;
  if (groupBy === 'field' && !groupField) groupBy = 'none';
  if (!name) {
    flash(req, 'error', 'Give the category a name.');
    return res.redirect('/inventory/stock/categories');
  }
  try {
    await pool.query('UPDATE stock_categories SET name = ?, group_by = ?, group_field_id = ? WHERE id = ?',
      [name, groupBy, groupField ? groupField.id : null, cat.id]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    flash(req, 'error', `There is already a category called "${name}".`);
    return res.redirect('/inventory/stock/categories');
  }
  await logInv(null, req.user, {
    type: 'inv_config', action: 'updated', subject: name,
    summary: name === cat.name ? `Changed the report grouping of "${name}"` : `Renamed the stock category "${cat.name}" to "${name}"`,
  });
  flash(req, 'success', 'Category saved.');
  res.redirect('/inventory/stock/categories');
});

router.post('/categories/:id/delete', async (req, res) => {
  const cat = await getCategory(pool, requireId(req.params.id));
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM stock_items WHERE category_id = ?', [cat.id]);
  if (Number(n)) {
    flash(req, 'error', `"${cat.name}" still has ${n} item${Number(n) === 1 ? '' : 's'}. Move or delete them first.`);
    return res.redirect('/inventory/stock/categories');
  }
  await transaction(async (conn) => {
    await conn.query('DELETE FROM stock_categories WHERE id = ?', [cat.id]);
    await logInv(conn, req.user, { type: 'inv_config', action: 'deleted', subject: cat.name, summary: `Deleted the stock category "${cat.name}"` });
  });
  flash(req, 'success', `Category "${cat.name}" deleted.`);
  res.redirect('/inventory/stock/categories');
});

// ---- Add one / add multiple ----

async function formContext(categoryId) {
  const categories = await listCategories(pool, { withFields: true });
  const category = categories.find((c) => c.id === categoryId) || categories[0] || null;
  return { categories, category, employees: await activeEmployees() };
}

router.get('/new', async (req, res) => {
  const ctx = await formContext(toId(req.query.category));
  res.render('inventory/stock/form', { title: 'Add stock item', ...ctx, item: null, input: {}, values: {}, error: null });
});

router.get('/multiple', async (req, res) => {
  const ctx = await formContext(toId(req.query.category));
  res.render('inventory/stock/multiple', { title: 'Add multiple items', ...ctx, input: { quantity: 2 }, values: {}, error: null });
});

const plainValues = (body, fields) => Object.fromEntries(fields.map((f) => [f.id, typeof body[`f_${f.id}`] === 'string' ? body[`f_${f.id}`] : '']));

// Inserts one item (and its extra values); assigns it when an active employee is chosen.
async function insertItem(conn, user, category, data, values, employee) {
  const [r] = await conn.query(
    'INSERT INTO stock_items (category_id, brand, model, serial, status, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [category.id, data.brand, data.model, data.serial, employee ? 'available' : data.status, data.notes, user.id, user.id]
  );
  await saveValues(conn, r.insertId, category.fields, values, new Map(), 'stock_values');
  const item = { id: r.insertId, category_name: category.name, ...data, status: 'available' };
  await logInv(conn, user, { type: 'inv_item', id: r.insertId, action: 'created', subject: itemLabel(item), summary: `Added ${itemLabel(item)} to stock` });
  if (employee) await assignItem(conn, user, item, employee);
  return r.insertId;
}

async function chosenEmployee(body) {
  const id = toId(body.employee_id);
  if (!id) return null;
  return (await activeEmployees()).map((e) => ({ id: e.id, title: e.name })).find((e) => e.id === id) || null;
}

router.post('/', async (req, res) => {
  const ctx = await formContext(toId(req.body.category_id));
  if (!ctx.category) throw notFound();
  const data = readItem(req.body);
  const { values, errors } = readValues(req.body, ctx.category.fields.filter((f) => f.visible));
  if (data.status === 'assigned') errors.push('To assign it, choose an employee under "Assign to" (the status is set for you).');
  if (errors.length) {
    res.status(400);
    return res.render('inventory/stock/form', { title: 'Add stock item', ...ctx, item: null, input: req.body, values: plainValues(req.body, ctx.category.fields), error: errors.join(' ') });
  }
  const employee = await chosenEmployee(req.body);
  const id = await transaction((conn) => insertItem(conn, req.user, ctx.category, data, values, employee));
  flash(req, 'success', 'Item added.');
  res.redirect(req.body.again === '1' ? `/inventory/stock/new?category=${ctx.category.id}` : `/inventory/stock/${id}`);
});

// Same category, brand and model, one row per serial / asset number. Extra field values
// are shared by all of them.
router.post('/multiple', async (req, res) => {
  const ctx = await formContext(toId(req.body.category_id));
  if (!ctx.category) throw notFound();
  const data = readItem(req.body);
  const quantity = Math.min(200, Math.max(1, Number.parseInt(req.body.quantity, 10) || 0));
  const serials = [].concat(req.body.serials || []).map((s) => str(s, 150)).slice(0, quantity);
  while (serials.length < quantity) serials.push('');
  const { values, errors } = readValues(req.body, ctx.category.fields.filter((f) => f.visible));
  if (data.status === 'assigned') errors.push('Items added in bulk start unassigned; assign them from each employee\'s profile.');
  const dupes = serials.filter((s, i) => s && serials.indexOf(s) !== i);
  if (dupes.length) errors.push(`The same serial / asset number is entered twice: ${[...new Set(dupes)].join(', ')}.`);
  if (errors.length) {
    res.status(400);
    return res.render('inventory/stock/multiple', { title: 'Add multiple items', ...ctx, input: { ...req.body, quantity, serials }, values: plainValues(req.body, ctx.category.fields), error: errors.join(' ') });
  }
  await transaction(async (conn) => {
    for (const serial of serials) await insertItem(conn, req.user, ctx.category, { ...data, serial: serial || null }, values, null);
  });
  flash(req, 'success', `${quantity} item${quantity === 1 ? '' : 's'} added.`);
  res.redirect(`/inventory/stock?category=${ctx.category.id}`);
});

// ---- One item ----

async function itemHistory(itemId) {
  const [rows] = await pool.query(`
    SELECT l.id, l.user_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS username, l.action, l.summary, l.created_at
    FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.entity_type = 'inv_item' AND l.entity_id = ?
    ORDER BY l.created_at DESC, l.id DESC LIMIT 200
  `, [itemId]);
  return rows;
}

router.get('/:id', async (req, res) => {
  const item = await getItem(pool, requireId(req.params.id));
  const ctx = await formContext(item.category_id);
  const values = Object.fromEntries([...item.values].map(([k, v]) => [k, v.value || '']));
  res.render('inventory/stock/form', {
    title: itemLabel(item), ...ctx, item, input: item, values, error: null, history: await itemHistory(item.id),
  });
});

router.post('/:id', async (req, res) => {
  const item = await getItem(pool, requireId(req.params.id));
  const ctx = await formContext(toId(req.body.category_id) || item.category_id);
  const data = readItem(req.body);
  const { values, errors } = readValues(req.body, ctx.category.fields.filter((f) => f.visible), item.values);
  if (data.status === 'assigned' && !item.employee_id) errors.push('To assign it, use "Assign to" below.');
  if (errors.length) {
    res.status(400);
    return res.render('inventory/stock/form', {
      title: itemLabel(item), ...ctx, item, input: { ...item, ...req.body }, values: plainValues(req.body, ctx.category.fields),
      error: errors.join(' '), history: await itemHistory(item.id),
    });
  }
  await transaction(async (conn) => {
    const locked = await getItem(conn, item.id, { lock: true });
    // Moving it out of "Assigned" returns it from the employee first.
    if (locked.employee_id && data.status !== 'assigned') await returnItem(conn, req.user, locked, { status: data.status });
    const status = locked.employee_id && data.status === 'assigned' ? 'assigned' : data.status;
    const changes = [];
    for (const k of ['brand', 'model', 'serial', 'notes']) if ((locked[k] || null) !== data[k]) changes.push(k);
    if (locked.status !== status && !(locked.employee_id && status !== 'assigned')) changes.push('status');
    if (ctx.category.id !== locked.category_id) {
      changes.push('category');
      // Extra values of the old category no longer apply.
      await conn.query('DELETE FROM stock_values WHERE item_id = ?', [item.id]);
    }
    await conn.query('UPDATE stock_items SET category_id = ?, brand = ?, model = ?, serial = ?, status = ?, notes = ?, updated_by = ? WHERE id = ?',
      [ctx.category.id, data.brand, data.model, data.serial, status, data.notes, req.user.id, item.id]);
    const existing = ctx.category.id === locked.category_id ? locked.values : new Map();
    changes.push(...await saveValues(conn, item.id, ctx.category.fields, values, existing, 'stock_values'));
    if (changes.length) {
      const label = itemLabel({ ...locked, ...data, category_name: ctx.category.name });
      await logInv(conn, req.user, {
        type: 'inv_item', id: item.id, action: 'updated', subject: label, changes, personId: locked.employee_id && status === 'assigned' ? locked.employee_id : null,
        summary: `Edited ${label}: ${changes.join(', ')}`,
      });
    }
  });
  flash(req, 'success', 'Item saved.');
  res.redirect(`/inventory/stock/${item.id}`);
});

router.post('/:id/assign', async (req, res) => {
  const item = await getItem(pool, requireId(req.params.id));
  const employee = await chosenEmployee(req.body);
  if (!employee) {
    flash(req, 'error', 'Choose an active employee.');
    return res.redirect(`/inventory/stock/${item.id}`);
  }
  try {
    await transaction(async (conn) => assignItem(conn, req.user, await getItem(conn, item.id, { lock: true }), employee));
    flash(req, 'success', `Assigned to ${employee.title}.`);
  } catch (err) {
    if (err.status !== 400) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(safePath(req.body.back, `/inventory/stock/${item.id}`));
});

router.post('/:id/unassign', async (req, res) => {
  const item = await getItem(pool, requireId(req.params.id));
  await transaction(async (conn) => returnItem(conn, req.user, await getItem(conn, item.id, { lock: true })));
  flash(req, 'success', 'Returned to stock.');
  res.redirect(safePath(req.body.back, `/inventory/stock/${item.id}`));
});

router.post('/:id/delete', async (req, res) => {
  const item = await getItem(pool, requireId(req.params.id));
  await transaction(async (conn) => {
    const locked = await getItem(conn, item.id, { lock: true });
    if (locked.employee_id) await returnItem(conn, req.user, locked, { reason: 'item deleted' });
    await conn.query('DELETE FROM stock_items WHERE id = ?', [item.id]);
    await logInv(conn, req.user, { type: 'inv_item', id: item.id, action: 'deleted', subject: itemLabel(item), summary: `Deleted ${itemLabel(item)}` });
  });
  flash(req, 'success', 'Item deleted.');
  res.redirect('/inventory/stock');
});

module.exports = router;
