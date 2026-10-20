// Shared spellchecker (UK English) with a team dictionary. The checking happens in a Web
// Worker (spell-worker.js); this file finds the free-text fields, draws the red wavy
// underlines and runs the suggestion popup.
//
// Fields: every <textarea>, <input type="text" data-spell> and [contenteditable][data-spell],
// except inside [data-spell="off"]. Native spellcheck is turned off on those fields (no double
// underlines); other text fields keep the browser's own, in en-GB (<html lang="en-GB">).
//   - Textareas and inputs: a layer on top of the field repeats its text (transparent, same
//     font, padding and scroll) with the misspelt words underlined; it ignores the mouse, so
//     the field works exactly as before.
//   - Rich text (contenteditable): words are marked with the CSS Custom Highlight API, which
//     never changes the HTML being edited (skipped in browsers without it).
// Text is checked 400ms after typing stops; words already checked are remembered, so only new
// words (the paragraph being changed) go to the worker. Ignored: words with digits, ALL-CAPS,
// mixed-case names (iPhone), URLs, email addresses, @mentions, #numbers, file names, paths
// and anything inside `code`.
// Click (or right-click) a flagged word: up to 5 suggestions, "Ignore" (this field only) and
// "Add to dictionary" (everyone, POST /spell/words). Arrow keys + Enter, Esc closes; the field
// keeps focus while the popup is open.
(() => {
  const versionMeta = document.querySelector('meta[name="spell-version"]');
  if (!versionMeta || !window.Worker) return;
  const VERSION = versionMeta.content;
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const DELAY = 400;
  const REFRESH = 5 * 60 * 1000;
  const highlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  // ---- Worker ----
  let worker = null;
  let failed = false;
  let nextId = 1;
  const waiting = new Map(); // request id -> resolve
  const verdict = new Map(); // word -> true (fine) / false (misspelt)
  const fields = new Set(); // field states
  let wordsLoadedAt = 0;

  function startWorker() {
    if (worker || failed) return worker;
    try {
      worker = new Worker(`/js/spell-worker.js?v=${encodeURIComponent(VERSION)}`);
    } catch (err) {
      failed = true;
      return null;
    }
    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'words-updated') {
        verdict.clear();
        fields.forEach((f) => f.check());
      } else if (msg.type === 'failed') {
        failed = true;
        console.warn('Spellchecker could not start:', msg.error);
        fields.forEach((f) => f.disable());
      } else if (waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    };
    loadWords();
    return worker;
  }
  const ask = (msg) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    worker.postMessage({ ...msg, id });
  });

  // The team dictionary and name words, on page load and every few minutes.
  async function loadWords() {
    if (!worker) return;
    try {
      const res = await fetch('/spell/words', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      wordsLoadedAt = Date.now();
      worker.postMessage({ type: 'words', words: data.words || [], names: data.names || [] });
    } catch (err) {
      // Offline for a moment: the next refresh tries again.
    }
  }
  setInterval(() => { if (worker && document.visibilityState === 'visible') loadWords(); }, REFRESH);
  document.addEventListener('visibilitychange', () => {
    if (worker && document.visibilityState === 'visible' && Date.now() - wordsLoadedAt > REFRESH) loadWords();
  });

  // ---- Words in a text ----
  const SKIP_CHUNK = [
    /^(?:https?:\/\/|www\.|mailto:|ftp:\/\/)/i, // URLs
    /[^\s@]+@[^\s@]+\.[^\s@]+/, // email addresses
    /^[@#]/, // @mentions, #numbers
    /\w\.[a-z0-9]{2,5}\b/i, // file names, domains, e.g. report.pdf, cleartwo.co.uk
    /\w[\\/]\w/, // paths
  ];
  const WORD = /[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}]+)*/gu;
  function tokenize(text) {
    // Anything inside `code` or a ``` block is masked (same length, so positions stay right).
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    const masked = text.replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
    const out = [];
    for (const chunk of masked.matchAll(/\S+/g)) {
      if (SKIP_CHUNK.some((re) => re.test(chunk[0]))) continue;
      for (const w of chunk[0].matchAll(WORD)) {
        const word = w[0];
        if (word.length < 2 || /[\p{N}_]/u.test(word)) continue;
        if (word === word.toUpperCase()) continue; // RDP, VPN, GDAP
        if (/\p{Ll}\p{Lu}/u.test(word)) continue; // iPhone, OneDrive
        out.push({ word, start: chunk.index + w.index, end: chunk.index + w.index + word.length });
      }
    }
    return out;
  }

  // Asks the worker about words not seen before; resolves when every verdict is known.
  async function judge(words) {
    const unknown = [...new Set(words.filter((w) => !verdict.has(w)))];
    if (unknown.length && startWorker()) {
      const reply = await ask({ type: 'check', words: unknown });
      const bad = new Set(reply.bad || []);
      unknown.forEach((w) => verdict.set(w, !bad.has(w)));
    }
  }

  const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- Textareas and text inputs: a transparent layer on top with the underlines ----
  const COPY = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'textTransform', 'textIndent', 'textAlign', 'tabSize', 'direction', 'boxSizing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopLeftRadius', 'borderTopRightRadius',
    'borderBottomLeftRadius', 'borderBottomRightRadius'];

  function textField(el) {
    const isInput = el.tagName === 'INPUT';
    const layer = document.createElement('div');
    layer.className = 'spell-layer';
    layer.setAttribute('aria-hidden', 'true');
    el.after(layer);
    el.spellcheck = false;
    const state = { el, ignored: new Set(), issues: [], timer: null, active: true };

    const place = () => {
      if (!state.active) return;
      if (!el.isConnected || el.offsetParent === null || !el.offsetWidth) { layer.hidden = true; return; }
      layer.hidden = false;
      if (layer.previousElementSibling !== el) el.after(layer); // the field was moved (popovers)
      const cs = getComputedStyle(el);
      COPY.forEach((p) => { layer.style[p] = cs[p]; });
      layer.style.borderStyle = 'solid';
      layer.style.whiteSpace = isInput ? 'pre' : 'pre-wrap';
      // A one-line input centres its text vertically: one line as tall as its content box.
      if (isInput) layer.style.lineHeight = `${el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)}px`;
      // Exact (fractional) sizes, so the text wraps at the same places.
      layer.style.width = cs.boxSizing === 'border-box' ? cs.width : `${el.offsetWidth}px`;
      layer.style.height = cs.boxSizing === 'border-box' ? cs.height : `${el.offsetHeight}px`;
      // A scrollbar inside the field narrows its text area: keep the wrapping the same.
      const scrollbar = el.offsetWidth - el.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      if (scrollbar > 0) layer.style.paddingRight = `${parseFloat(cs.paddingRight) + scrollbar}px`;
      // Line up with the field whatever the positioned ancestor is.
      layer.style.left = '0px';
      layer.style.top = '0px';
      const a = el.getBoundingClientRect();
      const b = layer.getBoundingClientRect();
      layer.style.left = `${a.left - b.left}px`;
      layer.style.top = `${a.top - b.top}px`;
      layer.scrollTop = el.scrollTop;
      layer.scrollLeft = el.scrollLeft;
    };

    const render = () => {
      const text = el.value;
      let html = '';
      let at = 0;
      for (const issue of state.issues) {
        html += escapeHtml(text.slice(at, issue.start));
        html += `<span class="spell-bad">${escapeHtml(text.slice(issue.start, issue.end))}</span>`;
        at = issue.end;
      }
      // A trailing newline needs something after it to take up its line.
      html += `${escapeHtml(text.slice(at))}${isInput ? '' : '​'}`;
      layer.innerHTML = html;
      place();
    };

    state.check = async () => {
      if (!state.active) return;
      const text = el.value;
      const tokens = tokenize(text);
      await judge(tokens.map((t) => t.word));
      if (el.value !== text) return; // changed while checking: the next check draws it
      state.issues = tokens.filter((t) => verdict.get(t.word) === false && !state.ignored.has(t.word.toLowerCase()));
      render();
    };
    state.schedule = () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(state.check, DELAY);
    };
    state.disable = () => {
      state.active = false;
      layer.remove();
      el.spellcheck = true;
    };
    // The flagged word under a point (click / right-click), from the layer's underlines.
    // rectOf() gives the word's box now (the layer's underline span), so the popup follows the
    // word when the page, a dialog or the textarea scrolls; null once it is out of view.
    state.issueAt = (x, y) => {
      const marks = [...layer.querySelectorAll('.spell-bad')];
      for (let i = 0; i < marks.length; i += 1) {
        const rects = [...marks[i].getClientRects()];
        for (let k = 0; k < rects.length; k += 1) {
          const r = rects[k];
          if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) {
            const mark = marks[i];
            return {
              issue: state.issues[i],
              rectOf: () => {
                if (!mark.isConnected) return null;
                const now = mark.getClientRects()[k] || mark.getBoundingClientRect();
                const box = el.getBoundingClientRect();
                // Scrolled out of the textarea.
                if (now.bottom < box.top || now.top > box.bottom || now.right < box.left || now.left > box.right) return null;
                return now;
              },
            };
          }
        }
      }
      return null;
    };
    state.replace = (issue, text) => {
      if (el.value.slice(issue.start, issue.end) !== issue.word) { state.check(); return; }
      el.focus();
      el.setSelectionRange(issue.start, issue.end);
      // insertText keeps Ctrl+Z working; setRangeText where it is not supported.
      if (!document.execCommand('insertText', false, text)) {
        el.setRangeText(text, issue.start, issue.end, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      state.check();
    };
    state.focus = () => el.focus();

    el.addEventListener('input', () => { place(); state.schedule(); });
    el.addEventListener('scroll', () => { layer.scrollTop = el.scrollTop; layer.scrollLeft = el.scrollLeft; });
    el.addEventListener('focus', place);
    el.form?.addEventListener('reset', () => setTimeout(state.check, 0));
    if (window.ResizeObserver) new ResizeObserver(place).observe(el);
    window.addEventListener('resize', place);
    document.addEventListener('animationend', place, true);
    document.addEventListener('toggle', place, true);

    const open = (event, viaMenu) => {
      if (!viaMenu && el.selectionStart !== el.selectionEnd) return; // selecting text
      const hit = state.issueAt(event.clientX, event.clientY);
      if (!hit) return;
      if (viaMenu) event.preventDefault();
      showPopup(state, hit.issue, hit.rectOf);
    };
    el.addEventListener('click', (e) => open(e, false));
    el.addEventListener('contextmenu', (e) => open(e, true));
    return state;
  }

  // ---- Rich text: CSS Custom Highlight API (the HTML is never changed) ----
  const ceRanges = new Map(); // state -> [{ range, word, node, start, end }]
  let highlight = null;
  function paintHighlights() {
    const all = [];
    ceRanges.forEach((list) => list.forEach((i) => all.push(i.range)));
    highlight = new Highlight(...all);
    CSS.highlights.set('spell-error', highlight);
  }

  function richField(el) {
    el.spellcheck = false;
    const state = { el, ignored: new Set(), timer: null, active: true };
    state.check = async () => {
      if (!state.active) return;
      const found = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement && node.parentElement.closest('code, pre')) continue;
        tokenize(node.data).forEach((t) => found.push({ ...t, node }));
      }
      await judge(found.map((t) => t.word));
      const list = found
        .filter((t) => verdict.get(t.word) === false && !state.ignored.has(t.word.toLowerCase()) && t.node.isConnected && t.node.data.slice(t.start, t.end) === t.word)
        .map((t) => {
          const range = new Range();
          range.setStart(t.node, t.start);
          range.setEnd(t.node, t.end);
          return { ...t, range, issue: t };
        });
      ceRanges.set(state, list);
      paintHighlights();
    };
    state.schedule = () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(state.check, DELAY);
    };
    state.disable = () => {
      state.active = false;
      ceRanges.delete(state);
      paintHighlights();
      el.spellcheck = true;
    };
    state.issueAt = (x, y) => {
      for (const item of ceRanges.get(state) || []) {
        const rects = [...item.range.getClientRects()];
        for (let k = 0; k < rects.length; k += 1) {
          const r = rects[k];
          if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) {
            return {
              issue: item,
              rectOf: () => (item.node.isConnected ? item.range.getClientRects()[k] || item.range.getBoundingClientRect() : null),
            };
          }
        }
      }
      return null;
    };
    state.replace = (issue, text) => {
      const { node, start, end, word } = issue;
      if (!node.isConnected || node.data.slice(start, end) !== word) { state.check(); return; }
      // Focus first, so editors that remember the text on focus (the Daily Report lines) see
      // the replacement as a change.
      el.focus();
      node.replaceData(start, end - start, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const sel = window.getSelection();
      const caret = new Range();
      caret.setStart(node, start + text.length);
      sel.removeAllRanges();
      sel.addRange(caret);
      state.check();
    };
    state.focus = () => el.focus();
    new MutationObserver(() => state.schedule()).observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('click', (e) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const hit = state.issueAt(e.clientX, e.clientY);
      if (hit) showPopup(state, hit.issue, hit.rectOf);
    });
    el.addEventListener('contextmenu', (e) => {
      const hit = state.issueAt(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      showPopup(state, hit.issue, hit.rectOf);
    });
    return state;
  }

  // ---- The popup ----
  // The field keeps focus the whole time: pressing on the popup is preventDefault-ed (no blur,
  // so the Daily Report lines and popovers stay as they are), the arrow keys move a highlight
  // in the popup while typing stays in the field, and Enter runs the highlighted item. Clicks
  // inside the popup never reach the page's click-outside handlers (inline popovers, menus).
  let pop = null;
  let popState = null;
  let popIssue = null;
  let placePop = null; // repositions the open popup from its word (scroll / resize)
  let active = -1; // the highlighted item (keyboard)
  function closePopup() {
    if (!pop) return;
    try { if (pop.matches(':popover-open')) pop.hidePopover(); } catch (err) { /* not a popover */ }
    pop.remove();
    placePop = null;
    pop = null;
    popState = null;
    popIssue = null;
    active = -1;
  }

  // A small toast in the page's toast area (foot.ejs [data-toasts]).
  function toast(text, isError) {
    const box = document.querySelector('[data-toasts]');
    if (!box) return;
    const t = document.createElement('div');
    t.className = isError ? 'toast toast-error' : 'toast toast-saved';
    t.setAttribute('role', isError ? 'alert' : 'status');
    if (!isError) t.innerHTML = '<span class="toast-icon toast-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><path d="M7.5 12.5l3 3 6-6.5"></path></svg></span>';
    const span = document.createElement('span');
    span.textContent = text;
    t.append(span);
    box.append(t);
    setTimeout(() => { t.classList.add('is-leaving'); setTimeout(() => t.remove(), 300); }, isError ? 5000 : 2500);
  }

  // A suggestion in the flagged word's capitalisation: "teh" -> "the", "Teh" -> "The", "TEH" -> "THE".
  function matchCase(word, s) {
    if (word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase()) return s.toUpperCase();
    const first = word.charAt(0);
    if (first && first === first.toUpperCase() && first !== first.toLowerCase()) return s.charAt(0).toUpperCase() + s.slice(1);
    return s;
  }

  // The field gets the focus back if it lost it (the caret stays where it was).
  const keepFocus = (state) => {
    const a = document.activeElement;
    if (!a || a === document.body || (a !== state.el && !state.el.contains(a))) state.focus();
  };

  // The actions, the same for a click and for Enter.
  function runAction(btn) {
    if (!btn || !pop || btn.disabled) return;
    const state = popState;
    const issue = popIssue;
    if (btn.dataset.suggestion !== undefined) {
      closePopup();
      state.replace(issue, matchCase(issue.word, btn.dataset.suggestion));
    } else if (btn.dataset.action === 'ignore') {
      closePopup();
      state.ignored.add(issue.word.toLowerCase());
      keepFocus(state);
      state.check();
    } else if (btn.dataset.action === 'add') {
      addWord(btn, issue);
    }
  }

  async function addWord(btn, issue) {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const res = await fetch('/spell/words', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrfToken, word: issue.word }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'The word could not be added to the dictionary.');
      if (worker) worker.postMessage({ type: 'add', word: data.word || issue.word });
      // Every spelling of it (any case) is fine now, in every field on the page.
      const lower = issue.word.toLowerCase();
      verdict.set(issue.word, true);
      [...verdict.keys()].forEach((w) => { if (w.toLowerCase() === lower) verdict.set(w, true); });
      const state = popState;
      if (popIssue === issue) closePopup();
      if (state) keepFocus(state);
      fields.forEach((f) => f.check());
      toast(`Added "${issue.word}" to the dictionary.`);
      loadWords();
    } catch (err) {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Add to dictionary'; }
      toast(err.message && err.message !== 'Failed to fetch' ? err.message : 'Could not reach the portal. The word was not added.', true);
    }
  }

  const items = () => (pop ? [...pop.querySelectorAll('.spell-opt')] : []);
  function highlightItem(i) {
    const all = items();
    if (!all.length) return;
    active = (i + all.length) % all.length;
    all.forEach((b, k) => b.classList.toggle('is-active', k === active));
    all[active].scrollIntoView({ block: 'nearest' });
  }

  function showPopup(state, issue, rectOf) {
    closePopup();
    popState = state;
    popIssue = issue;
    pop = document.createElement('div');
    pop.className = 'spell-pop';
    pop.setAttribute('role', 'menu');
    pop.setAttribute('aria-label', `Spelling: ${issue.word}`);
    const list = document.createElement('div');
    list.className = 'spell-pop-list';
    list.innerHTML = '<span class="skeleton"></span><span class="skeleton skeleton-short"></span>';
    const sep = document.createElement('div');
    sep.className = 'spell-pop-sep';
    const action = (label, key) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.className = 'spell-opt spell-opt-action';
      b.setAttribute('role', 'menuitem');
      b.dataset.action = key;
      b.textContent = label;
      return b;
    };
    pop.append(list, sep, action('Ignore', 'ignore'), action('Add to dictionary', 'add'));
    // Pressing on the popup keeps the focus (and the caret) in the field; the click itself
    // runs the action and goes no further, so no click-outside handler closes what is behind.
    pop.addEventListener('pointerdown', (e) => e.preventDefault());
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    pop.addEventListener('click', (e) => {
      e.stopPropagation();
      runAction(e.target.closest('.spell-opt'));
    });
    pop.addEventListener('mousemove', (e) => {
      const b = e.target.closest('.spell-opt');
      if (b) highlightItem(items().indexOf(b));
    });
    // In the browser's top layer (popover API), so it sits above everything and no parent
    // transform (e.g. a dialog's scale-in) can move it. Inside an open modal dialog it is put
    // in that dialog: everything outside a modal dialog is inert and could not be clicked.
    const host = state.el.closest('dialog[open]') || document.body;
    host.appendChild(pop);
    if (typeof pop.showPopover === 'function') {
      pop.setAttribute('popover', 'manual');
      pop.showPopover();
    }

    // Just below the word (6px), left edges aligned; above it when there is no room below;
    // kept inside the window. Closed when the word scrolls out of view.
    const position = () => {
      const rect = rectOf();
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
        closePopup();
        return;
      }
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 8);
      let top = rect.bottom + 6;
      if (top + h > window.innerHeight - 8) top = rect.top - h - 6 >= 8 ? rect.top - h - 6 : Math.max(8, window.innerHeight - h - 8);
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
      pop.classList.toggle('is-above', top < rect.top);
    };
    placePop = position;
    position();
    if (!pop) return;

    if (!startWorker()) return;
    ask({ type: 'suggest', word: issue.word }).then((reply) => {
      if (!pop || popIssue !== issue) return;
      list.replaceChildren();
      const suggestions = reply.suggestions || [];
      if (!suggestions.length) {
        const none = document.createElement('p');
        none.className = 'spell-none';
        none.textContent = 'No suggestions';
        list.appendChild(none);
      }
      suggestions.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.tabIndex = -1;
        b.className = 'spell-opt spell-suggestion';
        b.setAttribute('role', 'menuitem');
        b.dataset.suggestion = s;
        b.textContent = matchCase(issue.word, s);
        list.appendChild(b);
      });
      // The highlight moves with the items (it was on Ignore / Add while loading).
      if (active >= 0) highlightItem(active + suggestions.length);
      position();
    });
  }
  // While the popup is open (focus stays in the field): Down / Up highlight an item, Enter runs
  // the highlighted one, Esc closes, and any other key closes it (the person carries on typing).
  document.addEventListener('keydown', (e) => {
    if (!pop || !popState || e.target !== popState.el) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      highlightItem(active < 0 ? (e.key === 'ArrowDown' ? 0 : -1) : active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      e.stopPropagation();
      runAction(items()[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePopup();
    } else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
      closePopup();
    }
  }, true);
  // A press anywhere else closes it; the popup and everything in it count as inside.
  document.addEventListener('pointerdown', (e) => {
    if (pop && !(e.target instanceof Node && pop.contains(e.target))) closePopup();
  }, true);
  // The field losing focus closes it too, unless the focus is going into the popup.
  document.addEventListener('focusout', (e) => {
    if (!pop || !popState || e.target !== popState.el) return;
    if (e.relatedTarget instanceof Node && pop.contains(e.relatedTarget)) return;
    setTimeout(() => { if (pop && popState && document.activeElement !== popState.el && !pop.contains(document.activeElement)) closePopup(); }, 0);
  }, true);
  // Page, dialog or textarea scrolls and window resizes move the popup with its word.
  let framed = false;
  const follow = (e) => {
    if (!pop || !placePop || (e && e.target instanceof Node && pop.contains(e.target)) || framed) return;
    framed = true;
    requestAnimationFrame(() => { framed = false; if (placePop) placePop(); });
  };
  window.addEventListener('scroll', follow, true);
  window.addEventListener('resize', follow);

  // ---- Which fields ----
  function eligible(el) {
    if (el.closest('[data-spell="off"]')) return false;
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (el.tagName === 'INPUT') return el.type === 'text' && el.hasAttribute('data-spell') && !el.readOnly;
    return el.isContentEditable && el.hasAttribute('data-spell') && highlights;
  }
  const attached = new WeakMap();
  function attach(el) {
    if (attached.has(el) || failed || !eligible(el)) return attached.get(el) || null;
    const state = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? textField(el) : richField(el);
    attached.set(el, state);
    fields.add(state);
    startWorker();
    state.check();
    return state;
  }
  // Fields with text on screen now; the rest when they are first focused (closed popovers,
  // dialogs and fields added later by scripts).
  document.querySelectorAll('textarea, input[type="text"][data-spell], [contenteditable][data-spell]').forEach((el) => {
    const hasText = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value.trim() : el.textContent.trim();
    if (hasText && el.offsetParent !== null) attach(el);
  });
  const onEdit = (e) => {
    const el = e.target;
    if (el instanceof Element && el.matches('textarea, input[type="text"][data-spell], [contenteditable][data-spell]') && !attached.has(el)) {
      const state = attach(el);
      if (state && e.type === 'input') state.schedule();
    }
  };
  document.addEventListener('focusin', onEdit);
  document.addEventListener('input', onEdit);
  // Rich previews are filled in by scripts: watch them from the start.
  document.querySelectorAll('[contenteditable][data-spell]').forEach((el) => attach(el));
})();
