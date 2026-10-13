// Call Switch One customer sync (READ ONLY on the CS1 side, see api.js): daily at 06:30
// UK (index.js) and "Sync now". Customers are matched by CS1 ID (cs1_customers.identifier):
// existing ones are updated, new ones added, synced ones no longer returned are marked
// removed (removed_at; never deleted, so old months keep their names). Company is the
// customer name. Each run is recorded in cs1_sync_log with the field names the API
// returned (never values) and logged as entity_type 'cs1', action 'synced' (never on the
// Daily Report). A failure is stored (red banner on the Customers page) and admins are
// alerted once a day by their notification preference.
const { pool, transaction } = require('../../db');
const { logActivity, londonDate } = require('../activity');
const { channelsOf } = require('../notify');
const { pushToUser } = require('../push');
const { listCustomers, fieldNames, mapCustomer, cs1ApiConfig, normaliseId } = require('./api');
const { getSettings, saveSetting, rematchLines, unknownLines, realName } = require('./billing');

const mailer = () => require('../mailer'); // eslint-disable-line global-require
const COLUMNS = ['name', 'account_holder', 'store', 'email', 'status', 'registered_on', 'users_count', 'numbers_count'];

const rowOf = (c) => ({
  name: c.company, account_holder: c.holder || null, store: c.store || null, email: c.email || null, status: c.status || null,
  registered_on: c.registered, users_count: c.users, numbers_count: c.numbers,
});
const same = (a, b) => String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b);

let busy = false;

// "CS1-001234" or "001234 → CS1-001234" when the API wrote it differently; first 8.
const samplesOf = (mapped) => mapped.filter((c) => c.identifier).slice(0, 8)
  .map((c) => (c.rawId && c.rawId.toUpperCase() !== c.identifier ? `${c.rawId} → ${c.identifier}` : c.identifier)).join(', ');

