// GDAP expiry monitoring (read only from Microsoft Graph): the list with summary cards,
// filters and search, Sync now, linking customers to clients, and settings (Partner
// Center link, who gets alerts, daily digest, client secret expiry date).
const express = require('express');
const { pool } = require('../db');
const { str, requireId, toId, flash, safePath } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { gdapConfig } = require('../lib/gdap/graph');
const {
  listRelationships, lastSync, getSettings, saveSetting, LIVE, DEFAULT_PARTNER_URL,
} = require('../lib/gdap/data');
const { syncGdap, setLink } = require('../lib/gdap/sync');

const router = express.Router();

const FILTERS = {
  all: { label: 'All', test: (r) => !r.removed },
  expiring30: { label: 'Expiring in 30 days', test: (r) => !r.removed && LIVE.has(r.status) && !r.expired && r.days !== null && r.days <= 30 },
  expired: { label: 'Expired', test: (r) => !r.removed && (r.expired || r.status === 'expired') },
  active: { label: 'Active', test: (r) => !r.removed && r.status === 'active' && !r.expired },
  global: { label: 'Has Global Admin', test: (r) => !r.removed && r.hasGlobal },
  noextend: { label: 'Auto-extend off', test: (r) => !r.removed && !r.autoExtend },
  removed: { label: 'Removed', test: (r) => r.removed },
};

router.get('/', async (req, res) => {
  const filter = Object.hasOwn(FILTERS, req.query.f) ? req.query.f : 'all';
  const { settings, rows } = await listRelationships(pool);
  const live = rows.filter((r) => !r.removed && LIVE.has(r.status));
  const summary = {
    active: rows.filter(FILTERS.active.test).length,
    soon30: live.filter((r) => !r.expired && r.days !== null && r.days <= 30).length,
    soon7: live.filter((r) => !r.expired && r.days !== null && r.days <= 7).length,
    expired: rows.filter(FILTERS.expired.test).length,
  };
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, rows.filter(f.test).length]));
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  res.render('gdap/index', {
    title: 'GDAP', nav: 'gdap', config: gdapConfig(), sync: await lastSync(pool), settings, filter, filters: FILTERS, counts,
    summary, rows: rows.filter(FILTERS[filter].test), clients,
  });
});

router.post('/sync', async (req, res) => {
  const result = await syncGdap(req.user, { trigger: 'manual' });
  if (result.ok) {
    flash(req, 'saved', `Synced ${result.count} GDAP relationship${result.count === 1 ? '' : 's'}${result.alerts ? `, ${result.alerts} alert${result.alerts === 1 ? '' : 's'} sent` : ''}.`);
  } else {
    flash(req, 'error', result.error);
  }
  res.redirect('/gdap');
});

// Link to client: a client id, "" for not linked, or "auto" for automatic matching.
router.post('/:id/link', async (req, res) => {
  const id = requireId(req.params.id);
  const choice = String(req.body.client_id || '');
  const result = await setLink(req.user, id, choice === 'auto' ? { auto: true } : { clientId: toId(choice) });
  if (result.error) flash(req, 'error', result.error);
  else flash(req, 'saved', result.client ? `Saved. Linked to ${result.client.name}.` : 'Saved. Not linked to a client.');
  res.redirect(safePath(req.body.back, `/gdap#gdap-${id}`));
});

router.get('/settings', async (req, res) => {
  const settings = await getSettings(pool);
  const [users] = await pool.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, notify_channels FROM users ORDER BY name");
  res.render('gdap/settings', { title: 'GDAP settings', nav: 'gdap', settings, users, config: gdapConfig(), defaultUrl: DEFAULT_PARTNER_URL, error: null });
});

router.post('/settings', async (req, res) => {
  const before = await getSettings(pool);
  const url = str(req.body.partner_center_url, 500) || DEFAULT_PARTNER_URL;
  const everyone = req.body.alert_all === '1';
  const ids = [...new Set([].concat(req.body.alert_user_ids || []).map(toId).filter(Boolean))];
  const digest = req.body.digest === '1' ? '1' : '0';
  const secret = str(req.body.secret_expires_on, 10);
  let error = null;
  if (!/^https:\/\/[^\s]+$/.test(url) || !url.includes('{tenantId}')) error = 'The Partner Center link must start with https:// and contain {tenantId} where the customer\'s tenant id goes.';
  else if (!everyone && !ids.length) error = 'Choose who gets GDAP alerts (or everyone).';
  else if (secret && !/^\d{4}-\d{2}-\d{2}$/.test(secret)) error = 'Enter the client secret expiry as a date.';
  if (error) {
    const [users] = await pool.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, notify_channels FROM users ORDER BY name");
    const settings = { ...before, partner_center_url: url, alert_users: everyone ? 'all' : ids.join(','), digest, secret_expires_on: secret };
    return res.status(400).render('gdap/settings', { title: 'GDAP settings', nav: 'gdap', settings, users, config: gdapConfig(), defaultUrl: DEFAULT_PARTNER_URL, error });
  }
  const next = { partner_center_url: url, alert_users: everyone ? 'all' : ids.join(','), digest, secret_expires_on: secret };
  const changes = Object.keys(next).filter((k) => String(before[k] || '') !== String(next[k] || ''));
  for (const k of changes) await saveSetting(pool, k, next[k]);
  if (changes.length) {
    const labels = { partner_center_url: 'Partner Center link', alert_users: 'alert recipients', digest: `daily digest ${digest === '1' ? 'on' : 'off'}`, secret_expires_on: `client secret expiry ${secret || 'cleared'}` };
    await logActivity(null, req.user, { type: 'gdap', action: 'updated', subject: 'GDAP', summary: `Changed GDAP settings: ${changes.map((k) => labels[k]).join(', ')}`, changes });
  }
  flash(req, 'saved', changes.length ? 'Saved. GDAP settings updated.' : 'Saved. Nothing changed.');
  res.redirect('/gdap/settings');
});

module.exports = router;
