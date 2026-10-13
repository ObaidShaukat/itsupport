// Call Switch One customer sync (READ ONLY on the CS1 side, see api.js): daily at 06:30
// UK (index.js) and "Sync now" (at most once every 5 minutes).
//
// Source: first the dashboard list (GET www.callswitchone.com/service/account/reseller, with
// customer_id = the CS1 ID); when that fails or has no customer_id, the documented API
// (GET CS1_API_HOST/account/reseller), whose records are linked to their CS1 ID by uuid
// (saved by earlier service syncs or the "Import CS1 IDs" upload), so existing CS1 IDs are kept.
// Customers are found by uuid, then CS1 ID: updated, added, and synced ones no longer
// returned are marked removed (removed_at; never deleted, so old months keep their names).
// Company (contact_name) is the customer name. Synced customers still without a CS1 ID have
// identifier NULL ("Needs CS1 ID") and admins are alerted once per customer.
// Each run is in cs1_sync_log (source, the service probe, endpoint, HTTP status, record
// count, field names (never values), sample IDs, re-matched lines) and logged as entity_type
// 'cs1', action 'synced' (never on the Daily Report). After a good sync the lines of every
// saved billing month are re-matched. Failures alert admins once a day.
const { pool, transaction } = require('../../db');
const { logActivity, londonDate } = require('../activity');
const { channelsOf } = require('../notify');
const { pushToUser } = require('../push');
const {
  listService, listOfficial, fieldNames, mapCustomer, cs1ApiConfig, normaliseId,
} = require('./api');
const {
  getSettings, saveSetting, rematchLines, unknownLines, realName,
} = require('./billing');

const mailer = () => require('../mailer'); // eslint-disable-line global-require
const SYNC_NOW_GAP_SECONDS = 5 * 60;
const COLUMNS = ['name', 'account_holder', 'store', 'email', 'status', 'registered_on', 'users_count', 'numbers_count'];
const CS1_NUMBER = /^CS1-\d+$/;

const rowOf = (c) => ({
  name: c.company, account_holder: c.holder || null, store: c.store || null, email: c.email || null, status: c.status || null,
  registered_on: c.registered, users_count: c.users, numbers_count: c.numbers,
});
const same = (a, b) => String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b);
const dayOf = (v) => (v instanceof Date ? londonDate(v) : v);

// "CS1-001234" or "1234 → CS1-001234" when written differently; first 8.
const samplesOf = (mapped) => mapped.filter((c) => c.identifier).slice(0, 8)
  .map((c) => (c.rawId && c.rawId.toUpperCase() !== c.identifier ? `${c.rawId} → ${c.identifier}` : c.identifier)).join(', ');

let busy = false;

// ---- Writing one customer ----

// Puts a synced record's details on a row (identifier only when given).
async function writeSynced(conn, rowId, next, { identifier, uuid, accountId }) {
  const sets = ['name = ?', 'account_holder = ?', 'store = ?', 'email = ?', 'status = ?', 'registered_on = ?', 'users_count = ?', 'numbers_count = ?',
    "source = 'api'", 'removed_at = NULL', 'synced_at = NOW()'];
  const values = [next.name, next.account_holder, next.store, next.email, next.status, next.registered_on, next.users_count, next.numbers_count];
  if (uuid) { sets.push('uuid = ?'); values.push(uuid); }
  if (accountId) { sets.push('account_id = ?'); values.push(accountId); }
  if (identifier) { sets.push('identifier = ?'); values.push(identifier); }
  await conn.query(`UPDATE cs1_customers SET ${sets.join(', ')} WHERE id = ?`, [...values, rowId]);
}

// keep gets drop's uuid / client link and drop is deleted (one customer in two rows: e.g. a
// CS1 ID added by hand or seen in a CDR, and the synced record waiting for its CS1 ID).
async function mergeRows(conn, keep, drop) {
  await conn.query('DELETE FROM cs1_customers WHERE id = ?', [drop.id]);
  await conn.query('UPDATE cs1_customers SET uuid = COALESCE(uuid, ?), account_id = COALESCE(account_id, ?), client_id = COALESCE(client_id, ?) WHERE id = ?',
    [drop.uuid || null, drop.account_id || null, drop.client_id || null, keep.id]);
}

