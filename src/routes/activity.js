// "Log work": manual activity entries (entity_type 'manual'). Each user can edit
// and delete only their own entries.
const express = require('express');
const { pool } = require('../db');
const { str, requireId, flash, notFound, safePath } = require('../lib/http');
const { londonDate } = require('../lib/activity');
const { isDate } = require('../lib/report');

const router = express.Router();

const safeBack = (value) => safePath(value, '/report');

function readEntry(body) {
  return {
    client: str(body.client, 200),
    description: str(body.description, 2000),
    date: str(body.date, 10),
  };
}

// Resolves the typed/picked client name. Returns { client } or { error }.
async function resolveClient(name) {
  if (!name) return { client: null };
  const [rows] = await pool.query('SELECT id, name FROM clients WHERE name = ? ORDER BY id LIMIT 2', [name]);
  if (!rows.length) return { error: `There is no client called "${name}". Pick one from the list or leave it blank.` };
  if (rows.length > 1) return { error: `More than one client is called "${name}". Rename one of them first.` };
  return { client: rows[0] };
}

async function validate(entry) {
  if (!entry.description) return { error: 'Describe the work you did.' };
  if (!isDate(entry.date)) return { error: 'Choose a valid date.' };
  return resolveClient(entry.client);
}

const renderForm = (res, status, locals) => res.status(status).render('activity/log-work', { title: 'Log work', ...locals });

async function ownEntry(req, id) {
  const [[entry]] = await pool.query(
    "SELECT id, user_id, client_name, summary, activity_date FROM activity_log WHERE id = ? AND entity_type = 'manual'",
    [id]
  );
  if (!entry || entry.user_id !== req.user.id) throw notFound();
  return entry;
}

router.get('/', (req, res) => renderForm(res, 200, {
  entry: { client: '', description: '', date: londonDate() },
  action: '/log-work',
  back: safeBack(req.query.back),
  error: null,
}));

router.post('/', async (req, res) => {
  const entry = readEntry(req.body);
  const back = safeBack(req.body.back);
  const { client, error } = await validate(entry);
  if (error) return renderForm(res, 400, { entry, action: '/log-work', back, error });

  await pool.query(`
    INSERT INTO activity_log (user_id, client_id, client_name, entity_type, action, summary, activity_date)
    VALUES (?, ?, ?, 'manual', 'created', ?, ?)
  `, [req.user.id, client ? client.id : null, client ? client.name : null, entry.description, entry.date]);
  flash(req, 'success', entry.date === londonDate() ? 'Work logged.' : `Work logged for ${entry.date}.`);
  res.redirect(back);
});

router.get('/:id/edit', async (req, res) => {
  const row = await ownEntry(req, requireId(req.params.id));
  renderForm(res, 200, {
    title: 'Edit logged work',
    entry: { id: row.id, client: row.client_name || '', description: row.summary, date: row.activity_date },
    action: `/log-work/${row.id}`,
    back: safeBack(req.query.back),
    error: null,
  });
});

router.post('/:id', async (req, res) => {
  const row = await ownEntry(req, requireId(req.params.id));
  const entry = { ...readEntry(req.body), id: row.id };
  const back = safeBack(req.body.back);
  const { client, error } = await validate(entry);
  if (error) return renderForm(res, 400, { title: 'Edit logged work', entry, action: `/log-work/${row.id}`, back, error });

  await pool.query(
    'UPDATE activity_log SET client_id = ?, client_name = ?, summary = ?, activity_date = ?, updated_at = NOW() WHERE id = ?',
    [client ? client.id : null, client ? client.name : null, entry.description, entry.date, row.id]
  );
  flash(req, 'success', 'Logged work updated.');
  res.redirect(back);
});

router.post('/:id/delete', async (req, res) => {
  const row = await ownEntry(req, requireId(req.params.id));
  await pool.query('DELETE FROM activity_log WHERE id = ?', [row.id]);
  flash(req, 'success', 'Logged work deleted.');
  res.redirect(safeBack(req.body.back));
});

module.exports = router;
