// CallSwitch One, READ ONLY: our customer accounts (CS1 dashboard Customers page).
//
// Two ways in, neither stores anyone's CallSwitch dashboard login:
//   official API  GET https://CS1_API_HOST/account/reseller (+ /account/reseller/{uuid} when the
//                 list only has ids), with the API headers from .env. The daily sync (06:30) and
//                 "Sync now". It has no CS1 ID: records are matched to saved customers by uuid.
//   dashboard     https://www.callswitchone.com/service/account/reseller (DASHBOARD_URL): the
//                 list the CS1 dashboard loads, with customer_id (the CS1 ID). The SERVER NEVER
//                 CALLS IT (it needs a dashboard login, HTTP 401 with the API headers): a person
//                 opens it in their own logged-in browser and pastes / uploads the JSON on
//                 Customers -> "Refresh from CallSwitch" (parseDashboard).
// Only the endpoints in ALLOWED can be called (allowedUrl): both are documented as not
// chargeable. There is deliberately no helper for POST / PUT / PATCH / DELETE, and no cookies
// or browser tokens are ever sent.
//
// .env (all four required for the API sync):
//   CS1_API_HOST   the API host, e.g. api.callswitchone.com
//   CS1_RESELLER   sent as X-Auth-Reseller
//   CS1_USER       sent as X-Auth-User
//   CS1_PASSWORD   sent as X-Auth-Password (never logged or shown)
//
// Replies: the records are the array in the body (or under result / data / items / ..., or an
// object keyed by ID: each record then gets that key as _key); paging follows a next link
// (body or Link header) or page / last_page numbers.
const TIMEOUT_MS = 30 * 1000;
const MAX_PAGES = 200;
const MAX_DETAILS = 3000;
const CUSTOMERS_PATH = '/account/reseller';
const DASHBOARD_URL = 'https://www.callswitchone.com/service/account/reseller';
const ENV_KEYS = ['CS1_API_HOST', 'CS1_RESELLER', 'CS1_USER', 'CS1_PASSWORD'];

function cs1ApiConfig() {
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, String(process.env[k] || '').trim()]));
  const missing = ENV_KEYS.filter((k) => !env[k]);
  if (missing.length) return { configured: false, message: `Call Switch One customer sync not configured: add ${missing.join(', ')} to .env and restart the portal.` };
  // "api.callswitchone.com", also accepted with https:// or a trailing slash.
  const host = env.CS1_API_HOST.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return { configured: false, message: 'CS1_API_HOST in .env must be a host name such as api.callswitchone.com.' };
  const origin = `https://${host}`;
  return {
    configured: true, host, origin, url: `${origin}${CUSTOMERS_PATH}`,
    headers: { 'X-Auth-Reseller': env.CS1_RESELLER, 'X-Auth-User': env.CS1_USER, 'X-Auth-Password': env.CS1_PASSWORD },
  };
}

// The only endpoints this client may GET: [origin, path pattern].
const ALLOWED = (cfg) => [
  [cfg.origin, /^\/account\/reseller$/],
  [cfg.origin, /^\/account\/reseller\/[A-Za-z0-9-]{1,64}$/],
];
function allowedUrl(url, cfg) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return ALLOWED(cfg).some(([origin, re]) => u.origin === origin && re.test(u.pathname));
}

function httpError(status, body, url) {
  const detail = String((body && (body.status_message || body.message || body.error_description || body.error || body.title)) || '').slice(0, 200);
  const tail = detail ? ` ${detail}` : '';
  const where = shown(url);
  if (status >= 300 && status < 400) return `CallSwitch One redirected ${where} (HTTP ${status}): it does not accept the API headers there.`;
  if (status === 401) return `CallSwitch One refused the login for ${where} (401). Check CS1_RESELLER, CS1_USER and CS1_PASSWORD in .env.${tail}`;
  if (status === 403) return `The CallSwitch One API user is not allowed to read ${where} (403).${tail}`;
  if (status === 404) return `CallSwitch One returned 404 for ${where}.${tail}`;
  if (status === 429) return 'CallSwitch One is rate limiting requests (429). Try again later.';
  return `CallSwitch One API error ${status} for ${where}${detail ? `: ${detail}` : ''}`;
}

