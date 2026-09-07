import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createChatRunController } from '../src/renderer/app/features/chat/chatRunController.js';
import { applyDelegationNoticeUpsert, applyDelegationTaskUpdate } from '../src/renderer/app/features/network/delegationProgressState.js';
import { createNetworkWorkspaceController } from '../src/renderer/app/features/network/workspaceController.js';
import { createSessionNavigationController, mergeEmployeeConversationOverview } from '../src/renderer/app/features/navigation/sessionNavigationController.js';
import { buildPublicTaskProgressSnapshot } from '../src/main/modules/orchestration/domain/taskExecutionMetrics.js';
import { createUBuddyTaskPublishProcessTracker } from '../src/main/runtime.js';
import { state } from '../src/renderer/app/state.js';
import { renderChat, renderMessageList, renderUBuddyCenterDrawer, renderUBuddyTaskDrawer, renderUBuddyTaskStrip } from '../src/renderer/app/views/chatView.js';
import { renderCollaboration, renderTasks } from '../src/renderer/app/views/collaborationView.js';
import { renderNetworkPanel } from '../src/renderer/app/views/networkView.js';
import { renderTopbar } from '../src/renderer/app/views/navigationView.js';
import { renderTaskProgressCard } from '../src/renderer/app/views/taskProgressView.js';
import { hydrateUBuddyTaskViews, uBuddyPendingTaskCount, uBuddyTaskDisplayStatus } from '../src/renderer/app/features/ubuddy/taskDisplayState.js';
import { normalizeDelegationExecutionProgress, publicDelegationMetadata } from '../src/shared/contracts/delegation.js';
import { deriveTaskLifecycleProgress } from '../src/shared/contracts/uBuddyDeliveryReview.js';
import { mergeTaskWorkspaceMessages, mergeTaskWorkspaceSnapshot } from '../src/renderer/app/utils/taskWorkspaceMerge.js';
import { formatChatCardMessageTime } from '../src/renderer/app/utils/format.js';

const darkThemeFixes = readFileSync(new URL('../src/renderer/app/core/dark-theme-fixes.css', import.meta.url), 'utf8');

let publishProcessClock = 1_000;
const emittedPublishEvents = [];
const publishProcess = createUBuddyTaskPublishProcessTracker({
  enabled: true,
  now: () => publishProcessClock,
  onEvent: (event) => emittedPublishEvents.push(event),
});
publishProcess.start('intake', '确认任务信息', '正在整理任务目标、交付物、验收标准和约束。');
publishProcessClock += 500;
publishProcess.complete('intake', '已识别 1 项交付要求，并整理验收标准与执行约束。');
publishProcess.start('readiness', '检查派发条件', '正在独立检查关键输入、权限、风险和交付范围。');
publishProcessClock += 700;
publishProcess.complete('readiness', '派发条件检查通过，没有未解决的关键问题。');
publishProcess.start('planning', '规划任务与选择 Agent', '正在设计执行节点、依赖关系和交付路径。');
publishProcessClock += 900;
publishProcess.complete('planning', '已规划 1 个执行节点，由通用 Agent 承担。');
publishProcess.start('dispatching', '创建任务并安排执行', '正在保存任务图并为执行节点绑定可用 Agent。');
publishProcessClock += 1_100;
publishProcess.complete('dispatching', '任务图已创建并保存，通用 Agent 已接管执行。');
const completedPublishMetadata = publishProcess.messageMetadata('completed', { expanded: false });
assert.equal(completedPublishMetadata.uBuddyTaskPublishProcess.version, 'ubuddy_task_publish_process_v1');
assert.equal(completedPublishMetadata.uBuddyTaskPublishProcess.status, 'completed');
assert.equal(completedPublishMetadata.uBuddyTaskPublishProcess.durationMs, 3_200);
assert.equal(completedPublishMetadata.expanded, false);
assert.deepEqual(completedPublishMetadata.uBuddyTaskPublishProcess.events.map((event) => event.status), [
  'completed', 'completed', 'completed', 'completed',
]);
assert.equal(emittedPublishEvents.length, 8, 'each publish stage should emit one running and one settled update');
assert.doesNotMatch(JSON.stringify(completedPublishMetadata), /reasoningText|rawAnswer|prompt|workspaceRoot/i,
  'persisted publish progress must contain stage summaries only');

const waitingPublishProcess = createUBuddyTaskPublishProcessTracker({ enabled: true, now: () => publishProcessClock });
waitingPublishProcess.start('readiness', '检查派发条件', '正在检查派发条件。');
publishProcessClock += 250;
waitingPublishProcess.wait('readiness', '发现 1 项需要补充的关键信息。');
const waitingPublishMetadata = waitingPublishProcess.messageMetadata('waiting');
assert.equal(waitingPublishMetadata.expanded, true);
assert.equal(waitingPublishMetadata.uBuddyTaskPublishProcess.events[0].status, 'waiting');

const failedPublishProcess = createUBuddyTaskPublishProcessTracker({ enabled: true, now: () => publishProcessClock });
failedPublishProcess.start('planning', '规划任务与选择 Agent', '正在规划任务。');
publishProcessClock += 250;
failedPublishProcess.fail(undefined, '任务规划失败，未创建任务。');
const failedPublishMetadata = failedPublishProcess.messageMetadata('failed');
assert.equal(failedPublishMetadata.expanded, true);
assert.equal(failedPublishMetadata.uBuddyTaskPublishProcess.events[0].status, 'failed');

const cancelledPublishProcess = createUBuddyTaskPublishProcessTracker({ enabled: true, now: () => publishProcessClock });
cancelledPublishProcess.start('dispatching', '创建任务并安排执行', '正在创建任务。');
publishProcessClock += 250;
cancelledPublishProcess.cancel();
const cancelledPublishMetadata = cancelledPublishProcess.messageMetadata('cancelled');
assert.equal(cancelledPublishMetadata.expanded, true);
assert.equal(cancelledPublishMetadata.uBuddyTaskPublishProcess.events[0].status, 'cancelled');

const disabledPublishProcess = createUBuddyTaskPublishProcessTracker({ enabled: false, now: () => publishProcessClock });
disabledPublishProcess.start('intake', '确认任务信息', '不应显示。');
assert.deepEqual(disabledPublishProcess.messageMetadata('completed'), {});

const confirmationPublishProcess = createUBuddyTaskPublishProcessTracker({ enabled: true, now: () => publishProcessClock });
confirmationPublishProcess.start('planning', '规划任务与选择参与人', '正在规划多人分工。');
publishProcessClock += 250;
confirmationPublishProcess.complete('planning', '多人分工已经就绪。');
confirmationPublishProcess.start('dispatching', '确认后派发任务', '正在等待确认。');
publishProcessClock += 250;
confirmationPublishProcess.wait('dispatching', '方案尚未派发。');
const confirmationWaitingMetadata = confirmationPublishProcess.messageMetadata('waiting');
const resumedPublishEvents = [];
publishProcessClock += 1_000;
const resumedPublishProcess = createUBuddyTaskPublishProcessTracker({
  enabled: true,
  now: () => publishProcessClock,
  onEvent: (event) => resumedPublishEvents.push(event),
});
assert.equal(resumedPublishProcess.restore(confirmationWaitingMetadata.uBuddyTaskPublishProcess), true);
resumedPublishProcess.start('dispatching', '创建任务并安排执行', '确认已收到，正在派发。');
publishProcessClock += 500;
resumedPublishProcess.complete('dispatching', '多人任务已经发布。');
const resumedPublishMetadata = resumedPublishProcess.messageMetadata('completed');
assert.deepEqual(resumedPublishMetadata.uBuddyTaskPublishProcess.events.map((event) => event.status), ['completed', 'completed']);
assert.equal(resumedPublishMetadata.uBuddyTaskPublishProcess.events.filter((event) => event.activityId === 'ubuddy-task-publish:dispatching').length, 1,
  'resuming a confirmed proposal must update the waiting dispatch stage in place');
assert.equal(resumedPublishEvents.length, 2, 'resuming should emit only the new running and completed dispatch updates');
assert.equal(resumedPublishProcess.restore({ version: 'unknown', events: [] }), false);

const cardTimeNow = new Date('2026-08-14T12:30:00');
assert.equal(formatChatCardMessageTime('2026-08-14T08:05:00', { now: cardTimeNow }), '08:05');
assert.equal(formatChatCardMessageTime('2026-08-13T16:03:00', { now: cardTimeNow }), '昨天 16:03');
assert.equal(formatChatCardMessageTime('2026-08-10T09:20:00', { now: cardTimeNow }), '周一 09:20');
assert.equal(formatChatCardMessageTime('2026-08-07T09:20:00', { now: cardTimeNow }), '2026年08月07日 09:20');
assert.equal(formatChatCardMessageTime('2026-08-13T16:03:00', { now: cardTimeNow, languageMode: 'en' }), 'Yesterday 16:03');
for (const selector of [
  '.shell.theme-dark .local-task-active-nodes span',
  '.shell.theme-dark .network-task-result-view',
  '.shell.theme-dark .network-task-flow-columns article',
  '.shell.theme-dark .local-task-technical-details',
  '.shell.theme-dark .ubuddy-task-permission-badge',
  '.shell.theme-dark .ubuddy-task-strip-row footer button',
  '.shell.theme-dark .ubuddy-delivery-versions article pre',
]) assert.ok(darkThemeFixes.includes(selector), `missing dark-mode coverage for ${selector}`);

const retainedEmployeeOverview = mergeEmployeeConversationOverview({
  activeWork: { route: 'task_run', taskRunId: 'running-task', status: 'running', currentAction: '正在生成内容' },
  historyGroups: [{ id: 'history-one' }],
}, {
  activeWork: { route: 'none', sessionId: '', taskRunId: '' }, historyGroups: [], historySessions: [],
}, { availability: 'working', workState: 'running' });
assert.equal(retainedEmployeeOverview.activeWork.taskRunId, 'running-task', 'a transient empty overview must not erase a running Agent card');
assert.equal(retainedEmployeeOverview.historyGroups[0].id, 'history-one');
assert.equal(mergeEmployeeConversationOverview(retainedEmployeeOverview, {
  activeWork: { route: 'none', sessionId: '', taskRunId: '' },
}, { availability: 'idle', workState: '' }).activeWork.route, 'none', 'an idle status must allow a completed Agent card to clear');

const detailedWorkspaceTask = {
  id: 'workspace-task', title: '完整任务', status: 'running', metadata: { source: 'ubuddy_dispatch', detail: true },
  nodes: [{ id: 'node-one', status: 'running' }],
  events: [{ id: 'event-one', eventType: 'node_progress', summary: '正在生成内容' }],
  communications: [{ id: 'comm-one', status: 'open' }],
};
const mergedWorkspaceTask = mergeTaskWorkspaceSnapshot(detailedWorkspaceTask, {
  id: 'workspace-task', title: '摘要刷新', status: 'running', metadata: {}, nodes: [], events: [], communications: [],
});
assert.equal(mergedWorkspaceTask.title, '摘要刷新');
assert.equal(mergedWorkspaceTask.nodes[0].id, 'node-one');
assert.equal(mergedWorkspaceTask.events[0].id, 'event-one');
assert.equal(mergedWorkspaceTask.communications[0].id, 'comm-one');
assert.equal(mergedWorkspaceTask.metadata.detail, true);
const partialWorkspaceTask = mergeTaskWorkspaceSnapshot({
  id: 'workspace-task',
  events: [
    { id: 'event-one', createdAt: '2026-08-01T00:00:01.000Z', summary: '保留较早事件' },
    { id: 'event-two', createdAt: '2026-08-01T00:00:02.000Z', summary: '更新前' },
  ],
}, {
  id: 'workspace-task', eventHistoryPartial: true, eventCount: 3,
  events: [
    { id: 'event-two', createdAt: '2026-08-01T00:00:02.000Z', summary: '更新后' },
    { id: 'event-three', createdAt: '2026-08-01T00:00:03.000Z', summary: '新增事件' },
  ],
});
assert.deepEqual(partialWorkspaceTask.events.map((event) => event.id), ['event-one', 'event-two', 'event-three'],
  'bounded live snapshots must not truncate the task workspace and collapse its scroll range');
assert.equal(partialWorkspaceTask.events[1].summary, '更新后');
assert.deepEqual(mergeTaskWorkspaceMessages([{ id: 'visible-message', content: '保留的中间过程' }], []), [
  { id: 'visible-message', content: '保留的中间过程' },
]);

const run = {
  channelId: 'ubuddy-progress-channel', chatKey: 'new:ubuddy', sessionId: '', departmentId: 'secretary_department',
  agentId: 'secretary_agent', targetKind: 'collaboration', assistantContent: '', draftContent: '', processEvents: [],
  startedAt: Date.now(), lastStatusStage: 'queued', lastStatusText: '', progressMilestones: [], terminal: false,
};
let submittedClarificationAnswer = '';
let submittedClarificationContext = null;
let contactPickerOpened = false;
const openedFiles = [];
const savedFiles = [];
state.currentTab = 'chat';
state.currentSessionId = '';
state.currentChatKey = run.chatKey;
state.messages = [];
state.sessions = [];
state.org = { departments: [], agents: [{ id: 'code_agent', name: '代码 Agent' }], hrs: [] };
state.activeChatRun = run;
state.chatRuns = [run];

