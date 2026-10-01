// Escapes text for use inside a quoted Mermaid node label.
function label(text) {
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .trim();
}

// Top-to-bottom flowchart: Start > step 1 > step 2 > ... > Done.
function buildFlowchart(steps) {
  const lines = ['flowchart TB', '  start(["Start"])'];
  let prev = 'start';
  steps.forEach((step, i) => {
    const node = `s${i + 1}`;
    lines.push(`  ${node}["${i + 1}. ${label(step.title)}"]`);
    lines.push(`  ${prev} --> ${node}`);
    prev = node;
  });
  lines.push('  done(["Done"])', `  ${prev} --> done`);
  lines.push('  classDef terminal fill:#0B1B5C,stroke:#0B1B5C,color:#FFFFFF');
  lines.push('  classDef step fill:#FFFFFF,stroke:#00A6FF,color:#222222');
  lines.push('  class start,done terminal');
  if (steps.length) lines.push(`  class ${steps.map((_, i) => `s${i + 1}`).join(',')} step`);
  return lines.join('\n');
}

module.exports = { buildFlowchart };
