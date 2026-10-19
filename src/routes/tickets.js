const express = require('express');
const { pool, transaction } = require('../db');
const { str, requireId, toId, flash, notFound, backPath } = require('../lib/http');
const { TICKET_STATUSES, TICKET_PRIORITIES, isTicketStatus, isTicketPriority } = require('../lib/tickets');
const { readListQuery, listTickets, ticketCounts, listControls, instantTickets } = require('../lib/ticket-list');
const { boardColumns } = require('../lib/dashboard');
const { ticketReminders, reminderUsers, clearReminderNotifications } = require('../lib/reminders');
const {
  logActivity, historyFor, recordMeta, londonDate,
} = require('../lib/activity');
const {
  mentionUsers, mentionNames, mentionHtml, recordMentions,
} = require('../lib/mentions');
const { sendCommentEmails, pushMentionsTo } = require('../lib/comment-emails');
const {
  ticketUploads, insertAttachments, keepTicketFiles, removeTicketFiles, attachmentNames, fileSize,
} = require('../lib/ticket-files');

// Where to go back to on the ticket page (a same-site path, else the given anchor).
const backTo = (req, id, hash) => backPath(req, `/tickets/${id}${hash}`);
const fileList = (files) => files.map((f) => f.original_name).join(', ');

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

// Portal users a ticket can be assigned to, A-Z.
async function assignableUsers(db = pool) {
  const [users] = await db.query("SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name FROM users u ORDER BY name");
  return users;
}

const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';

async function clientOptions() {
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  return clients;
}

// List (the default) or Board (columns by status, drag a card to change its status). The
// last choice is remembered in users.ticket_view (a display preference, not activity-logged).
router.get('/', async (req, res) => {
  const state = readListQuery(req.query);
  if (state.view) {
    if (state.view !== req.user.ticket_view) await pool.query('UPDATE users SET ticket_view = ? WHERE id = ?', [state.view, req.user.id]);
  } else {
    state.view = req.user.ticket_view === 'board' ? 'board' : 'list';
  }
  // Every ticket goes to the page; filters and search work in the browser ([data-list]).
  // The board always shows every status (one column each); the status filter is for the List.
  const tickets = instantTickets(await listTickets({ sort: state.sort, dir: state.dir }), state, { ignoreStatus: state.view === 'board' });
  const controls = listControls('/tickets', state, await ticketCounts());
  const [clients, people] = await Promise.all([clientOptions(), assignableUsers()]);
  res.render('tickets/index', {
    title: 'Tickets', tickets, state, controls, clients, people,
    board: boardColumns(tickets, { closedLabel: 'Closed', closedLimit: 50 }),
  });
});

// Quick-action rail "Add reminder": the chosen ticket's page with the Add reminder form open.
router.get('/remind', (req, res) => {
  const id = toId(req.query.ticket);
  if (!id) return res.redirect('/tickets');
  return res.redirect(`/tickets/${id}?remind=1#reminders`);
});

router.get('/new', async (req, res) => {
  const clients = await clientOptions();
  const ticket = { client_id: toId(req.query.client_id), title: '', description: '', priority: 'normal', assigned_to: req.user.id };
  res.render('tickets/new', { title: 'New ticket', clients, ticket, error: null, people: await assignableUsers() });
});

