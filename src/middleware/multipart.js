const { parser, uploadErrorMessage, discardUploads } = require('../lib/uploads');
const { tokenMatches, isMultipart, forbidden } = require('./csrf');

// Parses every multipart (file upload) request before any route runs, then
// enforces sign-in and the CSRF token. Rejected requests have their files deleted.
// An upload error that still carried a valid token (e.g. a file over 500 MB) is
// passed to the route as req.uploadError so it can show a message.
function multipart(req, res, next) {
  if (!isMultipart(req)) return next();
  if (!req.session.userId) return next(forbidden());

  parser(req, res, async (err) => {
    if (!tokenMatches(req)) {
      await discardUploads(req);
      return next(forbidden());
    }
    if (err) {
      await discardUploads(req);
      req.files = {};
      req.uploadError = uploadErrorMessage(err);
    }
    // Routes set req.keepUploads once the files are recorded in the database.
    // Anything else (validation failures, errors, unexpected routes) is deleted.
    res.on('close', () => {
      if (!req.keepUploads) discardUploads(req);
    });
    next();
  });
}

module.exports = multipart;
