// CallSwitch One API, READ ONLY: our customer accounts (dashboard Customers page). In the CS1
// API docs (callswitchone.com/api-docs, Customer Management) these are the Sub Resellers:
// GET /account/reseller lists them ({ result: [...], status_code, status_message }) and
// GET /account/reseller/{uuid} gives one. The public docs only show uuid in the examples,
// so every sync logs the endpoint, HTTP status, record count, field names (never values)
// and sample IDs (Customers page, "Details of the last sync").
// Only GET requests are ever made, and only to https://CS1_API_HOST: there is deliberately
// no helper for POST / PUT / PATCH / DELETE.
//
// .env (all four required):
//   CS1_API_HOST   the API host, e.g. api.callswitchone.com
//   CS1_RESELLER   sent as X-Auth-Reseller
//   CS1_USER       sent as X-Auth-User
//   CS1_PASSWORD   sent as X-Auth-Password (never logged or shown)
//   CS1_API_FIELDS optional, when the automatic matching picks the wrong field:
//                  "id=account_code,company=company_name,store=storefront.name" (keys: id,
//                  company, holder, store, email, status, registered, users, numbers).
//
// The response shape is not assumed: the records are the array in the body (or under
// result / data / items / ...), paging follows a next link (body or Link header) or page /
// last_page numbers, and fields are matched by name (mapCustomer).
const TIMEOUT_MS = 30 * 1000;
const MAX_PAGES = 200;
const MAX_DETAILS = 3000;
const CUSTOMERS_PATH = '/account/reseller';
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

function httpError(status, body) {
  const detail = String((body && (body.status_message || body.message || body.error_description || body.error || body.title)) || '').slice(0, 200);
  const tail = detail ? ` ${detail}` : '';
  if (status === 401) return `CallSwitch One refused the login (401). Check CS1_RESELLER, CS1_USER and CS1_PASSWORD in .env.${tail}`;
  if (status === 403) return `The CallSwitch One API user is not allowed to read customers (403).${tail}`;
  if (status === 404) return `CallSwitch One returned 404 for ${CUSTOMERS_PATH}: check CS1_API_HOST in .env.${tail}`;
  if (status === 429) return 'CallSwitch One is rate limiting requests (429). Try again later.';
  return `CallSwitch One API error ${status}${detail ? `: ${detail}` : ''}`;
}

// The URL as logged: host and path only (no credentials are ever in a URL).
const shown = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}${u.search}`; } catch { return String(url); } };

// GET one URL on the CS1 API host. Returns { body, link, status } (link = Link header).
async function cs1Get(url, cfg = cs1ApiConfig()) {
  if (!cfg.configured) throw new Error(cfg.message);
  let target;
  try { target = new URL(url); } catch { throw new Error('Refused an invalid CallSwitch One URL.'); }
  if (target.origin !== cfg.origin) throw new Error('Refused a request outside the CallSwitch One API host.');
  let res;
  try {
    res = await fetch(target, { method: 'GET', headers: { ...cfg.headers, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const e = new Error(`Could not reach the CallSwitch One API at ${cfg.host}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    e.endpoint = shown(target);
    throw e;
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const e = new Error(httpError(res.status, body));
    Object.assign(e, { status: res.status, endpoint: shown(target) });
    throw e;
  }
  if (body === null) {
    const e = new Error(`The CallSwitch One API did not return JSON for ${shown(target)}.`);
    Object.assign(e, { status: res.status, endpoint: shown(target) });
    throw e;
  }
  return { body, link: res.headers.get('link') || '', status: res.status };
}

