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
