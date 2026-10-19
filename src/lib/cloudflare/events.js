// Cloudflare domain events (domain_events) and the activity log, shared by the checks
// (check.js) and the expiry lookups (rdap.js).
const { pool } = require('../../db');
const { logActivity } = require('../activity');

const log = (user, entry) => logActivity(null, user, { type: 'cloudflare', subject: 'Cloudflare', ...entry }).catch((err) => console.error('Cloudflare log failed:', err.message));

// Records an event (once per dedupe key, when given). Returns true when it is new.
async function addEvent(db, { domain = null, accountId = null, type, details = {}, key = null }, user = null) {
  const [r] = await (db || pool).query(
    'INSERT IGNORE INTO domain_events (domain_id, cf_account_id, type, details, dedupe_key) VALUES (?, ?, ?, ?, ?)',
    [domain ? domain.id : null, accountId, type, JSON.stringify(details), key]
  );
  if (r.affectedRows !== 1) return false;
  await log(user, {
    id: domain ? domain.id : null, action: 'updated', clientId: domain ? domain.client_id : null,
    summary: `Cloudflare: ${type.replace(/_/g, ' ')}${domain ? ` on ${domain.name}` : ''}${details.text ? `: ${details.text}` : ''}`,
  });
  return true;
}

module.exports = { addEvent, log };
