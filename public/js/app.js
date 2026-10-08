// Small progressive enhancements. Everything works without JavaScript except
// the delete confirmations and the flowchart.

// Ask before submitting forms marked with data-confirm (deletes), in a popup with
// Cancel and Delete. Falls back to the browser's confirm() without <dialog> support.
const confirmDialog = document.getElementById('confirm-dialog');
let pendingForm = null;

document.addEventListener('submit', (event) => {
  const form = event.target;
  const message = form.dataset && form.dataset.confirm;
  if (!message) return;
  if (!confirmDialog || typeof confirmDialog.showModal !== 'function') {
    if (!window.confirm(message)) event.preventDefault();
    return;
  }
  event.preventDefault();
  pendingForm = form;
  confirmDialog.querySelector('.confirm-message').textContent = message;
  // The confirm button says "Delete" unless the form names its action (data-confirm-ok).
  confirmDialog.querySelector('[data-confirm-ok]').textContent = form.dataset.confirmOk || 'Delete';
  confirmDialog.showModal();
  confirmDialog.querySelector('[data-confirm-cancel]').focus();
});

if (confirmDialog) {
  confirmDialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-confirm-ok]') && pendingForm) {
      const form = pendingForm;
      pendingForm = null;
      confirmDialog.close();
      form.submit(); // submit() does not fire the submit event again.
    } else if (event.target === confirmDialog || event.target.closest('[data-confirm-cancel]')) {
      confirmDialog.close();
    }
  });
  confirmDialog.addEventListener('close', () => { pendingForm = null; });
}

// Inline edit popovers (<details class="edit">). Only one is open at a time.
// Cancel, Esc or a click outside closes it, and closing discards unsaved changes.
const openPopovers = () => document.querySelectorAll('details.edit[open]');

function closePopover(details, { focusSummary = false } = {}) {
  details.open = false;
  if (focusSummary) details.querySelector('summary')?.focus();
}

document.addEventListener('toggle', (event) => {
  const details = event.target;
  if (!details.matches || !details.matches('details.edit')) return;

  if (!details.open) {
    details.querySelectorAll('form').forEach((form) => form.reset());
    return;
  }
  openPopovers().forEach((other) => {
    if (other !== details) closePopover(other);
  });
  const input = details.querySelector('input:not([type="hidden"]), textarea, select');
  if (input) input.focus();
}, true);

document.addEventListener('click', (event) => {
  const cancel = event.target.closest('[data-cancel]');
  if (cancel) {
    const details = cancel.closest('details.edit');
    if (details) closePopover(details, { focusSummary: true });
    return;
  }
  // Clicks inside a popup opened from a popover (e.g. Crop picture) leave it open.
  if (event.target.closest && event.target.closest('dialog')) return;
  openPopovers().forEach((details) => {
    if (!details.contains(event.target)) closePopover(details);
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // Esc closes the open popup first (the browser does that), not the popover behind it.
  if (document.querySelector('dialog[open]')) return;
  openPopovers().forEach((details) => closePopover(details, { focusSummary: true }));
});

// Instant client-side search. <input data-filter="#scope"> filters the
// [data-filter-item] elements inside #scope by their data-search text.
// [data-filter-group] elements (e.g. service categories) stay visible when their
// [data-filter-label] matches or any of their items match. [data-filter-empty]
// is shown when a search matches nothing.
const normalise = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim();
const searchText = (el) => normalise(el.dataset.search ?? el.textContent);

document.querySelectorAll('input[data-filter]').forEach((input) => {
  const scope = document.querySelector(input.dataset.filter);
  if (!scope) return;
  const groups = scope.querySelectorAll('[data-filter-group]');
  const empty = scope.querySelector('[data-filter-empty]');

  const apply = () => {
    const query = normalise(input.value);
    let visible = 0;

    if (groups.length) {
      groups.forEach((group) => {
        const label = group.querySelector('[data-filter-label]');
        const groupMatches = !query || (label && searchText(label).includes(query));
        let anyItem = false;
        group.querySelectorAll('[data-filter-item]').forEach((item) => {
          const show = groupMatches || searchText(item).includes(query);
          item.hidden = !show;
          if (show) anyItem = true;
        });
        group.hidden = !(groupMatches || anyItem);
        if (!group.hidden) visible++;
      });
    } else {
      scope.querySelectorAll('[data-filter-item]').forEach((item) => {
        const show = !query || searchText(item).includes(query);
        item.hidden = !show;
        if (show) visible++;
      });
    }

    if (empty) empty.hidden = !query || visible > 0;
  };

  input.addEventListener('input', apply);
  // Browsers may restore the box's text on back/forward navigation.
  if (input.value) apply();
});

// Render Mermaid flowcharts (the library is only loaded on service pages).
let chartCount = 0;

async function renderFlowchart(container, definition) {
  try {
    const { svg } = await window.mermaid.render(`flowchart-${++chartCount}`, definition);
    container.innerHTML = svg;
  } catch (err) {
    container.innerHTML = '<p class="is-error small">The flowchart could not be drawn. Refresh the page to try again.</p>';
  }
}

if (window.mermaid) {
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontSize: '14px',
      primaryColor: '#FFFFFF',
      primaryBorderColor: '#6741C3',
      primaryTextColor: '#000000',
      lineColor: '#0390D7',
    },
    flowchart: {
      curve: 'basis',
      useMaxWidth: true,
      nodeSpacing: 40,
      rankSpacing: 38,
      padding: 18,
      diagramPadding: 12,
    },
  });
  window.mermaid.run({ querySelector: 'pre.mermaid' });
}

// Drag-and-drop step reordering (SortableJS is only loaded on service pages).
// Each drop is saved straight away and the flowchart is redrawn from the reply.
const stepList = document.querySelector('[data-sortable-steps]');
if (stepList && window.Sortable) {
  const status = document.querySelector('[data-reorder-status]');
  const chart = document.querySelector('[data-flowchart]');
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

  const showStatus = (message, isError) => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(isError));
    status.hidden = !message;
  };

  const renumber = () => {
    stepList.querySelectorAll('.step-num').forEach((num, i) => {
      num.textContent = String(i + 1);
    });
  };

  window.Sortable.create(stepList, {
    handle: '.drag-handle',
    animation: 160,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd: async (event) => {
      if (event.oldIndex === event.newIndex) return;
      renumber();
      const order = [...stepList.querySelectorAll(':scope > li[data-id]')].map((li) => li.dataset.id);
      stepList.classList.add('is-saving');
      showStatus('Saving order…');
      try {
        const res = await fetch(stepList.dataset.orderUrl, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _csrf: csrfToken, order: order.join(',') }),
          credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'The new order could not be saved.');
        if (chart && window.mermaid) await renderFlowchart(chart, data.flowchart);
        showStatus('Order saved.');
        setTimeout(() => showStatus(''), 2000);
      } catch (err) {
        showStatus(`${err.message} Reloading…`, true);
        setTimeout(() => window.location.reload(), 1500);
      } finally {
        stepList.classList.remove('is-saving');
      }
    },
  });
}

// "Log work" dialog. Without JavaScript (or <dialog> support) the button is a
// plain link to the /log-work page.
const logWorkDialog = document.getElementById('log-work-dialog');
if (logWorkDialog && typeof logWorkDialog.showModal === 'function') {
  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-log-work]');
    if (!opener) return;
    event.preventDefault();
    logWorkDialog.querySelector('form').reset();
    logWorkDialog.showModal();
    logWorkDialog.querySelector('textarea').focus();
  });
  logWorkDialog.addEventListener('click', (event) => {
    // A click on the backdrop lands on the dialog element itself.
    if (event.target === logWorkDialog || event.target.closest('[data-dialog-close]')) logWorkDialog.close();
  });
}

