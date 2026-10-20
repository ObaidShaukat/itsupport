// Microsoft 365 email records of a domain, from public DNS (1.1.1.1 and 8.8.8.8, never the
// server's own resolver). Read only: nothing is changed anywhere.
//   mx            MX -> *.mail.protection.outlook.com or *.mx.microsoft
//   spf           TXT v=spf1 ... include:spf.protection.outlook.com (2+ SPF records = wrong)
//   autodiscover  CNAME autodiscover.{domain} -> autodiscover.outlook.com
//   dkim1 / dkim2 CNAME selector1/2._domainkey.{domain} -> *._domainkey.*.onmicrosoft.com or *.dkim.mail.microsoft
//   dmarc         exactly one TXT on _dmarc.{domain}, starting v=DMARC1, p=quarantine or p=reject
//   ms_verify     TXT MS=ms... (Microsoft 365 domain verification)
// Every record except ms_verify is required (CORE): one missing or wrong = Issues. Each record
// that is not right has a short problem ("missing", "policy is none", ...); the reason shown is
// "{label} {problem}", e.g. "DMARC policy is none", "DKIM selector2 missing".
const dns = require('dns');

const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

const CORE = ['mx', 'spf', 'autodiscover', 'dkim1', 'dkim2', 'dmarc'];
const DMARC_SUGGESTED = 'v=DMARC1; p=quarantine; rua=mailto:reports@cleartwo.it';
const RECORDS = ['mx', 'spf', 'autodiscover', 'dkim1', 'dkim2', 'dmarc', 'ms_verify'];
const LABELS = {
  mx: 'MX', spf: 'SPF', autodiscover: 'Autodiscover', dkim1: 'DKIM selector1', dkim2: 'DKIM selector2', dmarc: 'DMARC', ms_verify: 'Microsoft verification',
};

const host = (h) => String(h || '').trim().toLowerCase().replace(/\.$/, '');
const MISSING = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

// A lookup that treats "no such record" as an empty answer and anything else as an error.
async function look(kind, name) {
  try {
    if (kind === 'MX') return { ok: true, value: await resolver.resolveMx(name) };
    if (kind === 'TXT') return { ok: true, value: (await resolver.resolveTxt(name)).map((chunks) => chunks.join('')) };
    if (kind === 'CNAME') return { ok: true, value: (await resolver.resolveCname(name)).map(host) };
    if (kind === 'NS') return { ok: true, value: (await resolver.resolveNs(name)).map(host) };
  } catch (err) {
    if (MISSING.has(err.code)) return { ok: true, value: [], missing: err.code };
    return { ok: false, error: err.code === 'ETIMEOUT' || err.code === 'ECONNREFUSED' ? 'DNS lookup timed out' : `DNS lookup failed (${err.code || err.message})` };
  }
  return { ok: false, error: 'Unknown record type' };
}

// The usual Microsoft 365 MX host: "example-co-uk.mail.protection.outlook.com".
const mxHost = (domain) => `${domain.replace(/\./g, '-')}.mail.protection.outlook.com`;
const isMicrosoftMx = (h) => /\.mail\.protection\.outlook\.com$/.test(h) || /\.mx\.microsoft$/.test(h);
const isMicrosoftDkim = (h) => /\._domainkey\.[a-z0-9-]+\.onmicrosoft\.com$/.test(h) || /\.dkim\.mail\.microsoft$/.test(h);

