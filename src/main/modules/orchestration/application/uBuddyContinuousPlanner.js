import { runCodexSession } from '../../../codex.js';
import {
  UBUDDY_PLANNING_DECISION_VERSION,
  normalizeUBuddyPlanningDecision,
  validateUBuddyPlanningDecision,
} from '../../../../shared/contracts/uBuddyPlanningSession.js';
import { validateUBuddyTaskIntake } from '../../../../shared/contracts/uBuddyTaskIntake.js';

export const DEFAULT_UBUDDY_CONTINUOUS_PLANNING_TIMEOUT_MS = 600_000;
export const UBUDDY_CONTINUOUS_PLANNING_REASONING_EFFORT = 'low';

export async function planUBuddyContinuously({
  planningSessionId = '', revision = 1, prompt = '', priorDecision = null, clarificationResponse = null,
  directive = 'initial',
  taskMode = true,
  recentMessages = [], authorizedUsers = [], requiredUserIds = [], candidateAgents = [], requiredAgentInstanceIds = [],
  attachments = [], references = [], project = null, organizationAudienceSnapshot = null,
  root = '', cwd = '', model = '', signal = null, plannerThreadId = '', plannerSessionId = '',
  timeoutMs = Number(process.env.JANUS_UBUDDY_CONTINUOUS_PLANNING_TIMEOUT_MS || DEFAULT_UBUDDY_CONTINUOUS_PLANNING_TIMEOUT_MS),
  execute = runCodexSession, executionContext = null,
} = {}) {
  const users = normalizeUsers(authorizedUsers);
  const agents = normalizeAgents(candidateAgents);
  const allowedUserIds = users.map((item) => item.userId);
  const allowedAgentInstanceIds = agents.map((item) => item.agentInstanceId);
  const fixedRequiredUsers = uniqueIds(requiredUserIds).filter((id) => allowedUserIds.includes(id));
  const fixedRequiredAgents = uniqueIds(requiredAgentInstanceIds).filter((id) => allowedAgentInstanceIds.includes(id));
  const basePrompt = continuousPlanningPrompt({
    planningSessionId, revision, prompt, priorDecision, clarificationResponse, directive, taskMode, recentMessages,
    users, fixedRequiredUsers, agents, fixedRequiredAgents, attachments, references, project, organizationAudienceSnapshot,
  });
  let currentThreadId = String(plannerThreadId || '').trim();
  let invalidAnswer = '';
  let validationFailure = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const turnPrompt = attempt === 1 ? basePrompt : repairPrompt({
      planningSessionId, revision, invalidAnswer, validationFailure, allowedUserIds, allowedAgentInstanceIds,
    });
    let executionResult;
    try {
      executionResult = await execute({
        prompt: turnPrompt, freshPrompt: turnPrompt, agentId: 'secretary_agent',
        sessionId: plannerSessionId || executionContext?.conversationId || planningSessionId || 'ubuddy-continuous-planner',
        threadId: currentThreadId, root, cwd: cwd || root, role: 'ubuddy-continuous-planner', model,
        reasoningEffort: UBUDDY_CONTINUOUS_PLANNING_REASONING_EFFORT, sandbox: 'read-only', signal, timeoutMs,
        harnessMode: 'raw', readOnly: true, memoryUseEnabled: false, memoryGenerateEnabled: false,
        nativeMultiAgentEnabled: false, executionContext,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = new Error(`uBuddy continuous planner failed: ${String(error?.message || error)}`);
      failure.code = classifyExecutionError(error);
      failure.retryable = failure.code !== 'ubuddy_continuous_planning_configuration_failed';
      failure.cause = error;
      failure.plannerThreadId = currentThreadId;
      throw failure;
    }
    currentThreadId = modelThreadId(executionResult, currentThreadId);
    invalidAnswer = modelAnswer(executionResult);
    try {
      const parsed = parseJsonAnswer(invalidAnswer);
      const decision = validateUBuddyPlanningDecision(parsed, {
        allowedUserIds, allowedAgentInstanceIds, throwOnError: true,
      }).value;
      if (taskMode && decision.decision === 'direct_answer') {
        const error = new Error('Task mode cannot return a direct answer.');
        error.code = 'planning_task_mode_direct_invalid';
        error.diagnostics = [{ code: error.code, field: 'decision' }];
        throw error;
      }
      decision.intake = validatePlanningIntake(decision);
      assertFixedParticipants(decision, { fixedRequiredUsers, fixedRequiredAgents });
      return { ...decision, plannerThreadId: currentThreadId, planningSessionId, baseRevision: revision };
    } catch (error) {
      validationFailure = error;
      if (attempt === 2) {
        const failure = new Error(`uBuddy continuous planner returned an invalid plan: ${String(error?.message || error)}`);
        failure.code = 'ubuddy_continuous_planning_validation_failed';
        failure.retryable = true;
        failure.diagnostics = compactDiagnostics(error?.diagnostics);
        failure.uBuddyRawAnswerPreview = clip(invalidAnswer, 6000);
        failure.plannerThreadId = currentThreadId;
        throw failure;
      }
    }
  }
  throw new Error('Unreachable continuous planning state.');
}

function continuousPlanningPrompt({
  planningSessionId, revision, prompt, priorDecision, clarificationResponse, directive, taskMode, recentMessages,
  users, fixedRequiredUsers, agents, fixedRequiredAgents, attachments, references, project, organizationAudienceSnapshot,
}) {
  return [
    '【UBUDDY_CONTINUOUS_PLANNING_V1】',
    'Return exactly one JSON object and no Markdown. You are the sole semantic planner for this task from intake through the frozen dispatch plan.',
    'Do not execute the task. Do not create tasks, groups, messages, files, or side effects.',
    'Maintain one coherent plan across turns. The prior decision is the authoritative semantic checkpoint; apply the current answer to it instead of restarting classification.',
    'The planning directive describes why this same session resumed: initial, clarification, revise, all_selected, or retry.',
    'For revise, apply the requested changes while preserving unaffected facts and assignments. For all_selected, select and assign every authorized remote user. For retry, regenerate the full decision from the authoritative checkpoint.',
    taskMode ? 'The owner explicitly requested task mode. Do not return direct_answer.' : 'Use direct_answer only when the request is not a new task.',
    'Write every user-visible field in the language of the current request.',
    'Ask all currently identifiable critical questions together. Do not ask optional preferences when a safe assumption is available.',
    'Never invent, rename, add, or replace users or Agent instances. IDs must come from the authorized catalogs below.',
    'Every required user and required Agent must remain selected. Organization membership and permissions are runtime-owned facts.',
    'Use target.kind=local_agent when local Agents do the work, external_delegation for exactly one remote user, and task_group for multiple remote users. Do not mix local Agent and remote-user assignments in one dispatch plan.',
    'For manager_delegation the initiator coordinates only. For peer_collaboration include exactly one self assignment.',
    'Set collaboration.assignmentIntent=explicit only when the owner explicitly supplied complete person-by-person work. Otherwise use auto, even though you must still produce the final assignments.',
    'When ready, include a complete intake, selected participants, executable assignments, no clarifications, and readiness.status=ready.',
    'For a local Agent task, each selected Agent assignment uses assigneeKind=agent and agentInstanceId. For external work use assigneeKind=user. For initiator work use assigneeKind=self.',
    'Every selected worker must have an assignment. External collaboration requires exactly one user assignment per selected user; manager_delegation has no self assignment and peer_collaboration has exactly one self assignment.',
    'Dependencies must reference assignment IDs in this response and form a DAG.',
    `Planning identity: ${JSON.stringify({ planningSessionId, revision })}`,
    `Planning directive: ${JSON.stringify(String(directive || 'initial'))}`,
    `Prior authoritative decision: ${priorDecision ? JSON.stringify(priorDecision) : 'None; create the first revision.'}`,
    `Structured clarification response: ${clarificationResponse ? JSON.stringify(clarificationResponse) : 'None.'}`,
    `Authorized remote users: ${JSON.stringify(users)}`,
    `Required remote user IDs: ${JSON.stringify(fixedRequiredUsers)}`,
    `Authorized local Agent candidates: ${JSON.stringify(agents)}`,
    `Required local Agent instance IDs: ${JSON.stringify(fixedRequiredAgents)}`,
    `Organization audience snapshot: ${organizationAudienceSnapshot ? JSON.stringify(organizationAudienceSnapshot) : 'None.'}`,
    `Attachments: ${JSON.stringify(normalizeAttachments(attachments))}`,
    `References: ${JSON.stringify((Array.isArray(references) ? references : []).slice(0, 100))}`,
    `Project: ${project ? JSON.stringify(project) : 'None.'}`,
    `Recent visible context: ${JSON.stringify(normalizeRecent(recentMessages))}`,
    `Current request: ${String(prompt || '').trim()}`,
    `Schema: ${decisionSchema()}`,
  ].join('\n\n');
}

function decisionSchema() {
  return JSON.stringify({
    version: UBUDDY_PLANNING_DECISION_VERSION,
    decision: 'awaiting_clarification|ready_for_dispatch|direct_answer', confidence: 0.9, answer: '',
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready|needs_clarification', taskKind: 'general', workReportSpec: null,
      objective: '', deliverables: [], acceptanceCriteria: [], constraints: [], deadline: '',
      candidateUsers: [{ userId: '', displayName: '' }], requiredUsers: [{ userId: '', displayName: '' }],
      attachments: [{ id: '', name: '', kind: '' }], privacyScope: 'owner_private|direct_delegation|task_group_public',
      riskLevel: 'low|medium|high', missingFields: [], clarifications: [],
      executionPlan: { summary: '', steps: [], requiredInputs: [] }, knownFacts: [], safeAssumptions: [], criticalUnknowns: [],
      readiness: { status: 'ready|needs_clarification', reason: '' },
    },
    target: { kind: 'direct|local_agent|external_delegation|task_group', candidateUserIds: [], requiredUserIds: [], selectedUserIds: [], selectedAgentInstanceIds: [] },
    collaboration: { mode: 'manager_delegation|peer_collaboration', initiatorParticipation: 'coordinator_only|coordinator_and_worker', participantSelectionIntent: 'all|auto', assignmentIntent: 'explicit|auto' },
    assignments: [{ assignmentId: 'a1', assigneeKind: 'self|user|agent', userId: '', agentInstanceId: '', title: '', objective: '', deliverables: [], dependencies: [] }],
    clarifications: [{ id: '', header: '', question: '', reason: '', answerType: 'single_choice', options: [{ value: '', label: '', description: '' }], allowOther: true, required: true }],
    readiness: { status: 'ready|needs_clarification', reason: '', knownFacts: [], safeAssumptions: [], criticalUnknowns: [] },
    riskLevel: 'low|medium|high', rationale: '',
  });
}

