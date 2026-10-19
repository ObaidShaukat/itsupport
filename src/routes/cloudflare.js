// Cloudflare monitoring (READ ONLY on Cloudflare; src/lib/cloudflare): Domains (summary
// tiles, filters, search, sort, Check now, Hide), a page per domain (fields, events, client,
// notes), Accounts (link to a client) and Settings (who gets alerts). Every write here is
// logged as entity_type 'cloudflare' (never on the Daily Report).
const express = require('express');
const { pool } = require('../db');
const { str, requireId, toId, flash, backPath, notFound } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { cfConfig } = require('../lib/cloudflare/api');
const {
  listDomains, getDomain, defaultOrder, listAccounts, getSettings, saveSetting, lastCheck,
} = require('../lib/cloudflare/data');
const { runChecks, checkDomain } = require('../lib/cloudflare/check');
const { rdapProgress, runRdapQueue } = require('../lib/cloudflare/rdap');
const { providersLabel } = require('../lib/cloudflare/lookups');

const router = express.Router();
const log = (req, entry) => logActivity(null, req.user, { type: 'cloudflare', subject: 'Cloudflare', ...entry });

router.get('/', (req, res) => res.redirect('/cloudflare/domains'));

// ---- Domains ----
const STATUS_FILTERS = {
  all: { label: 'All', test: (d) => !d.hidden },
  problems: { label: 'Problems', test: (d) => !d.hidden && d.problem },
  healthy: { label: 'Healthy', test: (d) => !d.hidden && d.healthy },
  ns_changed: { label: 'NS changed', test: (d) => !d.hidden && d.status === 'ns_changed' },
  moved: { label: 'Moved / deleted', test: (d) => !d.hidden && ['moved', 'deactivated', 'deleted'].includes(d.status) },
  pending: { label: 'Pending', test: (d) => !d.hidden && d.status === 'pending' },
  expiring: { label: 'Expiring in 30 days', test: (d) => !d.hidden && d.expiring },
  hidden: { label: 'Hidden', test: (d) => d.hidden },
};
// Sortable columns: key -> value to compare (fixed list, never SQL).
const SORTS = {
  domain: (d) => d.name,
  client: (d) => (d.client_name || '~').toLowerCase(),
  account: (d) => (d.account_name || '~').toLowerCase(),
  status: (d) => ({ deleted: 0, moved: 1, deactivated: 1, ns_changed: 2, pending: 3, active: 4 }[d.status]),
  ns: (d) => d.provider.toLowerCase(),
  expiry: (d) => (d.days === null ? 99999 : d.days),
  checked: (d) => (d.last_checked ? new Date(d.last_checked).getTime() : 0),
};

router.get('/domains', async (req, res) => {
  const all = await listDomains(pool);
  const state = {
    status: Object.hasOwn(STATUS_FILTERS, req.query.status) ? req.query.status : 'all',
    client: toId(req.query.client) || '',
    account: toId(req.query.account) || '',
    q: str(req.query.q, 100).toLowerCase(),
    sort: Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : '',
    dir: req.query.dir === 'desc' ? 'desc' : 'asc',
  };
  const visible = all.filter((d) => !d.hidden);
  const summary = {
    total: visible.length,
    healthy: visible.filter((d) => d.healthy).length,
    nsChanged: visible.filter((d) => d.status === 'ns_changed').length,
    movedDeleted: visible.filter((d) => ['moved', 'deactivated', 'deleted'].includes(d.status)).length,
    expiring: visible.filter((d) => d.expiring).length,
  };
  // Every domain goes to the page and is filtered there ([data-list] in app.js: no request per
  // key). Rows that do not match the address's filters start hidden, so the page is right
  // before the script runs (and without it). Each row carries its search text, filter tags,
  // default rank and sort values, worked out once here.
  const ranked = defaultOrder(all);
  for (const [i, d] of ranked.entries()) {
    d.rank = i;
    d.search = [d.name, d.account_name, d.client_name, d.statusLabel, d.provider, d.registrar].filter(Boolean).join(' ').toLowerCase();
    d.tags = [
      ...Object.entries(STATUS_FILTERS).filter(([, f]) => f.test(d)).map(([k]) => `status:${k}`),
      d.client_id ? `client:${d.client_id}` : '', d.cf_account_id ? `account:${d.cf_account_id}` : '',
    ].filter(Boolean).join(' ');
    d.sortValues = Object.fromEntries(Object.entries(SORTS).map(([k, fn]) => [k, fn(d)]));
  }
  const words = state.q.split(/\s+/).filter(Boolean);
  const match = (d, skip) => (skip === 'status' || STATUS_FILTERS[state.status].test(d))
    && (!state.client || d.client_id === state.client) && (!state.account || d.cf_account_id === state.account)
    && words.every((w) => d.search.includes(w));
  for (const d of ranked) d.visible = match(d);
  const counts = Object.fromEntries(Object.entries(STATUS_FILTERS).map(([k, f]) => [k, ranked.filter((d) => match(d, 'status') && f.test(d)).length]));
  let rows = ranked;
  if (state.sort) {
    const key = SORTS[state.sort];
    const sign = state.dir === 'desc' ? -1 : 1;
    rows = [...rows].sort((x1, y1) => {
      const x = key(x1);
      const y = key(y1);
      return (x < y ? -1 : x > y ? 1 : 0) * sign || x1.rank - y1.rank;
    });
  }
  const href = (changes) => {
    const next = { ...state, ...changes };
    const q = new URLSearchParams();
    for (const k of ['status', 'client', 'account', 'q', 'sort', 'dir']) {
      if (next[k] && !(k === 'status' && next[k] === 'all') && !(k === 'dir' && !next.sort)) q.set(k, next[k]);
    }
    const s = q.toString();
    return `/cloudflare/domains${s ? `?${s}` : ''}`;
  };
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  const [accounts] = await pool.query('SELECT id, name FROM cf_accounts ORDER BY name');
  res.render('cloudflare/domains', {
    title: 'Cloudflare domains', nav: 'cloudflare', config: cfConfig(), check: await lastCheck(pool), summary, counts, filters: STATUS_FILTERS,
    state, rows, href, clients, accounts, total: all.length, rdap: await rdapProgress(),
  });
});

