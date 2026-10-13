// Call Switch One customers (READ ONLY on the CS1 side, see api.js). Nobody's CallSwitch
// dashboard username, password or cookies are ever stored or sent.
//
// Refresh from CallSwitch (planRefresh / applyRefresh): a person pastes or uploads the JSON of
// the dashboard list from their own logged-in browser; it is parsed (parseDashboard), shown as
// a preview (new / updated / unchanged) and saved on confirm. customer_id is the key; uuid links
// the customer to the official API record. The pasted text is never stored.
//
// Daily sync (syncCustomers; 06:30 UK in index.js + "Sync now", at most once every 5 minutes):
// GET CS1_API_HOST/account/reseller with the API headers. Records are matched to saved
// customers by uuid and may ONLY update the Company (contact_name) and find new / removed
// customers: no other field from the dashboard refresh is ever overwritten (the API's users,
// store_front and status_id are never used) and a CS1 ID is never touched. An unknown uuid is
// added as "New, CS1 ID missing" (identifier NULL) and admins are alerted once: "New
// CallSwitch customer: {company}. Click Refresh from CallSwitch to add their CS1 ID."
// Customers linked to the API that it no longer returns are marked removed (never deleted).
// Refreshes are cs1_sync_log rows too (source 'dashboard'), so the page shows both.
//
// Each sync run is in cs1_sync_log (endpoint, HTTP status, records, field names (never values),
// sample IDs, re-matched lines, error); refreshes and syncs are logged as entity_type 'cs1',
// action 'synced' (never on the Daily Report). After every refresh and good sync the lines of
// every saved billing month are re-matched. Failures alert admins once a day.
const { pool, transaction } = require('../../db');
const { logActivity, londonDate } = require('../activity');
const { channelsOf } = require('../notify');
const { pushToUser } = require('../push');
const {
  listOfficial, fieldNames, mapOfficial, cs1ApiConfig, normaliseId,
} = require('./api');
const {
  getSettings, saveSetting, rematchLines, unknownLines, realName,
} = require('./billing');

const mailer = () => require('../mailer'); // eslint-disable-line global-require
const SYNC_NOW_GAP_SECONDS = 5 * 60;
const CS1_NUMBER = /^CS1-\d+$/;
const MAX_REFRESH = 5000;

const same = (a, b) => String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b);
const dayOf = (v) => (v instanceof Date ? londonDate(v) : v);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let busy = false;

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
    await conn.query(`UPDATE cs1_customers SET name = ?, account_holder = ?, store = ?, email = ?, phone = ?, status = ?, ceased_on = ?, registered_on = ?, users_count = ?, numbers_count = ?,
      is_demo = ?, uuid = ?, account_id = COALESCE(?, account_id), client_id = COALESCE(client_id, ?), source = 'api', removed_at = NULL, synced_at = COALESCE(?, synced_at) WHERE id = ?`,
    [realName(row.name, row.identifier) || other.name || '', row.account_holder, row.store, row.email, row.phone || null, row.status, row.ceased_on || null, row.registered_on,
      row.users_count, row.numbers_count, row.is_demo ? 1 : 0, row.uuid, row.account_id || null, row.client_id || null, row.synced_at || null, other.id]);
    return { result: 'merged', message: `${realName(row.name, row.identifier) || id} is ${id}.`, id: other.id };
  }
  await conn.query('UPDATE cs1_customers SET identifier = ? WHERE id = ?', [id, row.id]);
  return { result: 'linked', message: `${realName(row.name, row.identifier) || id} is ${id}.`, id: row.id };
}

// ---- Refresh from CallSwitch (the dashboard list pasted from a person's own browser) ----

