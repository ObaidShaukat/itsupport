const express = require('express');
const { pool, transaction } = require('../db');
const { str, requireId, toId, flash, notFound } = require('../lib/http');
const { readListQuery, listTickets, ticketCounts, listControls } = require('../lib/ticket-list');
const { logActivity, historyFor, clientHistory, recordMeta } = require('../lib/activity');

const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readClient(body) {
  return {
    name: str(body.name, 200),
    contact_name: str(body.contact_name, 200),
    email: str(body.email, 254),
    phone: str(body.phone, 50),
    notes: str(body.notes, 5000),
  };
}

function validateClient(client) {
  if (!client.name) return 'Client name is required.';
  if (client.email && !EMAIL_PATTERN.test(client.email)) return 'Enter a valid email address.';
  return null;
}

// Empty optional fields are stored as NULL.
const clientValues = (c) => [c.name, c.contact_name || null, c.email || null, c.phone || null, c.notes || null];

const emptyClient = { name: '', contact_name: '', email: '', phone: '', notes: '' };

// Client service with its client, for log entries.
async function csContext(db, csId, lock = false) {
  const [[cs]] = await db.query(`
    SELECT cs.id, cs.client_id, cs.service_name, cs.status, c.name AS client_name
    FROM client_services cs
    JOIN clients c ON c.id = cs.client_id
    WHERE cs.id = ? ${lock ? 'FOR UPDATE' : ''}
  `, [csId]);
  if (!cs) throw notFound();
  return cs;
}

const csEntry = (cs, type, action, summary) => ({
  type, id: cs.id, action, summary, clientId: cs.client_id, clientName: cs.client_name, subject: cs.service_name,
});

// ---- Clients ----

router.get('/clients', async (req, res) => {
  const [clients] = await pool.query(`
    SELECT c.id, c.name, c.contact_name, c.email, c.phone,
      (SELECT COUNT(*) FROM tickets t WHERE t.client_id = c.id AND t.status <> 'closed') AS active_tickets,
      (SELECT COUNT(*) FROM client_services cs WHERE cs.client_id = c.id AND cs.status = 'open') AS open_services
    FROM clients c
    ORDER BY c.name
  `);
  res.render('clients/index', { title: 'Clients', clients });
});

router.get('/clients/new', (req, res) => {
  res.render('clients/form', { title: 'New client', client: emptyClient, action: '/clients', error: null });
});

router.post('/clients', async (req, res) => {
  const client = readClient(req.body);
  const problem = validateClient(client);
  if (problem) {
    return res.status(400).render('clients/form', { title: 'New client', client, action: '/clients', error: problem });
  }
  const [result] = await pool.query(
    'INSERT INTO clients (name, contact_name, email, phone, notes) VALUES (?, ?, ?, ?, ?)',
    clientValues(client)
  );
  await logActivity(null, req.user, {
    type: 'client', id: result.insertId, action: 'created', clientId: result.insertId, clientName: client.name,
    subject: client.name, summary: `Added client ${client.name}`,
  });
  flash(req, 'success', `Client "${client.name}" added.`);
  res.redirect(`/clients/${result.insertId}`);
});

