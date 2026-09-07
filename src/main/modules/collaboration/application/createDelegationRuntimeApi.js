import {
  buildPublicTaskProgressSnapshot,
  buildDeterministicWorkDigest,
  buildTimedOutEmptyWorkDigest,
  buildUBuddyPlannerCandidates,
  classifyTaskType,
  createDeliverableContract,
  decideUBuddyTurn,
  deliverableContractRequiresValidation,
  proposeUBuddyTaskGraph,
  publicTaskAgentWorkStatus,
  collectRecentWork,
  selectBestUBuddyCandidate,
  validateStandaloneDeliverable,
} from '../../orchestration/index.js';
import {
  normalizeWorkDigestEvidence,
  validateWorkReportSpec,
  WORK_REPORT_EMPTY_WAIT_MS,
} from '../../../../shared/contracts/workDigest.js';
import { normalizeMentionEntities } from '../../../../shared/contracts/mentions.js';
import { legacyDelegationTransitionAllowed } from '../../../../shared/contracts/delegation.js';
import {
  normalizePublicTaskSummary,
  renderPublicTaskSummaryContext,
} from '../../../../shared/contracts/taskSummary.js';
import { classifyPptIntent } from '../../../pptIntent.js';
import { socialRelayMutationMode, socialRelayUnavailableError } from './socialRelayMutationPolicy.js';
import { createSocialAutomationLedger } from './socialAutomationLedger.js';

const SOCIAL_AUTOMATION_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.JANUS_SOCIAL_AUTOMATION_MAX_AGE_MINUTES || 30) * 60_000,
);
const DEFAULT_EXTERNAL_DELEGATION_MAX_PLANNING_EPOCHS = 3;
const DEFAULT_EXTERNAL_DELEGATION_PLANNING_MAX_ATTEMPTS = 3;
const DEFAULT_EXTERNAL_DELEGATION_PLANNING_BUDGET_MS = 180_000;
const EXTERNAL_DELEGATION_PLANNING_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000]);

function externalDelegationPermissionMode(value = '') {
  return String(value || '').trim() === 'auto-approve' ? 'auto-approve' : 'full-access';
}

function workDigestToolResult(success, value) {
  return {
    success: Boolean(success),
    contentItems: [{ type: 'inputText', text: JSON.stringify(value ?? {}) }],
  };
}

function recentWorkReportingDisabledError() {
  const error = new Error('近期工作汇报功能未在接收端启用，任务不会转入普通 Agent 调度。');
  error.code = 'recent_work_reporting_disabled';
  return error;
}

export function externalDelegationPlanningRecoveryExhausted({
  executionEpoch = 0,
  taskRunId = '',
  maxPlanningEpochs = Number(process.env.JANUS_EXTERNAL_DELEGATION_MAX_PLANNING_EPOCHS
    || DEFAULT_EXTERNAL_DELEGATION_MAX_PLANNING_EPOCHS),
} = {}) {
  const epoch = Math.max(0, Number(executionEpoch || 0));
  const limit = Math.max(1, Number(maxPlanningEpochs || DEFAULT_EXTERNAL_DELEGATION_MAX_PLANNING_EPOCHS));
  return !String(taskRunId || '').trim() && epoch > limit;
}

export function externalDelegationPlanningAttemptTimeoutMs({
  attempt = 1,
  maxAttempts = DEFAULT_EXTERNAL_DELEGATION_PLANNING_MAX_ATTEMPTS,
  startedAt = Date.now(),
  now = Date.now(),
  budgetMs = DEFAULT_EXTERNAL_DELEGATION_PLANNING_BUDGET_MS,
  maximumAttemptMs = 90_000,
} = {}) {
  const currentAttempt = Math.max(1, Number(attempt || 1));
  const attemptLimit = Math.max(currentAttempt, Number(maxAttempts || DEFAULT_EXTERNAL_DELEGATION_PLANNING_MAX_ATTEMPTS));
  const remainingAttempts = Math.max(1, attemptLimit - currentAttempt + 1);
  const remainingBudget = Math.max(1_000, Number(budgetMs || DEFAULT_EXTERNAL_DELEGATION_PLANNING_BUDGET_MS)
    - Math.max(0, Number(now || 0) - Number(startedAt || 0)));
  const futureDelays = EXTERNAL_DELEGATION_PLANNING_RETRY_DELAYS_MS
    .slice(currentAttempt - 1, attemptLimit - 1)
    .reduce((total, value) => total + value, 0);
  return Math.max(1_000, Math.min(
    Math.max(1_000, Number(maximumAttemptMs || 90_000)),
    Math.floor(Math.max(1_000, remainingBudget - futureDelays) / remainingAttempts),
  ));
}

export function externalDelegationPlanningFailureIsTransient(error = null) {
  const raw = String(error?.message || error || '');
  if (/Codex CLI (?:was not found|could not be launched)|auth(?:entication)? required|unauthorized|forbidden/i.test(raw)) return false;
  return /timeout|timed out|\bECONN(?:RESET|REFUSED)?\b|\bENOTFOUND\b|\bEAI_AGAIN\b|fetch failed|network error|socket hang up|service unavailable|temporarily unavailable|bad gateway|gateway timeout|at capacity|rate.?limit|too many requests|\b(?:429|502|503|504)\b/i.test(raw);
}

function waitForExternalDelegationPlanningRetry(delayMs, signal = null) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Task planning cancelled.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.max(0, Number(delayMs || 0)));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Task planning cancelled.'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function delegationExecutionLeaseRenewalDefinitelyLost(error = null) {
  const code = String(error?.code || '').trim().toLowerCase();
  return Number(error?.status || 0) === 409
    || ['delegation_execution_lease_lost', 'delegation_execution_claimed', 'delegation_execution_terminal'].includes(code);
}

export function delegationExecutionLeaseRetryDelayMs(lease = {}, now = Date.now()) {
  const expiresAt = Date.parse(String(lease.leaseExpiresAt || lease.lease_expires_at || ''));
  if (!Number.isFinite(expiresAt)) return 10_000;
  const remainingMs = expiresAt - Number(now || 0);
  if (remainingMs <= 0) return 0;
  return Math.max(250, Math.min(10_000, remainingMs - 1_000));
}

function collaborationAutomationItemIsFresh(item = {}, now = Date.now()) {
  const timestamp = Date.parse(item.updatedAt || item.updated_at || item.createdAt || item.created_at || '');
  return Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp <= SOCIAL_AUTOMATION_MAX_AGE_MS;
}

function socialAutomationScopeIsFresh(item = {}, now = Date.now()) {
  const timestamp = Date.parse(item.createdAt || item.created_at || item.updatedAt || item.updated_at || '');
  return Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp <= SOCIAL_AUTOMATION_MAX_AGE_MS;
}

function collaborationAutomationStateIsFresh(tasks = [], now = Date.now()) {
  return (Array.isArray(tasks) ? tasks : []).some((task) => collaborationAutomationItemIsFresh(task, now));
}

function strictDelegationDraftJson(answer = '') {
  const candidate = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(candidate);
    return Boolean(String(parsed?.title || '').trim() && String(parsed?.content || '').trim());
  } catch {
    return false;
  }
}

function draftProcessingDiagnostics(error = null, {
  code = '', phase = 'create', model = '', providerId = '', executionId = '', retryable = true, message = '',
} = {}) {
  const raw = String(error?.message || error || '').trim();
  const normalized = raw.toLowerCase();
  let resolvedCode = code;
  if (!resolvedCode && /missing environment variable.*openai_api_key|openai_api_key.*(?:missing|not configured)/i.test(raw)) resolvedCode = 'auth_missing';
  else if (!resolvedCode && /(?:status|http)[^\n]*(?:401|403)|unauthorized|forbidden/i.test(raw)) resolvedCode = 'provider_auth_failed';
  else if (!resolvedCode && /(?:status|http)[^\n]*429|rate.?limit|too many requests/i.test(raw)) resolvedCode = 'rate_limited';
  else if (!resolvedCode && /502 bad gateway|err_connection_closed|provider relay failed/i.test(raw)) resolvedCode = 'provider_relay_failed';
  else if (!resolvedCode && /timed out|timeout/i.test(raw)) resolvedCode = 'timeout';
  else if (!resolvedCode && /codex cli was not found|could not be launched|codex unavailable/i.test(raw)) resolvedCode = 'codex_unavailable';
  else if (!resolvedCode) resolvedCode = normalized ? 'model_failed' : 'fallback';
  const messages = {
    auth_missing: '当前设备没有可用的模型 API Key，已生成基础草稿。',
    provider_auth_failed: '模型服务拒绝了鉴权，已生成基础草稿。',
    rate_limited: '模型服务当前限流，已生成基础草稿。',
    provider_relay_failed: '模型网络中转连接失败，已生成基础草稿。',
    timeout: '草稿模型在 30 秒内没有完成，已生成基础草稿。',
    codex_unavailable: '当前设备无法启动 Codex，已生成基础草稿。',
    model_output_recovered: '模型返回格式异常，系统已恢复可编辑内容。',
    forced_fallback: '当前客户端配置为不调用大模型，已生成基础草稿。',
    model_failed: '模型草稿生成失败，已生成基础草稿。',
    fallback: '本次使用了基础草稿模式。',
  };
  return {
    code: resolvedCode,
    phase: String(phase || 'create'),
    message: String(message || messages[resolvedCode] || messages.model_failed),
    detail: safeDraftErrorDetail(raw),
    retryable: Boolean(retryable),
    executionId: String(executionId || ''),
    providerId: String(providerId || ''),
    model: String(model || ''),
    occurredAt: new Date().toISOString(),
  };
}

function safeDraftErrorDetail(raw = '') {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const causal = lines.filter((line) => /^(?:error|warning):|missing environment variable|bad gateway|err_connection|timed out|timeout|unauthorized|forbidden|rate.?limit/i.test(line));
  const source = (causal.length ? causal.slice(-5) : lines.slice(-2)).join('\n');
  return String(source || 'No additional technical detail was recorded.')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:OPENAI_API_KEY\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/[A-Za-z]:\\[^\s]+|\/(?:home|Users|var|tmp)\/[^\s]+/g, '[LOCAL_PATH]')
    .slice(0, 1200);
}

function validateDelegationDeliverable({ store, task = null, delegation = {}, answer = '', workspaceRoot = '', generatedTaskFiles = [] } = {}) {
  const fileCandidates = (generatedTaskFiles || []).map((item) => item.source_path || item.sourcePath || item.path || item.relative_path || '').filter(Boolean);
  if (task?.id) {
    const current = store.getTaskRun(task.id) || task;
    return current.metadata?.deliverableResult || current.metadata?.deliveryReview || null;
  }
  const contract = createDeliverableContract({
    prompt: delegation.instruction || delegation.title,
    finalNode: { agentId: 'general_agent' },
  });
  if (!deliverableContractRequiresValidation(contract)) return null;
  return validateStandaloneDeliverable({
    contract,
    prompt: delegation.instruction || delegation.title,
    answer,
    workspaceRoot,
    ownerAgent: contract.owner_agent,
    fileCandidates,
  });
}

function deliverableValidationError(validation = {}) {
  const error = new Error(validation.summary || '最终交付物未通过验收。');
  error.code = validation.failureCode || 'deliverable_validation_failed';
  error.deliveryValidation = validation;
  return error;
}

function delegationAttachmentSelectionKey(item = {}) {
  return String(item.selectionKey || item.id || item.fileId || item.file_id || item.remote_file_id
    || item.source_path || item.sourcePath || item.path || item.relative_path
    || `${item.name || item.filename || ''}:${Number(item.size || 0)}`).trim();
}

function privateExternalDeliveryAttachment(item = {}) {
  return {
    ...item,
    selectionKey: delegationAttachmentSelectionKey(item),
  };
}

function delegationCandidateSubmissionText(message = {}) {
  const explicit = String(message.metadata?.submissionText || '').trim();
  if (explicit) return explicit;
  return String(message.content || '')
    .replace(/\n+你可以继续告诉我需要修改的地方，或回复“提交到任务群”。\s*$/u, '')
    .trim();
}

function delegationCandidateRevisionId(message = {}) {
  return String(message.metadata?.revisionId || message.metadata?.revision_id
    || message.metadata?.revisionNo || message.metadata?.revision_no
    || message.revisionId || message.revision_id || message.id || '').trim();
}

