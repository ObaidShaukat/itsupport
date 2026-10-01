// Service catalogue: categories > services > ordered steps.
const express = require('express');
const { pool, transaction } = require('../db');
const { str, requireId, toId, flash, direction, notFound } = require('../lib/http');
const { nextPosition, move } = require('../lib/order');
const { buildFlowchart } = require('../lib/mermaid');

const router = express.Router();

const isDuplicate = (err) => err.code === 'ER_DUP_ENTRY';

// ---- Overview ----

router.get('/services', async (req, res) => {
  const [categories] = await pool.query('SELECT id, name FROM service_categories ORDER BY position, id');
  const [services] = await pool.query(`
    SELECT s.id, s.name, s.category_id, COUNT(st.id) AS step_count
    FROM services s
    LEFT JOIN service_steps st ON st.service_id = s.id
    GROUP BY s.id, s.name, s.category_id, s.position
    ORDER BY s.position, s.id
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
    const position = await nextPosition(pool, 'service_categories');
    await pool.query('INSERT INTO service_categories (name, position) VALUES (?, ?)', [name, position]);
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `A category called "${name}" already exists.`);
    return res.redirect('/services');
  }
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
    GROUP BY s.id, s.name, s.description, s.position
    ORDER BY s.position, s.id
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
  try {
    await pool.query('UPDATE service_categories SET name = ? WHERE id = ?', [name, id]);
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `A category called "${name}" already exists.`);
    return res.redirect(`/categories/${id}`);
  }
  flash(req, 'success', 'Category renamed.');
  res.redirect(`/categories/${id}`);
});

router.post('/categories/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  await pool.query('DELETE FROM service_categories WHERE id = ?', [id]);
  flash(req, 'success', 'Category deleted.');
  res.redirect('/services');
});

router.post('/categories/:id/move', async (req, res) => {
  const id = requireId(req.params.id);
  const dir = direction(req.body.direction);
  if (dir) await move('service_categories', id, dir);
  res.redirect(`/services#category-${id}`);
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
    serviceId = await transaction(async (conn) => {
      const [[category]] = await conn.query('SELECT id FROM service_categories WHERE id = ? FOR UPDATE', [categoryId]);
      if (!category) throw notFound();
      const position = await nextPosition(conn, 'services', categoryId);
      const [result] = await conn.query(
        'INSERT INTO services (category_id, name, description, position) VALUES (?, ?, ?, ?)',
        [categoryId, name, description, position]
      );
      return result.insertId;
    });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `This category already has a service called "${name}".`);
    return res.redirect(`/categories/${categoryId}`);
  }
  flash(req, 'success', `Service "${name}" added. Now add its steps.`);
  res.redirect(`/services/${serviceId}`);
});

router.get('/services/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[service]] = await pool.query(`
    SELECT s.id, s.name, s.description, s.category_id, c.name AS category_name
    FROM services s
    JOIN service_categories c ON c.id = s.category_id
    WHERE s.id = ?
  `, [id]);
  if (!service) throw notFound();
  const [steps] = await pool.query(
    'SELECT id, title FROM service_steps WHERE service_id = ? ORDER BY position, id',
    [id]
  );
  const [categories] = await pool.query('SELECT id, name FROM service_categories ORDER BY position, id');
  res.render('services/show', {
    title: service.name,
    service,
    steps,
    categories,
    flowchart: buildFlowchart(steps),
  });
});

router.post('/services/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const name = str(req.body.name, 200);
  const description = str(req.body.description, 5000) || null;
  const categoryId = toId(req.body.category_id);
  if (!name) {
    flash(req, 'error', 'Service name is required.');
    return res.redirect(`/services/${id}`);
  }

  try {
    await transaction(async (conn) => {
      const [[service]] = await conn.query('SELECT id, category_id FROM services WHERE id = ? FOR UPDATE', [id]);
      if (!service) throw notFound();

      let newCategory = service.category_id;
      let position = null;
      if (categoryId && categoryId !== service.category_id) {
        const [[category]] = await conn.query('SELECT id FROM service_categories WHERE id = ?', [categoryId]);
        if (category) {
          newCategory = category.id;
          position = await nextPosition(conn, 'services', category.id);
        }
      }

      if (position === null) {
        await conn.query('UPDATE services SET name = ?, description = ? WHERE id = ?', [name, description, id]);
      } else {
        await conn.query(
          'UPDATE services SET name = ?, description = ?, category_id = ?, position = ? WHERE id = ?',
          [name, description, newCategory, position, id]
        );
      }
    });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    flash(req, 'error', `That category already has a service called "${name}".`);
    return res.redirect(`/services/${id}`);
  }
  flash(req, 'success', 'Service updated.');
  res.redirect(`/services/${id}`);
});

router.post('/services/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[service]] = await pool.query('SELECT category_id FROM services WHERE id = ?', [id]);
  if (!service) return res.redirect('/services');
  await pool.query('DELETE FROM services WHERE id = ?', [id]);
  flash(req, 'success', 'Service deleted.');
  res.redirect(`/categories/${service.category_id}`);
});

router.post('/services/:id/move', async (req, res) => {
  const id = requireId(req.params.id);
  const dir = direction(req.body.direction);
  const item = dir ? await move('services', id, dir) : null;
  if (!item) {
    const [[service]] = await pool.query('SELECT category_id FROM services WHERE id = ?', [id]);
    return res.redirect(service ? `/categories/${service.category_id}` : '/services');
  }
  // Moves are made from either the overview or the category page.
  const back = req.body.back === 'overview' ? `/services#category-${item.scope}` : `/categories/${item.scope}`;
  res.redirect(back);
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
    const position = await nextPosition(conn, 'service_steps', serviceId);
    await conn.query(
      'INSERT INTO service_steps (service_id, title, position) VALUES (?, ?, ?)',
      [serviceId, title, position]
    );
  });
  res.redirect(`/services/${serviceId}#steps`);
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
  }
  res.redirect(`/services/${serviceId}#steps`);
});

router.post('/steps/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const serviceId = await stepServiceId(id);
  await pool.query('DELETE FROM service_steps WHERE id = ?', [id]);
  res.redirect(`/services/${serviceId}#steps`);
});

router.post('/steps/:id/move', async (req, res) => {
  const id = requireId(req.params.id);
  const serviceId = await stepServiceId(id);
  const dir = direction(req.body.direction);
  if (dir) await move('service_steps', id, dir);
  res.redirect(`/services/${serviceId}#steps`);
});

module.exports = router;
