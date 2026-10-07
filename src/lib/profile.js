// Profile settings shared by My profile (yourself) and the Users page (anyone):
// picture, job title, reminder notifications and date format.
const { pool } = require('../db');
const { str } = require('./http');
const { saveAvatar, removeAvatar } = require('./avatars');
const { DATE_FORMATS, isDateFormat } = require('./dates');

const REMINDER_CHANNELS = {
  both: 'Popup and email',
  popup: 'Popup only',
  email: 'Email only',
};

const jobTitle = (value) => str(value, 100) || null;

// Saves an uploaded picture (multer field "file") for the user and deletes the old one.
// Returns { error } or { changed: true }.
async function updateAvatar(userId, req) {
  if (req.uploadError) return { error: req.uploadError };
  const file = req.files && req.files.file && req.files.file[0];
  const saved = await saveAvatar(file, req.body);
  if (saved.error) return saved;
  const [[before]] = await pool.query('SELECT avatar_file FROM users WHERE id = ?', [userId]);
  if (!before) {
    await removeAvatar(saved.name);
    return { error: 'That user no longer exists.' };
  }
  await pool.query('UPDATE users SET avatar_file = ? WHERE id = ?', [saved.name, userId]);
  await removeAvatar(before.avatar_file);
  return { changed: true };
}

// Removes the user's picture (file and column). Returns true when there was one.
async function clearAvatar(userId) {
  const [[before]] = await pool.query('SELECT avatar_file FROM users WHERE id = ?', [userId]);
  if (!before || !before.avatar_file) return false;
  await pool.query('UPDATE users SET avatar_file = NULL WHERE id = ?', [userId]);
  await removeAvatar(before.avatar_file);
  return true;
}

// Reminder notifications and date format from a form. Returns { prefs } or { error }.
function readPreferences(body) {
  const channel = body.reminder_channel;
  const format = body.date_format;
  if (!Object.hasOwn(REMINDER_CHANNELS, channel)) return { error: 'Choose how reminders reach you.' };
  if (!isDateFormat(format)) return { error: 'Choose a date format.' };
  return { prefs: { reminder_channel: channel, date_format: format } };
}

// Saves preferences; returns a description of what changed ('' when nothing did).
async function savePreferences(userId, prefs) {
  const [[before]] = await pool.query('SELECT reminder_channel, date_format FROM users WHERE id = ?', [userId]);
  if (!before) return '';
  const changes = [];
  if (before.reminder_channel !== prefs.reminder_channel) {
    changes.push(`reminder notifications ${REMINDER_CHANNELS[before.reminder_channel]} → ${REMINDER_CHANNELS[prefs.reminder_channel]}`);
  }
  if (before.date_format !== prefs.date_format) {
    changes.push(`date format ${DATE_FORMATS[before.date_format]} → ${DATE_FORMATS[prefs.date_format]}`);
  }
  if (changes.length) {
    await pool.query('UPDATE users SET reminder_channel = ?, date_format = ? WHERE id = ?', [prefs.reminder_channel, prefs.date_format, userId]);
  }
  return changes.join(', ');
}

module.exports = { REMINDER_CHANNELS, jobTitle, updateAvatar, clearAvatar, readPreferences, savePreferences };
