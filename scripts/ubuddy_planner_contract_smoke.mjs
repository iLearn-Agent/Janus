import assert from 'node:assert/strict';

import { createPickerMentionEntity, normalizeMentionEntities } from '../src/shared/contracts/mentions.js';
import { classifyUBuddyIntent } from '../src/main/modules/orchestration/application/uBuddyIntentClassifier.js';
import {
  DEFAULT_UBUDDY_PLANNER_TIMEOUT_MS,
  validateUBuddyTaskGraphProposal,
} from '../src/main/modules/orchestration/application/uBuddyTaskGraphPlanner.js';
import {
  UBUDDY_TURN_DECISION_VERSION,
  decideUBuddyTurn,
  detectMentionedUBuddyAgentIds,
  validateUBuddyTurnDecision,
} from '../src/main/modules/orchestration/application/uBuddyTurnDecisionPlanner.js';
import {
  parseUBuddyEscalation,
  planUBuddyRoute,
  selectUBuddyEscalationCandidate,
  UBUDDY_ESCALATION_TAG,
} from '../src/main/modules/orchestration/application/uBuddyRoutePlanner.js';
import { ensureLeaderSynthesisNode, selectTaskLeader } from '../src/main/modules/orchestration/domain/leaderCoordinator.js';

assert.equal(DEFAULT_UBUDDY_PLANNER_TIMEOUT_MS, 180_000);
assert.equal(UBUDDY_TURN_DECISION_VERSION, 'UBUDDY_TURN_DECISION_V2');

const candidates = [
  { agentId: 'general_agent', agentInstanceId: 'instance_general', departmentId: 'general', performanceLevel: 'P1', provisional: true, queueDepth: 0 },
  { agentId: 'ppt_agent', agentInstanceId: 'instance_ppt', departmentId: 'ppt_department', performanceLevel: 'P8', provisional: false, queueDepth: 2 },
];

const valid = validateUBuddyTaskGraphProposal({ nodes: [
  { localId: 'research', title: 'Research', objective: 'Collect evidence.', agentId: 'general_agent', dependencies: [], outputFormat: 'evidence list', isFinal: false },
  { localId: 'final', title: 'Final', objective: 'Synthesize the final delivery.', agentId: 'ppt_agent', dependencies: ['research'], outputFormat: 'final deliverable', isFinal: true },
] }, candidates);
assert.equal(valid.nodes.length, 2);
assert.equal(valid.finalNodeId, 'final');
assert.deepEqual(valid.nodes.map((item) => item.localId), ['research', 'final']);

const plannedDeliverables = validateUBuddyTaskGraphProposal({
  version: 2,
  status: 'ready',
  confidence: 0.94,
  nodes: [
    { localId: 'report', title: '中国环境材料', objective: '整理中国环境报告材料。', agentId: 'general_agent', dependencies: [], outputFormat: '报告材料', isFinal: false },
    { localId: 'deck', title: '五页中国环境PPT', objective: '基于材料生成五页PPT。', agentId: 'ppt_agent', dependencies: ['report'], outputFormat: '可编辑 PPTX', isFinal: true },
  ],
  deliverables: [
    { id: 'source_report', role: 'intermediate', type: 'report', title: '中国环境报告', ownerLocalId: 'report', deliveryMode: 'inline' },
    { id: 'final_deck', role: 'primary', type: 'presentation', title: '中国环境PPT', ownerLocalId: 'deck', deliveryMode: 'file', requiredExtensions: ['.pptx'], constraints: { exactSlideCount: 5 } },
  ],
}, candidates);
assert.equal(plannedDeliverables.version, 2);
assert.equal(plannedDeliverables.deliverablePlan.deliverables.find((item) => item.role === 'primary')?.type, 'presentation');
assert.equal(plannedDeliverables.deliverablePlan.deliverables.find((item) => item.role === 'primary')?.constraints.exactSlideCount, 5);

