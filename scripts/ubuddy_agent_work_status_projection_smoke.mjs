import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  projectDelegationAgentWorkStatus,
  projectDeliveryAgentWorkStatus,
  projectTaskAgentWorkStatus,
  publicTaskAgentWorkStatus,
} from '../src/main/modules/orchestration/domain/agentWorkStatusProjection.js';
import {
  normalizeAgentWorkStatusProjection,
  normalizeAgentWorkStatusProjectionEnvelope,
  publicAgentWorkStatusProjectionEnvelope,
  validateAgentWorkStatusProjectionEnvelope,
} from '../src/shared/contracts/uBuddyWorkStatus.js';
import { publicDelegationMetadata } from '../src/shared/contracts/delegation.js';
import {
  renderAgentWorkProjectionSummary,
  workProjectionEnvelope,
  workProjectionForAgent,
  workProjectionForNode,
} from '../src/renderer/app/components/agentWorkProjection.js';
import { normalizeCoordinationSnapshot } from '../src/renderer/app/features/ubuddy/coordinationState.js';
import { state } from '../src/renderer/app/state.js';
import { renderCollaboration, renderTasks } from '../src/renderer/app/views/collaborationView.js';
import { renderUBuddyCoordinationPanels } from '../src/renderer/app/views/ubuddyCoordinationView.js';
import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

const updatedAt = '2026-08-04T10:00:00.000Z';
const task = {
  id: 'task-work-status', ownerUserId: 'owner-private', workspaceId: 'workspace_personal',
  title: '阶段 8 进度展示', prompt: '实现 Agent 具体进度', departmentId: 'general', status: 'running', updatedAt,
  metadata: { source: 'ubuddy_dispatch', delegationId: 'delegation-work-status', phase: 'executing' },
  nodes: [
    {
      id: 'node-code', taskRunId: 'task-work-status', title: '实现统一投影', objective: '实现统一投影服务',
      agentId: 'code_agent', agentInstanceId: 'agent-code-a', status: 'running', priority: 10,
      attemptCount: 1, maxAttempts: 3, evidenceRefs: [{ id: 'artifact-safe', kind: 'deliverable', label: '实现草稿' }], updatedAt,
    },
    {
      id: 'node-test', taskRunId: 'task-work-status', title: '运行验证', objective: '验证三个页面',
      agentId: 'qa_agent', agentInstanceId: 'agent-qa-a', status: 'retry_wait', priority: 20,
      attemptCount: 2, maxAttempts: 3, waitReason: '网络暂时不可用', nextRetryAt: '2026-08-04T10:05:00.000Z', updatedAt,
    },
    {
      id: 'node-code-done', taskRunId: 'task-work-status', title: '梳理契约', objective: '梳理字段',
      agentId: 'code_agent', agentInstanceId: 'agent-code-a', status: 'completed', priority: 5,
      resultSummary: '统一字段已经确认。', evidenceRefs: ['/home/owner/private.txt'], updatedAt: '2026-08-04T09:50:00.000Z',
    },
  ],
  events: [
    {
      id: 'event-reasoning', taskNodeId: 'node-code', actorId: 'code_agent', eventType: 'node_activity', status: 'running',
      summary: '内部推理不应进入投影', payload: { activityType: 'reasoning' }, updatedAt: '2026-08-04T09:58:00.000Z',
    },
    {
      id: 'event-code', taskNodeId: 'node-code', actorId: 'code_agent', eventType: 'node_activity', status: 'running',
      summary: '正在整理 /home/owner/private/report.md，token=secret-value，联系 owner@example.com',
      payload: { activityType: 'commentary' }, updatedAt,
    },
    {
      id: 'event-test', taskNodeId: 'node-test', actorId: 'qa_agent', eventType: 'node_retry_scheduled', status: 'waiting',
      summary: '验证等待自动重试。', payload: {}, updatedAt,
    },
  ],
  communications: [],
};

