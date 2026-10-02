// Inventory > Reports and CSV exports.
const express = require('express');
const { pool } = require('../../db');
const { notFound } = require('../../lib/http');
const { londonDate } = require('../../lib/activity');
const inv = require('../../lib/inventory');
const cf = require('../../lib/custom-fields');

const router = express.Router();

router.get('/reports', async (req, res) => {
  // Assets grouped by category and model, with status counts and who has them.
  const [assetRows] = await pool.query(`
    SELECT c.name AS category, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', a.brand, a.model)), ''), '(no model)') AS model,
           a.status, p.name AS person
    FROM inv_assets a
    LEFT JOIN inv_categories c ON c.id = a.category_id
    LEFT JOIN inv_people p ON p.id = a.person_id
    ORDER BY c.name, model
  `);
  const assetGroups = new Map();
  for (const r of assetRows) {
    const key = `${r.category || 'Uncategorised'}|${r.model}`;
    if (!assetGroups.has(key)) assetGroups.set(key, { category: r.category || 'Uncategorised', model: r.model, total: 0, statuses: {}, people: [] });
    const g = assetGroups.get(key);
    g.total++;
    g.statuses[r.status] = (g.statuses[r.status] || 0) + 1;
    if (r.person && !g.people.includes(r.person)) g.people.push(r.person);
  }

  // Stock with who holds it.
  const [stockRows] = await pool.query(`${inv.STOCK_SELECT} ORDER BY c.name, s.brand, s.model`);
  const stock = stockRows.map(inv.withAvailability);
  const [holders] = await pool.query(`
    SELECT sa.stock_id, p.name, SUM(sa.quantity) AS qty FROM inv_stock_assignments sa
    JOIN inv_people p ON p.id = sa.person_id WHERE sa.returned_at IS NULL GROUP BY sa.stock_id, p.name ORDER BY p.name
  `);
  for (const s of stock) s.holders = holders.filter((h) => h.stock_id === s.id).map((h) => (Number(h.qty) > 1 ? `${h.name} (${h.qty})` : h.name));

  const [byCategory] = await pool.query(`
    SELECT c.name AS category, c.kind,
      (SELECT COUNT(*) FROM inv_assets a WHERE a.category_id = c.id) AS assets,
      (SELECT COALESCE(SUM(s.total_qty), 0) FROM inv_stock s WHERE s.category_id = c.id) AS stock
    FROM inv_categories c ORDER BY c.name
  `);
  const [byStatus] = await pool.query('SELECT status, COUNT(*) AS n FROM inv_assets GROUP BY status');

  const [spare] = await pool.query(`
    SELECT a.id, a.asset_tag, a.brand, a.model, a.serial_number, a.location, c.name AS category_name FROM inv_assets a
    LEFT JOIN inv_categories c ON c.id = a.category_id WHERE a.status = 'spare' ORDER BY c.name, a.model
  `);
  const [broken] = await pool.query(`
    SELECT a.id, a.asset_tag, a.brand, a.model, a.serial_number, a.status, c.name AS category_name, p.name AS person_name FROM inv_assets a
    LEFT JOIN inv_categories c ON c.id = a.category_id LEFT JOIN inv_people p ON p.id = a.person_id
    WHERE a.status IN ('repair', 'damaged') ORDER BY a.status, c.name, a.model
  `);
  const [noLaptop] = await pool.query(`
    SELECT p.id, p.name, t.name AS team_name FROM inv_people p LEFT JOIN inv_teams t ON t.id = p.team_id
    WHERE p.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM inv_assets a JOIN inv_categories c ON c.id = a.category_id
      WHERE a.person_id = p.id AND c.name IN ('Laptop', 'Workstation', 'Desktop')
    ) ORDER BY p.name
  `);

  res.render('inventory/reports', {
    title: 'Inventory reports',
    assetGroups: [...assetGroups.values()],
    stock,
    byCategory: byCategory.filter((c) => Number(c.assets) || Number(c.stock)),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
    spare,
    broken,
    lowStock: stock.filter((s) => s.available_qty <= inv.LOW_STOCK),
    lowStockLimit: inv.LOW_STOCK,
    noLaptop,
  });
});

// ---- CSV export ----