// Daily Report: the preview is editable, and both copy buttons read what is shown
// (including edits). "Copy for email" puts rich HTML (bold names, real bullets,
// Calibri 11pt) on the clipboard with plain text as the fallback.
// navigator.clipboard needs HTTPS; over plain http the older execCommand route is used.
const lineText = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function readPreview(preview) {
  return [...preview.querySelectorAll('[data-report-day]')].map((day) => ({
    title: day.querySelector('[data-report-day-title]') ? lineText(day.querySelector('[data-report-day-title]')) : '',
    users: [...day.querySelectorAll('[data-report-user]')].map((user) => ({
      heading: lineText(user.querySelector('[data-report-heading]') || user),
      lines: [...user.querySelectorAll('li')].map(lineText).filter(Boolean),
    })).filter((u) => u.heading || u.lines.length),
  }));
}

function previewToText(days) {
  return days.map((day) => {
    const blocks = day.users.map((u) => [u.heading, ...u.lines.map((l) => `- ${l}`)].join('\n')).join('\n\n');
    return (day.title ? `${day.title}\n\n` : '') + blocks;
  }).join('\n\n\n');
}

function previewToHtml(days) {
  const font = 'font-family: Calibri, Arial, sans-serif; font-size: 11pt;';
  const parts = days.map((day) => {
    const title = day.title ? `<p style="${font} margin: 12pt 0 6pt;"><b><u>${escapeHtml(day.title)}</u></b></p>` : '';
    const users = day.users.map((u) => `<p style="${font} margin: 0 0 4pt;"><b>${escapeHtml(u.heading)}</b></p>`
      + `<ul style="${font} margin: 0 0 12pt; padding-left: 18pt;">`
      + u.lines.map((l) => `<li style="${font} margin: 0 0 2pt;">${escapeHtml(l)}</li>`).join('')
      + '</ul>').join('');
    return title + users;
  });
  return `<div style="${font}">${parts.join('')}</div>`;
}

function copyWithSelection(node) {
  node.style.position = 'fixed';
  node.style.left = '-9999px';
  document.body.appendChild(node);
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  if (node.select) node.select();
  const ok = document.execCommand('copy');
  selection.removeAllRanges();
  node.remove();
  if (!ok) throw new Error('Copy was blocked by the browser.');
}

async function copyPlain(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  copyWithSelection(area);
}

async function copyRich(html, text) {
  if (navigator.clipboard && window.isSecureContext && window.ClipboardItem) {
    return navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  }
  const holder = document.createElement('div');
  holder.innerHTML = html;
  copyWithSelection(holder);
}

const reportPreview = document.querySelector('[data-report-preview]');
const copyStatus = document.querySelector('[data-copy-status]');
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!reportPreview) return;
    const days = readPreview(reportPreview);
    const text = previewToText(days);
    let message = '';
    let failed = false;
    try {
      if (button.dataset.copy === 'html') {
        try {
          await copyRich(previewToHtml(days), text);
          message = 'Copied for email. Paste it into Outlook.';
        } catch (err) {
          await copyPlain(text);
          message = 'Copied as plain text (formatted copy is not available in this browser).';
        }
      } else {
        await copyPlain(text);
        message = 'Copied as plain text.';
      }
    } catch (err) {
      failed = true;
      message = 'Could not copy automatically. Select the report and copy it by hand.';
    }
    if (copyStatus) {
      copyStatus.textContent = message;
      copyStatus.classList.toggle('is-error', failed);
      copyStatus.hidden = false;
      setTimeout(() => { copyStatus.hidden = true; }, 4000);
    }
  });
});

// Dashboard numbers count up from 0 (skipped when reduced motion is requested).
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
document.querySelectorAll('.stat-value').forEach((el) => {
  const target = Number(el.textContent.trim());
  if (reduceMotion || !Number.isFinite(target) || target <= 0) return;
  const duration = Math.min(1200, 400 + target * 40);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = String(Math.round(target * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  el.textContent = '0';
  requestAnimationFrame(step);
});

// ---- Reminders: bell, toasts and quick picks ----
// Polls /notifications/poll on load and every 60 seconds. The server turns the user's
// due ticket reminders into notifications; due and missed ones stay as toasts until
// Done or Snooze, and a short soft sound plays once when one first appears.
const bell = document.querySelector('[data-bell]');
if (bell) {
  const bellToggle = bell.querySelector('[data-bell-toggle]');
  const bellPanel = bell.querySelector('[data-bell-panel]');
  const bellList = bell.querySelector('[data-bell-list]');
  const bellCount = bell.querySelector('[data-bell-count]');
  const toastBox = document.querySelector('[data-toasts]');
  const bellToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const MAX_TOASTS = 4;
  const toasts = new Map(); // reminder id -> toast element

  const post = (url, data = {}) => fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: bellToken, ...data }),
    credentials: 'same-origin',
  }).then((r) => r.json().catch(() => ({ ok: false }))).catch(() => ({ ok: false }));

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgIcon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  };

  // Two soft sine notes. Browsers may block sound until the page has been clicked.
  function chime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const start = ctx.currentTime + 0.02;
      [[660, 0], [880, 0.16]].forEach(([freq, at]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start + at);
        gain.gain.exponentialRampToValueAtTime(0.07, start + at + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + at);
        osc.stop(start + at + 0.55);
      });
      setTimeout(() => ctx.close(), 1500);
    } catch (err) {
      // No sound available: the toast is enough.
    }
  }

  // "#12 Title", client, note and time for one reminder.
  function reminderBody(r, linkTitle) {
    const wrap = el('div', 'notice-body');
    const title = el(linkTitle ? 'a' : 'span', 'notice-title', `#${r.ticketId} ${r.ticketTitle}`);
    if (linkTitle) title.href = r.link;
    wrap.appendChild(title);
    wrap.appendChild(el('div', 'muted small', r.client));
    if (r.note) wrap.appendChild(el('div', 'small notice-note', r.note));
    wrap.appendChild(el('div', 'muted small', r.time));
    return wrap;
  }

  function removeToast(id) {
    const box = toasts.get(id);
    if (!box) return;
    toasts.delete(id);
    box.classList.add('is-leaving');
    setTimeout(() => box.remove(), 250);
  }

  function toast(r) {
    const box = el('div', 'toast');
    box.setAttribute('role', 'alert');
    const iconWrap = el('span', 'toast-icon');
    iconWrap.appendChild(svgIcon('bell'));
    box.appendChild(iconWrap);
    box.appendChild(reminderBody(r, true));

    const actions = el('div', 'notice-actions');
    const open = el('a', 'btn btn-small', 'Open ticket');
    open.href = r.link;
    actions.appendChild(open);
    const add = (label, url, data, primary) => {
      const b = el('button', `btn btn-small ${primary ? 'btn-primary' : 'btn-ghost'}`, label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        actions.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        const res = await post(url, data);
        if (res.ok) removeToast(r.id);
        else actions.querySelectorAll('button').forEach((x) => { x.disabled = false; });
        poll();
      });
      actions.appendChild(b);
    };
    add('Done', `/reminders/${r.id}/done`, {}, true);
    add('Snooze 10 min', `/reminders/${r.id}/snooze`, { until: '10m' });
    add('1 hour', `/reminders/${r.id}/snooze`, { until: '1h' });
    add('Tomorrow 09:00', `/reminders/${r.id}/snooze`, { until: 'tomorrow' });
    box.appendChild(actions);
    return box;
  }

  // Shows the due and missed reminders as toasts (up to MAX_TOASTS, plus a "more" note)
  // and removes toasts for reminders that were done or snoozed elsewhere.
  function renderToasts(list) {
    if (!toastBox) return;
    const visible = list.slice(0, MAX_TOASTS);
    const ids = new Set(visible.map((r) => r.id));
    for (const id of [...toasts.keys()]) if (!ids.has(id)) removeToast(id);
    for (const r of visible) {
      if (toasts.has(r.id)) continue;
      const box = toast(r);
      toasts.set(r.id, box);
      toastBox.appendChild(box);
    }
    let more = toastBox.querySelector('[data-toast-more]');
    const extra = list.length - visible.length;
    if (extra > 0) {
      if (!more) {
        more = el('button', 'btn btn-small toast-more');
        more.type = 'button';
        more.dataset.toastMore = '';
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          bellPanel.hidden = false;
          bellToggle.setAttribute('aria-expanded', 'true');
        });
      }
      more.textContent = `+${extra} more due — open the bell`;
      toastBox.appendChild(more);
    } else if (more) {
      more.remove();
    }
  }

  function renderBell(data) {
    const count = Number(data.count) || 0;
    bellCount.textContent = count > 99 ? '99+' : String(count);
    bellCount.hidden = count === 0;
    bell.classList.toggle('has-unread', count > 0);
    bellToggle.setAttribute('aria-label', count ? `Reminders (${count} due)` : 'Reminders');
    bellList.replaceChildren();
    const groups = [
      ['due', 'Due now', data.due],
      ['missed', 'Missed', data.missed],
      ['upcoming', 'Upcoming (next 7 days)', data.upcoming],
    ];
    for (const [key, label, items] of groups) {
      if (!items.length) continue;
      const group = el('section', `bell-group bell-group-${key}`);
      group.appendChild(el('h3', '', `${label} (${items.length})`));
      const ul = el('ul');
      for (const r of items) {
        const li = el('li');
        const link = el('a', 'notice');
        link.href = r.link;
        link.appendChild(reminderBody(r, false));
        li.appendChild(link);
        ul.appendChild(li);
      }
      group.appendChild(ul);
      bellList.appendChild(group);
    }
    if (!bellList.children.length) bellList.appendChild(el('p', 'empty small', 'No reminders due in the next 7 days.'));
  }

  async function poll() {
    try {
      const res = await fetch('/notifications/poll', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok) return;
      renderBell(data);
      // "Email only" users (My profile) get no popups.
      renderToasts(data.popup === false ? [] : [...data.due, ...data.missed]);
      if (data.sound) chime();
    } catch (err) {
      // Offline or signed out: try again on the next tick.
    }
  }

  bellToggle.addEventListener('click', () => {
    const show = bellPanel.hidden;
    bellPanel.hidden = !show;
    bellToggle.setAttribute('aria-expanded', String(show));
    if (show) poll();
  });
  document.addEventListener('click', (e) => {
    if (!bellPanel.hidden && !bell.contains(e.target)) {
      bellPanel.hidden = true;
      bellToggle.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bellPanel.hidden) {
      bellPanel.hidden = true;
      bellToggle.setAttribute('aria-expanded', 'false');
      bellToggle.focus();
    }
  });

  poll();
  setInterval(poll, 60000);
}

