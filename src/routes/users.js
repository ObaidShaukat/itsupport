const express = require('express');
const { pool } = require('../db');
const { str, requireId, flash } = require('../lib/http');
const { validateUsername, validatePassword, hashPassword } = require('../lib/users');
const { logActivity } = require('../lib/activity');

const logUser = (req, id, action, username, summary) => logActivity(null, req.user, {
  type: 'user', id, action, subject: username, summary,
});

const router = express.Router();

const password = (value) => (typeof value === 'string' ? value : '');
// Display name: shown everywhere the user appears; empty falls back to the username.
const displayName = (value) => str(value, 100) || null;

router.get('/', async (req, res) => {
  const [users] = await pool.query("SELECT id, username, display_name, role, created_at FROM users ORDER BY COALESCE(NULLIF(display_name, ''), username)");
  res.render('users/index', { title: 'Users', users });
});

router.post('/', async (req, res) => {
  const username = str(req.body.username, 101);
  const display = displayName(req.body.display_name);
  const pass = password(req.body.password);
  const problem = validateUsername(username) || validatePassword(pass);
  if (problem) {
    flash(req, 'error', problem);
    return res.redirect('/users');
  }

  const hash = await hashPassword(pass);
  try {
    const [result] = await pool.query('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)', [username, display, hash, 'admin']);
    await logUser(req, result.insertId, 'created', display || username, `Added user ${display ? `${display} (${username})` : username}`);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    flash(req, 'error', `The username "${username}" is already taken.`);
    return res.redirect('/users');
  }
  flash(req, 'success', `User "${display || username}" added.`);
  res.redirect('/users');
});

router.post('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const username = str(req.body.username, 101);
  const display = displayName(req.body.display_name);
  const problem = validateUsername(username);
  if (problem) {
    flash(req, 'error', problem);
    return res.redirect('/users');
  }

  const [[before]] = await pool.query('SELECT username, display_name FROM users WHERE id = ?', [id]);
  try {
    const [result] = await pool.query('UPDATE users SET username = ?, display_name = ? WHERE id = ?', [username, display, id]);
    if (!result.affectedRows) {
      flash(req, 'error', 'That user no longer exists.');
      return res.redirect('/users');
    }
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    flash(req, 'error', `The username "${username}" is already taken.`);
    return res.redirect('/users');
  }
  const changes = [];
  if (before && before.username !== username) changes.push(`username ${before.username} → ${username}`);
  if (before && (before.display_name || null) !== display) changes.push(`display name "${before.display_name || ''}" → "${display || ''}"`);
  if (changes.length) {
    await logUser(req, id, 'updated', display || username, `Updated user ${display || username}: ${changes.join(', ')}`);
  }
  flash(req, 'success', changes.length ? 'User updated.' : 'No changes.');
  res.redirect('/users');
});

router.post('/:id/password', async (req, res) => {
  const id = requireId(req.params.id);
  const pass = password(req.body.password);
  const problem = validatePassword(pass);
  if (problem) {
    flash(req, 'error', problem);
    return res.redirect('/users');
  }

  const hash = await hashPassword(pass);
  const [result] = await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
  if (result.affectedRows) {
    const [[user]] = await pool.query('SELECT username FROM users WHERE id = ?', [id]);
    await logUser(req, id, 'updated', user.username, `Reset the password for ${user.username}`);
  }
  flash(req, result.affectedRows ? 'success' : 'error', result.affectedRows ? 'Password reset.' : 'That user no longer exists.');
  res.redirect('/users');
});

router.post('/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  if (id === req.user.id) {
    flash(req, 'error', 'You cannot delete your own account.');
    return res.redirect('/users');
  }

  const [[user]] = await pool.query('SELECT username FROM users WHERE id = ?', [id]);
  const [result] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
  if (result.affectedRows) await logUser(req, id, 'deleted', user.username, `Deleted user ${user.username}`);
  flash(req, 'success', result.affectedRows ? 'User deleted.' : 'That user was already deleted.');
  res.redirect('/users');
});

module.exports = router;
