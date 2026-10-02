// Custom fields for inventory records, managed in the portal (Inventory > Custom fields).
// Definitions live in custom_fields, values in custom_field_values.
const { pool } = require('../db');
const { isDate } = require('./report');

const CF_ENTITIES = {
  person: 'People',
  asset: 'Assets',
  stock: 'Stock',
  access: 'Access',
  shared: 'Shared accounts',
};

const CF_TYPES = {
  text: 'Text',
  longtext: 'Long text',
  number: 'Number',
  date: 'Date',
  select: 'Dropdown',
  boolean: 'Yes / No',
  link: 'Link',
};

const optionList = (field) => String(field.options || '').split(/\r?\n/).map((o) => o.trim()).filter(Boolean);

// Visible fields for an entity type. With categoryId, fields limited to another
// category are left out; without it (list pages), all fields are returned.
async function fieldsFor(entityType, { categoryId, includeHidden = false } = {}, db = pool) {
  const [rows] = await db.query(`
    SELECT f.*, c.name AS category_name FROM custom_fields f
    LEFT JOIN inv_categories c ON c.id = f.category_id
    WHERE f.entity_type = ? ${includeHidden ? '' : 'AND f.hidden = 0'}
    ORDER BY f.sort_order, f.id
  `, [entityType]);
  const fields = rows.map((f) => ({ ...f, optionList: optionList(f) }));
  if (categoryId === undefined) return fields;
  return fields.filter((f) => !f.category_id || f.category_id === categoryId);
}

// Map entityId -> { fieldId: value } for the given records.
async function valuesFor(entityType, ids, db = pool) {
  const map = new Map();
  const list = [].concat(ids).filter(Boolean);
  if (!list.length) return map;
  const [rows] = await db.query(
    'SELECT entity_id, field_id, value FROM custom_field_values WHERE entity_type = ? AND entity_id IN (?)',
    [entityType, list]
  );
  for (const r of rows) {
    if (!map.has(r.entity_id)) map.set(r.entity_id, {});
    map.get(r.entity_id)[r.field_id] = r.value;
  }
  return map;
}

// Reads cf_<id> form fields. Returns { values: {fieldId: value|null}, errors: [] }.
function readValues(fields, body) {
  const values = {};
  const errors = [];
  for (const f of fields) {
    let raw = body[`cf_${f.id}`];
    if (Array.isArray(raw)) raw = raw[raw.length - 1];
    let v = typeof raw === 'string' ? raw.trim().slice(0, f.field_type === 'longtext' ? 10000 : 1000) : '';
    if (f.field_type === 'boolean') v = v === 'yes' ? 'yes' : (v === 'no' ? 'no' : '');
    if (v && f.field_type === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) errors.push(`${f.label} must be a number.`);
    if (v && f.field_type === 'date' && !isDate(v)) errors.push(`${f.label} must be a valid date.`);
    if (v && f.field_type === 'select' && !f.optionList.includes(v)) errors.push(`Choose one of the options for ${f.label}.`);
    if (v && f.field_type === 'link' && !/^https?:\/\/\S+$/i.test(v)) errors.push(`${f.label} must be a link starting with http:// or https://.`);
    if (!v && f.required) errors.push(`${f.label} is required.`);
    values[f.id] = v || null;
  }
  return { values, errors };
}

// Saves values for one record; returns the labels that changed.
async function saveValues(conn, entityType, entityId, fields, values) {
  const [existing] = await conn.query(
    'SELECT field_id, value FROM custom_field_values WHERE entity_type = ? AND entity_id = ?',
    [entityType, entityId]
  );
  const before = Object.fromEntries(existing.map((r) => [r.field_id, r.value]));
  const changed = [];
  for (const f of fields) {
    const v = values[f.id] ?? null;
    if ((before[f.id] ?? null) === v) continue;
    changed.push(f.label);
    if (v === null) {
      await conn.query('DELETE FROM custom_field_values WHERE field_id = ? AND entity_id = ?', [f.id, entityId]);
    } else {
      await conn.query(`
        INSERT INTO custom_field_values (field_id, entity_type, entity_id, value) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE value = VALUES(value)
      `, [f.id, entityType, entityId, v]);
    }
  }
  return changed;
}

const displayValue = (field, value) => {
  if (value === null || value === undefined || value === '') return '';
  if (field.field_type === 'boolean') return value === 'yes' ? 'Yes' : 'No';
  return String(value);
};

// Dropdown and yes/no fields can filter list pages (?cf_<id>=value).
const filterableFields = (fields) => fields.filter((f) => f.field_type === 'select' || f.field_type === 'boolean');

function filterCondition(entityType, alias, fields, query) {
  const where = [];
  const params = [];
  const active = {};
  for (const f of filterableFields(fields)) {
    const v = typeof query[`cf_${f.id}`] === 'string' ? query[`cf_${f.id}`] : '';
    if (!v) continue;
    active[f.id] = v;
    where.push(`EXISTS (SELECT 1 FROM custom_field_values cfv WHERE cfv.entity_type = ? AND cfv.entity_id = ${alias}.id AND cfv.field_id = ? AND cfv.value = ?)`);
    params.push(entityType, f.id, v);
  }
  return { where, params, active };
}

module.exports = {
  CF_ENTITIES, CF_TYPES, optionList, fieldsFor, valuesFor, readValues, saveValues, displayValue, filterableFields, filterCondition,
};
