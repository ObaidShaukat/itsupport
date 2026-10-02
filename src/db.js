const mysql = require('mysql2/promise');
const config = require('./config');

// Times are stored in UTC: every connection runs with time_zone +00:00 (so NOW()
// and CURRENT_TIMESTAMP are UTC) and mysql2 reads DATETIMEs back as UTC. Pages show
// them in UK time (fmtDate), and report days are UK dates (activity_date).
const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z',
  // DATE columns (e.g. activity_log.activity_date) come back as 'YYYY-MM-DD'
  // strings, so no timezone shifting happens. DATETIMEs are still Date objects.
  dateStrings: ['DATE'],
});

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

// Runs fn(conn) inside a transaction, committing on success and rolling back on error.
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, transaction };
