import assert from 'node:assert/strict';

import { renderAgentWorkStatus } from '../src/renderer/app/components/agentWorkStatus.js';
import {
  agentWorkStatusFor,
  applyAgentWorkStatusUpdates,
  applyCoordinationUpdate,
  applyEmployeeWorkStatusSnapshot,
  agentWorkEventMatchesWorkspace,
  normalizeAgentWorkStatus,
  normalizeCoordinationSnapshot,
  shouldApplyAgentTaskProgress,
} from '../src/renderer/app/features/ubuddy/coordinationState.js';
import { state } from '../src/renderer/app/state.js';
import { renderEmployees } from '../src/renderer/app/views/employeesView.js';
import { renderContactsWorkspace } from '../src/renderer/app/views/networkView.js';
import { renderTaskProgressCard } from '../src/renderer/app/views/taskProgressView.js';
import { renderUBuddyCoordinationPanels } from '../src/renderer/app/views/ubuddyCoordinationView.js';

const updatedAt = '2026-07-31T10:00:00.000Z';
const roster = [
  {
    id: 'agent-general-a', agentFamilyId: 'general_agent', displayName: '通用 Agent A', employmentState: 'active', routeEligible: true,
    family: { name: '通用 Agent', departmentId: 'general' }, queueDepth: 0, updatedAt,
  },
  {
    id: 'agent-general-b', agentFamilyId: 'general_agent', displayName: '通用 Agent B', employmentState: 'active', routeEligible: true,
    family: { name: '通用 Agent', departmentId: 'general' }, queueDepth: 0, updatedAt,
  },
  {
    id: 'agent-ppt-a', agentFamilyId: 'ppt', displayName: 'PPT Agent A', employmentState: 'active', routeEligible: true,
    family: { name: 'PPT Agent', departmentId: 'ppt_department' }, queueDepth: 0, updatedAt,
  },
];

Object.assign(state, {
  languageMode: 'zh-CN',
  employeeOverview: { roster, recruitableFamilies: [], capabilities: {}, quota: { limit: 10 } },
  agentWorkStatusByInstanceId: {},
  uBuddyCoordinationByTaskId: {},
  directoryStars: { contacts: {}, employees: [] },
  contactsActivePane: 'employees',
  contactsListRatio: 0.38,
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] }, organizations: [] },
  friendDirectoryCategory: 'all',
  friendDirectoryView: 'contacts',
  friendSearchQuery: '',
  networkContactProfileOpen: false,
  currentUser: { id: 'owner', displayName: 'Owner' },
  org: { departments: [{ id: 'general', name: '通用' }, { id: 'ppt_department', name: 'PPT' }], agents: [], hrs: [] },
  tasks: [],
  taskDetail: null,
  networkDelegationTaskById: {},
});

state.languageMode = 'en';
const englishIdleStatusHtml = renderAgentWorkStatus(normalizeAgentWorkStatus({ agentInstanceId: 'agent-general-a' }));
assert.match(englishIdleStatusHtml, /Idle/);
assert.match(englishIdleStatusHtml, /Ready for a New Task/);
assert.doesNotMatch(englishIdleStatusHtml, /空闲|可开始新的任务/);
const englishWorkingStatusHtml = renderAgentWorkStatus(normalizeAgentWorkStatus({
  agentInstanceId: 'agent-general-a', workState: 'running', updatedAt,
}));
assert.match(englishWorkingStatusHtml, /Working/);
assert.match(englishWorkingStatusHtml, /Running/);
assert.match(englishWorkingStatusHtml, /Updating Task Details/);
assert.doesNotMatch(englishWorkingStatusHtml, /工作中|执行中|任务信息更新中/);
state.languageMode = 'zh-CN';

assert.equal(shouldApplyAgentTaskProgress({
  availability: 'working', taskRunId: 'task-current', currentWork: '当前任务具体动作',
}, 'task-queued'), false, 'a queued task update must not replace the Agent current running task');
assert.equal(shouldApplyAgentTaskProgress({
  availability: 'idle', taskRunId: '', currentWork: '',
}, 'task-queued'), true, 'the next task may be promoted after the Agent becomes idle');
assert.equal(agentWorkEventMatchesWorkspace({ accountWorkspaceId: 'workspace_org_a' }, 'workspace_personal'), false);
assert.equal(agentWorkEventMatchesWorkspace({ accountWorkspaceId: 'workspace_org_a' }, 'workspace_org_a'), true);
assert.equal(agentWorkEventMatchesWorkspace({}, 'workspace_personal'), true, 'legacy unscoped events remain compatible');

