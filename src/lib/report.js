// Daily report: built only from activity_log. A UK date (or range) is turned into a
// UTC start/end and automatic entries are matched on created_at (when the action
// happened). Manual "Log work" entries are matched on the date the user picked.
// Each user gets a "<User>'s Work:" list, one bullet per item, grouped by client.
const { pool } = require('../db');
const { londonDate, londonDayStart } = require('./activity');

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
// Capital first letter, full stop at the end, no semicolons.
const sentence = (text) => {
  const t = clean(text).replace(/;/g, ',');
  if (!t) return '';
  const capitalised = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};
const joinAnd = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

const KB_FIELD_LABELS = {
  title: 'title',
  category: 'category',
  tags: 'tags',
  issue: 'issue description',
  solution: 'solution',
  attachments: 'attachments',
};
const KB_FIELD_ORDER = Object.keys(KB_FIELD_LABELS);

// ---- Bullets ----

// One user's day as bullets, one per item, grouped by client in the order the
// work happened, then work with no client, then "Other IT related tasks.".
//   Ticket:            Provided IT support to {client} regarding {title}.
//   Comment:           Provided IT support to {client} regarding {title}: {comment}.
//   Service assigned:  Started {service} for {client}.
//   Service closed:    Completed {service} for {client}.
//   Step ticked:       Completed {step} as part of {service} for {client}.
//   Note:              Carried out {service} for {client}: {note}.
//   Client:            Added {client} as a new client. / Updated the client details for {client}.
//   KB created:        Documented a solution for '{title}' in the General IT Support knowledge base.
//   KB edited:         Updated the knowledge base article '{title}': revised the {fields}.
//   Service catalogue: Added/Updated the {service} service process.
//   Manual entry:      as written (under its client if it has one).
// Deletes, unticked steps, reopenings and user-admin changes are left out (see /activity).
function userLines(rows) {
  const groups = new Map();
  const general = { items: [], byKey: new Map() };

  const groupFor = (row) => {
    const key = row.client_id ? `id:${row.client_id}` : `name:${row.client_name}`;
    if (!groups.has(key)) groups.set(key, { items: [], byKey: new Map() });
    return groups.get(key);
  };
  // Adds an item once per key; later rows for the same key update it in place.
  const item = (group, key, create) => {
    if (!group.byKey.has(key)) {
      const created = create();
      group.byKey.set(key, created);
      group.items.push(created);
    }
    return group.byKey.get(key);
  };
  const push = (group, text) => group.items.push({ text });

  for (const row of rows) {
    const client = clean(row.client_name);
    const subject = withoutStop(row.subject);

    if (row.entity_type === 'manual') {
      push(client ? groupFor(row) : general, sentence(row.summary));
      continue;
    }
    if (row.action === 'deleted') continue;

    switch (row.entity_type) {
      case 'ticket': {
        if (!client) break;
        // One bullet per ticket, unless the user commented: then each comment is a bullet.
        const t = item(groupFor(row), `ticket:${row.entity_id}`, () => ({ text: null }));
        if (!t.commented) t.text = sentence(`Provided IT support to ${client} regarding ${subject}`);
        break;
      }
      case 'ticket_comment': {
        if (!client) break;
        const group = groupFor(row);
        const t = item(group, `ticket:${row.entity_id}`, () => ({ text: null }));
        t.commented = true;
        t.text = null;
        push(group, sentence(`Provided IT support to ${client} regarding ${subject}: ${snippet(row.summary)}`));
        break;
      }
      case 'client_service': {
        if (!client) break;
        if (row.action === 'created') {
          item(groupFor(row), `cs-start:${row.entity_id}`, () => ({ text: sentence(`Started ${subject} for ${client}`) }));
        } else if (row.action === 'closed') {
          item(groupFor(row), `cs-done:${row.entity_id}`, () => ({ text: sentence(`Completed ${subject} for ${client}`) }));
        }
        break;
      }
      case 'step': {
        if (!client || row.action !== 'step_done') break;
        const step = withoutStop(withoutPrefix(row.summary));
        if (!step) break;
        item(groupFor(row), `step:${row.entity_id}:${step.toLowerCase()}`, () => ({
          text: sentence(`Completed ${step} as part of ${subject} for ${client}`),
        }));
        break;
      }
      case 'note':
        if (!client) break;
        push(groupFor(row), sentence(`Carried out ${subject} for ${client}: ${snippet(row.summary)}`));
        break;
      case 'client':
        if (!client) break;
        if (row.action === 'created') {
          item(groupFor(row), 'client:created', () => ({ text: sentence(`Added ${client} as a new client`) }));
        } else {
          item(groupFor(row), 'client:updated', () => ({ text: sentence(`Updated the client details for ${client}`) }));
        }
        break;
      case 'kb_article': {
        const a = item(general, `kb:${row.entity_id}`, () => ({ kb: true, created: false, changes: new Set() }));
        a.title = subject;
        if (row.action === 'created') a.created = true;
        for (const c of String(row.changes || '').split(',')) if (KB_FIELD_LABELS[c]) a.changes.add(c);
        if (row.action === 'uploaded') a.changes.add('attachments');
        break;
      }
      case 'service':
      case 'tutorial': {
        if (!row.entity_id) {
          item(general, `category:${subject}`, () => ({ text: sentence(`Updated the ${subject} service category`) }));
          break;
        }
        const svc = item(general, `service:${row.entity_id}`, () => ({ service: true, created: false }));
        svc.name = subject;
        if (row.entity_type === 'service' && row.action === 'created') svc.created = true;
        break;
      }
      default:
        break;
    }
  }

  const render = (entry) => {
    if (entry.kb) {
      if (entry.created) return sentence(`Documented a solution for '${entry.title}' in the General IT Support knowledge base`);
      const fields = KB_FIELD_ORDER.filter((c) => entry.changes.has(c)).map((c) => KB_FIELD_LABELS[c]);
      return sentence(`Updated the knowledge base article '${entry.title}'${fields.length ? `: revised the ${joinAnd(fields)}` : ''}`);
    }
    if (entry.service) return sentence(`${entry.created ? 'Added' : 'Updated'} the ${entry.name} service process`);
    return entry.text || null;
  };

  return [...groups.values(), general]
    .flatMap((group) => group.items.map(render))
    .filter(Boolean)
    .concat('Other IT related tasks.');
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
      .map((u) => ({ heading: heading(u.username), lines: userLines(u.rows) })),
  }));

  const multiDay = from !== to;
  const text = days.map((day) => {
    const blocks = day.users.map((u) => [u.heading, ...u.lines.map((l) => `• ${l}`)].join('\n'));
    return (multiDay ? `${day.label}\n\n` : '') + blocks.join('\n\n');
  }).join('\n\n\n');

  return { days, text, multiDay };
}

module.exports = {
  MAX_RANGE_DAYS, isDate, addDays, daysBetween, dayLabel, utcRange, rangeCondition, userLines, buildReport,
};
