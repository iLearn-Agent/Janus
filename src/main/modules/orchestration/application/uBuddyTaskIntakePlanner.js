import { runCodexSession } from '../../../codex.js';
import {
  UBUDDY_TASK_INTAKE_VERSION,
  normalizeUBuddyTaskIntake,
  validateUBuddyTaskIntake,
} from '../../../../shared/contracts/uBuddyTaskIntake.js';
import { validateWorkReportSpec } from '../../../../shared/contracts/workDigest.js';

export const UBUDDY_TASK_INTAKE_DECISION_VERSION = 'UBUDDY_TASK_INTAKE_DECISION_V2';
export const DEFAULT_UBUDDY_TASK_INTAKE_TIMEOUT_MS = 600_000;
export const DEFAULT_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS = 180_000;
export const UBUDDY_TASK_INTAKE_REASONING_EFFORT = 'low';

const INTAKE_ACTIONS = new Set(['direct', 'collect_context', 'dispatch_task']);
const RECENT_MESSAGE_BUDGETS = Object.freeze({
  initial: Object.freeze({ messageLimit: 6, characterLimit: 800 }),
  continuation: Object.freeze({ messageLimit: 3, characterLimit: 600 }),
  compactInitial: Object.freeze({ messageLimit: 3, characterLimit: 500 }),
  compactContinuation: Object.freeze({ messageLimit: 2, characterLimit: 400 }),
});

export function resolveUBuddyIntakeDispatchAuthorization({
  intakeDecision = null,
  pendingIntake = null,
  hasStagedContext = false,
  explicitDispatch = false,
  explicitNewTask = false,
  composerTaskMode = false,
} = {}) {
  const intake = intakeDecision?.intake || null;
  if (!intakeDecision?.taskIntent || !intake) {
    return dispatchAuthorization('direct', false, 'intake_not_task_intent');
  }
  if (intake.state === 'needs_clarification') {
    return dispatchAuthorization('clarification', false, 'intake_needs_clarification');
  }
  if (composerTaskMode) {
    return dispatchAuthorization('dispatch_task', true, 'composer_task_mode');
  }
  const explicitlyAuthorized = Boolean(explicitDispatch || explicitNewTask);
  if (explicitlyAuthorized) {
    return dispatchAuthorization('dispatch_task', true, explicitNewTask
      ? 'explicit_new_task_reference'
      : 'explicit_dispatch_confirmation');
  }
  if (intakeDecision.action !== 'dispatch_task') {
    return dispatchAuthorization('collect_context', false, 'intake_collect_context');
  }
  if (pendingIntake?.awaitingDispatch || hasStagedContext) {
    const completingFocusedClarification = Boolean(
      pendingIntake
      && pendingIntake.awaitingDispatch !== true
      && pendingIntake.intake?.state === 'needs_clarification'
      && intakeDecision.continuation === true
    );
    if (!completingFocusedClarification) {
      return dispatchAuthorization('collect_context', false, pendingIntake?.awaitingDispatch
        ? 'ready_intake_requires_explicit_dispatch'
        : 'staged_context_requires_explicit_dispatch');
    }
  }
  return dispatchAuthorization('dispatch_task', true, pendingIntake
    ? 'clarification_completed_with_dispatch_intent'
    : 'current_turn_dispatch_intent');
}

function dispatchAuthorization(action, authorized, reasonCode) {
  return {
    version: 'ubuddy_dispatch_authorization_v1',
    action,
    authorized: Boolean(authorized),
    reasonCode,
  };
}