// Reminder forms: quick picks fill the date/time field with a UK (Europe/London) time,
// whatever the computer's own time zone. Custom opens the field for any time.
function londonParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}`, weekday: get('weekday') };
}
function plusDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function reminderPick(kind) {
  const now = londonParts(new Date());
  if (kind === '1h') {
    const later = londonParts(new Date(Date.now() + 3600000));
    return `${later.date}T${later.time}`;
  }
  if (kind === 'afternoon') return `${now.date}T15:00`;
  if (kind === 'tomorrow') return `${plusDays(now.date, 1)}T09:00`;
  if (kind === 'monday') {
    const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(now.weekday) + 1; // Mon = 1
    return `${plusDays(now.date, 8 - day)}T09:00`; // on a Monday: next week's
  }
  return null;
}
document.querySelectorAll('[data-reminder-when]').forEach((box) => {
  const input = box.querySelector('input[name="remind_at"]');
  const buttons = box.querySelectorAll('[data-pick]');
  const press = (active) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === active)));
  buttons.forEach((button) => {
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      press(button);
      const value = reminderPick(button.dataset.pick);
      if (value) {
        input.value = value;
        return;
      }
      input.focus();
      try { input.showPicker?.(); } catch (err) { /* not allowed here: the focused field is enough */ }
    });
  });
  input.addEventListener('input', () => {
    const custom = box.querySelector('[data-pick="custom"]');
    press(custom);
  });
});

// ---- Drag-and-drop lists ----

// Generic drag-and-drop ordering: <ul data-sortable-list data-order-url="..."
// data-order-extra="key=value"> with <li data-id>; saves order=<ids> on drop.
document.querySelectorAll('[data-sortable-list]').forEach((list) => {
  if (!window.Sortable) return;
  const status = list.parentElement.querySelector('[data-reorder-status]');
  const token = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const show = (msg, isError) => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle('is-error', Boolean(isError));
    status.hidden = !msg;
  };
  window.Sortable.create(list, {
    handle: '.drag-handle',
    animation: 160,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd: async (event) => {
      if (event.oldIndex === event.newIndex) return;
      const order = [...list.querySelectorAll(':scope > li[data-id]')].map((li) => li.dataset.id).join(',');
      const body = new URLSearchParams({ _csrf: token, order, ...Object.fromEntries(new URLSearchParams(list.dataset.orderExtra || '')) });
      show('Saving order…');
      try {
        const res = await fetch(list.dataset.orderUrl, {
          method: 'POST', body, credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'The new order could not be saved.');
        show('Order saved.');
        setTimeout(() => show(''), 2000);
      } catch (err) {
        show(`${err.message} Reloading…`, true);
        setTimeout(() => window.location.reload(), 1500);
      }
    },
  });
});

// Selects marked data-autosubmit submit their form when changed (e.g. Daily Report View).
document.querySelectorAll('select[data-autosubmit]').forEach((select) => {
  select.addEventListener('change', () => select.form && select.form.submit());
});

// ---- Searchable dropdown (combobox) ----
// Upgrades a native field marked data-combobox into a portal-styled, searchable
// dropdown: type to filter, Up/Down + Enter to choose, Esc or a click outside to close,
// and a clear (×) button. Works on:
//   <select data-combobox>                      submits the option value (e.g. client id)
//   <input list="some-datalist" data-combobox>  submits the option text (e.g. client name)
// The original field stays in the form (visually hidden) and is what gets submitted,
// so forms still work without JavaScript.
let comboboxCount = 0;

function enhanceCombobox(native) {
  if (native.dataset.comboboxReady) return;
  native.dataset.comboboxReady = '1';
  const isSelect = native.tagName === 'SELECT';
  const datalist = !isSelect && native.list;
  const id = `combobox-${++comboboxCount}`;

  // Options: [{ value, label }]. A select's empty option becomes the placeholder.
  const readOptions = () => (isSelect
    ? [...native.options].filter((o) => o.value !== '').map((o) => ({ value: o.value, label: o.textContent.trim() }))
    : [...(datalist ? datalist.options : [])].map((o) => ({ value: o.value, label: o.value })));
  let options = readOptions();
  const emptyOption = isSelect ? [...native.options].find((o) => o.value === '') : null;
  const placeholder = native.getAttribute('placeholder') || (emptyOption ? emptyOption.textContent.trim() : 'Search…');

  const wrap = document.createElement('div');
  wrap.className = 'combobox';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combobox-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${id}-list`);
  input.setAttribute('aria-autocomplete', 'list');
  if (native.id) {
    // Keep <label for="..."> working: the visible input takes over the id.
    input.id = native.id;
    native.removeAttribute('id');
  }
  const labelEl = native.closest('label');
  const labelText = labelEl ? (labelEl.querySelector('span') || labelEl).textContent.trim() : '';
  if (labelText) input.setAttribute('aria-label', labelText);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'combobox-clear';
  clear.setAttribute('aria-label', 'Clear');
  clear.textContent = '×';
  const toggle = document.createElement('span');
  toggle.className = 'combobox-arrow';
  toggle.setAttribute('aria-hidden', 'true');
  const list = document.createElement('ul');
  list.className = 'combobox-list';
  list.id = `${id}-list`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  native.parentNode.insertBefore(wrap, native);
  wrap.append(input, clear, toggle, list, native);
  native.classList.add('combobox-native');
  native.tabIndex = -1;
  native.setAttribute('aria-hidden', 'true');
  if (!isSelect) native.removeAttribute('list'); // no native datalist popup any more

  const currentLabel = () => {
    if (isSelect) {
      const o = options.find((x) => x.value === native.value);
      return o ? o.label : '';
    }
    return native.value;
  };
  const sync = () => {
    input.value = currentLabel();
    wrap.classList.toggle('has-value', Boolean(native.value));
  };

  let shown = [];
  let active = -1;

  function render(filter) {
    const q = filter.trim().toLowerCase();
    shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    list.replaceChildren();
    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'combobox-empty';
      li.textContent = 'No matches';
      list.appendChild(li);
    }
    shown.forEach((o, i) => {
      const li = document.createElement('li');
      li.id = `${id}-opt-${i}`;
      li.setAttribute('role', 'option');
      li.className = 'combobox-option';
      if (o.value === native.value && native.value !== '') li.classList.add('is-selected');
      li.setAttribute('aria-selected', String(i === active));
      // Highlight the typed part.
      const at = q ? o.label.toLowerCase().indexOf(q) : -1;
      if (at >= 0) {
        li.append(o.label.slice(0, at));
        const mark = document.createElement('mark');
        mark.textContent = o.label.slice(at, at + q.length);
        li.append(mark, o.label.slice(at + q.length));
      } else {
        li.textContent = o.label;
      }
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the input
        choose(o);
      });
      list.appendChild(li);
    });
    setActive(active >= shown.length ? shown.length - 1 : active);
  }

  function setActive(i) {
    active = i;
    [...list.querySelectorAll('.combobox-option')].forEach((li, n) => {
      li.classList.toggle('is-active', n === i);
      li.setAttribute('aria-selected', String(n === i));
    });
    if (i >= 0) {
      const li = list.querySelector(`#${id}-opt-${i}`);
      input.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function open() {
    if (!list.hidden) return;
    options = readOptions();
    active = -1;
    render(input.value === currentLabel() ? '' : input.value);
    const selected = shown.findIndex((o) => o.value === native.value && native.value !== '');
    if (selected >= 0) setActive(selected);
    list.hidden = false;
    wrap.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    list.hidden = true;
    wrap.classList.remove('is-open');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function setValue(value) {
    if (native.value === value) return sync();
    native.value = value;
    sync();
    native.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function choose(o) {
    setValue(o.value);
    close();
  }

  // Leaving the field: an exact (case-insensitive) match is accepted; anything else
  // goes back to the last chosen value, so only real clients are ever submitted.
  function commitTyped() {
    const typed = input.value.trim().toLowerCase();
    if (!typed) return setValue('');
    const match = options.find((o) => o.label.toLowerCase() === typed);
    if (match) setValue(match.value);
    else sync();
  }

  input.addEventListener('focus', () => input.select());
  input.addEventListener('click', open);
  input.addEventListener('input', () => {
    if (list.hidden) open();
    active = 0;
    render(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return open();
      const n = shown.length;
      if (!n) return undefined;
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
    } else if (e.key === 'Enter') {
      if (!list.hidden) {
        e.preventDefault(); // do not submit the form while choosing
        if (shown[active]) choose(shown[active]);
        else if (shown.length === 1) choose(shown[0]);
      }
    } else if (e.key === 'Escape') {
      if (!list.hidden) {
        e.preventDefault();
        e.stopPropagation(); // close only this list, not the dialog or popover
        close();
        sync();
      }
    } else if (e.key === 'Tab') {
      if (!list.hidden && shown[active] && input.value.trim()) choose(shown[active]);
      close();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (wrap.contains(document.activeElement)) return;
      close();
      commitTyped();
    }, 0);
  });
  clear.addEventListener('mousedown', (e) => e.preventDefault());
  clear.addEventListener('click', () => {
    setValue('');
    input.focus();
    open();
  });
  toggle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (list.hidden) { input.focus(); open(); } else close();
  });
  document.addEventListener('mousedown', (e) => {
    if (!wrap.contains(e.target)) close();
  });
  // Required fields: show the browser's message on the visible input.
  // (the browser focuses the hidden field after this event, so move focus afterwards)
  native.addEventListener('invalid', () => setTimeout(() => { input.focus(); wrap.classList.add('is-invalid'); }));
  native.addEventListener('change', () => wrap.classList.remove('is-invalid'));
  // Forms that are reset (edit popovers, the Log work dialog) show the reset value.
  if (native.form) native.form.addEventListener('reset', () => setTimeout(sync));
  native.addEventListener('change', sync);
  sync();
}