const coordination = { coordinationState: 'sleeping', updatedAt };
const projection = projectTaskAgentWorkStatus(task, {
  coordination,
  agentName: (agentId) => ({ code_agent: '代码 Agent', qa_agent: '验证 Agent' })[agentId] || agentId,
});
assert.equal(validateAgentWorkStatusProjectionEnvelope(projection).valid, true);
assert.equal(projection.scopeKind, 'task_run');
assert.equal(projection.actors.length, 3, 'uBuddy and two assigned Agents must be projected');
const codeActor = projection.actors.find((actor) => actor.agentInstanceId === 'agent-code-a');
assert.equal(codeActor.progress.completed, 1);
assert.equal(codeActor.progress.total, 2);
assert.equal(codeActor.progress.percent, 50);
assert.match(codeActor.currentAction, /正在整理/);
assert.doesNotMatch(codeActor.currentAction, /\/home\/owner|secret-value|owner@example\.com/);
assert.equal(codeActor.timeline.some((entry) => entry.summary.includes('内部推理')), false);
assert.equal(codeActor.evidenceRefs.some((item) => String(item.id).includes('/home/')), false);
const inPlaceUpdatedProjection = projectTaskAgentWorkStatus({
  ...task,
  events: [
    {
      id: 'event-created-later', taskNodeId: 'node-code', actorId: 'code_agent', eventType: 'node_activity', status: 'running',
      summary: '后创建但已经过时的动作', payload: { activityType: 'commentary' },
      createdAt: '2026-08-04T10:01:00.000Z', updatedAt: '2026-08-04T10:01:00.000Z',
    },
    {
      id: 'event-created-earlier-updated-latest', taskNodeId: 'node-code', actorId: 'code_agent', eventType: 'node_activity', status: 'running',
      summary: '原位更新后的最新动作', payload: { activityType: 'commentary' },
      createdAt: '2026-08-04T09:59:00.000Z', updatedAt: '2026-08-04T10:02:00.000Z',
    },
  ],
});
assert.equal(inPlaceUpdatedProjection.actors.find((actor) => actor.agentInstanceId === 'agent-code-a')?.currentAction,
  '原位更新后的最新动作', 'an in-place event update must win by updatedAt rather than creation order');
const sameMillisecondFirst = projectTaskAgentWorkStatus({
  ...task,
  events: [{
    id: 'same-ms-first', taskNodeId: 'node-code', actorId: 'code_agent', eventType: 'node_activity', status: 'running',
    summary: '同毫秒第一条动作', payload: { activityType: 'commentary' }, updatedAt,
  }],
});
const sameMillisecondSecond = projectTaskAgentWorkStatus({
  ...task,
  events: [
    ...sameMillisecondFirst.actors.find((actor) => actor.agentInstanceId === 'agent-code-a').timeline.map((entry) => ({
      id: entry.id, taskNodeId: 'node-code', actorId: 'code_agent', eventType: 'node_activity', status: 'running',
      summary: entry.summary, payload: { activityType: 'commentary' }, updatedAt: entry.occurredAt,
    })),
    {
      id: 'same-ms-second', taskNodeId: 'node-code', actorId: 'code_agent', eventType: 'node_activity', status: 'running',
      summary: '同毫秒第二条动作', payload: { activityType: 'commentary' }, updatedAt,
    },
  ],
});
const sameMsFirstActor = sameMillisecondFirst.actors.find((actor) => actor.agentInstanceId === 'agent-code-a');
const sameMsSecondActor = sameMillisecondSecond.actors.find((actor) => actor.agentInstanceId === 'agent-code-a');
assert.ok(sameMsSecondActor.sourceRevision > sameMsFirstActor.sourceRevision,
  'same-millisecond progress events must receive increasing source revisions');
assert.equal(sameMsSecondActor.currentAction, '同毫秒第二条动作');
const qaActor = projection.actors.find((actor) => actor.agentInstanceId === 'agent-qa-a');
assert.equal(qaActor.status, 'waiting');
assert.equal(qaActor.blocker.summary, '网络暂时不可用');
assert.match(qaActor.nextStep, /自动重试/);
const ubuddyActor = projection.actors.find((actor) => actor.actorKind === 'ubuddy');
assert.match(ubuddyActor.currentAction, /等待 leader 唤醒/);

const separateTaskProjection = projectTaskAgentWorkStatus({
  ...task, id: 'task-work-status-second', nodes: task.nodes.map((node) => ({ ...node, taskRunId: 'task-work-status-second' })),
  events: [],
});
assert.notEqual(
  projection.actors.find((actor) => actor.agentInstanceId === 'agent-code-a').projectionId,
  separateTaskProjection.actors.find((actor) => actor.agentInstanceId === 'agent-code-a').projectionId,
  'the same Agent in different tasks must keep scoped identities',
);