// Gives a synced customer (row) its CS1 ID: { result: linked | already | merged | conflict, message }.
// Used by "Import CS1 IDs" and the edit popup. Another row with that CS1 ID and no other
// uuid is merged into (it keeps its client link and the synced details move onto it).
async function linkId(conn, row, cs1Id) {
  const id = normaliseId(cs1Id);
  if (!CS1_NUMBER.test(id)) return { result: 'conflict', message: `"${cs1Id}" is not a CS1 ID (CS1-123456).` };
  if (row.identifier === id) return { result: 'already', message: `${realName(row.name, row.identifier) || id} already has ${id}.` };
  if (row.identifier && CS1_NUMBER.test(row.identifier)) return { result: 'conflict', message: `${realName(row.name, row.identifier) || row.identifier} already has ${row.identifier}, not ${id}.` };
  const [[other]] = await conn.query('SELECT * FROM cs1_customers WHERE identifier = ? AND id <> ?', [id, row.id]);
  if (other && other.uuid && row.uuid && other.uuid !== row.uuid) return { result: 'conflict', message: `${id} already belongs to ${realName(other.name, other.identifier) || 'another CallSwitch customer'}.` };
  if (other) {
    await conn.query('DELETE FROM cs1_customers WHERE id = ?', [row.id]);
    await conn.query(`UPDATE cs1_customers SET name = ?, account_holder = ?, store = ?, email = ?, status = ?, registered_on = ?, users_count = ?, numbers_count = ?,
      uuid = ?, account_id = COALESCE(?, account_id), client_id = COALESCE(client_id, ?), source = 'api', removed_at = NULL, synced_at = COALESCE(?, synced_at) WHERE id = ?`,
    [realName(row.name, row.identifier) || other.name || '', row.account_holder, row.store, row.email, row.status, row.registered_on, row.users_count, row.numbers_count,
      row.uuid, row.account_id || null, row.client_id || null, row.synced_at || null, other.id]);
    return { result: 'merged', message: `${realName(row.name, row.identifier) || id} is ${id}.`, id: other.id };
  }
  await conn.query('UPDATE cs1_customers SET identifier = ? WHERE id = ?', [id, row.id]);
  return { result: 'linked', message: `${realName(row.name, row.identifier) || id} is ${id}.`, id: row.id };
}

// ---- The sync ----

