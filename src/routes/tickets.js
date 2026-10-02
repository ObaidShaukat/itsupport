const express = require('express');
const { pool, transaction } = require('../db');
const { str, requireId, toId, flash, notFound, safePath } = require('../lib/http');
const { TICKET_STATUSES, TICKET_PRIORITIES, isTicketStatus, isTicketPriority } = require('../lib/tickets');
const { readListQuery, listTickets, ticketCounts, listControls } = require('../lib/ticket-list');
const { logActivity, historyFor, recordMeta } = require('../lib/activity');

const ticketEntry = (ticket, type, action, summary) => ({
  type, id: ticket.id, action, summary, clientId: ticket.client_id, clientName: ticket.client_name, subject: ticket.title,
});

async function ticketContext(db, id, lock = false) {
  const [[ticket]] = await db.query(`
    SELECT t.id, t.title, t.status, t.priority, t.client_id, c.name AS client_name
    FROM tickets t
    JOIN clients c ON c.id = t.client_id
    WHERE t.id = ? ${lock ? 'FOR UPDATE' : ''}
  `, [id]);
  if (!ticket) throw notFound();
  return ticket;
}

const router = express.Router();

async function clientOptions() {
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  return clients;
}

router.get('/', async (req, res) => {
  const state = readListQuery(req.query);
  const tickets = await listTickets(state);
  const controls = listControls('/tickets', state, await ticketCounts());
  res.render('tickets/index', { title: 'Tickets', tickets, state, controls });
});

router.get('/new', async (req, res) => {
  const clients = await clientOptions();
  const ticket = { client_id: toId(req.query.client_id), title: '', description: '', priority: 'normal' };
  res.render('tickets/new', { title: 'New ticket', clients, ticket, error: null });
});

router.post('/', async (req, res) => {
  const ticket = {
    client_id: toId(req.body.client_id),
    title: str(req.body.title, 255),
    description: str(req.body.description, 10000),
    priority: isTicketPriority(req.body.priority) ? req.body.priority : 'normal',
  };

  let error = null;
  if (!ticket.client_id) error = 'Choose a client.';
  else if (!ticket.title) error = 'Title is required.';

  let ticketId = null;
  if (!error) {
    ticketId = await transaction(async (conn) => {
      const [[client]] = await conn.query('SELECT id, name FROM clients WHERE id = ?', [ticket.client_id]);
      if (!client) return null;
      const [result] = await conn.query(
        "INSERT INTO tickets (client_id, title, description, status, priority, created_by, updated_by) VALUES (?, ?, ?, 'open', ?, ?, ?)",
        [ticket.client_id, ticket.title, ticket.description || null, ticket.priority, req.user.id, req.user.id]
      );
      await conn.query(
        "INSERT INTO ticket_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, NULL, 'open')",
        [result.insertId, req.user.id]
      );
      await logActivity(conn, req.user, ticketEntry(
        { id: result.insertId, title: ticket.title, client_id: client.id, client_name: client.name },
        'ticket', 'created', `Opened ticket #${result.insertId}: ${ticket.title} (${TICKET_PRIORITIES[ticket.priority]} priority)`
      ));
      return result.insertId;
    });
    if (!ticketId) error = 'That client no longer exists.';
  }

  if (error) {
    const clients = await clientOptions();
    return res.status(400).render('tickets/new', { title: 'New ticket', clients, ticket, error });
  }
  flash(req, 'success', 'Ticket created.');
  res.redirect(`/tickets/${ticketId}`);
});

router.get('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[ticket]] = await pool.query(`
    SELECT t.*, c.name AS client_name, u.username AS created_by_name, uu.username AS updated_by_name
    FROM tickets t
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN users uu ON uu.id = t.updated_by
    WHERE t.id = ?
  `, [id]);
  if (!ticket) throw notFound();
  const [comments] = await pool.query(`
    SELECT tc.id, tc.body, tc.created_at, u.username
    FROM ticket_comments tc
    LEFT JOIN users u ON u.id = tc.user_id
    WHERE tc.ticket_id = ?
    ORDER BY tc.created_at, tc.id
  `, [id]);
  const [history] = await pool.query(`
    SELECT th.old_status, th.new_status, th.old_priority, th.new_priority, th.created_at, u.username
    FROM ticket_history th
    LEFT JOIN users u ON u.id = th.user_id
    WHERE th.ticket_id = ?
    ORDER BY th.created_at DESC, th.id DESC
  `, [id]);
  const activity = await historyFor(['ticket', 'ticket_comment'], [id]);
  const meta = recordMeta(activity, 'ticket', { createdBy: ticket.created_by_name, createdAt: ticket.created_at });
  res.render('tickets/show', { title: `Ticket #${ticket.id}`, ticket, comments, history, activity, meta });
});

