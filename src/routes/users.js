const express = require('express');
const { pool } = require('../db');
const { str, requireId, flash } = require('../lib/http');
const { validateUsername, validatePassword, hashPassword } = require('../lib/users');

const router = express.Router();

const password = (value) => (typeof value === 'string' ? value : '');

router.get('/', async (req, res) => {
  const [users] = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY username');
  res.render('users/index', { title: 'Users', users });
});

router.post('/', async (req, res) => {
  const username = str(req.body.username, 101);
  const pass = password(req.body.password);
  const problem = validateUsername(username) || validatePassword(pass);
  if (problem) {
    flash(req, 'error', problem);
    return res.redirect('/users');
  }

  const hash = await hashPassword(pass);
  try {
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, 'admin']);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    flash(req, 'error', `The username "${username}" is already taken.`);
    return res.redirect('/users');
  }
  flash(req, 'success', `User "${username}" added.`);
  res.redirect('/users');
});

router.post('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const username = str(req.body.username, 101);
  const problem = validateUsername(username);
  if (problem) {
    flash(req, 'error', problem);
    return res.redirect('/users');
  }

  try {
    const [result] = await pool.query('UPDATE users SET username = ? WHERE id = ?', [username, id]);
    if (!result.affectedRows) {
      flash(req, 'error', 'That user no longer exists.');
      return res.redirect('/users');
    }
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    flash(req, 'error', `The username "${username}" is already taken.`);
    return res.redirect('/users');
  }
  flash(req, 'success', `User renamed to "${username}".`);
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
  flash(req, result.affectedRows ? 'success' : 'error', result.affectedRows ? 'Password reset.' : 'That user no longer exists.');
  res.redirect('/users');
});

router.post('/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  if (id === req.user.id) {
    flash(req, 'error', 'You cannot delete your own account.');
    return res.redirect('/users');
  }

  const [result] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
  flash(req, 'success', result.affectedRows ? 'User deleted.' : 'That user was already deleted.');
  res.redirect('/users');
});

module.exports = router;
