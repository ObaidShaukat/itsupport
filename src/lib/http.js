class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = () => new HttpError(404, 'Page not found.');

// Trimmed string from a form field, capped at max characters. Non-strings become ''.
function str(value, max = 255) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

// Positive integer id, or null.
function toId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^[1-9]\d{0,9}$/.test(text)) return null;
  return Number(text);
}

// Positive integer id, or throws a 404.
function requireId(value) {
  const id = toId(value);
  if (!id) throw notFound();
  return id;
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function direction(value) {
  return value === 'up' || value === 'down' ? value : null;
}

module.exports = { HttpError, notFound, str, toId, requireId, flash, direction };
