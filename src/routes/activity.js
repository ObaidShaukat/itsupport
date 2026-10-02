// "Log work": manual activity entries (entity_type 'manual'). Each user can edit
// and delete only their own entries.
const express = require('express');
const { pool } = require('../db');
const { str, requireId, flash, notFound } = require('../lib/http');
const { londonDate } = require('../lib/activity');
const { isDate } = require('../lib/report');
const { readReportFields, resolveReportFields } = require('../lib/report-terms');

const router = express.Router();

// Only same-site paths are allowed as a return address.
const safeBack = (value) => (typeof value === 'string' && /^\/(?!\/)\S*$/.test(value) ? value.slice(0, 500) : '/report');

function readEntry(body) {
  const report = readReportFields(body);
  return {
    client: str(body.client, 200),
    description: str(body.description, 2000),
    date: str(body.date, 10),
    report,
    // For re-showing the form after an error.
    report_action: report.actionId,
    report_issue: report.issueName,
    report_detail: report.detail,
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
  const r = entry.report;
  if (!entry.description && !r.actionId && !r.issueName) {
    return { error: 'Describe the work you did, or pick an action or issue.' };
  }
  if (!isDate(entry.date)) return { error: 'Choose a valid date.' };
  return resolveClient(entry.client);
}

const renderForm = (res, status, locals) => res.status(status).render('activity/log-work', { title: 'Log work', ...locals });

async function ownEntry(req, id) {
  const [[entry]] = await pool.query(
    `SELECT l.id, l.user_id, l.client_name, l.summary, l.activity_date, l.action_id, l.report_detail, ri.name AS issue_name
     FROM activity_log l LEFT JOIN report_issues ri ON ri.id = l.issue_id
     WHERE l.id = ? AND l.entity_type = 'manual'`,
    [id]
  );
  if (!entry || entry.user_id !== req.user.id) throw notFound();
  return entry;
}

router.get('/', (req, res) => renderForm(res, 200, {
  entry: { client: '', description: '', date: londonDate(), report_action: null, report_issue: '', report_detail: '' },
  action: '/log-work',
  back: safeBack(req.query.back),
  error: null,
}));

router.post('/', async (req, res) => {
  const entry = readEntry(req.body);
  const back = safeBack(req.body.back);
  const { client, error } = await validate(entry);
  if (error) return renderForm(res, 400, { entry, action: '/log-work', back, error });

  const report = await resolveReportFields(null, req.user, entry.report);
  await pool.query(`
    INSERT INTO activity_log
      (user_id, client_id, client_name, entity_type, action, summary, action_id, issue_id, report_detail, activity_date)
    VALUES (?, ?, ?, 'manual', 'created', ?, ?, ?, ?, ?)
  `, [req.user.id, client ? client.id : null, client ? client.name : null, entry.description,
    report.actionId, report.issueId, report.detail, entry.date]);
  flash(req, 'success', entry.date === londonDate() ? 'Work logged.' : `Work logged for ${entry.date}.`);
  res.redirect(back);
});

router.get('/:id/edit', async (req, res) => {
  const row = await ownEntry(req, requireId(req.params.id));
  renderForm(res, 200, {
    title: 'Edit logged work',
    entry: {
      id: row.id, client: row.client_name || '', description: row.summary, date: row.activity_date,
      report_action: row.action_id, report_issue: row.issue_name || '', report_detail: row.report_detail || '',
    },
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

  const report = await resolveReportFields(null, req.user, entry.report);
  await pool.query(`
    UPDATE activity_log
    SET client_id = ?, client_name = ?, summary = ?, action_id = ?, issue_id = ?, report_detail = ?,
        activity_date = ?, updated_at = NOW()
    WHERE id = ?
  `, [client ? client.id : null, client ? client.name : null, entry.description,
    report.actionId, report.issueId, report.detail, entry.date, row.id]);
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
