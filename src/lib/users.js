const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;

function validateUsername(username) {
  if (!username) return 'Username is required.';
  if (username.length > 100) return 'Username must be 100 characters or fewer.';
  if (!/^[A-Za-z0-9._@-]+$/.test(username)) {
    return 'Username may only contain letters, numbers, dots, dashes, underscores and @.';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  // bcrypt ignores everything after 72 bytes.
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be 72 bytes or fewer.';
  return null;
}

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

module.exports = { validateUsername, validatePassword, hashPassword };
