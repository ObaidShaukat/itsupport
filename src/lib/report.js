// Daily report: built only from activity_log. A UK date (or range) is turned into a
// UTC start/end and automatic entries are matched on created_at (when the action
// happened). Manual "Log work" entries are matched on the date the user picked.
// Each user gets a "<User>'s Work:" list with one bullet per entry, built from what
// was typed (Log work text, comment text, note text), see userLines() below.
const { pool } = require('../db');
const { londonDate, londonDayStart } = require('./activity');

const MAX_RANGE_DAYS = 62;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SNIPPET_LENGTH = 200;

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
// Cleans a bullet: trimmed, no semicolons, "setup"/"set-up" at the start becomes
// "Set up", first letter capitalised, exactly one full stop at the end.
const sentence = (text) => {
  let t = clean(text).replace(/;/g, ',').replace(/[.\s]+$/, '');
  if (!t) return '';
  t = t.replace(/^set[\s-]?up\b/i, 'Set up');
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return /[!?]$/.test(t) ? t : `${t}.`;
};

// "British" list: "A", "A and B", "A, B and C".
const joinAnd = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

const mentions = (text, client) => Boolean(client) && text.toLowerCase().includes(client.toLowerCase());
// Adds " for {client}" unless there is no client or the text already names it.
const forClient = (text, client) => (client && !mentions(text, client) ? `${text} for ${client}` : text);

// ---- Bullets ----

// One user's day: one bullet per entry, in this order: client services, tickets,
// tasks, log work, knowledge base, then always "Other IT related tasks.".
//   Task completed:   "Completed task: {title} for {client}."  (no client: "Completed task: {title}.")
//   Log work:         "{text} for {client}."  (no client: "{text}.")
//   Ticket comment:   "Provided IT support to {client} regarding {comment}."  (empty comment: the ticket title)
//   Ticket created / status changed without a comment from this user:
//                     "Provided IT support to {client} regarding {title}."
//   Note:             "{note} for {client} ({service})."
//   Client services:  "Commenced {service} for {client}." / "Completed {steps} as part of
//                     {service} for {client}." / "Completed {service} for {client}."
//                     ({service} is the service's report phrase, or its name)
//   Knowledge base:   "Documented a solution for '{title}' in the knowledge base." /
//                     "Updated the knowledge base article '{title}'."
// "for {client}" is left out when the text already names the client. Exact duplicate
// lines are removed. Deletes, unticked steps, reopenings and client/user/catalogue
// changes are left out (they are listed on /activity).
function userLines(rows) {
  const section = () => ({ items: [], byKey: new Map() });
  const sections = { services: section(), tickets: section(), tasks: section(), logwork: section(), kb: section() };
  const commentedTickets = new Set();

  // Adds an item once per key; later rows for the same key update it in place.
  const item = (sec, key, create) => {
    if (!sec.byKey.has(key)) {
      const created = create();
      sec.byKey.set(key, created);
      sec.items.push(created);
    }
    return sec.byKey.get(key);
  };
  const push = (sec, text) => sec.items.push({ text: sentence(text) });

  for (const row of rows) {
    if (row.action === 'deleted') continue;
    const client = clean(row.client_name);
    const subject = withoutStop(row.subject);
    const servicePhrase = withoutStop(row.service_phrase) || subject;

    switch (row.entity_type) {
      case 'manual': {
        const text = withoutStop(row.summary);
        if (text) push(sections.logwork, forClient(text, client));
        break;
      }
      case 'ticket_comment': {
        if (!client) break;
        commentedTickets.add(row.entity_id);
        const regarding = snippet(row.summary) || subject;
        if (regarding) push(sections.tickets, `Provided IT support to ${client} regarding ${regarding}`);
        break;
      }
      case 'ticket':
        if (!client || !subject) break;
        item(sections.tickets, `ticket:${row.entity_id}`, () => ({ ticketId: row.entity_id, client, title: subject }));
        break;
      case 'note': {
        if (!client) break;
        const text = snippet(row.summary);
        if (text) push(sections.services, `${forClient(text, client)}${subject ? ` (${subject})` : ''}`);
        break;
      }
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
        const step = withoutStop(withoutPrefix(row.summary));
        if (step && !steps.steps.some((x) => x.toLowerCase() === step.toLowerCase())) steps.steps.push(step);
        break;
      }
      case 'task':
        // Only completions are reported; other task changes are on /activity.
        if (row.action === 'completed' && subject) {
          item(sections.tasks, `task:${row.entity_id}`, () => ({ text: sentence(forClient(`Completed task: ${subject}`, client)) }));
        }
        break;
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
    if (entry.ticketId !== undefined) {
      // Comment bullets already cover tickets this user commented on.
      return commentedTickets.has(entry.ticketId) ? null : sentence(`Provided IT support to ${entry.client} regarding ${entry.title}`);
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
  for (const sec of [sections.services, sections.tickets, sections.tasks, sections.logwork, sections.kb]) {
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
    SELECT l.user_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS username, l.client_id, COALESCE(c.name, l.client_name) AS client_name,
           l.entity_type, l.entity_id, l.action, l.subject, l.summary, l.changes,
           s.report_phrase AS service_phrase,
           l.activity_date, l.created_at, l.id
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.user_id
    LEFT JOIN clients c ON c.id = l.client_id
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
      .map((u) => ({ heading: heading(u.username), lines: userLines(u.rows) }))
      // Only "Other IT related tasks." means nothing to report: leave them out.
      .filter((u) => u.lines.length > 1),
  })).filter((day) => day.users.length);

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
