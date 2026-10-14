// Articles (formerly "General IT Support" / the knowledge base, at /articles; /kb redirects):
// Markdown issue / solution and attachments. Internally still kb_* tables and entity_type kb_article.
const express = require('express');
const { pool, transaction } = require('../db');
const {
  str, requireId, flash, notFound, backPath,
} = require('../lib/http');
const { renderMarkdown } = require('../lib/markdown');
const { receivedFiles, removeStoredFiles } = require('../lib/uploads');
const { logActivity, historyFor, recordMeta } = require('../lib/activity');
const { avatarHelper } = require('../lib/avatars');

const logArticle = (db, req, id, action, title, summary, changes = []) => logActivity(db, req.user, {
  type: 'kb_article', id, action, subject: title, summary, changes,
});

// Fields compared on edit, in the order they are reported.
const ARTICLE_FIELDS = [
  ['title', 'title'],
  ['category', 'category'],
  ['tags', 'tags'],
  ['issue', 'issue description'],
  ['solution', 'solution'],
];
const FIELD_LABELS = { ...Object.fromEntries(ARTICLE_FIELDS), attachments: 'attachments' };

// "a", "a and b", "a, b and c"
const joinAnd = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const describeChanges = (changes) => joinAnd(changes.map((c) => FIELD_LABELS[c]));

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
    SELECT a.id, a.file_name, a.original_name, a.size_bytes, a.kind, a.created_at, COALESCE(NULLIF(u.display_name, ''), u.username) AS uploaded_by
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
    title: 'Articles',
    articles,
    category,
    categories: categoryRows.map((r) => ({ name: r.category, count: Number(r.count) })),
    total,
  });
});

// ---- Create ----

router.get('/new', (req, res) => renderForm(res, 200, {
  article: { title: '', category: DEFAULT_CATEGORY, tags: '', issue: '', solution: '' },
  action: '/articles',
  error: null,
}));

router.post('/', async (req, res) => {
  const article = readArticle(req.body);
  const error = req.uploadError || (!article.title ? 'Title is required.' : null);
  if (error) return renderForm(res, 400, { article, action: '/articles', error });

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
  res.redirect(`/articles/${id}`);
});

// ---- View ----

router.get('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const article = await loadArticle(id);
  if (!article) throw notFound();
  const activity = await historyFor(['kb_article'], [id]);
  res.render('kb/show', {
    title: article.title,
    article,
    activity,
    meta: metaFor(article, activity),
    categories: await categoryOptions(),
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
  return renderForm(res, 200, { article, action: `/articles/${id}`, error: null, attachments: await attachmentsFor(id) });
});

router.post('/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const article = { ...readArticle(req.body), id };
  const error = req.uploadError || (!article.title ? 'Title is required.' : null);
  if (error) {
    const [[exists]] = await pool.query('SELECT id FROM kb_articles WHERE id = ?', [id]);
    if (!exists) throw notFound();
    return renderForm(res, 400, { article, action: `/articles/${id}`, error, attachments: await attachmentsFor(id) });
  }

  const added = await transaction(async (conn) => {
    const [[before]] = await conn.query(
      'SELECT title, category, tags, issue, solution FROM kb_articles WHERE id = ? FOR UPDATE',
      [id]
    );
    if (!before) throw notFound();
    await conn.query(`
      UPDATE kb_articles SET title = ?, category = ?, tags = ?, issue = ?, solution = ?, updated_by = ?
      WHERE id = ?
    `, [article.title, article.category, article.tags || null, article.issue || null, article.solution || null, req.user.id, id]);
    const files = await saveAttachments(conn, req, id);

    const changes = ARTICLE_FIELDS
      .map(([field]) => field)
      .filter((field) => (before[field] || '') !== (article[field] || ''));
    if (files) changes.push('attachments');
    const summary = changes.length
      ? `Revised the ${describeChanges(changes)}${files ? ` (${files} file${files === 1 ? '' : 's'} attached)` : ''}`
      : 'Saved with no changes';
    await logArticle(conn, req, id, 'updated', article.title, summary, changes);
    return files;
  });
  req.keepUploads = true;
  flash(req, 'success', added ? `Article updated, ${added} file${added === 1 ? '' : 's'} attached.` : 'Article updated.');
  res.redirect(`/articles/${id}`);
});

