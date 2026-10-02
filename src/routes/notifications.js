// In-portal notifications (bell + toast). The browser polls every 60 seconds; each
// poll turns the user's due task reminders into notifications. There is no background
// job, so reminders are created when their recipient next has the portal open.
const express = require('express');
const { pool, transaction } = require('../db');
const { requireId, notFound } = require('../lib/http');
const { logActivity, londonDate, londonLocalToUtc } = require('../lib/activity');
const { addDays } = require('../lib/report');

const router = express.Router();

// Reminders go to the assignee, or to the creator when nobody is assigned.
async function createDueReminders(userId) {
  await transaction(async (conn) => {
    const [due] = await conn.query(`
      SELECT t.id, t.title, t.due_at, COALESCE(c.name, tc.name) AS client_name
      FROM tasks t
      LEFT JOIN clients c ON c.id = t.client_id
      LEFT JOIN tickets tk ON tk.id = t.ticket_id
      LEFT JOIN clients tc ON tc.id = tk.client_id
      WHERE t.status = 'todo' AND t.remind_at IS NOT NULL AND t.remind_at <= NOW()
        AND t.reminder_sent_at IS NULL AND COALESCE(t.assigned_to, t.created_by) = ?
      FOR UPDATE
    `, [userId]);
    for (const task of due) {
      await conn.query(
        "INSERT INTO notifications (user_id, channel, type, title, body, link, task_id) VALUES (?, 'portal', 'task_reminder', ?, ?, ?, ?)",
        [userId, `Reminder: ${task.title}`.slice(0, 255), task.client_name ? `Task for ${task.client_name}` : 'Task reminder',
          `/tasks?task=${task.id}`, task.id]
      );
      await conn.query('UPDATE tasks SET reminder_sent_at = NOW() WHERE id = ?', [task.id]);
    }
  });
}

router.get('/poll', async (req, res) => {
  await createDueReminders(req.user.id);
  const fmt = req.app.locals.fmtDate;
  const shape = (n) => ({ id: n.id, title: n.title, body: n.body, link: n.link, taskId: n.task_id, read: Boolean(n.read_at), time: fmt(n.created_at) });

  const [items] = await pool.query(`
    SELECT id, title, body, link, task_id, created_at, read_at FROM notifications
    WHERE user_id = ? AND channel = 'portal'
    ORDER BY read_at IS NOT NULL, created_at DESC, id DESC LIMIT 20
  `, [req.user.id]);
  const [[{ unread }]] = await pool.query(
    "SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND channel = 'portal' AND read_at IS NULL",
    [req.user.id]
  );
  // New ones are shown once as a toast.
  const [fresh] = await pool.query(`
    SELECT id, title, body, link, task_id, created_at, read_at FROM notifications
    WHERE user_id = ? AND channel = 'portal' AND read_at IS NULL AND delivered_at IS NULL
    ORDER BY created_at, id LIMIT 5
  `, [req.user.id]);
  if (fresh.length) {
    await pool.query('UPDATE notifications SET delivered_at = NOW() WHERE id IN (?)', [fresh.map((n) => n.id)]);
  }

  res.json({ ok: true, unread: Number(unread), items: items.map(shape), toasts: fresh.map(shape) });
});

async function ownNotification(req) {
  const [[n]] = await pool.query('SELECT id, task_id FROM notifications WHERE id = ? AND user_id = ?', [requireId(req.params.id), req.user.id]);
  if (!n) throw notFound();
  return n;
}

// Read state is UI state, not work, so it is not written to the activity log.
router.post('/:id/read', async (req, res) => {
  const n = await ownNotification(req);
  await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = ?', [n.id]);
  res.json({ ok: true });
});

router.post('/read-all', async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
});

// Snooze: 10m, 1h or tomorrow (09:00 UK). Moves the task's reminder and marks this
// notification read; a new notification appears when the reminder is due again.
router.post('/:id/snooze', async (req, res) => {
  const n = await ownNotification(req);
  if (!n.task_id) return res.status(400).json({ ok: false, error: 'This notification has no task to snooze.' });
  const until = req.body.until;
  if (!['10m', '1h', 'tomorrow'].includes(until)) return res.status(400).json({ ok: false, error: 'Choose 10m, 1h or tomorrow.' });

  await transaction(async (conn) => {
    const [[task]] = await conn.query(`
      SELECT t.id, t.title, COALESCE(c.id, tc.id) AS client_id, COALESCE(c.name, tc.name) AS client_name
      FROM tasks t
      LEFT JOIN clients c ON c.id = t.client_id
      LEFT JOIN tickets tk ON tk.id = t.ticket_id
      LEFT JOIN clients tc ON tc.id = tk.client_id
      WHERE t.id = ? FOR UPDATE
    `, [n.task_id]);
    if (!task) throw notFound();
    if (until === 'tomorrow') {
      const tomorrow9 = londonLocalToUtc(`${addDays(londonDate(), 1)}T09:00`);
      await conn.query('UPDATE tasks SET remind_at = ?, reminder_sent_at = NULL, updated_by = ? WHERE id = ?', [tomorrow9, req.user.id, task.id]);
    } else {
      const minutes = until === '10m' ? 10 : 60;
      await conn.query(
        'UPDATE tasks SET remind_at = DATE_ADD(NOW(), INTERVAL ? MINUTE), reminder_sent_at = NULL, updated_by = ? WHERE id = ?',
        [minutes, req.user.id, task.id]
      );
    }
    await conn.query('UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = ?', [n.id]);
    const label = { '10m': '10 minutes', '1h': '1 hour', tomorrow: 'tomorrow 09:00' }[until];
    await logActivity(conn, req.user, {
      type: 'task', id: task.id, action: 'updated', subject: task.title, clientId: task.client_id, clientName: task.client_name,
      summary: `Snoozed the reminder for ${label}`, changes: ['reminder'],
    });
  });
  res.json({ ok: true });
});

module.exports = router;
