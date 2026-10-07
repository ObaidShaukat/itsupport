// My profile: the signed-in user changes their own display name, email signature and
// password. (The Users page lets anyone edit any user.) Changes are activity-logged
// as entity_type 'user', like the Users page.
const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { str, flash } = require('../lib/http');
const { validatePassword, hashPassword } = require('../lib/users');
const { logActivity } = require('../lib/activity');
const { readSignature } = require('../lib/signature');
const { userEmail } = require('../lib/mailer');

const router = express.Router();

const logSelf = (req, summary) => logActivity(null, req.user, {
  type: 'user', id: req.user.id, action: 'updated', subject: req.user.name, summary,
});

router.get('/', async (req, res) => {
  const [[me]] = await pool.query('SELECT username, display_name, email_signature, created_at FROM users WHERE id = ?', [req.user.id]);
  res.render('profile/index', { title: 'My profile', me, email: userEmail(req.user) });
});

router.post('/', async (req, res) => {
  const display = str(req.body.display_name, 100) || null;
  if ((req.user.display_name || null) !== display) {
    await pool.query('UPDATE users SET display_name = ? WHERE id = ?', [display, req.user.id]);
    await logSelf(req, `Changed their display name "${req.user.display_name || ''}" → "${display || ''}"`);
    flash(req, 'success', 'Display name saved.');
  } else {
    flash(req, 'success', 'No changes.');
  }
  res.redirect('/profile');
});

router.post('/signature', async (req, res) => {
  const signature = readSignature(req.body.email_signature);
  if (signature.error) {
    flash(req, 'error', signature.error);
    return res.redirect('/profile#signature');
  }
  const [[me]] = await pool.query('SELECT email_signature FROM users WHERE id = ?', [req.user.id]);
  if ((me.email_signature || null) === signature.html) {
    flash(req, 'success', 'No changes.');
    return res.redirect('/profile#signature');
  }
  await pool.query('UPDATE users SET email_signature = ? WHERE id = ?', [signature.html, req.user.id]);
  await logSelf(req, `${signature.html ? 'Updated' : 'Removed'} their email signature`);
  flash(req, 'success', 'Email signature saved.');
  res.redirect('/profile#signature');
});

router.post('/password', async (req, res) => {
  const current = typeof req.body.current_password === 'string' ? req.body.current_password : '';
  const next = typeof req.body.password === 'string' ? req.body.password : '';
  const [[me]] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!current || !(await bcrypt.compare(current, me.password_hash))) {
    flash(req, 'error', 'Your current password is not right.');
    return res.redirect('/profile#password');
  }
  const problem = validatePassword(next) || (next !== req.body.confirm_password ? 'The new passwords do not match.' : null);
  if (problem) {
    flash(req, 'error', problem);
    return res.redirect('/profile#password');
  }
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), req.user.id]);
  await logSelf(req, 'Changed their password');
  flash(req, 'success', 'Password changed.');
  res.redirect('/profile');
});

module.exports = router;
