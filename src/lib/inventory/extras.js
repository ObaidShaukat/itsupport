// Extra fields: belong to ONE inventory record only (record_extra_fields), unlike shared
// fields (inventory_fields), which every record in the tab has. They show after the
// shared fields on the record page, are not table columns (an "Extra" column shows "+N"
// with their names) and travel in the workbook as one "Extra fields" column
// ("Name: value | Name: value"). Password / PIN values are encrypted (value_enc) exactly
// like shared ones and never decrypted in bulk. Every change is logged on the record
// (entity_type inv_record), never on the Daily Report.
const { FIELD_TYPES, SECRET_TYPES, MASK, readValues } = require('./fields');
const { encrypt, decrypt } = require('./secrets');
const { logInv } = require('./records');

// Extra fields can be any type except access toggles and dropdowns (no options list).
const EXTRA_TYPES = Object.keys(FIELD_TYPES).filter((t) => t !== 'access' && t !== 'dropdown');
const isSecretType = (type) => SECRET_TYPES.includes(type);

// The extra field as a field-like object, so the shared validation / display code works.
const asField = (x) => ({
  id: `x${x.id}`, label: x.name, field_type: x.field_type, options: null, optionList: [], required: false, visible: true, extra: true,
});

// Map recordId -> [extra] (sorted), each { id, record_id, tab_id, name, field_type, value, hasSecret, sort_order }.
async function listExtras(db, recordIds) {
  const out = new Map(recordIds.map((id) => [id, []]));
  if (!recordIds.length) return out;
  const [rows] = await db.query(`
    SELECT id, tab_id, record_id, name, field_type, value, value_enc IS NOT NULL AS has_secret, sort_order, updated_at
    FROM record_extra_fields WHERE record_id IN (?) ORDER BY sort_order, id
  `, [recordIds]);
  for (const r of rows) {
    if (!out.has(r.record_id)) out.set(r.record_id, []);
    out.get(r.record_id).push({ ...r, value: isSecretType(r.field_type) ? null : r.value, hasSecret: Boolean(r.has_secret) });
  }
  return out;
}

