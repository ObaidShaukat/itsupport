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
  openPopovers().forEach((details) => {
    if (!details.contains(event.target)) closePopover(details);
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
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

// ---- Notifications bell (in-portal reminders) ----
// Polls /notifications/poll on load and every 60 seconds. Each poll also turns due
// task reminders into notifications on the server. New ones pop up as a toast.
const bell = document.querySelector('[data-bell]');
if (bell) {
  const bellToggle = bell.querySelector('[data-bell-toggle]');
  const bellPanel = bell.querySelector('[data-bell-panel]');
  const bellList = bell.querySelector('[data-bell-list]');
  const bellCount = bell.querySelector('[data-bell-count]');
  const toastBox = document.querySelector('[data-toasts]');
  const bellToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

  const post = (url, data = {}) => fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: bellToken, ...data }),
    credentials: 'same-origin',
  }).then((r) => r.json().catch(() => ({ ok: false })));

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Read / snooze buttons for one notification (used in the bell list and in toasts).
  function actionButtons(n, after) {
    const box = el('div', 'notice-actions');
    const add = (label, fn) => {
      const b = el('button', 'btn btn-small btn-ghost', label);
      b.type = 'button';
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        await fn();
        after();
        poll();
      });
      box.appendChild(b);
    };
    if (!n.read) add('Mark read', () => post(`/notifications/${n.id}/read`));
    if (n.taskId) {
      add('Snooze 10 min', () => post(`/notifications/${n.id}/snooze`, { until: '10m' }));
      add('1 hour', () => post(`/notifications/${n.id}/snooze`, { until: '1h' }));
      add('Tomorrow', () => post(`/notifications/${n.id}/snooze`, { until: 'tomorrow' }));
    }
    return box;
  }

  function noticeBody(n) {
    const wrap = el('div', 'notice-body');
    const title = el(n.link ? 'a' : 'strong', 'notice-title', n.title);
    if (n.link) title.href = n.link;
    wrap.appendChild(title);
    if (n.body) wrap.appendChild(el('div', 'muted small', n.body));
    wrap.appendChild(el('div', 'muted small', n.time));
    return wrap;
  }

  function render(data) {
    const unread = Number(data.unread) || 0;
    bellCount.textContent = unread > 99 ? '99+' : String(unread);
    bellCount.hidden = unread === 0;
    bell.classList.toggle('has-unread', unread > 0);
    bellList.replaceChildren();
    if (!data.items.length) bellList.appendChild(el('li', 'empty small', 'No notifications yet.'));
    for (const n of data.items) {
      const li = el('li', `notice ${n.read ? 'is-read' : ''}`);
      li.appendChild(noticeBody(n));
      li.appendChild(actionButtons(n, () => {}));
      bellList.appendChild(li);
    }
  }

  function toast(n) {
    if (!toastBox) return;
    const box = el('div', 'toast');
    box.setAttribute('role', 'status');
    const close = el('button', 'icon-btn toast-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    const dismiss = () => {
      box.classList.add('is-leaving');
      setTimeout(() => box.remove(), 250);
    };
    close.addEventListener('click', dismiss);
    box.appendChild(el('span', 'toast-icon', '🔔'));
    box.appendChild(noticeBody(n));
    box.appendChild(close);
    box.appendChild(actionButtons(n, dismiss));
    toastBox.appendChild(box);
    setTimeout(dismiss, 20000);
  }

  async function poll() {
    try {
      const res = await fetch('/notifications/poll', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok) return;
      render(data);
      data.toasts.forEach(toast);
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
  bell.querySelector('[data-bell-read-all]').addEventListener('click', async () => {
    await post('/notifications/read-all');
    poll();
  });

  poll();
  setInterval(poll, 60000);
}

// Task side panel: Esc closes it (back to the list).
const taskPanel = document.querySelector('[data-task-panel]');
if (taskPanel) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open], details.edit[open]')) return;
    const close = taskPanel.querySelector('[data-panel-close]');
    if (close) window.location.href = close.href;
  });
}

// ---- Inventory ----

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

// Custom fields limited to one category show only when that category is chosen.
document.querySelectorAll('[data-cf-scope]').forEach((form) => {
  const select = form.querySelector('[data-cf-category-select]');
  const sync = () => {
    form.querySelectorAll('[data-cf-category]').forEach((field) => {
      const show = select && select.value === field.dataset.cfCategory;
      field.hidden = !show;
      field.querySelectorAll('input, select, textarea').forEach((input) => { input.disabled = !show; });
    });
  };
  if (select) select.addEventListener('change', sync);
  sync();
});

// Asset form: "Sold to / Sold date" only matter when the status is Sold.
document.querySelectorAll('[data-sold-toggle]').forEach((select) => {
  const fields = select.form && select.form.querySelector('[data-sold-fields]');
  if (!fields) return;
  const sync = () => { fields.hidden = select.value !== 'sold'; };
  select.addEventListener('change', sync);
  sync();
});

// Custom field form: options box only for dropdowns; warn as soon as a label looks
// like a credential (the server refuses those labels anyway).
document.querySelectorAll('[data-field-form]').forEach((form) => {
  const type = form.querySelector('[data-field-type]');
  const options = form.querySelector('[data-options-field]');
  const label = form.querySelector('[data-credential-check]');
  const warning = form.querySelector('[data-credential-warning]');
  const syncType = () => { if (options) options.hidden = type.value !== 'select'; };
  const syncLabel = () => { if (warning) warning.hidden = !/pass|\bpin\b/i.test(label.value); };
  type.addEventListener('change', syncType);
  label.addEventListener('input', syncLabel);
  syncType();
  syncLabel();
});