function repairPrompt({ planningSessionId, revision, invalidAnswer, validationFailure, allowedUserIds, allowedAgentInstanceIds }) {
  return [
    '【UBUDDY_CONTINUOUS_PLANNING_REPAIR_V1】',
    'Your preceding planning response failed deterministic validation. Return exactly one corrected full JSON decision and no Markdown.',
    'Preserve the task semantics and all valid fields. Do not add users or Agent instances.',
    `Planning identity: ${JSON.stringify({ planningSessionId, revision })}`,
    `Allowed user IDs: ${JSON.stringify(allowedUserIds)}`,
    `Allowed Agent instance IDs: ${JSON.stringify(allowedAgentInstanceIds)}`,
    `Validation diagnostics: ${JSON.stringify(compactDiagnostics(validationFailure?.diagnostics))}`,
    `Invalid response: ${clip(invalidAnswer, 12_000)}`,
    `Required schema: ${decisionSchema()}`,
  ].join('\n\n');
}

function validatePlanningIntake(decision) {
  if (!decision.intake) {
    if (decision.decision === 'direct_answer') return null;
    const error = new Error('A task planning decision requires intake.');
    error.code = 'planning_intake_missing';
    throw error;
  }
  const validation = validateUBuddyTaskIntake(decision.intake, { throwOnError: false });
  if (!validation.valid) {
    const error = new Error(`Invalid planning intake: ${validation.diagnostics.map((item) => item.code).join(', ')}`);
    error.code = 'planning_intake_invalid';
    error.diagnostics = validation.diagnostics;
    throw error;
  }
  return validation.value;
}

