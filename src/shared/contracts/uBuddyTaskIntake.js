import { normalizeUBuddyDeliverables } from './uBuddyDispatch.js';
import { normalizeWorkReportSpec, validateWorkReportSpec } from './workDigest.js';

export const UBUDDY_TASK_INTAKE_VERSION = 'ubuddy_task_intake_v1';

export const UBUDDY_TASK_INTAKE_STATES = Object.freeze([
  'ready',
  'needs_clarification',
]);

export const UBUDDY_TASK_PRIVACY_SCOPES = Object.freeze([
  'owner_private',
  'direct_delegation',
  'task_group_public',
]);

export const UBUDDY_TASK_RISK_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
]);

export const UBUDDY_TASK_KINDS = Object.freeze(['general', 'recent_work_report']);

export const uBuddyTaskIntakeSpec = Object.freeze({
  name: 'uBuddyTaskIntakeSpec',
  version: UBUDDY_TASK_INTAKE_VERSION,
  fields: Object.freeze({
    version: 'string',
    taskKind: 'general | recent_work_report',
    workReportSpec: 'WORK_REPORT_SPEC_V1 | null',
    state: 'ready | needs_clarification',
    objective: 'string',
    deliverables: 'string[]',
    acceptanceCriteria: 'string[]',
    constraints: 'string[]',
    deadline: 'string',
    privacyScope: 'owner_private | direct_delegation | task_group_public',
    riskLevel: 'low | medium | high',
    candidateUsers: '{ userId: string, displayName: string }[]',
    requiredUsers: '{ userId: string, displayName: string }[]',
    attachments: '{ id: string, name: string, kind: string }[]',
    candidateUserIds: 'string[]',
    requiredUserIds: 'string[]',
    attachmentRefs: '{ id: string, name: string, kind: string }[]',
    missingFields: 'string[]',
    clarification: '{ reasonCode: string, question: string, options: string[] }',
    clarifications: 'UBUDDY_CLARIFICATION_QUESTION_V1[]',
    executionPlan: '{ summary: string, steps: string[], requiredInputs: object[] }',
    knownFacts: 'string[]',
    safeAssumptions: 'string[]',
    criticalUnknowns: 'object[]',
    readiness: '{ status: ready | needs_clarification, reason: string }',
  }),
  requiredWhenReady: Object.freeze(['objective', 'deliverables']),
});