const controller = createChatRunController({
  api: {}, windowRef: { confirm: () => true }, documentRef: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  state, render: () => {}, notify: () => {}, userVisibleErrorMessage: (value) => String(value || ''),
  chatRunForChannel: (channelId) => state.chatRuns.find((item) => item.channelId === channelId) || null,
  syncCurrentChatRun: () => { state.activeChatRun = run; }, upsertRecentSession: () => {}, expandProject: () => {},
  agentNameById: (id) => id === 'code_agent' ? '代码 Agent' : id, departmentName: (id) => id,
  allChatRuns: () => state.chatRuns, currentChatRun: () => state.activeChatRun, captureMessageScrollState: () => null,
  restoreMessageScrollState: () => {}, renderMessageList,
  parsePreviewPayload: (value) => JSON.parse(decodeURIComponent(value)), previewFileInfo: async () => {},
  saveFileFromPayload: async (file) => { savedFiles.push(file); }, showFileFromPayload: async () => {},
  openFileFromPayload: async (file) => { openedFiles.push(file); },
  openCollaborationTask: async () => {}, copyMessageText: async () => {}, editMessageFromHistory: () => {}, pathBasename: (value) => value,
  submitUBuddyClarificationAnswer: async (answer, context = {}) => {
    submittedClarificationAnswer = answer;
    submittedClarificationContext = context;
    return true;
  },
  openUBuddyContactPicker: () => { contactPickerOpened = true; },
  projectForSession: () => null, activeProject: () => null, scrollMessagesToBottom: () => {}, imageModelOptions: [],
  runStatusRefreshMs: 1000, runUpdateThrottleMs: 80, setTimer: () => 1, setRepeatingTimer: () => 1, clearRepeatingTimer: () => {},
});

state.activeTaskWorkspaceKind = 'task_run';
state.activeTaskWorkspaceId = 'stale-task-workspace';
assert.equal(controller.isRunForCurrentChat(run), false,
  'a real task workspace must keep the private uBuddy run out of that surface');
state.activeTaskWorkspaceKind = '';
state.activeTaskWorkspaceId = '';
assert.equal(controller.isRunForCurrentChat(run), true,
  'after leaving the task workspace, the active uBuddy run must become visible again');

controller.handleChatRunEvent(run.channelId, {
  kind: 'start', targetKind: 'secretary', departmentId: 'secretary_department', agentId: 'secretary_agent',
});
assert.match(renderMessageList(), /uBuddy 正在理解任务/);
controller.handleChatRunEvent(run.channelId, {
  kind: 'plan', plan: { mode: 'task', steps: [] }, targetKind: 'secretary', departmentId: 'secretary_department',
});
assert.ok(run.statusMessageId, 'a plan event must retain the active run status identity');
assert.match(renderMessageList(), /uBuddy 正在规划执行步骤/);

state.messages = [{ id: 'persisted-user', role: 'user', content: '修改 uBuddy 实时进度展示。', metadata: {} }];
assert.doesNotMatch(renderMessageList(), /uBuddy 正在规划执行步骤/);
controller.restoreActiveRunTransient();
assert.match(renderMessageList(), /uBuddy 正在规划执行步骤/,
  'an active uBuddy status must be restored immediately after persisted messages replace renderer state');
controller.handleChatRunEvent(run.channelId, {
  kind: 'activity', activityId: 'ubuddy-task-publish:intake', activityType: 'status', eventOrigin: 'janus',
  status: 'running', title: '确认任务信息', detail: '正在整理任务目标、交付物、验收标准和约束。',
});
const livePublishMarkup = renderMessageList();
assert.match(livePublishMarkup, /确认任务信息/);
assert.match(livePublishMarkup, /正在整理任务目标、交付物、验收标准和约束/);
assert.equal(run.processEvents.filter((event) => event.activityId === 'ubuddy-task-publish:intake').length, 1,
  'live publish stage updates must reuse the existing process event identity');

controller.handleChatRunEvent(run.channelId, {
  kind: 'progress', stage: 'confirming', taskType: 'code_change',
  objective: { summary: '修改 uBuddy 实时进度展示。', deliverables: ['完成代码修改', '运行相关测试'] },
  message: '任务目标已确认：代码修改。',
});
controller.handleChatRunEvent(run.channelId, {
  kind: 'task-progress', stage: 'executing', phase: 'executing', taskRunId: 'task-progress-smoke', taskStatus: 'running',
  taskProgress: { total: 2, completed: 0, running: 1, queued: 1, waiting: 0, failed: 0, percent: 0 },
  activeNodes: [{ id: 'node-code', title: '修改 renderer', agentId: 'code_agent', status: 'running' }],
  changedNodes: [{ id: 'node-code', title: '修改 renderer', agentId: 'code_agent', status: 'running', summary: '正在执行节点任务。' }],
  message: '修改 renderer：执行中；总体 0/2。',
});
controller.handleChatRunEvent(run.channelId, {
  kind: 'task-progress', stage: 'verifying', phase: 'verifying', taskRunId: 'task-progress-smoke', taskStatus: 'verifying',
  taskProgress: { total: 2, completed: 1, running: 1, queued: 0, waiting: 0, failed: 0, percent: 50 },
  activeNodes: [{ id: 'node-test', title: '运行验证', agentId: 'code_agent', status: 'running' }],
  changedNodes: [{ id: 'node-code', title: '修改 renderer', agentId: 'code_agent', status: 'completed', summary: '节点已完成。' }],
  message: '修改 renderer：已完成；总体 1/2。',
});

const html = renderMessageList();
assert.equal(run.taskRunId, 'task-progress-smoke');
assert.equal(run.progressMilestones.length, 3);
assert.match(html, /任务目标已确认/);
assert.match(html, /修改 renderer/);
assert.match(html, /验证中 · 85% · 执行节点 1\/2/);
assert.match(html, /运行验证/);
assert.match(html, /查看协作任务/);
assert.match(html, /data-task-card-action="cancel_task"[^>]*data-task-run-id="task-progress-smoke"/);
assert.match(html, /停止整个任务/);
assert.match(html, /collaboration-task-persistent-actions/);
assert.doesNotMatch(html, /resultText/);

const collapsedVerifyingHtml = renderTaskProgressCard({
  taskRunId: 'collapsed-verifying-task', taskStatus: 'verifying', open: false,
  controls: { canCancel: true },
});
assert.ok(collapsedVerifyingHtml.indexOf('collaboration-task-persistent-actions') > collapsedVerifyingHtml.lastIndexOf('</details>'),
  'the stop action must remain outside the collapsible progress details');
assert.match(collapsedVerifyingHtml, /data-task-card-action="cancel_task"[^>]*>停止整个任务<\/button>/);
state.uBuddyTaskViewsById = {
  ...(state.uBuddyTaskViewsById || {}),
  'format-contract-task': {
    id: 'format-contract-task', status: 'running', metadata: { deliverableContract: { deliverables: [
      { id: 'report', deliverable_title: '分析报告', requested_output_type: 'document', requires_file: true,
        required_extensions: ['.docx'], extension_rule: 'one_of', format_source: 'user_explicit' },
      { id: 'appendix', deliverable_title: '数据附件', requested_output_type: 'spreadsheet', requires_file: true,
        required_extensions: ['.xlsx', '.csv'], extension_rule: 'one_of', format_source: 'system_default' },
    ] } },
  },
};
const formatContractHtml = renderTaskProgressCard({ taskRunId: 'format-contract-task', taskStatus: 'running' });
assert.match(formatContractHtml, /交付规格/);
assert.match(formatContractHtml, /分析报告：\.DOCX（用户指定）/);
assert.match(formatContractHtml, /数据附件：任选一种：\.XLSX、\.CSV（系统默认）/);
const cancellingHtml = renderTaskProgressCard({
  taskRunId: 'cancelling-task', taskStatus: 'cancelling', open: false,
  controls: { canCancel: true },
});
assert.match(cancellingHtml, /data-task-card-action="cancel_task"[^>]* disabled>正在停止…<\/button>/);

const bestEffortHtml = renderTaskProgressCard({
  taskRunId: 'best-effort-renderer-task',
  taskStatus: 'completed',
  terminal: true,
  progress: {
    total: 3, completed: 3, executionPercent: 100, percent: 95, lifecyclePhase: 'delivering',
    label: '待确认交付', confirmationRequired: true, running: 0, queued: 0, waiting: 0, failed: 0,
  },
  deliverable: {
    resultState: 'accepted', validationState: 'passed', acceptanceSource: 'revision_limit_best_effort',
    qualityWarning: true, title: '中国环境 PPT 第三版', summary: '自动修改次数已用尽，已交付当前最佳版本。',
    body: '第三版正文', files: [{ name: 'environment-v3.pptx', path: '/tmp/environment-v3.pptx' }],
    reviewWarnings: { failedChecks: [{ summary: '仍有一处模板残留。' }] },
  },
});
assert.match(bestEffortHtml, /待确认交付 · 95% · 执行节点 3\/3/);
assert.match(bestEffortHtml, /class="is-warning"><i>!<\/i>交付/);
assert.doesNotMatch(bestEffortHtml, /class="is-failed"/);
assert.match(bestEffortHtml, /已交付 · 等待用户确认 · 质量提示/);
assert.match(bestEffortHtml, /仍有一处模板残留/);
assert.match(bestEffortHtml, /environment-v3\.pptx/);

const compactDeliveryHtml = renderTaskProgressCard({
  taskRunId: 'compact-delivery-task', taskStatus: 'completed', terminal: true, compact: true,
  deliverable: {
    title: '环境报告', summary: '完整交付摘要',
    files: [{ name: 'environment.docx', path: '/tmp/environment.docx' }, { name: 'environment.md', path: '/tmp/environment.md' }],
  },
  controls: { canOpenWorkspace: true, canOpenResult: true },
});
assert.doesNotMatch(compactDeliveryHtml, /environment\.docx|environment\.md/,
  'compact chat cards must not expand deliverable file details');
assert.match(compactDeliveryHtml, /查看结果 · 2 个文件/);
assert.match(compactDeliveryHtml, /<details class="collaboration-run-card"[^>]*data-task-progress-toggle="compact-delivery-task"(?![^>]* open)/,
  'compact chat cards must be collapsed by default');

assert.deepEqual(deriveTaskLifecycleProgress({ phase: 'executing', taskStatus: 'running', executionPercent: 100 }), {
  percent: 75, executionPercent: 100, phase: 'executing', label: '执行中', confirmationRequired: false,
});
assert.equal(deriveTaskLifecycleProgress({ phase: 'verifying', taskStatus: 'running', executionPercent: 100 }).percent, 85);
assert.equal(deriveTaskLifecycleProgress({ phase: 'verifying', taskStatus: 'completed', executionPercent: 100 }).percent, 85,
  'completed execution nodes must not make an in-progress verification phase appear complete');
assert.deepEqual(deriveTaskLifecycleProgress({
  phase: 'delivering', taskStatus: 'completed', executionPercent: 100,
  finalDeliveryState: 'delivered', hasConfirmationProtocol: true,
}), {
  percent: 95, executionPercent: 100, phase: 'delivering', label: '待确认交付', confirmationRequired: true,
});
assert.equal(deriveTaskLifecycleProgress({
  phase: 'delivering', taskStatus: 'completed', executionPercent: 100,
  finalDeliveryState: 'closed', hasConfirmationProtocol: true,
}).percent, 100);
assert.equal(deriveTaskLifecycleProgress({ phase: 'delivering', taskStatus: 'completed', executionPercent: 100 }).percent, 100,
  'legacy completed tasks without a confirmation protocol remain compatible');
assert.notEqual(deriveTaskLifecycleProgress({ phase: 'delivering', taskStatus: 'failed', executionPercent: 100 }).percent, 100);

const lifecycleTask = {
  id: 'lifecycle-progress-task', status: 'completed', nodes: [
    { id: 'lifecycle-node-1', title: '生成交付物', status: 'completed' },
    { id: 'lifecycle-node-2', title: '整理结果', status: 'completed' },
  ],
  metadata: {
    deliveryReviewState: 'accepted',
    finalDelivery: { state: 'delivered' },
  },
};
const deliveredSnapshot = buildPublicTaskProgressSnapshot(lifecycleTask, { phase: 'delivering' });
assert.equal(deliveredSnapshot.progress.executionPercent, 100);
assert.equal(deliveredSnapshot.progress.percent, 95);
assert.equal(deliveredSnapshot.progress.label, '待确认交付');
assert.equal(deliveredSnapshot.progress.confirmationRequired, true);
const closedSnapshot = buildPublicTaskProgressSnapshot({
  ...lifecycleTask,
  metadata: { ...lifecycleTask.metadata, finalDelivery: { state: 'closed' } },
}, { phase: 'delivering' });
assert.equal(closedSnapshot.progress.percent, 100);
assert.equal(closedSnapshot.progress.confirmationRequired, false);