document.querySelectorAll('[data-combobox]').forEach(enhanceCombobox);

// ---- Email: signatures, recipient chips and the Send report popup ----

// Rough browser-side clean-up of signature HTML for the editor and preview (the server
// sanitises properly with sanitize-html before saving and sending). Parsed with
// DOMParser, which never runs scripts or loads anything.
function cleanSignatureHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, style, link, meta, title, iframe, object, embed, form, input, button, textarea, select, base')
    .forEach((node) => node.remove());
  doc.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src') && /^(javascript|vbscript):/.test(value))) {
        node.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

// Shows signature HTML in a shadow root, so its styles cannot leak into the page.
function renderSignature(host, html) {
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>:host{display:block;font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#000;overflow-wrap:anywhere}'
    + 'img{max-width:100%;height:auto}a{color:#0563C1}</style>'
    + (cleanSignatureHtml(html) || '<span style="color:#6E6E73">No signature</span>');
}

document.querySelectorAll('[data-signature-view]').forEach((host) => {
  const template = host.querySelector('template[data-signature-html]');
  renderSignature(host, template ? template.innerHTML : '');
});

// Signature editor: rich text (bold, italic, link, image by URL, line break) or
// "Paste HTML". The textarea is always the submitted field.
document.querySelectorAll('[data-signature-editor]').forEach((editor) => {
  const toolbar = editor.querySelector('[data-sig-toolbar]');
  const area = editor.querySelector('[data-sig-area]');
  const source = editor.querySelector('[data-sig-source]');
  const previewWrap = editor.querySelector('[data-sig-preview-wrap]');
  const preview = editor.querySelector('[data-sig-preview]');
  const modeButton = editor.querySelector('[data-sig-mode]');
  let htmlMode = false;

  // The preview shows {job_title} filled in, as it will be when the report is sent.
  const jobTitle = editor.dataset.jobTitle || '';
  const refresh = () => renderSignature(preview, source.value.split('{job_title}').join(escapeHtml(jobTitle)));
  const loadArea = () => {
    area.innerHTML = cleanSignatureHtml(source.value);
    refresh();
  };
  const setMode = (html) => {
    htmlMode = html;
    if (!html) loadArea();
    area.hidden = html;
    source.hidden = !html;
    modeButton.setAttribute('aria-pressed', String(html));
    modeButton.textContent = html ? 'Back to editor' : 'Paste HTML';
    toolbar.querySelectorAll('[data-sig-cmd]').forEach((b) => { b.disabled = html; });
    (html ? source : area).focus();
  };

  toolbar.hidden = false;
  previewWrap.hidden = false;
  area.hidden = false;
  source.hidden = true;
  loadArea();

  area.addEventListener('input', () => {
    source.value = area.innerHTML;
    refresh();
  });
  source.addEventListener('input', refresh);
  modeButton.addEventListener('click', () => setMode(!htmlMode));
  // Keep the text selection when a toolbar button is pressed.
  toolbar.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-sig-cmd]')) e.preventDefault();
  });
  toolbar.addEventListener('click', (e) => {
    const button = e.target.closest('[data-sig-cmd]');
    if (!button || htmlMode) return;
    area.focus();
    const cmd = button.dataset.sigCmd;
    if (cmd === 'bold' || cmd === 'italic') document.execCommand(cmd);
    else if (cmd === 'clear') document.execCommand('removeFormat');
    else if (cmd === 'job_title') document.execCommand('insertText', false, '{job_title}');
    else if (cmd === 'break') {
      if (!document.execCommand('insertLineBreak')) document.execCommand('insertHTML', false, '<br>');
    } else if (cmd === 'link') {
      const url = (window.prompt('Link address (https://…, mailto: or tel:)', 'https://') || '').trim();
      if (!/^(https?:\/\/\S+|mailto:\S+|tel:[+\d\s()-]+)$/i.test(url)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) document.execCommand('createLink', false, url);
      else document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}">${escapeHtml(url.replace(/^(mailto|tel):/i, ''))}</a>`);
    } else if (cmd === 'image') {
      const url = (window.prompt('Image address (https://…)', 'https://') || '').trim();
      if (!/^https:\/\/\S+$/i.test(url)) return;
      document.execCommand('insertImage', false, url);
    }
    source.value = area.innerHTML;
    refresh();
  });
  // Cancel / Esc / click outside reset the form: show the saved signature again.
  const form = editor.closest('form');
  if (form) {
    form.addEventListener('reset', () => setTimeout(() => {
      if (htmlMode) setMode(false);
      else loadArea();
    }));
    form.addEventListener('submit', () => {
      if (!htmlMode) source.value = area.innerHTML;
    });
  }
});

