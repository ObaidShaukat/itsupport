// Inventory import, part 1: reading the uploaded .xlsx / .csv, the encrypted staging store
// that carries the parsed rows between the Map, Preview and Confirm steps, and the value
// helpers shared by the planners (import-plan.js).
//
// Plain password / PIN values never touch the disk or the logs: the uploaded file is
// deleted straight after parsing, and the parsed rows are kept only as one AES-256-GCM
// encrypted file (ENCRYPTION_KEY) in UPLOAD_DIR/imports, readable only by the user who
// uploaded it, deleted on confirm or cancel and after an hour at the latest.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { UPLOAD_DIR } = require('../uploads');
const { encrypt, decrypt, keyStatus } = require('./secrets');

const IMPORT_DIR = path.join(UPLOAD_DIR, 'imports');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 100;
const TTL_MS = 60 * 60 * 1000;
const TOKEN = /^[0-9a-f-]{36}$/;

fs.mkdirSync(IMPORT_DIR, { recursive: true });

// ---- Cell values ----

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Any exceljs cell value as text (dates as YYYY-MM-DD).
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : isoDate(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('hyperlink' in v) return String(v.hyperlink);
    if ('error' in v) return '';
    return '';
  }
  return String(v);
}

// "User-ID", "user id", "UserID" -> "userid"
const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Yes / Done / Granted / Y / 1 / True -> true; empty / No / 0 / False -> false; else null.
function parseAccess(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || ['no', 'n', '0', 'false', 'not granted', 'none', '-'].includes(t)) return false;
  if (['yes', 'y', 'done', 'granted', '1', 'true', 'x', '✓', '✔'].includes(t)) return true;
  return null;
}

// YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (UK order) -> YYYY-MM-DD, '' or null.
function parseDate(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m;
  else {
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
    if (!m) return null;
    [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
  }
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null;
  return isoDate(date);
}

// ---- Reading the upload ----

// Returns { headers, rows } (rows: arrays of text, empty rows dropped) or { error }.
async function readSheet(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!['.xlsx', '.csv'].includes(ext)) return { error: 'Upload an .xlsx or .csv file.' };
  if (file.size > MAX_BYTES) return { error: 'The file must be 20 MB or smaller.' };
  const book = new ExcelJS.Workbook();
  let sheet;
  try {
    if (ext === '.csv') sheet = await book.csv.readFile(file.path);
    else {
      await book.xlsx.readFile(file.path);
      // The first sheet with data (templates put Instructions second).
      sheet = book.worksheets.find((ws) => ws.actualRowCount > 0 && ws.name !== 'Instructions' && ws.name !== 'Lists');
    }
  } catch (err) {
    return { error: 'That file could not be read. Save it as .xlsx or .csv and try again.' };
  }
  if (!sheet) return { error: 'The file has no data.' };
  const all = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = [];
    for (let c = 1; c <= Math.min(row.cellCount, MAX_COLUMNS); c += 1) values.push(cellText(row.getCell(c).value).trim());
    if (values.some(Boolean)) all.push(values);
  });
  if (!all.length) return { error: 'The file has no data.' };
  const width = Math.min(MAX_COLUMNS, Math.max(...all.map((r) => r.length)));
  const headers = Array.from({ length: width }, (_, i) => all[0][i] || `Column ${i + 1}`);
  const rows = all.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] || ''));
  if (!rows.length) return { error: 'The file only has a header row.' };
  if (rows.length > MAX_ROWS) return { error: `The file has ${rows.length} rows; import at most ${MAX_ROWS} at a time.` };
  return { headers, rows };
}

// ---- Encrypted staging between the steps ----

const stagePath = (token) => path.join(IMPORT_DIR, `${token}.enc`);

// Removes staged imports older than an hour.
function cleanStaging() {
  for (const name of fs.readdirSync(IMPORT_DIR)) {
    const p = path.join(IMPORT_DIR, name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p);
    } catch (err) { /* already gone */ }
  }
}

function saveStage(token, data) {
  fs.writeFileSync(stagePath(token), encrypt(JSON.stringify(data)), { mode: 0o600 });
}

function createStage(data) {
  if (!keyStatus().ok) throw new Error(keyStatus().message);
  const token = crypto.randomUUID();
  saveStage(token, { ...data, createdAt: Date.now() });
  return token;
}

// The staged import for this user, or null (missing, expired or someone else's).
function loadStage(token, userId) {
  if (!TOKEN.test(String(token || ''))) return null;
  try {
    const data = JSON.parse(decrypt(fs.readFileSync(stagePath(token), 'utf8')));
    if (data.userId !== userId || Date.now() - data.createdAt > TTL_MS) return null;
    return data;
  } catch (err) {
    return null;
  }
}

function deleteStage(token) {
  if (!TOKEN.test(String(token || ''))) return;
  try { fs.unlinkSync(stagePath(token)); } catch (err) { /* already gone */ }
}

function removeUpload(file) {
  if (!file) return;
  try { fs.unlinkSync(file.path); } catch (err) { /* already gone */ }
}

module.exports = {
  MAX_BYTES, cellText, normHeader, parseAccess, parseDate, readSheet,
  cleanStaging, createStage, saveStage, loadStage, deleteStage, removeUpload,
};
