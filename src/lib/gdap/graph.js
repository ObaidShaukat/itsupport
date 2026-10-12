// Microsoft Graph, READ ONLY, for GDAP (granular delegated admin) relationships.
// App-only (client credentials): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET from .env,
// scope https://graph.microsoft.com/.default. The app needs the application permission
// DelegatedAdminRelationship.Read.All with admin consent.
// Only GET requests to graph.microsoft.com are ever made: there is deliberately no
// helper for POST / PATCH / DELETE on Graph.
const GRAPH = 'https://graph.microsoft.com';
const RELATIONSHIPS_URL = `${GRAPH}/v1.0/tenantRelationships/delegatedAdminRelationships`;
const TIMEOUT_MS = 30 * 1000;

let cached = null; // { token, expiresAt }

function gdapConfig() {
  const tenant = (process.env.MS_TENANT_ID || '').trim();
  const clientId = (process.env.MS_CLIENT_ID || '').trim();
  const secret = (process.env.MS_CLIENT_SECRET || '').trim();
  const missing = [['MS_TENANT_ID', tenant], ['MS_CLIENT_ID', clientId], ['MS_CLIENT_SECRET', secret]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { configured: false, message: `GDAP not configured: add ${missing.join(', ')} to .env and restart the portal.` };
  return { configured: true, tenant, clientId, secret };
}

// A readable message for Microsoft's token errors (expired secret, wrong ids...).
function tokenError(body, status) {
  const text = String((body && (body.error_description || body.error)) || `HTTP ${status}`);
  if (/AADSTS7000222/.test(text)) return 'The client secret has expired. Create a new secret in Entra ID (App registrations) and update MS_CLIENT_SECRET in .env.';
  if (/AADSTS7000215/.test(text)) return 'The client secret is wrong. Check MS_CLIENT_SECRET in .env (use the secret value, not its ID).';
  if (/AADSTS700016/.test(text)) return 'The app (MS_CLIENT_ID) was not found in the tenant. Check MS_CLIENT_ID and MS_TENANT_ID in .env.';
  if (/AADSTS90002|AADSTS900023/.test(text)) return 'The tenant (MS_TENANT_ID) was not found. Check MS_TENANT_ID in .env.';
  return `Could not sign in to Microsoft: ${text.split('\r\n')[0].slice(0, 300)}`;
}

// App-only token, cached until a minute before it expires.
async function getToken() {
  const cfg = gdapConfig();
  if (!cfg.configured) throw new Error(cfg.message);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.secret, scope: `${GRAPH}/.default`, grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(tokenError(body, res.status));
  cached = { token: body.access_token, expiresAt: Date.now() + Math.max(60, Number(body.expires_in || 3600) - 60) * 1000 };
  return cached.token;
}

// GET one Graph URL (only https://graph.microsoft.com/...). Returns the JSON body.
async function graphGet(url) {
  if (!String(url).startsWith(`${GRAPH}/`)) throw new Error('Refused a request outside Microsoft Graph.');
  const token = await getToken();
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) cached = null;
  if (!res.ok) {
    const msg = (body.error && (body.error.message || body.error.code)) || `HTTP ${res.status}`;
    if (res.status === 403) throw new Error(`Permission missing: give the app the Microsoft Graph application permission DelegatedAdminRelationship.Read.All and grant admin consent (${msg}).`);
    if (res.status === 401) throw new Error(`Microsoft rejected the sign-in (${msg}). Check the app registration and secret.`);
    throw new Error(`Microsoft Graph error ${res.status}: ${String(msg).slice(0, 300)}`);
  }
  return body;
}

// Every delegatedAdminRelationship, following @odata.nextLink.
async function listRelationships() {
  const all = [];
  let url = RELATIONSHIPS_URL;
  for (let page = 0; url && page < 200; page += 1) {
    const body = await graphGet(url);
    all.push(...(Array.isArray(body.value) ? body.value : []));
    url = body['@odata.nextLink'] || null;
  }
  return all;
}

module.exports = { gdapConfig, listRelationships };
