// Settings: Daily Report actions (verb templates) and issues (subject phrases).
const express = require('express');
const { pool } = require('../db');
const { str, requireId, flash, notFound } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { loadTerms } = require('../lib/report-terms');

const router = express.Router();

const PHRASE_TYPES = ['problem', 'config'];
const isDuplicate = (err) => err.code === 'ER_DUP_ENTRY';
const logSetting = (req, id, action, subject, summary) => logActivity(null, req.user, {
  type: 'setting', id, action, subject, summary,
});

function readAction(body) {
  return {
    name: str(body.name, 100),
    template: str(body.template, 255),
    phrase_type: PHRASE_TYPES.includes(body.phrase_type) ? body.phrase_type : 'problem',
  };
}

function validateAction(a) {
  if (!a.name) return 'Action name is required.';
  if (!a.template.includes('{client}') || !a.template.includes('{subjects}')) {
    return 'The template must include both {client} and {subjects}.';
  }
  return null;
}

function readIssue(body) {
  const name = str(body.name, 100);
  return {
    name,
    problem_phrase: str(body.problem_phrase, 255) || name,
    config_phrase: str(body.config_phrase, 255) || name,
  };
}

router.get('/', async (req, res) => {
  const { actions, issues } = await loadTerms();
  res.render('settings/index', { title: 'Settings', actions, issues });
});

// ---- Actions ----

router.post('/actions', async (req, res) => {
  const action = readAction(req.body);
  const problem = validateAction(action);
  if (problem) {
    flash(req, 'error', problem);
    return res.redirect('/settings#actions');
  }
  try {
    const [[{ next }]] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM report_actions');
    const [result] = await pool.query(
      'INSERT INTO report_actions (name, template, phrase_type, sort_order) VALUES (?, ?, ?, ?)',
      [action.name, action.template, action.phrase_type, Number(next)]
    );
    await logSetting(req, result.insertId, 'created', action.name, `Added report action ${action.name}: ${action.template}`);
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `An action called "${action.name}" already exists.`);
    return res.redirect('/settings#actions');
  }
  flash(req, 'success', `Action "${action.name}" added.`);
  res.redirect('/settings#actions');
});

router.post('/actions/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const action = readAction(req.body);
  const problem = validateAction(action);
  if (problem) {
    flash(req, 'error', problem);
    return res.redirect('/settings#actions');
  }
  try {
    const [result] = await pool.query(
      'UPDATE report_actions SET name = ?, template = ?, phrase_type = ? WHERE id = ?',
      [action.name, action.template, action.phrase_type, id]
    );
    if (!result.affectedRows) throw notFound();
    await logSetting(req, id, 'updated', action.name, `Updated report action ${action.name}: ${action.template}`);
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `An action called "${action.name}" already exists.`);
    return res.redirect('/settings#actions');
  }
  flash(req, 'success', 'Action updated.');
  res.redirect('/settings#actions');
});

// Entries that used a deleted action fall back to the default wording.
router.post('/actions/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[action]] = await pool.query('SELECT name FROM report_actions WHERE id = ?', [id]);
  if (!action) return res.redirect('/settings#actions');
  await pool.query('DELETE FROM report_actions WHERE id = ?', [id]);
  await logSetting(req, id, 'deleted', action.name, `Deleted report action ${action.name}`);
  flash(req, 'success', 'Action deleted.');
  res.redirect('/settings#actions');
});

// ---- Issues ----

router.post('/issues', async (req, res) => {
  const issue = readIssue(req.body);
  if (!issue.name) {
    flash(req, 'error', 'Issue name is required.');
    return res.redirect('/settings#issues');
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO report_issues (name, problem_phrase, config_phrase) VALUES (?, ?, ?)',
      [issue.name, issue.problem_phrase, issue.config_phrase]
    );
    await logSetting(req, result.insertId, 'created', issue.name, `Added report issue ${issue.name}`);
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `An issue called "${issue.name}" already exists.`);
    return res.redirect('/settings#issues');
  }
  flash(req, 'success', `Issue "${issue.name}" added.`);
  res.redirect('/settings#issues');
});

router.post('/issues/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const issue = readIssue(req.body);
  if (!issue.name) {
    flash(req, 'error', 'Issue name is required.');
    return res.redirect('/settings#issues');
  }
  try {
    const [result] = await pool.query(
      'UPDATE report_issues SET name = ?, problem_phrase = ?, config_phrase = ? WHERE id = ?',
      [issue.name, issue.problem_phrase, issue.config_phrase, id]
    );
    if (!result.affectedRows) throw notFound();
    await logSetting(req, id, 'updated', issue.name,
      `Updated report issue ${issue.name}: "${issue.problem_phrase}" / "${issue.config_phrase}"`);
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `An issue called "${issue.name}" already exists.`);
    return res.redirect('/settings#issues');
  }
  flash(req, 'success', 'Issue updated.');
  res.redirect('/settings#issues');
});

router.post('/issues/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[issue]] = await pool.query('SELECT name FROM report_issues WHERE id = ?', [id]);
  if (!issue) return res.redirect('/settings#issues');
  await pool.query('DELETE FROM report_issues WHERE id = ?', [id]);
  await logSetting(req, id, 'deleted', issue.name, `Deleted report issue ${issue.name}`);
  flash(req, 'success', 'Issue deleted.');
  res.redirect('/settings#issues');
});

module.exports = router;