export function normalizeUBuddyTaskIntake(value = {}) {
  const source = objectValue(value);
  const candidateUsers = normalizeUsers(source.candidateUsers || source.candidate_users
    || source.candidateUserIds || source.candidate_user_ids);
  const requiredUsers = normalizeUsers(source.requiredUsers || source.required_users
    || source.requiredUserIds || source.required_user_ids);
  const candidateUserIds = candidateUsers.map((item) => item.userId);
  const requiredUserIds = requiredUsers.map((item) => item.userId);
  const normalizedAttachments = normalizeAttachmentRefs(source.attachments || source.attachmentRefs || source.attachment_refs);
  const rawState = clean(source.state).toLowerCase();
  const rawPrivacyScope = clean(source.privacyScope || source.privacy_scope).toLowerCase();
  const rawRiskLevel = clean(source.riskLevel || source.risk_level).toLowerCase();
  const rawTaskKind = clean(source.taskKind || source.task_kind).toLowerCase();
  const legacyClarification = normalizeClarification(source.clarification);
  const clarifications = normalizeTaskClarifications(
    normalizeClarifications(source.clarifications, legacyClarification),
    rawTaskKind,
  );
  const readiness = normalizeReadiness(source.readiness, rawState, clarifications);
  return {
    version: clean(source.version) || UBUDDY_TASK_INTAKE_VERSION,
    state: UBUDDY_TASK_INTAKE_STATES.includes(rawState) ? rawState : 'needs_clarification',
    taskKind: UBUDDY_TASK_KINDS.includes(rawTaskKind) ? rawTaskKind : 'general',
    workReportSpec: rawTaskKind === 'recent_work_report'
      ? normalizeWorkReportSpec(source.workReportSpec || source.work_report_spec)
      : null,
    objective: clean(source.objective, 4_000),
    deliverables: normalizeUBuddyDeliverables(source.deliverables),
    acceptanceCriteria: cleanStringArray(source.acceptanceCriteria || source.acceptance_criteria, 24, 500),
    constraints: cleanStringArray(source.constraints, 24, 500),
    deadline: clean(source.deadline, 160),
    privacyScope: UBUDDY_TASK_PRIVACY_SCOPES.includes(rawPrivacyScope) ? rawPrivacyScope : 'owner_private',
    riskLevel: UBUDDY_TASK_RISK_LEVELS.includes(rawRiskLevel) ? rawRiskLevel : 'low',
    candidateUsers,
    requiredUsers,
    attachments: normalizedAttachments,
    // Compatibility aliases for the Stage 0 routing contracts.
    candidateUserIds,
    requiredUserIds,
    attachmentRefs: normalizedAttachments.map((item) => ({ ...item })),
    missingFields: cleanStringArray(source.missingFields || source.missing_fields, 24, 120),
    clarification: clarifications.length ? clarificationLegacyAlias(clarifications[0]) : legacyClarification,
    clarifications,
    executionPlan: normalizeExecutionPlan(source.executionPlan || source.execution_plan),
    knownFacts: cleanStringArray(source.knownFacts || source.known_facts, 40, 500),
    safeAssumptions: cleanStringArray(source.safeAssumptions || source.safe_assumptions, 40, 500),
    criticalUnknowns: normalizeCriticalUnknowns(source.criticalUnknowns || source.critical_unknowns),
    readiness,
  };
}

function normalizeUsers(value = []) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const source = typeof item === 'string' ? { userId: item } : objectValue(item);
    const userId = clean(source.userId || source.user_id || source.id, 160);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    result.push({
      userId,
      displayName: clean(source.displayName || source.display_name || source.name, 240),
    });
    if (result.length >= 100) break;
  }
  return result;
}

