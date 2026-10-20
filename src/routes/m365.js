// Microsoft > Email Services (/microsoft/email-services; src/lib/m365): Microsoft 365 email
// health of domains from public DNS (read only). The list (instant: [data-list] in app.js),
// Add domains, Check now (all / one), Hide, a page per domain (records, how to fix, copy fix
// instructions, Uses Microsoft 365 override, notes, history) and Settings. Every write is
// logged as entity_type 'm365' (never on the Daily Report).
const express = require('express');
const { pool } = require('../db');
const { str, requireId, toId, flash, backPath, notFound } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const {
  STATUS_LABELS, STATUS_RANK, listDomains, getDomain, defaultOrder, recordsFor, getSettings, saveSetting, cleanDomain,
} = require('../lib/m365/data');
const { runChecks, checkDomain } = require('../lib/m365/check');
const {
  fixHint, whereOf, providerDefault, m365Missing, LABELS, CORE,
} = require('../lib/m365/dns');

const router = express.Router();
const BASE = '/microsoft/email-services';
const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';
const log = (req, entry) => logActivity(null, req.user, { type: 'm365', subject: 'Email Services', ...entry });

const STATUS_FILTERS = {
  all: { label: 'All', test: (d) => !d.hidden },
  issues: { label: 'Issues', test: (d) => !d.hidden && d.statusKey === 'issues' },
  healthy: { label: 'Healthy', test: (d) => !d.hidden && d.statusKey === 'healthy' },
  not_m365: { label: 'Not Microsoft', test: (d) => !d.hidden && d.statusKey === 'not_m365' },
  error: { label: 'Error', test: (d) => !d.hidden && d.statusKey === 'error' },
  unchecked: { label: 'Not checked', test: (d) => !d.hidden && d.statusKey === 'unchecked' },
  hidden: { label: 'Hidden', test: (d) => d.hidden },
};
const SORTS = {
  domain: (d) => d.domain,
  status: (d) => STATUS_RANK[d.statusKey] ?? 9,
  managed: (d) => (d.managed_by || '~').toLowerCase(),
  provider: (d) => (d.dns_provider || '~').toLowerCase(),
  checked: (d) => (d.last_checked ? new Date(d.last_checked).getTime() : 0),
};

// Each row's search text, tags, rank (default order) and sort values, made once.
function prepareRows(all) {
  const ranked = defaultOrder(all);
  for (const [i, d] of ranked.entries()) {
    d.rank = i;
    d.search = [d.domain, d.statusLabel, d.managed_by, d.dns_provider, d.notes, ...d.issueLabels].filter(Boolean).join(' ').toLowerCase();
    d.tags = [
      ...Object.entries(STATUS_FILTERS).filter(([, f]) => f.test(d)).map(([k]) => `status:${k}`),
      d.managed_by ? `managed:${encodeURIComponent(d.managed_by)}` : '',
    ].filter(Boolean).join(' ');
    d.sortValues = Object.fromEntries(Object.entries(SORTS).map(([k, fn]) => [k, fn(d)]));
  }
  return ranked;
}

function summaryOf(all) {
  const shown = all.filter((d) => !d.hidden);
  return {
    m365: shown.filter((d) => d.usesM365 || ['healthy', 'issues'].includes(d.statusKey)).length,
    healthy: shown.filter((d) => d.statusKey === 'healthy').length,
    issues: shown.filter((d) => d.statusKey === 'issues').length,
    notM365: shown.filter((d) => d.statusKey === 'not_m365').length,
  };
}

// The JSON reply of the row actions (Check now, Hide): the row drawn again (views/m365/_row.ejs)
// and the tile numbers, so the list updates in place.
async function rowReply(req, res, id, extra) {
  const all = await listDomains(pool);
  const d = prepareRows(all).find((x) => x.id === id);
  if (!d) return res.status(404).json({ ok: false, error: 'That domain no longer exists.' });
  res.render('m365/_row', { d, here: backPath(req, BASE) }, (err, html) => {
    if (err) return res.status(500).json({ ok: false, error: 'The row could not be drawn again. Reload the page.' });
    return res.json({ ok: true, rowHtml: html, summary: summaryOf(all), status: d.statusKey, hidden: d.hidden, ...extra });
  });
}

