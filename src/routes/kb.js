// General IT Support: knowledge base articles with Markdown issue/solution and attachments.
const express = require('express');
const { pool, transaction } = require('../db');
const { str, requireId, flash, notFound } = require('../lib/http');
const { renderMarkdown } = require('../lib/markdown');
const { receivedFiles, removeStoredFiles } = require('../lib/uploads');
const { logActivity, historyFor, recordMeta } = require('../lib/activity');

const logArticle = (db, req, id, action, title, summary) => logActivity(db, req.user, {
  type: 'kb_article', id, action, subject: title, summary,
});

const router = express.Router();

const DEFAULT_CATEGORY = 'General';

// "VPN, Outlook , vpn" -> "VPN, Outlook" (trimmed, de-duplicated case-insensitively).
function normaliseTags(value) {
  const seen = new Set();
  const tags = [];
  for (const raw of str(value, 1000).split(',')) {
    const tag = raw.trim().slice(0, 50);
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
  }
  return tags.join(', ').slice(0, 500);
}

const tagList = (tags) => (tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : []);

function readArticle(body) {
  return {
    title: str(body.title, 255),
    category: str(body.category, 100) || DEFAULT_CATEGORY,
    tags: normaliseTags(body.tags),
    issue: str(body.issue, 200000),
    solution: str(body.solution, 200000),
  };
}

async function categoryOptions() {
  const [rows] = await pool.query('SELECT DISTINCT category FROM kb_articles ORDER BY category');
  return rows.map((r) => r.category);
}

async function attachmentsFor(articleId) {
  const [rows] = await pool.query(`
    SELECT a.id, a.file_name, a.original_name, a.size_bytes, a.kind, a.created_at, u.username AS uploaded_by
    FROM kb_attachments a
    LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.article_id = ?
    ORDER BY a.original_name, a.id
  `, [articleId]);
  return rows;
}

async function saveAttachments(conn, req, articleId) {
  const files = receivedFiles(req, 'files');
  if (!files.length) return 0;
  await conn.query(
    'INSERT INTO kb_attachments (article_id, file_name, original_name, size_bytes, kind, uploaded_by) VALUES ?',
    [files.map((f) => [articleId, f.file_name, f.original_name, f.size_bytes, f.kind, req.user.id])]
  );
  return files.length;
}

function renderForm(res, status, { article, action, error, attachments = [] }) {
  return categoryOptions().then((categories) => res.status(status).render('kb/form', {
    title: article.id ? `Edit ${article.title}` : 'New article',
    article,
    action,
    error,
    attachments,
    categories,
  }));
}

// ---- List ----

router.get('/', async (req, res) => {
  const category = str(req.query.category, 100);
  const [articles] = await pool.query(`
    SELECT a.id, a.title, a.category, a.tags, LEFT(a.issue, 300) AS issue_preview, a.updated_at,
      (SELECT COUNT(*) FROM kb_attachments f WHERE f.article_id = a.id) AS attachment_count
    FROM kb_articles a
    ${category ? 'WHERE a.category = ?' : ''}
    ORDER BY a.title, a.id
  `, category ? [category] : []);
  const [categoryRows] = await pool.query(
    'SELECT category, COUNT(*) AS count FROM kb_articles GROUP BY category ORDER BY category'
  );
  const total = categoryRows.reduce((sum, r) => sum + Number(r.count), 0);
  for (const a of articles) a.tagList = tagList(a.tags);
  res.render('kb/index', {
    title: 'General IT Support',
    articles,
    category,
    categories: categoryRows.map((r) => ({ name: r.category, count: Number(r.count) })),
    total,
  });
});

// ---- Create ----

router.get('/new', (req, res) => renderForm(res, 200, {
  article: { title: '', category: DEFAULT_CATEGORY, tags: '', issue: '', solution: '' },
  action: '/kb',
  error: null,
}));

