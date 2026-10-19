// Suggestion helpers for the spellchecker worker (loaded with importScripts by spell-worker.js).
// nspell's suggest() only tries single edits, so typos with two changes (or letters swapped
// apart, "congifurations") get nothing. spellSuggester(spell) adds a fallback: every word form
// nspell knows (spell.data: about 120,000 for en-GB, affixed forms included), bucketed by first
// letter, compared with the optimal string alignment (Damerau-Levenshtein) distance, at most 2.
//
// Ranking: nspell's own suggestions first, then distance, then a commonness guess (Hunspell
// files carry no word frequencies): a matching first letter, a closer length, a longer shared
// start, ordinary words before names. The replacement keeps the typo's capitalisation.
/* exported spellSuggester */
self.spellSuggester = function spellSuggester(spell) {
  const MAX = 5;
  const MAX_DISTANCE = 2;
  // Flags on words that must never be suggested (NOSUGGEST, ONLYINCOMPOUND in the .aff).
  const blocked = [spell.flags && spell.flags.NOSUGGEST, spell.flags && spell.flags.ONLYINCOMPOUND].filter(Boolean);
  let buckets = null; // first letter (lower case) -> [{ word, lower }]

  function index() {
    if (buckets) return buckets;
    buckets = new Map();
    for (const word of Object.keys(spell.data)) {
      const flags = spell.data[word] || [];
      if (blocked.some((f) => flags.includes(f))) continue;
      if (word.length < 2 || /[^\p{L}'’-]/u.test(word)) continue;
      const lower = word.toLowerCase();
      const key = lower[0];
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ word, lower });
    }
    return buckets;
  }

  // Optimal string alignment distance (insert, delete, substitute, swap two neighbours),
  // giving up as soon as it must be more than max.
  function distance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  const sharedStart = (a, b) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
    return n;
  };

  function nearby(typo) {
    const lower = typo.toLowerCase();
    const all = index();
    // The typo's first letter; also its second, for a swapped first pair ("htis" -> "this").
    const keys = [...new Set([lower[0], lower[1]].filter(Boolean))];
    const found = [];
    for (const key of keys) {
      for (const cand of all.get(key) || []) {
        if (Math.abs(cand.lower.length - lower.length) > MAX_DISTANCE) continue;
        const d = distance(lower, cand.lower, MAX_DISTANCE);
        if (d > MAX_DISTANCE || d === 0) continue;
        found.push({
          word: cand.word,
          d,
          firstLetter: cand.lower[0] === lower[0] ? 0 : 1,
          lengthGap: Math.abs(cand.lower.length - lower.length),
          start: sharedStart(lower, cand.lower),
          name: cand.word[0] !== cand.lower[0] ? 1 : 0,
          possessive: /['’]s$/.test(cand.word) && !/['’]s$/i.test(typo) ? 1 : 0,
        });
      }
    }
    found.sort((x, y) => x.d - y.d || x.firstLetter - y.firstLetter || x.possessive - y.possessive || x.name - y.name
      || x.lengthGap - y.lengthGap || y.start - x.start || x.word.localeCompare(y.word));
    return found.map((f) => f.word);
  }

  // "Congifurations" -> "Configurations": a capitalised typo gets a capitalised suggestion.
  function caseLike(typo, word) {
    if (typo[0] && typo[0] === typo[0].toUpperCase() && typo[0] !== typo[0].toLowerCase()) {
      return word[0].toUpperCase() + word.slice(1);
    }
    return word;
  }

  return function suggestions(typo) {
    const out = [];
    const seen = new Set();
    const add = (w) => {
      const final = caseLike(typo, w);
      const key = final.toLowerCase();
      if (!seen.has(key) && key !== typo.toLowerCase()) {
        seen.add(key);
        out.push(final);
      }
    };
    spell.suggest(typo).forEach(add);
    // Fewer than 3 from nspell: fill up from the edit-distance search.
    if (out.length < 3) {
      for (const w of nearby(typo)) {
        if (out.length >= MAX) break;
        add(w);
      }
    }
    return out.slice(0, MAX);
  };
};
