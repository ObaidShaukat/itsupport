// The full inventory workbook (one .xlsx, a sheet per tab):
//   GET  /workbook                         export and import page
//   POST /workbook/export                  download (passwords blank unless "Include passwords")
//   POST /workbook/import                  parse every sheet, stage (encrypted), go to Map
//   GET  /workbook/import/:token · POST .../map · GET .../preview · POST .../confirm · POST .../cancel
// Sheets are imported in order (Employees, Stock, Writers, Old Accounts, other tabs, new
// tabs) with the single-tab planner, in one transaction. Exports and imports are logged.
const express = require('express');
const { pool, transaction } = require('../../db');
const { flash } = require('../../lib/http');
const { listTabs, logInv } = require('../../lib/inventory/records');
const { FIELD_TYPES, CATEGORY_TYPES, MASK, isSecret, listFields } = require('../../lib/inventory/fields');
const { keyStatus } = require('../../lib/inventory/secrets');
const files = require('../../lib/inventory/import-files');
const planner = require('../../lib/inventory/import-plan');
const wb = require('../../lib/inventory/workbook');

const router = express.Router();
const PREVIEW_ROWS = 300; // per sheet

router.get('/workbook', async (req, res) => {
  const tabs = await listTabs();
  res.render('inventory/workbook/index', { title: 'Inventory workbook', tabs, key: keyStatus(), error: req.query.error || null });
});

// ---- Export ----

