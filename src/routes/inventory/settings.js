// Settings > Inventory tabs: add simple tabs (each starts with a "Name" column and gets
// its own fields), rename, drag to reorder, delete (with confirmation and a record
// count). Employees, Ex Employees and Stock can be renamed and moved but not deleted.
const express = require('express');
const { pool, transaction } = require('../../db');
const { requireId, str, flash, notFound } = require('../../lib/http');
const { listTabs, getTab, logInv } = require('../../lib/inventory/records');

const router = express.Router();

const deletable = (tab) => tab.kind === 'records';

async function recordCounts() {
  const [rows] = await pool.query('SELECT tab_id, COUNT(*) AS n FROM inventory_records GROUP BY tab_id');
  return Object.fromEntries(rows.map((r) => [r.tab_id, Number(r.n)]));
}

router.get('/settings/tabs', async (req, res) => {
  res.render('inventory/settings/tabs', { title: 'Inventory tabs', tabs: await listTabs(), counts: await recordCounts(), deletable });
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
  if (!name) {
    flash(req, 'error', 'Give the tab a name.');
  } else if (name !== tab.name) {
    await pool.query('UPDATE inventory_tabs SET name = ? WHERE id = ?', [name, tab.id]);
    await logInv(null, req.user, { type: 'inv_config', action: 'updated', subject: name, summary: `Renamed the inventory tab "${tab.name}" to "${name}"` });
    flash(req, 'success', 'Tab renamed.');
  }
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