// Email recipient chips: <input data-email-tokens list="..."> holding "a@x.com, b@y.com".
// Enter, comma, semicolon, Tab or leaving the field turns the typed address into a chip;
// Backspace in the empty field removes the last one. The original input (now hidden)
// is what gets submitted.
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
function enhanceEmailTokens(original) {
  const box = document.createElement('div');
  box.className = 'token-input';
  const typing = document.createElement('input');
  typing.type = 'email';
  typing.autocomplete = 'off';
  typing.placeholder = original.placeholder || '';
  if (original.getAttribute('list')) typing.setAttribute('list', original.getAttribute('list'));
  typing.setAttribute('aria-label', original.closest('label')?.querySelector('span')?.textContent.trim() || 'Email addresses');
  const required = original.required;
  original.required = false;
  original.type = 'hidden';
  original.after(box);
  box.appendChild(typing);

  let tokens = [];
  const sync = () => {
    original.value = tokens.join(', ');
    box.classList.toggle('has-tokens', tokens.length > 0);
  };
  const chip = (email) => {
    const span = document.createElement('span');
    span.className = 'token';
    span.textContent = email;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'token-remove';
    remove.setAttribute('aria-label', `Remove ${email}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      tokens = tokens.filter((t) => t !== email);
      span.remove();
      sync();
      typing.focus();
    });
    span.appendChild(remove);
    box.insertBefore(span, typing);
  };
  // Adds every valid address in text; anything invalid stays in the field, marked.
  const take = (text) => {
    const bad = [];
    String(text).split(/[\s,;]+/).map((p) => p.trim().replace(/^<|>$/g, '')).filter(Boolean).forEach((part) => {
      const email = part.toLowerCase();
      if (!EMAIL_RE.test(email)) bad.push(part);
      else if (!tokens.includes(email)) {
        tokens.push(email);
        chip(email);
      }
    });
    typing.value = bad.join(', ');
    typing.classList.toggle('is-invalid', bad.length > 0);
    typing.title = bad.length ? 'Not a valid email address' : '';
    sync();
    return bad.length === 0;
  };
  take(original.value);

  typing.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && typing.value.trim())) && typing.value.trim()) {
      e.preventDefault();
      take(typing.value);
    } else if (e.key === 'Enter') {
      e.preventDefault(); // Enter in an empty field does not submit the popup
    } else if (e.key === 'Backspace' && !typing.value && tokens.length) {
      const last = tokens.pop();
      box.querySelectorAll('.token').forEach((t) => { if (t.firstChild.textContent === last) t.remove(); });
      sync();
    }
  });
  typing.addEventListener('input', () => {
    typing.classList.remove('is-invalid');
    // A suggestion picked from the list is added straight away.
    const list = typing.list;
    if (list && [...list.options].some((o) => o.value === typing.value)) take(typing.value);
  });
  typing.addEventListener('blur', () => { if (typing.value.trim()) take(typing.value); });
  box.addEventListener('click', (e) => { if (e.target === box) typing.focus(); });

  // Called before submit: adds anything still typed; false when invalid or required and empty.
  original.flushTokens = () => {
    const ok = typing.value.trim() ? take(typing.value) : true;
    if (!ok) {
      typing.focus();
      return false;
    }
    if (required && !tokens.length) {
      typing.classList.add('is-invalid');
      typing.title = 'Add at least one email address';
      typing.focus();
      return false;
    }
    return true;
  };
}
document.querySelectorAll('input[data-email-tokens]').forEach(enhanceEmailTokens);

// Send report popup. With "My report" showing, it starts from the page preview so any
// edits made there are kept; otherwise from the user's own report rendered with it.
const sendDialog = document.querySelector('[data-send-dialog]');
if (sendDialog && typeof sendDialog.showModal === 'function') {
  const sendForm = sendDialog.querySelector('[data-send-form]');
  const sendPreview = sendDialog.querySelector('[data-send-preview]');
  document.querySelectorAll('[data-send-open]').forEach((button) => {
    button.addEventListener('click', () => {
      if (sendDialog.hasAttribute('data-copy-page') && reportPreview) sendPreview.innerHTML = reportPreview.innerHTML;
      sendDialog.showModal();
      const first = sendDialog.querySelector('.token-input input, input[name="subject"]');
      if (first) first.focus();
    });
  });
  sendDialog.querySelectorAll('[data-send-close]').forEach((b) => b.addEventListener('click', () => sendDialog.close()));
  // A click on the backdrop (outside the popup) closes it without sending.
  sendDialog.addEventListener('click', (e) => { if (e.target === sendDialog) sendDialog.close(); });
  sendForm.addEventListener('submit', (e) => {
    const tokenInputs = [...sendForm.querySelectorAll('input[data-email-tokens]')];
    if (!tokenInputs.every((input) => !input.flushTokens || input.flushTokens())) {
      e.preventDefault();
      return;
    }
    sendForm.querySelector('[data-send-report]').value = JSON.stringify(readPreview(sendPreview));
    sendForm.querySelectorAll('button[type="submit"]').forEach((b) => { b.disabled = true; });
  });
}


// ---- Profile picture: crop popup ----
// Choosing a file in a [data-avatar-form] opens the shared crop popup
// (views/partials/crop-dialog.ejs). The picture is drawn on a canvas: drag to move,
// zoom with the slider, mouse wheel or a two-finger pinch, rotate 90° and reset; the
// circle previews update live. Save draws the square onto a 512 x 512 canvas and
// uploads only that JPG (quality 0.9), so large phone photos upload quickly. Cancel,
// Esc or a click outside closes the popup and clears the chosen file.
const cropDialog = document.querySelector('[data-crop-dialog]');
if (cropDialog && typeof cropDialog.showModal === 'function') {
  const OUTPUT = 512;
  const MAX_SOURCE = 2048; // huge photos are scaled down once, so moving stays smooth
  const BOX = 0.8; // the crop square's share of the stage
  const stage = cropDialog.querySelector('[data-crop-stage]');
  const canvas = cropDialog.querySelector('[data-crop-canvas]');
  const previews = [...cropDialog.querySelectorAll('[data-crop-preview]')];
  const zoomInput = cropDialog.querySelector('[data-crop-zoom]');
  const errorBox = cropDialog.querySelector('[data-crop-error]');
  const saveButton = cropDialog.querySelector('[data-crop-save]');
  const MAX_ZOOM = Number(zoomInput.max) || 5;

  let source = null; // canvas holding the (possibly scaled down) picture
  let form = null;
  let state = { rotation: 0, zoom: 1, cx: 0, cy: 0 }; // crop centre in rotated-picture pixels
  let frame = 0;

  const showCropError = (message) => {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  };
  // Picture size after rotation.
  const dims = () => (state.rotation % 180 === 0 ? { w: source.width, h: source.height } : { w: source.height, h: source.width });
  // Side of the crop square, in rotated-picture pixels.
  const side = () => {
    const { w, h } = dims();
    return Math.min(w, h) / state.zoom;
  };
  const clampState = () => {
    const { w, h } = dims();
    const half = side() / 2;
    state.zoom = Math.min(MAX_ZOOM, Math.max(1, state.zoom));
    state.cx = Math.min(w - half, Math.max(half, state.cx));
    state.cy = Math.min(h - half, Math.max(half, state.cy));
  };
  // Draws the picture so the crop square fills a box of boxSize, centred on the canvas.
  function paint(ctx, size, boxSize, background) {
    const k = boxSize / side();
    const { w, h } = dims();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size, size);
    } else {
      ctx.clearRect(0, 0, size, size);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(size / 2, size / 2);
    ctx.scale(k, k);
    ctx.translate(-state.cx, -state.cy);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((state.rotation * Math.PI) / 180);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    ctx.restore();
  }
  function render() {
    frame = 0;
    if (!source) return;
    clampState();
    zoomInput.value = String(state.zoom);
    const css = stage.clientWidth || 300;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(css * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    paint(canvas.getContext('2d'), px, px * BOX, '#F5F5F7');
    previews.forEach((p) => paint(p.getContext('2d'), p.width, p.width, '#FFFFFF'));
  }
  const queueRender = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };
  const resetState = () => {
    const { w, h } = { w: source.width, h: source.height };
    state = { rotation: 0, zoom: 1, cx: w / 2, cy: h / 2 };
    queueRender();
  };
  // Stage pixels -> rotated-picture pixels.
  const toPicture = () => side() / ((stage.clientWidth || 300) * BOX);

  // Loads the file (with its EXIF rotation applied) into a canvas of at most MAX_SOURCE.
  async function loadSource(file) {
    let bitmap;
    if (window.createImageBitmap) {
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (err) {
        bitmap = null;
      }
    }
    if (!bitmap) {
      bitmap = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('unreadable'));
        };
        img.src = url;
      });
    }
    const w = bitmap.naturalWidth || bitmap.width;
    const h = bitmap.naturalHeight || bitmap.height;
    const fit = Math.min(1, MAX_SOURCE / Math.max(w, h));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * fit));
    out.height = Math.max(1, Math.round(h * fit));
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, out.width, out.height);
    if (bitmap.close) bitmap.close();
    return out;
  }

  function closeCrop() {
    if (cropDialog.open) cropDialog.close();
  }
  cropDialog.addEventListener('close', () => {
    if (form && !form.dataset.uploading) {
      const input = form.querySelector('[data-avatar-file]');
      if (input) input.value = '';
    }
    source = null;
    showCropError('');
  });

  document.querySelectorAll('[data-avatar-form]').forEach((avatarForm) => {
    const input = avatarForm.querySelector('[data-avatar-file]');
    const formError = avatarForm.querySelector('[data-avatar-error]');
    // The popup's Save uploads; the form's own Save button is only for no-JavaScript use.
    const submit = avatarForm.querySelector('[data-avatar-submit]');
    if (submit) submit.hidden = true;
    input.required = false;
    input.addEventListener('change', async () => {
      if (formError) formError.hidden = true;
      const file = input.files && input.files[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        if (formError) {
          formError.textContent = 'Use a JPG, PNG or WebP image.';
          formError.hidden = false;
        }
        input.value = '';
        return;
      }
      form = avatarForm;
      try {
        source = await loadSource(file);
      } catch (err) {
        if (formError) {
          formError.textContent = 'That file could not be read as a picture.';
          formError.hidden = false;
        }
        input.value = '';
        return;
      }
      saveButton.disabled = false;
      cropDialog.showModal();
      resetState();
      stage.focus();
    });
  });

  cropDialog.querySelectorAll('[data-crop-cancel]').forEach((b) => b.addEventListener('click', closeCrop));
  // A click on the backdrop (outside the popup) cancels.
  cropDialog.addEventListener('click', (e) => { if (e.target === cropDialog) closeCrop(); });
  cropDialog.querySelector('[data-crop-reset]').addEventListener('click', () => source && resetState());
  cropDialog.querySelector('[data-crop-rotate]').addEventListener('click', () => {
    if (!source) return;
    // Turn 90° clockwise, keeping the same part of the picture in the middle.
    const { h } = dims();
    state = { ...state, rotation: (state.rotation + 90) % 360, cx: h - state.cy, cy: state.cx };
    queueRender();
  });
  zoomInput.addEventListener('input', () => {
    state.zoom = Number(zoomInput.value) || 1;
    queueRender();
  });
  stage.addEventListener('wheel', (e) => {
    if (!source) return;
    e.preventDefault();
    state.zoom *= Math.exp(-e.deltaY * 0.0015);
    queueRender();
  }, { passive: false });

  // One pointer drags; two pointers (touch) pinch to zoom.
  const pointers = new Map();
  let pinch = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!source) return;
    try {
      stage.setPointerCapture(e.pointerId);
    } catch (err) {
      // Not capturable (e.g. the pointer already ended): moves still arrive on the stage.
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.classList.add('is-dragging');
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: state.zoom };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last || !source) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, now);
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      state.zoom = pinch.zoom * ((Math.hypot(a.x - b.x, a.y - b.y) || 1) / pinch.dist);
    } else if (pointers.size === 1) {
      const scale = toPicture();
      state.cx -= (now.x - last.x) * scale;
      state.cy -= (now.y - last.y) * scale;
    }
    queueRender();
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) stage.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('keydown', (e) => {
    if (!source) return;
    const step = (e.shiftKey ? 40 : 10) * toPicture();
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      state.cx += moves[e.key][0];
      state.cy += moves[e.key][1];
    } else if (e.key === '+' || e.key === '=') state.zoom *= 1.1;
    else if (e.key === '-') state.zoom /= 1.1;
    else return;
    e.preventDefault();
    queueRender();
  });
  window.addEventListener('resize', () => cropDialog.open && queueRender());

  saveButton.addEventListener('click', async () => {
    if (!source || !form) return;
    showCropError('');
    saveButton.disabled = true;
    const out = document.createElement('canvas');
    out.width = OUTPUT;
    out.height = OUTPUT;
    clampState();
    paint(out.getContext('2d'), OUTPUT, OUTPUT, '#FFFFFF');
    const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) {
      showCropError('The picture could not be prepared. Try another one.');
      saveButton.disabled = false;
      return;
    }
    const data = new FormData(form);
    data.set('file', blob, 'avatar.jpg');
    form.dataset.uploading = '1';
    try {
      // redirect: 'manual' leaves the server's success / error message for the page we
      // go back to (following the redirect here would use it up).
      const res = await fetch(form.action, { method: 'POST', body: data, credentials: 'same-origin', redirect: 'manual' });
      if (res.type !== 'opaqueredirect' && !res.ok) throw new Error(String(res.status));
      const target = new URL(form.dataset.back || window.location.pathname, window.location.href);
      if (target.pathname === window.location.pathname && target.search === window.location.search) {
        window.location.hash = target.hash;
        window.location.reload();
      } else {
        window.location.href = target.href;
      }
    } catch (err) {
      delete form.dataset.uploading;
      showCropError('The upload failed. Check your connection and try again.');
      saveButton.disabled = false;
    }
  });
}

// ---- Compact layout helpers ----

// Sidebar: collapse to icons only. The choice is kept in a cookie so the server renders
// the page already collapsed (no flash on the next page).
const shell = document.querySelector('[data-shell]');
const navCollapse = document.querySelector('[data-nav-collapse]');
if (shell && navCollapse) {
  navCollapse.addEventListener('click', () => {
    const collapsed = shell.classList.toggle('nav-collapsed');
    document.cookie = `itsupport_nav=${collapsed ? 'collapsed' : 'open'}; path=/; max-age=31536000; SameSite=Lax`;
    const label = collapsed ? 'Expand menu' : 'Collapse menu';
    navCollapse.setAttribute('aria-pressed', String(collapsed));
    navCollapse.title = label;
    navCollapse.setAttribute('aria-label', label);
  });
}

// Table cells are one line, cut with "…": show the full text as a tooltip when a cell
// is actually cut off and has no tooltip of its own.
document.addEventListener('mouseover', (event) => {
  const cell = event.target.closest && event.target.closest('.table td, .table th');
  if (!cell || cell.hasAttribute('title') || cell.dataset.tipChecked) return;
  cell.dataset.tipChecked = '1';
  if (cell.scrollWidth > cell.clientWidth + 1) {
    const text = cell.textContent.replace(/\s+/g, ' ').trim();
    if (text) cell.title = text;
  }
});

// ---- Inventory grids ----
// [data-grid] tables (views/inventory/_grid.ejs): search, click a header to sort, a filter
// row, CSV export of the rows shown, drag a field header to reorder (saved for everyone at
// data-order-url), drag a header edge to resize (saved per user), click a row to open it.
// Password / PIN cells only ever hold "••••••" here, so exports never contain them.
const invToken = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
const invPost = (url, data) => fetch(url, {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ _csrf: invToken(), ...data }),
  credentials: 'same-origin',
}).then((r) => r.json().catch(() => ({ ok: false })).then((d) => ({ status: r.status, ...d }))).catch(() => ({ ok: false }));

function csvValue(value) {
  const s = String(value ?? '');
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // no formulas when opened in Excel
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

document.querySelectorAll('[data-grid]').forEach((root) => {
  const table = root.querySelector('table.grid');
  if (!table) return;
  const tbody = table.tBodies[0];
  const headRow = table.tHead.rows[0];
  const filterRow = root.querySelector('[data-grid-filters]');
  const search = root.querySelector('[data-grid-search]');
  const count = root.querySelector('[data-grid-count]');
  const emptyMsg = root.querySelector('[data-grid-empty]');
  const status = root.querySelector('[data-grid-status]');
  const rows = [...tbody.rows];
  const colIndex = (key) => [...headRow.cells].findIndex((th) => th.dataset.col === key);
  const say = (msg, isError) => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle('is-error', Boolean(isError));
    status.hidden = !msg;
    if (msg && !isError) setTimeout(() => { status.hidden = true; }, 2000);
  };
  const setTableWidth = () => {
    const total = [...table.querySelectorAll('colgroup col')].reduce((n, c) => n + (parseFloat(c.style.width) || 0), 0);
    table.style.width = `${total}px`;
  };

  // Open the record when a row (not a link or button in it) is clicked, or Enter pressed.
  tbody.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, select, label, .secret')) return;
    const tr = e.target.closest('tr[data-href]');
    if (tr) window.location.href = tr.dataset.href;
  });
  tbody.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('tr[data-href]')) window.location.href = e.target.dataset.href;
  });

  // Search + per-column filters.
  function apply() {
    const q = (search ? search.value : '').trim().toLowerCase();
    const filters = [...root.querySelectorAll('[data-grid-filter]')]
      .map((el) => ({ i: colIndex(el.dataset.gridFilter), v: el.value.trim().toLowerCase(), exact: el.tagName === 'SELECT' }))
      .filter((f) => f.v && f.i >= 0);
    let shown = 0;
    for (const tr of rows) {
      let ok = !q || [...tr.cells].some((td) => (td.dataset.x || '').toLowerCase().includes(q));
      for (const f of filters) {
        if (!ok) break;
        const text = ((tr.cells[f.i] && tr.cells[f.i].dataset.f) || '').toLowerCase();
        ok = f.exact ? text === f.v : text.includes(f.v);
      }
      tr.hidden = !ok;
      if (ok) shown += 1;
    }
    if (count) count.textContent = `${shown} ${shown === 1 ? 'row' : 'rows'}${shown !== rows.length ? ` of ${rows.length}` : ''}`;
    if (emptyMsg) emptyMsg.hidden = shown > 0;
  }
  if (search) search.addEventListener('input', apply);
  root.querySelectorAll('[data-grid-filter]').forEach((el) => el.addEventListener('input', apply));

  const filterToggle = root.querySelector('[data-grid-filter-toggle]');
  if (filterToggle && filterRow) {
    filterToggle.addEventListener('click', () => {
      const show = filterRow.hidden;
      filterRow.hidden = !show;
      filterToggle.setAttribute('aria-pressed', String(show));
      if (!show) {
        filterRow.querySelectorAll('input, select').forEach((el) => { el.value = ''; });
        apply();
      } else {
        const first = filterRow.querySelector('input, select');
        if (first) first.focus();
      }
    });
  }

  // Sort by a column (click again to reverse). Empty values always go last.
  let sorted = { key: null, dir: 1 };
  root.querySelectorAll('[data-grid-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.gridSort;
      sorted = { key, dir: sorted.key === key ? -sorted.dir : 1 };
      const i = colIndex(key);
      const type = headRow.cells[i].dataset.sortType;
      const val = (tr) => (tr.cells[i] && tr.cells[i].dataset.v) || '';
      rows.sort((a, b) => {
        const x = val(a);
        const y = val(b);
        if (!x || !y) return Number(!x) - Number(!y);
        if (type === 'number') return (parseFloat(x) - parseFloat(y)) * sorted.dir;
        return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) * sorted.dir;
      });
      rows.forEach((tr) => tbody.appendChild(tr));
      [...headRow.cells].forEach((th, j) => {
        th.setAttribute('aria-sort', j === i ? (sorted.dir > 0 ? 'ascending' : 'descending') : 'none');
        const arrow = th.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = j === i ? (sorted.dir > 0 ? '▲' : '▼') : '↕';
      });
    });
  });

  // CSV of the rows shown, columns in their current order.
  const csvButton = root.querySelector('[data-grid-csv]');
  if (csvButton) {
    csvButton.addEventListener('click', () => {
      const head = [...headRow.cells].map((th) => th.title || th.textContent.trim());
      const lines = [head, ...rows.filter((tr) => !tr.hidden).map((tr) => [...tr.cells].map((td) => td.dataset.x || ''))];
      const csv = `﻿${lines.map((l) => l.map(csvValue).join(',')).join('\r\n')}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `${root.dataset.csvName || 'export'}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  // Resize: drag the right edge of a header. Saved for this user.
  root.querySelectorAll('[data-grid-resize]').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const th = handle.closest('th');
      const key = th.dataset.col;
      const col = [...table.querySelectorAll('colgroup col')].find((c) => c.dataset.col === key);
      if (!col) return;
      const startX = e.clientX;
      const startW = parseFloat(col.style.width) || th.offsetWidth;
      const wasDraggable = th.draggable;
      th.draggable = false;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* moves still arrive */ }
      root.classList.add('is-resizing');
      const move = (ev) => {
        col.style.width = `${Math.max(50, Math.min(800, startW + ev.clientX - startX))}px`;
        setTableWidth();
      };
      const up = async () => {
        handle.removeEventListener('pointermove', move);
        th.draggable = wasDraggable;
        root.classList.remove('is-resizing');
        const width = Math.round(parseFloat(col.style.width));
        if (width !== Math.round(startW)) {
          const res = await invPost('/inventory/widths', { key, width });
          if (!res.ok) say('The width could not be saved.', true);
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
  });

  // Reorder: drag a field header onto another. Saved for everyone.
  const orderUrl = root.dataset.orderUrl;
  if (orderUrl) {
    let dragKey = null;
    const moveColumn = (from, to) => {
      const parents = [table.querySelector('colgroup'), headRow, filterRow, ...tbody.rows].filter(Boolean);
      for (const parent of parents) {
        const cells = parent.children;
        const node = cells[from];
        const target = cells[to];
        if (!node || !target) continue;
        if (to > from) parent.insertBefore(node, target.nextSibling);
        else parent.insertBefore(node, target);
      }
    };
    headRow.querySelectorAll('th[data-field-id]').forEach((th) => {
      th.addEventListener('dragstart', (e) => {
        dragKey = th.dataset.col;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragKey);
        th.classList.add('is-dragging');
      });
      th.addEventListener('dragend', () => {
        th.classList.remove('is-dragging');
        headRow.querySelectorAll('.is-drop-target').forEach((x) => x.classList.remove('is-drop-target'));
      });
      th.addEventListener('dragover', (e) => {
        if (!dragKey || dragKey === th.dataset.col) return;
        e.preventDefault();
        th.classList.add('is-drop-target');
      });
      th.addEventListener('dragleave', () => th.classList.remove('is-drop-target'));
      th.addEventListener('drop', async (e) => {
        e.preventDefault();
        th.classList.remove('is-drop-target');
        const from = colIndex(dragKey);
        const to = colIndex(th.dataset.col);
        dragKey = null;
        if (from < 0 || to < 0 || from === to) return;
        moveColumn(from, to);
        const order = [...headRow.querySelectorAll('th[data-field-id]')].map((x) => x.dataset.fieldId).join(',');
        say('Saving column order…');
        const res = await invPost(orderUrl, { order });
        if (res.ok) say('Column order saved.');
        else {
          say(`${res.error || 'The column order could not be saved.'} Reloading…`, true);
          setTimeout(() => window.location.reload(), 1500);
        }
      });
    });
  }
  apply();
});

// Password / PIN: reveal (eye) shows the value for 30 seconds; copy puts it on the
// clipboard without showing it. Every reveal and copy is logged on the server.
document.addEventListener('click', async (e) => {
  const button = e.target.closest && e.target.closest('[data-secret-reveal], [data-secret-copy]');
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();
  const box = button.closest('[data-secret]');
  const valueEl = box.querySelector('[data-secret-value]');
  const isCopy = button.hasAttribute('data-secret-copy');
  const hide = () => {
    clearTimeout(box.hideTimer);
    valueEl.textContent = '••••••';
    box.classList.remove('is-revealed', 'is-error');
  };
  if (!isCopy && box.classList.contains('is-revealed')) {
    hide();
    return;
  }
  button.disabled = true;
  const res = await invPost('/inventory/secret', { record_id: box.dataset.record, field_id: box.dataset.field, action: isCopy ? 'copy' : 'reveal' });
  button.disabled = false;
  clearTimeout(box.hideTimer);
  if (!res.ok) {
    valueEl.textContent = res.error || 'Could not load it.';
    box.classList.add('is-error');
    box.hideTimer = setTimeout(hide, 5000);
    return;
  }
  if (isCopy) {
    try {
      await copyPlain(res.value);
      valueEl.textContent = 'Copied';
    } catch (err) {
      valueEl.textContent = 'Copy blocked';
    }
    box.hideTimer = setTimeout(hide, 1500);
    return;
  }
  valueEl.textContent = res.value;
  box.classList.add('is-revealed');
  box.hideTimer = setTimeout(hide, 30000);
});

// Add multiple stock items: one serial / asset number row per item.
document.querySelectorAll('[data-multi-form]').forEach((form) => {
  const qty = form.querySelector('[data-multi-quantity]');
  const list = form.querySelector('[data-multi-rows]');
  if (!qty || !list) return;
  const sync = () => {
    const n = Math.min(200, Math.max(1, Number.parseInt(qty.value, 10) || 1));
    while (list.children.length < n) {
      const i = list.children.length + 1;
      const li = document.createElement('li');
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'serials';
      input.maxLength = 150;
      input.placeholder = `Item ${i}`;
      input.setAttribute('aria-label', `Serial / asset number ${i}`);
      li.appendChild(input);
      list.appendChild(li);
    }
    while (list.children.length > n) list.lastElementChild.remove();
  };
  qty.addEventListener('input', sync);
  sync();
});

// Columns form: the options box only matters for dropdowns.
document.querySelectorAll('[data-field-form]').forEach((form) => {
  const type = form.querySelector('[data-field-type]');
  const options = form.querySelector('[data-options-field]');
  if (!type || !options) return;
  const sync = () => { options.hidden = type.value !== 'dropdown'; };
  type.addEventListener('change', sync);
  sync();
});

// ---- Inventory import ----

// Map step: the "New field type" choice only applies to "Create a new field".
document.querySelectorAll('[data-map-row]').forEach((row) => {
  const target = row.querySelector('[data-map-target]');
  const type = row.querySelector('[data-map-type]');
  if (!target || !type) return;
  const sync = () => {
    type.disabled = target.value !== 'new';
    row.classList.toggle('is-skipped', target.value === 'skip');
  };
  target.addEventListener('change', sync);
  sync();
});

// Download a text block on the page as a file (e.g. the import error report).
document.querySelectorAll('[data-download-text]').forEach((button) => {
  button.addEventListener('click', () => {
    const source = document.querySelector(button.dataset.downloadText);
    if (!source) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([source.value], { type: 'text/csv;charset=utf-8' }));
    a.download = button.dataset.downloadName || 'report.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});
