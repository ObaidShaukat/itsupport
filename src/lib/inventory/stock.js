// Stock: every physical item (laptops included), its category's extra fields, assigning
// to and returning from employees (with an assignment history), the per-category
// summary and the Category > Brand > Model breakdown report.
const { pool } = require('../../db');
const { notFound } = require('../http');
const { londonDate } = require('../activity');
const { listFields, loadValues } = require('./fields');
const { employeeNames, logInv } = require('./records');

async function listCategories(db = pool, { withFields = false } = {}) {
  const [cats] = await db.query('SELECT id, name, group_by, group_field_id, sort_order FROM stock_categories ORDER BY sort_order, name');
  if (withFields) {
    for (const c of cats) c.fields = await listFields(db, { categoryId: c.id });
  }
  return cats;
}

async function getCategory(db, id) {
  const [[cat]] = await db.query('SELECT id, name, group_by, group_field_id, sort_order FROM stock_categories WHERE id = ?', [id]);
  if (!cat) throw notFound();
  return cat;
}

const ITEM_COLUMNS = `
  i.id, i.category_id, c.name AS category_name, i.brand, i.model, i.serial, i.status, i.employee_id, i.notes,
  i.created_at, i.updated_at`;

// "Laptop · Dell Latitude 5420 (SN 1234)"
function itemLabel(item) {
  const name = [item.brand, item.model].filter(Boolean).join(' ') || 'Item';
  return `${item.category_name ? `${item.category_name} · ` : ''}${name}${item.serial ? ` (${item.serial})` : ''}`;
}

// Items with values and employee names. filters: { categoryId, status, employeeId, ids }.
async function listItems(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.categoryId) { where.push('i.category_id = ?'); params.push(filters.categoryId); }
  if (filters.status) { where.push('i.status = ?'); params.push(filters.status); }
  if (filters.employeeId) { where.push('i.employee_id = ?'); params.push(filters.employeeId); }
  const [items] = await db.query(`
    SELECT ${ITEM_COLUMNS}
    FROM stock_items i JOIN stock_categories c ON c.id = i.category_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.sort_order, c.name, i.brand, i.model, i.serial, i.id
  `, params);
  const values = await loadValues(db, items.map((i) => i.id), 'stock_values');
  const names = await employeeNames(db, items.map((i) => i.employee_id));
  return items.map((i) => ({ ...i, values: values.get(i.id) || new Map(), employee_name: i.employee_id ? names.get(i.employee_id) : null }));
}

async function getItem(db, id, { lock = false } = {}) {
  const [[item]] = await db.query(`
    SELECT ${ITEM_COLUMNS}
    FROM stock_items i JOIN stock_categories c ON c.id = i.category_id
    WHERE i.id = ? ${lock ? 'FOR UPDATE' : ''}
  `, [id]);
  if (!item) throw notFound();
  item.values = (await loadValues(db, [item.id], 'stock_values')).get(item.id) || new Map();
  if (item.employee_id) item.employee_name = (await employeeNames(db, [item.employee_id])).get(item.employee_id);
  return item;
}

