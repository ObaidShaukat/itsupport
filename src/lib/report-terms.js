// Daily Report vocabulary: actions (verb templates) and issues (subject phrases),
// edited on the Settings page and picked on comment, note and Log work forms.
const { pool } = require('../db');
const { str, toId } = require('./http');
const { logActivity } = require('./activity');

// Used when an entry has an issue but no action.
const DEFAULT_TEMPLATE = 'Provided IT support to {client} regarding {subjects} issues.';

// "A", "A and B", "A, B and C" (British style, no Oxford comma).
const joinAnd = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

const fillTemplate = (template, client, subjects) => String(template)
  .replace(/\{client\}/g, client)
  .replace(/\{subjects\}/g, Array.isArray(subjects) ? joinAnd(subjects) : subjects);

async function loadTerms() {
  const [actions] = await pool.query('SELECT id, name, template, phrase_type, sort_order FROM report_actions ORDER BY name');
  const [issues] = await pool.query('SELECT id, name, problem_phrase, config_phrase FROM report_issues ORDER BY name');
  return { actions, issues };
}

// Raw form values (fields: report_action, report_issue, report_detail).
const readReportFields = (body) => ({
  actionId: toId(body.report_action),
  issueName: str(body.report_issue, 100),
  detail: str(body.report_detail, 255),
});

// Turns form values into ids. An unknown action is dropped; an issue name that
// does not exist yet is created (both phrases default to the name) and logged.
async function resolveReportFields(db, user, fields) {
  const conn = db || pool;
  let actionId = null;
  if (fields.actionId) {
    const [[action]] = await conn.query('SELECT id FROM report_actions WHERE id = ?', [fields.actionId]);
    if (action) actionId = action.id;
  }

  let issueId = null;
  if (fields.issueName) {
    const [[issue]] = await conn.query('SELECT id FROM report_issues WHERE name = ?', [fields.issueName]);
    if (issue) {
      issueId = issue.id;
    } else {
      const [result] = await conn.query(
        'INSERT INTO report_issues (name, problem_phrase, config_phrase) VALUES (?, ?, ?)',
        [fields.issueName, fields.issueName, fields.issueName]
      );
      issueId = result.insertId;
      await logActivity(conn, user, {
        type: 'setting', id: issueId, action: 'created', subject: fields.issueName,
        summary: `Added report issue ${fields.issueName} (from a form)`,
      });
    }
  }

  return { actionId, issueId, detail: fields.detail || null };
}

module.exports = { DEFAULT_TEMPLATE, joinAnd, fillTemplate, loadTerms, readReportFields, resolveReportFields };
