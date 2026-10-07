// Active sessions (My profile). express-mysql-session keeps the session data in its
// "sessions" table; user_sessions records the user, browser (user agent), IP address,
// sign-in time and last activity for each one. Signing a session out destroys it in
// the store (so its cookie stops working at once) and deletes the row.
const { pool } = require('../db');

let store = null;
const setStore = (sessionStore) => { store = sessionStore; };

const TOUCH_MS = 60 * 1000; // last_active is written at most once a minute per session

// Records (or refreshes) the current session. Called on sign-in and on every signed-in
// request; only writes when a minute has passed since the last write.
async function trackSession(req, { force = false } = {}) {
  if (!req.session || !req.session.userId) return;
  const now = Date.now();
  if (!force && req.session.trackedAt && now - req.session.trackedAt < TOUCH_MS) return;
  req.session.trackedAt = now; // throttle only; the stored times come from MySQL
  await pool.query(`
    INSERT INTO user_sessions (session_id, user_id, user_agent, ip) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), user_agent = VALUES(user_agent), ip = VALUES(ip), last_active = NOW()
  `, [req.sessionID, req.session.userId, String(req.get('User-Agent') || '').slice(0, 500) || null, String(req.ip || '').slice(0, 64) || null]);
}

// "Chrome on Windows", "Safari on iPhone", ...
function describeAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown device';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
      : /Firefox\//.test(s) ? 'Firefox'
        : /Chrome\/|CriOS\//.test(s) ? 'Chrome'
          : /Safari\//.test(s) ? 'Safari'
            : 'Browser';
  const os = /iPhone/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
      : /Android/.test(s) ? 'Android'
        : /Windows/.test(s) ? 'Windows'
          : /Mac OS X|Macintosh/.test(s) ? 'macOS'
            : /CrOS/.test(s) ? 'ChromeOS'
              : /Linux/.test(s) ? 'Linux'
                : 'unknown system';
  return `${browser} on ${os}`;
}

// Removes rows whose session has ended (expired, or destroyed by signing out).
async function pruneSessions(userId) {
  try {
    await pool.query(`
      DELETE us FROM user_sessions us
      LEFT JOIN sessions s ON s.session_id = us.session_id
      WHERE us.user_id = ? AND (s.session_id IS NULL OR s.expires < UNIX_TIMESTAMP())
    `, [userId]);
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
}

async function listSessions(userId, currentSessionId) {
  await pruneSessions(userId);
  const [rows] = await pool.query(
    'SELECT id, session_id, user_agent, ip, created_at, last_active FROM user_sessions WHERE user_id = ? ORDER BY last_active DESC, id DESC',
    [userId]
  );
  return rows.map((r) => ({
    id: r.id, device: describeAgent(r.user_agent), userAgent: r.user_agent, ip: r.ip,
    createdAt: r.created_at, lastActive: r.last_active, current: r.session_id === currentSessionId,
  }));
}

async function destroy(sessionId) {
  if (store) await store.destroy(sessionId);
  await pool.query('DELETE FROM user_sessions WHERE session_id = ?', [sessionId]);
}

// Signs out one of the user's sessions by its row id. Returns its description, or null.
async function signOutSession(userId, id, currentSessionId) {
  const [[row]] = await pool.query('SELECT session_id, user_agent FROM user_sessions WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row || row.session_id === currentSessionId) return null;
  await destroy(row.session_id);
  return describeAgent(row.user_agent);
}

// Signs out every session of the user except keepSessionId (pass null for all).
// Returns how many were signed out. Used by "Sign out all other sessions" and after a
// password change or reset.
async function signOutOtherSessions(userId, keepSessionId) {
  const [rows] = await pool.query('SELECT session_id FROM user_sessions WHERE user_id = ?', [userId]);
  const others = rows.filter((r) => r.session_id !== keepSessionId);
  for (const r of others) await destroy(r.session_id);
  // Sessions from before tracking started have no row: find them in the store's data.
  try {
    const [untracked] = await pool.query(
      "SELECT session_id FROM sessions WHERE session_id <> ? AND (data LIKE ? OR data LIKE ?)",
      [keepSessionId || '', `%"userId":${Number(userId)},%`, `%"userId":${Number(userId)}}%`]
    );
    for (const r of untracked) await destroy(r.session_id);
    return others.length + untracked.length;
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    return others.length;
  }
}

const forgetSession = (sessionId) => pool.query('DELETE FROM user_sessions WHERE session_id = ?', [sessionId]);

module.exports = { setStore, trackSession, describeAgent, listSessions, signOutSession, signOutOtherSessions, forgetSession };
