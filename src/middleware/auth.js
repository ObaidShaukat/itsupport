const { pool } = require('../db');

// Every page except login requires a signed-in user. The user is reloaded on each
// request so a deleted account is signed out straight away.
async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');

  const [[user]] = await pool.query('SELECT id, username, display_name, role, report_view FROM users WHERE id = ?', [req.session.userId]);
  if (!user) {
    return req.session.destroy(() => res.redirect('/login'));
  }

  // name: what to show for this user (display name, or the username when empty).
  user.name = user.display_name || user.username;
  req.user = user;
  res.locals.currentUser = user;
  next();
}

module.exports = { requireAuth };
