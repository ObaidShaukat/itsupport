// Ticket reminders: add, edit, mark done, snooze and delete. The ticket page posts
// forms (redirect back); toasts post with Accept: application/json and get JSON.
// Every change is logged against the ticket (entity_type 'reminder', history only).
const express = require('express');
const { transaction } = require('../db');
const { requireId, toId, flash, notFound, safePath } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const {
  SNOOZES, reminderContext, readReminderForm, snoozeUntil, clearReminderNotifications,
} = require('../lib/reminders');

const router = express.Router();

const wantsJson = (req) => (req.get('Accept') || '').includes('application/json');
const ticketBack = (req, ticketId) => safePath(req.body.back, `/tickets/${ticketId}#reminders`);
const withNote = (text, note) => (note ? `${text}: ${note}` : text);

const reminderEntry = (r, action, summary, changes) => ({
  type: 'reminder', id: r.ticket_id, action, summary, changes,
  subject: r.ticket_title, clientId: r.client_id, clientName: r.client_name,
});

// Loads (and locks) the reminder, or 404.
async function lockedReminder(conn, req) {
  const reminder = await reminderContext(conn, requireId(req.params.id), true);
  if (!reminder) throw notFound();
  return reminder;
}

function done(req, res, ticketId, message) {
  if (wantsJson(req)) return res.json({ ok: true });
  if (message) flash(req, 'success', message);
  return res.redirect(ticketBack(req, ticketId));
}

function failed(req, res, ticketId, error) {
  if (wantsJson(req)) return res.status(400).json({ ok: false, error });
  flash(req, 'error', error);
  return res.redirect(ticketBack(req, ticketId));
}

router.post('/', async (req, res) => {
  const ticketId = toId(req.body.ticket_id);
  if (!ticketId) throw notFound();
  const fmt = req.app.locals.fmtDate;
  const result = await transaction(async (conn) => {
    const [[ticket]] = await conn.query(`
      SELECT t.id, t.title, t.client_id, c.name AS client_name
      FROM tickets t JOIN clients c ON c.id = t.client_id WHERE t.id = ?
    `, [ticketId]);
    if (!ticket) throw notFound();
    const { form, error } = await readReminderForm(conn, req.body, req.user.id);
    if (error) return { error };
    await conn.query(
      'INSERT INTO reminders (ticket_id, note, remind_at, for_user_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
      [ticket.id, form.note, form.remindAt, form.forUserId, req.user.id, req.user.id]
    );
    await logActivity(conn, req.user, reminderEntry(
      { ticket_id: ticket.id, ticket_title: ticket.title, client_id: ticket.client_id, client_name: ticket.client_name },
      'created', withNote(`Added a reminder for ${form.forName} on ${fmt(form.remindAt)}`, form.note)
    ));
    return {};
  });
  if (result.error) return failed(req, res, ticketId, result.error);
  return done(req, res, ticketId, 'Reminder added.');
});

router.post('/:id', async (req, res) => {
  const fmt = req.app.locals.fmtDate;
  const result = await transaction(async (conn) => {
    const r = await lockedReminder(conn, req);
    const { form, error } = await readReminderForm(conn, req.body, req.user.id);
    if (error) return { r, error };
    const changes = [];
    if ((r.note || null) !== form.note) changes.push('note');
    if (r.for_user_id !== form.forUserId) changes.push('for');
    if (new Date(r.due_at).getTime() !== form.remindAt.getTime() || r.snoozed_until) changes.push('time');
    if (!changes.length) return { r };
    // A new time (or recipient) starts over: no snooze, and the old notification is closed.
    await conn.query(
      'UPDATE reminders SET note = ?, for_user_id = ?, remind_at = ?, snoozed_until = NULL, updated_by = ? WHERE id = ?',
      [form.note, form.forUserId, form.remindAt, req.user.id, r.id]
    );
    if (changes.includes('time') || changes.includes('for')) {
      // Notify (popup and email) again at the new time / for the new person.
      await conn.query('UPDATE reminders SET email_sent_at = NULL WHERE id = ?', [r.id]);
      await clearReminderNotifications(conn, { reminderId: r.id });
    }
    await logActivity(conn, req.user, reminderEntry(r, 'updated',
      withNote(`Edited a reminder for ${form.forName} on ${fmt(form.remindAt)}`, form.note), changes));
    return { r, changed: true };
  });
  if (result.error) return failed(req, res, result.r.ticket_id, result.error);
  return done(req, res, result.r.ticket_id, result.changed ? 'Reminder updated.' : null);
});

router.post('/:id/done', async (req, res) => {
  const r = await transaction(async (conn) => {
    const reminder = await lockedReminder(conn, req);
    if (reminder.status === 'done') return reminder;
    await conn.query("UPDATE reminders SET status = 'done', done_at = NOW(), updated_by = ? WHERE id = ?", [req.user.id, reminder.id]);
    await clearReminderNotifications(conn, { reminderId: reminder.id });
    await logActivity(conn, req.user, reminderEntry(reminder, 'completed', withNote('Marked a reminder done', reminder.note)));
    return reminder;
  });
  return done(req, res, r.ticket_id, 'Reminder marked done.');
});

router.post('/:id/snooze', async (req, res) => {
  const choice = req.body.until;
  const until = snoozeUntil(choice);
  const fmt = req.app.locals.fmtDate;
  const r = await transaction(async (conn) => {
    const reminder = await lockedReminder(conn, req);
    if (!until || reminder.status === 'done') return { ...reminder, invalid: true };
    await conn.query('UPDATE reminders SET snoozed_until = ?, email_sent_at = NULL, updated_by = ? WHERE id = ?', [until, req.user.id, reminder.id]);
    await clearReminderNotifications(conn, { reminderId: reminder.id });
    await logActivity(conn, req.user, reminderEntry(reminder, 'updated',
      withNote(`Snoozed a reminder for ${SNOOZES[choice]} (until ${fmt(until)})`, reminder.note), ['snooze']));
    return reminder;
  });
  if (r.invalid) return failed(req, res, r.ticket_id, 'Choose 10 minutes, 1 hour or tomorrow 09:00.');
  return done(req, res, r.ticket_id, `Reminder snoozed for ${SNOOZES[choice]}.`);
});

router.post('/:id/delete', async (req, res) => {
  const fmt = req.app.locals.fmtDate;
  const r = await transaction(async (conn) => {
    const reminder = await lockedReminder(conn, req);
    await clearReminderNotifications(conn, { reminderId: reminder.id, remove: true });
    await conn.query('DELETE FROM reminders WHERE id = ?', [reminder.id]);
    await logActivity(conn, req.user, reminderEntry(reminder, 'deleted',
      withNote(`Deleted a reminder for ${reminder.for_name || 'a deleted user'} on ${fmt(reminder.due_at)}`, reminder.note)));
    return reminder;
  });
  return done(req, res, r.ticket_id, 'Reminder deleted.');
});

module.exports = router;