export function createDelegationRuntimeApi(context) {
  const {
    crypto,
    fs,
    path,
    all,
    run,
    deleteSessionManagedAttachments,
    runCodexDoctor,
    runCodexExec,
    runCodexSession,
    codexConfigFiles,
    codexConfigStatus,
    saveCodexConfig,
    saveCodexConfigFiles,
    artifactMessage,
    latestArtifact,
    buildAttachmentContext,
    buildMessageWithAttachments,
    describeFile,
    extractPptSourceVisuals,
    renderUploadedFile,
    uploadFile,
    uploadFileFromPath,
    dataDir,
    buildAgentChatPrompt,
    buildPlainChatPrompt,
    buildResumeTurnPrompt,
    fallbackPptAnswer,
    normalizePptAssistantAnswer,
    renderPptArtifact,
    shouldAttachPptArtifact,
    readCodexVisibleMessages,
    formatChatPlanSummary,
    planHomeChatRoute,
    suggestChatTitle,
    clipText,
    newId,
    sha256Text,
    localDelegationTransitionAllowed,
    localNextDelegationStatus,
    normalizeDelegationExecutionProgress,
    normalizeDelegationPublicFailure,
    privateAgentDelegationMetadata,
    publicAgentDelegationMetadata,
    publicDelegationSubmissionText,
    normalizePptProgress,
    appendDelegationDecisionPrompt,
    buildAgentDelegationPrompt,
    buildAgentDelegationRouteMessage,
    buildDelegationIntakeSummary,
    buildPrivateDelegationWorkspaceRouteMessage,
    buildPrivateIngressProcessingRequest,
    buildUBuddyDelegationProcessingPrompt,
    collectDelegationGeneratedFiles,
    delegationIntakeRevisionKey,
    deterministicPrivateIngressReply,
    displayAuthUserName,
    delegationWorkspaceEpoch,
    ensureDelegationWorkspaceSession,
    ensureDelegationEditableDraftFile,
    ensureDelegationTaskWorkspace,
    listDelegationWorkspaceDeliverables,
    fallbackUBuddyDelegationProcessing,
    hasExplicitDelegationFileRequest,
    isDelegationInformationOnlyRequest,
    latestDelegationPublishCandidate,
    mergeDelegationWorkspaceMessages,
    parseUBuddyDelegationProcessingAnswer,
    previewUBuddyDelegationProcessingAnswer,
    privateDelegationWorkspaceMessages,
    publicDelegationAttachment,
    safeCollaborationFilename,
    snapshotDelegationWorkspaceDeliverables,
    isSecretaryIdentityQuestion,
    isSecretaryContextCollectionMessage,
    isSecretaryPublishConfirmation,
    hasSecretaryAccountReference,
    ensureSecretaryConversationSeed,
    recordSecretaryDelegationFeedback,
    delegationRequiresHumanApproval,
    delegationExecutionFailureDetails,
    publicDelegationExecutionFailure,
    localCollaborationTaskAction,
    publicLocalTaskActionMetadata,
    collaborationTaskStatusReply,
    collaborationInstructionForFriend,
    syncCollaborationGroupWorkspace,
    syncDelegationWorkspaceMessages,
    uniqueDelegationAttachments,
    uploadCollaborationTaskAttachments,
    runtimeRoot,
    auth,
    store,
    socialRelay: baseSocialRelay,
    cloudSync,
    org,
    scheduler,
    agentExecution,
    evolution,
    modelCatalog,
    activeRuns,
    activeChatRuns,
    effectiveCurrentUser,
    triggerAutoSync,
    agentStatuses,
    classifyDelegationWorkspaceIntent,
    normalizeWorkspaceKey,
    ChatRunCancelled,
    statusRank,
    enrichPptChatContext,
    sessionPatchFromPayload,
    emitCodexChatEvent,
    emitChatEvent,
    withAsyncHeartbeat,
    internalWorkspaceExecutionToken,
    runtimeState,
    onTaskUpdated,
    createUBuddyDiagnosticEmitter,
    activateUnifiedUBuddyTask,
    uBuddyFeatureFlags,
    recoverPendingUBuddyDispatches = async () => null,
  } = context;
  const socialRelay = baseSocialRelay;
  const socialAutomationLedger = createSocialAutomationLedger({ store });
  const activeWorkspaceId = () => {
    const userId = auth.currentUser()?.id || '';
    return userId
      ? store.activeAccountWorkspace?.({ userId, deviceId: store.contextDeviceId?.() || 'local' })?.id || 'workspace_personal'
      : 'workspace_personal';
  };
  const drainDelegationIntakeQueue = () => {
    while (runtimeState.delegationIntakeActiveCount < 2 && runtimeState.delegationIntakeQueue.length) {
      const queued = runtimeState.delegationIntakeQueue.shift();
      runtimeState.delegationIntakeActiveCount += 1;
      Promise.resolve()
        .then(queued.operation)
        .then(queued.resolve, queued.reject)
        .finally(() => {
          runtimeState.delegationIntakeActiveCount = Math.max(0, runtimeState.delegationIntakeActiveCount - 1);
          drainDelegationIntakeQueue();
        });
    }
  };
  const scheduleDelegationIntake = (operation) => new Promise((resolve, reject) => {
    runtimeState.delegationIntakeQueue.push({ operation, resolve, reject });
    drainDelegationIntakeQueue();
  });
  const dependencyAccepted = (delegation = {}) => {
    const status = String(delegation.status || '');
    if (['result_accepted', 'closed'].includes(status)) return true;
    if (status !== 'completed') return false;
    return Boolean(delegation.metadata?.resultAcceptedAt || delegation.metadata?.acceptedAt
      || delegation.metadata?.humanDecision === 'accepted');
  };
  const dependencyHandoffState = (delegation = {}) => {
    if (dependencyAccepted(delegation)) return 'accepted';
    if (String(delegation.status || '') === 'revision_requested') return 'invalidated';
    if (['failed', 'rejected', 'declined', 'withdrawn', 'blocked'].includes(String(delegation.status || ''))) return 'failed';
    return '';
  };
  const dependencyResultFingerprint = (delegation = {}) => sha256Text(JSON.stringify({
    content: String(delegation.metadata?.latestResult || delegation.metadata?.result
      || delegation.result || delegation.summary || '').trim(),
    attachments: (Array.isArray(delegation.metadata?.resultAttachments)
      ? delegation.metadata.resultAttachments
      : Array.isArray(delegation.metadata?.attachments) ? delegation.metadata.attachments : [])
      .map((item) => ({
        id: String(item?.id || item?.fileId || item?.file_id || ''),
        name: String(item?.name || item?.filename || ''),
        size: Number(item?.size || 0),
        sha256: String(item?.sha256 || item?.hash || ''),
      })),
  }));
  const publishDependencyHandoffs = async (delegation = {}) => {
    const groupId = String(delegation.groupId || delegation.group_id || delegation.metadata?.groupId || '').trim();
    const sourceAssignmentId = String(delegation.metadata?.assignmentId || '').trim();
    const handoffState = dependencyHandoffState(delegation);
    if (!groupId || !sourceAssignmentId || !handoffState) return [];
    const detail = socialRelay.connected()
      ? await socialRelay.collaborationGroup(groupId, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }).catch(() => null)
      : (() => { try { return auth.collaborationGroup(groupId, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }); } catch { return null; } })();
    const plan = detail?.group?.metadata?.uBuddyCollaborationPlan || detail?.group?.metadata?.ubuddyCollaborationPlan || null;
    const downstream = (Array.isArray(plan?.assignments) ? plan.assignments : []).filter((assignment) => (
      Array.isArray(assignment?.dependencies) && assignment.dependencies.includes(sourceAssignmentId)
    ));
    if (!downstream.length) return [];
    const resultText = String(delegation.metadata?.latestResult || delegation.metadata?.result
      || delegation.result || delegation.summary || '').trim().slice(0, 8000);
    const attachments = (Array.isArray(delegation.metadata?.resultAttachments)
      ? delegation.metadata.resultAttachments
      : Array.isArray(delegation.metadata?.attachments) ? delegation.metadata.attachments : [])
      .map(publicDelegationAttachment).slice(0, 20);
    const sourceResultFingerprint = dependencyResultFingerprint(delegation);
    const published = [];
    for (const target of downstream) {
      const sourceEventId = `ubuddy-dependency-handoff:v2:${delegation.id}:${handoffState}:${sourceResultFingerprint.slice(0, 24)}:${target.assignmentId}`;
      const existing = (detail?.messages || []).some((message) => String(message.sourceEventId || message.source_event_id || message.metadata?.sourceEventId || '') === sourceEventId);
      if (existing) continue;
      const messagePayload = {
        content: handoffState === 'accepted'
          ? resultText || `${delegation.title || '上游任务'}的结果已验收通过，可供下游使用。`
          : handoffState === 'invalidated'
            ? `${delegation.title || '上游任务'}已被打回修改，之前验收通过的依赖结果现已失效。`
            : `${delegation.title || '上游任务'}未能完成，下游任务将保持冻结。`,
        senderAgentId: 'secretary_agent',
        kind: 'agent',
        sourceEventId,
        metadata: {
          type: 'ubuddy_dependency_handoff',
          version: 2,
          sourceEventId,
          sourceAssignmentId,
          targetAssignmentId: target.assignmentId,
          targetUserId: target.assigneeKind === 'user' ? target.userId : '',
          sourceDelegationId: delegation.id,
          sourceStatus: delegation.status,
          sourceResultFingerprint,
          handoffState,
          confirmedPublic: handoffState === 'accepted',
          attachments: handoffState === 'accepted' ? attachments : [],
        },
      };
      const sent = socialRelay.connected()
        ? await socialRelay.sendCollaborationMessage(groupId, {
            ...messagePayload,
            workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
          }).catch(() => null)
        : (() => {
            try {
              return auth.sendCollaborationMessage({
                groupId,
                workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
                ...messagePayload,
              });
            } catch { return null; }
          })();
      if (sent) published.push(sent);
    }
    return published;
  };
  const dependencyTaskResults = (dependencies = [], byAssignment = new Map()) => dependencies.map((assignmentId) => {
    const upstream = byAssignment.get(assignmentId) || {};
    return {
      assignmentId,
      title: String(upstream.title || ''),
      status: String(upstream.status || ''),
      fingerprint: dependencyResultFingerprint(upstream),
      content: String(upstream.metadata?.latestResult || upstream.metadata?.result || upstream.result || '').trim().slice(0, 8000),
      attachments: (upstream.metadata?.resultAttachments || upstream.metadata?.attachments || []).map(publicDelegationAttachment).slice(0, 20),
    };
  });
  const dependencyHandoffText = (results = []) => results.map((item) => (
    `上游 ${item.assignmentId}（${item.title || '任务'}）：\n${item.content || '结果已经验收通过，详见任务群附件。'}`
  )).join('\n\n');
  const freezeLocalDependencyTask = (task = {}, dependencyStates = []) => {
    const invalidationKey = sha256Text(JSON.stringify(dependencyStates));
    if (task.metadata?.externalDependencyInvalidationKey === invalidationKey) return store.getTaskRun(task.id) || task;
    store.updateTaskRunMetadata(task.id, {
      externalDependencyState: 'invalidated',
      externalDependencyInvalidatedAt: new Date().toISOString(),
      externalDependencyInvalidationKey: invalidationKey,
      externalDependencyStates: dependencyStates,
    });
    if (!['completed', 'failed', 'cancelled'].includes(String(task.status || ''))) {
      store.updateTaskRunStatus(task.id, 'cancelling', 'An accepted upstream dependency was invalidated; freezing unfinished downstream work.');
      for (const node of task.nodes || []) {
        if (['completed', 'failed', 'cancelled'].includes(String(node.status || ''))) continue;
        agentExecution?.cancel?.({ workKind: 'task_node', workId: node.id, reason: 'upstream_dependency_invalidated' });
        store.settleTaskProcessEvents?.({ taskRunId: task.id, taskNodeId: node.id, status: 'cancelled' });
        store.updateTaskNode(node.id, {
          status: 'cancelled',
          errorText: 'Cancelled because an accepted upstream dependency was invalidated.',
          waitReason: '',
          timeoutPolicy: '',
          completedAt: new Date().toISOString(),
        });
      }
      store.updateTaskRunStatus(task.id, 'cancelled', 'Upstream dependency changed; history is preserved and a successor will be created after re-acceptance.');
    }
    return store.getTaskRun(task.id) || task;
  };
  const createDependencySuccessorTask = (task = {}, results = []) => {
    const dependencyRevisionKey = sha256Text(JSON.stringify(results.map((item) => ({
      assignmentId: item.assignmentId, fingerprint: item.fingerprint,
    }))));
    const existingSuccessorId = String(task.metadata?.externalDependencySuccessorTaskRunId || '');
    const existingSuccessor = existingSuccessorId ? store.getTaskRun(existingSuccessorId) : null;
    if (existingSuccessor?.metadata?.externalDependencyRevisionKey === dependencyRevisionKey) return existingSuccessor;
    const successorTaskRunId = `task_dependency_successor_${sha256Text(`${task.id}:${dependencyRevisionKey}`).slice(0, 32)}`;
    const materialized = store.getTaskRun(successorTaskRunId);
    if (materialized) return materialized;
    const handoffText = dependencyHandoffText(results);
    const sourceProposal = task.metadata?.taskGraphProposal || {};
    const proposalNodes = (sourceProposal.nodes || task.metadata?.dispatchPlan?.nodes || []).map((node) => ({
      ...node,
      objective: `${node.objective || task.prompt || ''}\n\n以下是最新版且已经验收通过的上游结果；仅基于这些结果继续：\n${handoffText}`.slice(0, 30_000),
    }));
    const successor = scheduler.createTaskRun({
      title: task.title,
      prompt: `${task.prompt || task.title}\n\n上游依赖已更新并重新验收通过。请基于新版结果续接执行：\n${handoffText}`.slice(0, 30_000),
      departmentId: task.departmentId || task.department_id || '',
      userId: task.ownerUserId || task.userId || auth.currentUser()?.id || '',
      metadata: {
        ...(task.metadata || {}),
        materializeTaskRunId: successorTaskRunId,
        parentTaskRunId: task.id,
        continuationReason: 'upstream_dependency_reaccepted',
        externalDependencyState: 'ready',
        externalDependencyReadyAt: new Date().toISOString(),
        externalDependencyRevisionKey: dependencyRevisionKey,
        externalDependencyResults: results,
        externalDependencyInvalidationKey: '',
        externalDependencySuccessorTaskRunId: '',
        taskGraphProposal: { ...sourceProposal, status: 'ready', nodes: proposalNodes },
      },
    });
    store.updateTaskRunMetadata(task.id, {
      externalDependencySuccessorTaskRunId: successor.id,
      continuedByTaskRunId: successor.id,
    });
    return successor;
  };
  const activateReadyLocalPeerTasks = (group = {}, groupTasks = []) => {
    const byAssignment = new Map((Array.isArray(groupTasks) ? groupTasks : []).map((task) => [
      String(task?.metadata?.assignmentId || ''), task,
    ]).filter(([assignmentId]) => assignmentId));
    const localTasks = store.listTaskRuns({ userId: auth.currentUser()?.id || '', limit: 300 }).filter((task) => (
      String(task.metadata?.collaborationGroupId || '') === String(group.id || '')
      && ['waiting', 'ready', 'invalidated'].includes(String(task.metadata?.externalDependencyState || ''))
      && Array.isArray(task.metadata?.externalAssignmentDependencies)
    ));
    for (const task of localTasks) {
      const dependencies = task.metadata.externalAssignmentDependencies;
      if (!dependencies.length) continue;
      const dependencyStates = dependencies.map((assignmentId) => ({
        assignmentId,
        status: String(byAssignment.get(assignmentId)?.status || 'missing'),
        accepted: dependencyAccepted(byAssignment.get(assignmentId) || {}),
      }));
      if (dependencyStates.some((item) => !item.accepted)) {
        if (task.metadata?.externalDependencyState === 'ready') freezeLocalDependencyTask(task, dependencyStates);
        continue;
      }
      const results = dependencyTaskResults(dependencies, byAssignment);
      const dependencyRevisionKey = sha256Text(JSON.stringify(results.map((item) => ({ assignmentId: item.assignmentId, fingerprint: item.fingerprint }))));
      if (task.metadata?.externalDependencyState === 'invalidated') {
        const successor = createDependencySuccessorTask(task, results);
        activateUnifiedUBuddyTask?.(successor.id);
        continue;
      }
      if (task.metadata?.externalDependencyState === 'ready'
        && task.metadata?.externalDependencyRevisionKey === dependencyRevisionKey) continue;
      const handoffText = dependencyHandoffText(results);
      for (const node of task.nodes || []) {
        store.updateTaskNode(node.id, {
          objective: `${node.objective || task.prompt || ''}\n\n以下是已经验收通过并确认可供本任务使用的上游结果；仅基于这些结果继续，不得补造未公开信息：\n${handoffText}`.slice(0, 30_000),
        });
      }
      store.updateTaskRunMetadata(task.id, {
        externalDependencyState: 'ready',
        externalDependencyReadyAt: new Date().toISOString(),
        externalDependencyRevisionKey: dependencyRevisionKey,
        externalDependencyResults: results,
      });
      store.updateTaskRunStatus(task.id, 'ready', 'Confirmed public dependency results are ready.');
      activateUnifiedUBuddyTask?.(task.id);
    }
  };
  const agentWorkProjectionEnabled = () => {
    const user = auth.currentUser();
    return Boolean(uBuddyFeatureFlags?.snapshot?.({ userId: user?.id || '', workspaceId: activeWorkspaceId() })?.agentWorkDetailProjection);
  };
  const claimDelegationExecution = async (delegation = {}) => {
    if (!socialRelay.connected()) return { acquired: true, supported: false, lease: null };
    const supported = await socialRelay.delegationExecutionLeaseSupported?.().catch(() => false);
    if (!supported) return { acquired: true, supported: false, lease: null };
    try {
      const result = await socialRelay.claimDelegationExecution(delegation.id, {
        deviceId: store.contextDeviceId?.() || socialRelay.status?.().deviceId || 'local',
        leaseSeconds: 90,
      });
      const lease = result?.lease || null;
      if (lease) runtimeState.delegationExecutionLeases.set(delegation.id, lease);
      return { acquired: Boolean(lease), supported: true, lease };
    } catch (error) {
      if (Number(error?.status || 0) === 409 || error?.code === 'delegation_execution_claimed') {
        return { acquired: false, supported: true, lease: null, reason: 'claimed_elsewhere', error };
      }
      throw error;
    }
  };
  const armDelegationExecutionLease = (delegationId = '', { onLeaseLost = null } = {}) => {
    const lease = runtimeState.delegationExecutionLeases.get(delegationId);
    if (!lease?.leaseToken || runtimeState.delegationExecutionLeaseTimers.has(delegationId)) return;
    const clearRetryTimer = () => {
      const retryTimer = runtimeState.delegationExecutionLeaseRetryTimers.get(delegationId);
      if (retryTimer) clearTimeout(retryTimer);
      runtimeState.delegationExecutionLeaseRetryTimers.delete(delegationId);
    };
    const loseLease = (error, leaseToken) => {
      const current = runtimeState.delegationExecutionLeases.get(delegationId);
      if (!current?.leaseToken || current.leaseToken !== leaseToken) return;
      const activeTimer = runtimeState.delegationExecutionLeaseTimers.get(delegationId);
      if (activeTimer) clearInterval(activeTimer);
      runtimeState.delegationExecutionLeaseTimers.delete(delegationId);
      clearRetryTimer();
      runtimeState.delegationExecutionLeaseRenewals.delete(delegationId);
      runtimeState.delegationExecutionLeases.delete(delegationId);
      try { onLeaseLost?.(error); } catch {}
    };
    const renewLease = () => {
      const current = runtimeState.delegationExecutionLeases.get(delegationId);
      if (!current?.leaseToken || runtimeState.closed) return;
      if (runtimeState.delegationExecutionLeaseRenewals.get(delegationId) === current.leaseToken) return;
      runtimeState.delegationExecutionLeaseRenewals.set(delegationId, current.leaseToken);
      socialRelay.renewDelegationExecutionLease(delegationId, {
        deviceId: current.deviceId || store.contextDeviceId?.() || 'local',
        leaseToken: current.leaseToken,
        leaseSeconds: 90,
      }).then((result) => {
        const active = runtimeState.delegationExecutionLeases.get(delegationId);
        if (result?.lease && active?.leaseToken === current.leaseToken) {
          clearRetryTimer();
          runtimeState.delegationExecutionLeases.set(delegationId, result.lease);
        }
      }).catch((error) => {
        const active = runtimeState.delegationExecutionLeases.get(delegationId);
        if (active?.leaseToken !== current.leaseToken) return;
        if (delegationExecutionLeaseRenewalDefinitelyLost(error)) {
          loseLease(error, current.leaseToken);
          return;
        }
        const retryDelayMs = delegationExecutionLeaseRetryDelayMs(active);
        if (retryDelayMs <= 0) {
          const expired = new Error('Delegation execution lease expired before a transient renewal failure recovered.');
          expired.code = 'delegation_execution_lease_expired';
          loseLease(expired, current.leaseToken);
          return;
        }
        if (!runtimeState.delegationExecutionLeaseRetryTimers.has(delegationId)) {
          const retryTimer = setTimeout(() => {
            runtimeState.delegationExecutionLeaseRetryTimers.delete(delegationId);
            renewLease();
          }, retryDelayMs);
          retryTimer.unref?.();
          runtimeState.delegationExecutionLeaseRetryTimers.set(delegationId, retryTimer);
        }
      }).finally(() => {
        if (runtimeState.delegationExecutionLeaseRenewals.get(delegationId) === current.leaseToken) {
          runtimeState.delegationExecutionLeaseRenewals.delete(delegationId);
        }
      });
    };
    const timer = setInterval(renewLease, 30_000);
    timer.unref?.();
    runtimeState.delegationExecutionLeaseTimers.set(delegationId, timer);
  };
  const releaseDelegationExecution = async (delegationId = '', reason = 'completed') => {
    const timer = runtimeState.delegationExecutionLeaseTimers.get(delegationId);
    if (timer) clearInterval(timer);
    runtimeState.delegationExecutionLeaseTimers.delete(delegationId);
    const retryTimer = runtimeState.delegationExecutionLeaseRetryTimers.get(delegationId);
    if (retryTimer) clearTimeout(retryTimer);
    runtimeState.delegationExecutionLeaseRetryTimers.delete(delegationId);
    runtimeState.delegationExecutionLeaseRenewals.delete(delegationId);
    const lease = runtimeState.delegationExecutionLeases.get(delegationId);
    runtimeState.delegationExecutionLeases.delete(delegationId);
    if (!lease?.leaseToken || !socialRelay.connected()) return { released: false };
    return socialRelay.releaseDelegationExecutionLease(delegationId, {
      deviceId: lease.deviceId || store.contextDeviceId?.() || 'local',
      leaseToken: lease.leaseToken,
      reason,
    }).catch(() => ({ released: false }));
  };
  const emitUBuddyDiagnostic = createUBuddyDiagnosticEmitter({ source: 'ubuddy-delegation' });
  const internalAutoStart = Symbol('internalAutoStart');
  const workspaceMessageMetadata = (delegation = {}, workspaceEpoch = '', extra = {}) => ({
    ...extra,
    delegationId: delegation.id || '',
    privateTaskWorkspace: true,
    workspaceEpoch: workspaceEpoch || delegationWorkspaceEpoch(delegation),
  });
  const delegationGroupId = (delegation = {}) => String(delegation.groupId || delegation.group_id || delegation.metadata?.groupId || '').trim();
  const taskSummaryStage = (task = {}, messages = []) => {
    const status = String(task.status || '').trim();
    const taskMessages = messages.filter((message) => message.metadata?.type === 'ubuddy_task_summary'
      && String(message.metadata?.taskId || '') === String(task.id || ''));
    const previousStage = String(taskMessages.at(-1)?.metadata?.stage || '');
    if (['result_accepted', 'completed', 'closed'].includes(status)) return 'completed';
    if (['submitted', 'draft_ready'].includes(status)) return 'submitted';
    if (status === 'revision_requested') return 'revision_requested';
    if (['blocked', 'failed'].includes(status) || task.metadata?.executionProgress?.blocker) return 'blocked';
    if (['working', 'running', 'accepted'].includes(status)) {
      if (['blocked', 'revision_requested'].includes(previousStage)) return 'recovered';
      if (['started', 'recovered'].includes(previousStage)) return previousStage;
      return 'started';
    }
    if (['assigned', 'pending'].includes(status)) return 'planned';
    return '';
  };
  const taskSummaryPayload = (task = {}, stage = '', version = 1) => {
    const progress = normalizeDelegationExecutionProgress(task.metadata?.executionProgress || {}) || {};
    const completedNodes = (progress.nodes || []).filter((node) => node.status === 'completed').slice(-3);
    const blocker = progress.blocker || null;
    const copy = {
      planned: { conclusion: '任务范围已经明确，正在等待接收方开始处理。', nextStep: '接收方 uBuddy 将确认任务并启动执行。' },
      started: { conclusion: '任务已经进入执行阶段，协作分工正在推进。', nextStep: '完成当前关键工作后同步阶段结果。' },
      recovered: { conclusion: '影响任务推进的问题已经解除，工作现已恢复。', nextStep: '继续执行剩余工作并同步新的关键结果。' },
      blocked: { conclusion: '任务当前无法按原计划继续，需要先解除阻塞。', nextStep: blocker?.suggestedNextStep || '相关成员对齐依赖后继续执行。' },
      submitted: { conclusion: '任务结果已经整理完成，正在等待相关成员审核。', nextStep: '审核交付内容并确认通过或提出修改意见。' },
      revision_requested: { conclusion: '任务结果需要修改，uBuddy 正在根据反馈重新整理。', nextStep: '完成修改后重新提交审核。' },
      completed: { conclusion: '任务已经完成并通过当前协作流程。', nextStep: '如无新增要求，可在任务工作区查看最终结果。' },
    }[stage] || { conclusion: '任务状态已经更新。', nextStep: '继续关注后续协作进展。' };
    const highlights = completedNodes.map((node) => node.summary || `${node.title}已完成`).filter(Boolean);
    if (!highlights.length && progress.message && stage !== 'blocked') highlights.push(progress.message);
    const risk = blocker?.summary || (stage === 'revision_requested' ? '当前交付尚未通过审核，需要按反馈修改。' : '');
    const occurredAt = progress.updatedAt || task.updatedAt || task.updated_at || new Date().toISOString();
    const sourceCursor = String(progress.sequence || occurredAt);
    const title = String(task.title || '协作任务');
    const content = [
      `${title}：${copy.conclusion}`,
      highlights.length ? `关键成果：${highlights.join('；')}` : '',
      risk ? `风险或待处理：${risk}` : '',
      `下一步：${copy.nextStep}`,
    ].filter(Boolean).join('\n');
    return {
      content,
      metadata: {
        type: 'ubuddy_task_summary', taskId: task.id || '', stage, summaryVersion: version,
        responsibleUBuddyOwnerUserId: task.recipientUserId || task.recipient_user_id || '',
        sourceCursor, phase: progress.phase || statusForSummaryStage(stage), conclusion: copy.conclusion,
        highlights, risk, nextStep: copy.nextStep,
        requiresUserAction: Boolean(blocker?.requiresUserAction || ['submitted', 'revision_requested'].includes(stage)),
        occurredAt, publicStatusOnly: true,
      },
    };
  };
  const statusForSummaryStage = (stage = '') => ({
    planned: 'planning', started: 'executing', recovered: 'executing', blocked: 'blocked',
    submitted: 'reviewing', revision_requested: 'revising', completed: 'completed',
  })[stage] || 'updated';
  const taskCoordinationRequest = (task = {}) => {
    const progress = normalizeDelegationExecutionProgress(task.metadata?.executionProgress || {}) || {};
    const blocker = progress.blocker;
    if (blocker && !blocker.requiresUserAction) {
      return {
        reason: 'blocked_dependency',
        summary: blocker.summary || '存在尚未解除的工作依赖',
        sourceCursor: String(progress.sequence || progress.updatedAt || task.updatedAt || 'blocked'),
      };
    }
    const latest = [...(progress.milestones || [])].reverse().find((milestone) => [
      'dependency_waiting', 'dependency_changed', 'interface_changed', 'handoff_required', 'coordination_required',
    ].includes(String(milestone.eventType || '')));
    if (!latest) return null;
    return {
      reason: String(latest.eventType || 'work_alignment'),
      summary: latest.detail || latest.title || '需要同步工作依赖和下一步',
      sourceCursor: String(latest.sequence || latest.occurredAt || progress.sequence || progress.updatedAt || 'alignment'),
    };
  };
  const notifyDelegationUpdated = (delegation = null, change = {}, projection = {}) => {
    if (!delegation?.id) return;
    try { onTaskUpdated?.({ delegation, ...projection, change }); } catch {}
  };
  const syncSharedTaskWorkspace = async (delegation, user, mode = 'pull') => {
    const groupId = delegationGroupId(delegation);
    if (!groupId) return null;
    return syncCollaborationGroupWorkspace({
      runtimeRoot,
      auth,
      socialRelay,
      userId: user.id,
      groupId,
      workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
      mode,
    });
  };
  const updateDelegationSyncState = (delegationId, patch = {}) => {
    const current = auth.agentDelegationByEntityId(String(delegationId || ''));
    if (!current) return null;
    auth.upsertDelegationWorkspace({
      delegationId,
      workspaceId: current.workspaceId || current.accountWorkspaceId,
      metadata: patch,
    });
    const updated = auth.agentDelegationByEntityId(String(delegationId || ''));
    notifyDelegationUpdated(updated, { type: 'delegation_sync_state', syncState: updated?.metadata?.syncState || '' });
    return updated;
  };
  const sharedWorkspaceSyncMustBlock = (error = null) => {
    return /(?:校验失败|路径无效|路径越界|符号链接|参数不完整|超过\s*60\s*MB)/i.test(String(error?.message || error || ''));
  };
  const syncSharedTaskWorkspaceResilient = async (delegation, user, mode = 'pull', { blockUnsafe = true } = {}) => {
    if (!delegationGroupId(delegation)) return null;
    try {
      const result = await syncSharedTaskWorkspace(delegation, user, mode);
      if (result?.offline || result?.syncStatus === 'offline') {
        updateDelegationSyncState(delegation.id, {
          syncState: 'pending',
          syncError: '共享工作区当前离线，将在网络恢复后自动重试。',
          pendingSharedWorkspaceSync: mode,
          sharedWorkspaceSyncError: 'Shared task workspace is offline.',
        });
        return result;
      }
      const current = auth.agentDelegationByEntityId(delegation.id) || delegation;
      const hasOtherPendingSync = Boolean(current.metadata?.pendingRemoteUpdate || current.metadata?.pendingWorkspaceSync);
      updateDelegationSyncState(delegation.id, {
        pendingSharedWorkspaceSync: '',
        sharedWorkspaceSyncError: '',
        ...(hasOtherPendingSync ? {} : { syncState: 'synced', syncError: '' }),
      });
      return result;
    } catch (error) {
      updateDelegationSyncState(delegation.id, {
        syncState: 'pending',
        syncError: String(error?.message || error).slice(0, 1000),
        pendingSharedWorkspaceSync: mode,
        sharedWorkspaceSyncError: String(error?.message || error).slice(0, 2000),
      });
      if (blockUnsafe && sharedWorkspaceSyncMustBlock(error)) throw error;
      return {
        workspaceRoot: ensureDelegationTaskWorkspace(runtimeRoot, user.id, delegation),
        syncStatus: 'pending',
        localFallback: true,
        error,
      };
    }
  };
  const syncDelegationRemoteUpdate = async (delegationId, payload = {}) => {
    if (!socialRelay.connected()) return { ok: true, localOnly: true };
    try {
      const entity = auth.agentDelegationByEntityId(delegationId);
      const pendingStatus = String(payload.status || '').trim();
      const currentStatus = String(entity?.status || '').trim();
      if (pendingStatus && currentStatus && pendingStatus !== currentStatus
        && !legacyDelegationTransitionAllowed(currentStatus, pendingStatus)) {
        const current = auth.agentDelegationByEntityId(delegationId);
        const hasOtherPendingSync = Boolean(current?.metadata?.pendingWorkspaceSync || current?.metadata?.pendingSharedWorkspaceSync);
        updateDelegationSyncState(delegationId, {
          pendingRemoteUpdate: null,
          ...(hasOtherPendingSync ? {} : { syncState: 'synced', syncError: '' }),
        });
        return { ok: true, skipped: true, reason: 'stale_status_update', currentStatus, pendingStatus };
      }
      const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? { ...payload.metadata }
        : null;
      if (metadata?.agentWorkStatusProjection) {
        const supported = await socialRelay.agentWorkDetailProjectionSupported?.().catch(() => false);
        if (!supported) delete metadata.agentWorkStatusProjection;
      }
      const scopedPayload = {
        ...payload,
        ...(metadata ? { metadata } : {}),
        workspaceId: payload.workspaceId || entity?.workspaceId || entity?.accountWorkspaceId || 'workspace_personal',
      };
      const result = await socialRelay.updateDelegation(delegationId, scopedPayload);
      const current = auth.agentDelegationByEntityId(delegationId);
      const hasOtherPendingSync = Boolean(current?.metadata?.pendingWorkspaceSync || current?.metadata?.pendingSharedWorkspaceSync);
      updateDelegationSyncState(delegationId, {
        pendingRemoteUpdate: null,
        ...(hasOtherPendingSync ? {} : { syncState: 'synced', syncError: '' }),
      });
      return { ok: true, result };
    } catch (error) {
      updateDelegationSyncState(delegationId, {
        syncState: 'pending',
        syncError: String(error?.message || error).slice(0, 1000),
        pendingRemoteUpdate: {
          ...payload,
          workspaceId: payload.workspaceId || auth.agentDelegationByEntityId(delegationId)?.workspaceId || 'workspace_personal',
        },
      });
      return { ok: false, error };
    }
  };
  const syncDelegationWorkspaceUpdate = async (delegation = {}) => {
    const current = delegation?.id ? auth.agentDelegationByEntityId(delegation.id) || delegation : delegation;
    if (!socialRelay.connected() || !current?.id || !current.sessionId) return { ok: true, localOnly: true };
    try {
      await syncDelegationWorkspaceMessages(
        socialRelay,
        current.id,
        current.sessionId,
        privateDelegationWorkspaceMessages(store, current),
        delegationWorkspaceEpoch(current),
        current.workspaceId || current.accountWorkspaceId,
      );
      const latest = auth.agentDelegationByEntityId(current.id) || current;
      const hasOtherPendingSync = Boolean(latest.metadata?.pendingRemoteUpdate || latest.metadata?.pendingSharedWorkspaceSync);
      updateDelegationSyncState(current.id, {
        pendingWorkspaceSync: false,
        ...(hasOtherPendingSync ? {} : { syncState: 'synced', syncError: '' }),
      });
      return { ok: true };
    } catch (error) {
      updateDelegationSyncState(current.id, {
        pendingWorkspaceSync: true,
        syncState: 'pending',
        syncError: String(error?.message || error).slice(0, 1000),
      });
      return { ok: false, error };
    }
  };
  const drainPendingDelegationRemoteUpdates = async () => {
    if (!socialRelay.connected()) return;
    const currentUser = auth.currentUser();
    for (const delegation of auth.agentDelegationsAllWorkspaces({ direction: 'all', limit: 500 })) {
      const pending = delegation.metadata?.pendingRemoteUpdate;
      if (delegation.metadata?.syncState === 'pending' && pending && typeof pending === 'object') {
        await syncDelegationRemoteUpdate(delegation.id, pending);
      }
      const current = auth.agentDelegationByEntityId(delegation.id) || delegation;
      if (current.metadata?.pendingWorkspaceSync) await syncDelegationWorkspaceUpdate(current);
      const latest = auth.agentDelegationByEntityId(delegation.id) || current;
      if (currentUser?.id && latest.metadata?.pendingSharedWorkspaceSync) {
        await syncSharedTaskWorkspaceResilient(
          latest,
          currentUser,
          latest.metadata.pendingSharedWorkspaceSync === 'push' ? 'push' : 'pull',
          { blockUnsafe: false },
        );
      }
    }
  };
  const delegationProgressRemoteChains = new Map();
  const publicTaskNodeStatusSummary = (node = {}) => ({
    pending: '正在等待上游依赖。',
    ready: '依赖已满足，等待执行。',
    queued: '已进入 Agent 执行队列。',
    running: '正在执行当前节点。',
    retry_wait: '正在等待自动重试。',
    waiting: '正在等待所需信息。',
    blocked: '当前节点被依赖问题阻塞。',
    completed: '节点已完成。',
    failed: '节点执行失败。',
    cancelled: '节点已取消。',
  })[String(node.status || '')] || '节点状态已更新。';
  const publicTaskNode = (node = {}, task = {}) => {
    const outputDisposition = String(task.metadata?.nodeOutputDeclarations?.[node.id]?.contentType || '').trim();
    return {
      id: node.id || '',
      title: node.title || '任务节点',
      agentName: org.agent(node.agentId)?.name || node.agentId || 'Agent',
      status: node.status || 'pending',
      outputDisposition,
      summary: outputDisposition === 'diagnostic'
        ? '执行结束，但未产生可交付物。'
        : publicTaskNodeStatusSummary(node),
      attemptCount: Number(node.attemptCount || 0),
      maxAttempts: Number(node.maxAttempts || 3),
      nextRetryAt: node.nextRetryAt || '',
      startedAt: node.startedAt || '',
      completedAt: node.completedAt || '',
      updatedAt: node.updatedAt || node.completedAt || node.startedAt || '',
    };
  };
  const publicTaskBlocker = (task = {}) => {
    const node = (task.nodes || []).find((item) => ['waiting', 'retry_wait', 'blocked', 'failed'].includes(item.status));
    if (!node) return null;
    return {
      nodeId: node.id || '',
      summary: task.metadata?.failureReport?.summary || publicTaskNodeStatusSummary(node),
      attemptCount: Number(node.attemptCount || 0),
      maxAttempts: Number(node.maxAttempts || 3),
      nextRetryAt: node.nextRetryAt || '',
      retryable: node.status !== 'failed' || Boolean(node.fallback),
      suggestedNextStep: node.status === 'retry_wait'
        ? '系统将在稍后自动重试。'
        : node.status === 'failed'
          ? '接收方可以重试节点、调整方案或重新执行。'
          : '等待所需信息或解除依赖后继续。',
    };
  };
  const publicTaskProgressPatch = (task = null, event = {}) => {
    if (!task?.id) return {};
    const changed = event.changedNodes?.[0] || event.activeNodes?.[0] || event.change?.node || null;
    return {
      nodes: (task.nodes || []).map((node) => publicTaskNode(node, task)),
      blocker: publicTaskBlocker(task),
      ...(changed ? {
        milestone: {
          key: `${changed.id || changed.title}:${changed.status || 'updated'}`,
          status: changed.status || 'running',
          title: changed.title || '任务节点',
          detail: publicTaskNodeStatusSummary(changed),
          agentName: org.agent(changed.agentId)?.name || changed.agentName || changed.agentId || '',
          eventType: event.change?.type || event.kind || `node_${changed.status || 'updated'}`,
          occurredAt: changed.updatedAt || changed.completedAt || changed.startedAt || new Date().toISOString(),
        },
      } : {}),
    };
  };
  const queueDelegationRemoteUpdate = (delegationId, payload = {}) => {
    if (!socialRelay.connected()) return Promise.resolve(null);
    const previousChain = delegationProgressRemoteChains.get(delegationId) || Promise.resolve();
    const remote = previousChain
      .catch(() => null)
      .then(() => syncDelegationRemoteUpdate(delegationId, payload));
    delegationProgressRemoteChains.set(delegationId, remote);
    return remote;
  };
  const publishDelegationProgress = (delegationId, patch = {}, { syncRemote = true } = {}) => {
    const current = auth.agentDelegationByEntityId(String(delegationId || ''));
    if (!current) return { delegation: null, progress: null, remote: Promise.resolve(null) };
    const previous = normalizeDelegationExecutionProgress(current.metadata?.executionProgress) || {};
    const milestone = patch.milestone && typeof patch.milestone === 'object' ? patch.milestone : null;
    const nextSequence = Math.max(Number(previous.sequence || 0) + 1, Number(patch.sequence || 0));
    const normalizedMilestone = milestone ? {
      ...milestone,
      sequence: Number(milestone.sequence || nextSequence),
      occurredAt: milestone.occurredAt || patch.updatedAt || new Date().toISOString(),
    } : null;
    const milestones = [...(previous.milestones || [])];
    if (normalizedMilestone) {
      const existingIndex = milestones.findIndex((item) => item.key && item.key === normalizedMilestone.key);
      if (existingIndex >= 0) milestones[existingIndex] = { ...milestones[existingIndex], ...normalizedMilestone };
      else milestones.push(normalizedMilestone);
    }
    const { milestone: _milestone, ...publicPatch } = patch;
    const mergedProgress = {
      ...previous,
      ...publicPatch,
      milestones: milestone ? milestones : publicPatch.milestones ?? previous.milestones,
      sequence: nextSequence,
      updatedAt: patch.updatedAt || new Date().toISOString(),
    };
    const lifecycleChanged = ['phase', 'taskStatus', 'reviewState', 'finalDeliveryState', 'confirmationRequired']
      .some((key) => Object.prototype.hasOwnProperty.call(publicPatch, key));
    if (lifecycleChanged) {
      if (!Object.prototype.hasOwnProperty.call(publicPatch, 'executionPercent')) delete mergedProgress.executionPercent;
      if (!Object.prototype.hasOwnProperty.call(publicPatch, 'percent')) delete mergedProgress.percent;
      if (!Object.prototype.hasOwnProperty.call(publicPatch, 'lifecyclePhase')) delete mergedProgress.lifecyclePhase;
      if (!Object.prototype.hasOwnProperty.call(publicPatch, 'label')) delete mergedProgress.label;
    }
    const progress = normalizeDelegationExecutionProgress(mergedProgress);
    const hasPublicFailure = Object.prototype.hasOwnProperty.call(patch, 'publicFailure');
    const publicFailure = hasPublicFailure
      ? normalizeDelegationPublicFailure(patch.publicFailure)
      : normalizeDelegationPublicFailure(current.metadata?.publicFailure);
    const hasAgentWorkProjection = Object.prototype.hasOwnProperty.call(patch, 'agentWorkStatusProjection');
    const agentWorkStatusProjection = hasAgentWorkProjection && patch.agentWorkStatusProjection
      ? {
          ...patch.agentWorkStatusProjection,
          scopeKind: 'delegation',
          scopeId: delegationId,
          actors: (patch.agentWorkStatusProjection.actors || []).map((actor) => ({ ...actor, delegationId })),
        }
      : null;
    const metadata = {
      ...(current.metadata || {}),
      executionProgress: progress,
      ...(hasPublicFailure ? { publicFailure } : {}),
      ...(hasAgentWorkProjection ? { agentWorkStatusProjection } : {}),
    };
    const delegation = auth.updateAgentDelegation({
      delegationId,
      workspaceId: current.workspaceId || current.accountWorkspaceId,
      metadata,
    });
    notifyDelegationUpdated(delegation, {
      type: 'delegation_progress',
      progress,
      progressEventKey: normalizedMilestone?.key || '',
    });
    emitUBuddyDiagnostic('delegation_progress', {
      data: {
        delegationId,
        status: delegation.status || '',
        phase: progress?.phase || '',
        sequence: progress?.sequence || 0,
        completed: progress?.completed || 0,
        total: progress?.total || 0,
        running: progress?.running || 0,
        waiting: progress?.waiting || 0,
        failed: progress?.failed || 0,
        terminal: Boolean(progress?.terminal),
      },
    });
    let remote = Promise.resolve(null);
    if (syncRemote && socialRelay.connected()) {
      remote = queueDelegationRemoteUpdate(delegationId, {
        workspaceId: current.workspaceId || current.accountWorkspaceId,
        metadata: publicAgentDelegationMetadata({
          executionProgress: progress,
          ...(hasPublicFailure ? { publicFailure } : {}),
          ...(hasAgentWorkProjection ? { agentWorkStatusProjection } : {}),
        }),
      });
    }
    return { delegation, progress, remote };
  };
  const publishDelegationProgressSafely = (delegationId, patch = {}, options = {}) => {
    try {
      const result = publishDelegationProgress(delegationId, patch, options);
      result?.remote?.catch?.((error) => {
        emitUBuddyDiagnostic('delegation_progress_publish_failed', {
          level: 'warn',
          data: { delegationId, phase: String(patch.phase || ''), stage: 'remote_sync' },
          error,
        });
      });
      return result;
    } catch (error) {
      emitUBuddyDiagnostic('delegation_progress_publish_failed', {
        level: 'warn',
        data: { delegationId, phase: String(patch.phase || ''), stage: 'local_projection' },
        error,
      });
      return { delegation: auth.agentDelegationByEntityId(String(delegationId || '')), progress: null, remote: Promise.resolve(null) };
    }
  };
  const flushDelegationProgress = async (delegationId) => {
    const pending = delegationProgressRemoteChains.get(String(delegationId || ''));
    if (pending) await pending.catch(() => null);
  };
  const progressPatchFromEvent = (event = {}) => {
    const stage = String(event.stage || event.phase || '').trim().toLowerCase();
    const phase = ({
      confirming: 'preparing', preparing: 'preparing', planning: 'planning',
      working: 'executing', executing: 'executing', verifying: 'verifying',
      delivering: 'verifying', done: 'awaiting_delivery',
    })[stage] || (event.kind === 'done' ? 'awaiting_delivery' : 'executing');
    const progress = event.taskProgress || event.progress || event.taskProgressSnapshot?.progress || {};
    const current = event.changedNodes?.[0] || event.activeNodes?.[0] || null;
    const eventTaskRunId = String(event.taskRunId || event.task?.id || event.taskProgressSnapshot?.taskRunId || '').trim();
    const task = eventTaskRunId ? store.getTaskRun(eventTaskRunId) : null;
    const publicMessage = task
      ? current
        ? `${current.title || '任务节点'}：${publicTaskNodeStatusSummary(current)}`
        : phase === 'verifying'
          ? 'uBuddy 正在校验交付物'
          : phase === 'awaiting_delivery'
            ? '任务已完成执行，等待确认交付'
            : 'uBuddy 正在推进任务节点'
      : event.message || (phase === 'planning' ? 'uBuddy 正在规划任务执行步骤' : 'uBuddy 正在处理任务');
    return {
      phase,
      message: publicMessage,
      completed: progress.completed,
      total: progress.total,
      running: progress.running,
      waiting: progress.waiting,
      failed: progress.failed,
      currentStep: current ? {
        title: current.title || '',
        status: current.status || (phase === 'executing' ? 'running' : phase),
        agentName: current.agentName || '',
      } : null,
      terminal: false,
      ...publicTaskProgressPatch(task, event),
      ...(task && agentWorkProjectionEnabled() ? {
        agentWorkStatusProjection: publicTaskAgentWorkStatus(task, {
          agentName: (agentId) => org.agent(agentId)?.name || agentId || 'Agent',
        }),
      } : {}),
    };
  };
  const markDelegationFailure = async ({
    delegationId = '', error = null, stage = '', sessionId = '', workspaceRoot = '', workspaceEpoch = '', progressPatch = {},
  } = {}) => {
    const current = auth.agentDelegationById(String(delegationId || ''));
    if (!current) return null;
    const alreadyPersistedFailure = error?.delegation;
    if (alreadyPersistedFailure?.id === current.id
      && ['blocked', 'failed'].includes(String(alreadyPersistedFailure.status || ''))
      && alreadyPersistedFailure.metadata?.publicFailure) return current;
    const failure = delegationExecutionFailureDetails(error);
    const failureStage = String(stage || failure.stage || 'execution').trim();
    const status = failure.retryable ? 'blocked' : 'failed';
    const publicFailure = normalizeDelegationPublicFailure({
      code: failure.code,
      stage: failureStage,
      message: failure.publicMessage,
      retryable: failure.retryable,
      occurredAt: new Date().toISOString(),
    });
    const progress = normalizeDelegationExecutionProgress({
      ...(current.metadata?.executionProgress || {}),
      ...progressPatch,
      sequence: Number(current.metadata?.executionProgress?.sequence || 0) + 1,
      phase: status,
      taskStatus: status,
      failureStage,
      lifecyclePhase: progressPatch.lifecyclePhase || (/verif|validation/i.test(failureStage)
        ? 'verifying' : /deliver/i.test(failureStage) ? 'delivering' : 'executing'),
      percent: undefined,
      label: '',
      message: publicFailure?.message || failure.publicMessage,
      failed: Math.max(1, Number(current.metadata?.executionProgress?.failed || 0)),
      terminal: true,
      updatedAt: new Date().toISOString(),
    });
    const metadata = {
      ...(current.metadata || {}),
      executionState: 'failed',
      deliveryState: 'blocked',
      failureCode: failure.code,
      failureStage,
      retryable: failure.retryable,
      executionFailureDetail: failure.privateMessage,
      publicFailure,
      executionProgress: progress,
      ...(workspaceRoot ? { taskWorkspaceRoot: workspaceRoot } : {}),
      ...(sessionId ? { workspaceSessionId: sessionId } : {}),
      ...(workspaceEpoch ? { workspaceEpoch } : {}),
    };
    const failed = auth.updateAgentDelegation({
      delegationId,
      status,
      ...(sessionId ? { sessionId } : {}),
      lastError: failure.publicMessage,
      metadata,
    });
    notifyDelegationUpdated(failed, { type: 'delegation_failed', progress });
    await flushDelegationProgress(delegationId);
    await syncDelegationRemoteUpdate(delegationId, {
      status,
      ...(sessionId ? { sessionId } : {}),
      lastError: failure.publicMessage,
      result: failure.publicMessage,
      metadata: publicAgentDelegationMetadata(metadata),
    });
    recordSecretaryDelegationFeedback(store, failed, failure.publicMessage);
    emitUBuddyDiagnostic('delegation_failed', {
      level: 'error',
      data: { delegationId, status, failureCode: failure.code, failureStage, retryable: failure.retryable },
      error,
    });
    triggerAutoSync(status === 'blocked' ? 'agent_delegation_blocked' : 'agent_delegation_failed', { delayMs: 500 });
    return failed;
  };
  return {
    async processAgentDelegationContent({
      delegationId = '',
      phase = 'reply',
      content = '',
      attachments = [],
      model = '',
      reasoningEffort = '',
      sandboxPermission = '',
      contextMessages = [],
      signal = null,
      timeoutMs = Number(process.env.JANUS_UBUDDY_DRAFT_HARD_TIMEOUT_MS || process.env.JANUS_UBUDDY_WORKSPACE_INTENT_TIMEOUT_MS || 180_000),
      softTimeoutMs = Number(process.env.JANUS_UBUDDY_DRAFT_SOFT_TIMEOUT_MS || 30_000),
      allowFallback = true,
      onEvent = null,
    } = {}) {
      const startedAt = Date.now();
      const user = auth.requireUser();
      const modelConfig = codexConfigStatus(runtimeRoot) || {};
      const cleanContent = String(content || '').trim();
      const cleanAttachments = Array.isArray(attachments) ? attachments.slice(0, 20) : [];
      const delegation = delegationId ? auth.agentDelegationById(String(delegationId)) : null;
      if (!cleanContent && !cleanAttachments.length && phase !== 'intake') throw new Error('\u8bf7\u8f93\u5165\u9700\u8981 uBuddy \u5904\u7406\u7684\u5185\u5bb9\u3002');
      const emit = (event = {}) => {
        if (typeof onEvent === 'function') onEvent(event);
      };
      emit({ kind: 'draft-progress', stage: 'context', message: '正在整理本次任务上下文', elapsedMs: 0 });
      const prompt = buildUBuddyDelegationProcessingPrompt({
        phase,
        content: cleanContent,
        attachments: cleanAttachments,
        delegation,
        contextMessages,
        currentUser: user,
      });
      const fallback = fallbackUBuddyDelegationProcessing({
        phase,
        content: cleanContent,
        attachments: cleanAttachments,
        delegation,
        contextMessages,
      });
      let secretaryInstance = null;
      let coordinatorMemory = null;
      let relationshipId = '';
      if (delegation) {
        relationshipId = `user:${delegation.requesterUserId === user.id ? delegation.recipientUserId : delegation.requesterUserId}`;
        try {
          secretaryInstance = store.findUserAgentInstance?.({ userId: user.id, agentFamilyId: 'secretary_agent' }) || null;
          if (secretaryInstance?.id) {
            store.ensureRelationshipMemoryDocument?.({ agentInstanceId: secretaryInstance.id, relationshipId });
            coordinatorMemory = ensureDelegationCoordinatorMemory(store, delegation, secretaryInstance);
          }
        } catch {
          // Memory setup must not make an otherwise valid delegation message fail.
        }
      }
      const finish = (result) => {
        const durationMs = Math.max(0, Date.now() - startedAt);
        const normalized = {
          ...result,
          diagnostics: result?.diagnostics ? { ...result.diagnostics, durationMs } : null,
        };
        recordDelegationCoordinatorMemory(store, delegation, secretaryInstance, {
          phase,
          sourceId: delegation?.id || '',
          input: cleanContent,
          output: normalized?.content || normalized?.instruction || normalized?.title || '',
          mode: normalized?.mode || 'fallback',
        });
        if (normalized.diagnostics) emit({ kind: 'draft-warning', diagnostics: normalized.diagnostics });
        emit({
          kind: 'draft-done',
          mode: normalized.mode || 'fallback',
          durationMs,
          executionId: normalized.diagnostics?.executionId || '',
        });
        emitUBuddyDiagnostic('delegation_content_processed', {
          durationMs,
          data: {
            delegationId: delegation?.id || '',
            phase,
            mode: normalized.mode || 'fallback',
            attachmentCount: cleanAttachments.length,
            diagnosticCode: normalized.diagnostics?.code || '',
          },
        });
        return normalized;
      };
      if (String(process.env.JANUS_UBUDDY_PROCESSING_MODE || '').toLowerCase() === 'fallback') {
        if (!allowFallback) {
          return finish({
            mode: 'failed', title: '', content: '',
            diagnostics: draftProcessingDiagnostics(null, {
              code: 'forced_fallback', phase, model, retryable: true,
              providerId: modelConfig.providerName || '',
              message: '当前客户端配置为不调用大模型；没有生成或发布兜底草稿。',
            }),
          });
        }
        return finish({
          ...fallback,
          diagnostics: draftProcessingDiagnostics(null, {
            code: 'forced_fallback', phase, model, retryable: true,
            providerId: modelConfig.providerName || '',
            message: '当前客户端配置为不调用大模型，已生成基础草稿。',
          }),
        });
      }
      let executionId = '';
      let softTimer = null;
      try {
        const userAgentContext = store.resolveUserAgent({
          userId: user.id,
          agentFamilyId: 'secretary_agent',
          taskRunId: coordinatorMemory?.taskRunId || delegation?.id || '',
          relationshipId,
        });
        const effectiveMemory = userAgentContext?.memoryContent || '';
        executionId = newId('model_exec');
        const effectiveModel = String(model || modelConfig.model || '').trim();
        let streamedAnswer = '';
        let previousPreview = '';
        emit({ kind: 'draft-progress', stage: 'connecting', message: '正在连接草稿模型', elapsedMs: Date.now() - startedAt });
        if (softTimeoutMs > 0) {
          softTimer = setTimeout(() => emit({
            kind: 'draft-slow', stage: 'slow', message: '草稿仍在生成，你可以继续等待、重新生成或改为手动编辑。',
            elapsedMs: Date.now() - startedAt,
          }), softTimeoutMs);
        }
        const answer = await runCodexExec({
          prompt,
          agentId: 'secretary_agent',
          role: 'ubuddy_delegation_processing',
          root: runtimeRoot,
          cwd: runtimeRoot,
          sandbox: 'read-only',
          timeoutMs,
          signal,
          model,
          reasoningEffort: 'low',
          permissionMode: typeof onEvent === 'function' ? 'draft-stream' : '',
          harnessMode: 'raw',
          onEvent: (event = {}) => {
            if (event.kind === 'token') streamedAnswer += String(event.content || '');
            else if (event.kind === 'answer') streamedAnswer = String(event.content || streamedAnswer);
            else if (event.kind === 'heartbeat') {
              emit({ kind: 'draft-progress', stage: 'generating', message: 'uBuddy 正在编写草稿', elapsedMs: Number(event.elapsed || Date.now() - startedAt) });
              return;
            } else if (event.kind === 'activity' || event.kind === 'progress') {
              emit({ kind: 'draft-progress', stage: 'generating', message: 'uBuddy 正在整理目标、交付物和约束', elapsedMs: Date.now() - startedAt });
              return;
            }
            const preview = previewUBuddyDelegationProcessingAnswer(streamedAnswer);
            const previewKey = preview ? `${preview.title}\n${preview.content}` : '';
            if (preview && previewKey !== previousPreview) {
              previousPreview = previewKey;
              emit({ kind: 'draft-preview', title: preview.title, content: preview.content, elapsedMs: Date.now() - startedAt });
            }
          },
          executionContext: {
            id: executionId,
            store,
            userId: user.id,
            conversationId: delegation?.sessionId || '',
            departmentId: 'secretary_department',
            agentId: 'secretary_agent',
            agentInstanceId: userAgentContext?.instance?.id || '',
            agentVersionId: userAgentContext?.baseVersion?.id || '',
            personalSkillVersionId: userAgentContext?.personalSkillVersion?.id || '',
            agentRole: 'agent',
            executionKind: 'ubuddy_delegation_processing',
            skillHash: userAgentContext?.effectiveSkillHash || sha256Text(org.readSkill(org.agent('secretary_agent'))),
            memoryHash: sha256Text(effectiveMemory),
            memoryManifestHash: userAgentContext?.memoryManifestHash || '',
            metadata: { phase, delegationId: delegation?.id || '', readOnlyOrganizer: true, fastDraftPath: true },
          },
        });
        if (softTimer) clearTimeout(softTimer);
        emit({ kind: 'draft-progress', stage: 'parsing', message: '正在校验草稿结构', elapsedMs: Date.now() - startedAt });
        const parsed = parseUBuddyDelegationProcessingAnswer(answer, fallback);
        const strictJson = strictDelegationDraftJson(answer);
        return finish({
          ...parsed,
          mode: 'model',
          processedByOwnUBuddy: phase !== 'intake',
          organizedByRecipientUBuddy: phase === 'intake',
          diagnostics: strictJson ? null : draftProcessingDiagnostics(null, {
            code: 'model_output_recovered', phase, model: effectiveModel, executionId, retryable: true,
            providerId: modelConfig.providerName || '',
            message: '模型返回的草稿格式不标准，系统已恢复可编辑内容。',
          }),
        });
      } catch (error) {
        if (softTimer) clearTimeout(softTimer);
        if (signal?.aborted) throw error;
        const diagnostics = draftProcessingDiagnostics(error, {
          phase,
          model: String(model || modelConfig.model || '').trim(),
          providerId: modelConfig.providerName || '',
          executionId,
          retryable: true,
        });
        if (!allowFallback) {
          return finish({
            mode: 'failed', title: '', content: '', warning: diagnostics.detail,
            diagnostics: { ...diagnostics, message: '草稿生成失败；没有生成或发布兜底任务。你可以重试或手动编辑。' },
          });
        }
        return finish({ ...fallback, warning: diagnostics.detail, diagnostics });
      }
    },
    async delegationTaskMemory({ delegationId = '' } = {}) {
      const user = auth.requireUser();
      const delegation = auth.agentDelegationById(String(delegationId || '').trim());
      if (!delegation || ![delegation.requesterUserId, delegation.recipientUserId].includes(user.id)) {
        throw new Error('无权查看该任务 Memory。');
      }
      const secretaryInstance = store.findUserAgentInstance?.({ userId: user.id, agentFamilyId: 'secretary_agent' }) || null;
      const coordinator = secretaryInstance?.id ? ensureDelegationCoordinatorMemory(store, delegation, secretaryInstance) : null;
      const executionTaskRunId = String(delegation.taskRunId || '').trim();
      const executionDocuments = executionTaskRunId && store.getTaskRun(executionTaskRunId)
        ? store.listUserAgentInstances({ userId: user.id }).flatMap((instance) => (
            store.listMemoryDocuments({ agentInstanceId: instance.id })
              .filter((document) => document.scope === 'task' && document.taskRunId === executionTaskRunId)
              .filter((document) => document.id !== coordinator?.id)
              .map((document) => taskMemoryView(store, document, instance))
          ))
        : [];
      const groupId = delegationGroupId(delegation);
      const workspaceSync = groupId
        ? await syncSharedTaskWorkspaceResilient(delegation, user, 'pull', { blockUnsafe: false })
        : null;
      return {
        delegationId: delegation.id,
        groupId,
        taskRunId: executionTaskRunId,
        workspaceRoot: workspaceSync?.workspaceRoot || ensureDelegationTaskWorkspace(runtimeRoot, user.id, delegation),
        workspaceScope: groupId ? 'collaboration_group' : 'private_delegation',
        workspaceRevision: Number(workspaceSync?.revision || 0),
        workspaceSyncStatus: workspaceSync?.syncStatus || (groupId ? 'idle' : 'private'),
        workspaceSessionId: delegation.sessionId || '',
        runs: delegation.sessionId ? store.listAgentDeliveryRuns({
          userId: user.id,
          sessionId: delegation.sessionId,
          statuses: ['queued', 'running'],
          limit: 100,
        }).filter((receipt) => receipt.metadata?.delegationId === delegation.id) : [],
        coordinator: coordinator ? taskMemoryView(store, coordinator, secretaryInstance, { role: 'coordinator' }) : null,
        executionDocuments,
        lifecycleState: ['closed', 'withdrawn', 'declined', 'rejected', 'completed', 'result_accepted'].includes(String(delegation.status || '')) ? 'historical' : 'active',
      };
    },
    ensureExternalDelegationNotice({ delegation: inputDelegation = null } = {}) {
      const user = auth.requireUser();
      const delegation = inputDelegation?.id ? inputDelegation : auth.agentDelegationByEntityId(String(inputDelegation || ''));
      if (!delegation || delegation.recipientUserId !== user.id) return null;
      const secretarySession = this.ensureSecretarySession({ accountWorkspaceId: delegation.workspaceId || delegation.accountWorkspaceId || activeWorkspaceId() });
      let notice = store.listMessages(secretarySession.id).find((message) => (
        message.metadata?.externalDelegationId === delegation.id && message.metadata?.uBuddyTaskQueued
      )) || null;
      if (!notice) notice = store.addMessage({
        sessionId: secretarySession.id, role: 'assistant',
        content: `${displayAuthUserName(delegation.requester)} 的 uBuddy 向我派发了任务“${delegation.title || '未命名任务'}”。我已收到，接下来会在隔离工作区安排 Agent 执行。`,
        agentId: 'secretary_agent', departmentId: 'secretary_department',
        metadata: {
          secretaryControl: true, uBuddyTaskQueued: true, uBuddyPlanning: true,
          externalDelegationId: delegation.id, externalDelegationStatus: delegation.status,
          externalRequesterUserId: delegation.requesterUserId, externalRequesterName: displayAuthUserName(delegation.requester),
          externalProgressPrivacy: 'public_nodes_only',
        },
      });
      const updatedDelegation = auth.updateAgentDelegation({
        delegationId: delegation.id,
        metadata: { ...(delegation.metadata || {}), ownerSecretarySessionId: secretarySession.id, ownerSecretaryMessageId: notice.id },
      });
      notifyDelegationUpdated(updatedDelegation || delegation, { type: 'delegation_notice_upserted' }, {
        session: secretarySession,
        message: notice,
      });
      return { session: secretarySession, message: notice };
    },
    async prepareRecentWorkDigest({ delegationId = '', manualSupplement = '' } = {}) {
      const user = auth.requireUser();
      const delegation = auth.agentDelegationByEntityId(String(delegationId || '').trim());
      if (!delegation || delegation.recipientUserId !== user.id) throw new Error('近期工作汇报委托不可用。');
      if (String(delegation.metadata?.taskKind || '') !== 'recent_work_report') throw new Error('当前委托不是近期工作汇报。');
      const flags = uBuddyFeatureFlags?.snapshot?.({ userId: user.id, workspaceId: delegation.workspaceId || delegation.accountWorkspaceId || '' });
      if (flags?.recentWorkReportingV1 !== true) throw new Error('近期工作汇报功能尚未启用。');
      const spec = validateWorkReportSpec({
        ...(delegation.metadata?.workReportSpec || {}),
        audienceUserIds: [delegation.requesterUserId],
      }, { throwOnError: true }).value;
      const existingJob = store.getWorkDigestJob({ delegationId: delegation.id });
      const job = existingJob || store.ensureWorkDigestJob({
        delegationId: delegation.id,
        ownerUserId: user.id,
        workspaceId: delegation.workspaceId || delegation.accountWorkspaceId || '',
        spec,
        expiresAt: new Date(Date.now() + WORK_REPORT_EMPTY_WAIT_MS).toISOString(),
      });
      if (job.status === 'published') return { ok: true, job, idempotent: true };
      if (!String(manualSupplement || '').trim() && job.status === 'draft_ready' && job.latestVersion) {
        return { ok: true, job, version: job.latestVersion, delegation, idempotent: true };
      }
      const collected = collectRecentWork({
        store, userId: user.id, workspaceId: delegation.workspaceId || delegation.accountWorkspaceId || '', spec,
        excludeTaskRunIds: [delegation.taskRunId, delegation.metadata?.activeTaskRunId].filter(Boolean),
      });
      const supplement = String(manualSupplement || '').trim();
      if (supplement) collected.evidence.unshift(normalizeWorkDigestEvidence({
        id: `manual:${sha256Text(`${delegation.id}:${supplement}`).slice(0, 32)}`,
        sourceKind: 'owner_supplement', sourceId: `owner:${delegation.id}`,
        sourceRevision: sha256Text(supplement), occurredAt: new Date().toISOString(),
        title: '本人补充', status: 'completed', summary: supplement, included: true,
      }));
      if (!collected.evidence.length) {
        const waiting = store.updateWorkDigestJob({
          id: job.id, status: 'awaiting_owner_supplement', coverage: collected.coverage,
          expiresAt: job.expiresAt || new Date(Date.now() + WORK_REPORT_EMPTY_WAIT_MS).toISOString(),
        });
        const waitingMetadata = {
          ...(delegation.metadata || {}), intakeStatus: 'completed', executionState: 'waiting_owner_supplement',
          deliveryState: 'awaiting_owner_supplement', workDigestJobId: waiting.id,
          workDigestState: 'awaiting_owner_supplement', workDigestCoverage: collected.coverage,
          workDigestExpiresAt: waiting.expiresAt,
        };
        const updated = auth.updateAgentDelegation({
          delegationId: delegation.id, workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
          status: 'working', metadata: waitingMetadata,
        }) || delegation;
        const notice = this.ensureExternalDelegationNotice({ delegation: updated });
        if (notice?.message?.id) store.updateMessage(notice.message.id, {
          content: 'uBuddy 在指定范围内暂未找到结构化工作记录，正在等待你补充。',
          metadata: { ...(notice.message.metadata || {}), externalDelegationStatus: 'working', workDigestState: 'awaiting_owner_supplement', workDigestCoverage: collected.coverage, workDigestExpiresAt: waiting.expiresAt },
        });
        if (socialRelay.connected()) await syncDelegationRemoteUpdate(delegation.id, {
          workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
          status: 'working', metadata: publicAgentDelegationMetadata(waitingMetadata),
        });
        return { ok: true, awaitingSupplement: true, job: waiting, coverage: collected.coverage };
      }

      let collectedByTool = false;
      let savedVersion = null;
      const workspaceRoot = ensureDelegationTaskWorkspace(runtimeRoot, user.id, delegation);
      const resolvedWorkspace = ensureDelegationWorkspaceSession({ auth, store, delegation, user, workspaceRoot, newId });
      const dynamicTools = [{
        type: 'namespace', name: 'janus', description: 'Private recent-work evidence controls for the current owner.',
        tools: [{
          type: 'function', name: 'collect_recent_work', description: 'Read the already authorized structured recent-work evidence.',
          inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
        }, {
          type: 'function', name: 'save_work_digest_draft', description: 'Save an owner-private report draft using only collected evidence ids.',
          inputSchema: { type: 'object', additionalProperties: false, properties: {
            body: { type: 'string', minLength: 1, maxLength: 12000 },
            evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 500 },
          }, required: ['body', 'evidenceIds'] },
        }],
      }];
      try {
        await runCodexSession({
          prompt: [
            '你是当前接收方用户的私人 uBuddy。请生成一份可由用户审核的近期工作汇报。',
            '必须先调用 janus.collect_recent_work，再仅基于返回事实撰写；不要推断未记录的工作。',
            '正文按已完成、进行中、阻塞事项、下一步组织，并在末尾说明覆盖范围。',
            '完成后调用 janus.save_work_digest_draft。不要发布或代表用户作出承诺。',
            `请求范围：${JSON.stringify(spec)}`,
          ].join('\n\n'),
          root: runtimeRoot, cwd: runtimeRoot, sessionId: resolvedWorkspace.session.id,
          model: '', reasoningEffort: 'low', permissionMode: 'request-approval', readOnly: true,
          memoryUseEnabled: false, memoryGenerateEnabled: false, nativeMultiAgentEnabled: false,
          dynamicTools,
          onDynamicToolCall: async (call = {}) => {
            if (String(call.namespace || '') !== 'janus') return workDigestToolResult(false, { error: 'unsupported_namespace' });
            if (call.tool === 'collect_recent_work') {
              collectedByTool = true;
              return workDigestToolResult(true, { spec, evidence: collected.evidence, coverage: collected.coverage });
            }
            if (call.tool === 'save_work_digest_draft') {
              if (!collectedByTool) return workDigestToolResult(false, { error: 'collect_recent_work_required' });
              const args = call.arguments || {};
              const allowed = new Map(collected.evidence.map((item) => [item.id, item]));
              const selected = [...new Set((args.evidenceIds || []).map(String))].map((id) => allowed.get(id)).filter(Boolean);
              if (!selected.length) return workDigestToolResult(false, { error: 'evidence_required' });
              savedVersion = store.saveWorkDigestVersion({
                jobId: job.id, body: publicDelegationSubmissionText(String(args.body || '')),
                evidence: selected, coverage: collected.coverage, sourceKind: 'codex',
              });
              return workDigestToolResult(true, { versionId: savedVersion.id, revisionNo: savedVersion.revisionNo });
            }
            return workDigestToolResult(false, { error: 'unsupported_tool' });
          },
          executionContext: {
            id: newId('model_exec'), store, userId: user.id, conversationId: resolvedWorkspace.session.id,
            departmentId: 'secretary_department', agentId: 'secretary_agent', executionKind: 'ubuddy_recent_work_digest',
            metadata: { delegationId: delegation.id, readOnlyCollector: true },
          },
        });
      } catch {
        // The deterministic draft below preserves the evidence boundary when Codex is unavailable.
      }
      savedVersion ||= store.saveWorkDigestVersion({
        jobId: job.id, body: buildDeterministicWorkDigest(collected), evidence: collected.evidence,
        coverage: collected.coverage, sourceKind: 'deterministic_fallback',
      });
      const candidate = store.addMessage({
        sessionId: resolvedWorkspace.session.id, role: 'assistant', content: savedVersion.body,
        agentId: 'secretary_agent', departmentId: 'agent_delegation',
        metadata: {
          delegationId: delegation.id, privateTaskWorkspace: true, workspaceEpoch: resolvedWorkspace.workspaceEpoch,
          publishCandidate: true, awaitingOwnerDecision: true, submissionText: savedVersion.body,
          revisionId: savedVersion.id, workDigestVersionId: savedVersion.id, workDigestCoverage: collected.coverage,
        },
      });
      const readyMetadata = {
        ...(delegation.metadata || {}), intakeStatus: 'completed', executionState: 'draft_ready', deliveryState: 'awaiting_delivery',
        preliminaryResult: savedVersion.body, draftReadyAt: new Date().toISOString(), workDigestJobId: job.id,
        workDigestState: 'draft_ready', workDigestDraftVersionId: savedVersion.id, workDigestCoverage: collected.coverage,
      };
      const ready = auth.updateAgentDelegation({
        delegationId: delegation.id, workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
        status: 'draft_ready', sessionId: resolvedWorkspace.session.id, metadata: readyMetadata,
      }) || delegation;
      const notice = this.ensureExternalDelegationNotice({ delegation: ready });
      if (notice?.message?.id) store.updateMessage(notice.message.id, {
        content: '近期工作汇报草稿已经生成，等待你确认后交付给对方。',
        metadata: {
          ...(notice.message.metadata || {}), externalDelegationStatus: 'draft_ready',
          externalDelegationDeliveryDraft: {
            version: 1, candidateMessageId: candidate.id, candidateRevisionId: savedVersion.id,
            submissionText: savedVersion.body, attachments: [], updatedAt: new Date().toISOString(),
          },
        },
      });
      if (socialRelay.connected()) {
        await syncDelegationRemoteUpdate(delegation.id, {
          workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
          status: 'draft_ready', sessionId: resolvedWorkspace.session.id, metadata: publicAgentDelegationMetadata(readyMetadata),
        });
        await syncDelegationWorkspaceUpdate(ready);
      }
      return { ok: true, job: store.getWorkDigestJob({ id: job.id }), version: savedVersion, delegation: ready };
    },
    async supplementRecentWorkDigest({ delegationId = '', content = '' } = {}) {
      const user = auth.requireUser();
      const delegation = auth.agentDelegationByEntityId(String(delegationId || '').trim());
      if (!delegation || delegation.recipientUserId !== user.id) throw new Error('近期工作汇报委托不可用。');
      const supplement = String(content || '').trim();
      if (!supplement) throw new Error('请输入需要补充的工作内容。');
      if (supplement.length > 4000) throw new Error('补充内容不能超过 4000 个字符。');
      const job = store.getWorkDigestJob({ delegationId: delegation.id });
      if (job?.status === 'awaiting_owner_supplement' && Date.parse(job.expiresAt || '') <= Date.now()) {
        throw new Error('补充等待期已结束，uBuddy 将按未找到结构化记录提交最小说明。');
      }
      return this.prepareRecentWorkDigest({ delegationId: delegation.id, manualSupplement: supplement });
    },
    async startExternalUBuddyTask({ delegation: inputDelegation = null, workspaceRoot = '', workspaceSessionId = '', workspaceEpoch = '', model = '', reasoningEffort = '', executionEpoch = 0, signal = null } = {}) {
      const user = auth.requireUser();
      const delegation = inputDelegation?.id ? inputDelegation : auth.agentDelegationByEntityId(String(inputDelegation || ''));
      if (!delegation || delegation.recipientUserId !== user.id) throw new Error('外部委托不可用。');
      const delegationPermissionMode = externalDelegationPermissionMode(delegation.metadata?.executionPermissionMode);
      const accountWorkspaceId = delegation.workspaceId || delegation.accountWorkspaceId || activeWorkspaceId();
      const secretarySession = this.ensureSecretarySession({ accountWorkspaceId });
      let notice = store.listMessages(secretarySession.id)
        .find((message) => message.metadata?.externalDelegationId === delegation.id && message.metadata?.uBuddyTaskQueued) || null;
      let existingTask = delegation.taskRunId ? store.getTaskRun(delegation.taskRunId) : null;
      if (!existingTask) existingTask = store.findTaskRunForDelegation?.({
        delegationId: delegation.id, userId: user.id, allWorkspaces: true,
      }) || null;
      if (existingTask && !['pending', 'ready', 'queued', 'running', 'waiting', 'verifying', 'completed']
        .includes(String(existingTask.status || ''))) existingTask = null;
      if (existingTask?.id) {
        const latestDelegation = auth.agentDelegationByEntityId(delegation.id) || delegation;
        const resumedDelegation = auth.updateAgentDelegation({
          delegationId: delegation.id, taskRunId: existingTask.id,
          metadata: { ...(latestDelegation.metadata || {}), activeTaskRunId: existingTask.id,
            attemptTaskRunIds: [...new Set([...(latestDelegation.metadata?.attemptTaskRunIds || []), existingTask.id])],
            resumedAfterRestart: true,
            executionState: ['completed', 'verifying'].includes(String(existingTask.status || '')) ? 'completed' : 'running' },
        }) || latestDelegation;
        if (!notice) notice = store.addMessage({
          sessionId: secretarySession.id, role: 'assistant',
          content: `${displayAuthUserName(delegation.requester)} 的 uBuddy 向我派发了任务“${delegation.title || '未命名任务'}”，我已恢复该任务的执行进度。`,
          agentId: 'secretary_agent', departmentId: 'secretary_department',
          metadata: {
            secretaryControl: true, uBuddyTaskQueued: true, externalDelegationId: delegation.id,
            externalDelegationStatus: delegation.status, externalRequesterUserId: delegation.requesterUserId,
            externalRequesterName: displayAuthUserName(delegation.requester), taskRunId: existingTask.id,
            taskType: existingTask.metadata?.taskType || '', objective: existingTask.metadata?.objective || null,
            taskSnapshot: buildPublicTaskProgressSnapshot(existingTask, {
              phase: existingTask.status === 'completed' ? 'delivering' : 'executing',
              taskType: existingTask.metadata?.taskType || '', objective: existingTask.metadata?.objective || null,
            }),
          },
        });
        activateUnifiedUBuddyTask?.(existingTask.id);
        notifyDelegationUpdated(resumedDelegation, { type: 'delegation_notice_upserted', task: existingTask }, {
          session: secretarySession,
          message: notice,
          task: existingTask,
        });
        return { task: existingTask, message: notice, session: secretarySession, resumed: true };
      }
      const attachments = Array.isArray(delegation.metadata?.attachments) ? delegation.metadata.attachments : [];
      const ingress = store.addMessage({
        sessionId: secretarySession.id, role: 'user', visible: false,
        content: String(delegation.instruction || delegation.title || '').trim(),
        agentId: 'secretary_agent', departmentId: 'secretary_department',
        metadata: { secretaryControl: true, externalDelegationIngress: true, externalDelegationId: delegation.id,
          requesterUserId: delegation.requesterUserId, publicContextOnly: true, attachments },
      });
      notice ||= store.addMessage({
        sessionId: secretarySession.id, role: 'assistant',
        content: `${displayAuthUserName(delegation.requester)} 的 uBuddy 向我派发了任务“${delegation.title || '未命名任务'}”。我已收到，正在规划 Agent 和执行步骤。`,
        agentId: 'secretary_agent', departmentId: 'secretary_department',
        metadata: {
          secretaryControl: true, uBuddyTaskQueued: true, uBuddyPlanning: true, sourceMessageId: ingress.id,
          externalDelegationId: delegation.id, externalDelegationStatus: delegation.status,
          externalRequesterUserId: delegation.requesterUserId, externalRequesterName: displayAuthUserName(delegation.requester),
          externalProgressPrivacy: 'public_nodes_only',
        },
      });
      const candidates = buildUBuddyPlannerCandidates({
        store, org, userId: user.id,
        performanceForAgent: (agentInstanceId) => cloudSync.stage8Projection(`performance:${agentInstanceId}`)?.payload || null,
        leadershipForAgent: (agentInstanceId) => cloudSync.stage8Projection(`leadership:${agentInstanceId}`)?.payload || null,
      });
      const userAgentContext = store.resolveUserAgent({ userId: user.id, agentFamilyId: 'secretary_agent' });
      const selection = modelCatalog.resolveSelection({ model, reasoningEffort });
      const clarificationAnswers = Array.isArray(delegation.metadata?.externalDelegationClarificationAnswers)
        ? delegation.metadata.externalDelegationClarificationAnswers.slice(-6)
        : [];
      const sharedTaskSummary = delegationGroupId(delegation)
        ? normalizePublicTaskSummary(delegation.metadata?.taskSummary)
        : null;
      const sharedGoalContext = renderPublicTaskSummaryContext(sharedTaskSummary);
      const assignedWork = String(delegation.instruction || delegation.title || '').trim();
      const delegatedTaskPrompt = [
        sharedGoalContext,
        `Your assigned work:\n${assignedWork}`,
      ].filter(Boolean).join('\n\n');
      const planningStartedAt = Date.now();
      publishDelegationProgressSafely(delegation.id, {
        phase: 'planning',
        message: 'uBuddy 正在选择合适的 Agent 并生成执行步骤',
        terminal: false,
        milestone: {
          key: 'planning_started', status: 'running', title: '规划 Agent 和执行步骤',
          detail: '正在匹配可用 Agent、拆分任务节点并确认交付方式。', occurredAt: new Date().toISOString(),
        },
      });
      emitUBuddyDiagnostic('delegation_planning_started', {
        data: { delegationId: delegation.id, executionEpoch: Math.max(0, Number(executionEpoch || 0)) },
      });
      let turnDecision;
      const planningMaxAttempts = Math.max(1, Number(process.env.JANUS_EXTERNAL_DELEGATION_PLANNING_MAX_ATTEMPTS
        || DEFAULT_EXTERNAL_DELEGATION_PLANNING_MAX_ATTEMPTS));
      const planningBudgetMs = Math.max(1_000, Number(process.env.JANUS_EXTERNAL_DELEGATION_PLANNING_BUDGET_MS
        || DEFAULT_EXTERNAL_DELEGATION_PLANNING_BUDGET_MS));
      for (let attempt = 1; attempt <= planningMaxAttempts; attempt += 1) {
        try {
          turnDecision = await decideUBuddyTurn({
            prompt: [`外部正式委托标题：${delegation.title || '未命名任务'}`, `发出方：${displayAuthUserName(delegation.requester)}`,
              sharedGoalContext,
              `你的具体分工：${assignedWork}`,
              ...clarificationAnswers.map((item, index) => [
                `第 ${index + 1} 个澄清问题：${String(item?.question || '').trim() || '未记录问题文本'}`,
                `接收方用户已授权用于本任务的回答：${String(item?.answer || '').trim()}`,
              ].join('\n')),
              '这是隔离外部任务。只能使用上述公开要求和附件，不得假设可以访问用户的私人会话、Memory、项目或凭据。'].join('\n'),
            recentMessages: [],
            skill: userAgentContext?.effectiveSkill || org.readSkill(org.agent('secretary_agent')),
            memory: 'External delegation privacy boundary: no private owner Memory is available for planning.',
            attachmentSummaries: attachments.map((attachment) => ({
              id: String(attachment?.id || attachment?.attachmentId || ''), name: String(attachment?.name || attachment?.filename || attachment?.fileName || ''),
              type: String(attachment?.type || attachment?.mimeType || ''), size: Math.max(0, Number(attachment?.size || 0)),
            })),
            candidates, mentionedAgentIds: [], decisionMode: 'formal_task', root: runtimeRoot, cwd: workspaceRoot || runtimeRoot,
            model: selection.model, reasoningEffort: selection.reasoningEffort, signal,
            timeoutMs: externalDelegationPlanningAttemptTimeoutMs({
              attempt, maxAttempts: planningMaxAttempts, startedAt: planningStartedAt,
              budgetMs: planningBudgetMs,
            }),
            executionContext: { store, userId: user.id, conversationId: delegation.sessionId || '',
              taskRunId: delegation.taskRunId || '', departmentId: 'secretary_department', agentId: 'secretary_agent',
              executionKind: 'ubuddy_external_delegation_planner' },
          });
          break;
        } catch (error) {
          const failure = delegationExecutionFailureDetails(error);
          const retryDelayMs = EXTERNAL_DELEGATION_PLANNING_RETRY_DELAYS_MS[attempt - 1] || 0;
          const elapsedMs = Math.max(0, Date.now() - planningStartedAt);
          const retryable = failure.code === 'model_unavailable'
            && externalDelegationPlanningFailureIsTransient(error)
            && attempt < planningMaxAttempts
            && elapsedMs + retryDelayMs + 1_000 < planningBudgetMs;
          emitUBuddyDiagnostic('delegation_planning_failed', {
            level: 'error',
            data: {
              delegationId: delegation.id,
              executionEpoch: Math.max(0, Number(executionEpoch || 0)),
              durationMs: elapsedMs,
              attempt,
              maxAttempts: planningMaxAttempts,
              retryable,
              errorCode: String(error?.code || ''),
            },
            error,
          });
          if (!retryable) throw error;
          emitUBuddyDiagnostic('delegation_planning_retry_scheduled', {
            level: 'warn',
            data: {
              delegationId: delegation.id,
              executionEpoch: Math.max(0, Number(executionEpoch || 0)),
              attempt,
              nextAttempt: attempt + 1,
              retryDelayMs,
            },
          });
          await waitForExternalDelegationPlanningRetry(retryDelayMs, signal);
        }
      }
      if (turnDecision.decision === 'clarification') {
        const clarificationText = [turnDecision.clarification?.question,
          ...(turnDecision.clarification?.options || []).map((option, index) => `${index + 1}. ${option}`)].filter(Boolean).join('\n');
        notice = store.updateMessage(notice.id, {
          content: `我已收到 ${displayAuthUserName(delegation.requester)} 的任务，但开始执行前还需要对方补充信息：\n\n${clarificationText}`,
          metadata: { ...(notice.metadata || {}), uBuddyPlanning: false, externalDelegationClarification: turnDecision.clarification,
            blocker: { summary: clarificationText } },
        });
        notifyDelegationUpdated(delegation, { type: 'delegation_notice_upserted' }, {
          session: secretarySession,
          message: notice,
        });
        return { clarification: turnDecision.clarification, message: notice, session: secretarySession, task: null };
      }
      const objective = { taskType: classifyTaskType(delegation.instruction || delegation.title || ''),
        summary: String(delegation.instruction || delegation.title || '').replace(/\s+/g, ' ').slice(0, 500) };
      const dispatchPlan = { mode: 'unified_external_delegation_v1', objective, nodes: turnDecision.nodes,
        finalNodeId: turnDecision.finalNodeId, deliverablePlan: turnDecision.deliverablePlan,
        confidence: turnDecision.confidence, rationale: turnDecision.agentSelectionRationale };
      const plannedFinalNode = turnDecision.nodes.find((node) => node.localId === turnDecision.finalNodeId)
        || turnDecision.nodes.find((node) => node.isFinal) || turnDecision.nodes.at(-1);
      const task = scheduler.createTaskRun({
        title: delegation.title || objective.summary.slice(0, 80) || '外部 uBuddy 任务',
        prompt: buildMessageWithAttachments(runtimeRoot, delegatedTaskPrompt, attachments, user.id),
        departmentId: plannedFinalNode?.departmentId || org.agent(plannedFinalNode?.agentId)?.departmentId || 'general', userId: user.id,
        metadata: {
          userId: user.id, accountWorkspaceId, source: 'ubuddy_dispatch', taskOrigin: 'external_delegation', delegationId: delegation.id,
          collaborationGroupId: delegationGroupId(delegation), projectId: '', workspaceRoot,
          ubuddyWorkspaceScope: 'isolated_external_delegation', sourceSecretarySessionId: secretarySession.id,
          sourceSecretaryMessageId: ingress.id, displayConversationId: secretarySession.id, conversationId: '',
          delegationWorkspaceSessionId: workspaceSessionId || '',
          routingPrompt: delegatedTaskPrompt, globalTaskSummary: delegatedTaskPrompt, objective, taskType: objective.taskType,
          ...(sharedTaskSummary ? { taskSummary: sharedTaskSummary } : {}),
          candidateSnapshots: candidates, ubuddyPlannerMode: 'unified_external_delegation_v1', requireValidatedTaskGraph: true,
          taskGraphProposal: { version: 2, status: 'ready', confidence: turnDecision.confidence, nodes: turnDecision.nodes,
            deliverables: turnDecision.deliverablePlan?.deliverables || [] },
          deliverablePlan: turnDecision.deliverablePlan, dispatchPlan, coordinationAuthority: 'owner_ubuddy',
          externalDeliveryGate: 'recipient_confirmation', externalRequesterUserId: delegation.requesterUserId,
          externalRequesterName: displayAuthUserName(delegation.requester), delegationWorkspaceEpoch: workspaceEpoch,
          executionEpoch: Math.max(0, Number(executionEpoch || 0)), attachments,
          executionOptions: {
            model: selection.model,
            reasoningEffort: selection.reasoningEffort,
            requestedPermissionMode: delegationPermissionMode,
            permissionMode: delegationPermissionMode,
            permissionPolicyVersion: 'ubuddy_task_permission_v2',
            permissionOwner: 'recipient',
            permissionSource: delegationPermissionMode === 'auto-approve' ? 'recipient_selected' : 'remote_default_full_access',
            permissionDeviceId: store.contextDeviceId?.() || socialRelay.status?.().deviceId || 'local',
            permissionUpdatedAt: new Date().toISOString(),
            remotePermissionIntent: 'full-access',
          },
        },
      });
      bindDelegatedTaskWorkScope(store, task, delegation);
      notice = store.updateMessage(notice.id, {
        content: `${displayAuthUserName(delegation.requester)} 的任务已完成规划，正在由 Agent 执行；我会在完成、失败或需要你操作时回来通知你。`,
        metadata: { ...(notice.metadata || {}), uBuddyPlanning: false, uBuddySleeping: true, taskRunId: task.id,
          externalDelegationClarification: null, blocker: null,
          taskType: objective.taskType, objective, dispatchPlan,
          assignedAgentIds: [...new Set((task.nodes || []).map((node) => node.agentId).filter(Boolean))],
          taskSnapshot: buildPublicTaskProgressSnapshot(task, { phase: 'executing', taskType: objective.taskType, objective }) },
      });
      const updatedDelegation = auth.updateAgentDelegation({ delegationId: delegation.id, taskRunId: task.id, sessionId: workspaceSessionId,
        metadata: { ...(delegation.metadata || {}), activeTaskRunId: task.id, ownerSecretarySessionId: secretarySession.id,
          ownerSecretaryMessageId: notice.id, sourceSecretarySessionId: secretarySession.id, sourceSecretaryMessageId: ingress.id,
          executionEpoch: Math.max(0, Number(executionEpoch || 0)), taskOrigin: 'external_delegation' } });
      publishDelegationProgressSafely(delegation.id, {
        phase: 'executing',
        taskStatus: task.status || 'pending',
        message: '任务看板已建立，正在安排 Agent 执行',
        completed: 0,
        total: (task.nodes || []).length,
        nodes: (task.nodes || []).map((node) => publicTaskNode(node, task)),
        terminal: false,
        milestone: {
          key: 'task_created', status: 'completed', title: '任务看板已建立',
          detail: '执行节点已经创建，后续进度将在当前看板中持续更新。', occurredAt: new Date().toISOString(),
        },
      });
      notifyDelegationUpdated(updatedDelegation || delegation, { type: 'delegation_notice_upserted', task }, {
        session: secretarySession,
        message: notice,
        task,
      });
      activateUnifiedUBuddyTask?.(task.id);
      return { task, message: notice, session: secretarySession, turnDecision, dispatchPlan };
    },
    async syncExternalUBuddyTaskUpdate(payload = {}) {
      const task = payload.task?.id ? store.getTaskRun(payload.task.id) || payload.task : null;
      if (!task?.id || task.metadata?.taskOrigin !== 'external_delegation' || !task.metadata?.delegationId) return null;
      const delegationId = String(task.metadata.delegationId);
      const delegation = auth.agentDelegationByEntityId(delegationId);
      if (!delegation || delegation.recipientUserId !== task.ownerUserId) return null;
      const nodes = task.nodes || [];
      const terminal = ['completed', 'failed', 'cancelled'].includes(String(task.status || ''));
      const phase = task.status === 'completed' ? 'awaiting_delivery'
        : task.status === 'verifying' ? 'verifying'
          : task.status === 'failed' || task.status === 'cancelled' ? 'failed'
          : task.status === 'waiting' ? 'executing' : 'executing';
      const completedCount = nodes.filter((node) => node.status === 'completed').length;
      const executionBlocked = task.status === 'waiting'
        && nodes.some((node) => node.status === 'blocked')
        && Boolean(task.metadata?.failureReport || task.metadata?.publicFailure);
      const progressPatch = {
        phase,
        taskStatus: task.status || '',
        lifecyclePhase: task.metadata?.failurePhase === 'verifying' ? 'verifying'
          : task.status === 'verifying' ? 'verifying'
            : task.status === 'completed' ? 'delivering' : 'executing',
        failureStage: task.metadata?.failurePhase || '',
        outputDisposition: task.metadata?.outputDisposition || task.metadata?.deliverableResult?.contentType || '',
        reviewState: task.metadata?.deliveryReviewState || task.metadata?.deliveryReview?.state || '',
        message: task.status === 'completed'
          ? '任务处理和交付校验已完成，等待接收方确认交付'
          : task.status === 'verifying' ? 'Agent 已提交交付物，接收方 uBuddy 大模型正在验收'
            : task.status === 'failed' ? '任务执行失败，接收方 uBuddy 正在整理可公开的错误信息'
            : task.status === 'cancelled' ? '任务执行已停止'
              : payload.change?.node?.title ? `${payload.change.node.title}：${payload.change.node.status || '处理中'}` : '接收方 uBuddy 正在调度 Agent 执行任务',
        completed: completedCount,
        total: nodes.length,
        executionPercent: nodes.length ? Math.round((completedCount / nodes.length) * 100) : 0,
        running: nodes.filter((node) => ['running', 'queued'].includes(node.status)).length,
        waiting: nodes.filter((node) => ['waiting', 'retry_wait', 'blocked', 'pending'].includes(node.status)).length,
        failed: nodes.filter((node) => node.status === 'failed').length,
        currentStep: payload.change?.node ? { title: payload.change.node.title || '', status: payload.change.node.status || '', agentName: org.agent(payload.change.node.agentId)?.name || '' } : null,
        terminal: false,
        ...publicTaskProgressPatch(task, { change: payload.change || {}, changedNodes: payload.change?.node ? [payload.change.node] : [] }),
        ...(agentWorkProjectionEnabled() ? {
          agentWorkStatusProjection: publicTaskAgentWorkStatus(task, {
            agentName: (agentId) => org.agent(agentId)?.name || agentId || 'Agent',
          }),
        } : {}),
      };
      if (terminal && task.metadata?.externalWorkspaceRevisionInProgress?.delegationId === delegationId) {
        // A private workspace revision reuses the original task graph. Its
        // caller owns the blocked/draft-ready outcome, so this task event must
        // not fail the entire external delegation.
        return auth.agentDelegationByEntityId(delegationId) || delegation;
      }
      if (executionBlocked || (terminal && task.status !== 'completed')) {
        const latestFailureState = auth.agentDelegationByEntityId(delegationId) || delegation;
        if (latestFailureState.status === 'blocked' && latestFailureState.metadata?.workspaceExecutionError) {
          await releaseDelegationExecution(delegationId, 'workspace_blocked');
          return latestFailureState;
        }
        await releaseDelegationExecution(delegationId, executionBlocked ? 'task_blocked' : task.status);
        const report = task.metadata?.publicFailure || task.metadata?.failureReport || {};
        const error = new Error(report.cause || report.summary || task.summary || `Task ${task.status}`);
        error.code = report.errorCode || '';
        return markDelegationFailure({
          delegationId,
          error,
          stage: task.metadata?.failurePhase || (executionBlocked ? 'execution' : 'unified_task'),
          progressPatch: { ...progressPatch, terminal: true },
        });
      }
      publishDelegationProgress(delegationId, progressPatch);
      if (!terminal) return auth.agentDelegationByEntityId(delegationId);
      await flushDelegationProgress(delegationId);
      const latest = auth.agentDelegationByEntityId(delegationId) || delegation;
      if (latest.metadata?.draftReadyAt && latest.status === 'draft_ready') {
        await releaseDelegationExecution(delegationId, 'draft_ready');
        return latest;
      }
      const completedNodes = nodes.filter((node) => node.status === 'completed');
      const finalNode = completedNodes.find((node) => node.id === task.metadata?.finalTaskNodeId)
        || completedNodes.find((node) => node.isFinal) || completedNodes.at(-1);
      const recoverySourceNode = /^Fallback:\s*/i.test(String(finalNode?.title || ''))
        ? nodes.find((node) => node.status === 'cancelled'
          && String(node.waitReason || '').includes(`fallback node ${finalNode.id}`))
          || nodes.find((node) => node.status === 'cancelled' && String(node.errorText || '').trim())
        : null;
      const answer = String(finalNode?.resultText || task.metadata?.deliverableResult?.summary || task.summary || '').trim();
      if (!answer) return markDelegationFailure({ delegationId, error: new Error('统一 uBuddy 任务完成但没有可交付结果。'), stage: 'delivery' });
      const submissionText = publicDelegationSubmissionText(answer).slice(0, 8000);
      const workspaceRoot = String(task.metadata?.workspaceRoot || latest.metadata?.taskWorkspaceRoot || '').trim();
      if (!classifyPptIntent(delegation.instruction || delegation.title || '', { attachments: latest.metadata?.attachments || [] }).creation) {
        ensureDelegationEditableDraftFile({ workspaceRoot, delegation: latest, answer, previous: latest.metadata?.generatedTaskFiles });
      }
      const executionSession = latest.sessionId ? store.getSession(latest.sessionId) : null;
      let draftMessage = executionSession ? store.listMessages(executionSession.id).find((message) => (
        message.metadata?.delegationId === delegationId && message.metadata?.initialDelegationDraft && message.metadata?.publishCandidate
      )) : null;
      if (executionSession && !draftMessage) draftMessage = store.addMessage({
        sessionId: executionSession.id, role: 'assistant', content: appendDelegationDecisionPrompt(answer, latest),
        agentId: 'secretary_agent', departmentId: 'agent_delegation',
        metadata: workspaceMessageMetadata(latest, delegationWorkspaceEpoch(latest), {
          processedByOwnUBuddy: true, workspaceRole: 'recipient', publishCandidate: true, publishAction: 'submit',
          awaitingOwnerDecision: true, initialDelegationDraft: true, resultState: 'complete', taskRunId: task.id,
          submissionText,
        }),
      });
      if (draftMessage && draftMessage.metadata?.submissionText !== submissionText) draftMessage = store.updateMessage(draftMessage.id, {
        metadata: { ...(draftMessage.metadata || {}), submissionText },
      });
      const generatedTaskFiles = collectDelegationGeneratedFiles({
        runtimeRoot, store, sessionId: executionSession?.id || '', workspaceRoot, userId: task.ownerUserId,
        previous: latest.metadata?.generatedTaskFiles, delegationId, groupId: delegationGroupId(latest),
        workspaceEpoch: delegationWorkspaceEpoch(latest), candidateMessageId: draftMessage?.id || '',
      });
      const completed = auth.updateAgentDelegation({
        delegationId, status: 'draft_ready', taskRunId: task.id, sessionId: executionSession?.id || latest.sessionId,
        metadata: {
          ...(latest.metadata || {}), activeTaskRunId: task.id, preliminaryResult: answer, generatedTaskFiles,
          draftReadyAt: new Date().toISOString(), executionState: 'completed', deliveryState: 'awaiting_delivery',
          ownerConfirmationRequired: true, safePreparationOnly: false, failureCode: '', failureStage: '', retryable: false,
          ...(recoverySourceNode ? {
            executionRecovered: true,
            executionDegraded: false,
            specializedExecutionError: String(recoverySourceNode.errorText || '').slice(0, 4000),
          } : {}),
        },
      });
      const secretarySessionId = String(completed.metadata?.ownerSecretarySessionId || task.metadata?.sourceSecretarySessionId || '');
      const queuedMessage = secretarySessionId ? store.listMessages(secretarySessionId).find((message) => (
        message.metadata?.externalDelegationId === delegationId && message.metadata?.uBuddyTaskQueued
      )) : null;
      const deliveryDraft = {
        version: 1,
        candidateMessageId: draftMessage?.id || '',
        candidateRevisionId: delegationCandidateRevisionId(draftMessage || {}),
        submissionText,
        attachments: generatedTaskFiles.map(privateExternalDeliveryAttachment),
        updatedAt: new Date().toISOString(),
      };
      if (queuedMessage) store.updateMessage(queuedMessage.id, {
        content: `${displayAuthUserName(completed.requester)} 的任务已经完成，等待你确认后交付给对方。`,
        metadata: { ...(queuedMessage.metadata || {}), terminal: true, processOnly: true,
          externalDelegationStatus: 'draft_ready', externalDelegationPublishMessageId: draftMessage?.id || '',
          externalDelegationDeliveryDraft: deliveryDraft,
          taskSnapshot: buildPublicTaskProgressSnapshot(task, { phase: 'delivering', taskType: task.metadata?.taskType || '', objective: task.metadata?.objective || null }) },
      });
      notifyDelegationUpdated(completed, { type: 'delegation_draft_ready', task, progress: completed.metadata?.executionProgress || null });
      if (socialRelay.connected()) {
        await syncDelegationRemoteUpdate(delegationId, {
          status: 'draft_ready', taskRunId: task.id, sessionId: executionSession?.id || '',
          metadata: {
            ...publicAgentDelegationMetadata(completed.metadata),
            preliminaryResult: submissionText,
            draftReadyAt: completed.metadata?.draftReadyAt || '',
            ownerConfirmationRequired: true,
            deliveryState: 'awaiting_delivery',
            activeTaskRunId: task.id,
          },
        });
        await syncDelegationWorkspaceUpdate(completed);
      }
      await releaseDelegationExecution(delegationId, 'draft_ready');
      triggerAutoSync('agent_delegation_draft_ready', { delayMs: 500 });
      return completed;
    },
    createAgentDelegation(payload = {}) {
      const user = auth.requireUser();
      const workspaceId = store.activeAccountWorkspace?.({
        userId: user.id,
        deviceId: store.contextDeviceId?.() || 'local',
      })?.id || 'workspace_personal';
      const scopedPayload = {
        ...payload,
        workspaceId,
        metadata: {
          ...(payload.metadata || {}),
          permissionPolicyVersion: 'ubuddy_task_permission_v2',
          permissionOwner: 'recipient',
          permissionSource: 'sender_default',
          remotePermissionIntent: 'full-access',
          permissionNotice: '当前任务默认建议完全开放执行；接收方可在自己的设备上选择 AI 自动审查。',
        },
      };
      const deliveryMode = socialRelayMutationMode({ socialRelay, user });
      if (deliveryMode === 'remote') {
        return socialRelay.createDelegation(scopedPayload).then((result) => ({
          ...result,
          delegations: auth.agentDelegations({ direction: 'all', workspaceId }),
          inbox: auth.socialInbox({ workspaceId }),
        }));
      }
      if (deliveryMode === 'unavailable') throw socialRelayUnavailableError();
      const result = auth.createAgentDelegation(scopedPayload);
      return { ...result, delegations: auth.agentDelegations({ direction: 'all', workspaceId }) };
    },
    async startAgentDelegation(payload = {}) {
      const user = auth.requireUser();
      const delegationId = String(payload.delegationId || payload.id || '').trim();
      const delegation = payload[internalAutoStart]
        ? auth.agentDelegationByEntityId(delegationId)
        : auth.agentDelegationById(delegationId);
      if (!delegation) throw new Error('\u59d4\u6258\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u65e0\u6743\u8bbf\u95ee\u3002');
      if (delegation.recipientUserId !== user.id) throw new Error('\u53ea\u6709\u63a5\u6536\u65b9\u53ef\u4ee5\u542f\u52a8\u8be5\u59d4\u6258\u4efb\u52a1\u3002');
      if (delegation.status === 'assigned') throw new Error('\u8bf7\u5148\u63a5\u6536\u8be5\u59d4\u6258\uff0c\u518d\u5f00\u59cb\u5904\u7406\u3002');
      if (delegation.status === 'rejected') throw new Error('\u8be5\u59d4\u6258\u5df2\u88ab\u62d2\u7edd\uff0c\u65e0\u6cd5\u542f\u52a8\u3002');
      if (['closed', 'withdrawn', 'declined', 'submitted', 'result_accepted'].includes(String(delegation.status || ''))) throw new Error('当前任务状态不允许继续启动处理。');
      const delegationPermissionMode = externalDelegationPermissionMode(
        payload.sandboxPermission || delegation.metadata?.executionPermissionMode,
      );
      const activeProcessing = runtimeState.delegationProcessingLocks.get(delegationId);
      if (activeProcessing) {
        await activeProcessing;
        const current = auth.agentDelegationById(delegationId);
        return {
          ok: !['blocked', 'failed'].includes(String(current?.status || '')),
          blocked: current?.status === 'blocked',
          coalesced: true,
          error: current?.lastError || '',
          delegation: current,
          session: current?.sessionId ? store.getSession(current.sessionId) : null,
          task: current?.taskRunId ? store.getTaskRun(current.taskRunId) : null,
          delegations: auth.agentDelegations({ direction: 'all' }),
          inbox: auth.socialInbox(),
        };
      }
      let releaseProcessing = null;
      const processingLock = new Promise((resolve) => { releaseProcessing = resolve; });
      runtimeState.delegationProcessingLocks.set(delegationId, processingLock);
      try {
      let taskWorkspaceRoot = '';
      let workspaceBaseline = null;
      let resolvedWorkspace = null;
      let executionSession = null;
      let workspaceEpoch = '';
      publishDelegationProgressSafely(delegationId, {
        phase: 'preparing',
        message: 'uBuddy 正在准备隔离工作区和任务会话',
        terminal: false,
        milestone: {
          key: 'workspace_preparing', status: 'running', title: '准备隔离工作区',
          detail: '正在建立隔离工作区、同步公开任务资料并检查执行环境。', occurredAt: new Date().toISOString(),
        },
      }, { syncRemote: false });
      try {
        taskWorkspaceRoot = ensureDelegationTaskWorkspace(runtimeRoot, user.id, delegation);
        await syncSharedTaskWorkspaceResilient(delegation, user, 'pull');
        workspaceBaseline = delegationGroupId(delegation) ? snapshotDelegationWorkspaceDeliverables(taskWorkspaceRoot) : null;
        const remoteWorkspace = socialRelay.connected()
          ? await socialRelay.delegationWorkspace(delegationId, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }).catch(() => null)
          : null;
        resolvedWorkspace = ensureDelegationWorkspaceSession({
          auth,
          store,
          delegation,
          user,
          workspaceRoot: taskWorkspaceRoot,
          remoteWorkspace: remoteWorkspace?.workspace || null,
          newId,
        });
        executionSession = resolvedWorkspace.session;
        workspaceEpoch = resolvedWorkspace.workspaceEpoch;
      } catch (error) {
        const failed = await markDelegationFailure({
          delegationId,
          error,
          stage: taskWorkspaceRoot ? 'workspace_sync' : 'workspace_prepare',
          workspaceRoot: taskWorkspaceRoot,
        });
        return {
          ok: false,
          blocked: failed?.status === 'blocked',
          error: failed?.metadata?.publicFailure?.message || String(error?.message || error),
          delegation: failed,
          delegations: auth.agentDelegations({ direction: 'all' }),
          inbox: auth.socialInbox(),
        };
      }
      if (['draft_ready', 'submitted', 'result_accepted', 'completed'].includes(delegation.status)) {
        const current = auth.agentDelegationByEntityId(delegationId) || {
          ...delegation,
          sessionId: executionSession.id,
          metadata: resolvedWorkspace.metadata,
        };
        if (socialRelay.connected() && resolvedWorkspace.repaired) {
          await socialRelay.updateDelegation(delegationId, {
            workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
            sessionId: executionSession.id,
            metadata: privateAgentDelegationMetadata(resolvedWorkspace.metadata),
          }).catch(() => null);
        }
        return {
          ok: true,
          delegation: current,
          session: executionSession,
          delegations: auth.agentDelegations({ direction: 'all' }),
          inbox: auth.socialInbox(),
        };
      }
      try {
        store.provisionNewUserAgentDefaults?.({ userId: user.id, sourceDeviceId: cloudSync.status?.().deviceId || '' });
      } catch {
        // Existing active employees can still be used when default provisioning is temporarily unavailable.
      }
      const activeEmployees = store.activeEmployeeAgentsForUser?.({ userId: user.id }) || [];
      const preflightPrompt = String(delegation.instruction || '').trim() || String(delegation.title || '').trim();
      const preflightPptCreationRequested = classifyPptIntent(preflightPrompt, {
        attachments: Array.isArray(delegation.metadata?.attachments) ? delegation.metadata.attachments : [],
      }).creation;
      const activePptEmployee = activeEmployees.find((employee) => (
        (org.agent(employee.agentFamilyId)?.departmentId || employee.family?.departmentId || '') === 'ppt_department'
      ));
      const executionRequested = payload.execute !== false && payload.dryRun !== true;
      if (executionRequested && (!activeEmployees.length || (preflightPptCreationRequested && !activePptEmployee))) {
        const pptSkillInstallRequired = preflightPptCreationRequested
          && org.agent('ppt')?.skillPackageId === 'ppt_creation'
          && org.agent('ppt')?.skillInstalled === false;
        const preflightError = new Error(pptSkillInstallRequired
          ? 'ppt_skill_install_required: the receiver device has not installed the PPT creation Skill.'
          : preflightPptCreationRequested
            ? 'ppt_employee_not_active: no canonical PPT employee is available for this delegation.'
            : 'employee_not_active: no active employee is available for this delegation.');
        preflightError.code = pptSkillInstallRequired
          ? 'ppt_skill_install_required'
          : preflightPptCreationRequested ? 'ppt_employee_not_active' : 'employee_not_active';
        const blocked = await markDelegationFailure({
          delegationId,
          sessionId: executionSession.id,
          error: preflightError,
          stage: 'preflight',
          workspaceRoot: taskWorkspaceRoot,
          workspaceEpoch,
        });
        return {
          ok: false,
          blocked: true,
          error: blocked?.metadata?.publicFailure?.message || '没有可执行该任务的在职 Agent。',
          failureCode: blocked?.metadata?.failureCode || 'no_active_employee',
          delegation: blocked,
          session: executionSession,
          delegations: auth.agentDelegations({ direction: 'all' }),
          inbox: auth.socialInbox(),
        };
      }
      let executionClaim;
      try {
        executionClaim = await claimDelegationExecution(delegation);
      } catch (error) {
        const failed = await markDelegationFailure({ delegationId, sessionId: executionSession.id, error, stage: 'execution_claim', workspaceRoot: taskWorkspaceRoot, workspaceEpoch });
        return { ok: false, blocked: true, error: failed?.metadata?.publicFailure?.message || String(error?.message || error), delegation: failed,
          session: executionSession, delegations: auth.agentDelegations({ direction: 'all' }), inbox: auth.socialInbox() };
      }
      if (!executionClaim.acquired) {
        return { ok: true, claimedElsewhere: true, delegation: auth.agentDelegationByEntityId(delegationId) || delegation,
          session: executionSession, task: delegation.taskRunId ? store.getTaskRun(delegation.taskRunId) : null,
          delegations: auth.agentDelegations({ direction: 'all' }), inbox: auth.socialInbox() };
      }
      const executionEpoch = Math.max(0, Number(executionClaim.lease?.executionEpoch || 0));
      const executionAbortController = new AbortController();
      let executionLeaseLostError = null;
      let executionLeaseFailure = null;
      armDelegationExecutionLease(delegationId, { onLeaseLost: (error) => {
        executionLeaseLostError = error instanceof Error ? error : new Error(String(error || 'Delegation execution lease lost.'));
        executionAbortController.abort(executionLeaseLostError);
        const current = auth.agentDelegationByEntityId(delegationId);
        if (current?.taskRunId) { try { this.cancelTaskRun({ taskRunId: current.taskRunId }); } catch {} }
        executionLeaseFailure ||= markDelegationFailure({
          delegationId,
          error: executionLeaseLostError,
          stage: 'execution_lease_lost',
          workspaceRoot: taskWorkspaceRoot,
          workspaceEpoch,
        }).catch(() => auth.agentDelegationByEntityId(delegationId));
      } });
      const persistClaimedFailure = async ({ error, stage, releaseReason }) => {
        let failed = null;
        try {
          failed = await markDelegationFailure({
            delegationId,
            sessionId: executionSession.id,
            error,
            stage,
            workspaceRoot: taskWorkspaceRoot,
            workspaceEpoch,
          });
        } catch (persistenceError) {
          failed = auth.agentDelegationByEntityId(delegationId);
          emitUBuddyDiagnostic('delegation_failure_persistence_failed', {
            level: 'error',
            data: { delegationId, stage, executionEpoch },
            error: persistenceError,
          });
        }
        await releaseDelegationExecution(delegationId, releaseReason);
        return failed;
      };
      if (payload[internalAutoStart]
        && externalDelegationPlanningRecoveryExhausted({ executionEpoch, taskRunId: delegation.taskRunId })) {
        const recoveryError = new Error(`External delegation planning did not create a task before execution epoch ${executionEpoch}.`);
        recoveryError.code = 'ubuddy_planning_recovery_exhausted';
        const failed = await persistClaimedFailure({
          error: recoveryError,
          stage: 'unified_planning_recovery',
          releaseReason: 'planning_recovery_exhausted',
        });
        return {
          ok: false,
          blocked: false,
          error: failed?.metadata?.publicFailure?.message || recoveryError.message,
          delegation: failed,
          session: executionSession,
          delegations: auth.agentDelegations({ direction: 'all' }),
          inbox: auth.socialInbox(),
        };
      }
      const runningProgress = normalizeDelegationExecutionProgress({
        ...(auth.agentDelegationByEntityId(delegationId)?.metadata?.executionProgress || delegation.metadata?.executionProgress || {}),
        sequence: Number(auth.agentDelegationByEntityId(delegationId)?.metadata?.executionProgress?.sequence
          || delegation.metadata?.executionProgress?.sequence || 0) + 1,
        phase: 'preparing',
        message: '接收方 uBuddy 已接收任务，正在准备执行环境',
        terminal: false,
        updatedAt: new Date().toISOString(),
      });
      const running = auth.updateAgentDelegation({
        delegationId,
        status: 'running',
        sessionId: executionSession.id,
        lastError: '',
        metadata: {
          ...(resolvedWorkspace.metadata || delegation.metadata || {}),
          ...(auth.agentDelegationByEntityId(delegationId)?.metadata || {}),
          startedByUserId: user.id,
          taskWorkspaceRoot,
          workspaceSessionId: executionSession.id,
          workspaceEpoch,
          executionState: 'running',
          deliveryState: 'executing',
          failureCode: '',
          failureStage: '',
          retryable: false,
          executionFailureDetail: '',
          publicFailure: null,
          executionEpoch,
          executionPermissionMode: delegationPermissionMode,
          executionPermissionOwner: 'recipient',
          executionPermissionSource: delegationPermissionMode === 'auto-approve'
            ? 'recipient_selected'
            : 'remote_default_full_access',
          executionPermissionDeviceId: store.contextDeviceId?.() || socialRelay.status?.().deviceId || 'local',
          remotePermissionIntent: 'full-access',
          executionProgress: runningProgress,
        },
        started: true,
      });
      notifyDelegationUpdated(running, { type: 'delegation_started', progress: runningProgress });
      emitUBuddyDiagnostic('delegation_execution_started', {
        data: { delegationId, status: running.status, groupId: running.groupId || '', attachmentCount: Array.isArray(running.metadata?.attachments) ? running.metadata.attachments.length : 0 },
      });
      if (socialRelay.connected()) {
        try {
          await syncDelegationRemoteUpdate(delegationId, {
            status: 'running',
            sessionId: executionSession.id,
            metadata: {
              ...publicAgentDelegationMetadata(running.metadata),
              ...privateAgentDelegationMetadata(running.metadata),
            },
          });
        } catch (error) {
          const failed = await persistClaimedFailure({
            error,
            stage: 'execution_start_sync',
            releaseReason: 'execution_start_sync_failed',
          });
          return {
            ok: false,
            blocked: failed?.status === 'blocked',
            error: failed?.metadata?.publicFailure?.message || String(error?.message || error),
            delegation: failed,
            session: executionSession,
            delegations: auth.agentDelegations({ direction: 'all' }),
            inbox: auth.socialInbox(),
          };
        }
      }
      triggerAutoSync('agent_delegation_started', { delayMs: 500 });
      const unifiedExternalTasks = true;
      if (unifiedExternalTasks && payload.execute !== false && payload.dryRun !== true) {
        try {
          const unified = await this.startExternalUBuddyTask({
            delegation: running, workspaceRoot: taskWorkspaceRoot, workspaceSessionId: executionSession.id, workspaceEpoch,
            model: payload.model || '', reasoningEffort: payload.reasoningEffort || '',
            executionEpoch,
            signal: executionAbortController.signal,
          });
          if (unified.clarification) {
            const clarificationText = [unified.clarification.question,
              ...(unified.clarification.options || []).map((option, index) => `${index + 1}. ${option}`)].filter(Boolean).join('\n');
            const waiting = auth.updateAgentDelegation({
              delegationId, status: 'accepted', sessionId: executionSession.id,
              metadata: { ...(running.metadata || {}), dependencyState: 'waiting', dependencyReasonCode: 'owner_input_required',
                clarification: unified.clarification, ownerInputRequestedAt: new Date().toISOString() },
            });
            if (socialRelay.connected()) await syncDelegationRemoteUpdate(delegationId, {
              status: 'accepted', sessionId: executionSession.id,
              metadata: publicAgentDelegationMetadata(waiting?.metadata || {}),
            }).catch(() => null);
            publishDelegationProgressSafely(delegationId, {
              phase: 'waiting', lifecyclePhase: 'confirming',
              message: '等待接收方补充信息后继续同一任务', terminal: false,
              blocker: { summary: clarificationText, userActionRequired: true, reasonCode: 'owner_input_required' },
              currentStep: null,
            });
            await releaseDelegationExecution(delegationId, 'awaiting_requirements');
            return { ok: true, waitingForOwnerInput: true, clarification: unified.clarification,
              delegation: auth.agentDelegationByEntityId(delegationId) || waiting,
              session: unified.session || executionSession, message: unified.message, delegations: auth.agentDelegations({ direction: 'all' }), inbox: auth.socialInbox() };
          }
          if (unified.task?.id) activateUnifiedUBuddyTask?.(unified.task.id);
          const bound = auth.agentDelegationByEntityId(delegationId) || running;
          if (socialRelay.connected()) await syncDelegationRemoteUpdate(delegationId, {
            taskRunId: unified.task?.id || '', sessionId: executionSession.id,
          });
          return { ok: true, resuming: true, unified: true, delegation: bound, session: unified.session || executionSession,
            message: unified.message, task: unified.task, delegations: auth.agentDelegations({ direction: 'all' }), inbox: auth.socialInbox() };
        } catch (error) {
          const failed = executionLeaseLostError
            ? await (executionLeaseFailure || markDelegationFailure({
                delegationId, sessionId: executionSession.id, error: executionLeaseLostError,
                stage: 'execution_lease_lost', workspaceRoot: taskWorkspaceRoot, workspaceEpoch,
              }))
            : await persistClaimedFailure({ error, stage: 'unified_planning', releaseReason: 'planning_failed' });
          if (executionLeaseLostError) await releaseDelegationExecution(delegationId, 'execution_lease_lost');
          return { ok: false, blocked: failed?.status === 'blocked', error: failed?.metadata?.publicFailure?.message || String(error?.message || error),
            delegation: failed, session: executionSession, delegations: auth.agentDelegations({ direction: 'all' }), inbox: auth.socialInbox() };
        }
      }
      const peerId = running.requesterUserId === user.id ? running.recipientUserId : running.requesterUserId;
      const delegationComments = auth.socialConversation({ peerId }).filter((message) => {
        const metadata = message.metadata || {};
        return metadata.delegationId === delegationId && metadata.type === 'agent_delegation_comment' && !metadata.withdrawn;
      });
      const delegatedMessage = buildAgentDelegationPrompt(running, user, delegationComments);
      const delegationRouteMessage = buildAgentDelegationRouteMessage(running, delegationComments);
      const pptCreationRequested = classifyPptIntent(delegationRouteMessage, {
        attachments: Array.isArray(running.metadata?.attachments) ? running.metadata.attachments : [],
      }).creation;
      const execute = payload.execute !== false && payload.dryRun !== true;
      if (!execute) {
        store.addMessage({
          sessionId: executionSession.id,
          role: 'user',
          content: delegatedMessage,
          departmentId: 'agent_delegation',
          metadata: workspaceMessageMetadata(running, workspaceEpoch, { agentDelegation: { id: delegationId, mode: 'created_session_only' } }),
        });
        const accepted = auth.updateAgentDelegation({
          delegationId,
          status: 'accepted',
          sessionId: executionSession.id,
          metadata: { ...(running.metadata || {}), sessionId: executionSession.id, execution: 'created_session_only', workspaceEpoch },
        });
        if (socialRelay.connected()) {
          await socialRelay.updateDelegation(delegationId, {
            workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
            status: 'accepted',
            sessionId: executionSession.id,
          }).catch(() => null);
        }
        triggerAutoSync('agent_delegation_session', { delayMs: 500 });
        return {
          ok: true,
          dryRun: true,
          delegation: accepted,
          session: executionSession,
          delegations: auth.agentDelegations({ direction: 'all' }),
          inbox: auth.socialInbox(),
        };
      }
      let primaryTask = null;
      let attemptTaskRunIds = Array.isArray(running.metadata?.attemptTaskRunIds)
        ? [...running.metadata.attemptTaskRunIds]
        : [];
      const bindActiveDelegatedTask = (taskOrId = null, { resumedAfterRestart = false } = {}) => {
        const activeTask = typeof taskOrId === 'string'
          ? store.getTaskRun(String(taskOrId || '').trim())
          : taskOrId?.id ? store.getTaskRun(taskOrId.id) || taskOrId : null;
        if (!activeTask?.id) return null;
        primaryTask = activeTask;
        attemptTaskRunIds = [...new Set([...attemptTaskRunIds, activeTask.id])];
        const latestDelegation = auth.agentDelegationById(delegationId) || running;
        bindDelegatedTaskWorkScope(store, activeTask, latestDelegation);
        if (latestDelegation.taskRunId !== activeTask.id
          || latestDelegation.metadata?.activeTaskRunId !== activeTask.id
          || resumedAfterRestart) {
          const boundDelegation = auth.updateAgentDelegation({
            delegationId,
            taskRunId: activeTask.id,
            metadata: {
              ...(latestDelegation.metadata || {}),
              activeTaskRunId: activeTask.id,
              attemptTaskRunIds,
              executionState: ['completed', 'verifying'].includes(String(activeTask.status || '')) ? 'completed' : 'running',
              deliveryState: String(activeTask.status || '') === 'verifying' ? 'verifying' : 'executing',
              ...(resumedAfterRestart ? { resumedAfterRestart: true } : {}),
            },
          });
          notifyDelegationUpdated(boundDelegation, { type: 'delegation_task_bound', task: activeTask });
          emitUBuddyDiagnostic('delegation_task_bound', {
            data: {
              delegationId,
              taskRunId: activeTask.id,
              taskStatus: activeTask.status || '',
              attemptTaskRunCount: attemptTaskRunIds.length,
              resumedAfterRestart,
            },
          });
          if (socialRelay.connected()) {
            queueDelegationRemoteUpdate(delegationId, { taskRunId: activeTask.id });
          }
          triggerAutoSync('agent_delegation_task_bound', { delayMs: 200 });
        }
        return activeTask;
      };
      try {
        publishDelegationProgress(delegationId, {
          phase: 'planning',
          message: 'uBuddy 正在分析任务、交付物和执行步骤',
          publicFailure: null,
          terminal: false,
        });
        const linkedTaskRunId = String(running.taskRunId || running.metadata?.activeTaskRunId || '').trim();
        let resumableTask = linkedTaskRunId ? store.getTaskRun(linkedTaskRunId) : null;
        if (!resumableTask) {
          const latestDelegatedTask = store.findTaskRunForDelegation?.({
            delegationId,
            userId: user.id,
            allWorkspaces: true,
          }) || null;
          resumableTask = latestDelegatedTask && ['pending', 'ready', 'queued', 'running', 'waiting', 'verifying', 'completed']
            .includes(String(latestDelegatedTask.status || ''))
            ? latestDelegatedTask
            : null;
          if (resumableTask) bindActiveDelegatedTask(resumableTask, { resumedAfterRestart: true });
        }
        if (resumableTask) {
          scheduler.prepareTaskRecovery(resumableTask.id);
          resumableTask = store.getTaskRun(resumableTask.id) || resumableTask;
        }
        if (resumableTask && ['pending', 'ready'].includes(String(resumableTask.status || ''))) {
          for (let wave = 0; wave < 12 && store.readyTaskNodes(resumableTask.id).length; wave += 1) {
            resumableTask = await scheduler.runReadyNodes(resumableTask.id, {
              maxParallel: Math.min(3, store.readyTaskNodes(resumableTask.id).length),
              model: payload.model || '',
              reasoningEffort: payload.reasoningEffort || '',
              permissionMode: scheduler.taskExecutionPermissionMode?.(resumableTask)
                || resumableTask.metadata?.executionOptions?.permissionMode
                || resumableTask.metadata?.executionOptions?.requestedPermissionMode || 'full-access',
              onTaskProgress: (task, change = {}) => {
                const nodes = task?.nodes || [];
                publishDelegationProgress(delegationId, {
                  phase: 'executing',
                  message: change?.node?.title ? `${change.node.title}：${change.node.status || '处理中'}` : 'uBuddy 正在恢复并继续执行任务',
                  completed: nodes.filter((node) => node.status === 'completed').length,
                  total: nodes.length,
                  running: nodes.filter((node) => node.status === 'running').length,
                  waiting: nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length,
                  failed: nodes.filter((node) => node.status === 'failed').length,
                  currentStep: change?.node ? { title: change.node.title || '', status: change.node.status || '' } : null,
                  terminal: false,
                  ...publicTaskProgressPatch(task, { change, changedNodes: change?.node ? [change.node] : [] }),
                });
              },
            });
          }
          resumableTask = store.getTaskRun(resumableTask.id);
        }
        if (resumableTask && ['pending', 'ready', 'queued', 'running', 'waiting'].includes(String(resumableTask.status || ''))) {
          bindActiveDelegatedTask(resumableTask, { resumedAfterRestart: true });
          await flushDelegationProgress(delegationId);
          return {
            ok: true,
            resuming: true,
            delegation: auth.agentDelegationById(delegationId),
            session: executionSession,
            task: resumableTask,
            delegations: auth.agentDelegations({ direction: 'all' }),
            inbox: auth.socialInbox(),
          };
        }
        let result;
        if (resumableTask && ['completed', 'verifying'].includes(String(resumableTask.status || ''))) {
          const completedNodes = (resumableTask.nodes || []).filter((node) => node.status === 'completed');
          const finalNode = completedNodes.find((node) => /final|synthesis|最终|整合/i.test(`${node.title || ''} ${node.outputFormat || ''}`))
            || completedNodes.at(-1);
          const resumedAnswer = String(finalNode?.resultText || '').trim();
          if (!resumedAnswer) throw new Error('Recovered task graph completed without a deliverable result.');
          result = {
            session: executionSession,
            message: null,
            answer: resumedAnswer,
            threadId: '',
            task: resumableTask,
            resumedAfterRestart: true,
          };
        } else {
          result = await this.sendChat({
            message: delegatedMessage,
            routingMessage: delegationRouteMessage,
            chatMode: 'collaboration',
            routePreference: 'explicit',
            workspaceRoot: taskWorkspaceRoot,
            model: payload.model || '',
            reasoningEffort: payload.reasoningEffort || '',
            sandboxPermission: delegationPermissionMode,
            timeoutMs: Number(process.env.JANUS_UBUDDY_WORKSPACE_NODE_TIMEOUT_MS || 1_800_000),
            requestedAccountWorkspaceId: running.workspaceId || running.accountWorkspaceId || '',
            internalWorkspaceToken: internalWorkspaceExecutionToken,
            onTaskCreated: (task) => bindActiveDelegatedTask(task),
            onEvent: (event = {}) => {
              bindActiveDelegatedTask(event.taskRunId || event.task?.id || event.taskProgressSnapshot?.taskRunId || '');
              publishDelegationProgress(delegationId, progressPatchFromEvent(event));
              try { payload.onEvent?.(event); } catch {}
            },
            contextScope: {
              kind: 'task',
              taskRunId: delegationId,
              delegationId,
              groupId: running.groupId || '',
              title: running.title || '',
            },
          });
        }
        await flushDelegationProgress(delegationId);
        const delegatedTask = result.task?.id ? store.getTaskRun(result.task.id) || result.task : result.task;
        primaryTask = delegatedTask || null;
        if (delegatedTask) result.task = delegatedTask;
        bindDelegatedTaskWorkScope(store, delegatedTask, running);
        if (delegatedTask?.id) {
          attemptTaskRunIds = [...new Set([...attemptTaskRunIds, delegatedTask.id])];
          auth.updateAgentDelegation({
            delegationId,
            taskRunId: delegatedTask.id,
            metadata: {
              ...((auth.agentDelegationById(delegationId) || running).metadata || {}),
              activeTaskRunId: delegatedTask.id,
              attemptTaskRunIds,
              executionState: ['completed', 'verifying'].includes(String(delegatedTask.status || '')) ? 'completed' : String(delegatedTask.status || 'running'),
              deliveryState: String(delegatedTask.status || '') === 'verifying' ? 'verifying' : 'executing',
            },
          });
        }
        if (delegatedTask && !['completed', 'verifying'].includes(String(delegatedTask.status || ''))) {
          const nodeErrors = (delegatedTask.nodes || []).filter((node) => ['failed', 'waiting', 'retry_wait', 'blocked'].includes(node.status)).map((node) => node.errorText || node.waitReason).filter(Boolean);
          throw new Error(nodeErrors.join('\n') || `Delegated task graph ended with status ${delegatedTask.status}.`);
        }
        if (result?.cancelled) {
          const restored = auth.updateAgentDelegation({
            delegationId,
            status: 'assigned',
            sessionId: executionSession.id,
            metadata: { ...(running.metadata || {}), sessionId: executionSession.id, workspaceEpoch, cancelled: true },
          });
          if (socialRelay.connected()) {
            await syncDelegationRemoteUpdate(delegationId, { status: 'assigned', sessionId: executionSession.id });
          }
          return { ok: true, cancelled: true, delegation: restored, session: executionSession, delegations: auth.agentDelegations({ direction: 'all' }), inbox: auth.socialInbox() };
        }
        if (result.message?.id) {
          const workerMessage = result.message;
          result.message = store.addMessage({
            sessionId: executionSession.id,
            role: 'assistant',
            content: appendDelegationDecisionPrompt(workerMessage.content, running),
            agentId: 'secretary_agent',
            departmentId: 'agent_delegation',
            metadata: workspaceMessageMetadata(running, workspaceEpoch, {
              processedByOwnUBuddy: true,
              workspaceRole: 'recipient',
              publishCandidate: true,
              publishAction: 'submit',
              awaitingOwnerDecision: true,
              initialDelegationDraft: true,
              resultState: 'complete',
              workerSessionId: result.session?.id || '',
              workerMessageId: workerMessage.id,
            }),
          });
          result.answer = result.message.content;
        }
        if (!pptCreationRequested) {
          ensureDelegationEditableDraftFile({
            workspaceRoot: taskWorkspaceRoot,
            delegation: running,
            answer: result.answer || result.message?.content || '',
            previous: running.metadata?.generatedTaskFiles,
          });
        }
        if (!delegatedTask?.id && pptCreationRequested && !listDelegationWorkspaceDeliverables(taskWorkspaceRoot).some((filePath) => /\.pptx$/i.test(filePath))) {
          throw new Error('PPT Designer 没有生成 PPTX 文件；本次不会用对话记录或 Markdown 草稿冒充交付物。');
        }
        const generatedTaskFiles = collectDelegationGeneratedFiles({
          runtimeRoot,
          store,
          sessionId: executionSession.id,
          workspaceRoot: taskWorkspaceRoot,
          userId: user.id,
          previous: running.metadata?.generatedTaskFiles,
          delegationId,
          groupId: delegationGroupId(running),
          workspaceEpoch,
          candidateMessageId: result.message?.id || '',
          workspaceBaseline,
        });
        const deliveryValidation = validateDelegationDeliverable({
          store,
          task: delegatedTask,
          delegation: running,
          answer: result.answer || result.message?.content || '',
          workspaceRoot: taskWorkspaceRoot,
          generatedTaskFiles,
        });
        if (!delegatedTask?.id && deliveryValidation && !deliveryValidation.passed) throw deliverableValidationError(deliveryValidation);
        await syncSharedTaskWorkspaceResilient(running, user, 'push');
        if (delegatedTask?.id) {
          result.task = store.getTaskRun(delegatedTask.id) || delegatedTask;
          primaryTask = result.task;
        }
        publishDelegationProgress(delegationId, {
          phase: 'awaiting_delivery',
          message: '任务处理和交付校验已完成，等待接收方确认交付',
          completed: result.task?.nodeCount || delegatedTask?.nodeCount || delegatedTask?.nodes?.length || 0,
          total: result.task?.nodeCount || delegatedTask?.nodeCount || delegatedTask?.nodes?.length || 0,
          running: 0,
          waiting: 0,
          failed: 0,
          currentStep: null,
          publicFailure: null,
          terminal: false,
        });
        await flushDelegationProgress(delegationId);
        const latestRunning = auth.agentDelegationById(delegationId) || running;
        const completed = auth.updateAgentDelegation({
          delegationId,
          status: 'draft_ready',
          sessionId: executionSession.id,
          metadata: {
            ...(latestRunning.metadata || {}),
            sessionId: executionSession.id,
            workspaceSessionId: executionSession.id,
            workspaceEpoch,
            threadId: result.threadId || '',
            answerMessageId: result.message?.id || '',
            preliminaryResult: result.answer || result.message?.content || '',
            taskWorkspaceRoot,
            generatedTaskFiles,
            ...(deliveryValidation ? { deliverableResult: deliveryValidation, resultState: deliveryValidation.resultState } : {}),
            draftReadyAt: new Date().toISOString(),
            initialDraftRevisionNo: Number(latestRunning.metadata?.initialDraftRevisionNo || latestRunning.metadata?.intakeLatestRevisionNo || 0),
            activeTaskRunId: result.task?.id || delegatedTask?.id || '',
            attemptTaskRunIds: [...new Set([...attemptTaskRunIds, result.task?.id || delegatedTask?.id || ''].filter(Boolean))],
            executionState: 'completed',
            deliveryState: 'awaiting_delivery',
            failureCode: '',
            failureStage: '',
            retryable: false,
            executionFailureDetail: '',
          },
        });
        notifyDelegationUpdated(completed, {
          type: 'delegation_draft_ready',
          progress: completed.metadata?.executionProgress || null,
        });
        emitUBuddyDiagnostic('delegation_draft_ready', {
          data: {
            delegationId,
            taskRunId: result.task?.id || delegatedTask?.id || '',
            generatedFileCount: generatedTaskFiles.length,
            recovered: false,
          },
        });
        if (socialRelay.connected()) {
          await syncDelegationRemoteUpdate(delegationId, {
            status: 'draft_ready',
            sessionId: executionSession.id,
            taskRunId: result.task?.id || '',
            metadata: publicAgentDelegationMetadata(completed.metadata),
          });
          await syncDelegationWorkspaceUpdate(completed);
        }
        triggerAutoSync('agent_delegation_draft_ready', { delayMs: 500 });
        return {
          ok: true,
          delegation: completed,
          session: executionSession,
          message: result.message,
          answer: result.answer,
          threadId: result.threadId,
          delegations: auth.agentDelegations({ direction: 'all' }),
          inbox: auth.socialInbox(),
        };
      } catch (error) {
        const specializedError = error;
        const specializedFailure = delegationExecutionFailureDetails(specializedError);
        emitUBuddyDiagnostic('delegation_recovery_started', {
          level: 'warn',
          data: { delegationId, failureCode: specializedFailure.code, failureStage: specializedFailure.stage },
          error: specializedError,
        });
        if (primaryTask?.id && !['completed', 'failed', 'cancelled'].includes(String(store.getTaskRun(primaryTask.id)?.status || ''))) {
          primaryTask = scheduler.completeTaskDeliveryValidation(primaryTask.id, {
            passed: false,
            failureCode: specializedFailure.code,
            summary: specializedFailure.privateMessage,
            final: false,
          }) || store.getTaskRun(primaryTask.id);
        }
        try {
          const recoveryCandidates = buildUBuddyPlannerCandidates({ store, org, userId: user.id });
          const recoveryCandidate = pptCreationRequested
            ? selectBestUBuddyCandidate(recoveryCandidates.filter((candidate) => candidate.departmentId === 'ppt_department'), {
              departmentId: 'ppt_department',
              prompt: delegationRouteMessage,
            })
            : null;
          if (pptCreationRequested && !recoveryCandidate) throw new Error('当前没有可用的 PPT 员工 Agent。');
          const recoveryPrompt = [
            '【uBuddy 专业执行接管】',
            pptCreationRequested
              ? '上一轮执行没有形成真实 PPTX。现在由 PPT 员工 Agent 接管同一任务，并负责生成可编辑 PPTX。'
              : '原专业 Agent 遇到明确执行错误。现在由 Generalist 接管同一任务，并负责把任务真正完成。',
            '',
            delegatedMessage,
            '',
            '必须完成原任务要求的全部交付物；需要文件时实际生成文件，需要验证时完成验证。',
            '不要输出超时说明、占位草稿、待办清单或仅供继续编辑的安全草稿。',
            '执行没有固定时间上限；除非用户取消或出现无法恢复的明确错误，否则持续执行直至完成。',
          ].join('\n');
          const recoveryRoutingMessage = [
            '【uBuddy 专业执行接管】',
            delegationRouteMessage,
          ].filter(Boolean).join('\n\n');
          const recovery = await this.sendChat({
            message: recoveryPrompt,
            routingMessage: recoveryRoutingMessage,
            chatMode: 'collaboration',
            routePreference: 'explicit',
            workspaceRoot: taskWorkspaceRoot,
            model: payload.model || '',
            reasoningEffort: payload.reasoningEffort || '',
            sandboxPermission: delegationPermissionMode,
            timeoutMs: Number(process.env.JANUS_UBUDDY_WORKSPACE_NODE_TIMEOUT_MS || 1_800_000),
            requestedAccountWorkspaceId: running.workspaceId || running.accountWorkspaceId || '',
            internalWorkspaceToken: internalWorkspaceExecutionToken,
            onTaskCreated: (task) => bindActiveDelegatedTask(task),
            onEvent: (event = {}) => {
              bindActiveDelegatedTask(event.taskRunId || event.task?.id || event.taskProgressSnapshot?.taskRunId || '');
              publishDelegationProgress(delegationId, {
                ...progressPatchFromEvent(event),
                message: event.message || '专业执行遇到问题，uBuddy 正在调度接管方案',
              });
              try { payload.onEvent?.(event); } catch {}
            },
            contextScope: {
              kind: 'task',
              taskRunId: delegationId,
              delegationId,
              groupId: running.groupId || '',
              title: running.title || '',
            },
          });
          if (recovery.task?.id) recovery.task = store.getTaskRun(recovery.task.id) || recovery.task;
          if (recovery.task && !['completed', 'verifying'].includes(String(recovery.task.status || ''))) {
            const recoveryNodeErrors = (recovery.task.nodes || [])
              .filter((node) => ['failed', 'waiting', 'retry_wait', 'blocked'].includes(node.status))
              .map((node) => node.errorText || node.waitReason)
              .filter(Boolean);
            throw new Error(recoveryNodeErrors.join('\n') || `Recovery task graph ended with status ${recovery.task.status}.`);
          }
          if (recovery.task?.id) primaryTask = recovery.task;
          bindDelegatedTaskWorkScope(store, recovery.task, running);
          const recoveryAnswer = String(recovery.answer || recovery.message?.content || '').trim();
          if (!recoveryAnswer) throw new Error('Generalist 接管后没有返回完整结果。');
          const preliminaryResult = appendDelegationDecisionPrompt(recoveryAnswer, running);
          if (recovery.message?.id) {
            const workerMessage = recovery.message;
            recovery.message = store.addMessage({
              sessionId: executionSession.id,
              role: 'assistant',
              content: preliminaryResult,
              agentId: 'secretary_agent',
              departmentId: 'agent_delegation',
              metadata: workspaceMessageMetadata(running, workspaceEpoch, {
                processedByOwnUBuddy: true,
                workspaceRole: 'recipient',
                publishCandidate: true,
                publishAction: 'submit',
                awaitingOwnerDecision: true,
                initialDelegationDraft: true,
                executionRecovered: true,
                resultState: 'complete',
                workerSessionId: recovery.session?.id || '',
                workerMessageId: workerMessage.id,
              }),
            });
          }
          if (!pptCreationRequested) {
            ensureDelegationEditableDraftFile({
              workspaceRoot: taskWorkspaceRoot,
              delegation: running,
              answer: preliminaryResult,
              previous: running.metadata?.generatedTaskFiles,
              force: true,
            });
          }
          if (!recovery.task?.id && !primaryTask?.id && pptCreationRequested
            && !listDelegationWorkspaceDeliverables(taskWorkspaceRoot).some((filePath) => /\.pptx$/i.test(filePath))) {
            throw new Error('PPT Designer 接管后仍未生成 PPTX 文件。');
          }
          const generatedTaskFiles = collectDelegationGeneratedFiles({
            runtimeRoot,
            store,
            sessionId: executionSession.id,
            workspaceRoot: taskWorkspaceRoot,
            userId: user.id,
            previous: running.metadata?.generatedTaskFiles,
            delegationId,
            groupId: delegationGroupId(running),
            workspaceEpoch,
            candidateMessageId: recovery.message?.id || '',
            workspaceBaseline,
          });
          const recoveryValidationTask = recovery.task?.id ? recovery.task : (primaryTask?.id ? primaryTask : null);
          const recoveryDeliveryValidation = validateDelegationDeliverable({
            store,
            task: recoveryValidationTask,
            delegation: running,
            answer: recoveryAnswer,
            workspaceRoot: taskWorkspaceRoot,
            generatedTaskFiles,
          });
          if (!recoveryValidationTask?.id && recoveryDeliveryValidation && !recoveryDeliveryValidation.passed) {
            throw deliverableValidationError(recoveryDeliveryValidation);
          }
          await syncSharedTaskWorkspaceResilient(running, user, 'push');
          const primaryNodesFinished = primaryTask?.nodes?.length
            && primaryTask.nodes.every((node) => ['completed', 'cancelled'].includes(String(node.status || '')));
          const recoveredTaskId = recovery.task?.id || (primaryNodesFinished ? primaryTask?.id || '' : '');
          if (recoveredTaskId) {
            recovery.task = store.getTaskRun(recoveredTaskId) || recovery.task;
            primaryTask = recovery.task;
          }
          attemptTaskRunIds = [...new Set([
            ...attemptTaskRunIds,
            primaryTask?.id || '',
            recovery.task?.id || '',
          ].filter(Boolean))];
          publishDelegationProgress(delegationId, {
            phase: 'awaiting_delivery',
            message: 'uBuddy 已完成接管执行和交付校验，等待接收方确认交付',
            completed: recovery.task?.nodes?.length || primaryTask?.nodes?.length || 0,
            total: recovery.task?.nodes?.length || primaryTask?.nodes?.length || 0,
            running: 0,
            waiting: 0,
            failed: 0,
            currentStep: null,
            publicFailure: null,
            terminal: false,
          });
          await flushDelegationProgress(delegationId);
          const latestRecovered = auth.agentDelegationById(delegationId) || running;
          const recovered = auth.updateAgentDelegation({
            delegationId,
            status: 'draft_ready',
            sessionId: executionSession.id,
            taskRunId: recovery.task?.id || primaryTask?.id || '',
            lastError: '',
            metadata: {
              ...(latestRecovered.metadata || {}),
              sessionId: executionSession.id,
              workspaceSessionId: executionSession.id,
              workspaceEpoch,
              threadId: recovery.threadId || '',
              answerMessageId: recovery.message?.id || '',
              preliminaryResult,
              taskWorkspaceRoot,
              generatedTaskFiles,
              ...(recoveryDeliveryValidation ? { deliverableResult: recoveryDeliveryValidation, resultState: recoveryDeliveryValidation.resultState } : {}),
              draftReadyAt: new Date().toISOString(),
              initialDraftRevisionNo: Number(latestRecovered.metadata?.initialDraftRevisionNo || latestRecovered.metadata?.intakeLatestRevisionNo || 0),
              executionRecovered: true,
              specializedExecutionError: String(specializedError?.message || specializedError).slice(0, 4000),
              activeTaskRunId: recovery.task?.id || primaryTask?.id || '',
              attemptTaskRunIds,
              executionState: 'completed',
              deliveryState: 'awaiting_delivery',
              failureCode: '',
              failureStage: '',
              retryable: false,
              executionFailureDetail: '',
            },
          });
          notifyDelegationUpdated(recovered, {
            type: 'delegation_draft_ready',
            progress: recovered.metadata?.executionProgress || null,
          });
          emitUBuddyDiagnostic('delegation_recovery_completed', {
            data: {
              delegationId,
              taskRunId: recovery.task?.id || primaryTask?.id || '',
              generatedFileCount: generatedTaskFiles.length,
              attemptTaskRunCount: attemptTaskRunIds.length,
            },
          });
          if (socialRelay.connected()) {
            await syncDelegationRemoteUpdate(delegationId, {
              status: 'draft_ready',
              sessionId: executionSession.id,
              taskRunId: recovery.task?.id || primaryTask?.id || '',
              metadata: publicAgentDelegationMetadata(recovered.metadata),
            });
            await syncDelegationWorkspaceUpdate(recovered);
          }
          return {
            ok: true,
            recovered: true,
            delegation: recovered,
            session: executionSession,
            message: recovery.message,
            answer: preliminaryResult,
            threadId: recovery.threadId,
            delegations: auth.agentDelegations({ direction: 'all' }),
            inbox: auth.socialInbox(),
          };
        } catch (recoveryError) {
          emitUBuddyDiagnostic('delegation_recovery_failed', {
            level: 'error',
            data: { delegationId },
            error: recoveryError,
          });
          error = new Error(`专业 Agent 执行失败：${specializedError?.message || specializedError}\nGeneralist 接管失败：${recoveryError?.message || recoveryError}`);
        }
        const failure = delegationExecutionFailureDetails(error);
        const publicError = failure.publicMessage;
        if (primaryTask?.id) {
          scheduler.completeTaskDeliveryValidation(primaryTask.id, {
            passed: false,
            failureCode: failure.code,
            summary: failure.privateMessage,
          });
        }
        store.addMessage({
          sessionId: executionSession.id,
          role: 'assistant',
          content: publicError,
          agentId: 'secretary_agent',
          departmentId: 'agent_delegation',
          metadata: workspaceMessageMetadata(running, workspaceEpoch, {
            executionFailed: true,
            publishCandidate: false,
            resultState: 'failed',
          }),
        });
        await flushDelegationProgress(delegationId);
        const latestFailed = auth.agentDelegationById(delegationId) || running;
        const failureStatus = failure.retryable ? 'blocked' : 'failed';
        const publicFailure = normalizeDelegationPublicFailure({
          code: failure.code,
          stage: failure.stage,
          message: publicError,
          retryable: failure.retryable,
          occurredAt: new Date().toISOString(),
        });
        const failureProgress = normalizeDelegationExecutionProgress({
          ...(latestFailed.metadata?.executionProgress || {}),
          sequence: Number(latestFailed.metadata?.executionProgress?.sequence || 0) + 1,
          phase: failureStatus,
          message: publicError,
          failed: Math.max(1, Number(latestFailed.metadata?.executionProgress?.failed || 0)),
          terminal: true,
          updatedAt: new Date().toISOString(),
        });
        const failed = auth.updateAgentDelegation({
          delegationId,
          status: failureStatus,
          sessionId: executionSession.id,
          lastError: publicError,
          metadata: {
            ...(latestFailed.metadata || {}),
            sessionId: executionSession.id,
            workspaceSessionId: executionSession.id,
            workspaceEpoch,
            failedAt: new Date().toISOString(),
            activeTaskRunId: primaryTask?.id || latestFailed.metadata?.activeTaskRunId || '',
            attemptTaskRunIds: [...new Set([...attemptTaskRunIds, primaryTask?.id || ''].filter(Boolean))],
            executionState: 'failed',
            deliveryState: 'blocked',
            failureCode: failure.code,
            failureStage: failure.stage,
            retryable: failure.retryable,
            executionFailureDetail: failure.privateMessage,
            publicFailure,
            executionProgress: failureProgress,
          },
        });
        notifyDelegationUpdated(failed, { type: 'delegation_failed', progress: failureProgress });
        emitUBuddyDiagnostic('delegation_terminal_failure', {
          level: 'error',
          data: {
            delegationId,
            taskRunId: primaryTask?.id || '',
            status: failureStatus,
            failureCode: failure.code,
            failureStage: failure.stage,
            retryable: failure.retryable,
            attemptTaskRunCount: attemptTaskRunIds.length,
          },
          error,
        });
        if (socialRelay.connected()) {
          await syncDelegationRemoteUpdate(delegationId, {
            status: failureStatus,
            lastError: publicError,
            result: publicError,
            metadata: publicAgentDelegationMetadata(failed.metadata),
          });
          await syncDelegationWorkspaceUpdate(failed);
        }
        if (!socialRelay.connected()) {
          try {
            auth.socialSendMessage({
              recipientId: delegation.requesterUserId,
              senderAgentId: delegation.recipientAgentId || 'secretary_agent',
              kind: 'agent',
              title: `${failure.retryable ? 'uBuddy 任务受阻' : '\u79d8\u4e66 Agent \u5904\u7406\u5931\u8d25'}\uff1a${delegation.title}`,
              content: publicError,
              metadata: { type: 'agent_delegation', action: failure.retryable ? 'blocked' : 'failed', delegationId, status: failure.retryable ? 'blocked' : 'failed', failureCode: failure.code },
            });
          } catch {
            // Failure notifications are best-effort.
          }
        }
        recordSecretaryDelegationFeedback(store, failed, publicError);
        triggerAutoSync(failure.retryable ? 'agent_delegation_blocked' : 'agent_delegation_failed', { delayMs: 500 });
        const publicFailureError = new Error(publicError);
        publicFailureError.delegation = failed;
        throw publicFailureError;
      }
      } finally {
        if (runtimeState.delegationProcessingLocks.get(delegationId) === processingLock) {
          runtimeState.delegationProcessingLocks.delete(delegationId);
        }
        releaseProcessing?.();
      }
    },
    async respondAgentDelegation(payload = {}) {
      const user = auth.requireUser();
      const delegationId = String(payload.delegationId || payload.id || '').trim();
      const action = String(payload.action || '').trim().toLowerCase();
      const delegation = auth.agentDelegationById(delegationId);
      if (!delegation) throw new Error('\u59d4\u6258\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u65e0\u6743\u8bbf\u95ee\u3002');
      if (delegation.recipientUserId !== user.id) throw new Error('\u53ea\u6709\u63a5\u6536\u65b9\u53ef\u4ee5\u5904\u7406\u8be5\u59d4\u6258\u3002');
      if (!['accept', 'reject', 'submit'].includes(action)) throw new Error('\u4e0d\u652f\u6301\u7684\u59d4\u6258\u64cd\u4f5c\u3002');
      const requestedAttachments = Array.isArray(payload.attachments) ? payload.attachments.slice(0, 20) : [];
      const generatedAttachmentSelection = Array.isArray(payload.selectedGeneratedAttachmentKeys)
        ? new Set(payload.selectedGeneratedAttachmentKeys.map((item) => String(item || '').trim()).filter(Boolean))
        : null;
      const generatedAttachments = action === 'submit' && Array.isArray(delegation.metadata?.generatedTaskFiles)
        ? delegation.metadata.generatedTaskFiles.filter((item) => (
            generatedAttachmentSelection === null || generatedAttachmentSelection.has(delegationAttachmentSelectionKey(item))
          ))
        : [];
      const attachments = uniqueDelegationAttachments([...requestedAttachments, ...generatedAttachments]).slice(0, 20);
      const privateNote = (String(payload.message || '').trim()
        || (action === 'submit' ? String(delegation.metadata?.preliminaryResult || '').trim() : '')
        || (attachments.length ? '\u5904\u7406\u7ed3\u679c\u4e0e\u4ea4\u4ed8\u6587\u4ef6\u89c1\u9644\u4ef6\u3002' : ''));
      const note = (action === 'submit' ? publicDelegationSubmissionText(privateNote) : privateNote).slice(0, 8000);
      if (delegation.groupId || delegation.metadata?.groupId || action === 'submit') {
        const groupAction = action === 'accept' ? 'working' : action === 'submit' ? 'submit' : 'decline';
        const sharedAttachments = action === 'submit' ? attachments.map(publicDelegationAttachment) : attachments;
        const explicitSourceWorkspaceMessageId = String(payload.sourceWorkspaceMessageId || '').trim();
        const sourceWorkspaceMessageId = action === 'submit'
          ? explicitSourceWorkspaceMessageId || `owner-submit:${sha256Text(JSON.stringify({
            delegationId,
            status: delegation.status,
            draftReadyAt: delegation.metadata?.draftReadyAt || delegation.metadata?.workspaceUpdatedAt || '',
            note,
            attachments: sharedAttachments.map((item) => ({
              id: item.remote_file_id || item.id || '',
              name: item.filename || item.name || '',
              sha256: item.sha256 || '',
              size: Number(item.size || 0),
            })),
          })).slice(0, 40)}`
          : '';
        const actionMetadata = {
          attachments: sharedAttachments,
          ...(action === 'submit' ? {
            sourceWorkspaceMessageId,
            sourceWorkspaceRevisionId: String(payload.sourceWorkspaceRevisionId || '').trim(),
            explicitlyConfirmedByOwner: payload.autoEmptyReport !== true,
            ...(payload.autoEmptyReport === true ? {
              autoEmptyReport: true,
              workDigestCoverage: payload.workDigestCoverage || {},
            } : {}),
          } : {}),
        };
        const updated = await this.collaborationTaskAction({ delegationId, action: groupAction, content: note, metadata: actionMetadata, expectedStatus: delegation.status });
        if (action === 'accept') return this.startAgentDelegation({ delegationId, execute: true, model: payload.model || '', reasoningEffort: payload.reasoningEffort || '', sandboxPermission: payload.sandboxPermission || '' });
        if (action === 'submit') {
          const latest = updated?.delegation || auth.agentDelegationByEntityId(delegationId) || delegation;
          const submittedAttachments = Array.isArray(latest.metadata?.resultAttachments)
            ? latest.metadata.resultAttachments
            : Array.isArray(latest.metadata?.attachments) ? latest.metadata.attachments : sharedAttachments;
          const secretarySessionId = String(latest.metadata?.ownerSecretarySessionId || delegation.metadata?.ownerSecretarySessionId || '');
          const queuedMessage = secretarySessionId ? store.listMessages(secretarySessionId).find((message) => (
            message.metadata?.externalDelegationId === delegationId && message.metadata?.uBuddyTaskQueued
          )) : null;
          if (queuedMessage) store.updateMessage(queuedMessage.id, {
            content: `${displayAuthUserName(latest.requester || delegation.requester)} 的任务结果已提交，正在等待对方验收。`,
            metadata: {
              ...(queuedMessage.metadata || {}), externalDelegationStatus: 'submitted',
              externalDelegationSubmittedSnapshot: {
                version: 1, content: note, attachments: submittedAttachments,
                sourceWorkspaceMessageId: actionMetadata.sourceWorkspaceMessageId,
                sourceWorkspaceRevisionId: actionMetadata.sourceWorkspaceRevisionId,
                submittedAt: latest.metadata?.resultSubmittedAt || new Date().toISOString(),
              },
            },
          });
          const workDigestJob = store.getWorkDigestJob({ delegationId });
          const submittedDigestVersionId = String(payload.sourceWorkspaceRevisionId || workDigestJob?.latestVersion?.id || '');
          if (workDigestJob?.id && submittedDigestVersionId) {
            store.markWorkDigestPublished({ jobId: workDigestJob.id, versionId: submittedDigestVersionId });
          }
        }
        return updated;
      }
      if (action === 'submit' && !note) throw new Error('\u8bf7\u5148\u586b\u5199\u5904\u7406\u7ed3\u679c\u3002');
      if (action === 'accept' && !['assigned', 'accepted', 'blocked', 'failed'].includes(delegation.status)) throw new Error('\u5f53\u524d\u4efb\u52a1\u72b6\u6001\u65e0\u6cd5\u63a5\u6536\u3002');
      if (action === 'submit' && !['running', 'draft_ready'].includes(delegation.status)) throw new Error('\u8bf7\u5148\u63a5\u6536\u4efb\u52a1\uff0c\u518d\u63d0\u4ea4\u5904\u7406\u7ed3\u679c\u3002');
      const status = action === 'accept' ? 'running' : action === 'submit' ? 'completed' : 'rejected';
      const now = new Date().toISOString();
      const acceptedPermissionMode = action === 'accept'
        ? externalDelegationPermissionMode(payload.sandboxPermission || delegation.metadata?.executionPermissionMode)
        : '';
      const permissionDeviceId = store.contextDeviceId?.() || socialRelay.status?.().deviceId || 'local';
      const permissionHistory = action === 'accept' ? [
        ...(Array.isArray(delegation.metadata?.executionPermissionHistory)
          ? delegation.metadata.executionPermissionHistory : []),
        {
          actorUserId: user.id,
          from: String(delegation.metadata?.executionPermissionMode || delegation.metadata?.remotePermissionIntent || 'full-access'),
          to: acceptedPermissionMode,
          deviceId: permissionDeviceId,
          changedAt: now,
        },
      ].slice(-20) : delegation.metadata?.executionPermissionHistory;
      const metadata = {
        ...(delegation.metadata || {}),
        workflowState: status,
        respondedByUserId: user.id,
        responseNote: note,
        humanDecision: action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : (delegation.metadata?.humanDecision || 'accepted'),
        humanAcceptedAt: action === 'accept' ? now : delegation.metadata?.humanAcceptedAt,
        resultSubmittedAt: action === 'submit' ? now : delegation.metadata?.resultSubmittedAt,
        resultSubmittedByUserId: action === 'submit' ? user.id : delegation.metadata?.resultSubmittedByUserId,
        executionState: action === 'accept' ? 'running' : action === 'submit' ? 'completed' : 'stopped',
        deliveryState: action === 'accept' ? 'executing' : action === 'submit' ? 'submitted' : 'declined',
        ...(action === 'accept' ? {
          permissionPolicyVersion: 'ubuddy_task_permission_v2',
          executionPermissionMode: acceptedPermissionMode,
          executionPermissionOwner: 'recipient',
          executionPermissionSource: acceptedPermissionMode === 'auto-approve' ? 'recipient_selected' : 'remote_default_full_access',
          executionPermissionDeviceId: permissionDeviceId,
          executionPermissionHistory: permissionHistory,
          permissionUpdatedAt: now,
          remotePermissionIntent: 'full-access',
        } : {}),
        ...(action !== 'reject' ? { failureCode: '', failureStage: '', retryable: false, executionFailureDetail: '' } : {}),
        ...(action === 'submit' && attachments.length ? { attachments, resultAttachments: attachments } : {}),
      };
      const terminalResult = action === 'submit'
        ? note
        : action === 'reject'
          ? (note || '\u63a5\u6536\u65b9\u7528\u6237\u5df2\u62d2\u7edd\u8be5\u4efb\u52a1\u3002')
          : '';
      if (socialRelay.connected()) {
        await socialRelay.updateDelegation(delegationId, {
          workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
          status,
          result: terminalResult,
          metadata: publicAgentDelegationMetadata(metadata),
        });
      } else {
        auth.updateAgentDelegation({
          delegationId,
          status,
          metadata,
          started: action === 'accept',
          completed: action === 'reject' || action === 'submit',
        });
        if (action === 'reject' || action === 'submit') {
          try {
            auth.socialSendMessage({
              recipientId: delegation.requesterUserId,
              senderAgentId: delegation.recipientAgentId || 'secretary_agent',
              recipientAgentId: delegation.senderAgentId || 'secretary_agent',
              kind: 'agent',
              title: action === 'submit' ? `\u4efb\u52a1\u7ed3\u679c\uff1a${delegation.title}` : `uBuddy \u5df2\u62d2\u7edd\u59d4\u6258\uff1a${delegation.title}`,
              content: terminalResult,
              metadata: { type: 'agent_delegation', action: status, delegationId, status, attachments },
            });
          } catch {
            // The delegation record remains authoritative.
          }
        }
      }
      triggerAutoSync(`agent_delegation_${status}`, { delayMs: 500 });
      return {
        ok: true,
        delegation: auth.agentDelegationById(delegationId),
        delegations: auth.agentDelegations({ direction: 'all' }),
        inbox: auth.socialInbox(),
      };
    },
    async pollSocialNetwork({ autoProcess = false, onProjection = null } = {}) {
      if (runtimeState.socialPollRunning) {
        const activeCompletion = runtimeState.socialPollCompletion;
        if (autoProcess && activeCompletion) {
          await activeCompletion;
          if (!runtimeState.closed) return this.pollSocialNetwork({ autoProcess: true, onProjection });
        }
        const workspaceId = activeWorkspaceId();
        return {
          skipped: true,
          reason: 'already_running',
          workspaceId,
          accountWorkspaceId: workspaceId,
          status: socialRelay.status(),
          friends: socialRelay.friendsOverviewWithCachedPresence(auth.friendsOverview({ workspaceId })),
          inbox: auth.socialInbox({ workspaceId }),
          delegations: auth.agentDelegations({ direction: 'all', workspaceId }),
          collaboration: auth.collaborationOverview({ workspaceId }),
          chatGroups: auth.chatGroupsOverview({ workspaceId }),
        };
      }
      runtimeState.socialPollRunning = true;
      const pollCompletion = new Promise((resolve) => { runtimeState.resolveSocialPollCompletion = resolve; });
      runtimeState.socialPollCompletion = pollCompletion;
      try {
        const activePollWorkspaceId = activeWorkspaceId();
        const publishProjection = (projection = {}) => {
          if (typeof onProjection !== 'function') return;
          try {
            onProjection({
              ...(projection || {}),
              workspaceId: activePollWorkspaceId,
              accountWorkspaceId: activePollWorkspaceId,
              status: socialRelay.status(),
              friends: projection?.friends || socialRelay.friendsOverviewWithCachedPresence(
                auth.friendsOverview({ workspaceId: activePollWorkspaceId }),
              ),
              inbox: auth.socialInbox({ workspaceId: activePollWorkspaceId }),
              delegations: auth.agentDelegations({ direction: 'all', workspaceId: activePollWorkspaceId }),
              collaboration: projection?.collaboration || auth.collaborationOverview({ workspaceId: activePollWorkspaceId }),
              chatGroups: projection?.chatGroups || auth.chatGroupsOverview({ workspaceId: activePollWorkspaceId }),
              projectionOnly: true,
            });
          } catch (error) {
            emitUBuddyDiagnostic('social_projection_publish_failed', { level: 'warn', error });
          }
        };
        const result = await socialRelay.poll({
          workspaceId: activePollWorkspaceId,
          onCollaborationProjection: publishProjection,
        });
        publishProjection(result);
        const currentUser = auth.currentUser();
        socialRelay.mergeDelegationTasks(result?.allWorkspaceCollaboration?.tasks || result?.collaboration?.tasks || []);
        for (const delegation of auth.agentDelegationsAllWorkspaces({ direction: 'incoming', limit: 200 })) {
          if (!['withdrawn', 'closed'].includes(delegation.status) || delegation.recipientUserId !== currentUser?.id) continue;
          const taskRunIds = [...new Set([
            delegation.taskRunId,
            delegation.task_run_id,
            delegation.metadata?.activeTaskRunId,
          ].map((item) => String(item || '').trim()).filter(Boolean))];
          for (const taskRunId of taskRunIds) {
            const task = store.getTaskRun(taskRunId);
            if (!task || task.ownerUserId !== currentUser.id || ['completed', 'failed', 'cancelled'].includes(String(task.status || ''))) continue;
            try { this.cancelTaskRun({ taskRunId }); } catch { /* The remote terminal status remains authoritative. */ }
          }
        }
        const uBuddyDispatchRecovery = autoProcess && socialRelay.connected()
          ? await recoverPendingUBuddyDispatches({ expeditePresence: true })
          : null;
        if (socialRelay.connected()) {
          await drainPendingDelegationRemoteUpdates();
          const directInbox = auth.socialInboxAllWorkspaces({ limit: 5000 });
          const incomingDirectMessageIds = new Set((result?.incomingMessages || []).map((message) => String(message?.id || '')).filter(Boolean));
          const directWorkspaceIds = new Set([
            activePollWorkspaceId,
            ...directInbox.map((message) => message.workspaceId || message.accountWorkspaceId || 'workspace_personal'),
            ...(result?.incomingMessages || []).map((message) => message.workspaceId || message.accountWorkspaceId || 'workspace_personal'),
          ]);
          for (const workspaceId of directWorkspaceIds) {
            const scope = {
              userId: currentUser?.id || '',
              workspaceId,
              automationType: 'direct_ubuddy_reply',
              scopeId: 'workspace',
            };
            const workspaceMessages = directInbox.filter((message) => (
              (message.workspaceId || message.accountWorkspaceId || 'workspace_personal') === workspaceId
            ));
            if (result?.historyCatchUp) {
              socialAutomationLedger.recordBaseline(scope, workspaceMessages);
              continue;
            }
            if (!socialAutomationLedger.scopeInitialized(scope)) {
              socialAutomationLedger.recordBaseline(
                scope,
                workspaceMessages.filter((message) => !incomingDirectMessageIds.has(String(message?.id || ''))),
              );
              socialAutomationLedger.markScopeInitialized(scope);
            }
          }
          for (const message of result?.incomingMessages || []) {
            if (message.senderAgentId || message.metadata?.type !== 'direct_message') continue;
            const automationIdentity = {
              userId: currentUser?.id || '',
              workspaceId: message.workspaceId || message.accountWorkspaceId || 'workspace_personal',
              automationType: 'direct_ubuddy_reply',
              scopeId: 'workspace',
              sourceMessageId: message.id,
            };
            if (socialAutomationLedger.hasProcessed(automationIdentity)) continue;
            const directlyMentioned = normalizeMentionEntities(message.metadata?.mentions, { content: message.content, requirePicker: true }).some((mention) => mention.principalType === 'ubuddy' && mention.ownerUserId === currentUser?.id);
            if (!directlyMentioned) {
              socialAutomationLedger.markProcessed(automationIdentity, 'inspected');
              continue;
            }
            const conversation = auth.socialConversation({ peerId: message.senderUserId, workspaceId: message.workspaceId || message.accountWorkspaceId });
            if (conversation.some((candidate) => candidate.senderUserId === currentUser?.id && candidate.senderAgentId === 'secretary_agent' && candidate.metadata?.inReplyTo === message.id)) {
              socialAutomationLedger.markProcessed(automationIdentity, 'already_replied');
              continue;
            }
            const sharedContext = conversation.slice(-20).map((item) => ({
              content: `${item.senderUserId === currentUser?.id ? displayAuthUserName(currentUser) : displayAuthUserName(message.sender)}：${item.content || ''}`,
              metadata: item.metadata || {},
            }));
            const processedReply = await this.processAgentDelegationContent({
              phase: 'reply',
              content: `请仅依据共享私聊上下文回答这次对 uBuddy 的提及：${message.content || ''}`,
              contextMessages: sharedContext,
            });
            const replyBody = String(processedReply?.content || '').trim() || '我已收到这次提及，并结合共享私聊上下文完成整理。';
            try {
              await socialRelay.sendMessage({
                workspaceId: message.workspaceId || message.accountWorkspaceId,
                recipientId: message.senderUserId,
                senderAgentId: 'secretary_agent',
                kind: 'agent',
                content: `我是 ${displayAuthUserName(currentUser)} 的 uBuddy。${replyBody}\n\n我只使用了这段共享私聊；正式任务和承诺仍需用户确认。`,
                metadata: { type: 'ubuddy_context_reply', inReplyTo: message.id, publicContextOnly: true, ubuddyProcessingMode: processedReply?.mode || 'fallback' },
              });
              socialAutomationLedger.markProcessed(automationIdentity);
            } catch {
              // Keep the source message unprocessed so a later poll can retry.
            }
          }
          const chatGroupScanScope = {
            userId: currentUser?.id || '',
            workspaceId: activePollWorkspaceId,
            automationType: 'chat_group_ubuddy_reply_scan',
            scopeId: 'workspace',
          };
          const chatGroupScanInitialized = socialAutomationLedger.scopeInitialized(chatGroupScanScope);
          for (const group of result?.chatGroups?.groups || []) {
            if (String(group.status || 'active') !== 'active') continue;
            const detail = await socialRelay.chatGroup(group.id, {
              workspaceId: group.workspaceId || group.accountWorkspaceId,
            }).catch(() => null);
            if (!detail) continue;
            const groupAutomationScope = {
              userId: currentUser?.id || '',
              workspaceId: group.workspaceId || group.accountWorkspaceId || activePollWorkspaceId,
              automationType: 'chat_group_ubuddy_reply',
              scopeId: group.id,
            };
            if (!socialAutomationLedger.scopeInitialized(groupAutomationScope)) {
              if (!chatGroupScanInitialized || !socialAutomationScopeIsFresh(group)) {
                socialAutomationLedger.establishScopeBaseline(groupAutomationScope, detail.messages || []);
                continue;
              }
              socialAutomationLedger.markScopeInitialized(groupAutomationScope);
            }
            for (const message of (detail.messages || []).slice(-60)) {
              if (message.senderAgentId || message.sender_agent_id) continue;
              const automationIdentity = { ...groupAutomationScope, sourceMessageId: message.id };
              if (socialAutomationLedger.hasProcessed(automationIdentity)) continue;
              if (message.metadata?.uBuddyMultiMention?.classification === 'multi_task') {
                const workflowUpdates = (detail.messages || []).filter((candidate) => (
                  candidate.metadata?.type === 'ubuddy_multi_task_status'
                  && String(candidate.metadata?.sourceMessageId || '') === String(message.id || '')
                ));
                const latestWorkflow = workflowUpdates.at(-1);
                const workflowStatus = String(latestWorkflow?.metadata?.status || '');
                const stillFresh = Date.now() - Date.parse(message.createdAt || message.created_at || 0) < 120_000;
                if (!latestWorkflow && stillFresh) continue;
                if (['planning', 'retry_wait', 'confirmation_required', 'action_required', 'dispatched'].includes(workflowStatus)) continue;
              }
              const mentioned = normalizeMentionEntities(message.metadata?.mentions, {
                content: message.content,
                requirePicker: true,
              }).some((mention) => mention.principalType === 'ubuddy' && mention.ownerUserId === currentUser?.id);
              if (!mentioned) {
                socialAutomationLedger.markProcessed(automationIdentity, 'inspected');
                continue;
              }
              const alreadyReplied = (detail.messages || []).some((candidate) => (
                candidate.senderUserId === currentUser?.id
                && candidate.senderAgentId === 'secretary_agent'
                && candidate.metadata?.inReplyTo === message.id
              ));
              if (alreadyReplied) {
                socialAutomationLedger.markProcessed(automationIdentity, 'already_replied');
                continue;
              }
              const publicContext = (detail.messages || []).slice(-30).map((item) => ({
                content: `${displayAuthUserName(item.sender)}${item.senderAgentId ? '的 uBuddy' : ''}：${item.content || ''}`,
                metadata: item.metadata || {},
              }));
              const processedReply = await this.processAgentDelegationContent({
                phase: 'reply',
                content: `请仅依据普通多人群聊的公开上下文回答这次对 uBuddy 的提及：${message.content || ''}。不要访问用户私人 Memory，也不要代替用户作出正式承诺。`,
                contextMessages: publicContext,
              });
              const replyBody = String(processedReply?.content || '').trim()
                || '我已收到这次提及，并结合群聊公开上下文完成整理。';
              try {
                await socialRelay.sendChatGroupMessage(group.id, {
                  workspaceId: group.workspaceId || group.accountWorkspaceId,
                  senderAgentId: 'secretary_agent',
                  kind: 'agent',
                  content: `我是 ${displayAuthUserName(currentUser)} 的 uBuddy。${replyBody}\n\n我只使用了当前群聊的公开内容；正式任务会进入任务群或委托链路执行。`,
                  metadata: {
                    type: 'ubuddy_context_reply',
                    inReplyTo: message.id,
                    publicContextOnly: true,
                    ubuddyProcessingMode: processedReply?.mode || 'fallback',
                  },
                });
                socialAutomationLedger.markProcessed(automationIdentity);
              } catch {
                // Keep the source message unprocessed so a later poll can retry.
              }
            }
          }
          socialAutomationLedger.markScopeInitialized(chatGroupScanScope);
          const collaborationGroupScanWorkspaces = new Map();
          for (const group of result?.allWorkspaceCollaboration?.groups || result?.collaboration?.groups || []) {
            if (group.status === 'closed') continue;
            const detail = await socialRelay.collaborationGroup(group.id, { workspaceId: group.workspaceId || group.accountWorkspaceId }).catch(() => null);
            if (!detail) continue;
            const ownTasks = (detail.tasks || []).filter((task) => (task.recipientUserId || task.recipient_user_id) === currentUser?.id);
            const groupAutomationScope = {
              userId: currentUser?.id || '',
              workspaceId: group.workspaceId || group.accountWorkspaceId || activePollWorkspaceId,
              automationType: 'collaboration_group_ubuddy_reply',
              scopeId: group.id,
            };
            const collaborationGroupScanScope = {
              userId: currentUser?.id || '',
              workspaceId: groupAutomationScope.workspaceId,
              automationType: 'collaboration_group_ubuddy_reply_scan',
              scopeId: 'workspace',
            };
            const collaborationGroupScanInitialized = socialAutomationLedger.scopeInitialized(collaborationGroupScanScope);
            collaborationGroupScanWorkspaces.set(groupAutomationScope.workspaceId, collaborationGroupScanScope);
            if (!socialAutomationLedger.scopeInitialized(groupAutomationScope)) {
              if (!collaborationGroupScanInitialized || !socialAutomationScopeIsFresh(group)) {
                socialAutomationLedger.establishScopeBaseline(groupAutomationScope, detail.messages || []);
                continue;
              }
              socialAutomationLedger.markScopeInitialized(groupAutomationScope);
            }
            if (String(group.ownerUserId || '') === String(currentUser?.id || '')) {
              for (const task of detail.tasks || []) {
                const existingSummaries = (detail.messages || []).filter((message) => (
                  message.metadata?.type === 'ubuddy_task_summary'
                  && String(message.metadata?.taskId || '') === String(task.id || '')
                ));
                const stage = taskSummaryStage(task, detail.messages || []);
                const lastStage = String(existingSummaries.at(-1)?.metadata?.stage || '');
                if (!stage || stage === lastStage) continue;
                const summary = taskSummaryPayload(task, stage, existingSummaries.length + 1);
                const summaryEventId = `task-summary:${task.id}:${stage}:${summary.metadata.sourceCursor}`.slice(0, 240);
                try {
                  const published = await socialRelay.sendCollaborationMessage(group.id, {
                    workspaceId: group.workspaceId || group.accountWorkspaceId,
                    sourceEventId: summaryEventId,
                    senderAgentId: 'secretary_agent',
                    kind: 'agent',
                    content: summary.content,
                    metadata: { ...summary.metadata, sourceEventId: summaryEventId },
                  });
                  detail.messages = published?.messages || [...(detail.messages || []), {
                    id: summaryEventId, senderUserId: currentUser.id, senderAgentId: 'secretary_agent',
                    kind: 'agent', content: summary.content, metadata: summary.metadata,
                  }];
                } catch {
                  // A later poll retries the same deterministic stage transition.
                }
              }
            }
            for (const task of detail.tasks || []) {
              if (String(task.recipientUserId || task.recipient_user_id || '') !== String(currentUser?.id || '')) continue;
              const participant = [task.requesterUserId || task.requester_user_id, task.recipientUserId || task.recipient_user_id]
                .map((item) => String(item || '')).filter(Boolean);
              if (!participant.includes(String(currentUser?.id || ''))) continue;
              const targetOwnerUserId = participant.find((item) => item !== String(currentUser?.id || '')) || '';
              const coordinationRequest = taskCoordinationRequest(task);
              if (!targetOwnerUserId || !coordinationRequest) continue;
              const recentThread = (detail.messages || []).findLast((message) => (
                message.metadata?.type === 'ubuddy_peer_coordination'
                && String(message.metadata?.taskId || '') === String(task.id || '')
                && String(message.metadata?.coordinationReason || '') === coordinationRequest.reason
                && Date.now() - Date.parse(message.createdAt || message.created_at || 0) < 60 * 60_000
              ));
              if (recentThread) continue;
              const threadId = `ubuddy-thread:${task.id}:${coordinationRequest.sourceCursor}`;
              const sourceEventId = `peer-coordination:${task.id}:${coordinationRequest.reason}:${coordinationRequest.sourceCursor}`.slice(0, 240);
              const targetName = displayAuthUserName((detail.members || []).find((member) => member.userId === targetOwnerUserId)?.user || {}) || '协作成员';
              try {
                const published = await socialRelay.sendCollaborationMessage(group.id, {
                  workspaceId: group.workspaceId || group.accountWorkspaceId,
                  sourceEventId,
                  senderAgentId: 'secretary_agent', kind: 'agent',
                  content: `@${targetName}的uBuddy 当前任务“${task.title || '协作任务'}”需要对齐：${coordinationRequest.summary}。请同步相关进展、可用输入和下一步。`,
                  metadata: {
                    type: 'ubuddy_peer_coordination', sourceEventId, threadId, turn: 1, taskId: task.id || '',
                    targetOwnerUserId, publicContextOnly: true, coordinationReason: coordinationRequest.reason,
                    replyStatus: 'queued', coordinationComplete: false,
                    mentions: [{ principalType: 'ubuddy', ownerUserId: targetOwnerUserId, source: 'automation', displayText: `@${targetName}的uBuddy` }],
                  },
                });
                detail.messages = published?.messages || detail.messages;
              } catch {
                // The deterministic source event is retried after relay recovery.
              }
            }
            for (const message of (detail.messages || []).slice(-60)) {
              const sourceAgentId = String(message.senderAgentId || message.sender_agent_id || '');
              const coordination = message.metadata?.type === 'ubuddy_peer_coordination';
              const coordinationTargeted = coordination
                && String(message.metadata?.targetOwnerUserId || '') === String(currentUser?.id || '');
              if (sourceAgentId && !coordinationTargeted) continue;
              const automationIdentity = { ...groupAutomationScope, sourceMessageId: message.id };
              if (socialAutomationLedger.hasProcessed(automationIdentity)) continue;
              const mentioned = coordinationTargeted || normalizeMentionEntities(message.metadata?.mentions, { content: message.content, requirePicker: true })
                .some((mention) => mention.principalType === 'ubuddy' && mention.ownerUserId === currentUser?.id);
              if (!mentioned) {
                socialAutomationLedger.markProcessed(automationIdentity, 'inspected');
                continue;
              }
              const alreadyReplied = (detail.messages || []).some((candidate) => candidate.senderUserId === currentUser?.id
                && candidate.senderAgentId === 'secretary_agent' && candidate.metadata?.inReplyTo === message.id
                && (!coordination || candidate.metadata?.type === 'ubuddy_peer_coordination'));
              if (alreadyReplied) {
                socialAutomationLedger.markProcessed(automationIdentity, 'already_replied');
                continue;
              }
              if (coordinationTargeted) {
                const receiptEventId = `peer-receipt:${message.id}:processing`.slice(0, 240);
                try {
                  const receiptResult = await socialRelay.sendCollaborationMessage(group.id, {
                    workspaceId: group.workspaceId || group.accountWorkspaceId,
                    sourceEventId: receiptEventId,
                    senderAgentId: 'secretary_agent', kind: 'agent',
                    content: 'uBuddy 已收到工作对齐请求。',
                    metadata: {
                      type: 'ubuddy_peer_coordination_receipt', sourceEventId: receiptEventId,
                      inReplyTo: message.id, threadId: message.metadata?.threadId || '', taskId: message.metadata?.taskId || '',
                      receiptStatus: 'processing', targetOwnerUserId: message.senderUserId || message.sender_user_id || '', publicContextOnly: true,
                    },
                  });
                  detail.messages = receiptResult?.messages || detail.messages;
                } catch {
                  // The visible reply remains authoritative if the lightweight receipt cannot be persisted.
                }
              }
              const referencedTaskId = String(message.metadata?.taskId || '');
              const task = (detail.tasks || []).find((item) => String(item.id || '') === referencedTaskId)
                || ownTasks.find((item) => !['closed', 'withdrawn'].includes(String(item.status || ''))) || ownTasks[0];
              const threadId = String(message.metadata?.threadId || `ubuddy-thread:${message.id}`);
              const threadMessages = (detail.messages || []).filter((item) => (
                String(item.metadata?.threadId || '') === threadId
                && item.metadata?.type === 'ubuddy_peer_coordination'
              ));
              const turn = Math.max(Number(message.metadata?.turn || 1) + 1, threadMessages.length + 1);
              if (coordination && (message.metadata?.coordinationComplete === true || turn > 6)) {
                socialAutomationLedger.markProcessed(automationIdentity, 'thread_complete');
                continue;
              }
              const statusText = collaborationTaskStatusReply(task?.status || 'assigned');
              const publicContext = (detail.messages || []).filter((item) => !item.metadata?.privateTaskWorkspace).slice(-30).map((item) => ({
                content: `${displayAuthUserName(item.sender)}${item.senderAgentId ? '的 uBuddy' : ''}：${item.content || ''}`,
                metadata: item.metadata || {},
              }));
              const processedReply = await this.processAgentDelegationContent({
                phase: 'reply',
                content: coordination
                  ? `请仅依据任务群公开上下文，与对方 uBuddy 对齐工作依赖。回答这条消息：${message.content || ''}\n当前相关任务状态：${statusText}。简洁说明已对齐内容、仍需确认的差异和下一步；不要代替用户作正式承诺。`
                  : `请仅依据任务群公开上下文回答这次提及：${message.content || ''}\n当前相关任务状态：${statusText}。不要代替用户做正式承诺。`,
                contextMessages: publicContext,
              });
              const replyBody = String(processedReply?.content || '').trim() || `我已结合群聊公开上下文收到这条消息；当前相关任务${statusText}。`;
              try {
                await socialRelay.sendCollaborationMessage(group.id, {
                  workspaceId: group.workspaceId || group.accountWorkspaceId,
                  senderAgentId: 'secretary_agent',
                  kind: 'agent',
                  content: `我是 ${displayAuthUserName(currentUser)} 的 uBuddy。${replyBody}\n\n正式结果或承诺仍会由用户确认后提交。`,
                  metadata: coordination ? {
                    type: 'ubuddy_peer_coordination', inReplyTo: message.id, threadId, turn,
                    taskId: task?.id || message.metadata?.taskId || '', targetOwnerUserId: message.senderUserId || message.sender_user_id || '',
                    publicContextOnly: true, coordinationReason: message.metadata?.coordinationReason || 'work_alignment',
                    coordinationComplete: turn >= 6, replyStatus: turn >= 6 ? 'stopped' : 'replied',
                    ubuddyProcessingMode: processedReply?.mode || 'fallback',
                    mentions: [{ principalType: 'ubuddy', ownerUserId: message.senderUserId || message.sender_user_id || '', source: 'automation' }],
                  } : { type: 'ubuddy_context_reply', inReplyTo: message.id, taskId: task?.id || '', publicContextOnly: true, ubuddyProcessingMode: processedReply?.mode || 'fallback' },
                });
                socialAutomationLedger.markProcessed(automationIdentity);
              } catch {
                // Keep the source message unprocessed so a later poll can retry.
              }
            }
          }
          if (!collaborationGroupScanWorkspaces.size) {
            collaborationGroupScanWorkspaces.set(activePollWorkspaceId, {
              userId: currentUser?.id || '',
              workspaceId: activePollWorkspaceId,
              automationType: 'collaboration_group_ubuddy_reply_scan',
              scopeId: 'workspace',
            });
          }
          for (const scope of collaborationGroupScanWorkspaces.values()) socialAutomationLedger.markScopeInitialized(scope);
          for (const delegation of auth.agentDelegationsAllWorkspaces({ direction: 'all', limit: 500 })) {
            if (['closed', 'withdrawn', 'declined', 'rejected'].includes(String(delegation.status || ''))) continue;
            const needsWorkspaceIngress = Boolean(delegation.metadata?.draftReadyAt)
              || ['draft_ready', 'revision_requested', 'submitted', 'result_accepted'].includes(String(delegation.status || ''));
            if (!needsWorkspaceIngress) continue;
            const remoteWorkspace = await socialRelay.delegationWorkspace(delegation.id, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }).catch(() => null);
            const workspaceItems = Array.isArray(remoteWorkspace?.items) ? remoteWorkspace.items : [];
            if (delegation.recipientUserId === currentUser?.id && delegation.status === 'draft_ready') {
              const candidate = [...workspaceItems].reverse().find((message) => (
                message.role === 'assistant' && message.metadata?.publishCandidate
              )) || null;
              const submissionText = publicDelegationSubmissionText(
                delegationCandidateSubmissionText(candidate || {}) || delegation.metadata?.preliminaryResult,
              ).slice(0, 8000);
              if (candidate && submissionText) {
                const candidateIndex = workspaceItems.findIndex((message) => message.id === candidate.id);
                const generatedFiles = uniqueDelegationAttachments(workspaceItems.slice(Math.max(0, candidateIndex + 1))
                  .filter((message) => message.metadata?.generatedTaskFiles)
                  .flatMap((message) => Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : []));
                const deliveryDraft = {
                  version: 1,
                  candidateMessageId: candidate.id || '',
                  candidateRevisionId: delegationCandidateRevisionId(candidate),
                  submissionText,
                  attachments: generatedFiles.map(privateExternalDeliveryAttachment),
                  updatedAt: candidate.updatedAt || candidate.updated_at || candidate.createdAt || candidate.created_at || new Date().toISOString(),
                };
                const notice = this.ensureExternalDelegationNotice({ delegation });
                const currentDescriptor = notice?.message?.metadata?.externalDelegationDeliveryDraft || null;
                const attachmentKeys = (value = []) => value.map((item) => delegationAttachmentSelectionKey(item)).filter(Boolean).join('|');
                if (notice?.message?.id && (currentDescriptor?.candidateMessageId !== deliveryDraft.candidateMessageId
                  || currentDescriptor?.candidateRevisionId !== deliveryDraft.candidateRevisionId
                  || currentDescriptor?.submissionText !== deliveryDraft.submissionText
                  || attachmentKeys(currentDescriptor?.attachments || []) !== attachmentKeys(deliveryDraft.attachments))) {
                  store.updateMessage(notice.message.id, {
                    content: `${displayAuthUserName(delegation.requester)} 的任务已经完成，等待你确认后交付给对方。`,
                    metadata: {
                      ...(notice.message.metadata || {}), terminal: true, processOnly: true,
                      externalDelegationStatus: 'draft_ready', externalDelegationPublishMessageId: candidate.id || '',
                      externalDelegationDeliveryDraft: deliveryDraft,
                    },
                  });
                }
                if (!delegation.metadata?.preliminaryResult || !delegation.metadata?.draftReadyAt) auth.updateAgentDelegation({
                  delegationId: delegation.id,
                  workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
                  metadata: {
                    ...(delegation.metadata || {}), preliminaryResult: submissionText,
                    draftReadyAt: delegation.metadata?.draftReadyAt || deliveryDraft.updatedAt,
                    ownerConfirmationRequired: true, deliveryState: 'awaiting_delivery',
                  },
                });
              }
            }
            const ingressMessages = workspaceItems.filter((message) => message.role === 'system'
              && ['task_assigned', 'group_message_ingress', 'requirements_update', 'result_submitted', 'revision_requested', 'result_accepted'].includes(String(message.metadata?.type || ''))
              && String(message.sourceEventId || message.metadata?.sourceEventId || '').trim());
            const respondedSourceEventIds = new Set(workspaceItems.flatMap((message) => [
              message.metadata?.responseToSourceEventId,
              ...(Array.isArray(message.metadata?.responseToSourceEventIds) ? message.metadata.responseToSourceEventIds : []),
            ].map((item) => String(item || '').trim()).filter(Boolean)));
            const initialDraftRevisionNo = Number(delegation.metadata?.initialDraftRevisionNo || 0);
            const pendingIngress = ingressMessages.filter((ingress) => {
              const sourceEventId = String(ingress.sourceEventId || ingress.metadata?.sourceEventId || '').trim();
              if (!sourceEventId || respondedSourceEventIds.has(sourceEventId)) return false;
              const type = String(ingress.metadata?.type || '');
              if (type === 'task_assigned') return false;
              if (['requirements_update', 'group_message_ingress', 'revision_requested'].includes(type)) {
                const revisionNo = Number(ingress.metadata?.revisionNo || ingress.metadata?.revision_no || 0);
                if (!delegation.metadata?.draftReadyAt && ['assigned', 'accepted', 'preparing', 'awaiting_approval', 'running'].includes(String(delegation.status || ''))) return false;
                if (revisionNo && revisionNo <= initialDraftRevisionNo) return false;
              }
              return true;
            });
            const requirementIngress = pendingIngress.filter((ingress) => ['requirements_update', 'group_message_ingress', 'revision_requested'].includes(String(ingress.metadata?.type || '')));
            const ingressBatches = [
              ...(requirementIngress.length ? [requirementIngress] : []),
              ...pendingIngress.filter((ingress) => !requirementIngress.includes(ingress)).map((ingress) => [ingress]),
            ];
            for (const batch of ingressBatches) {
              const ingress = batch.at(-1);
              const ingressSourceEventIds = batch.map((item) => String(item.sourceEventId || item.metadata?.sourceEventId || '').trim()).filter(Boolean);
              const responseSourceEventId = `response:${sha256Text(ingressSourceEventIds.join('|')).slice(0, 40)}`;
              const priorContext = workspaceItems
                .filter((message) => new Date(message.createdAt || 0) <= new Date(ingress.createdAt || 0))
                .slice(-30)
                .map((message) => ({ content: `${message.role === 'user' ? '用户' : message.role === 'assistant' ? '我的uBuddy' : '公开任务更新'}：${message.content || ''}`, metadata: message.metadata || {} }));
              const consolidatedIngress = batch.length === 1 ? ingress : {
                ...ingress,
                content: batch.map((item, index) => `${index + 1}. ${item.content || ''}`).join('\n'),
                metadata: { ...(ingress.metadata || {}), type: 'requirements_update', consolidated: true },
              };
              let reply = '';
              let processingMode = 'fallback';
              try {
                const processed = await this.processAgentDelegationContent({
                  delegationId: delegation.id,
                  phase: 'reply',
                  content: buildPrivateIngressProcessingRequest(delegation, consolidatedIngress),
                  attachments: batch.flatMap((item) => Array.isArray(item.metadata?.attachments) ? item.metadata.attachments : []),
                  contextMessages: priorContext,
                });
                reply = String(processed?.content || '').trim();
                processingMode = processed?.mode || 'model';
              } catch {
                // Persist one deterministic own-uBuddy reply when the model is temporarily unavailable.
              }
              reply ||= deterministicPrivateIngressReply(consolidatedIngress);
              const offerDecision = batch.some((item) => ['requirements_update', 'group_message_ingress', 'revision_requested'].includes(String(item.metadata?.type || '')));
              if (offerDecision && delegation.taskRunId && store.getTaskRun(delegation.taskRunId)) {
                try {
                  const task = store.getTaskRun(delegation.taskRunId);
                  const candidates = task.metadata?.candidateSnapshots?.length
                    ? task.metadata.candidateSnapshots
                    : buildUBuddyPlannerCandidates({
                        store,
                        org,
                        userId: currentUser?.id || '',
                        performanceForAgent: (agentInstanceId) => cloudSync.stage8Projection(`performance:${agentInstanceId}`)?.payload || null,
                        leadershipForAgent: (agentInstanceId) => {
                          const projection = cloudSync.stage8Projection(`leadership:${agentInstanceId}`);
                          const leadership = projection?.payload || null;
                          const approvedTrial = (cloudSync.stage8Projection(`leadership_actions:${agentInstanceId}`)?.payload || [])
                            .find((item) => item.action === 'trial_approved' && item.status === 'approved');
                          return leadership ? { ...leadership, approvedTrial, projectionUpdatedAt: projection.updatedAt || '' } : null;
                        },
                      });
                  let proposal = null;
                  try {
                    proposal = await proposeUBuddyTaskGraph({
                      prompt: `${task.prompt}\n\nNew requirements:\n${consolidatedIngress.content || ''}`,
                      candidates,
                      root: runtimeRoot,
                      cwd: task.metadata?.workspaceRoot || runtimeRoot,
                      executionContext: {
                        store,
                        userId: currentUser?.id || task.ownerUserId || 'local_admin',
                        conversationId: delegation.sessionId || '',
                        taskRunId: task.id,
                        departmentId: 'secretary_department',
                        agentId: 'secretary_agent',
                        executionKind: 'ubuddy_task_graph_revision',
                      },
                    });
                  } catch {
                    const fallback = selectBestUBuddyCandidate(candidates, { departmentId: task.departmentId, prompt: consolidatedIngress.content || task.prompt });
                    if (fallback) proposal = { nodes: [{
                      localId: 'revision_final', title: 'Revised task delivery',
                      objective: `Revise the existing deliverable to satisfy these requirements:\n${consolidatedIngress.content || ''}`,
                      agentId: fallback.agentId, dependencies: [], outputFormat: 'complete revised deliverable with change summary',
                      isFinal: true, priority: 90, estimatedMinutes: 30,
                    }] };
                  }
                  if (proposal) {
                    scheduler.applyUBuddyTaskGraphRevision(task.id, proposal, { reason: consolidatedIngress.content || 'Task requirements changed.' });
                    let revisedTask = store.getTaskRun(task.id);
                    for (let wave = 0; wave < 12 && store.readyTaskNodes(task.id).length; wave += 1) {
                      revisedTask = await scheduler.runReadyNodes(task.id, { maxParallel: Math.min(3, store.readyTaskNodes(task.id).length) });
                    }
                    const finalNode = (revisedTask.nodes || []).filter((node) => node.status === 'completed').at(-1);
                    if (finalNode?.resultText) {
                      reply = finalNode.resultText;
                      processingMode = proposal.mode === 'model' ? 'model_revision' : 'fallback_revision';
                      auth.updateAgentDelegation({
                        delegationId: delegation.id,
                        status: 'draft_ready',
                        taskRunId: task.id,
                        metadata: { ...(delegation.metadata || {}), preliminaryResult: reply, draftReadyAt: new Date().toISOString(), taskGraphRevisionId: revisedTask.revisions?.at(-1)?.id || '' },
                      });
                      await socialRelay.updateDelegation(delegation.id, {
                        workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
                        status: 'draft_ready',
                        taskRunId: task.id,
                      }).catch(() => null);
                    }
                  }
                } catch (error) {
                  emitUBuddyDiagnostic('ubuddy_delegation_revision_processing_failed', {
                    level: 'warn',
                    data: { delegationId: delegation.id, taskRunId: delegation.taskRunId || '' },
                    error,
                  });
                  // A revision planning failure leaves the deterministic private reply path available.
                }
              }
              if (offerDecision) reply = appendDelegationDecisionPrompt(reply, delegation);
              await socialRelay.sendDelegationWorkspaceMessage(delegation.id, {
                workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
                clientMessageId: `workspace_${sha256Text(responseSourceEventId).slice(0, 32)}`,
                role: 'assistant',
                content: reply,
                sourceEventId: responseSourceEventId,
                metadata: {
                  delegationId: delegation.id,
                  privateTaskWorkspace: true,
                  workspaceEpoch: delegationWorkspaceEpoch(delegation),
                  type: 'ubuddy_ingress_response',
                  responseType: 'ubuddy_update',
                  sourceEventId: responseSourceEventId,
                  responseToSourceEventId: ingressSourceEventIds.at(-1) || '',
                  responseToSourceEventIds: ingressSourceEventIds,
                  responseToSourceGroupMessageId: ingress.sourceGroupMessageId || ingress.metadata?.sourceGroupMessageId || '',
                  processedByOwnUBuddy: true,
                  publishCandidate: offerDecision && processingMode === 'model_revision' && Boolean(reply),
                  awaitingOwnerDecision: offerDecision,
                  consolidated: batch.length > 1,
                  ubuddyProcessingMode: processingMode,
                },
              }).catch(() => null);
            }
          }
        }
          const autoStartPreparedIncomingDelegation = (candidate = null) => {
            const activeUser = auth.currentUser();
            const blockedReason = !autoProcess ? 'auto_process_disabled'
              : !candidate?.id ? 'delegation_missing'
                : candidate.metadata?.intakeStatus !== 'completed' ? 'intake_incomplete'
                  : candidate.metadata?.dependencyState === 'waiting' ? 'dependency_waiting'
                    : candidate.metadata?.draftReadyAt ? 'draft_already_ready'
                      : ['awaiting_owner_supplement', 'draft_ready'].includes(candidate.metadata?.workDigestState) ? 'work_digest_waiting'
                        : !['accepted', 'preparing', 'awaiting_approval'].includes(String(candidate.status || '')) ? 'status_not_startable'
                          : activeUser?.id !== candidate.recipientUserId ? 'recipient_mismatch'
                            : runtimeState.autoProcessingDelegations.has(candidate.id) ? 'already_processing'
                              : '';
            if (blockedReason) {
              emitUBuddyDiagnostic('ubuddy_delegation_auto_start_skipped', {
                data: {
                  delegationId: candidate?.id || '', reason: blockedReason,
                  status: candidate?.status || '', intakeStatus: candidate?.metadata?.intakeStatus || '',
                },
              });
              return false;
            }
            runtimeState.autoProcessingDelegations.add(candidate.id);
            emitUBuddyDiagnostic('ubuddy_delegation_auto_start_scheduled', {
              data: { delegationId: candidate.id, taskKind: candidate.metadata?.taskKind || 'general' },
            });
            const recentWorkReport = String(candidate.metadata?.taskKind || '') === 'recent_work_report';
            const recentWorkEnabled = uBuddyFeatureFlags?.snapshot?.({
              userId: activeUser?.id || '',
              workspaceId: candidate.workspaceId || candidate.accountWorkspaceId || '',
            })?.recentWorkReportingV1 === true;
            (recentWorkReport
              ? recentWorkEnabled
                ? this.prepareRecentWorkDigest({ delegationId: candidate.id })
                : Promise.reject(recentWorkReportingDisabledError())
              : this.startAgentDelegation({ delegationId: candidate.id, execute: true, [internalAutoStart]: true }))
              .catch((error) => runtimeState.closed ? null : markDelegationFailure({
                delegationId: candidate.id, error, stage: 'auto_start',
              }))
              .finally(() => runtimeState.autoProcessingDelegations.delete(candidate.id));
            return true;
          };
          const incomingDelegations = auth.agentDelegationsAllWorkspaces({ direction: 'incoming', limit: 5000 })
            .sort((left, right) => String(left.createdAt || left.created_at || '').localeCompare(String(right.createdAt || right.created_at || ''))
              || String(left.id || '').localeCompare(String(right.id || '')));
          for (const delegation of incomingDelegations) {
          if (['submitted', 'result_accepted', 'closed', 'withdrawn', 'declined', 'blocked', 'completed', 'rejected'].includes(String(delegation.status || ''))) continue;
          let acceptanceRemote = Promise.resolve(null);
          if (delegation.status === 'assigned') {
            const acceptingMetadata = {
              ...(delegation.metadata || {}),
              intakeStatus: 'processing',
              executionState: delegation.metadata?.executionState || 'queued',
              deliveryState: delegation.metadata?.deliveryState || 'preparing',
            };
            const acceptedDelegation = auth.updateAgentDelegation({
              delegationId: delegation.id,
              workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
              status: 'accepted',
              metadata: acceptingMetadata,
              started: true,
            }) || delegation;
            try { this.ensureExternalDelegationNotice({ delegation: acceptedDelegation }); } catch {}
            const receivedProgress = publishDelegationProgressSafely(delegation.id, {
              phase: 'queued',
              message: '任务已收到，正在进入接单处理队列',
              terminal: false,
              milestone: {
                key: 'delegation_received', status: 'completed', title: '任务已收到',
                detail: '接收方 uBuddy 已确认收到委托，无需重复派发。', occurredAt: new Date().toISOString(),
              },
            }, { syncRemote: false });
            if (socialRelay.connected()) acceptanceRemote = syncDelegationRemoteUpdate(delegation.id, {
              workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
              status: 'accepted',
              metadata: publicAgentDelegationMetadata(receivedProgress?.delegation?.metadata || acceptedDelegation.metadata || acceptingMetadata),
            });
          }
          const existingIntakeJob = runtimeState.delegationIntakeJobs.get(delegation.id);
          if (existingIntakeJob) {
            await existingIntakeJob;
            if (autoProcess) autoStartPreparedIncomingDelegation(auth.agentDelegationByEntityId(delegation.id));
            continue;
          }
          const processIntake = async () => {
          await acceptanceRemote;
          if (runtimeState.closed || auth.currentUser()?.id !== delegation.recipientUserId) return;
          try { this.ensureExternalDelegationNotice({ delegation: auth.agentDelegationByEntityId(delegation.id) || delegation }); } catch {}
          const peerId = delegation.requesterUserId || delegation.requester_user_id || '';
          let contextMessages = auth.socialConversation({ peerId, workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }).filter((message) => {
            const messageMetadata = message.metadata || {};
            return messageMetadata.delegationId === delegation.id
              && messageMetadata.type === 'agent_delegation_comment'
              && !messageMetadata.withdrawn;
          });
          const collaborationGroupId = delegation.groupId || delegation.group_id || delegation.metadata?.groupId || '';
          const assignmentDependencies = [...new Set((Array.isArray(delegation.metadata?.dependencies) ? delegation.metadata.dependencies : [])
            .map((item) => String(item || '').trim()).filter(Boolean))];
          let receivedDependencyIds = new Set();
          if (collaborationGroupId) {
            const groupDetail = socialRelay.connected()
              ? await socialRelay.collaborationGroup(collaborationGroupId, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }).catch(() => null)
              : (() => { try { return auth.collaborationGroup(collaborationGroupId, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }); } catch { return null; } })();
            const groupTaskMessages = (groupDetail?.messages || []).filter((message) => {
              const messageMetadata = message.metadata || {};
              return (messageMetadata.delegationId === delegation.id
                && ['task_action', 'agent_delegation_comment'].includes(messageMetadata.type)
                && !messageMetadata.withdrawn)
                || (messageMetadata.type === 'ubuddy_dependency_handoff'
                  && String(messageMetadata.targetAssignmentId || '') === String(delegation.metadata?.assignmentId || ''));
            });
            const latestDependencyEventBySource = new Map();
            for (const message of groupTaskMessages.filter((item) => item.metadata?.type === 'ubuddy_dependency_handoff')) {
              const sourceAssignmentId = String(message.metadata?.sourceAssignmentId || '');
              if (!sourceAssignmentId) continue;
              const current = latestDependencyEventBySource.get(sourceAssignmentId);
              if (!current || new Date(message.createdAt || message.created_at || 0) >= new Date(current.createdAt || current.created_at || 0)) {
                latestDependencyEventBySource.set(sourceAssignmentId, message);
              }
            }
            receivedDependencyIds = new Set([...latestDependencyEventBySource.entries()]
              .filter(([, message]) => message.metadata?.handoffState === 'accepted' && message.metadata?.confirmedPublic === true)
              .map(([sourceAssignmentId]) => sourceAssignmentId));
            contextMessages = [...contextMessages, ...groupTaskMessages]
              .sort((left, right) => new Date(left.createdAt || left.created_at || 0) - new Date(right.createdAt || right.created_at || 0));
          }
          const missingDependencyIds = assignmentDependencies.filter((assignmentId) => !receivedDependencyIds.has(assignmentId));
          if (missingDependencyIds.length) {
            const latestDelegation = auth.agentDelegationByEntityId(delegation.id) || delegation;
            const waitingMetadata = {
              ...(latestDelegation.metadata || {}),
              intakeStatus: 'waiting_dependencies',
              dependencyState: 'waiting',
              dependencyAssignmentIds: assignmentDependencies,
              missingDependencyAssignmentIds: missingDependencyIds,
              dependencyUpdatedAt: new Date().toISOString(),
              executionState: 'waiting_dependencies',
              deliveryState: 'preparing',
            };
            auth.updateAgentDelegation({
              delegationId: delegation.id,
              workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
              metadata: waitingMetadata,
            });
            if (socialRelay.connected()) await syncDelegationRemoteUpdate(delegation.id, {
              workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
              metadata: publicAgentDelegationMetadata(waitingMetadata),
            });
            return;
          }
          const intakeRevisionKey = delegationIntakeRevisionKey(delegation, contextMessages);
          if (delegation.status !== 'assigned' && delegation.metadata?.intakeRevisionKey === intakeRevisionKey) {
            const unchangedDelegation = auth.agentDelegationByEntityId(delegation.id) || delegation;
            autoStartPreparedIncomingDelegation(unchangedDelegation);
            return;
          }
          const attachments = [
            ...(Array.isArray(delegation.metadata?.attachments) ? delegation.metadata.attachments : []),
            ...contextMessages.flatMap((message) => Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : []),
          ];
          let currentDelegation = auth.agentDelegationById(delegation.id, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }) || delegation;
          const trustedStructuredIntake = Boolean(
            !delegation.metadata?.draftReadyAt
            && delegation.metadata?.initiatedThroughOwnUBuddy
            && String(delegation.instruction || delegation.title || '').trim(),
          );
          publishDelegationProgressSafely(delegation.id, {
            phase: 'preparing',
            message: 'uBuddy 正在整理任务要求、附件和公开上下文',
            terminal: false,
            milestone: {
              key: 'intake_started', status: 'running', title: '整理任务要求',
              detail: '正在确认目标、交付物、附件和可使用的公开上下文。', occurredAt: new Date().toISOString(),
            },
          });
          const organized = delegation.metadata?.draftReadyAt
            ? {
                content: buildDelegationIntakeSummary(delegation, contextMessages),
                mode: 'context_refresh',
              }
            : trustedStructuredIntake
              ? {
                  content: buildDelegationIntakeSummary(delegation, contextMessages),
                  mode: 'trusted_dispatch',
                }
            : await this.processAgentDelegationContent({
                delegationId: delegation.id,
                phase: 'intake',
                content: delegation.instruction || delegation.title || '',
                attachments,
                contextMessages,
              });
          if (runtimeState.closed || auth.currentUser()?.id !== delegation.recipientUserId) return;
          // Intake can call the model while the owner is already producing a newer
          // result in the private workspace. Re-read the delegation before writing
          // the intake summary so this background refresh cannot restore a stale
          // status (for example revision_requested over a new draft_ready result).
          currentDelegation = auth.agentDelegationById(delegation.id, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }) || currentDelegation;
          const metadata = {
            ...(currentDelegation.metadata || {}),
            intakeStatus: 'completed',
            intakeSummary: organized.content || buildDelegationIntakeSummary(delegation, contextMessages),
            intakeCompletedAt: new Date().toISOString(),
            intakeRevisionKey,
            intakeRevision: Math.max(0, Number(currentDelegation.metadata?.intakeRevision || 0)) + 1,
            intakeLatestRevisionNo: Math.max(0, ...contextMessages.map((message) => Number(message.metadata?.revisionNo || message.metadata?.revision_no || 0))),
            intakeProcessingMode: organized.mode || 'fallback',
            humanDecision: currentDelegation.metadata?.humanDecision || 'pending',
            dependencyState: assignmentDependencies.length ? 'ready' : 'not_required',
            dependencyAssignmentIds: assignmentDependencies,
            missingDependencyAssignmentIds: [],
            dependencyUpdatedAt: assignmentDependencies.length ? new Date().toISOString() : '',
          };
          try {
            const ownerConfirmationRequired = delegationRequiresHumanApproval({ ...currentDelegation, metadata });
            const nextMetadata = {
              ...metadata,
              ownerConfirmationRequired,
              safePreparationOnly: ownerConfirmationRequired,
              executionState: currentDelegation.metadata?.executionState || 'queued',
              deliveryState: currentDelegation.metadata?.deliveryState || 'preparing',
              failureCode: '',
              failureStage: '',
              retryable: false,
            };
            const acceptingInitialAssignment = currentDelegation.status === 'assigned';
            const intakeCompletedDelegation = auth.updateAgentDelegation({
              delegationId: delegation.id,
              workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
              ...(acceptingInitialAssignment ? { status: 'accepted' } : {}),
              metadata: nextMetadata,
              started: acceptingInitialAssignment,
            }) || currentDelegation;
            const intakeProgress = publishDelegationProgressSafely(delegation.id, {
              phase: 'queued',
              message: '任务要求已整理，等待后台启动执行',
              terminal: false,
              milestone: {
                key: 'intake_completed', status: 'completed', title: '任务要求已整理',
                detail: '目标、交付要求和公开上下文已整理完成。', occurredAt: new Date().toISOString(),
              },
            }, { syncRemote: false });
            if (socialRelay.connected()) await queueDelegationRemoteUpdate(delegation.id, {
              workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
              // A background intake refresh owns its summary, not the task's live
              // workflow state. Omitting status lets the server preserve a newer
              // draft_ready/working/submitted state produced concurrently.
              ...(acceptingInitialAssignment ? { status: 'accepted' } : {}),
              metadata: publicAgentDelegationMetadata(intakeProgress?.delegation?.metadata || intakeCompletedDelegation.metadata || nextMetadata),
            });
            autoStartPreparedIncomingDelegation(auth.agentDelegationByEntityId(delegation.id));
          } catch (error) {
            emitUBuddyDiagnostic('ubuddy_delegation_intake_failed', {
              level: 'warn', data: { delegationId: delegation.id, stage: 'intake_completion' }, error,
            });
            // Keep the previous revision so the next poll can retry the uBuddy intake step.
          }
          };
          const intakeJob = scheduleDelegationIntake(processIntake)
            .catch((error) => {
              emitUBuddyDiagnostic('ubuddy_delegation_intake_failed', {
                level: 'warn', data: { delegationId: delegation.id }, error,
              });
              return null;
            });
          runtimeState.delegationIntakeJobs.set(delegation.id, intakeJob);
          intakeJob.finally(() => {
            if (runtimeState.delegationIntakeJobs.get(delegation.id) === intakeJob) {
              runtimeState.delegationIntakeJobs.delete(delegation.id);
            }
          }).catch(() => null);
          if (!autoProcess) await intakeJob;
        }
        for (const delegation of auth.agentDelegationsAllWorkspaces({ direction: 'outgoing', limit: 5000 })) {
          if (!['submitted', 'revision_requested', 'result_accepted', 'completed', 'closed', 'failed', 'rejected', 'declined', 'withdrawn', 'blocked'].includes(delegation.status)) continue;
          await publishDependencyHandoffs(delegation).catch(() => []);
          const sourceSecretarySessionId = delegation.metadata?.sourceSecretarySessionId || '';
          if (!sourceSecretarySessionId) continue;
          const currentUser = auth.currentUser();
          const sourceSecretarySession = store.getSession(sourceSecretarySessionId);
          const sourceSessionWritable = sourceSecretarySession
            && sourceSecretarySession.userId === currentUser?.id
            && sourceSecretarySession.workspaceId === (delegation.workspaceId || delegation.accountWorkspaceId)
            && sourceSecretarySession.departmentId === 'secretary_department'
            && sourceSecretarySession.status !== 'deleted'
            && !sourceSecretarySession.readOnly
            && sourceSecretarySession.writeState !== 'read_only';
          const secretarySession = sourceSessionWritable
            ? sourceSecretarySession
            : this.ensureSecretarySession({
                sessionId: sourceSecretarySessionId,
                accountWorkspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
              });
          const secretarySessionId = secretarySession?.id || '';
          if (!secretarySessionId) continue;
          if (secretarySessionId !== sourceSecretarySessionId) {
            const repairedMetadata = { ...(delegation.metadata || {}), sourceSecretarySessionId: secretarySessionId };
            auth.updateAgentDelegation({ delegationId: delegation.id, workspaceId: delegation.workspaceId || delegation.accountWorkspaceId, metadata: repairedMetadata });
            if (socialRelay.connected()) {
              await socialRelay.updateDelegation(delegation.id, {
                workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
                metadata: { sourceSecretarySessionId: secretarySessionId },
              }).catch(() => null);
            }
          }
          const alreadyRecorded = store.listMessages(secretarySessionId).some((message) => (
            message.metadata?.delegationFeedbackId === delegation.id && message.metadata?.delegationStatus === delegation.status
          ));
          if (alreadyRecorded) continue;
          const matchingFeedback = auth.socialInbox({ limit: 100, workspaceId: delegation.workspaceId || delegation.accountWorkspaceId })
            .find((message) => message.metadata?.delegationId === delegation.id && message.metadata?.status === delegation.status);
          store.addMessage({
            sessionId: secretarySessionId,
            role: 'assistant',
            content: matchingFeedback?.content || (delegation.status === 'submitted'
              ? `Buddy agent 已提交任务结果，等待你验收：${delegation.title}`
              : ['result_accepted', 'completed'].includes(delegation.status)
                ? `Buddy agent 任务已完成：${delegation.title}`
                : `Buddy agent 任务${delegation.status === 'rejected' ? '已拒绝' : '处理失败'}：${delegation.title}${delegation.lastError ? `\n\n${delegation.lastError}` : ''}`),
            agentId: 'secretary_agent',
            departmentId: 'secretary_department',
            metadata: {
              secretaryControl: true,
              delegationFeedbackId: delegation.id,
              delegationStatus: delegation.status,
              peerUserId: delegation.recipientUserId,
            },
          });
        }
        if (autoProcess && socialRelay.connected()) {
          for (const delegationId of socialRelay.pendingIncomingDelegations()) {
            if (runtimeState.delegationIntakeJobs.has(delegationId)
              || runtimeState.autoProcessingDelegations.has(delegationId)) continue;
            const delegation = auth.agentDelegationByEntityId(delegationId);
            autoStartPreparedIncomingDelegation(delegation);
          }
        }
        if (autoProcess) {
          const dueWorkDigests = store.listWorkDigestJobs({
            ownerUserId: auth.currentUser()?.id || '', statuses: ['awaiting_owner_supplement'],
            dueBefore: new Date().toISOString(), limit: 100,
          });
          for (const job of dueWorkDigests) {
            const delegation = auth.agentDelegationByEntityId(job.delegationId);
            if (!delegation || delegation.recipientUserId !== auth.currentUser()?.id) continue;
            const existingVersion = store.latestWorkDigestVersion({ jobId: job.id, states: ['draft', 'published'] });
            const version = existingVersion || store.saveWorkDigestVersion({
              jobId: job.id,
              body: buildTimedOutEmptyWorkDigest({ coverage: job.coverage, spec: job.spec }),
              evidence: [], coverage: job.coverage, sourceKind: 'automatic_empty_timeout', updateJobStatus: false,
            });
            try {
              await this.respondAgentDelegation({
                delegationId: delegation.id, action: 'submit', message: version.body,
                sourceWorkspaceRevisionId: version.id, autoEmptyReport: true,
                workDigestCoverage: job.coverage,
              });
            } catch (error) {
              store.updateWorkDigestJob({ id: job.id, lastError: String(error?.message || error).slice(0, 2000) });
            }
          }
        }
        const collaboration = socialRelay.connected()
          ? (result?.collaboration || { groups: [], tasks: [] })
          : auth.collaborationOverview({ workspaceId: activePollWorkspaceId });
        const allWorkspaceCollaboration = socialRelay.connected()
          ? (result?.allWorkspaceCollaboration || collaboration)
          : collaboration;
        const delegationHistoryCatchUpWorkspaceIds = new Set(result?.delegationHistoryCatchUpWorkspaceIds || []);
        for (const group of allWorkspaceCollaboration.groups || []) {
          if (group.ownerUserId !== auth.currentUser()?.id || group.status === 'closed') continue;
          const groupTasks = (allWorkspaceCollaboration.tasks || []).filter((task) => (task.groupId || task.metadata?.groupId) === group.id);
          activateReadyLocalPeerTasks(group, groupTasks);
          const finalStatuses = new Set(['result_accepted', 'completed', 'declined', 'withdrawn', 'closed', 'failed', 'rejected']);
          const allTerminal = groupTasks.length > 0 && groupTasks.every((task) => finalStatuses.has(String(task.status || '')));
          if (!groupTasks.length || (!allTerminal && !groupTasks.some((task) => task.status === 'blocked'))) continue;
          const summaryRevision = sha256Text(JSON.stringify(groupTasks.map((task) => ({
            id: task.id,
            status: task.status,
            updatedAt: task.updatedAt || task.updated_at || '',
          })))).slice(0, 16);
          const groupWorkspaceId = group.workspaceId || group.accountWorkspaceId || activePollWorkspaceId;
          const summaryAutomationIdentity = {
            userId: auth.currentUser()?.id || '',
            workspaceId: groupWorkspaceId,
            automationType: 'collaboration_group_summary',
            scopeId: group.id,
            sourceMessageId: `${group.id}:${summaryRevision}`,
          };
          if (socialAutomationLedger.hasProcessed(summaryAutomationIdentity)) continue;
          if (delegationHistoryCatchUpWorkspaceIds.has(groupWorkspaceId)
            || (result?.allWorkspaceDelegationHistoryCatchUp && !delegationHistoryCatchUpWorkspaceIds.size)) {
            socialAutomationLedger.markProcessed(summaryAutomationIdentity, 'baseline');
            continue;
          }
          if (!collaborationAutomationStateIsFresh(groupTasks)) continue;
          try {
            await this.prepareCollaborationGroupSummary({
              groupId: group.id,
              workspaceId: groupWorkspaceId,
            });
          } catch {
            continue;
          }
          const sourceType = String(group.metadata?.sourceType || group.metadata?.source_type || '');
          const sourceGroupId = String(group.metadata?.source_group_id || group.metadata?.sourceGroupId || '').trim();
          if (allTerminal && sourceType === 'natural_chat_group' && sourceGroupId) {
            const participantLabels = groupTasks.map((task) => (
              displayAuthUserName(task.recipient || {}) || task.recipientUserId || task.recipient_user_id || '成员'
            ));
            const completed = groupTasks.filter((task) => ['result_accepted', 'completed', 'closed'].includes(String(task.status || ''))).length;
            const failed = groupTasks.filter((task) => ['failed', 'declined', 'withdrawn', 'rejected'].includes(String(task.status || ''))).length;
            const resultLines = groupTasks.map((task) => {
              const recipient = displayAuthUserName(task.recipient || {}) || task.recipientUserId || task.recipient_user_id || '成员';
              return `- ${recipient}：${task.title || '任务'}（${collaborationTaskStatusReply(task.status || '')}）`;
            });
            const summaryPayload = {
              workspaceId: groupWorkspaceId,
              content: [
                `关联多人任务已完成：${completed}/${groupTasks.length} 项完成${failed ? `，${failed} 项未完成` : ''}。`,
                ...resultLines,
                '详细结果、文件和交付确认请进入关联任务群查看。',
              ].join('\n'),
              clientMessageId: `ubuddy_multi_summary:${group.id}:${summaryRevision}`.slice(0, 200),
              senderAgentId: 'secretary_agent',
              kind: 'agent',
              metadata: {
                type: 'ubuddy_multi_task_summary',
                status: failed ? 'completed_with_issues' : 'completed',
                collaborationGroupId: group.id,
                sourceMessageId: group.metadata?.source_message_id || group.metadata?.sourceMessageId || '',
                assignmentCount: groupTasks.length,
                participantLabels,
                summaryRevision,
                publicStatusOnly: true,
              },
            };
            try {
              if (socialRelay.connected()) {
                await socialRelay.sendChatGroupMessage(sourceGroupId, summaryPayload);
              } else {
                auth.sendChatGroupMessage({ groupId: sourceGroupId, ...summaryPayload });
              }
            } catch (error) {
              emitUBuddyDiagnostic('ubuddy_natural_group_summary_publish_failed', {
                level: 'warn', data: { collaborationGroupId: group.id, sourceGroupId, summaryRevision }, error,
              });
              continue;
            }
          }
          socialAutomationLedger.markProcessed(summaryAutomationIdentity);
        }
        const scopedResult = { ...(result || {}) };
        delete scopedResult.allWorkspaceCollaboration;
        return {
          ...scopedResult,
          workspaceId: activePollWorkspaceId,
          accountWorkspaceId: activePollWorkspaceId,
          status: socialRelay.status(),
          friends: result?.friends || socialRelay.friendsOverviewWithCachedPresence(
            auth.friendsOverview({ workspaceId: activePollWorkspaceId }),
          ),
          inbox: auth.socialInbox({ workspaceId: activePollWorkspaceId }),
          delegations: auth.agentDelegations({ direction: 'all', workspaceId: activePollWorkspaceId }),
          collaboration,
          chatGroups: result?.chatGroups || auth.chatGroupsOverview({ workspaceId: activePollWorkspaceId }),
          ...(uBuddyDispatchRecovery ? { uBuddyDispatchRecovery } : {}),
        };
      } finally {
        runtimeState.socialPollRunning = false;
        runtimeState.resolveSocialPollCompletion?.();
        if (runtimeState.socialPollCompletion === pollCompletion) {
          runtimeState.socialPollCompletion = null;
          runtimeState.resolveSocialPollCompletion = null;
        }
      }
    }
  };
}

