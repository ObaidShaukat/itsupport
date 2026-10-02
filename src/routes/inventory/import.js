// Inventory > Import: upload the .xlsx, preview, then confirm.
// The uploaded file is deleted as soon as it has been read (the multipart middleware
// removes any upload a route does not keep). Only the parsed plan, which never
// contains password/PIN columns, is kept until the import is confirmed or cancelled.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { flash } = require('../../lib/http');
const { UPLOAD_DIR } = require('../../lib/uploads');
const { parseWorkbook, executePlan, planSummary } = require('../../lib/inventory-import');
const cf = require('../../lib/custom-fields');

const router = express.Router();
const PLAN_DIR = path.join(UPLOAD_DIR, 'import-plans');
const planPath = (id) => path.join(PLAN_DIR, `${id}.json`);
const validId = (id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);

function loadPlan(req) {
  const id = req.session.importPlan;
  if (!validId(id) || !fs.existsSync(planPath(id))) return null;
  return JSON.parse(fs.readFileSync(planPath(id), 'utf8'));
}

function discardPlan(req) {
  const id = req.session.importPlan;
  if (validId(id)) fs.rmSync(planPath(id), { force: true });
  delete req.session.importPlan;
}

router.get('/import', (req, res) => {
  res.render('inventory/import/upload', { title: 'Import inventory', hasPlan: Boolean(loadPlan(req)) });
});

router.post('/import', async (req, res) => {
  const file = req.files && req.files.file && req.files.file[0];
  if (req.uploadError || !file) {
    flash(req, 'error', req.uploadError || 'Choose the .xlsx file to import.');
    return res.redirect('/inventory/import');
  }
  if (!/\.xlsx$/i.test(file.originalname)) {
    flash(req, 'error', 'Only .xlsx files can be imported.');
    return res.redirect('/inventory/import');
  }
  let plan;
  try {
    plan = await parseWorkbook(file.path, file.originalname.slice(0, 200));
  } catch (err) {
    console.error('Inventory import could not read the file:', err.message);
    flash(req, 'error', 'That file could not be read as an Excel workbook.');
    return res.redirect('/inventory/import');
  }
  discardPlan(req);
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  const id = crypto.randomUUID();
  fs.writeFileSync(planPath(id), JSON.stringify(plan));
  req.session.importPlan = id;
  // The .xlsx itself is not kept: req.keepUploads is not set, so it is deleted now.
  res.redirect('/inventory/import/preview');
});

router.get('/import/preview', async (req, res) => {
  const plan = loadPlan(req);
  if (!plan) {
    flash(req, 'info', 'Upload the spreadsheet to see a preview.');
    return res.redirect('/inventory/import');
  }
  const people = Object.values(plan.people).sort((a, b) => a.name.localeCompare(b.name));
  const name = (key) => (key && plan.people[key] ? plan.people[key].name : '');
  res.render('inventory/import/preview', {
    title: 'Import preview',
    plan,
    summary: planSummary(plan),
    people,
    stock: Object.values(plan.stock).sort((a, b) => `${a.category} ${a.model}`.localeCompare(`${b.category} ${b.model}`)),
    name,
    personFields: await cf.fieldsFor('person'),
  });
});

router.post('/import/confirm', async (req, res) => {
  const plan = loadPlan(req);
  if (!plan) {
    flash(req, 'error', 'The preview has expired. Upload the file again.');
    return res.redirect('/inventory/import');
  }
  const mappings = {};
  for (const u of plan.unknownColumns) {
    const v = req.body[`map_${u.id.replace(/[^a-z0-9]/gi, '_')}`];
    mappings[u.id] = typeof v === 'string' ? v : 'skip';
  }
  const counts = await executePlan(plan, mappings, req.user);
  discardPlan(req);
  flash(req, 'success', `Import complete: ${counts.people} people added (${counts.peopleUpdated} already existed), `
    + `${counts.assets} assets, ${counts.stock} stock items, ${counts.access} access entries.`);
  res.redirect('/inventory/people');
});

router.post('/import/cancel', (req, res) => {
  discardPlan(req);
  flash(req, 'info', 'Import cancelled. Nothing was changed.');
  res.redirect('/inventory/import');
});

module.exports = router;
