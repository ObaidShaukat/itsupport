// Inventory templates and Excel / CSV import, for every records tab and for Stock:
//   GET  /t/:id/template.xlsx, /stock/template.xlsx   download a template
//   GET  /t/:id/import, /stock/import                 upload page
//   POST /t/:id/import, /stock/import                 parse, stage (encrypted), go to Map
//   GET  /import/:token  ·  POST /import/:token/map    1. map columns
//   GET  /import/:token/preview                        2. preview (nothing written)
//   POST /import/:token/confirm                        3. import in one transaction, summary
//   POST /import/:token/cancel
// The upload is deleted straight after parsing; rows live only in the encrypted stage.
const express = require('express');
const { pool, transaction } = require('../../db');
const { requireId, flash, notFound } = require('../../lib/http');
const { getTab, dataTab, logInv, tabUrl } = require('../../lib/inventory/records');
const { FIELD_TYPES, CATEGORY_TYPES, MASK, isSecret, listFields } = require('../../lib/inventory/fields');
const { keyStatus } = require('../../lib/inventory/secrets');
const { lockEmployees } = require('../../lib/inventory/userids');
const files = require('../../lib/inventory/import-files');
const planner = require('../../lib/inventory/import-plan');
const { recordsTemplate, stockTemplate } = require('../../lib/inventory/template');

const router = express.Router();

const PREVIEW_ROWS = 500;

