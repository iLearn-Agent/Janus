import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import {
  DEFAULT_UBUDDY_TASK_INTAKE_TIMEOUT_MS,
  UBUDDY_TASK_INTAKE_REASONING_EFFORT,
  buildSafeUBuddyTaskIntakeFallback,
  decideUBuddyTaskIntake,
  findPendingUBuddyTaskIntake,
  isUBuddyTaskIntakeTimeoutError,
  resolveUBuddyIntakeDispatchAuthorization,
  validateUBuddyTaskIntakeDecision,
} from '../src/main/modules/orchestration/application/uBuddyTaskIntakePlanner.js';
import { auditUBuddyTaskReadiness } from '../src/main/modules/orchestration/application/uBuddyTaskReadinessAuditor.js';

assert.equal(DEFAULT_UBUDDY_TASK_INTAKE_TIMEOUT_MS, 600_000);
assert.equal(UBUDDY_TASK_INTAKE_REASONING_EFFORT, 'low');
const openEndedClarification = validateUBuddyTaskIntakeDecision({
  version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'collect_context',
  intake: {
    version: 'ubuddy_task_intake_v1', state: 'needs_clarification', objective: '推进科研课题', deliverables: [],
    privacyScope: 'owner_private', riskLevel: 'low', missingFields: ['objective'],
    clarification: { reasonCode: 'missing_objective', question: '最需要推进的科研目标是什么？', options: [] },
  },
});
assert.equal(openEndedClarification.intake.clarifications.length, 1);
assert.equal(openEndedClarification.intake.clarifications[0].options.length, 0,
  'open-ended clarification must remain valid without forced choices');

const multiQuestionClarification = validateUBuddyTaskIntakeDecision({
  version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'collect_context',
  intake: {
    version: 'ubuddy_task_intake_v1', state: 'needs_clarification', objective: '调查近期工作', deliverables: ['工作汇报'],
    privacyScope: 'owner_private', riskLevel: 'low', missingFields: ['time_range', 'workspace_scope'],
    clarifications: [
      { id: 'time_range', question: '统计哪个时间范围？', options: ['最近7天', '最近30天'] },
      { id: 'workspace_scope', question: '统计哪些工作空间？', options: ['当前工作空间', '全部授权工作空间'] },
    ],
  },
});
assert.equal(multiQuestionClarification.intake.clarifications.length, 2);

const recentWorkContinuation = await decideUBuddyTaskIntake({
  prompt: 'clarify_date_range: 2026-07-13至08-13\nclarify_workspace_scope: 她的全部近期工作',
  previousIntake: {
    version: 'ubuddy_task_intake_v1', state: 'needs_clarification', taskKind: 'recent_work_report',
    objective: '告诉我她最近的工作进度和内容', deliverables: ['近期工作报告'],
    privacyScope: 'direct_delegation', riskLevel: 'low',
    workReportSpec: {
      version: 'work_report_spec_v1', startAt: '', endAt: '', timezone: 'Asia/Shanghai', workspaceScope: '',
    },
    missingFields: ['time_range', 'workspace_scope'],
    clarifications: [
      { id: 'clarify_date_range', question: '请指定最近的绝对起止日期和时区。' },
      { id: 'clarify_workspace_scope', question: '这份报告应覆盖哪个 Workspace、项目或工作范围？' },
    ],
  },
  mentionedUsers: [{ userId: 'recent-work-contact', displayName: '胡楚钰' }],
  recentWorkReportingEnabled: true,
  clarificationResponse: {
    version: 'ubuddy_clarification_response_v1',
    answers: [
      { questionId: 'clarify_date_range', value: '2026-07-13至08-13' },
      { questionId: 'clarify_workspace_scope', value: 'all_authorized_workspaces', label: '她的全部近期工作' },
    ],
  },
  execute: async () => JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: true,
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready', taskKind: 'recent_work_report',
      objective: '告诉我胡楚钰最近的工作进度和内容', deliverables: ['近期工作报告'],
      candidateUsers: [{ userId: 'recent-work-contact', displayName: '胡楚钰' }],
      requiredUsers: [{ userId: 'recent-work-contact', displayName: '胡楚钰' }],
      privacyScope: 'direct_delegation', riskLevel: 'low', missingFields: [], clarifications: [],
      workReportSpec: {
        version: 'work_report_spec_v1', startAt: '2026-07-13T00:00:00+08:00', endAt: '2026-08-14T00:00:00+08:00',
        timezone: 'Asia/Shanghai',
      },
      executionPlan: { summary: '汇总指定范围内的近期工作', steps: ['收集结构化任务记录', '整理报告'], requiredInputs: [] },
      knownFacts: [], safeAssumptions: [], criticalUnknowns: [], readiness: { status: 'ready', reason: '信息完整' },
    },
  }),
});
assert.equal(recentWorkContinuation.intake.workReportSpec.workspaceScope, 'all_authorized_workspaces');
assert.equal(recentWorkContinuation.intake.workReportSpec.timezone, 'Asia/Shanghai');

const invalidContactTimezone = await decideUBuddyTaskIntake({
  prompt: 'clarify_timezone: 胡楚钰所在地时区',
  previousIntake: recentWorkContinuation.intake,
  mentionedUsers: [{ userId: 'recent-work-contact', displayName: '胡楚钰' }],
  recentWorkReportingEnabled: true,
  execute: async () => JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: true,
    intake: {
      ...recentWorkContinuation.intake,
      state: 'ready', missingFields: [], clarifications: [], criticalUnknowns: [],
      readiness: { status: 'ready', reason: '' },
      workReportSpec: { ...recentWorkContinuation.intake.workReportSpec, timezone: '胡楚钰所在地时区' },
    },
  }),
});
assert.equal(invalidContactTimezone.intake.state, 'needs_clarification');
assert.equal(invalidContactTimezone.action, 'collect_context');
assert.deepEqual(invalidContactTimezone.intake.clarifications.map((item) => item.id), ['clarify_report_timezone']);
assert.match(invalidContactTimezone.intake.clarifications[0].question, /无法从联系人资料确定对方所在地时区/);