function assertFixedParticipants(decision, { fixedRequiredUsers, fixedRequiredAgents }) {
  const missingUsers = fixedRequiredUsers.filter((id) => !decision.target.selectedUserIds.includes(id));
  const missingAgents = fixedRequiredAgents.filter((id) => !decision.target.selectedAgentInstanceIds.includes(id));
  if (!missingUsers.length && !missingAgents.length) return;
  const error = new Error('The planning response removed required participants.');
  error.code = 'planning_required_participants_missing';
  error.diagnostics = [
    ...missingUsers.map(() => ({ code: 'planning_required_user_missing', field: 'target.selectedUserIds' })),
    ...missingAgents.map(() => ({ code: 'planning_required_agent_missing', field: 'target.selectedAgentInstanceIds' })),
  ];
  throw error;
}

function normalizeUsers(value) { return (Array.isArray(value) ? value : []).map((item) => ({ userId: String(item?.userId || item?.id || ''), displayName: String(item?.displayName || item?.name || '') })).filter((item) => item.userId); }
function normalizeAgents(value) { return (Array.isArray(value) ? value : []).map((item) => ({ agentId: String(item?.agentId || ''), agentInstanceId: String(item?.agentInstanceId || item?.id || ''), name: String(item?.name || item?.displayName || item?.agentId || ''), departmentId: String(item?.departmentId || ''), capabilities: (Array.isArray(item?.capabilities) ? item.capabilities : []).slice(0, 40) })).filter((item) => item.agentInstanceId); }
function normalizeAttachments(value) { return (Array.isArray(value) ? value : []).slice(0, 20).map((item) => ({ id: String(item?.id || item?.attachmentId || ''), name: String(item?.name || item?.filename || ''), kind: String(item?.kind || item?.type || item?.mimeType || ''), size: Number(item?.size || 0) })); }
function normalizeRecent(value) { return (Array.isArray(value) ? value : []).slice(-10).map((item) => ({ role: String(item?.role || ''), content: clip(item?.content, 1200) })).filter((item) => item.content); }
function uniqueIds(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))]; }
function modelAnswer(result) { return String(result && typeof result === 'object' ? result.answer || '' : result || '').trim(); }
function modelThreadId(result, fallback = '') { return String(result && typeof result === 'object' ? result.threadId || fallback : fallback).trim(); }
function parseJsonAnswer(answer) { const text = String(answer || '').trim(); const start = text.indexOf('{'); const end = text.lastIndexOf('}'); if (start < 0 || end <= start) throw new Error('Continuous planner did not return JSON.'); return normalizeUBuddyPlanningDecision(JSON.parse(text.slice(start, end + 1))); }
function compactDiagnostics(value) { return (Array.isArray(value) ? value : []).slice(0, 30).map((item) => ({ code: String(item?.code || ''), field: String(item?.field || '') })); }
function clip(value, limit) { const text = String(value || '').trim(); return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`; }
function classifyExecutionError(error) { const text = String(error?.message || error || ''); if (/api key|authentication|unauthorized|forbidden|unsupported model|codex cli was not found|ENOENT/i.test(text)) return 'ubuddy_continuous_planning_configuration_failed'; if (/timed out|timeout/i.test(text)) return 'ubuddy_continuous_planning_timeout'; return 'ubuddy_continuous_planning_provider_failed'; }