for (let index = 0; index < 250; index += 1) {
  controller.handleChatRunEvent(run.channelId, {
    kind: 'activity', activityId: 'protocol-cap-check', activityType: 'reasoning', status: 'running',
    detail: '协议事件容量检查', protocolEvents: [{ protocolEventId: `protocol-${index}`, sequence: index, method: 'item/reasoning/textDelta' }],
  });
}
const cappedProtocolEvent = run.processEvents.find((item) => item.activityId === 'protocol-cap-check');
assert.equal(cappedProtocolEvent.protocolEvents.length, 200);
assert.equal(cappedProtocolEvent.protocolEvents[0].protocolEventId, 'protocol-50');

controller.handleChatRunEvent(run.channelId, { kind: 'done', answer: '任务完成。' });
assert.equal(state.messages.find((message) => message.id === run.statusMessageId)?.metadata?.terminal, true);

state.currentSessionId = 'ubuddy-session';
state.currentChatKey = 'session:ubuddy-session';
state.activeChatRun = null;
state.chatRuns = [];
state.messages = [{
  id: 'ubuddy-background-task', role: 'assistant', content: '任务已进入后台队列。',
  agentId: 'secretary_agent', departmentId: 'secretary_department',
  metadata: {
    uBuddyTaskQueued: true,
    taskRunId: 'background-task-1',
    taskSnapshot: { progress: { total: 2, completed: 0 } },
    ...completedPublishMetadata,
  },
}];
const completedPublishMarkup = renderMessageList();
assert.match(completedPublishMarkup, /任务已发布/);
assert.match(completedPublishMarkup, /确认任务信息/);
assert.match(completedPublishMarkup, /创建任务并安排执行/);
assert.match(completedPublishMarkup, /<details class="codex-process-disclosure"[^>]*data-process-toggle="ubuddy-background-task"(?![^>]* open)>/,
  'a successfully published task should retain its process collapsed');
assert.ok(completedPublishMarkup.indexOf('任务已发布') < completedPublishMarkup.indexOf('data-task-progress-run="background-task-1"'),
  'the publish process should appear above the original task card');
assert.equal((completedPublishMarkup.match(/任务已发布/g) || []).length, 1,
  'the persisted process must not be duplicated by the task-card render path');
assert.doesNotMatch(completedPublishMarkup, /reasoningText|rawAnswer|workspaceRoot/);

state.messages = [{
  id: 'ubuddy-waiting-publish', role: 'assistant', content: '还需要补充一项信息。',
  agentId: 'secretary_agent', departmentId: 'secretary_department',
  metadata: { secretaryControl: true, ...waitingPublishMetadata },
}];
const waitingPublishMarkup = renderMessageList();
assert.match(waitingPublishMarkup, /等待补充信息/);
assert.match(waitingPublishMarkup, /<details class="codex-process-disclosure"[^>]*data-process-toggle="ubuddy-waiting-publish" open>/,
  'a waiting publish process should remain expanded');

state.messages = [{
  id: 'ubuddy-waiting-confirmation', role: 'assistant', content: '多人方案等待确认。',
  agentId: 'secretary_agent', departmentId: 'secretary_department',
  metadata: { secretaryControl: true, ...confirmationWaitingMetadata },
}];
const waitingConfirmationMarkup = renderMessageList();
assert.match(waitingConfirmationMarkup, /等待确认/);
assert.doesNotMatch(waitingConfirmationMarkup, /等待补充信息/);

state.messages = [{
  id: 'ubuddy-legacy-background-task', role: 'assistant', content: '旧任务已进入后台队列。',
  agentId: 'secretary_agent', departmentId: 'secretary_department',
  metadata: { uBuddyTaskQueued: true, taskRunId: 'legacy-background-task' },
}];
assert.doesNotMatch(renderMessageList(), /任务已发布|ubuddy-task-publish-process-message/,
  'legacy queued task messages should keep their existing card-only rendering');

state.messages = [{
  id: 'ubuddy-background-task-flag-off', role: 'assistant', content: '任务已进入后台队列。',
  agentId: 'secretary_agent', departmentId: 'secretary_department',
  metadata: { uBuddyTaskQueued: true, taskRunId: 'background-task-flag-off', ...completedPublishMetadata },
}];
state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, newProcessEventStream: false };
const disabledPublishMarkup = renderMessageList();
assert.doesNotMatch(disabledPublishMarkup, /任务已发布|确认任务信息/);
assert.match(disabledPublishMarkup, /data-task-progress-run="background-task-flag-off"/,
  'disabling the process stream must not hide or alter the original task card');
state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, newProcessEventStream: true };

state.messages = [];
state.agentDelegations = [];
state.networkDelegationProgressById = {};
const provisionalNotice = {
  id: 'external-delegation-provisional', sessionId: 'ubuddy-session', role: 'assistant',
  content: '好友的 uBuddy 向我派发了任务。我已收到，接下来会在隔离工作区安排 Agent 执行。',
  metadata: { uBuddyTaskQueued: true, externalDelegationId: 'delegation-provisional' },
};
applyDelegationNoticeUpsert(state, {
  session: { id: 'ubuddy-session', title: '我的 uBuddy' },
  message: provisionalNotice,
});
applyDelegationTaskUpdate(state, {
  delegation: {
    id: 'delegation-provisional', title: '建立前进度任务', status: 'accepted',
    metadata: { executionProgress: {
      sequence: 2, phase: 'preparing', message: 'uBuddy 正在整理任务要求、附件和公开上下文',
      milestones: [{ key: 'delegation_received', title: '任务已收到', status: 'completed', detail: '无需重复派发。' }],
    } },
  },
  change: { type: 'delegation_progress', progress: {
    sequence: 2, phase: 'preparing', message: 'uBuddy 正在整理任务要求、附件和公开上下文',
    milestones: [{ key: 'delegation_received', title: '任务已收到', status: 'completed', detail: '无需重复派发。' }],
  } },
});
const provisionalMarkup = renderMessageList();
assert.match(provisionalMarkup, /data-delegation-progress="delegation-provisional"/);
assert.match(provisionalMarkup, /uBuddy 正在整理任务要求、附件和公开上下文/);
assert.match(provisionalMarkup, /建立前进度任务/);
assert.doesNotMatch(provisionalMarkup, /data-task-progress-run=/);
assert.doesNotMatch(provisionalMarkup, /data-task-card-action=/);

applyDelegationNoticeUpsert(state, {
  session: { id: 'ubuddy-session', title: '我的 uBuddy' },
  message: {
    ...provisionalNotice,
    metadata: { ...provisionalNotice.metadata, taskRunId: 'provisional-task-run' },
  },
});
applyDelegationTaskUpdate(state, {
  delegation: { id: 'delegation-provisional', title: '建立前进度任务', status: 'running', metadata: {} },
  task: {
    id: 'provisional-task-run', status: 'running',
    metadata: { delegationId: 'delegation-provisional' },
    nodes: [{ id: 'provisional-node', title: '执行正式任务', agentId: 'general_agent', status: 'running' }],
  },
  change: { type: 'node_running', node: { id: 'provisional-node', title: '执行正式任务', agentId: 'general_agent', status: 'running' } },
});
const upgradedProvisionalMarkup = renderMessageList();
assert.match(upgradedProvisionalMarkup, /data-task-progress-run="provisional-task-run"/);
assert.equal((upgradedProvisionalMarkup.match(/collaboration-run-card/g) || []).length, 1,
  'binding a taskRunId must upgrade the provisional delegation card in place');

state.messages = [{
  id: 'external-submitted-action', role: 'assistant', content: '任务结果已提交。',
  metadata: {
    uBuddyTaskQueued: true, externalDelegationId: 'delegation-submitted-action', externalDelegationStatus: 'submitted',
    externalDelegationSubmittedSnapshot: { content: '已完成交付。', attachments: [{ name: 'result.docx' }] },
  },
}];
state.agentDelegations = [{ id: 'delegation-submitted-action', status: 'submitted', metadata: {} }];
const submittedActionMarkup = renderMessageList();
assert.match(submittedActionMarkup, /data-task-card-action="open_workspace"[^>]*data-task-workspace-kind="delegation"[^>]*data-task-workspace-id="delegation-submitted-action"/,
  'a submitted delegation action must use the task-card event path so incremental message patches remain clickable');
assert.doesNotMatch(submittedActionMarkup, /data-network-delegation="delegation-submitted-action"/);

state.messages = [];
const noticeProjection = applyDelegationNoticeUpsert(state, {
  session: { id: 'ubuddy-session', title: '我的 uBuddy' },
  message: {
    id: 'external-delegation-notice', sessionId: 'ubuddy-session', role: 'assistant',
    content: '好友的 uBuddy 向我派发了任务。我已收到，正在规划 Agent 和执行步骤。',
    metadata: { uBuddyTaskQueued: true, taskRunId: 'background-task-1', externalDelegationId: 'delegation-1' },
  },
});
assert.equal(noticeProjection.currentSession, true, 'a background delegation notice must enter the currently open uBuddy conversation');
assert.equal(state.messages.some((message) => message.id === 'external-delegation-notice'), true);

const backgroundMatched = controller.handleTaskUpdate({
  task: {
    id: 'background-task-1', status: 'running', nodes: [
      { id: 'node-general', title: '撰写物理力学文稿', agentId: 'general_agent', status: 'running' },
      { id: 'node-ppt', title: '生成五页 PPT', agentId: 'ppt', status: 'pending' },
    ],
  },
  change: {
    type: 'node_heartbeat', elapsedSeconds: 15,
    message: '通用 Agent 正在处理“撰写物理力学文稿”，已用时 15 秒。',
    node: { id: 'node-general', title: '撰写物理力学文稿', agentId: 'general_agent', status: 'running' },
  },
});
assert.equal(backgroundMatched, true, 'persisted uBuddy task messages must update without an active chat run');
assert.match(renderMessageList(), /已用时 15 秒/);
assert.match(renderMessageList(), /执行中 · 25% · 执行节点 0\/2/);

state.messages = [{
  id: 'delivered-progress-message', role: 'assistant', content: '交付已准备完成。',
  metadata: { uBuddyTaskQueued: true, taskRunId: 'delivered-progress-task' },
}];
controller.handleTaskUpdate({
  task: {
    id: 'delivered-progress-task', status: 'completed',
    nodes: [{ id: 'delivered-node', title: '生成交付物', status: 'completed' }],
    metadata: { deliveryReviewState: 'accepted', finalDelivery: { state: 'delivered' } },
  },
  change: { type: 'ubuddy_delivery_review_accepted' },
});
assert.equal(state.messages[0].metadata.taskProgress.executionPercent, 100);
assert.equal(state.messages[0].metadata.taskProgress.percent, 95);
assert.equal(state.messages[0].metadata.taskProgress.confirmationRequired, true);
const pendingHydrationDeliveryMarkup = renderMessageList();
assert.match(pendingHydrationDeliveryMarkup, /class="ubuddy-chat-delivery-card ubuddy-chat-task-result-card is-pending"/);
assert.doesNotMatch(pendingHydrationDeliveryMarkup, /<header><span>任务交付<\/span><\/header>/);
assert.match(pendingHydrationDeliveryMarkup, />待验收</);
assert.doesNotMatch(pendingHydrationDeliveryMarkup, /collaboration-run-card|总体进度|100%/,
  'a terminal uBuddy task must use the same compact card shell as a hydrated delivery');

