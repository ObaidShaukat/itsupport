// GDAP expiry monitoring (read only from Microsoft Graph): the list with summary cards,
// filters and search, Sync now, linking customers to clients, and settings (Partner
// Center link, who gets alerts, daily digest, client secret expiry date).
const express = require('express');
const { pool } = require('../db');
const { str, requireId, toId, flash, safePath } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { gdapConfig } = require('../lib/gdap/graph');
const {
  listRelationships, lastSync, getSettings, saveSetting, LIVE, DEFAULT_PARTNER_URL, alertDays,
} = require('../lib/gdap/data');
const { syncGdap, setLink } = require('../lib/gdap/sync');

const router = express.Router();

// Hidden relationships are left out of every view and count except "Hidden".
const shown = (r) => !r.hidden && !r.removed;
const FILTERS = {
  all: { label: 'All', test: shown },
  expiring30: { label: 'Expiring in 30 days', test: (r) => shown(r) && LIVE.has(r.status) && !r.expired && r.days !== null && r.days <= 30 },
  expired: { label: 'Expired', test: (r) => shown(r) && (r.expired || r.status === 'expired') },
  active: { label: 'Active', test: (r) => shown(r) && r.status === 'active' && !r.expired },
  global: { label: 'Has Global Admin', test: (r) => shown(r) && r.hasGlobal },
  noextend: { label: 'Auto-extend off', test: (r) => shown(r) && !r.autoExtend },
  removed: { label: 'Removed', test: (r) => !r.hidden && r.removed },
  // Customers (by tenant) with two or more visible relationships.
  multiple: { label: 'Multiple relationships', test: (r) => shown(r) && r.groupSize >= 2 },
  hidden: { label: 'Hidden', test: (r) => r.hidden },
};

// "Multiple relationships": customer A-Z, then newest end date first within a customer.
function groupOrder(rows) {
  const name = (r) => (r.customer_name || r.display_name || '').toLowerCase();
  return [...rows].sort((a, b) => name(a).localeCompare(name(b)) || a.customerKey.localeCompare(b.customerKey)
    || (b.end_at ? new Date(b.end_at).getTime() : 0) - (a.end_at ? new Date(a.end_at).getTime() : 0));
}