state.agentWorkStatusByInstanceId['agent-general-a'] = {
  agentInstanceId: 'agent-general-a', availability: 'working', workState: 'running',
  currentWork: '正在分析仓库结构并定位关键模块', taskRunId: 'task-live-progress',
  updatedAt: '2026-07-31T10:00:01.000Z', statusSource: 'task_progress',
};
applyAgentWorkStatusUpdates(state, [{
  agentInstanceId: 'agent-general-a', availability: 'working', workState: 'running',
  currentWork: { title: '执行任务节点', taskRunId: 'task-live-progress' },
  updatedAt: '2026-07-31T10:00:02.000Z',
}]);
assert.equal(state.agentWorkStatusByInstanceId['agent-general-a'].currentWork, '正在分析仓库结构并定位关键模块',
  'a later availability snapshot for the same task must not erase the specific live action');
applyAgentWorkStatusUpdates(state, [{
  agentInstanceId: 'agent-general-a', availability: 'idle', currentWork: null,
  updatedAt: '2026-07-31T10:00:03.000Z',
}]);
assert.equal(state.agentWorkStatusByInstanceId['agent-general-a'].availability, 'idle',
  'terminal availability must clear task progress');
state.agentWorkStatusByInstanceId['agent-general-a'] = {
  agentInstanceId: 'agent-general-a', availability: 'working', workState: 'running',
  currentWork: '最后一个执行动作', taskRunId: 'task-same-time',
  updatedAt: '2026-07-31T10:00:04.000Z', statusSource: 'task_progress',
};
applyAgentWorkStatusUpdates(state, [{
  agentInstanceId: 'agent-general-a', availability: 'idle', currentWork: null,
  updatedAt: '2026-07-31T10:00:04.000Z',
}]);
assert.equal(state.agentWorkStatusByInstanceId['agent-general-a'].availability, 'idle',
  'an idle snapshot with the same timestamp must clear stale task progress');

for (const workState of ['reserved', 'queued', 'running', 'blocked']) {
  const normalized = normalizeAgentWorkStatus({ agentInstanceId: 'agent-general-a', workState, currentWork: '制作交付物', updatedAt });
  assert.equal(normalized.availability, 'working');
  assert.equal(normalized.workState, workState);
  assert.match(renderAgentWorkStatus(normalized), /工作中/);
}
assert.equal(normalizeAgentWorkStatus({ availability: 'idle', workState: 'blocked' }).availability, 'working');
assert.equal(normalizeAgentWorkStatus({ agentInstanceId: 'agent-general-a' }).availability, 'idle');
assert.match(renderAgentWorkStatus(normalizeAgentWorkStatus({ agentInstanceId: 'agent-general-a' })), /空闲/);

const planningHtml = renderUBuddyCoordinationPanels({
  state,
  taskRunId: 'task-planning',
  coordination: normalizeCoordinationSnapshot({
    coordinationState: 'planning', participants: [], waitingRequirements: [],
    leader: { agentInstanceId: 'agent-general-a', name: '通用 Agent A', leadershipLevel: 'L2' },
    matches: [],
    candidates: [
      { agentId: 'general_agent', agentInstanceId: 'agent-general-a', name: '通用 Agent A', status: 'available', updatedAt },
      { agentId: 'general_agent', agentInstanceId: 'agent-general-a', name: '通用 Agent A', status: 'available', updatedAt },
    ],
  }),
  task: {
    id: 'task-planning', metadata: {},
    nodes: [{ id: 'planned-node', title: '待确认节点', agentInstanceId: 'agent-general-a', status: 'pending' }],
  },
  nodes: [{ id: 'planned-node', title: '待确认节点', agentInstanceId: 'agent-general-a', status: 'pending' }],
});
assert.match(planningHtml, /uBuddy 正在读取员工状态/);
assert.match(planningHtml, /任务分配情况/);
assert.match(planningHtml, /所需能力/);
assert.match(planningHtml, /识别中/);
assert.match(planningHtml, /候选 Agent/);
assert.match(planningHtml, /空闲/);
assert.equal((planningHtml.match(/任务分配情况/g) || []).length, 1);
assert.equal((planningHtml.match(/通用 Agent A/g) || []).length, 1, 'duplicate candidate snapshots must render once');
assert.doesNotMatch(planningHtml, /最终 Agent|负责节点/);
assert.doesNotMatch(planningHtml, /执行详情|节点状态与交付/);

