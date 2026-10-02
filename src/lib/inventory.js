// Internal inventory (Cleartwo's own staff and equipment, not clients).
// SECURITY: nothing here ever stores passwords, PINs or credentials.
const { pool } = require('../db');
const { logActivity } = require('./activity');
const { isDate } = require('./report');

const ASSET_STATUSES = {
  in_use: 'In use',
  spare: 'Spare',
  repair: 'Repair',
  damaged: 'Damaged',
  sold: 'Sold',
  disposed: 'Disposed',
};
const CONNECTIONS = { wired: 'Wired', wireless: 'Wireless', na: 'N/A' };
const ACCESS_STATUSES = { active: 'Active', removed: 'Removed' };
const PERSON_STATUSES = { active: 'Active', left: 'Left' };

// Stock is "low" when this many or fewer are available.
const LOW_STOCK = 2;

// Labels/headers that look like credentials. Custom field labels use the word "pin" only
// (so "Shipping" is fine); import headers are stricter and skip any "pin" or "pass".
const CREDENTIAL_LABEL = /pass|\bpin\b/i;
const CREDENTIAL_HEADER = /pass|pin/i;

const dateOrNull = (value) => (isDate(value) ? value : null);
const norm = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function loadLists(db = pool) {
  const [companies] = await db.query('SELECT id, name FROM inv_companies ORDER BY name');
  const [teams] = await db.query('SELECT id, name FROM inv_teams ORDER BY name');
  const [categories] = await db.query('SELECT id, name, kind FROM inv_categories ORDER BY name');
  const [apps] = await db.query('SELECT id, name FROM inv_apps ORDER BY name');
  return { companies, teams, categories, apps };
}

// Next free asset tag: C2-0001, C2-0002, ... (call inside a transaction).
async function nextAssetTag(conn) {
  const [[row]] = await conn.query(`
    SELECT MAX(CAST(SUBSTRING(asset_tag, 4) AS UNSIGNED)) AS n FROM inv_assets WHERE asset_tag LIKE 'C2-%' FOR UPDATE
  `);
  return `C2-${String((Number(row.n) || 0) + 1).padStart(4, '0')}`;
}

const logInv = (db, user, entry) => logActivity(db, user, entry);

// Display name for an asset: "HP EliteBook 840 G5 (C2-0007)".
const assetLabel = (a) => `${[a.brand, a.model].filter(Boolean).join(' ') || a.category_name || 'Asset'} (${a.asset_tag})`;
const stockLabel = (s) => [s.brand, s.model].filter(Boolean).join(' ') || s.category_name || 'Stock item';

// Stock totals with assigned and available counts.
const STOCK_SELECT = `
  SELECT s.*, c.name AS category_name,
         COALESCE((SELECT SUM(sa.quantity) FROM inv_stock_assignments sa WHERE sa.stock_id = s.id AND sa.returned_at IS NULL), 0) AS assigned_qty
  FROM inv_stock s
  LEFT JOIN inv_categories c ON c.id = s.category_id
`;
const withAvailability = (s) => {
  const assigned = Number(s.assigned_qty) || 0;
  return { ...s, assigned_qty: assigned, available_qty: Math.max(0, Number(s.total_qty) - assigned - Number(s.damaged_qty)) };
};

async function personById(id, db = pool) {
  const [[p]] = await db.query(`
    SELECT p.*, co.name AS company_name, t.name AS team_name
    FROM inv_people p
    LEFT JOIN inv_companies co ON co.id = p.company_id
    LEFT JOIN inv_teams t ON t.id = p.team_id
    WHERE p.id = ?
  `, [id]);
  return p || null;
}

async function assetById(id, db = pool) {
  const [[a]] = await db.query(`
    SELECT a.*, c.name AS category_name, c.kind AS category_kind, p.name AS person_name
    FROM inv_assets a
    LEFT JOIN inv_categories c ON c.id = a.category_id
    LEFT JOIN inv_people p ON p.id = a.person_id
    WHERE a.id = ?
  `, [id]);
  return a || null;
}

async function stockById(id, db = pool) {
  const [[s]] = await db.query(`${STOCK_SELECT} WHERE s.id = ?`, [id]);
  return s ? withAvailability(s) : null;
}

// Items a person currently holds (used on the person page and for offboarding).
async function holdings(personId, db = pool) {
  const [assets] = await db.query(`
    SELECT a.*, c.name AS category_name FROM inv_assets a
    LEFT JOIN inv_categories c ON c.id = a.category_id
    WHERE a.person_id = ? ORDER BY c.name, a.asset_tag
  `, [personId]);
  const [stock] = await db.query(`
    SELECT sa.id, sa.quantity, sa.assigned_at, sa.notes, s.id AS stock_id, s.brand, s.model, s.connection, c.name AS category_name
    FROM inv_stock_assignments sa
    JOIN inv_stock s ON s.id = sa.stock_id
    LEFT JOIN inv_categories c ON c.id = s.category_id
    WHERE sa.person_id = ? AND sa.returned_at IS NULL
    ORDER BY c.name, s.model
  `, [personId]);
  const [access] = await db.query(`
    SELECT ac.*, ap.name AS app_name FROM inv_access ac
    LEFT JOIN inv_apps ap ON ap.id = ac.app_id
    WHERE ac.person_id = ? ORDER BY ac.status, ap.name
  `, [personId]);
  return { assets, stock, access };
}

module.exports = {
  ASSET_STATUSES, CONNECTIONS, ACCESS_STATUSES, PERSON_STATUSES, LOW_STOCK,
  CREDENTIAL_LABEL, CREDENTIAL_HEADER,
  dateOrNull, norm, loadLists, nextAssetTag, logInv, assetLabel, stockLabel,
  STOCK_SELECT, withAvailability, personById, assetById, stockById, holdings,
};