// What a dashboard record writes on a customer row.
const refreshRow = (c) => ({
  identifier: c.identifier, uuid: c.uuid || null, account_id: c.accountId || null, name: c.company || '', account_holder: c.holder || null,
  store: c.store || null, email: c.email || null, phone: c.phone || null, status: c.status || 'Active', ceased_on: c.ceasedOn || null,
  registered_on: c.registered || null, users_count: c.users, numbers_count: c.numbers, is_demo: c.demo ? 1 : 0,
});
const REFRESH_FIELDS = [
  ['name', 'company'], ['account_holder', 'account holder'], ['store', 'store'], ['email', 'email'], ['phone', 'phone'], ['status', 'status'],
  ['ceased_on', 'ceased date'], ['registered_on', 'registered'], ['users_count', 'users'], ['numbers_count', 'numbers'], ['uuid', 'API link'], ['is_demo', 'demo'],
];

// The mapped records posted back by the preview form, checked again (types and lengths).
function cleanMapped(list) {
  if (!Array.isArray(list)) return [];
  const t = (v, n) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.min(Math.round(Number(v)), 1e6));
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  return list.slice(0, MAX_REFRESH).filter((c) => c && typeof c === 'object').map((c) => ({
    identifier: normaliseId(t(c.identifier, 191)), uuid: t(c.uuid, 64), accountId: t(c.accountId, 64), company: t(c.company, 200), holder: t(c.holder, 200),
    store: t(c.store, 200), email: t(c.email, 255), phone: t(c.phone, 40), status: ['Active', 'Ceased', 'Locked'].includes(c.status) ? c.status : 'Active',
    ceasedOn: day(c.ceasedOn), registered: day(c.registered), users: num(c.users), numbers: num(c.numbers), demo: Boolean(c.demo),
  })).filter((c) => CS1_NUMBER.test(c.identifier));
}

// { added: [...], updated: [{ company, identifier, changes }], unchanged, conflicts, steps }.
// steps is what applyRefresh does for each record. Read-only.
async function planRefresh(db, mapped, { lock = false } = {}) {
  const [existing] = await db.query(`SELECT * FROM cs1_customers${lock ? ' FOR UPDATE' : ''}`);
  const byIdent = new Map();
  const byUuid = new Map();
  for (const e of existing) {
    const key = normaliseId(e.identifier);
    if (key && !byIdent.has(key)) byIdent.set(key, e);
    if (e.uuid && !byUuid.has(e.uuid)) byUuid.set(e.uuid, e);
  }
  const plan = { added: [], updated: [], unchanged: 0, conflicts: [], steps: [] };
  const seen = new Set();
  for (const c of mapped) {
    if (!c.identifier || seen.has(c.identifier)) continue;
    seen.add(c.identifier);
    const next = refreshRow(c);
    const byId = byIdent.get(c.identifier) || null;
    const byU = (c.uuid && byUuid.get(c.uuid)) || null;
    if (byId && byU && byId.id !== byU.id && byU.identifier && byU.identifier !== c.identifier) {
      plan.conflicts.push(`${c.company || c.identifier}: CallSwitch says ${c.identifier} but the API record is saved as ${byU.identifier}`);
      continue;
    }
    const target = byId || byU;
    if (!target) {
      plan.added.push({ company: next.name, identifier: c.identifier, status: next.status });
      plan.steps.push({ kind: 'add', next });
      continue;
    }
    const changes = REFRESH_FIELDS.filter(([col]) => !same(dayOf(target[col]), next[col])).map(([, label]) => label);
    if (target.identifier !== c.identifier) changes.unshift('CS1 ID');
    if (target.removed_at) changes.push('back from Removed');
    if (target.source !== 'api') changes.push('synced');
    const merge = byId && byU && byId.id !== byU.id ? byU : null;
    if (merge) changes.push('merged with the API record');
    if (changes.length) {
      plan.updated.push({ company: next.name || realName(target.name, target.identifier) || c.identifier, identifier: c.identifier, changes: [...new Set(changes)] });
      plan.steps.push({ kind: 'update', id: target.id, next, merge });
    } else plan.unchanged += 1;
  }
  return plan;
}

