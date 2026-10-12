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
// Only paths starting with a single "/" are allowed: absolute URLs, "//host" and "/\host"
// (which browsers also treat as another host), backslashes and whitespace are rejected,
// so it can never redirect off-site.
const safePath = (value, fallback) => (typeof value === 'string' && value.length <= 500 && /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : fallback);

// Where to go back to after a form: the "back" field (POST body), then ?back= (links),
// then the page the request came from (Referer, only from this same site), else the
// fallback. Safe when req.body is undefined (Express 5 leaves it unset on GET).
function backPath(req, fallback) {
  const fromBody = safePath(req.body && req.body.back, null);
  if (fromBody) return fromBody;
  const fromQuery = safePath(req.query && req.query.back, null);
  if (fromQuery) return fromQuery;
  const referer = req.get && req.get('Referer');
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.host === req.get('Host')) {
        const path = safePath(url.pathname + url.search, null);
        // Not the page that is handling this request (avoid going "back" to itself).
        if (path && path !== req.originalUrl) return path;
      }
    } catch (err) {
      // Not a valid URL: ignore it.
    }
  }
  return fallback;
}

module.exports = {
  HttpError, notFound, str, toId, requireId, flash, safePath, backPath,
};