export async function decideUBuddyTaskIntake({
  prompt = '',
  recentMessages = [],
  previousIntake = null,
  previousRequest = '',
  attachmentSummaries = [],
  referenceSummaries = [],
  mentionedUsers = [],
  clarificationResponse = null,
  plannerThreadId = '',
  plannerSessionId = '',
  composerTaskMode = false,
  recentWorkReportingEnabled = false,
  root = '',
  cwd = '',
  model = '',
  reasoningEffort = '',
  signal = null,
  timeoutMs = Number(process.env.JANUS_UBUDDY_TASK_INTAKE_TIMEOUT_MS || DEFAULT_UBUDDY_TASK_INTAKE_TIMEOUT_MS),
  execute = runCodexSession,
  executionContext = null,
} = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw intakeError('uBuddy task intake requires a user message.');
  const defaultTimezone = runtimeTimeZone();
  const plannerPrompt = buildUBuddyTaskIntakePrompt({
    prompt: cleanPrompt,
    recentMessages,
    previousIntake,
    previousRequest,
    attachmentSummaries,
    referenceSummaries,
    mentionedUsers,
    composerTaskMode,
    recentWorkReportingEnabled,
    defaultTimezone,
  });
  const configuredTotalTimeoutMs = Number(timeoutMs);
  const totalTimeoutMs = Number.isFinite(configuredTotalTimeoutMs) && configuredTotalTimeoutMs > 1
    ? configuredTotalTimeoutMs
    : DEFAULT_UBUDDY_TASK_INTAKE_TIMEOUT_MS;
  const configuredRetryTimeoutMs = Number(process.env.JANUS_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS
    || Math.min(totalTimeoutMs, DEFAULT_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS));
  const retryTimeoutCeiling = Math.max(1, Math.floor(totalTimeoutMs / 2));
  const retryTimeoutMs = Number.isFinite(configuredRetryTimeoutMs) && configuredRetryTimeoutMs > 0
    ? Math.min(configuredRetryTimeoutMs, retryTimeoutCeiling)
    : Math.min(DEFAULT_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS, retryTimeoutCeiling);
  const primaryTimeoutMs = Math.max(1, totalTimeoutMs - retryTimeoutMs);
  let answer;
  try {
    const executionResult = await execute({
      prompt: plannerPrompt,
      freshPrompt: plannerPrompt,
      agentId: 'secretary_agent',
      sessionId: plannerSessionId || executionContext?.conversationId || 'ubuddy-task-intake',
      threadId: plannerThreadId,
      root,
      cwd: cwd || root,
      role: 'ubuddy-task-intake',
      model,
      reasoningEffort: UBUDDY_TASK_INTAKE_REASONING_EFFORT,
      sandbox: 'read-only',
      signal,
      timeoutMs: primaryTimeoutMs,
      harnessMode: 'raw',
      readOnly: true,
      memoryUseEnabled: false,
      memoryGenerateEnabled: false,
      nativeMultiAgentEnabled: false,
      executionContext,
    });
    answer = modelAnswer(executionResult);
    plannerThreadId = modelThreadId(executionResult, plannerThreadId);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!isUBuddyTaskIntakeTimeoutError(error)) {
      throw intakeError(`uBuddy task intake failed: ${String(error?.message || error)}`, error);
    }
    const compactPrompt = buildUBuddyTaskIntakePrompt({
      prompt: cleanPrompt,
      recentMessages,
      previousIntake,
      previousRequest,
      attachmentSummaries,
      referenceSummaries,
      mentionedUsers,
      composerTaskMode,
      recentWorkReportingEnabled,
      defaultTimezone,
      compact: true,
    });
    try {
      const executionResult = await execute({
        prompt: compactPrompt,
        freshPrompt: compactPrompt,
        agentId: 'secretary_agent',
        sessionId: plannerSessionId || executionContext?.conversationId || 'ubuddy-task-intake',
        threadId: plannerThreadId,
        root,
        cwd: cwd || root,
        role: 'ubuddy-task-intake-retry',
        model,
        reasoningEffort: UBUDDY_TASK_INTAKE_REASONING_EFFORT,
        sandbox: 'read-only',
        signal,
        timeoutMs: retryTimeoutMs,
        harnessMode: 'raw',
        readOnly: true,
        memoryUseEnabled: false,
        memoryGenerateEnabled: false,
        nativeMultiAgentEnabled: false,
        executionContext,
      });
      answer = modelAnswer(executionResult);
      plannerThreadId = modelThreadId(executionResult, plannerThreadId);
    } catch (retryError) {
      if (signal?.aborted) throw retryError;
      const failure = intakeError(`uBuddy task intake failed after a compact retry: ${String(retryError?.message || retryError)}`, retryError);
      failure.uBuddyIntakeRetryAttempted = true;
      if (isUBuddyTaskIntakeTimeoutError(retryError)) failure.code = 'ubuddy_task_intake_timeout';
      throw failure;
    }
  }
  try {
    const parsedDecision = parseJsonAnswer(answer);
    const enrichedDecision = enrichKnownIntakeFields(parsedDecision, {
      previousIntake,
      mentionedUsers,
      attachmentSummaries,
      clarificationAnswer: cleanPrompt,
      clarificationResponse,
    });
    const timezoneResolvedDecision = resolveRecentWorkTimezoneAlias(enrichedDecision, defaultTimezone);
    const repairableDecision = downgradeIncompleteRecentWorkIntake(timezoneResolvedDecision, { defaultTimezone });
    const allowedCandidateUserIds = normalizeUsers(mentionedUsers).map((item) => item.userId);
    const safeDecision = replaceUnmentionedCandidatesWithExecutionTargetClarification(
      repairableDecision,
      allowedCandidateUserIds,
      cleanPrompt,
    );
    return {
      ...validateUBuddyTaskIntakeDecision(safeDecision, {
        allowedCandidateUserIds,
        allowedAttachmentIds: (Array.isArray(attachmentSummaries) ? attachmentSummaries : [])
          .map((item) => String(item?.id || '').trim()).filter(Boolean),
      }),
      rawAnswer: answer,
      plannerThreadId,
    };
  } catch (error) {
    const failure = error?.code === 'ubuddy_task_intake_failed'
      ? error
      : intakeError(`uBuddy task intake was invalid: ${String(error?.message || error)}`, error);
    failure.uBuddyRawAnswerPreview = clipText(answer, 6000);
    throw failure;
  }
}

function modelAnswer(result) {
  return result && typeof result === 'object' ? String(result.answer || '') : String(result || '');
}

function modelThreadId(result, fallback = '') {
  return String(result && typeof result === 'object' ? result.threadId || fallback : fallback).trim();
}