router.get('/domains/:id', async (req, res) => {
  const domain = await getDomain(requireId(req.params.id));
  if (!domain) throw notFound();
  const [events] = await pool.query('SELECT * FROM domain_events WHERE domain_id = ? ORDER BY detected_at DESC, id DESC LIMIT 200', [domain.id]);
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  const [[account]] = domain.cf_account_id ? await pool.query('SELECT a.*, c.name AS client_name FROM cf_accounts a LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = ?', [domain.cf_account_id]) : [[null]];
  const shaped = events.map((e) => {
    let details = {};
    try { details = JSON.parse(e.details || '{}') || {}; } catch (err) { details = {}; }
    return { ...e, details, newProvider: Array.isArray(details.new) ? providersLabel(details.new) : '' };
  });
  res.render('cloudflare/domain', {
    title: domain.name, nav: 'cloudflare', config: cfConfig(), domain, events: shaped, clients, account,
  });
});

// Expiry lookups progress (polled by the Domains page while they run).
router.get('/rdap-progress', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await rdapProgress());
});

// Look up expiry dates now (only the domains that are due; in the background).
router.post('/rdap', async (req, res) => {
  if (cfConfig().configured || (await rdapProgress()).domains) {
    runRdapQueue().catch((err) => console.error('RDAP queue failed:', err.message));
    flash(req, 'saved', 'Looking up expiry dates in the background.');
  }
  res.redirect('/cloudflare/domains');
});

router.post('/check', async (req, res) => {
  const result = await runChecks(req.user, { trigger: 'manual' });
  if (result.ok) {
    const extra = result.problems && result.problems.length ? ` Some accounts could not be read: ${result.problems.join('; ')}` : '';
    flash(req, result.problems && result.problems.length ? 'info' : 'saved', `Checked ${result.domains} domain${result.domains === 1 ? '' : 's'} in ${result.accounts} account${result.accounts === 1 ? '' : 's'}: ${result.events} new event${result.events === 1 ? '' : 's'}, ${result.alerts} alert${result.alerts === 1 ? '' : 's'}.${extra}`);
  } else {
    flash(req, 'error', result.error);
  }
  res.redirect(backPath(req, '/cloudflare/domains'));
});

router.post('/domains/:id/check', async (req, res) => {
  const id = requireId(req.params.id);
  const result = await checkDomain(req.user, id);
  if (result.ok) flash(req, 'saved', `Checked ${result.name}: ${result.events ? `${result.events} new event${result.events === 1 ? '' : 's'}` : 'no changes'}.`);
  else flash(req, 'error', result.error);
  res.redirect(backPath(req, `/cloudflare/domains/${id}`));
});

async function domainRow(id) {
  const [[d]] = await pool.query('SELECT d.id, d.name, d.hidden_at, d.client_id, d.client_manual, d.notes, c.name AS client_name FROM domains d LEFT JOIN clients c ON c.id = d.client_id WHERE d.id = ?', [id]);
  if (!d) throw notFound();
  return d;
}

