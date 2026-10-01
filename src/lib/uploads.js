// File uploads: stored on disk outside /public with random names, and served only
// to signed-in users through /files/:name (see routes/files.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 20;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Only these types are ever shown inline. Everything else (including SVG and HTML,
// which can carry scripts) is served as a download.
const INLINE_TYPES = {
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'],
  '.avif': ['image', 'image/avif'],
  '.bmp': ['image', 'image/bmp'],
  '.mp4': ['video', 'video/mp4'],
  '.webm': ['video', 'video/webm'],
  '.pdf': ['pdf', 'application/pdf'],
};

const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/;

function extensionOf(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

// 'image' | 'video' | 'pdf' | 'file', decided by extension (the browser-sent
// MIME type is not trusted).
const kindOf = (name) => (INLINE_TYPES[extensionOf(name)] || ['file'])[0];
const inlineType = (name) => (INLINE_TYPES[extensionOf(name)] || [null, null])[1];

const isStoredName = (name) => typeof name === 'string' && STORED_NAME.test(name);
const storedPath = (name) => path.join(UPLOAD_DIR, name);

// Multer stores originalname as latin1; recover UTF-8 names (e.g. "café.pdf").
function originalName(file) {
  const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
  return (name.includes('�') ? file.originalname : name).slice(0, 255) || 'file';
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + extensionOf(file.originalname)),
});

// Accepts one file as "file" and/or up to 20 as "files".
const parser = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fieldSize: 2 * 1024 * 1024 },
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'files', maxCount: MAX_FILES },
]);

function uploadErrorMessage(err) {
  if (err.code === 'LIMIT_FILE_SIZE') return 'Each file must be 500 MB or smaller.';
  if (err.code === 'LIMIT_FILE_COUNT') return `You can upload up to ${MAX_FILES} files at once.`;
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return 'Too many files were sent in one upload.';
  return 'The upload failed. Please try again.';
}

// Files received in this request, as rows ready to insert.
function receivedFiles(req, field) {
  const files = (req.files && req.files[field]) || [];
  return files.map((f) => ({
    file_name: f.filename,
    original_name: originalName(f),
    size_bytes: f.size,
    kind: kindOf(f.originalname),
  }));
}

async function removeStoredFiles(names) {
  await Promise.all(names.filter(isStoredName).map(async (name) => {
    try {
      await fs.promises.unlink(storedPath(name));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Could not delete upload ${name}:`, err.message);
    }
  }));
}

// Deletes everything uploaded in this request (used when a form is rejected).
function discardUploads(req) {
  const names = Object.values(req.files || {}).flat().map((f) => f.filename);
  return removeStoredFiles(names);
}

module.exports = {
  UPLOAD_DIR,
  MAX_FILE_BYTES,
  parser,
  uploadErrorMessage,
  receivedFiles,
  removeStoredFiles,
  discardUploads,
  isStoredName,
  storedPath,
  inlineType,
};
