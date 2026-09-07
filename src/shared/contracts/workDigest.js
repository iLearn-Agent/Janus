export const WORK_REPORT_SPEC_VERSION = 'work_report_spec_v1';
export const WORK_DIGEST_VERSION = 'work_digest_v1';
export const WORK_REPORT_MAX_LOOKBACK_DAYS = 90;
export const WORK_REPORT_EMPTY_WAIT_MS = 15 * 60 * 1000;

export const WORK_REPORT_SECTIONS = Object.freeze([
  'completed', 'in_progress', 'blockers', 'next_steps', 'artifacts',
]);

export const WORK_REPORT_WORKSPACE_SCOPES = Object.freeze([
  'current_workspace', 'all_authorized_workspaces', 'selected_projects',
]);

export function normalizeWorkReportSpec(value = {}) {
  const source = objectValue(value);
  const rawScope = clean(source.workspaceScope || source.workspace_scope).toLowerCase();
  const sections = cleanArray(source.sections, WORK_REPORT_SECTIONS, 5);
  return {
    version: clean(source.version) || WORK_REPORT_SPEC_VERSION,
    startAt: isoDate(source.startAt || source.start_at),
    endAt: isoDate(source.endAt || source.end_at),
    timezone: clean(source.timezone, 100),
    workspaceScope: WORK_REPORT_WORKSPACE_SCOPES.includes(rawScope) ? rawScope : '',
    projectIds: stringArray(source.projectIds || source.project_ids, 24, 160),
    agentInstanceIds: stringArray(source.agentInstanceIds || source.agent_instance_ids, 100, 160),
    sourceTypes: ['structured_tasks'],
    sections: sections.length ? sections : [...WORK_REPORT_SECTIONS],
    detailLevel: ['brief', 'standard', 'detailed'].includes(clean(source.detailLevel || source.detail_level).toLowerCase())
      ? clean(source.detailLevel || source.detail_level).toLowerCase() : 'standard',
    audienceUserIds: stringArray(source.audienceUserIds || source.audience_user_ids, 100, 160),
    confirmationMode: 'owner_confirmation',
  };
}

export function validateWorkReportSpec(value = {}, { now = Date.now(), throwOnError = false, requireAudience = true } = {}) {
  const spec = normalizeWorkReportSpec(value);
  const diagnostics = [];
  if (spec.version !== WORK_REPORT_SPEC_VERSION) diagnostics.push(error('work_report_version_unsupported', 'version'));
  if (!spec.startAt) diagnostics.push(error('work_report_start_missing', 'startAt'));
  if (!spec.endAt) diagnostics.push(error('work_report_end_missing', 'endAt'));
  if (!spec.timezone) diagnostics.push(error('work_report_timezone_missing', 'timezone'));
  else if (!validTimeZone(spec.timezone)) diagnostics.push(error('work_report_timezone_invalid', 'timezone'));
  if (!spec.workspaceScope) diagnostics.push(error('work_report_workspace_scope_missing', 'workspaceScope'));
  const start = Date.parse(spec.startAt);
  const end = Date.parse(spec.endAt);
  if (spec.startAt && spec.endAt && (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)) {
    diagnostics.push(error('work_report_time_range_invalid', 'startAt'));
  }
  if (Number.isFinite(start) && Number.isFinite(end)
    && end - start > WORK_REPORT_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) {
    diagnostics.push(error('work_report_time_range_too_large', 'startAt'));
  }
  if (Number.isFinite(end) && end > Number(now) + 24 * 60 * 60 * 1000) {
    diagnostics.push(error('work_report_end_in_future', 'endAt'));
  }
  if (spec.workspaceScope === 'selected_projects' && !spec.projectIds.length) {
    diagnostics.push(error('work_report_projects_missing', 'projectIds'));
  }
  if (requireAudience && !spec.audienceUserIds.length) diagnostics.push(error('work_report_audience_missing', 'audienceUserIds'));
  const result = { valid: diagnostics.length === 0, value: spec, diagnostics };
  if (!result.valid && throwOnError) {
    const exception = new Error(diagnostics.map((item) => item.code).join(', '));
    exception.code = 'work_report_spec_invalid';
    exception.diagnostics = diagnostics;
    throw exception;
  }
  return result;
}

export function normalizeWorkDigestEvidence(value = {}) {
  const source = objectValue(value);
  return {
    id: clean(source.id, 200), sourceKind: clean(source.sourceKind || source.source_kind, 80),
    sourceId: clean(source.sourceId || source.source_id, 200), sourceRevision: clean(source.sourceRevision || source.source_revision, 200),
    workspaceId: clean(source.workspaceId || source.workspace_id, 160), projectId: clean(source.projectId || source.project_id, 160),
    agentId: clean(source.agentId || source.agent_id, 160), agentInstanceId: clean(source.agentInstanceId || source.agent_instance_id, 160),
    occurredAt: isoDate(source.occurredAt || source.occurred_at), title: clean(source.title, 300), status: clean(source.status, 80),
    summary: clean(source.summary, 1200), blocker: clean(source.blocker, 600), nextStep: clean(source.nextStep || source.next_step, 600),
    artifacts: stringArray(source.artifacts, 20, 300), included: source.included !== false,
  };
}

function isoDate(value = '') {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function validTimeZone(value = '') {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function cleanArray(value, allow, maximum) {
  return stringArray(value, maximum, 80).filter((item) => allow.includes(item));
}

function stringArray(value, maximum, itemLength) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
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

function clean(value = '', maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function error(code, field) {
  return { severity: 'error', code, field };
}
