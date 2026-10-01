const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Synchroniser-token CSRF protection: one random token per session, required
// as the _csrf field on every state-changing request.
function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  const token = req.session.csrfToken;
  res.locals.csrfToken = token;
  res.locals.csrfField = `<input type="hidden" name="_csrf" value="${token}">`;

  if (SAFE_METHODS.has(req.method)) return next();

  const sent = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';
  const a = Buffer.from(sent);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error('Your form expired. Go back, refresh the page and try again.');
    err.status = 403;
    return next(err);
  }
  next();
}

module.exports = csrf;
