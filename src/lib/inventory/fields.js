// Flexible inventory fields: definitions (inventory_fields) for a records tab or a stock
// category, form parsing / validation, and saving / loading values. Password and PIN
// values are encrypted (secrets.js) and never decrypted in bulk: lists only know whether
// one is set; revealing goes through POST /inventory/secret, which is logged.
const { str } = require('../http');
const { encrypt, keyStatus } = require('./secrets');

const FIELD_TYPES = {
  text: 'Text',
  longtext: 'Long text',
  email: 'Email',
  phone: 'Phone',
  number: 'Number',
  date: 'Date',
  link: 'Link',
  dropdown: 'Dropdown',
  password: 'Password (encrypted)',
  pin: 'PIN (encrypted)',
  access: 'Access (Granted / Not granted)',
};
const SECRET_TYPES = ['password', 'pin'];
// Stock category extra fields describe kit, so no secrets or access toggles there.
const CATEGORY_TYPES = Object.keys(FIELD_TYPES).filter((t) => !SECRET_TYPES.includes(t) && t !== 'access');

const STOCK_STATUSES = {
  available: 'Available',
  assigned: 'Assigned',
  repair: 'Repair',
  damaged: 'Damaged',
  sold: 'Sold',
  disposed: 'Disposed',
};

const MASK = '••••••';
const isSecret = (field) => SECRET_TYPES.includes(field.field_type);
const optionsOf = (field) => String(field.options || '').split('\n').map((o) => o.trim()).filter(Boolean);

// Fields of one tab ({ tabId }) or stock category ({ categoryId }), in column order.
async function listFields(db, { tabId, categoryId }, { visibleOnly = false } = {}) {
  const [rows] = await db.query(`
    SELECT id, tab_id, category_id, label, field_type, options, role, sort_order, visible, required, width
    FROM inventory_fields
    WHERE ${tabId ? 'tab_id = ?' : 'category_id = ?'} ${visibleOnly ? 'AND visible = 1' : ''}
    ORDER BY sort_order, id
  `, [tabId || categoryId]);
  return rows.map((f) => ({ ...f, visible: Boolean(f.visible), required: Boolean(f.required), optionList: optionsOf(f) }));
}

