// Ticket reminders. remind_at is a UK time chosen by the user and stored in UTC;
// snoozed_until overrides it until the reminder is edited or marked done. Reminders
// are logged (entity_type 'reminder', entity_id = ticket id) for history only and are
// never on the Daily Report.
//
// Notifications: when a pending reminder is due, its recipient gets one unread
// 'ticket_reminder' row in notifications (channel 'portal'; 'email' / 'teams' can be
// added later from the same rows). Done, snooze, edit and delete mark that row read,
// so a snoozed or rescheduled reminder notifies again when it is next due.
const { pool, transaction } = require('../db');
const { str, toId } = require('./http');
const { londonDate, londonDayStart, londonLocalToUtc, toLondonInput } = require('./activity');
const { addDays } = require('./report');

const DUE_AT = 'COALESCE(r.snoozed_until, r.remind_at)';
const USER_NAME = (alias) => `COALESCE(NULLIF(${alias}.display_name, ''), ${alias}.username)`;

// Snooze choices offered on toasts: 10 minutes, 1 hour, tomorrow 09:00 (UK).
const SNOOZES = { '10m': '10 minutes', '1h': '1 hour', tomorrow: 'tomorrow 09:00' };

async function reminderUsers() {
  const [users] = await pool.query(`SELECT id, ${USER_NAME('u')} AS name FROM users u ORDER BY name`);
  return users;
}

// Reminders on one ticket: pending (soonest first) and done (latest first).
async function ticketReminders(ticketId) {
  const [rows] = await pool.query(`
    SELECT r.id, r.note, r.remind_at, r.snoozed_until, r.status, r.for_user_id, r.done_at,
           r.created_at, r.updated_at, ${DUE_AT} AS due_at, ${DUE_AT} <= NOW() AS is_due,
           ${USER_NAME('fu')} AS for_name, ${USER_NAME('cu')} AS created_name, ${USER_NAME('uu')} AS updated_name
    FROM reminders r
    LEFT JOIN users fu ON fu.id = r.for_user_id
    LEFT JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users uu ON uu.id = r.updated_by
    WHERE r.ticket_id = ?
    ORDER BY r.status = 'done', ${DUE_AT}, r.id
  `, [ticketId]);
  for (const r of rows) r.input = toLondonInput(r.due_at);
  return {
    pending: rows.filter((r) => r.status === 'pending'),
    done: rows.filter((r) => r.status === 'done').sort((a, b) => new Date(b.done_at) - new Date(a.done_at)),
  };
}

// One reminder with its ticket and client (for logging), or null.
async function reminderContext(db, id, lock = false) {
  const [[reminder]] = await db.query(`
    SELECT r.id, r.ticket_id, r.note, r.remind_at, r.snoozed_until, r.status, r.for_user_id,
           ${DUE_AT} AS due_at, ${USER_NAME('fu')} AS for_name,
           t.title AS ticket_title, t.client_id, c.name AS client_name
    FROM reminders r
    JOIN tickets t ON t.id = r.ticket_id
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN users fu ON fu.id = r.for_user_id
    WHERE r.id = ? ${lock ? 'FOR UPDATE' : ''}
  `, [id]);
  return reminder || null;
}

// Add / edit form: note, for (user id, default the signed-in user), remind_at (UK time).
async function readReminderForm(db, body, userId) {
  const form = {
    note: str(body.note, 500) || null,
    forUserId: toId(body.for_user_id) || userId,
    remindAt: londonLocalToUtc(body.remind_at),
  };
  if (!form.remindAt) return { error: 'Choose a date and time for the reminder.' };
  const [[user]] = await db.query(`SELECT id, ${USER_NAME('u')} AS name FROM users u WHERE id = ?`, [form.forUserId]);
  if (!user) return { error: 'Choose who the reminder is for.' };
  form.forName = user.name;
  return { form };
}

// UTC time for a snooze choice, or null for an unknown choice.
function snoozeUntil(choice) {
  if (choice === '10m') return new Date(Date.now() + 10 * 60000);
  if (choice === '1h') return new Date(Date.now() + 60 * 60000);
  if (choice === 'tomorrow') return londonLocalToUtc(`${addDays(londonDate(), 1)}T09:00`);
  return null;
}

