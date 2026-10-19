// Public lookups for the Cloudflare checks: a domain's nameservers in public DNS (asked of
// 1.1.1.1 and 8.8.8.8, never the server's own resolver, so local caching can't hide a
// change), RDAP for the expiry date and registrar, and plain names for nameserver providers.
const dns = require('dns');

const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

const host = (h) => String(h || '').trim().toLowerCase().replace(/\.$/, '');
const nsList = (list) => [...new Set((list || []).map(host).filter(Boolean))].sort();

// { ok: true, ns: [...] } (an empty list when the domain has no NS records or does not exist),
// or { ok: false, error } when the lookup itself failed (time-out, network): then we know nothing.
async function publicNameservers(name) {
  try {
    return { ok: true, ns: nsList(await resolver.resolveNs(name)) };
  } catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(err.code)) return { ok: true, ns: [] };
    return { ok: false, error: `DNS lookup failed (${err.code || err.message})` };
  }
}

// Same set of nameservers (order and case ignored).
const sameNs = (a, b) => {
  const x = nsList(a);
  const y = nsList(b);
  return x.length > 0 && x.length === y.length && x.every((v, i) => v === y[i]);
};

// Nameserver host -> provider, by the end of the name. Unknown: the domain part.
const PROVIDERS = [
  ['ns.cloudflare.com', 'Cloudflare'],
  ['domaincontrol.com', 'GoDaddy'],
  ['123-reg.co.uk', '123-reg'],
  ['registrar-servers.com', 'Namecheap'],
  ['awsdns', 'Amazon Route 53'],
  ['azure-dns', 'Microsoft Azure DNS'],
  ['googledomains.com', 'Google Domains'],
  ['google.com', 'Google'],
  ['ionos', 'IONOS'],
  ['ui-dns', 'IONOS'],
  ['1and1', 'IONOS'],
  ['fasthosts.net.uk', 'Fasthosts'],
  ['fasthosts.co.uk', 'Fasthosts'],
  ['heartinternet.uk', 'Heart Internet'],
  ['names.co.uk', 'Names.co.uk'],
  ['tsohost.co.uk', 'TSOHost'],
  ['krystal.uk', 'Krystal'],
  ['krystal.co.uk', 'Krystal'],
  ['hostinger', 'Hostinger'],
  ['bluehost.com', 'Bluehost'],
  ['siteground.net', 'SiteGround'],
  ['wixdns.net', 'Wix'],
  ['squarespacedns.com', 'Squarespace'],
  ['shopify.com', 'Shopify'],
  ['digitalocean.com', 'DigitalOcean'],
  ['linode.com', 'Linode'],
  ['ovh.net', 'OVH'],
  ['gandi.net', 'Gandi'],
  ['dnsimple.com', 'DNSimple'],
  ['nsone.net', 'NS1'],
  ['ultradns', 'UltraDNS'],
  ['dynect.net', 'Dyn'],
  ['zoneedit.com', 'ZoneEdit'],
  ['easydns', 'easyDNS'],
  ['hover.com', 'Hover'],
  ['name.com', 'Name.com'],
  ['tucows.com', 'Tucows'],
  ['eukhost.com', 'eUKhost'],
  ['34sp.com', '34SP.com'],
  ['mythic-beasts.com', 'Mythic Beasts'],
  ['livedns.co.uk', 'LiveDNS'],
  ['register365', 'Register365'],
  ['blacknight.com', 'Blacknight'],
];
function providerOf(ns) {
  const h = host(ns);
  const hit = PROVIDERS.find(([end]) => h === end || h.endsWith(`.${end}`) || h.includes(end));
  if (hit) return hit[1];
  const parts = h.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : h || 'Unknown';
}
// "GoDaddy" for a set of GoDaddy servers, "GoDaddy + Cloudflare" for a mix, "None" when empty.
function providersLabel(list) {
  const names = [...new Set(nsList(list).map(providerOf))];
  return names.length ? names.join(' + ') : 'None';
}

