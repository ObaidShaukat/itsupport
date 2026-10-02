// Daily report: built only from activity_log. A UK date (or range) is turned into a
// UTC start/end and automatic entries are matched on created_at (when the action
// happened). Manual "Log work" entries are matched on the date the user picked.
// Each user gets a "<User>'s Work:" list built from fixed templates (no AI): actions
// and issues picked on forms are grouped per client, see userLines() below.
const { pool } = require('../db');
const { londonDate, londonDayStart } = require('./activity');
const { DEFAULT_TEMPLATE, joinAnd, fillTemplate } = require('./report-terms');

const MAX_RANGE_DAYS = 62;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SNIPPET_LENGTH = 150;

function isDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

function dayLabel(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

// UTC [start, end) covering the UK dates from..to inclusive.
const utcRange = (from, to) => [londonDayStart(from), londonDayStart(addDays(to, 1))];

// SQL condition and parameters selecting activity_log rows (alias l) for from..to.
function rangeCondition(from, to) {
  const [start, end] = utcRange(from, to);
  return {
    sql: "((l.entity_type <> 'manual' AND l.created_at >= ? AND l.created_at < ?) OR (l.entity_type = 'manual' AND l.activity_date BETWEEN ? AND ?))",
    params: [start, end, from, to],
  };
}

// The UK date a row belongs to on the report.
const rowDay = (row) => (row.entity_type === 'manual' ? String(row.activity_date).slice(0, 10) : londonDate(new Date(row.created_at)));

// "obaid" -> "Obaid's Work:"
function heading(username) {
  const name = username ? username.charAt(0).toUpperCase() + username.slice(1) : 'Former user';
  return `${name}'s Work:`;
}

// ---- Text helpers ----

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const withoutStop = (text) => clean(text).replace(/[.;:,\s]+$/, '');
// Entries logged before plain-text summaries had a "Comment: " style prefix.
const withoutPrefix = (text) => clean(text).replace(/^(Comment|Note|Edited note|Done):\s*/i, '');
const snippet = (text) => {
  const t = withoutStop(withoutPrefix(text));
  return t.length > SNIPPET_LENGTH ? `${t.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…` : t;
};
// Capital first letter, exactly one full stop at the end, no semicolons.
const sentence = (text) => {
  const t = clean(text).replace(/;/g, ',').replace(/[.\s]+$/, '');
  if (!t) return '';
  const capitalised = t.charAt(0).toUpperCase() + t.slice(1);
  return /[!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

// Subject used when an action is picked with no issue and nothing else to go on.
const FALLBACK_SUBJECT = 'general IT';

// ---- Bullets ----

// One user's day as bullets, in this order: client services, tickets, log work,
// knowledge base, then always "Other IT related tasks.". Duplicate lines are removed.
//
// Comments, notes and Log work with an action and/or issue are grouped per client +
// action, their subjects joined "A, B and C" into the action's template, with any
// report details in brackets:
//   "Resolved Remote Desktop access and Outlook connectivity and mailbox issues for ASL Solicitors (rebuilt user profile)."
//   Issue only -> "Provided IT support to {client} regarding {problem phrase} issues."
//   Action only -> the ticket title (or Log work text) is the subject.
//   Log work with no client -> "internal staff".
// Without an action or issue:
//   Tickets (created, status changes, plain comments) -> "Provided IT support to {client} regarding {titles}."
//   Notes -> "Continued {service} for {client} ({detail})."
//   Log work -> as written.
// Client services: "Commenced {service} for {client}.", "Completed {steps} as part of
// {service} for {client}.", "Completed {service} for {client}." ({service} is the
// service's report phrase, or its name).
// Knowledge base: "Documented a solution for '{title}' in the knowledge base." /
// "Updated the knowledge base article '{title}'."
// Deletes, unticked steps, reopenings, client/user/settings/catalogue changes are left out.
function userLines(rows) {
  const section = () => ({ items: [], byKey: new Map() });
  const sections = { services: section(), tickets: section(), logwork: section(), kb: section() };
  const groupedTickets = new Set();

  // Adds an item once per key; later rows for the same key update it in place.
  const item = (sec, key, create) => {
    if (!sec.byKey.has(key)) {
      const created = create();
      sec.byKey.set(key, created);
      sec.items.push(created);
    }
    return sec.byKey.get(key);
  };
  const addUnique = (list, value) => {
    const v = withoutStop(value);
    if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
  };

  // Grouped "action + issue" line for one client.
  const addGrouped = (sec, client, row, fallbackSubject) => {
    const action = row.action_template ? { id: row.action_ref, template: row.action_template, type: row.phrase_type } : null;
    const issuePhrase = row.issue_name
      ? (action && action.type === 'config' ? row.config_phrase : row.problem_phrase) || row.issue_name
      : null;
    const bucket = item(sec, `group:${client.toLowerCase()}:${action ? action.id : 'default'}`, () => ({
      grouped: true, client, template: action ? action.template : DEFAULT_TEMPLATE, subjects: [], details: [],
    }));
    addUnique(bucket.subjects, issuePhrase || fallbackSubject || FALLBACK_SUBJECT);
    addUnique(bucket.details, row.report_detail);
  };

  const hasTerms = (row) => Boolean(row.action_template || row.issue_name);

  for (const row of rows) {
    if (row.action === 'deleted') continue;
    const client = clean(row.client_name);
    const subject = withoutStop(row.subject);
    const servicePhrase = withoutStop(row.service_phrase) || subject;

    switch (row.entity_type) {
      case 'manual':
        if (hasTerms(row)) addGrouped(sections.logwork, client || 'internal staff', row, snippet(row.summary));
        else if (clean(row.summary)) sections.logwork.items.push({ text: sentence(row.summary) });
        break;
      case 'ticket_comment':
        if (!client) break;
        if (hasTerms(row)) {
          addGrouped(sections.tickets, client, row, subject);
          groupedTickets.add(row.entity_id);
          break;
        }
      // A plain comment counts like any other work on the ticket.
      // falls through
      case 'ticket': {
        if (!client) break;
        const titles = item(sections.tickets, `titles:${client.toLowerCase()}`, () => ({ client, titles: new Map() }));
        if (!titles.titles.has(row.entity_id)) titles.titles.set(row.entity_id, subject);
        break;
      }
      case 'note':
        if (!client) break;
        if (hasTerms(row)) {
          addGrouped(sections.services, client, row, servicePhrase);
        } else {
          const detail = withoutStop(row.report_detail);
          sections.services.items.push({ text: sentence(`Continued ${servicePhrase} for ${client}${detail ? ` (${detail})` : ''}`) });
        }
        break;
      case 'client_service':
        if (!client) break;
        if (row.action === 'created') {
          item(sections.services, `start:${row.entity_id}`, () => ({ text: sentence(`Commenced ${servicePhrase} for ${client}`) }));
        } else if (row.action === 'closed') {
          item(sections.services, `done:${row.entity_id}`, () => ({ text: sentence(`Completed ${servicePhrase} for ${client}`) }));
        }
        break;
      case 'step': {
        if (!client || row.action !== 'step_done') break;
        const steps = item(sections.services, `steps:${row.entity_id}`, () => ({ client, phrase: servicePhrase, steps: [] }));
        addUnique(steps.steps, withoutPrefix(row.summary));
        break;
      }
      case 'kb_article': {
        const a = item(sections.kb, `kb:${row.entity_id}`, () => ({ kb: true, created: false }));
        a.title = subject;
        if (row.action === 'created') a.created = true;
        break;
      }
      default:
        break;
    }
  }

  const render = (entry) => {
    if (entry.grouped) {
      const text = withoutStop(fillTemplate(entry.template, entry.client, entry.subjects));
      return sentence(entry.details.length ? `${text} (${entry.details.join(', ')})` : text);
    }
    if (entry.titles) {
      const titles = [...entry.titles].filter(([id]) => !groupedTickets.has(id)).map(([, title]) => title).filter(Boolean);
      return titles.length ? sentence(`Provided IT support to ${entry.client} regarding ${joinAnd(titles)}`) : null;
    }
    if (entry.steps) {
      return entry.steps.length ? sentence(`Completed ${joinAnd(entry.steps)} as part of ${entry.phrase} for ${entry.client}`) : null;
    }
    if (entry.kb) {
      return entry.created
        ? sentence(`Documented a solution for '${entry.title}' in the knowledge base`)
        : sentence(`Updated the knowledge base article '${entry.title}'`);
    }
    return entry.text || null;
  };

  const seen = new Set();
  const lines = [];
  for (const sec of [sections.services, sections.tickets, sections.logwork, sections.kb]) {
    for (const entry of sec.items) {
      const line = render(entry);
      if (line && !seen.has(line.toLowerCase())) {
        seen.add(line.toLowerCase());
        lines.push(line);
      }
    }
  }
  return lines.concat('Other IT related tasks.');
}

// Report for from..to (inclusive UK dates), optionally one user.
// Returns { days: [{ date, label, users: [{ heading, lines }] }], text, multiDay }.
async function buildReport({ from, to, userId }) {
  const range = rangeCondition(from, to);
  const params = [...range.params];
  if (userId) params.push(userId);
  const [rows] = await pool.query(`
    SELECT l.user_id, u.username, l.client_id, COALESCE(c.name, l.client_name) AS client_name,
           l.entity_type, l.entity_id, l.action, l.subject, l.summary, l.changes,
           l.report_detail, ra.id AS action_ref, ra.template AS action_template, ra.phrase_type,
           ri.name AS issue_name, ri.problem_phrase, ri.config_phrase, s.report_phrase AS service_phrase,
           l.activity_date, l.created_at, l.id
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.user_id
    LEFT JOIN clients c ON c.id = l.client_id
    LEFT JOIN report_actions ra ON ra.id = l.action_id
    LEFT JOIN report_issues ri ON ri.id = l.issue_id
    LEFT JOIN client_services cs ON cs.id = l.entity_id AND l.entity_type IN ('client_service', 'step', 'note')
    LEFT JOIN services s ON s.id = cs.service_id
    WHERE ${range.sql} ${userId ? 'AND l.user_id = ?' : ''}
    ORDER BY l.created_at, l.id
  `, params);

  const byDay = new Map();
  for (const row of rows) {
    const date = rowDay(row);
    if (date < from || date > to) continue;
    if (!byDay.has(date)) byDay.set(date, new Map());
    const users = byDay.get(date);
    const userKey = row.user_id || 0;
    if (!users.has(userKey)) users.set(userKey, { username: row.username, rows: [] });
    users.get(userKey).rows.push(row);
  }

  const days = [...byDay.keys()].sort().map((date) => ({
    date,
    label: dayLabel(date),
    users: [...byDay.get(date).values()]
      .sort((a, b) => (a.username || '~').localeCompare(b.username || '~'))
      .map((u) => ({ heading: heading(u.username), lines: userLines(u.rows) })),
  }));

  const multiDay = from !== to;
  const text = days.map((day) => {
    const blocks = day.users.map((u) => [u.heading, ...u.lines.map((l) => `- ${l}`)].join('\n'));
    return (multiDay ? `${day.label}\n\n` : '') + blocks.join('\n\n');
  }).join('\n\n\n');

  return { days, text, multiDay };
}

module.exports = {
  MAX_RANGE_DAYS, isDate, addDays, daysBetween, dayLabel, utcRange, rangeCondition, userLines, buildReport,
};