function downgradeIncompleteRecentWorkIntake(value = {}, { defaultTimezone = runtimeTimeZone() } = {}) {
  const intake = value?.intake;
  if (value?.taskIntent !== true || intake?.taskKind !== 'recent_work_report' || intake.state !== 'ready') return value;
  const validation = validateWorkReportSpec(intake.workReportSpec || {}, { requireAudience: false });
  if (validation.valid) return value;
  const questionByCode = {
    work_report_start_missing: {
      id: 'clarify_report_period', header: '报告时间', question: '请确认报告覆盖的绝对起止时间和时区。',
      reason: '近期工作报告需要明确的时间边界。', answerType: 'text', options: [], allowOther: true, required: true,
    },
    work_report_end_missing: {
      id: 'clarify_report_period', header: '报告时间', question: '请确认报告覆盖的绝对起止时间和时区。',
      reason: '近期工作报告需要明确的时间边界。', answerType: 'text', options: [], allowOther: true, required: true,
    },
    work_report_timezone_missing: {
      id: 'clarify_report_period', header: '报告时间', question: '请确认报告覆盖的绝对起止时间和时区。',
      reason: '近期工作报告需要明确时区。', answerType: 'text', options: [], allowOther: true, required: true,
    },
    work_report_timezone_invalid: {
      id: 'clarify_report_timezone', header: '报告时区',
      question: `无法从联系人资料确定对方所在地时区。请选择按 ${defaultTimezone} 或 UTC 统计，也可以填写对方所在城市或 IANA 时区。`,
      reason: '联系人资料没有可验证的所在地时区，不能把自然语言说明作为时区执行。',
      answerType: 'single_choice',
      options: [
        { value: defaultTimezone, label: `按我的当前时区（${defaultTimezone}）`, description: '使用当前设备时区解释起止日期。' },
        { value: 'UTC', label: 'UTC', description: '按协调世界时解释起止日期。' },
      ],
      allowOther: true, required: true,
    },
    work_report_workspace_scope_missing: {
      id: 'clarify_workspace_scope', header: '工作范围', question: '需要汇总哪个 Workspace 或项目范围？',
      reason: '工作范围会改变报告所包含的任务。', answerType: 'workspace_scope',
      options: [
        { value: 'current_workspace', label: '当前工作空间', description: '仅汇总当前工作空间。' },
        { value: 'all_authorized_workspaces', label: '全部已授权空间', description: '汇总有权访问的全部工作空间。' },
        { value: 'selected_projects', label: '指定项目', description: '仅汇总指定项目。' },
      ],
      allowOther: true, required: true,
    },
    work_report_projects_missing: {
      id: 'clarify_projects', header: '项目范围', question: '请选择需要纳入报告的项目。',
      reason: '选择“指定项目”后必须明确项目范围。', answerType: 'text', options: [], allowOther: true, required: true,
    },
  };
  const clarifications = [];
  const seen = new Set();
  for (const diagnostic of validation.diagnostics) {
    const question = questionByCode[diagnostic.code];
    if (!question || seen.has(question.id)) continue;
    seen.add(question.id);
    clarifications.push({ version: 'ubuddy_clarification_question_v1', ...question });
  }
  if (!clarifications.length) return value;
  return {
    ...value,
    action: 'collect_context',
    intake: {
      ...intake,
      state: 'needs_clarification',
      missingFields: clarifications.map((item) => item.id),
      clarifications,
      clarification: {
        reasonCode: clarifications[0].id,
        question: clarifications[0].question,
        options: clarifications[0].options.map((item) => item.label),
      },
      criticalUnknowns: clarifications.map((item) => ({
        id: item.id, name: item.header, reason: item.reason, questionId: item.id,
      })),
      readiness: { status: 'needs_clarification', reason: '近期工作报告仍缺少必要范围信息。' },
    },
  };
}

function resolveRecentWorkTimezoneAlias(value = {}, defaultTimezone = runtimeTimeZone()) {
  const intake = value?.intake;
  if (value?.taskIntent !== true || intake?.taskKind !== 'recent_work_report' || !intake.workReportSpec) return value;
  const timezone = String(intake.workReportSpec.timezone || '').trim();
  if (!/^(?:requester_local|current_device|local|我的当前时区|当前时区|本地时区)$/iu.test(timezone)) return value;
  return {
    ...value,
    intake: {
      ...intake,
      workReportSpec: { ...intake.workReportSpec, timezone: defaultTimezone },
      safeAssumptions: [...new Set([...(intake.safeAssumptions || []), `报告日期按发起人当前时区 ${defaultTimezone} 解释。`])],
    },
  };
}

function runtimeTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function replaceUnmentionedCandidatesWithExecutionTargetClarification(value = {}, allowedUserIds = [], prompt = '') {
  if (value?.taskIntent !== true || !value.intake || typeof value.intake !== 'object') return value;
  const allowed = new Set(allowedUserIds);
  const candidates = normalizeUsers(value.intake.candidateUsers || value.intake.candidateUserIds);
  const missingFields = Array.isArray(value.intake.missingFields) ? value.intake.missingFields : [];
  const missingExecutionTarget = !allowed.size
    && missingFields.some((field) => ['candidateUsers', 'requiredUsers', 'executionTarget'].includes(String(field || '')));
  if (!missingExecutionTarget && !candidates.some((item) => !allowed.has(item.userId))) return value;
  const retainedCandidates = candidates.filter((item) => allowed.has(item.userId));
  const requiredUsers = normalizeUsers(value.intake.requiredUsers || value.intake.requiredUserIds)
    .filter((item) => allowed.has(item.userId));
  const english = !/[\u3400-\u9fff]/u.test(String(prompt || ''));
  const question = {
    version: 'ubuddy_clarification_question_v1',
    id: 'executionTarget',
    header: english ? 'Execution target' : '执行方',
    question: english
      ? 'No Agent or contact was selected for this task. How should it be completed?'
      : '这项任务尚未指定 Agent 或联系人，请选择完成方式。',
    reason: english
      ? 'A contact must be selected explicitly before uBuddy can delegate work.'
      : '委托任务前需要通过联系人列表明确选择接收人。',
    answerType: 'execution_target',
    options: [
      {
        label: english ? 'Complete locally' : '本地完成',
        description: english ? 'Let uBuddy select a local Agent and complete the task here.' : '由 uBuddy 选择合适的本地 Agent 执行。',
      },
      {
        label: english ? 'Complete with a contact' : '@ 联系人完成',
        description: english ? 'Choose a contact before delegating the task.' : '打开联系人列表，选择任务接收人。',
      },
    ],
    allowOther: false,
    required: true,
  };
  return {
    ...value,
    action: 'collect_context',
    continuation: Boolean(value.continuation),
    intake: {
      ...value.intake,
      state: 'needs_clarification',
      candidateUsers: retainedCandidates,
      requiredUsers,
      privacyScope: retainedCandidates.length ? 'direct_delegation' : 'owner_private',
      missingFields: ['executionTarget'],
      clarifications: [question],
      clarification: {
        reasonCode: question.id,
        question: question.question,
        options: question.options.map((item) => item.label),
      },
      criticalUnknowns: [{
        id: 'executionTarget',
        name: english ? 'Execution target' : '执行方',
        reason: question.reason,
        questionId: question.id,
      }],
      readiness: { status: 'needs_clarification', reason: question.reason },
    },
  };
}

