// Dashboard: greeting, "Open per person", this week's tickets chart, the closed-within-24h
// gauge, Open tickets / Reminders today tiles, the Email services card and the ticket board (src/lib/dashboard.js).
const express = require('express');
const { dashboardData, dashboardEmail, greeting } = require('../lib/dashboard');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const data = await dashboardData(req.user);
  res.render('dashboard', { title: 'Dashboard', ...data, hello: greeting() });
});

// The Email services card drawn again (polled every 60s by app.js, so it follows the checks).
router.get('/dashboard/email-services', async (req, res) => {
  const email = await dashboardEmail(pool);
  res.set('Cache-Control', 'no-store');
  res.render('partials/dash-email', { email }, (err, html) => {
    if (err) return res.status(500).json({ ok: false });
    return res.json({ ok: true, html, issues: email ? email.issues : 0 });
  });
});

module.exports = router;
