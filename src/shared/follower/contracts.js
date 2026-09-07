export const FOLLOWER_REPORT_SCHEMA_VERSION = 'follower_report_v2';
export const FOLLOWER_ASSET_VERSION = 'follower_agent_v1';
export const FOLLOWER_PRIVACY_VALIDATOR_VERSION = 'follower_privacy_v1';

export const FOLLOWER_REPORT_KINDS = Object.freeze([
  'daily_brief',
  'weekly_review',
  'growth_guidance',
]);

export const FOLLOWER_DEFAULT_PROMPTS = Object.freeze({
  daily_brief: '给我一份工作简报，汇总当前时间窗口内的重要进展、阻塞、等待输入事项，以及接下来需要我关注的工作。',
  weekly_review: '回顾本周的主要成果、仍在推进的工作、反复出现的阻塞，并指出下周最值得优先关注的事项。',
  growth_guidance: '基于近期工作和讨论，提炼值得继续探索的观点、研究问题与潜在改进方向。',
});

const FOLLOWER_DEFAULT_PROMPTS_EN = Object.freeze({
  daily_brief: 'Give me a work brief covering important progress, blockers, items waiting for input, and what needs my attention next.',
  weekly_review: 'Review the main outcomes this week, work still in progress, recurring blockers, and the priorities worth carrying into next week.',
  growth_guidance: 'Use recent work and discussions to identify promising perspectives, research questions, and potential improvements.',
});

export const FOLLOWER_CLAIM_STATUSES = Object.freeze([
  'completed',
  'in_progress',
  'blocked',
  'waiting_for_input',
  'discussed_not_executed',
  'suggestion',
]);

export const FOLLOWER_WORK_SOURCE_CATEGORIES = Object.freeze([
  'agent_conversations',
  'task_activity',
  'project_change_metadata',
  'project_file_content',
]);

export const FOLLOWER_GRANT_CATEGORIES = Object.freeze([
  ...FOLLOWER_WORK_SOURCE_CATEGORIES,
  'sync_sanitized_reports',
]);

export const FOLLOWER_RUN_STATUSES = Object.freeze([
  'queued',
  'collecting',
  'generating',
  'validating',
  'committing',
  'completed',
  'skipped_no_activity',
  'retry_wait',
  'failed',
  'cancelled_authorization_changed',
  'cancelled_user_changed',
]);

export const FOLLOWER_SCHEDULE_FREQUENCIES = Object.freeze(['daily', 'weekly']);

export function normalizeFollowerReport(value = {}) {
  const source = objectValue(value);
  const window = objectValue(source.window);
  return {
    schemaVersion: clean(source.schemaVersion) || FOLLOWER_REPORT_SCHEMA_VERSION,
    kind: enumValue(source.kind, FOLLOWER_REPORT_KINDS, 'daily_brief'),
    window: {
      startAt: iso(source.window?.startAt),
      endAt: iso(source.window?.endAt),
      timezone: clean(window.timezone, 100),
      catchUp: Boolean(window.catchUp),
      truncated: Boolean(window.truncated),
    },
    coverage: arrayValue(source.coverage).slice(0, 20).map((item) => ({
      category: clean(item?.category, 80),
      itemCount: nonNegativeInteger(item?.itemCount),
      truncated: Boolean(item?.truncated),
      warningCode: clean(item?.warningCode, 100),
    })),
    claims: arrayValue(source.claims).slice(0, 100).map((item, index) => ({
      id: clean(item?.id, 120) || `claim_${index + 1}`,
      status: enumValue(item?.status, FOLLOWER_CLAIM_STATUSES, 'discussed_not_executed'),
      text: cleanMultiline(item?.text, 1600),
      sourceRefs: stringArray(item?.sourceRefs, 30, 200),
    })).filter((item) => item.text),
    suggestions: arrayValue(source.suggestions).slice(0, 20).map((item, index) => ({
      id: clean(item?.id, 120) || `suggestion_${index + 1}`,
      category: enumValue(item?.category, ['insight', 'recommendation', 'research_direction'], 'recommendation'),
      title: clean(item?.title, 300),
      rationale: cleanMultiline(item?.rationale, 1200),
      expectedValue: cleanMultiline(item?.expectedValue, 800),
      perspective: cleanMultiline(item?.perspective, 1200),
      researchQuestion: cleanMultiline(item?.researchQuestion, 800),
      // Retained for backward compatibility with follower_report_v2 reports from older clients.
      smallestNextStep: cleanMultiline(item?.smallestNextStep, 800),
      sourceRefs: stringArray(item?.sourceRefs, 30, 200),
    })).filter((item) => item.title),
    summary: cleanMultiline(source.summary, 2400),
  };
}

