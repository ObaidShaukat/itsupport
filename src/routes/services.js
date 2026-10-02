// Service catalogue: categories > services > steps.
// Categories and services are listed A-Z; steps keep the order they were added in.
const express = require('express');
const { pool, transaction } = require('../db');
const { HttpError, str, requireId, toId, flash, notFound } = require('../lib/http');
const { nextStepPosition } = require('../lib/order');
const { buildFlowchart } = require('../lib/mermaid');
const { receivedFiles, removeStoredFiles, discardUploads } = require('../lib/uploads');
const { logActivity, historyFor, recordMeta } = require('../lib/activity');

const router = express.Router();

const isDuplicate = (err) => err.code === 'ER_DUP_ENTRY';

// Logs against a service (steps and tutorials appear in the service's History).
async function logService(req, serviceId, action, summary, type = 'service') {
  const [[service]] = await pool.query('SELECT name FROM services WHERE id = ?', [serviceId]);
  await logActivity(null, req.user, { type, id: serviceId, action, subject: service ? service.name : null, summary });
}

// Category changes have no History panel of their own, so entity_id stays empty.
const logCategory = (req, action, name, summary) => logActivity(null, req.user, {
  type: 'service', action, subject: name, summary,
});

// ---- Overview ----

router.get('/services', async (req, res) => {
  const [categories] = await pool.query('SELECT id, name FROM service_categories ORDER BY name');
  const [services] = await pool.query(`
    SELECT s.id, s.name, s.category_id, COUNT(st.id) AS step_count
    FROM services s
    LEFT JOIN service_steps st ON st.service_id = s.id
    GROUP BY s.id, s.name, s.category_id
    ORDER BY s.name
  `);
  for (const category of categories) {
    category.services = services.filter((s) => s.category_id === category.id);
  }
  res.render('services/index', { title: 'Services', categories });
});

// ---- Categories ----

router.post('/categories', async (req, res) => {
  const name = str(req.body.name, 150);
  if (!name) {
    flash(req, 'error', 'Category name is required.');
    return res.redirect('/services');
  }
  try {
    await pool.query('INSERT INTO service_categories (name) VALUES (?)', [name]);
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `A category called "${name}" already exists.`);
    return res.redirect('/services');
  }
  await logCategory(req, 'created', name, `Added service category ${name}`);
  flash(req, 'success', `Category "${name}" added.`);
  res.redirect('/services');
});

router.get('/categories/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[category]] = await pool.query('SELECT id, name FROM service_categories WHERE id = ?', [id]);
  if (!category) throw notFound();
  const [services] = await pool.query(`
    SELECT s.id, s.name, s.description, COUNT(st.id) AS step_count
    FROM services s
    LEFT JOIN service_steps st ON st.service_id = s.id
    WHERE s.category_id = ?
    GROUP BY s.id, s.name, s.description
    ORDER BY s.name
  `, [id]);
  res.render('services/category', { title: category.name, category, services });
});

router.post('/categories/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const name = str(req.body.name, 150);
  if (!name) {
    flash(req, 'error', 'Category name is required.');
    return res.redirect(`/categories/${id}`);
  }
  const [[before]] = await pool.query('SELECT name FROM service_categories WHERE id = ?', [id]);
  if (!before) throw notFound();
  try {
    await pool.query('UPDATE service_categories SET name = ? WHERE id = ?', [name, id]);
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `A category called "${name}" already exists.`);
    return res.redirect(`/categories/${id}`);
  }
  if (before.name !== name) await logCategory(req, 'updated', name, `Renamed category ${before.name} to ${name}`);
  flash(req, 'success', 'Category renamed.');
  res.redirect(`/categories/${id}`);
});

