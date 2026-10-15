// Dashboard: greeting, "Open per person", this week's tickets chart, the closed-within-24h
// gauge, Open tickets / Reminders today tiles and the ticket board (src/lib/dashboard.js).
const express = require('express');
const { dashboardData, greeting } = require('../lib/dashboard');

const router = express.Router();

router.get('/', async (req, res) => {
  const data = await dashboardData(req.user);
  res.render('dashboard', { title: 'Dashboard', ...data, hello: greeting() });
});

module.exports = router;