export function validateFollowerReport(value = {}, { sourceIds = [], sources = [], kind = '', window = null } = {}) {
  const report = normalizeFollowerReport(value);
  const diagnostics = [];
  if (report.schemaVersion !== FOLLOWER_REPORT_SCHEMA_VERSION) diagnostics.push(error('schema_version_unsupported', 'schemaVersion'));
  if (!FOLLOWER_REPORT_KINDS.includes(report.kind)) diagnostics.push(error('kind_invalid', 'kind'));
  if (kind && report.kind !== kind) diagnostics.push(error('kind_mismatch', 'kind'));
  if (!report.window.startAt || !report.window.endAt) diagnostics.push(error('window_invalid', 'window'));
  if (window?.startAt && report.window.startAt !== iso(window.startAt)) diagnostics.push(error('window_start_mismatch', 'window.startAt'));
  if (window?.endAt && report.window.endAt !== iso(window.endAt)) diagnostics.push(error('window_end_mismatch', 'window.endAt'));
  const allowed = new Set(stringArray(sourceIds, 2000, 200));
  const sourceByRef = new Map(arrayValue(sources).map((item) => [clean(item?.refId, 200), item]));
  for (const [index, claim] of report.claims.entries()) {
    if (!claim.sourceRefs.length && claim.status !== 'suggestion') diagnostics.push(error('claim_source_required', `claims.${index}.sourceRefs`));
    if (claim.sourceRefs.some((id) => !allowed.has(id))) diagnostics.push(error('claim_source_unknown', `claims.${index}.sourceRefs`));
    if (claim.status === 'completed' && !claim.sourceRefs.some((id) => completedSource(sourceByRef.get(id)))) {
      diagnostics.push(error('claim_completed_evidence_required', `claims.${index}.sourceRefs`));
    }
  }
  for (const [index, suggestion] of report.suggestions.entries()) {
    if (suggestion.sourceRefs.some((id) => !allowed.has(id))) diagnostics.push(error('suggestion_source_unknown', `suggestions.${index}.sourceRefs`));
    if (report.kind === 'growth_guidance' && !suggestion.sourceRefs.length) diagnostics.push(error('growth_guidance_source_required', `suggestions.${index}.sourceRefs`));
    if (report.kind === 'growth_guidance' && suggestion.category === 'insight' && !suggestion.perspective && !suggestion.rationale) {
      diagnostics.push(error('growth_guidance_perspective_required', `suggestions.${index}.perspective`));
    }
    if (report.kind === 'growth_guidance' && suggestion.category === 'research_direction' && !suggestion.researchQuestion) {
      diagnostics.push(error('growth_guidance_question_required', `suggestions.${index}.researchQuestion`));
    }
  }
  if (report.kind === 'growth_guidance' && allowed.size && !report.suggestions.length) diagnostics.push(error('growth_guidance_extension_required', 'suggestions'));
  return { valid: diagnostics.length === 0, value: report, diagnostics };
}

function completedSource(source) {
  if (!source || typeof source !== 'object') return false;
  if (String(source.sourceKind || '').endsWith('_message')) return false;
  return ['completed', 'result_accepted', 'closed'].includes(clean(source.status, 80));
}

export function normalizeFollowerPreferences(value = {}) {
  const source = objectValue(value);
  const prompts = objectValue(source.prompts);
  const language = enumValue(source.language, ['zh-CN', 'en'], 'zh-CN');
  const defaults = language === 'en' ? FOLLOWER_DEFAULT_PROMPTS_EN : FOLLOWER_DEFAULT_PROMPTS;
  return {
    verbosity: enumValue(source.verbosity, ['short', 'standard', 'detailed'], 'standard'),
    reasoningEffort: enumValue(source.reasoningEffort, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium'),
    language,
    focus: stringArray(source.focus, 8, 80).filter((item) => ['risks', 'deliveries', 'blockers', 'next_steps', 'projects'].includes(item)),
    suggestionCount: Math.max(1, Math.min(8, Number(source.suggestionCount || 3) || 3)),
    model: clean(source.model, 160),
    prompts: Object.fromEntries(FOLLOWER_REPORT_KINDS.map((kind) => [
      kind,
      cleanMultiline(prompts[kind] || defaults[kind], 2_000),
    ])),
  };
}

export function normalizeFollowerSchedule(value = {}) {
  const source = objectValue(value);
  const kind = enumValue(source.kind, FOLLOWER_REPORT_KINDS, 'daily_brief');
  const frequency = enumValue(source.frequency, FOLLOWER_SCHEDULE_FREQUENCIES, kind === 'weekly_review' ? 'weekly' : 'daily');
  return {
    kind,
    enabled: Boolean(source.enabled),
    timezone: validTimeZone(source.timezone) ? clean(source.timezone, 100) : '',
    frequency,
    daysOfWeek: [...new Set(arrayValue(source.daysOfWeek).map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort(),
    localTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(source.localTime || '')) ? String(source.localTime) : '',
    missedRunPolicy: 'coalesce_once',
  };
}

function validTimeZone(value = '') {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(value || '') }).format();
    return Boolean(value);
  } catch {
    return false;
  }
}

function enumValue(value, allowed, fallback) {
  const normalized = clean(value);
  return allowed.includes(normalized) ? normalized : fallback;
}

function stringArray(value, maximum, itemLength) {
  const result = [];
  const seen = new Set();
  for (const item of arrayValue(value)) {
    const normalized = clean(item, itemLength);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximum) break;
  }
  return result;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function cleanMultiline(value = '', maximum = 1200) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, maximum);
}

function iso(value = '') {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function nonNegativeInteger(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function error(code, field) {
  return { severity: 'error', code, field };
}