// The URL as logged: host and path only (no credentials are ever in a URL).
function shown(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname}${u.search}`; } catch { return String(url); }
}

// GET one allowed URL. Returns { body, link, status } (link = Link header). Redirects are not
// followed (a redirect to a login page means the headers were not accepted) and no cookies
// are sent.
async function cs1Get(url, cfg = cs1ApiConfig()) {
  if (!cfg.configured) throw new Error(cfg.message);
  if (!allowedUrl(url, cfg)) throw new Error(`Refused a request to ${shown(url)}: not an allowed CallSwitch One endpoint.`);
  const target = new URL(url);
  let res;
  try {
    res = await fetch(target, {
      method: 'GET', headers: { ...cfg.headers, Accept: 'application/json' }, credentials: 'omit', redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = new Error(`Could not reach ${target.host}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    e.endpoint = shown(target);
    throw e;
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw Object.assign(new Error(httpError(res.status, body, target)), { status: res.status, endpoint: shown(target) });
  if (body === null) throw Object.assign(new Error(`CallSwitch One did not return JSON for ${shown(target)}.`), { status: res.status, endpoint: shown(target) });
  return { body, link: res.headers.get('link') || '', status: res.status };
}

const LIST_KEYS = ['result', 'data', 'items', 'results', 'customers', 'resellers', 'records', 'rows', 'content', 'value'];
// One record from a detail reply: { result: { ... } } or the object itself.
const detailOf = (body) => (body && body.result && typeof body.result === 'object' && !Array.isArray(body.result) ? body.result : body);
// { "575445": { ... }, "575446": { ... } } -> records with _key = their key.
const keyed = (obj) => {
  const entries = Object.entries(obj || {});
  if (entries.length < 1 || !entries.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v))) return null;
  return entries.map(([k, v]) => ({ _key: k, ...v }));
};

function recordsOf(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  for (const k of LIST_KEYS) {
    if (Array.isArray(body[k])) return body[k];
    // A list keyed by ID ("result": { "575445": {...} }); a single record has scalar values.
    if (body[k] && typeof body[k] === 'object' && keyed(body[k]) && Object.keys(body[k]).every((key) => /^[\w-]+$/.test(key)) && !('uuid' in body[k])) return keyed(body[k]);
    if (body[k] && typeof body[k] === 'object') {
      const inner = recordsOf(body[k]);
      if (inner) return inner;
    }
  }
  // The whole body keyed by CS1 number ({ "575445": {...} }).
  if (Object.keys(body).length && Object.keys(body).every((key) => /^(CS1[-_]?)?\d+$/i.test(key))) return keyed(body);
  const arrays = Object.values(body).filter((v) => Array.isArray(v) && v.some((x) => x && typeof x === 'object'));
  return arrays.length === 1 ? arrays[0] : null;
}

function nextUrl(body, link, current, cfg) {
  const fromLink = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link || '');
  const candidates = [fromLink && fromLink[1]];
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const links = body.links || body._links || {};
    const meta = body.meta || body.pagination || {};
    candidates.push(body.next, body.next_page_url, body.nextPage, body['@odata.nextLink'], links.next, links.next && links.next.href, meta.next, meta.next_page_url);
  }
  const origin = new URL(current).origin;
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue;
    try {
      const u = new URL(c, current);
      if (u.origin === origin && allowedUrl(u, cfg)) return u.toString();
    } catch { /* not a URL */ }
  }
  // Page numbers: { page / current_page, last_page / total_pages / pages }.
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const meta = body.meta || body.pagination || body;
    const page = Number(meta.current_page ?? meta.page ?? meta.currentPage);
    const last = Number(meta.last_page ?? meta.total_pages ?? meta.totalPages ?? meta.pages ?? meta.lastPage);
    if (Number.isFinite(page) && Number.isFinite(last) && page < last) {
      const u = new URL(current);
      u.searchParams.set(meta.currentPage !== undefined ? 'currentPage' : 'page', String(page + 1));
      return u.toString();
    }
  }
  return null;
}

