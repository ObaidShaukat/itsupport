// Spellchecker files and word lists for the browser (src/lib/spell.js, public/js/spell.js).
// Mounted before the per-page data, so these quick requests run no page queries.
//   GET  /spell/nspell.js?v=  nspell wrapped for the worker (cached for a year: the version is in the address)
//   GET  /spell/en-GB.aff|dic UK English Hunspell files (same caching)
//   GET  /spell/words         { words: team dictionary, names: client / user / ... name words }
//   POST /spell/words         word: add to the team dictionary (JSON reply)
const express = require('express');
const { logActivity } = require('../lib/activity');
const {
  SPELL_VERSION, AFF_PATH, DIC_PATH, nspellBundle, knownNames, teamWords, addWord,
} = require('../lib/spell');

const router = express.Router();

const longCache = (res) => res.set('Cache-Control', 'private, max-age=31536000, immutable');

router.get('/nspell.js', (req, res) => {
  longCache(res);
  res.type('application/javascript').send(nspellBundle());
});

for (const [name, file] of [['en-GB.aff', AFF_PATH], ['en-GB.dic', DIC_PATH]]) {
  router.get(`/${name}`, (req, res) => {
    longCache(res);
    res.type('text/plain; charset=utf-8').sendFile(file);
  });
}

router.get('/words', async (req, res) => {
  const [words, names] = await Promise.all([teamWords(), knownNames()]);
  res.set('Cache-Control', 'no-store');
  res.json({ version: SPELL_VERSION, words, names });
});

router.post('/words', async (req, res) => {
  const result = await addWord(req.user.id, req.body.word);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  if (result.added) {
    await logActivity(null, req.user, {
      type: 'dictionary', action: 'created', subject: result.word, summary: `Added '${result.word}' to the dictionary`,
    });
  }
  return res.json({ ok: true, word: result.word, added: result.added });
});

module.exports = router;
