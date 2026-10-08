// Daily report: built only from activity_log. A UK date (or range) is turned into a
// UTC start/end and automatic entries are matched on created_at (when the action
// happened). Manual "Log work" entries are matched on the date the user picked.
// Each user gets a "<User>'s Work:" list with one bullet per entry, see userLines()
// below. Only Log work entries and General IT Support (KB) articles are reported;
// ticket activity (comments, status, priority, reminders) and client service activity
// (commenced, steps, notes, completed) stay in the activity log and History panels.
const { pool } = require('../db');
const { londonDate, londonDayStart } = require('./activity');

const MAX_RANGE_DAYS = 62;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
// Cleans a bullet: trimmed, no semicolons, "setup"/"set-up" at the start becomes
// "Set up", first letter capitalised, exactly one full stop at the end.
const sentence = (text) => {
  let t = clean(text).replace(/;/g, ',').replace(/[.\s]+$/, '');
  if (!t) return '';
  t = t.replace(/^set[\s-]?up\b/i, 'Set up');
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return /[!?]$/.test(t) ? t : `${t}.`;
};

const mentions = (text, client) => Boolean(client) && text.toLowerCase().includes(client.toLowerCase());

// Puts the client into typed text without adding any wording of our own:
// 1. the text already names the client -> unchanged;
// 2. "...support ... regarding ..." -> "to {client}" goes right before "regarding";
// 3. otherwise " for {client}" is added at the end. No client -> unchanged.
function withClient(text, client) {
  if (!client || mentions(text, client)) return text;
  const m = /\bsupport\b[\s\S]*?\b(regarding)\b/i.exec(text);
  if (m) {
    const at = m.index + m[0].length - m[1].length;
    return `${text.slice(0, at)}to ${client} ${text.slice(at)}`;
  }
  return `${text} for ${client}`;
}

// ---- Bullets ----

// One user's day: one bullet per entry, in this order: log work, then General IT
// Support (knowledge base), then always "Other IT related tasks.".
//   Log work:         the typed text with the client put in (see withClient); no client: as typed.
//   Knowledge base:   "Documented a solution for '{title}' in the knowledge base." /
//                     "Updated the knowledge base article '{title}'."
// Typed text never gets a prefix of ours; withClient() only inserts the client. Exact
// duplicate lines are removed. Everything else (tickets, client services, deletes, sent
// reports, client/user/catalogue changes) is left out; it is listed on /activity.
function userLines(rows) {
  const logwork = [];
  const articles = new Map(); // article id -> { title, created }

  for (const row of rows) {
    if (row.action === 'deleted') continue;
    if (row.entity_type === 'manual') {
      const text = withoutStop(row.summary);
      if (text) logwork.push(sentence(withClient(text, clean(row.client_name))));
    } else if (row.entity_type === 'kb_article') {
      if (!articles.has(row.entity_id)) articles.set(row.entity_id, { title: '', created: false });
      const article = articles.get(row.entity_id);
      article.title = withoutStop(row.subject);
      if (row.action === 'created') article.created = true;
    }
    // Any other entity type is not on the report.
  }

  const kb = [...articles.values()].map((a) => (a.created
    ? sentence(`Documented a solution for '${a.title}' in the knowledge base`)
    : sentence(`Updated the knowledge base article '${a.title}'`)));

  const seen = new Set();
  const lines = [];
  for (const line of [...logwork, ...kb]) {
    if (line && !seen.has(line.toLowerCase())) {
      seen.add(line.toLowerCase());
      lines.push(line);
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
           l.activity_date, l.created_at, l.id
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.user_id
    LEFT JOIN clients c ON c.id = l.client_id
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