// Every record of one list endpoint (all pages): { records, endpoint, status, pages, details }.
// details: read /account/reseller/{uuid} for each when the list only has ids (official only).
async function listFrom(startUrl, cfg, { details = false } = {}) {
  const records = [];
  const seen = new Set();
  const info = { endpoint: shown(startUrl), status: null, pages: 0, details: 0 };
  let url = startUrl;
  try {
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      if (seen.has(url)) break;
      seen.add(url);
      const { body, link, status } = await cs1Get(url, cfg);
      if (info.status === null) info.status = status;
      info.pages += 1;
      const list = recordsOf(body);
      if (!list) {
        const keys = body && typeof body === 'object' ? Object.keys(body).slice(0, 20).join(', ') : typeof body;
        throw Object.assign(new Error(`The CallSwitch One reply from ${shown(url)} has no list of customers (top-level fields: ${keys || 'none'}).`), { status });
      }
      records.push(...list.filter((r) => r && typeof r === 'object'));
      if (!list.length) break;
      url = nextUrl(body, link, url, cfg);
    }
    const bare = details && records.length && records.every((r) => r.uuid && Object.keys(r).length <= 3);
    if (!bare) return { records, ...info };
    if (records.length > MAX_DETAILS) throw new Error(`CallSwitch One returned ${records.length} customers: more than the ${MAX_DETAILS} the sync reads one by one.`);
    const out = [];
    for (const r of records) {
      const { body } = await cs1Get(`${cfg.url}/${encodeURIComponent(String(r.uuid))}`, cfg);
      info.details += 1;
      const rec = detailOf(body);
      if (rec && typeof rec === 'object') out.push({ ...r, ...rec });
    }
    return { records: out, ...info, endpoint: `${info.endpoint} (+ ${info.details} × ${CUSTOMERS_PATH}/{uuid})` };
  } catch (err) {
    // What was asked goes with the error, for the sync log.
    err.endpoint = err.endpoint || info.endpoint;
    if (err.status === undefined) err.status = info.status;
    throw err;
  }
}

// The documented API (all pages).
async function listOfficial(cfg = cs1ApiConfig()) {
  if (!cfg.configured) throw new Error(cfg.message);
  return listFrom(cfg.url, cfg, { details: true });
}
// Kept for the check scripts: the documented API.
const listCustomers = () => listOfficial();

// ---- CS1 IDs ----

// The same customer can be written CS1-001234, cs1 1234, CS1_1234 or just 1234 (CDR files,
// the API, typed by hand): numeric IDs become "CS1-" + the number (at least 6 digits, so
// 1234 and CS1-001234 match). Anything else is trimmed and upper-cased.
function normaliseId(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return '';
  const m = /^(?:CS1)?[\s_-]*0*(\d+)$/i.exec(s);
  if (m) return `CS1-${m[1].padStart(6, '0')}`;
  return s.toUpperCase().replace(/\s+/g, ' ').slice(0, 191);
}
const ID_RE = /^CS1[\s_-]*\d+$/i;

// ---- Record -> customer (fixed mapping) ----
//
// Dashboard records (mapDashboard; result[] of the pasted JSON):
//   customer_id                 -> CS1 ID (the key)            uuid -> link to the API record
//   contact_name                -> Company ("name" is a code). A " : CEASED - d/m/yyyy" suffix is
//                                  stripped and gives Status Ceased with that date (ceased_on)
//   is_ceased / is_locked       -> Status Ceased / Locked, otherwise Active
//   first_name + last_name      -> Account Holder              email_address -> Email
//   phone                       -> Phone                       store_name -> Store
//   created_on                  -> Registered                  is_demo -> demo account (hidden)
//   products.voip_user_count    -> Users                       products.voip_number_count -> Numbers
// Official API records (mapOfficial): contact_name -> Company (same suffix rule), phone,
// store_front -> Store only when it is a name (the API gives the storefront's uuid), users -> Users, created_on; status only when the record says it
// (is_ceased / is_locked / the CEASED suffix), otherwise null = keep the saved status.
const STATUS_LABELS = {}; // status_id names, if ever needed (the dashboard has is_ceased / is_locked)

