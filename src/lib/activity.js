// Activity log (audit trail). Every create/update/delete in the portal writes
// one row here; the daily report and the History panels read it back.
//
// entity_id points at the record whose History panel shows the entry:
//   ticket, ticket_comment             -> ticket id
//   client_service, step, note         -> client service id
//   service, tutorial                  -> service id (category changes have no id)
//   kb_article                         -> article id
//   client                             -> client id
//   user                               -> user id (Users page changes)
//   setting                            -> (no longer written) old report action/issue changes
//   task                               -> task id
//   manual                             -> null
// client_name and subject (ticket title, service name, ...) are snapshots, so the
// log still reads correctly after the record is renamed or deleted. changes lists
// which fields an edit touched (KB articles: title,category,tags,issue,solution,attachments).
//
// Times: created_at is set by MySQL (UTC, see src/db.js) and never from JavaScript.
// activity_date is the UK date of the action (or the date picked for manual work).
const { pool } = require('../db');

const ENTITY_TYPES = ['ticket', 'ticket_comment', 'client_service', 'step', 'note', 'service', 'kb_article', 'tutorial', 'client', 'user', 'setting', 'task', 'manual'];
const ACTIONS = ['created', 'updated', 'status_changed', 'commented', 'step_done', 'closed', 'reopened', 'deleted', 'uploaded', 'completed'];

const ACTION_LABELS = {
  created: 'Created',
  updated: 'Updated',
  status_changed: 'Status changed',
  commented: 'Commented',
  step_done: 'Step done',
  closed: 'Closed',
  reopened: 'Reopened',
  deleted: 'Deleted',
  uploaded: 'Uploaded',
  completed: 'Completed',
};

// Today's date in the UK as YYYY-MM-DD. Report days follow UK time.
function londonDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// The UTC instant at which the given UK date (YYYY-MM-DD) starts, as a Date.
// Handles BST/GMT, so a UK day maps to the right UTC range in queries.
function londonOffsetMs(instant) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const wallClockAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function londonDayStart(date) {
  const midnightUtc = new Date(`${date}T00:00:00Z`).getTime();
  const first = midnightUtc - londonOffsetMs(new Date(midnightUtc));
  return new Date(midnightUtc - londonOffsetMs(new Date(first)));
}

// UK wall-clock time from a form ("YYYY-MM-DDTHH:MM", e.g. a datetime-local input) as
// a UTC Date, or null. User-chosen times like task due dates and reminders are the
// only times set from JavaScript; "now" timestamps always come from MySQL.
function londonLocalToUtc(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(asUtc)) return null;
  const first = asUtc - londonOffsetMs(new Date(asUtc));
  return new Date(asUtc - londonOffsetMs(new Date(first)));
}

// A Date as UK wall-clock "YYYY-MM-DDTHH:MM" for a datetime-local input.
function toLondonInput(date) {
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(date));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

// Writes one log entry. A logging failure is reported but never breaks the
// action the user just took.
async function logActivity(db, user, entry) {
  if (!ENTITY_TYPES.includes(entry.type) || !ACTIONS.includes(entry.action)) {
    throw new Error(`Invalid activity entry: ${entry.type}/${entry.action}`);
  }
  try {
    await (db || pool).query(`
      INSERT INTO activity_log
        (user_id, client_id, client_name, entity_type, entity_id, action, subject, summary, changes, activity_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      user ? user.id : null,
      entry.clientId || null,
      entry.clientName ? String(entry.clientName).slice(0, 200) : null,
      entry.type,
      entry.id || null,
      entry.action,
      entry.subject ? String(entry.subject).slice(0, 255) : null,
      String(entry.summary || '').slice(0, 5000),
      entry.changes && entry.changes.length ? entry.changes.join(',').slice(0, 255) : null,
      entry.date || londonDate(),
    ]);
  } catch (err) {
    console.error('Could not write activity log entry:', err.message);
  }
}

const ENTRY_COLUMNS = `
  l.id, l.user_id, u.username, l.client_id, l.client_name, l.entity_type, l.entity_id,
  l.action, l.subject, l.summary, l.changes, l.activity_date, l.created_at
`;

// Log entries for records of the given types, oldest first.
async function historyFor(types, ids) {
  const idList = [].concat(ids).filter(Boolean);
  if (!idList.length) return [];
  const [rows] = await pool.query(`
    SELECT ${ENTRY_COLUMNS}
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.entity_type IN (?) AND l.entity_id IN (?)
    ORDER BY l.created_at, l.id
  `, [types, idList]);
  return rows;
}

// Everything logged against a client, newest first.
async function clientHistory(clientId, limit = 100) {
  const [rows] = await pool.query(`
    SELECT ${ENTRY_COLUMNS}
    FROM activity_log l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.client_id = ?
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ?
  `, [clientId, limit]);
  return rows;
}

// "Created by X on date" / "Last updated by Y on date" from a record's entries
// (oldest first). fallback covers records made before the activity log existed.
function recordMeta(entries, primaryType, fallback = {}) {
  const created = entries.find((e) => e.entity_type === primaryType && e.action === 'created');
  const last = entries.at(-1);
  const meta = {
    createdBy: created ? created.username || 'Deleted user' : fallback.createdBy || null,
    createdAt: created ? created.created_at : fallback.createdAt || null,
    updatedBy: null,
    updatedAt: null,
  };
  if (last && last !== created) {
    meta.updatedBy = last.username || 'Deleted user';
    meta.updatedAt = last.created_at;
  }
  return meta;
}

module.exports = {
  ENTITY_TYPES,
  ACTIONS,
  ACTION_LABELS,
  londonDate,
  londonDayStart,
  londonLocalToUtc,
  toLondonInput,
  logActivity,
  historyFor,
  clientHistory,
  recordMeta,
};