router.post('/categories/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [files] = await pool.query(`
    SELECT t.file_name FROM service_tutorials t
    JOIN services s ON s.id = t.service_id
    WHERE s.category_id = ?
  `, [id]);
  const [[category]] = await pool.query('SELECT name FROM service_categories WHERE id = ?', [id]);
  if (!category) return res.redirect('/services');
  await pool.query('DELETE FROM service_categories WHERE id = ?', [id]);
  await logCategory(req, 'deleted', category.name, `Deleted category ${category.name} and its services`);
  await removeStoredFiles(files.map((f) => f.file_name));
  flash(req, 'success', 'Category deleted.');
  res.redirect('/services');
});

// ---- Services ----

router.post('/categories/:id/services', async (req, res) => {
  const categoryId = requireId(req.params.id);
  const name = str(req.body.name, 200);
  const description = str(req.body.description, 5000) || null;
  if (!name) {
    flash(req, 'error', 'Service name is required.');
    return res.redirect(`/categories/${categoryId}`);
  }

  let serviceId;
  try {
    const [[category]] = await pool.query('SELECT id FROM service_categories WHERE id = ?', [categoryId]);
    if (!category) throw notFound();
    const [result] = await pool.query(
      'INSERT INTO services (category_id, name, description) VALUES (?, ?, ?)',
      [categoryId, name, description]
    );
    serviceId = result.insertId;
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `This category already has a service called "${name}".`);
    return res.redirect(`/categories/${categoryId}`);
  }
  await logService(req, serviceId, 'created', `Added service ${name}`);
  flash(req, 'success', `Service "${name}" added. Now add its steps.`);
  res.redirect(`/services/${serviceId}`);
});

router.get('/services/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[service]] = await pool.query(`
    SELECT s.id, s.name, s.description, s.report_phrase, s.category_id, c.name AS category_name
    FROM services s
    JOIN service_categories c ON c.id = s.category_id
    WHERE s.id = ?
  `, [id]);
  if (!service) throw notFound();
  const [steps] = await pool.query(
    'SELECT id, title FROM service_steps WHERE service_id = ? ORDER BY position, id',
    [id]
  );
  const [categories] = await pool.query('SELECT id, name FROM service_categories ORDER BY name');
  const [tutorials] = await pool.query(`
    SELECT t.id, t.title, t.description, t.file_name, t.original_name, t.size_bytes, t.kind,
           t.created_at, t.updated_at, u.username AS uploaded_by
    FROM service_tutorials t
    LEFT JOIN users u ON u.id = t.uploaded_by
    WHERE t.service_id = ?
    ORDER BY t.title, t.id
  `, [id]);
  const activity = await historyFor(['service', 'tutorial'], [id]);
  const meta = recordMeta(activity, 'service');
  res.render('services/show', {
    title: service.name,
    activity,
    meta,
    tab: req.query.tab === 'tutorials' ? 'tutorials' : 'steps',
    service,
    steps,
    categories,
    tutorials,
    flowchart: buildFlowchart(steps),
  });
});

router.post('/services/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const name = str(req.body.name, 200);
  const description = str(req.body.description, 5000) || null;
  const categoryId = toId(req.body.category_id);
  // Wording used in the Daily Report; blank means the service name is used.
  const reportPhrase = str(req.body.report_phrase, 255) || null;
  if (!name) {
    flash(req, 'error', 'Service name is required.');
    return res.redirect(`/services/${id}`);
  }

  try {
    await transaction(async (conn) => {
      const [[service]] = await conn.query('SELECT id, category_id FROM services WHERE id = ? FOR UPDATE', [id]);
      if (!service) throw notFound();

      let newCategory = service.category_id;
      if (categoryId && categoryId !== service.category_id) {
        const [[category]] = await conn.query('SELECT id FROM service_categories WHERE id = ?', [categoryId]);
        if (category) newCategory = category.id;
      }
      await conn.query(
        'UPDATE services SET name = ?, description = ?, report_phrase = ?, category_id = ? WHERE id = ?',
        [name, description, reportPhrase, newCategory, id]
      );
    });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `That category already has a service called "${name}".`);
    return res.redirect(`/services/${id}`);
  }
  await logService(req, id, 'updated', `Updated service details for ${name}`);
  flash(req, 'success', 'Service updated.');
  res.redirect(`/services/${id}`);
});

router.post('/services/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[service]] = await pool.query('SELECT category_id, name FROM services WHERE id = ?', [id]);
  if (!service) return res.redirect('/services');
  const [files] = await pool.query('SELECT file_name FROM service_tutorials WHERE service_id = ?', [id]);
  await logService(req, id, 'deleted', `Deleted service ${service.name}`);
  await pool.query('DELETE FROM services WHERE id = ?', [id]);
  await removeStoredFiles(files.map((f) => f.file_name));
  flash(req, 'success', 'Service deleted.');
  res.redirect(`/categories/${service.category_id}`);
});

// ---- Steps ----

router.post('/services/:id/steps', async (req, res) => {
  const serviceId = requireId(req.params.id);
  const title = str(req.body.title, 500);
  if (!title) {
    flash(req, 'error', 'Step text is required.');
    return res.redirect(`/services/${serviceId}#steps`);
  }
  await transaction(async (conn) => {
    const [[service]] = await conn.query('SELECT id FROM services WHERE id = ? FOR UPDATE', [serviceId]);
    if (!service) throw notFound();
    const position = await nextStepPosition(conn, serviceId);
    await conn.query(
      'INSERT INTO service_steps (service_id, title, position) VALUES (?, ?, ?)',
      [serviceId, title, position]
    );
  });
  await logService(req, serviceId, 'updated', `Added step: ${title}`);
  res.redirect(`/services/${serviceId}#steps`);
});

