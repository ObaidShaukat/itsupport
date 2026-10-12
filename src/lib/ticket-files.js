// Ticket and comment attachments (ticket_attachments). Multer first stores uploads in
// UPLOAD_DIR; once the rows are saved they are moved to UPLOAD_DIR/tickets. Max 100 MB
// per file, several at once; any file type (only images, mp4/webm and PDF are ever shown
// inline by /files/:name, everything else downloads).
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, receivedFiles, isStoredName, storedPath } = require('./uploads');

const TICKET_DIR = path.join(UPLOAD_DIR, 'tickets');
const TICKET_MAX_BYTES = 100 * 1024 * 1024;
fs.mkdirSync(TICKET_DIR, { recursive: true });

const ticketPath = (name) => path.join(TICKET_DIR, name);

// Where a ticket file is on disk (UPLOAD_DIR/tickets, or UPLOAD_DIR if the move failed).
function ticketFilePath(name) {
  const inTickets = ticketPath(name);
  return fs.existsSync(inTickets) ? inTickets : storedPath(name);
}

// The files of this request ("files" field) as rows, or { error } when one is too big.
function ticketUploads(req) {
  if (req.uploadError) return { error: req.uploadError };
  const files = receivedFiles(req, 'files');
  const big = files.find((f) => f.size_bytes > TICKET_MAX_BYTES);
  if (big) return { error: `"${big.original_name}" is over 100 MB. Each attachment must be 100 MB or smaller.` };
  return { files };
}

// Inserts the rows (inside the caller's transaction).
async function insertAttachments(conn, { ticketId, commentId = null, userId, files }) {
  if (!files.length) return;
  await conn.query(
    'INSERT INTO ticket_attachments (ticket_id, comment_id, file_name, original_name, size_bytes, kind, uploaded_by) VALUES ?',
    [files.map((f) => [ticketId, commentId, f.file_name, f.original_name, f.size_bytes, f.kind, userId])]
  );
}

// After commit: keep the files (req.keepUploads) and move them into uploads/tickets.
async function keepTicketFiles(req, files) {
  req.keepUploads = true;
  for (const f of files) {
    try {
      await fs.promises.rename(storedPath(f.file_name), ticketPath(f.file_name));
    } catch (err) {
      console.error(`Could not move upload ${f.file_name} to uploads/tickets:`, err.message);
    }
  }
}

async function removeTicketFiles(names) {
  for (const name of names.filter(isStoredName)) {
    for (const p of [ticketPath(name), storedPath(name)]) {
      try {
        await fs.promises.unlink(p);
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`Could not delete upload ${name}:`, err.message);
      }
    }
  }
}

// File names of a ticket's attachments, of one comment's, or of all tickets of a client.
async function attachmentNames(db, { ticketId, commentId, clientId }) {
  let rows;
  if (commentId) [rows] = await db.query('SELECT file_name FROM ticket_attachments WHERE comment_id = ?', [commentId]);
  else if (ticketId) [rows] = await db.query('SELECT file_name FROM ticket_attachments WHERE ticket_id = ?', [ticketId]);
  else [rows] = await db.query('SELECT a.file_name FROM ticket_attachments a JOIN tickets t ON t.id = a.ticket_id WHERE t.client_id = ?', [clientId]);
  return rows.map((r) => r.file_name);
}

// "1.2 MB"
function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

module.exports = {
  TICKET_DIR, TICKET_MAX_BYTES, ticketFilePath, ticketUploads, insertAttachments, keepTicketFiles, removeTicketFiles, attachmentNames, fileSize,
};