router.get('/', async (req, res) => {
  const all = await listDomains(pool);
  const state = {
    status: Object.hasOwn(STATUS_FILTERS, req.query.status) ? req.query.status : 'all',
    managed: ['Us', 'Customer'].includes(req.query.managed) ? req.query.managed : '',
    q: str(req.query.q, 100).toLowerCase(),
    sort: Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : '',
    dir: req.query.dir === 'desc' ? 'desc' : 'asc',
  };
  // Every domain goes to the page and is filtered there (instant); rows the address's filters
  // leave out start hidden.
  const ranked = prepareRows(all);
  const words = state.q.split(/\s+/).filter(Boolean);
  const match = (d, skip) => (skip === 'status' || STATUS_FILTERS[state.status].test(d))
    && (!state.managed || d.managed_by === state.managed) && words.every((w) => d.search.includes(w));
  for (const d of ranked) d.visible = match(d);
  const counts = Object.fromEntries(Object.entries(STATUS_FILTERS).map(([k, f]) => [k, ranked.filter((d) => match(d, 'status') && f.test(d)).length]));
  let rows = ranked;
  if (state.sort) {
    const key = SORTS[state.sort];
    const sign = state.dir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = key(a); const y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sign || a.rank - b.rank;
    });
  }
  const summary = summaryOf(all);
  const href = (changes) => {
    const next = { ...state, ...changes };
    const q = new URLSearchParams();
    for (const k of ['status', 'managed', 'q', 'sort', 'dir']) {
      if (next[k] && !(k === 'status' && next[k] === 'all') && !(k === 'dir' && !next.sort)) q.set(k, next[k]);
    }
    const s = q.toString();
    return `${BASE}${s ? `?${s}` : ''}`;
  };
  const [[last]] = await pool.query("SELECT value FROM m365_settings WHERE name = 'last_run'");
  res.render('m365/index', {
    title: 'Email Services', nav: 'microsoft', rows, state, counts, filters: STATUS_FILTERS, summary, href, total: all.length,
    lastRun: last && last.value ? new Date(last.value) : null,
  });
});

// Add domains: one per line (or separated by commas / spaces); duplicates are ignored. Domains
// added by hand use Microsoft 365 (uses_m365 'yes'); auto is for domains added automatically.
router.post('/add', async (req, res) => {
  const text = str(req.body.domains, 20000);
  const notes = str(req.body.notes, 2000) || null;
  const parts = text.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
  const bad = [];
  const wanted = [];
  for (const p of parts) {
    const d = cleanDomain(p);
    if (!d) bad.push(p);
    else if (!wanted.includes(d)) wanted.push(d);
  }
  if (!wanted.length) {
    flash(req, 'error', bad.length ? `Not a domain name: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}` : 'Paste one or more domains, one per line.');
    return res.redirect(`${BASE}#add`);
  }
  const added = [];
  for (const d of wanted) {
    const [r] = await pool.query("INSERT IGNORE INTO m365_domains (domain, notes, uses_m365, created_by) VALUES (?, ?, 'yes', ?)", [d, notes, req.user.id]);
    if (r.affectedRows === 1) {
      added.push({ id: r.insertId, domain: d });
      await pool.query("INSERT INTO m365_events (domain_id, type, user_id, alerted_at) VALUES (?, 'added', ?, NOW())", [r.insertId, req.user.id]);
    }
  }
  const skipped = wanted.length - added.length;
  if (added.length) {
    await log(req, { action: 'created', summary: `Email Services: added ${added.map((a) => a.domain).join(', ')}` });
    // Checked straight away, so the list shows their status.
    await runChecks(req.user, { trigger: 'added', ids: added.map((a) => a.id) });
  }
  const bits = [];
  if (added.length) bits.push(`Added and checked ${added.length} domain${added.length === 1 ? '' : 's'}.`);
  if (skipped) bits.push(`${skipped} already in the list.`);
  if (bad.length) bits.push(`Not a domain name: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}.`);
  flash(req, added.length ? (bad.length ? 'info' : 'saved') : 'info', bits.join(' '));
  res.redirect(BASE);
});

