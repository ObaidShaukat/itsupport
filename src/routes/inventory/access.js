// Inventory > Access: which accounts each person has, plus shared / service accounts.
// SECURITY: records that an account exists only. There is no field for passwords, PINs
// or keys; credentials live in 1Password (flag + optional 1Password item link).
const express = require('express');
const { pool, transaction } = require('../../db');
const { str, requireId, toId, flash, notFound, safePath } = require('../../lib/http');
const { londonDate } = require('../../lib/activity');
const inv = require('../../lib/inventory');
const cf = require('../../lib/custom-fields');

const router = express.Router();

// 1Password item links: https://... or onepassword://...
const OP_LINK = /^(https:\/\/|onepassword:\/\/)\S+$/i;

async function appId(conn, name, user) {
  if (!name) return null;
  const [[row]] = await conn.query('SELECT id FROM inv_apps WHERE name = ?', [name]);
  if (row) return row.id;
  const [r] = await conn.query('INSERT INTO inv_apps (name) VALUES (?)', [name]);
  await inv.logInv(conn, user, { type: 'inv_setting', id: r.insertId, action: 'created', subject: name, summary: `Added app ${name}.` });
  return r.insertId;
}

function readAccess(body) {
  return {
    person_id: toId(body.person_id),
    app: str(body.app, 100),
    username: str(body.username, 254),
    granted_date: inv.dateOrNull(str(body.granted_date, 10)),
    granted_by: str(body.granted_by, 150),
    status: Object.hasOwn(inv.ACCESS_STATUSES, body.status) ? body.status : 'active',
    removed_date: inv.dateOrNull(str(body.removed_date, 10)),
    in_1password: body.in_1password === '1' ? 1 : 0,
    onepassword_link: str(body.onepassword_link, 500),
    notes: str(body.notes, 5000),
  };
}

function accessErrors(a) {
  const errors = [];
  if (!a.app) errors.push('Choose the account or app.');
  if (a.onepassword_link && !OP_LINK.test(a.onepassword_link)) errors.push('The 1Password link must start with https:// or onepassword://.');
  return errors;
}

// ---- All access ----

router.get('/access', async (req, res) => {
  const fields = await cf.fieldsFor('access');
  const filter = cf.filterCondition('access', 'ac', fields, req.query);
  const appFilter = toId(req.query.app);
  const personFilter = toId(req.query.person);
  const status = Object.hasOwn(inv.ACCESS_STATUSES, req.query.status) ? req.query.status : '';
  const where = [...filter.where];
  const params = [...filter.params];
  if (appFilter) { where.push('ac.app_id = ?'); params.push(appFilter); }
  if (personFilter) { where.push('ac.person_id = ?'); params.push(personFilter); }
  if (status) { where.push('ac.status = ?'); params.push(status); }
  const [access] = await pool.query(`
    SELECT ac.*, ap.name AS app_name, p.name AS person_name, p.status AS person_status
    FROM inv_access ac
    JOIN inv_people p ON p.id = ac.person_id
    LEFT JOIN inv_apps ap ON ap.id = ac.app_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ap.name, p.name
  `, params);
  const [shared] = await pool.query(`
    SELECT sh.*, ap.name AS app_name, p.name AS owner_name FROM inv_shared_accounts sh
    LEFT JOIN inv_apps ap ON ap.id = sh.app_id
    LEFT JOIN inv_people p ON p.id = sh.owner_person_id
    ORDER BY sh.status, sh.name
  `);
  const sharedFields = await cf.fieldsFor('shared');
  const [people] = await pool.query('SELECT id, name, status FROM inv_people ORDER BY status, name');
  res.render('inventory/access/index', {
    title: 'Access',
    access,
    shared,
    fields,
    listFields: fields.filter((f) => f.show_in_list),
    filterFields: cf.filterableFields(fields),
    activeFilters: filter.active,
    values: await cf.valuesFor('access', access.map((a) => a.id)),
    sharedFields,
    sharedListFields: sharedFields.filter((f) => f.show_in_list),
    sharedValues: await cf.valuesFor('shared', shared.map((s) => s.id)),
    lists: await inv.loadLists(),
    people,
    appFilter,
    personFilter,
    status,
  });
});

// ---- Shared / service accounts (before the /access/:id routes) ----

function readShared(body) {
  return {
    name: str(body.name, 150),
    app: str(body.app, 100),
    account: str(body.account, 254),
    purpose: str(body.purpose, 255),
    owner_person_id: toId(body.owner_person_id),
    status: Object.hasOwn(inv.ACCESS_STATUSES, body.status) ? body.status : 'active',
    in_1password: body.in_1password === '1' ? 1 : 0,
    onepassword_link: str(body.onepassword_link, 500),
    notes: str(body.notes, 5000),
  };
}