async function getExtra(db, id, lock = false) {
  const [[x]] = await db.query(`SELECT * FROM record_extra_fields WHERE id = ? ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!x) return null;
  return { ...x, hasSecret: Boolean(x.value_enc), value: isSecretType(x.field_type) ? null : x.value };
}

// Name + type from a form. Returns { name, type } or { error }.
function readExtraDef(body, { nameKey = 'label', typeKey = 'field_type' } = {}) {
  const name = String(body[nameKey] || '').trim().slice(0, 100);
  const type = String(body[typeKey] || 'text');
  if (!name) return { error: 'Give the field a name.' };
  if (!EXTRA_TYPES.includes(type)) return { error: 'Choose a type (fields for one record cannot be dropdowns or access toggles).' };
  return { name, type };
}

// Checks a typed value for an extra field of this type. raw '' = no value. For secrets
// an empty input keeps the saved one (clear removes it). Returns { change } or { error },
// change = { value } | { secret } | { clear } | null (nothing to do).
function readExtraValue({ name, type }, raw, { clear = false, hasSecret = false } = {}) {
  if (clear) return { change: { clear: true } };
  const draft = { id: 0, label: name, field_type: type, optionList: [], required: false };
  const text = typeof raw === 'string' ? raw : '';
  if (isSecretType(type) && !text) return { change: null };
  const { values, errors } = readValues({ f_0: text }, [draft], new Map([[0, { hasSecret }]]));
  if (errors.length) return { error: errors.join(' ') };
  return { change: values.get(0) || null };
}

// Applies a value change to an extra row (inside a transaction). true when it changed.
async function writeExtraValue(conn, extra, change, userId) {
  if (!change) return false;
  if (change.clear || (!change.secret && !change.value)) {
    if (!extra.value && !extra.hasSecret) return false;
    await conn.query('UPDATE record_extra_fields SET value = NULL, value_enc = NULL, updated_by = ? WHERE id = ?', [userId, extra.id]);
    return true;
  }
  if (change.secret) {
    await conn.query('UPDATE record_extra_fields SET value = NULL, value_enc = ?, updated_by = ? WHERE id = ?', [encrypt(change.secret), userId, extra.id]);
    return true;
  }
  if (change.value === extra.value) return false;
  await conn.query('UPDATE record_extra_fields SET value = ?, value_enc = NULL, updated_by = ? WHERE id = ?', [change.value, userId, extra.id]);
  return true;
}

// Creates an extra field on a record. ctx: { record, tab, title }. Returns the new id.
async function createExtra(conn, user, ctx, { name, type, change }) {
  const [[dup]] = await conn.query('SELECT id FROM record_extra_fields WHERE record_id = ? AND LOWER(name) = LOWER(?)', [ctx.record.id, name]);
  if (dup) throw Object.assign(new Error(`This record already has a field called "${name}".`), { status: 409 });
  const [[shared]] = await conn.query('SELECT id FROM inventory_fields WHERE tab_id = ? AND LOWER(label) = LOWER(?)', [ctx.tab.id, name]);
  if (shared) throw Object.assign(new Error(`${ctx.tab.name} already has a field called "${name}" for all records. Fill in its value instead.`), { status: 409 });
  const [[{ next }]] = await conn.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM record_extra_fields WHERE record_id = ?', [ctx.record.id]);
  const [r] = await conn.query(
    'INSERT INTO record_extra_fields (tab_id, record_id, name, field_type, sort_order, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [ctx.tab.id, ctx.record.id, name, type, next, user.id, user.id]
  );
  const extra = { id: r.insertId, value: null, hasSecret: false };
  const filled = await writeExtraValue(conn, extra, change, user.id);
  await conn.query('UPDATE inventory_records SET updated_by = ? WHERE id = ?', [user.id, ctx.record.id]);
  await logInv(conn, user, {
    type: 'inv_record', id: ctx.record.id, action: 'updated', subject: ctx.title, changes: [name],
    summary: `Added the field "${name}" (${FIELD_TYPES[type]}, this record only) to ${ctx.title} (${ctx.tab.name})${filled ? ' with a value' : ''}`,
  });
  return r.insertId;
}

// Name / type / value of one extra field. Returns the list of what changed.
async function updateExtra(conn, user, ctx, extra, { name, type, change }) {
  const changes = [];
  if (name !== extra.name) {
    const [[dup]] = await conn.query('SELECT id FROM record_extra_fields WHERE record_id = ? AND LOWER(name) = LOWER(?) AND id <> ?', [extra.record_id, name, extra.id]);
    if (dup) throw Object.assign(new Error(`This record already has a field called "${name}".`), { status: 409 });
    changes.push(`renamed "${extra.name}" to "${name}"`);
  }
  if (type !== extra.field_type) {
    const hasValue = Boolean(extra.value || extra.hasSecret);
    if (hasValue && isSecretType(type) !== isSecretType(extra.field_type) && !(change && (change.clear || change.secret || 'value' in change))) {
      throw Object.assign(new Error(`"${extra.name}" has a value, so it cannot change between a password / PIN and a plain type without a new value.`), { status: 400 });
    }
    changes.push(`type ${FIELD_TYPES[extra.field_type]} → ${FIELD_TYPES[type]}`);
  }
  if (changes.length) {
    // A plain value becoming secret (or the other way) is replaced by the new one below.
    const reset = isSecretType(type) !== isSecretType(extra.field_type);
    await conn.query(`UPDATE record_extra_fields SET name = ?, field_type = ?, ${reset ? 'value = NULL, value_enc = NULL, ' : ''}updated_by = ? WHERE id = ?`, [name, type, user.id, extra.id]);
    if (reset) Object.assign(extra, { value: null, hasSecret: false });
  }
  if (await writeExtraValue(conn, extra, change, user.id)) changes.push(isSecretType(type) ? `${name} (value changed)` : `${name} value`);
  if (!changes.length) return changes;
  await conn.query('UPDATE inventory_records SET updated_by = ? WHERE id = ?', [user.id, ctx.record.id]);
  await logInv(conn, user, {
    type: 'inv_record', id: ctx.record.id, action: 'updated', subject: ctx.title, changes: [name],
    summary: `Changed the field "${extra.name}" (this record only) on ${ctx.title}: ${changes.join(', ')}`,
  });
  return changes;
}

async function deleteExtra(conn, user, ctx, extra) {
  await conn.query('DELETE FROM record_extra_fields WHERE id = ?', [extra.id]);
  await conn.query('UPDATE inventory_records SET updated_by = ? WHERE id = ?', [user.id, ctx.record.id]);
  await logInv(conn, user, {
    type: 'inv_record', id: ctx.record.id, action: 'deleted', subject: ctx.title, changes: [extra.name],
    summary: `Deleted the field "${extra.name}" (this record only) from ${ctx.title}${extra.value || extra.hasSecret ? ' with its value' : ''}`,
  });
}

// Moves an extra field up / down among the record's extra fields.
async function moveExtra(conn, user, ctx, extra, dir) {
  const [list] = await conn.query('SELECT id FROM record_extra_fields WHERE record_id = ? ORDER BY sort_order, id', [extra.record_id]);
  const ids = list.map((r) => r.id);
  const i = ids.indexOf(extra.id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return false;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  for (const [k, id] of ids.entries()) await conn.query('UPDATE record_extra_fields SET sort_order = ? WHERE id = ?', [k, id]);
  await logInv(conn, user, {
    type: 'inv_record', id: ctx.record.id, action: 'updated', subject: ctx.title, summary: `Moved the field "${extra.name}" ${dir === 'up' ? 'up' : 'down'} on ${ctx.title}`,
  });
  return true;
}

// "Make shared": a field with the same name and type for every record in the tab; this
// record keeps its value (moved over, still encrypted for secrets); the extra goes.
async function makeShared(conn, user, ctx, extra) {
  const [[same]] = await conn.query('SELECT id FROM inventory_fields WHERE tab_id = ? AND LOWER(label) = LOWER(?)', [ctx.tab.id, extra.name]);
  if (same) throw Object.assign(new Error(`${ctx.tab.name} already has a field called "${extra.name}". Rename one of them first.`), { status: 409 });
  const [[{ next }]] = await conn.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM inventory_fields WHERE tab_id = ?', [ctx.tab.id]);
  const [f] = await conn.query(
    'INSERT INTO inventory_fields (tab_id, label, field_type, options, sort_order, visible, required, width) VALUES (?, ?, ?, NULL, ?, 1, 0, 160)',
    [ctx.tab.id, extra.name, extra.field_type, next]
  );
  const [[raw]] = await conn.query('SELECT value, value_enc FROM record_extra_fields WHERE id = ?', [extra.id]);
  if (raw && (raw.value || raw.value_enc)) {
    await conn.query('INSERT INTO inventory_values (record_id, field_id, value, value_enc) VALUES (?, ?, ?, ?)', [extra.record_id, f.insertId, raw.value, raw.value_enc]);
  }
  await conn.query('DELETE FROM record_extra_fields WHERE id = ?', [extra.id]);
  await logInv(conn, user, {
    type: 'inv_config', action: 'created', subject: ctx.tab.name,
    summary: `Added the column "${extra.name}" (${FIELD_TYPES[extra.field_type]}) to ${ctx.tab.name} by making ${ctx.title}'s field shared`,
  });
  await logInv(conn, user, {
    type: 'inv_record', id: ctx.record.id, action: 'updated', subject: ctx.title, changes: [extra.name],
    summary: `Made the field "${extra.name}" shared (now on every record in ${ctx.tab.name}); ${ctx.title} keeps its value`,
  });
  return f.insertId;
}