const authorizedSpaceWordingContinuation = await decideUBuddyTaskIntake({
  prompt: 'clarify_report_period: 最近 30 天\nclarify_workspace_scope: 全部已授权空间',
  previousIntake: {
    version: 'ubuddy_task_intake_v1', state: 'needs_clarification', taskKind: 'recent_work_report',
    objective: '告诉我测试账号 02 最近的工作进度和内容', deliverables: ['近期工作报告'],
    privacyScope: 'direct_delegation', riskLevel: 'low',
    workReportSpec: { version: 'work_report_spec_v1', timezone: 'Asia/Shanghai', workspaceScope: '' },
    missingFields: ['time_range', 'workspace_scope'],
    clarifications: [
      { id: 'clarify_report_period', question: '请确认报告覆盖的绝对起止时间和时区。' },
      { id: 'clarify_workspace_scope', question: '需要汇总哪个 Workspace 或项目范围？' },
    ],
  },
  mentionedUsers: [{ userId: 'test-account-02', displayName: '测试账号 02' }],
  recentWorkReportingEnabled: true,
  plannerThreadId: 'ubuddy-intake-planner-thread',
  plannerSessionId: 'ubuddy-intake-planner-session',
  clarificationResponse: {
    version: 'ubuddy_clarification_response_v1',
    answers: [
      { questionId: 'clarify_report_period', value: '最近 30 天' },
      { questionId: 'clarify_workspace_scope', value: 'all_authorized_workspaces', label: '全部已授权空间' },
    ],
  },
  execute: async ({ threadId, sessionId }) => {
    assert.equal(threadId, 'ubuddy-intake-planner-thread', 'clarification continuation must resume the same Codex planner thread');
    assert.equal(sessionId, 'ubuddy-intake-planner-session');
    return { threadId, answer: JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: true,
      intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready', taskKind: 'recent_work_report',
      objective: '告诉我测试账号 02 最近的工作进度和内容', deliverables: ['近期工作报告'],
      candidateUsers: [{ userId: 'test-account-02', displayName: '测试账号 02' }],
      requiredUsers: [{ userId: 'test-account-02', displayName: '测试账号 02' }],
      privacyScope: 'direct_delegation', riskLevel: 'low', missingFields: [], clarifications: [],
      workReportSpec: {
        version: 'work_report_spec_v1', startAt: '2026-07-15T00:00:00+08:00', endAt: '2026-08-14T23:59:59+08:00',
        timezone: 'Asia/Shanghai',
      },
      executionPlan: { summary: '汇总近期工作', steps: ['收集任务记录', '整理报告'], requiredInputs: [] },
      knownFacts: [], safeAssumptions: [], criticalUnknowns: [], readiness: { status: 'ready', reason: '信息完整' },
      },
    }) };
  },
});
assert.equal(authorizedSpaceWordingContinuation.intake.workReportSpec.workspaceScope, 'all_authorized_workspaces');
assert.equal(authorizedSpaceWordingContinuation.plannerThreadId, 'ubuddy-intake-planner-thread');

const inferredRecipientClarification = await decideUBuddyTaskIntake({
  prompt: '根据刚才的讨论，就这个调研任务帮我分配一下',
  mentionedUsers: [],
  execute: async () => JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: false,
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready', objective: '完成调研任务', deliverables: ['调研报告'],
      candidateUsers: [{ userId: 'history-only-user', displayName: '历史联系人' }],
      requiredUsers: [{ userId: 'history-only-user', displayName: '历史联系人' }],
      privacyScope: 'direct_delegation', riskLevel: 'medium', missingFields: [], clarifications: [],
      executionPlan: { summary: '完成调研并提交报告', steps: ['开展调研', '整理报告'], requiredInputs: [] },
      knownFacts: [], safeAssumptions: [], criticalUnknowns: [], readiness: { status: 'ready', reason: '信息完整' },
    },
  }),
});
assert.equal(inferredRecipientClarification.intake.state, 'needs_clarification');
assert.deepEqual(inferredRecipientClarification.intake.candidateUserIds, []);
assert.deepEqual(inferredRecipientClarification.intake.missingFields, ['executionTarget']);
assert.equal(inferredRecipientClarification.intake.clarifications[0].answerType, 'execution_target');
assert.deepEqual(inferredRecipientClarification.intake.clarifications[0].options.map((item) => item.label),
  ['本地完成', '@ 联系人完成']);

const missingRecipientChoice = await decideUBuddyTaskIntake({
  prompt: '请把这个调研任务分配一下',
  mentionedUsers: [],
  execute: async () => JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'collect_context', continuation: false,
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'needs_clarification', objective: '完成调研任务', deliverables: ['调研报告'],
      candidateUsers: [], requiredUsers: [], privacyScope: 'owner_private', riskLevel: 'low',
      missingFields: ['candidateUsers'],
      clarifications: [{ id: 'candidateUsers', question: '由谁完成？', options: ['本地', '联系人'] }],
    },
  }),
});
assert.equal(missingRecipientChoice.intake.clarifications[0].answerType, 'execution_target');

let readinessPrompt = '';
await auditUBuddyTaskReadiness({
  prompt: '根据刚才的讨论完成调研任务',
  intake: {
    version: 'ubuddy_task_intake_v1', state: 'ready', objective: '完成调研任务', deliverables: ['调研报告'],
    candidateUsers: [], requiredUsers: [], privacyScope: 'owner_private', riskLevel: 'low', missingFields: [],
  },
  recentMessages: Array.from({ length: 8 }, (_, index) => ({
    role: 'user', content: `可见消息 ${index} ${'内容'.repeat(2_000)}`,
    metadata: { processEvents: [{ output: 'MUST_NOT_REACH_READINESS_'.repeat(100_000) }] },
  })),
  execute: async ({ prompt }) => {
    readinessPrompt = prompt;
    return JSON.stringify({ version: 'UBUDDY_TASK_READINESS_AUDIT_V1', dispatchReady: true, clarifications: [] });
  },
});
assert.ok(readinessPrompt.length < 30_000, 'readiness prompt must remain far below the Codex input limit');
assert.doesNotMatch(readinessPrompt, /MUST_NOT_REACH_READINESS_/,
  'readiness audit must never serialize message metadata or process output');
assert.doesNotMatch(readinessPrompt, /可见消息 0|可见消息 1/,
  'readiness audit must keep only the latest bounded visible messages');

const retryCalls = [];
const retriedDecision = await decideUBuddyTaskIntake({
  prompt: '创建一项超时重试测试任务',
  recentMessages: Array.from({ length: 16 }, (_, index) => ({ role: 'user', content: `${index}:${'背景'.repeat(800)}` })),
  attachmentSummaries: [{ id: 'intake-summary-only-attachment', name: 'summary-only.pdf', kind: 'application/pdf' }],
  referenceSummaries: [{ referenceId: 'intake-summary-only-reference', name: 'summary-only.md', referenceKind: 'file', sizeBytes: 42 }],
  attachmentContext: 'ATTACHMENT_BODY_MUST_NOT_REACH_INTAKE',
  referenceContext: 'REFERENCE_BODY_MUST_NOT_REACH_INTAKE',
  reasoningEffort: 'ultra',
  execute: async (options) => {
    retryCalls.push(options);
    if (retryCalls.length === 1) {
      const error = new Error('Process timed out after 600000ms: codex');
      error.code = 'codex_request_timeout';
      throw error;
    }
    return JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', continuation: false, intake: null,
    });
  },
});
assert.equal(retriedDecision.taskIntent, false);
assert.equal(retryCalls.length, 2);
assert.equal(retryCalls[0].reasoningEffort, 'low');
assert.equal(retryCalls[1].reasoningEffort, 'low');
assert.equal(retryCalls[1].role, 'ubuddy-task-intake-retry');
assert.equal(retryCalls[0].timeoutMs + retryCalls[1].timeoutMs, 600_000,
  'the primary attempt and compact retry must share the 600-second total budget');
assert.equal(retryCalls[1].timeoutMs, 180_000);
assert.ok(retryCalls[1].prompt.length < retryCalls[0].prompt.length, 'the timeout retry must use compact context');
assert.match(retryCalls[0].prompt, /summary-only\.pdf/);
assert.match(retryCalls[0].prompt, /summary-only\.md/);
assert.doesNotMatch(retryCalls[0].prompt, /ATTACHMENT_BODY_MUST_NOT_REACH_INTAKE|REFERENCE_BODY_MUST_NOT_REACH_INTAKE/,
  'intake must not include attachment or selected-reference body text');
assert.doesNotMatch(retryCalls[1].prompt, /ATTACHMENT_BODY_MUST_NOT_REACH_INTAKE|REFERENCE_BODY_MUST_NOT_REACH_INTAKE/,
  'the compact retry must not restore attachment or selected-reference body text');