async function syncCustomers(user, { trigger = 'manual' } = {}) {
  const cfg = cs1ApiConfig();
  if (!cfg.configured) return { ok: false, error: cfg.message, notConfigured: true };
  if (busy) return { ok: false, error: 'A Call Switch One sync is already running. Try again in a minute.' };
  if (trigger === 'manual') {
    const [[gap]] = await pool.query('SELECT TIMESTAMPDIFF(SECOND, MAX(started_at), NOW()) AS ago FROM cs1_sync_log');
    if (gap && gap.ago !== null && Number(gap.ago) < SYNC_NOW_GAP_SECONDS) {
      const wait = Math.max(1, Math.ceil((SYNC_NOW_GAP_SECONDS - Number(gap.ago)) / 60));
      return { ok: false, error: `Sync now can run once every 5 minutes. Try again in ${wait} minute${wait === 1 ? '' : 's'}.` };
    }
  }
  busy = true;
  // A run cut off by a restart never finished: close it so the page does not show it running.
  await pool.query("UPDATE cs1_sync_log SET status = 'failed', finished_at = NOW(), error = 'Stopped before it finished (the portal restarted).' WHERE status = 'running' AND started_at < NOW() - INTERVAL 15 MINUTE").catch(() => {});
  let logId = null;
  // What was asked and seen, kept for the log even when the sync fails.
  const seen = { source: null, probe: '', endpoint: cfg.serviceUrl, status: null, records: null, fields: [], samples: '' };
  let newUnlinked = [];
  try {
    const [log] = await pool.query('INSERT INTO cs1_sync_log (trigger_type, status, user_id, endpoint) VALUES (?, ?, ?, ?)', [trigger, 'running', user ? user.id : null, cfg.serviceUrl]);
    logId = log.insertId;

    // 1. The dashboard list, with customer_id. Logged: HTTP status and whether customer_id is there.
    let reply = null;
    try {
      const service = await listService(cfg);
      const withId = service.records.filter((r) => r && r.customer_id !== undefined && r.customer_id !== null && r.customer_id !== '').length;
      seen.probe = `GET ${service.endpoint} -> HTTP ${service.status}, ${service.records.length} records, customer_id ${withId ? `present (${withId})` : 'missing'}`;
      if (withId) { reply = service; seen.source = 'service'; }
    } catch (err) {
      seen.probe = `GET ${err.endpoint || cfg.serviceUrl} -> ${err.status ? `HTTP ${err.status}` : 'no reply'}: ${String(err.message).slice(0, 200)}`;
    }
    console.log(`Call Switch One sync, dashboard list: ${seen.probe}`);
    // 2. Otherwise the documented API (CS1 IDs come from the saved uuid links).
    if (!reply) { reply = await listOfficial(cfg); seen.source = 'official'; }

    const { records } = reply;
    Object.assign(seen, { endpoint: reply.endpoint, status: reply.status, records: records.length, fields: fieldNames(records) });
    const mapped = records.map(mapCustomer);
    seen.samples = samplesOf(mapped);
    // Endpoint, status, count, field names and sample IDs; never values or credentials.
    console.log(`Call Switch One sync (${seen.source}): GET ${seen.endpoint} -> HTTP ${seen.status}, ${seen.records} records; fields: ${seen.fields.join(', ') || '(none)'}; sample IDs: ${seen.samples || '(none)'}`);
    // Never mark everyone removed because of an empty or unrecognised reply.
    if (!records.length) throw new Error('CallSwitch One returned no customers, so nothing was changed.');
    if (!mapped.some((c) => c.uuid || c.identifier)) throw new Error(`The reply has no uuid or customer_id, so nothing was changed. Fields returned: ${seen.fields.join(', ').slice(0, 600)}`);

    const counts = await transaction(async (conn) => {
      const [existing] = await conn.query('SELECT * FROM cs1_customers FOR UPDATE');
      const unknownBefore = await unknownLines(conn);
      const byUuid = new Map();
      const byIdent = new Map();
      for (const e of existing) {
        if (e.uuid && !byUuid.has(e.uuid)) byUuid.set(e.uuid, e);
        const key = normaliseId(e.identifier);
        if (key && !byIdent.has(key)) byIdent.set(key, e);
      }
      const touched = new Set();
      const handled = new Set();
      let added = 0; let updated = 0; let removed = 0; let restored = 0; let linked = 0;
      for (const c of mapped) {
        const key = c.uuid || c.identifier;
        if (!key || handled.has(key)) continue;
        handled.add(key);
        const next = rowOf(c);
        let row = (c.uuid && byUuid.get(c.uuid)) || (c.identifier && byIdent.get(c.identifier)) || null;
        let identifier = c.identifier || (row && row.identifier && CS1_NUMBER.test(row.identifier) ? row.identifier : null);
        // The CS1 ID is already on another row (added by hand or from a CDR): one customer.
        if (identifier && row) {
          const other = byIdent.get(identifier);
          if (other && other.id !== row.id && !touched.has(other.id) && (!other.uuid || other.uuid === c.uuid)) {
            await mergeRows(conn, other, row);
            touched.add(row.id);
            row = { ...other, uuid: other.uuid || row.uuid, client_id: other.client_id || row.client_id };
          } else if (other && other.id !== row.id) identifier = row.identifier && CS1_NUMBER.test(row.identifier) ? row.identifier : null;
        }
        if (!row) {
          const [ins] = await conn.query(`INSERT INTO cs1_customers (identifier, name, account_holder, store, email, status, registered_on, users_count, numbers_count, uuid, account_id, source, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', NOW())`,
          [identifier, next.name, next.account_holder, next.store, next.email, next.status, next.registered_on, next.users_count, next.numbers_count, c.uuid || null, c.accountId || null]);
          touched.add(ins.insertId);
          added += 1;
          if (!identifier) newUnlinked.push({ id: ins.insertId, company: next.name || c.holder || 'a new customer' });
          continue;
        }
        touched.add(row.id);
        // Company is the name; an empty company never wipes a name typed by hand.
        if (!next.name) next.name = realName(row.name, row.identifier) || '';
        const changed = COLUMNS.filter((k) => !same(dayOf(row[k]), next[k]));
        if (row.removed_at) restored += 1;
        if (identifier && row.identifier !== identifier) linked += 1;
        await writeSynced(conn, row.id, next, { identifier: identifier && row.identifier !== identifier ? identifier : null, uuid: c.uuid, accountId: c.accountId });
        if (changed.length) updated += 1;
        if (!identifier && !row.id_alerted_at) newUnlinked.push({ id: row.id, company: next.name || 'a customer' });
      }
      // Synced customers that are no longer returned: Removed (names typed by hand stay).
      for (const e of existing) {
        if (e.source === 'api' && !e.removed_at && !touched.has(e.id)) {
          await conn.query('UPDATE cs1_customers SET removed_at = NOW() WHERE id = ?', [e.id]);
          removed += 1;
        }
      }
      const [[pending]] = await conn.query('SELECT COUNT(*) AS n FROM cs1_customers WHERE identifier IS NULL AND removed_at IS NULL');
      // Saved billing months pick up the new companies (sent months keep their snapshot).
      const match = await rematchLines(conn, unknownBefore);
      const result = {
        total: handled.size, added, updated, removed, restored, linked, needsId: Number(pending.n), source: seen.source,
        rematched: match.newlyMatched, months: match.months, unknown: match.unknown,
      };
      await conn.query(`UPDATE cs1_sync_log SET status = 'ok', finished_at = NOW(), total = ?, added = ?, updated = ?, removed = ?,
        source = ?, probe = ?, endpoint = ?, http_status = ?, records = ?, fields = ?, sample_ids = ?, rematched = ? WHERE id = ?`,
      [result.total, added, updated, removed, seen.source, seen.probe.slice(0, 500), String(seen.endpoint).slice(0, 500), seen.status, seen.records,
        seen.fields.join(', ').slice(0, 4000), seen.samples.slice(0, 1000), match.newlyMatched, logId]);
      await logActivity(conn, user, {
        type: 'cs1', action: 'synced', subject: 'Call Switch One',
        summary: `Synced Call Switch One customers (${trigger === 'schedule' ? 'daily' : 'Sync now'}, ${seen.source === 'service' ? 'dashboard list' : 'API'}): ${result.total} from CallSwitch One, ${added} added, ${updated} updated, ${removed} marked removed${restored ? `, ${restored} back again` : ''}${linked ? `, ${linked} CS1 ID${linked === 1 ? '' : 's'} added` : ''}${result.needsId ? `, ${result.needsId} still need a CS1 ID` : ''}; ${match.newlyMatched} billing line${match.newlyMatched === 1 ? '' : 's'} in ${match.months} month${match.months === 1 ? '' : 's'} now matched`,
      });
      return result;
    });
    await alertNewCustomers(newUnlinked).catch((e) => console.error('CS1 new customer alert failed:', e.message));
    newUnlinked = [];
    return { ok: true, ...counts, fields: seen.fields };
  } catch (err) {
    const message = String(err.message || err).slice(0, 2000);
    if (err.endpoint) seen.endpoint = err.endpoint;
    if (err.status) seen.status = err.status;
    console.error(`Call Switch One sync failed: GET ${seen.endpoint} -> ${seen.status ? `HTTP ${seen.status}` : 'no reply'}: ${message}`);
    if (logId) {
      await pool.query(`UPDATE cs1_sync_log SET status = 'failed', finished_at = NOW(), error = ?, source = ?, probe = ?, endpoint = ?, http_status = ?, records = ?, fields = ?, sample_ids = ? WHERE id = ?`,
        [message, seen.source, seen.probe.slice(0, 500) || null, String(seen.endpoint).slice(0, 500), seen.status, seen.records, seen.fields.join(', ').slice(0, 4000) || null, seen.samples.slice(0, 1000) || null, logId]).catch(() => {});
    }
    await logActivity(null, user, { type: 'cs1', action: 'synced', subject: 'Call Switch One', summary: `Call Switch One customer sync failed: ${message.slice(0, 300)}` }).catch(() => {});
    await alertSyncFailure(message).catch((e) => console.error('CS1 sync alert failed:', e.message));
    return { ok: false, error: message };
  } finally {
    busy = false;
  }
}