export function validateUBuddyTaskIntake(value = {}, { throwOnError = false } = {}) {
  const source = objectValue(value);
  const intake = normalizeUBuddyTaskIntake(value);
  const diagnostics = [];
  if (intake.version !== UBUDDY_TASK_INTAKE_VERSION) {
    diagnostics.push(errorDiagnostic('task_intake_version_unsupported', 'version', 'Unsupported uBuddy task intake version.'));
  }
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.state, allowedValues: UBUDDY_TASK_INTAKE_STATES,
    code: 'task_intake_state_invalid', field: 'state', message: 'A task intake requires a supported state.' });
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.privacyScope ?? source.privacy_scope, allowedValues: UBUDDY_TASK_PRIVACY_SCOPES,
    code: 'task_intake_privacy_scope_invalid', field: 'privacyScope', message: 'A task intake requires a supported privacy scope.' });
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.riskLevel ?? source.risk_level, allowedValues: UBUDDY_TASK_RISK_LEVELS,
    code: 'task_intake_risk_level_invalid', field: 'riskLevel', message: 'A task intake requires a supported risk level.' });
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.taskKind ?? source.task_kind, allowedValues: UBUDDY_TASK_KINDS,
    code: 'task_intake_kind_invalid', field: 'taskKind', message: 'A task intake requires a supported task kind.' });
  const candidateIds = new Set(intake.candidateUserIds);
  for (const userId of intake.requiredUserIds) {
    if (!candidateIds.has(userId)) {
      diagnostics.push(errorDiagnostic('task_intake_required_user_not_candidate', 'requiredUserIds', 'Every required user must also be a candidate user.'));
    }
  }
  if (intake.state === 'ready') {
    if (!intake.objective) diagnostics.push(errorDiagnostic('task_intake_objective_missing', 'objective', 'A ready task intake requires an objective.'));
    if (!intake.deliverables.length) diagnostics.push(errorDiagnostic('task_intake_deliverables_missing', 'deliverables', 'A ready task intake requires at least one deliverable.'));
    if (intake.privacyScope !== 'owner_private' && !intake.candidateUserIds.length) {
      diagnostics.push(errorDiagnostic('task_intake_candidate_users_missing', 'candidateUsers', 'A ready external task intake requires at least one candidate user.'));
    }
    if (intake.privacyScope === 'owner_private' && intake.requiredUserIds.length) {
      diagnostics.push(errorDiagnostic('task_intake_private_scope_has_required_users', 'privacyScope', 'An owner-private task intake cannot require external users.'));
    }
    if (intake.missingFields.length) diagnostics.push(errorDiagnostic('task_intake_ready_has_missing_fields', 'missingFields', 'A ready task intake cannot contain missing fields.'));
    if (intake.clarifications.length) diagnostics.push(errorDiagnostic('task_intake_ready_has_clarification', 'clarifications', 'A ready task intake cannot contain clarification questions.'));
    if (intake.readiness.status !== 'ready') diagnostics.push(errorDiagnostic('task_intake_ready_readiness_invalid', 'readiness.status', 'A ready task intake must pass readiness review.'));
    if (intake.taskKind === 'recent_work_report') {
      const workReportValidation = validateWorkReportSpec(intake.workReportSpec || {}, { requireAudience: false });
      diagnostics.push(...workReportValidation.diagnostics.map((item) => errorDiagnostic(item.code, `workReportSpec.${item.field}`, item.code)));
    }
  } else if (!intake.clarifications.length) {
    diagnostics.push(errorDiagnostic('task_intake_clarification_missing', 'clarifications', 'A task intake that needs clarification requires at least one question.'));
  }
  for (const question of intake.clarifications) {
    if (!question.id || !question.question) diagnostics.push(errorDiagnostic('task_intake_clarification_invalid', 'clarifications', 'Every clarification requires an id and question.'));
    if (question.options.length === 1) diagnostics.push(errorDiagnostic('task_intake_clarification_options_invalid', 'clarifications.options', 'Clarification options must be empty or contain at least two choices.'));
  }
  return finishValidation('ubuddy_task_intake_invalid', intake, diagnostics, throwOnError);
}

function normalizeAttachmentRefs(value = []) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const source = typeof item === 'string' ? { id: item } : objectValue(item);
    const id = clean(source.id || source.attachmentId || source.attachment_id, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: clean(source.name, 240),
      kind: clean(source.kind || source.type, 80),
    });
    if (result.length >= 20) break;
  }
  return result;
}

function normalizeClarification(value = {}) {
  const source = objectValue(value);
  return {
    reasonCode: clean(source.reasonCode || source.reason_code, 120),
    question: clean(source.question, 1_000),
    options: cleanStringArray(source.options, 4, 160),
  };
}

function normalizeClarifications(value, legacy = {}) {
  const source = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  for (let index = 0; index < source.length; index += 1) {
    const item = objectValue(source[index]);
    const id = clean(item.id || item.questionId || item.question_id || `question_${index + 1}`, 120);
    const question = clean(item.question, 1000);
    if (!id || !question || seen.has(id)) continue;
    seen.add(id);
    result.push({
      version: 'ubuddy_clarification_question_v1',
      id,
      header: clean(item.header, 120),
      question,
      reason: clean(item.reason || item.reasonCode || item.reason_code, 500),
      answerType: clean(item.answerType || item.answer_type, 40) || 'single_choice',
      options: normalizeQuestionOptions(item.options),
      allowOther: item.allowOther !== false && item.allow_other !== false,
      required: item.required !== false,
    });
    if (result.length >= 12) break;
  }
  if (!result.length && legacy.question) {
    result.push({
      version: 'ubuddy_clarification_question_v1', id: legacy.reasonCode || 'clarification_1', header: '',
      question: legacy.question, reason: legacy.reasonCode, answerType: 'single_choice',
      options: legacy.options.map((label) => ({ label, description: '' })), allowOther: true, required: true,
    });
  }
  return result;
}

