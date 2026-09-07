import { runCodexExec } from '../../../codex.js';
import { validateUBuddyTaskGraphProposal } from './uBuddyTaskGraphPlanner.js';
import { normalizeOrganizationResearchDecision } from '../../../../shared/contracts/organizationMessageResearch.js';

export const UBUDDY_TURN_DECISION_VERSION = 'UBUDDY_TURN_DECISION_V2';
// Routing is a short model call. Keep a hard upper bound so a broken desktop
// relay cannot leave the composer in an apparently-running state indefinitely.
export const DEFAULT_UBUDDY_TURN_DECISION_TIMEOUT_MS = 90_000;

const DECISIONS = new Set(['direct_answer', 'clarification', 'execution_mode_choice', 'task_plan']);
const AUTOMATIC_DECISION_CONFIDENCE = 0.75;

export async function decideUBuddyTurn({
  prompt = '',
  recentMessages = [],
  skill = '',
  memory = '',
  attachmentSummaries = [],
  candidates = [],
  mentionedAgentIds = [],
  decisionMode = 'unified',
  root = '',
  cwd = '',
  model = '',
  reasoningEffort = '',
  signal = null,
  timeoutMs = Number(process.env.JANUS_UBUDDY_TURN_DECISION_TIMEOUT_MS || DEFAULT_UBUDDY_TURN_DECISION_TIMEOUT_MS),
  execute = runCodexExec,
  executionContext = null,
} = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw decisionError('uBuddy turn decision requires a user message.');
  const normalizedCandidates = normalizeCandidates(candidates);
  const normalizedMentionedAgentIds = [...new Set((Array.isArray(mentionedAgentIds) ? mentionedAgentIds : [])
    .map((item) => String(item || '').trim()).filter(Boolean))];
  const plannerPrompt = buildUBuddyTurnDecisionPrompt({
    prompt: cleanPrompt,
    recentMessages,
    skill,
    memory,
    attachmentSummaries,
    candidates: normalizedCandidates,
    mentionedAgentIds: normalizedMentionedAgentIds,
    decisionMode,
  });
  let answer;
  try {
    answer = await execute({
      prompt: plannerPrompt,
      agentId: 'secretary_agent',
      root,
      cwd: cwd || root,
      role: 'ubuddy-turn-decision',
      model,
      reasoningEffort,
      sandbox: 'read-only',
      signal,
      timeoutMs,
      harnessMode: 'raw',
      executionContext,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw decisionError(`uBuddy model decision failed: ${String(error?.message || error)}`, error);
  }
  try {
    const validated = validateUBuddyTurnDecision(parseJsonAnswer(answer), {
        candidates: normalizedCandidates,
        mentionedAgentIds: normalizedMentionedAgentIds,
      });
    if (decisionMode === 'formal_task' && ['direct_answer', 'execution_mode_choice'].includes(validated.decision)) {
      throw decisionError('A formal external delegation must produce task_plan or clarification.');
    }
    if (decisionMode === 'explicit_new_task' && ['direct_answer', 'execution_mode_choice'].includes(validated.decision)) {
      throw decisionError('An explicitly requested new task must produce task_plan or clarification.');
    }
    if (decisionMode === 'intake_ready' && validated.decision === 'clarification') {
      throw decisionError('A ready structured task intake must not ask another requirements clarification question.');
    }
    if (decisionMode === 'task_continuation' && validated.decision !== 'task_plan') {
      throw decisionError('A task continuation must produce a successor task_plan without answering directly or asking another clarification question.');
    }
    if (decisionMode === 'forced_scheduler' && !['task_plan', 'clarification'].includes(validated.decision)) {
      throw decisionError('The owner selected Scheduler; the decision must produce task_plan or a material clarification.');
    }
    if (decisionMode === 'composer_task' && validated.decision !== 'task_plan') {
      throw decisionError('Composer task mode with ready intake must produce a formal task_plan.');
    }
    return {
      ...validated,
      rawAnswer: answer,
    };
  } catch (error) {
    const failure = error?.code === 'ubuddy_turn_decision_failed'
      ? error
      : decisionError(`uBuddy model decision was invalid: ${String(error?.message || error)}`, error);
    failure.uBuddyRawAnswerPreview = clipText(answer, 6000);
    throw failure;
  }
}

export function validateUBuddyTurnDecision(value = {}, { candidates = [], mentionedAgentIds = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw decisionError('uBuddy turn decision must be a JSON object.');
  const version = String(value.version || '').trim();
  if (version !== UBUDDY_TURN_DECISION_VERSION) throw decisionError(`Unsupported uBuddy turn decision version: ${version || 'missing'}.`);
  const decision = String(value.decision || '').trim().toLowerCase();
  if (!DECISIONS.has(decision)) throw decisionError(`Invalid uBuddy turn decision: ${decision || 'missing'}.`);
  const confidence = Math.max(0, Math.min(1, Number(value.confidence ?? 0.9) || 0));
  const sourceNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const sourceDeliverables = Array.isArray(value.deliverables) ? value.deliverables : [];
  const mentioned = [...new Set((Array.isArray(mentionedAgentIds) ? mentionedAgentIds : [])
    .map((item) => String(item || '').trim()).filter(Boolean))];
  const organizationResearch = normalizeOrganizationResearchDecision(value);

  if (decision === 'direct_answer') {
    if (confidence < AUTOMATIC_DECISION_CONFIDENCE) {
      throw decisionError(`A direct uBuddy decision requires confidence of at least ${AUTOMATIC_DECISION_CONFIDENCE}; use execution_mode_choice when both modes are viable.`);
    }
    const answer = String(value.answer || '').trim();
    if (sourceNodes.length || sourceDeliverables.length) throw decisionError('A direct uBuddy decision cannot contain task nodes or deliverables.');
    const explanations = normalizeMentionExplanations(value.mentionedAgentsNotSelected);
    const explanationIds = new Set(explanations.map((item) => item.agentId));
    const missingExplanations = mentioned.filter((agentId) => !explanationIds.has(agentId));
    if (missingExplanations.length) {
      throw decisionError(`The direct answer did not explain why mentioned Agents were not selected: ${missingExplanations.join(', ')}.`);
    }
    const unexpectedExplanations = explanations.filter((item) => !mentioned.includes(item.agentId));
    if (unexpectedExplanations.length) {
      throw decisionError(`mentionedAgentsNotSelected contains unmentioned Agents: ${unexpectedExplanations.map((item) => item.agentId).join(', ')}.`);
    }
    return {
      version,
      decision,
      confidence,
      answer,
      clarification: null,
      nodes: [],
      finalNodeId: '',
      deliverablePlan: null,
      agentSelectionRationale: '',
      mentionedAgentsNotSelected: explanations,
      routingRationale: String(value.routingRationale || '').trim().slice(0, 2000),
      organizationResearch,
    };
  }

  if (decision === 'clarification') {
    if (sourceNodes.length || sourceDeliverables.length) throw decisionError('A clarification decision cannot contain task nodes or deliverables.');
    const sources = Array.isArray(value.clarifications) && value.clarifications.length
      ? value.clarifications : value.clarification ? [value.clarification] : [];
    const clarifications = sources.slice(0, 12).map((item, index) => {
      const question = String(item?.question || '').trim().slice(0, 1000);
      const options = [...new Set((Array.isArray(item?.options) ? item.options : []).map((option) => typeof option === 'string' ? option : option?.label)
        .map((option) => String(option || '').trim().slice(0, 160)).filter(Boolean))].slice(0, 6);
      return { id: String(item?.id || item?.reason || `clarification_${index + 1}`).trim().slice(0, 120),
        header: String(item?.header || '').trim().slice(0, 120), reason: String(item?.reason || 'model_requires_clarification').trim().slice(0, 500),
        question, options, allowOther: item?.allowOther !== false, required: item?.required !== false };
    }).filter((item) => item.question);
    if (!clarifications.length) throw decisionError('A clarification decision requires at least one question.');
    return {
      version,
      decision,
      confidence,
      answer: '',
      clarification: { reason: clarifications[0].reason, question: clarifications[0].question, options: clarifications[0].options },
      clarifications,
      nodes: [],
      finalNodeId: '',
      deliverablePlan: null,
      agentSelectionRationale: '',
      mentionedAgentsNotSelected: [],
      routingRationale: String(value.routingRationale || '').trim().slice(0, 2000),
      organizationResearch,
    };
  }

  if (decision === 'execution_mode_choice') {
    if (sourceNodes.length || sourceDeliverables.length) throw decisionError('An execution mode choice cannot contain task nodes or deliverables.');
    if (confidence >= AUTOMATIC_DECISION_CONFIDENCE) {
      throw decisionError(`An execution mode choice is only valid below confidence ${AUTOMATIC_DECISION_CONFIDENCE}.`);
    }
    const recommendedMode = String(value.executionModeChoice?.recommendedMode || value.recommendedMode || '').trim().toLowerCase();
    if (!['direct', 'scheduler'].includes(recommendedMode)) throw decisionError('An execution mode choice requires recommendedMode=direct|scheduler.');
    const routingRationale = String(value.executionModeChoice?.routingRationale || value.routingRationale || '').trim().slice(0, 2000);
    if (!routingRationale) throw decisionError('An execution mode choice requires a concise routing rationale.');
    return {
      version,
      decision,
      confidence,
      answer: '',
      clarification: null,
      executionModeChoice: {
        recommendedMode,
        routingRationale,
        directModeSummary: String(value.executionModeChoice?.directModeSummary || '').trim().slice(0, 500)
          || '由 uBuddy 直接完成，流程更快，不创建多 Agent 任务图。',
        schedulerModeSummary: String(value.executionModeChoice?.schedulerModeSummary || '').trim().slice(0, 500)
          || '由 uBuddy 拆分任务、选择专业 Agent、跟踪进度、审核并统一交付。',
      },
      nodes: [],
      finalNodeId: '',
      deliverablePlan: null,
      agentSelectionRationale: '',
      mentionedAgentsNotSelected: [],
      routingRationale,
      organizationResearch,
    };
  }

  if (confidence < AUTOMATIC_DECISION_CONFIDENCE) {
    throw decisionError(`A task plan decision requires confidence of at least ${AUTOMATIC_DECISION_CONFIDENCE}; use execution_mode_choice when direct execution is also viable, or clarification when requirements are missing.`);
  }
  if (!sourceDeliverables.length) throw decisionError('A task plan decision requires at least one declared deliverable.');
  const graph = validateUBuddyTaskGraphProposal({
    version: 2,
    status: 'ready',
    confidence,
    nodes: sourceNodes,
    deliverables: sourceDeliverables,
  }, candidates);
  if (graph.status !== 'ready') throw decisionError('A task plan decision must contain a ready task graph.');
  if (!graph.deliverablePlan?.deliverables?.length) throw decisionError('A task plan decision requires a valid deliverable plan.');
  const rationale = String(value.agentSelectionRationale || '').trim().slice(0, 4000);
  if (!rationale) throw decisionError('A task plan decision requires agentSelectionRationale.');
  const selectedAgentIds = new Set(graph.nodes.map((node) => node.agentId));
  const unusedMentioned = mentioned.filter((agentId) => !selectedAgentIds.has(agentId));
  const explanations = normalizeMentionExplanations(value.mentionedAgentsNotSelected);
  const explanationIds = new Set(explanations.map((item) => item.agentId));
  const missingExplanations = unusedMentioned.filter((agentId) => !explanationIds.has(agentId));
  if (missingExplanations.length) {
    throw decisionError(`The task plan omitted mentioned Agents without explanation: ${missingExplanations.join(', ')}.`);
  }
  const unexpectedExplanations = explanations.filter((item) => !unusedMentioned.includes(item.agentId));
  if (unexpectedExplanations.length) {
    throw decisionError(`mentionedAgentsNotSelected contains selected or unmentioned Agents: ${unexpectedExplanations.map((item) => item.agentId).join(', ')}.`);
  }
  return {
    version,
    decision,
    confidence,
    answer: '',
    clarification: null,
    nodes: graph.nodes,
    finalNodeId: graph.finalNodeId,
    deliverablePlan: graph.deliverablePlan,
    agentSelectionRationale: rationale,
    mentionedAgentsNotSelected: explanations,
    routingRationale: String(value.routingRationale || rationale).trim().slice(0, 2000),
    organizationResearch,
  };
}

export function detectMentionedUBuddyAgentIds({ prompt = '', mentions = [], candidates = [], organization = { agents: [] } } = {}) {
  const explicit = (Array.isArray(mentions) ? mentions : [])
    .filter((item) => item?.principalType === 'agent')
    .map((item) => String(item.agentId || '').trim()).filter(Boolean);
  const compactPrompt = normalizeMentionText(prompt);
  const activeIds = new Set(normalizeCandidates(candidates).map((item) => item.agentId));
  const knownAgents = Array.isArray(organization?.agents) ? organization.agents : [];
  const textual = knownAgents.filter((agent) => {
    if (!agent?.id || agent.id === 'secretary_agent') return false;
    const aliases = [
      agent.id,
      agent.name,
      String(agent.name || '').replace(/\s+agent$/i, ''),
      agent.id === 'general_agent' ? '通用Agent' : '',
      agent.id === 'ppt' ? 'PPTAgent' : '',
    ].map(normalizeMentionText).filter((item) => item.length >= 3);
    return aliases.some((alias) => compactPrompt.includes(alias));
  }).map((agent) => agent.id);
  return [...new Set([...explicit, ...textual])].filter((agentId) => activeIds.has(agentId) || knownAgents.some((agent) => agent.id === agentId));
}

function buildUBuddyTurnDecisionPrompt({ prompt, recentMessages, skill, memory, attachmentSummaries, candidates, mentionedAgentIds, decisionMode = 'unified' }) {
  return [
    '【UBUDDY_TURN_DECISION_V2】',
    'Return exactly one JSON object and no Markdown. You are the owner\'s uBuddy. Make one unified semantic decision for this turn.',
    'Write every user-visible field in the same language as the current owner message. This includes answers, clarification questions and options, execution-mode summaries, task titles, objectives, fallbacks, deliverable titles, rationales, and omission reasons.',
    'Choose decision=direct_answer when the full Codex uBuddy can complete the request itself: conversation, research, writing, summaries, analysis, or one coherent bounded project change that does not materially benefit from specialist ownership or a dependency graph. This is a routing decision only; do not perform the work in this read-only call.',
    'A request whose sole purpose is to inspect progress, results, artifacts, review status, or pending state of existing work is direct_answer. The full Codex uBuddy will call verified Janus query tools after this routing decision. Do not turn an existing-work query into a new task plan.',
    'Always include organizationResearch={requiresOrganizationResearch,continuesResearchTopic,filters}. Set requiresOrganizationResearch=true only when the owner explicitly asks to investigate organization messages or the request cannot be answered without them; ordinary chat must remain false. filters may contain personIds,conversationIds,sourceKinds,after,before. Set continuesResearchTopic=true only for a semantically same-topic follow-up within the active research context.',
    'Choose decision=clarification when a material ambiguity would change the final deliverable or execution plan. Ask one concise question and always provide 2-4 useful suggested answers, including plausible concrete answers for open-ended questions. The UI separately provides a free-form “other answer” field, so do not add an “other” option.',
    'Choose decision=task_plan when the request clearly benefits from a specialist Agent, durable background tracking, multiple independent domains, multiple deliverables, or dependent stages. Produce the complete executable graph now.',
    `Choose decision=execution_mode_choice only when the request is clear, both direct Codex execution and Scheduler execution are genuinely suitable, and confidence in the recommended mode is below ${AUTOMATIC_DECISION_CONFIDENCE}. Do not use it for ordinary questions or clearly multi-stage work.`,
    decisionMode === 'formal_task'
      ? 'This input is an already-published external delegation. You MUST choose task_plan unless a material missing requirement makes execution unsafe; in that case choose clarification. Never choose direct_answer.'
      : '',
    decisionMode === 'explicit_new_task'
      ? 'The owner explicitly selected “create new task”. You MUST create an independent task_plan unless a material missing requirement makes execution unsafe; in that case choose clarification. Never choose direct_answer or append this work to an existing task.'
      : '',
    decisionMode === 'composer_task'
      ? 'The owner authoritatively selected Task mode and the structured intake is ready. You MUST return task_plan for a new formal Scheduler task. Never choose direct_answer, clarification, or execution_mode_choice, and never reinterpret creation-negating words in the message as a mode change.'
      : '',
    decisionMode === 'intake_ready'
      ? 'The structured intake gate has already resolved every material task ambiguity. Do not ask another requirements clarification question. Choose direct_answer, execution_mode_choice, or task_plan based only on the execution-routing rules above.'
      : '',
    decisionMode === 'task_continuation'
      ? 'This is a FIFO continuation of an existing formal task after the owner supplied a supplement. You MUST create a successor task_plan now. Never choose direct_answer or clarification, and preserve the original objective while applying the supplement.'
      : '',
    decisionMode === 'forced_scheduler'
      ? 'The owner explicitly selected multi-Agent Scheduler execution. You MUST choose task_plan unless a genuinely missing task requirement requires clarification. Never choose direct_answer or execution_mode_choice.'
      : '',
    'uBuddy coordinates and must never appear as a task node. Use only supplied active employee candidates. Exactly one node must have isFinal=true and dependencies must form a DAG.',
    'Use the fewest useful nodes, normally 1-4. Every node requires localId, title, objective, agentId, agentInstanceId, dependencies, outputFormat, isFinal, blocking, and fallback.',
    'For task_plan, include at least one deliverable, exactly one primary deliverable owned by the final node, and a non-empty agentSelectionRationale.',
    'Use the canonical deliverable keys exactly: id, role, type, title, ownerLocalId, deliveryMode, requiredExtensions, constraints. ownerLocalId must exactly equal one nodes[].localId. Do not use type=pptx; use type=presentation.',
    'Agent names mentioned by the user are advisory, not mandatory. If a mentioned Agent is not selected in task_plan, or if you choose direct_answer instead of assigning it, include exactly one mentionedAgentsNotSelected entry with its agentId and a user-visible reason. Never silently omit it.',
    'Allowed deliverable types: answer, report, document, presentation, spreadsheet, image, code_change. Use deliveryMode=file and requiredExtensions=[".pptx"] for presentations; preserve exact requested slide counts in constraints.exactSlideCount.',
    'Do not execute tools or modify files during this decision. Invalid JSON or an invalid graph is a planning failure; there is no deterministic routing fallback.',
    `Current effective uBuddy Skill:\n${clipText(skill || 'No effective Skill is available.', 12000)}`,
    `Current governed uBuddy Memory:\n${clipText(memory || 'No approved Memory is available.', 5000)}`,
    `Recent visible conversation:\n${formatRecentMessages(recentMessages) || 'No previous visible conversation.'}`,
    `Attachment summaries:\n${JSON.stringify((Array.isArray(attachmentSummaries) ? attachmentSummaries : []).slice(0, 20))}`,
    `User-mentioned Agent ids (advisory):\n${JSON.stringify(mentionedAgentIds)}`,
    `Active employee candidates:\n${JSON.stringify(candidates)}`,
    `Current owner message:\n${prompt}`,
    'Schema: {"version":"UBUDDY_TURN_DECISION_V2","decision":"direct_answer|clarification|execution_mode_choice|task_plan","confidence":0.9,"answer":"optional legacy preview only","routingRationale":"brief reason","clarifications":[{"id":"...","header":"...","reason":"...","question":"...","options":["..."],"allowOther":true,"required":true}],"executionModeChoice":{"recommendedMode":"direct|scheduler","routingRationale":"why both modes are viable","directModeSummary":"...","schedulerModeSummary":"..."},"nodes":[],"deliverables":[],"agentSelectionRationale":"required for task_plan","mentionedAgentsNotSelected":[]}.',
  ].join('\n\n');
}

function normalizeCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : []).filter((item) => item?.agentId && item?.agentInstanceId).map((item) => ({
    agentId: String(item.agentId),
    agentInstanceId: String(item.agentInstanceId),
    name: String(item.name || item.displayName || item.agentId),
    departmentId: String(item.departmentId || ''),
    status: String(item.status || 'idle'),
    availability: String(item.availability || ''),
    queueDepth: Math.max(0, Number(item.queueDepth || 0)),
    performanceLevel: String(item.performanceLevel || 'P1'),
    leadershipLevel: String(item.leadershipLevel || 'L0'),
    leadershipScore: Math.max(0, Math.min(100, Number(item.leadershipScore || 0))),
    responsibilities: clipText(item.responsibilities || item.responsibility || '', 2000),
    effectiveSkill: clipText(item.effectiveSkill || item.skill || '', 6000),
    specializations: Array.isArray(item.specializations) ? item.specializations.slice(0, 20) : [],
  }));
}

function normalizeMentionExplanations(value = []) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map((item) => ({
    agentId: String(item?.agentId || '').trim(),
    reason: String(item?.reason || '').trim().slice(0, 1000),
  })).filter((item) => {
    if (!item.agentId || !item.reason || seen.has(item.agentId)) return false;
    seen.add(item.agentId);
    return true;
  });
}

function formatRecentMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).slice(-12).map((message) => {
    const role = String(message?.role || 'user').trim();
    return `${role}: ${clipText(message?.content || '', 900)}`;
  }).filter((item) => !item.endsWith(': ')).join('\n');
}

function parseJsonAnswer(answer = '') {
  const text = String(answer || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw decisionError('uBuddy model decision did not return JSON.');
  return JSON.parse(fenced.slice(start, end + 1));
}

function normalizeMentionText(value = '') {
  return String(value || '').toLowerCase().replace(/[\s_\-·.]+/g, '');
}

function clipText(value = '', limit = 1000) {
  const text = String(value || '');
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function decisionError(message, cause = null) {
  const error = new Error(message);
  error.code = 'ubuddy_turn_decision_failed';
  if (cause) error.cause = cause;
  return error;
}
