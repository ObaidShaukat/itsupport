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
// "Add to dictionary" (everyone, POST /spell/words). Arrow keys + Enter, Esc closes.
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
    state.issueAt = (x, y) => {
      const marks = [...layer.querySelectorAll('.spell-bad')];
      for (let i = 0; i < marks.length; i += 1) {
        for (const r of marks[i].getClientRects()) {
          if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return { issue: state.issues[i], rect: r };
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
      showPopup(state, hit.issue, hit.rect);
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
        for (const r of item.range.getClientRects()) {
          if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return { issue: item, rect: r };
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
      if (hit) showPopup(state, hit.issue, hit.rect);
    });
    el.addEventListener('contextmenu', (e) => {
      const hit = state.issueAt(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      showPopup(state, hit.issue, hit.rect);
    });
    return state;
  }

  // ---- The popup ----
  let pop = null;
  let popState = null;
  function closePopup(refocus) {
    if (!pop) return;
    pop.remove();
    pop = null;
    if (refocus && popState) popState.focus();
    popState = null;
  }

  function showPopup(state, issue, rect) {
    closePopup(false);
    popState = state;
    pop = document.createElement('div');
    pop.className = 'spell-pop';
    pop.setAttribute('role', 'menu');
    pop.setAttribute('aria-label', `Spelling: ${issue.word}`);
    const list = document.createElement('div');
    list.className = 'spell-pop-list';
    list.innerHTML = '<span class="skeleton"></span><span class="skeleton skeleton-short"></span>';
    const sep = document.createElement('div');
    sep.className = 'spell-pop-sep';
    const ignore = document.createElement('button');
    ignore.type = 'button';
    ignore.className = 'spell-opt spell-opt-action';
    ignore.setAttribute('role', 'menuitem');
    ignore.textContent = 'Ignore';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'spell-opt spell-opt-action';
    add.setAttribute('role', 'menuitem');
    add.textContent = 'Add to dictionary';
    pop.append(list, sep, ignore, add);
    // Inside an open <dialog> the popup must be in the dialog to show above it.
    const host = state.el.closest('dialog[open]') || document.body;
    host.appendChild(pop);

    const position = () => {
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      let left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 8);
      let top = rect.bottom + 6;
      if (top + h > window.innerHeight - 8 && rect.top - h - 6 > 8) top = rect.top - h - 6;
      left = Math.round(left);
      pop.style.left = `${left}px`;
      pop.style.top = `${Math.round(top)}px`;
    };
    position();

    const items = () => [...pop.querySelectorAll('.spell-opt')];
    const focusItem = (i) => { const all = items(); if (all.length) all[(i + all.length) % all.length].focus(); };

    ignore.addEventListener('click', () => {
      state.ignored.add(issue.word.toLowerCase());
      closePopup(true);
      state.check();
    });
    add.addEventListener('click', async () => {
      add.disabled = true;
      try {
        const res = await fetch('/spell/words', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _csrf: csrfToken, word: issue.word }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'The word could not be added.');
        worker.postMessage({ type: 'add', word: data.word });
        verdict.set(issue.word, true);
        closePopup(true);
        fields.forEach((f) => f.check());
      } catch (err) {
        add.disabled = false;
        add.textContent = err.message;
      }
    });
    pop.addEventListener('keydown', (e) => {
      const all = items();
      const i = all.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(i - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
      else if (e.key === 'End') { e.preventDefault(); focusItem(all.length - 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopup(true); }
      else if (e.key === 'Tab') { closePopup(false); }
    });

    if (!startWorker()) return;
    ask({ type: 'suggest', word: issue.word }).then((reply) => {
      if (!pop || popState !== state) return;
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
        b.className = 'spell-opt spell-suggestion';
        b.setAttribute('role', 'menuitem');
        b.textContent = s;
        b.addEventListener('click', () => { closePopup(false); state.replace(issue, s); });
        list.appendChild(b);
      });
      position();
    });
  }
  // While the popup is open, arrow keys in the field move into it, Esc closes it and any other
  // key closes it (the person carries on typing). The field keeps focus after a click.
  document.addEventListener('keydown', (e) => {
    if (!pop || !popState || e.target !== popState.el) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...pop.querySelectorAll('.spell-opt')];
      if (all.length) all[e.key === 'ArrowDown' ? 0 : all.length - 1].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePopup(false);
    } else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
      closePopup(false);
    }
  }, true);
  document.addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target)) closePopup(false); }, true);
  window.addEventListener('scroll', (e) => { if (pop && !pop.contains(e.target)) closePopup(false); }, true);
  window.addEventListener('resize', () => closePopup(false));

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
