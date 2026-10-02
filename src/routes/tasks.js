// Tasks: My Day / Upcoming / Overdue / Important / All / Completed, quick add, side panel.
const express = require('express');
const { pool, transaction } = require('../db');
const { str, requireId, toId, flash, notFound, safePath } = require('../lib/http');
const { logActivity, londonDate, londonLocalToUtc, toLondonInput } = require('../lib/activity');
const { VIEWS, listTasks, viewCounts, getTask } = require('../lib/tasks');

const router = express.Router();

const back = (req) => safePath(req.body.back, '/tasks');

// Task with the client it belongs to (its own, or its ticket's), for log entries.
async function taskContext(db, id, lock = false) {
  const [[task]] = await db.query(`
    SELECT t.id, t.title, t.status, t.important, t.remind_at, t.client_id, t.ticket_id,
           COALESCE(c.id, tc.id) AS log_client_id, COALESCE(c.name, tc.name) AS log_client_name
    FROM tasks t
    LEFT JOIN clients c ON c.id = t.client_id
    LEFT JOIN tickets tk ON tk.id = t.ticket_id
    LEFT JOIN clients tc ON tc.id = tk.client_id
    WHERE t.id = ? ${lock ? 'FOR UPDATE' : ''}
  `, [id]);
  if (!task) throw notFound();
  return task;
}

const logTask = (db, req, task, action, summary, changes) => logActivity(db, req.user, {
  type: 'task', id: task.id, action, summary, changes,
  clientId: task.log_client_id, clientName: task.log_client_name, subject: task.title,
});

// Form fields shared by quick add, the add form on ticket/client pages and the side panel.
async function readTaskForm(db, req) {
  const body = req.body;
  const fields = {
    title: str(body.title, 255),
    notes: str(body.notes, 10000) || null,
    important: body.important === '1' ? 1 : 0,
    due_at: londonLocalToUtc(body.due_at),
    remind_at: londonLocalToUtc(body.remind_at),
    assigned_to: Object.hasOwn(body, 'assigned_to') ? toId(body.assigned_to) : req.user.id,
    client_id: toId(body.client_id),
    ticket_id: toId(body.ticket_id),
  };
  // Quick add from My Day: due today at 17:00 (UK).
  if (!fields.due_at && body.quick_view === 'my-day') fields.due_at = londonLocalToUtc(`${londonDate()}T17:00`);
  if (body.quick_view === 'important') fields.important = 1;

  if (fields.assigned_to) {
    const [[u]] = await db.query('SELECT id FROM users WHERE id = ?', [fields.assigned_to]);
    if (!u) fields.assigned_to = null;
  }
  if (fields.ticket_id) {
    const [[t]] = await db.query('SELECT id, client_id FROM tickets WHERE id = ?', [fields.ticket_id]);
    if (!t) fields.ticket_id = null;
    else if (!fields.client_id) fields.client_id = t.client_id;
  }
  if (fields.client_id) {
    const [[c]] = await db.query('SELECT id FROM clients WHERE id = ?', [fields.client_id]);
    if (!c) fields.client_id = null;
  }
  return fields;
}

// ---- List ----

router.get('/', async (req, res) => {
  const view = Object.hasOwn(VIEWS, req.query.view) ? req.query.view : 'my-day';
  // Default is "my tasks"; user=all shows everyone's.
  const userParam = req.query.user === 'all' ? 'all' : (toId(req.query.user) || 'me');
  const filters = {
    userId: userParam === 'all' ? null : userParam === 'me' ? req.user.id : userParam,
    clientId: toId(req.query.client),
    ticketId: toId(req.query.ticket),
  };

  const [tasks, counts] = await Promise.all([listTasks(view, filters), viewCounts(filters)]);
  const [users] = await pool.query('SELECT id, username FROM users ORDER BY username');
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  const [tickets] = await pool.query(`
    SELECT t.id, t.title, c.name AS client_name FROM tickets t JOIN clients c ON c.id = t.client_id
    WHERE t.status <> 'closed' ORDER BY t.id DESC LIMIT 300
  `);

  const openId = toId(req.query.task);
  const open = openId ? await getTask(openId) : null;
  if (open && open.ticket_id && !tickets.some((t) => t.id === open.ticket_id)) {
    tickets.unshift({ id: open.ticket_id, title: open.ticket_title, client_name: open.client_name || '' });
  }

  const params = (changes) => {
    const q = new URLSearchParams();
    const next = {
      view, user: userParam === 'me' ? '' : String(userParam), client: filters.clientId || '', ticket: filters.ticketId || '', ...changes,
    };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, String(v));
    const qs = q.toString();
    return `/tasks${qs ? `?${qs}` : ''}`;
  };

  res.render('tasks/index', {
    title: 'Tasks',
    view,
    views: Object.entries(VIEWS).map(([key, label]) => ({ key, label, count: counts[key], href: params({ view: key, task: '' }), active: key === view })),
    filters,
    userParam,
    users,
    clients,
    tickets,
    tasks,
    open,
    openInputs: open ? { due_at: toLondonInput(open.due_at), remind_at: toLondonInput(open.remind_at) } : null,
    taskHref: (id) => params({ task: id }),
    closeHref: params({ task: '' }),
    listPath: params({}),
  });
});