async function recordsScope(id) {
  const tab = await dataTab(pool, await getTab(pool, id));
  if (tab.kind === 'stock') throw notFound();
  return { kind: 'records', tabId: tab.id, tab, name: tab.name, back: tabUrl(tab) };
}
const stockScope = () => ({ kind: 'stock', name: 'Stock', back: '/inventory/stock' });
async function scopeOf(stage) {
  return stage.scope.kind === 'stock' ? stockScope() : recordsScope(stage.scope.tabId);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- Templates ----

async function sendBook(res, book, name) {
  res.attachment(`${slug(name)}-template.xlsx`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await book.xlsx.write(res);
  res.end();
}
router.get('/t/:id/template.xlsx', async (req, res) => {
  const scope = await recordsScope(requireId(req.params.id));
  await sendBook(res, await recordsTemplate(pool, scope.tab), scope.name);
});
router.get('/stock/template.xlsx', async (req, res) => sendBook(res, await stockTemplate(pool), 'stock'));

// ---- Upload ----

function uploadPage(res, scope, error = null) {
  res.render('inventory/import/upload', {
    title: `Import · ${scope.name}`, area: scope, error, key: keyStatus(),
    templateUrl: scope.kind === 'stock' ? '/inventory/stock/template.xlsx' : `/inventory/t/${scope.tabId}/template.xlsx`,
    action: scope.kind === 'stock' ? '/inventory/stock/import' : `/inventory/t/${scope.tabId}/import`,
  });
}
router.get('/t/:id/import', async (req, res) => uploadPage(res, await recordsScope(requireId(req.params.id))));
router.get('/stock/import', async (req, res) => uploadPage(res, stockScope()));

async function receive(req, res, scope) {
  files.cleanStaging();
  const file = req.files && req.files.file && req.files.file[0];
  try {
    if (req.uploadError) return uploadPage(res.status(400), scope, req.uploadError);
    if (!file) return uploadPage(res.status(400), scope, 'Choose a file to import.');
    if (!keyStatus().ok) return uploadPage(res.status(400), scope, `${keyStatus().message} Imports need it to keep the file's data encrypted while you check it.`);
    const sheet = await files.readSheet(file);
    if (sheet.error) return uploadPage(res.status(400), scope, sheet.error);
    const targets = await planner.targetsFor(pool, scope);
    const token = files.createStage({
      userId: req.user.id, scope: scope.kind === 'stock' ? { kind: 'stock' } : { kind: 'records', tabId: scope.tabId },
      fileName: String(file.originalname || 'import').slice(0, 120), headers: sheet.headers, rows: sheet.rows, examples: sheet.examples || 0,
      mapping: planner.autoMatch(sheet.headers, targets),
    });
    return res.redirect(`/inventory/import/${token}`);
  } finally {
    files.removeUpload(file); // never kept, whatever happened
  }
}
router.post('/t/:id/import', async (req, res) => receive(req, res, await recordsScope(requireId(req.params.id))));
router.post('/stock/import', async (req, res) => receive(req, res, stockScope()));

// ---- 1. Map columns ----

function getStage(req) {
  const stage = files.loadStage(req.params.token, req.user.id);
  if (!stage) throw Object.assign(new Error('This import has finished or expired (imports are kept for an hour). Upload the file again.'), { status: 404 });
  return stage;
}

// Example values for each column (secret-looking ones masked).
function samples(stage, col, secret) {
  const values = stage.rows.map((r) => r[col]).filter(Boolean).slice(0, 3);
  return secret ? values.map(() => MASK) : values;
}

router.get('/import/:token', async (req, res) => {
  const stage = getStage(req);
  const scope = await scopeOf(stage);
  const targets = await planner.targetsFor(pool, scope);
  const secretTargets = new Set(targets.filter((t) => ['password', 'pin'].includes(t.type)).map((t) => t.value));
  const columns = stage.headers.map((h, col) => {
    const m = stage.mapping[col] || { target: 'skip', type: 'text' };
    const secret = secretTargets.has(m.target) || (m.target === 'new' && ['password', 'pin'].includes(m.type)) || /pass|pin/i.test(h);
    return { header: h, mapping: m, samples: samples(stage, col, secret) };
  });
  res.render('inventory/import/map', {
    title: `Import · ${scope.name}`, area: scope, stage, token: req.params.token, columns, targets,
    newTypes: Object.fromEntries((scope.kind === 'stock' ? CATEGORY_TYPES : Object.keys(FIELD_TYPES)).map((t) => [t, FIELD_TYPES[t]])),
    error: req.query.error || null,
  });
});

router.post('/import/:token/map', async (req, res) => {
  const stage = getStage(req);
  const scope = await scopeOf(stage);
  const targets = await planner.targetsFor(pool, scope);
  const allowedTypes = scope.kind === 'stock' ? CATEGORY_TYPES : Object.keys(FIELD_TYPES);
  const mapping = stage.headers.map((h, col) => {
    const target = String(req.body[`map_${col}`] || 'skip');
    const type = allowedTypes.includes(req.body[`type_${col}`]) ? req.body[`type_${col}`] : 'text';
    return { target: ['skip', 'new'].includes(target) || targets.some((t) => t.value === target) ? target : 'skip', type };
  });
  // Each field only once; new fields must not clash with existing names.
  const problems = [];
  const seen = new Map();
  mapping.forEach((m, col) => {
    if (m.target === 'skip' || m.target === 'new') return;
    if (seen.has(m.target)) problems.push(`"${stage.headers[seen.get(m.target)]}" and "${stage.headers[col]}" both go to the same field.`);
    else seen.set(m.target, col);
  });
  const existingLabels = new Set(targets.map((t) => t.norms[0]));
  mapping.forEach((m, col) => {
    if (m.target === 'new' && existingLabels.has(files.normHeader(stage.headers[col]))) {
      problems.push(`A field called "${stage.headers[col]}" already exists: map the column to it instead of creating a new one.`);
    }
  });
  stage.mapping = mapping;
  files.saveStage(req.params.token, stage);
  if (problems.length) return res.redirect(`/inventory/import/${req.params.token}?error=${encodeURIComponent(problems.join(' '))}`);
  res.redirect(`/inventory/import/${req.params.token}/preview`);
});

// ---- 2. Preview ----

async function makePlan(db, stage, scope) {
  if (scope.kind === 'stock') return planner.planStock(db, stage);
  return planner.planRecords(db, { tab: scope.tab, mapping: stage.mapping, headers: stage.headers, rows: stage.rows });
}

router.get('/import/:token/preview', async (req, res) => {
  const stage = getStage(req);
  const scope = await scopeOf(stage);
  const plan = await makePlan(pool, stage, scope);
  const shown = [...plan.rows.filter((r) => r.action === 'skip'), ...plan.rows.filter((r) => r.action !== 'skip')].slice(0, PREVIEW_ROWS);
  res.render('inventory/import/preview', {
    title: `Import · ${scope.name}`, area: scope, stage, token: req.params.token, plan, shown,
  });
});

router.post('/import/:token/cancel', async (req, res) => {
  const stage = files.loadStage(req.params.token, req.user.id);
  files.deleteStage(req.params.token);
  flash(req, 'success', 'Import cancelled. Nothing was changed.');
  res.redirect(stage ? (await scopeOf(stage)).back : '/inventory');
});

// ---- 3. Confirm ----

// CSV of skipped rows with the reasons; password / PIN columns are written as (hidden).
async function errorReport(stage, scope, plan) {
  const skipped = plan.rows.filter((r) => r.action === 'skip');
  if (!skipped.length) return '';
  let secretCols = new Set();
  if (scope.kind === 'records') {
    const fields = await listFields(pool, { tabId: scope.tab.id });
    secretCols = new Set(stage.mapping.map((m, col) => {
      const f = String(m.target).startsWith('f:') ? fields.find((x) => x.id === Number(m.target.slice(2))) : null;
      return (f && isSecret(f)) || (m.target === 'new' && ['password', 'pin'].includes(m.type)) ? col : -1;
    }).filter((c) => c >= 0));
  }
  const cell = (v) => {
    const s = String(v ?? '');
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [['Row', 'Why it was skipped', ...stage.headers]];
  for (const r of skipped) {
    const cells = stage.rows[r.n - 2] || [];
    lines.push([r.n, r.errors.join(' '), ...stage.headers.map((h, col) => (secretCols.has(col) && cells[col] ? '(hidden)' : cells[col] || ''))]);
  }
  return `﻿${lines.map((l) => l.map(cell).join(',')).join('\r\n')}`;
}

router.post('/import/:token/confirm', async (req, res) => {
  const stage = getStage(req);
  const scope = await scopeOf(stage);
  const plan = await transaction(async (conn) => {
    let result;
    if (scope.kind === 'stock') {
      const first = await planner.planStock(conn, stage);
      await planner.prepareStock(conn, req.user, first);
      result = await planner.planStock(conn, stage); // with the new categories / fields
      await planner.applyStock(conn, req.user, { plan: result, fileName: stage.fileName });
    } else {
      if (scope.tab.kind === 'employees') await lockEmployees(conn, scope.tab.id);
      const mapping = await planner.createRecordFields(conn, req.user, { tab: scope.tab, mapping: stage.mapping, headers: stage.headers, rows: stage.rows });
      result = await planner.planRecords(conn, { tab: scope.tab, mapping, headers: stage.headers, rows: stage.rows });
      await planner.applyRecords(conn, req.user, { tab: scope.tab, plan: result, fileName: stage.fileName });
    }
    const c = result.counts;
    await logInv(conn, req.user, {
      type: 'inv_config', action: 'uploaded', subject: scope.name,
      summary: `Imported ${stage.fileName} into ${scope.name}: ${c.create} created, ${c.update} updated, ${c.unchanged} unchanged, ${c.skip} skipped`,
    });
    return result;
  });
  const report = await errorReport(stage, scope, plan);
  files.deleteStage(req.params.token);
  res.render('inventory/import/done', {
    title: `Imported · ${scope.name}`, area: scope, plan, fileName: stage.fileName, report,
    reportName: `${slug(scope.name)}-import-skipped.csv`,
  });
});

module.exports = router;