function normalizeQuestionOptions(value = []) {
  const source = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  for (const item of source) {
    const sourceItem = typeof item === 'string' ? { label: item } : objectValue(item);
    const label = clean(sourceItem.label, 160);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    result.push({
      value: clean(sourceItem.value, 160) || label,
      label,
      description: clean(sourceItem.description, 300),
    });
    if (result.length >= 6) break;
  }
  return result;
}

function normalizeTaskClarifications(clarifications = [], taskKind = '') {
  if (taskKind !== 'recent_work_report') return clarifications;
  return clarifications.map((question) => {
    if (!String(question.id || '').toLowerCase().includes('workspace_scope')) return question;
    return {
      ...question,
      answerType: 'workspace_scope',
      options: [
        { value: 'current_workspace', label: '当前工作空间', description: '仅汇总当前工作空间内的结构化任务。' },
        { value: 'all_authorized_workspaces', label: '全部已授权空间', description: '汇总有权访问的全部工作空间。' },
        { value: 'selected_projects', label: '指定项目', description: '仅汇总随后指定的项目。' },
      ],
      allowOther: true,
    };
  });
}

function clarificationLegacyAlias(question = {}) {
  return {
    reasonCode: clean(question.reason || question.id, 120),
    question: clean(question.question, 1000),
    options: (question.options || []).map((item) => clean(item.label, 160)).filter(Boolean),
  };
}

function normalizeExecutionPlan(value = {}) {
  const source = objectValue(value);
  return {
    summary: clean(source.summary, 2000),
    steps: cleanStringArray(source.steps, 20, 500),
    requiredInputs: (Array.isArray(source.requiredInputs || source.required_inputs)
      ? source.requiredInputs || source.required_inputs : []).slice(0, 30).map((item, index) => {
      const input = typeof item === 'string' ? { name: item } : objectValue(item);
      return { id: clean(input.id || `input_${index + 1}`, 120), name: clean(input.name, 240),
        reason: clean(input.reason, 500), source: clean(input.source, 80), satisfied: input.satisfied === true };
    }).filter((item) => item.name),
  };
}

function normalizeCriticalUnknowns(value = []) {
  return (Array.isArray(value) ? value : []).slice(0, 30).map((item, index) => {
    const source = typeof item === 'string' ? { name: item } : objectValue(item);
    return { id: clean(source.id || `unknown_${index + 1}`, 120), name: clean(source.name || source.field, 240),
      reason: clean(source.reason || source.impact, 500), questionId: clean(source.questionId || source.question_id, 120) };
  }).filter((item) => item.name);
}

function normalizeReadiness(value = {}, rawState = '', clarifications = []) {
  const source = objectValue(value);
  const requested = clean(source.status, 40).toLowerCase();
  const status = ['ready', 'needs_clarification'].includes(requested)
    ? requested
    : rawState === 'ready' && !clarifications.length ? 'ready' : 'needs_clarification';
  return { status, reason: clean(source.reason, 1000) };
}

function cleanStringArray(value = [], maximum = 24, itemLength = 240) {
  const source = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  for (const item of source) {
    const normalized = clean(typeof item === 'string' ? item : item?.label, itemLength);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximum) break;
  }
  return result;
}

function finishValidation(code, value, diagnostics, throwOnError) {
  const result = { valid: diagnostics.every((item) => item.severity !== 'error'), value, diagnostics };
  if (throwOnError && !result.valid) {
    const error = new Error(diagnostics.map((item) => item.message).join(' '));
    error.code = code;
    error.diagnostics = diagnostics;
    throw error;
  }
  return result;
}

function errorDiagnostic(code, field, message) {
  return { severity: 'error', code, field, message };
}

function addInvalidEnumDiagnostic({ diagnostics, rawValue, allowedValues, code, field, message }) {
  const normalized = clean(rawValue).toLowerCase();
  if (normalized && !allowedValues.includes(normalized)) diagnostics.push(errorDiagnostic(code, field, message));
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '', maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}
