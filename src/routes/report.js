// Daily Report: one day (default today) or a date range, all users or one.
const express = require('express');
const { pool } = require('../db');
const { toId } = require('../lib/http');
const { londonDate } = require('../lib/activity');
const { MAX_RANGE_DAYS, isDate, addDays, daysBetween, dayLabel, buildReport } = require('../lib/report');

const router = express.Router();

router.get('/', async (req, res) => {
  const today = londonDate();
  let from = isDate(req.query.from) ? req.query.from : today;
  let to = isDate(req.query.to) ? req.query.to : from;
  if (to < from) [from, to] = [to, from];
  let notice = null;
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
    to = addDays(from, MAX_RANGE_DAYS - 1);
    notice = `Reports cover at most ${MAX_RANGE_DAYS} days, so this one ends on ${dayLabel(to)}.`;
  }

  const [users] = await pool.query('SELECT id, username FROM users ORDER BY username');
  const userId = users.some((u) => u.id === toId(req.query.user)) ? toId(req.query.user) : null;

  const report = await buildReport({ from, to, userId });

  // Your own manual entries in this period, for editing.
  const [manual] = await pool.query(`
    SELECT id, client_name, summary, activity_date
    FROM activity_log
    WHERE entity_type = 'manual' AND user_id = ? AND activity_date BETWEEN ? AND ?
    ORDER BY activity_date, created_at, id
  `, [req.user.id, from, to]);

  const link = (range) => {
    const params = new URLSearchParams({ from: range.from });
    if (range.to !== range.from) params.set('to', range.to);
    if (userId) params.set('user', String(userId));
    return `/report?${params}`;
  };

  const span = daysBetween(from, to) + 1;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, -((dow + 6) % 7));
  const presets = [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { label: 'This week', from: monday, to: today },
    { label: 'Last week', from: addDays(monday, -7), to: addDays(monday, -1) },
  ].map((p) => ({ ...p, href: link(p), active: p.from === from && p.to === to }));

  res.render('report/index', {
    title: 'Daily Report',
    from,
    to,
    userId,
    users,
    report,
    manual,
    notice,
    presets,
    periodLabel: from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`,
    prevHref: link({ from: addDays(from, -span), to: addDays(to, -span) }),
    nextHref: link({ from: addDays(from, span), to: addDays(to, span) }),
    unit: span === 1 ? 'day' : `${span} days`,
    backPath: req.originalUrl,
  });
});

module.exports = router;
