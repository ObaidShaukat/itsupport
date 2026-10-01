// Small progressive enhancements. Everything works without JavaScript except
// the delete confirmations and the flowchart.

// Ask before submitting forms marked with data-confirm (deletes).
document.addEventListener('submit', (event) => {
  const message = event.target.dataset && event.target.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

// Only one inline edit panel open at a time; Escape closes it.
document.addEventListener('toggle', (event) => {
  const details = event.target;
  if (!details.matches || !details.matches('details.edit') || !details.open) return;
  document.querySelectorAll('details.edit[open]').forEach((other) => {
    if (other !== details) other.open = false;
  });
  const input = details.querySelector('input:not([type="hidden"]), textarea, select');
  if (input) input.focus();
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('details.edit[open]').forEach((details) => {
    details.open = false;
  });
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
      primaryColor: '#FFFFFF',
      primaryBorderColor: '#00A6FF',
      primaryTextColor: '#222222',
      lineColor: '#0B1B5C',
    },
    flowchart: { curve: 'basis', useMaxWidth: true },
  });
  window.mermaid.run({ querySelector: 'pre.mermaid' });
}
