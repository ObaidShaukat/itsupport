// Serves uploaded files to signed-in users only (mounted after requireAuth).
const express = require('express');
const { pool } = require('../db');
const { notFound } = require('../lib/http');
const { isStoredName, storedPath, inlineType } = require('../lib/uploads');

const router = express.Router();

router.get('/:name', async (req, res, next) => {
  const name = req.params.name;
  if (!isStoredName(name)) throw notFound();

  const [[file]] = await pool.query(`
    SELECT original_name, kind FROM service_tutorials WHERE file_name = ?
    UNION ALL
    SELECT original_name, kind FROM kb_attachments WHERE file_name = ?
    LIMIT 1
  `, [name, name]);
  if (!file) throw notFound();

  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    'Cache-Control': 'private, max-age=3600',
  });

  const type = file.kind === 'file' ? null : inlineType(name);
  if (type && req.query.download !== '1') {
    res.type(type);
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  } else {
    res.attachment(file.original_name);
    res.type('application/octet-stream');
  }

  // sendFile handles Range requests, so videos can seek.
  res.sendFile(storedPath(name), (err) => {
    if (!err) return;
    if (err.code === 'ENOENT' && !res.headersSent) return next(notFound());
    if (!res.headersSent) next(err);
  });
});

module.exports = router;