// Value at "a.b.c", or undefined.
function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// One level of nesting flattened: { products: { voip_user_count } } -> "products.voip_user_count".
function flatten(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    out[k] = v;
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2;
  }
  return out;
}

// Field names in the reply (one level deep), never values.
function fieldNames(records) {
  const names = new Set();
  for (const r of records.slice(0, 200)) for (const k of Object.keys(flatten(r))) names.add(k);
  return [...names].sort();
}

// Every path (keys included, any depth) whose key or value contains needle:
// [{ path, where: 'value' | 'key', value }]. Used by npm run cs1-find.
function deepFind(obj, needle, base = '', out = [], depth = 0) {
  const n = String(needle);
  if (depth > 12 || obj === null || obj === undefined) return out;
  if (typeof obj !== 'object') {
    if (String(obj).includes(n)) out.push({ path: base || '(value)', where: 'value', value: obj });
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const path = base ? `${base}${Array.isArray(obj) ? `[${k}]` : `.${k}`}` : (Array.isArray(obj) ? `[${k}]` : k);
    if (!Array.isArray(obj) && k.includes(n)) out.push({ path, where: 'key', value: k });
    deepFind(v, n, path, out, depth + 1);
  }
  return out;
}

const scalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const text = (v, max) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const count = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return count(v.count ?? v.total ?? null);
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 1e6) : null;
};
const first = (rec, paths, accept = () => true) => {
  for (const p of paths) {
    const v = getPath(rec, p);
    if (v !== undefined && v !== null && v !== '' && accept(v)) return v;
  }
  return null;
};
const isTrue = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v === undefined || v === null ? '' : v).trim());

