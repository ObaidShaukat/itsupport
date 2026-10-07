const { pool } = require('../db');
const { formattersFor } = require('../lib/dates');
const { trackSession } = require('../lib/sessions');

// Every page except login requires a signed-in user. The user is reloaded on each
// request so a deleted account is signed out straight away.
async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');

  const [[user]] = await pool.query('SELECT id, username, display_name, job_title, avatar_file, reminder_channel, date_format, role, report_view FROM users WHERE id = ?', [req.session.userId]);
  if (!user) {
    return req.session.destroy(() => res.redirect('/login'));
  }

  // name: what to show for this user (display name, or the username when empty).
  user.name = user.display_name || user.username;
  req.user = user;
  res.locals.currentUser = user;
  // Dates in this user's chosen format (times always 24h UK): fmtDate / fmtDay / fmtTime
  // in views, req.fmt in routes.
  req.fmt = formattersFor(user.date_format);
  Object.assign(res.locals, req.fmt);
  // Last activity for "Active sessions" (at most one write a minute).
  await trackSession(req).catch((err) => console.error('Could not update the session:', err.message));
  next();
}

module.exports = { requireAuth };