export function isUBuddyTaskIntakeTimeoutError(error = null) {
  let current = error;
  const visited = new Set();
  for (let depth = 0; current && depth < 8 && !visited.has(current); depth += 1) {
    visited.add(current);
    const code = String(current?.code || '').trim();
    const message = String(current?.message || current || '');
    if (['codex_request_timeout', 'ubuddy_task_intake_timeout'].includes(code)
      || /(?:model request|process|task intake).{0,40}timed out|timed out after \d+(?:ms|s)/i.test(message)) return true;
    current = current?.cause;
  }
  return false;
}

export function buildSafeUBuddyTaskIntakeFallback({
  prompt = '',
  previousIntake = null,
  mentionedUsers = [],
  attachmentSummaries = [],
  taskIntent = false,
  action = 'collect_context',
  continuation = false,
  objective = '',
  deliverables = [],
  privacyScope = '',
  riskLevel = 'low',
} = {}) {
  if (!taskIntent) {
    return {
      version: UBUDDY_TASK_INTAKE_DECISION_VERSION,
      taskIntent: false,
      action: 'direct',
      continuation: Boolean(continuation),
      intake: null,
      recovery: { mode: 'deterministic_timeout_fallback' },
    };
  }
  const previous = previousIntake ? normalizeUBuddyTaskIntake(previousIntake) : null;
  const candidates = mergeById(previous?.candidateUsers || [], normalizeUsers(mentionedUsers), 'userId');
  const attachments = mergeById(previous?.attachments || [], normalizeAttachments(attachmentSummaries), 'id');
  const resolvedPrivacyScope = ['owner_private', 'direct_delegation', 'task_group_public'].includes(privacyScope)
    ? privacyScope
    : candidates.length ? 'direct_delegation' : 'owner_private';
  const previousRequired = mergeById(previous?.requiredUsers || [], [], 'userId')
    .filter((item) => candidates.some((candidate) => candidate.userId === item.userId));
  const requiredUsers = resolvedPrivacyScope === 'owner_private'
    ? []
    : previousRequired.length
      ? previousRequired
      : candidates.length === 1 ? [candidates[0]] : [];
  const fallbackDeliverables = (Array.isArray(deliverables) ? deliverables : [])
    .map((item) => String(item || '').trim()).filter(Boolean);
  const decision = {
    version: UBUDDY_TASK_INTAKE_DECISION_VERSION,
    taskIntent: true,
    action: action === 'dispatch_task' ? 'dispatch_task' : 'collect_context',
    continuation: Boolean(continuation),
    intake: {
      version: UBUDDY_TASK_INTAKE_VERSION,
      state: 'ready',
      objective: String(objective || previous?.objective || prompt || '').trim(),
      deliverables: previous?.deliverables?.length
        ? previous.deliverables
        : fallbackDeliverables.length ? fallbackDeliverables : ['完成请求并返回明确结果'],
      acceptanceCriteria: previous?.acceptanceCriteria || [],
      constraints: previous?.constraints || [],
      deadline: previous?.deadline || '',
      taskKind: previous?.taskKind || 'general',
      workReportSpec: previous?.workReportSpec || null,
      candidateUsers: candidates,
      requiredUsers,
      attachments,
      privacyScope: resolvedPrivacyScope,
      riskLevel: ['low', 'medium', 'high'].includes(riskLevel) ? riskLevel : 'low',
      missingFields: [],
      clarification: { reasonCode: '', question: '', options: [] },
    },
  };
  return {
    ...validateUBuddyTaskIntakeDecision(decision, {
      allowedCandidateUserIds: candidates.map((item) => item.userId),
      allowedAttachmentIds: attachments.map((item) => item.id),
    }),
    recovery: { mode: 'deterministic_timeout_fallback' },
  };
}