const LIST_KEYS = ['result', 'data', 'items', 'results', 'customers', 'resellers', 'records', 'rows', 'content', 'value'];
// One record from a detail reply: { result: { ... } } or the object itself.
const detailOf = (body) => (body && body.result && typeof body.result === 'object' && !Array.isArray(body.result) ? body.result : body);
function recordsOf(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  for (const k of LIST_KEYS) {
    if (Array.isArray(body[k])) return body[k];
    if (body[k] && typeof body[k] === 'object') {
      const inner = recordsOf(body[k]);
      if (inner) return inner;
    }
  }
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
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue;
    try {
      const u = new URL(c, current);
      if (u.origin === cfg.origin) return u.toString();
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

// Every customer record (all pages, details per uuid when the list only has ids), with what
// was asked: { records, endpoint, status, pages, details }.
async function listCustomers() {
  const cfg = cs1ApiConfig();
  if (!cfg.configured) throw new Error(cfg.message);
  const records = [];
  const seen = new Set();
  const info = { endpoint: shown(cfg.url), status: null, pages: 0, details: 0 };
  let url = cfg.url;
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
    // A list of bare ids ({ uuid } only, as in the docs' example): read each one's details.
    const bare = records.length && records.every((r) => r.uuid && !mapCustomer(r).company && Object.keys(r).length <= 3);
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

// ---- Mapping by field name ----

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

// One level of nesting flattened: { store: { name } } -> "store.name".
function flatten(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2;
      out[k] = v;
    } else out[k] = v;
  }
  return out;
}

// Field names in the reply (one level deep), never values.
function fieldNames(records) {
  const names = new Set();
  for (const r of records.slice(0, 200)) for (const k of Object.keys(flatten(r))) names.add(k);
  return [...names].sort();
}

const FIELDS = {
  id: ['cs1id', 'cs1number', 'customerid', 'customernumber', 'accountid', 'accountnumber', 'accountno', 'accountcode', 'resellerid', 'resellernumber', 'accountref', 'accountreference', 'customerreference', 'customeridentifier', 'identifier', 'reference', 'ref', 'code', 'id'],
  company: ['company', 'companyname', 'customername', 'businessname', 'organisation', 'organization', 'organisationname', 'organizationname', 'accountname', 'name'],
  holder: ['accountholder', 'accountholdername', 'holder', 'holdername', 'contactname', 'primarycontact', 'primarycontactname', 'ownername', 'owner', 'fullname'],
  store: ['store', 'storename', 'storefront', 'storefrontname', 'storefronttitle', 'storefront.name', 'store.name', 'reseller', 'resellername'],
  email: ['email', 'emailaddress', 'accountemail', 'contactemail', 'primaryemail', 'accountholderemail'],
  status: ['status', 'accountstatus', 'customerstatus', 'state'],
  registered: ['registered', 'registeredat', 'registereddate', 'registeredon', 'registrationdate', 'datecreated', 'createddate', 'createdat', 'created', 'signupdate', 'startdate'],
  users: ['users', 'userscount', 'usercount', 'numberofusers', 'totalusers', 'usertotal', 'seats', 'extensions', 'sipaccounts'],
  numbers: ['numbers', 'numberscount', 'numbercount', 'numberofnumbers', 'phonenumbers', 'phonenumberscount', 'numberofphonenumbers', 'totalnumbers', 'dids', 'ddis', 'didcount'],
};

// CS1_API_FIELDS: "key=field,key=field" chosen by hand, tried before the automatic names.
function overrides() {
  const out = {};
  for (const part of String(process.env.CS1_API_FIELDS || '').split(',')) {
    const [k, v] = part.split('=').map((x) => (x || '').trim());
    if (k && v && FIELDS[k]) out[k] = v;
  }
  return out;
}
const fieldsFor = (key) => {
  const o = overrides()[key];
  return o ? [o, ...FIELDS[key]] : FIELDS[key];
};

function pick(flat, candidates, accept = () => true) {
  const byNorm = new Map();
  for (const [k, v] of Object.entries(flat)) if (!byNorm.has(norm(k))) byNorm.set(norm(k), v);
  for (const c of candidates) {
    const v = byNorm.get(norm(c));
    if (v !== undefined && v !== null && v !== '' && accept(v)) return v;
  }
  return null;
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

// "2025-04-29T10:00:00Z", "2025-04-29", "29/04/2025", unix seconds / ms -> "2025-04-29".
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

function statusOf(flat) {
  const s = pick(flat, fieldsFor('status'), scalar);
  if (typeof s === 'boolean') return s ? 'Active' : 'Inactive';
  if (s !== null) {
    const t = text(s, 40);
    // "ACTIVE" / "active" / "on_hold" -> "Active" / "On hold".
    const words = t.replace(/[_-]+/g, ' ').toLowerCase();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
  }
  const active = pick(flat, ['active', 'isactive', 'enabled', 'isenabled']);
  if (active !== null) return active === true || active === 1 || /^(1|true|yes)$/i.test(String(active)) ? 'Active' : 'Inactive';
  const suspended = pick(flat, ['suspended', 'issuspended']);
  if (suspended === true || suspended === 1) return 'Suspended';
  return '';
}

// One API record -> { identifier, company, holder, store, email, status, registered, users, numbers }.
// The CS1 ID is any field whose value looks like CS1-123456 first, else an id-like field.
function mapCustomer(rec) {
  const flat = flatten(rec);
  const forced = overrides();
  let id = forced.id ? pick(flat, [forced.id], scalar) : null;
  if (!id) id = Object.values(flat).find((v) => typeof v === 'string' && ID_RE.test(v.trim()));
  if (!id) id = pick(flat, FIELDS.id.filter((k) => k !== 'id'), (v) => typeof v === 'string' || typeof v === 'number');
  // Last: a numeric id (the dashboard shows it as CS1-xxxxxx), never the uuid.
  if (!id && /^\d+$/.test(String(flat.id ?? ''))) id = flat.id;
  let holder = pick(flat, fieldsFor('holder'), scalar);
  if (holder === null) {
    const first = pick(flat, ['firstname', 'forename', 'contactfirstname'], scalar);
    const last = pick(flat, ['lastname', 'surname', 'contactlastname'], scalar);
    holder = [first, last].filter(Boolean).join(' ') || null;
  }
  const storeValue = pick(flat, fieldsFor('store'));
  const store = storeValue && typeof storeValue === 'object' ? (storeValue.name || storeValue.title || '') : storeValue;
  return {
    identifier: normaliseId(id),
    rawId: text(id, 191),
    company: text(pick(flat, fieldsFor('company'), scalar), 200),
    holder: text(holder, 200),
    store: text(store, 200),
    email: text(pick(flat, fieldsFor('email'), scalar), 255),
    status: statusOf(flat),
    registered: dateOf(pick(flat, fieldsFor('registered'), scalar)),
    users: count(pick(flat, fieldsFor('users'))),
    numbers: count(pick(flat, fieldsFor('numbers'))),
  };
}

module.exports = {
  cs1ApiConfig, cs1Get, listCustomers, fieldNames, mapCustomer, recordsOf, dateOf, normaliseId, ID_RE, CUSTOMERS_PATH, ENV_KEYS,
};
