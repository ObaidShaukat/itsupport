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

// RDAP (https://rdap.org redirects to the registry): { ok, expiresOn: 'YYYY-MM-DD' | null,
// registrar } or { ok: false, note } (no RDAP for this TLD, not found, time-out).
async function rdapLookup(name) {
  let res;
  try {
    res = await fetch(`https://rdap.org/domain/${encodeURIComponent(name)}`, {
      // rdap.org (behind Cloudflare) refuses requests without a User-Agent.
      method: 'GET', headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': 'Cleartwo-IT-Support/1.0 (domain expiry check)' }, redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: false, note: `RDAP lookup failed (${err.name === 'TimeoutError' ? 'timed out' : err.message})` };
  }
  if (res.status === 404) return { ok: false, noRdap: true, note: 'No RDAP for this domain or its TLD' };
  if (!res.ok) return { ok: false, note: `RDAP lookup failed (HTTP ${res.status})` };
  const body = await res.json().catch(() => null);
  if (!body) return { ok: false, note: 'RDAP reply could not be read' };
  const expiry = (body.events || []).find((e) => /expiration/i.test(String(e.eventAction || '')));
  const date = expiry && expiry.eventDate ? new Date(expiry.eventDate) : null;
  const registrarEntity = (body.entities || []).find((e) => (e.roles || []).includes('registrar'));
  let registrar = null;
  if (registrarEntity) {
    const card = Array.isArray(registrarEntity.vcardArray) ? registrarEntity.vcardArray[1] || [] : [];
    const fn = card.find((p) => p[0] === 'fn');
    registrar = (fn && fn[3]) || registrarEntity.handle || null;
  }
  return {
    ok: true,
    expiresOn: date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null,
    registrar: registrar ? String(registrar).slice(0, 255) : null,
  };
}

module.exports = {
  publicNameservers, sameNs, nsList, providerOf, providersLabel, rdapLookup,
};
