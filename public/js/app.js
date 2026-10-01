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
if (window.mermaid) {
  const bodyFont = getComputedStyle(document.body).fontFamily;
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      fontFamily: bodyFont,
      primaryColor: '#F1ECFA',
      primaryBorderColor: '#6741C3',
      primaryTextColor: '#000000',
      lineColor: '#200D6C',
    },
    flowchart: { curve: 'basis', useMaxWidth: true },
  });
  window.mermaid.run({ querySelector: 'pre.mermaid' });
}