router.post('/', async (req, res) => {
  const ticket = {
    client_id: toId(req.body.client_id),
    title: str(req.body.title, 255),
    description: str(req.body.description, 10000),
    priority: isTicketPriority(req.body.priority) ? req.body.priority : 'normal',
    assigned_to: toId(req.body.assigned_to) || req.user.id,
  };

  let error = null;
  if (!ticket.client_id) error = 'Choose a client.';
  else if (!ticket.title) error = 'Title is required.';

  let ticketId = null;
  if (!error) {
    ticketId = await transaction(async (conn) => {
      const [[client]] = await conn.query('SELECT id, name FROM clients WHERE id = ?', [ticket.client_id]);
      if (!client) return null;
      // Assigned to a portal user (default: whoever opens it).
      const [[assignee]] = await conn.query('SELECT id FROM users WHERE id = ?', [ticket.assigned_to]);
      const [result] = await conn.query(
        "INSERT INTO tickets (client_id, title, description, status, priority, created_by, updated_by, assigned_to) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)",
        [ticket.client_id, ticket.title, ticket.description || null, ticket.priority, req.user.id, req.user.id, assignee ? assignee.id : req.user.id]
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
    return res.status(400).render('tickets/new', { title: 'New ticket', clients, ticket, error, people: await assignableUsers() });
  }
  flash(req, 'success', 'Ticket created.');
  res.redirect(`/tickets/${ticketId}`);
});

router.get('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[ticket]] = await pool.query(`
    SELECT t.*, c.name AS client_name, COALESCE(NULLIF(u.display_name, ''), u.username) AS created_by_name, COALESCE(NULLIF(uu.display_name, ''), uu.username) AS updated_by_name,
           COALESCE(NULLIF(au.display_name, ''), au.username) AS assigned_to_name
    FROM tickets t
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN users uu ON uu.id = t.updated_by
    LEFT JOIN users au ON au.id = t.assigned_to
    WHERE t.id = ?
  `, [id]);
  if (!ticket) throw notFound();
  const [comments] = await pool.query(`
    SELECT tc.id, tc.body, tc.created_at, tc.updated_at, tc.user_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS username
    FROM ticket_comments tc
    LEFT JOIN users u ON u.id = tc.user_id
    WHERE tc.ticket_id = ?
    ORDER BY tc.created_at, tc.id
  `, [id]);
  const mentions = await mentionNames(pool, comments.map((c) => c.id));
  const [files] = await pool.query(`
    SELECT a.id, a.comment_id, a.file_name, a.original_name, a.size_bytes, a.kind, a.created_at, a.uploaded_by,
           COALESCE(NULLIF(u.display_name, ''), u.username) AS uploaded_name
    FROM ticket_attachments a
    LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.ticket_id = ?
    ORDER BY a.created_at, a.id
  `, [id]);
  for (const f of files) f.size = fileSize(f.size_bytes);
  for (const c of comments) {
    c.html = mentionHtml(c.body, mentions.get(c.id));
    c.files = files.filter((f) => f.comment_id === c.id);
  }
  const ticketFiles = files.filter((f) => !f.comment_id);
  const [history] = await pool.query(`
    SELECT th.id, th.user_id, th.old_status, th.new_status, th.old_priority, th.new_priority, th.created_at, COALESCE(NULLIF(u.display_name, ''), u.username) AS username
    FROM ticket_history th
    LEFT JOIN users u ON u.id = th.user_id
    WHERE th.ticket_id = ?
    ORDER BY th.created_at DESC, th.id DESC
  `, [id]);
  // One timeline, oldest first (newest at the bottom, next to the comment box): comments
  // and status / priority changes.
  const timeline = [
    ...history.map((h) => ({ type: 'event', at: new Date(h.created_at).getTime(), order: 0, item: h })),
    ...comments.map((c) => ({ type: 'comment', at: new Date(c.created_at).getTime(), order: 1, item: c })),
  ].sort((a, b) => a.at - b.at || a.order - b.order || a.item.id - b.item.id);
  const activity = await historyFor(['ticket', 'ticket_comment', 'reminder'], [id]);
  const meta = recordMeta(activity, 'ticket', { createdBy: ticket.created_by_name, createdAt: ticket.created_at });
  const reminders = await ticketReminders(id);
  const users = await reminderUsers();
  const mentionable = await mentionUsers();
  // Seeing the ticket reads the user's @mention notifications for it.
  await pool.query(
    "UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND type = 'mention' AND read_at IS NULL AND link LIKE ?",
    [req.user.id, `/tickets/${id}#%`]
  );
  res.render('tickets/show', {
    title: `Ticket #${ticket.id}`, ticket, comments, history, timeline, files, ticketFiles, activity, meta, reminders, users, mentionable,
    people: await assignableUsers(),
    remindOpen: req.query.remind === '1',
    // The Reminders card's bell rings gently when one of them is due today (UK).
    reminderToday: reminders.pending.some((r) => londonDate(new Date(r.remind_at)) === londonDate()),
  });
});

router.post('/:id/status', async (req, res) => {
  const id = requireId(req.params.id);
  const status = req.body.status;
  if (!isTicketStatus(status)) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: 'Choose a valid status.' });
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

  if (wantsJson(req)) return res.json({ ok: true, changed, status, label: TICKET_STATUSES[status] });
  flash(req, changed ? 'saved' : 'info', changed ? `Saved. Status changed to ${TICKET_STATUSES[status]}.` : 'Status unchanged.');
  return res.redirect(backPath(req, `/tickets/${id}`));
});