router.get('/clients/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[client]] = await pool.query('SELECT * FROM clients WHERE id = ?', [id]);
  if (!client) throw notFound();

  const [clientServices] = await pool.query(`
    SELECT cs.id, cs.service_id, cs.service_name, cs.status, cs.created_at, cs.closed_at, u.username AS assigned_by
    FROM client_services cs
    LEFT JOIN users u ON u.id = cs.assigned_by
    WHERE cs.client_id = ?
    ORDER BY cs.status = 'closed', cs.created_at DESC
  `, [id]);
  const [steps] = await pool.query(`
    SELECT css.id, css.client_service_id, css.title, css.done, css.done_at, u.username AS done_by
    FROM client_service_steps css
    JOIN client_services cs ON cs.id = css.client_service_id
    LEFT JOIN users u ON u.id = css.done_by
    WHERE cs.client_id = ?
    ORDER BY css.position, css.id
  `, [id]);
  const [notes] = await pool.query(`
    SELECT n.id, n.client_service_id, n.body, n.created_at, n.updated_at,
           u.username AS author, e.username AS editor
    FROM client_service_notes n
    JOIN client_services cs ON cs.id = n.client_service_id
    LEFT JOIN users u ON u.id = n.user_id
    LEFT JOIN users e ON e.id = n.updated_by
    WHERE cs.client_id = ?
    ORDER BY n.created_at DESC, n.id DESC
  `, [id]);
  const csHistory = await historyFor(['client_service', 'step', 'note'], clientServices.map((cs) => cs.id));
  for (const cs of clientServices) {
    cs.steps = steps.filter((s) => s.client_service_id === cs.id);
    cs.doneCount = cs.steps.filter((s) => s.done).length;
    cs.notes = notes.filter((n) => n.client_service_id === cs.id);
    cs.history = csHistory.filter((e) => e.entity_id === cs.id);
    cs.meta = recordMeta(cs.history, 'client_service', { createdBy: cs.assigned_by, createdAt: cs.created_at });
  }
  const clientMeta = recordMeta(await historyFor(['client'], [id]), 'client', { createdAt: client.created_at });
  const activity = await clientHistory(id);

  const ticketState = readListQuery(req.query);
  const tickets = await listTickets({ ...ticketState, clientId: id });
  const ticketControls = listControls(`/clients/${id}`, ticketState, await ticketCounts(id), '#tickets');

  const [catalogue] = await pool.query(`
    SELECT s.id, s.name, c.id AS category_id, c.name AS category_name
    FROM services s
    JOIN service_categories c ON c.id = s.category_id
    ORDER BY c.name, c.id, s.name
  `);
  const serviceGroups = [];
  for (const s of catalogue) {
    let group = serviceGroups.at(-1);
    if (!group || group.id !== s.category_id) {
      group = { id: s.category_id, name: s.category_name, services: [] };
      serviceGroups.push(group);
    }
    group.services.push(s);
  }

  res.render('clients/show', {
    title: client.name, client, clientMeta, activity, clientServices, tickets, ticketState, ticketControls, serviceGroups,
  });
});

router.get('/clients/:id/edit', async (req, res) => {
  const id = requireId(req.params.id);
  const [[client]] = await pool.query('SELECT * FROM clients WHERE id = ?', [id]);
  if (!client) throw notFound();
  for (const key of Object.keys(emptyClient)) client[key] ??= '';
  res.render('clients/form', { title: `Edit ${client.name}`, client, action: `/clients/${id}`, error: null });
});

router.post('/clients/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const client = readClient(req.body);
  client.id = id;
  const problem = validateClient(client);
  if (problem) {
    return res.status(400).render('clients/form', { title: 'Edit client', client, action: `/clients/${id}`, error: problem });
  }
  const [result] = await pool.query(
    'UPDATE clients SET name = ?, contact_name = ?, email = ?, phone = ?, notes = ? WHERE id = ?',
    [...clientValues(client), id]
  );
  if (!result.affectedRows) throw notFound();
  await logActivity(null, req.user, {
    type: 'client', id, action: 'updated', clientId: id, clientName: client.name,
    subject: client.name, summary: `Updated client details for ${client.name}`,
  });
  flash(req, 'success', 'Client updated.');
  res.redirect(`/clients/${id}`);
});

router.post('/clients/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[client]] = await pool.query('SELECT name FROM clients WHERE id = ?', [id]);
  if (!client) return res.redirect('/clients');
  // Logged first; the entry keeps the client's name after the row is gone.
  await logActivity(null, req.user, {
    type: 'client', id, action: 'deleted', clientId: id, clientName: client.name,
    subject: client.name, summary: `Deleted client ${client.name} with its tickets and services`,
  });
  await pool.query('DELETE FROM clients WHERE id = ?', [id]);
  flash(req, 'success', 'Client deleted.');
  res.redirect('/clients');
});

// ---- Assigned services ----

