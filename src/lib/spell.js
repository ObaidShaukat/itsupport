// Shared spellchecker (UK English) with a team dictionary.
//
// The browser checks text in a Web Worker (public/js/spell-worker.js) with nspell and the
// dictionary-en-gb Hunspell files, all served by the portal (/spell/..., long cache headers).
// nspell is CommonJS, so nspellBundle() wraps its files (and is-buffer) into one plain browser
// script once per process: no bundler, no eval.
//
// Words the checker accepts besides the dictionary:
//   - dictionary_words: added by anyone ("Add to dictionary" or Settings > Dictionary), for
//     everyone, matched case-insensitively;
//   - knownNames(): the words in client, user, service, category, article category, stock
//     brand / model / category and CS1 company names, read fresh on every request so changes
//     apply on the browsers' next refresh (every few minutes and on page load).
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const NSPELL_DIR = path.dirname(require.resolve('nspell/package.json'));
// dictionary-en-gb is ESM-only with an exports map, so find its folder on the module path.
const DICT_DIR = require.resolve.paths('dictionary-en-gb')
  .map((dir) => path.join(dir, 'dictionary-en-gb'))
  .find((dir) => fs.existsSync(path.join(dir, 'index.dic')));
const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

// Changes whenever either package is updated, so the long browser cache is safe.
const SPELL_VERSION = `${version(NSPELL_DIR)}-${version(DICT_DIR)}`;
const AFF_PATH = path.join(DICT_DIR, 'index.aff');
const DIC_PATH = path.join(DICT_DIR, 'index.dic');

let bundle = null;

// One browser script defining self.nspell. Every CommonJS file nspell needs is wrapped in a
// function; require() calls are resolved here, at build time, to fixed module ids.
function nspellBundle() {
  if (bundle) return bundle;
  const modules = new Map(); // absolute path -> { id, code, deps }
  const visit = (file) => {
    if (modules.has(file)) return modules.get(file).id;
    const entry = { id: modules.size, code: '', deps: {} };
    modules.set(file, entry);
    entry.code = fs.readFileSync(file, 'utf8');
    for (const [, spec] of entry.code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      entry.deps[spec] = visit(require.resolve(spec, { paths: [path.dirname(file)] }));
    }
    return entry.id;
  };
  const main = visit(require.resolve('nspell'));
  const defs = [...modules.values()].map((m) => `${m.id}: [function (module, exports, require) {\n${m.code}\n}, ${JSON.stringify(m.deps)}]`);
  bundle = `/* nspell ${version(NSPELL_DIR)} (MIT), wrapped for the browser by src/lib/spell.js */
(function () {
  var defs = {\n${defs.join(',\n')}\n};
  var cache = {};
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var module = cache[id] = { exports: {} };
    var deps = defs[id][1];
    defs[id][0].call(module.exports, module, module.exports, function (spec) { return load(deps[spec]); });
    return module.exports;
  }
  self.nspell = load(${main});
})();
`;
  return bundle;
}

// A dictionary word: letters (any language), with ' or - inside, 1-100 characters.
const WORD = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’-]*[\p{L}\p{M}])?$/u;
function cleanWord(value) {
  const word = String(value || '').trim().replace(/’/g, "'");
  return word.length <= 100 && WORD.test(word) ? word : null;
}

// Every word (2+ letters) in a name: "Abel & Co Chartered Accountants" -> Abel, Co, ...
function wordsOf(text, into) {
  for (const [w] of String(text || '').matchAll(/[\p{L}\p{M}][\p{L}\p{M}'’]*/gu)) {
    const word = w.replace(/['’]+$/, '');
    if (word.length > 1) into.add(word.toLowerCase());
  }
}

async function knownNames(db = pool) {
  const queries = [
    'SELECT name AS t FROM clients',
    'SELECT contact_name AS t FROM clients WHERE contact_name IS NOT NULL',
    "SELECT COALESCE(NULLIF(display_name, ''), username) AS t FROM users",
    "SELECT SUBSTRING_INDEX(username, '@', 1) AS t FROM users",
    'SELECT name AS t FROM services',
    'SELECT name AS t FROM service_categories',
    'SELECT DISTINCT category AS t FROM kb_articles',
    'SELECT DISTINCT brand AS t FROM stock_items WHERE brand IS NOT NULL',
    'SELECT DISTINCT model AS t FROM stock_items WHERE model IS NOT NULL',
    'SELECT name AS t FROM stock_categories',
    'SELECT name AS t FROM cs1_customers',
  ];
  const names = new Set();
  for (const sql of queries) {
    const [rows] = await db.query(sql);
    for (const row of rows) wordsOf(row.t, names);
  }
  return [...names];
}

async function teamWords(db = pool) {
  const [rows] = await db.query('SELECT word FROM dictionary_words');
  return rows.map((r) => r.word);
}

async function listWords({ q = '' } = {}) {
  const params = [];
  let where = '';
  if (q) {
    where = 'WHERE d.word LIKE ?';
    params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const [rows] = await pool.query(`
    SELECT d.id, d.word, d.added_at, d.added_by AS added_by_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS added_by
    FROM dictionary_words d LEFT JOIN users u ON u.id = d.added_by
    ${where}
    ORDER BY d.word
  `, params);
  return rows;
}

// Adds a word for everyone. { word, added } (added false when it was already there).
async function addWord(userId, value) {
  const word = cleanWord(value);
  if (!word) return { error: 'Enter one word: letters only, with \' or - inside, up to 100 characters.' };
  const [result] = await pool.query('INSERT IGNORE INTO dictionary_words (word, added_by) VALUES (?, ?)', [word, userId]);
  return { word, added: result.affectedRows > 0 };
}

module.exports = {
  SPELL_VERSION, AFF_PATH, DIC_PATH, nspellBundle, cleanWord, knownNames, teamWords, listWords, addWord,
};
