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

// A same-site path ("/tickets?status=open") to return to, or the fallback.
// Rejects absolute URLs and "//host" so it cannot redirect off-site.
const safePath = (value, fallback) => (typeof value === 'string' && /^\/(?!\/)\S*$/.test(value) ? value.slice(0, 500) : fallback);

module.exports = { HttpError, notFound, str, toId, requireId, flash, safePath };
