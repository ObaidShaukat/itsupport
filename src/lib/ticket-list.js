// Ticket list shared by the Tickets page and each client's page: status and
// priority filters, sortable columns and the query behind them.
const { pool } = require('../db');
const { TICKET_STATUSES, TICKET_PRIORITIES, isTicketStatus, isTicketPriority } = require('./tickets');

// Sortable columns: key -> [SQL expression (fixed, never from input), default direction].
// "asc" on priority means most urgent first.
const SORTS = {
  id: ['t.id', 'desc'],
  title: ['t.title', 'asc'],
  client: ['c.name', 'asc'],
  status: ["FIELD(t.status, 'open', 'customer_waiting', 'closed')", 'asc'],
  created_by: ["COALESCE(NULLIF(cu.display_name, ''), cu.username)", 'asc'],
  updated_by: ["COALESCE(NULLIF(uu.display_name, ''), uu.username)", 'asc'],
  updated: ['t.updated_at', 'desc'],
  priority: ["FIELD(t.priority, 'urgent', 'high', 'normal', 'low')", 'asc'],
};
// Default: urgent tickets first, then the most recently updated.
const DEFAULT_ORDER = "(t.priority = 'urgent') DESC, t.updated_at DESC, t.id DESC";

// Priority is a small flag at the start of each row (its header sorts by priority).
const COLUMNS = [
  ['priority', 'Priority'],
  ['id', '#'],
  ['title', 'Title'],
  ['client', 'Client'],
  ['status', 'Status'],
  ['created_by', 'Created by'],
  ['updated_by', 'Updated by'],
  ['updated', 'Last updated'],
];

function readListQuery(query) {
  const sort = Object.hasOwn(SORTS, query.sort) ? query.sort : '';
  return {
    status: isTicketStatus(query.status) ? query.status : '',
    priority: isTicketPriority(query.priority) ? query.priority : '',
    sort,
    dir: sort ? (query.dir === 'asc' || query.dir === 'desc' ? query.dir : SORTS[sort][1]) : '',
  };
}

async function listTickets({ clientId = null, status, priority, sort, dir }) {
  const where = [];
  const params = [];
  if (clientId) {
    where.push('t.client_id = ?');
    params.push(clientId);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  if (priority) {
    where.push('t.priority = ?');
    params.push(priority);
  }
  const order = sort ? `${SORTS[sort][0]} ${dir === 'desc' ? 'DESC' : 'ASC'}, t.updated_at DESC, t.id DESC` : DEFAULT_ORDER;
  const [tickets] = await pool.query(`
    SELECT t.id, t.title, t.status, t.priority, t.created_at, t.updated_at, t.created_by AS created_by_id, t.updated_by AS updated_by_id,
           c.id AS client_id, c.name AS client_name,
           COALESCE(NULLIF(cu.display_name, ''), cu.username) AS created_by, COALESCE(NULLIF(uu.display_name, ''), uu.username) AS updated_by,
           (SELECT MIN(COALESCE(r.snoozed_until, r.remind_at)) FROM reminders r
            WHERE r.ticket_id = t.id AND r.status = 'pending') AS next_reminder_at
    FROM tickets t
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users uu ON uu.id = t.updated_by
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order}
  `, params);
  return tickets;
}

// Counts per status and per priority (within a client, if given).
async function ticketCounts(clientId = null) {
  const [rows] = await pool.query(`
    SELECT status, priority, COUNT(*) AS count FROM tickets
    ${clientId ? 'WHERE client_id = ?' : ''}
    GROUP BY status, priority
  `, clientId ? [clientId] : []);
  const counts = { all: 0, status: {}, priority: {} };
  for (const key of Object.keys(TICKET_STATUSES)) counts.status[key] = 0;
  for (const key of Object.keys(TICKET_PRIORITIES)) counts.priority[key] = 0;
  for (const row of rows) {
    const n = Number(row.count);
    counts.all += n;
    counts.status[row.status] += n;
    counts.priority[row.priority] += n;
  }
  return counts;
}

// Filter chips and sortable headers for a list at base (e.g. "/tickets" or
// "/clients/5", with an optional #hash), keeping the other settings in the links.
function listControls(base, state, counts, hash = '') {
  const href = (changes) => {
    const next = { ...state, ...changes };
    const q = new URLSearchParams();
    for (const key of ['status', 'priority', 'sort', 'dir']) if (next[key]) q.set(key, next[key]);
    const qs = q.toString();
    return `${base}${qs ? `?${qs}` : ''}${hash}`;
  };

  const statusFilters = [
    { label: 'All', href: href({ status: '' }), active: !state.status, count: counts.all },
    ...Object.entries(TICKET_STATUSES).map(([key, label]) => ({
      label, href: href({ status: key }), active: state.status === key, count: counts.status[key],
    })),
  ];
  const priorityFilters = [
    { label: 'Any', href: href({ priority: '' }), active: !state.priority, count: counts.all },
    ...['urgent', 'high', 'normal', 'low'].map((key) => ({
      key, label: TICKET_PRIORITIES[key], href: href({ priority: key }), active: state.priority === key, count: counts.priority[key],
    })),
  ];
  const columns = COLUMNS.map(([key, label]) => {
    const active = state.sort === key;
    const dir = active ? (state.dir === 'asc' ? 'desc' : 'asc') : SORTS[key][1];
    return { key, label, active, dir: active ? state.dir : null, href: href({ sort: key, dir }) };
  });
  return {
    statusFilters,
    priorityFilters,
    columns,
    resetSortHref: state.sort ? href({ sort: '', dir: '' }) : null,
  };
}

module.exports = { readListQuery, listTickets, ticketCounts, listControls };
