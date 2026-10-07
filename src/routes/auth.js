const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { str } = require('../lib/http');
const { trackSession, forgetSession } = require('../lib/sessions');

const router = express.Router();

// Compared against when the username does not exist, so a wrong username takes
// as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null, username: '' });
});

router.post('/login', async (req, res, next) => {
  const username = str(req.body.username, 100);
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  const [[user]] = await pool.query('SELECT id, password_hash FROM users WHERE username = ?', [username]);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid username or password.', username });
  }

  // New session id on sign-in to prevent session fixation.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    // Recorded for "Active sessions" on My profile (device, IP, signed in at).
    trackSession(req, { force: true })
      .catch((trackErr) => console.error('Could not record the session:', trackErr.message))
      .finally(() => req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/'))));
  });
});

router.post('/logout', async (req, res, next) => {
  await forgetSession(req.sessionID).catch((err) => console.error('Could not forget the session:', err.message));
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('itsupport.sid');
    res.redirect('/login');
  });
});

module.exports = router;
