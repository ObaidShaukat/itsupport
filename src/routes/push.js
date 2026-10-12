// Desktop notifications (Web Push): the browser subscribes (after the user allows it in
// the "Enable desktop notifications" banner or on My profile) and posts its subscription
// here; unsubscribe removes it; test sends a notification to the user's own browsers.
// The browser posts with fetch (form fields + CSRF token) and gets JSON back.
const express = require('express');
const { pool } = require('../db');
const { str } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { describeAgent } = require('../lib/sessions');
const { pushStatus, pushToUser } = require('../lib/push');

const router = express.Router();

const logSelf = (req, summary) => logActivity(null, req.user, {
  type: 'user', id: req.user.id, action: 'updated', subject: req.user.name, summary,
});

// Push service URLs are https; anything else is refused.
const readEndpoint = (value) => {
  const endpoint = str(value, 700);
  return /^https:\/\/[^\s]+$/.test(endpoint) ? endpoint : '';
};

router.post('/subscribe', async (req, res) => {
  const status = pushStatus();
  if (!status.enabled) return res.status(400).json({ ok: false, error: status.message });
  const endpoint = readEndpoint(req.body.endpoint);
  const p256dh = str(req.body.p256dh, 255);
  const auth = str(req.body.auth, 100);
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ ok: false, error: 'The browser sent an incomplete subscription.' });
  const agent = str(req.get('User-Agent'), 255) || null;
  const [[existing]] = await pool.query('SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  if (existing) {
    await pool.query('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, user_agent = ? WHERE id = ?', [req.user.id, p256dh, auth, agent, existing.id]);
  } else {
    await pool.query('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)', [req.user.id, endpoint, p256dh, auth, agent]);
  }
  if (!existing || existing.user_id !== req.user.id) await logSelf(req, `Turned on desktop notifications in ${describeAgent(agent)}`);
  return res.json({ ok: true });
});

router.post('/unsubscribe', async (req, res) => {
  const endpoint = readEndpoint(req.body.endpoint);
  if (!endpoint) return res.json({ ok: true });
  const [r] = await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.user.id]);
  if (r.affectedRows) await logSelf(req, `Turned off desktop notifications in ${describeAgent(req.get('User-Agent'))}`);
  return res.json({ ok: true });
});

router.post('/test', async (req, res) => {
  const status = pushStatus();
  if (!status.enabled) return res.status(400).json({ ok: false, error: status.message });
  const sent = await pushToUser(req.user.id, {
    title: 'Desktop notifications are on',
    body: 'Reminders, @mentions and reminders you are added to will show like this.',
    url: '/profile#notifications',
    tag: 'test',
  });
  if (!sent) {
    const [[me]] = await pool.query('SELECT notify_channels FROM users WHERE id = ?', [req.user.id]);
    const off = !String(me && me.notify_channels).split(',').includes('desktop');
    return res.status(400).json({ ok: false, error: off ? 'Tick "Desktop notification" under Notifications and save first.' : 'No browser is subscribed yet. Turn desktop notifications on first.' });
  }
  return res.json({ ok: true, sent });
});

module.exports = router;