// Marks a reminder's (or a whole ticket's) open notifications read, or deletes them.
async function clearReminderNotifications(db, { reminderId, ticketId, remove = false }) {
  const where = reminderId
    ? ['n.reminder_id = ?', reminderId]
    : ['n.reminder_id IN (SELECT r.id FROM reminders r WHERE r.ticket_id = ?)', ticketId];
  if (remove) {
    await db.query(`DELETE n FROM notifications n WHERE ${where[0]}`, [where[1]]);
  } else {
    await db.query(`UPDATE notifications n SET n.read_at = NOW() WHERE n.read_at IS NULL AND ${where[0]}`, [where[1]]);
  }
}

// Gives each of the user's due reminders one unread notification. Called on every poll;
// the row locks stop two open tabs creating the same notification twice.
async function createDueNotifications(userId) {
  await transaction(async (conn) => {
    const [due] = await conn.query(`
      SELECT r.id, r.note, r.ticket_id, t.title, c.name AS client_name
      FROM reminders r
      JOIN tickets t ON t.id = r.ticket_id
      JOIN clients c ON c.id = t.client_id
      WHERE r.for_user_id = ? AND r.status = 'pending' AND ${DUE_AT} <= NOW()
      ORDER BY r.id
      FOR UPDATE
    `, [userId]);
    for (const r of due) {
      const [[open]] = await conn.query(
        'SELECT id FROM notifications WHERE reminder_id = ? AND user_id = ? AND read_at IS NULL LIMIT 1 FOR UPDATE',
        [r.id, userId]
      );
      if (open) continue;
      await conn.query(
        "INSERT INTO notifications (user_id, channel, type, title, body, link, reminder_id) VALUES (?, 'portal', 'ticket_reminder', ?, ?, ?, ?)",
        [userId, `Reminder: #${r.ticket_id} ${r.title}`.slice(0, 255), (r.note || r.client_name).slice(0, 500),
          `/tickets/${r.ticket_id}#reminders`, r.id]
      );
    }
  });
}

// The bell: the user's pending reminders that are due now (today, UK), missed (due
// before today) or upcoming (next 7 days). Toasts are the due and missed ones; isNew is
// true the first time a notification is shown (the browser plays the sound once).
async function bellFor(userId, fmtDate) {
  await createDueNotifications(userId);
  const todayStart = londonDayStart(londonDate());
  const [rows] = await pool.query(`
    SELECT r.id, r.note, r.ticket_id, t.title, c.name AS client_name, ${DUE_AT} AS due_at,
           ${DUE_AT} <= NOW() AS is_due, ${DUE_AT} < ? AS is_missed,
           n.id AS notification_id, n.delivered_at
    FROM reminders r
    JOIN tickets t ON t.id = r.ticket_id
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN notifications n ON n.id = (
      SELECT MIN(n2.id) FROM notifications n2 WHERE n2.reminder_id = r.id AND n2.user_id = r.for_user_id AND n2.read_at IS NULL
    )
    WHERE r.for_user_id = ? AND r.status = 'pending' AND ${DUE_AT} <= DATE_ADD(NOW(), INTERVAL 7 DAY)
    ORDER BY ${DUE_AT}, r.id
  `, [todayStart, userId]);

  const fresh = rows.filter((r) => r.is_due && r.notification_id && !r.delivered_at).map((r) => r.notification_id);
  if (fresh.length) await pool.query('UPDATE notifications SET delivered_at = NOW() WHERE id IN (?) AND delivered_at IS NULL', [fresh]);

  const shape = (r) => ({
    id: r.id, ticketId: r.ticket_id, ticketTitle: r.title, client: r.client_name, note: r.note || '',
    time: fmtDate(r.due_at), link: `/tickets/${r.ticket_id}#reminders`, isNew: fresh.includes(r.notification_id),
  });
  const due = rows.filter((r) => r.is_due && !r.is_missed).reverse().map(shape); // latest first
  const missed = rows.filter((r) => r.is_missed).reverse().map(shape);
  const upcoming = rows.filter((r) => !r.is_due).map(shape);
  return { count: due.length + missed.length, due, missed, upcoming, sound: fresh.length > 0 };
}

module.exports = {
  SNOOZES, reminderUsers, ticketReminders, reminderContext, readReminderForm, snoozeUntil,
  clearReminderNotifications, bellFor,
};
