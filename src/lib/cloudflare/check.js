// Cloudflare checks (READ ONLY on Cloudflare): every 6 hours (index.js, 00:15 / 06:15 /
// 12:15 / 18:15 UK), "Check now" for everything and per domain.
//   1. GET /accounts (all pages): new accounts are added; an account the token no longer
//      sees gets access_lost (alert) and its domains are left as they are.
//   2. GET /zones per account (all pages): status, plan, type and Cloudflare's assigned
//      nameservers are saved. A zone missing from an account we can still see is marked
//      deleted (kept), with who / when from the account's audit log where available.
//   3. Public DNS (1.1.1.1, 8.8.8.8): a domain whose nameservers no longer match Cloudflare's
//      gets nameservers_ok = 0 and an ns_changed event, before Cloudflare marks it "moved";
//      back on Cloudflare's: back_to_cloudflare.
//   4. RDAP once a (UK) day per domain: expiry date and registrar; expiring (30 / 14 / 7 days)
//      and expired events, once per threshold and expiry date.
// Every run is in cf_check_log and the activity log (entity_type 'cloudflare'); events are
// in domain_events and the activity log, then alerts go out (src/lib/cloudflare/alerts.js).
const { pool } = require('../../db');
const { logActivity, londonDate, londonDayStart } = require('../activity');
const api = require('./api');
const { publicNameservers, sameNs, nsList, rdapLookup, providersLabel } = require('./lookups');
const { autoLink, parseList, daysUntil } = require('./data');
const { sendEventAlerts } = require('./alerts');

let running = false;

const log = (user, entry) => logActivity(null, user, { type: 'cloudflare', subject: 'Cloudflare', ...entry }).catch((err) => console.error('Cloudflare log failed:', err.message));
const json = (v) => JSON.stringify(v);

// Records an event (once per dedupe key, when given). Returns true when it is new.
async function addEvent(db, { domain = null, accountId = null, type, details = {}, key = null }, user = null) {
  const [r] = await db.query(
    'INSERT IGNORE INTO domain_events (domain_id, cf_account_id, type, details, dedupe_key) VALUES (?, ?, ?, ?, ?)',
    [domain ? domain.id : null, accountId, type, json(details), key]
  );
  if (r.affectedRows !== 1) return false;
  await log(user, {
    id: domain ? domain.id : null, action: 'updated', clientId: domain ? domain.client_id : null,
    summary: `Cloudflare: ${type.replace(/_/g, ' ')}${domain ? ` on ${domain.name}` : ''}${details.text ? `: ${details.text}` : ''}`,
  });
  return true;
}

// ---- Accounts ----
async function syncAccounts(user) {
  const seen = await api.listAccounts();
  const [known] = await pool.query('SELECT id, account_id, name, access_lost FROM cf_accounts');
  const byKey = new Map(known.map((a) => [a.account_id, a]));
  let events = 0;
  for (const a of seen) {
    const existing = byKey.get(a.id);
    await pool.query(`
      INSERT INTO cf_accounts (account_id, name, last_seen) VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE name = VALUES(name), last_seen = NOW(), access_lost = 0, access_lost_at = NULL
    `, [a.id, String(a.name || a.id).slice(0, 255)]);
    if (existing && existing.access_lost) await log(user, { action: 'updated', summary: `Cloudflare: access to the account ${a.name} is back` });
  }
  const seenKeys = new Set(seen.map((a) => a.id));
  for (const a of known) {
    if (seenKeys.has(a.account_id) || a.access_lost) continue;
    await pool.query('UPDATE cf_accounts SET access_lost = 1, access_lost_at = NOW() WHERE id = ?', [a.id]);
    if (await addEvent(pool, { accountId: a.id, type: 'access_lost', details: { account: a.name, text: `the token no longer sees ${a.name}` } }, user)) events += 1;
  }
  await autoLink(pool);
  const [rows] = await pool.query('SELECT id, account_id, name, client_id FROM cf_accounts WHERE access_lost = 0');
  return { accounts: rows, events };
}