const normalizedReportedPercent = normalizeAgentWorkStatusProjection({
  projectionId: 'reported-percent', taskRunId: task.id, agentInstanceId: 'agent-code-a', status: 'running',
  progress: { completed: 1, total: 4, percent: 99 }, updatedAt,
});
assert.equal(normalizedReportedPercent.progress.percent, 25, 'reported percentages must be ignored');

const publicProjection = publicTaskAgentWorkStatus(task, { coordination, agentName: (value) => value });
assert.equal(publicProjection.actors.every((actor) => actor.visibility === 'participant_public'), true);
assert.equal(publicProjection.actors.every((actor) => !actor.ownerUserId && !actor.agentInstanceId), true);
const delegationEnvelope = publicAgentWorkStatusProjectionEnvelope({ ...publicProjection, scopeKind: 'delegation', scopeId: 'delegation-work-status' });
const publicMetadata = publicDelegationMetadata({ agentWorkStatusProjection: delegationEnvelope });
assert.equal(publicMetadata.agentWorkStatusProjection.scopeKind, 'delegation');
assert.equal(publicMetadata.agentWorkStatusProjection.actors.length, 3);

const receiptProjection = projectDeliveryAgentWorkStatus({
  workId: 'delivery-work-status', userId: 'owner-private', targetAgentInstanceId: 'agent-code-a', deliveryStatus: 'running', updatedAt,
  metadata: { targetAgentId: 'code_agent', targetAgentName: '代码 Agent' },
  events: [{ id: 'delivery-event', sequenceNo: 1, stage: 'working', message: '正在生成交付文件', createdAt: updatedAt }],
});
assert.equal(receiptProjection.scopeKind, 'delivery');
assert.equal(receiptProjection.actors[0].currentAction, '正在生成交付文件');

const remoteProjection = projectDelegationAgentWorkStatus({
  id: 'delegation-fallback', status: 'running', updatedAt,
  metadata: { executionProgress: {
    sequence: 3, phase: 'executing', message: '接收方正在执行', completed: 1, total: 2, updatedAt,
    nodes: [
      { id: 'remote-1', title: '整理报告结构', agentName: '报告 Agent', status: 'running', summary: '正在整理报告结构' },
      { id: 'remote-2', title: '资料检查', agentName: '报告 Agent', status: 'completed', summary: '资料检查完成' },
    ],
    milestones: [{ key: 'remote-milestone', title: '资料检查', detail: '资料检查完成', agentName: '报告 Agent', status: 'completed' }],
  } },
});
assert.equal(remoteProjection.scopeKind, 'delegation');
assert.match(remoteProjection.actors.find((actor) => actor.actorKind === 'remote_agent').currentAction, /整理报告结构/);

const componentHtml = renderAgentWorkProjectionSummary(codeActor, { showTimeline: true });
assert.match(componentHtml, /代码 Agent/);
assert.match(componentHtml, /当前节点/);
assert.match(componentHtml, /工作进度时间线/);

Object.assign(state, {
  currentUser: { id: 'owner-private' },
  activeAccountWorkspace: { id: 'workspace_personal' },
  activeTaskWorkspaceKind: '', activeTaskWorkspaceId: '', taskDetail: { ...task, agentWorkStatusProjection: projection },
  tasks: [{ ...task, nodeCount: 3, completedNodeCount: 1, agentWorkStatusProjection: projection }],
  taskBusy: false, busy: false, agentStatuses: [],
  org: { departments: [{ id: 'general', name: '通用' }], agents: [{ id: 'code_agent', name: '代码 Agent' }, { id: 'qa_agent', name: '验证 Agent' }], hrs: [] },
  collaborationEventHistoryOpenByTaskId: {}, taskWorkspaceViewById: {},
  workMemoryObservability: null,
  uBuddyFeatureFlags: { ...state.uBuddyFeatureFlags, agentWorkDetailProjection: true },
});
const collaborationHtml = renderCollaboration();
assert.match(collaborationHtml, /正在整理/);
assert.match(collaborationHtml, /验证等待自动重试/);
const kanbanHtml = renderTasks();
assert.match(kanbanHtml, /下一步/);
assert.match(kanbanHtml, /网络暂时不可用/);
const participantHtml = renderUBuddyCoordinationPanels({
  state, taskRunId: task.id,
  coordination: { coordinationState: 'sleeping', participants: [], leader: { agentInstanceId: 'agent-code-a', leadershipLevel: 'L1' }, waitingRequirements: [] },
  task: { ...task, agentWorkStatusProjection: projection }, nodes: task.nodes,
});
assert.match(participantHtml, /最终 Agent/);
assert.match(participantHtml, /代码 Agent/);
assert.match(participantHtml, /验证 Agent/);
assert.match(participantHtml, /class="is-running">实现统一投影/);
assert.match(participantHtml, /class="is-completed">梳理契约/);
assert.match(participantHtml, /class="is-retry_wait">运行验证/);
assert.match(participantHtml, /工作进度时间线/);
assert.match(participantHtml, /leader/);