function bindDelegatedTaskWorkScope(store, task, delegation) {
  if (!task?.id || !delegation?.id) return null;
  const scope = store.ensureTaskWorkScope?.({
    taskRunId: task.id,
    parentWorkScopeId: `delegation:${delegation.id}`,
    federationType: 'delegation',
    federationId: delegation.id,
  }) || null;
  for (const node of task.nodes || []) {
    if (!node.agentInstanceId) continue;
    store.ensureTaskMemoryDocument?.({
      agentInstanceId: node.agentInstanceId,
      taskRunId: task.id,
      taskTitle: task.title || delegation.title || node.title || '',
      delegationId: delegation.id,
      groupId: delegation.groupId || delegation.metadata?.groupId || '',
      cloudEvolutionAllowed: Boolean(task.metadata?.cloudEvolutionAllowed),
    });
  }
  store.canonicalizeDelegationTaskMemories?.({
    userId: task.ownerUserId || '',
    delegationId: delegation.id,
    taskRunId: task.id,
    groupId: delegation.groupId || delegation.metadata?.groupId || '',
    taskTitle: task.title || delegation.title || '',
  });
  return scope;
}

function ensureDelegationCoordinatorMemory(store, delegation, secretaryInstance) {
  if (!delegation?.id || !secretaryInstance?.id) return null;
  const canonicalTaskId = String(delegation.taskRunId || delegation.id).trim();
  const document = store.ensureTaskMemoryDocument?.({
    agentInstanceId: secretaryInstance.id,
    taskRunId: canonicalTaskId,
    taskTitle: delegation.title || 'uBuddy 委托任务',
    delegationId: delegation.id,
    groupId: delegation.groupId || delegation.metadata?.groupId || '',
    cloudEvolutionAllowed: false,
  }) || null;
  if (canonicalTaskId !== delegation.id) {
    store.canonicalizeDelegationTaskMemories?.({
      userId: secretaryInstance.userId || '',
      delegationId: delegation.id,
      taskRunId: canonicalTaskId,
      groupId: delegation.groupId || delegation.metadata?.groupId || '',
      taskTitle: delegation.title || 'uBuddy 委托任务',
    });
    return store.ensureTaskMemoryDocument?.({
      agentInstanceId: secretaryInstance.id,
      taskRunId: canonicalTaskId,
      taskTitle: delegation.title || 'uBuddy 委托任务',
      delegationId: delegation.id,
      groupId: delegation.groupId || delegation.metadata?.groupId || '',
      cloudEvolutionAllowed: false,
    }) || document;
  }
  return document;
}

