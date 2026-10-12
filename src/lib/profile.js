// Profile settings shared by My profile (yourself) and the Users page (anyone):
// picture, job title, notifications (popup / email / desktop) and date format.
const { pool } = require('../db');
const { str } = require('./http');
const { saveAvatar, removeAvatar } = require('./avatars');
const { DATE_FORMATS, isDateFormat } = require('./dates');
const { NOTIFY_CHANNELS, readChannels, channelLabel } = require('./notify');

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

// Notifications (one or more of popup / email / desktop) and date format from a form.
// Returns { prefs } or { error }.
function readPreferences(body) {
  const channels = readChannels(body.notify_channels);
  const format = body.date_format;
  if (!channels.length) return { error: 'Choose at least one way to be notified (popup, email or desktop).' };
  if (!isDateFormat(format)) return { error: 'Choose a date format.' };
  return { prefs: { notify_channels: channels.join(','), date_format: format } };
}

// Saves preferences; returns a description of what changed ('' when nothing did).
async function savePreferences(userId, prefs) {
  const [[before]] = await pool.query('SELECT notify_channels, date_format FROM users WHERE id = ?', [userId]);
  if (!before) return '';
  const changes = [];
  if (before.notify_channels !== prefs.notify_channels) {
    changes.push(`notifications ${channelLabel(readChannels(before.notify_channels.split(',')))} → ${channelLabel(prefs.notify_channels.split(','))}`);
  }
  if (before.date_format !== prefs.date_format) {
    changes.push(`date format ${DATE_FORMATS[before.date_format]} → ${DATE_FORMATS[prefs.date_format]}`);
  }
  if (changes.length) {
    await pool.query('UPDATE users SET notify_channels = ?, date_format = ? WHERE id = ?', [prefs.notify_channels, prefs.date_format, userId]);
  }
  return changes.join(', ');
}

// Labels for the preference form (kept under the old name used by the routes).
const REMINDER_CHANNELS = NOTIFY_CHANNELS;

module.exports = { REMINDER_CHANNELS, jobTitle, updateAvatar, clearAvatar, readPreferences, savePreferences };