router.post('/:id/status', async (req, res) => {
  const id = requireId(req.params.id);
  const status = req.body.status;
  if (!isTicketStatus(status)) {
    flash(req, 'error', 'Choose a valid status.');
    return res.redirect(`/tickets/${id}`);
  }

  const changed = await transaction(async (conn) => {
    const ticket = await ticketContext(conn, id, true);
    if (ticket.status === status) return false;
    await conn.query('UPDATE tickets SET status = ?, updated_by = ?, updated_at = NOW() WHERE id = ?', [status, req.user.id, id]);
    await conn.query(
      'INSERT INTO ticket_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, ?, ?)',
      [id, req.user.id, ticket.status, status]
    );
    await logActivity(conn, req.user, ticketEntry(
      ticket, 'ticket', 'status_changed', `Status: ${TICKET_STATUSES[ticket.status]} → ${TICKET_STATUSES[status]}`
    ));
    return true;
  });

  flash(req, changed ? 'success' : 'info', changed ? `Status changed to ${TICKET_STATUSES[status]}.` : 'Status unchanged.');
  res.redirect(`/tickets/${id}`);
});

router.post('/:id/priority', async (req, res) => {
  const id = requireId(req.params.id);
  const priority = req.body.priority;
  if (!isTicketPriority(priority)) {
    flash(req, 'error', 'Choose a valid priority.');
    return res.redirect(`/tickets/${id}`);
  }

  const changed = await transaction(async (conn) => {
    const ticket = await ticketContext(conn, id, true);
    if (ticket.priority === priority) return false;
    await conn.query('UPDATE tickets SET priority = ?, updated_by = ?, updated_at = NOW() WHERE id = ?', [priority, req.user.id, id]);
    await conn.query(
      'INSERT INTO ticket_history (ticket_id, user_id, old_priority, new_priority) VALUES (?, ?, ?, ?)',
      [id, req.user.id, ticket.priority, priority]
    );
    await logActivity(conn, req.user, ticketEntry(
      ticket, 'ticket', 'updated', `Priority: ${TICKET_PRIORITIES[ticket.priority]} → ${TICKET_PRIORITIES[priority]}`
    ));
    return true;
  });

  flash(req, changed ? 'success' : 'info', changed ? `Priority changed to ${TICKET_PRIORITIES[priority]}.` : 'Priority unchanged.');
  res.redirect(`/tickets/${id}`);
});

// Edits the title and description.
router.post('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const title = str(req.body.title, 255);
  const description = str(req.body.description, 10000);
  if (!title) {
    flash(req, 'error', 'Title is required.');
    return res.redirect(`/tickets/${id}`);
  }
  await transaction(async (conn) => {
    const [[before]] = await conn.query('SELECT title, description FROM tickets WHERE id = ? FOR UPDATE', [id]);
    if (!before) throw notFound();
    const changes = [];
    if (before.title !== title) changes.push('title');
    if ((before.description || '') !== description) changes.push('description');
    await conn.query(
      'UPDATE tickets SET title = ?, description = ?, updated_by = ?, updated_at = NOW() WHERE id = ?',
      [title, description || null, req.user.id, id]
    );
    const ticket = await ticketContext(conn, id);
    await logActivity(conn, req.user, {
      ...ticketEntry(ticket, 'ticket', 'updated', changes.length ? `Edited the ${changes.join(' and ')}` : 'Saved with no changes'),
      changes,
    });
  });
  flash(req, 'success', 'Ticket updated.');
  res.redirect(`/tickets/${id}`);
});

router.post('/:id/comments', async (req, res) => {
  const id = requireId(req.params.id);
  const body = str(req.body.body, 10000);
  if (!body) {
    flash(req, 'error', 'Comment cannot be empty.');
    return res.redirect(`/tickets/${id}#comments`);
  }
  await transaction(async (conn) => {
    const ticket = await ticketContext(conn, id, true);
    await conn.query('INSERT INTO ticket_comments (ticket_id, user_id, body) VALUES (?, ?, ?)', [id, req.user.id, body]);
    await logActivity(conn, req.user, ticketEntry(ticket, 'ticket_comment', 'commented', body));
    await conn.query('UPDATE tickets SET updated_by = ?, updated_at = NOW() WHERE id = ?', [req.user.id, id]);
  });
  res.redirect(`/tickets/${id}#comments`);
});

// Deletes the ticket with its comments and status history (ON DELETE CASCADE).
// The activity log keeps its entries (with the title snapshot), so past reports are
// unchanged. Returns to the list it was deleted from (back), or the client's tickets.
router.post('/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const ticket = await ticketContext(pool, id);
  await logActivity(null, req.user, ticketEntry(ticket, 'ticket', 'deleted', `Deleted ticket #${id}: ${ticket.title}`));
  await pool.query('DELETE FROM tickets WHERE id = ?', [id]);
  flash(req, 'success', `Ticket #${id} "${ticket.title}" deleted.`);
  res.redirect(safePath(req.body.back, `/clients/${ticket.client_id}#tickets`));
});

module.exports = router;