// { error } when the domain itself cannot be looked up (does not exist, time-out), otherwise
// { nameservers, records: { mx: { ok, found, expected }, ... }, detected }.
async function checkDns(domain) {
  const name = host(domain);
  const ns = await look('NS', name);
  if (!ns.ok) return { error: ns.error };
  if (ns.missing === 'ENOTFOUND' || ns.missing === 'NXDOMAIN') return { error: 'The domain does not exist in DNS (NXDOMAIN)' };
  const [mx, txt, auto, dkim1, dkim2, dmarc] = await Promise.all([
    look('MX', name), look('TXT', name), look('CNAME', `autodiscover.${name}`),
    look('CNAME', `selector1._domainkey.${name}`), look('CNAME', `selector2._domainkey.${name}`), look('TXT', `_dmarc.${name}`),
  ]);
  // The core lookups must answer, or the result would be a guess.
  const failed = [mx, txt, auto].find((r) => !r.ok);
  if (failed) return { error: failed.error };

  const records = {};
  // MX
  const mxList = (mx.value || []).sort((a, b) => a.priority - b.priority).map((m) => ({ priority: m.priority, exchange: host(m.exchange) }));
  const mxOk = mxList.length > 0 && mxList.every((m) => isMicrosoftMx(m.exchange));
  records.mx = {
    ok: mxOk,
    found: mxList.length ? mxList.map((m) => `${m.priority} ${m.exchange}`).join(', ') : '',
    expected: `${mxHost(name)} (priority 0), and no other MX records`,
    microsoft: mxList.some((m) => isMicrosoftMx(m.exchange)),
    problem: mxOk ? null : !mxList.length ? 'missing' : mxList.some((m) => isMicrosoftMx(m.exchange)) ? 'has non-Microsoft records too' : 'not pointing to Microsoft',
  };
  // SPF and the MS=ms verification record (both TXT on the domain)
  const spf = txt.value.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  const spfMs = spf.some((t) => /include:spf\.protection\.outlook\.com/i.test(t));
  records.spf = {
    ok: spf.length === 1 && spfMs,
    found: spf.join('  |  '),
    expected: 'One TXT record: v=spf1 include:spf.protection.outlook.com -all',
    microsoft: spfMs,
    count: spf.length,
    problem: spf.length === 1 && spfMs ? null : !spf.length ? 'missing' : spf.length > 1 ? `has ${spf.length} records (only one allowed)` : 'does not include spf.protection.outlook.com',
  };
  const verify = txt.value.filter((t) => /^MS=ms\d+/i.test(t.trim()));
  records.ms_verify = {
    ok: verify.length > 0, found: verify.join(', '), expected: 'TXT MS=ms######## (from the Microsoft 365 admin centre)', microsoft: verify.length > 0, problem: verify.length ? null : 'missing',
  };
  // Autodiscover
  records.autodiscover = {
    ok: auto.value.includes('autodiscover.outlook.com'),
    found: auto.value.join(', '),
    expected: `CNAME autodiscover.${name} → autodiscover.outlook.com`,
    microsoft: auto.value.includes('autodiscover.outlook.com'),
    problem: auto.value.includes('autodiscover.outlook.com') ? null : auto.value.length ? 'not pointing to autodiscover.outlook.com' : 'missing',
  };
  // DKIM: both selectors must be CNAMEs to Microsoft.
  for (const [key, r, selector] of [['dkim1', dkim1, 'selector1'], ['dkim2', dkim2, 'selector2']]) {
    const expected = `CNAME ${selector}._domainkey.${name} → ${selector}-${name.replace(/\./g, '-')}._domainkey.<tenant>.onmicrosoft.com`;
    if (!r.ok) records[key] = { ok: false, found: '', expected, problem: `lookup failed (${r.error})` };
    else {
      const ok = r.value.length > 0 && r.value.every(isMicrosoftDkim);
      records[key] = { ok, found: r.value.join(', '), expected, problem: ok ? null : r.value.length ? 'not pointing to Microsoft' : 'missing' };
    }
  }
  // DMARC: exactly one TXT record on _dmarc, starting v=DMARC1, with p=quarantine or p=reject.
  records.dmarc = dmarcRecord(dmarc, name);
  const detected = Boolean(records.mx.microsoft || records.spf.microsoft || records.autodiscover.microsoft || records.ms_verify.microsoft);
  return { nameservers: ns.value.sort(), records, detected };
}

