import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { decideUBuddyTaskIntake } from '../src/main/modules/orchestration/application/uBuddyTaskIntakePlanner.js';
import {
  buildDeterministicWorkDigest,
  buildEmptyWorkDigest,
  buildTimedOutEmptyWorkDigest,
  collectRecentWork,
} from '../src/main/modules/orchestration/application/recentWorkCollector.js';
import { createUBuddyFeatureFlagService } from '../src/main/modules/collaboration/infrastructure/ubuddyFeatureFlags.js';
import { publicDelegationMetadata } from '../src/shared/contracts/delegation.js';
import { validateUBuddyTaskIntake } from '../src/shared/contracts/uBuddyTaskIntake.js';
import { validateWorkReportSpec } from '../src/shared/contracts/workDigest.js';
import { state as rendererState } from '../src/renderer/app/state.js';
import { renderNetworkPanel } from '../src/renderer/app/views/networkView.js';

const NOW = '2026-08-11T12:00:00.000Z';
const SPEC = {
  version: 'work_report_spec_v1',
  startAt: '2026-08-04T00:00:00.000Z',
  endAt: '2026-08-11T12:00:00.000Z',
  timezone: 'Asia/Shanghai',
  workspaceScope: 'selected_projects',
  projectIds: ['project-target'],
  agentInstanceIds: ['agent-instance-target'],
  sourceTypes: ['structured_tasks'],
  sections: ['completed', 'in_progress', 'blockers', 'next_steps', 'artifacts'],
  detailLevel: 'standard',
  audienceUserIds: ['requester-user'],
  confirmationMode: 'owner_confirmation',
};

assert.equal(createUBuddyFeatureFlagService({ env: {} }).snapshot().recentWorkReportingV1, true,
  'recent-work reporting must be on by default');
assert.equal(createUBuddyFeatureFlagService({
  env: { JANUS_UBUDDY_RECENT_WORK_REPORTING_V1: 'off' },
}).snapshot().recentWorkReportingV1, false, 'an explicit environment override must still disable recent-work reporting');
assert.deepEqual(validateWorkReportSpec({ timezone: 'Asia/Shanghai' }, { now: Date.parse(NOW) }).diagnostics.map((item) => item.field), [
  'startAt', 'endAt', 'workspaceScope', 'audienceUserIds',
]);
assert.equal(validateWorkReportSpec(SPEC, { now: Date.parse(NOW) }).valid, true);
assert.ok(validateWorkReportSpec({ ...SPEC, timezone: 'not/a-timezone' }, { now: Date.parse(NOW) })
  .diagnostics.some((item) => item.code === 'work_report_timezone_invalid'));

const invalidIntake = validateUBuddyTaskIntake({
  version: 'ubuddy_task_intake_v1', state: 'ready', taskKind: 'recent_work_report',
  objective: '汇报近期工作', deliverables: ['工作汇报'], privacyScope: 'direct_delegation', riskLevel: 'low',
  candidateUsers: [{ userId: 'recipient-user' }], requiredUsers: [{ userId: 'recipient-user' }],
  workReportSpec: { timezone: 'Asia/Shanghai' }, missingFields: [], clarification: {},
});
assert.equal(invalidIntake.valid, false);
assert.ok(invalidIntake.diagnostics.some((item) => item.code === 'work_report_start_missing'));
assert.ok(invalidIntake.diagnostics.some((item) => item.code === 'work_report_workspace_scope_missing'));