const unifiedDirect = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2',
  decision: 'direct_answer',
  confidence: 0.96,
  answer: '这是直接回答。',
  nodes: [],
  deliverables: [],
}, { candidates });
assert.equal(unifiedDirect.decision, 'direct_answer');
assert.equal(unifiedDirect.nodes.length, 0);
const openEndedTurnClarification = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2', decision: 'clarification', confidence: 0.6,
  clarification: { reason: 'missing_objective', question: '最需要推进的科研目标是什么？', options: [] },
  nodes: [], deliverables: [],
}, { candidates });
assert.equal(openEndedTurnClarification.clarifications.length, 1);
assert.equal(openEndedTurnClarification.clarifications[0].options.length, 0);
const multiTurnClarification = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2', decision: 'clarification', confidence: 0.6,
  clarifications: [
    { id: 'scope', question: '处理哪个范围？', options: ['当前项目', '全部项目'] },
    { id: 'deadline', question: '什么时候交付？', options: [] },
  ], nodes: [], deliverables: [],
}, { candidates });
assert.equal(multiTurnClarification.clarifications.length, 2);
assert.throws(() => validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.7,
  answer: '', nodes: [], deliverables: [], mentionedAgentsNotSelected: [],
}, { candidates }), /execution_mode_choice/i);
const executionModeChoice = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2', decision: 'execution_mode_choice', confidence: 0.64,
  routingRationale: '直接执行更快，多 Agent 协作则有独立审核，两种方式都适合。',
  executionModeChoice: {
    recommendedMode: 'scheduler',
    routingRationale: '直接执行更快，多 Agent 协作则有独立审核，两种方式都适合。',
    directModeSummary: '由 uBuddy 一次完成。',
    schedulerModeSummary: '拆分并审核。',
  },
  nodes: [], deliverables: [],
}, { candidates });
assert.equal(executionModeChoice.executionModeChoice.recommendedMode, 'scheduler');
assert.throws(() => validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.9,
  answer: '我直接回答。', nodes: [], deliverables: [], mentionedAgentsNotSelected: [],
}, { candidates, mentionedAgentIds: ['ppt_agent'] }), /did not explain/i);

const unifiedReportToPpt = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2',
  decision: 'task_plan',
  confidence: 0.96,
  answer: '',
  nodes: [
    { localId: 'report', title: '中国环境报告', objective: '撰写中国环境报告。', agentId: 'general_agent', agentInstanceId: 'instance_general', dependencies: [], outputFormat: '结构化报告', isFinal: false, blocking: true, fallback: '说明缺失资料。' },
    { localId: 'deck', title: '五页中国环境PPT', objective: '依据报告生成五页PPT。', agentId: 'ppt_agent', agentInstanceId: 'instance_ppt', dependencies: ['report'], outputFormat: '可编辑 PPTX', isFinal: true, blocking: true, fallback: '报告无法使用时说明原因。' },
  ],
  deliverables: [
    { id: 'report_material', role: 'intermediate', type: 'report', title: '中国环境报告', ownerLocalId: 'report', deliveryMode: 'inline' },
    { id: 'deck_file', role: 'primary', type: 'presentation', title: '中国环境PPT', ownerLocalId: 'deck', deliveryMode: 'file', requiredExtensions: ['.pptx'], constraints: { exactSlideCount: 5 } },
  ],
  agentSelectionRationale: '通用 Agent 负责报告内容，PPT Agent 负责最终演示文稿。',
  mentionedAgentsNotSelected: [],
}, { candidates, mentionedAgentIds: ['general_agent', 'ppt_agent'] });
assert.equal(unifiedReportToPpt.decision, 'task_plan');
assert.deepEqual(unifiedReportToPpt.nodes.map((node) => node.agentId), ['general_agent', 'ppt_agent']);
assert.equal(unifiedReportToPpt.deliverablePlan.deliverables.find((item) => item.role === 'primary')?.constraints.exactSlideCount, 5);

const aliasedDeliverable = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2',
  decision: 'task_plan',
  confidence: 0.93,
  nodes: [{ localId: 'deck', title: '五页PPT', objective: '生成五页PPT。', agentId: 'ppt_agent', agentInstanceId: 'instance_ppt', dependencies: [], outputFormat: 'PPTX', isFinal: true, blocking: true, fallback: '说明原因。' }],
  deliverables: [{ id: 'deck', role: 'final', type: 'pptx', title: '五页PPT', ownerNodeId: 'deck', deliveryMode: 'file', requiredExtensions: '.pptx', constraints: { slideCount: 5 } }],
  agentSelectionRationale: 'PPT Agent 负责最终演示文稿。',
  mentionedAgentsNotSelected: [],
}, { candidates });
assert.equal(aliasedDeliverable.deliverablePlan.deliverables[0].role, 'primary');
assert.equal(aliasedDeliverable.deliverablePlan.deliverables[0].type, 'presentation');
assert.equal(aliasedDeliverable.deliverablePlan.deliverables[0].ownerLocalId, 'deck');
assert.equal(aliasedDeliverable.deliverablePlan.deliverables[0].constraints.exactSlideCount, 5);