// ---- Inline editing on the article page (fetch, JSON replies) ----
// Title, category, issue and solution are saved one field at a time; attachments are uploaded
// one file per request (so each has its own progress bar), renamed and deleted from the page.
// Every change sets updated_by, is logged as kb_article / updated (the Daily Report line
// "Updated the article '{title}'.") and the reply carries the refreshed "Last updated",
// History and Attachments HTML. Without JavaScript the Edit page does the same.

const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';
const INLINE_FIELDS = {
  title: { max: 255, sql: 'UPDATE kb_articles SET title = ?, updated_by = ? WHERE id = ?' },
  category: { max: 100, sql: 'UPDATE kb_articles SET category = ?, updated_by = ? WHERE id = ?' },
  issue: { max: 200000, sql: 'UPDATE kb_articles SET issue = ?, updated_by = ? WHERE id = ?' },
  solution: { max: 200000, sql: 'UPDATE kb_articles SET solution = ?, updated_by = ? WHERE id = ?' },
};

const renderPart = (res, view, locals) => new Promise((resolve, reject) => {
  res.render(view, locals, (err, html) => (err ? reject(err) : resolve(html)));
});

async function loadArticle(id) {
  const [[article]] = await pool.query(`
    SELECT a.*, COALESCE(NULLIF(c.display_name, ''), c.username) AS created_by_name, COALESCE(NULLIF(e.display_name, ''), e.username) AS updated_by_name
    FROM kb_articles a
    LEFT JOIN users c ON c.id = a.created_by
    LEFT JOIN users e ON e.id = a.updated_by
    WHERE a.id = ?
  `, [id]);
  return article || null;
}

// "Created by … on …" / "Last updated by … on …" from the History, as on the page.
function metaFor(article, activity) {
  const meta = recordMeta(activity, 'kb_article', { createdBy: article.created_by_name, createdAt: article.created_at });
  if (!meta.updatedBy && article.updated_by_name && String(article.updated_at) !== String(article.created_at)) {
    meta.updatedBy = article.updated_by_name;
    meta.updatedAt = article.updated_at;
  }
  return meta;
}

// The parts of the page that change after an inline edit.
async function pageParts(res, id) {
  const article = await loadArticle(id);
  const [people] = await pool.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, avatar_file FROM users");
  res.locals.avatar = avatarHelper(people);
  const activity = await historyFor(['kb_article'], [id]);
  const attachments = await attachmentsFor(id);
  return {
    title: article.title,
    category: article.category,
    metaHtml: await renderPart(res, 'partials/record-meta', { meta: metaFor(article, activity) }),
    historyHtml: await renderPart(res, 'partials/history', { entries: activity.slice().reverse() }),
    attachmentsHtml: await renderPart(res, 'kb/_attachments', { article, attachments }),
    attachmentCount: attachments.length,
  };
}

const jsonError = (res, status, error) => res.status(status).json({ ok: false, error });

router.post('/:id/field', async (req, res) => {
  const id = requireId(req.params.id);
  const field = String(req.body.field || '');
  const spec = INLINE_FIELDS[field];
  if (!spec) return jsonError(res, 400, 'That cannot be edited here.');
  let value = str(req.body.value, spec.max);
  if (field === 'title' && !value) return jsonError(res, 400, 'Title is required.');
  if (field === 'category') value = value || DEFAULT_CATEGORY;
  const changed = await transaction(async (conn) => {
    const [[before]] = await conn.query('SELECT title, category, issue, solution FROM kb_articles WHERE id = ? FOR UPDATE', [id]);
    if (!before) throw notFound();
    if ((before[field] || '') === value) return false;
    await conn.query(spec.sql, [field === 'issue' || field === 'solution' ? value || null : value, req.user.id, id]);
    const title = field === 'title' ? value : before.title;
    const summary = field === 'title' ? `Renamed the article from "${before.title}" to "${value}"`
      : field === 'category' ? `Moved the article from ${before.category} to ${value}`
        : `Revised the ${FIELD_LABELS[field]}`;
    await logArticle(conn, req, id, 'updated', title, summary, [field]);
    return true;
  });
  const out = { ok: true, changed, field, value, ...(await pageParts(res, id)) };
  if (field === 'issue' || field === 'solution') out.html = renderMarkdown(value);
  if (field === 'category') out.categories = await categoryOptions();
  return res.json(out);
});