// Saves a refresh (re-planned inside the transaction), re-matches the billing months and logs it.
async function applyRefresh(user, mapped) {
  return transaction(async (conn) => {
    const unknownBefore = await unknownLines(conn);
    const plan = await planRefresh(conn, mapped, { lock: true });
    for (const step of plan.steps) {
      const n = step.next;
      const values = [n.name, n.account_holder, n.store, n.email, n.phone, n.status, n.ceased_on, n.registered_on, n.users_count, n.numbers_count, n.is_demo, n.uuid, n.account_id];
      if (step.kind === 'add') {
        await conn.query(`INSERT INTO cs1_customers (identifier, name, account_holder, store, email, phone, status, ceased_on, registered_on, users_count, numbers_count, is_demo, uuid, account_id, source, synced_at, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', NOW(), ?, ?)`, [n.identifier, ...values, user ? user.id : null, user ? user.id : null]);
        await conn.query('UPDATE cs1_customers SET refreshed_at = NOW() WHERE identifier = ?', [n.identifier]);
        continue;
      }
      if (step.merge) {
        // The CS1 ID row (added by hand / from a CDR) and the API record (waiting for its ID): one customer.
        await mergeRows(conn, { id: step.id }, step.merge);
      }
      await conn.query(`UPDATE cs1_customers SET identifier = ?, name = ?, account_holder = ?, store = ?, email = ?, phone = ?, status = ?, ceased_on = ?, registered_on = ?,
        users_count = ?, numbers_count = ?, is_demo = ?, uuid = COALESCE(?, uuid), account_id = COALESCE(?, account_id), source = 'api', removed_at = NULL, synced_at = NOW(), refreshed_at = NOW(), updated_by = ? WHERE id = ?`,
      [n.identifier, ...values, user ? user.id : null, step.id]);
    }
    const match = await rematchLines(conn, unknownBefore);
    const result = { added: plan.added.length, updated: plan.updated.length, unchanged: plan.unchanged, conflicts: plan.conflicts, rematched: match.newlyMatched, months: match.months };
    await conn.query(`INSERT INTO cs1_sync_log (trigger_type, status, user_id, source, finished_at, total, added, updated, records, rematched, endpoint)
      VALUES ('refresh', 'ok', ?, 'dashboard', NOW(), ?, ?, ?, ?, ?, 'Refresh from CallSwitch (pasted dashboard list)')`,
    [user ? user.id : null, mapped.length, result.added, result.updated, mapped.length, match.newlyMatched]);
    await logActivity(conn, user, {
      type: 'cs1', action: 'synced', subject: 'Call Switch One',
      summary: `Refreshed Call Switch One customers from CallSwitch (dashboard list): ${plural(result.added, 'new customer')}, ${result.updated} updated, ${result.unchanged} unchanged${result.conflicts.length ? `, ${result.conflicts.length} skipped` : ''}; ${plural(match.newlyMatched, 'billing line')} in ${plural(match.months, 'month')} now matched${plan.added.length ? ` (new: ${plan.added.slice(0, 15).map((a) => `${a.company || a.identifier} ${a.identifier}`).join(', ')})` : ''}`,
    });
    return result;
  });
}

// ---- Daily official API sync ----

// "1234 → CS1-001234" style samples are only for dashboard IDs; the API has uuids only.
const samplesOf = (records) => records.slice(0, 5).map((r) => r.uuid).filter(Boolean).map((u) => `uuid ${String(u).slice(0, 8)}…`).join(', ');