async function lastSync(db = pool) {
  const [[last]] = await db.query(`
    SELECT s.*, COALESCE(NULLIF(u.display_name, ''), u.username) AS user_name
    FROM cs1_sync_log s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT 1
  `);
  const [[ok]] = await db.query("SELECT MAX(started_at) AS at FROM cs1_sync_log WHERE status = 'ok'");
  return { last: last || null, lastOkAt: ok ? ok.at : null };
}

// ---- Import CS1 IDs (the CS1 dashboard Customers export) ----

const normText = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(ltd|limited)\b/g, ' ').replace(/[^a-z0-9]/g, '');
const HEADERS = {
  id: ['id', 'customerid', 'cs1id', 'customer', 'accountid'],
  company: ['company', 'companyname', 'contactname', 'customername', 'name'],
  email: ['email', 'emailaddress', 'contactemail'],
};

// rows / headers from readSheet(); matches each row to a synced customer by company and / or
// email and saves its CS1 ID (linkId). Returns { linked, already, merged, unmatched, conflicts }.
async function importIds(conn, { headers, rows }) {
  const col = (names) => headers.findIndex((h) => names.includes(String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '')));
  const at = { id: col(HEADERS.id), company: col(HEADERS.company), email: col(HEADERS.email) };
  if (at.id < 0) return { error: 'The file has no ID column (the CS1 ID, e.g. CS1-512319).' };
  if (at.company < 0 && at.email < 0) return { error: 'The file needs a Company or Email column to match customers.' };
  const [customers] = await conn.query('SELECT * FROM cs1_customers WHERE uuid IS NOT NULL FOR UPDATE');
  const out = { linked: [], already: 0, merged: [], unmatched: [], conflicts: [], rows: 0 };
  const done = new Set();
  for (const r of rows) {
    const cs1 = normaliseId(r[at.id]);
    if (!CS1_NUMBER.test(cs1)) continue;
    out.rows += 1;
    const company = at.company >= 0 ? r[at.company] : '';
    const email = at.email >= 0 ? String(r[at.email] || '').trim().toLowerCase() : '';
    const live = customers.filter((c) => !done.has(c.id));
    let hits = live.filter((c) => company && normText(realName(c.name, c.identifier)) === normText(company) && (!email || !c.email || c.email.toLowerCase() === email));
    if (hits.length !== 1 && email) hits = live.filter((c) => c.email && c.email.toLowerCase() === email);
    if (hits.length !== 1) {
      out.unmatched.push(`${cs1} ${company || email}${hits.length > 1 ? ' (more than one match)' : ''}`);
      continue;
    }
    const res = await linkId(conn, hits[0], cs1);
    if (res.result === 'already') out.already += 1;
    else if (res.result === 'conflict') out.conflicts.push(res.message);
    else (res.result === 'merged' ? out.merged : out.linked).push(`${realName(hits[0].name, hits[0].identifier) || cs1} = ${cs1}`);
    done.add(hits[0].id);
  }
  return out;
}