const waitingCoordination = normalizeCoordinationSnapshot({
  coordinationState: 'waiting_for_agents', generation: 1, stateRevision: 1, updatedAt,
  leader: { agentInstanceId: 'agent-ppt-a', name: 'PPT Agent A', leadershipLevel: 'L1' },
  participants: [],
  waitingRequirements: [{ agentFamilyId: 'ppt', label: 'PPT Agent', count: 1 }],
  matches: [{ agentId: 'general_agent', agentInstanceId: 'agent-general-b', name: '通用 Agent B', status: 'available' }],
  candidates: [{ agentId: 'ppt', agentInstanceId: 'agent-ppt-a', name: 'PPT Agent A', status: 'busy', runningWork: '正在制作另一份演示文稿' }],
});
const waitingHtml = renderUBuddyCoordinationPanels({
  state,
  taskRunId: 'task-waiting',
  coordination: waitingCoordination,
  task: { id: 'task-waiting', nodes: [{ id: 'stale-node', title: '尚未派发', agentId: 'ppt', agentInstanceId: 'agent-ppt-a', status: 'pending' }], metadata: {} },
  nodes: [{ id: 'stale-node', title: '尚未派发', agentId: 'ppt', agentInstanceId: 'agent-ppt-a', status: 'pending' }],
});
assert.match(waitingHtml, /正在等待员工空闲/);
assert.match(waitingHtml, /任务分配情况/);
assert.match(waitingHtml, /候选 Agent/);
assert.match(waitingHtml, /PPT Agent/);
assert.match(waitingHtml, /暂不绑定实例/);
assert.match(waitingHtml, /工作中/);
assert.doesNotMatch(waitingHtml, /leader<\/b>/i);
assert.doesNotMatch(waitingHtml, /匹配员工状态|最终分配结果/);
assert.equal((waitingHtml.match(/任务分配情况/g) || []).length, 1);
assert.doesNotMatch(waitingHtml, /最终 Agent|负责节点/);
assert.doesNotMatch(waitingHtml, /执行详情|节点状态与交付/);

const legacyWaitingHtml = renderUBuddyCoordinationPanels({
  state,
  taskRunId: 'task-legacy-waiting',
  coordination: {
    coordination_state: 'waiting_for_agents',
    leader: {},
    waiting_requirements: [{ agent_family_id: 'ppt', label: '旧版 PPT 能力', required_count: 1 }],
    candidates: [{
      agent_family_id: 'ppt', agent_instance_id: 'agent-ppt-a', name: 'PPT Agent A',
      status: 'busy', running_work: '处理旧版候选任务',
    }],
  },
  task: { id: 'task-legacy-waiting', nodes: [], metadata: {} },
});
assert.match(legacyWaitingHtml, /正在等待员工空闲/);
assert.match(legacyWaitingHtml, /旧版 PPT 能力/);
assert.match(legacyWaitingHtml, /PPT Agent A/);
assert.match(legacyWaitingHtml, /工作中/);

const sleepingCoordination = normalizeCoordinationSnapshot({
  coordinationState: 'sleeping', generation: 2, stateRevision: 3, updatedAt,
  leader: { agentInstanceId: 'agent-general-a', name: '通用 Agent A', leadershipLevel: 'L2' },
  participants: [
    { agentInstanceId: 'agent-general-a', name: '通用 Agent A', availability: 'working', workState: 'running', currentWork: '统筹内容与验收', updatedAt },
    { agentInstanceId: 'agent-ppt-a', name: 'PPT Agent A', availability: 'working', workState: 'queued', currentWork: '等待生成演示文稿', updatedAt },
  ],
  waitingRequirements: [],
});
const task = {
  id: 'task-sleeping', status: 'running', leadAgentInstanceId: 'agent-general-a', updatedAt,
  metadata: { leadershipLevelSnapshot: 'L2', candidateSnapshots: [] },
  nodes: [
    { id: 'node-1', title: '统筹内容', agentId: 'general_agent', agentInstanceId: 'agent-general-a', status: 'running', attemptCount: 1, maxAttempts: 3 },
    { id: 'node-1b', title: '审核交付', agentId: 'general_agent', agentInstanceId: 'agent-general-a', status: 'queued', attemptCount: 0, maxAttempts: 1 },
    { id: 'node-2', title: '生成演示文稿', agentId: 'ppt', agentInstanceId: 'agent-ppt-a', status: 'retry_wait', attemptCount: 2, maxAttempts: 3, nextRetryAt: '2026-07-31T10:05:00.000Z' },
  ],
};
state.tasks = [task];
state.uBuddyCoordinationByTaskId['task-sleeping'] = sleepingCoordination;
for (const participant of sleepingCoordination.participants) state.agentWorkStatusByInstanceId[participant.agentInstanceId] = participant;