// Assigned to: a portal user, or nobody (assigned_to empty). Logged on the ticket.
router.post('/:id/assign', async (req, res) => {
  const id = requireId(req.params.id);
  const wanted = toId(req.body.assigned_to);
  const result = await transaction(async (conn) => {
    const ticket = await ticketContext(conn, id, true);
    const [[before]] = await conn.query(`
      SELECT t.assigned_to, COALESCE(NULLIF(u.display_name, ''), u.username) AS name
      FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.id = ?
    `, [id]);
    let person = null;
    if (wanted) {
      [[person]] = await conn.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name FROM users WHERE id = ?", [wanted]);
      if (!person) return { error: 'That user no longer exists.' };
    }
    if ((before.assigned_to || null) === (person ? person.id : null)) return { changed: false, person };
    await conn.query('UPDATE tickets SET assigned_to = ?, updated_by = ?, updated_at = NOW() WHERE id = ?', [person ? person.id : null, req.user.id, id]);
    await logActivity(conn, req.user, ticketEntry(ticket, 'ticket', 'updated',
      `Assigned to: ${before.name || 'nobody'} → ${person ? person.name : 'nobody'}`));
    return { changed: true, person };
  });
  if (result.error) {
    flash(req, 'error', result.error);
    return res.redirect(`/tickets/${id}`);
  }
  flash(req, result.changed ? 'saved' : 'info', result.changed ? `Saved. Assigned to ${result.person ? result.person.name : 'nobody'}.` : 'Assignment unchanged.');
  return res.redirect(`/tickets/${id}`);
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

  flash(req, changed ? 'saved' : 'info', changed ? `Saved. Priority changed to ${TICKET_PRIORITIES[priority]}.` : 'Priority unchanged.');
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
  flash(req, 'saved', 'Saved. Ticket updated.');
  res.redirect(`/tickets/${id}`);
});

// After commit: one email per recipient (a new comment: every admin except the author, the
// newly @mentioned getting the mention email instead; an edit: only the newly mentioned) and
// desktop notifications for the newly mentioned who want them. Never breaks the comment.
async function notifyComment({ ticket, author, comment, files, mentioned, notify, isNew }) {
  try {
    await sendCommentEmails({ ticket, author, comment, files, mentionedNames: mentioned.map((u) => u.name), notify, isNew });
  } catch (err) {
    console.error('Comment emails failed:', err.message);
  }
  if (!notify.length) return;
  try {
    await pushMentionsTo({ users: notify, author, ticket, body: comment.body, commentId: comment.id });
  } catch (err) {
    console.error('Mention desktop notifications failed:', err.message);
  }
}

// A comment: text and / or attachments (multipart "files", max 100 MB each; pasted
// screenshots arrive as files too).
router.post('/:id/comments', async (req, res) => {
  const id = requireId(req.params.id);
  const body = str(req.body.body, 10000);
  const upload = ticketUploads(req);
  if (upload.error) {
    flash(req, 'error', upload.error);
    return res.redirect(`/tickets/${id}#composer`);
  }
  const { files } = upload;
  if (!body && !files.length) {
    flash(req, 'error', 'Write a comment or attach a file.');
    return res.redirect(`/tickets/${id}#composer`);
  }
  const author = { id: req.user.id, name: req.user.name };
  const saved = await transaction(async (conn) => {
    const ticket = await ticketContext(conn, id, true);
    const [r] = await conn.query('INSERT INTO ticket_comments (ticket_id, user_id, body) VALUES (?, ?, ?)', [id, req.user.id, body]);
    await insertAttachments(conn, { ticketId: id, commentId: r.insertId, userId: req.user.id, files });
    const attached = files.length ? ` (attached ${fileList(files)})` : '';
    await logActivity(conn, req.user, ticketEntry(ticket, 'ticket_comment', 'commented', `${body || 'Added attachments'}${attached}`));
    // @mentions: stored, a bell notification and (after commit) an email and desktop
    // notification for each person mentioned except the author. Logged on the ticket
    // History, never on the Daily Report.
    const { mentioned, notify } = await recordMentions(conn, { commentId: r.insertId, ticket, author, body, picked: req.body.mention_ids });
    if (mentioned.length) {
      await logActivity(conn, req.user, ticketEntry(ticket, 'ticket_comment', 'sent',
        `Mentioned ${mentioned.map((u) => u.name).join(', ')} in a comment${notify.length ? ' (notified)' : ''}`));
    }
    await conn.query('UPDATE tickets SET updated_by = ?, updated_at = NOW() WHERE id = ?', [req.user.id, id]);
    const [[row]] = await conn.query('SELECT created_at FROM ticket_comments WHERE id = ?', [r.insertId]);
    return { ticket, commentId: r.insertId, createdAt: row ? row.created_at : null, mentioned, notify };
  });
  await keepTicketFiles(req, files);
  await notifyComment({
    ticket: saved.ticket, author, comment: { id: saved.commentId, body, created_at: saved.createdAt }, files,
    mentioned: saved.mentioned, notify: saved.notify, isNew: true,
  });
  res.redirect(`/tickets/${id}#comment-${saved.commentId}`);
});