// "Name: value | Name: value" for tables (search, CSV) and the workbook. Secrets: MASK,
// or the decrypted value when secrets is a Map extraId -> plain (Include passwords).
function extrasText(extras, { secrets = null, mask = MASK } = {}) {
  return (extras || []).map((x) => {
    let v = x.value || '';
    if (isSecretType(x.field_type)) v = secrets ? secrets.get(x.id) || '' : x.hasSecret ? mask : '';
    return `${x.name}: ${v}`.trim();
  }).join(' | ');
}

// Decrypted secret extras of some records (workbook "Include passwords"): Map id -> plain.
async function extraSecrets(db, recordIds) {
  const out = new Map();
  if (!recordIds.length) return out;
  const [rows] = await db.query('SELECT id, value_enc FROM record_extra_fields WHERE record_id IN (?) AND value_enc IS NOT NULL', [recordIds]);
  for (const r of rows) {
    try { out.set(r.id, decrypt(r.value_enc)); } catch (err) { /* left blank */ }
  }
  return out;
}

// Parses a workbook "Extra fields" cell. '' -> null (no change); CLEAR -> { clearAll };
// otherwise { items: [{ name, value }] } where value '' = no change and CLEAR = remove.
function parseExtrasCell(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^clear$/i.test(t)) return { clearAll: true };
  const items = [];
  const errors = [];
  for (const part of t.split('|').map((p) => p.trim()).filter(Boolean)) {
    const at = part.indexOf(':');
    if (at <= 0) { errors.push(`"${part.slice(0, 40)}" is not "Name: value".`); continue; }
    const name = part.slice(0, at).trim().slice(0, 100);
    const value = part.slice(at + 1).trim();
    if (!name) errors.push(`"${part.slice(0, 40)}" has no name.`);
    else items.push({ name, value });
  }
  return { items, errors };
}

module.exports = {
  EXTRA_TYPES, isSecretType, asField, listExtras, getExtra, readExtraDef, readExtraValue, writeExtraValue, createExtra, updateExtra,
  deleteExtra, moveExtra, makeShared, extrasText, extraSecrets, parseExtrasCell,
};
