// In-portal notifications (bell + toasts). The browser polls every 60 seconds; each
// poll turns the signed-in user's due ticket reminders into notification rows
// (channel 'portal'; 'email' / 'teams' are reserved for later). There is no background
// job, so a reminder notifies when its recipient next has the portal open.
// Done and snooze are on /reminders (src/routes/reminders.js).
const express = require('express');
const { bellFor } = require('../lib/reminders');

const router = express.Router();

router.get('/poll', async (req, res) => {
  const bell = await bellFor(req.user, req.fmt.fmtDate);
  res.json({ ok: true, ...bell });
});

module.exports = router;
