// Tasks (like Microsoft To Do): views, filters and queries.
const { pool } = require('../db');
const { londonDate, londonDayStart } = require('./activity');
const { addDays } = require('./report');

const VIEWS = {
  'my-day': 'My Day',
  upcoming: 'Upcoming',
  overdue: 'Overdue',
  important: 'Important',
  all: 'All',
  completed: 'Completed',
};

// SQL (alias t) for each view. "Today" is the UK day; NOW() is MySQL's UTC time.
function viewCondition(view) {
  const today = londonDate();
  const start = londonDayStart(today);
  const end = londonDayStart(addDays(today, 1));
  switch (view) {
    case 'my-day': return { sql: "t.status = 'todo' AND t.due_at >= ? AND t.due_at < ?", params: [start, end] };
    case 'upcoming': return { sql: "t.status = 'todo' AND t.due_at >= ?", params: [end] };
    case 'overdue': return { sql: "t.status = 'todo' AND t.due_at < NOW()", params: [] };
    case 'important': return { sql: "t.status = 'todo' AND t.important = 1", params: [] };
    case 'completed': return { sql: "t.status = 'done'", params: [] };
    default: return { sql: "t.status = 'todo'", params: [] };
  }
}

// filters: { userId: number|null (assigned to), clientId, ticketId }
function filterCondition(filters) {
  const where = [];
  const params = [];
  if (filters.userId) {
    where.push('t.assigned_to = ?');
    params.push(filters.userId);
  }
  if (filters.clientId) {
    where.push('t.client_id = ?');
    params.push(filters.clientId);
  }
  if (filters.ticketId) {
    where.push('t.ticket_id = ?');
    params.push(filters.ticketId);
  }
  return { where, params };
}

const TASK_SELECT = `
  SELECT t.id, t.title, t.notes, t.status, t.important, t.due_at, t.remind_at, t.completed_at,
         t.created_at, t.updated_at, t.assigned_to, t.client_id, t.ticket_id,
         (t.status = 'todo' AND t.due_at < NOW()) AS overdue,
         c.name AS client_name, tk.title AS ticket_title,
         COALESCE(NULLIF(au.display_name, ''), au.username) AS assigned_name, COALESCE(NULLIF(cu.display_name, ''), cu.username) AS created_name, COALESCE(NULLIF(uu.display_name, ''), uu.username) AS updated_name
  FROM tasks t
  LEFT JOIN clients c ON c.id = t.client_id
  LEFT JOIN tickets tk ON tk.id = t.ticket_id
  LEFT JOIN users au ON au.id = t.assigned_to
  LEFT JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users uu ON uu.id = t.updated_by
`;

async function listTasks(view, filters) {
  const v = viewCondition(view);
  const f = filterCondition(filters);
  const where = [v.sql, ...f.where];
  const order = view === 'completed'
    ? 't.completed_at DESC, t.id DESC'
    : 't.important DESC, t.due_at IS NULL, t.due_at, t.created_at DESC';
  const [rows] = await pool.query(
    `${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`,
    [...v.params, ...f.params]
  );
  return rows;
}

async function viewCounts(filters) {
  const f = filterCondition(filters);
  const counts = {};
  for (const view of Object.keys(VIEWS)) {
    const v = viewCondition(view);
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS n FROM tasks t WHERE ${[v.sql, ...f.where].join(' AND ')}`,
      [...v.params, ...f.params]
    );
    counts[view] = Number(row.n);
  }
  return counts;
}

async function getTask(id) {
  const [[task]] = await pool.query(`${TASK_SELECT} WHERE t.id = ?`, [id]);
  return task || null;
}

// Tasks linked to a ticket or a client, open ones first (for the Tasks panels).
async function linkedTasks(column, id) {
  if (!['ticket_id', 'client_id'].includes(column)) throw new Error('Bad column');
  const [rows] = await pool.query(
    `${TASK_SELECT} WHERE t.${column} = ? ORDER BY t.status = 'done', t.important DESC, t.due_at IS NULL, t.due_at, t.created_at DESC LIMIT 100`,
    [id]
  );
  return rows;
}

module.exports = { VIEWS, listTasks, viewCounts, getTask, linkedTasks };
