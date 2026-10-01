const express = require('express');
const { pool, transaction } = require('../db');
const { str, requireId, toId, flash, notFound } = require('../lib/http');
const { TICKET_STATUSES, isTicketStatus } = require('../lib/tickets');

const router = express.Router();

async function clientOptions() {
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  return clients;
}

router.get('/', async (req, res) => {
  const status = isTicketStatus(req.query.status) ? req.query.status : '';
  const [tickets] = await pool.query(`
    SELECT t.id, t.title, t.status, t.created_at, t.updated_at,
           c.id AS client_id, c.name AS client_name, u.username AS created_by
    FROM tickets t
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN users u ON u.id = t.created_by
    ${status ? 'WHERE t.status = ?' : ''}
    ORDER BY t.updated_at DESC
  `, status ? [status] : []);
  const [countRows] = await pool.query('SELECT status, COUNT(*) AS count FROM tickets GROUP BY status');
  const counts = { all: 0 };
  for (const key of Object.keys(TICKET_STATUSES)) counts[key] = 0;
  for (const row of countRows) {
    counts[row.status] = Number(row.count);
    counts.all += Number(row.count);
  }
  res.render('tickets/index', { title: 'Tickets', tickets, status, counts });
});

router.get('/new', async (req, res) => {
  const clients = await clientOptions();
  const ticket = { client_id: toId(req.query.client_id), title: '', description: '' };
  res.render('tickets/new', { title: 'New ticket', clients, ticket, error: null });
});

router.post('/', async (req, res) => {
  const ticket = {
    client_id: toId(req.body.client_id),
    title: str(req.body.title, 255),
    description: str(req.body.description, 10000),
  };

  let error = null;
  if (!ticket.client_id) error = 'Choose a client.';
  else if (!ticket.title) error = 'Title is required.';

  let ticketId = null;
  if (!error) {
    ticketId = await transaction(async (conn) => {
      const [[client]] = await conn.query('SELECT id FROM clients WHERE id = ?', [ticket.client_id]);
      if (!client) return null;
      const [result] = await conn.query(
        "INSERT INTO tickets (client_id, title, description, status, created_by) VALUES (?, ?, ?, 'open', ?)",
        [ticket.client_id, ticket.title, ticket.description || null, req.user.id]
      );
      await conn.query(
        "INSERT INTO ticket_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, NULL, 'open')",
        [result.insertId, req.user.id]
      );
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
    SELECT t.*, c.name AS client_name, u.username AS created_by_name
    FROM tickets t
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN users u ON u.id = t.created_by
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
    SELECT th.old_status, th.new_status, th.created_at, u.username
    FROM ticket_history th
    LEFT JOIN users u ON u.id = th.user_id
    WHERE th.ticket_id = ?
    ORDER BY th.created_at DESC, th.id DESC
  `, [id]);
  res.render('tickets/show', { title: `Ticket #${ticket.id}`, ticket, comments, history });
});

router.post('/:id/status', async (req, res) => {
  const id = requireId(req.params.id);
  const status = req.body.status;
  if (!isTicketStatus(status)) {
    flash(req, 'error', 'Choose a valid status.');
    return res.redirect(`/tickets/${id}`);
  }

  const changed = await transaction(async (conn) => {
    const [[ticket]] = await conn.query('SELECT id, status FROM tickets WHERE id = ? FOR UPDATE', [id]);
    if (!ticket) throw notFound();
    if (ticket.status === status) return false;
    await conn.query('UPDATE tickets SET status = ? WHERE id = ?', [status, id]);
    await conn.query(
      'INSERT INTO ticket_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, ?, ?)',
      [id, req.user.id, ticket.status, status]
    );
    return true;
  });

  flash(req, changed ? 'success' : 'info', changed ? `Status changed to ${TICKET_STATUSES[status]}.` : 'Status unchanged.');
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
    const [[ticket]] = await conn.query('SELECT id FROM tickets WHERE id = ? FOR UPDATE', [id]);
    if (!ticket) throw notFound();
    await conn.query('INSERT INTO ticket_comments (ticket_id, user_id, body) VALUES (?, ?, ?)', [id, req.user.id, body]);
    await conn.query('UPDATE tickets SET updated_at = NOW() WHERE id = ?', [id]);
  });
  res.redirect(`/tickets/${id}#comments`);
});

module.exports = router;
