// Ticket reminders with one or more recipients. remind_at is a UK time chosen by the user
// and stored in UTC. Each recipient (reminder_recipients) has their own snooze, email
// state and done mark; a reminder is complete ('done') when every recipient has marked
// it done, or when its creator marks it done for everyone. Reminders are logged
// (entity_type 'reminder', entity_id = ticket id) for history only, never on the Daily Report.
//
// When a recipient's reminder is due (COALESCE(their snoozed_until, remind_at) <= NOW()):
//  - popup: one unread 'ticket_reminder' row in notifications for them (users with the
//    popup or both preference); Done, snooze, edit and delete mark it read, so a snoozed
//    or rescheduled reminder notifies again;
//  - email: sent once per due time (users with the email or both preference), see
//    sendDueReminderEmails; snooze and edits clear sent_at so the next due time emails again.
const { pool, transaction } = require('../db');
const { str, toId } = require('./http');
const { londonDate, londonDayStart, londonLocalToUtc, toLondonInput } = require('./activity');
const { addDays } = require('./report');
const { formattersFor } = require('./dates');

const DUE_AT = 'COALESCE(rr.snoozed_until, r.remind_at)';
const USER_NAME = (alias) => `COALESCE(NULLIF(${alias}.display_name, ''), ${alias}.username)`;

// Snooze choices offered on toasts: 10 minutes, 1 hour, tomorrow 09:00 (UK).
const SNOOZES = { '10m': '10 minutes', '1h': '1 hour', tomorrow: 'tomorrow 09:00' };

async function reminderUsers() {
  const [users] = await pool.query(`SELECT id, ${USER_NAME('u')} AS name FROM users u ORDER BY name`);
  return users;
}

// Recipients of the given reminders: Map reminderId -> [{ user_id, name, done_at, snoozed_until }].
async function recipientsOf(db, ids) {
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const [rows] = await db.query(`
    SELECT rr.reminder_id, rr.user_id, ${USER_NAME('u')} AS name, rr.done_at, rr.snoozed_until, rr.sent_at
    FROM reminder_recipients rr JOIN users u ON u.id = rr.user_id
    WHERE rr.reminder_id IN (?)
    ORDER BY name
  `, [ids]);
  for (const r of rows) out.get(r.reminder_id).push(r);
  return out;
}

const namesOf = (recipients) => recipients.map((x) => x.name).join(', ') || 'nobody';

// Reminders on one ticket: pending (soonest first) and done (latest first), each with
// its recipients and their state.
async function ticketReminders(ticketId) {
  const [rows] = await pool.query(`
    SELECT r.id, r.note, r.remind_at, r.status, r.done_at, r.created_by, r.created_at, r.updated_at,
           r.remind_at <= NOW() AS is_due,
           ${USER_NAME('cu')} AS created_name, ${USER_NAME('uu')} AS updated_name
    FROM reminders r
    LEFT JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users uu ON uu.id = r.updated_by
    WHERE r.ticket_id = ?
    ORDER BY r.status = 'done', r.remind_at, r.id
  `, [ticketId]);
  const recipients = await recipientsOf(pool, rows.map((r) => r.id));
  for (const r of rows) {
    r.input = toLondonInput(r.remind_at);
    r.recipients = recipients.get(r.id) || [];
    r.recipientIds = r.recipients.map((x) => x.user_id);
  }
  return {
    pending: rows.filter((r) => r.status === 'pending'),
    done: rows.filter((r) => r.status === 'done').sort((a, b) => new Date(b.done_at) - new Date(a.done_at)),
  };
}

// One reminder with its ticket, client and recipients (for logging), or null.
async function reminderContext(db, id, lock = false) {
  const [[reminder]] = await db.query(`
    SELECT r.id, r.ticket_id, r.note, r.remind_at, r.status, r.created_by, r.remind_at AS due_at,
           t.title AS ticket_title, t.client_id, c.name AS client_name
    FROM reminders r
    JOIN tickets t ON t.id = r.ticket_id
    JOIN clients c ON c.id = t.client_id
    WHERE r.id = ? ${lock ? 'FOR UPDATE' : ''}
  `, [id]);
  if (!reminder) return null;
  reminder.recipients = (await recipientsOf(db, [reminder.id])).get(reminder.id) || [];
  return reminder;
}