async function syncCustomers(user, { trigger = 'manual' } = {}) {
  const cfg = cs1ApiConfig();
  if (!cfg.configured) return { ok: false, error: cfg.message, notConfigured: true };
  if (busy) return { ok: false, error: 'A Call Switch One sync is already running. Try again in a minute.' };
  busy = true;
  // A run cut off by a restart never finished: close it so the page does not show it running.
  await pool.query("UPDATE cs1_sync_log SET status = 'failed', finished_at = NOW(), error = 'Stopped before it finished (the portal restarted).' WHERE status = 'running' AND started_at < NOW() - INTERVAL 15 MINUTE").catch(() => {});
  let logId = null;
  // What was asked and seen, kept for the log even when the sync fails.
  const seen = { endpoint: cfg.url, status: null, records: null, fields: [], samples: '' };
  try {
    const [log] = await pool.query('INSERT INTO cs1_sync_log (trigger_type, status, user_id, endpoint) VALUES (?, ?, ?, ?)', [trigger, 'running', user ? user.id : null, cfg.url]);
    logId = log.insertId;
    const reply = await listCustomers();
    const { records } = reply;
    Object.assign(seen, { endpoint: reply.endpoint, status: reply.status, records: records.length, fields: fieldNames(records) });
    const mapped = records.map(mapCustomer);
    seen.samples = samplesOf(mapped);
    // Endpoint, status, count, field names and sample IDs; never values or credentials.
    console.log(`Call Switch One sync: GET ${seen.endpoint} -> HTTP ${seen.status}, ${seen.records} records; fields: ${seen.fields.join(', ') || '(none)'}; sample IDs: ${seen.samples || '(none)'}`);
    const byId = new Map();
    for (const c of mapped) if (c.identifier && !byId.has(c.identifier)) byId.set(c.identifier, c);
    // Never mark everyone removed because of an empty or unrecognised reply.
    if (!records.length) throw new Error('The CallSwitch One API returned no customers, so nothing was changed.');
    if (!byId.size) throw new Error(`No CS1 IDs were found in the reply, so nothing was changed. Fields returned: ${seen.fields.join(', ').slice(0, 600)}. Set CS1_API_FIELDS (e.g. id=account_number) if the ID is in one of them.`);

    const counts = await transaction(async (conn) => {
      const [existing] = await conn.query('SELECT * FROM cs1_customers FOR UPDATE');
      const unknownBefore = await unknownLines(conn);
      // Existing customers by normalised CS1 ID (older rows may be "1234" or "cs1-1234").
      const known = new Map();
      for (const e of existing) {
        const key = normaliseId(e.identifier);
        if (!known.has(key)) known.set(key, e);
      }
      let added = 0; let updated = 0; let removed = 0; let restored = 0;
      for (const [identifier, c] of byId) {
        const next = rowOf(c);
        const before = known.get(identifier);
        if (!before) {
          await conn.query(`INSERT INTO cs1_customers (identifier, name, account_holder, store, email, status, registered_on, users_count, numbers_count, source, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', NOW())`,
          [identifier, next.name, next.account_holder, next.store, next.email, next.status, next.registered_on, next.users_count, next.numbers_count]);
          added += 1;
          continue;
        }
        // Company is the name; an empty company never wipes a name typed by hand.
        if (!next.name) next.name = realName(before.name, before.identifier) || '';
        const changed = COLUMNS.filter((k) => !same(before[k] instanceof Date ? londonDate(before[k]) : before[k], next[k]));
        if (before.removed_at) restored += 1;
        if (changed.length || before.removed_at || before.source !== 'api' || before.identifier !== identifier) {
          const sql = `UPDATE cs1_customers SET identifier = ?, name = ?, account_holder = ?, store = ?, email = ?, status = ?, registered_on = ?, users_count = ?, numbers_count = ?,
            source = 'api', removed_at = NULL, synced_at = NOW() WHERE id = ?`;
          const values = [next.name, next.account_holder, next.store, next.email, next.status, next.registered_on, next.users_count, next.numbers_count, before.id];
          try {
            await conn.query(sql, [identifier, ...values]);
          } catch (err) {
            // Another old row already has the normalised ID: keep this one's ID as it was.
            if (err.code !== 'ER_DUP_ENTRY') throw err;
            await conn.query(sql, [before.identifier, ...values]);
          }
          if (changed.length) updated += 1;
        } else {
          await conn.query('UPDATE cs1_customers SET synced_at = NOW() WHERE id = ?', [before.id]);
        }
      }
      // Synced customers that are no longer returned: Removed (names typed by hand stay).
      for (const e of existing) {
        if (e.source === 'api' && !e.removed_at && !byId.has(normaliseId(e.identifier))) {
          await conn.query('UPDATE cs1_customers SET removed_at = NOW() WHERE id = ?', [e.id]);
          removed += 1;
        }
      }
      // Saved billing months pick up the new companies (sent months keep their snapshot).
      const match = await rematchLines(conn, unknownBefore);
      const result = { total: byId.size, added, updated, removed, restored, rematched: match.newlyMatched, months: match.months, unknown: match.unknown };
      await conn.query(`UPDATE cs1_sync_log SET status = 'ok', finished_at = NOW(), total = ?, added = ?, updated = ?, removed = ?,
        endpoint = ?, http_status = ?, records = ?, fields = ?, sample_ids = ?, rematched = ? WHERE id = ?`,
      [result.total, added, updated, removed, String(seen.endpoint).slice(0, 500), seen.status, seen.records,
        seen.fields.join(', ').slice(0, 4000), seen.samples.slice(0, 1000), match.newlyMatched, logId]);
      await logActivity(conn, user, {
        type: 'cs1', action: 'synced', subject: 'Call Switch One',
        summary: `Synced Call Switch One customers (${trigger === 'schedule' ? 'daily' : 'Sync now'}): ${result.total} from CallSwitch One, ${added} added, ${updated} updated, ${removed} marked removed${restored ? `, ${restored} back again` : ''}; ${match.newlyMatched} billing line${match.newlyMatched === 1 ? '' : 's'} in ${match.months} month${match.months === 1 ? '' : 's'} now matched`,
      });
      return result;
    });
    return { ok: true, ...counts, fields: seen.fields };
  } catch (err) {
    const message = String(err.message || err).slice(0, 2000);
    if (err.endpoint) seen.endpoint = err.endpoint;
    if (err.status) seen.status = err.status;
    console.error(`Call Switch One sync failed: GET ${seen.endpoint} -> ${seen.status ? `HTTP ${seen.status}` : 'no reply'}: ${message}`);
    if (logId) {
      await pool.query(`UPDATE cs1_sync_log SET status = 'failed', finished_at = NOW(), error = ?, endpoint = ?, http_status = ?, records = ?, fields = ?, sample_ids = ? WHERE id = ?`,
        [message, String(seen.endpoint).slice(0, 500), seen.status, seen.records, seen.fields.join(', ').slice(0, 4000) || null, seen.samples.slice(0, 1000) || null, logId]).catch(() => {});
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

// ---- Failure alert: admins, once per UK day ----

async function alertSyncFailure(error) {
  const today = londonDate();
  const settings = await getSettings();
  if (settings.sync_alert_day === today) return false;
  await saveSetting(pool, 'sync_alert_day', today);
  const { mailStatus, sendMail, logSkipped, userEmail, escapeHtml: e, appUrl } = mailer();
  const [admins] = await pool.query("SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, u.username, u.notify_channels FROM users u WHERE u.role = 'admin' ORDER BY name");
  const title = 'Call Switch One: customer sync failed';
  const body = String(error).slice(0, 300);
  const link = '/call-switch-one/customers';
  const base = appUrl();
  const font = 'font-family: Arial, Helvetica, sans-serif;';
  const html = `<!doctype html><html><body style="margin: 0; padding: 24px 12px; background: #F5F5F7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px;">
<tr><td style="${font} background: #200D6C; color: #FFFFFF; padding: 18px 24px; font-size: 16px; font-weight: bold; border-radius: 12px 12px 0 0;">Cleartwo <span style="color: #B9A6F0; font-weight: normal;">IT Support</span></td></tr>
<tr><td style="${font} padding: 24px; font-size: 14px; color: #000000;">
<p style="margin: 0 0 6px; color: #6741C3; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Call Switch One</p>
<p style="margin: 0 0 12px; color: #200D6C; font-size: 19px; font-weight: bold;">The customer sync with CallSwitch One failed</p>
<p style="margin: 0 0 16px;">Customer names on the call charges are not being updated until this is fixed.</p>
<p style="margin: 0 0 20px; color: #B00020;">${e(String(error).slice(0, 500))}</p>
${base ? `<a href="${e(base + link)}" style="display: inline-block; background: #0390D7; color: #FFFFFF; text-decoration: none; font-weight: bold; padding: 12px 22px; border-radius: 999px;">Open Call Switch One customers</a>` : ''}
</td></tr></table></body></html>`;
  const text = `${title}\n\n${String(error).slice(0, 500)}${base ? `\n\nOpen: ${base}${link}` : ''}`;
  const reached = [];
  for (const u of admins) {
    const ch = channelsOf(u);
    let any = false;
    if (ch.has('popup')) {
      await pool.query("INSERT INTO notifications (user_id, channel, type, title, body, link) VALUES (?, 'portal', 'cs1', ?, ?, ?)", [u.id, title, body, link]);
      any = true;
    }
    if (ch.has('email') && mailStatus().enabled) {
      const to = userEmail(u);
      const meta = { kind: 'cs1', userId: u.id };
      if (to) { await sendMail({ to, subject: title, html, text }, meta); any = true; } else await logSkipped({ to: u.username, subject: title, html, text }, meta, 'This user has no email address (their username is not an email address).');
    }
    if (ch.has('desktop') && await pushToUser(u.id, { title, body, url: link, tag: 'cs1-sync' }).catch(() => 0)) any = true;
    if (any) reached.push(u.name);
  }
  await logActivity(null, null, { type: 'cs1', action: 'sent', subject: 'Call Switch One', summary: `Call Switch One sync failure alert sent to ${reached.join(', ') || 'nobody'}` }).catch(() => {});
  return true;
}

module.exports = { syncCustomers, lastSync, alertSyncFailure };
