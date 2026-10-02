// Daily report: built only from activity_log entries whose activity_date (the UK
// date the action happened) is in the chosen range. Each user gets a "<User>'s Work:"
// bullet list, one bullet per item, grouped by client.
const { pool } = require('../db');

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

// "obaid" -> "Obaid's Work:"
function heading(username) {
  const name = username ? username.charAt(0).toUpperCase() + username.slice(1) : 'Former user';
  return `${name}'s Work:`;
}

const SNIPPET_LENGTH = 150;

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const withoutStop = (text) => clean(text).replace(/[.\s]+$/, '');
const snippet = (text) => {
  const t = withoutStop(text);
  return t.length > SNIPPET_LENGTH ? `${t.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…` : t;
};
// Ends a bullet with a full stop unless it already ends with punctuation.
const sentence = (text) => {
  const t = clean(text);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

// One user's day as bullets, one per item, grouped by client (in the order the
// work happened), then work with no client, then "Other IT related tasks.".
//   Ticket:               Provided IT support to Abel regarding Test.
//   Comment:              Provided IT support to Abel regarding Test: <comment>.
//   Service assigned/closed: Configured & set up Laptops for Abel.
//   Steps ticked:         Managed Email setup for Abel: Create new tenant, Add domain.
//   Note added/edited:    Laptops for Abel: new check.
//   Client added/edited:  Added new client: Abel. / Updated client details for Abel.
//   KB article:           Created/Updated General IT Support article: Outlook not syncing.
//   Service catalogue:    Added/Updated service process: Emails setup.
//   Manual entry:         as written (under its client if it has one).
// Deletes, unticked steps and user-admin changes are left out (see /activity).
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
    const client = row.client_name;
    const subject = withoutStop(row.subject);

    if (row.entity_type === 'manual') {
      push(client ? groupFor(row) : general, sentence(row.summary));
      continue;
    }
    if (row.action === 'deleted') continue;

    switch (row.entity_type) {
      case 'ticket': {
        if (!client) break;
        // One bullet per ticket, unless the user commented (each comment is its own bullet).
        const t = item(groupFor(row), `ticket:${row.entity_id}`, () => ({ ticket: true, text: null }));
        if (!t.commented) t.text = `Provided IT support to ${client} regarding ${subject}.`;
        break;
      }
      case 'ticket_comment': {
        if (!client) break;
        const group = groupFor(row);
        const t = group.byKey.get(`ticket:${row.entity_id}`);
        if (t && !t.commented) {
          // Replace the plain ticket bullet with the comment bullets.
          t.text = null;
          t.commented = true;
        }
        if (!t) group.byKey.set(`ticket:${row.entity_id}`, { ticket: true, commented: true, text: null });
        push(group, sentence(`Provided IT support to ${client} regarding ${subject}: ${snippet(row.summary)}`));
        break;
      }
      case 'client_service': {
        if (!client) break;
        const group = groupFor(row);
        if (row.action === 'created' || row.action === 'closed') {
          item(group, `setup:${row.entity_id}`, () => ({ text: `Configured & set up ${subject} for ${client}.` }));
        } else {
          const m = item(group, `managed:${row.entity_id}`, () => ({ steps: [] }));
          m.service = subject;
          m.client = client;
        }
        break;
      }
      case 'step': {
        if (!client || row.action !== 'step_done') break;
        const m = item(groupFor(row), `managed:${row.entity_id}`, () => ({ steps: [] }));
        m.service = subject;
        m.client = client;
        const step = withoutStop(row.summary);
        if (step && !m.steps.includes(step)) m.steps.push(step);
        break;
      }
      case 'note':
        if (!client) break;
        push(groupFor(row), sentence(`${subject} for ${client}: ${snippet(row.summary)}`));
        break;
      case 'client':
        if (!client) break;
        if (row.action === 'created') {
          item(groupFor(row), 'client:created', () => ({ text: `Added new client: ${client}.` }));
        } else {
          item(groupFor(row), 'client:updated', () => ({ text: `Updated client details for ${client}.` }));
        }
        break;
      case 'kb_article': {
        const a = item(general, `kb:${row.entity_id}`, () => ({ created: false }));
        if (row.action === 'created') a.created = true;
        a.text = `${a.created ? 'Created' : 'Updated'} General IT Support article: ${subject}.`;
        break;
      }
      case 'service':
      case 'tutorial': {
        if (!row.entity_id) {
          item(general, `category:${subject}`, () => ({ text: `Updated service category: ${subject}.` }));
          break;
        }
        const svc = item(general, `service:${row.entity_id}`, () => ({ created: false }));
        if (row.entity_type === 'service' && row.action === 'created') svc.created = true;
        svc.text = `${svc.created ? 'Added' : 'Updated'} service process: ${subject}.`;
        break;
      }
      default:
        break;
    }
  }

  const render = (entry) => {
    if (entry.steps) {
      if (!entry.service) return null;
      return entry.steps.length
        ? sentence(`Managed ${entry.service} for ${entry.client}: ${snippet(entry.steps.join(', '))}`)
        : `Managed ${entry.service} for ${entry.client}.`;
    }
    return entry.text || null;
  };

  return [...groups.values(), general]
    .flatMap((group) => group.items.map(render))
    .filter(Boolean)
    .concat('Other IT related tasks.');
}

// Report for from..to (inclusive), optionally one user.
// Returns { days: [{ date, label, users: [{ heading, lines }] }], text }.
async function buildReport({ from, to, userId }) {
  const params = [from, to];
  if (userId) params.push(userId);
  const [rows] = await pool.query(`
    SELECT l.user_id, u.username, l.client_id, COALESCE(c.name, l.client_name) AS client_name,
           l.entity_type, l.entity_id, l.action, l.subject, l.summary, l.activity_date, l.created_at, l.id
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.user_id
    LEFT JOIN clients c ON c.id = l.client_id
    WHERE l.activity_date BETWEEN ? AND ? ${userId ? 'AND l.user_id = ?' : ''}
    ORDER BY l.activity_date, l.created_at, l.id
  `, params);

  const byDay = new Map();
  for (const row of rows) {
    const date = String(row.activity_date).slice(0, 10);
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

module.exports = { MAX_RANGE_DAYS, isDate, addDays, daysBetween, dayLabel, userLines, buildReport };