const inferredSolePrimaryOwner = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2',
  decision: 'task_plan',
  confidence: 0.93,
  nodes: [{ localId: 'final', title: '最终报告', objective: '撰写最终报告。', agentId: 'general_agent', agentInstanceId: 'instance_general', dependencies: [], outputFormat: '报告', isFinal: true, blocking: true, fallback: '说明原因。' }],
  deliverables: [{ id: 'report', role: 'primary', type: 'report', title: '最终报告', deliveryMode: 'inline' }],
  agentSelectionRationale: '通用 Agent 负责最终报告。',
  mentionedAgentsNotSelected: [],
}, { candidates });
assert.equal(inferredSolePrimaryOwner.deliverablePlan.deliverables[0].ownerLocalId, 'final');

assert.throws(() => validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2',
  decision: 'task_plan',
  confidence: 0.93,
  nodes: [{ localId: 'final', title: '结果', objective: '完成结果。', agentId: 'general_agent', agentInstanceId: 'instance_general', dependencies: [], outputFormat: 'text', isFinal: true, blocking: true, fallback: '说明原因。' }],
  deliverables: [{ id: 'bad', role: 'primary', type: 'video', title: '视频', ownerLocalId: 'final' }],
  agentSelectionRationale: '通用 Agent 执行。',
  mentionedAgentsNotSelected: [],
}, { candidates }), /deliverables\[0\]\.type is invalid: video/i);

assert.throws(() => validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2',
  decision: 'task_plan',
  confidence: 0.93,
  nodes: [{ localId: 'final', title: '结果', objective: '完成结果。', agentId: 'general_agent', agentInstanceId: 'instance_general', dependencies: [], outputFormat: 'text', isFinal: true, blocking: true, fallback: '说明原因。' }],
  deliverables: [{ id: 'bad', role: 'primary', type: 'document', title: '文档', ownerLocalId: 'missing_node' }],
  agentSelectionRationale: '通用 Agent 执行。',
  mentionedAgentsNotSelected: [],
}, { candidates }), /ownerLocalId references unknown node missing_node/i);

const unifiedSingleAgentTask = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2',
  decision: 'task_plan',
  confidence: 0.91,
  nodes: [{ localId: 'final', title: '整理名单', objective: '整理并核对名单。', agentId: 'general_agent', agentInstanceId: 'instance_general', dependencies: [], outputFormat: '核对后的名单', isFinal: true, blocking: true, fallback: '列出无法核对的条目。' }],
  deliverables: [{ id: 'primary', role: 'primary', type: 'document', title: '核对名单', ownerLocalId: 'final', deliveryMode: 'inline' }],
  agentSelectionRationale: '这是正式交付任务，由通用 Agent 单节点执行。',
  mentionedAgentsNotSelected: [],
}, { candidates, mentionedAgentIds: ['general_agent'] });
assert.equal(unifiedSingleAgentTask.nodes.length, 1, 'formal single-Agent work must remain a task graph');

assert.throws(() => validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2',
  decision: 'task_plan',
  confidence: 0.9,
  nodes: [{ localId: 'final', title: '报告', objective: '撰写报告。', agentId: 'general_agent', agentInstanceId: 'instance_general', dependencies: [], outputFormat: '报告', isFinal: true, blocking: true, fallback: '说明原因。' }],
  deliverables: [{ id: 'primary', role: 'primary', type: 'report', title: '报告', ownerLocalId: 'final', deliveryMode: 'inline' }],
  agentSelectionRationale: '通用 Agent 更适合报告。',
  mentionedAgentsNotSelected: [],
}, { candidates, mentionedAgentIds: ['ppt_agent'] }), /without explanation/i);

const ignoredMention = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2',
  decision: 'task_plan',
  confidence: 0.9,
  nodes: [{ localId: 'final', title: '报告', objective: '撰写报告。', agentId: 'general_agent', agentInstanceId: 'instance_general', dependencies: [], outputFormat: '报告', isFinal: true, blocking: true, fallback: '说明原因。' }],
  deliverables: [{ id: 'primary', role: 'primary', type: 'report', title: '报告', ownerLocalId: 'final', deliveryMode: 'inline' }],
  agentSelectionRationale: '通用 Agent 更适合报告。',
  mentionedAgentsNotSelected: [{ agentId: 'ppt_agent', reason: '当前只需要书面报告，不需要演示文稿。' }],
}, { candidates, mentionedAgentIds: ['ppt_agent'] });
assert.equal(ignoredMention.mentionedAgentsNotSelected[0].agentId, 'ppt_agent');

