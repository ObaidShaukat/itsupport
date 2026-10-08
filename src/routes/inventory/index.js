// Inventory: Employees, Stock, Writers, Ex Employees, Old Accounts and any tabs added in
// Settings > Inventory tabs. Internal (our own staff, accounts and kit, never clients).
// Every write is activity-logged (inv_record / inv_item / inv_config / inv_secret) but
// never on the Daily Report. Passwords and PINs are encrypted (src/lib/inventory/secrets.js).
const express = require('express');
const { pool } = require('../../db');
const { toId, str } = require('../../lib/http');
const { tabUrl, listTabs, getRecord, logInv } = require('../../lib/inventory/records');
const { isSecret } = require('../../lib/inventory/fields');
const { decrypt, keyStatus } = require('../../lib/inventory/secrets');

const router = express.Router();

// Tabs for the tab bar and the sidebar, and each user's saved column widths (also on
// POSTs, which can render a form again with an error). JSON calls skip it.
router.use(async (req, res, next) => {
  if (req.accepts(['html', 'json']) === 'html') {
    res.locals.invTabs = (await listTabs()).map((t) => ({ ...t, href: tabUrl(t) }));
    const [widths] = await pool.query('SELECT col_key, width FROM inventory_widths WHERE user_id = ?', [req.user.id]);
    res.locals.invWidths = Object.fromEntries(widths.map((w) => [w.col_key, w.width]));
    res.locals.invKey = keyStatus();
  }
  next();
});

router.get('/', async (req, res) => {
  const tabs = await listTabs();
  res.redirect(tabs.length ? tabUrl(tabs[0]) : '/inventory/settings/tabs');
});

// Reveal or copy one password / PIN. Returns the plain value as JSON (the browser hides
// it again after 30 seconds) and logs who saw which field of which record.
router.post('/secret', async (req, res) => {
  const recordId = toId(req.body.record_id);
  const fieldId = toId(req.body.field_id);
  const action = req.body.action === 'copy' ? 'copy' : 'reveal';
  if (!recordId || !fieldId) return res.status(400).json({ ok: false, error: 'Unknown field.' });
  const { record, tab, fields, title } = await getRecord(pool, recordId);
  const field = fields.find((f) => f.id === fieldId);
  if (!field || !isSecret(field)) return res.status(400).json({ ok: false, error: 'Unknown field.' });
  const status = keyStatus();
  if (!status.ok) return res.status(400).json({ ok: false, error: status.message });
  const [[row]] = await pool.query('SELECT value_enc FROM inventory_values WHERE record_id = ? AND field_id = ?', [record.id, field.id]);
  if (!row || !row.value_enc) return res.status(404).json({ ok: false, error: 'Nothing is saved in this field.' });
  let value;
  try {
    value = decrypt(row.value_enc);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  await logInv(null, req.user, {
    type: 'inv_secret', id: record.id, action: action === 'copy' ? 'copied' : 'viewed', subject: title,
    summary: `${action === 'copy' ? 'Copied' : 'Revealed'} ${field.label} for ${title} (${tab.name})`,
    personId: tab.kind === 'employees' ? record.id : null,
  });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, value });
});

// Column widths dragged in any inventory table (per user, not logged: a display preference).
router.post('/widths', async (req, res) => {
  const key = str(req.body.key, 64);
  const width = Math.round(Number(req.body.width));
  if (!/^[a-z0-9:_-]+$/i.test(key) || !Number.isFinite(width)) return res.status(400).json({ ok: false });
  await pool.query(
    'INSERT INTO inventory_widths (user_id, col_key, width) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE width = VALUES(width)',
    [req.user.id, key, Math.min(800, Math.max(50, width))]
  );
  res.json({ ok: true });
});

// Templates and imports first: /stock/template.xlsx and /stock/import must not reach /stock/:id.
router.use(require('./imports'));
router.use(require('./workbook'));
router.use('/stock', require('./stock'));
router.use(require('./settings'));
router.use(require('./fields'));
router.use(require('./records'));

module.exports = router;