state.languageMode = 'zh-CN';
const completedResultMarkup = renderTaskProgressCard({
  taskRunId: 'completed-result-task',
  title: '竞品能力对比表',
  content: '竞品能力对比已整理完成。',
  taskStatus: 'completed',
  phase: 'delivering',
  progress: { terminal: true, executionPercent: 100 },
  nodes: [{
    id: 'completed-result-node', title: '整理对比结果', status: 'completed',
    startedAt: '2026-08-13T08:00:00.000Z', completedAt: '2026-08-13T08:02:30.000Z',
    evidenceRefs: [{ type: 'file', value: '/tmp/competitor-comparison.xlsx', label: 'competitor-comparison.xlsx' }],
  }],
  createdAt: '2026-08-13T08:00:00.000Z',
  updatedAt: '2026-08-13T08:03:00.000Z',
  showMessageTime: true,
  compact: true,
  terminal: true,
  controls: { canOpenWorkspace: true, canOpenResult: true },
});
assert.match(completedResultMarkup, /class="ubuddy-chat-delivery-card ubuddy-chat-task-result-card is-completed"/);
assert.doesNotMatch(completedResultMarkup, /<header><span>任务结果<\/span><\/header>/);
assert.match(completedResultMarkup, />已完成</);
assert.match(completedResultMarkup, /竞品能力对比表/);
assert.match(completedResultMarkup, /ubuddy-chat-delivery-title"><strong>竞品能力对比表<\/strong><span class="ubuddy-chat-delivery-title-meta">[^]*已完成/);
assert.match(completedResultMarkup, />打开任务<|>查看结果</);
assert.match(completedResultMarkup, /ubuddy-chat-task-duration[^]*已运行 2 分 30 秒/);
assert.match(completedResultMarkup, /ubuddy-chat-card-message-time/);
assert.ok(completedResultMarkup.indexOf('ubuddy-chat-card-message-time') < completedResultMarkup.indexOf('ubuddy-chat-delivery-card'),
  'the sparse message timestamp must sit above the whole card');
assert.match(completedResultMarkup, /完成文件[^]*competitor-comparison\.xlsx/);
assert.match(completedResultMarkup, /ubuddy-chat-task-file-icon is-excel[^]*<b>X<\/b>/);
assert.match(completedResultMarkup, /data-open-file="[^"]+"[^]*>打开</);
assert.match(completedResultMarkup, /data-save-file="[^"]+"[^]*>下载</);
assert.doesNotMatch(completedResultMarkup, /collaboration-run-card|总体进度|100%/,
  'a completed result without files must keep the delivery-card template instead of the legacy progress card');
state.languageMode = 'en';
const englishCompletedResultMarkup = renderTaskProgressCard({
  taskRunId: 'english-completed-result-task', taskStatus: 'completed', terminal: true, compact: true,
  createdAt: '2026-08-13T08:00:00.000Z', updatedAt: '2026-08-13T08:02:30.000Z',
  nodes: [{ status: 'completed', startedAt: '2026-08-13T08:00:00.000Z', completedAt: '2026-08-13T08:02:30.000Z' }],
});
assert.match(englishCompletedResultMarkup, /2m 30s/);
state.languageMode = 'zh-CN';

const failedResultMarkup = renderTaskProgressCard({
  taskRunId: 'failed-result-task',
  title: '生成行业分析报告',
  content: '生成报告时任务执行失败。',
  taskStatus: 'failed',
  phase: 'executing',
  progress: { terminal: true, executionPercent: 40 },
  nodes: [{ id: 'failed-result-node', title: '生成报告文件', status: 'failed', errorText: '导出服务不可用' }],
  createdAt: '2026-08-13T09:00:00.000Z',
  updatedAt: '2026-08-13T09:01:15.000Z',
  showMessageTime: true,
  compact: true,
  terminal: true,
  controls: { canOpenWorkspace: true, canOpenResult: true, canRerun: true },
});
assert.match(failedResultMarkup, /ubuddy-chat-task-result-card is-failed/);
assert.match(failedResultMarkup, />执行失败</);
assert.match(failedResultMarkup, /ubuddy-chat-task-failure-signal/);
assert.match(failedResultMarkup, /任务未完成/);
assert.match(failedResultMarkup, /ubuddy-chat-task-duration[^]*已运行 1 分 15 秒/);
assert.match(failedResultMarkup, /ubuddy-chat-card-message-time/);
assert.doesNotMatch(failedResultMarkup, /完成文件/);
assert.match(failedResultMarkup, /data-task-card-action="open_workspace"[^>]*>查看失败原因</);
assert.match(failedResultMarkup, /data-rerun-ubuddy-task="failed-result-task"/);
assert.doesNotMatch(failedResultMarkup, /data-task-card-action="open_result"|>查看结果</,
  'failed task cards must open diagnostics instead of an empty result view');

state.currentUser = { id: 'test-account-07', displayName: '测试账号 07' };
state.employeeOverview = {
  ...(state.employeeOverview || {}),
  roster: [{ id: 'report-agent-02', agentFamilyId: 'general_agent', displayName: '报告 Agent 02' }],
};
state.tasks = [{
  id: 'pending-chat-delivery', title: '2026年图像检测技术发展报告', status: 'completed', ownerUserId: 'test-account-07',
  nodes: [{ id: 'report-node', status: 'completed', agentId: 'general_agent', agentInstanceId: 'report-agent-02' }],
  metadata: {
    source: 'ubuddy_dispatch', selectedDeliverySubmissionId: 'pending-chat-submission', selectedDeliverySubmissionNo: 2,
    finalDelivery: { state: 'delivered', deliveredAt: '2026-08-12T16:40:00.000Z' },
    uBuddyTaskIntakeSpec: {
      objective: '清晰说明生成式推荐系统的基本概念',
      deliverables: ['生成式推荐系统介绍 Word 文档'],
      acceptanceCriteria: ['文档为可交付的 Word 格式', '内容结构完整，适合初次了解该主题的读者'],
      constraints: ['使用清晰易懂的中文表述'],
    },
  },
}];
state.messages = [{
  id: 'pending-chat-delivery-previous', role: 'user', content: '请生成报告。',
  createdAt: '2026-08-12T16:37:59.000Z', metadata: {},
}, {
  id: 'pending-chat-delivery-message', role: 'assistant', content: '报告已经完成。',
  createdAt: '2026-08-12T16:40:00.000Z',
  metadata: {
    uBuddyTaskTerminalTaskRunId: 'pending-chat-delivery', uBuddyFinalDeliveryMessage: true,
    taskRunId: 'pending-chat-delivery', terminal: true,
    deliverableResult: {
      title: '2026年图像检测技术发展报告', resultState: 'delivered', contentType: 'deliverable',
      selectedSubmissionId: 'pending-chat-submission', selectedSubmissionNo: 2,
      files: [{ name: 'report.docx', path: '/tmp/report.docx' }, { name: 'report.md', path: '/tmp/report.md' }],
    },
  },
}];
const pendingChatDeliveryMarkup = renderMessageList();
assert.doesNotMatch(pendingChatDeliveryMarkup, /<header><span>任务交付<\/span><\/header>/);
assert.match(pendingChatDeliveryMarkup, />待验收</);
assert.match(pendingChatDeliveryMarkup, /ubuddy-chat-delivery-title"><strong>2026年图像检测技术发展报告<\/strong><span class="ubuddy-chat-delivery-title-meta">[^]*待验收/);
assert.match(pendingChatDeliveryMarkup, /任务目标已达成[^]*清晰说明生成式推荐系统的基本概念/);
assert.match(pendingChatDeliveryMarkup, /交付物已完成[^]*data-open-file="[^"]+"[^]*report\.docx/);
assert.match(pendingChatDeliveryMarkup, /验收标准已满足[^]*文档为可交付的 Word 格式/);
assert.match(pendingChatDeliveryMarkup, /执行约束已遵循[^]*使用清晰易懂的中文表述/);
assert.match(pendingChatDeliveryMarkup, /执行 Agent[^]*测试账号 07 · 报告 Agent 02/);
assert.equal((pendingChatDeliveryMarkup.match(/ubuddy-chat-delivery-file-links[^]*?<\/span>/) || [''])[0].includes('data-save-file'), false,
  'delivery facts should point directly to actual files instead of repeating file cards and download controls');
assert.match(pendingChatDeliveryMarkup, />W<\/i>/);
assert.match(pendingChatDeliveryMarkup, />MD<\/i>/);
assert.match(pendingChatDeliveryMarkup, /data-ubuddy-quick-accept="pending-chat-delivery"/);
assert.match(pendingChatDeliveryMarkup, />快速验收</);
assert.match(pendingChatDeliveryMarkup, /data-task-card-action="open_result"[^>]*data-delivery-submission-id="pending-chat-submission"[^>]*>查看交付详情/);
assert.match(pendingChatDeliveryMarkup, /ubuddy-chat-card-message-time/,
  'a card sent more than two minutes after the previous message must show its centered timestamp');
assert.doesNotMatch(pendingChatDeliveryMarkup, />打开<|>下载<|>预览<|>定位</,
  'the compact delivery should use direct file links without redundant file-card actions');
const openPayload = pendingChatDeliveryMarkup.match(/data-open-file="([^"]+)"/)?.[1] || '';
let openFileListener = null;
const openFileButton = {
  dataset: { openFile: openPayload },
  hasAttribute: (name) => name === 'data-codex-file-action',
  addEventListener: (type, listener) => { if (type === 'click') openFileListener = listener; },
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => selector === '[data-open-file]' ? [openFileButton] : [],
});
assert.equal(typeof openFileListener, 'function');
await openFileListener({ preventDefault() {}, stopPropagation() {} });
assert.equal(openedFiles.at(-1)?.name, 'report.docx');
assert.equal(openedFiles.at(-1)?.path, '/tmp/report.docx');
state.messages[0] = { ...state.messages[0], createdAt: '2026-08-12T16:38:00.000Z' };
assert.doesNotMatch(renderMessageList(), /ubuddy-chat-card-message-time/,
  'a card sent exactly two minutes after the previous message must not repeat the timestamp');
state.messages[0] = { ...state.messages[0], createdAt: '2026-08-12T16:37:59.000Z' };

