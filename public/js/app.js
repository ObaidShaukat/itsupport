// Small progressive enhancements. Everything works without JavaScript except
// the delete confirmations and the flowchart.

// Ask before submitting forms marked with data-confirm (deletes).
document.addEventListener('submit', (event) => {
  const message = event.target.dataset && event.target.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

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
