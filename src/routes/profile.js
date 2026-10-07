// My profile: the signed-in user changes their own picture, display name, job title,
// reminder notifications, date format, email signature and password, and manages
// their signed-in sessions. (The Users page lets anyone edit any user.) Every change
// is activity-logged as entity_type 'user', which is never on the Daily Report.
const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { str, flash, requireId } = require('../lib/http');
const { validatePassword, hashPassword } = require('../lib/users');
const { logActivity } = require('../lib/activity');
const { readSignature } = require('../lib/signature');
const { userEmail } = require('../lib/mailer');
const { REMINDER_CHANNELS, jobTitle, updateAvatar, clearAvatar, readPreferences, savePreferences } = require('../lib/profile');
const { listSessions, signOutSession, signOutOtherSessions } = require('../lib/sessions');

const router = express.Router();

const logSelf = (req, summary) => logActivity(null, req.user, {
  type: 'user', id: req.user.id, action: 'updated', subject: req.user.name, summary,
});
const done = (req, res, message, hash = '') => {
  flash(req, 'success', message);
  res.redirect(`/profile${hash}`);
};
const failed = (req, res, message, hash = '') => {
  flash(req, 'error', message);
  res.redirect(`/profile${hash}`);
};

router.get('/', async (req, res) => {
  const [[me]] = await pool.query(
    'SELECT id, username, display_name, job_title, avatar_file, reminder_channel, date_format, email_signature, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  const sessions = await listSessions(req.user.id, req.sessionID);
  res.render('profile/index', {
    title: 'My profile', me, email: userEmail(req.user), sessions, reminderChannels: REMINDER_CHANNELS,
  });
});

router.post('/', async (req, res) => {
  const display = str(req.body.display_name, 100) || null;
  const title = jobTitle(req.body.job_title);
  const changes = [];
  if ((req.user.display_name || null) !== display) changes.push(`display name "${req.user.display_name || ''}" → "${display || ''}"`);
  if ((req.user.job_title || null) !== title) changes.push(`job title "${req.user.job_title || ''}" → "${title || ''}"`);
  if (!changes.length) return done(req, res, 'No changes.');
  await pool.query('UPDATE users SET display_name = ?, job_title = ? WHERE id = ?', [display, title, req.user.id]);
  await logSelf(req, `Changed their ${changes.join(', ')}`);
  done(req, res, 'Profile saved.');
});

router.post('/avatar', async (req, res) => {
  const result = await updateAvatar(req.user.id, req);
  if (result.error) return failed(req, res, result.error, '#picture');
  await logSelf(req, 'Changed their profile picture');
  done(req, res, 'Profile picture saved.', '#picture');
});

router.post('/avatar/delete', async (req, res) => {
  if (!(await clearAvatar(req.user.id))) return done(req, res, 'You have no profile picture.', '#picture');
  await logSelf(req, 'Removed their profile picture');
  done(req, res, 'Profile picture removed.', '#picture');
});

router.post('/preferences', async (req, res) => {
  const { prefs, error } = readPreferences(req.body);
  if (error) return failed(req, res, error, '#preferences');
  const changed = await savePreferences(req.user.id, prefs);
  if (!changed) return done(req, res, 'No changes.', '#preferences');
  await logSelf(req, `Changed their ${changed}`);
  done(req, res, 'Preferences saved.', '#preferences');
});

router.post('/signature', async (req, res) => {
  const signature = readSignature(req.body.email_signature);
  if (signature.error) return failed(req, res, signature.error, '#signature');
  const [[me]] = await pool.query('SELECT email_signature FROM users WHERE id = ?', [req.user.id]);
  if ((me.email_signature || null) === signature.html) return done(req, res, 'No changes.', '#signature');
  await pool.query('UPDATE users SET email_signature = ? WHERE id = ?', [signature.html, req.user.id]);
  await logSelf(req, `${signature.html ? 'Updated' : 'Removed'} their email signature`);
  done(req, res, 'Email signature saved.', '#signature');
});

// Changing your password signs out all your other sessions.
router.post('/password', async (req, res) => {
  const current = typeof req.body.current_password === 'string' ? req.body.current_password : '';
  const next = typeof req.body.password === 'string' ? req.body.password : '';
  const [[me]] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!current || !(await bcrypt.compare(current, me.password_hash))) return failed(req, res, 'Your current password is not right.', '#password');
  const problem = validatePassword(next) || (next !== req.body.confirm_password ? 'The new passwords do not match.' : null);
  if (problem) return failed(req, res, problem, '#password');
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), req.user.id]);
  const signedOut = await signOutOtherSessions(req.user.id, req.sessionID);
  await logSelf(req, `Changed their password${signedOut ? ` and signed out ${signedOut} other session${signedOut === 1 ? '' : 's'}` : ''}`);
  done(req, res, signedOut ? 'Password changed. Your other sessions have been signed out.' : 'Password changed.');
});

router.post('/sessions/others/delete', async (req, res) => {
  const count = await signOutOtherSessions(req.user.id, req.sessionID);
  if (!count) return done(req, res, 'There are no other sessions.', '#sessions');
  await logSelf(req, `Signed out ${count} other session${count === 1 ? '' : 's'}`);
  done(req, res, `Signed out ${count} other session${count === 1 ? '' : 's'}.`, '#sessions');
});

router.post('/sessions/:id/delete', async (req, res) => {
  const device = await signOutSession(req.user.id, requireId(req.params.id), req.sessionID);
  if (!device) return failed(req, res, 'That session has already ended (or is this device: use Sign out).', '#sessions');
  await logSelf(req, `Signed out a session (${device})`);
  done(req, res, `Signed out ${device}.`, '#sessions');
});

module.exports = router;