function enrichKnownIntakeFields(value = {}, {
  previousIntake = null,
  mentionedUsers = [],
  attachmentSummaries = [],
  clarificationAnswer = '',
  clarificationResponse = null,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.taskIntent !== true || !value.intake || typeof value.intake !== 'object') return value;
  const knownUsers = normalizeUsers(mentionedUsers);
  const sourceCandidates = normalizeUsers(value.intake.candidateUsers || value.intake.candidateUserIds);
  const sourceRequired = normalizeUsers(value.intake.requiredUsers || value.intake.requiredUserIds);
  const previousCandidates = normalizeUsers(previousIntake?.candidateUsers || previousIntake?.candidateUserIds);
  const previousRequired = normalizeUsers(previousIntake?.requiredUsers || previousIntake?.requiredUserIds);
  const knownAttachments = normalizeAttachments(attachmentSummaries);
  const sourceAttachments = normalizeAttachments(value.intake.attachments || value.intake.attachmentRefs);
  const previousAttachments = normalizeAttachments(previousIntake?.attachments || previousIntake?.attachmentRefs);
  const hasCandidateUsers = hasOwn(value.intake, 'candidateUsers') || hasOwn(value.intake, 'candidateUserIds');
  const hasRequiredUsers = hasOwn(value.intake, 'requiredUsers') || hasOwn(value.intake, 'requiredUserIds');
  const hasAttachments = hasOwn(value.intake, 'attachments') || hasOwn(value.intake, 'attachmentRefs');
  const hasTaskKind = hasOwn(value.intake, 'taskKind') || hasOwn(value.intake, 'task_kind');
  const hasWorkReportSpec = hasOwn(value.intake, 'workReportSpec') || hasOwn(value.intake, 'work_report_spec');
  const taskKind = hasTaskKind ? value.intake.taskKind || value.intake.task_kind : previousIntake?.taskKind || 'general';
  const sourceWorkReportSpec = hasWorkReportSpec
    ? value.intake.workReportSpec || value.intake.work_report_spec || {}
    : {};
  const workReportSpec = taskKind === 'recent_work_report'
    ? applyRecentWorkClarificationAnswers({
        ...(previousIntake?.workReportSpec || {}),
        ...sourceWorkReportSpec,
      }, {
        previousIntake,
        answer: clarificationAnswer,
        clarificationResponse,
      })
    : hasWorkReportSpec ? sourceWorkReportSpec : previousIntake?.workReportSpec || null;
  return {
    ...value,
    intake: {
      ...value.intake,
      candidateUsers: hasCandidateUsers
        ? sourceCandidates
        : mergeById(previousCandidates, knownUsers, 'userId'),
      requiredUsers: hasRequiredUsers ? sourceRequired : previousRequired,
      attachments: hasAttachments
        ? sourceAttachments
        : mergeById(previousAttachments, knownAttachments, 'id'),
      taskKind,
      workReportSpec,
    },
  };
}

function applyRecentWorkClarificationAnswers(spec = {}, {
  previousIntake = null,
  answer = '',
  clarificationResponse = null,
} = {}) {
  const next = { ...(spec || {}) };
  const text = String(answer || '').replace(/\s+/g, ' ').trim();
  const pendingIds = new Set((previousIntake?.clarifications || [])
    .map((question) => String(question?.id || '').trim().toLowerCase()));
  const workspaceQuestionPending = [...pendingIds].some((id) => id.includes('workspace_scope'));
  if (workspaceQuestionPending && !String(next.workspaceScope || next.workspace_scope || '').trim()) {
    const structuredAnswer = (clarificationResponse?.answers || []).find((item) => (
      String(item?.questionId || '').trim().toLowerCase().includes('workspace_scope')
    ));
    const workspaceAnswer = String(structuredAnswer?.value || '').trim()
      || clarificationAnswerForIds(text, pendingIds, ['workspace_scope']);
    const scope = normalizeRecentWorkWorkspaceAnswer(workspaceAnswer);
    if (scope) next.workspaceScope = scope;
  }
  return next;
}

function clarificationAnswerForIds(text = '', pendingIds = new Set(), idParts = []) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^([^:：]+)\s*[:：]\s*(.+)$/.exec(line);
    if (!match) continue;
    const id = String(match[1] || '').trim().toLowerCase();
    if (![...pendingIds].some((pendingId) => pendingId === id)
      && !idParts.some((part) => id.includes(part))) continue;
    return String(match[2] || '').trim();
  }
  return '';
}