// Assigns a service by copying its current steps into a checklist for this client.
router.post('/clients/:id/services', async (req, res) => {
  const clientId = requireId(req.params.id);
  const serviceId = toId(req.body.service_id);
  if (!serviceId) {
    flash(req, 'error', 'Choose a service to assign.');
    return res.redirect(`/clients/${clientId}#services`);
  }

  const result = await transaction(async (conn) => {
    const [[client]] = await conn.query('SELECT id, name FROM clients WHERE id = ?', [clientId]);
    if (!client) throw notFound();
    const [[service]] = await conn.query('SELECT id, name FROM services WHERE id = ?', [serviceId]);
    if (!service) return null;

    const [inserted] = await conn.query(
      'INSERT INTO client_services (client_id, service_id, service_name, status, assigned_by) VALUES (?, ?, ?, ?, ?)',
      [clientId, service.id, service.name, 'open', req.user.id]
    );
    const csId = inserted.insertId;
    const [steps] = await conn.query(
      'SELECT title FROM service_steps WHERE service_id = ? ORDER BY position, id',
      [service.id]
    );
    if (steps.length) {
      await conn.query(
        'INSERT INTO client_service_steps (client_service_id, title, position) VALUES ?',
        [steps.map((s, i) => [csId, s.title, i])]
      );
    }
    await logActivity(conn, req.user, {
      type: 'client_service', id: csId, action: 'created', clientId, clientName: client.name,
      subject: service.name, summary: `Assigned ${service.name} (${steps.length} step${steps.length === 1 ? '' : 's'})`,
    });
    return { csId, name: service.name };
  });

  if (!result) {
    flash(req, 'error', 'That service no longer exists.');
    return res.redirect(`/clients/${clientId}#services`);
  }
  flash(req, 'success', `"${result.name}" assigned.`);
  res.redirect(`/clients/${clientId}#cs-${result.csId}`);
});

// Ticks or unticks a step. Ticking the last step closes the service;
// unticking a step on a closed service reopens it.
router.post('/client-services/:id/steps/:stepId/toggle', async (req, res) => {
  const csId = requireId(req.params.id);
  const stepId = requireId(req.params.stepId);

  const outcome = await transaction(async (conn) => {
    const cs = await csContext(conn, csId, true);
    const [[step]] = await conn.query(
      'SELECT id, title, done FROM client_service_steps WHERE id = ? AND client_service_id = ?',
      [stepId, csId]
    );
    if (!step) throw notFound();

    if (step.done) {
      await conn.query('UPDATE client_service_steps SET done = 0, done_by = NULL, done_at = NULL WHERE id = ?', [stepId]);
      await logActivity(conn, req.user, csEntry(cs, 'step', 'updated', `Unticked step: ${step.title}`));
    } else {
      await conn.query('UPDATE client_service_steps SET done = 1, done_by = ?, done_at = NOW() WHERE id = ?', [req.user.id, stepId]);
      await logActivity(conn, req.user, csEntry(cs, 'step', 'step_done', step.title));
    }

    const [[totals]] = await conn.query(
      'SELECT COUNT(*) AS total, COALESCE(SUM(done = 0), 0) AS remaining FROM client_service_steps WHERE client_service_id = ?',
      [csId]
    );
    const total = Number(totals.total);
    const remaining = Number(totals.remaining);
    let change = null;
    if (total > 0 && remaining === 0 && cs.status !== 'closed') {
      await conn.query("UPDATE client_services SET status = 'closed', closed_at = NOW() WHERE id = ?", [csId]);
      await logActivity(conn, req.user, csEntry(cs, 'client_service', 'closed', 'All steps done, service closed'));
      change = 'closed';
    } else if (remaining > 0 && cs.status === 'closed') {
      await conn.query("UPDATE client_services SET status = 'open', closed_at = NULL WHERE id = ?", [csId]);
      await logActivity(conn, req.user, csEntry(cs, 'client_service', 'reopened', 'Reopened because a step was unticked'));
      change = 'reopened';
    }
    return { clientId: cs.client_id, change };
  });

  if (outcome.change === 'closed') flash(req, 'success', 'All steps done. Service closed.');
  if (outcome.change === 'reopened') flash(req, 'info', 'Step unticked. Service reopened.');
  res.redirect(`/clients/${outcome.clientId}#cs-${csId}`);
});

