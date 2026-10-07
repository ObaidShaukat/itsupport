// Daily Report: one day (default today) or a date range. "View" picks whose work is
// shown: 'me' (default), 'all' or a user id. The last choice is saved on the user
// (users.report_view); that is a display preference, so it is not activity-logged.
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

  const [users] = await pool.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name FROM users ORDER BY name");

  // ?view= wins (and is remembered); otherwise the saved choice; otherwise "me".
  // The old ?user= links still work.
  const valid = (v) => v === 'me' || v === 'all' || users.some((u) => String(u.id) === v);
  let view = typeof req.query.view === 'string' ? req.query.view : (toId(req.query.user) ? String(toId(req.query.user)) : '');
  if (valid(view)) {
    if (view !== req.user.report_view) {
      await pool.query('UPDATE users SET report_view = ? WHERE id = ?', [view, req.user.id]);
    }
  } else {
    view = valid(req.user.report_view || '') ? req.user.report_view : 'me';
  }
  const userId = view === 'all' ? null : view === 'me' ? req.user.id : Number(view);

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
    params.set('view', view);
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
    view,
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