await assert.rejects(() => decideUBuddyTurn({
  prompt: '写一份报告',
  candidates,
  execute: async () => 'not json',
}), (error) => {
  assert.match(error.message, /did not return JSON/i);
  assert.equal(error.uBuddyRawAnswerPreview, 'not json');
  return true;
});

let capturedUnifiedPrompt = '';
await decideUBuddyTurn({
  prompt: '解释这个概念',
  candidates,
  execute: async ({ prompt }) => {
    capturedUnifiedPrompt = prompt;
    return JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.95,
      answer: '概念解释。', nodes: [], deliverables: [], mentionedAgentsNotSelected: [],
    });
  },
});
assert.match(capturedUnifiedPrompt, /ownerLocalId/);
assert.match(capturedUnifiedPrompt, /Do not use type=pptx/);

await assert.rejects(() => decideUBuddyTurn({
  prompt: '这是其他用户正式派发的任务',
  candidates,
  decisionMode: 'formal_task',
  execute: async () => JSON.stringify({
    version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.95,
    answer: '不应直接回答。', nodes: [], deliverables: [], mentionedAgentsNotSelected: [],
  }),
}), /formal external delegation/i);

assert.deepEqual(detectMentionedUBuddyAgentIds({
  prompt: '让通用Agent写报告，然后交给PPT Agent生成5页PPT',
  candidates,
  organization: { agents: [{ id: 'general_agent', name: '通用 Agent' }, { id: 'ppt_agent', name: 'PPT Agent' }] },
}), ['general_agent', 'ppt_agent']);

const clarification = validateUBuddyTaskGraphProposal({
  version: 2,
  status: 'needs_clarification',
  confidence: 0.4,
  clarification: { question: '最终需要报告还是PPT？', options: ['报告', 'PPT'] },
}, candidates);
assert.equal(clarification.status, 'needs_clarification');
assert.equal(clarification.nodes.length, 0);
assert.deepEqual(clarification.clarification.options, ['报告', 'PPT']);

assert.throws(() => validateUBuddyTaskGraphProposal({ nodes: [
  { localId: 'a', objective: 'A', agentId: 'general_agent', dependencies: ['b'], outputFormat: 'text', isFinal: false },
  { localId: 'b', objective: 'B', agentId: 'general_agent', dependencies: ['a'], outputFormat: 'text', isFinal: true },
] }, candidates), /cycle/i);
assert.throws(() => validateUBuddyTaskGraphProposal({ nodes: [
  { localId: 'final', objective: 'Final', agentId: 'secretary_agent', dependencies: [], outputFormat: 'text', isFinal: true },
] }, candidates), /inactive|invalid/i);
assert.throws(() => validateUBuddyTaskGraphProposal({ nodes: [
  { localId: 'work', objective: 'Work', agentId: 'general_agent', dependencies: [], outputFormat: 'text', isFinal: false },
] }, candidates), /exactly one final/i);

const mention = createPickerMentionEntity({ principalType: 'user', userId: 'user_bob', displayText: '@Bob' });
assert.deepEqual(normalizeMentionEntities([mention], { content: '@Bob 请处理任务。' }).map((item) => item.userId), ['user_bob']);
assert.equal(normalizeMentionEntities([mention], { content: '请处理任务。' }).length, 0, 'deleted display text must invalidate its mention');
assert.equal(normalizeMentionEntities([{ principalType: 'user', userId: 'user_bob', displayText: '@Bob', mentionId: 'manual' }], { content: '@Bob 请处理任务。' }).length, 0, 'manual text must not become a picker mention');
const agentMention = createPickerMentionEntity({ principalType: 'agent', agentId: 'ppt', agentInstanceId: 'instance_ppt', displayText: '@PPT Designer' });
assert.equal(normalizeMentionEntities([agentMention], { content: '@PPT Designer 做一个汇报 PPT' })[0]?.agentInstanceId, 'instance_ppt');

