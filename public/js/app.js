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