// DMARC from the TXT answers on _dmarc.{domain}: every TXT record there counts as a DMARC record.
function dmarcRecord(answer, name) {
  const expected = `TXT _dmarc.${name}: ${DMARC_SUGGESTED} (p=reject also passes)`;
  if (!answer.ok) return { ok: false, found: '', expected, problem: `lookup failed (${answer.error})`, policy: '' };
  const all = answer.value.map((t) => t.trim()).filter(Boolean);
  const found = all.join('  |  ');
  const policyOf = (t) => ((/(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(t) || [])[1] || '').toLowerCase();
  const policy = all.length === 1 ? policyOf(all[0]) : '';
  let problem = null;
  if (!all.length) problem = 'missing';
  else if (all.length > 1) problem = `has ${all.length} records (only one allowed)`;
  else if (!/^v=DMARC1(\s*;|\s*$)/i.test(all[0])) problem = 'does not start with v=DMARC1';
  else if (!policy) problem = 'has no policy (p=)';
  else if (policy === 'none') problem = 'policy is none';
  else if (!['quarantine', 'reject'].includes(policy)) problem = `policy "${policy}" is not valid`;
  return { ok: !problem, found, expected, problem, policy, count: all.length };
}

// The reasons of the failing required records, stored as [{ r: record, p: problem }]:
// reasonsList() gives one line each ("DMARC policy is none"); reasonsSummary() groups the
// missing ones for small places ("MX, DMARC missing · SPF has 2 records (only one allowed)").
const reasonText = (x) => `${LABELS[x.r] || x.r} ${x.p}`;
const reasonsList = (reasons) => (reasons || []).map(reasonText);
function reasonsSummary(reasons) {
  const list = reasons || [];
  const missing = list.filter((x) => x.p === 'missing').map((x) => LABELS[x.r] || x.r);
  const other = list.filter((x) => x.p !== 'missing').map(reasonText);
  return [missing.length ? `${missing.join(', ')} missing` : '', ...other].filter(Boolean).join(' · ');
}
const parseReasons = (json) => {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.filter((x) => x && x.r && x.p) : [];
  } catch (err) {
    return [];
  }
};

// ---- Fix steps for the domain page's "How to fix" and "Copy fix instructions" ----
// A step is { action: 'add' | 'change' | 'remove', type, host, value, priority, from, remove }:
// add / change carry Type / Host / Value (+ Priority for MX; TTL is always 3600 or Auto);
// change also has from (what is there now); remove has remove = the record to delete
// ("MX 10 mailstore1.secureserver.net"). Hosts are relative: "@" is the domain itself.
const TTL = '3600 (or Auto)';
const MS_SPF = 'v=spf1 include:spf.protection.outlook.com -all';
const splitFound = (record, found) => {
  const v = String(found || '').trim();
  if (!v) return [];
  return ['spf', 'dmarc'].includes(record) ? v.split(/\s+\|\s+/) : v.split(/,\s*/);
};
const sel = (record) => (record === 'dkim1' ? 'selector1' : 'selector2');

// The Microsoft DKIM target of a selector: from the other selector when that one is right
// (same tenant), else the usual pattern with <tenant> to fill in from Microsoft Defender.
function dkimTarget(record, domain, otherFound) {
  const other = splitFound('dkim', otherFound).map(host).find(isMicrosoftDkim);
  const want = sel(record);
  if (other) return other.replace(/selector[12]/, want);
  return `${want}-${host(domain).replace(/\./g, '-')}._domainkey.<tenant>.onmicrosoft.com`;
}

