// GDAP sync: reads every delegatedAdminRelationship from Microsoft Graph (read only),
// stores it in gdap_relationships, marks the ones no longer returned as Removed (never
// deleted), links customers to portal clients by name (unless linked by hand), records
// the run in gdap_sync_log and the activity log, then runs the expiry alerts. A failure
// is recorded with its error (red banner on the page) and admins are alerted.
// Runs daily at 07:00 UK (index.js, node-cron) and from "Sync now".
const { pool, transaction } = require('../../db');
const { logActivity } = require('../activity');
const { gdapConfig, listRelationships } = require('./graph');
const { matchKey, clientIndex } = require('./data');
const { runExpiryAlerts, alertSyncFailure } = require('./alerts');

let running = false;

const toDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 ? null : d;
};

// The fields we keep from one Graph relationship.
function readRelationship(rel) {
  const roles = ((rel.accessDetails && rel.accessDetails.unifiedRoles) || []).map((r) => String(r.roleDefinitionId || '').toLowerCase()).filter(Boolean);
  return {
    relationship_id: String(rel.id || '').slice(0, 100),
    display_name: rel.displayName ? String(rel.displayName).slice(0, 255) : null,
    customer_tenant_id: rel.customer && rel.customer.tenantId ? String(rel.customer.tenantId).slice(0, 64) : null,
    customer_name: rel.customer && rel.customer.displayName ? String(rel.customer.displayName).slice(0, 255) : null,
    status: rel.status ? String(rel.status).slice(0, 40) : null,
    created_at_ms: toDate(rel.createdDateTime),
    activated_at: toDate(rel.activatedDateTime),
    end_at: toDate(rel.endDateTime),
    duration: rel.duration ? String(rel.duration).slice(0, 40) : null,
    auto_extend_duration: rel.autoExtendDuration ? String(rel.autoExtendDuration).slice(0, 40) : null,
    roles: JSON.stringify(roles),
  };
}

// Links each relationship that was not linked by hand to the one client whose name
// matches its customer name (or unlinks it when nothing matches any more).
async function autoLink(conn) {
  const [clients] = await conn.query('SELECT id, name FROM clients');
  const index = clientIndex(clients);
  const [rels] = await conn.query('SELECT id, customer_name, client_id FROM gdap_relationships WHERE link_manual = 0');
  let linked = 0;
  for (const r of rels) {
    const match = index.get(matchKey(r.customer_name)) || null;
    if (match !== r.client_id) {
      await conn.query('UPDATE gdap_relationships SET client_id = ? WHERE id = ?', [match, r.id]);
      if (match) linked += 1;
    }
  }
  return linked;
}