// ---- Alerts to admins ----

async function admins() {
  const [rows] = await pool.query("SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, u.username, u.notify_channels FROM users u WHERE u.role = 'admin' ORDER BY name");
  return rows;
}

// One alert to every admin by their notification preference (bell, email, desktop).
async function tellAdmins({ title, body, heading, intro, tag }) {
  const { mailStatus, sendMail, logSkipped, userEmail, escapeHtml: e, appUrl } = mailer();
  const link = '/call-switch-one/customers';
  const base = appUrl();
  const font = 'font-family: Arial, Helvetica, sans-serif;';
  const html = `<!doctype html><html><body style="margin: 0; padding: 24px 12px; background: #F5F5F7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px;">
<tr><td style="${font} background: #200D6C; color: #FFFFFF; padding: 18px 24px; font-size: 16px; font-weight: bold; border-radius: 12px 12px 0 0;">Cleartwo <span style="color: #B9A6F0; font-weight: normal;">IT Support</span></td></tr>
<tr><td style="${font} padding: 24px; font-size: 14px; color: #000000;">
<p style="margin: 0 0 6px; color: #6741C3; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Call Switch One</p>
<p style="margin: 0 0 12px; color: #200D6C; font-size: 19px; font-weight: bold;">${e(heading)}</p>
<p style="margin: 0 0 20px;">${e(intro)}</p>
${base ? `<a href="${e(base + link)}" style="display: inline-block; background: #0390D7; color: #FFFFFF; text-decoration: none; font-weight: bold; padding: 12px 22px; border-radius: 999px;">Open Call Switch One customers</a>` : ''}
</td></tr></table></body></html>`;
  const text = `${heading}\n\n${intro}${base ? `\n\nOpen: ${base}${link}` : ''}`;
  const reached = [];
  for (const u of await admins()) {
    const ch = channelsOf(u);
    let any = false;
    if (ch.has('popup')) {
      await pool.query("INSERT INTO notifications (user_id, channel, type, title, body, link) VALUES (?, 'portal', 'cs1', ?, ?, ?)", [u.id, title.slice(0, 255), String(body).slice(0, 500), link]);
      any = true;
    }
    if (ch.has('email') && mailStatus().enabled) {
      const to = userEmail(u);
      const meta = { kind: 'cs1', userId: u.id };
      if (to) { await sendMail({ to, subject: title.slice(0, 200), html, text }, meta); any = true; } else await logSkipped({ to: u.username, subject: title, html, text }, meta, 'This user has no email address (their username is not an email address).');
    }
    if (ch.has('desktop') && await pushToUser(u.id, { title, body: String(body).slice(0, 300), url: link, tag }).catch(() => 0)) any = true;
    if (any) reached.push(u.name);
  }
  return reached;
}