// Saves a drag-and-drop reorder. Expects order=<step ids, comma-separated> covering
// every step of the service; replies with the rebuilt flowchart.
router.post('/services/:id/steps/order', async (req, res) => {
  const serviceId = requireId(req.params.id);
  const order = str(req.body.order, 20000).split(',').map(toId);

  const steps = await transaction(async (conn) => {
    const [[service]] = await conn.query('SELECT id FROM services WHERE id = ? FOR UPDATE', [serviceId]);
    if (!service) throw notFound();
    const [rows] = await conn.query(
      'SELECT id, title FROM service_steps WHERE service_id = ? ORDER BY position, id',
      [serviceId]
    );
    const current = new Set(rows.map((r) => r.id));
    const valid = order.length === rows.length && new Set(order).size === order.length && order.every((sid) => current.has(sid));
    if (!valid) throw new HttpError(409, 'The steps changed since this page loaded. Refresh and try again.');

    for (let i = 0; i < order.length; i++) {
      await conn.query('UPDATE service_steps SET position = ? WHERE id = ?', [i, order[i]]);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    return order.map((sid) => byId.get(sid));
  });

  await logService(req, serviceId, 'updated', 'Reordered steps');
  res.json({ ok: true, flowchart: buildFlowchart(steps) });
});

async function stepServiceId(id) {
  const [[step]] = await pool.query('SELECT service_id FROM service_steps WHERE id = ?', [id]);
  if (!step) throw notFound();
  return step.service_id;
}

router.post('/steps/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const serviceId = await stepServiceId(id);
  const title = str(req.body.title, 500);
  if (!title) {
    flash(req, 'error', 'Step text is required.');
  } else {
    await pool.query('UPDATE service_steps SET title = ? WHERE id = ?', [title, id]);
    await logService(req, serviceId, 'updated', `Edited step: ${title}`);
  }
  res.redirect(`/services/${serviceId}#steps`);
});

router.post('/steps/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const serviceId = await stepServiceId(id);
  const [[step]] = await pool.query('SELECT title FROM service_steps WHERE id = ?', [id]);
  await pool.query('DELETE FROM service_steps WHERE id = ?', [id]);
  await logService(req, serviceId, 'updated', `Deleted step: ${step ? step.title : ''}`);
  res.redirect(`/services/${serviceId}#steps`);
});

// ---- Tutorials (files on a service) ----

const tutorialsTab = (serviceId) => `/services/${serviceId}?tab=tutorials`;

router.post('/services/:id/tutorials', async (req, res) => {
  const serviceId = requireId(req.params.id);
  const [file] = receivedFiles(req, 'file');
  const title = str(req.body.title, 255);
  const description = str(req.body.description, 5000) || null;

  let problem = req.uploadError;
  if (!problem && !file) problem = 'Choose a file to upload.';
  if (!problem && !title) problem = 'Title is required.';
  const [[service]] = await pool.query('SELECT id FROM services WHERE id = ?', [serviceId]);
  if (!service) {
    await discardUploads(req);
    throw notFound();
  }
  if (problem) {
    await discardUploads(req);
    flash(req, 'error', problem);
    return res.redirect(tutorialsTab(serviceId));
  }

  await pool.query(`
    INSERT INTO service_tutorials (service_id, title, description, file_name, original_name, size_bytes, kind, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [serviceId, title, description, file.file_name, file.original_name, file.size_bytes, file.kind, req.user.id]);
  req.keepUploads = true;
  await logService(req, serviceId, 'uploaded', `Uploaded tutorial ${title} (${file.original_name})`, 'tutorial');
  flash(req, 'success', `Tutorial "${title}" added.`);
  res.redirect(tutorialsTab(serviceId));
});

// Updates the title/description and, if a new file was chosen, replaces the file.
router.post('/tutorials/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[tutorial]] = await pool.query('SELECT id, service_id, file_name FROM service_tutorials WHERE id = ?', [id]);
  if (!tutorial) {
    await discardUploads(req);
    throw notFound();
  }
  const [file] = receivedFiles(req, 'file');
  const title = str(req.body.title, 255);
  const description = str(req.body.description, 5000) || null;
  const problem = req.uploadError || (!title ? 'Title is required.' : null);
  if (problem) {
    await discardUploads(req);
    flash(req, 'error', problem);
    return res.redirect(tutorialsTab(tutorial.service_id));
  }

  if (file) {
    await pool.query(`
      UPDATE service_tutorials
      SET title = ?, description = ?, file_name = ?, original_name = ?, size_bytes = ?, kind = ?, updated_at = NOW()
      WHERE id = ?
    `, [title, description, file.file_name, file.original_name, file.size_bytes, file.kind, id]);
    req.keepUploads = true;
    await removeStoredFiles([tutorial.file_name]);
  } else {
    await pool.query(
      'UPDATE service_tutorials SET title = ?, description = ?, updated_at = NOW() WHERE id = ?',
      [title, description, id]
    );
  }
  await logService(req, tutorial.service_id, file ? 'uploaded' : 'updated',
    file ? `Replaced the file for tutorial ${title} (${file.original_name})` : `Edited tutorial ${title}`, 'tutorial');
  flash(req, 'success', 'Tutorial updated.');
  res.redirect(tutorialsTab(tutorial.service_id));
});

router.post('/tutorials/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[tutorial]] = await pool.query('SELECT service_id, title, file_name FROM service_tutorials WHERE id = ?', [id]);
  if (!tutorial) throw notFound();
  await pool.query('DELETE FROM service_tutorials WHERE id = ?', [id]);
  await removeStoredFiles([tutorial.file_name]);
  await logService(req, tutorial.service_id, 'deleted', `Deleted tutorial ${tutorial.title}`, 'tutorial');
  flash(req, 'success', 'Tutorial deleted.');
  res.redirect(tutorialsTab(tutorial.service_id));
});

module.exports = router;