// Returns { ok, count, added, removed } or { ok: false, error }.
async function syncGdap(user = null, { trigger = 'schedule' } = {}) {
  const cfg = gdapConfig();
  if (!cfg.configured) return { ok: false, error: cfg.message, notConfigured: true };
  if (running) return { ok: false, error: 'A GDAP sync is already running. Try again in a minute.' };
  running = true;
  const [log] = await pool.query("INSERT INTO gdap_sync_log (status, triggered_by) VALUES ('running', ?)", [user ? user.id : null]);
  const logId = log.insertId;
  const how = trigger === 'manual' ? 'Sync now' : 'daily sync';
  try {
    const items = (await listRelationships()).map(readRelationship).filter((r) => r.relationship_id);
    const result = await transaction(async (conn) => {
      const [before] = await conn.query('SELECT relationship_id, removed_at FROM gdap_relationships');
      const known = new Map(before.map((r) => [r.relationship_id, r]));
      for (const r of items) {
        await conn.query(`
          INSERT INTO gdap_relationships (relationship_id, display_name, customer_tenant_id, customer_name, status, created_at_ms, activated_at,
            end_at, duration, auto_extend_duration, roles, removed_at, last_synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NOW())
          ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), customer_tenant_id = VALUES(customer_tenant_id),
            customer_name = VALUES(customer_name), status = VALUES(status), created_at_ms = VALUES(created_at_ms),
            activated_at = VALUES(activated_at), end_at = VALUES(end_at), duration = VALUES(duration),
            auto_extend_duration = VALUES(auto_extend_duration), roles = VALUES(roles), removed_at = NULL, last_synced_at = NOW()
        `, [r.relationship_id, r.display_name, r.customer_tenant_id, r.customer_name, r.status, r.created_at_ms, r.activated_at,
          r.end_at, r.duration, r.auto_extend_duration, r.roles]);
      }
      const ids = items.map((r) => r.relationship_id);
      const [gone] = ids.length
        ? await conn.query('UPDATE gdap_relationships SET removed_at = NOW() WHERE removed_at IS NULL AND relationship_id NOT IN (?)', [ids])
        : await conn.query('UPDATE gdap_relationships SET removed_at = NOW() WHERE removed_at IS NULL');
      const linked = await autoLink(conn);
      const added = items.filter((r) => !known.has(r.relationship_id)).length;
      await conn.query("UPDATE gdap_sync_log SET status = 'ok', finished_at = NOW(), relationship_count = ? WHERE id = ?", [items.length, logId]);
      await logActivity(conn, user, {
        type: 'gdap', action: 'synced', subject: 'GDAP',
        summary: `GDAP ${how}: ${items.length} relationship${items.length === 1 ? '' : 's'} (${added} new, ${gone.affectedRows} removed, ${linked} newly linked to clients)`,
      });
      return { ok: true, count: items.length, added, removed: gone.affectedRows, linked };
    });
    running = false;
    try {
      result.alerts = await runExpiryAlerts();
    } catch (err) {
      console.error('GDAP alerts failed:', err.message);
    }
    return result;
  } catch (err) {
    running = false;
    const error = String(err.message || err).slice(0, 2000);
    await pool.query("UPDATE gdap_sync_log SET status = 'failed', finished_at = NOW(), error = ? WHERE id = ?", [error, logId]).catch(() => {});
    await logActivity(null, user, { type: 'gdap', action: 'synced', subject: 'GDAP', summary: `GDAP ${how} failed: ${error.slice(0, 400)}` }).catch(() => {});
    await alertSyncFailure(error).catch((e) => console.error('GDAP failure alert failed:', e.message));
    return { ok: false, error };
  }
}

// The client a relationship is linked to: a client id (link by hand), or null with
// auto = true to go back to automatic matching.
async function setLink(user, relId, { clientId, auto }) {
  return transaction(async (conn) => {
    const [[rel]] = await conn.query('SELECT id, customer_name, display_name, client_id FROM gdap_relationships WHERE id = ? FOR UPDATE', [relId]);
    if (!rel) return { error: 'That GDAP relationship no longer exists.' };
    let client = null;
    if (auto) {
      await conn.query('UPDATE gdap_relationships SET link_manual = 0 WHERE id = ?', [relId]);
      await autoLink(conn);
      const [[after]] = await conn.query('SELECT g.client_id, c.name FROM gdap_relationships g LEFT JOIN clients c ON c.id = g.client_id WHERE g.id = ?', [relId]);
      client = after.client_id ? { id: after.client_id, name: after.name } : null;
    } else {
      if (clientId) {
        [[client]] = await conn.query('SELECT id, name FROM clients WHERE id = ?', [clientId]);
        if (!client) return { error: 'That client no longer exists.' };
      }
      await conn.query('UPDATE gdap_relationships SET client_id = ?, link_manual = 1 WHERE id = ?', [client ? client.id : null, relId]);
    }
    const customer = rel.customer_name || rel.display_name || 'customer';
    await logActivity(conn, user, {
      type: 'gdap', id: relId, action: 'updated', subject: 'GDAP', clientId: client ? client.id : null, clientName: client ? client.name : null,
      summary: auto ? `Set the GDAP customer ${customer} back to automatic client matching (${client ? `linked to ${client.name}` : 'no match'})`
        : client ? `Linked the GDAP customer ${customer} to the client ${client.name}` : `Unlinked the GDAP customer ${customer} from its client`,
    });
    return { client, changed: rel.client_id !== (client ? client.id : null) || auto };
  });
}

module.exports = { syncGdap, setLink, readRelationship };