// "2025-04-29T10:00:00Z", "2025-04-29 10:00:00", "29/04/2025", unix seconds / ms -> "2025-04-29".
function dateOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// "Felix Legal : CEASED - 3/2/2025" -> { company: 'Felix Legal', ceasedOn: '2025-02-03' }.
function companyOf(value) {
  const raw = text(value, 300);
  const m = /\s*:\s*CEASED\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/i.exec(raw);
  if (!m) return { company: raw.slice(0, 200), ceasedOn: null };
  return { company: raw.slice(0, m.index).trim().slice(0, 200), ceasedOn: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` };
}

// Ceased / Locked / Active from is_ceased / is_locked (and the CEASED suffix); null when the
// record does not say.
function statusOf(rec, ceasedOn) {
  if (isTrue(rec.is_ceased) || ceasedOn) return 'Ceased';
  if (isTrue(rec.is_locked)) return 'Locked';
  if ('is_ceased' in rec || 'is_locked' in rec) return 'Active';
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const holderOf = (rec) => [first(rec, ['first_name'], scalar), first(rec, ['last_name'], scalar)].filter(Boolean).join(' ');

// A dashboard record (result[] of the pasted JSON) -> customer; identifier '' without customer_id.
function mapDashboard(rec) {
  const rawId = first(rec, ['customer_id'], (v) => typeof v === 'string' || typeof v === 'number');
  const { company, ceasedOn } = companyOf(first(rec, ['contact_name'], scalar));
  return {
    identifier: rawId === null ? '' : normaliseId(rawId),
    rawId: text(rawId, 191),
    uuid: text(first(rec, ['uuid'], scalar), 64),
    accountId: text(first(rec, ['account_id'], scalar), 64),
    company,
    ceasedOn,
    holder: text(holderOf(rec), 200),
    email: text(first(rec, ['email_address', 'email'], scalar), 255),
    phone: text(first(rec, ['phone', 'phone_number'], scalar), 40),
    store: text(first(rec, ['store_name'], scalar), 200),
    status: statusOf(rec, ceasedOn) || 'Active',
    registered: dateOf(first(rec, ['created_on'], scalar)),
    users: count(first(rec, ['products.voip_user_count'])),
    numbers: count(first(rec, ['products.voip_number_count'])),
    demo: isTrue(rec.is_demo),
  };
}

// An official API record -> what it can tell (null / '' = unknown, keep the saved value).
function mapOfficial(rec) {
  const { company, ceasedOn } = companyOf(first(rec, ['contact_name'], scalar));
  const storefront = getPath(rec, 'store_front');
  return {
    identifier: '',
    rawId: '',
    uuid: text(first(rec, ['uuid'], scalar), 64),
    company,
    ceasedOn,
    holder: text(holderOf(rec), 200),
    email: text(first(rec, ['email_address', 'email'], scalar), 255),
    phone: text(first(rec, ['phone'], scalar), 40),
    // store_front is the storefront's uuid in the API, not its name: only a real name is used.
    store: text([typeof storefront === 'string' ? storefront : null, first(rec, ['store_front.name', 'store_name'], scalar)]
      .find((v) => v && !UUID_RE.test(String(v).trim())) || '', 200),
    status: statusOf(rec, ceasedOn),
    registered: dateOf(first(rec, ['created_on'], scalar)),
    users: count(first(rec, ['users', 'products.voip_user_count'])),
    numbers: count(first(rec, ['products.voip_number_count'])),
    demo: 'is_demo' in rec ? isTrue(rec.is_demo) : null,
  };
}

// Either shape (check scripts): dashboard when the record has customer_id.
const mapCustomer = (rec) => (rec && rec.customer_id !== undefined ? mapDashboard(rec) : mapOfficial(rec));

// The text copied from (or saved off) the dashboard list in the browser -> { records } or
// { error }. Ctrl+A in a browser JSON viewer can add text around the JSON, so the first "{"
// to the last "}" is read. Only status_code + result[] is accepted.
const NOT_LOGGED_IN = "That isn't the CallSwitch customer list. Looks like you weren't logged in to CallSwitch: log in at callswitchone.com, open the link again and copy the whole page.";
function parseDashboard(input) {
  const s = String(input || '').replace(/^﻿/, '').trim();
  if (!s) return { error: 'Paste the page from the new tab, or choose the saved file.' };
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: /<html|<!doctype|log ?in|sign ?in/i.test(s) ? NOT_LOGGED_IN : "That isn't valid JSON. Copy the whole page in the new tab (Ctrl+A, then Ctrl+C) and paste it again." };
  let body;
  try { body = JSON.parse(s.slice(start, end + 1)); } catch {
    return { error: "That isn't valid JSON. Copy the whole page in the new tab (Ctrl+A, then Ctrl+C) and paste it again, or save it with Ctrl+S and upload the file." };
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.result)) {
    const code = body && body.status_code;
    return { error: code && Number(code) !== 200 ? `CallSwitch answered ${code}${body.status_message ? ` (${body.status_message})` : ''}. ${NOT_LOGGED_IN}` : NOT_LOGGED_IN };
  }
  if (body.status_code !== undefined && Number(body.status_code) !== 200) return { error: `CallSwitch answered ${body.status_code}${body.status_message ? ` (${body.status_message})` : ''}. ${NOT_LOGGED_IN}` };
  const records = body.result.filter((r) => r && typeof r === 'object');
  if (!records.length) return { error: 'The customer list is empty.' };
  if (!records.some((r) => r.customer_id)) return { error: 'This list has no customer_id. Open the link from the Refresh panel (the dashboard list), not the API.' };
  return { records };
}

module.exports = {
  cs1ApiConfig, cs1Get, allowedUrl, listOfficial, listCustomers, fieldNames, mapCustomer, mapDashboard, mapOfficial, companyOf,
  parseDashboard, recordsOf, dateOf, normaliseId, deepFind, getPath, ID_RE, STATUS_LABELS, CUSTOMERS_PATH, DASHBOARD_URL, ENV_KEYS,
};