router.get('/', async (req, res) => {
  const filter = Object.hasOwn(FILTERS, req.query.f) ? req.query.f : 'all';
  const { settings, rows } = await listRelationships(pool);
  const live = rows.filter((r) => shown(r) && LIVE.has(r.status));
  const summary = {
    active: rows.filter(FILTERS.active.test).length,
    soon30: live.filter((r) => !r.expired && r.days !== null && r.days <= 30).length,
    soon7: live.filter((r) => !r.expired && r.days !== null && r.days <= 7).length,
    expired: rows.filter(FILTERS.expired.test).length,
  };
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, rows.filter(f.test).length]));
  // Customers with several relationships, counted once each for the pill.
  counts.multiple = new Set(rows.filter(FILTERS.multiple.test).map((r) => r.customerKey)).size;
  const supersededCount = rows.filter((r) => shown(r) && r.superseded).length;
  let list = rows.filter(FILTERS[filter].test);
  if (filter === 'multiple') list = groupOrder(list);
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  res.render('gdap/index', {
    title: 'GDAP', nav: 'gdap', config: gdapConfig(), sync: await lastSync(pool), settings, filter, filters: FILTERS, counts,
    summary, rows: list, clients, supersededCount, grouped: filter === 'multiple',
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

const relLabel = (r) => `${r.customer_name || 'Unknown customer'} – ${r.display_name || r.relationship_id}`;

// Hide (hide=1) or unhide one relationship. Hidden ones are left out of views, counts
// and every alert; the choice is per relationship, not per customer.
router.post('/:id/hide', async (req, res) => {
  const id = requireId(req.params.id);
  const hide = req.body.hide === '1';
  const [[rel]] = await pool.query(`
    SELECT g.id, g.relationship_id, g.customer_name, g.display_name, g.hidden_at, g.client_id, c.name AS client_name
    FROM gdap_relationships g LEFT JOIN clients c ON c.id = g.client_id WHERE g.id = ?
  `, [id]);
  if (!rel) {
    flash(req, 'error', 'That GDAP relationship no longer exists.');
    return res.redirect('/gdap');
  }
  if (Boolean(rel.hidden_at) !== hide) {
    if (hide) await pool.query('UPDATE gdap_relationships SET hidden_at = NOW(), hidden_by = ? WHERE id = ?', [req.user.id, id]);
    else await pool.query('UPDATE gdap_relationships SET hidden_at = NULL, hidden_by = NULL WHERE id = ?', [id]);
    await logActivity(null, req.user, {
      type: 'gdap', id, action: 'updated', subject: 'GDAP', clientId: rel.client_id, clientName: rel.client_name,
      summary: `${hide ? 'Hid' : 'Unhid'} the GDAP relationship ${relLabel(rel)}`,
    });
  }
  flash(req, 'saved', hide ? `Hidden: ${relLabel(rel)}. Find it under Hidden.` : `Unhidden: ${relLabel(rel)}.`);
  res.redirect(safePath(req.body.back, '/gdap'));
});

// Hides every expired relationship whose customer has an active one.
router.post('/hide-superseded', async (req, res) => {
  const { rows } = await listRelationships(pool);
  const targets = rows.filter((r) => !r.hidden && !r.removed && r.superseded);
  if (targets.length) {
    await pool.query('UPDATE gdap_relationships SET hidden_at = NOW(), hidden_by = ? WHERE id IN (?) AND hidden_at IS NULL', [req.user.id, targets.map((r) => r.id)]);
    for (const r of targets) {
      await logActivity(null, req.user, {
        type: 'gdap', id: r.id, action: 'updated', subject: 'GDAP', clientId: r.client_id, clientName: r.client_name,
        summary: `Hid the superseded GDAP relationship ${relLabel(r)} (Hide all superseded)`,
      });
    }
  }
  flash(req, 'saved', targets.length ? `Hidden ${targets.length} superseded relationship${targets.length === 1 ? '' : 's'}. Find them under Hidden.` : 'No superseded relationships to hide.');
  res.redirect(safePath(req.body.back, '/gdap'));
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
  const daysText = str(req.body.alert_days, 100);
  const days = alertDays({ alert_days: daysText });
  const badDays = daysText.split(/[\s,;]+/).filter(Boolean).some((d) => !/^\d+$/.test(d) || Number(d) < 1 || Number(d) > 365);
  const expiredAlert = req.body.alert_expired === '1' ? '1' : '0';
  let error = null;
  if (!/^https:\/\/[^\s]+$/.test(url) || !url.includes('{tenantId}')) error = 'The Partner Center link must start with https:// and contain {tenantId} where the customer\'s tenant id goes.';
  else if (!everyone && !ids.length) error = 'Choose who gets GDAP alerts (or everyone).';
  else if (secret && !/^\d{4}-\d{2}-\d{2}$/.test(secret)) error = 'Enter the client secret expiry as a date.';
  else if (badDays) error = 'Alert days must be whole numbers from 1 to 365, separated by commas (e.g. 30, 14, 7, 1).';
  else if (!days.length && expiredAlert === '0') error = 'Choose at least one alert day, or alert on expiry.';
  if (error) {
    const [users] = await pool.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, notify_channels FROM users ORDER BY name");
    const settings = { ...before, partner_center_url: url, alert_users: everyone ? 'all' : ids.join(','), digest, secret_expires_on: secret, alert_days: daysText, alert_expired: expiredAlert };
    return res.status(400).render('gdap/settings', { title: 'GDAP settings', nav: 'gdap', settings, users, config: gdapConfig(), defaultUrl: DEFAULT_PARTNER_URL, error });
  }
  const next = {
    partner_center_url: url, alert_users: everyone ? 'all' : ids.join(','), digest, secret_expires_on: secret, alert_days: days.join(','), alert_expired: expiredAlert,
  };
  const changes = Object.keys(next).filter((k) => String(before[k] || '') !== String(next[k] || ''));
  for (const k of changes) await saveSetting(pool, k, next[k]);
  if (changes.length) {
    const labels = { partner_center_url: 'Partner Center link', alert_users: 'alert recipients', digest: `daily digest ${digest === '1' ? 'on' : 'off'}`, secret_expires_on: `client secret expiry ${secret || 'cleared'}`, alert_days: `alert days ${days.join(', ') || 'none'}`, alert_expired: `alert on expiry ${expiredAlert === '1' ? 'on' : 'off'}` };
    await logActivity(null, req.user, { type: 'gdap', action: 'updated', subject: 'GDAP', summary: `Changed GDAP settings: ${changes.map((k) => labels[k]).join(', ')}`, changes });
  }
  flash(req, 'saved', changes.length ? 'Saved. GDAP settings updated.' : 'Saved. Nothing changed.');
  res.redirect('/gdap/settings');
});

module.exports = router;