// ---- Zones ----
async function saveZone(zone, account, user) {
  const [[byZone]] = await pool.query('SELECT * FROM domains WHERE zone_id = ?', [zone.id]);
  const [[byName]] = byZone ? [[null]] : await pool.query('SELECT * FROM domains WHERE name = ?', [String(zone.name).toLowerCase()]);
  const existing = byZone || byName;
  const fields = {
    name: String(zone.name).toLowerCase(),
    zone_id: zone.id,
    cf_account_id: account.id,
    cf_status: String(zone.status || '').slice(0, 20) || null,
    cf_type: String(zone.type || '').slice(0, 20) || null,
    plan: zone.plan && zone.plan.name ? String(zone.plan.name).slice(0, 100) : null,
    assigned_ns: json(nsList(zone.name_servers)),
  };
  let events = 0;
  if (!existing) {
    await pool.query(`
      INSERT INTO domains (name, zone_id, cf_account_id, client_id, cf_status, cf_type, plan, assigned_ns, last_checked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [fields.name, fields.zone_id, fields.cf_account_id, account.client_id || null, fields.cf_status, fields.cf_type, fields.plan, fields.assigned_ns]);
    return { events, isNew: true };
  }
  const domain = { ...existing, ...fields };
  if (existing.deleted_at) {
    await pool.query('UPDATE domains SET deleted_at = NULL, deleted_by = NULL WHERE id = ?', [existing.id]);
    if (await addEvent(pool, { domain, type: 're_added', details: { text: `back in Cloudflare (${account.name})` } }, user)) events += 1;
  }
  if (fields.cf_status === 'moved' && existing.cf_status !== 'moved') {
    if (await addEvent(pool, { domain, type: 'moved', details: { text: 'Cloudflare marked the zone as moved', from: existing.cf_status } }, user)) events += 1;
  }
  const clientSql = existing.client_manual ? '' : ', client_id = ?';
  await pool.query(`
    UPDATE domains SET name = ?, zone_id = ?, cf_account_id = ?, cf_status = ?, cf_type = ?, plan = ?, assigned_ns = ?, last_checked = NOW() ${clientSql}
    WHERE id = ?
  `, [fields.name, fields.zone_id, fields.cf_account_id, fields.cf_status, fields.cf_type, fields.plan, fields.assigned_ns,
    ...(existing.client_manual ? [] : [account.client_id || null]), existing.id]);
  return { events, isNew: false };
}

async function markDeleted(domain, account, user) {
  const who = await api.zoneDeletion(account.account_id, domain.name);
  await pool.query('UPDATE domains SET deleted_at = COALESCE(?, NOW()), deleted_by = ? WHERE id = ? AND deleted_at IS NULL', [who && who.at ? who.at : null, who ? who.by : null, domain.id]);
  const [[row]] = await pool.query('SELECT deleted_at FROM domains WHERE id = ?', [domain.id]);
  return addEvent(pool, {
    domain, type: 'deleted', key: `deleted:${domain.id}:${row && row.deleted_at ? new Date(row.deleted_at).toISOString() : ''}`,
    details: { by: who ? who.by : null, at: row ? row.deleted_at : null, account: account.name, text: `removed from Cloudflare${who ? ` by ${who.by}` : ''}` },
  }, user);
}

async function syncZones(account, user) {
  const zones = await api.listZones(account.account_id);
  let events = 0;
  let added = 0;
  for (const z of zones) {
    const r = await saveZone(z, account, user);
    events += r.events;
    if (r.isNew) added += 1;
  }
  return { zones, events, added };
}

// Zones gone from an account we could list: deleted (the record is kept). Run after every
// account was read, so a zone that moved to another account we can see is not "deleted".
async function detectDeleted(account, allZoneIds, user) {
  const [mine] = await pool.query('SELECT * FROM domains WHERE cf_account_id = ? AND deleted_at IS NULL AND zone_id IS NOT NULL', [account.id]);
  let events = 0;
  for (const d of mine) {
    if (!allZoneIds.has(d.zone_id) && await markDeleted(d, account, user)) events += 1;
  }
  return events;
}

// ---- Nameservers ----
async function checkNameservers(d, user) {
  if (d.deleted_at || ['partial', 'secondary'].includes(d.cf_type)) return 0;
  const assigned = parseList(d.assigned_ns);
  if (!assigned.length) return 0;
  const r = await publicNameservers(d.name);
  if (!r.ok) {
    await pool.query('UPDATE domains SET ns_checked_at = NOW() WHERE id = ?', [d.id]);
    return 0;
  }
  const ok = sameNs(r.ns, assigned) ? 1 : 0;
  const before = parseList(d.current_ns);
  await pool.query('UPDATE domains SET current_ns = ?, nameservers_ok = ?, ns_checked_at = NOW(), last_checked = NOW() WHERE id = ?', [json(r.ns), ok, d.id]);
  if (d.cf_status === 'pending') return 0; // not switched to Cloudflare yet: expected
  if (!ok && d.nameservers_ok !== 0) {
    const text = r.ns.length ? `now ${providersLabel(r.ns)} (${r.ns.join(', ')})` : 'no nameservers found (the domain does not resolve)';
    return (await addEvent(pool, { domain: d, type: 'ns_changed', details: { old: before.length ? before : assigned, new: r.ns, assigned, text } }, user)) ? 1 : 0;
  }
  if (ok && d.nameservers_ok === 0) {
    return (await addEvent(pool, { domain: d, type: 'back_to_cloudflare', details: { old: before, new: r.ns, text: 'back on Cloudflare\'s nameservers' } }, user)) ? 1 : 0;
  }
  return 0;
}

// ---- Expiry (RDAP) ----
async function checkExpiry(d, user, { force = false } = {}) {
  if (d.deleted_at) return 0;
  const todayStart = londonDayStart(londonDate());
  if (!force && d.rdap_checked_at && new Date(d.rdap_checked_at) >= todayStart) return expiryEvents(d, user);
  const r = await rdapLookup(d.name);
  if (r.ok) {
    await pool.query('UPDATE domains SET expires_on = ?, registrar = ?, rdap_checked_at = NOW(), rdap_note = NULL WHERE id = ?', [r.expiresOn, r.registrar, d.id]);
    d.expires_on = r.expiresOn;
  } else if (r.noRdap) {
    // No RDAP for this TLD: skipped until tomorrow.
    await pool.query('UPDATE domains SET rdap_checked_at = NOW(), rdap_note = ? WHERE id = ?', [r.note.slice(0, 255), d.id]);
  } else {
    // A time-out or rate limit: noted, and tried again at the next check.
    await pool.query('UPDATE domains SET rdap_note = ? WHERE id = ?', [r.note.slice(0, 255), d.id]);
  }
  return expiryEvents(d, user);
}

async function expiryEvents(d, user) {
  if (!d.expires_on) return 0;
  const day = String(d.expires_on instanceof Date ? d.expires_on.toISOString() : d.expires_on).slice(0, 10);
  const days = daysUntil(day);
  if (days === null || days > 30) return 0;
  if (days < 0) {
    return (await addEvent(pool, { domain: d, type: 'expired', key: `expired:${d.id}:${day}`, details: { expires_on: day, text: `expired on ${day}` } }, user)) ? 1 : 0;
  }
  const threshold = [7, 14, 30].find((t) => days <= t);
  return (await addEvent(pool, {
    domain: d, type: 'expiring', key: `expiring:${d.id}:${threshold}:${day}`, details: { expires_on: day, days, threshold, text: `expires in ${days} day${days === 1 ? '' : 's'} (${day})` },
  }, user)) ? 1 : 0;
}

// Runs fn over items, a few at a time (DNS / RDAP lookups).
async function eachLimited(items, limit, fn) {
  let i = 0;
  let total = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i];
      i += 1;
      try {
        total += (await fn(item)) || 0;
      } catch (err) {
        console.error(`Cloudflare check of ${item.name} failed:`, err.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return total;
}

async function startLog(trigger, user) {
  const [r] = await pool.query('INSERT INTO cf_check_log (trigger_type, user_id) VALUES (?, ?)', [trigger, user ? user.id : null]);
  return r.insertId;
}
const finishLog = (id, status, fields = {}) => pool.query(
  'UPDATE cf_check_log SET finished_at = NOW(), status = ?, accounts = ?, domains = ?, events = ?, error = ? WHERE id = ?',
  [status, fields.accounts ?? null, fields.domains ?? null, fields.events ?? null, fields.error ? String(fields.error).slice(0, 2000) : null, id]
);

// Everything. Returns { ok, accounts, domains, events, alerts } or { ok: false, error }.
async function runChecks(user = null, { trigger = 'schedule' } = {}) {
  const cfg = api.cfConfig();
  if (!cfg.configured) return { ok: false, error: cfg.message, notConfigured: true };
  if (running) return { ok: false, error: 'A Cloudflare check is already running. Try again in a minute.' };
  running = true;
  const logId = await startLog(trigger === 'manual' ? 'manual' : 'schedule', user);
  try {
    const { accounts, events: accountEvents } = await syncAccounts(user);
    let events = accountEvents;
    const problems = [];
    const listed = []; // accounts whose zones were read in full
    const allZoneIds = new Set();
    for (const account of accounts) {
      try {
        const r = await syncZones(account, user);
        events += r.events;
        r.zones.forEach((z) => allZoneIds.add(z.id));
        listed.push(account);
      } catch (err) {
        // One account failing (permissions) must not stop the others; its zones are not
        // marked deleted because we could not list them.
        if (err.message === api.REJECTED) throw err;
        problems.push(`${account.name}: ${err.message}`);
      }
    }
    for (const account of listed) events += await detectDeleted(account, allZoneIds, user);
    const [domains] = await pool.query('SELECT * FROM domains WHERE deleted_at IS NULL');
    events += await eachLimited(domains, 5, (d) => checkNameservers(d, user));
    const [fresh] = await pool.query('SELECT * FROM domains WHERE deleted_at IS NULL');
    events += await eachLimited(fresh, 2, (d) => checkExpiry(d, user));
    const alerts = await sendEventAlerts();
    const summary = { accounts: accounts.length, domains: fresh.length, events };
    await finishLog(logId, 'ok', { ...summary, error: problems.length ? problems.join('; ') : null });
    await log(user, {
      action: 'synced',
      summary: `Cloudflare check (${trigger}): ${accounts.length} account${accounts.length === 1 ? '' : 's'}, ${fresh.length} domain${fresh.length === 1 ? '' : 's'}, ${events} event${events === 1 ? '' : 's'}, ${alerts} alert${alerts === 1 ? '' : 's'}${problems.length ? `; problems: ${problems.join('; ')}` : ''}`,
    });
    return { ok: true, ...summary, alerts, problems };
  } catch (err) {
    await finishLog(logId, 'failed', { error: err.message });
    await log(user, { action: 'synced', summary: `Cloudflare check failed: ${err.message}` });
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

// One domain ("Check now" on its row or page): its zone, nameservers, RDAP (always), alerts.
async function checkDomain(user, id) {
  const cfg = api.cfConfig();
  const [[d]] = await pool.query('SELECT d.*, a.account_id, a.name AS account_name, a.client_id AS account_client, a.access_lost FROM domains d LEFT JOIN cf_accounts a ON a.id = d.cf_account_id WHERE d.id = ?', [id]);
  if (!d) return { ok: false, error: 'That domain no longer exists.' };
  if (!cfg.configured) return { ok: false, error: cfg.message, notConfigured: true };
  const logId = await startLog('domain', user);
  try {
    let events = 0;
    if (d.zone_id && !d.deleted_at && d.account_id && !d.access_lost) {
      const account = { id: d.cf_account_id, account_id: d.account_id, name: d.account_name, client_id: d.account_client };
      try {
        const zone = await api.getZone(d.zone_id);
        events += (await saveZone(zone, account, user)).events;
      } catch (err) {
        if (err.message === api.REJECTED) throw err;
        // The zone is gone while its account is still visible: deleted.
        if (err.status === 404 || (err.codes || []).some((c) => [1001, 1003, 7003].includes(c))) {
          const visible = (await api.listAccounts()).some((a) => a.id === d.account_id);
          if (visible && await markDeleted(d, account, user)) events += 1;
        } else {
          throw err;
        }
      }
    }
    const [[now]] = await pool.query('SELECT * FROM domains WHERE id = ?', [id]);
    events += await checkNameservers(now, user);
    const [[after]] = await pool.query('SELECT * FROM domains WHERE id = ?', [id]);
    events += await checkExpiry(after, user, { force: true });
    const alerts = await sendEventAlerts();
    await finishLog(logId, 'ok', { accounts: null, domains: 1, events });
    await log(user, { id, action: 'synced', clientId: d.client_id, summary: `Cloudflare check of ${d.name}: ${events} event${events === 1 ? '' : 's'}` });
    return { ok: true, events, alerts, name: d.name };
  } catch (err) {
    await finishLog(logId, 'failed', { error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { runChecks, checkDomain };
