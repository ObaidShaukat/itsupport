// Ticket list shared by the Tickets page (Board and List views) and each client's page:
// status, priority, client, person (assigned to) and text filters, sortable columns and the
// query behind them.
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

const positiveId = (v) => (/^\d{1,10}$/.test(String(v || '')) && Number(v) > 0 ? Number(v) : null);

function readListQuery(query) {
  const sort = Object.hasOwn(SORTS, query.sort) ? query.sort : '';
  return {
    status: isTicketStatus(query.status) ? query.status : '',
    priority: isTicketPriority(query.priority) ? query.priority : '',
    sort,
    dir: sort ? (query.dir === 'asc' || query.dir === 'desc' ? query.dir : SORTS[sort][1]) : '',
    client: positiveId(query.client) || '',
    // A user id, or 'none' for unassigned tickets.
    person: query.person === 'none' ? 'none' : positiveId(query.person) || '',
    q: typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '',
    // '' when the address names no view (the Tickets page then uses the user's last choice).
    view: query.view === 'list' || query.view === 'board' ? query.view : '',
  };
}

async function listTickets({
  clientId = null, status, priority, sort, dir, client, person, q,
}) {
  const where = [];
  const params = [];
  if (clientId || client) {
    where.push('t.client_id = ?');
    params.push(clientId || client);
  }
  if (person === 'none') where.push('t.assigned_to IS NULL');
  else if (person) {
    where.push('t.assigned_to = ?');
    params.push(person);
  }
  if (q) {
    // Title, client or "#12" / "12" for the ticket number.
    const num = /^#?(\d{1,10})$/.exec(q);
    where.push(`(t.title LIKE ? OR c.name LIKE ?${num ? ' OR t.id = ?' : ''})`);
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`, `%${q.replace(/[\\%_]/g, '\\$&')}%`);
    if (num) params.push(Number(num[1]));
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
           t.assigned_to AS assigned_to_id, COALESCE(NULLIF(au.display_name, ''), au.username) AS assigned_to,
           c.id AS client_id, c.name AS client_name,
           COALESCE(NULLIF(cu.display_name, ''), cu.username) AS created_by, COALESCE(NULLIF(uu.display_name, ''), uu.username) AS updated_by,
           (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id = t.id) AS comment_count,
           (SELECT MIN(r.remind_at) FROM reminders r
            WHERE r.ticket_id = t.id AND r.status = 'pending') AS next_reminder_at,
           (SELECT COUNT(*) FROM ticket_attachments a WHERE a.ticket_id = t.id) AS attachment_count
    FROM tickets t
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users uu ON uu.id = t.updated_by
    LEFT JOIN users au ON au.id = t.assigned_to
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order}
  `, params);
  return tickets;
}

// Instant lists ([data-list] in app.js): every ticket goes to the page and is filtered there.
// Each gets its search text, filter tags, default rank (urgent first, then last updated),
// sort values and visible (whether it matches the address's filters, so the page is right
// before the script runs). ignoreStatus: the board shows every status in its own column.
const STATUS_RANK = { open: 0, customer_waiting: 1, closed: 2 };
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function instantTickets(tickets, state, { ignoreStatus = false } = {}) {
  const ranked = [...tickets].sort((a, b) => ((b.priority === 'urgent') - (a.priority === 'urgent'))
    || (new Date(b.updated_at) - new Date(a.updated_at)) || (b.id - a.id));
  ranked.forEach((t, i) => { t.rank = i; });
  const words = String(state.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of tickets) {
    t.search = [`#${t.id}`, t.title, t.client_name, TICKET_STATUSES[t.status], TICKET_PRIORITIES[t.priority], t.created_by, t.updated_by, t.assigned_to]
      .filter(Boolean).join(' ').toLowerCase();
    t.tags = [`status:${t.status}`, `priority:${t.priority}`, `client:${t.client_id}`, `person:${t.assigned_to_id || 'none'}`].join(' ');
    t.sortValues = {
      priority: PRIORITY_RANK[t.priority] ?? 9,
      id: t.id,
      title: String(t.title || '').toLowerCase(),
      client: String(t.client_name || '').toLowerCase(),
      status: STATUS_RANK[t.status] ?? 9,
      created_by: String(t.created_by || '~').toLowerCase(),
      updated_by: String(t.updated_by || '~').toLowerCase(),
      updated: new Date(t.updated_at).getTime(),
    };
    t.visible = (ignoreStatus || !state.status || t.status === state.status)
      && (!state.priority || t.priority === state.priority)
      && (!state.client || t.client_id === Number(state.client))
      && (!state.person || (state.person === 'none' ? !t.assigned_to_id : t.assigned_to_id === Number(state.person)))
      && words.every((w) => t.search.includes(w));
  }
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
    for (const key of ['status', 'priority', 'sort', 'dir', 'client', 'person', 'q', 'view']) if (next[key]) q.set(key, next[key]);
    const qs = q.toString();
    return `${base}${qs ? `?${qs}` : ''}${hash}`;
  };

  const statusFilters = [
    { key: '', label: 'All', href: href({ status: '' }), active: !state.status, count: counts.all },
    ...Object.entries(TICKET_STATUSES).map(([key, label]) => ({
      key, label, href: href({ status: key }), active: state.status === key, count: counts.status[key],
    })),
  ];
  const priorityFilters = [
    { key: '', label: 'Any', href: href({ priority: '' }), active: !state.priority, count: counts.all },
    ...['urgent', 'high', 'normal', 'low'].map((key) => ({
      key, label: TICKET_PRIORITIES[key], href: href({ priority: key }), active: state.priority === key, count: counts.priority[key],
    })),
  ];
  const columns = COLUMNS.map(([key, label]) => {
    const active = state.sort === key;
    const dir = active ? (state.dir === 'asc' ? 'desc' : 'asc') : SORTS[key][1];
    return { key, label, active, dir: active ? state.dir : null, first: SORTS[key][1], href: href({ sort: key, dir }) };
  });
  return {
    statusFilters,
    priorityFilters,
    columns,
    resetSortHref: state.sort ? href({ sort: '', dir: '' }) : null,
    href,
  };
}

module.exports = { readListQuery, listTickets, ticketCounts, listControls, instantTickets };
