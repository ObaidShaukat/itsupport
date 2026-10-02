const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const [[counts]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM tickets WHERE status = 'open') AS openTickets,
      (SELECT COUNT(*) FROM tickets WHERE status = 'customer_waiting') AS waitingTickets,
      (SELECT COUNT(*) FROM client_services WHERE status = 'open') AS openServices
  `);

  const [recentTickets] = await pool.query(`
    SELECT t.id, t.title, t.status, t.created_at, t.updated_at, c.id AS client_id, c.name AS client_name,
           u.username AS created_by
    FROM tickets t
    JOIN clients c ON c.id = t.client_id
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.status <> 'closed'
    ORDER BY t.updated_at DESC
    LIMIT 8
  `);

  const [openServices] = await pool.query(`
    SELECT cs.id, cs.service_name, cs.client_id, c.name AS client_name, cs.created_at,
           u.username AS assigned_by,
           COUNT(css.id) AS step_count, COALESCE(SUM(css.done), 0) AS done_count
    FROM client_services cs
    JOIN clients c ON c.id = cs.client_id
    LEFT JOIN users u ON u.id = cs.assigned_by
    LEFT JOIN client_service_steps css ON css.client_service_id = cs.id
    WHERE cs.status = 'open'
    GROUP BY cs.id, cs.service_name, cs.client_id, c.name, cs.created_at, u.username
    ORDER BY cs.created_at DESC
    LIMIT 8
  `);

  res.render('dashboard', {
    title: 'Dashboard',
    counts: {
      openTickets: Number(counts.openTickets),
      waitingTickets: Number(counts.waitingTickets),
      openServices: Number(counts.openServices),
    },
    recentTickets,
    openServices,
  });
});

module.exports = router;
