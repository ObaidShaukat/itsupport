// "Log work": manual activity entries (entity_type 'manual'). Each user can edit
// and delete only their own entries.
const express = require('express');
const { pool } = require('../db');
const { str, requireId, flash, notFound, safePath, backPath } = require('../lib/http');
const { londonDate, logActivity } = require('../lib/activity');
const { isDate, entryTextFromLine, entryLine } = require('../lib/report');

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
  const back = backPath(req, '/report');
  const { client, error } = await validate(entry);
  if (error) return renderForm(res, 400, { entry, action: '/log-work', back, error });

  await pool.query(`
    INSERT INTO activity_log (user_id, client_id, client_name, entity_type, action, summary, activity_date)
    VALUES (?, ?, ?, 'manual', 'created', ?, ?)
  `, [req.user.id, client ? client.id : null, client ? client.name : null, entry.description, entry.date]);
  // A floating "Saved"-style toast (foot.ejs), not a banner that pushes the page down.
  flash(req, 'saved', entry.date === londonDate() ? 'Work logged.' : `Work logged for ${entry.date}.`);
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
  const back = backPath(req, '/report');
  const { client, error } = await validate(entry);
  if (error) return renderForm(res, 400, { title: 'Edit logged work', entry, action: `/log-work/${row.id}`, back, error });

  await pool.query(
    'UPDATE activity_log SET client_id = ?, client_name = ?, summary = ?, activity_date = ?, updated_at = NOW() WHERE id = ?',
    [client ? client.id : null, client ? client.name : null, entry.description, entry.date, row.id]
  );
  flash(req, 'success', 'Logged work updated.');
  res.redirect(back);
});

// Daily Report preview: an edited Log work line saved straight back to its entry (JSON).
// text is the line as shown; the client part the report adds and the final full stop are
// taken off (entryTextFromLine), the client and date stay as they are. The change is logged
// as entity_type 'report' / updated (on /activity, never on the Daily Report itself).
router.post('/:id/text', async (req, res) => {
  const row = await ownEntry(req, requireId(req.params.id));
  const text = entryTextFromLine(str(req.body.text, 2200), row.client_name, row.summary);
  if (!text) return res.status(400).json({ ok: false, error: 'A logged work line cannot be empty. Delete the entry below instead.' });
  if (text.length > 2000) return res.status(400).json({ ok: false, error: 'Keep it under 2,000 characters.' });
  // Unchanged when the report line would read the same (only capitals / the full stop differ
  // from the saved text): the entry is left exactly as typed.
  const changed = entryLine(text, row.client_name) !== entryLine(row.summary, row.client_name);
  if (changed) {
    await pool.query('UPDATE activity_log SET summary = ?, updated_at = NOW() WHERE id = ?', [text, row.id]);
    await logActivity(null, req.user, {
      type: 'report', id: row.id, action: 'updated', clientName: row.client_name, subject: 'Logged work',
      summary: `Edited logged work from the Daily Report preview: "${row.summary}" → "${text}"`,
    });
  }
  const summary = changed ? text : row.summary;
  return res.json({ ok: true, changed, summary, line: entryLine(summary, row.client_name) });
});

router.post('/:id/delete', async (req, res) => {
  const row = await ownEntry(req, requireId(req.params.id));
  await pool.query('DELETE FROM activity_log WHERE id = ?', [row.id]);
  flash(req, 'success', 'Logged work deleted.');
  res.redirect(backPath(req, '/report'));
});

module.exports = router;