// The author edits their comment's text. People newly @mentioned are notified; nobody
// already mentioned is notified again.
router.post('/:id/comments/:cid', async (req, res) => {
  const id = requireId(req.params.id);
  const cid = requireId(req.params.cid);
  const body = str(req.body.body, 10000);
  const author = { id: req.user.id, name: req.user.name };
  const result = await transaction(async (conn) => {
    const ticket = await ticketContext(conn, id, true);
    const [[comment]] = await conn.query('SELECT id, user_id, body, created_at FROM ticket_comments WHERE id = ? AND ticket_id = ? FOR UPDATE', [cid, id]);
    if (!comment) throw notFound();
    if (comment.user_id !== req.user.id) return { error: 'Only the person who wrote a comment can edit it.' };
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM ticket_attachments WHERE comment_id = ?', [cid]);
    if (!body && !Number(n)) return { error: 'A comment needs text or an attachment. Delete it instead.' };
    if (body === comment.body) return { ticket, notify: [], mentioned: [] };
    await conn.query('UPDATE ticket_comments SET body = ?, updated_at = NOW() WHERE id = ?', [body, cid]);
    await logActivity(conn, req.user, ticketEntry(ticket, 'ticket_comment', 'updated', `Edited a comment: ${body || '(no text)'}`));
    const { mentioned, notify } = await recordMentions(conn, { commentId: cid, ticket, author, body, picked: req.body.mention_ids });
    if (notify.length) {
      await logActivity(conn, req.user, ticketEntry(ticket, 'ticket_comment', 'sent',
        `Mentioned ${notify.map((u) => u.name).join(', ')} in an edited comment (notified)`));
    }
    await conn.query('UPDATE tickets SET updated_by = ?, updated_at = NOW() WHERE id = ?', [req.user.id, id]);
    const [files] = notify.length ? await conn.query('SELECT original_name, size_bytes FROM ticket_attachments WHERE comment_id = ?', [cid]) : [[]];
    return { ticket, notify, mentioned, files, createdAt: comment.created_at, changed: true };
  });
  if (result.error) {
    flash(req, 'error', result.error);
    return res.redirect(`/tickets/${id}#comment-${cid}`);
  }
  if (result.notify.length) {
    await notifyComment({
      ticket: result.ticket, author, comment: { id: cid, body, created_at: result.createdAt }, files: result.files || [],
      mentioned: result.mentioned, notify: result.notify, isNew: false,
    });
  }
  if (result.changed) flash(req, 'saved', 'Saved. Comment updated.');
  res.redirect(`/tickets/${id}#comment-${cid}`);
});