state.tasks = [{
  id: 'accepted-in-place-task', title: '原卡片验收任务', status: 'completed', nodes: [],
  metadata: {
    deliveryReviewOutcome: 'owner_override', finalDelivery: { state: 'closed' },
    deliverableResult: {
      title: '原卡片验收交付物', summary: '本次交付已经确认。', resultState: 'accepted',
      contentType: 'deliverable', acceptanceSource: 'owner_override', files: [],
    },
  },
}];
state.messages = [{
  id: 'accepted-in-place-original', role: 'assistant', content: '任务已完成，等待验收。',
  metadata: {
    uBuddyTaskTerminalTaskRunId: 'accepted-in-place-task', uBuddyFinalDeliveryMessage: true,
    taskRunId: 'accepted-in-place-task', terminal: true,
    deliverableResult: { title: '原卡片验收交付物', resultState: 'accepted', contentType: 'deliverable' },
  },
}, {
  id: 'accepted-in-place-duplicate', role: 'assistant', content: '这条验收消息不应生成新卡片。',
  metadata: {
    uBuddyTaskTerminalTaskRunId: 'accepted-in-place-task', uBuddyFinalDeliveryMessage: true,
    taskRunId: 'accepted-in-place-task', terminal: true,
    deliverableResult: { title: '原卡片验收交付物', resultState: 'accepted', contentType: 'deliverable', acceptanceSource: 'owner_override' },
  },
}];
const acceptedInPlaceMarkup = renderMessageList();
assert.equal((acceptedInPlaceMarkup.match(/class="ubuddy-chat-delivery-card /g) || []).length, 1,
  'accepting a delivery must update the original card instead of rendering another card');
assert.match(acceptedInPlaceMarkup, />已验收</);
assert.match(acceptedInPlaceMarkup, />查看交付详情/);
assert.doesNotMatch(acceptedInPlaceMarkup, /data-ubuddy-quick-accept/);
assert.doesNotMatch(acceptedInPlaceMarkup, /这条验收消息不应生成新卡片/);

state.messages = [{
  id: 'accepted-queued-host', role: 'assistant', content: '任务执行已完成，等待验收。',
  metadata: {
    uBuddyTaskQueued: true, taskRunId: 'accepted-in-place-task', terminal: true,
    taskSnapshot: { taskRunId: 'accepted-in-place-task', taskStatus: 'completed' },
    ...completedPublishMetadata,
  },
}, {
  id: 'accepted-terminal-notice', role: 'assistant', content: '终态通知不应再显示第二张卡片。',
  metadata: {
    uBuddyTaskTerminalTaskRunId: 'accepted-in-place-task', uBuddyFinalDeliveryMessage: true,
    taskRunId: 'accepted-in-place-task', terminal: true,
    deliverableResult: { title: '原卡片验收交付物', resultState: 'accepted', contentType: 'deliverable', acceptanceSource: 'owner_override' },
  },
}];
const acceptedQueuedHostMarkup = renderMessageList();
assert.equal((acceptedQueuedHostMarkup.match(/class="ubuddy-chat-delivery-card /g) || []).length, 1,
  'the accepted result must be projected into the original queued task card');
assert.equal((acceptedQueuedHostMarkup.match(/任务已发布/g) || []).length, 1,
  'accepting a task should preserve its collapsed publication process on the in-place result card');
assert.match(acceptedQueuedHostMarkup, /<details class="codex-process-disclosure"[^>]*data-process-toggle="accepted-terminal-notice"(?![^>]* open)>/);
assert.doesNotMatch(acceptedQueuedHostMarkup, /终态通知不应再显示第二张卡片/);

state.messages = [];
const deliveryReceipt = {
  workId: 'delivery-work-1', sourceSessionId: 'ubuddy-session', targetSessionId: 'general-session', deliveryStatus: 'running',
  metadata: { targetAgentId: 'code_agent', targetAgentName: '代码 Agent', startedAt: new Date().toISOString() },
  events: [],
};
const deliveryEvent = {
  sequenceNo: 1, kind: 'start', stage: 'working', message: '代码 Agent 已领取任务，正在理解要求并准备输出。',
  payload: { agentId: 'code_agent', departmentId: 'general' }, createdAt: new Date().toISOString(),
};
controller.handleAgentDeliveryUpdate({ receipt: deliveryReceipt, event: deliveryEvent });
assert.match(renderMessageList(), /代码 Agent 已领取任务/);
state.messages = [];
controller.restorePersistentDeliveryRuns([{ ...deliveryReceipt, events: [deliveryEvent] }], 'ubuddy-session');
assert.match(renderMessageList(), /代码 Agent 已领取任务/);
controller.handleAgentDeliveryUpdate({ receipt: { ...deliveryReceipt, deliveryStatus: 'completed' } });
assert.equal(state.chatRuns.some((item) => item.workId === deliveryReceipt.workId), false,
  'terminal delivery updates must remove the transient background run');
assert.equal(state.messages.some((message) => message.id.includes(deliveryReceipt.workId)), false,
  'terminal delivery updates must remove transient status and process messages');
assert.equal((state.agentDeliveryRunsBySession['ubuddy-session'] || []).some((item) => item.workId === deliveryReceipt.workId), false,
  'terminal delivery updates must evict persisted active-run cache entries');

state.agentDelegations = [];
state.collaborationOverview = { groups: [], tasks: [] };
state.networkDelegationProgressById = {};
const liveDelegationId = applyDelegationTaskUpdate(state, {
  delegation: {
    id: 'delegation-live-progress', groupId: 'group-live', status: 'running',
    metadata: { executionProgress: { sequence: 2, phase: 'planning', message: 'uBuddy 正在规划任务', total: 0, completed: 0 } },
  },
  change: { type: 'delegation_progress', progress: { sequence: 2, phase: 'planning', message: 'uBuddy 正在规划任务', total: 0, completed: 0 } },
});
assert.equal(liveDelegationId, 'delegation-live-progress');
assert.equal(state.agentDelegations[0].status, 'running');
assert.equal(state.collaborationOverview.tasks[0].id, 'delegation-live-progress');
assert.equal(state.networkDelegationProgressById['delegation-live-progress'].phase, 'planning');

state.currentUser = { id: 'progress-owner', displayName: 'Progress Owner' };
state.collaborationGroupId = 'progress-group';
state.collaborationGroupWorkspace = {};
state.collaborationGroupDetail = {
  group: { id: 'progress-group', title: '实时进度群', ownerUserId: 'progress-owner', status: 'active' },
  members: [
    { userId: 'progress-owner', status: 'active', user: state.currentUser },
    { userId: 'progress-peer', status: 'active', user: { id: 'progress-peer', displayName: 'Progress Peer', avatarUrl: 'https://avatars.example.test/progress-peer.png' } },
  ],
  tasks: [{ id: 'delegation-live-progress', title: '实时多节点任务', status: 'running', metadata: {} }],
  messages: [
    { id: 'assigned-progress', senderUserId: 'progress-owner', senderAgentId: 'secretary_agent', content: '任务已派发', metadata: { type: 'task_assigned', delegationId: 'delegation-live-progress' } },
    { id: 'peer-progress', senderUserId: 'progress-peer', senderAgentId: 'secretary_agent', sender: { id: 'progress-peer', displayName: 'Progress Peer', avatarUrl: 'https://avatars.example.test/progress-peer.png' }, content: '对方 uBuddy 已同步进度。' },
  ],
};
state.networkDelegationProgressById['delegation-live-progress'] = {
  phase: 'executing', message: '代码 Agent 正在修改 renderer', completed: 1, total: 3,
  nodes: [{ id: 'node-live', title: '修改 renderer', agentName: '代码 Agent', status: 'running', updatedAt: '2026-08-12T09:20:00.000Z' }],
};
state.collaborationGroupDetail.tasks.push({
  id: 'delegation-earlier-progress', title: '整理需求', status: 'completed', recipientUserId: 'progress-owner',
  updatedAt: '2026-08-12T09:10:00.000Z', metadata: { executionProgress: {
    phase: 'delivered', updatedAt: '2026-08-12T09:10:00.000Z',
    milestones: [{ key: 'requirements:completed', title: '需求整理', detail: '已确认验收范围', status: 'completed', occurredAt: '2026-08-12T09:10:00.000Z' }],
  } },
});
const groupProgressHtml = renderChat();
assert.equal(renderTopbar(), '', 'a collaboration group must not reserve an empty chat utility above its own header');
assert.match(groupProgressHtml, /collaboration-progress-task/);
assert.match(groupProgressHtml, /修改 renderer/);
assert.match(groupProgressHtml, /完成当前工作后同步下一项关键进展/);
assert.match(groupProgressHtml, /data-progress-event-id="node:delegation-live-progress:node-live:running"/);
assert.match(groupProgressHtml, /data-task-card-action="open_workspace"[^>]*data-task-workspace-id="delegation-live-progress"/);
assert.doesNotMatch(groupProgressHtml, /data-ubuddy-owner-user="progress-peer"|ubuddy-owner-avatar/,
  'work groups intentionally keep the existing uBuddy avatar treatment for now');
assert.ok(groupProgressHtml.indexOf('已确认验收范围') < groupProgressHtml.indexOf('正在推进修改 renderer'),
  'collaboration progress events must be ordered by their own occurredAt timestamps across tasks');
state.collaborationGroupId = '';
state.collaborationGroupDetail = null;

const failedStageHtml = renderTaskProgressCard({
  taskRunId: 'failed-stage-task', phase: 'executing', taskStatus: 'failed', terminal: true,
  open: false,
  progress: { total: 3, completed: 1, failed: 1 },
  nodes: [{ id: 'failed-node', title: '执行实现', status: 'failed' }],
  blocker: { summary: '执行节点失败' },
});
assert.match(failedStageHtml, /class="is-failed"><i>!<\/i>执行/);
assert.doesNotMatch(failedStageHtml, /class="is-complete"><i>✓<\/i>验证/);
assert.doesNotMatch(failedStageHtml, /class="is-active"><i>5<\/i>交付/);

const failedValidationHtml = renderTaskProgressCard({
  taskRunId: 'failed-validation-task', phase: 'failed', taskStatus: 'running', terminal: false,
  progress: {
    taskStatus: 'failed', failureStage: 'delivery_validation', lifecyclePhase: 'verifying',
    total: 1, completed: 1, executionPercent: 100, terminal: true,
  },
  nodes: [{ id: 'completed-before-review', title: '整理复习资料', status: 'completed' }],
});
assert.match(failedValidationHtml, /任务失败 · 85%/);
assert.match(failedValidationHtml, /class="is-failed"><i>!<\/i>验证/);
assert.doesNotMatch(failedValidationHtml, /确认目标中 · 5%/);

const unavailableReviewHtml = renderTaskProgressCard({
  taskRunId: 'unavailable-review-task', phase: 'verifying', taskStatus: 'completed', terminal: true,
  progress: {
    reviewState: 'action_required', deliveryValidationState: 'unavailable',
    deliveryValidationCode: 'delivery_review_uncertain', lifecyclePhase: 'verifying',
    total: 1, completed: 1, executionPercent: 100,
  },
  deliverable: { validationState: 'unavailable', qualityWarning: true, title: '当前交付版本' },
});
assert.match(unavailableReviewHtml, /class="is-unavailable"><i>\?<\/i>验证/);
assert.doesNotMatch(unavailableReviewHtml, /class="is-failed"/);

const actionRequiredReviewHtml = renderTaskProgressCard({
  taskRunId: 'action-required-review-task', phase: 'verifying', taskStatus: 'waiting',
  progress: { reviewState: 'action_required', deliveryValidationState: 'failed', lifecyclePhase: 'verifying' },
  resultState: 'needs_revision',
  deliverable: { resultState: 'needs_revision', validationState: 'failed', title: '待补充交付版本' },
  blocker: { summary: '需要补充原始资料', userActionRequired: true },
});
assert.match(actionRequiredReviewHtml, /class="is-action-required"><i>…<\/i>验证/);
assert.doesNotMatch(actionRequiredReviewHtml, /class="is-failed"/);

state.taskProgressOpenById = {};
assert.match(failedStageHtml, /data-task-progress-toggle="failed-stage-task"/);
assert.doesNotMatch(failedStageHtml, /<details class="collaboration-run-card"[^>]* open/);
let progressToggleListener = null;
const progressToggleDetails = {
  dataset: { taskProgressToggle: 'failed-stage-task' },
  open: true,
  addEventListener: (type, listener) => { if (type === 'toggle') progressToggleListener = listener; },
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => selector === '[data-task-progress-toggle]' ? [progressToggleDetails] : [],
});
assert.equal(typeof progressToggleListener, 'function');
progressToggleListener();
assert.equal(state.taskProgressOpenById['failed-stage-task'], true);
const reopenedFailedStageHtml = renderTaskProgressCard({
  taskRunId: 'failed-stage-task', phase: 'executing', taskStatus: 'failed', terminal: true,
  open: false,
  progress: { total: 3, completed: 1, failed: 1 },
  nodes: [{ id: 'failed-node', title: '执行实现', status: 'failed' }],
  blocker: { summary: '执行节点失败' },
});
assert.match(reopenedFailedStageHtml, /<details class="collaboration-run-card"[^>]* open/);
state.taskProgressOpenById = {};

state.tasks = [{
  id: 'unified-task-card-run', title: '实时任务旧标题', status: 'running', metadata: {},
  nodes: [{ id: 'unified-node', title: '生成中国环境 PPT', agentId: 'code_agent', status: 'running', detail: '正在生成演示文稿。' }],
}];
state.taskDisclosureOpenByKey = { 'unified-task-card-run:technical': true };
state.messages = [{
  id: 'unified-task-status', role: 'assistant', content: '正在生成演示文稿。',
  metadata: {
    transient: 'run-status', taskRunId: 'unified-task-card-run', stage: 'executing',
    taskProgress: { total: 1, completed: 0, running: 1, queued: 0, waiting: 0, failed: 0 },
    taskSnapshot: { taskRunId: 'unified-task-card-run', taskStatus: 'running', phase: 'executing' },
  },
}, {
  id: 'unified-task-published-host', role: 'assistant', content: '任务已经发布。',
  metadata: {
    publishedTaskCards: [{
      taskRunId: 'unified-task-card-run', taskWorkspaceId: 'unified-task-card-run', workspaceKind: 'task_run',
      title: '中国环境 PPT 测试任务', status: 'running',
    }, {
      taskRunId: 'different-task-run', taskWorkspaceId: 'different-task-run', workspaceKind: 'task_run',
      title: '另一个独立任务', status: 'running',
    }],
  },
}];
const unifiedTaskCardsMarkup = renderMessageList();
assert.equal((unifiedTaskCardsMarkup.match(/中国环境 PPT 测试任务/g) || []).length, 1,
  'a published card and its live run status must merge into one task card');
assert.equal((unifiedTaskCardsMarkup.match(/<article class="ubuddy-published-task-card /g) || []).length, 1,
  'only the different task should remain as a separate published card');
assert.match(unifiedTaskCardsMarkup, /另一个独立任务/);
assert.match(unifiedTaskCardsMarkup, /data-task-disclosure-key="unified-task-card-run:technical" open/);
let taskDisclosureToggleListener = null;
const taskDisclosureDetails = {
  dataset: { taskDisclosureKey: 'unified-task-card-run:technical' }, open: false,
  addEventListener: (type, listener) => { if (type === 'toggle') taskDisclosureToggleListener = listener; },
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => selector === '[data-task-disclosure-key]' ? [taskDisclosureDetails] : [],
});
assert.equal(typeof taskDisclosureToggleListener, 'function');
taskDisclosureToggleListener();
assert.equal(state.taskDisclosureOpenByKey['unified-task-card-run:technical'], false);
assert.doesNotMatch(renderMessageList(), /data-task-disclosure-key="unified-task-card-run:technical" open/);
state.taskDisclosureOpenByKey = {};

state.messages = [{
  id: 'ubuddy-clarification-message', role: 'assistant',
  content: '你说的“原始人物”具体是指哪一类？\n1. 原始人类\n2. 原创人物（OC）\n3. 某位具体人物',
  metadata: {
    dispatchClarification: true,
    clarification: {
      question: '你说的“原始人物”具体是指哪一类？',
      options: ['原始人类', '原创人物（OC）', '某位具体人物'],
    },
  },
}];
const clarificationMarkup = renderMessageList();
assert.match(clarificationMarkup, /ubuddy-clarification-card is-pending/);
assert.match(clarificationMarkup, /原创人物（OC）/);
assert.match(clarificationMarkup, /其他答案/);
assert.match(clarificationMarkup, /data-ubuddy-clarification-other/);
assert.match(clarificationMarkup, /确认并继续/);
assert.match(clarificationMarkup, /<fieldset class="ubuddy-clarification-question"/);
assert.match(clarificationMarkup, /<legend><small>问题 1<\/small><strong>你说的“原始人物”具体是指哪一类？<\/strong><\/legend><div class="chat-user-input-options">/);
state.uBuddyClarificationDrafts = {
  'ubuddy-clarification-message': { selectedValue: '__other__', text: '中文输入草稿' },
};
const clarificationDraftMarkup = renderMessageList();
assert.match(clarificationDraftMarkup, /id="ubuddy-clarification-input-ubuddy-clarification-message"/);
assert.match(clarificationDraftMarkup, /value="__other__" checked/);
assert.match(clarificationDraftMarkup, /中文输入草稿/);

state.uBuddyFeatureFlags = { ...(state.uBuddyFeatureFlags || {}), messageModeV1: true };
state.uBuddyMessageMode = 'ask';
state.messages.push({
  id: 'ubuddy-ask-side-question', role: 'user', content: '顺便解释一下验收标准。',
  metadata: { uBuddyMessageMode: 'ask' },
});
const askClarificationMarkup = renderMessageList();
assert.match(askClarificationMarkup, /ubuddy-clarification-card is-pending/,
  'an Ask side question must not visually resolve a pending Task clarification');
assert.match(askClarificationMarkup, /button type="submit" disabled>确认并继续/,
  'Task clarification submission must be disabled while Ask mode is selected');
assert.match(askClarificationMarkup, /title="当前为讨论模式，切换到任务模式后可操作"/);
state.uBuddyMessageMode = 'task';

let clarificationSubmitListener = null;
const clarificationSubmitButton = { disabled: false, textContent: '' };
const clarificationForm = {
  dataset: { ubuddyClarificationForm: 'ubuddy-clarification-message' },
  addEventListener: (type, listener) => { if (type === 'submit') clarificationSubmitListener = listener; },
  querySelectorAll: () => [],
  querySelector: (selector) => ({
    'input[type="radio"]:checked': { value: '原创人物（OC）' },
    '[data-ubuddy-clarification-error]': { hidden: true, textContent: '' },
    'button[type="submit"]': clarificationSubmitButton,
  })[selector] || null,
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => selector === '[data-ubuddy-clarification-form]' ? [clarificationForm] : [],
});
assert.equal(typeof clarificationSubmitListener, 'function');
await clarificationSubmitListener({ preventDefault() {} });
assert.equal(submittedClarificationAnswer, '原创人物（OC）');
state.messages.push({
  id: 'ubuddy-clarification-answer', role: 'user', content: submittedClarificationAnswer,
  metadata: {
    uBuddyClarificationResponse: true,
    sourceMessageId: 'ubuddy-clarification-message',
    uBuddyClarificationAnswers: [{ questionId: 'clarification_1', value: submittedClarificationAnswer }],
  },
});
const resolvedClarificationMarkup = renderMessageList();
assert.match(resolvedClarificationMarkup, /ubuddy-clarification-card is-resolved/);
assert.match(resolvedClarificationMarkup, /已接收答案/);
assert.match(resolvedClarificationMarkup, /已确认/);
assert.doesNotMatch(resolvedClarificationMarkup, /message user[^>]*data-message-id="ubuddy-clarification-answer"/,
  'a structured clarification response must stay in the confirmation card instead of rendering as a user bubble');
assert.doesNotMatch(resolvedClarificationMarkup, /data-ubuddy-clarification-form/);

state.messages = [{
  id: 'ubuddy-execution-target-message', role: 'assistant', content: '请选择任务执行方。',
  metadata: {
    dispatchClarification: true,
    clarifications: [{
      id: 'executionTarget', answerType: 'execution_target',
      question: '这项任务尚未指定 Agent 或联系人，请选择完成方式。',
      options: [{ label: '本地完成' }, { label: '@ 联系人完成' }], allowOther: false, required: true,
    }],
  },
}];
state.languageMode = 'zh-CN';
const executionTargetMarkup = renderMessageList();
assert.match(executionTargetMarkup, /ubuddy-execution-target-card/);
assert.match(executionTargetMarkup, /data-ubuddy-execution-target="local"/);
assert.match(executionTargetMarkup, /data-ubuddy-execution-target="contact"/);
assert.match(executionTargetMarkup, /本地完成/);
assert.match(executionTargetMarkup, /@ 联系人完成/);
assert.doesNotMatch(executionTargetMarkup, /data-ubuddy-clarification-form/,
  'execution target choice must use direct actions instead of the generic clarification form');
let contactTargetListener = null;
const contactTargetButton = {
  disabled: false, dataset: { ubuddyExecutionTarget: 'contact' },
  addEventListener: (type, listener) => { if (type === 'click') contactTargetListener = listener; },
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => selector === '[data-ubuddy-execution-target]' ? [contactTargetButton] : [],
});
assert.equal(typeof contactTargetListener, 'function');
await contactTargetListener();
assert.equal(contactPickerOpened, true, 'contact execution choice must open the structured contact picker');
state.languageMode = 'en';
const englishExecutionTargetMarkup = renderMessageList();
assert.match(englishExecutionTargetMarkup, /Complete locally/);
assert.match(englishExecutionTargetMarkup, /Complete with a contact/);
assert.match(englishExecutionTargetMarkup, /No task has been created/);
state.languageMode = 'zh-CN';

state.messages = [{
  id: 'ubuddy-mode-choice-message', role: 'assistant', content: '请选择执行方式。',
  metadata: {
    uBuddyExecutionModeChoice: {
      version: 'ubuddy_execution_mode_choice_v1', choiceId: 'choice-1', status: 'pending',
      recommendedMode: 'scheduler', routingRationale: '两种执行方式都可行。',
      directModeSummary: '由 uBuddy 一次完成。', schedulerModeSummary: '拆分任务并审核。',
    },
  },
}];
const modeChoiceMarkup = renderMessageList();
assert.match(modeChoiceMarkup, /ubuddy-execution-mode-card is-pending/);
assert.match(modeChoiceMarkup, /data-ubuddy-execution-mode="direct"/);
assert.match(modeChoiceMarkup, /data-ubuddy-execution-mode="scheduler"/);
assert.match(modeChoiceMarkup, /推荐/);
assert.doesNotMatch(modeChoiceMarkup, /其他答案/);
state.uBuddyMessageMode = 'ask';
const askModeChoiceMarkup = renderMessageList();
assert.match(askModeChoiceMarkup, /data-ubuddy-execution-mode="direct"[^>]*disabled/);
assert.match(askModeChoiceMarkup, /data-ubuddy-execution-mode="scheduler"[^>]*disabled/);
assert.match(askModeChoiceMarkup, /data-ubuddy-task-actions-disabled="true"/);
state.uBuddyMessageMode = 'task';
let modeChoiceClickListener = null;
const modeButtons = [];
const modeCard = {
  querySelectorAll: () => modeButtons,
  querySelector: () => ({ hidden: true, textContent: '' }),
};
const modeButton = {
  dataset: { ubuddyExecutionMode: 'scheduler', ubuddyExecutionChoiceId: 'choice-1' }, disabled: false,
  addEventListener: (type, listener) => { if (type === 'click') modeChoiceClickListener = listener; },
  closest: () => modeCard,
};
modeButtons.push(modeButton);
controller.wireMessageEvents({
  querySelectorAll: (selector) => selector === '[data-ubuddy-execution-mode]' ? [modeButton] : [],
});
assert.equal(typeof modeChoiceClickListener, 'function');
await modeChoiceClickListener();
assert.equal(submittedClarificationAnswer, '使用多 Agent 协作');
assert.deepEqual(submittedClarificationContext.executionModeChoice, { choiceId: 'choice-1', mode: 'scheduler' });

state.messages = [{
  id: 'ubuddy-planning-failure-message', role: 'assistant', content: 'uBuddy 暂时未能生成多人分工方案。',
  metadata: {
    uBuddyCollaborationPlanningFailure: {
      version: 1, status: 'retryable', proposalId: 'proposal-failed', revision: 1,
      code: 'collaboration_assignment_timeout', stage: 'execute', attemptCount: 2,
    },
  },
}];
const planningFailureMarkup = renderMessageList();
assert.match(planningFailureMarkup, /ubuddy-collaboration-planning-failure is-retryable/);
assert.match(planningFailureMarkup, /data-ubuddy-planning-failure-action="重新生成分工方案"/);
assert.match(planningFailureMarkup, /data-ubuddy-planning-failure-action="取消本次协作"/);
assert.doesNotMatch(planningFailureMarkup, /data-ubuddy-clarification-form/);
state.uBuddyMessageMode = 'ask';
const askPlanningFailureMarkup = renderMessageList();
assert.match(askPlanningFailureMarkup, /data-ubuddy-planning-failure-action="重新生成分工方案" disabled/);
assert.match(askPlanningFailureMarkup, /data-ubuddy-planning-failure-action="取消本次协作" disabled/);
assert.match(askPlanningFailureMarkup, /title="当前为讨论模式，切换到任务模式后可操作"/);
state.uBuddyMessageMode = 'task';
let planningFailureActionListener = null;
const planningFailureButton = {
  dataset: { ubuddyPlanningFailureAction: '重新生成分工方案' },
  disabled: false,
  textContent: '重新生成方案',
  addEventListener: (type, listener) => { if (type === 'click') planningFailureActionListener = listener; },
  closest: () => ({ dataset: { messageId: 'ubuddy-planning-failure-message' } }),
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => selector === '[data-ubuddy-planning-failure-action]' ? [planningFailureButton] : [],
});
assert.equal(typeof planningFailureActionListener, 'function');
await planningFailureActionListener();
assert.ok(['重新生成分工方案', 'Retry plan'].includes(submittedClarificationAnswer));

state.messages = [{
  id: 'ubuddy-collaboration-plan-message', role: 'assistant', content: '请确认多人分工方案。',
  metadata: {
    uBuddyCollaborationPlan: {
      status: 'awaiting_confirmation', collaborationMode: 'manager_delegation',
      assignments: [{ assignmentId: 'assignment-1', assigneeKind: 'user', userId: 'user-1', title: '整理资料' }],
    },
  },
}];
state.uBuddyMessageMode = 'ask';
const askCollaborationPlanMarkup = renderMessageList();
assert.match(askCollaborationPlanMarkup, /data-ubuddy-plan-action="确认派发" disabled/);
assert.match(askCollaborationPlanMarkup, /data-ubuddy-plan-action="全员参与" disabled/);
assert.match(askCollaborationPlanMarkup, /data-ubuddy-plan-action="取消方案" disabled/);
assert.match(askCollaborationPlanMarkup, /data-ubuddy-task-actions-disabled="true"/);
state.uBuddyMessageMode = 'task';
const taskCollaborationPlanMarkup = renderMessageList();
assert.doesNotMatch(taskCollaborationPlanMarkup, /data-ubuddy-plan-action="确认派发" disabled/);

state.tasks = [{ id: 'history-task', title: '历史分页任务', departmentId: 'general' }];
state.agentStatuses = [];
state.taskDetail = {
  id: 'history-task', title: '历史分页任务', departmentId: 'general', status: 'failed', metadata: {}, nodes: [], communications: [],
  events: Array.from({ length: 15 }, (_, index) => ({
    id: `history-event-${index}`, eventType: index === 1 ? 'node_activity' : 'node_progress',
    status: index === 14 ? 'failed' : 'completed', summary: index === 0 ? '最早完整记录' : `记录 ${index}`,
    command: index === 1 ? 'pwd' : '', output: index === 1 ? '/tmp' : '', payload: index === 1
      ? { activityType: 'command' }
      : index === 2
        ? { activityType: 'reasoning', reasoningText: '持久化 reasoning 详情', protocolEvents: [{ method: 'item/reasoning/textDelta' }] }
        : { activityType: 'reasoning' },
  })),
};
state.collaborationEventHistoryOpenByTaskId = {};
const collapsedHistoryHtml = renderTasks();
assert.match(collapsedHistoryHtml, /展开更早的 7 条记录/);
assert.doesNotMatch(collapsedHistoryHtml, /最早完整记录/);
state.collaborationEventHistoryOpenByTaskId = { 'history-task': true };
const expandedHistoryHtml = renderTasks();
assert.match(expandedHistoryHtml, /最早完整记录/);
assert.match(expandedHistoryHtml, /已执行 1 项操作/);
assert.match(expandedHistoryHtml, /<code>pwd<\/code>/);
assert.doesNotMatch(expandedHistoryHtml, /持久化 reasoning 详情/);
assert.doesNotMatch(expandedHistoryHtml, /item\/reasoning\/textDelta/);

state.activeTaskWorkspaceKind = 'task_run';
state.activeTaskWorkspaceId = 'history-task';
state.taskWorkspaceLoadingById = { 'history-task': true };
state.taskWorkspaceViewById = { 'history-task': 'activity' };
state.taskRunWorkspaceMessagesById = { 'history-task': [] };
const syncingWorkspaceHtml = renderCollaboration();
assert.match(syncingWorkspaceHtml, /正在同步/);
assert.match(syncingWorkspaceHtml, /保留已有动态/);
assert.match(syncingWorkspaceHtml, /最早完整记录/,
  'refreshing a populated task workspace must keep its existing activity stream visible');
assert.doesNotMatch(syncingWorkspaceHtml, /<strong>正在读取任务数据<\/strong>/,
  'a populated task workspace must not be replaced by the initial loading placeholder');
state.activeTaskWorkspaceKind = '';
state.activeTaskWorkspaceId = '';
state.taskWorkspaceLoadingById = {};

const workspaceState = {
  sessions: [{ id: 'ubuddy-workspace-session', departmentId: 'secretary_department', writeState: 'writable', projectId: '', workspaceRoot: '' }],
  projects: [{ id: 'project-a', workspaceRoot: '/tmp/project-a' }],
  currentSessionId: '', currentChatKey: '', secretarySessionId: 'ubuddy-workspace-session', homeMode: 'department',
  sidebarMode: 'root', activeProjectId: '', workspaceRoot: '/tmp/stale-task-group-workspace', workspaceDetached: true,
  networkConversationPeerId: '', networkConversationGroupId: '', networkConversationMessages: [], collaborationGroupId: '',
  collaborationGroupDetail: null, chatDraft: '', attachments: [], composerMentions: [], secretaryMentions: [],
  modelMenuOpen: false, imageModelMenuOpen: false, pptTemplateMenuOpen: false, pptStyleMenuOpen: false,
  agentMenuOpen: false, friendOverview: {},
};
const workspaceApi = {
  ensureSecretarySession: async () => workspaceState.sessions[0],
  listMessages: async () => [], chatContextStatus: async () => null,
  friendsOverview: async () => ({}), listAgentDeliveryRuns: async () => [],
  collaborationWorkspaceMessages: async () => [], delegationTaskMemory: async () => null,
};
const workspaceController = createNetworkWorkspaceController({
  api: workspaceApi, state: workspaceState, render: () => {}, notify: () => {}, userErrorMessage: String,
  preserveChatDraftFromInput: () => '', focusChatInputAtEnd: () => {}, refreshSocialInbox: async () => {},
  refreshAgentDelegations: async () => {}, refreshSocialThreads: async () => {}, refreshCollaborationOverview: async () => {},
  socialTaskGroups: () => [], socialTaskGroupById: () => null, latestSocialTaskGroup: () => null, socialTaskGroupType: 'task',
  scrollMessagesToBottom: () => {}, readyAttachmentsForSend: async () => [], currentModelValue: () => '',
  currentReasoningValue: () => '', persistComposerDrafts: () => {}, focusActiveComposerInput: () => {},
  materializeCollaborationFile: async () => {}, isCurrentUserAdmin: () => false, windowRef: {},
  documentRef: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  noteDirectoryGroups: () => {}, currentChatRun: () => null, syncCurrentChatRun: () => {},
  restoreActiveRunTransient: () => {}, restorePersistentDeliveryRuns: () => {},
});
await workspaceController.openUBuddyConversation();
assert.equal(workspaceState.workspaceRoot, '', 'personal uBuddy must clear stale non-project workspace state');
assert.equal(workspaceState.activeProjectId, '');
assert.equal(workspaceState.workspaceDetached, false);

workspaceState.sidebarMode = 'project';
workspaceState.activeProjectId = 'project-a';
workspaceState.workspaceRoot = '/tmp/stale-task-group-workspace';
await workspaceController.openUBuddyConversation();
assert.equal(workspaceState.workspaceRoot, '/tmp/project-a', 'explicit project uBuddy context must remain selected');
assert.equal(workspaceState.activeProjectId, 'project-a');

workspaceState.currentTab = 'chat';
workspaceState.currentChatKey = 'collaboration:group-task-navigation';
workspaceState.networkPanelOpen = false;
workspaceState.networkPanelView = 'messages';
workspaceState.networkMessageHomeOpen = false;
workspaceState.collaborationGroupId = 'group-task-navigation';
workspaceState.collaborationGroupDetail = {
  group: { id: 'group-task-navigation', title: '任务导航验证群' },
  tasks: [{ id: 'delegation-task-navigation', title: '验证查看任务', status: 'running', metadata: {} }],
  messages: [],
};
workspaceState.collaborationOverview = {
  groups: [],
  tasks: workspaceState.collaborationGroupDetail.tasks,
};
await workspaceController.openNetworkDelegation('delegation-task-navigation');
assert.equal(workspaceState.collaborationGroupId, '', 'opening a task from a work group must leave the group surface');
assert.equal(workspaceState.networkDelegationId, 'delegation-task-navigation');
assert.equal(workspaceState.activeTaskWorkspaceKind, 'delegation');
assert.equal(workspaceState.taskWorkspaceReturnContext?.collaborationGroupId, 'group-task-navigation',
  'task navigation must retain the source group for the back action');
await workspaceController.returnToTaskSourceChat();
assert.equal(workspaceState.collaborationGroupId, 'group-task-navigation', 'the task back action must restore the source group');

const publicProgress = normalizeDelegationExecutionProgress({
  version: 1,
  phase: 'executing',
  message: '正在读取 /home/alice/private/project/report.md',
  completed: 1,
  total: 2,
  nodes: [{
    id: 'node-public', title: '整理 /Users/alice/private.docx', agentName: '文档 Agent', status: 'running',
    summary: '命令详情 /tmp/private-command.log', attemptCount: 1, maxAttempts: 3,
    startedAt: '2026-08-12T09:00:00.000Z', updatedAt: '2026-08-12T09:05:00.000Z',
  }],
  milestones: [{
    key: 'node-public:running', status: 'running', title: '整理文档', detail: '处理 /var/folders/private/output',
    eventType: 'node_running', sequence: 4, occurredAt: '2026-08-12T09:05:00.000Z',
  }],
  blocker: { nodeId: 'node-public', summary: '等待 /opt/private/input', suggestedNextStep: '稍后重试' },
});
assert.equal(publicProgress.version, 2);
assert.equal(publicProgress.nodes.length, 1);
assert.equal(publicProgress.milestones.length, 1);
assert.equal(publicProgress.nodes[0].startedAt, '2026-08-12T09:00:00.000Z');
assert.equal(publicProgress.nodes[0].updatedAt, '2026-08-12T09:05:00.000Z');
assert.equal(publicProgress.milestones[0].eventType, 'node_running');
assert.equal(publicProgress.milestones[0].sequence, 4);
assert.equal(publicProgress.milestones[0].occurredAt, '2026-08-12T09:05:00.000Z');
assert.ok(publicProgress.blocker);
assert.doesNotMatch(JSON.stringify(publicProgress), /home\/alice|Users\/alice|tmp\/private|var\/folders|opt\/private/);
const publicMetadata = publicDelegationMetadata({
  executionProgress: publicProgress,
  activeTaskRunId: 'private-run-id',
  executionFailureDetail: 'private diagnostics',
});
assert.equal(publicMetadata.executionProgress.version, 2);
assert.equal(publicMetadata.activeTaskRunId, undefined);
assert.equal(publicMetadata.executionFailureDetail, undefined);

const waitingProgress = normalizeDelegationExecutionProgress({
  phase: 'waiting',
  lifecyclePhase: 'confirming',
  message: '等待接收方补充信息',
  blocker: { summary: '请补充可核实的工作记录', userActionRequired: true },
});
assert.equal(waitingProgress.phase, 'waiting', 'clarification waits must not fall back to preparing');
assert.equal(waitingProgress.blocker.userActionRequired, true);

state.currentTab = 'chat';
state.chatGroupId = '';
state.collaborationGroupId = '';
state.networkConversationPeerId = '';
state.networkConversationGroupId = '';
state.networkPanelOpen = false;
state.currentSessionId = 'employee-active-work-session';
state.currentChatKey = 'session:employee-active-work-session';
state.currentAgentInstanceId = 'employee-active-work-agent';
state.sessions = [{
  id: 'employee-active-work-session', title: '通用 Agent 对话', departmentId: 'general', agentId: 'general_agent',
  agentInstanceId: 'employee-active-work-agent', status: 'active', writeState: 'writable',
}];
state.messages = [{ id: 'employee-active-work-message', role: 'assistant', content: '我正在继续处理任务。' }];
state.employeeConversationOverviewByInstanceId = {
  'employee-active-work-agent': {
    activeWork: {
      route: 'task_run', taskRunId: 'employee-active-task', title: '中国环境 PPT', status: 'running',
      currentAction: '正在核对页面布局', updatedAt: '2026-08-05T10:00:00.000Z',
      progress: { completed: 1, total: 4, percent: 25 },
      nodes: [{ id: 'layout-node', title: '调整图表布局', status: 'running' }],
      recentEvents: [{ id: 'layout-event', summary: '已完成封面排版', status: 'completed', createdAt: '2026-08-05T09:59:00.000Z' }],
    },
    taskQueue: { count: 2, taskRunIds: ['next-task-a', 'next-task-b'] },
    historyGroups: [], historySessions: [],
  },
};
const employeeActiveWorkMarkup = renderChat();
assert.match(employeeActiveWorkMarkup, /aria-label="Agent 当前工作"/);
assert.match(employeeActiveWorkMarkup, /data-employee-active-work="employee-active-work-agent"/);
assert.match(employeeActiveWorkMarkup, /data-employee-active-work-toggle="employee-active-work-agent"/);
assert.match(employeeActiveWorkMarkup, /aria-expanded="true"/);
assert.match(employeeActiveWorkMarkup, /中国环境 PPT/);
assert.match(employeeActiveWorkMarkup, /调整图表布局/);
assert.match(employeeActiveWorkMarkup, /任务进度/);
assert.match(employeeActiveWorkMarkup, /1\/4 节点 · 25%/);
assert.match(employeeActiveWorkMarkup, /style="width:25%"/);
assert.match(employeeActiveWorkMarkup, /后续 2 个任务/);
assert.match(employeeActiveWorkMarkup, /class="conversation-top-stack"/);
state.employeeActiveWorkCollapsedByInstanceId = { 'employee-active-work-agent': true };
const collapsedEmployeeWorkMarkup = renderChat();
assert.match(collapsedEmployeeWorkMarkup, /employee-conversation-active-work is-collapsed/);
assert.match(collapsedEmployeeWorkMarkup, /任务信息已折叠，展开后可查看进度和执行详情。/);
assert.match(collapsedEmployeeWorkMarkup, /aria-expanded="false"/);
assert.doesNotMatch(collapsedEmployeeWorkMarkup, /class="employee-conversation-work-nodes"/);
state.languageMode = 'en';
const englishCollapsedEmployeeWorkMarkup = renderChat();
assert.match(englishCollapsedEmployeeWorkMarkup, /Task information is collapsed\. Expand it to view progress and execution details\./);
assert.match(englishCollapsedEmployeeWorkMarkup, /Open Task Workspace/);
state.languageMode = 'zh-CN';
state.employeeActiveWorkCollapsedByInstanceId = {};

state.employeeConversationOverviewByInstanceId['employee-active-work-agent'].activeWork = {
  ...state.employeeConversationOverviewByInstanceId['employee-active-work-agent'].activeWork,
  status: 'verifying', currentStage: 'verifying',
};
assert.match(renderChat(), /<em>验证中<\/em>/);
state.employeeConversationOverviewByInstanceId['employee-active-work-agent'].activeWork = {
  ...state.employeeConversationOverviewByInstanceId['employee-active-work-agent'].activeWork,
  status: 'delivering', currentStage: 'delivering',
};
assert.match(renderChat(), /<em>交付中<\/em>/);

state.currentSessionId = 'ubuddy-task-strip-session';
state.currentChatKey = 'session:ubuddy-task-strip-session';
state.homeMode = 'secretary';
state.networkPanelView = 'messages';
state.networkMessageHomeOpen = false;
state.sessions = [{ id: 'ubuddy-task-strip-session', departmentId: 'secretary_department', title: 'uBuddy' }];
state.currentUser = { id: 'self-user', role: 'user' };
state.messages = [{
  id: 'task-strip-source-message', role: 'assistant', content: '任务已进入执行。',
  metadata: { uBuddyTaskQueued: true, taskRunId: 'task-strip-running' },
}];
state.tasks = [{
  id: 'task-strip-running', title: '整理调研并制作 PPT', status: 'running', createdAt: '2026-08-06T10:00:00.000Z', updatedAt: '2026-08-06T10:05:00.000Z',
  metadata: { sourceSecretarySessionId: 'ubuddy-task-strip-session', sourceSecretaryMessageId: 'task-strip-source-message' },
}, {
  id: 'task-strip-retry', title: '导出最终文件', status: 'running', createdAt: '2026-08-06T10:01:00.000Z', updatedAt: '2026-08-06T10:06:00.000Z',
  metadata: { sourceSecretarySessionId: 'ubuddy-task-strip-session', backgroundRecovery: { attemptCount: 2, maxAttempts: 3 } },
}];
state.uBuddyTaskViewsById = {
  'task-strip-running': {
    ...state.tasks[0],
    nodes: [{ id: 'research-node', title: '整理竞品结论', status: 'running' }, { id: 'ppt-node', title: '制作 PPT', status: 'pending' }],
  },
  'task-strip-retry': {
    ...state.tasks[1],
    nodes: [{ id: 'export-node', title: '导出最终文件', status: 'retry_wait', attemptCount: 2, maxAttempts: 3, nextRetryAt: '2026-08-06T10:07:00.000Z' }],
  },
};
state.uBuddyTaskStripOpenBySessionId = { 'ubuddy-task-strip-session': true };
state.uBuddyTaskDrawerOpenBySessionId = { 'ubuddy-task-strip-session': true };
state.uBuddyTaskStripFilterBySessionId = { 'ubuddy-task-strip-session': 'all' };
const taskStripMarkup = renderUBuddyTaskStrip();
assert.match(taskStripMarkup, /待我处理/);
assert.match(taskStripMarkup, /等待对方/);
assert.match(taskStripMarkup, /进行中/);
assert.match(taskStripMarkup, /data-ubuddy-task-drawer-toggle/);
const taskDrawerMarkup = renderUBuddyTaskDrawer();
assert.match(taskDrawerMarkup, /整理调研并制作 PPT/);
assert.match(taskDrawerMarkup, /导出最终文件/);
assert.match(taskDrawerMarkup, /等待自动重试/);
assert.match(taskDrawerMarkup, /停止整个任务/);

state.uBuddyDeliveryCenterPage = { counts: { pending: 3 }, items: [], nextCursor: '', total: 3 };
state.networkPanelOpen = false;
state.networkMessageHomeOpen = false;
const uBuddyTopbar = renderTopbar();
assert.match(uBuddyTopbar, /data-ubuddy-center-open="tasks"/);
assert.match(uBuddyTopbar, />全部任务</);
assert.match(uBuddyTopbar, /data-ubuddy-center-open="deliveries"/);
assert.match(uBuddyTopbar, />交付中心</);
assert.match(uBuddyTopbar, /<b>3<\/b>/);
assert.doesNotMatch(renderChat(), /data-ubuddy-task-strip-host|data-ubuddy-task-drawer-host/,
  'the old task strip must not duplicate the new top-right centers');

state.uBuddyCenterOpen = 'tasks';
state.uBuddyTaskCenterFilter = 'all';
state.uBuddyTaskCenterPage = {
  counts: { all: 2, needs_action: 1, active: 1, waiting: 0, closed: 0 }, nextCursor: 'next-page', total: 2,
  items: [{ id: 'center-local', kind: 'task_run', taskRunId: 'center-local', title: '整理技术报告', summary: '生成 Word 与 Markdown。', group: 'needs_action', actor: 'uBuddy', progress: { completed: 2, total: 2 }, updatedAt: '2026-08-12T16:40:00.000Z' }, { id: 'center-delegation', kind: 'delegation', delegationId: 'center-delegation', title: '联系人调研', summary: '等待对方整理材料。', group: 'active', actor: '联系人 uBuddy', updatedAt: '2026-08-12T16:20:00.000Z' }],
};
const taskCenterMarkup = renderUBuddyCenterDrawer();
assert.match(taskCenterMarkup, /全部任务/);
assert.match(taskCenterMarkup, /整理技术报告/);
assert.match(taskCenterMarkup, /联系人调研/);
assert.match(taskCenterMarkup, /data-ubuddy-center-more/);
assert.match(taskCenterMarkup, /data-ubuddy-task-center-search/);
assert.match(taskCenterMarkup, /data-task-card-action="open_workspace"[^>]*data-task-workspace-id="center-local"/,
  'all tasks must open task details even when the task needs owner action');
assert.doesNotMatch(taskCenterMarkup, /data-task-card-action="open_result"[^>]*data-task-workspace-id="center-local"/);

state.uBuddyCenterOpen = 'deliveries';
state.uBuddyDeliveryCenterFilter = 'pending';
state.uBuddyDeliveryCenterPage = {
  counts: { pending: 1, accepted: 2, revision_requested: 1 }, nextCursor: '', total: 1,
  items: [{ id: 'delivery-center-local', kind: 'task_run', taskRunId: 'delivery-center-local', submissionId: 'submission-center', versionNo: 2, status: 'pending', title: '2026年图像检测技术发展报告', summary: '报告已完成。', fileCount: 2, actor: 'uBuddy', submittedAt: '2026-08-12T16:40:00.000Z' }],
};
const deliveryCenterMarkup = renderUBuddyCenterDrawer();
assert.match(deliveryCenterMarkup, /交付中心/);
assert.match(deliveryCenterMarkup, /待审核/);
assert.match(deliveryCenterMarkup, /已验收/);
assert.match(deliveryCenterMarkup, /已打回/);
assert.match(deliveryCenterMarkup, /版本 2 · 2 个文件/);
assert.match(deliveryCenterMarkup, /data-delivery-submission-id="submission-center"/,
  'delivery history rows must identify the version that should be expanded');
assert.match(deliveryCenterMarkup, /aria-modal="false"/);
state.uBuddyCenterOpen = '';

const pendingTask = {
  id: 'task-strip-action', title: '补充验收信息', status: 'waiting',
  metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: 'ubuddy-task-strip-session', requiresUserAction: true },
};
state.tasks = [...state.tasks, pendingTask];
state.uBuddyTaskViewsById = { ...state.uBuddyTaskViewsById, [pendingTask.id]: { ...pendingTask, summary: 'hydrated duplicate' } };
assert.equal(uBuddyTaskDisplayStatus(pendingTask).group, 'needs_my_action');
const localDeliveryTask = {
  id: 'local-delivery', status: 'completed',
  metadata: { source: 'ubuddy_dispatch', finalDelivery: { state: 'delivered' } },
};
const externalDeliveryTask = {
  id: 'external-delivery', status: 'completed', recipientUserId: 'self-user',
  metadata: { source: 'ubuddy_dispatch', taskOrigin: 'external_delegation', finalDelivery: { state: 'delivered' } },
};
assert.equal(uBuddyTaskDisplayStatus(localDeliveryTask, { currentUserId: 'self-user' }).group, 'needs_my_action');
assert.equal(uBuddyTaskDisplayStatus(externalDeliveryTask, { currentUserId: 'self-user' }).group, 'waiting_counterparty');
assert.equal(uBuddyPendingTaskCount({ tasks: state.tasks, taskViewsById: state.uBuddyTaskViewsById }), 1,
  'uBuddy pending count must deduplicate task list and hydrated task views');