// ---- RDAP (expiry date and registrar) ----
// The registry's own RDAP server comes from the IANA bootstrap file (data.iana.org/rdap/dns.json,
// cached for a day): .com / .net -> Verisign, .uk / .co.uk -> Nominet, .org -> PIR, and so on.
// Redirects are followed. Only when the bootstrap file cannot be read is rdap.org used (it
// redirects to the same servers). Registries refuse requests without a User-Agent.
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const RDAP_HEADERS = { Accept: 'application/rdap+json, application/json', 'User-Agent': 'Cleartwo-IT-Support/1.0 (domain expiry check)' };
let bootstrap = null; // { at, servers: Map(tld -> base URL ending in "/") }

async function rdapServers() {
  if (bootstrap && Date.now() - bootstrap.at < 24 * 60 * 60 * 1000) return bootstrap.servers;
  try {
    const res = await fetch(BOOTSTRAP_URL, { headers: RDAP_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const servers = new Map();
    for (const [tlds, urls] of body.services || []) {
      const base = (urls || []).find((u) => /^https:\/\//i.test(u)) || (urls || [])[0];
      if (!base) continue;
      for (const tld of tlds || []) servers.set(String(tld).toLowerCase(), base.endsWith('/') ? base : `${base}/`);
    }
    if (!servers.size) throw new Error('empty bootstrap file');
    bootstrap = { at: Date.now(), servers };
  } catch (err) {
    console.error('RDAP bootstrap file could not be read:', err.message);
    if (!bootstrap) return null; // rdap.org is used instead
    bootstrap.at = Date.now() - 23 * 60 * 60 * 1000; // try again within the hour
  }
  return bootstrap.servers;
}

// The registry server for a name: the longest matching suffix ("co.uk" before "uk").
function serverFor(servers, name) {
  const labels = String(name).toLowerCase().split('.');
  for (let i = 1; i < labels.length; i += 1) {
    const suffix = labels.slice(i).join('.');
    if (servers.has(suffix)) return servers.get(suffix);
  }
  return null;
}

// { ok: true, expiresOn: 'YYYY-MM-DD' | null, registrar } or { ok: false, note, noRdap
// (no RDAP for the TLD / domain unknown to the registry: skip for a day), rateLimited, retryAfter }.
async function rdapLookup(name) {
  const tld = String(name).split('.').pop();
  const servers = await rdapServers();
  // Not in the IANA file (some country TLDs): rdap.org knows a few more (e.g. .fr).
  let url = `https://rdap.org/domain/${encodeURIComponent(name)}`;
  const base = servers ? serverFor(servers, name) : null;
  const fallback = !base;
  if (base) url = `${base}domain/${encodeURIComponent(name)}`;
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: RDAP_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  } catch (err) {
    return { ok: false, note: `RDAP lookup failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}` };
  }
  if (res.status === 429) {
    return { ok: false, rateLimited: true, retryAfter: Math.min(300, Number(res.headers.get('retry-after')) || 60), note: 'RDAP lookup rate limited by the registry (HTTP 429): tried again later' };
  }
  if (res.status === 404) {
    return { ok: false, noRdap: true, note: fallback && servers ? `The .${tld} registry has no RDAP service` : 'The registry has no record of this domain (RDAP HTTP 404)' };
  }
  if (!res.ok) return { ok: false, note: `RDAP lookup failed (HTTP ${res.status} from ${new URL(res.url || url).host})` };
  const body = await res.json().catch(() => null);
  if (!body) return { ok: false, note: 'The RDAP reply could not be read' };
  // The "expiration" event ("registration expiration" on some registries).
  const expiry = (body.events || []).find((e) => /expiration/i.test(String(e.eventAction || '')));
  const date = expiry && expiry.eventDate ? new Date(expiry.eventDate) : null;
  const registrarEntity = (body.entities || []).find((e) => (e.roles || []).includes('registrar'));
  let registrar = null;
  if (registrarEntity) {
    const card = Array.isArray(registrarEntity.vcardArray) ? registrarEntity.vcardArray[1] || [] : [];
    const fn = card.find((p) => p[0] === 'fn');
    registrar = (fn && fn[3]) || (registrarEntity.publicIds || []).map((p) => p.identifier).find(Boolean) || registrarEntity.handle || null;
  }
  const expiresOn = date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  return {
    ok: true,
    expiresOn,
    registrar: registrar ? String(registrar).slice(0, 255) : null,
    note: expiresOn ? null : 'The registry does not publish an expiry date for this domain',
  };
}

module.exports = {
  publicNameservers, sameNs, nsList, providerOf, providersLabel, rdapLookup,
};