// Hide (hide=1) or unhide: hidden domains are left out of counts and never alert.
router.post('/domains/:id/hide', async (req, res) => {
  const d = await domainRow(requireId(req.params.id));
  const hide = req.body.hide === '1';
  if (Boolean(d.hidden_at) !== hide) {
    if (hide) await pool.query('UPDATE domains SET hidden_at = NOW(), hidden_by = ? WHERE id = ?', [req.user.id, d.id]);
    else await pool.query('UPDATE domains SET hidden_at = NULL, hidden_by = NULL WHERE id = ?', [d.id]);
    await log(req, { id: d.id, action: 'updated', clientId: d.client_id, clientName: d.client_name, summary: `${hide ? 'Hid' : 'Unhid'} the domain ${d.name}` });
  }
  flash(req, 'saved', hide ? `Hidden: ${d.name}. Find it under Hidden.` : `Unhidden: ${d.name}.`);
  res.redirect(backPath(req, '/cloudflare/domains'));
});

// Client, set by hand on the domain page: "" (none) or a client id. Nothing is linked
// automatically (accounts are not linked to clients).
router.post('/domains/:id/client', async (req, res) => {
  const d = await domainRow(requireId(req.params.id));
  const clientId = toId(req.body.client_id);
  let clientName = null;
  if (clientId) {
    const [[c]] = await pool.query('SELECT id, name FROM clients WHERE id = ?', [clientId]);
    if (!c) { flash(req, 'error', 'Choose a client from the list.'); return res.redirect(`/cloudflare/domains/${d.id}`); }
    clientName = c.name;
  }
  await pool.query('UPDATE domains SET client_id = ?, client_manual = 1 WHERE id = ?', [clientId || null, d.id]);
  const after = await domainRow(d.id);
  if (after.client_id !== d.client_id) {
    await log(req, {
      id: d.id, action: 'updated', clientId: after.client_id, clientName: after.client_name,
      summary: `Domain ${d.name}: client ${clientName ? `set to ${clientName}` : 'cleared'}`,
    });
  }
  flash(req, 'saved', after.client_name ? `Saved. ${d.name} is linked to ${after.client_name}.` : `Saved. ${d.name} is not linked to a client.`);
  res.redirect(backPath(req, `/cloudflare/domains/${d.id}`));
});

router.post('/domains/:id/notes', async (req, res) => {
  const d = await domainRow(requireId(req.params.id));
  const notes = str(req.body.notes, 10000);
  if ((d.notes || '') !== notes) {
    await pool.query('UPDATE domains SET notes = ? WHERE id = ?', [notes || null, d.id]);
    await log(req, { id: d.id, action: 'updated', clientId: d.client_id, clientName: d.client_name, summary: `Updated the notes on ${d.name}`, changes: ['notes'] });
  }
  flash(req, 'saved', 'Saved.');
  res.redirect(`/cloudflare/domains/${d.id}#notes`);
});

// ---- Accounts ----
router.get('/accounts', async (req, res) => {
  res.render('cloudflare/accounts', {
    title: 'Cloudflare accounts', nav: 'cloudflare', config: cfConfig(), check: await lastCheck(pool), accounts: await listAccounts(pool),
  });
});

// ---- Settings ----
async function renderSettings(res, settings, error = null, status = 200) {
  const [users] = await pool.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, notify_channels FROM users ORDER BY name");
  res.status(status).render('cloudflare/settings', { title: 'Cloudflare settings', nav: 'cloudflare', settings, users, config: cfConfig(), error });
}
router.get('/settings', async (req, res) => renderSettings(res, await getSettings(pool)));
router.post('/settings', async (req, res) => {
  const before = await getSettings(pool);
  const everyone = req.body.alert_all === '1';
  const ids = [...new Set([].concat(req.body.alert_user_ids || []).map(toId).filter(Boolean))];
  if (!everyone && !ids.length) return renderSettings(res, { ...before, alert_users: '' }, 'Choose who gets Cloudflare alerts (or everyone).', 400);
  const value = everyone ? 'all' : ids.join(',');
  if (String(before.alert_users || 'all') !== value) {
    await saveSetting(pool, 'alert_users', value);
    await log(req, { action: 'updated', summary: `Changed who gets Cloudflare alerts: ${everyone ? 'everyone' : `${ids.length} user${ids.length === 1 ? '' : 's'}`}`, changes: ['alert_users'] });
  }
  flash(req, 'saved', 'Saved. Cloudflare settings updated.');
  res.redirect('/cloudflare/settings');
});

module.exports = router;
