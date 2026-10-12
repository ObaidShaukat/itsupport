// Brands & models clean-up for stock items: list every brand and model per category with
// counts, and rename / merge one brand or model into another (e.g. brand "MacBook" into
// "Apple", with "MacBook" put in front of the model: "MacBook Air M1 2020"). Matching is
// case-insensitive and ignores surrounding spaces, so "apple" and "Apple " merge too. A
// plan is shown as a preview first and re-made inside the apply transaction.
const { logInv } = require('./records');

const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const same = (a, b) => clean(a, 200).toLowerCase() === clean(b, 200).toLowerCase();

// [{ id, name, total, brands: [{ brand, count, models: [{ model, count }] }] }]
async function brandTree(db) {
  const [rows] = await db.query(`
    SELECT c.id, c.name, c.sort_order, i.brand, i.model, COUNT(i.id) AS n
    FROM stock_categories c JOIN stock_items i ON i.category_id = c.id
    GROUP BY c.id, c.name, c.sort_order, i.brand, i.model
    ORDER BY c.sort_order, c.name, i.brand, i.model
  `);
  const cats = new Map();
  for (const r of rows) {
    if (!cats.has(r.id)) cats.set(r.id, { id: r.id, name: r.name, total: 0, brands: new Map() });
    const cat = cats.get(r.id);
    const brand = r.brand || '';
    if (!cat.brands.has(brand)) cat.brands.set(brand, { brand, count: 0, models: [] });
    const b = cat.brands.get(brand);
    b.count += Number(r.n);
    cat.total += Number(r.n);
    b.models.push({ model: r.model || '', count: Number(r.n) });
  }
  return [...cats.values()].map((c) => ({ ...c, brands: [...c.brands.values()].sort((a, b) => a.brand.localeCompare(b.brand)) }));
}

// Suggestions for the stock forms: brands A-Z and, per brand (lower case), its models.
async function suggestions(db) {
  const [rows] = await db.query(`
    SELECT DISTINCT TRIM(brand) AS brand, TRIM(model) AS model FROM stock_items
    WHERE brand IS NOT NULL AND TRIM(brand) <> '' ORDER BY brand, model
  `);
  const brands = [...new Set(rows.map((r) => r.brand))];
  const models = {};
  for (const r of rows) {
    if (!r.model) continue;
    const k = r.brand.toLowerCase();
    (models[k] = models[k] || []).includes(r.model) || models[k].push(r.model);
  }
  return { brands, models };
}

// Reads the rename / merge form. Returns { input } or { error }.
function readRename(body) {
  const input = {
    kind: body.kind === 'model' ? 'model' : 'brand',
    categoryId: Number(body.category_id) || null,
    fromBrand: clean(body.from_brand, 100),
    fromModel: clean(body.from_model, 150),
    toBrand: clean(body.to_brand, 100),
    toModel: clean(body.to_model, 150),
    prefix: body.prefix === '1',
  };
  if (!input.fromBrand) return { input, error: 'Choose the brand to change.' };
  if (input.kind === 'brand' && !input.toBrand) return { input, error: 'Enter the new brand name (an existing brand merges them).' };
  if (input.kind === 'model' && !input.fromModel) return { input, error: 'Choose the model to change.' };
  if (input.kind === 'model' && !input.toModel) return { input, error: 'Enter the new model name (an existing model merges them).' };
  return { input };
}

// The items that change: { items: [{ id, category, brand, model, newBrand, newModel, employee_id }],
// groups: [{ category, from, to, count, merge }] }.
async function planRename(db, input, { lock = false } = {}) {
  const params = [input.fromBrand];
  let where = 'LOWER(TRIM(i.brand)) = LOWER(?)';
  if (input.kind === 'model') { where += ' AND LOWER(TRIM(i.model)) = LOWER(?)'; params.push(input.fromModel); }
  if (input.categoryId) { where += ' AND i.category_id = ?'; params.push(input.categoryId); }
  const [rows] = await db.query(`
    SELECT i.id, i.category_id, c.name AS category, i.brand, i.model, i.serial, i.employee_id
    FROM stock_items i JOIN stock_categories c ON c.id = i.category_id
    WHERE ${where} ORDER BY c.sort_order, c.name, i.model, i.id ${lock ? 'FOR UPDATE' : ''}
  `, params);
  const [existing] = await db.query('SELECT DISTINCT category_id, TRIM(brand) AS brand, TRIM(model) AS model FROM stock_items');
  const items = [];
  for (const r of rows) {
    let newBrand = input.kind === 'brand' ? input.toBrand : (input.toBrand || clean(r.brand, 100));
    let newModel = clean(r.model, 150);
    if (input.kind === 'model') newModel = input.toModel;
    else if (input.prefix) {
      // The brand as typed in the form (e.g. "MacBook"), not each item's own spelling.
      const old = input.fromBrand;
      newModel = newModel.toLowerCase().startsWith(old.toLowerCase()) ? newModel : clean(`${old} ${newModel}`, 150);
    }
    newBrand = newBrand || null;
    newModel = newModel || null;
    if ((r.brand || null) === newBrand && (r.model || null) === newModel) continue;
    items.push({ ...r, newBrand, newModel });
  }
  const groups = new Map();
  for (const it of items) {
    const key = [it.category, it.brand, it.model, it.newBrand, it.newModel].join('\u0000');
    if (!groups.has(key)) {
      const merge = existing.some((e) => e.category_id === it.category_id && same(e.brand, it.newBrand) && same(e.model, it.newModel)
        && !(same(e.brand, it.brand) && same(e.model, it.model)));
      groups.set(key, {
        category: it.category, from: `${it.brand || '(no brand)'} · ${it.model || '(no model)'}`,
        to: `${it.newBrand || '(no brand)'} · ${it.newModel || '(no model)'}`, count: 0, merge,
      });
    }
    groups.get(key).count += 1;
  }
  return { items, groups: [...groups.values()] };
}

const describe = (input) => (input.kind === 'brand'
  ? `brand "${input.fromBrand}" → "${input.toBrand}"${input.prefix ? ' (old brand put in front of the model)' : ''}`
  : `model "${input.fromBrand} ${input.fromModel}" → "${input.toBrand || input.fromBrand} ${input.toModel}"`);

// Applies the rename / merge (inside a transaction). Returns the number of items changed.
async function applyRename(conn, user, input, where) {
  const plan = await planRename(conn, input, { lock: true });
  for (const it of plan.items) {
    await conn.query('UPDATE stock_items SET brand = ?, model = ?, updated_by = ? WHERE id = ?', [it.newBrand, it.newModel, user.id, it.id]);
    await logInv(conn, user, {
      type: 'inv_item', id: it.id, action: 'updated', subject: `${it.newBrand || ''} ${it.newModel || ''}`.trim(), changes: ['brand', 'model'],
      summary: `Brand / model clean-up: "${it.brand || ''} ${it.model || ''}" → "${it.newBrand || ''} ${it.newModel || ''}"${it.serial ? ` (serial ${it.serial})` : ''}`,
      personId: it.employee_id || null,
    });
  }
  if (plan.items.length) {
    await logInv(conn, user, {
      type: 'inv_config', action: 'updated', subject: 'Brands & models',
      summary: `Renamed / merged ${describe(input)} in ${where}: ${plan.items.length} item${plan.items.length === 1 ? '' : 's'} updated`,
    });
  }
  return plan.items.length;
}

module.exports = { brandTree, suggestions, readRename, planRename, applyRename, describe };
