// Ticket reminders: add, edit, mark done, snooze and delete. The ticket page posts
// forms (redirect back); toasts post with Accept: application/json and get JSON.
// A reminder can be for several people: each recipient marks it done or snoozes it for
// themselves; the creator can also mark it done for everyone. Every change is logged
// against the ticket (entity_type 'reminder', history only).
const express = require('express');
const { transaction } = require('../db');
const { requireId, toId, flash, notFound, safePath } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const {
  SNOOZES, reminderContext, readReminderForm, snoozeUntil, clearReminderNotifications, setRecipients, markDone,
  snoozeFor, namesOf,
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
  const fmt = req.fmt.fmtDate;
  const result = await transaction(async (conn) => {
    const [[ticket]] = await conn.query(`
      SELECT t.id, t.title, t.client_id, c.name AS client_name
      FROM tickets t JOIN clients c ON c.id = t.client_id WHERE t.id = ?
    `, [ticketId]);
    if (!ticket) throw notFound();
    const { form, error } = await readReminderForm(conn, req.body, req.user.id);
    if (error) return { error };
    const [r] = await conn.query(
      'INSERT INTO reminders (ticket_id, note, remind_at, for_user_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
      [ticket.id, form.note, form.remindAt, form.userIds[0], req.user.id, req.user.id]
    );
    await setRecipients(conn, r.insertId, form.userIds);
    await logActivity(conn, req.user, reminderEntry(
      { ticket_id: ticket.id, ticket_title: ticket.title, client_id: ticket.client_id, client_name: ticket.client_name },
      'created', withNote(`Added a reminder for ${form.names} on ${fmt(form.remindAt)}`, form.note)
    ));
    return {};
  });
  if (result.error) return failed(req, res, ticketId, result.error);
  return done(req, res, ticketId, 'Reminder added.');
});

router.post('/:id', async (req, res) => {
  const fmt = req.fmt.fmtDate;
  const result = await transaction(async (conn) => {
    const r = await lockedReminder(conn, req);
    const { form, error } = await readReminderForm(conn, req.body, req.user.id);
    if (error) return { r, error };
    const changes = [];
    const before = r.recipients.map((x) => x.user_id).sort().join(',');
    if ((r.note || null) !== form.note) changes.push('note');
    if (before !== [...form.userIds].sort().join(',')) changes.push('for');
    const newTime = new Date(r.remind_at).getTime() !== form.remindAt.getTime();
    if (newTime) changes.push('time');
    if (!changes.length) return { r };
    await conn.query('UPDATE reminders SET note = ?, remind_at = ?, updated_by = ? WHERE id = ?', [form.note, form.remindAt, req.user.id, r.id]);
    // A new time starts over for everyone (no snoozes, email again, new popup).
    await setRecipients(conn, r.id, form.userIds, { resetTimes: newTime });
    // Someone added to a reminder that was complete makes it pending again.
    if (r.status === 'done') {
      const [[{ open }]] = await conn.query('SELECT COUNT(*) AS open FROM reminder_recipients WHERE reminder_id = ? AND done_at IS NULL', [r.id]);
      if (Number(open)) await conn.query("UPDATE reminders SET status = 'pending', done_at = NULL WHERE id = ?", [r.id]);
    }
    await logActivity(conn, req.user, reminderEntry(r, 'updated',
      withNote(`Edited a reminder for ${form.names} on ${fmt(form.remindAt)}`, form.note), changes));
    return { r, changed: true };
  });
  if (result.error) return failed(req, res, result.r.ticket_id, result.error);
  return done(req, res, result.r.ticket_id, result.changed ? 'Reminder updated.' : null);
});

// Done for me (a recipient), or for everyone (?everyone=1, the creator). Someone who is
// neither gets a clear error.
router.post('/:id/done', async (req, res) => {
  const result = await transaction(async (conn) => {
    const reminder = await lockedReminder(conn, req);
    const isRecipient = reminder.recipients.some((x) => x.user_id === req.user.id);
    const isCreator = reminder.created_by === req.user.id;
    const everyone = req.body.everyone === '1' || (!isRecipient && isCreator);
    if (reminder.status === 'done') return { reminder, message: 'Reminder already done.' };
    if (everyone && !isCreator) return { reminder, error: 'Only the person who added the reminder can mark it done for everyone.' };
    if (!everyone && !isRecipient) return { reminder, error: 'This reminder is not for you.' };
    const state = await markDone(conn, reminder, req.user.id, { everyone });
    if (state.already) return { reminder, message: 'You have already marked it done.' };
    const left = reminder.recipients.filter((x) => !x.done_at && x.user_id !== req.user.id).map((x) => x.name);
    await logActivity(conn, req.user, reminderEntry(reminder, 'completed', withNote(
      everyone ? 'Marked a reminder done for everyone'
        : state.complete ? 'Marked a reminder done (everyone has now done it)' : `Marked a reminder done for themselves (still to do: ${left.join(', ')})`,
      reminder.note
    )));
    return { reminder, message: state.complete ? 'Reminder done.' : 'Marked done for you.' };
  });
  if (result.error) return failed(req, res, result.reminder.ticket_id, result.error);
  return done(req, res, result.reminder.ticket_id, result.message);
});

// Snooze for me (10m, 1h or tomorrow 09:00 UK).
router.post('/:id/snooze', async (req, res) => {
  const choice = req.body.until;
  const until = snoozeUntil(choice);
  const fmt = req.fmt.fmtDate;
  const r = await transaction(async (conn) => {
    const reminder = await lockedReminder(conn, req);
    if (!until || reminder.status === 'done') return { ...reminder, invalid: 'Choose 10 minutes, 1 hour or tomorrow 09:00.' };
    if (!(await snoozeFor(conn, reminder, req.user.id, until))) return { ...reminder, invalid: 'This reminder is not waiting for you.' };
    await logActivity(conn, req.user, reminderEntry(reminder, 'updated',
      withNote(`Snoozed a reminder for ${SNOOZES[choice]} (until ${fmt(until)})`, reminder.note), ['snooze']));
    return reminder;
  });
  if (r.invalid) return failed(req, res, r.ticket_id, r.invalid);
  return done(req, res, r.ticket_id, `Reminder snoozed for ${SNOOZES[choice]}.`);
});

router.post('/:id/delete', async (req, res) => {
  const fmt = req.fmt.fmtDate;
  const r = await transaction(async (conn) => {
    const reminder = await lockedReminder(conn, req);
    await clearReminderNotifications(conn, { reminderId: reminder.id, remove: true });
    await conn.query('DELETE FROM reminders WHERE id = ?', [reminder.id]);
    await logActivity(conn, req.user, reminderEntry(reminder, 'deleted',
      withNote(`Deleted a reminder for ${namesOf(reminder.recipients)} on ${fmt(reminder.remind_at)}`, reminder.note)));
    return reminder;
  });
  return done(req, res, r.ticket_id, 'Reminder deleted.');
});

module.exports = router;