const secondCodeInstanceId = 'agent-code-b';
const multiInstanceTask = {
  ...task,
  id: 'task-work-status-multi-instance',
  leadAgentInstanceId: 'agent-code-a',
  nodes: [
    ...task.nodes,
    {
      id: 'node-code-b', taskRunId: 'task-work-status-multi-instance', title: '独立复核实现', objective: '独立复核统一投影',
      agentId: 'code_agent', agentInstanceId: secondCodeInstanceId, status: 'queued', priority: 15,
      attemptCount: 0, maxAttempts: 3, updatedAt,
    },
    {
      id: 'node-code-unbound', taskRunId: 'task-work-status-multi-instance', title: '未绑定补充节点', objective: '等待实例绑定',
      agentId: 'code_agent', agentInstanceId: '', status: 'pending', priority: 30,
      attemptCount: 0, maxAttempts: 3, updatedAt,
    },
  ].map((node) => ({ ...node, taskRunId: 'task-work-status-multi-instance' })),
};
const multiInstanceProjection = projectTaskAgentWorkStatus(multiInstanceTask, {
  coordination,
  agentName: (agentId) => ({ code_agent: '代码 Agent', qa_agent: '验证 Agent' })[agentId] || agentId,
});
const firstCodeActor = multiInstanceProjection.actors.find((actor) => actor.agentInstanceId === 'agent-code-a');
const defensiveProjection = {
  ...multiInstanceProjection,
  actors: [
    ...multiInstanceProjection.actors,
    firstCodeActor,
    {
      ...firstCodeActor,
      projectionId: 'legacy-recovery-conversation-projection',
      currentAction: '恢复后继续整理统一投影。',
      evidenceRefs: [],
      timeline: [{ id: 'legacy-recovery-event', sourceKind: 'task_event', status: 'running', stage: 'executing', summary: '恢复后继续执行。', occurredAt: '2026-08-04T10:01:00.000Z' }],
      updatedAt: '2026-08-04T10:01:00.000Z',
    },
    {
      ...firstCodeActor,
      projectionId: 'orphan-recovery-conversation-projection',
      agentInstanceId: 'recovery-conversation-code-a',
      actorLabel: '恢复会话',
      currentAction: '旧恢复记录不应创建参与 Agent。',
      updatedAt: '2026-08-04T10:02:00.000Z',
    },
  ],
  updatedAt: '2026-08-04T10:01:00.000Z',
};
const defensiveEnvelope = workProjectionEnvelope(defensiveProjection);
assert.equal(defensiveEnvelope.actors.filter((actor) => actor.agentInstanceId === 'agent-code-a').length, 1,
  'duplicate and recovery projections must collapse into one Agent instance');
assert.equal(defensiveEnvelope.actors.find((actor) => actor.agentInstanceId === 'agent-code-a')?.progress.total, 2,
  'exact duplicate projections must not double-count responsible nodes');
assert.match(defensiveEnvelope.actors.find((actor) => actor.agentInstanceId === 'agent-code-a')?.timeline.at(-1)?.summary || '', /恢复后继续执行/);
const revisionOrderedEnvelope = workProjectionEnvelope({
  ...multiInstanceProjection,
  actors: [
    { ...firstCodeActor, status: 'running', sourceRevision: 10 },
    { ...firstCodeActor, status: 'completed', currentAction: '较新修订已经完成。', sourceRevision: 11 },
  ],
});
assert.equal(revisionOrderedEnvelope.actors[0]?.status, 'completed',
  'equal-timestamp snapshots with the same projectionId must use the highest source revision');