const routeCandidates = [
  { agentId: 'general_agent', agentInstanceId: 'instance_general', departmentId: 'general' },
  { agentId: 'ppt', agentInstanceId: 'instance_ppt', departmentId: 'ppt_department' },
];
const routeOrganization = { agents: [
  { id: 'general_agent', name: 'Generalist' },
  { id: 'ppt', name: 'PPT Designer' },
] };
assert.equal(planUBuddyRoute({ prompt: '帮我把这段话改简洁', candidates: routeCandidates, organization: routeOrganization }).mode, 'direct');
assert.deepEqual(planUBuddyRoute({ prompt: '告诉通用Agent，让它整理名单', candidates: routeCandidates, organization: routeOrganization }), {
  version: 'ubuddy_route_v2', mode: 'single_agent', source: 'explicit', reasonCode: 'agent_explicitly_requested',
  targetAgentId: 'general_agent', targetAgentInstanceId: '', explicitAgentIds: ['general_agent'], explicitAgentInstanceIds: [], requiredCapabilities: [], reason: '',
});
assert.equal(planUBuddyRoute({ prompt: '制作一份项目汇报 PPT', candidates: routeCandidates, organization: routeOrganization }).targetAgentId, 'ppt');
assert.equal(planUBuddyRoute({ prompt: '让 Generalist 和 PPT Designer 协作完成', candidates: routeCandidates, organization: routeOrganization }).mode, 'workflow');
assert.equal(planUBuddyRoute({ prompt: '让通用 Agent 和 PPT Agent 协作完成', candidates: routeCandidates, organization: routeOrganization }).mode, 'workflow');
const friendMention = createPickerMentionEntity({ principalType: 'user', userId: 'user_admin', displayText: '@管理员' });
assert.equal(classifyUBuddyIntent({ prompt: '你现在几点？', route: { mode: 'direct' } }).intent, 'direct_answer');
const externalQuestionDecision = classifyUBuddyIntent({ prompt: '@管理员 问一下他什么时候开会', mentions: [friendMention], friendships: [{ friend: { id: 'user_admin', displayName: '管理员' } }], route: { mode: 'direct' } });
assert.equal(externalQuestionDecision.intent, 'single_agent_task');
assert.equal(externalQuestionDecision.executionMode, 'external_single_delegation');
assert.deepEqual(externalQuestionDecision.reasonCodes, ['task_mode_external_delegation']);
const reportDecision = classifyUBuddyIntent({ prompt: '@管理员 写一份环境治理报告', mentions: [friendMention], friendships: [{ friend: { id: 'user_admin', displayName: '管理员' } }], route: { mode: 'direct' } });
assert.equal(reportDecision.executionMode, 'external_single_delegation');
assert.equal(reportDecision.requiresTaskGroup, false);
const pptDecision = classifyUBuddyIntent({ prompt: '@PPT Designer 做一个汇报 PPT', mentions: [agentMention], candidates: routeCandidates, route: { mode: 'single_agent', targetAgentId: 'ppt', targetAgentInstanceId: 'instance_ppt' } });
assert.equal(pptDecision.executionMode, 'local_single_agent');
const mixedDecision = classifyUBuddyIntent({ prompt: '@管理员和PPT Designer 分工做一个项目方案', mentions: [friendMention, agentMention], friendships: [{ friend: { id: 'user_admin', displayName: '管理员' } }], candidates: routeCandidates, route: { mode: 'single_agent', targetAgentId: 'ppt', targetAgentInstanceId: 'instance_ppt' } });
assert.equal(mixedDecision.intent, 'multi_agent_task');
assert.equal(mixedDecision.requiresTaskGroup, true);
const escalation = parseUBuddyEscalation(`<${UBUDDY_ESCALATION_TAG}>{"mode":"single_agent","targetAgentId":"ppt","reasonCode":"specialist_required"}</${UBUDDY_ESCALATION_TAG}>`);
assert.equal(escalation.mode, 'single_agent');
assert.equal(escalation.targetAgentId, 'ppt');
const capabilityCandidate = selectUBuddyEscalationCandidate([
  {
    agentId: 'general_agent', agentInstanceId: 'instance_general', queueDepth: 0,
    effectiveSkill: '通用问答与分析，文件和代码任务处理，跨领域问题求解，结果验证与清晰交付',
  },
  {
    agentId: 'ppt', agentInstanceId: 'instance_ppt', queueDepth: 0,
    effectiveSkill: '制作、编辑和验证可交付的 PPTX 演示文稿',
  },
], {
  requiredCapabilities: ['program_execution', 'cryptographic_hash_verification'],
});
assert.equal(capabilityCandidate?.agentId, 'general_agent');
assert.equal(selectUBuddyEscalationCandidate([
  { agentId: 'general_agent', agentInstanceId: 'instance_general', effectiveSkill: '文件和代码任务处理' },
], { requiredCapabilities: ['medical_diagnosis'] }), null, 'unmatched specialist capabilities must not fall back to an unrelated Agent');