function normalizeRecentWorkWorkspaceAnswer(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return new Set(['current_workspace', 'all_authorized_workspaces', 'selected_projects']).has(normalized)
    ? normalized
    : '';
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

export function validateUBuddyTaskIntakeDecision(value = {}, {
  allowedCandidateUserIds = null,
  allowedAttachmentIds = null,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw intakeError('uBuddy task intake decision must be a JSON object.');
  }
  const version = String(value.version || '').trim();
  if (version !== UBUDDY_TASK_INTAKE_DECISION_VERSION) {
    throw intakeError(`Unsupported uBuddy task intake decision version: ${version || 'missing'}.`);
  }
  const taskIntent = value.taskIntent === true;
  const action = String(value.action || '').trim().toLowerCase();
  if (!INTAKE_ACTIONS.has(action)) {
    throw intakeError(`Invalid uBuddy task intake action: ${action || 'missing'}.`);
  }
  if (!taskIntent) {
    if (action !== 'direct') throw intakeError('A non-task intake decision must use action=direct.');
    return {
      version,
      taskIntent: false,
      intake: null,
      continuation: Boolean(value.continuation),
      action,
    };
  }
  if (action === 'direct') throw intakeError('A task intake decision cannot use action=direct.');
  const validated = validateUBuddyTaskIntake(value.intake, { throwOnError: true }).value;
  if (Array.isArray(allowedCandidateUserIds)) {
    const allowed = new Set(allowedCandidateUserIds.map((item) => String(item || '').trim()).filter(Boolean));
    const unexpected = validated.candidateUserIds.filter((userId) => !allowed.has(userId));
    if (unexpected.length) throw intakeError(`Task intake selected unmentioned candidate users: ${unexpected.join(', ')}.`);
  }
  if (Array.isArray(allowedAttachmentIds)) {
    const allowed = new Set(allowedAttachmentIds.map((item) => String(item || '').trim()).filter(Boolean));
    const unexpected = validated.attachmentRefs.filter((item) => !allowed.has(item.id));
    if (unexpected.length) throw intakeError(`Task intake referenced unknown attachments: ${unexpected.map((item) => item.id).join(', ')}.`);
  }
  if (validated.state === 'needs_clarification' && !validated.clarifications.length) {
    throw intakeError('A blocking task intake must provide at least one focused clarification question.');
  }
  return {
    version,
    taskIntent: true,
    intake: validated,
    continuation: Boolean(value.continuation),
    action,
  };
}

export function findPendingUBuddyTaskIntake(messages = []) {
  const source = Array.isArray(messages) ? messages : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index] || {};
    const intake = message.metadata?.uBuddyTaskIntakeSpec;
    if (!intake) continue;
    if (message.role === 'user' && message.metadata?.uBuddyIntakeDecisionFailed) continue;
    const clarificationPending = message.role === 'assistant' && intake.state === 'needs_clarification';
    const dispatchPending = message.role === 'assistant'
      && intake.state === 'ready'
      && message.metadata?.uBuddyIntakeAwaitingDispatch === true;
    if (!clarificationPending && !dispatchPending) return null;
    const laterUserMessage = source.slice(index + 1).some((item) => (
      item?.role === 'user' && !isIntakeNeutralControlMessage(item)
    ));
    if (laterUserMessage) return null;
    const sourceMessageId = String(message.metadata?.sourceMessageId || '').trim();
    const sourceMessage = source.find((item) => item?.id === sourceMessageId) || null;
    return {
      intake,
      clarificationMessage: message,
      sourceMessage,
      sourceMessageId,
      awaitingDispatch: dispatchPending,
      plannerThreadId: String(message.metadata?.uBuddyIntakePlannerThreadId || '').trim(),
    };
  }
  return null;
}

function isIntakeNeutralControlMessage(message = {}) {
  const metadata = message?.metadata || {};
  return Boolean(
    metadata.identityControl
    || metadata.greetingControl
    || metadata.contextCollection
    || metadata.taskQueryIntent
    || metadata.uBuddyMessageMode === 'ask'
    || metadata.uBuddyIntakeDecisionFailed
  );
}

export function renderUBuddyTaskIntakeExecutionPrompt(intake = null, fallback = '') {
  if (!intake?.objective) return String(fallback || '').trim();
  return [
    `任务目标：${intake.objective}`,
    intake.deliverables?.length ? `交付物：${intake.deliverables.join('；')}` : '',
    intake.acceptanceCriteria?.length ? `验收标准：${intake.acceptanceCriteria.join('；')}` : '',
    intake.constraints?.length ? `约束：${intake.constraints.join('；')}` : '',
    intake.deadline ? `截止时间：${intake.deadline}` : '',
    intake.taskKind === 'recent_work_report' ? `任务类型：近期工作汇报\n汇报范围：${JSON.stringify(intake.workReportSpec || {})}` : '',
    `隐私范围：${intake.privacyScope}`,
    `风险等级：${intake.riskLevel}`,
  ].filter(Boolean).join('\n');
}