assert.equal(uBuddyPendingTaskCount({
  tasks: [{ ...pendingTask, id: 'unrelated-action', metadata: { requiresUserAction: true } }],
}), 0, 'pending tasks outside uBuddy must not contribute to its badge');
state.networkPanelView = 'messages';
state.networkMessageHomeOpen = true;
const pendingShortcutMarkup = renderNetworkPanel();
assert.match(pendingShortcutMarkup, /data-network-peer="self-secretary"[^>]*has-pending|has-pending[^>]*data-network-peer="self-secretary"/);
assert.match(pendingShortcutMarkup, /data-ubuddy-pending-badge[^>]*>1<\/small>/);
assert.match(pendingShortcutMarkup, state.languageMode === 'en'
  ? /aria-label="uBuddy, 1 item needs your attention"/
  : /aria-label="uBuddy，有 1 条待处理"/);

const taskStripTasks = state.tasks;
const taskStripViews = state.uBuddyTaskViewsById;
state.tasks = Array.from({ length: 100 }, (_, index) => ({
  ...pendingTask, id: `task-strip-action-${index}`,
}));
state.uBuddyTaskViewsById = {};
assert.match(renderNetworkPanel(), /data-ubuddy-pending-badge[^>]*>99\+<\/small>/,
  'large pending counts must use a compact 99+ badge');