// "New CallSwitch customer: {company}, add their CS1 ID." once per customer (id_alerted_at).
async function alertNewCustomers(list) {
  for (const c of list) {
    const [r] = await pool.query('UPDATE cs1_customers SET id_alerted_at = NOW() WHERE id = ? AND id_alerted_at IS NULL AND identifier IS NULL', [c.id]);
    if (r.affectedRows !== 1) continue;
    const title = `New CallSwitch customer: ${c.company}, add their CS1 ID.`;
    const reached = await tellAdmins({
      title, body: 'Add it on Call Switch One → Customers (Import CS1 IDs, or edit the customer), so their call charges are named.',
      heading: title, intro: 'CallSwitch One returned a customer without a CS1 ID. Add it on Call Switch One → Customers (Import CS1 IDs, or edit the customer) so their call charges show the company.', tag: `cs1-new-${c.id}`,
    });
    await logActivity(null, null, { type: 'cs1', action: 'sent', subject: 'Call Switch One', summary: `"${title}" sent to ${reached.join(', ') || 'nobody'}` }).catch(() => {});
  }
}

// Failure alert: admins, once per UK day.
async function alertSyncFailure(error) {
  const today = londonDate();
  const settings = await getSettings();
  if (settings.sync_alert_day === today) return false;
  await saveSetting(pool, 'sync_alert_day', today);
  const reached = await tellAdmins({
    title: 'Call Switch One: customer sync failed', body: String(error).slice(0, 300),
    heading: 'The customer sync with CallSwitch One failed', intro: `Customer names on the call charges are not being updated until this is fixed. ${String(error).slice(0, 500)}`, tag: 'cs1-sync',
  });
  await logActivity(null, null, { type: 'cs1', action: 'sent', subject: 'Call Switch One', summary: `Call Switch One sync failure alert sent to ${reached.join(', ') || 'nobody'}` }).catch(() => {});
  return true;
}

module.exports = {
  syncCustomers, lastSync, alertSyncFailure, importIds, linkId, SYNC_NOW_GAP_SECONDS,
};
