// Inventory > Lists & fields: editable lists (categories, companies, teams, apps) and
// custom fields (add, edit, reorder, hide, delete).
const express = require('express');
const { pool, transaction } = require('../../db');
const { str, requireId, toId, flash, notFound, HttpError } = require('../../lib/http');
const inv = require('../../lib/inventory');
const cf = require('../../lib/custom-fields');

const router = express.Router();

const LISTS = {
  categories: { table: 'inv_categories', label: 'category', title: 'Categories' },
  companies: { table: 'inv_companies', label: 'company', title: 'Companies' },
  teams: { table: 'inv_teams', label: 'team', title: 'Teams' },
  apps: { table: 'inv_apps', label: 'account / app', title: 'Accounts & apps' },
};
const listSpec = (key) => {
  if (!Object.hasOwn(LISTS, key)) throw notFound();
  return LISTS[key];
};
const logSetting = (req, id, action, subject, summary) => inv.logInv(null, req.user, { type: 'inv_setting', id, action, subject, summary });

router.get('/settings', async (req, res) => {
  const lists = await inv.loadLists();
  const [usage] = await pool.query(`
    SELECT 'categories' AS list, category_id AS id, COUNT(*) AS n FROM inv_assets WHERE category_id IS NOT NULL GROUP BY category_id
    UNION ALL SELECT 'categories', category_id, COUNT(*) FROM inv_stock WHERE category_id IS NOT NULL GROUP BY category_id
    UNION ALL SELECT 'companies', company_id, COUNT(*) FROM inv_people WHERE company_id IS NOT NULL GROUP BY company_id
    UNION ALL SELECT 'teams', team_id, COUNT(*) FROM inv_people WHERE team_id IS NOT NULL GROUP BY team_id
    UNION ALL SELECT 'apps', app_id, COUNT(*) FROM inv_access WHERE app_id IS NOT NULL GROUP BY app_id
  `);
  const used = {};
  for (const u of usage) used[`${u.list}:${u.id}`] = (used[`${u.list}:${u.id}`] || 0) + Number(u.n);
  const [fieldCounts] = await pool.query('SELECT entity_type, COUNT(*) AS n, SUM(hidden) AS hidden FROM custom_fields GROUP BY entity_type');
  res.render('inventory/settings/index', {
    title: 'Inventory lists & fields', lists, LISTS, used,
    fieldCounts: Object.fromEntries(fieldCounts.map((r) => [r.entity_type, { n: Number(r.n), hidden: Number(r.hidden) }])),
  });
});

// ---- Editable lists ----

router.post('/settings/lists/:list', async (req, res) => {
  const spec = listSpec(req.params.list);
  const name = str(req.body.name, 100);
  if (!name) {
    flash(req, 'error', 'Enter a name.');
    return res.redirect(`/inventory/settings#${req.params.list}`);
  }
  try {
    const kind = req.body.kind === 'stock' ? 'stock' : 'asset';
    const [r] = spec.table === 'inv_categories'
      ? await pool.query('INSERT INTO inv_categories (name, kind) VALUES (?, ?)', [name, kind])
      : await pool.query(`INSERT INTO ${spec.table} (name) VALUES (?)`, [name]);
    await logSetting(req, r.insertId, 'created', name, `Added ${spec.label} ${name}.`);
    flash(req, 'success', `${name} added.`);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    flash(req, 'error', `${name} is already in the list.`);
  }
  res.redirect(`/inventory/settings#${req.params.list}`);
});

router.post('/settings/lists/:list/:id', async (req, res) => {
  const spec = listSpec(req.params.list);
  const id = requireId(req.params.id);
  const name = str(req.body.name, 100);
  const [[before]] = await pool.query(`SELECT * FROM ${spec.table} WHERE id = ?`, [id]);
  if (!before) throw notFound();
  if (!name) {
    flash(req, 'error', 'Enter a name.');
    return res.redirect(`/inventory/settings#${req.params.list}`);
  }
  try {
    if (spec.table === 'inv_categories') {
      const kind = req.body.kind === 'stock' ? 'stock' : 'asset';
      await pool.query('UPDATE inv_categories SET name = ?, kind = ? WHERE id = ?', [name, kind, id]);
      await logSetting(req, id, 'updated', name, `Updated category ${before.name}${before.name !== name ? ` → ${name}` : ''} (${kind === 'stock' ? 'stock' : 'asset'}).`);
    } else {
      await pool.query(`UPDATE ${spec.table} SET name = ? WHERE id = ?`, [name, id]);
      await logSetting(req, id, 'updated', name, `Renamed ${spec.label} ${before.name} to ${name}.`);
    }
    flash(req, 'success', 'Saved.');
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    flash(req, 'error', `${name} is already in the list.`);
  }
  res.redirect(`/inventory/settings#${req.params.list}`);
});