state.tasks = taskStripTasks;
state.uBuddyTaskViewsById = taskStripViews;

const recoveryMarkup = renderTaskProgressCard({
  taskRunId: 'task-strip-retry', title: '导出最终文件', taskStatus: 'running',
  progress: { total: 1, completed: 0, waiting: 1 }, nodes: state.uBuddyTaskViewsById['task-strip-retry'].nodes,
});
assert.match(recoveryMarkup, /创建/);
assert.match(recoveryMarkup, /第 2\/3 次尝试/);
assert.match(recoveryMarkup, /等待自动重试/);
assert.match(recoveryMarkup, /下次自动重试|系统将在/);

const hydrationState = {
  tasks: [{ id: 'hydrate-task-ok', metadata: { sourceSecretarySessionId: 'hydrate-session' } }, { id: 'hydrate-task-failed', metadata: { sourceSecretarySessionId: 'hydrate-session' } }],
  uBuddyTaskViewsById: {}, uBuddyTaskViewLoadingById: {}, uBuddyTaskViewErrorById: {}, workspaceSwitchGeneration: 7,
};
const hydration = await hydrateUBuddyTaskViews({
  api: { getTask: async (taskRunId) => {
    if (taskRunId === 'hydrate-task-failed') throw new Error('fixture unavailable');
    return { id: taskRunId, title: '补充后的任务详情', status: 'running', nodes: [{ id: 'hydrated-node', status: 'running' }], metadata: { sourceSecretarySessionId: 'hydrate-session' } };
  } },
  state: hydrationState, sessionId: 'hydrate-session', messages: [], workspaceGeneration: 7,
});
assert.equal(hydration.changed, true);
assert.equal(hydrationState.uBuddyTaskViewsById['hydrate-task-ok'].nodes.length, 1);
assert.match(hydrationState.uBuddyTaskViewErrorById['hydrate-task-failed'], /fixture unavailable/);

