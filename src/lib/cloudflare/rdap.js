// Domain expiry dates and registrars from RDAP (lookups.js rdapLookup: the registry's server
// from the IANA bootstrap file), run as a background queue so hundreds of domains are never
// looked up at once:
//   - at most one lookup a second (THROTTLE_MS), one at a time; a 429 from a registry waits
//     (Retry-After, at most 5 minutes) and tries that domain once more;
//   - each domain is refreshed once a (UK) day: a domain is due when it was never looked up or
//     its last good lookup was before today; a TLD without RDAP (or a domain the registry does
//     not know) is also skipped for the rest of the day; other failures are noted (rdap_note,
//     shown as the "Unknown" tooltip, and logged) and tried again at the next run;
//   - runs straight after the portal starts (so a deploy fills every domain in), after each
//     6-hourly Cloudflare check, every hour (index.js), and on "Check now" for one domain;
//   - progress (rdapProgress) is shown on the Domains page.
// Expiring (30 / 14 / 7 days) and expired events, then their alerts, follow each lookup.
const { pool } = require('../../db');
const { londonDate, londonDayStart } = require('../activity');
const { rdapLookup } = require('./lookups');
const { daysUntil } = require('./data');
const { addEvent, log } = require('./events');
const { sendEventAlerts } = require('./alerts');

const THROTTLE_MS = 1100;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const state = { running: false, total: 0, done: 0, found: 0, failed: 0, current: null, startedAt: null, finishedAt: null };

// Saves one lookup. Returns the number of new events.
async function saveLookup(d, r, user = null) {
  if (r.ok) {
    await pool.query('UPDATE domains SET expires_on = ?, registrar = ?, rdap_checked_at = NOW(), rdap_note = ? WHERE id = ?', [r.expiresOn, r.registrar, r.note || null, d.id]);
    d.expires_on = r.expiresOn;
  } else if (r.noRdap) {
    await pool.query('UPDATE domains SET rdap_checked_at = NOW(), rdap_note = ? WHERE id = ?', [String(r.note).slice(0, 255), d.id]);
  } else {
    await pool.query('UPDATE domains SET rdap_note = ? WHERE id = ?', [String(r.note).slice(0, 255), d.id]);
    console.error(`RDAP lookup for ${d.name} failed: ${r.note}`);
  }
  return expiryEvents(d, user);
}

async function expiryEvents(d, user) {
  if (!d.expires_on || d.deleted_at) return 0;
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

async function lookupWithRetry(name) {
  let r = await rdapLookup(name);
  if (r.rateLimited) {
    await sleep(r.retryAfter * 1000);
    r = await rdapLookup(name);
  }
  return r;
}

// One domain now (Check now on a domain), whether it is due or not.
async function lookupDomain(d, user = null) {
  if (d.deleted_at) return 0;
  return saveLookup(d, await lookupWithRetry(d.name), user);
}

async function dueDomains() {
  const [rows] = await pool.query(`
    SELECT * FROM domains
    WHERE deleted_at IS NULL AND (rdap_checked_at IS NULL OR rdap_checked_at < ?)
    ORDER BY rdap_checked_at IS NOT NULL, rdap_checked_at, id
  `, [londonDayStart(londonDate())]);
  return rows;
}

// The whole queue (does nothing while it is already running). Not awaited by callers.
async function runRdapQueue() {
  if (state.running) return state;
  Object.assign(state, { running: true, total: 0, done: 0, found: 0, failed: 0, current: null, startedAt: new Date(), finishedAt: null });
  let events = 0;
  try {
    const due = await dueDomains();
    state.total = due.length;
    for (const d of due) {
      state.current = d.name;
      try {
        const r = await lookupWithRetry(d.name);
        if (r.ok && r.expiresOn) state.found += 1;
        if (!r.ok && !r.noRdap) state.failed += 1;
        events += await saveLookup(d, r);
      } catch (err) {
        state.failed += 1;
        console.error(`RDAP lookup for ${d.name} failed:`, err.message);
      }
      state.done += 1;
      if (state.done % 25 === 0) await sendEventAlerts();
      await sleep(THROTTLE_MS);
    }
    await sendEventAlerts();
    if (state.total) {
      await log(null, {
        action: 'synced',
        summary: `Cloudflare: looked up expiry dates for ${state.total} domain${state.total === 1 ? '' : 's'} (${state.found} found, ${state.failed} failed, ${events} event${events === 1 ? '' : 's'})`,
      });
    }
  } catch (err) {
    console.error('RDAP queue failed:', err.message);
  } finally {
    state.running = false;
    state.current = null;
    state.finishedAt = new Date();
  }
  return state;
}

// For the Domains page: the queue, and how many domains still have no known expiry.
async function rdapProgress() {
  const [[row]] = await pool.query(`
    SELECT SUM(expires_on IS NULL) AS unknown, SUM(rdap_checked_at IS NULL) AS never, COUNT(*) AS total
    FROM domains WHERE deleted_at IS NULL
  `);
  return {
    running: state.running, total: state.total, done: state.done, found: state.found, failed: state.failed, current: state.current,
    finishedAt: state.finishedAt, unknown: Number(row.unknown || 0), never: Number(row.never || 0), domains: Number(row.total || 0),
  };
}

module.exports = { runRdapQueue, rdapProgress, lookupDomain, expiryEvents };