router.post('/check', async (req, res) => {
  const result = await runChecks(req.user, { trigger: 'manual' });
  if (result.ok) flash(req, 'saved', `Checked ${result.count} domain${result.count === 1 ? '' : 's'}: ${result.changed} status change${result.changed === 1 ? '' : 's'}, ${result.alerts} alert${result.alerts === 1 ? '' : 's'}.`);
  else flash(req, 'error', result.error);
  res.redirect(backPath(req, BASE));
});

// ---- Settings ----
async function renderSettings(res, settings, error = null, status = 200) {
  const [users] = await pool.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, notify_channels FROM users ORDER BY name");
  res.status(status).render('m365/settings', { title: 'Email Services settings', nav: 'microsoft', settings, users, error });
}
router.get('/settings', async (req, res) => renderSettings(res, await getSettings(pool)));
router.post('/settings', async (req, res) => {
  const before = await getSettings(pool);
  const everyone = req.body.alert_all === '1';
  const ids = [...new Set([].concat(req.body.alert_user_ids || []).map(toId).filter(Boolean))];
  if (!everyone && !ids.length) return renderSettings(res, { ...before, alert_users: '' }, 'Choose who gets Email Services alerts (or everyone).', 400);
  const value = everyone ? 'all' : ids.join(',');
  if (String(before.alert_users || 'all') !== value) {
    await saveSetting(pool, 'alert_users', value);
    await log(req, { action: 'updated', summary: `Changed who gets Email Services alerts: ${everyone ? 'everyone' : `${ids.length} user${ids.length === 1 ? '' : 's'}`}`, changes: ['alert_users'] });
  }
  // include_cloudflare is prepared but not available yet: it is never changed here.
  flash(req, 'saved', 'Saved. Email Services settings updated.');
  res.redirect(`${BASE}/settings`);
});

// ---- One domain ----
async function domainOr404(id) {
  const d = await getDomain(requireId(id));
  if (!d) throw notFound();
  return d;
}

router.get('/:id', async (req, res) => {
  const domain = await domainOr404(req.params.id);
  const records = (await recordsFor(domain.id)).map((r) => {
    const count = r.found ? String(r.found).split('  |  ').length : 0;
    return {
      ...r,
      where: whereOf(r.record, domain.domain),
      byProvider: providerDefault(r.record, r.found),
      hint: r.ok ? '' : fixHint(r.record, { found: r.found, count }, domain.domain, domain.dns_provider),
    };
  });
  // Set to use Microsoft 365 but nothing of it is in DNS: most likely the nameservers moved and
  // the records were not copied over.
  const provider = domain.dns_provider && !/^(None|Unknown)$/i.test(domain.dns_provider) ? domain.dns_provider : 'another provider';
  const missingSummary = domain.uses_m365 === 'yes' && domain.statusKey !== 'error' && m365Missing(records)
    ? `Microsoft 365 records are missing. The DNS is now hosted at ${provider}, so the records probably weren't copied over when the nameservers changed.`
    : '';
  const [events] = await pool.query(`
    SELECT e.*, COALESCE(NULLIF(u.display_name, ''), u.username) AS user_name FROM m365_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.domain_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 200
  `, [domain.id]);
  // Plain-text fix instructions for the customer (what is missing or wrong).
  const coreBad = records.filter((r) => r.core && !r.ok);
  const infoBad = records.filter((r) => !r.core && !r.ok && r.record !== 'ms_verify');
  const at = domain.dns_provider && !/^(None|Unknown)$/i.test(domain.dns_provider) ? ` (DNS hosted at ${domain.dns_provider})` : '';
  const line = (r, i) => `${i + 1}. ${r.label} (${r.where}): ${r.hint}\n   Expected: ${r.expected}${r.found ? `\n   Found now: ${r.found}${r.byProvider ? ` (${r.byProvider})` : ''}` : '\n   Found now: nothing'}`;
  const fixText = coreBad.length || infoBad.length ? [
    `Microsoft 365 email DNS records for ${domain.domain}${at}`,
    '',
    ...(missingSummary ? [missingSummary, ''] : []),
    ...(coreBad.length ? ['Needed for email to work:', ...coreBad.map(line), ''] : []),
    ...(infoBad.length ? ['Recommended (email security):', ...infoBad.map(line), ''] : []),
  ].join('\n').trim() : '';
  res.render('m365/domain', {
    title: domain.domain, nav: 'microsoft', domain, records, events, fixText, missingSummary, STATUS_LABELS, LABELS, CORE,
  });
});