let capturedMessageView = 0;
let restoredMessageView = 0;
let forcedBottomScroll = 0;
let refreshedTaskViews = 0;
const navigationState = {
  currentSessionId: 'previous-session', currentChatKey: 'session:previous-session', currentTab: 'chat', currentUser: { id: 'nav-user' },
  sessions: [{ id: 'restore-session', title: 'uBuddy', departmentId: 'secretary_department', status: 'active' }],
  projects: [], messages: [], attachments: [], archivedSessions: [], chatSearchResults: [], employeeConversationOverviewByInstanceId: {},
  messagePagination: {}, networkPanelView: 'messages', networkPanelOpen: false, networkMessageHomeOpen: false, messageActivePane: 'conversation',
  workspaceRoot: '', workspaceDetached: false, activeProjectId: '', homeMode: 'secretary', currentDepartmentId: '', currentAgentId: '', currentAgentInstanceId: '',
  sidebarSectionsOpen: {}, interactionMode: '', goalActionBusy: '', composerImageMode: false, taskProgressOpenById: {}, taskDisclosureOpenByKey: {},
  preloadedMessagePagesBySessionId: {
    'restore-session': {
      items: [{ id: 'preloaded-message', role: 'assistant', content: '启动预加载消息。' }],
      nextCursor: null,
      hasMore: false,
    },
  },
};
const navigationRenderMessageIds = [];
const navigationController = createSessionNavigationController({
  state: navigationState, render: () => { navigationRenderMessageIds.push((navigationState.messages || []).map((item) => item.id)); },
  windowRef: { janus: {
    listMessagePage: async () => ({ items: [{ id: 'restored-message', role: 'assistant', content: '任务仍在执行。' }], nextCursor: null, hasMore: false }),
    chatContextStatus: async () => null, listAgentDeliveryRuns: async () => [],
  } },
  documentRef: { getElementById: () => null }, agentDisplayLabels: {}, isLegacyChatDepartmentId: () => false,
  retractNetworkPanelForChat: () => {}, focusChatInputAtEnd: () => {}, projectById: () => null, projectName: () => '', expandProject: () => {},
  notify: () => {}, pathBasename: (value) => value, openUBuddyConversation: async () => {}, closeChatSearch: () => {},
  restoreActiveRunTransient: () => {}, restorePersistentDeliveryRuns: () => {}, resetChatSearchState: () => {}, resolveSelectedAgentId: () => '',
  scrollMessagesToBottom: () => { forcedBottomScroll += 1; }, findSessionById: (id) => navigationState.sessions.find((item) => item.id === id),
  normalizeSearch: String, scheduleChatSearch: () => {}, sessionIsArchived: () => false, saveThemeMode: () => {},
  captureMessageViewState: () => { capturedMessageView += 1; }, restoreMessageViewState: () => { restoredMessageView += 1; return true; },
  refreshUBuddyTaskViewsForSession: async () => { refreshedTaskViews += 1; },
});
await navigationController.openSession('restore-session');
await Promise.resolve();
assert.deepEqual(navigationRenderMessageIds[0], ['preloaded-message'], 'opening a session must render its startup cache before revalidation');
assert.equal(navigationState.messages.at(-1)?.id, 'restored-message', 'fresh data must replace the startup cache after revalidation');
assert.equal(capturedMessageView, 1, 'opening another conversation must save the previous message view');
assert.equal(restoredMessageView, 1, 'returning to a conversation must attempt to restore its saved view');
assert.equal(forcedBottomScroll, 0, 'a restored conversation must not be forced back to the bottom');
assert.equal(refreshedTaskViews, 1, 'opening uBuddy must refresh task views without blocking message rendering');

console.log('renderer uBuddy progress smoke passed');
