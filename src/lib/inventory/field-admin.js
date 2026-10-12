// Deleting inventory fields: the field's values (records and stock items), any stock
// category grouping on it and the definition go together in the caller's transaction,
// with one inv_config log line. Also finds the junk fields created by mistake (names
// typed into "+ Add field" instead of a value) for the one-time clean-up in Settings.
const { logInv } = require('./records');

// Names of fields created by mistake, removed by Settings -> Clean up (case-insensitive).
const JUNK_NAMES = ['asdasd', 'asdas', 'mdp.user26@gmail.com'];

// Deletes one field (row from inventory_fields) with its values. where: tab / category
// name for the log. Returns the number of records / items that had a value.
async function deleteField(conn, user, field, where, { note = '' } = {}) {
  const [[{ records }]] = await conn.query(
    'SELECT COUNT(*) AS records FROM inventory_values WHERE field_id = ? AND (value IS NOT NULL OR value_enc IS NOT NULL)', [field.id]
  );
  const [[{ items }]] = await conn.query('SELECT COUNT(*) AS items FROM stock_values WHERE field_id = ? AND value IS NOT NULL', [field.id]);
  const count = Number(records) + Number(items);
  await conn.query('DELETE FROM inventory_values WHERE field_id = ?', [field.id]);
  await conn.query('DELETE FROM stock_values WHERE field_id = ?', [field.id]);
  await conn.query("UPDATE stock_categories SET group_by = 'none', group_field_id = NULL WHERE group_field_id = ?", [field.id]);
  const [r] = await conn.query('DELETE FROM inventory_fields WHERE id = ?', [field.id]);
  if (!r.affectedRows) throw Object.assign(new Error(`"${field.label}" was already deleted.`), { status: 404 });
  await logInv(conn, user, {
    type: 'inv_config', action: 'deleted', subject: where,
    summary: `Deleted the column "${field.label}" from ${where}${count ? ` (data in ${count} record${count === 1 ? '' : 's'} removed)` : ''}${note}`,
  });
  return count;
}

// Junk fields on any tab or stock category: [{ id, label, field_type, where, values }].
async function findJunkFields(db) {
  const [rows] = await db.query(`
    SELECT f.id, f.label, f.field_type, f.tab_id, f.category_id, COALESCE(t.name, CONCAT('Stock: ', c.name)) AS place,
           (SELECT COUNT(*) FROM inventory_values v WHERE v.field_id = f.id AND (v.value IS NOT NULL OR v.value_enc IS NOT NULL))
           + (SELECT COUNT(*) FROM stock_values s WHERE s.field_id = f.id AND s.value IS NOT NULL) AS value_count
    FROM inventory_fields f
    LEFT JOIN inventory_tabs t ON t.id = f.tab_id
    LEFT JOIN stock_categories c ON c.id = f.category_id
    WHERE LOWER(TRIM(f.label)) IN (?)
    ORDER BY place, f.label
  `, [JUNK_NAMES]);
  return rows.map((r) => ({ ...r, value_count: Number(r.value_count) }));
}

// A field name that looks like a value: an email address or a web address.
const looksLikeValue = (name) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(name).trim())
  || /^(https?:\/\/|www\.)\S+$/i.test(String(name).trim())
  || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(String(name).trim());

module.exports = { JUNK_NAMES, deleteField, findJunkFields, looksLikeValue };