assert.equal(revisionOrderedEnvelope.actors[0]?.currentAction, '较新修订已经完成。');
const codeAOnlyProjection = {
  ...defensiveEnvelope,
  actors: defensiveEnvelope.actors.filter((actor) => actor.agentInstanceId !== secondCodeInstanceId),
};
assert.equal(workProjectionForAgent(codeAOnlyProjection, { agentInstanceId: secondCodeInstanceId, agentId: 'code_agent' }), null,
  'an instance lookup must never fall back to another real instance in the same Agent family');
assert.equal(workProjectionForNode(codeAOnlyProjection, multiInstanceTask.nodes.find((node) => node.id === 'node-code-b')), null,
  'a bound node must never inherit a sibling instance projection through its Agent family');

const multiInstanceCoordination = normalizeCoordinationSnapshot({
  coordinationState: 'sleeping',
  leader: { agentInstanceId: 'agent-code-a', leadershipLevel: 'L1' },
  participants: [
    { agentInstanceId: 'agent-code-a', agentFamilyId: 'code_agent', name: '代码 Agent A', workState: 'running', availability: 'working', updatedAt },
    { agentInstanceId: 'agent-code-a', agentFamilyId: 'code_agent', name: '恢复会话', recoveryConversationId: 'recovery-code-a', workState: 'running', availability: 'working', updatedAt: '2026-08-04T10:01:00.000Z' },
    { agentInstanceId: secondCodeInstanceId, agentFamilyId: 'code_agent', name: '代码 Agent B', workState: 'queued', availability: 'working', updatedAt },
    { agentInstanceId: 'agent-qa-a', agentFamilyId: 'qa_agent', name: '验证 Agent', workState: 'blocked', availability: 'working', updatedAt },
    { agentInstanceId: 'recovery-only-row', agentFamilyId: 'code_agent', name: '恢复会话', recoveryConversationId: 'recovery-only-row', workState: 'running', availability: 'working', updatedAt },
  ],
  waitingRequirements: [],
  updatedAt: '2026-08-04T10:01:00.000Z',
});
assert.equal(multiInstanceCoordination.participants.length, 3);
Object.assign(state, {
  employeeOverview: { roster: [
    { id: 'agent-code-a', agentFamilyId: 'code_agent', displayName: '代码 Agent A', family: { name: '代码 Agent', departmentId: 'general' } },
    { id: secondCodeInstanceId, agentFamilyId: 'code_agent', displayName: '代码 Agent B', family: { name: '代码 Agent', departmentId: 'general' } },
    { id: 'agent-qa-a', agentFamilyId: 'qa_agent', displayName: '验证 Agent', family: { name: '验证 Agent', departmentId: 'general' } },
  ] },
  taskDetail: { ...multiInstanceTask, agentWorkStatusProjection: defensiveProjection },
  tasks: [{ ...multiInstanceTask, nodeCount: multiInstanceTask.nodes.length, completedNodeCount: 1, agentWorkStatusProjection: defensiveProjection }],
});
const multiCollaborationHtml = renderCollaboration();
const multiKanbanHtml = renderTasks();
const multiParticipantHtml = renderUBuddyCoordinationPanels({
  state,
  taskRunId: multiInstanceTask.id,
  coordination: multiInstanceCoordination,
  task: { ...multiInstanceTask, agentWorkStatusProjection: defensiveProjection },
  nodes: multiInstanceTask.nodes,
});
for (const html of [multiCollaborationHtml, multiKanbanHtml, multiParticipantHtml]) {
  assert.match(html, /代码 Agent #1/);
  assert.match(html, /代码 Agent #2/);
  assert.match(html, /实现统一投影/);
  assert.match(html, /梳理契约/);
  assert.match(html, /独立复核实现/);
  assert.match(html, /未绑定补充节点/);
  assert.doesNotMatch(html, /恢复会话|recovery-code-a/);
}
assert.equal((multiCollaborationHtml.match(/collab-agent-row has-work-projection/g) || []).length, 3,
  'the collaboration Agent list must contain one row per real instance');
assert.equal((multiParticipantHtml.match(/data-agent-work-projection=/g) || []).length, 3,
  'the task progress participant list must exclude uBuddy and dedupe recovery projections');
Object.assign(state, {
  taskDetail: { ...multiInstanceTask, agentWorkStatusProjection: codeAOnlyProjection },
  tasks: [{ ...multiInstanceTask, agentWorkStatusProjection: codeAOnlyProjection }],
});
const missingSiblingProjectionHtml = renderCollaboration();
assert.match(missingSiblingProjectionHtml, /代码 Agent #2/);
assert.equal((missingSiblingProjectionHtml.match(/collab-agent-row has-work-projection/g) || []).length, 2,
  'a missing sibling projection must fall back to its own status row instead of borrowing another same-family instance projection');

const singleInstanceWithUnboundNode = {
  ...multiInstanceTask,
  id: 'task-work-status-single-instance-unbound',
  nodes: [
    { ...multiInstanceTask.nodes.find((node) => node.id === 'node-code'), taskRunId: 'task-work-status-single-instance-unbound' },
    { ...multiInstanceTask.nodes.find((node) => node.id === 'node-code-unbound'), taskRunId: 'task-work-status-single-instance-unbound' },
  ],
};
const singleInstanceProjection = projectTaskAgentWorkStatus(singleInstanceWithUnboundNode, {
  coordination,
  agentName: (agentId) => ({ code_agent: '代码 Agent' })[agentId] || agentId,
});
Object.assign(state, {
  taskDetail: { ...singleInstanceWithUnboundNode, agentWorkStatusProjection: singleInstanceProjection },
  tasks: [{ ...singleInstanceWithUnboundNode, agentWorkStatusProjection: singleInstanceProjection }],
});
const singleInstanceCollaborationHtml = renderCollaboration();
assert.equal((singleInstanceCollaborationHtml.match(/collab-agent-row has-work-projection/g) || []).length, 1,
  'an unbound family node must not create a second participant row beside a real instance');
const singleInstanceParticipantHtml = renderUBuddyCoordinationPanels({
  state,
  taskRunId: singleInstanceWithUnboundNode.id,
  coordination: normalizeCoordinationSnapshot({
    coordinationState: 'sleeping',
    leader: { agentInstanceId: 'agent-code-a', leadershipLevel: 'L1' },
    participants: [{ agentInstanceId: 'agent-code-a', agentFamilyId: 'code_agent', name: '代码 Agent A', workState: 'running', availability: 'working', updatedAt }],
  }),
  task: { ...singleInstanceWithUnboundNode, agentWorkStatusProjection: singleInstanceProjection },
  nodes: singleInstanceWithUnboundNode.nodes,
});
const singleInstanceAllocationHtml = singleInstanceParticipantHtml.match(/<section class="ubuddy-allocation-card[\s\S]*?<\/section>/)?.[0] || '';
assert.match(singleInstanceAllocationHtml, /实现统一投影/);
assert.doesNotMatch(singleInstanceAllocationHtml, /未绑定补充节点/,
  'a node without agentInstanceId must remain unassigned instead of being attributed by family');

state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, agentWorkDetailProjection: false };
assert.doesNotMatch(renderCollaboration(), /data-agent-work-projection=/, 'turning the flag off must restore the legacy task UI');

assert.deepEqual(normalizeAgentWorkStatusProjectionEnvelope(projection), projection);

const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-work-status-projection-'));
let projectionDb = null;
try {
  projectionDb = openDatabase(storeRoot, { skipMigrationBackup: true });
  const store = new Store(projectionDb, { root: storeRoot });
  const storedTask = store.createTaskRun({ title: '批量投影事实', prompt: '验证批量读取', ownerUserId: '' });
  const storedNode = store.createTaskNode({ taskRunId: storedTask.id, title: '批量节点', objective: '读取节点和事件', agentId: 'code_agent' });
  store.updateTaskNode(storedNode.id, { status: 'running' });
  store.recordTaskEvent({
    taskRunId: storedTask.id, taskNodeId: storedNode.id, eventType: 'node_progress', actorId: 'code_agent',
    status: 'running', summary: '正在验证批量事实读取。', payload: { activityType: 'commentary' },
  });
  const facts = store.listTaskRunProjectionFacts({ taskRunIds: [storedTask.id] });
  assert.equal(facts[storedTask.id].nodes.length, 1);
  assert.ok(facts[storedTask.id].events.length >= 2);
  const storedProjection = projectTaskAgentWorkStatus({ ...storedTask, ...facts[storedTask.id] });
  assert.match(storedProjection.actors[0].currentAction, /批量事实读取/);
} finally {
  try { projectionDb?.close(); } catch {}
  await rm(storeRoot, { recursive: true, force: true });
}
console.log('uBuddy Agent work-status projection smoke passed');