let initialContextPrompt = '';
await decideUBuddyTaskIntake({
  prompt: '创建精简历史上下文测试任务',
  recentMessages: Array.from({ length: 10 }, (_, index) => ({ role: 'user', content: `INITIAL_HISTORY_${index}` })),
  execute: async (options) => {
    initialContextPrompt = options.prompt;
    return JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', continuation: false, intake: null,
    });
  },
});
assert.doesNotMatch(initialContextPrompt, /INITIAL_HISTORY_[0-3]/,
  'a new intake must not send more than the latest six conversation messages');
assert.match(initialContextPrompt, /INITIAL_HISTORY_4/);
assert.match(initialContextPrompt, /INITIAL_HISTORY_9/);

let continuationContextPrompt = '';
await decideUBuddyTaskIntake({
  prompt: '继续精简历史上下文测试任务',
  previousRequest: 'PREVIOUS_REQUEST_MUST_NOT_BE_RESENT',
  previousIntake: {
    version: 'ubuddy_task_intake_v1', state: 'ready', objective: '整理上下文', deliverables: ['报告'],
    candidateUsers: [], requiredUsers: [], attachments: [], privacyScope: 'owner_private', riskLevel: 'low',
    missingFields: [], clarification: { reasonCode: '', question: '', options: [] },
  },
  recentMessages: Array.from({ length: 8 }, (_, index) => ({ role: 'user', content: `CONTINUATION_HISTORY_${index}` })),
  execute: async (options) => {
    continuationContextPrompt = options.prompt;
    return JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', continuation: true, intake: null,
    });
  },
});
assert.doesNotMatch(continuationContextPrompt, /CONTINUATION_HISTORY_[0-4]/,
  'a structured intake continuation must send only the latest three conversation messages');
assert.match(continuationContextPrompt, /CONTINUATION_HISTORY_5/);
assert.match(continuationContextPrompt, /CONTINUATION_HISTORY_7/);
assert.doesNotMatch(continuationContextPrompt, /PREVIOUS_REQUEST_MUST_NOT_BE_RESENT/,
  'a validated previous intake must replace the original request in continuation prompts');

await assert.rejects(() => decideUBuddyTaskIntake({
  prompt: '创建一项持续超时测试任务',
  execute: async () => {
    const error = new Error('Codex model request timed out after 1s before a response completed.');
    error.code = 'codex_request_timeout';
    throw error;
  },
}), (error) => error.code === 'ubuddy_task_intake_timeout'
  && error.uBuddyIntakeRetryAttempted === true
  && isUBuddyTaskIntakeTimeoutError(error));

const timeoutFallback = buildSafeUBuddyTaskIntakeFallback({
  prompt: '请让联系人整理项目进展',
  mentionedUsers: [{ userId: 'fallback-user', displayName: '联系人' }],
  taskIntent: true,
  action: 'dispatch_task',
  objective: '整理项目进展',
  deliverables: ['书面报告'],
  privacyScope: 'direct_delegation',
  riskLevel: 'medium',
});
assert.equal(timeoutFallback.action, 'dispatch_task');
assert.equal(timeoutFallback.intake.requiredUsers[0].userId, 'fallback-user');
assert.equal(timeoutFallback.recovery.mode, 'deterministic_timeout_fallback');
assert.equal(buildSafeUBuddyTaskIntakeFallback({ prompt: '解释光合作用', taskIntent: false }).action, 'direct');

const readyIntakeDecision = {
  taskIntent: true,
  action: 'dispatch_task',
  continuation: true,
  intake: { state: 'ready', objective: '整理背景', deliverables: ['报告'] },
};
assert.deepEqual(resolveUBuddyIntakeDispatchAuthorization({
  intakeDecision: readyIntakeDecision,
  hasStagedContext: true,
}), {
  version: 'ubuddy_dispatch_authorization_v1', action: 'collect_context', authorized: false,
  reasonCode: 'staged_context_requires_explicit_dispatch',
}, 'staged background must remain non-dispatching even when the intake model asks to dispatch');
assert.equal(resolveUBuddyIntakeDispatchAuthorization({
  intakeDecision: readyIntakeDecision,
  pendingIntake: { awaitingDispatch: true, intake: { state: 'ready' } },
}).authorized, false, 'a ready intake awaiting dispatch must require explicit confirmation');
assert.equal(resolveUBuddyIntakeDispatchAuthorization({
  intakeDecision: readyIntakeDecision,
  pendingIntake: { awaitingDispatch: false, intake: { state: 'needs_clarification' } },
}).authorized, true, 'a focused clarification answer may continue the already requested execution');
assert.equal(resolveUBuddyIntakeDispatchAuthorization({
  intakeDecision: { ...readyIntakeDecision, action: 'collect_context' },
  hasStagedContext: true,
  explicitDispatch: true,
}).authorized, true, 'an explicit dispatch confirmation must override a conservative collect-context model action');

assert.throws(() => validateUBuddyTaskIntakeDecision({
  version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task',
  intake: {
    version: 'ubuddy_task_intake_v1', state: 'ready', objective: '委托报告', deliverables: ['报告'],
    candidateUsers: ['unmentioned-user'], requiredUsers: ['unmentioned-user'], privacyScope: 'direct_delegation',
  },
}, { allowedCandidateUserIds: [] }), /unmentioned candidate users/i);
assert.throws(() => validateUBuddyTaskIntakeDecision({
  version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task',
  intake: {
    version: 'ubuddy_task_intake_v1', state: 'ready', objective: '私有任务', deliverables: ['报告'],
    candidateUsers: ['external-user'], requiredUsers: ['external-user'], privacyScope: 'owner_private',
  },
}, { allowedCandidateUserIds: ['external-user'] }), /owner-private task intake cannot require external users/i);
assert.equal(validateUBuddyTaskIntakeDecision({
  version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task',
  intake: {
    version: 'ubuddy_task_intake_v1', state: 'ready', objective: '多人直连任务', deliverables: ['报告'],
    candidateUsers: ['user-a', 'user-b'], requiredUsers: [], privacyScope: 'direct_delegation',
  },
}, { allowedCandidateUserIds: ['user-a', 'user-b'] }).intake.candidateUserIds.length, 2,
  'intake must preserve a multi-user candidate pool until Stage 7 selects final recipients');

const enrichedKnownFields = await decideUBuddyTaskIntake({
  prompt: '@验收联系人 按附件要求处理',
  mentionedUsers: [{ userId: 'known-user', displayName: '已知联系人' }],
  attachmentSummaries: [{ id: 'known-attachment', name: 'requirements.txt', kind: 'text/plain' }],
  execute: async () => JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task',
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready', objective: '按附件要求处理', deliverables: ['报告'],
      privacyScope: 'owner_private',
    },
  }),
});
assert.equal(enrichedKnownFields.intake.candidateUsers[0].userId, 'known-user');
assert.equal(enrichedKnownFields.intake.requiredUsers.length, 0,
  'known candidates must not be promoted to required users without semantic evidence');
assert.equal(enrichedKnownFields.intake.attachments[0].id, 'known-attachment');