// ---- Create ----

router.post('/', async (req, res) => {
  const fields = await readTaskForm(pool, req);
  if (!fields.title) {
    flash(req, 'error', 'Give the task a title.');
    return res.redirect(back(req));
  }
  const id = await transaction(async (conn) => {
    const [result] = await conn.query(`
      INSERT INTO tasks (title, notes, assigned_to, due_at, remind_at, important, client_id, ticket_id, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [fields.title, fields.notes, fields.assigned_to, fields.due_at, fields.remind_at, fields.important,
      fields.client_id, fields.ticket_id, req.user.id, req.user.id]);
    const task = await taskContext(conn, result.insertId);
    await logTask(conn, req, task, 'created', `Added task: ${fields.title}`);
    return result.insertId;
  });
  flash(req, 'success', 'Task added.');
  const to = back(req);
  res.redirect(to.startsWith('/tasks') ? `${to}${to.includes('?') ? '&' : '?'}task=${id}` : to);
});

// ---- Update (side panel) ----

router.post('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const fields = await readTaskForm(pool, req);
  if (!fields.title) {
    flash(req, 'error', 'Give the task a title.');
    return res.redirect(back(req));
  }
  await transaction(async (conn) => {
    const [[before]] = await conn.query('SELECT * FROM tasks WHERE id = ? FOR UPDATE', [id]);
    if (!before) throw notFound();
    const same = (a, b) => String(a ?? '') === String(b ?? '');
    const sameTime = (a, b) => (a ? new Date(a).getTime() : 0) === (b ? new Date(b).getTime() : 0);
    const changes = [];
    if (!same(before.title, fields.title)) changes.push('title');
    if (!same(before.notes, fields.notes)) changes.push('notes');
    if (!same(before.assigned_to, fields.assigned_to)) changes.push('assignee');
    if (!sameTime(before.due_at, fields.due_at)) changes.push('due date');
    if (!sameTime(before.remind_at, fields.remind_at)) changes.push('reminder');
    if (!same(before.important, fields.important)) changes.push('importance');
    if (!same(before.client_id, fields.client_id)) changes.push('client');
    if (!same(before.ticket_id, fields.ticket_id)) changes.push('ticket');

    await conn.query(`
      UPDATE tasks SET title = ?, notes = ?, assigned_to = ?, due_at = ?, remind_at = ?, important = ?,
        client_id = ?, ticket_id = ?, updated_by = ?, updated_at = NOW()
        ${changes.includes('reminder') ? ', reminder_sent_at = NULL' : ''}
      WHERE id = ?
    `, [fields.title, fields.notes, fields.assigned_to, fields.due_at, fields.remind_at, fields.important,
      fields.client_id, fields.ticket_id, req.user.id, id]);
    const task = await taskContext(conn, id);
    await logTask(conn, req, task, 'updated', changes.length ? `Updated the ${changes.join(', ')}` : 'Saved with no changes', changes);
  });
  flash(req, 'success', 'Task saved.');
  res.redirect(back(req));
});

// ---- Complete / reopen, star, delete ----

router.post('/:id/toggle', async (req, res) => {
  const id = requireId(req.params.id);
  const done = await transaction(async (conn) => {
    const task = await taskContext(conn, id, true);
    const nowDone = task.status !== 'done';
    await conn.query(
      `UPDATE tasks SET status = ?, completed_at = ${nowDone ? 'NOW()' : 'NULL'}, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [nowDone ? 'done' : 'todo', req.user.id, id]
    );
    await logTask(conn, req, task, nowDone ? 'completed' : 'reopened', `${nowDone ? 'Completed' : 'Reopened'} task: ${task.title}`);
    return nowDone;
  });
  if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true, done });
  res.redirect(back(req));
});

router.post('/:id/star', async (req, res) => {
  const id = requireId(req.params.id);
  const important = await transaction(async (conn) => {
    const task = await taskContext(conn, id, true);
    const next = task.important ? 0 : 1;
    await conn.query('UPDATE tasks SET important = ?, updated_by = ?, updated_at = NOW() WHERE id = ?', [next, req.user.id, id]);
    await logTask(conn, req, task, 'updated', next ? 'Marked as important' : 'No longer important', ['importance']);
    return next;
  });
  if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true, important: Boolean(important) });
  res.redirect(back(req));
});

router.post('/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const task = await taskContext(pool, id);
  await logTask(null, req, task, 'deleted', `Deleted task: ${task.title}`);
  await pool.query('DELETE FROM tasks WHERE id = ?', [id]);
  flash(req, 'success', 'Task deleted.');
  res.redirect(back(req).replace(/([?&])task=\d+&?/, '$1').replace(/[?&]$/, ''));
});

module.exports = router;
