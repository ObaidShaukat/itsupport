// Serves profile pictures to signed-in users only (mounted after requireAuth).
// Each upload gets a new random name, so the files can be cached.
const express = require('express');
const { notFound } = require('../lib/http');
const { isAvatarName, avatarPath } = require('../lib/avatars');

const router = express.Router();

router.get('/:name', (req, res, next) => {
  const name = req.params.name;
  if (!isAvatarName(name)) throw notFound();
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'private, max-age=86400',
  });
  res.type('image/webp');
  res.sendFile(avatarPath(name), (err) => {
    if (!err) return;
    if (err.code === 'ENOENT' && !res.headersSent) return next(notFound());
    if (!res.headersSent) next(err);
  });
});

module.exports = router;