// Column manager form -> { field } or { error }. allowed: the types this scope may use.
function readFieldForm(body, allowed) {
  const label = str(body.label, 100);
  const type = body.field_type;
  if (!label) return { error: 'Give the column a name.' };
  if (!allowed.includes(type)) return { error: 'Choose a column type.' };
  const options = type === 'dropdown'
    ? String(body.options || '').split(/\r?\n/).map((o) => o.trim().slice(0, 100)).filter(Boolean).slice(0, 100).join('\n')
    : null;
  if (type === 'dropdown' && !options) return { error: 'Add at least one option for the dropdown (one per line).' };
  const width = Math.min(600, Math.max(60, Number.parseInt(body.width, 10) || 160));
  return {
    field: {
      label, field_type: type, options, width,
      required: body.required === '1' ? 1 : 0,
      visible: body.visible === '0' ? 0 : 1,
    },
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Normalises one submitted value; returns { value } or { error }.
function cleanValue(field, raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { value: null };
  switch (field.field_type) {
    case 'longtext':
      return { value: String(raw).trim().slice(0, 10000) };
    case 'email':
      return EMAIL.test(text) && text.length <= 254 ? { value: text } : { error: `${field.label}: enter a valid email address.` };
    case 'phone':
      return /^[0-9+()\-.\s]{3,40}$/.test(text) ? { value: text } : { error: `${field.label}: enter a valid phone number.` };
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(text) && text.length <= 30 ? { value: text } : { error: `${field.label}: enter a number.` };
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { value: text } : { error: `${field.label}: enter a date.` };
    case 'link': {
      const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('scheme');
        return { value: parsed.href.slice(0, 1000) };
      } catch (err) {
        return { error: `${field.label}: enter a web address.` };
      }
    }
    case 'dropdown':
      return field.optionList.includes(text) ? { value: text } : { error: `${field.label}: choose one of the options.` };
    case 'access':
      return { value: text === 'granted' ? 'granted' : null };
    default:
      return { value: text.slice(0, 1000) };
  }
}

// Reads f_<id> inputs for the given fields. For password / PIN fields an empty input
// keeps the saved value, and clear_<id> removes it. existing: Map fieldId -> { value,
// hasSecret } (for required checks on edit). Returns { values: Map fieldId -> change,
// errors }. change is { value } or { secret } (plain text, encrypted on save) or { clear }.
function readValues(body, fields, existing = new Map()) {
  const values = new Map();
  const errors = [];
  let needsKey = false;
  for (const field of fields) {
    const name = `f_${field.id}`;
    if (isSecret(field)) {
      const plain = typeof body[name] === 'string' ? body[name] : '';
      if (body[`clear_${field.id}`] === '1') values.set(field.id, { clear: true });
      else if (plain) {
        if (plain.length > 500) errors.push(`${field.label} is too long.`);
        else {
          values.set(field.id, { secret: plain });
          needsKey = true;
        }
      }
      const willHave = values.has(field.id) ? !values.get(field.id).clear : Boolean(existing.get(field.id)?.hasSecret);
      if (field.required && !willHave) errors.push(`${field.label} is required.`);
      continue;
    }
    if (field.field_type === 'access') {
      values.set(field.id, { value: body[name] === 'granted' ? 'granted' : null });
      continue;
    }
    if (!(name in body)) continue; // not on this form (e.g. hidden column): leave as is
    const result = cleanValue(field, body[name]);
    if (result.error) errors.push(result.error);
    else {
      if (field.required && !result.value) errors.push(`${field.label} is required.`);
      values.set(field.id, { value: result.value });
    }
  }
  if (needsKey && !keyStatus().ok) errors.push(keyStatus().message);
  return { values, errors };
}

// Saves changes for an inventory record (or, with table 'stock_values', a stock item).
// Returns the labels of fields whose value changed (never the values of secrets).
async function saveValues(conn, ownerId, fields, values, existing = new Map(), table = 'inventory_values') {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const changed = [];
  const key = table === 'stock_values' ? 'item_id' : 'record_id';
  for (const [fieldId, change] of values) {
    const field = byId.get(fieldId);
    if (!field) continue;
    const before = existing.get(fieldId) || {};
    if (change.clear || (!change.secret && !change.value)) {
      if (before.value || before.hasSecret) {
        await conn.query(`DELETE FROM ${table} WHERE ${key} = ? AND field_id = ?`, [ownerId, fieldId]);
        changed.push(field.label);
      }
    } else if (change.secret) {
      await conn.query(
        `INSERT INTO inventory_values (record_id, field_id, value, value_enc) VALUES (?, ?, NULL, ?)
         ON DUPLICATE KEY UPDATE value = NULL, value_enc = VALUES(value_enc)`,
        [ownerId, fieldId, encrypt(change.secret)]
      );
      changed.push(field.label);
    } else if (change.value !== before.value) {
      await conn.query(
        `INSERT INTO ${table} (${key}, field_id, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [ownerId, fieldId, change.value]
      );
      changed.push(field.label);
    }
  }
  return changed;
}

// Map ownerId -> Map fieldId -> { value, hasSecret } (secrets are not decrypted).
async function loadValues(db, ids, table = 'inventory_values') {
  const out = new Map(ids.map((id) => [id, new Map()]));
  if (!ids.length) return out;
  const key = table === 'stock_values' ? 'item_id' : 'record_id';
  const cols = table === 'stock_values' ? 'value, NULL AS value_enc' : 'value, value_enc';
  const [rows] = await db.query(`SELECT ${key} AS owner, field_id, ${cols} FROM ${table} WHERE ${key} IN (?)`, [ids]);
  for (const r of rows) {
    if (!out.has(r.owner)) out.set(r.owner, new Map());
    out.get(r.owner).set(r.field_id, { value: r.value, hasSecret: Boolean(r.value_enc) });
  }
  return out;
}

// Text for sorting, search and CSV (secrets masked, never decrypted).
function displayText(field, v) {
  if (!v) return field.field_type === 'access' ? 'Not granted' : '';
  if (isSecret(field)) return v.hasSecret ? MASK : '';
  if (field.field_type === 'access') return v.value === 'granted' ? 'Granted' : 'Not granted';
  return v.value || '';
}

module.exports = {
  FIELD_TYPES, SECRET_TYPES, CATEGORY_TYPES, STOCK_STATUSES, MASK,
  isSecret, optionsOf, listFields, readFieldForm, readValues, saveValues, loadValues, displayText,
};