async function setClientServiceStatus(req, res, status) {
  const csId = requireId(req.params.id);
  const cs = await csContext(pool, csId);
  if (status === 'closed') {
    const [result] = await pool.query("UPDATE client_services SET status = 'closed', closed_at = NOW() WHERE id = ? AND status = 'open'", [csId]);
    if (result.affectedRows) await logActivity(null, req.user, csEntry(cs, 'client_service', 'closed', 'Marked as closed'));
  } else {
    const [result] = await pool.query("UPDATE client_services SET status = 'open', closed_at = NULL WHERE id = ? AND status = 'closed'", [csId]);
    if (result.affectedRows) await logActivity(null, req.user, csEntry(cs, 'client_service', 'reopened', 'Reopened'));
  }
  flash(req, 'success', status === 'closed' ? 'Service closed.' : 'Service reopened.');
  res.redirect(`/clients/${cs.client_id}#cs-${csId}`);
}

router.post('/client-services/:id/reopen', (req, res) => setClientServiceStatus(req, res, 'open'));
router.post('/client-services/:id/close', (req, res) => setClientServiceStatus(req, res, 'closed'));

// ---- Notes on assigned services ----

router.post('/client-services/:id/notes', async (req, res) => {
  const csId = requireId(req.params.id);
  const cs = await csContext(pool, csId);
  const body = str(req.body.body, 10000);
  if (!body) {
    flash(req, 'error', 'Note cannot be empty.');
  } else {
    await pool.query(
      'INSERT INTO client_service_notes (client_service_id, user_id, body) VALUES (?, ?, ?)',
      [csId, req.user.id, body]
    );
    await logActivity(null, req.user, csEntry(cs, 'note', 'created', body));
  }
  res.redirect(`/clients/${cs.client_id}#cs-${csId}`);
});

async function noteContext(noteId) {
  const [[note]] = await pool.query(`
    SELECT n.id, n.client_service_id, cs.client_id, cs.service_name, c.name AS client_name
    FROM client_service_notes n
    JOIN client_services cs ON cs.id = n.client_service_id
    JOIN clients c ON c.id = cs.client_id
    WHERE n.id = ?
  `, [noteId]);
  if (!note) throw notFound();
  return note;
}

router.post('/client-service-notes/:id', async (req, res) => {
  const note = await noteContext(requireId(req.params.id));
  const body = str(req.body.body, 10000);
  if (!body) {
    flash(req, 'error', 'Note cannot be empty.');
  } else {
    await pool.query(
      'UPDATE client_service_notes SET body = ?, updated_by = ?, updated_at = NOW() WHERE id = ?',
      [body, req.user.id, note.id]
    );
    await logActivity(null, req.user, csEntry({ ...note, id: note.client_service_id }, 'note', 'updated', body));
    flash(req, 'success', 'Note updated.');
  }
  res.redirect(`/clients/${note.client_id}#cs-${note.client_service_id}`);
});

router.post('/client-service-notes/:id/delete', async (req, res) => {
  const note = await noteContext(requireId(req.params.id));
  await pool.query('DELETE FROM client_service_notes WHERE id = ?', [note.id]);
  await logActivity(null, req.user, csEntry({ ...note, id: note.client_service_id }, 'note', 'deleted', 'Deleted a note'));
  flash(req, 'success', 'Note deleted.');
  res.redirect(`/clients/${note.client_id}#cs-${note.client_service_id}`);
});

router.post('/client-services/:id/delete', async (req, res) => {
  const csId = requireId(req.params.id);
  const cs = await csContext(pool, csId);
  await pool.query('DELETE FROM client_services WHERE id = ?', [csId]);
  await logActivity(null, req.user, csEntry(cs, 'client_service', 'deleted', `Removed ${cs.service_name} from the client`));
  flash(req, 'success', 'Service removed from client.');
  res.redirect(`/clients/${cs.client_id}#services`);
});

module.exports = router;