router.post('/', async (req, res) => {
  const article = readArticle(req.body);
  const error = req.uploadError || (!article.title ? 'Title is required.' : null);
  if (error) return renderForm(res, 400, { article, action: '/kb', error });

  const id = await transaction(async (conn) => {
    const [result] = await conn.query(`
      INSERT INTO kb_articles (title, category, tags, issue, solution, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [article.title, article.category, article.tags || null, article.issue || null, article.solution || null, req.user.id, req.user.id]);
    const files = await saveAttachments(conn, req, result.insertId);
    await logArticle(conn, req, result.insertId, 'created', article.title,
      `Wrote article ${article.title}${files ? ` with ${files} attachment${files === 1 ? '' : 's'}` : ''}`);
    return result.insertId;
  });
  req.keepUploads = true;
  flash(req, 'success', 'Article created.');
  res.redirect(`/kb/${id}`);
});

// ---- View ----

router.get('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const [[article]] = await pool.query(`
    SELECT a.*, c.username AS created_by_name, e.username AS updated_by_name
    FROM kb_articles a
    LEFT JOIN users c ON c.id = a.created_by
    LEFT JOIN users e ON e.id = a.updated_by
    WHERE a.id = ?
  `, [id]);
  if (!article) throw notFound();
  const activity = await historyFor(['kb_article'], [id]);
  const meta = recordMeta(activity, 'kb_article', {
    createdBy: article.created_by_name, createdAt: article.created_at,
  });
  if (!meta.updatedBy && article.updated_by_name && String(article.updated_at) !== String(article.created_at)) {
    meta.updatedBy = article.updated_by_name;
    meta.updatedAt = article.updated_at;
  }
  res.render('kb/show', {
    title: article.title,
    article,
    activity,
    meta,
    tags: tagList(article.tags),
    issueHtml: renderMarkdown(article.issue),
    solutionHtml: renderMarkdown(article.solution),
    attachments: await attachmentsFor(id),
  });
});

// ---- Edit ----

router.get('/:id/edit', async (req, res) => {
  const id = requireId(req.params.id);
  const [[article]] = await pool.query('SELECT id, title, category, tags, issue, solution FROM kb_articles WHERE id = ?', [id]);
  if (!article) throw notFound();
  for (const key of ['tags', 'issue', 'solution']) article[key] ??= '';
  return renderForm(res, 200, { article, action: `/kb/${id}`, error: null, attachments: await attachmentsFor(id) });
});

router.post('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const article = { ...readArticle(req.body), id };
  const error = req.uploadError || (!article.title ? 'Title is required.' : null);
  if (error) {
    const [[exists]] = await pool.query('SELECT id FROM kb_articles WHERE id = ?', [id]);
    if (!exists) throw notFound();
    return renderForm(res, 400, { article, action: `/kb/${id}`, error, attachments: await attachmentsFor(id) });
  }

  const added = await transaction(async (conn) => {
    const [result] = await conn.query(`
      UPDATE kb_articles SET title = ?, category = ?, tags = ?, issue = ?, solution = ?, updated_by = ?
      WHERE id = ?
    `, [article.title, article.category, article.tags || null, article.issue || null, article.solution || null, req.user.id, id]);
    if (!result.affectedRows) throw notFound();
    const files = await saveAttachments(conn, req, id);
    await logArticle(conn, req, id, 'updated', article.title, `Edited article ${article.title}`);
    if (files) {
      await logArticle(conn, req, id, 'uploaded', article.title,
        `Attached ${files} file${files === 1 ? '' : 's'} to ${article.title}`);
    }
    return files;
  });
  req.keepUploads = true;
  flash(req, 'success', added ? `Article updated, ${added} file${added === 1 ? '' : 's'} attached.` : 'Article updated.');
  res.redirect(`/kb/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [files] = await pool.query('SELECT file_name FROM kb_attachments WHERE article_id = ?', [id]);
  const [[article]] = await pool.query('SELECT title FROM kb_articles WHERE id = ?', [id]);
  if (!article) return res.redirect('/kb');
  await pool.query('DELETE FROM kb_articles WHERE id = ?', [id]);
  await logArticle(null, req, id, 'deleted', article.title, `Deleted article ${article.title}`);
  await removeStoredFiles(files.map((f) => f.file_name));
  flash(req, 'success', 'Article deleted.');
  res.redirect('/kb');
});

router.post('/attachments/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[file]] = await pool.query(`
    SELECT f.article_id, f.file_name, f.original_name, a.title
    FROM kb_attachments f JOIN kb_articles a ON a.id = f.article_id
    WHERE f.id = ?
  `, [id]);
  if (!file) throw notFound();
  await pool.query('DELETE FROM kb_attachments WHERE id = ?', [id]);
  await logArticle(null, req, file.article_id, 'deleted', file.title, `Removed attachment ${file.original_name}`);
  await removeStoredFiles([file.file_name]);
  flash(req, 'success', 'Attachment removed.');
  res.redirect(`/kb/${file.article_id}/edit#attachments`);
});

module.exports = router;