function buildUBuddyTaskIntakePrompt({
  prompt,
  recentMessages,
  previousIntake,
  previousRequest,
  attachmentSummaries,
  referenceSummaries,
  mentionedUsers,
  composerTaskMode = false,
  recentWorkReportingEnabled = false,
  defaultTimezone = runtimeTimeZone(),
  compact = false,
}) {
  const recentMessageBudget = recentMessageBudgetForIntake({
    compact,
    hasPreviousIntake: Boolean(previousIntake),
  });
  return [
    '【UBUDDY_TASK_INTAKE_DECISION_V2】',
    'Return exactly one JSON object and no Markdown. This is a read-only intake gate before any task, collaboration group, delegation, or task graph can be created.',
    'Write every user-visible intake field in the same language as the current owner message, especially the objective, deliverables, criteria, constraints, clarification question, and options.',
    'Decide task information completeness separately from whether the owner wants work created now. Always return action=direct|collect_context|dispatch_task.',
    composerTaskMode
      ? 'The composer is authoritatively in Task mode. Return taskIntent=true and action=dispatch_task for every request for a new answer, result, action, or external response, even if wording otherwise contradicts task creation. A question, reminder, notification, or other request addressed to a structured user is a formal external delegation whose deliverable is the recipient\'s clear, verifiable response; never describe it as sending or recording a lightweight message. The only exception is a request whose sole purpose is to inspect progress, results, artifacts, review status, or pending state of existing work; for that read-only inquiry return taskIntent=false and action=direct so the full Codex uBuddy can query verified state. Ask one material clarification when required.'
      : '',
    composerTaskMode
      ? 'In Task mode, never use action=direct merely because the request is conversational, informational, phrased as a question, or appears small. Only the existing-work inquiry exception above may continue through direct-answer logic.'
      : 'Use action=direct with taskIntent=false only for a conversational/informational turn that should continue through the existing direct-answer logic, or when the owner clearly abandons an earlier intake.',
    'For any formal local task, external delegation, task-group request, or request addressed to another user, set taskIntent=true and produce one complete uBuddyTaskIntakeSpec.',
    'Use action=collect_context when the owner is only adding background, constraints, recipients, files, or other intake facts and has not asked to create, start, publish, assign, or dispatch work in this turn. A complete state=ready intake is still only a draft when action=collect_context.',
    'Use action=dispatch_task only when the current turn clearly asks to create/start a new task, assign or publish work, confirms a pending dispatch, or supplies the final requested clarification in a way that clearly continues the previously requested execution. Never infer dispatch merely because the intake became complete.',
    'When recent messages contain contextCollection or a ready intake awaiting dispatch, further background-only supplements MUST remain action=collect_context until the owner explicitly confirms creation or dispatch.',
    'Extract intake facts from the current message, recent conversation, previous intake, structured mentions, attachment summaries, and selected reference summaries. Treat files and references as opaque inputs during intake; never infer or request their body text.',
    'When previousIntake is present, update that intake with the owner\'s new answer. Preserve all populated fields unless the owner explicitly changes them; do not reinterpret the whole request from scratch.',
    'A request to inspect progress, results, artifacts, review status, or pending state of existing work is neutral to any previous intake. Return taskIntent=false and action=direct for that turn; do not treat it as a clarification answer, abandon the pending intake, or create another task.',
    'First draft a concise executionPlan with the steps the selected Agent or recipient would actually perform. Then audit the plan for critical unknowns. Only block when a missing fact would materially change the result set, execution target, deliverable, recipient, risk handling, deadline feasibility, data scope, permissions, or privacy/publication scope. Do not ask for optional preferences when a safe default is sufficient; record that default in safeAssumptions.',
    recentWorkReportingEnabled
      ? 'Classify a request asking another user to report, summarize, or hand back that user\'s recent work as taskKind=recent_work_report. This is a formal delegation, never an existing-task query.'
      : '',
    recentWorkReportingEnabled
      ? 'For taskKind=recent_work_report, never interpret an unqualified word such as recent/latest/近期/最近 as a time range. Before ready, obtain all currently identifiable required inputs: one absolute startAt/endAt range and timezone, then workspaceScope=current_workspace|all_authorized_workspaces|selected_projects. Return all independent missing questions together.'
      : '',
    recentWorkReportingEnabled
      ? `The authenticated requester device timezone is ${defaultTimezone}. Unless the owner explicitly requires another timezone, use ${defaultTimezone} as a safe assumption and do not ask a timezone question. Never emit natural-language timezone text: workReportSpec.timezone must be a valid IANA timezone.`
      : '',
    recentWorkReportingEnabled
      ? 'For a ready recent_work_report set workReportSpec.version=work_report_spec_v1, sourceTypes=["structured_tasks"], confirmationMode=owner_confirmation, audienceUserIds=[] (the host binds the authenticated requester), and sections to the requested sections or all five standard sections. Maximum lookback is 90 days.'
      : '',
    'If blocked, state=needs_clarification, missingFields may contain all currently known critical fields, clarifications must contain one entry for each independent missing decision, and each question should include 2-4 useful suggested answers when choices are practical. The UI provides a free-form answer for every question.',
    'If not blocked, state=ready, missingFields=[], clarifications=[], readiness.status=ready, executionPlan must be executable, and deliverables must name the actual expected output type. Always return knownFacts, safeAssumptions, criticalUnknowns, executionPlan, and readiness.',
    'candidateUsers contains only explicitly mentioned or previously retained possible recipients. requiredUsers contains recipients explicitly required by the owner and must be a subset of candidateUsers. Never invent or select an unmentioned user.',
    'If the wording clearly requests external delegation but no recipient is identified, ask only for candidateUsers. requiredUsers may be empty when the mentioned users form a candidate pool for later Profile selection. If the final output form is materially ambiguous, ask only for deliverables.',
    'Use privacyScope=owner_private for local private work, direct_delegation when the intended result should remain in private one-to-one delegation workspaces, and task_group_public when selected participants may share task-group information. Candidate count alone does not decide topology; the final one-to-one versus task-group topology is decided after participant selection and collaboration-mode planning. Public release outside Janus is a high-risk constraint, not a new privacyScope value.',
    'Use riskLevel=high for deletion, payment, deployment, public publication, credentials, or binding external commitments; medium for meaningful external or organizational consequences; otherwise low.',
    `Previous intake to continue:\n${previousIntake ? JSON.stringify(previousIntake) : 'None.'}`,
    previousIntake ? '' : `Original request for the previous intake:\n${clipText(previousRequest || 'None.', compact ? 2000 : 4000)}`,
    `Recent visible conversation:\n${formatRecentMessages(recentMessages, recentMessageBudget) || 'No previous visible conversation.'}`,
    `Structured users mentioned in this intake:\n${JSON.stringify(normalizeUsers(mentionedUsers))}`,
    `Attachment summaries:\n${JSON.stringify((Array.isArray(attachmentSummaries) ? attachmentSummaries : []).slice(0, 20))}`,
    `Selected reference summaries:\n${JSON.stringify(normalizeReferenceSummaries(referenceSummaries))}`,
    `Current owner message:\n${prompt}`,
    `Schema: {"version":"${UBUDDY_TASK_INTAKE_DECISION_VERSION}","taskIntent":true,"action":"collect_context|dispatch_task","continuation":false,"intake":{"version":"${UBUDDY_TASK_INTAKE_VERSION}","state":"ready|needs_clarification","taskKind":"${recentWorkReportingEnabled ? 'general|recent_work_report' : 'general'}","workReportSpec":${recentWorkReportingEnabled ? 'null|{"version":"work_report_spec_v1","startAt":"ISO","endAt":"ISO","timezone":"IANA","workspaceScope":"current_workspace|all_authorized_workspaces|selected_projects","projectIds":[],"agentInstanceIds":[],"sourceTypes":["structured_tasks"],"sections":["completed","in_progress","blockers","next_steps","artifacts"],"detailLevel":"brief|standard|detailed","audienceUserIds":["..."],"confirmationMode":"owner_confirmation"}' : 'null'},"objective":"...","deliverables":["report"],"acceptanceCriteria":[],"constraints":[],"deadline":"","candidateUsers":[{"userId":"...","displayName":"..."}],"requiredUsers":[{"userId":"...","displayName":"..."}],"attachments":[{"id":"...","name":"...","kind":"..."}],"privacyScope":"owner_private|direct_delegation|task_group_public","riskLevel":"low|medium|high","missingFields":["..."],"clarifications":[{"id":"...","header":"...","question":"...","reason":"...","answerType":"single_choice","options":[{"value":"stable_machine_value","label":"localized label","description":"..."}],"allowOther":true,"required":true}],"executionPlan":{"summary":"...","steps":["..."],"requiredInputs":[{"id":"...","name":"...","reason":"...","source":"owner|context|default","satisfied":true}]},"knownFacts":["..."],"safeAssumptions":["..."],"criticalUnknowns":[{"id":"...","name":"...","reason":"...","questionId":"..."}],"readiness":{"status":"ready|needs_clarification","reason":"..."}}}. For state=ready use missingFields=[], clarifications=[], readiness.status=ready. For taskIntent=false, use action=direct and intake=null.`,
  ].filter(Boolean).join('\n\n');
}