// One or more files (the page sends one per request, for its progress bars).
router.post('/:id/attachments', async (req, res) => {
  const id = requireId(req.params.id);
  if (req.uploadError) return jsonError(res, 400, req.uploadError);
  const files = receivedFiles(req, 'files');
  if (!files.length) return jsonError(res, 400, 'Choose a file to upload.');
  const [[article]] = await pool.query('SELECT title FROM kb_articles WHERE id = ?', [id]);
  if (!article) return jsonError(res, 404, 'That article no longer exists.');
  await transaction(async (conn) => {
    await saveAttachments(conn, req, id);
    await conn.query('UPDATE kb_articles SET updated_by = ? WHERE id = ?', [req.user.id, id]);
    await logArticle(conn, req, id, 'updated', article.title,
      `Added attachment${files.length === 1 ? '' : 's'} ${files.map((f) => f.original_name).join(', ')}`, ['attachments']);
  });
  req.keepUploads = true;
  return res.json({ ok: true, added: files.length, ...(await pageParts(res, id)) });
});

// "Report.pdf" -> a safe display / download name; the extension is kept when left off.
function cleanFileName(name, original) {
  let clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const ext = (/\.[A-Za-z0-9]{1,8}$/.exec(original || '') || [''])[0];
  if (clean && ext && !clean.toLowerCase().endsWith(ext.toLowerCase())) clean = `${clean}${ext}`;
  return clean.slice(0, 255);
}

router.post('/attachments/:id/rename', async (req, res) => {
  const id = requireId(req.params.id);
  const [[file]] = await pool.query(`
    SELECT f.article_id, f.original_name, a.title FROM kb_attachments f JOIN kb_articles a ON a.id = f.article_id WHERE f.id = ?
  `, [id]);
  if (!file) return wantsJson(req) ? jsonError(res, 404, 'That attachment no longer exists.') : res.redirect('/articles');
  const name = cleanFileName(req.body.name, file.original_name);
  if (!name) {
    if (wantsJson(req)) return jsonError(res, 400, 'Enter a file name.');
    flash(req, 'error', 'Enter a file name.');
    return res.redirect(backPath(req, `/articles/${file.article_id}`));
  }
  if (name !== file.original_name) {
    await transaction(async (conn) => {
      await conn.query('UPDATE kb_attachments SET original_name = ? WHERE id = ?', [name, id]);
      await conn.query('UPDATE kb_articles SET updated_by = ? WHERE id = ?', [req.user.id, file.article_id]);
      await logArticle(conn, req, file.article_id, 'updated', file.title, `Renamed attachment ${file.original_name} to ${name}`, ['attachments']);
    });
  }
  if (wantsJson(req)) return res.json({ ok: true, ...(await pageParts(res, file.article_id)) });
  flash(req, 'saved', 'Saved.');
  return res.redirect(backPath(req, `/articles/${file.article_id}`));
});

router.post('/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [files] = await pool.query('SELECT file_name FROM kb_attachments WHERE article_id = ?', [id]);
  const [[article]] = await pool.query('SELECT title FROM kb_articles WHERE id = ?', [id]);
  if (!article) return res.redirect('/articles');
  await pool.query('DELETE FROM kb_articles WHERE id = ?', [id]);
  await logArticle(null, req, id, 'deleted', article.title, `Deleted article ${article.title}`);
  await removeStoredFiles(files.map((f) => f.file_name));
  flash(req, 'success', 'Article deleted.');
  res.redirect('/articles');
});

router.post('/attachments/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[file]] = await pool.query(`
    SELECT f.article_id, f.file_name, f.original_name, a.title
    FROM kb_attachments f JOIN kb_articles a ON a.id = f.article_id
    WHERE f.id = ?
  `, [id]);
  if (!file) {
    if (wantsJson(req)) return jsonError(res, 404, 'That attachment no longer exists.');
    throw notFound();
  }
  await transaction(async (conn) => {
    await conn.query('DELETE FROM kb_attachments WHERE id = ?', [id]);
    await conn.query('UPDATE kb_articles SET updated_by = ? WHERE id = ?', [req.user.id, file.article_id]);
    // Removing an attachment is an edit of the article, so it is logged as an update.
    await logArticle(conn, req, file.article_id, 'updated', file.title,
      `Removed attachment ${file.original_name}`, ['attachments']);
  });
  await removeStoredFiles([file.file_name]);
  if (wantsJson(req)) return res.json({ ok: true, ...(await pageParts(res, file.article_id)) });
  flash(req, 'success', 'Attachment removed.');
  return res.redirect(backPath(req, `/articles/${file.article_id}/edit#attachments`));
});

module.exports = router;
