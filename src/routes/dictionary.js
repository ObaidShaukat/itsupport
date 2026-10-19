// Settings > Dictionary (/settings/dictionary): the team spellchecker dictionary. Anyone can
// add or delete words; they apply for everyone straight away (src/lib/spell.js). Logged as
// entity_type 'dictionary' (never on the Daily Report).
const express = require('express');
const { pool } = require('../db');
const { requireId, flash, notFound } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { listWords, addWord } = require('../lib/spell');

const router = express.Router();

router.get('/', async (req, res) => {
  res.render('settings/dictionary', { title: 'Dictionary', words: await listWords() });
});

router.post('/', async (req, res) => {
  const result = await addWord(req.user.id, req.body.word);
  if (result.error) {
    flash(req, 'error', result.error);
  } else if (!result.added) {
    flash(req, 'info', `'${result.word}' is already in the dictionary.`);
  } else {
    await logActivity(null, req.user, {
      type: 'dictionary', action: 'created', subject: result.word, summary: `Added '${result.word}' to the dictionary`,
    });
    flash(req, 'saved', `Added '${result.word}'.`);
  }
  res.redirect('/settings/dictionary');
});

router.post('/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const [[row]] = await pool.query('SELECT id, word FROM dictionary_words WHERE id = ?', [id]);
  if (!row) throw notFound();
  await pool.query('DELETE FROM dictionary_words WHERE id = ?', [id]);
  await logActivity(null, req.user, {
    type: 'dictionary', action: 'deleted', subject: row.word, summary: `Removed '${row.word}' from the dictionary`,
  });
  flash(req, 'saved', `Removed '${row.word}'.`);
  res.redirect('/settings/dictionary');
});

module.exports = router;