// Add / edit form: note, for (one or more user ids, default the signed-in user),
// remind_at (UK time). Returns { form } or { error }.
async function readReminderForm(db, body, userId) {
  const raw = [].concat(body.for_user_ids || body.for_user_id || []);
  const ids = [...new Set(raw.map(toId).filter(Boolean))];
  const form = {
    note: str(body.note, 500) || null,
    // The form sends for_present=1, so ticking nobody is an error, not "me".
    userIds: ids.length ? ids : (body.for_present ? [] : [userId]),
    remindAt: londonLocalToUtc(body.remind_at),
  };
  if (!form.remindAt) return { error: 'Choose a date and time for the reminder.' };
  if (!form.userIds.length) return { error: 'Choose who the reminder is for.' };
  const [users] = await db.query(`SELECT id, ${USER_NAME('u')} AS name FROM users u WHERE id IN (?) ORDER BY name`, [form.userIds]);
  if (users.length !== form.userIds.length) return { error: 'Choose who the reminder is for.' };
  form.users = users;
  form.names = users.map((u) => u.name).join(', ');
  return { form };
}

// UTC time for a snooze choice, or null for an unknown choice.
function snoozeUntil(choice) {
  if (choice === '10m') return new Date(Date.now() + 10 * 60000);
  if (choice === '1h') return new Date(Date.now() + 60 * 60000);
  if (choice === 'tomorrow') return londonLocalToUtc(`${addDays(londonDate(), 1)}T09:00`);
  return null;
}

// Marks open notifications of a reminder (one user's, or everyone's), or of a whole
// ticket's reminders, read; or deletes them.
async function clearReminderNotifications(db, { reminderId, ticketId, userId, remove = false }) {
  const where = [];
  const params = [];
  if (reminderId) { where.push('n.reminder_id = ?'); params.push(reminderId); }
  else { where.push('n.reminder_id IN (SELECT r.id FROM reminders r WHERE r.ticket_id = ?)'); params.push(ticketId); }
  if (userId) { where.push('n.user_id = ?'); params.push(userId); }
  if (remove) await db.query(`DELETE n FROM notifications n WHERE ${where.join(' AND ')}`, params);
  else await db.query(`UPDATE notifications n SET n.read_at = NOW() WHERE n.read_at IS NULL AND ${where.join(' AND ')}`, params);
}

// Sets a reminder's recipients. Removed people lose their notifications; with
// resetTimes (a new time) everyone's snooze and email state start again.
async function setRecipients(conn, reminderId, userIds, { resetTimes = false } = {}) {
  const [current] = await conn.query('SELECT user_id FROM reminder_recipients WHERE reminder_id = ?', [reminderId]);
  const before = current.map((r) => r.user_id);
  for (const uid of before.filter((id) => !userIds.includes(id))) {
    await conn.query('DELETE FROM reminder_recipients WHERE reminder_id = ? AND user_id = ?', [reminderId, uid]);
    await clearReminderNotifications(conn, { reminderId, userId: uid, remove: true });
  }
  for (const uid of userIds.filter((id) => !before.includes(id))) {
    await conn.query('INSERT INTO reminder_recipients (reminder_id, user_id) VALUES (?, ?)', [reminderId, uid]);
  }
  if (resetTimes) {
    await conn.query('UPDATE reminder_recipients SET snoozed_until = NULL, sent_at = NULL WHERE reminder_id = ?', [reminderId]);
    await clearReminderNotifications(conn, { reminderId });
  }
  await conn.query('UPDATE reminders SET for_user_id = ? WHERE id = ?', [userIds[0] || null, reminderId]);
  return { added: userIds.filter((id) => !before.includes(id)), removed: before.filter((id) => !userIds.includes(id)) };
}

// Marks the reminder done for one recipient, or (everyone) for all of them. The reminder
// is complete once nobody is left. Returns { complete, already }.
async function markDone(conn, reminder, userId, { everyone = false } = {}) {
  if (everyone) {
    await conn.query('UPDATE reminder_recipients SET done_at = NOW() WHERE reminder_id = ? AND done_at IS NULL', [reminder.id]);
    await clearReminderNotifications(conn, { reminderId: reminder.id });
  } else {
    const [r] = await conn.query('UPDATE reminder_recipients SET done_at = NOW() WHERE reminder_id = ? AND user_id = ? AND done_at IS NULL', [reminder.id, userId]);
    await clearReminderNotifications(conn, { reminderId: reminder.id, userId });
    if (!r.affectedRows) return { complete: reminder.status === 'done', already: true };
  }
  const [[{ open }]] = await conn.query('SELECT COUNT(*) AS open FROM reminder_recipients WHERE reminder_id = ? AND done_at IS NULL', [reminder.id]);
  if (!Number(open)) {
    await conn.query("UPDATE reminders SET status = 'done', done_at = NOW(), updated_by = ? WHERE id = ?", [userId, reminder.id]);
    return { complete: true };
  }
  await conn.query('UPDATE reminders SET updated_by = ? WHERE id = ?', [userId, reminder.id]);
  return { complete: false };
}