let disabledIntakePrompt = '';
await decideUBuddyTaskIntake({
  prompt: '请询问对方最近的工作。', recentWorkReportingEnabled: false,
  execute: async ({ prompt }) => {
    disabledIntakePrompt = prompt;
    return JSON.stringify({ version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', intake: null });
  },
});
assert.doesNotMatch(disabledIntakePrompt, /Classify a request asking another user.*recent_work_report/);
let enabledIntakePrompt = '';
await decideUBuddyTaskIntake({
  prompt: '请询问对方最近的工作。', recentWorkReportingEnabled: true,
  execute: async ({ prompt }) => {
    enabledIntakePrompt = prompt;
    return JSON.stringify({ version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', intake: null });
  },
});
assert.match(enabledIntakePrompt, /Classify a request asking another user.*recent_work_report/);

let collectorArgs = null;
const collectorTasks = new Map([
  ['task-target', taskFixture({
    id: 'task-target', workspaceId: 'workspace-organization', projectId: 'project-target',
    agentInstanceId: 'agent-instance-target', title: '目标任务', updatedAt: '2026-08-10T08:00:00.000Z',
    resultSummary: '报告已写入 /home/recipient/private/report.md', artifact: '/home/recipient/private/report.md',
  })],
  ['task-other-project', taskFixture({
    id: 'task-other-project', workspaceId: 'workspace-organization', projectId: 'project-other',
    agentInstanceId: 'agent-instance-target', title: '其他项目', updatedAt: '2026-08-10T08:00:00.000Z',
  })],
  ['task-other-agent', taskFixture({
    id: 'task-other-agent', workspaceId: 'workspace-organization', projectId: 'project-target',
    agentInstanceId: 'agent-instance-other', title: '其他 Agent', updatedAt: '2026-08-10T08:00:00.000Z',
  })],
  ['task-outside-range', taskFixture({
    id: 'task-outside-range', workspaceId: 'workspace-organization', projectId: 'project-target',
    agentInstanceId: 'agent-instance-target', title: '范围外任务', updatedAt: '2026-07-01T08:00:00.000Z',
  })],
  ['task-revoked-workspace', taskFixture({
    id: 'task-revoked-workspace', workspaceId: 'workspace-revoked', projectId: 'project-target',
    agentInstanceId: 'agent-instance-target', title: '已撤销 Workspace 任务', updatedAt: '2026-08-10T08:00:00.000Z',
  })],
]);
const collectorStore = {
  listAccountWorkspaces() {
    return [{ id: 'workspace-personal' }, { id: 'workspace-organization' }];
  },
  listTaskRuns(args) {
    collectorArgs = args;
    return [...collectorTasks.values()].map((task) => ({
      id: task.id, workspaceId: task.workspaceId, metadata: task.metadata,
    }));
  },
  getTaskRun(id) { return structuredClone(collectorTasks.get(id)); },
};
const collected = collectRecentWork({
  store: collectorStore, userId: 'recipient-user', workspaceId: 'workspace-personal', spec: SPEC,
});
assert.equal(collectorArgs.allWorkspaces, true, 'selected projects must be searched across authorized Workspaces');
assert.equal(collected.evidence.length, 1);
assert.equal(collected.evidence[0].sourceId, 'task-target');
assert.equal(collected.evidence[0].summary.includes('/home/recipient'), false);
assert.deepEqual(collected.evidence[0].artifacts, ['report.md']);
assert.equal(collected.coverage.filteredPrivateEventCount, 2);
assert.equal(collected.coverage.includedTaskCount, 1);
assert.match(buildDeterministicWorkDigest(collected), /目标任务/);
assert.match(buildEmptyWorkDigest({ coverage: collected.coverage, spec: SPEC }), /未找到可汇报的结构化 Janus 工作记录/);
assert.match(buildTimedOutEmptyWorkDigest({ coverage: collected.coverage, spec: SPEC }), /不代表本人确认没有开展其他工作/);

assert.deepEqual(publicDelegationMetadata({
  taskKind: 'recent_work_report', workReportSpec: SPEC, workDigestJobId: 'private-job',
  workDigestState: 'draft_ready', workDigestCoverage: { includedTaskCount: 1 }, preliminaryResult: 'private draft',
}), { taskKind: 'recent_work_report', workReportSpec: SPEC });

Object.assign(rendererState, {
  networkPanelOpen: true, networkPanelView: 'tasks', networkDelegationId: 'digest-renderer-delegation',
  languageMode: 'zh',
  currentUser: { id: 'recipient-user', displayName: 'Recipient' },
  agentDelegations: [{
    id: 'digest-renderer-delegation', requesterUserId: 'requester-user', recipientUserId: 'recipient-user',
    title: '近期工作汇报', instruction: '汇报指定范围内的近期工作。', status: 'working',
    requester: { id: 'requester-user', displayName: 'Requester' }, recipient: { id: 'recipient-user', displayName: 'Recipient' },
    metadata: {
      taskKind: 'recent_work_report', workReportSpec: SPEC, workDigestState: 'awaiting_owner_supplement',
      workDigestCoverage: { includedTaskCount: 0 }, workDigestExpiresAt: '2026-08-11T12:15:00.000Z',
    },
  }],
  collaborationOverview: { groups: [], tasks: [] }, networkConversationMessages: [], networkBusyDelegationId: '',
  networkDelegationRunsById: {}, networkDelegationProgressById: {}, networkDelegationCommentDrafts: {},
  networkDelegationUBuddyEnabled: {}, networkDelegationEditingMessageId: '', networkDelegationMemoryMenuOpen: false,
  attachments: [], friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } }, socialThreads: [], socialInbox: [],
});
const waitingHtml = renderNetworkPanel();
assert.match(waitingHtml, /id="work-digest-supplement-form"/);
assert.match(waitingHtml, /不会代表你确认没有开展其他工作/);
assert.match(waitingHtml, /等待截止/);
rendererState.agentDelegations[0].status = 'draft_ready';
rendererState.agentDelegations[0].metadata.workDigestState = 'draft_ready';
rendererState.agentDelegations[0].metadata.workDigestCoverage = { includedTaskCount: 2 };
const readyHtml = renderNetworkPanel();
assert.match(readyHtml, /已纳入 2 个结构化任务/);
assert.doesNotMatch(readyHtml, /work-digest-supplement-form/);
rendererState.languageMode = 'en';
const englishReadyHtml = renderNetworkPanel();
assert.match(englishReadyHtml, /Recent Work Report/);
assert.match(englishReadyHtml, /2 structured tasks included/);
assert.doesNotMatch(englishReadyHtml.match(/<section class="network-work-digest-status">[^]*?<\/section>/)?.[0] || '', /[\u3400-\u9fff]/,
  'the recent-work status surface must not add Chinese copy to the English renderer fixture');
rendererState.languageMode = 'zh';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-recent-work-reporting-'));
const fakeCodex = path.join(root, 'fake-codex.mjs');
const previousFlag = process.env.JANUS_UBUDDY_RECENT_WORK_REPORTING_V1;
const previousBin = process.env.JANUS_CODEX_BIN;
let runtime = null;

try {
  await writeFile(fakeCodex, `#!/usr/bin/env node
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server'); process.exit(0); }
if (args[0] !== 'app-server') process.exit(0);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (!message.method || message.id == null) continue;
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'recent-work-smoke' } });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'recent-work-thread' } } });
  else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  else if (message.method === 'thread/memoryMode/set' || message.method === 'thread/goal/get') send({ id: message.id, result: {} });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'recent-work-turn' } } });
    send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'fallback please' } } });
    send({ method: 'turn/completed', params: { turn: { id: 'recent-work-turn', status: 'completed', items: [] } } });
  } else send({ id: message.id, result: {} });
}
`);
  chmodSync(fakeCodex, 0o755);
  process.env.JANUS_CODEX_BIN = fakeCodex;
  process.env.JANUS_UBUDDY_RECENT_WORK_REPORTING_V1 = 'on';
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });

  const requester = runtime.currentUser();
  const registration = runtime.auth.registerWithEmail({
    email: 'recent-work-owner@example.com', password: 'recent-work-password-123', displayName: 'Recent Work Owner',
  });
  const owner = registration.user || registration;
  runtime.store.provisionNewUserAgentDefaults({ userId: owner.id });
  const [userA, userB] = [requester.id, owner.id].sort();
  runtime.db.prepare("INSERT INTO friendships(id,user_a_id,user_b_id,status) VALUES('recent-work-friendship',?,?,'accepted')").run(userA, userB);

  const runtimeSpec = {
    ...SPEC,
    startAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    endAt: new Date(Date.now() + 60 * 1000).toISOString(),
    workspaceScope: 'current_workspace', projectIds: [], agentInstanceIds: [], audienceUserIds: [requester.id],
  };
  const createReportDelegation = (title) => {
    runtime.auth.setActiveUser(requester.id);
    return runtime.createAgentDelegation({
      recipientId: owner.id, title, instruction: '请按指定范围汇报近期工作。',
      metadata: { taskKind: 'recent_work_report', workReportSpec: runtimeSpec },
    }).delegation;
  };

  const supplementedDelegation = createReportDelegation('补充路径验证');
  runtime.auth.setActiveUser(owner.id);
  const waiting = await runtime.prepareRecentWorkDigest({ delegationId: supplementedDelegation.id });
  assert.equal(waiting.awaitingSupplement, true);
  assert.equal(waiting.job.status, 'awaiting_owner_supplement');
  assert.equal(runtime.auth.agentDelegationById(supplementedDelegation.id).status, 'working');

  const drafted = await runtime.supplementRecentWorkDigest({
    delegationId: supplementedDelegation.id, content: '完成了客户访谈纪要，并整理了下一轮验证问题。',
  });
  assert.equal(drafted.job.status, 'draft_ready');
  assert.equal(drafted.delegation.status, 'draft_ready');
  assert.equal(drafted.version.sourceKind, 'deterministic_fallback');
  assert.equal(drafted.version.evidence[0].sourceKind, 'owner_supplement');
  assert.equal(runtime.store.getSession(drafted.delegation.sessionId)?.userId, owner.id);
  const versionCountAfterDraft = runtime.db.prepare('SELECT COUNT(*) count FROM work_digest_versions WHERE job_id=?').get(drafted.job.id).count;
  const repeatedDraft = await runtime.prepareRecentWorkDigest({ delegationId: supplementedDelegation.id });
  assert.equal(repeatedDraft.idempotent, true);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) count FROM work_digest_versions WHERE job_id=?').get(drafted.job.id).count, versionCountAfterDraft);
  assert.match(drafted.version.evidenceHash, /^[a-f0-9]{64}$/);

  const timeoutDelegation = createReportDelegation('超时路径验证');
  runtime.auth.setActiveUser(owner.id);
  const timeoutWaiting = await runtime.prepareRecentWorkDigest({ delegationId: timeoutDelegation.id });
  runtime.db.prepare("UPDATE work_digest_jobs SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(timeoutWaiting.job.id);
  await assert.rejects(() => runtime.supplementRecentWorkDigest({
    delegationId: timeoutDelegation.id, content: '这条补充已经超过固定等待期限。',
  }), /补充等待期已结束/);
  await runtime.pollSocialNetwork({ autoProcess: true });
  const publishedJob = runtime.store.getWorkDigestJob({ id: timeoutWaiting.job.id });
  assert.equal(publishedJob.status, 'published');
  assert.equal(publishedJob.latestVersion.sourceKind, 'automatic_empty_timeout');
  assert.match(publishedJob.latestVersion.body, /不代表本人确认没有开展其他工作/);
  const submitted = runtime.auth.agentDelegationById(timeoutDelegation.id);
  assert.ok(['submitted', 'completed'].includes(submitted.status));
  const publishedVersionCount = runtime.db.prepare('SELECT COUNT(*) count FROM work_digest_versions WHERE job_id=?').get(timeoutWaiting.job.id).count;
  await runtime.pollSocialNetwork({ autoProcess: true });
  assert.equal(runtime.db.prepare('SELECT COUNT(*) count FROM work_digest_versions WHERE job_id=?').get(timeoutWaiting.job.id).count, publishedVersionCount,
    'repeated polling must not publish another timed-out empty report');

  const persisted = runtime.store.ensureWorkDigestJob({
    delegationId: 'persistence-idempotence', ownerUserId: owner.id, workspaceId: 'workspace_personal', spec: runtimeSpec,
  });
  assert.equal(runtime.store.ensureWorkDigestJob({
    delegationId: 'persistence-idempotence', ownerUserId: owner.id, workspaceId: 'workspace_personal', spec: runtimeSpec,
  }).id, persisted.id);

  assert.equal(runtime.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('uBuddy recent work reporting smoke passed');
} finally {
  runtime?.close();
  rmSync(root, { recursive: true, force: true });
  if (previousFlag === undefined) delete process.env.JANUS_UBUDDY_RECENT_WORK_REPORTING_V1;
  else process.env.JANUS_UBUDDY_RECENT_WORK_REPORTING_V1 = previousFlag;
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
}

function taskFixture({ id, workspaceId, projectId, agentInstanceId, title, updatedAt, resultSummary = '任务已完成', artifact = '' }) {
  return {
    id, ownerUserId: 'recipient-user', workspaceId, accountWorkspaceId: workspaceId, title,
    status: 'completed', createdAt: updatedAt, updatedAt, completedAt: updatedAt, summary: resultSummary,
    leadAgentId: 'general_agent', leadAgentInstanceId: agentInstanceId,
    metadata: {
      projectId,
      deliverableResult: artifact ? { files: [{ relative_path: artifact }] } : { files: [] },
    },
    nodes: [{
      id: `${id}-node`, title, status: 'completed', agentId: 'general_agent', agentInstanceId,
      createdAt: updatedAt, updatedAt, completedAt: updatedAt, resultSummary,
    }],
    events: [
      { id: `${id}-event`, eventType: 'node_completed', actorId: 'general_agent', summary: resultSummary, createdAt: updatedAt, updatedAt, payload: {} },
      { id: `${id}-private`, eventType: 'model_prompt', actorId: 'general_agent', summary: 'private prompt', createdAt: updatedAt, updatedAt, payload: {} },
    ],
    deliverySubmissions: [],
  };
}