const sameFamilyCandidates = [
  { agentId: 'general_agent', agentInstanceId: 'instance_general_a', name: '通用 Agent A', performanceLevel: 'P2', queueDepth: 3 },
  { agentId: 'general_agent', agentInstanceId: 'instance_general_b', name: '备用研究助手', performanceLevel: 'P4', queueDepth: 0 },
];
const explicitInstanceGraph = validateUBuddyTaskGraphProposal({ nodes: [{
  localId: 'final', objective: '整理研究结果', agentId: 'general_agent', agentInstanceId: 'instance_general_b',
  dependencies: [], outputFormat: 'markdown', isFinal: true,
}] }, sameFamilyCandidates);
assert.equal(explicitInstanceGraph.nodes[0].agentInstanceId, 'instance_general_b');
const compatibleFamilyGraph = validateUBuddyTaskGraphProposal({ nodes: [{
  localId: 'final', objective: '整理研究结果', agentId: 'general_agent', dependencies: [], outputFormat: 'markdown', isFinal: true,
}] }, sameFamilyCandidates);
assert.equal(compatibleFamilyGraph.nodes[0].agentInstanceId, 'instance_general_b', 'legacy family-only plans must select the best active instance deterministically');
const customNamedRoute = planUBuddyRoute({ prompt: '请让备用研究助手处理这份材料', candidates: sameFamilyCandidates, organization: routeOrganization });
assert.equal(customNamedRoute.targetAgentInstanceId, 'instance_general_b');
assert.deepEqual(customNamedRoute.explicitAgentInstanceIds, ['instance_general_b']);

const selectedLeader = selectTaskLeader([
  { agentId: 'general_agent', agentInstanceId: 'instance_b', leadershipLevel: 'L1', leadershipScore: 90, rank: 'lead', performanceLevel: 'P10', relevanceScore: 10 },
  { agentId: 'ppt', agentInstanceId: 'instance_a', leadershipLevel: 'L2', leadershipScore: 10, rank: 'junior', performanceLevel: 'P1', relevanceScore: 0 },
]);
assert.equal(selectedLeader.agentInstanceId, 'instance_a', 'L level must sort before leadership score, rank, P level, and relevance');
const performanceTieBreak = selectTaskLeader([
  { agentId: 'general_agent', agentInstanceId: 'instance_b', leadershipLevel: 'L0', leadershipScore: 0, rank: 'specialist', performanceLevel: 'P3', relevanceScore: 1 },
  { agentId: 'ppt', agentInstanceId: 'instance_a', leadershipLevel: 'L0', leadershipScore: 0, rank: 'specialist', performanceLevel: 'P8', relevanceScore: 1 },
]);
assert.equal(performanceTieBreak.agentInstanceId, 'instance_a', 'P level must break ties after static rank');
const synthesisGraph = ensureLeaderSynthesisNode([
  { localId: 'research', agentId: 'general_agent', agentInstanceId: 'instance_general', dependencies: [], blocking: true, isFinal: false, outputFormat: 'markdown' },
  { localId: 'delivery', agentId: 'ppt', agentInstanceId: 'instance_ppt', dependencies: ['research'], blocking: true, isFinal: true, outputFormat: 'markdown' },
], { agentId: 'general_agent', agentInstanceId: 'instance_general', departmentId: 'general' });
const synthesis = synthesisGraph.find((node) => node.nodeKind === 'leader_synthesis');
assert.ok(synthesis);
assert.equal(synthesis.agentInstanceId, 'instance_general');
assert.deepEqual(synthesis.dependencies, ['delivery']);
assert.equal(synthesis.isFinal, true);

console.log(JSON.stringify({ ok: true, checks: ['planner_timeout', 'valid_graph', 'cycle_rejected', 'inactive_agent_rejected', 'final_required', 'picker_mention', 'deleted_mention', 'manual_text_rejected', 'direct_route', 'single_agent_route', 'workflow_route', 'escalation_protocol', 'capability_alias_matching', 'unrelated_fallback_rejected', 'same_family_explicit_instance', 'same_family_legacy_selection', 'custom_instance_name_route', 'leader_sort_contract', 'leader_synthesis'] }));