router.post('/settings/lists/:list/:id/delete', async (req, res) => {
  const spec = listSpec(req.params.list);
  const id = requireId(req.params.id);
  const [[row]] = await pool.query(`SELECT name FROM ${spec.table} WHERE id = ?`, [id]);
  if (!row) throw notFound();
  await pool.query(`DELETE FROM ${spec.table} WHERE id = ?`, [id]);
  await logSetting(req, id, 'deleted', row.name, `Deleted ${spec.label} ${row.name}.`);
  flash(req, 'success', `${row.name} deleted.`);
  res.redirect(`/inventory/settings#${req.params.list}`);
});

// ---- Custom fields ----

function readField(body) {
  return {
    label: str(body.label, 100),
    entity_type: Object.hasOwn(cf.CF_ENTITIES, body.entity_type) ? body.entity_type : null,
    field_type: Object.hasOwn(cf.CF_TYPES, body.field_type) ? body.field_type : 'text',
    options: str(body.options, 5000).split(/\r?\n/).map((o) => o.trim()).filter(Boolean).join('\n') || null,
    required: body.required === '1' ? 1 : 0,
    show_in_list: body.show_in_list === '1' ? 1 : 0,
    category_id: toId(body.category_id),
  };
}

function fieldErrors(f) {
  const errors = [];
  if (!f.label) errors.push('Enter a label.');
  if (inv.CREDENTIAL_LABEL.test(f.label)) {
    errors.push('Passwords, PINs and other credentials must never be stored here. Keep them in 1Password and tick "Credentials stored in 1Password" instead.');
  }
  if (!f.entity_type) errors.push('Choose what the field applies to.');
  if (f.field_type === 'select' && !f.options) errors.push('Add at least one option for the dropdown (one per line).');
  return errors;
}

router.get('/settings/fields', async (req, res) => {
  const entity = Object.hasOwn(cf.CF_ENTITIES, req.query.entity) ? req.query.entity : 'person';
  const fields = await cf.fieldsFor(entity, { includeHidden: true });
  const [counts] = await pool.query(
    'SELECT field_id, COUNT(*) AS n FROM custom_field_values WHERE entity_type = ? AND value IS NOT NULL AND value <> \'\' GROUP BY field_id',
    [entity]
  );
  const used = Object.fromEntries(counts.map((c) => [c.field_id, Number(c.n)]));
  res.render('inventory/settings/fields', {
    title: 'Custom fields', entity, fields, used, lists: await inv.loadLists(), CF_ENTITIES: cf.CF_ENTITIES, CF_TYPES: cf.CF_TYPES, edit: null,
  });
});