// Quotes a value and neutralises spreadsheet formulas (=, +, -, @ at the start).
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const EXPORTS = {
  people: {
    entity: 'person',
    sql: `SELECT p.id, p.name, p.email, co.name AS company, t.name AS team, p.role, p.phone, p.start_date, p.status, p.leaving_date, p.notes
          FROM inv_people p LEFT JOIN inv_companies co ON co.id = p.company_id LEFT JOIN inv_teams t ON t.id = p.team_id ORDER BY p.status, p.name`,
    columns: [['name', 'Name'], ['email', 'Email'], ['company', 'Company'], ['team', 'Team'], ['role', 'Role'], ['phone', 'Phone'],
      ['start_date', 'Start date'], ['status', 'Status'], ['leaving_date', 'Leaving date'], ['notes', 'Notes']],
  },
  assets: {
    entity: 'asset',
    sql: `SELECT a.id, a.asset_tag, c.name AS category, a.brand, a.model, a.serial_number, a.device_name, a.wifi_mac, a.ethernet_mac,
                 a.specifications, a.purchase_date, a.location, a.status, p.name AS person, a.sold_to, a.sold_date, a.notes
          FROM inv_assets a LEFT JOIN inv_categories c ON c.id = a.category_id LEFT JOIN inv_people p ON p.id = a.person_id ORDER BY a.asset_tag`,
    columns: [['asset_tag', 'Asset tag'], ['category', 'Category'], ['brand', 'Brand'], ['model', 'Model'], ['serial_number', 'Serial number'],
      ['device_name', 'Device name'], ['wifi_mac', 'Wi-Fi MAC'], ['ethernet_mac', 'Ethernet MAC'], ['specifications', 'Specifications'],
      ['purchase_date', 'Purchase date'], ['location', 'Location'], ['status', 'Status'], ['person', 'Assigned to'],
      ['sold_to', 'Sold to'], ['sold_date', 'Sold date'], ['notes', 'Notes']],
  },
  stock: {
    entity: 'stock',
    sql: `${inv.STOCK_SELECT} ORDER BY c.name, s.model`,
    map: inv.withAvailability,
    columns: [['category_name', 'Category'], ['brand', 'Brand'], ['model', 'Model'], ['connection', 'Connection'], ['location', 'Location'],
      ['total_qty', 'Total'], ['assigned_qty', 'Assigned'], ['damaged_qty', 'Damaged'], ['available_qty', 'Available'], ['notes', 'Notes']],
  },
  access: {
    entity: 'access',
    sql: `SELECT ac.id, p.name AS person, ap.name AS app, ac.username, ac.granted_date, ac.granted_by, ac.status, ac.removed_date,
                 IF(ac.in_1password, 'Yes', 'No') AS in_1password, ac.onepassword_link, ac.notes
          FROM inv_access ac JOIN inv_people p ON p.id = ac.person_id LEFT JOIN inv_apps ap ON ap.id = ac.app_id ORDER BY p.name, ap.name`,
    columns: [['person', 'Person'], ['app', 'Account / app'], ['username', 'Username / email'], ['granted_date', 'Granted'],
      ['granted_by', 'Granted by'], ['status', 'Status'], ['removed_date', 'Removed'], ['in_1password', 'In 1Password'],
      ['onepassword_link', '1Password link'], ['notes', 'Notes']],
  },
};

router.get('/export/:type', async (req, res) => {
  const type = String(req.params.type).replace(/\.csv$/, '');
  const spec = EXPORTS[type];
  if (!spec) throw notFound();
  let [rows] = await pool.query(spec.sql);
  if (spec.map) rows = rows.map(spec.map);
  const fields = await cf.fieldsFor(spec.entity, { includeHidden: false });
  const values = await cf.valuesFor(spec.entity, rows.map((r) => r.id));

  const header = [...spec.columns.map(([, label]) => label), ...fields.map((f) => f.label)];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    const v = values.get(row.id) || {};
    lines.push([
      ...spec.columns.map(([key]) => row[key]),
      ...fields.map((f) => cf.displayValue(f, v[f.id])),
    ].map(csvCell).join(','));
  }
  await inv.logInv(null, req.user, { type: 'inv_setting', action: 'updated', subject: `${type} export`,
    summary: `Exported ${rows.length} ${type} record${rows.length === 1 ? '' : 's'} to CSV.` });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`inventory-${type}-${londonDate()}.csv`);
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});

module.exports = router;
