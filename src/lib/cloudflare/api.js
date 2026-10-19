// Cloudflare API v4, READ ONLY. CLOUDFLARE_API_TOKEN from .env (Authorization: Bearer).
// Only GET requests to api.cloudflare.com are ever made: there is deliberately no helper for
// POST / PUT / PATCH / DELETE. A 429 (rate limited) waits for Retry-After (or 30s) and tries
// again, up to 5 times; requests go one at a time.
//
// The token needs (Cloudflare dashboard > My Profile > API Tokens > Custom token), for all
// accounts: Account Settings: Read, Zone: Read; optional: Account: Access: Audit Logs: Read
// (to show who deleted a zone).
const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 30 * 1000;
const MAX_TRIES = 5;
const PER_PAGE = 50;

function cfConfig() {
  const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!token) return { configured: false, message: 'Cloudflare not configured: add CLOUDFLARE_API_TOKEN to .env and restart the portal.' };
  return { configured: true, token };
}

class CfError extends Error {
  constructor(message, { status = 0, codes = [] } = {}) {
    super(message);
    this.status = status;
    this.codes = codes;
  }
}

const REJECTED = 'Token rejected: check CLOUDFLARE_API_TOKEN in .env (it may be wrong, expired or missing permissions).';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// One GET. path starts with "/", params is an object of query parameters.
async function cfGet(path, params = {}) {
  const cfg = cfConfig();
  if (!cfg.configured) throw new CfError(cfg.message);
  const url = new URL(`${API}${path}`);
  if (url.origin !== 'https://api.cloudflare.com' || !url.pathname.startsWith('/client/v4/')) throw new CfError('Blocked: only GET requests to api.cloudflare.com are allowed.');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new CfError(`Could not reach Cloudflare: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
    if (res.status === 429 && attempt < MAX_TRIES) {
      const wait = Math.min(120, Number(res.headers.get('retry-after')) || 30);
      await sleep(wait * 1000);
      continue;
    }
    const body = await res.json().catch(() => null);
    const errors = (body && Array.isArray(body.errors)) ? body.errors : [];
    const codes = errors.map((e) => Number(e.code)).filter(Boolean);
    if (res.ok && body && body.success !== false) return body;
    // 1000 / 6003 / 6111 / 9106 / 9109 / 10000: bad, expired or unauthorised token.
    if (res.status === 401 || res.status === 403 || codes.some((c) => [1000, 6003, 6111, 9106, 9109, 10000].includes(c))) {
      throw new CfError(REJECTED, { status: res.status, codes });
    }
    if (res.status === 429) throw new CfError('Cloudflare is rate limiting the portal. The next check will try again.', { status: 429 });
    const text = errors.map((e) => e.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
    throw new CfError(`Cloudflare error: ${text.slice(0, 300)}`, { status: res.status, codes });
  }
}

// Every page of a list endpoint.
async function cfList(path, params = {}) {
  const out = [];
  for (let page = 1; page <= 200; page += 1) {
    const body = await cfGet(path, { ...params, page, per_page: PER_PAGE });
    const items = Array.isArray(body.result) ? body.result : [];
    out.push(...items);
    const info = body.result_info || {};
    const pages = Number(info.total_pages) || (items.length < PER_PAGE ? page : page + 1);
    if (page >= pages || !items.length) break;
  }
  return out;
}

// Checks the token itself (user tokens): { ok, message }.
async function verifyToken() {
  try {
    const body = await cfGet('/user/tokens/verify');
    const status = body.result && body.result.status;
    return status === 'active' ? { ok: true } : { ok: false, message: REJECTED };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

const listAccounts = () => cfList('/accounts');
const listZones = (accountId) => cfList('/zones', { 'account.id': accountId });
const getZone = async (zoneId) => (await cfGet(`/zones/${encodeURIComponent(zoneId)}`)).result;

// Who deleted a zone, from the account's audit log (needs Audit Logs: Read; null when the
// token cannot read it or nothing is found). { at, by } with by = the user's email or "Cloudflare".
async function zoneDeletion(accountId, zoneName) {
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const body = await cfGet(`/accounts/${encodeURIComponent(accountId)}/audit_logs`, {
      'zone.name': zoneName, 'action.type': 'delete', direction: 'desc', per_page: 5, since,
    });
    const hit = (body.result || []).find((r) => r && r.action && String(r.action.type).toLowerCase() === 'delete'
      && (!r.resource || /zone/i.test(String(r.resource.type || 'zone'))));
    if (!hit) return null;
    const actor = hit.actor || {};
    const by = actor.email || (/user/i.test(String(actor.type || '')) ? 'A user' : 'Cloudflare');
    const at = hit.when ? new Date(hit.when) : null;
    return { at: at && !Number.isNaN(at.getTime()) ? at : null, by: String(by).slice(0, 255) };
  } catch (err) {
    return null;
  }
}

module.exports = {
  cfConfig, cfGet, cfList, verifyToken, listAccounts, listZones, getZone, zoneDeletion, CfError, REJECTED,
};