router.post('/settings/fields', async (req, res) => {
  const f = readField(req.body);
  const errors = fieldErrors(f);
  if (errors.length) {
    flash(req, 'error', errors.join(' '));
    return res.redirect(`/inventory/settings/fields?entity=${f.entity_type || 'person'}`);
  }
  const [[{ next }]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM custom_fields WHERE entity_type = ?', [f.entity_type]);
  const [r] = await pool.query(`
    INSERT INTO custom_fields (label, entity_type, field_type, options, required, show_in_list, category_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [f.label, f.entity_type, f.field_type, f.options, f.required, f.show_in_list,
    ['asset', 'stock'].includes(f.entity_type) ? f.category_id : null, Number(next)]);
  await logSetting(req, r.insertId, 'created', f.label, `Added custom field "${f.label}" (${cf.CF_TYPES[f.field_type]}) to ${cf.CF_ENTITIES[f.entity_type]}.`);
  flash(req, 'success', `Field "${f.label}" added.`);
  res.redirect(`/inventory/settings/fields?entity=${f.entity_type}`);
});

// Drag-and-drop order within one entity type: order=<ids, comma-separated>.
router.post('/settings/fields/order', async (req, res) => {
  const entity = Object.hasOwn(cf.CF_ENTITIES, req.body.entity) ? req.body.entity : null;
  const order = str(req.body.order, 5000).split(',').map(toId);
  if (!entity) throw new HttpError(400, 'Unknown field group.');
  await transaction(async (conn) => {
    const [rows] = await conn.query('SELECT id FROM custom_fields WHERE entity_type = ? FOR UPDATE', [entity]);
    const ids = new Set(rows.map((r) => r.id));
    if (order.length !== rows.length || !order.every((id) => ids.has(id))) {
      throw new HttpError(409, 'The fields changed since this page loaded. Refresh and try again.');
    }
    for (let i = 0; i < order.length; i++) await conn.query('UPDATE custom_fields SET sort_order = ? WHERE id = ?', [i + 1, order[i]]);
  });
  await logSetting(req, null, 'updated', cf.CF_ENTITIES[entity], `Reordered the custom fields for ${cf.CF_ENTITIES[entity]}.`);
  res.json({ ok: true });
});

router.get('/settings/fields/:id/edit', async (req, res) => {
  const id = requireId(req.params.id);
  const [[field]] = await pool.query('SELECT * FROM custom_fields WHERE id = ?', [id]);
  if (!field) throw notFound();
  const fields = await cf.fieldsFor(field.entity_type, { includeHidden: true });
  res.render('inventory/settings/fields', {
    title: `Edit field ${field.label}`, entity: field.entity_type, fields, used: {}, lists: await inv.loadLists(),
    CF_ENTITIES: cf.CF_ENTITIES, CF_TYPES: cf.CF_TYPES, edit: field,
  });
});

router.post('/settings/fields/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[before]] = await pool.query('SELECT * FROM custom_fields WHERE id = ?', [id]);
  if (!before) throw notFound();
  const f = { ...readField(req.body), entity_type: before.entity_type };
  const errors = fieldErrors(f);
  if (errors.length) {
    flash(req, 'error', errors.join(' '));
    return res.redirect(`/inventory/settings/fields/${id}/edit`);
  }
  await pool.query(`
    UPDATE custom_fields SET label = ?, field_type = ?, options = ?, required = ?, show_in_list = ?, category_id = ? WHERE id = ?
  `, [f.label, f.field_type, f.options, f.required, f.show_in_list, ['asset', 'stock'].includes(f.entity_type) ? f.category_id : null, id]);
  await logSetting(req, id, 'updated', f.label, `Updated custom field "${before.label}"${before.label !== f.label ? ` → "${f.label}"` : ''} (${cf.CF_ENTITIES[f.entity_type]}).`);
  flash(req, 'success', 'Field saved.');
  res.redirect(`/inventory/settings/fields?entity=${f.entity_type}`);
});

// Hide keeps the data but stops showing the field; showing it again brings it back.
router.post('/settings/fields/:id/hide', async (req, res) => {
  const id = requireId(req.params.id);
  const [[field]] = await pool.query('SELECT * FROM custom_fields WHERE id = ?', [id]);
  if (!field) throw notFound();
  const hidden = field.hidden ? 0 : 1;
  await pool.query('UPDATE custom_fields SET hidden = ? WHERE id = ?', [hidden, id]);
  await logSetting(req, id, 'updated', field.label, `${hidden ? 'Hid' : 'Showed'} custom field "${field.label}" (${cf.CF_ENTITIES[field.entity_type]}).`);
  flash(req, 'success', hidden ? `"${field.label}" is hidden. Its data is kept.` : `"${field.label}" is visible again.`);
  res.redirect(`/inventory/settings/fields?entity=${field.entity_type}`);
});

// Delete: confirmation page first, showing how many records have a value.
router.get('/settings/fields/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[field]] = await pool.query('SELECT * FROM custom_fields WHERE id = ?', [id]);
  if (!field) throw notFound();
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM custom_field_values WHERE field_id = ? AND value IS NOT NULL AND value <> ''", [id]);
  res.render('inventory/settings/field-delete', { title: `Delete ${field.label}`, field, count: Number(n), CF_ENTITIES: cf.CF_ENTITIES });
});

router.post('/settings/fields/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[field]] = await pool.query('SELECT * FROM custom_fields WHERE id = ?', [id]);
  if (!field) throw notFound();
  if (req.body.confirm !== field.label) {
    flash(req, 'error', 'Type the field label exactly to confirm deletion.');
    return res.redirect(`/inventory/settings/fields/${id}/delete`);
  }
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM custom_field_values WHERE field_id = ?', [id]);
  await pool.query('DELETE FROM custom_fields WHERE id = ?', [id]);
  await logSetting(req, id, 'deleted', field.label, `Deleted custom field "${field.label}" (${cf.CF_ENTITIES[field.entity_type]}) and its ${n} value${Number(n) === 1 ? '' : 's'}.`);
  flash(req, 'success', `"${field.label}" and its values were deleted.`);
  res.redirect(`/inventory/settings/fields?entity=${field.entity_type}`);
});

module.exports = router;
