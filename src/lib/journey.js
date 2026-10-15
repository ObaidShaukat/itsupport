// A service's steps as a "journey": stages left to right, each a group of steps.
// Steps with the same (optional) stage, one after another, form a stage; a step without a
// stage joins the stage before it. When no step has a stage, steps are grouped in threes
// ("Stage 1", "Stage 2", ...).
// With progress (a client's assigned service) each step is done / current (the first step
// not done) / todo, each stage done when all its steps are, and the journey knows how many
// are done. Without progress (the Services page template) every step is just a step.
const CHUNK = 3;

function journey(steps, { progress = false } = {}) {
  const list = steps.map((s) => ({ ...s, stage: String(s.stage || '').trim() }));
  const groups = [];
  if (!list.some((s) => s.stage)) {
    for (let i = 0; i < list.length; i += CHUNK) groups.push({ label: `Stage ${groups.length + 1}`, steps: list.slice(i, i + CHUNK) });
  } else {
    let label = '';
    for (const s of list) {
      const next = s.stage || label || 'Stage 1';
      if (!groups.length || groups[groups.length - 1].label !== next) groups.push({ label: next, steps: [] });
      groups[groups.length - 1].steps.push(s);
      label = next;
    }
  }
  const current = progress ? list.find((s) => !s.done) : null;
  for (const g of groups) {
    for (const s of g.steps) s.state = !progress ? 'step' : s.done ? 'done' : current && s.id === current.id ? 'current' : 'todo';
    g.done = progress && g.steps.every((s) => s.done);
    g.current = progress && g.steps.some((s) => s.state === 'current');
    g.doneCount = g.steps.filter((s) => s.done).length;
  }
  const done = list.filter((s) => s.done).length;
  return {
    progress,
    groups,
    total: list.length,
    done,
    complete: progress && list.length > 0 && done === list.length,
    percent: list.length ? Math.round((done / list.length) * 100) : 0,
  };
}

// Distinct stage names already used (for the Stage field suggestions), in order.
function stageNames(steps) {
  return [...new Set(steps.map((s) => String(s.stage || '').trim()).filter(Boolean))];
}

module.exports = { journey, stageNames };
