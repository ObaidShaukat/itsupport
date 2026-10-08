// Password and PIN fields: AES-256-GCM with ENCRYPTION_KEY from .env (64 hex characters,
// i.e. 32 bytes). Stored as "v1:" + base64(IV 12 bytes | auth tag 16 bytes | ciphertext).
// Plain text is never stored or logged. Without a valid key, saving and revealing
// password fields is refused with a clear message.
// Generate a key with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Keep it safe: if it is lost or changed, saved passwords can no longer be read.
const crypto = require('crypto');

const PREFIX = 'v1:';

function readKey() {
  const hex = String(process.env.ENCRYPTION_KEY || '').trim();
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function keyStatus() {
  if (readKey()) return { ok: true, message: '' };
  const set = Boolean(String(process.env.ENCRYPTION_KEY || '').trim());
  return {
    ok: false,
    message: set
      ? 'ENCRYPTION_KEY in .env must be 64 hexadecimal characters, so password and PIN fields cannot be saved or shown.'
      : 'ENCRYPTION_KEY is not set in .env, so password and PIN fields cannot be saved or shown.',
  };
}

function encrypt(plain) {
  const key = readKey();
  if (!key) throw new Error(keyStatus().message);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decrypt(stored) {
  const key = readKey();
  if (!key) throw new Error(keyStatus().message);
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) throw new Error('This value is not encrypted in a known format.');
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error('This value could not be decrypted. Has ENCRYPTION_KEY changed?');
  }
}

module.exports = { keyStatus, encrypt, decrypt };