router.post('/:id/check', async (req, res) => {
  const d = await domainOr404(req.params.id);
  const result = await checkDomain(req.user, d.id);
  if (wantsJson(req)) {
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return rowReply(req, res, d.id, { message: `Checked ${result.domain}: ${STATUS_LABELS[result.status] || result.status}${result.changed ? ' (changed)' : ''}.` });
  }
  if (result.ok) flash(req, 'saved', `Checked ${result.domain}: ${STATUS_LABELS[result.status] || result.status}${result.changed ? ' (changed)' : ''}.`);
  else flash(req, 'error', result.error);
  res.redirect(backPath(req, `${BASE}/${d.id}`));
});

router.post('/:id/hide', async (req, res) => {
  const d = await domainOr404(req.params.id);
  const hide = req.body.hide === '1';
  if (d.hidden !== hide) {
    if (hide) await pool.query('UPDATE m365_domains SET hidden_at = NOW(), hidden_by = ? WHERE id = ?', [req.user.id, d.id]);
    else await pool.query('UPDATE m365_domains SET hidden_at = NULL, hidden_by = NULL WHERE id = ?', [d.id]);
    await log(req, { id: d.id, action: 'updated', summary: `${hide ? 'Hid' : 'Unhid'} the Email Services domain ${d.domain}` });
  }
  if (wantsJson(req)) return rowReply(req, res, d.id, { message: hide ? `Hidden: ${d.domain}.` : `Unhidden: ${d.domain}.` });
  flash(req, 'saved', hide ? `Hidden: ${d.domain}. Find it under Hidden.` : `Unhidden: ${d.domain}.`);
  res.redirect(backPath(req, BASE));
});

// Uses Microsoft 365: auto (from DNS) / yes / no; the status is worked out again at once.
router.post('/:id/uses', async (req, res) => {
  const d = await domainOr404(req.params.id);
  const value = ['auto', 'yes', 'no'].includes(req.body.uses_m365) ? req.body.uses_m365 : 'auto';
  if (value !== d.uses_m365) {
    await pool.query('UPDATE m365_domains SET uses_m365 = ? WHERE id = ?', [value, d.id]);
    await pool.query("INSERT INTO m365_events (domain_id, type, details, user_id, alerted_at) VALUES (?, 'override', ?, ?, NOW())",
      [d.id, JSON.stringify({ from: d.uses_m365, to: value }), req.user.id]);
    await log(req, { id: d.id, action: 'updated', summary: `Email Services: ${d.domain} uses Microsoft 365 set to ${value === 'auto' ? 'Auto (from DNS)' : value === 'yes' ? 'Yes' : 'No'}`, changes: ['uses_m365'] });
    await checkDomain(req.user, d.id);
  }
  flash(req, 'saved', 'Saved.');
  res.redirect(`${BASE}/${d.id}`);
});

router.post('/:id/notes', async (req, res) => {
  const d = await domainOr404(req.params.id);
  const notes = str(req.body.notes, 10000);
  if ((d.notes || '') !== notes) {
    await pool.query('UPDATE m365_domains SET notes = ? WHERE id = ?', [notes || null, d.id]);
    await log(req, { id: d.id, action: 'updated', summary: `Updated the notes on ${d.domain} (Email Services)`, changes: ['notes'] });
  }
  flash(req, 'saved', 'Saved.');
  res.redirect(`${BASE}/${d.id}#notes`);
});

router.post('/:id/delete', async (req, res) => {
  const d = await domainOr404(req.params.id);
  await pool.query('DELETE FROM m365_domains WHERE id = ?', [d.id]);
  await log(req, { id: d.id, action: 'deleted', summary: `Email Services: removed ${d.domain}` });
  flash(req, 'saved', `Removed ${d.domain}.`);
  res.redirect(BASE);
});

module.exports = router;
