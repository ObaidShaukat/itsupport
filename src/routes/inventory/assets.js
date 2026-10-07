// Inventory > Assets: one record per physical item, with assignment history.
const express = require('express');
const { pool, transaction } = require('../../db');
const { str, requireId, toId, flash, notFound, safePath } = require('../../lib/http');
const { londonDate } = require('../../lib/activity');
const inv = require('../../lib/inventory');
const cf = require('../../lib/custom-fields');
const { assignAsset } = require('../../lib/inventory-actions');

const router = express.Router();

function readAsset(body) {
  return {
    category_id: toId(body.category_id),
    brand: str(body.brand, 100),
    model: str(body.model, 255),
    serial_number: str(body.serial_number, 150),
    device_name: str(body.device_name, 150),
    wifi_mac: str(body.wifi_mac, 50),
    ethernet_mac: str(body.ethernet_mac, 50),
    specifications: str(body.specifications, 5000),
    purchase_date: inv.dateOrNull(str(body.purchase_date, 10)),
    location: str(body.location, 150),
    status: Object.hasOwn(inv.ASSET_STATUSES, body.status) ? body.status : 'spare',
    sold_to: str(body.sold_to, 150),
    sold_date: inv.dateOrNull(str(body.sold_date, 10)),
    notes: str(body.notes, 5000),
  };
}

const ASSET_COLUMNS = ['category_id', 'brand', 'model', 'serial_number', 'device_name', 'wifi_mac', 'ethernet_mac',
  'specifications', 'purchase_date', 'location', 'status', 'sold_to', 'sold_date', 'notes'];
const assetValues = (a) => ASSET_COLUMNS.map((k) => (a[k] === '' ? null : a[k]));

// Fields that apply to the chosen category (fields without a category apply to all).
const fieldsForCategory = (fields, categoryId) => fields.filter((f) => !f.category_id || f.category_id === categoryId);

// ---- List ----

router.get('/assets', async (req, res) => {
  const fields = await cf.fieldsFor('asset');
  const filter = cf.filterCondition('asset', 'a', fields, req.query);
  const categoryId = toId(req.query.category);
  const status = Object.hasOwn(inv.ASSET_STATUSES, req.query.status) ? req.query.status : '';
  const personId = toId(req.query.person);
  const where = [...filter.where];
  const params = [...filter.params];
  if (categoryId) { where.push('a.category_id = ?'); params.push(categoryId); }
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (personId) { where.push('a.person_id = ?'); params.push(personId); }
  const [assets] = await pool.query(`
    SELECT a.*, c.name AS category_name, p.name AS person_name
    FROM inv_assets a
    LEFT JOIN inv_categories c ON c.id = a.category_id
    LEFT JOIN inv_people p ON p.id = a.person_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.asset_tag
  `, params);
  const [people] = await pool.query("SELECT id, name FROM inv_people WHERE status = 'active' ORDER BY name");
  res.render('inventory/assets/index', {
    title: 'Assets',
    assets,
    fields,
    listFields: fields.filter((f) => f.show_in_list),
    filterFields: cf.filterableFields(fields),
    activeFilters: filter.active,
    values: await cf.valuesFor('asset', assets.map((a) => a.id)),
    lists: await inv.loadLists(),
    people,
    categoryId,
    status,
    personId,
  });
});

// ---- Create / edit ----

async function renderForm(res, statusCode, asset, error) {
  const lists = await inv.loadLists();
  res.status(statusCode).render('inventory/assets/form', {
    title: asset.id ? `Edit ${asset.asset_tag}` : 'New asset',
    asset,
    lists,
    assetCategories: lists.categories.filter((c) => c.kind === 'asset' || c.id === asset.category_id),
    fields: await cf.fieldsFor('asset'),
    values: asset.cf || {},
    error,
  });
}

const blankAsset = () => ({ status: 'spare', cf: {} });

router.get('/assets/new', (req, res) => renderForm(res, 200, { ...blankAsset(), category_id: toId(req.query.category) }, null));