const sleepingHtml = renderTaskProgressCard({
  taskRunId: task.id, taskStatus: 'running', phase: 'executing', progress: { total: 3, running: 1, queued: 1, waiting: 1 },
  nodes: task.nodes, blocker: { summary: '等待自动重试', errorCode: 'network_transient', attemptCount: 2, maxAttempts: 3, nextRetryAt: '2026-07-31T10:05:00.000Z' },
});
assert.match(sleepingHtml, /任务分配情况/);
assert.match(sleepingHtml, /最终 Agent/);
assert.match(sleepingHtml, /通用 Agent A/);
assert.match(sleepingHtml, /统筹内容/);
assert.match(sleepingHtml, /审核交付/);
assert.match(sleepingHtml, /生成演示文稿/);
assert.match(sleepingHtml, /L2/);
assert.match(sleepingHtml, /uBuddy sleeping/);
assert.match(sleepingHtml, /下次自动重试/);
assert.match(sleepingHtml, /2\/3 次/);
assert.doesNotMatch(sleepingHtml, /所需能力|候选 Agent|等待员工空闲|匹配员工状态|最终分配结果/);
assert.doesNotMatch(sleepingHtml, /任务团队|参与 Agent 当前状态/);
const allocationHtml = sleepingHtml.match(/<section class="ubuddy-allocation-card[\s\S]*?<\/section>/)?.[0] || '';
assert.equal((sleepingHtml.match(/任务分配情况/g) || []).length, 1);
assert.equal((allocationHtml.match(/通用 Agent A/g) || []).length, 1);
assert.equal((sleepingHtml.match(/通用 Agent A/g) || []).length, 1, 'default task card must not repeat assigned Agent details');

const assignedPendingHtml = renderUBuddyCoordinationPanels({
  state,
  taskRunId: 'task-assignment-pending',
  coordination: normalizeCoordinationSnapshot({ coordinationState: 'sleeping', participants: [], waitingRequirements: [] }),
  task: { id: 'task-assignment-pending', nodes: [], metadata: {} },
});
assert.match(assignedPendingHtml, /最终 Agent/);
assert.match(assignedPendingHtml, /最终分配信息更新中/);
assert.doesNotMatch(assignedPendingHtml, /所需能力|候选 Agent/);

const cancelledBeforeAssignmentHtml = renderUBuddyCoordinationPanels({
  state,
  taskRunId: 'task-cancelled-before-assignment',
  coordination: { coordinationState: 'cancelled', participants: [], waitingRequirements: [] },
  task: { id: 'task-cancelled-before-assignment', status: 'cancelled', nodes: [], metadata: {} },
});
assert.match(cancelledBeforeAssignmentHtml, /分配结果/);
assert.match(cancelledBeforeAssignmentHtml, /任务已取消，未产生最终分配/);
assert.doesNotMatch(cancelledBeforeAssignmentHtml, /最终 Agent|最终分配信息更新中|所需能力|候选 Agent/);

const duplicateInstanceCoordination = normalizeCoordinationSnapshot({
  coordinationState: 'sleeping', generation: 3, stateRevision: 1, updatedAt: '2026-07-31T10:02:00.000Z',
  leader: { agentInstanceId: 'agent-general-a', name: '通用 Agent A', leadershipLevel: 'L2' },
  participants: [
    { agentInstanceId: 'agent-general-a', agentFamilyId: 'general_agent', name: '通用 Agent A', availability: 'working', workState: 'running', currentWork: '统筹初始节点', updatedAt },
    { agentInstanceId: 'agent-general-a', agentFamilyId: 'general_agent', name: '恢复会话', recoveryConversationId: 'recovery-agent-general-a', availability: 'working', workState: 'running', currentWork: '恢复后继续统筹', updatedAt: '2026-07-31T10:01:00.000Z' },
    { agentInstanceId: 'agent-general-b', agentFamilyId: 'general_agent', name: '通用 Agent B', availability: 'working', workState: 'queued', currentWork: '等待复核', updatedAt },
  ],
});
assert.equal(duplicateInstanceCoordination.participants.length, 2, 'recovery conversation records must collapse into the real Agent instance');
assert.equal(duplicateInstanceCoordination.participants.find((item) => item.agentInstanceId === 'agent-general-a')?.currentWork, '恢复后继续统筹');
const duplicateInstanceTask = {
  ...task,
  id: 'task-instance-dedupe',
  nodes: [
    { id: 'node-a-1', title: '整理资料', agentId: 'general_agent', agentInstanceId: 'agent-general-a', status: 'running' },
    { id: 'node-a-2', title: '汇总结论', agentId: 'general_agent', agentInstanceId: 'agent-general-a', status: 'queued' },
    { id: 'node-b-1', title: '独立复核', agentId: 'general_agent', agentInstanceId: 'agent-general-b', status: 'queued' },
  ],
};
const duplicateInstanceHtml = renderUBuddyCoordinationPanels({
  state,
  taskRunId: duplicateInstanceTask.id,
  coordination: duplicateInstanceCoordination,
  task: duplicateInstanceTask,
  nodes: duplicateInstanceTask.nodes,
});
const duplicateAllocationHtml = duplicateInstanceHtml.match(/<section class="ubuddy-allocation-card[\s\S]*?<\/section>/)?.[0] || '';
assert.equal((duplicateAllocationHtml.match(/通用 Agent #1/g) || []).length, 1);
assert.equal((duplicateAllocationHtml.match(/通用 Agent #2/g) || []).length, 1);
assert.doesNotMatch(duplicateAllocationHtml, /恢复会话|recovery-agent-general-a/);
assert.match(duplicateAllocationHtml, /整理资料/);
assert.match(duplicateAllocationHtml, /汇总结论/);
assert.match(duplicateAllocationHtml, /独立复核/);
const workingEmployeesHtml = renderEmployees();
assert.match(workingEmployeesHtml, /工作中/);
assert.match(workingEmployeesHtml, /执行中/);
assert.match(workingEmployeesHtml, /统筹内容与验收/);
const workingContactsHtml = renderContactsWorkspace();
assert.match(workingContactsHtml, /工作中/);
assert.match(workingContactsHtml, /执行中/);
assert.match(workingContactsHtml, /统筹内容与验收/);

const staleParticipant = normalizeAgentWorkStatus({
  agentInstanceId: 'agent-general-a', availability: 'idle', currentWork: '', updatedAt,
});
const synchronizedState = {
  ...state,
  agentWorkStatusByInstanceId: {
    ...state.agentWorkStatusByInstanceId,
    'agent-general-a': normalizeAgentWorkStatus({
      agentInstanceId: 'agent-general-a', availability: 'working', workState: 'running',
      currentWork: '执行他人 uBuddy 安排的任务', updatedAt: '2026-07-31T10:03:00.000Z',
    }),
  },
  uBuddyCoordinationByTaskId: { ...state.uBuddyCoordinationByTaskId },
};
assert.equal(agentWorkStatusFor(synchronizedState, roster[0], staleParticipant).availability, 'working',
  'a stale task participant snapshot must not override newer global Agent availability');
const synchronizedStatusHtml = renderUBuddyCoordinationPanels({
  state: synchronizedState,
  taskRunId: 'task-stale-participant',
  coordination: normalizeCoordinationSnapshot({
    coordinationState: 'sleeping', updatedAt,
    leader: { agentInstanceId: 'agent-general-a', name: '通用 Agent A', leadershipLevel: 'L2' },
    participants: [staleParticipant],
  }),
  task: {
    id: 'task-stale-participant', status: 'running', leadAgentInstanceId: 'agent-general-a',
    nodes: [{ id: 'stale-participant-node', title: '执行委托任务', agentId: 'general_agent', agentInstanceId: 'agent-general-a', status: 'running' }],
    metadata: {},
  },
});
assert.match(synchronizedStatusHtml, /工作中/);
assert.doesNotMatch(synchronizedStatusHtml, /空闲/);

applyCoordinationUpdate(synchronizedState, {
  taskRunId: 'task-older-status-update',
  coordination: {
    coordinationState: 'sleeping', stateRevision: 1, updatedAt,
    participants: [staleParticipant],
  },
}, { id: 'task-older-status-update', updatedAt });
assert.equal(synchronizedState.agentWorkStatusByInstanceId['agent-general-a'].availability, 'working',
  'an older coordination update must not replace newer global Agent availability');

applyAgentWorkStatusUpdates(synchronizedState, [{
  agentInstanceId: 'agent-general-a', availability: 'idle', workState: '', currentWork: '',
  updatedAt: '2026-07-31T10:04:00.000Z',
}]);
assert.equal(agentWorkStatusFor(synchronizedState, roster[0], staleParticipant).availability, 'idle',
  'an authoritative idle event must override a stale working coordination snapshot');
applyCoordinationUpdate(synchronizedState, {
  taskRunId: 'task-newer-coordination-still-stale',
  coordination: {
    coordinationState: 'sleeping', stateRevision: 2, updatedAt: '2026-07-31T10:04:00.000Z',
    participants: [{
      agentInstanceId: 'agent-general-a', availability: 'working', workState: 'running',
      currentWork: '已经结束的任务', updatedAt: '2026-07-31T10:04:00.000Z',
    }],
  },
}, { id: 'task-newer-coordination-still-stale', updatedAt: '2026-07-31T10:04:00.000Z' });
assert.equal(agentWorkStatusFor(synchronizedState, roster[0], {
  agentInstanceId: 'agent-general-a', availability: 'working', workState: 'running',
  updatedAt: '2026-07-31T10:04:00.000Z',
}).availability, 'idle', 'a same-version task snapshot must not undo authoritative idle availability');

applyEmployeeWorkStatusSnapshot(synchronizedState, [{
  ...roster[0], availability: 'working', workState: 'queued', currentWork: '刷新后发现的新任务',
  updatedAt: '2026-07-31T10:06:00.000Z',
}]);
assert.equal(agentWorkStatusFor(synchronizedState, roster[0]).workState, 'queued',
  'an employee refresh must update the same renderer status cache used by all Agent surfaces');
applyAgentWorkStatusUpdates(synchronizedState, [{
  agentInstanceId: 'agent-general-a', availability: 'idle', workState: '', currentWork: '',
}]);
assert.equal(agentWorkStatusFor(synchronizedState, roster[0]).availability, 'idle',
  'a legacy authoritative availability event without updatedAt must still replace cached status');

const awakened = {
  ...sleepingCoordination,
  coordinationState: 'awakened', generation: 2, stateRevision: 4,
  wakeReason: { code: 'recovery_exhausted', summary: '网络连接重试耗尽' },
  failureReport: {
    errorCode: 'network_transient', summary: 'socket connection closed', cause: 'connection closed',
    attemptCount: 3, maxAttempts: 3, attemptedActions: ['自动重试 3 次'], suggestedNextStep: '检查网络后继续。',
  },
};
const awakenedHtml = renderUBuddyCoordinationPanels({ state, taskRunId: task.id, coordination: awakened, task, nodes: task.nodes });
assert.match(awakenedHtml, /自动恢复和重试已耗尽/);
assert.match(awakenedHtml, /结构化失败报告/);
assert.match(awakenedHtml, /网络连接暂时异常，系统已完成自动重试/);
assert.match(awakenedHtml, /自动重试 3 次/);
assert.doesNotMatch(awakenedHtml, /派发草稿|阶段草稿|计划模式/);

const firstApply = applyCoordinationUpdate(state, { taskRunId: task.id, coordination: awakened }, task);
assert.equal(firstApply.applied, true);
assert.deepEqual(new Set(firstApply.agentInstanceIds), new Set(['agent-general-a', 'agent-ppt-a']));
const duplicateApply = applyCoordinationUpdate(state, { taskRunId: task.id, coordination: awakened }, task);
assert.equal(duplicateApply.duplicate, true);
const staleApply = applyCoordinationUpdate(state, {
  taskRunId: task.id,
  coordination: { ...awakened, stateRevision: 2, coordinationState: 'planning' },
}, task);
assert.equal(staleApply.stale, true);
assert.equal(state.uBuddyCoordinationByTaskId[task.id].coordinationState, 'awakened');
const pptStatusBeforeSingleUpdate = state.agentWorkStatusByInstanceId['agent-ppt-a'];
const singleAgentUpdate = applyCoordinationUpdate(state, {
  taskRunId: task.id,
  coordination: {
    ...awakened,
    stateRevision: 5,
    participants: [{ agentInstanceId: 'agent-general-a', name: '通用 Agent A', availability: 'idle', currentWork: '', updatedAt }],
    wakeReason: { code: 'completion', summary: '团队任务已完成' },
    failureReport: null,
  },
}, task);
assert.equal(singleAgentUpdate.applied, true);
assert.equal(state.agentWorkStatusByInstanceId['agent-general-a'].availability, 'idle');
assert.equal(state.agentWorkStatusByInstanceId['agent-ppt-a'], pptStatusBeforeSingleUpdate);
const completionHtml = renderUBuddyCoordinationPanels({
  state, taskRunId: task.id, coordination: state.uBuddyCoordinationByTaskId[task.id], task, nodes: task.nodes,
});
assert.match(completionHtml, /团队任务已完成/);
const deliveredCoordination = normalizeCoordinationSnapshot({
  ...state.uBuddyCoordinationByTaskId[task.id], coordinationState: 'completed', stateRevision: 6,
});
assert.equal(deliveredCoordination.coordinationState, 'completed');
const deliveredHtml = renderUBuddyCoordinationPanels({
  state, taskRunId: task.id, coordination: deliveredCoordination, task: { ...task, status: 'completed' }, nodes: task.nodes,
});
assert.match(deliveredHtml, /任务结果已交付/);
assert.match(deliveredHtml, /已交付/);

const externalDeliveryTask = {
  ...task,
  id: 'external-delivery-task',
  status: 'completed',
  deliveryReview: { state: 'accepted', selectedSubmissionId: 'external-submission', summary: '交付内容通过内部验收。' },
  deliverySubmissions: [{ id: 'external-submission', submissionNo: 1, bodySnapshot: '外部委托结果。', artifactManifest: [], createdAt: updatedAt }],
  metadata: {
    ...(task.metadata || {}),
    taskOrigin: 'external_delegation', delegationId: 'external-delegation-status',
    selectedDeliverySubmissionId: 'external-submission',
    finalDelivery: { state: 'delivered', deliveredAt: updatedAt, updatedAt },
  },
};
state.agentDelegations = [{ id: 'external-delegation-status', status: 'submitted' }];
const externalSubmittedDeliveryHtml = renderUBuddyCoordinationPanels({
  state, taskRunId: externalDeliveryTask.id, coordination: deliveredCoordination, task: externalDeliveryTask, nodes: task.nodes,
});
assert.match(externalSubmittedDeliveryHtml, /已交付 · 等待发出方验收/);
assert.doesNotMatch(externalSubmittedDeliveryHtml, /去委托任务确认交付/);
state.agentDelegations = [{ id: 'external-delegation-status', status: 'result_accepted' }];
const externalAcceptedDeliveryHtml = renderUBuddyCoordinationPanels({
  state, taskRunId: externalDeliveryTask.id, coordination: deliveredCoordination, task: externalDeliveryTask, nodes: task.nodes,
});
assert.match(externalAcceptedDeliveryHtml, /发出方已确认任务结束/);
assert.doesNotMatch(externalAcceptedDeliveryHtml, /去委托任务确认交付/);
state.agentDelegations = [];

const generalStatus = agentWorkStatusFor(state, roster[0]);
assert.equal(generalStatus.availability, 'idle');
const employeesHtml = renderEmployees();
assert.match(employeesHtml, /data-agent-work-status="agent-general-a"/);
assert.match(employeesHtml, /空闲/);
const contactsHtml = renderContactsWorkspace();
assert.match(contactsHtml, /data-agent-work-status="agent-general-a"/);
assert.match(contactsHtml, /空闲/);

console.log('renderer uBuddy work status smoke passed');
