// Daily report: turns activity_log entries into "<User>'s Work:" bullet lists,
// one line per client per user per day.
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

const cleanItem = (text) => String(text || '').trim().replace(/[.\s]+$/, '');
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function pushUnique(list, value) {
  const item = cleanItem(value);
  if (item && !list.includes(item)) list.push(item);
}

// One sentence for everything a user did for one client, e.g.
// "Provided IT support to ASL Solicitors regarding RDP issues, Outlook issues."
// "Configured & set up Laptops for Kansas Chicken."
// "Managed Email setup for VSPG Housing."
function clientLine(entry) {
  const managed = entry.managed.filter((name) => !entry.setup.includes(name));
  const segments = [];
  let named = false;
  if (entry.tickets.length) {
    segments.push(`provided IT support to ${entry.name} regarding ${entry.tickets.join(', ')}`);
    named = true;
  }
  if (entry.setup.length) {
    segments.push(`configured & set up ${entry.setup.join(', ')}${named ? '' : ` for ${entry.name}`}`);
    named = true;
  }
  if (managed.length) {
    segments.push(`managed ${managed.join(', ')}${named ? '' : ` for ${entry.name}`}`);
  }
  return segments.length ? `${capitalise(segments.join('; '))}.` : null;
}

// Lines for one user on one day, in the order the work happened.
function userLines(rows) {
  const lines = [];
  const clients = new Map();

  for (const row of rows) {
    if (row.entity_type === 'manual') {
      lines.push({ order: lines.length, text: row.summary, manual: true });
      continue;
    }
    // Catalogue and knowledge-base work has no client; it is covered by
    // the closing "Other IT related tasks." line.
    if (!row.client_name || row.action === 'deleted') continue;

    const key = row.client_id ? `id:${row.client_id}` : `name:${row.client_name}`;
    let entry = clients.get(key);
    if (!entry) {
      entry = { name: row.client_name, order: lines.length, tickets: [], setup: [], managed: [] };
      clients.set(key, entry);
      lines.push(entry);
    }

    switch (row.entity_type) {
      case 'ticket':
      case 'ticket_comment':
        pushUnique(entry.tickets, row.subject);
        break;
      case 'client_service':
        if (row.action === 'created' || row.action === 'closed') pushUnique(entry.setup, row.subject);
        else pushUnique(entry.managed, row.subject);
        break;
      case 'step':
        if (row.action === 'step_done') pushUnique(entry.managed, row.subject);
        break;
      case 'note':
        pushUnique(entry.managed, row.subject);
        break;
      default:
        break;
    }
  }

  return lines
    .map((line) => (line.manual ? line.text : clientLine(line)))
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
           l.entity_type, l.action, l.subject, l.summary, l.activity_date, l.created_at, l.id
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