router.post('/assets', async (req, res) => {
  const asset = readAsset(req.body);
  const fields = fieldsForCategory(await cf.fieldsFor('asset'), asset.category_id);
  const { values, errors } = cf.readValues(fields, req.body);
  if (!asset.model && !asset.serial_number) errors.unshift('Enter at least a model or a serial number.');
  if (asset.status === 'in_use') errors.unshift('New assets start unassigned. Save it, then use Assign to give it to someone.');
  if (asset.serial_number) {
    const [[dupe]] = await pool.query('SELECT asset_tag FROM inv_assets WHERE serial_number = ?', [asset.serial_number]);
    if (dupe) errors.unshift(`Serial ${asset.serial_number} is already recorded as ${dupe.asset_tag}.`);
  }
  if (errors.length) return renderForm(res, 400, { ...asset, cf: values }, errors.join(' '));

  const id = await transaction(async (conn) => {
    const tag = await inv.nextAssetTag(conn);
    const [r] = await conn.query(`
      INSERT INTO inv_assets (asset_tag, ${ASSET_COLUMNS.join(', ')}, created_by, updated_by)
      VALUES (?, ${ASSET_COLUMNS.map(() => '?').join(', ')}, ?, ?)
    `, [tag, ...assetValues(asset), req.user.id, req.user.id]);
    await cf.saveValues(conn, 'asset', r.insertId, fields, values);
    const saved = await inv.assetById(r.insertId, conn);
    await inv.logInv(conn, req.user, { type: 'inv_asset', id: r.insertId, action: 'created', subject: inv.assetLabel(saved),
      summary: `Added asset ${inv.assetLabel(saved)}${asset.serial_number ? `, serial ${asset.serial_number}` : ''}.` });
    return r.insertId;
  });
  flash(req, 'success', 'Asset added.');
  res.redirect(`/inventory/assets/${id}`);
});

router.get('/assets/:id/edit', async (req, res) => {
  const asset = await inv.assetById(requireId(req.params.id));
  if (!asset) throw notFound();
  const values = (await cf.valuesFor('asset', [asset.id])).get(asset.id) || {};
  await renderForm(res, 200, { ...asset, cf: values }, null);
});

router.post('/assets/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const before = await inv.assetById(id);
  if (!before) throw notFound();
  const asset = { ...readAsset(req.body), id, asset_tag: before.asset_tag, person_id: before.person_id };
  const fields = fieldsForCategory(await cf.fieldsFor('asset'), asset.category_id);
  const { values, errors } = cf.readValues(fields, req.body);
  if (!asset.model && !asset.serial_number) errors.unshift('Enter at least a model or a serial number.');
  if (asset.status === 'in_use' && !before.person_id) errors.unshift('Use Assign to put an asset in use.');
  if (asset.serial_number) {
    const [[dupe]] = await pool.query('SELECT asset_tag FROM inv_assets WHERE serial_number = ? AND id <> ?', [asset.serial_number, id]);
    if (dupe) errors.unshift(`Serial ${asset.serial_number} is already recorded as ${dupe.asset_tag}.`);
  }
  if (errors.length) return renderForm(res, 400, { ...asset, cf: values }, errors.join(' '));

  await transaction(async (conn) => {
    // Leaving "In use" (sold, spare, repair...) ends the current assignment.
    let unassigned = null;
    if (before.person_id && asset.status !== 'in_use') {
      unassigned = before.person_name;
      await conn.query('UPDATE inv_asset_assignments SET assigned_until = ? WHERE asset_id = ? AND assigned_until IS NULL', [londonDate(), id]);
    }
    await conn.query(`
      UPDATE inv_assets SET ${ASSET_COLUMNS.map((k) => `${k} = ?`).join(', ')}, person_id = ?, updated_by = ? WHERE id = ?
    `, [...assetValues(asset), unassigned ? null : before.person_id, req.user.id, id]);
    const changedCf = await cf.saveValues(conn, 'asset', id, fields, values);
    const saved = await inv.assetById(id, conn);
    let summary = `Updated asset ${inv.assetLabel(saved)}.`;
    if (asset.status !== before.status) summary = `Changed ${inv.assetLabel(saved)} from ${inv.ASSET_STATUSES[before.status]} to ${inv.ASSET_STATUSES[asset.status]}${asset.status === 'sold' && asset.sold_to ? ` (sold to ${asset.sold_to})` : ''}${unassigned ? `, unassigned from ${unassigned}` : ''}.`;
    await inv.logInv(conn, req.user, { type: 'inv_asset', id, action: asset.status !== before.status ? 'status_changed' : 'updated',
      subject: inv.assetLabel(saved), summary, personId: before.person_id, changes: changedCf });
  });
  flash(req, 'success', 'Asset saved.');
  res.redirect(`/inventory/assets/${id}`);
});