// The expected value only, short and plain ("example-com.mail.protection.outlook.com").
function expectedValue(record, domain, ctx = {}) {
  switch (record) {
    case 'mx': return mxHost(host(domain));
    case 'spf': return MS_SPF;
    case 'autodiscover': return 'autodiscover.outlook.com';
    case 'dkim1': return dkimTarget('dkim1', domain, ctx.dkim2);
    case 'dkim2': return dkimTarget('dkim2', domain, ctx.dkim1);
    case 'dmarc': return DMARC_SUGGESTED;
    case 'ms_verify': return 'MS=ms######## (from the Microsoft 365 admin centre)';
    default: return '';
  }
}

// SPF with the Microsoft include added: one record keeps its own mechanisms; several are
// merged into one (duplicates dropped), ending with the first record's "all" (else -all).
function fixedSpf(records) {
  const terms = [];
  let all = '';
  for (const rec of records) {
    for (const t of rec.trim().split(/\s+/).slice(1)) {
      if (/^[~?+-]?all$/i.test(t)) { if (!all) all = t; } else if (!terms.some((x) => x.toLowerCase() === t.toLowerCase())) terms.push(t);
    }
  }
  if (!terms.some((t) => /^include:spf\.protection\.outlook\.com$/i.test(t))) terms.push('include:spf.protection.outlook.com');
  return ['v=spf1', ...terms, all || '-all'].join(' ');
}

// The steps that fix one record that is not right (an empty list when it is right).
function fixSteps(record, check, domain, ctx = {}) {
  if (!check || check.ok) return [];
  const name = host(domain);
  const found = splitFound(record, check.found);
  const value = expectedValue(record, name, ctx);
  switch (record) {
    case 'mx': {
      const list = found.map((m) => { const [p, h] = m.trim().split(/\s+/); return { priority: p, exchange: host(h || p) }; });
      const steps = [];
      if (!list.some((m) => isMicrosoftMx(m.exchange))) steps.push({ action: 'add', type: 'MX', host: '@', value, priority: '0' });
      for (const m of list.filter((x) => !isMicrosoftMx(x.exchange))) steps.push({ action: 'remove', remove: `MX ${m.priority} ${m.exchange}` });
      return steps;
    }
    case 'spf':
      if (!found.length) return [{ action: 'add', type: 'TXT', host: '@', value }];
      if (found.length === 1) return [{ action: 'change', type: 'TXT', host: '@', value: fixedSpf(found), from: found[0] }];
      return [...found.map((f) => ({ action: 'remove', remove: `TXT @ "${f}"` })), { action: 'add', type: 'TXT', host: '@', value: fixedSpf(found) }];
    case 'autodiscover':
      return [found.length
        ? { action: 'change', type: 'CNAME', host: 'autodiscover', value, from: found.join(', ') }
        : { action: 'add', type: 'CNAME', host: 'autodiscover', value }];
    case 'dkim1': case 'dkim2':
      return [found.length
        ? { action: 'change', type: 'CNAME', host: `${sel(record)}._domainkey`, value, from: found.join(', ') }
        : { action: 'add', type: 'CNAME', host: `${sel(record)}._domainkey`, value }];
    case 'dmarc':
      if (!found.length) return [{ action: 'add', type: 'TXT', host: '_dmarc', value }];
      if (found.length === 1) return [{ action: 'change', type: 'TXT', host: '_dmarc', value, from: found[0] }];
      return [...found.map((f) => ({ action: 'remove', remove: `TXT _dmarc "${f}"` })), { action: 'add', type: 'TXT', host: '_dmarc', value }];
    case 'ms_verify':
      return [{ action: 'add', type: 'TXT', host: '@', value: 'MS=ms######## (copy it from the Microsoft 365 admin centre: Settings > Domains)' }];
    default: return [];
  }
}

