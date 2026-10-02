// Raw activity_log for one UK date: a check page for what was logged.
const express = require('express');
const { pool } = require('../db');
const { toId } = require('../lib/http');
const { ENTITY_TYPES, londonDate } = require('../lib/activity');
const { isDate, addDays, dayLabel } = require('../lib/report');

const router = express.Router();

router.get('/', async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : londonDate();
  const [users] = await pool.query('SELECT id, username FROM users ORDER BY username');
  const userId = users.some((u) => u.id === toId(req.query.user)) ? toId(req.query.user) : null;
  const type = ENTITY_TYPES.includes(req.query.type) ? req.query.type : '';

  const where = ['l.activity_date = ?'];
  const params = [date];
  if (userId) {
    where.push('l.user_id = ?');
    params.push(userId);
  }
  if (type) {
    where.push('l.entity_type = ?');
    params.push(type);
  }
  const [entries] = await pool.query(`
    SELECT l.id, l.created_at, l.updated_at, l.activity_date, u.username, l.action, l.entity_type, l.entity_id,
           l.client_id, l.client_name, l.subject, l.summary
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.created_at, l.id
  `, params);

  const link = (d) => {
    const q = new URLSearchParams({ date: d });
    if (userId) q.set('user', String(userId));
    if (type) q.set('type', type);
    return `/activity?${q}`;
  };

  res.render('activity/index', {
    title: 'Activity log',
    date,
    dateLabel: dayLabel(date),
    users,
    userId,
    type,
    types: ENTITY_TYPES,
    entries,
    prevHref: link(addDays(date, -1)),
    nextHref: link(addDays(date, 1)),
    reportHref: `/report?from=${date}${userId ? `&user=${userId}` : ''}`,
  });
});

module.exports = router;
