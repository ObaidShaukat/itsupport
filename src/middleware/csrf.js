const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function forbidden() {
  const err = new Error('Your form expired. Go back, refresh the page and try again.');
  err.status = 403;
  return err;
}

// True when the request carries this session's token as the _csrf field.
function tokenMatches(req) {
  const token = req.session.csrfToken || '';
  const sent = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';
  const a = Buffer.from(sent);
  const b = Buffer.from(token);
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const isMultipart = (req) => Boolean(req.is('multipart/form-data'));

// Synchroniser-token CSRF protection: one random token per session, required
// as the _csrf field on every state-changing request. Multipart (file upload)
// bodies are not parsed yet at this point, so their check happens in
// middleware/multipart.js straight after parsing, before any route runs.
function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  const token = req.session.csrfToken;
  res.locals.csrfToken = token;
  res.locals.csrfField = `<input type="hidden" name="_csrf" value="${token}">`;

  if (SAFE_METHODS.has(req.method) || isMultipart(req)) return next();
  if (!tokenMatches(req)) return next(forbidden());
  next();
}

module.exports = csrf;
module.exports.tokenMatches = tokenMatches;
module.exports.isMultipart = isMultipart;
module.exports.forbidden = forbidden;