// Plain-text lines of the steps, in the same Type / Host / Value / Priority / TTL format.
function stepsText(steps, indent = '   ') {
  const out = [];
  for (const s of steps) {
    if (s.action === 'remove') { out.push(`${indent}Remove: ${s.remove}`); continue; }
    out.push(`${indent}${s.action === 'change' ? `Change (now: ${s.from})` : 'Add'}:`);
    out.push(`${indent}  Type: ${s.type}`, `${indent}  Host: ${s.host}`, `${indent}  Value: ${s.value}`);
    if (s.priority !== undefined) out.push(`${indent}  Priority: ${s.priority}`);
    out.push(`${indent}  TTL: ${TTL}`);
  }
  return out;
}

// Where a record lives: "TXT on _dmarc.example.com".
function whereOf(record, domain) {
  const name = host(domain);
  switch (record) {
    case 'mx': return `MX on ${name}`;
    case 'spf': case 'ms_verify': return `TXT on ${name}`;
    case 'autodiscover': return `CNAME on autodiscover.${name}`;
    case 'dkim1': return `CNAME on selector1._domainkey.${name}`;
    case 'dkim2': return `CNAME on selector2._domainkey.${name}`;
    case 'dmarc': return `TXT on _dmarc.${name}`;
    default: return '';
  }
}

// Records a DNS provider adds by itself, recognised from what was found:
// [records, pattern, label]. The first match wins.
const PROVIDER_DEFAULTS = [
  [['dmarc'], /onsecureserver\.net/i, 'default record added by GoDaddy'],
  [['mx'], /\.secureserver\.net\b/i, 'default record added by GoDaddy'],
  [['spf'], /include:secureserver\.net/i, 'default record added by GoDaddy'],
  [['mx'], /\.mx\.cloudflare\.net\b/i, 'added by Cloudflare Email Routing'],
  [['spf'], /include:_spf\.mx\.cloudflare\.net/i, 'added by Cloudflare Email Routing'],
  [['dmarc'], /dmarc-reports\.cloudflare\.net/i, 'added by Cloudflare DMARC Management'],
  [['mx'], /eforward\d*\.registrar-servers\.com/i, 'default record added by Namecheap (email forwarding)'],
  [['spf'], /include:spf\.efwd\.registrar-servers\.com/i, 'default record added by Namecheap (email forwarding)'],
  [['mx'], /\.123-reg\.co\.uk\b/i, 'default record added by 123 Reg'],
  [['mx'], /\.ionos\.(co\.uk|com|de)\b|\.1and1\./i, 'default record added by IONOS'],
  [['spf'], /include:_spf(-eu)?\.ionos\.com/i, 'default record added by IONOS'],
  [['mx'], /\.hostinger\.com\b/i, 'default record added by Hostinger'],
  [['spf'], /include:_spf\.mail\.hostinger\.com/i, 'default record added by Hostinger'],
];
function providerDefault(record, found) {
  if (!found) return '';
  const hit = PROVIDER_DEFAULTS.find(([recs, re]) => recs.includes(record) && re.test(found));
  return hit ? hit[2] : '';
}

// True when nothing of Microsoft 365 is left: no Microsoft MX, no SPF including
// spf.protection.outlook.com and no MS=ms verification record (records = recordsFor() rows
// or checkDns() records, keyed by record name or with .record).
function m365Missing(records) {
  const by = Array.isArray(records) ? Object.fromEntries(records.map((r) => [r.record, r])) : records;
  if (!by.mx || !by.spf || !by.ms_verify) return false;
  const mxFound = String(by.mx.found || '').split(/,\s*/).map((m) => host(m.split(/\s+/).pop()));
  const msMx = mxFound.some(isMicrosoftMx);
  const msSpf = /include:spf\.protection\.outlook\.com/i.test(String(by.spf.found || ''));
  const verify = /MS=ms\d+/i.test(String(by.ms_verify.found || ''));
  return !msMx && !msSpf && !verify;
}

module.exports = {
  checkDns, fixSteps, stepsText, expectedValue, TTL, whereOf, reasonsList, reasonsSummary, parseReasons, DMARC_SUGGESTED, providerDefault, m365Missing, CORE, RECORDS, LABELS, host, mxHost,
};
