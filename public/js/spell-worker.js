// Spellchecker worker (UK English): loads nspell and the dictionary-en-gb files from the portal
// once (cached by the browser for a year: the version is in every address), then answers
// check / suggest requests from public/js/spell.js so typing never waits for it.
//   { type: 'words', words, names }  team dictionary + name words (replaces the previous list)
//   { type: 'add', word }            one word added to the team dictionary
//   { type: 'check', id, words }     -> { type: 'checked', id, bad: [words not accepted] }
//   { type: 'suggest', id, word }    -> { type: 'suggested', id, suggestions: [up to 5] }
/* global nspell */
const version = new URLSearchParams(self.location.search).get('v') || '0';
let spell = null;
let team = new Set(); // lower case

const ready = (async () => {
  self.importScripts(`/spell/nspell.js?v=${encodeURIComponent(version)}`);
  const get = (name) => fetch(`/spell/${name}?v=${encodeURIComponent(version)}`, { credentials: 'same-origin' })
    .then((r) => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.text(); });
  const [aff, dic] = await Promise.all([get('en-GB.aff'), get('en-GB.dic')]);
  spell = nspell(aff, dic);
})();

const norm = (w) => w.replace(/’/g, "'");
const inTeam = (w) => team.has(w.toLowerCase());

function accepted(raw) {
  const word = norm(raw);
  if (inTeam(word) || spell.correct(word)) return true;
  // Possessives of accepted words: "Cleartwo's", "clients'".
  const base = word.replace(/'s$/i, '').replace(/s'$/i, 's');
  if (base !== word && base.length > 1 && (inTeam(base) || spell.correct(base))) return true;
  return false;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'words') {
    team = new Set([...(msg.words || []), ...(msg.names || [])].map((w) => String(w).toLowerCase()));
    self.postMessage({ type: 'words-updated' });
    return;
  }
  if (msg.type === 'add') {
    team.add(String(msg.word || '').toLowerCase());
    return;
  }
  try {
    await ready;
  } catch (err) {
    self.postMessage({ type: 'failed', error: String(err && err.message ? err.message : err) });
    return;
  }
  if (msg.type === 'check') {
    self.postMessage({ type: 'checked', id: msg.id, bad: (msg.words || []).filter((w) => !accepted(w)) });
  } else if (msg.type === 'suggest') {
    const word = norm(String(msg.word || ''));
    let suggestions = [];
    // Very long words make suggest() slow; nothing useful comes back for them anyway.
    if (word.length <= 30) suggestions = spell.suggest(word).slice(0, 5);
    self.postMessage({ type: 'suggested', id: msg.id, suggestions });
  }
};