// The author deletes their comment with its attachments (rows and files).
router.post('/:id/comments/:cid/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const cid = requireId(req.params.cid);
  const result = await transaction(async (conn) => {
    const ticket = await ticketContext(conn, id, true);
    const [[comment]] = await conn.query('SELECT id, user_id, body, created_at FROM ticket_comments WHERE id = ? AND ticket_id = ? FOR UPDATE', [cid, id]);
    if (!comment) throw notFound();
    if (comment.user_id !== req.user.id) return { error: 'Only the person who wrote a comment can delete it.' };
    const names = await attachmentNames(conn, { commentId: cid });
    await conn.query('DELETE FROM ticket_comments WHERE id = ?', [cid]);
    // Its @mention notifications are no longer useful.
    await conn.query("UPDATE notifications SET read_at = NOW() WHERE type = 'mention' AND read_at IS NULL AND link = ?", [`/tickets/${id}#comment-${cid}`]);
    await logActivity(conn, req.user, ticketEntry(ticket, 'ticket_comment', 'deleted',
      `Deleted a comment: ${comment.body || '(no text)'}${names.length ? ` (with ${names.length} attachment${names.length === 1 ? '' : 's'})` : ''}`));
    await conn.query('UPDATE tickets SET updated_by = ?, updated_at = NOW() WHERE id = ?', [req.user.id, id]);
    return { names };
  });
  if (result.error) {
    flash(req, 'error', result.error);
    return res.redirect(`/tickets/${id}#comment-${cid}`);
  }
  await removeTicketFiles(result.names);
  flash(req, 'saved', 'Comment deleted.');
  res.redirect(`/tickets/${id}#timeline`);
});

// Files attached to the ticket itself (Attachments panel: drop, paperclip or paste).
router.post('/:id/attachments', async (req, res) => {
  const id = requireId(req.params.id);
  const upload = ticketUploads(req);
  if (upload.error || !upload.files.length) {
    flash(req, 'error', upload.error || 'Choose one or more files to attach.');
    return res.redirect(backTo(req, id, '#attachments'));
  }
  const { files } = upload;
  await transaction(async (conn) => {
    const ticket = await ticketContext(conn, id, true);
    await insertAttachments(conn, { ticketId: id, userId: req.user.id, files });
    await logActivity(conn, req.user, ticketEntry(ticket, 'ticket', 'uploaded', `Attached ${fileList(files)}`));
    await conn.query('UPDATE tickets SET updated_by = ?, updated_at = NOW() WHERE id = ?', [req.user.id, id]);
  });
  await keepTicketFiles(req, files);
  flash(req, 'saved', `Saved. ${files.length === 1 ? 'File' : `${files.length} files`} attached.`);
  res.redirect(backTo(req, id, '#attachments'));
});

// Deletes one attachment (of the ticket or of a comment): the row and the file.
router.post('/:id/attachments/:aid/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const aid = requireId(req.params.aid);
  const file = await transaction(async (conn) => {
    const ticket = await ticketContext(conn, id, true);
    const [[row]] = await conn.query('SELECT id, file_name, original_name, comment_id FROM ticket_attachments WHERE id = ? AND ticket_id = ?', [aid, id]);
    if (!row) throw notFound();
    await conn.query('DELETE FROM ticket_attachments WHERE id = ?', [aid]);
    await logActivity(conn, req.user, ticketEntry(ticket, 'ticket', 'deleted',
      `Deleted the attachment ${row.original_name}${row.comment_id ? ' from a comment' : ''}`));
    await conn.query('UPDATE tickets SET updated_by = ?, updated_at = NOW() WHERE id = ?', [req.user.id, id]);
    return row;
  });
  await removeTicketFiles([file.file_name]);
  flash(req, 'saved', `Deleted ${file.original_name}.`);
  res.redirect(backTo(req, id, file.comment_id ? `#comment-${file.comment_id}` : '#attachments'));
});

// Deletes the ticket with its comments and status history (ON DELETE CASCADE).
// The activity log keeps its entries (with the title snapshot), so past reports are
// unchanged. Returns to the list it was deleted from (back), or the client's tickets.
router.post('/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const ticket = await ticketContext(pool, id);
  await logActivity(null, req.user, ticketEntry(ticket, 'ticket', 'deleted', `Deleted ticket #${id}: ${ticket.title}`));
  // Reminders go with the ticket (ON DELETE CASCADE); their notifications go first.
  await clearReminderNotifications(pool, { ticketId: id, remove: true });
  // Attachment rows go with the ticket; their files are deleted from disk.
  const names = await attachmentNames(pool, { ticketId: id });
  await pool.query('DELETE FROM tickets WHERE id = ?', [id]);
  await removeTicketFiles(names);
  flash(req, 'success', `Ticket #${id} "${ticket.title}" deleted.`);
  res.redirect(backPath(req, `/clients/${ticket.client_id}#tickets`));
});

module.exports = router;
