// Inventory > People and Former Employees, with offboarding when someone leaves.
const express = require('express');
const { pool, transaction } = require('../../db');
const { str, requireId, toId, flash, notFound, safePath } = require('../../lib/http');
const { londonDate } = require('../../lib/activity');
const inv = require('../../lib/inventory');
const cf = require('../../lib/custom-fields');
const { assignAsset, giveStock } = require('../../lib/inventory-actions');

const router = express.Router();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Finds a list entry (company/team) by name, creating it when typed new.
async function listId(conn, table, name, user) {
  if (!name) return null;
  if (!['inv_companies', 'inv_teams'].includes(table)) throw new Error('Bad list');
  const [[row]] = await conn.query(`SELECT id FROM ${table} WHERE name = ?`, [name]);
  if (row) return row.id;
  const [r] = await conn.query(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
  await inv.logInv(conn, user, { type: 'inv_setting', id: r.insertId, action: 'created', subject: name,
    summary: `Added ${table === 'inv_companies' ? 'company' : 'team'} ${name}.` });
  return r.insertId;
}

function readPerson(body) {
  return {
    name: str(body.name, 150),
    email: str(body.email, 254),
    company: str(body.company, 100),
    team: str(body.team, 100),
    role: str(body.role, 150),
    phone: str(body.phone, 50),
    start_date: inv.dateOrNull(str(body.start_date, 10)),
    notes: str(body.notes, 5000),
  };
}

// ---- Lists ----

async function peopleList(req, res, status) {
  const fields = await cf.fieldsFor('person');
  const filter = cf.filterCondition('person', 'p', fields, req.query);
  const companyId = toId(req.query.company);
  const teamId = toId(req.query.team);
  const where = ['p.status = ?', ...filter.where];
  const params = [status, ...filter.params];
  if (companyId) { where.push('p.company_id = ?'); params.push(companyId); }
  if (teamId) { where.push('p.team_id = ?'); params.push(teamId); }
  const [people] = await pool.query(`
    SELECT p.*, co.name AS company_name, t.name AS team_name,
      (SELECT COUNT(*) FROM inv_assets a WHERE a.person_id = p.id) AS asset_count,
      (SELECT COALESCE(SUM(sa.quantity), 0) FROM inv_stock_assignments sa WHERE sa.person_id = p.id AND sa.returned_at IS NULL) AS stock_count,
      (SELECT COUNT(*) FROM inv_access ac WHERE ac.person_id = p.id AND ac.status = 'active') AS access_count,
      (SELECT COUNT(*) FROM inv_offboarding_items o WHERE o.person_id = p.id AND o.done = 0) AS open_offboarding
    FROM inv_people p
    LEFT JOIN inv_companies co ON co.id = p.company_id
    LEFT JOIN inv_teams t ON t.id = p.team_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.name
  `, params);
  const values = await cf.valuesFor('person', people.map((p) => p.id));
  const lists = await inv.loadLists();
  res.render('inventory/people/index', {
    title: status === 'active' ? 'People' : 'Former Employees',
    former: status === 'left',
    people,
    fields,
    listFields: fields.filter((f) => f.show_in_list),
    filterFields: cf.filterableFields(fields),
    activeFilters: filter.active,
    values,
    lists,
    companyId,
    teamId,
  });
}

router.get('/people', (req, res) => peopleList(req, res, 'active'));
router.get('/former', (req, res) => peopleList(req, res, 'left'));

// ---- Create / edit ----

async function renderForm(res, status, person, error) {
  res.status(status).render('inventory/people/form', {
    title: person.id ? `Edit ${person.name}` : 'New person',
    person,
    lists: await inv.loadLists(),
    fields: await cf.fieldsFor('person'),
    values: person.cf || {},
    error,
  });
}

router.get('/people/new', (req, res) => renderForm(res, 200, { name: '', company: '', team: '', cf: {} }, null));

router.post('/people', async (req, res) => {
  const person = readPerson(req.body);
  const fields = await cf.fieldsFor('person');
  const { values, errors } = cf.readValues(fields, req.body);
  if (!person.name) errors.unshift('Name is required.');
  if (person.email && !EMAIL.test(person.email)) errors.unshift('Enter a valid email address.');
  if (errors.length) return renderForm(res, 400, { ...person, cf: values }, errors.join(' '));

  const id = await transaction(async (conn) => {
    const companyId = await listId(conn, 'inv_companies', person.company, req.user);
    const teamId = await listId(conn, 'inv_teams', person.team, req.user);
    const [r] = await conn.query(`
      INSERT INTO inv_people (name, email, company_id, team_id, role, phone, start_date, notes, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [person.name, person.email || null, companyId, teamId, person.role || null, person.phone || null,
      person.start_date, person.notes || null, req.user.id, req.user.id]);
    await cf.saveValues(conn, 'person', r.insertId, fields, values);
    await inv.logInv(conn, req.user, { type: 'inv_person', id: r.insertId, personId: r.insertId, action: 'created',
      subject: person.name, summary: `Added ${person.name}${person.team ? ` to ${person.team}` : ''}.` });
    return r.insertId;
  });
  flash(req, 'success', `${person.name} added.`);
  res.redirect(`/inventory/people/${id}`);
});

router.get('/people/:id/edit', async (req, res) => {
  const p = await inv.personById(requireId(req.params.id));
  if (!p) throw notFound();
  const values = (await cf.valuesFor('person', [p.id])).get(p.id) || {};
  await renderForm(res, 200, {
    ...p, company: p.company_name || '', team: p.team_name || '',
    start_date: p.start_date || '', email: p.email || '', role: p.role || '', phone: p.phone || '', notes: p.notes || '', cf: values,
  }, null);
});

router.post('/people/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const existing = await inv.personById(id);
  if (!existing) throw notFound();
  const person = { ...readPerson(req.body), id };
  const fields = await cf.fieldsFor('person');
  const { values, errors } = cf.readValues(fields, req.body);
  if (!person.name) errors.unshift('Name is required.');
  if (person.email && !EMAIL.test(person.email)) errors.unshift('Enter a valid email address.');
  if (errors.length) return renderForm(res, 400, { ...person, cf: values }, errors.join(' '));

  await transaction(async (conn) => {
    const companyId = await listId(conn, 'inv_companies', person.company, req.user);
    const teamId = await listId(conn, 'inv_teams', person.team, req.user);
    await conn.query(`
      UPDATE inv_people SET name = ?, email = ?, company_id = ?, team_id = ?, role = ?, phone = ?, start_date = ?, notes = ?, updated_by = ?
      WHERE id = ?
    `, [person.name, person.email || null, companyId, teamId, person.role || null, person.phone || null,
      person.start_date, person.notes || null, req.user.id, id]);
    const changedCf = await cf.saveValues(conn, 'person', id, fields, values);
    await inv.logInv(conn, req.user, { type: 'inv_person', id, personId: id, action: 'updated', subject: person.name,
      summary: `Updated ${person.name}'s details.`, changes: changedCf });
  });
  flash(req, 'success', 'Details saved.');
  res.redirect(`/inventory/people/${id}`);
});

// ---- Person page ----

router.get('/people/:id', async (req, res) => {
  const person = await inv.personById(requireId(req.params.id));
  if (!person) throw notFound();
  const held = await inv.holdings(person.id);
  const fields = await cf.fieldsFor('person');
  const values = (await cf.valuesFor('person', [person.id])).get(person.id) || {};
  const [offboarding] = await pool.query(
    "SELECT o.*, COALESCE(NULLIF(u.display_name, ''), u.username) AS done_by_name FROM inv_offboarding_items o LEFT JOIN users u ON u.id = o.done_by WHERE o.person_id = ? ORDER BY o.done, o.id",
    [person.id]
  );
  const [timeline] = await pool.query(`
    SELECT l.action, l.summary, l.created_at, COALESCE(NULLIF(u.display_name, ''), u.username) AS username
    FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.related_person_id = ? OR (l.entity_type = 'inv_person' AND l.entity_id = ?)
    ORDER BY l.created_at DESC, l.id DESC LIMIT 200
  `, [person.id, person.id]);
  const [assetHistory] = await pool.query(`
    SELECT h.*, a.asset_tag, a.brand, a.model, c.name AS category_name
    FROM inv_asset_assignments h JOIN inv_assets a ON a.id = h.asset_id LEFT JOIN inv_categories c ON c.id = a.category_id
    WHERE h.person_id = ? ORDER BY COALESCE(h.assigned_until, '9999-12-31') DESC, h.id DESC
  `, [person.id]);
  // Things that can be given to this person.
  const [spareAssets] = await pool.query(`
    SELECT a.id, a.asset_tag, a.brand, a.model, a.serial_number, c.name AS category_name FROM inv_assets a
    LEFT JOIN inv_categories c ON c.id = a.category_id
    WHERE a.person_id IS NULL AND a.status = 'spare' ORDER BY c.name, a.model, a.asset_tag
  `);
  const [stockRows] = await pool.query(`${inv.STOCK_SELECT} ORDER BY c.name, s.model`);
  const stock = stockRows.map(inv.withAvailability).filter((s) => s.available_qty > 0);
  const lists = await inv.loadLists();
  const accessFields = await cf.fieldsFor('access');

  res.render('inventory/people/show', {
    title: person.name, person, held, fields, values, offboarding, timeline, assetHistory, spareAssets, stock, lists, accessFields,
    today: londonDate(),
  });
});

// ---- Assign from the person page ----

router.post('/people/:id/assign-asset', async (req, res) => {
  const id = requireId(req.params.id);
  const assetId = toId(req.body.asset);
  try {
    if (!assetId) throw Object.assign(new Error('Choose an asset.'), { status: 400 });
    await assignAsset(req.user, assetId, id);
    flash(req, 'success', 'Asset assigned.');
  } catch (err) {
    if (err.status !== 400) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(`/inventory/people/${id}#assets`);
});

router.post('/people/:id/give-stock', async (req, res) => {
  const id = requireId(req.params.id);
  const stockId = toId(req.body.stock);
  const quantity = Number.parseInt(String(req.body.quantity || '1'), 10);
  try {
    if (!stockId) throw Object.assign(new Error('Choose a stock item.'), { status: 400 });
    await giveStock(req.user, stockId, id, quantity);
    flash(req, 'success', 'Stock given.');
  } catch (err) {
    if (err.status !== 400) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(`/inventory/people/${id}#stock`);
});

// ---- Leaving (offboarding) ----

// Marks the person as Left and builds a checklist from everything they hold.
router.post('/people/:id/leave', async (req, res) => {
  const id = requireId(req.params.id);
  const leavingDate = inv.dateOrNull(str(req.body.leaving_date, 10));
  if (!leavingDate) {
    flash(req, 'error', 'Enter the leaving date.');
    return res.redirect(`/inventory/people/${id}#leave`);
  }
  const count = await transaction(async (conn) => {
    const person = await inv.personById(id, conn);
    if (!person) throw notFound();
    if (person.status === 'left') return -1;
    await conn.query("UPDATE inv_people SET status = 'left', leaving_date = ?, updated_by = ? WHERE id = ?", [leavingDate, req.user.id, id]);
    const held = await inv.holdings(id, conn);
    const items = [
      ...held.assets.map((a) => ['asset', a.id, `Return ${inv.assetLabel(a)}${a.serial_number ? `, serial ${a.serial_number}` : ''}`]),
      ...held.stock.map((s) => ['stock', s.id, `Return ${s.quantity} × ${inv.stockLabel(s)}`]),
      ...held.access.filter((a) => a.status === 'active').map((a) => ['access', a.id, `Revoke ${a.app_name || 'account'}${a.username ? ` (${a.username})` : ''}`]),
    ];
    if (items.length) {
      await conn.query('INSERT INTO inv_offboarding_items (person_id, item_type, item_id, label) VALUES ?',
        [items.map(([type, itemId, label]) => [id, type, itemId, label.slice(0, 255)])]);
    }
    await inv.logInv(conn, req.user, { type: 'inv_person', id, personId: id, action: 'status_changed', subject: person.name,
      summary: `Offboarded ${person.name} (leaving date ${leavingDate}, ${items.length} item${items.length === 1 ? '' : 's'} to return or revoke).` });
    return items.length;
  });
  if (count < 0) flash(req, 'info', 'This person has already left.');
  else flash(req, 'success', count ? `Marked as left. ${count} item${count === 1 ? '' : 's'} on the offboarding checklist.` : 'Marked as left. They held nothing to return.');
  res.redirect(`/inventory/people/${id}#offboarding`);
});

// Ticks an offboarding item and applies it: asset -> Spare, stock -> returned, account -> Removed.
router.post('/offboarding/:itemId/done', async (req, res) => {
  const itemId = requireId(req.params.itemId);
  const personId = await transaction(async (conn) => {
    const [[item]] = await conn.query('SELECT * FROM inv_offboarding_items WHERE id = ? FOR UPDATE', [itemId]);
    if (!item) throw notFound();
    if (item.done) return item.person_id;
    const person = await inv.personById(item.person_id, conn);
    const today = londonDate();
    let summary = `${item.label} (${person.name}).`;
    if (item.item_type === 'asset') {
      const [[asset]] = await conn.query('SELECT * FROM inv_assets WHERE id = ? FOR UPDATE', [item.item_id]);
      if (asset && asset.person_id === item.person_id) {
        await conn.query("UPDATE inv_assets SET person_id = NULL, status = 'spare', updated_by = ? WHERE id = ?", [req.user.id, asset.id]);
        await conn.query('UPDATE inv_asset_assignments SET assigned_until = ? WHERE asset_id = ? AND assigned_until IS NULL', [today, asset.id]);
        summary = `Returned ${inv.assetLabel(asset)} from ${person.name}; now Spare.`;
      }
    } else if (item.item_type === 'stock') {
      await conn.query('UPDATE inv_stock_assignments SET returned_at = ? WHERE id = ? AND returned_at IS NULL', [today, item.item_id]);
      summary = `${item.label.replace(/^Return/, 'Returned')} from ${person.name}.`;
    } else if (item.item_type === 'access') {
      await conn.query("UPDATE inv_access SET status = 'removed', removed_date = ?, updated_by = ? WHERE id = ? AND status = 'active'", [today, req.user.id, item.item_id]);
      summary = `${item.label.replace(/^Revoke/, 'Revoked')} for ${person.name}.`;
    }
    await conn.query('UPDATE inv_offboarding_items SET done = 1, done_by = ?, done_at = NOW() WHERE id = ?', [req.user.id, itemId]);
    await inv.logInv(conn, req.user, { type: 'inv_person', id: item.person_id, personId: item.person_id, action: 'updated',
      subject: person.name, summary });
    return item.person_id;
  });
  res.redirect(safePath(req.body.back, `/inventory/people/${personId}#offboarding`));
});

router.post('/people/:id/reactivate', async (req, res) => {
  const id = requireId(req.params.id);
  const person = await inv.personById(id);
  if (!person) throw notFound();
  await pool.query("UPDATE inv_people SET status = 'active', leaving_date = NULL, updated_by = ? WHERE id = ?", [req.user.id, id]);
  await inv.logInv(null, req.user, { type: 'inv_person', id, personId: id, action: 'reopened', subject: person.name,
    summary: `Reactivated ${person.name}.` });
  flash(req, 'success', `${person.name} is active again.`);
  res.redirect(`/inventory/people/${id}`);
});

module.exports = router;