// ---- Detail ----

router.get('/assets/:id', async (req, res) => {
  const asset = await inv.assetById(requireId(req.params.id));
  if (!asset) throw notFound();
  const [history] = await pool.query(`
    SELECT h.*, COALESCE(NULLIF(u.display_name, ''), u.username) AS created_by_name FROM inv_asset_assignments h LEFT JOIN users u ON u.id = h.created_by
    WHERE h.asset_id = ? ORDER BY COALESCE(h.assigned_until, '9999-12-31') DESC, h.id DESC
  `, [asset.id]);
  const [log] = await pool.query(`
    SELECT l.action, l.summary, l.created_at, COALESCE(NULLIF(u.display_name, ''), u.username) AS username FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.entity_type = 'inv_asset' AND l.entity_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT 100
  `, [asset.id]);
  const [people] = await pool.query("SELECT id, name FROM inv_people WHERE status = 'active' ORDER BY name");
  const fields = fieldsForCategory(await cf.fieldsFor('asset'), asset.category_id);
  res.render('inventory/assets/show', {
    title: asset.asset_tag,
    asset,
    history,
    log,
    people,
    fields,
    values: (await cf.valuesFor('asset', [asset.id])).get(asset.id) || {},
    today: londonDate(),
  });
});

// ---- Assign / unassign / reassign ----

router.post('/assets/:id/assign', async (req, res) => {
  const id = requireId(req.params.id);
  const personId = toId(req.body.person_id);
  const date = inv.dateOrNull(str(req.body.date, 10)) || londonDate();
  const back = safePath(req.body.back, `/inventory/assets/${id}`);
  if (!personId) {
    flash(req, 'error', 'Choose who to assign it to.');
    return res.redirect(back);
  }
  try {
    const result = await assignAsset(req.user, id, personId, date);
    flash(req, 'success', result === 'unchanged' ? 'Already assigned to that person.' : 'Asset assigned.');
  } catch (err) {
    if (err.status !== 400) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(back);
});

router.post('/assets/:id/unassign', async (req, res) => {
  const id = requireId(req.params.id);
  const date = inv.dateOrNull(str(req.body.date, 10)) || londonDate();
  const status = ['spare', 'repair', 'damaged'].includes(req.body.status) ? req.body.status : 'spare';
  const back = safePath(req.body.back, `/inventory/assets/${id}`);
  await transaction(async (conn) => {
    const full = await inv.assetById(id, conn);
    if (!full) throw notFound();
    if (!full.person_id) return;
    await conn.query('UPDATE inv_assets SET person_id = NULL, status = ?, updated_by = ? WHERE id = ?', [status, req.user.id, id]);
    await conn.query('UPDATE inv_asset_assignments SET assigned_until = ? WHERE asset_id = ? AND assigned_until IS NULL', [date, id]);
    await inv.logInv(conn, req.user, { type: 'inv_asset', id, action: 'updated', subject: inv.assetLabel(full), personId: full.person_id,
      summary: `Unassigned ${inv.assetLabel(full)} from ${full.person_name}; now ${inv.ASSET_STATUSES[status]}.` });
  });
  flash(req, 'success', 'Asset unassigned.');
  res.redirect(back);
});

router.post('/assets/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const full = await inv.assetById(id);
  if (!full) throw notFound();
  await inv.logInv(null, req.user, { type: 'inv_asset', id, action: 'deleted', subject: inv.assetLabel(full), personId: full.person_id,
    summary: `Deleted asset ${inv.assetLabel(full)}${full.serial_number ? `, serial ${full.serial_number}` : ''}.` });
  await pool.query("DELETE FROM custom_field_values WHERE entity_type = 'asset' AND entity_id = ?", [id]);
  await pool.query('DELETE FROM inv_assets WHERE id = ?', [id]);
  flash(req, 'success', `${full.asset_tag} deleted.`);
  res.redirect('/inventory/assets');
});

module.exports = router;
