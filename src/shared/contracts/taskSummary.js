export const PUBLIC_TASK_SUMMARY_VERSION = 1;

export function buildPublicTaskSummary({ taskIntake = null, objective = '', deliverables = [] } = {}) {
  const intake = objectValue(taskIntake);
  return normalizePublicTaskSummary({
    version: PUBLIC_TASK_SUMMARY_VERSION,
    objective: intake.objective || objective,
    deliverables: nonEmptyArray(intake.deliverables) ? intake.deliverables : deliverables,
    acceptanceCriteria: intake.acceptanceCriteria || intake.acceptance_criteria,
    constraints: intake.constraints,
    deadline: intake.deadline,
  });
}

export function normalizePublicTaskSummary(value = null) {
  const source = objectValue(value);
  const objective = clean(source.objective, 4_000);
  if (!objective) return null;
  return {
    version: PUBLIC_TASK_SUMMARY_VERSION,
    objective,
    deliverables: cleanStrings(source.deliverables, 12, 240),
    acceptanceCriteria: cleanStrings(source.acceptanceCriteria || source.acceptance_criteria, 24, 500),
    constraints: cleanStrings(source.constraints, 24, 500),
    deadline: clean(source.deadline, 160),
  };
}

export function renderPublicTaskSummaryContext(value = null) {
  const summary = normalizePublicTaskSummary(value);
  if (!summary) return '';
  return [
    `Shared final objective:\n${summary.objective}`,
    summary.deliverables.length ? `Final deliverables:\n- ${summary.deliverables.join('\n- ')}` : '',
    summary.acceptanceCriteria.length ? `Acceptance criteria:\n- ${summary.acceptanceCriteria.join('\n- ')}` : '',
    summary.constraints.length ? `Shared constraints:\n- ${summary.constraints.join('\n- ')}` : '',
    summary.deadline ? `Deadline:\n${summary.deadline}` : '',
  ].filter(Boolean).join('\n\n');
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.some((item) => String(item || '').trim());
}

function cleanStrings(value, maximum, itemLength) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const text = clean(item, itemLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maximum) break;
  }
  return result;
}

function clean(value = '', maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}
