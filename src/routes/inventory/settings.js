// Settings > Inventory tabs: add simple tabs (each starts with a "Name" column and gets
// its own fields), rename, drag to reorder, delete (with confirmation and a record
// count). Employees, Ex Employees and Stock can be renamed and moved but not deleted.
const express = require('express');
const { pool, transaction } = require('../../db');
const { requireId, str, flash, notFound } = require('../../lib/http');
const { listTabs, getTab, logInv } = require('../../lib/inventory/records');
const { getPrefix, formatId, PREFIX_PATTERN } = require('../../lib/inventory/userids');
const { findJunkFields, deleteField } = require('../../lib/inventory/field-admin');

const router = express.Router();

const deletable = (tab) => tab.kind === 'records';

async function recordCounts() {
  const [rows] = await pool.query('SELECT tab_id, COUNT(*) AS n FROM inventory_records GROUP BY tab_id');
  return Object.fromEntries(rows.map((r) => [r.tab_id, Number(r.n)]));
}

router.get('/settings/tabs', async (req, res) => {
  res.render('inventory/settings/tabs', {
    title: 'Inventory settings', tabs: await listTabs(), counts: await recordCounts(), deletable, prefix: await getPrefix(pool),
    junk: await findJunkFields(pool),
  });
});

// One-time clean-up: deletes the fields created by mistake ("asdasd", "asdas",
// "MDP.USER26@GMAIL.COM", any case, on any tab), with their values, in one transaction.
router.post('/settings/cleanup-fields', async (req, res) => {
  const junk = await findJunkFields(pool);
  if (!junk.length) {
    flash(req, 'info', 'There are no junk fields left to remove.');
    return res.redirect('/inventory/settings/tabs');
  }
  try {
    await transaction(async (conn) => {
      for (const f of junk) await deleteField(conn, req.user, f, f.place, { note: ' (clean-up of fields created by mistake)' });
    });
    flash(req, 'saved', `Removed ${junk.length} junk field${junk.length === 1 ? '' : 's'}: ${junk.map((f) => `"${f.label}" (${f.place})`).join(', ')}.`);
  } catch (err) {
    console.error('Inventory field clean-up failed:', err);
    flash(req, 'error', `The clean-up could not finish (${err.message}). Nothing was changed.`);
  }
  res.redirect('/inventory/settings/tabs');
});

router.post('/settings/tabs', async (req, res) => {
  const name = str(req.body.name, 60);
  if (!name) {
    flash(req, 'error', 'Give the tab a name.');
    return res.redirect('/inventory/settings/tabs');
  }
  const id = await transaction(async (conn) => {
    const [[{ next }]] = await conn.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM inventory_tabs');
    const [r] = await conn.query("INSERT INTO inventory_tabs (kind, name, sort_order) VALUES ('records', ?, ?)", [name, next]);
    await conn.query(
      "INSERT INTO inventory_fields (tab_id, label, field_type, role, sort_order, required, width) VALUES (?, 'Name', 'text', 'title', 0, 1, 180)",
      [r.insertId]
    );
    await logInv(conn, req.user, { type: 'inv_config', action: 'created', subject: name, summary: `Added the inventory tab "${name}"` });
    return r.insertId;
  });
  flash(req, 'success', `Tab "${name}" added. Add its columns here.`);
  res.redirect(`/inventory/t/${id}/columns`);
});