function recentMessageBudgetForIntake({ compact = false, hasPreviousIntake = false } = {}) {
  if (compact) {
    return hasPreviousIntake
      ? RECENT_MESSAGE_BUDGETS.compactContinuation
      : RECENT_MESSAGE_BUDGETS.compactInitial;
  }
  return hasPreviousIntake
    ? RECENT_MESSAGE_BUDGETS.continuation
    : RECENT_MESSAGE_BUDGETS.initial;
}

function normalizeUsers(users = []) {
  return (Array.isArray(users) ? users : []).map((item) => {
    const source = typeof item === 'string' ? { userId: item } : item || {};
    return {
      userId: String(source.userId || source.id || '').trim(),
      displayName: String(source.displayName || source.name || source.displayText || '').replace(/^@/, '').trim(),
    };
  }).filter((item) => item.userId).slice(0, 100);
}

function normalizeAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).map((item) => {
    const source = typeof item === 'string' ? { id: item } : item || {};
    return {
      id: String(source.id || source.attachmentId || '').trim(),
      name: String(source.name || source.filename || source.fileName || '').trim(),
      kind: String(source.kind || source.type || source.mimeType || '').trim(),
    };
  }).filter((item) => item.id).slice(0, 20);
}

function normalizeReferenceSummaries(references = []) {
  return (Array.isArray(references) ? references : []).map((item) => {
    const source = item || {};
    const referenceKind = String(source.referenceKind || source.kind || '').trim();
    const memoryReference = Boolean(source.sourceMemoryId || source.memoryDocumentId || referenceKind === 'archived_memory');
    return {
      id: String(source.referenceId || source.id || source.sourceMemoryId || source.memoryDocumentId || '').trim(),
      name: String(source.name || source.displayName || source.relativePath || '').trim(),
      kind: memoryReference ? 'archived_memory' : referenceKind || 'file',
      contentType: memoryReference ? '' : String(source.contentType || source.type || '').trim(),
      sizeBytes: memoryReference ? 0 : Math.max(0, Number(source.sizeBytes || source.size || 0)),
    };
  }).filter((item) => item.id || item.name).slice(0, 20);
}

function mergeById(primary = [], additional = [], key = 'id') {
  const result = new Map();
  for (const item of [...primary, ...additional]) {
    const id = String(item?.[key] || '').trim();
    if (!id) continue;
    const merged = { ...(result.get(id) || {}) };
    for (const [field, value] of Object.entries(item)) {
      if (!merged[field] && value) merged[field] = value;
    }
    result.set(id, merged);
  }
  return [...result.values()];
}

function formatRecentMessages(messages = [], { messageLimit = 16, characterLimit = 1200 } = {}) {
  return (Array.isArray(messages) ? messages : []).slice(-messageLimit).map((message) => {
    const role = String(message?.role || 'user').trim();
    return `${role}: ${clipText(message?.content || '', characterLimit)}`;
  }).filter((item) => !item.endsWith(': ')).join('\n');
}

function parseJsonAnswer(answer = '') {
  const text = String(answer || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw intakeError('uBuddy task intake did not return JSON.');
  return JSON.parse(fenced.slice(start, end + 1));
}

function clipText(value = '', limit = 1000) {
  const text = String(value || '');
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function intakeError(message, cause = null) {
  const error = new Error(message);
  error.code = 'ubuddy_task_intake_failed';
  if (cause) error.cause = cause;
  return error;
}