function recordDelegationCoordinatorMemory(store, delegation, secretaryInstance, {
  phase = 'reply',
  sourceId = '',
  input = '',
  output = '',
  mode = '',
} = {}) {
  if (!delegation?.id || !secretaryInstance?.id) return null;
  try {
    ensureDelegationCoordinatorMemory(store, delegation, secretaryInstance);
    const parts = [
      input ? `用户输入：${String(input).trim().slice(0, 1200)}` : '',
      output ? `uBuddy 整理：${String(output).trim().slice(0, 1200)}` : '',
      mode ? `处理模式：${mode}` : '',
    ].filter(Boolean);
    if (!parts.length) return null;
    return store.appendTaskMemoryObservation?.({
      agentInstanceId: secretaryInstance.id,
      taskRunId: String(delegation.taskRunId || delegation.id).trim(),
      taskTitle: delegation.title || 'uBuddy 委托任务',
      sourceId: sourceId || delegation.id,
      status: `ubuddy_${phase}`,
      summary: parts.join('\n'),
    }) || null;
  } catch {
    return null;
  }
}

function taskMemoryView(store, document, instance, { role = 'executor' } = {}) {
  const family = store.getAgentFamily?.(instance?.agentFamilyId || document?.agentFamilyId || '') || null;
  return {
    id: document.id,
    displayName: document.displayName,
    scope: document.scope,
    taskRunId: document.taskRunId,
    delegationId: document.delegationId,
    groupId: document.groupId,
    contextSpaceId: document.contextSpaceId,
    lifecycleState: document.lifecycleState,
    visibility: document.visibility,
    content: document.content,
    decryptionState: document.decryptionState,
    currentVersionId: document.currentVersionId,
    updatedAt: document.updatedAt,
    agentInstanceId: instance?.id || document.userAgentInstanceId || '',
    agentFamilyId: instance?.agentFamilyId || document.agentFamilyId || '',
    agentName: family?.displayName || family?.name || instance?.agentFamilyId || 'Agent',
    role,
  };
}
