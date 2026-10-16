// Dashboard figures, all from real ticket data, with UK (Europe/London) days:
//   week     Mon-Fri of this week: tickets opened / closed per day (bar chart)
//   fast     % of the tickets closed this week that were closed within 24 hours of being
//            opened (gauge); null when nothing was closed
//   open     open tickets; remindersToday: the signed-in user's pending reminders due today
//   people   open (not closed) tickets per assignee, for the "Open per person" stack
//   updates  latest open / customer-waiting tickets, recently updated client services
//            (from activity_log) and recently created or edited articles, 5 each
const { pool } = require('../db');
const { londonDate, londonDayStart } = require('./activity');

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// "2026-10-15" plus n days.
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// This UK week: Monday's date, and the five weekday dates.
function ukWeek(today = londonDate()) {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(today, -((dow + 6) % 7));
  const longDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${today}T12:00:00Z`));
  return { today, monday, longDay, days: DAYS.map((label, i) => ({ label, date: addDays(monday, i) })) };
}

async function weekChart(db, week) {
  const start = londonDayStart(week.monday);
  const end = londonDayStart(addDays(week.monday, 7));
  const [opened] = await db.query('SELECT created_at FROM tickets WHERE created_at >= ? AND created_at < ?', [start, end]);
  // The first time each ticket was closed this week.
  const [closed] = await db.query(`
    SELECT th.ticket_id, MIN(th.created_at) AS closed_at, t.created_at AS opened_at
    FROM ticket_history th JOIN tickets t ON t.id = th.ticket_id
    WHERE th.new_status = 'closed' AND th.created_at >= ? AND th.created_at < ?
    GROUP BY th.ticket_id, t.created_at
  `, [start, end]);
  const dayOf = (d) => londonDate(new Date(d));
  const bars = week.days.map((d) => ({
    ...d,
    opened: opened.filter((r) => dayOf(r.created_at) === d.date).length,
    closed: closed.filter((r) => dayOf(r.closed_at) === d.date).length,
    isToday: d.date === week.today,
  }));
  const fastCount = closed.filter((r) => new Date(r.closed_at) - new Date(r.opened_at) <= DAY_MS).length;
  return {
    bars,
    max: Math.max(1, ...bars.map((b) => Math.max(b.opened, b.closed))),
    totals: { opened: opened.length, closed: closed.length },
    fast: closed.length ? Math.round((fastCount / closed.length) * 100) : null,
    fastCount,
    closedCount: closed.length,
  };
}

const CARD_SQL = `
  SELECT t.id, t.title, t.status, t.priority, t.created_at, t.updated_at,
         c.id AS client_id, c.name AS client_name,
         t.assigned_to AS assigned_to_id, COALESCE(NULLIF(au.display_name, ''), au.username) AS assigned_to,
         (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id = t.id) AS comment_count,
         (SELECT COUNT(*) FROM ticket_attachments a WHERE a.ticket_id = t.id) AS attachment_count
  FROM tickets t
  JOIN clients c ON c.id = t.client_id
  LEFT JOIN users au ON au.id = t.assigned_to`;

// Board columns from a list of tickets (the Tickets page passes its filtered list).
function boardColumns(tickets, { closedLabel = 'Closed', closedLimit = 50 } = {}) {
  // Urgent first, then the most recently updated.
  const order = (a, b) => ((b.priority === 'urgent') - (a.priority === 'urgent')) || (new Date(b.updated_at) - new Date(a.updated_at));
  const col = (status, label, limit) => {
    const all = tickets.filter((t) => t.status === status).sort(order);
    return { status, label, count: all.length, tickets: limit ? all.slice(0, limit) : all, more: limit ? Math.max(0, all.length - limit) : 0 };
  };
  return [col('open', 'Open'), col('customer_waiting', 'Customer waiting'), col('closed', closedLabel, closedLimit)];
}

const UPDATES_LIMIT = 5;

// The dashboard's Updates columns.
async function recentUpdates(db) {
  const [tickets] = await db.query(`${CARD_SQL}
    WHERE t.status IN ('open', 'customer_waiting')
    ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`, [UPDATES_LIMIT]);
  // Client services have no updated_at: their latest activity (the service itself, its steps
  // and notes all log against the client service id) says who touched it last and when.
  const [services] = await db.query(`
    SELECT cs.id, cs.service_name, cs.status, c.name AS client_name, a.created_at AS updated_at,
           a.user_id AS updated_by_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS updated_by,
           (SELECT COUNT(*) FROM client_service_steps s WHERE s.client_service_id = cs.id) AS step_count,
           (SELECT COUNT(*) FROM client_service_steps s WHERE s.client_service_id = cs.id AND s.done = 1) AS done_count
    FROM (
      SELECT entity_id, MAX(id) AS last_id FROM activity_log
      WHERE entity_type IN ('client_service', 'step', 'note') AND entity_id IS NOT NULL
      GROUP BY entity_id ORDER BY last_id DESC LIMIT 20
    ) x
    JOIN activity_log a ON a.id = x.last_id
    JOIN client_services cs ON cs.id = x.entity_id
    JOIN clients c ON c.id = cs.client_id
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY x.last_id DESC LIMIT ?`, [UPDATES_LIMIT]);
  const [articles] = await db.query(`
    SELECT k.id, k.title, k.category, k.updated_at, k.created_at,
           COALESCE(k.updated_by, k.created_by) AS author_id,
           COALESCE(NULLIF(u.display_name, ''), u.username) AS author
    FROM kb_articles k LEFT JOIN users u ON u.id = COALESCE(k.updated_by, k.created_by)
    ORDER BY k.updated_at DESC, k.id DESC LIMIT ?`, [UPDATES_LIMIT]);
  return {
    tickets,
    services: services.map((s) => ({ ...s, step_count: Number(s.step_count), done_count: Number(s.done_count) })),
    articles,
  };
}

async function dashboardData(user) {
  const week = ukWeek();
  const chart = await weekChart(pool, week);
  const [[counts]] = await pool.query(`
    SELECT (SELECT COUNT(*) FROM tickets WHERE status = 'open') AS open_tickets,
           (SELECT COUNT(*) FROM tickets WHERE status = 'customer_waiting') AS waiting_tickets
  `);
  const todayStart = londonDayStart(week.today);
  const tomorrowStart = londonDayStart(addDays(week.today, 1));
  const [[rem]] = await pool.query(`
    SELECT COUNT(*) AS n FROM reminders r
    JOIN reminder_recipients rr ON rr.reminder_id = r.id
    WHERE rr.user_id = ? AND rr.done_at IS NULL AND r.status = 'pending'
      AND COALESCE(rr.snoozed_until, r.remind_at) >= ? AND COALESCE(rr.snoozed_until, r.remind_at) < ?
  `, [user.id, todayStart, tomorrowStart]);
  const [people] = await pool.query(`
    SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, COUNT(t.id) AS open_count
    FROM tickets t JOIN users u ON u.id = t.assigned_to
    WHERE t.status <> 'closed'
    GROUP BY u.id, u.display_name, u.username
    ORDER BY open_count DESC, name
  `);
  const [[unassigned]] = await pool.query("SELECT COUNT(*) AS n FROM tickets WHERE status <> 'closed' AND assigned_to IS NULL");
  const updates = await recentUpdates(pool);
  return {
    week,
    chart,
    openTickets: Number(counts.open_tickets),
    waitingTickets: Number(counts.waiting_tickets),
    remindersToday: Number(rem.n),
    people: people.map((p) => ({ id: p.id, name: p.name, count: Number(p.open_count) })),
    unassigned: Number(unassigned.n),
    updates,
  };
}

// "Good morning" / "Good afternoon" / "Good evening" by the UK hour.
function greeting(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

module.exports = { dashboardData, boardColumns, ukWeek, greeting, addDays };