// Employee User-ID prefix (MDP in MDP-001). Existing IDs keep the prefix they were given.
router.post('/settings/user-id-prefix', async (req, res) => {
  const prefix = str(req.body.prefix, 10).toUpperCase();
  if (!PREFIX_PATTERN.test(prefix)) {
    flash(req, 'error', 'The prefix can only use letters and numbers (up to 10).');
    return res.redirect('/inventory/settings/tabs#user-id');
  }
  const before = await getPrefix(pool);
  if (prefix !== before) {
    await pool.query("INSERT INTO inventory_settings (name, value) VALUES ('user_id_prefix', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [prefix]);
    await logInv(null, req.user, {
      type: 'inv_config', action: 'updated', subject: 'Employee User-IDs',
      summary: `Changed the employee User-ID prefix from ${before} to ${prefix} (new IDs look like ${formatId(prefix, 1)})`,
    });
  }
  flash(req, 'success', prefix === before ? 'No changes.' : `New User-IDs now look like ${formatId(prefix, 1)}.`);
  res.redirect('/inventory/settings/tabs#user-id');
});

router.post('/settings/tabs/order', async (req, res) => {
  const tabs = await listTabs();
  const ids = String(req.body.order || '').split(',').map(Number).filter(Boolean);
  if (ids.length !== tabs.length || ids.some((id) => !tabs.some((t) => t.id === id))) {
    return res.status(400).json({ ok: false, error: 'That order does not match the tabs.' });
  }
  await transaction(async (conn) => {
    for (const [i, id] of ids.entries()) await conn.query('UPDATE inventory_tabs SET sort_order = ? WHERE id = ?', [i, id]);
    await logInv(conn, req.user, { type: 'inv_config', action: 'updated', subject: 'Inventory tabs', summary: 'Reordered the inventory tabs' });
  });
  res.json({ ok: true });
});

router.post('/settings/tabs/:id', async (req, res) => {
  const tab = await getTab(pool, requireId(req.params.id));
  const name = str(req.body.name, 60);
  // "+ Add field" default on this tab's records: all records (shared) or this record only.
  const applies = ['all', 'record'].includes(req.body.add_field_default) ? req.body.add_field_default : tab.add_field_default;
  if (!name) {
    flash(req, 'error', 'Give the tab a name.');
    return res.redirect('/inventory/settings/tabs');
  }
  const changes = [];
  if (name !== tab.name) changes.push(`renamed "${tab.name}" to "${name}"`);
  if (applies !== tab.add_field_default) changes.push(`"+ Add field" now defaults to ${applies === 'record' ? 'This record only' : 'All records'}`);
  if (changes.length) {
    await pool.query('UPDATE inventory_tabs SET name = ?, add_field_default = ? WHERE id = ?', [name, applies, tab.id]);
    await logInv(null, req.user, { type: 'inv_config', action: 'updated', subject: name, summary: `Changed the inventory tab "${tab.name}": ${changes.join(', ')}` });
  }
  flash(req, 'saved', changes.length ? 'Saved. Tab updated.' : 'Saved. Nothing changed.');
  res.redirect('/inventory/settings/tabs');
});

router.get('/settings/tabs/:id/delete', async (req, res) => {
  const tab = await getTab(pool, requireId(req.params.id));
  if (!deletable(tab)) throw notFound();
  const count = (await recordCounts())[tab.id] || 0;
  res.render('inventory/settings/tab-delete', { title: `Delete tab · ${tab.name}`, tab, count });
});

router.post('/settings/tabs/:id/delete', async (req, res) => {
  const tab = await getTab(pool, requireId(req.params.id));
  if (!deletable(tab)) throw notFound();
  if (req.body.confirm_name !== tab.name) {
    flash(req, 'error', `Type the tab name "${tab.name}" to confirm.`);
    return res.redirect(`/inventory/settings/tabs/${tab.id}/delete`);
  }
  const count = (await recordCounts())[tab.id] || 0;
  await transaction(async (conn) => {
    await conn.query('DELETE FROM inventory_tabs WHERE id = ?', [tab.id]); // fields, records and values cascade
    await logInv(conn, req.user, {
      type: 'inv_config', action: 'deleted', subject: tab.name,
      summary: `Deleted the inventory tab "${tab.name}"${count ? ` and its ${count} record${count === 1 ? '' : 's'}` : ''}`,
    });
  });
  flash(req, 'success', `Tab "${tab.name}" deleted.`);
  res.redirect('/inventory/settings/tabs');
});

module.exports = router;
