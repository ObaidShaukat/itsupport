// Escapes text for use inside a quoted Mermaid node label.
function label(text) {
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .trim();
}

// Top-to-bottom flowchart: (Start) > 1. step > 2. step > ... > (Done).
// Start/Done are pills, steps are rounded boxes, arrows are smooth brand-blue curves.
// After a drag-and-drop reorder the server returns a freshly built chart (see app.js).
function buildFlowchart(steps) {
  const lines = ['flowchart TB', '  start(["Start"])'];
  let prev = 'start';
  steps.forEach((step, i) => {
    const node = `s${i + 1}`;
    lines.push(`  ${node}("${i + 1}. ${label(step.title)}")`);
    lines.push(`  ${prev} --> ${node}`);
    prev = node;
  });
  lines.push('  done(["Done"])', `  ${prev} --> done`);
  lines.push('  classDef terminal fill:#200D6C,stroke:#200D6C,color:#FFFFFF,font-weight:600');
  lines.push('  classDef step fill:#FFFFFF,stroke:#6741C3,stroke-width:2px,color:#000000');
  lines.push('  class start,done terminal');
  if (steps.length) lines.push(`  class ${steps.map((_, i) => `s${i + 1}`).join(',')} step`);
  lines.push('  linkStyle default stroke:#0390D7,stroke-width:2px');
  return lines.join('\n');
}

module.exports = { buildFlowchart };