async function syncCustomers(user, { trigger = 'manual' } = {}) {
  const cfg = cs1ApiConfig();
  if (!cfg.configured) return { ok: false, error: cfg.message, notConfigured: true };
  if (busy) return { ok: false, error: 'A Call Switch One sync is already running. Try again in a minute.' };
  if (trigger === 'manual') {
    const [[gap]] = await pool.query("SELECT TIMESTAMPDIFF(SECOND, MAX(started_at), NOW()) AS ago FROM cs1_sync_log WHERE COALESCE(source, 'official') <> 'dashboard'");
    if (gap && gap.ago !== null && Number(gap.ago) < SYNC_NOW_GAP_SECONDS) {
      const wait = Math.max(1, Math.ceil((SYNC_NOW_GAP_SECONDS - Number(gap.ago)) / 60));
      return { ok: false, error: `Sync now can run once every 5 minutes. Try again in ${plural(wait, 'minute')}.` };
    }
  }
  busy = true;
  // A run cut off by a restart never finished: close it so the page does not show it running.
  await pool.query("UPDATE cs1_sync_log SET status = 'failed', finished_at = NOW(), error = 'Stopped before it finished (the portal restarted).' WHERE status = 'running' AND started_at < NOW() - INTERVAL 15 MINUTE").catch(() => {});
  let logId = null;
  const seen = { endpoint: cfg.url, status: null, records: null, fields: [], samples: '' };
  let newUnlinked = [];
  try {
    const [log] = await pool.query('INSERT INTO cs1_sync_log (trigger_type, status, user_id, endpoint, source) VALUES (?, ?, ?, ?, ?)', [trigger, 'running', user ? user.id : null, cfg.url, 'official']);
    logId = log.insertId;
    const reply = await listOfficial(cfg);
    const { records } = reply;
    Object.assign(seen, { endpoint: reply.endpoint, status: reply.status, records: records.length, fields: fieldNames(records), samples: samplesOf(records) });
    console.log(`Call Switch One sync: GET ${seen.endpoint} -> HTTP ${seen.status}, ${seen.records} records; fields: ${seen.fields.join(', ') || '(none)'}`);
    const mapped = records.map(mapOfficial).filter((c) => c.uuid);
    // Never mark everyone removed because of an empty or unrecognised reply.
    if (!records.length) throw new Error('CallSwitch One returned no customers, so nothing was changed.');
    if (!mapped.length) throw new Error(`The reply has no uuid, so nothing was changed. Fields returned: ${seen.fields.join(', ').slice(0, 600)}`);

    const counts = await transaction(async (conn) => {
      const [existing] = await conn.query('SELECT * FROM cs1_customers FOR UPDATE');
      const unknownBefore = await unknownLines(conn);
      const byUuid = new Map();
      for (const e of existing) if (e.uuid && !byUuid.has(e.uuid)) byUuid.set(e.uuid, e);
      const touched = new Set();
      let added = 0; let updated = 0; let removed = 0; let restored = 0;
      for (const c of mapped) {
        if (touched.has(`u:${c.uuid}`)) continue;
        touched.add(`u:${c.uuid}`);
        const row = byUuid.get(c.uuid);
        if (!row) {
          // Unknown uuid: "New, CS1 ID missing" until Refresh from CallSwitch adds the ID and details.
          const [ins] = await conn.query("INSERT INTO cs1_customers (identifier, name, uuid, source, synced_at) VALUES (NULL, ?, ?, 'api', NOW())", [c.company, c.uuid]);
          touched.add(ins.insertId);
          added += 1;
          newUnlinked.push({ id: ins.insertId, company: c.company || 'a new customer' });
          continue;
        }
        touched.add(row.id);
        // The API may only update the Company; every other field stays as the dashboard refresh
        // (or a person) saved it, and the CS1 ID is never touched.
        const name = c.company || row.name;
        if (row.removed_at) restored += 1;
        if (name !== row.name) updated += 1;
        await conn.query('UPDATE cs1_customers SET name = ?, removed_at = NULL, synced_at = NOW() WHERE id = ?', [name, row.id]);
        if (!row.identifier && !row.id_alerted_at) newUnlinked.push({ id: row.id, company: name || 'a customer' });
      }
      // Customers linked to the API that it no longer returns: Removed (never deleted).
      for (const e of existing) {
        if (e.uuid && !e.removed_at && !touched.has(e.id)) {
          await conn.query('UPDATE cs1_customers SET removed_at = NOW() WHERE id = ?', [e.id]);
          removed += 1;
        }
      }
      const [[pending]] = await conn.query('SELECT COUNT(*) AS n FROM cs1_customers WHERE identifier IS NULL AND removed_at IS NULL');
      const match = await rematchLines(conn, unknownBefore);
      const result = {
        total: mapped.length, added, updated, removed, restored, needsId: Number(pending.n), source: 'official', rematched: match.newlyMatched, months: match.months,
      };
      await conn.query(`UPDATE cs1_sync_log SET status = 'ok', finished_at = NOW(), total = ?, added = ?, updated = ?, removed = ?,
        endpoint = ?, http_status = ?, records = ?, fields = ?, sample_ids = ?, rematched = ? WHERE id = ?`,
      [result.total, added, updated, removed, String(seen.endpoint).slice(0, 500), seen.status, seen.records,
        seen.fields.join(', ').slice(0, 4000), seen.samples.slice(0, 1000), match.newlyMatched, logId]);
      await logActivity(conn, user, {
        type: 'cs1', action: 'synced', subject: 'Call Switch One',
        summary: `Synced Call Switch One customers from the API (${trigger === 'schedule' ? 'daily' : 'Sync now'}): ${result.total} from CallSwitch One, ${added} new, ${updated} updated, ${removed} marked removed${restored ? `, ${restored} back again` : ''}${result.needsId ? `, ${result.needsId} need a CS1 ID` : ''}; ${plural(match.newlyMatched, 'billing line')} in ${plural(match.months, 'month')} now matched`,
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

// The last API sync (last, lastOkAt) and the last Refresh from CallSwitch (refresh).
async function lastSync(db = pool) {
  const pick = async (where) => {
    const [[row]] = await db.query(`
      SELECT s.*, COALESCE(NULLIF(u.display_name, ''), u.username) AS user_name
      FROM cs1_sync_log s LEFT JOIN users u ON u.id = s.user_id WHERE ${where} ORDER BY s.id DESC LIMIT 1
    `);
    return row || null;
  };
  const [[ok]] = await db.query("SELECT MAX(started_at) AS at FROM cs1_sync_log WHERE status = 'ok' AND COALESCE(source, 'official') <> 'dashboard'");
  return { last: await pick("COALESCE(s.source, 'official') <> 'dashboard'"), lastOkAt: ok ? ok.at : null, refresh: await pick("s.source = 'dashboard'") };
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

// "New CallSwitch customer: {company}. Click Refresh from CallSwitch to add their CS1 ID."
// once per customer (id_alerted_at). More than 5 at once (e.g. the first sync) is one alert.
async function alertNewCustomers(list) {
  const fresh = [];
  for (const c of list) {
    const [r] = await pool.query('UPDATE cs1_customers SET id_alerted_at = NOW() WHERE id = ? AND id_alerted_at IS NULL AND identifier IS NULL', [c.id]);
    if (r.affectedRows === 1) fresh.push(c);
  }
  if (!fresh.length) return;
  const intro = 'CallSwitch One has a customer without a CS1 ID in the portal. On Call Switch One → Customers, click Refresh from CallSwitch (logged in to CallSwitch) to add the CS1 IDs, so their call charges show the company.';
  const send = async (title, tag) => {
    const reached = await tellAdmins({ title, body: 'Click Refresh from CallSwitch on Call Switch One → Customers.', heading: title, intro, tag });
    await logActivity(null, null, { type: 'cs1', action: 'sent', subject: 'Call Switch One', summary: `"${title}" sent to ${reached.join(', ') || 'nobody'}` }).catch(() => {});
  };
  if (fresh.length > 5) {
    await send(`${fresh.length} new CallSwitch customers: ${fresh.slice(0, 5).map((c) => c.company).join(', ')}… Click Refresh from CallSwitch to add their CS1 IDs.`, 'cs1-new-many');
    return;
  }
  for (const c of fresh) await send(`New CallSwitch customer: ${c.company}. Click Refresh from CallSwitch to add their CS1 ID.`, `cs1-new-${c.id}`);
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
  syncCustomers, lastSync, alertSyncFailure, importIds, linkId, planRefresh, applyRefresh, cleanMapped, SYNC_NOW_GAP_SECONDS,
};