// One recipient snoozes it for themselves.
async function snoozeFor(conn, reminder, userId, until) {
  const [r] = await conn.query('UPDATE reminder_recipients SET snoozed_until = ?, sent_at = NULL WHERE reminder_id = ? AND user_id = ? AND done_at IS NULL',
    [until, reminder.id, userId]);
  await clearReminderNotifications(conn, { reminderId: reminder.id, userId });
  return r.affectedRows > 0;
}

// Gives each of the user's due reminders one unread notification. Called on every poll;
// the row locks stop two open tabs creating the same notification twice.
async function createDueNotifications(userId) {
  await transaction(async (conn) => {
    const [due] = await conn.query(`
      SELECT r.id, r.note, r.ticket_id, t.title, c.name AS client_name
      FROM reminder_recipients rr
      JOIN reminders r ON r.id = rr.reminder_id
      JOIN tickets t ON t.id = r.ticket_id
      JOIN clients c ON c.id = t.client_id
      WHERE rr.user_id = ? AND rr.done_at IS NULL AND r.status = 'pending' AND ${DUE_AT} <= NOW()
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

// The bell: the user's own pending reminders that are due now (today, UK), missed (due
// before today) or upcoming (next 7 days), plus unread @mentions. Toasts are the due and
// missed reminders; isNew is true the first time one is shown (the sound plays once).
// users.reminder_channel: 'popup' and 'both' get notifications, toasts and the sound;
// 'email' only still sees the bell list, but no popups.
async function bellFor(user, fmtDate) {
  const userId = user.id;
  const popup = user.reminder_channel !== 'email';
  if (popup) await createDueNotifications(userId);
  const todayStart = londonDayStart(londonDate());
  const [rows] = await pool.query(`
    SELECT r.id, r.note, r.ticket_id, t.title, c.name AS client_name, ${DUE_AT} AS due_at,
           ${DUE_AT} <= NOW() AS is_due, ${DUE_AT} < ? AS is_missed,
           n.id AS notification_id, n.delivered_at
    FROM reminder_recipients rr
    JOIN reminders r ON r.id = rr.reminder_id
    JOIN tickets t ON t.id = r.ticket_id
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN notifications n ON n.id = (
      SELECT MIN(n2.id) FROM notifications n2 WHERE n2.reminder_id = r.id AND n2.user_id = rr.user_id AND n2.read_at IS NULL
    )
    WHERE rr.user_id = ? AND rr.done_at IS NULL AND r.status = 'pending' AND ${DUE_AT} <= DATE_ADD(NOW(), INTERVAL 7 DAY)
    ORDER BY ${DUE_AT}, r.id
  `, [todayStart, userId]);
  const [mentionRows] = await pool.query(`
    SELECT id, title, body, created_at, delivered_at FROM notifications
    WHERE user_id = ? AND type = 'mention' AND read_at IS NULL
    ORDER BY id DESC LIMIT 20
  `, [userId]);

  const fresh = rows.filter((r) => r.is_due && r.notification_id && !r.delivered_at).map((r) => r.notification_id);
  const freshMentions = mentionRows.filter((m) => !m.delivered_at).map((m) => m.id);
  if (fresh.length || freshMentions.length) {
    await pool.query('UPDATE notifications SET delivered_at = NOW() WHERE id IN (?) AND delivered_at IS NULL', [[...fresh, ...freshMentions]]);
  }

  const shape = (r) => ({
    id: r.id, ticketId: r.ticket_id, ticketTitle: r.title, client: r.client_name, note: r.note || '',
    time: fmtDate(r.due_at), link: `/tickets/${r.ticket_id}#reminders`, isNew: fresh.includes(r.notification_id),
  });
  const due = rows.filter((r) => r.is_due && !r.is_missed).reverse().map(shape); // latest first
  const missed = rows.filter((r) => r.is_missed).reverse().map(shape);
  const upcoming = rows.filter((r) => !r.is_due).map(shape);
  const mentions = mentionRows.map((m) => ({ id: m.id, title: m.title, body: m.body || '', time: fmtDate(m.created_at), link: `/notifications/${m.id}/open` }));
  return {
    count: due.length + missed.length + mentions.length, due, missed, upcoming, mentions, popup,
    sound: (popup && fresh.length > 0) || freshMentions.length > 0,
  };
}

// ---- Reminder emails ----
// A timer in index.js calls sendDueReminderEmails() every minute. Each recipient's due
// reminder is emailed to them once per due time: sent_at is claimed (set) before sending,
// so it never double-sends; snooze and time edits clear it so the next due time emails
// again. Users who chose "Popup only" are not emailed. Reminders that fell due more than
// a day ago (e.g. while email was not set up) are not emailed late; they still show in
// the portal. The due time is shown in the recipient's own date format (24h UK time).
const londonTime = (date, format) => formattersFor(format).fmtDate(date);

function reminderEmail(r) {
  const { escapeHtml: e, appUrl } = mailer();
  const base = appUrl();
  const link = base ? `${base}/tickets/${r.ticket_id}#reminders` : '';
  const ticket = `#${r.ticket_id} ${r.title}`;
  const subject = `Reminder: ${r.note || ticket}`.replace(/\s+/g, ' ').slice(0, 200);
  const font = 'font-family: Arial, Helvetica, sans-serif;';
  const row = (label, value) => `<tr><td style="${font} padding: 6px 12px 6px 0; color: #6E6E73; font-size: 13px; vertical-align: top; white-space: nowrap;">${label}</td>`
    + `<td style="${font} padding: 6px 0; color: #000000; font-size: 14px;">${value}</td></tr>`;
  const html = `<!doctype html><html><body style="margin: 0; padding: 0; background: #F5F5F7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #F5F5F7; padding: 24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; overflow: hidden;">
<tr><td style="${font} background: #200D6C; color: #FFFFFF; padding: 18px 24px; font-size: 16px; font-weight: bold;">Cleartwo <span style="color: #B9A6F0; font-weight: normal;">IT Support</span></td></tr>
<tr><td style="padding: 24px;">
<p style="${font} margin: 0 0 6px; color: #6741C3; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Reminder</p>
<p style="${font} margin: 0 0 18px; color: #200D6C; font-size: 20px; font-weight: bold; line-height: 1.35; white-space: pre-line;">${e(r.note || ticket)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 22px;">
${row('Due', `${e(londonTime(r.due_at, r.date_format))} (UK time)`)}
${row('Ticket', e(ticket))}
${row('Client', e(r.client_name))}
</table>
${link
    ? `<a href="${e(link)}" style="${font} display: inline-block; background: #0390D7; color: #FFFFFF; text-decoration: none; font-weight: bold; font-size: 14px; padding: 12px 22px; border-radius: 999px;">Open ticket #${r.ticket_id}</a>`
    : `<p style="${font} margin: 0; font-size: 14px;">Open ticket #${r.ticket_id} in the IT Support portal.</p>`}
</td></tr>
</table>
<p style="${font} color: #6E6E73; font-size: 12px; margin: 14px 0 0;">You are getting this because a reminder on this ticket was set for you.</p>
</td></tr></table></body></html>`;
  const text = [
    'Reminder', '', r.note || ticket, '',
    `Due: ${londonTime(r.due_at, r.date_format)} (UK time)`, `Ticket: ${ticket}`, `Client: ${r.client_name}`,
    link ? `\nOpen the ticket: ${link}` : '',
  ].join('\n');
  return { subject, html, text };
}

// Loaded lazily so this module does not need SMTP settings to be required.
const mailer = () => require('./mailer');

async function sendDueReminderEmails() {
  const { mailStatus, sendMail, logSkipped, userEmail } = mailer();
  if (!mailStatus().enabled) return 0;
  const claimed = await transaction(async (conn) => {
    const [due] = await conn.query(`
      SELECT r.id, r.note, r.ticket_id, rr.user_id, ${DUE_AT} AS due_at, t.title, c.name AS client_name, u.username, u.date_format
      FROM reminder_recipients rr
      JOIN reminders r ON r.id = rr.reminder_id
      JOIN tickets t ON t.id = r.ticket_id
      JOIN clients c ON c.id = t.client_id
      JOIN users u ON u.id = rr.user_id
      WHERE r.status = 'pending' AND rr.done_at IS NULL AND rr.sent_at IS NULL AND u.reminder_channel IN ('email', 'both')
        AND ${DUE_AT} <= NOW() AND ${DUE_AT} > DATE_SUB(NOW(), INTERVAL 1 DAY)
      ORDER BY ${DUE_AT}, r.id
      LIMIT 50
      FOR UPDATE
    `);
    for (const r of due) await conn.query('UPDATE reminder_recipients SET sent_at = NOW() WHERE reminder_id = ? AND user_id = ?', [r.id, r.user_id]);
    return due;
  });
  for (const r of claimed) {
    const message = { to: userEmail(r), ...reminderEmail(r) };
    const meta = { kind: 'reminder', userId: r.user_id, reminderId: r.id };
    if (!message.to) {
      await logSkipped({ ...message, to: r.username }, meta, 'This user has no email address (their username is not an email address).');
      continue;
    }
    await sendMail(message, meta);
  }
  return claimed.length;
}

module.exports = {
  sendDueReminderEmails, reminderEmail,
  SNOOZES, reminderUsers, ticketReminders, reminderContext, readReminderForm, snoozeUntil,
  clearReminderNotifications, setRecipients, markDone, snoozeFor, namesOf, bellFor,
};