router.post('/workbook/export', async (req, res) => {
  const includeSecrets = req.body.include_passwords === '1';
  if (includeSecrets && !keyStatus().ok) {
    flash(req, 'error', keyStatus().message);
    return res.redirect('/inventory/workbook');
  }
  const { book, sheets, secrets } = await wb.exportWorkbook(pool, { includeSecrets });
  const counts = sheets.map((s) => `${s.name} ${s.rows}`).join(', ');
  await logInv(null, req.user, {
    type: 'inv_config', action: 'exported', subject: 'Inventory workbook',
    summary: includeSecrets
      ? `Exported the inventory workbook WITH passwords and PINs (${secrets} value${secrets === 1 ? '' : 's'} decrypted): ${counts}`
      : `Exported the inventory workbook (passwords and PINs left blank): ${counts}`,
  });
  const date = new Date().toISOString().slice(0, 10);
  res.set('Cache-Control', 'no-store');
  res.attachment(`inventory-${date}${includeSecrets ? '-with-passwords' : ''}.xlsx`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await book.xlsx.write(res);
  res.end();
});

// ---- Import: upload ----

router.post('/workbook/import', async (req, res) => {
  files.cleanStaging();
  const file = req.files && req.files.file && req.files.file[0];
  const back = (msg) => res.redirect(`/inventory/workbook?error=${encodeURIComponent(msg)}#import`);
  try {
    if (req.uploadError) return back(req.uploadError);
    if (!file) return back('Choose a workbook to import.');
    if (!keyStatus().ok) return back(`${keyStatus().message} Imports need it to keep the file's data encrypted while you check it.`);
    const book = await files.readWorkbook(file);
    if (book.error) return back(book.error);
    const tabs = await listTabs();
    const sheets = [];
    for (const s of book.sheets) {
      const match = wb.matchSheet(s.name, tabs);
      const sheet = { ...s, target: match.target, defaultStatus: match.defaultStatus, unknown: Boolean(match.unknown), newTabName: s.name.slice(0, 60) };
      sheet.mapping = await wb.defaultMapping(pool, sheet, tabs);
      sheets.push(sheet);
    }
    const token = files.createStage({ userId: req.user.id, multi: true, fileName: String(file.originalname || 'workbook').slice(0, 120), sheets });
    return res.redirect(`/inventory/workbook/import/${token}`);
  } finally {
    files.removeUpload(file);
  }
});

function getStage(req) {
  const stage = files.loadStage(req.params.token, req.user.id);
  if (!stage || !stage.multi) throw Object.assign(new Error('This import has finished or expired (imports are kept for an hour). Upload the workbook again.'), { status: 404 });
  return stage;
}

// ---- Import: map ----

router.get('/workbook/import/:token', async (req, res) => {
  const stage = getStage(req);
  const tabs = await listTabs();
  const sheets = [];
  for (const [i, sheet] of stage.sheets.entries()) {
    const scope = wb.scopeFor(sheet, tabs);
    const targets = ['records', 'stock'].includes(scope.kind) ? await planner.targetsFor(pool, scope) : [];
    const secretTargets = new Set(targets.filter((t) => ['password', 'pin'].includes(t.type)).map((t) => t.value));
    const columns = sheet.headers.map((h, col) => {
      const m = sheet.mapping[col] || { target: 'skip', type: 'text' };
      const secret = secretTargets.has(m.target) || ['password', 'pin'].includes(m.type) || /pass|\bpin\b/i.test(h);
      const samples = sheet.rows.map((r) => r[col]).filter(Boolean).slice(0, 3);
      return { header: h, mapping: m, samples: secret ? samples.map(() => MASK) : samples };
    });
    sheets.push({ i, sheet, scope, targets, columns, newTypes: scope.kind === 'stock' ? CATEGORY_TYPES : Object.keys(FIELD_TYPES) });
  }
  res.render('inventory/workbook/map', {
    title: 'Import workbook', stage, token: req.params.token, sheets, tabs: tabs.filter((t) => t.kind !== 'ex_employees'),
    fieldTypes: FIELD_TYPES, error: req.query.error || null, notice: req.query.notice || null,
  });
});

router.post('/workbook/import/:token/map', async (req, res) => {
  const stage = getStage(req);
  const tabs = await listTabs();
  const validTargets = new Set(['skip', 'stock', 'newtab', ...tabs.filter((t) => ['employees', 'records'].includes(t.kind)).map((t) => `tab:${t.id}`)]);
  const problems = [];
  let retargeted = false;
  for (const [i, sheet] of stage.sheets.entries()) {
    const target = validTargets.has(req.body[`s${i}_target`]) ? req.body[`s${i}_target`] : sheet.target;
    if (sheet.target === 'newtab' || target === 'newtab') sheet.newTabName = files.normHeader(req.body[`s${i}_tabname`]) ? String(req.body[`s${i}_tabname`]).trim().slice(0, 60) : sheet.name.slice(0, 60);
    if (target !== sheet.target) {
      sheet.target = target;
      sheet.mapping = await wb.defaultMapping(pool, sheet, tabs);
      retargeted = true;
      continue;
    }
    if (target === 'skip') continue;
    const scope = wb.scopeFor(sheet, tabs);
    const targets = scope.kind === 'newtab' ? [] : await planner.targetsFor(pool, scope);
    const allowedTypes = scope.kind === 'stock' ? CATEGORY_TYPES : Object.keys(FIELD_TYPES);
    sheet.mapping = sheet.headers.map((h, col) => {
      const t = String(req.body[`s${i}_map_${col}`] || 'skip');
      const type = allowedTypes.includes(req.body[`s${i}_type_${col}`]) ? req.body[`s${i}_type_${col}`] : 'text';
      return { target: ['skip', 'new'].includes(t) || targets.some((x) => x.value === t) ? t : 'skip', type };
    });
    const seen = new Map();
    sheet.mapping.forEach((m, col) => {
      if (m.target === 'skip' || m.target === 'new') return;
      if (seen.has(m.target)) problems.push(`${sheet.name}: "${sheet.headers[seen.get(m.target)]}" and "${sheet.headers[col]}" both go to the same field.`);
      else seen.set(m.target, col);
    });
    const existing = new Set(targets.map((t) => t.norms[0]));
    const newLabels = new Set();
    sheet.mapping.forEach((m, col) => {
      if (m.target !== 'new') return;
      const n = files.normHeader(sheet.headers[col]);
      if (existing.has(n)) problems.push(`${sheet.name}: a field called "${sheet.headers[col]}" already exists; map the column to it.`);
      else if (newLabels.has(n)) problems.push(`${sheet.name}: two columns are called "${sheet.headers[col]}".`);
      newLabels.add(n);
    });
    if (scope.kind === 'newtab' && !sheet.mapping.some((m) => m.target === 'new')) problems.push(`${sheet.name}: choose at least one column for the new tab.`);
  }
  files.saveStage(req.params.token, stage);
  const url = `/inventory/workbook/import/${req.params.token}`;
  if (problems.length) return res.redirect(`${url}?error=${encodeURIComponent(problems.join(' '))}`);
  if (retargeted) return res.redirect(`${url}?notice=${encodeURIComponent('The columns of the sheets you pointed at a different tab were matched again. Check them, then preview.')}`);
  if (!stage.sheets.some((s) => s.target !== 'skip')) return res.redirect(`${url}?error=${encodeURIComponent('Every sheet is skipped: choose where at least one should go.')}`);
  res.redirect(`${url}/preview`);
});

// ---- Import: preview, confirm, cancel ----

router.get('/workbook/import/:token/preview', async (req, res) => {
  const stage = getStage(req);
  const results = await wb.planAll(pool, stage, req.user);
  const totals = { create: 0, update: 0, unchanged: 0, skip: 0 };
  for (const r of results) for (const k of Object.keys(totals)) totals[k] += r.plan.counts[k];
  const skippedSheets = stage.sheets.filter((s) => s.target === 'skip');
  res.render('inventory/workbook/preview', {
    title: 'Import workbook', stage, token: req.params.token, results, totals, skippedSheets, previewRows: PREVIEW_ROWS,
  });
});

router.post('/workbook/import/:token/cancel', async (req, res) => {
  files.deleteStage(req.params.token);
  flash(req, 'success', 'Import cancelled. Nothing was changed.');
  res.redirect('/inventory/workbook');
});

// Skipped rows of every sheet as one CSV; password / PIN cells written as (hidden).
async function errorReport(results) {
  const cell = (v) => {
    const s = String(v ?? '');
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [['Sheet', 'Row', 'Why it was skipped', 'Values']];
  for (const { sheet, scope, plan } of results) {
    const skipped = plan.rows.filter((r) => r.action === 'skip');
    if (!skipped.length) continue;
    let fields = [];
    if (scope.kind === 'records') fields = await listFields(pool, { tabId: scope.tab.id });
    const secretCol = sheet.mapping.map((m, col) => {
      const f = String(m.target).startsWith('f:') ? fields.find((x) => x.id === Number(m.target.slice(2))) : null;
      return Boolean((f && isSecret(f)) || (m.target === 'new' && ['password', 'pin'].includes(m.type)) || /pass|\bpin\b/i.test(sheet.headers[col]));
    });
    for (const r of skipped) {
      const cells = sheet.rows[r.n - 2] || [];
      const values = sheet.headers.map((h, col) => (cells[col] ? `${h}: ${secretCol[col] ? '(hidden)' : cells[col]}` : null)).filter(Boolean).join('; ');
      lines.push([sheet.name, r.n, r.errors.join(' '), values]);
    }
  }
  return lines.length > 1 ? `﻿${lines.map((l) => l.map(cell).join(',')).join('\r\n')}` : '';
}

router.post('/workbook/import/:token/confirm', async (req, res) => {
  const stage = getStage(req);
  const results = await transaction(async (conn) => {
    const out = await wb.planAll(conn, stage, req.user, { apply: true });
    const totals = out.reduce((t, r) => ({ c: t.c + r.plan.counts.create, u: t.u + r.plan.counts.update, s: t.s + r.plan.counts.skip }), { c: 0, u: 0, s: 0 });
    await logInv(conn, req.user, {
      type: 'inv_config', action: 'uploaded', subject: 'Inventory workbook',
      summary: `Imported the workbook ${stage.fileName} (${out.length} sheet${out.length === 1 ? '' : 's'}): ${totals.c} created, ${totals.u} updated, ${totals.s} skipped`,
    });
    return out;
  });
  const report = await errorReport(results);
  files.deleteStage(req.params.token);
  res.render('inventory/workbook/done', { title: 'Workbook imported', stage, results, report });
});

module.exports = router;
