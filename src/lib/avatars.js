// Profile pictures. The browser crops the picture in a popup and uploads a 512 x 512
// JPG (public/js/app.js); without JavaScript the original JPG, PNG or WebP is sent.
// Either way the server checks it (max 5 MB), takes the centre square (or crop_x /
// crop_y / crop_size if sent), resizes to 256 x 256 and re-encodes as WebP, which
// also drops any metadata. Stored in uploads/avatars and served only to signed-in
// users via /avatars/:name. People without a picture get a coloured circle with
// their initials.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { UPLOAD_DIR } = require('./uploads');

const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
const MAX_BYTES = 5 * 1024 * 1024;
const SIZE = 256;
const FORMATS = ['jpeg', 'png', 'webp'];
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;

fs.mkdirSync(AVATAR_DIR, { recursive: true });

const isAvatarName = (name) => typeof name === 'string' && NAME.test(name);
const avatarPath = (name) => path.join(AVATAR_DIR, name);

// Crop square in the (EXIF-rotated) image's pixels, from the form's crop_x / crop_y /
// crop_size; null when missing or out of bounds (then the centre square is used).
function readCrop(body, width, height) {
  const [x, y, size] = ['crop_x', 'crop_y', 'crop_size'].map((k) => Math.round(Number(body[k])));
  if (![x, y, size].every(Number.isFinite) || size < 16 || x < 0 || y < 0) return null;
  if (x + size > width || y + size > height) return null;
  return { left: x, top: y, width: size, height: size };
}

// Turns the uploaded file (multer, field "file") into a stored avatar. Returns
// { name } or { error }. The original upload is deleted by the multipart middleware.
async function saveAvatar(file, body) {
  if (!file) return { error: 'Choose a picture to upload.' };
  if (file.size > MAX_BYTES) return { error: 'The picture must be 5 MB or smaller.' };
  let image;
  try {
    // rotate() applies the EXIF orientation, matching what the browser showed.
    image = await sharp(file.path, { failOn: 'error' }).rotate().toBuffer({ resolveWithObject: true });
  } catch (err) {
    return { error: 'That file is not a picture we can read. Use a JPG, PNG or WebP image.' };
  }
  if (!FORMATS.includes(image.info.format)) return { error: 'Use a JPG, PNG or WebP image.' };
  const { width, height } = image.info;
  const side = Math.min(width, height);
  const crop = readCrop(body || {}, width, height)
    || { left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side };
  const name = `${crypto.randomUUID()}.webp`;
  await sharp(image.data).extract(crop).resize(SIZE, SIZE, { fit: 'cover' }).webp({ quality: 85 }).toFile(avatarPath(name));
  return { name };
}

async function removeAvatar(name) {
  if (!isAvatarName(name)) return;
  try {
    await fs.promises.unlink(avatarPath(name));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not delete avatar ${name}:`, err.message);
  }
}

// ---- Rendering ----

const COLOURS = ['#200D6C', '#0390D7', '#6741C3', '#1D7A46', '#B4234B', '#C25E00', '#00838F', '#5D4037'];
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function initials(name) {
  const words = String(name || '').replace(/@.*$/, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0];
  return letters.toUpperCase();
}

function colourFor(seed) {
  let hash = 0;
  for (const ch of String(seed || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length];
}

// people: [{ id, name, avatar_file }]. Returns avatar(person, size) for the views:
// person is { id, name } (id preferred; a name alone is looked up by name, e.g. the
// created/updated-by names from activity history). size: 'xs' | 'sm' | 'md' | 'lg'.
function avatarHelper(people) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const byName = new Map(people.map((p) => [String(p.name).toLowerCase(), p]));
  return (person, size = 'sm') => {
    const p = person || {};
    const known = (p.id && byId.get(Number(p.id))) || (p.name && byName.get(String(p.name).toLowerCase())) || null;
    const name = (known && known.name) || p.name || 'Deleted user';
    const cls = `avatar avatar-${['xs', 'sm', 'md', 'lg'].includes(size) ? size : 'sm'}`;
    if (known && isAvatarName(known.avatar_file)) {
      return `<img class="${cls}" src="/avatars/${known.avatar_file}" alt="" title="${escape(name)}" loading="lazy">`;
    }
    const seed = known ? known.id : name;
    return `<span class="${cls} avatar-initials" style="background:${colourFor(seed)}" title="${escape(name)}" aria-hidden="true">${escape(initials(name))}</span>`;
  };
}

module.exports = { MAX_BYTES, isAvatarName, avatarPath, saveAvatar, removeAvatar, avatarHelper, initials };