const retainedRequiredUsers = await decideUBuddyTaskIntake({
  prompt: '继续原任务',
  previousIntake: {
    version: 'ubuddy_task_intake_v1', state: 'needs_clarification', objective: '委托报告', deliverables: ['报告'],
    candidateUsers: [{ userId: 'required-user', displayName: '必选联系人' }],
    requiredUsers: [{ userId: 'required-user', displayName: '必选联系人' }],
    missingFields: ['deadline'], clarification: { question: '截止时间是什么？', options: [] },
  },
  mentionedUsers: [{ userId: 'required-user', displayName: '必选联系人' }],
  execute: async () => JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: true,
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready', objective: '委托报告', deliverables: ['报告'],
      deadline: '明天下午 5 点', privacyScope: 'direct_delegation',
    },
  }),
});
assert.equal(retainedRequiredUsers.intake.requiredUsers[0].userId, 'required-user');

const pendingSpec = {
  version: 'ubuddy_task_intake_v1', state: 'needs_clarification', objective: '待澄清任务', deliverables: [],
  missingFields: ['deliverables'], clarification: { question: '需要什么交付物？', options: [] },
};
const pendingMessages = [
  { id: 'pending-source', role: 'user', content: '待澄清任务', metadata: { uBuddyTaskIntakeSpec: pendingSpec } },
  { id: 'pending-question', role: 'assistant', content: '需要什么交付物？', metadata: { sourceMessageId: 'pending-source', uBuddyTaskIntakeSpec: pendingSpec } },
];
assert.equal(findPendingUBuddyTaskIntake([
  ...pendingMessages,
  { id: 'query', role: 'user', content: '进度？', metadata: { taskQueryIntent: 'progress' } },
])?.intake?.objective, '待澄清任务');
assert.equal(findPendingUBuddyTaskIntake([
  ...pendingMessages,
  { id: 'ask', role: 'user', content: '顺便解释一下验收标准。', metadata: { uBuddyMessageMode: 'ask' } },
  { id: 'ask-answer', role: 'assistant', content: '验收标准用于判断交付物是否完成。', metadata: { uBuddyMessageMode: 'ask' } },
])?.intake?.objective, '待澄清任务', 'Ask turns must not close or answer a pending Task intake');
assert.equal(findPendingUBuddyTaskIntake([
  ...pendingMessages,
  { id: 'cancel', role: 'user', content: '取消任务', metadata: { taskCancellationRequest: true } },
]), null, 'a cancellation request must close the pending intake');
assert.equal(findPendingUBuddyTaskIntake([
  ...pendingMessages,
  { id: 'failed-supplement', role: 'user', content: '报告', metadata: { uBuddyIntakeDecisionFailed: true, uBuddyTaskIntakeSpec: pendingSpec } },
])?.intake?.objective, '待澄清任务', 'a crash between failure messages must preserve the pending intake');

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-intake-v2-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-intake-v2-bin-'));
const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-intake-v2-project-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const logPath = path.join(binRoot, 'calls.jsonl');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousFlag = process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
const previousStructuredReferenceFlag = process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
const previousAutoRoutingFlag = process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
const previousLog = process.env.UBUDDY_INTAKE_LOG;
const previousIntakeTimeout = process.env.JANUS_UBUDDY_TASK_INTAKE_TIMEOUT_MS;
const previousIntakeRetryTimeout = process.env.JANUS_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS;