async function renderShared(res, statusCode, item, error) {
  const [people] = await pool.query('SELECT id, name FROM inv_people ORDER BY name');
  res.status(statusCode).render('inventory/access/shared-form', {
    title: item.id ? `Edit ${item.name}` : 'New shared account',
    item, people, lists: await inv.loadLists(), fields: await cf.fieldsFor('shared'), values: item.cf || {}, error,
  });
}

router.get('/access/shared/new', (req, res) => renderShared(res, 200, { status: 'active', cf: {} }, null));

router.get('/access/shared/:id/edit', async (req, res) => {
  const id = requireId(req.params.id);
  const [[item]] = await pool.query('SELECT sh.*, ap.name AS app FROM inv_shared_accounts sh LEFT JOIN inv_apps ap ON ap.id = sh.app_id WHERE sh.id = ?', [id]);
  if (!item) throw notFound();
  await renderShared(res, 200, { ...item, cf: (await cf.valuesFor('shared', [id])).get(id) || {} }, null);
});

async function saveShared(req, res, id) {
  const item = { ...readShared(req.body), id };
  const fields = await cf.fieldsFor('shared');
  const { values, errors } = cf.readValues(fields, req.body);
  if (!item.name) errors.unshift('Name is required.');
  if (item.onepassword_link && !OP_LINK.test(item.onepassword_link)) errors.unshift('The 1Password link must start with https:// or onepassword://.');
  if (errors.length) return renderShared(res, 400, { ...item, cf: values }, errors.join(' '));
  const savedId = await transaction(async (conn) => {
    const app = await appId(conn, item.app, req.user);
    const cols = [item.name, app, item.account || null, item.purpose || null, item.owner_person_id, item.status,
      item.in_1password, item.onepassword_link || null, item.notes || null, req.user.id];
    let rowId = id;
    if (id) {
      const [r] = await conn.query(`
        UPDATE inv_shared_accounts SET name = ?, app_id = ?, account = ?, purpose = ?, owner_person_id = ?, status = ?,
          in_1password = ?, onepassword_link = ?, notes = ?, updated_by = ? WHERE id = ?
      `, [...cols, id]);
      if (!r.affectedRows) throw notFound();
    } else {
      const [r] = await conn.query(`
        INSERT INTO inv_shared_accounts (name, app_id, account, purpose, owner_person_id, status, in_1password, onepassword_link, notes, updated_by, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [...cols, req.user.id]);
      rowId = r.insertId;
    }
    const changed = await cf.saveValues(conn, 'shared', rowId, fields, values);
    await inv.logInv(conn, req.user, { type: 'inv_shared', id: rowId, action: id ? 'updated' : 'created', subject: item.name,
      summary: `${id ? 'Updated' : 'Added'} shared account ${item.name}${item.app ? ` (${item.app})` : ''}.`, changes: changed,
      personId: item.owner_person_id });
    return rowId;
  });
  flash(req, 'success', 'Shared account saved.');
  res.redirect(`/inventory/access#shared-${savedId}`);
}

router.post('/access/shared', (req, res) => saveShared(req, res, null));
router.post('/access/shared/:id', (req, res) => saveShared(req, res, requireId(req.params.id)));

router.post('/access/shared/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[item]] = await pool.query('SELECT name FROM inv_shared_accounts WHERE id = ?', [id]);
  if (!item) throw notFound();
  await inv.logInv(null, req.user, { type: 'inv_shared', id, action: 'deleted', subject: item.name, summary: `Deleted shared account ${item.name}.` });
  await pool.query("DELETE FROM custom_field_values WHERE entity_type = 'shared' AND entity_id = ?", [id]);
  await pool.query('DELETE FROM inv_shared_accounts WHERE id = ?', [id]);
  flash(req, 'success', 'Shared account deleted.');
  res.redirect('/inventory/access#shared');
});

// ---- A person's access entries ----

router.post('/access', async (req, res) => {
  const a = readAccess(req.body);
  const back = safePath(req.body.back, a.person_id ? `/inventory/people/${a.person_id}#access` : '/inventory/access');
  const fields = await cf.fieldsFor('access');
  const { values, errors } = cf.readValues(fields, req.body);
  errors.unshift(...accessErrors(a));
  const person = a.person_id ? await inv.personById(a.person_id) : null;
  if (!person) errors.unshift('Choose the person.');
  if (errors.length) {
    flash(req, 'error', errors.join(' '));
    return res.redirect(back);
  }
  await transaction(async (conn) => {
    const app = await appId(conn, a.app, req.user);
    const [r] = await conn.query(`
      INSERT INTO inv_access (person_id, app_id, username, granted_date, granted_by, status, removed_date, in_1password, onepassword_link, notes, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [a.person_id, app, a.username || null, a.granted_date || londonDate(), a.granted_by || req.user.name, a.status,
      a.status === 'removed' ? (a.removed_date || londonDate()) : null, a.in_1password, a.onepassword_link || null, a.notes || null,
      req.user.id, req.user.id]);
    await cf.saveValues(conn, 'access', r.insertId, fields, values);
    await inv.logInv(conn, req.user, { type: 'inv_access', id: r.insertId, action: 'created', subject: a.app, personId: a.person_id,
      summary: `Gave ${person.name} ${a.app} access${a.username ? ` (${a.username})` : ''}.` });
  });
  flash(req, 'success', 'Access added.');
  res.redirect(back);
});

router.get('/access/:id/edit', async (req, res) => {
  const id = requireId(req.params.id);
  const [[item]] = await pool.query(`
    SELECT ac.*, ap.name AS app, p.name AS person_name FROM inv_access ac
    JOIN inv_people p ON p.id = ac.person_id LEFT JOIN inv_apps ap ON ap.id = ac.app_id WHERE ac.id = ?
  `, [id]);
  if (!item) throw notFound();
  res.render('inventory/access/form', {
    title: `Edit ${item.app || 'access'} for ${item.person_name}`,
    item, lists: await inv.loadLists(), fields: await cf.fieldsFor('access'),
    values: (await cf.valuesFor('access', [id])).get(id) || {}, error: null,
  });
});

router.post('/access/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[before]] = await pool.query('SELECT ac.*, p.name AS person_name FROM inv_access ac JOIN inv_people p ON p.id = ac.person_id WHERE ac.id = ?', [id]);
  if (!before) throw notFound();
  const a = { ...readAccess(req.body), person_id: before.person_id };
  const fields = await cf.fieldsFor('access');
  const { values, errors } = cf.readValues(fields, req.body);
  errors.unshift(...accessErrors(a));
  if (errors.length) {
    return res.status(400).render('inventory/access/form', {
      title: 'Edit access', item: { ...before, ...a, id }, lists: await inv.loadLists(), fields, values, error: errors.join(' '),
    });
  }
  await transaction(async (conn) => {
    const app = await appId(conn, a.app, req.user);
    const removedDate = a.status === 'removed' ? (a.removed_date || before.removed_date || londonDate()) : null;
    await conn.query(`
      UPDATE inv_access SET app_id = ?, username = ?, granted_date = ?, granted_by = ?, status = ?, removed_date = ?,
        in_1password = ?, onepassword_link = ?, notes = ?, updated_by = ? WHERE id = ?
    `, [app, a.username || null, a.granted_date, a.granted_by || null, a.status, removedDate, a.in_1password,
      a.onepassword_link || null, a.notes || null, req.user.id, id]);
    const changed = await cf.saveValues(conn, 'access', id, fields, values);
    const summary = before.status !== a.status
      ? `${a.status === 'removed' ? 'Removed' : 'Restored'} ${a.app} access for ${before.person_name}.`
      : `Updated ${a.app} access for ${before.person_name}.`;
    await inv.logInv(conn, req.user, { type: 'inv_access', id, action: 'updated', subject: a.app, personId: before.person_id, summary, changes: changed });
  });
  flash(req, 'success', 'Access saved.');
  res.redirect(safePath(req.body.back, `/inventory/people/${before.person_id}#access`));
});

router.post('/access/:id/remove', async (req, res) => {
  const id = requireId(req.params.id);
  const [[a]] = await pool.query(`
    SELECT ac.*, ap.name AS app_name, p.name AS person_name FROM inv_access ac
    JOIN inv_people p ON p.id = ac.person_id LEFT JOIN inv_apps ap ON ap.id = ac.app_id WHERE ac.id = ?
  `, [id]);
  if (!a) throw notFound();
  if (a.status === 'active') {
    await pool.query("UPDATE inv_access SET status = 'removed', removed_date = ?, updated_by = ? WHERE id = ?", [londonDate(), req.user.id, id]);
    await inv.logInv(null, req.user, { type: 'inv_access', id, action: 'updated', subject: a.app_name, personId: a.person_id,
      summary: `Removed ${a.app_name || 'account'} access for ${a.person_name}${a.username ? ` (${a.username})` : ''}.` });
  }
  flash(req, 'success', 'Access marked as removed.');
  res.redirect(safePath(req.body.back, `/inventory/people/${a.person_id}#access`));
});

router.post('/access/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[a]] = await pool.query(`
    SELECT ac.*, ap.name AS app_name, p.name AS person_name FROM inv_access ac
    JOIN inv_people p ON p.id = ac.person_id LEFT JOIN inv_apps ap ON ap.id = ac.app_id WHERE ac.id = ?
  `, [id]);
  if (!a) throw notFound();
  await inv.logInv(null, req.user, { type: 'inv_access', id, action: 'deleted', subject: a.app_name, personId: a.person_id,
    summary: `Deleted the ${a.app_name || 'account'} access record for ${a.person_name}.` });
  await pool.query("DELETE FROM custom_field_values WHERE entity_type = 'access' AND entity_id = ?", [id]);
  await pool.query('DELETE FROM inv_access WHERE id = ?', [id]);
  flash(req, 'success', 'Access record deleted.');
  res.redirect(safePath(req.body.back, `/inventory/people/${a.person_id}#access`));
});

module.exports = router;