// Assigns an available item to an active employee (inside a transaction).
async function assignItem(conn, user, item, employee) {
  if (item.status !== 'available') throw Object.assign(new Error('That item is not available.'), { status: 400 });
  await conn.query("UPDATE stock_items SET status = 'assigned', employee_id = ?, updated_by = ? WHERE id = ?", [employee.id, user.id, item.id]);
  await conn.query(`
    INSERT INTO stock_assignments (item_id, employee_id, category_name, brand, model, serial, assigned_on, assigned_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [item.id, employee.id, item.category_name, item.brand, item.model, item.serial, londonDate(), user.id]);
  await logInv(conn, user, {
    type: 'inv_item', id: item.id, action: 'assigned', subject: itemLabel(item), personId: employee.id,
    summary: `Assigned ${itemLabel(item)} to ${employee.title}`,
  });
}

// Returns an assigned item to stock (status available unless given), closing its open
// assignment on returnedOn (a UK date; default today).
async function returnItem(conn, user, item, { status = 'available', returnedOn = londonDate(), reason = '' } = {}) {
  if (!item.employee_id) return;
  const name = item.employee_name || 'the employee';
  await conn.query('UPDATE stock_items SET status = ?, employee_id = NULL, updated_by = ? WHERE id = ?', [status, user.id, item.id]);
  await conn.query(
    'UPDATE stock_assignments SET returned_on = ?, returned_by = ? WHERE item_id = ? AND employee_id = ? AND returned_on IS NULL',
    [returnedOn, user.id, item.id, item.employee_id]
  );
  await logInv(conn, user, {
    type: 'inv_item', id: item.id, action: 'returned', subject: itemLabel(item), personId: item.employee_id,
    summary: `Returned ${itemLabel(item)} from ${name} to stock${reason ? ` (${reason})` : ''}`,
  });
}

// Everything an employee holds goes back to stock (used when they become inactive).
async function returnAll(conn, user, employee, returnedOn) {
  const [rows] = await conn.query('SELECT id FROM stock_items WHERE employee_id = ? FOR UPDATE', [employee.id]);
  for (const { id } of rows) {
    const item = await getItem(conn, id);
    item.employee_name = employee.title;
    await returnItem(conn, user, item, { returnedOn, reason: 'left the company' });
  }
  return rows.length;
}

// Assignment history of an employee, newest first.
async function assignmentsFor(db, employeeId) {
  const [rows] = await db.query(`
    SELECT id, item_id, category_name, brand, model, serial, assigned_on, returned_on
    FROM stock_assignments WHERE employee_id = ? ORDER BY assigned_on DESC, id DESC
  `, [employeeId]);
  return rows;
}

// Per category: total, assigned, available, repair / damaged, sold / disposed.
async function summary(db = pool) {
  const [rows] = await db.query(`
    SELECT c.id, c.name,
           COUNT(i.id) AS total,
           SUM(i.status = 'assigned') AS assigned,
           SUM(i.status = 'available') AS available,
           SUM(i.status IN ('repair', 'damaged')) AS repair,
           SUM(i.status IN ('sold', 'disposed')) AS gone
    FROM stock_categories c LEFT JOIN stock_items i ON i.category_id = c.id
    GROUP BY c.id, c.name, c.sort_order
    ORDER BY c.sort_order, c.name
  `);
  return rows.map((r) => ({ ...r, total: Number(r.total), assigned: Number(r.assigned) || 0, available: Number(r.available) || 0,
    repair: Number(r.repair) || 0, gone: Number(r.gone) || 0 }));
}

const platformOf = (category, item) => (/apple|mac/i.test(`${item.brand || ''} ${category.name}`) ? 'Apple' : 'Windows');

// Breakdown like the old Excel sheet: Category > (group) > Brand > Model with quantity and
// the employees using it, plus brand and category totals. Sold and disposed items are
// left out. Groups: 'platform' (Windows / Apple), 'field' (e.g. Mouse connection type).
async function breakdown(db = pool) {
  const categories = await listCategories(db);
  const items = (await listItems(db)).filter((i) => !['sold', 'disposed'].includes(i.status));
  return categories.map((cat) => {
    const catItems = items.filter((i) => i.category_id === cat.id);
    const groupOf = (item) => {
      if (cat.group_by === 'platform') return platformOf(cat, item);
      if (cat.group_by === 'field' && cat.group_field_id) return item.values.get(cat.group_field_id)?.value || 'Not set';
      return null;
    };
    const groups = new Map();
    for (const item of catItems) {
      const g = groupOf(item);
      if (!groups.has(g)) groups.set(g, new Map());
      const brand = item.brand || 'No brand';
      const brands = groups.get(g);
      if (!brands.has(brand)) brands.set(brand, new Map());
      const model = item.model || 'No model';
      const models = brands.get(brand);
      if (!models.has(model)) models.set(model, { model, quantity: 0, available: 0, employees: [] });
      const row = models.get(model);
      row.quantity += 1;
      if (item.status === 'available') row.available += 1;
      if (item.employee_name && !row.employees.includes(item.employee_name)) row.employees.push(item.employee_name);
    }
    const sortKeys = (m) => [...m.keys()].sort((a, b) => String(a).localeCompare(String(b)));
    return {
      id: cat.id,
      name: cat.name,
      total: catItems.length,
      groups: sortKeys(groups).map((g) => {
        const brands = groups.get(g);
        const brandRows = sortKeys(brands).map((b) => {
          const models = [...brands.get(b).values()].sort((x, y) => x.model.localeCompare(y.model));
          models.forEach((m) => m.employees.sort((x, y) => x.localeCompare(y)));
          return { brand: b, models, total: models.reduce((n, m) => n + m.quantity, 0) };
        });
        return { name: g, brands: brandRows, total: brandRows.reduce((n, b) => n + b.total, 0) };
      }),
    };
  });
}

module.exports = {
  listCategories, getCategory, itemLabel, listItems, getItem, assignItem, returnItem, returnAll,
  assignmentsFor, summary, breakdown,
};