await writeFile(path.join(projectRoot, 'reference.txt'), 'PROJECT_REFERENCE_CONTINUITY_OK：最终报告必须引用该项目资料。', 'utf8');

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
const intake = (value, action = 'dispatch_task') => JSON.stringify({
  version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action, continuation: false, intake: value,
});
const spec = (value = {}) => ({
  version: 'ubuddy_task_intake_v1', state: 'ready', objective: '完成用户请求', deliverables: ['书面报告'],
  acceptanceCriteria: [], constraints: [], deadline: '', candidateUsers: [], requiredUsers: [], attachments: [],
  privacyScope: 'owner_private', riskLevel: 'low', missingFields: [],
  clarification: { reasonCode: '', question: '', options: [] }, ...value,
});
function responseFor(input) {
  if (input.includes('【UBUDDY_TASK_READINESS_AUDIT_V1】')) {
    const draft = JSON.parse(input.split('Draft intake:\\n').at(-1)?.split('\\n\\nRecent context:')[0] || '{}');
    return JSON.stringify({
      version: 'UBUDDY_TASK_READINESS_AUDIT_V1',
      dispatchReady: draft.state === 'ready',
      reason: draft.state === 'ready' ? '测试任务已就绪。' : '仍需回答澄清问题。',
      executionPlan: draft.executionPlan || { summary: draft.objective || '执行测试任务', steps: ['执行任务并生成交付物'], requiredInputs: [] },
      knownFacts: draft.knownFacts || [], safeAssumptions: draft.safeAssumptions || [],
      criticalUnknowns: draft.criticalUnknowns || (draft.missingFields || []).map((id) => ({ id, name: id, reason: '测试缺项', questionId: id })),
      clarifications: draft.clarifications || (draft.clarification?.question ? [{ id: draft.clarification.reasonCode || 'clarification_1', question: draft.clarification.question, options: draft.clarification.options || [] }] : []),
    });
  }
  if (input.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
    const current = input.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
    const mentioned = JSON.parse(input.match(/Structured users mentioned in this intake:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const attachments = JSON.parse(input.match(/Attachment summaries:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const references = JSON.parse(input.match(/Selected reference summaries:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    if (current.includes('算了，解释一下光合作用')) return JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', continuation: true, intake: null,
    });
    if (current.includes('当前任务进度怎么样')) return JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', continuation: true, intake: null,
    });
    if (current.includes('新增说明但不要创建')) return intake(spec({
      objective: '整理中国环境研究背景', deliverables: ['Markdown 报告'],
      constraints: ['仅使用已提供资料'],
    }), 'collect_context');
    if (current.includes('研究范围再补充华东地区')) return intake(spec({
      objective: '整理中国环境研究背景', deliverables: ['Markdown 报告'],
      constraints: ['仅使用已提供资料', '研究范围包含华东地区'],
    }), 'dispatch_task');
    if (current.includes('确认创建这项背景研究任务')) return intake(spec({
      objective: '整理中国环境研究背景', deliverables: ['Markdown 报告'],
      constraints: ['仅使用已提供资料', '研究范围包含华东地区'],
    }), 'dispatch_task');
    if (current.includes('问一下几点开会')) return intake(spec({
      objective: '询问并确认几点开会', deliverables: ['联系人对开会时间的明确回复'],
      candidateUsers: mentioned, requiredUsers: mentioned,
      privacyScope: 'direct_delegation', riskLevel: 'low',
    }));
    if (current.includes('需要失败恢复的分析任务')) return intake(spec({
      state: 'needs_clarification', objective: '完成需要失败恢复的分析任务', deliverables: [],
      missingFields: ['deliverables'],
      clarification: { reasonCode: 'missing_deliverable_type', question: '最终需要什么交付物？', options: ['报告', 'PPT'] },
    }));
    if (current.includes('需要中断后继续的分析任务')) return intake(spec({
      state: 'needs_clarification', objective: '完成需要中断后继续的分析任务', deliverables: [],
      missingFields: ['deliverables'],
      clarification: { reasonCode: 'missing_deliverable_type', question: '中断测试最终需要什么交付物？', options: ['报告', 'PPT'] },
    }));
    if (current.includes('最终交付报告但模拟 intake 失败')) return 'not-json';
    if (current.includes('重试上一条补充')) return intake(spec({
      objective: '完成需要失败恢复的分析任务', deliverables: ['书面报告'],
    }));
    if (current.includes('中断测试最终交付报告')) return intake(spec({
      objective: '完成需要中断后继续的分析任务', deliverables: ['书面报告'],
    }));
    if (current.includes('替换收件人测试') && !current.includes('改由他负责')) return intake(spec({
      state: 'needs_clarification', objective: '完成替换收件人测试', deliverables: [],
      candidateUsers: mentioned, requiredUsers: mentioned, privacyScope: 'direct_delegation',
      missingFields: ['deliverables'],
      clarification: { reasonCode: 'missing_deliverable_type', question: '替换测试最终需要什么交付物？', options: ['报告', 'PPT'] },
    }));
    if (current.includes('改由他负责') && current.includes('交付物仍待定')) {
      const replacement = mentioned.filter((item) => item.userId === 'replacement_contact');
      return intake(spec({
        state: 'needs_clarification', objective: '完成替换收件人测试', deliverables: [],
        candidateUsers: replacement, requiredUsers: replacement, privacyScope: 'direct_delegation',
        missingFields: ['deliverables'],
        clarification: { reasonCode: 'missing_deliverable_type', question: '替换后最终需要什么交付物？', options: ['报告', 'PPT'] },
      }));
    }
    if (current.includes('替换测试最终交付报告')) {
      const replacement = mentioned.filter((item) => item.userId === 'replacement_contact');
      return intake(spec({
        objective: '完成替换收件人测试', deliverables: ['书面报告'],
        candidateUsers: replacement, requiredUsers: replacement, privacyScope: 'direct_delegation',
      }));
    }
    if (current.includes('附件替换测试') && !current.includes('改用新附件')) return intake(spec({
      state: 'needs_clarification', objective: '完成附件替换测试', deliverables: [], attachments,
      missingFields: ['deliverables'],
      clarification: { reasonCode: 'missing_deliverable_type', question: '附件替换测试最终需要什么交付物？', options: ['报告', 'PPT'] },
    }));
    if (current.includes('改用新附件')) return intake(spec({
      objective: '完成附件替换测试', deliverables: ['书面报告'],
      attachments: attachments.filter((item) => item.name === 'replacement-new.txt'),
    }));
    if (current.includes('项目引用延续测试')) return intake(spec({
      state: 'needs_clarification', objective: '完成项目引用延续测试', deliverables: [],
      missingFields: ['deliverables'],
      clarification: { reasonCode: 'missing_deliverable_type', question: '项目引用测试最终需要什么交付物？', options: ['报告', 'PPT'] },
    }));
    if (current.includes('项目引用最终交付报告')) {
      if (!references.some((item) => item.name === 'reference.txt')) return intake(spec({
        state: 'needs_clarification', objective: '完成项目引用延续测试', deliverables: ['书面报告'],
        missingFields: ['constraints'],
        clarification: { reasonCode: 'reference_context_missing', question: '请重新选择项目参考文件。', options: ['重新选择参考文件', '不使用参考文件继续'] },
      }));
      return intake(spec({ objective: '完成项目引用延续测试', deliverables: ['书面报告'] }));
    }
    if (current.includes('委托给同事') && !mentioned.length) return intake(spec({
      state: 'needs_clarification', objective: '写一份市场分析报告', deliverables: ['市场分析报告'],
      missingFields: ['requiredUsers'], privacyScope: 'direct_delegation', riskLevel: 'medium',
      clarification: { reasonCode: 'missing_required_users', question: '这份报告需要委托给哪位联系人？', options: ['重新选择一位联系人', '改为由我自己处理'] },
    }));
    if (current.includes('交给她') && mentioned.length) return intake(spec({
      objective: '写一份市场分析报告', deliverables: ['市场分析报告'], candidateUsers: mentioned,
      requiredUsers: mentioned, privacyScope: 'direct_delegation', riskLevel: 'medium',
    }));
    if (current.includes('分析中国环境并形成最终材料')) return intake(spec({
      state: 'needs_clarification', objective: '分析中国环境', deliverables: [], missingFields: ['deliverables'],
      clarification: { reasonCode: 'missing_deliverable_type', question: '最终交付物需要报告还是 PPT？', options: ['报告', 'PPT'] },
    }));
    if (current.includes('最终交付 PPT')) return intake(spec({
      objective: '分析中国环境', deliverables: ['可编辑 PPTX 演示文稿'], acceptanceCriteria: ['内容完整且可编辑'],
    }));
    if (current.includes('附件任务最终交付书面报告')) {
      return intake(spec({
        objective: '依据附件撰写中国环境分析', deliverables: ['书面报告'],
        acceptanceCriteria: ['包含摘要和结论'], attachments,
      }));
    }
    if (current.includes('请按附件要求处理')) return intake(spec({
      state: 'needs_clarification', objective: '按附件要求处理', deliverables: [], missingFields: ['deliverables'],
      attachments, clarification: { reasonCode: 'attachment_body_deferred', question: '附件任务最终需要什么交付物？', options: ['书面报告', 'PPT'] },
    }));
    return intake(spec({
      objective: '撰写中国环境报告', deliverables: ['Markdown 报告'],
      acceptanceCriteria: ['包含摘要和数据来源'], constraints: ['使用中文'],
    }));
  }
  if (input.includes('【UBUDDY_TURN_DECISION_V2】')) {
    const candidates = JSON.parse(input.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const current = input.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
    if (current.includes('当前任务进度怎么样')) return JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.98,
      answer: '', clarification: null, routingRationale: '已有任务查询交给完整 Codex 调用 Janus 状态工具。',
      nodes: [], deliverables: [], agentSelectionRationale: '', mentionedAgentsNotSelected: [],
    });
    if (current.includes('解释一下光合作用')) return JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.96,
      answer: '光合作用是植物利用光能把二氧化碳和水转化为有机物并释放氧气的过程。', clarification: null,
      nodes: [], deliverables: [], agentSelectionRationale: '', mentionedAgentsNotSelected: [],
    });
    if (current.includes('旧逻辑最终产物不明确')) return JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'clarification', confidence: 0.6,
      answer: '', clarification: { reason: 'legacy_clarification', question: '旧逻辑需要哪种交付物？', options: ['报告', 'PPT'] },
      nodes: [], deliverables: [], agentSelectionRationale: '', mentionedAgentsNotSelected: [],
    });
    const wantsPpt = /PPT|演示文稿/.test(current);
    const candidate = candidates.find((item) => item.agentId === (wantsPpt ? 'ppt' : 'general_agent')) || candidates[0];
    return JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.96,
      answer: '', clarification: null,
      nodes: [{
        localId: 'final', title: wantsPpt ? '制作 PPT' : '撰写报告', objective: '完成结构化 intake 中的交付要求',
        agentId: candidate?.agentId, agentInstanceId: candidate?.agentInstanceId, dependencies: [],
        outputFormat: wantsPpt ? 'editable PPTX' : 'Markdown report', isFinal: true, blocking: true,
        fallback: '说明无法完成的原因。',
      }],
      deliverables: [{
        id: 'primary', role: 'primary', type: wantsPpt ? 'presentation' : 'report',
        title: wantsPpt ? '中国环境 PPT' : '中国环境报告', ownerLocalId: 'final',
        deliveryMode: wantsPpt ? 'file' : 'inline', requiredExtensions: wantsPpt ? ['.pptx'] : [], constraints: {},
      }],
      agentSelectionRationale: '选择能够完成结构化交付物的在职 Agent。', mentionedAgentsNotSelected: [],
    });
  }
  if (input.includes('解释一下光合作用')) {
    return '光合作用是植物利用光能把二氧化碳和水转化为有机物并释放氧气的过程。';
  }
  return '任务执行完成。';
}
function log(stdin, response) {
  if (process.env.UBUDDY_INTAKE_LOG) fs.appendFileSync(process.env.UBUDDY_INTAKE_LOG, JSON.stringify({ stdin, response }) + '\\n');
}
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method && String(message.id) === 'intake-query-call') {
      const payload = JSON.parse(message.result?.contentItems?.[0]?.text || '{}');
      const details = payload.answer || (payload.candidates || []).map((item) => item.title).join('、') || '当前没有可查询的任务';
      const answer = 'CODEX_INTAKE_QUERY_OK：' + details;
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { turn: { id: 'ubuddy-intake-v2-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
    } else if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'ubuddy-intake-v2-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'ubuddy-intake-v2-thread' } } });
    else if (message.method === 'turn/start') {
      const stdin = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
      send({ id: message.id, result: { turn: { id: 'ubuddy-intake-v2-turn' } } });
      if (stdin.includes('当前任务进度怎么样') && !stdin.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
        send({ id: 'intake-query-call', method: 'item/tool/call', params: {
          threadId: 'ubuddy-intake-v2-thread', turnId: 'ubuddy-intake-v2-turn', callId: 'intake-query-call',
          namespace: 'janus', tool: 'query_work', arguments: { query: 'progress' },
        } });
      } else {
        const response = responseFor(stdin); log(stdin, response);
        send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response } } });
        send({ method: 'turn/completed', params: { turn: { id: 'ubuddy-intake-v2-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response }] } } });
      }
    } else if (message.method === 'thread/memoryMode/set' || message.method.startsWith('thread/goal/')) {
      if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
      else send({ id: message.id, result: {} });
    } else send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
if (stdin.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】') && stdin.includes('模拟 intake 超时兜底')) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const response = responseFor(stdin); log(stdin, response);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ubuddy-intake-v2-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'on';
process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = 'off';
process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'off';
process.env.UBUDDY_INTAKE_LOG = logPath;

let runtime;
try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const userId = runtime.currentUser().id;
  const project = runtime.createProject({ title: 'uBuddy intake reference project', workspaceRoot: projectRoot });
  runtime.store.recruitUserAgent({ userId, agentFamilyId: 'ppt', commandId: 'ubuddy-intake-v2:recruit-ppt' });
  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('intake_contact','intake-contact@example.com','验收联系人','intake_contact',1)`).run();
  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('replacement_contact','replacement-contact@example.com','替换联系人','replacement_contact',1)`).run();
  const [friendA, friendB] = [userId, 'intake_contact'].sort();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
    VALUES ('intake_contact_friendship',?,?,'accepted')`).run(friendA, friendB);
  const [replacementFriendA, replacementFriendB] = [userId, 'replacement_contact'].sort();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
    VALUES ('replacement_contact_friendship',?,?,'accepted')`).run(replacementFriendA, replacementFriendB);
  const contactMention = {
    principalType: 'user', userId: 'intake_contact', displayText: '@验收联系人',
    mentionId: 'intake_contact_mention', source: 'picker',
  };
  const replacementMention = {
    principalType: 'user', userId: 'replacement_contact', displayText: '@替换联系人',
    mentionId: 'replacement_contact_mention', source: 'picker',
  };
  const counts = () => ({
    tasks: runtime.store.listTaskRuns({ userId }).length,
    groups: runtime.db.prepare('SELECT count(*) count FROM collaboration_groups').get().count,
    delegations: runtime.agentDelegations({ direction: 'outgoing' }).length,
  });

  const contextOnlySession = runtime.ensureSecretarySession();
  const contextOnlyCounts = counts();
  const contextOnlyInitial = await runtime.secretaryChat({
    sessionId: contextOnlySession.id,
    message: '新增说明但不要创建：请整理中国环境研究背景，最终需要 Markdown 报告，并且仅使用已提供资料。',
  });
  assert.equal(contextOnlyInitial.uBuddyMode, 'context_collected', JSON.stringify(contextOnlyInitial));
  assert.equal(contextOnlyInitial.taskIntake.state, 'ready');
  assert.deepEqual(counts(), contextOnlyCounts, 'a complete background-only intake must not create work');
  const contextOnlySupplement = await runtime.secretaryChat({
    sessionId: contextOnlySession.id,
    message: '研究范围再补充华东地区。',
  });
  assert.equal(contextOnlySupplement.uBuddyMode, 'context_collected');
  assert.deepEqual(counts(), contextOnlyCounts,
    'a staged-context supplement must stay unpublished even if the intake model incorrectly asks to dispatch');
  const contextOnlyConfirmed = await runtime.secretaryChat({
    sessionId: contextOnlySession.id,
    message: '确认创建这项背景研究任务。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(contextOnlyConfirmed.uBuddyMode));
  assert.equal(counts().tasks, contextOnlyCounts.tasks + 1, 'explicit task creation must publish the staged intake exactly once');
  assert.equal(counts().groups, contextOnlyCounts.groups);
  assert.equal(counts().delegations, contextOnlyCounts.delegations);

  const externalQuestion = await runtime.secretaryChat({
    sessionId: runtime.ensureSecretarySession().id,
    message: '@验收联系人 问一下几点开会。',
    mentions: [{ ...contactMention, mentionId: 'intake_simple_message_mention' }],
  });
  assert.equal(externalQuestion.dispatchType, 'external_delegation', JSON.stringify(externalQuestion));
  assert.ok(externalQuestion.delegation?.id || externalQuestion.waitingForPresence);
  assert.equal(runtime.socialConversation({ peerId: 'intake_contact' })
    .filter((item) => item.metadata?.type === 'ubuddy_simple_message').length, 0);
  if (externalQuestion.delegation) assert.deepEqual(externalQuestion.delegation.metadata?.expectedDeliverables, ['联系人对开会时间的明确回复']);

  const completeSession = runtime.ensureSecretarySession();
  const complete = await runtime.secretaryChat({
    sessionId: completeSession.id,
    message: '请用中文写一份中国环境 Markdown 报告，包含摘要和数据来源。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(complete.uBuddyMode), JSON.stringify(complete));
  assert.equal(complete.task.metadata.uBuddyTaskIntakeSpec.state, 'ready');
  assert.equal(complete.task.metadata.uBuddyTaskIntakeSpec.missingFields.length, 0);

  const referenceInitial = await runtime.secretaryChat({
    sessionId: completeSession.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '项目引用延续测试，最终材料待定。',
    fileReferences: [{
      referenceId: 'intake-reference-continuity', referenceKind: 'file', projectId: project.id,
      relativePath: 'reference.txt', name: 'reference.txt', source: 'picker',
    }],
  });
  assert.equal(referenceInitial.uBuddyMode, 'clarification');
  const referenceContinued = await runtime.secretaryChat({
    sessionId: completeSession.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '项目引用最终交付报告。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(referenceContinued.uBuddyMode));
  assert.match(referenceContinued.task.prompt, /PROJECT_REFERENCE_CONTINUITY_OK/);
  const referenceSource = runtime.store.listMessages(completeSession.id).filter((item) => item.role === 'user').at(-1);
  assert.equal(referenceSource.metadata.fileReferences[0].relativePath, 'reference.txt');
  const referenceAbandonInitial = await runtime.secretaryChat({
    sessionId: completeSession.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '项目引用延续测试，最终材料待定。',
    fileReferences: [{
      referenceId: 'intake-reference-abandon', referenceKind: 'file', projectId: project.id,
      relativePath: 'reference.txt', name: 'reference.txt', source: 'picker',
    }],
  });
  assert.equal(referenceAbandonInitial.uBuddyMode, 'clarification');
  const referenceAbandoned = await runtime.secretaryChat({
    sessionId: completeSession.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '算了，解释一下光合作用。',
  });
  assert.equal(referenceAbandoned.uBuddyMode, 'direct');
  const referenceAbandonedSource = runtime.store.getMessage(referenceAbandoned.message.metadata.sourceMessageId);
  assert.equal(referenceAbandonedSource.metadata.fileReferences, undefined,
    'abandoning an intake must clear inherited project references');

  const recipientSession = runtime.ensureSecretarySession();
  const recipientCounts = counts();
  const missingRecipient = await runtime.secretaryChat({
    sessionId: recipientSession.id,
    message: '请把一份市场分析报告委托给同事完成。',
  });
  assert.equal(missingRecipient.uBuddyMode, 'clarification');
  assert.deepEqual(missingRecipient.taskIntake.missingFields, ['executionTarget']);
  assert.equal(missingRecipient.taskIntake.clarifications[0].answerType, 'execution_target');
  assert.match(missingRecipient.answer, /本地完成/);
  assert.match(missingRecipient.answer, /@ 联系人完成/);
  assert.deepEqual(counts(), recipientCounts, 'recipient clarification must not create task, group, or delegation');
  const continuedRecipient = await runtime.secretaryChat({
    sessionId: recipientSession.id,
    message: '@验收联系人 交给她。',
    mentions: [contactMention],
  });
  assert.equal(continuedRecipient.uBuddyMode, 'dispatched');
  assert.equal(continuedRecipient.dispatchType, 'external_delegation');
  if (continuedRecipient.delegation) assert.equal(continuedRecipient.delegation.recipientUserId, 'intake_contact');
  else assert.equal(continuedRecipient.waitingForPresence, true);
  assert.equal(continuedRecipient.intentDecision.objective, '写一份市场分析报告');
  const continuedRecipientIntake = runtime.store.listMessages(recipientSession.id).filter((item) => item.role === 'user').at(-1)
    ?.metadata?.uBuddyTaskIntakeSpec;
  assert.equal(continuedRecipientIntake?.objective, '写一份市场分析报告');
  assert.equal(continuedRecipientIntake?.candidateUsers[0].userId, 'intake_contact');
  assert.equal(continuedRecipientIntake?.requiredUsers[0].userId, 'intake_contact');

  const replacementInitial = await runtime.secretaryChat({
    sessionId: recipientSession.id,
    message: '@验收联系人 请完成替换收件人测试，最终材料待定。',
    mentions: [{ ...contactMention, mentionId: 'replacement_initial_mention' }],
  });
  assert.equal(replacementInitial.uBuddyMode, 'clarification');
  const replacementResult = await runtime.secretaryChat({
    sessionId: recipientSession.id,
    message: '@替换联系人 改由他负责，交付物仍待定。',
    mentions: [replacementMention],
  });
  assert.equal(replacementResult.uBuddyMode, 'clarification');
  const replacementIntermediateSource = runtime.store.listMessages(recipientSession.id).filter((item) => item.role === 'user').at(-1);
  assert.deepEqual(replacementIntermediateSource.metadata.uBuddyTaskIntakeSpec.requiredUsers.map((item) => item.userId), ['replacement_contact']);
  assert.deepEqual(replacementIntermediateSource.metadata.mentions.filter((item) => item.principalType === 'user').map((item) => item.userId), ['replacement_contact']);
  const replacementFinal = await runtime.secretaryChat({
    sessionId: recipientSession.id,
    message: '替换测试最终交付报告。',
  });
  assert.equal(replacementFinal.uBuddyMode, 'dispatched');
  if (replacementFinal.delegation) assert.equal(replacementFinal.delegation.recipientUserId, 'replacement_contact');
  else assert.equal(replacementFinal.waitingForPresence, true);

  const deliverableSession = runtime.ensureSecretarySession();
  const deliverableCounts = counts();
  const missingDeliverable = await runtime.secretaryChat({
    sessionId: deliverableSession.id,
    message: '分析中国环境并形成最终材料。',
  });
  assert.equal(missingDeliverable.uBuddyMode, 'clarification');
  assert.deepEqual(missingDeliverable.taskIntake.missingFields, ['deliverables']);
  assert.match(missingDeliverable.answer, /报告还是 PPT/);
  assert.deepEqual(counts(), deliverableCounts, 'deliverable clarification must not create task, group, or delegation');
  const continuedDeliverable = await runtime.secretaryChat({
    sessionId: deliverableSession.id,
    message: '最终交付 PPT。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(continuedDeliverable.uBuddyMode));
  assert.equal(continuedDeliverable.task.metadata.uBuddyTaskIntakeSpec.objective, '分析中国环境');
  assert.equal(continuedDeliverable.task.metadata.uBuddyTaskIntakeSpec.deliverables[0], '可编辑 PPTX 演示文稿');

  const attachmentSession = runtime.ensureSecretarySession();
  const attachment = runtime.uploadFile({
    filename: 'intake-requirements.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('附件明确要求：最终交付书面报告，包含摘要和结论。').toString('base64'),
  });
  const attachmentResult = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '请按附件要求处理。',
    attachments: [attachment],
  });
  assert.equal(attachmentResult.uBuddyMode, 'clarification');
  assert.equal(attachmentResult.taskIntake.clarification.reasonCode, 'attachment_body_deferred');
  const continuedAttachmentResult = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '附件任务最终交付书面报告。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(continuedAttachmentResult.uBuddyMode), JSON.stringify(continuedAttachmentResult));
  assert.equal(continuedAttachmentResult.task.metadata.uBuddyTaskIntakeSpec.deliverables[0], '书面报告');
  assert.equal(continuedAttachmentResult.task.metadata.uBuddyTaskIntakeSpec.attachments[0].id, attachment.id);

  const replacementOldAttachment = runtime.uploadFile({
    filename: 'replacement-old.txt', contentType: 'text/plain',
    dataBase64: Buffer.from('旧附件，不应进入最终执行。').toString('base64'),
  });
  const replacementNewAttachment = runtime.uploadFile({
    filename: 'replacement-new.txt', contentType: 'text/plain',
    dataBase64: Buffer.from('新附件，应作为最终执行依据。').toString('base64'),
  });
  const attachmentReplacementInitial = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '附件替换测试，最终材料待定。',
    attachments: [replacementOldAttachment],
  });
  assert.equal(attachmentReplacementInitial.uBuddyMode, 'clarification');
  const attachmentReplacementResult = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '改用新附件，最终交付报告。',
    attachments: [replacementNewAttachment],
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(attachmentReplacementResult.uBuddyMode));
  assert.deepEqual(attachmentReplacementResult.task.metadata.uBuddyTaskIntakeSpec.attachments.map((item) => item.id), [replacementNewAttachment.id]);
  assert.deepEqual(attachmentReplacementResult.task.metadata.attachments.map((item) => item.id), [replacementNewAttachment.id]);

  const abandonmentCounts = counts();
  const pendingBeforeAbandonment = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '分析中国环境并形成最终材料。',
  });
  assert.equal(pendingBeforeAbandonment.uBuddyMode, 'clarification');
  assert.deepEqual(counts(), abandonmentCounts);
  const abandoned = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '算了，解释一下光合作用。',
  });
  assert.equal(abandoned.uBuddyMode, 'direct');
  assert.match(abandoned.answer, /光合作用/);
  assert.deepEqual(counts(), abandonmentCounts, 'abandoning an intake must not reuse its recipients or create work');

  const retryCounts = counts();
  const retryInitial = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '需要失败恢复的分析任务。',
  });
  assert.equal(retryInitial.uBuddyMode, 'clarification');
  const retryFailure = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '最终交付报告但模拟 intake 失败。',
  });
  assert.equal(retryFailure.uBuddyMode, 'intake_failed');
  assert.equal(retryFailure.message.metadata.uBuddyIntakeRetryable, true);
  assert.equal(retryFailure.message.metadata.uBuddyTaskIntakeSpec.objective, '完成需要失败恢复的分析任务');
  assert.deepEqual(counts(), retryCounts, 'an intake model failure must not create work');
  const retryRecovered = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '重试上一条补充。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(retryRecovered.uBuddyMode));
  assert.equal(retryRecovered.task.metadata.uBuddyTaskIntakeSpec.objective, '完成需要失败恢复的分析任务');
  assert.equal(retryRecovered.task.metadata.uBuddyTaskIntakeSpec.deliverables[0], '书面报告');

  const interruptedInitial = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '需要中断后继续的分析任务。',
  });
  assert.equal(interruptedInitial.uBuddyMode, 'clarification');
  assert.equal(interruptedInitial.message.metadata.uBuddyIntakePlannerThreadId, 'ubuddy-intake-v2-thread',
    'the clarification card must persist the Codex planner thread for process-safe continuation');
  const interruptedQuery = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '当前任务进度怎么样？',
  });
  assert.equal(interruptedQuery.uBuddyMode, 'task_query_control');
  assert.match(interruptedQuery.answer, /^CODEX_INTAKE_QUERY_OK/);
  const interruptedRecovered = await runtime.secretaryChat({
    sessionId: attachmentSession.id,
    message: '中断测试最终交付报告。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(interruptedRecovered.uBuddyMode));
  assert.equal(interruptedRecovered.task.metadata.uBuddyTaskIntakeSpec.objective, '完成需要中断后继续的分析任务');

  process.env.JANUS_UBUDDY_TASK_INTAKE_TIMEOUT_MS = '60';
  process.env.JANUS_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS = '60';
  const timeoutFallbackCounts = counts();
  const timeoutFallbackSession = runtime.ensureSecretarySession();
  const timeoutFallbackResult = await runtime.secretaryChat({
    sessionId: timeoutFallbackSession.id,
    message: '请创建模拟 intake 超时兜底报告任务。',
  });
  assert.equal(timeoutFallbackResult.uBuddyMode, 'intake_failed');
  assert.equal(timeoutFallbackResult.errorCode, 'ubuddy_task_intake_timeout');
  assert.deepEqual(counts(), timeoutFallbackCounts, 'an intake timeout must not create local work');
  const externalTimeoutFallbackSession = runtime.ensureSecretarySession();
  const externalTimeoutFallbackResult = await runtime.secretaryChat({
    sessionId: externalTimeoutFallbackSession.id,
    message: '@验收联系人 请完成模拟 intake 超时兜底报告任务。',
    mentions: [{ ...contactMention, mentionId: 'intake_timeout_fallback_mention' }],
  });
  assert.equal(externalTimeoutFallbackResult.uBuddyMode, 'intake_failed');
  assert.equal(externalTimeoutFallbackResult.errorCode, 'ubuddy_task_intake_timeout');
  assert.deepEqual(counts(), timeoutFallbackCounts, 'an intake timeout must not create external work');
  const externalTimeoutFallbackSource = runtime.store.listMessages(externalTimeoutFallbackSession.id)
    .filter((item) => item.role === 'user').at(-1);
  assert.equal(externalTimeoutFallbackSource.metadata.uBuddyIntakeDecisionFailed, true);
  if (previousIntakeTimeout === undefined) delete process.env.JANUS_UBUDDY_TASK_INTAKE_TIMEOUT_MS;
  else process.env.JANUS_UBUDDY_TASK_INTAKE_TIMEOUT_MS = previousIntakeTimeout;
  if (previousIntakeRetryTimeout === undefined) delete process.env.JANUS_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS;
  else process.env.JANUS_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS = previousIntakeRetryTimeout;

  process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = 'on';
  const semanticNewTask = await runtime.secretaryChat({
    sessionId: runtime.ensureSecretarySession().id,
    taskReferenceVersion: 'structured_task_reference_v1',
    message: '请创建一份新的中国环境 Markdown 报告。',
  });
  assert.notEqual(semanticNewTask.uBuddyMode, 'task_reference_required',
    'a semantically new task must not be intercepted by active-task selection');
  assert.ok(semanticNewTask.taskRunId);
  runtime.cancelTaskRun({ taskRunId: semanticNewTask.taskRunId });
  process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = 'off';

  process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'off';
  const legacySession = runtime.ensureSecretarySession();
  const intakeCallsBefore = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.includes('UBUDDY_TASK_INTAKE_DECISION_V2')).length;
  const legacy = await runtime.secretaryChat({
    sessionId: legacySession.id,
    message: '@验收联系人',
    mentions: [{ ...contactMention, mentionId: 'legacy_contact_mention' }],
  });
  const intakeCallsAfter = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.includes('UBUDDY_TASK_INTAKE_DECISION_V2')).length;
  assert.equal(legacy.uBuddyMode, 'clarification');
  assert.equal(legacy.message.metadata.reasonCode, 'missing_requirement');
  assert.equal(legacy.message.metadata.uBuddyIntakeClarificationV2, undefined);
  assert.equal(intakeCallsAfter, intakeCallsBefore, 'disabled flag must bypass the intake-v2 model call');

  console.log('uBuddy intake clarification v2 smoke passed');
} finally {
  if (runtime) {
    for (const task of runtime.store.listTaskRuns({ userId: runtime.currentUser()?.id || '', limit: 100 })) {
      if (!['completed', 'failed', 'cancelled'].includes(String(task.status || ''))) {
        try { runtime.cancelTaskRun({ taskRunId: task.id }); } catch {}
      }
    }
  }
  if (runtime) await runtime.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN; else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousFlag === undefined) delete process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2; else process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = previousFlag;
  if (previousStructuredReferenceFlag === undefined) delete process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
  else process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = previousStructuredReferenceFlag;
  if (previousAutoRoutingFlag === undefined) delete process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
  else process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = previousAutoRoutingFlag;
  if (previousLog === undefined) delete process.env.UBUDDY_INTAKE_LOG; else process.env.UBUDDY_INTAKE_LOG = previousLog;
  if (previousIntakeTimeout === undefined) delete process.env.JANUS_UBUDDY_TASK_INTAKE_TIMEOUT_MS;
  else process.env.JANUS_UBUDDY_TASK_INTAKE_TIMEOUT_MS = previousIntakeTimeout;
  if (previousIntakeRetryTimeout === undefined) delete process.env.JANUS_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS;
  else process.env.JANUS_UBUDDY_TASK_INTAKE_RETRY_TIMEOUT_MS = previousIntakeRetryTimeout;
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}
