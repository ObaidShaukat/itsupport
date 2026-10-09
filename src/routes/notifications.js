// In-portal notifications (bell + toasts). The browser polls every 60 seconds; each
// poll turns the signed-in user's due ticket reminders into notification rows
// (channel 'portal'; 'email' / 'teams' are reserved for later). There is no background
// job, so a reminder notifies when its recipient next has the portal open.
// Done and snooze are on /reminders (src/routes/reminders.js).
const express = require('express');
const { pool } = require('../db');
const { requireId, safePath } = require('../lib/http');
const { bellFor } = require('../lib/reminders');

const router = express.Router();

router.get('/poll', async (req, res) => {
  const bell = await bellFor(req.user, req.fmt.fmtDate);
  res.json({ ok: true, ...bell });
});

// Opens a notification (e.g. an @mention in the bell): marks it read (only the user's
// own) and goes to its page.
router.get('/:id/open', async (req, res) => {
  const id = requireId(req.params.id);
  const [[n]] = await pool.query('SELECT id, link FROM notifications WHERE id = ? AND user_id = ?', [id, req.user.id]);
  if (!n) return res.redirect('/');
  await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = ?', [n.id]);
  return res.redirect(safePath(n.link, '/'));
});

module.exports = router;
