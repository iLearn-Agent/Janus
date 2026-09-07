import { strict as assert } from 'node:assert';
import fs from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderChat, renderMessageList } from '../src/renderer/app/views/chatView.js';
import { configureCollaborationView, renderCollaboration, taskFailureDiagnostics } from '../src/renderer/app/views/collaborationView.js';
import { translateUiText } from '../src/renderer/app/i18n.js';
import { renderSidebar, renderTopbar } from '../src/renderer/app/views/navigationView.js';
import { renderNetworkPanel } from '../src/renderer/app/views/networkView.js';
import { renderWindowTitlebar } from '../src/renderer/app/components/overlays.js';

state.currentUser = { id: 'ui-user', username: 'tester', role: 'user' };
state.currentTab = 'collaboration';
state.networkPanelOpen = true;
state.networkPanelView = 'tasks';
state.org = {
  departments: [{ id: 'ppt_department', name: 'PPT部门' }],
  agents: [{ id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department', routable: true }],
  hrs: [],
};
state.sessions = [{
  id: 'ppt-session', title: 'PPT Agent', departmentId: 'ppt_department', agentId: 'ppt',
  agentInstanceId: 'ppt-instance', unreadDeliveryCount: 1, unreadCount: 1, status: 'active', updatedAt: new Date().toISOString(),
}];
state.tasks = [{
  id: 'task-recent', title: 'uBuddy 新建协作任务', status: 'queued', nodeCount: 2, completedNodeCount: 0,
  metadata: { source: 'direct' }, updatedAt: new Date().toISOString(),
}];
state.taskDetail = {
  ...state.tasks[0],
  metadata: {
    source: 'direct', coordinationMode: 'appointed_agent_leader', leadershipPolicyViolation: false,
    leadershipEnforcementMode: 'shadow', taskLeaderSelection: { leadershipEligible: false, assignmentEligibility: { reasons: ['leadership_level_insufficient'] } },
  },
  leadAgentId: 'ppt',
  nodes: [{
    id: 'node-queued', title: 'PPT Agent 回复', objective: '回复你好', agentId: 'ppt', departmentId: 'ppt_department',
    agentInstanceId: 'ppt-instance', status: 'queued', dependencies: [], notify: [], priority: 50, estimatedMinutes: 1,
  }],
  communications: [],
  events: [{ id: 'event-queued', eventType: 'node_queued', summary: '已进入 FIFO', createdAt: new Date().toISOString() }],
};
state.agentStatuses = [{ agentId: 'ppt', status: 'pending', queuedCount: 1 }];
state.friendOverview = { friends: [], requests: { incoming: [], outgoing: [] } };
state.agentDelegations = [];
state.collaborationOverview = { groups: [], tasks: [] };

configureCollaborationView({ agentNameById: (id) => id === 'ppt' ? 'PPT Agent' : id });
const sidebar = renderSidebar();
const panel = renderNetworkPanel();
const collaboration = renderCollaboration();
assert.match(sidebar, /data-network-view="messages"/);
assert.match(panel, /我的协作任务/);
assert.match(panel, /data-local-collaboration-task="task-recent"/);
assert.match(panel, /排队中/);
assert.match(collaboration, /uBuddy 新建协作任务/);
assert.match(collaboration, /排队中/);
assert.match(collaboration, /FIFO/);
assert.match(collaboration, /负责人：PPT Agent/);
assert.doesNotMatch(collaboration, /无需 Agent Leader|平面协调/);
state.uBuddyFeatureFlags = { ...(state.uBuddyFeatureFlags || {}), agentWorkDetailProjection: false };
state.employeeOverview = { roster: [
  { id: 'ppt-instance-a', agentFamilyId: 'ppt', displayName: 'PPT Agent A', family: { name: 'PPT Agent', departmentId: 'ppt_department' } },
  { id: 'ppt-instance-b', agentFamilyId: 'ppt', displayName: 'PPT Agent B', family: { name: 'PPT Agent', departmentId: 'ppt_department' } },
] };
state.taskDetail = {
  ...state.taskDetail,
  nodes: [
    { ...state.taskDetail.nodes[0], id: 'node-instance-a', agentInstanceId: 'ppt-instance-a', status: 'running' },
    { ...state.taskDetail.nodes[0], id: 'node-instance-b', agentInstanceId: 'ppt-instance-b', status: 'blocked' },
  ],
  communications: [{ id: 'same-family-communication', fromAgentId: 'ppt', toAgentId: 'ppt', status: 'open' }],
};
state.tasks = [state.taskDetail];
state.agentStatuses = [{ agentId: 'ppt', status: 'waiting', runningCount: 8, waitingCount: 9, openCommunicationCount: 7 }];
const multiInstanceCollaboration = renderCollaboration();
assert.match(multiInstanceCollaboration, /PPT Agent #1/);
assert.match(multiInstanceCollaboration, /PPT Agent #2/);
assert.equal((multiInstanceCollaboration.match(/1 个等待/g) || []).length, 1,
  'only the blocked instance must show the current task waiting load');
assert.doesNotMatch(multiInstanceCollaboration, /9 个等待|7 个通信/,
  'instance rows must not inherit family-wide load and communication counts');
state.networkPanelView = 'messages';
state.networkMessageHomeOpen = true;
state.socialThreads = [];
state.collaborationOverview = {
  groups: [
    { id: 'workspace-group-duplicate', title: '只显示一次的任务群', workspaceId: 'workspace_personal', updatedAt: '2026-07-31T12:00:00.000Z' },
    { id: 'workspace-group-duplicate', title: '只显示一次的任务群', workspaceId: 'workspace_personal', updatedAt: '2026-07-31T12:00:00.000Z' },
  ],
  tasks: [],
};
const deduplicatedGroupPanel = renderNetworkPanel();
assert.equal((deduplicatedGroupPanel.match(/data-collaboration-group="workspace-group-duplicate"/g) || []).length, 1);
state.activeAccountWorkspace = { id: 'workspace_personal', kind: 'personal', name: '个人空间', role: 'owner' };
state.accountWorkspaces = [
  state.activeAccountWorkspace,
  { id: 'workspace_org_ui', kind: 'organization', name: 'UI 测试组织', role: 'member' },
];
state.accountWorkspaceMenuOpen = true;
const workspaceTitlebar = renderWindowTitlebar();
assert.doesNotMatch(workspaceTitlebar, /data-account-workspace-toggle|account-workspace-help|切换工作空间/);
state.accountWorkspaceMenuOpen = false;
state.accountMenuOpen = true;
state.accountMenuWorkspaceOpen = true;
const accountWorkspaceMenu = renderSidebar();
assert.match(accountWorkspaceMenu, /data-account-workspace-account-toggle/);
assert.match(accountWorkspaceMenu, /data-account-workspace-source="account-menu"/);
assert.match(accountWorkspaceMenu, /UI 测试组织/);
const chatCss = fs.readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
const workspaceUiCss = fs.readFileSync(new URL('../src/renderer/app/core/workspace-ui.css', import.meta.url), 'utf8');
assert.match(chatCss, /[^{}]*\.is-ubuddy-group-human \.message-shell\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none/);
assert.match(chatCss, /[^{}]*\.is-ubuddy-work-request \.message-shell\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none/);
assert.match(workspaceUiCss, /[^{}]*\.is-ubuddy-group-human > \.message-shell\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none/);
assert.match(workspaceUiCss, /[^{}]*\.is-ubuddy-work-request > \.message-shell\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none/);
state.accountMenuOpen = false;
state.accountMenuWorkspaceOpen = false;
state.networkPanelView = 'tasks';
state.collaborationOverview = { groups: [], tasks: [] };
state.activeTaskWorkspaceKind = 'task_run';
state.activeTaskWorkspaceId = 'task-recent';
state.activeTaskSourceContext = { source_conversation_id: 'source-session', source_message_id: 'source-message', task_workspace_id: 'task-recent' };
state.activeTaskReturnAnchorId = 'source-message';
state.activeTaskReturnSurface = 'session';
const localTaskWorkspace = renderCollaboration();
assert.doesNotMatch(localTaskWorkspace, /多 Agent 任务工作区|任务权限/);
assert.match(localTaskWorkspace, /任务详情：[^]*uBuddy 新建协作任务/);
assert.equal(renderTopbar(), '', 'a task delivery workspace must not retain the generic Run Settings topbar');
assert.match(localTaskWorkspace, /data-task-card-action="return_to_source_chat"/);
assert.match(localTaskWorkspace, /class="local-task-workspace-back"[^]*?<span>返回原对话<\/span>/);
assert.match(localTaskWorkspace, /data-task-workspace-view="activity"[^]*?aria-pressed="true"/);
assert.match(localTaskWorkspace, /id="task-run-workspace-form"/);
assert.match(localTaskWorkspace, /class="send-btn" type="submit" title="发送" aria-label="发送"[^>]*><svg/);
assert.doesNotMatch(localTaskWorkspace, /class="send-btn"[^>]*>[^]*?<span>发送<\/span>/);
assert.doesNotMatch(localTaskWorkspace, /local-task-workspace-body[^>]*data-scroll-follow-bottom/);
assert.doesNotMatch(localTaskWorkspace, /network-task-flow-columns/);
assert.doesNotMatch(localTaskWorkspace, /local-task-failure-diagnostics/);
const healthyTaskDetail = state.taskDetail;
state.taskDetail = {
  ...healthyTaskDetail,
  status: 'failed',
  nodes: [
    { id: 'node-other', title: '其他节点', agentId: 'general', status: 'completed', updatedAt: '2026-08-05T00:00:05.000Z' },
    { id: 'node-failed', title: '构建交付物', agentId: 'ppt', status: 'failed', errorText: '节点错误兜底', updatedAt: '2026-08-05T00:00:10.000Z' },
  ],
  events: [
    { id: 'other-command', taskNodeId: 'node-other', eventType: 'node_activity', status: 'completed', command: 'do-not-show', output: 'other', createdAt: '2026-08-05T00:00:01.000Z', payload: { activityType: 'command', status: 'completed', exitCode: 0 } },
    ...['one', 'two', 'three', 'four'].map((name, index) => ({
      id: `failed-command-${name}`, taskNodeId: 'node-failed', eventType: 'node_activity',
      status: name === 'four' ? 'failed' : 'completed', command: `run-${name}`,
      output: name === 'four' ? 'stderr <token>' : `output-${name}`,
      createdAt: `2026-08-05T00:00:0${index + 2}.000Z`, updatedAt: `2026-08-05T00:00:0${index + 2}.500Z`,
      payload: { activityType: 'command', status: name === 'four' ? 'failed' : 'completed', exitCode: name === 'four' ? 17 : 0, cwd: '/tmp/private <dir>' },
    })),
    { id: 'node-failure', taskNodeId: 'node-failed', eventType: 'leader_failure_decision', summary: 'uBuddy 已决定唤醒', createdAt: '2026-08-05T00:00:07.000Z', payload: { failureReport: { summary: '最后报错 <boom>' } } },
    { id: 'after-failure-command', taskNodeId: 'node-failed', eventType: 'node_activity', status: 'completed', command: 'after-failure', output: 'late', createdAt: '2026-08-05T00:00:08.000Z', payload: { activityType: 'command', status: 'completed', exitCode: 0 } },
  ],
};
state.tasks = [state.taskDetail];
const failedDiagnostics = taskFailureDiagnostics(state.taskDetail);
assert.equal(failedDiagnostics.error, '最后报错 <boom>');
assert.equal(failedDiagnostics.node.id, 'node-failed');
assert.deepEqual(failedDiagnostics.commands.map((item) => item.command), ['run-two', 'run-three', 'run-four']);
assert.deepEqual(failedDiagnostics.commands.map((item) => item.exitCode), [0, 0, 17]);
const failedDiagnosticsWorkspace = renderCollaboration();
assert.match(failedDiagnosticsWorkspace, /local-task-failure-diagnostics/);
assert.match(failedDiagnosticsWorkspace, /最后报错 &lt;boom&gt;/);
assert.match(failedDiagnosticsWorkspace, /失败节点：构建交付物/);
assert.match(failedDiagnosticsWorkspace, /报错前最近 3 条命令/);
assert.match(failedDiagnosticsWorkspace, /run-two/);
assert.match(failedDiagnosticsWorkspace, /run-three/);
assert.match(failedDiagnosticsWorkspace, /run-four/);
assert.match(failedDiagnosticsWorkspace, /退出码 17/);
assert.match(failedDiagnosticsWorkspace, /stderr &lt;token&gt;/);
assert.match(failedDiagnosticsWorkspace, /\/tmp\/private &lt;dir&gt;/);
assert.doesNotMatch(failedDiagnosticsWorkspace, /最后报错 <boom>|stderr <token>|\/tmp\/private <dir>/);
assert.equal(translateUiText('报错前最近 3 条命令', 'en'), 'Latest 3 Commands Before the Error');
assert.equal(translateUiText('失败节点：构建交付物', 'en'), 'Failed Node: Task Node');
state.taskDetail = { ...state.taskDetail, events: [], nodes: [{ ...state.taskDetail.nodes[1], errorText: '只有节点错误' }] };
state.tasks = [state.taskDetail];
const fallbackFailureWorkspace = renderCollaboration();
assert.match(fallbackFailureWorkspace, /只有节点错误/);
state.taskDetail = { ...state.taskDetail, events: [], nodes: [], summary: '模型服务连续超时，任务已停止。' };
state.tasks = [state.taskDetail];
const summaryFallbackFailureWorkspace = renderCollaboration();
assert.match(summaryFallbackFailureWorkspace, /local-task-failure-diagnostics/);
assert.match(summaryFallbackFailureWorkspace, /模型服务连续超时，任务已停止。/);
assert.match(fallbackFailureWorkspace, /该失败节点没有可用的命令执行记录/);
state.taskDetail = healthyTaskDetail;
state.tasks = [healthyTaskDetail];
const loadedTaskDetail = state.taskDetail;
state.taskDetail = null;
state.tasks = [];
state.taskWorkspaceViewById = { 'task-recent': 'flow' };
const loadingTaskWorkspace = renderCollaboration();
assert.match(loadingTaskWorkspace, /class="view collaboration-view local-task-workspace"/);
assert.match(loadingTaskWorkspace, /local-task-workspace-loading/);
assert.match(loadingTaskWorkspace, /data-task-workspace-view="flow"[^]*?aria-pressed="true"/);
assert.doesNotMatch(loadingTaskWorkspace, /collab-summary/);
assert.doesNotMatch(loadingTaskWorkspace, /network-task-flow-columns/);
state.taskDetail = loadedTaskDetail;
state.tasks = [loadedTaskDetail];
assert.match(renderCollaboration(), /network-task-flow-columns/);
state.taskWorkspaceViewById = { 'task-recent': 'activity' };
state.taskDisclosureOpenByKey = { 'task-recent:technical': true };
assert.match(renderCollaboration(), /<details class="collaboration-technical-details local-task-technical-details" data-task-disclosure-key="task-recent:technical" open>/);
state.taskDisclosureOpenByKey = {};
const deliveredTask = {
  ...state.taskDetail,
  status: 'completed',
  summary: '交付验收通过。',
  deliveryReview: { state: 'accepted', summary: '正文和交付文件均满足验收要求。' },
  deliverySubmissions: [{ id: 'submission-final', submissionNo: 2, bodySnapshot: '最终正文', artifactManifest: [] }],
  metadata: {
    ...state.taskDetail.metadata,
    source: 'ubuddy_dispatch',
    deliveryReviewState: 'accepted',
    deliveryReviewOutcome: 'ubuddy_model_review',
    selectedDeliverySubmissionId: 'submission-final',
    selectedDeliverySubmissionNo: 2,
    finalDelivery: {
      version: 'final_delivery_policy_v1', state: 'delivered', deliveredAt: '2026-08-05T01:00:00.000Z',
      userConfirmedAt: '', closedAt: '', failedAt: '', failureReason: '', retryable: true,
      retryAttemptCount: 0, lastEventId: 'delivered', processedEventIds: ['delivered'], updatedAt: '2026-08-05T01:00:00.000Z',
    },
    deliverableResult: {
      resultState: 'accepted', validationState: 'passed', title: '最终报告', summary: '已生成可下载报告。',
      selectedSubmissionId: 'submission-final', selectedSubmissionNo: 2,
      files: [{ id: 'delivery-file', name: '最终报告.md', path: '/tmp/final-report.md', size: 1024 }],
    },
  },
};
state.taskDetail = deliveredTask;
state.tasks = [deliveredTask];
state.taskWorkspaceViewById = { 'task-recent': 'result' };
const deliveredWorkspace = renderCollaboration();
assert.match(deliveredWorkspace, /查看交付：[^]*最终报告/);
assert.match(deliveredWorkspace, /交付结果与验收记录/);
assert.match(deliveredWorkspace, /结果已交付 · 等待你确认/);
assert.match(deliveredWorkspace, /质量检查/);
assert.match(deliveredWorkspace, /接受交付并关闭任务/);
assert.match(deliveredWorkspace, /要求修改/);
assert.match(deliveredWorkspace, /data-open-file=/);
assert.match(deliveredWorkspace, /data-save-file=/);
assert.doesNotMatch(deliveredWorkspace, /任务已关闭/);
assert.equal(translateUiText('查看交付：', 'en'), 'View Delivery: ');
assert.equal(translateUiText('交付结果与验收记录', 'en'), 'Delivery Results and Review');
assert.equal(translateUiText('已交付 · 等待发出方验收', 'en'), 'Delivered · Awaiting Requester Review');
state.activeTaskWorkspaceId = 'task-recent-root';
state.taskDetail = {
  ...deliveredTask,
  id: 'task-recent-successor',
  deliverySubmissions: [
    { id: 'submission-history', submissionNo: 1, bodySnapshot: '第一版历史正文', artifactManifest: [{ name: 'history-v1.md', snapshotPath: '/tmp/history-v1.md' }] },
    ...deliveredTask.deliverySubmissions,
  ],
};
state.tasks = [state.taskDetail];
state.taskRunWorkspaceActiveRunById = { 'task-recent-root': 'task-recent-successor' };
state.taskWorkspaceViewById = { 'task-recent-root': 'result' };
state.taskResultSubmissionById = { 'task-recent-root': 'submission-history' };
const historicalDeliveryWorkspace = renderCollaboration();
assert.match(historicalDeliveryWorkspace, /data-delivery-submission-id="submission-history"/);
assert.match(historicalDeliveryWorkspace, /正在查看版本 1/);
assert.match(historicalDeliveryWorkspace, /历史交付快照/);
assert.match(historicalDeliveryWorkspace, /第一版历史正文/);
assert.match(historicalDeliveryWorkspace, /history-v1\.md/);
assert.doesNotMatch(historicalDeliveryWorkspace, /最终报告\.md/);
state.activeTaskWorkspaceId = 'task-recent';
state.taskRunWorkspaceActiveRunById = {};
state.taskWorkspaceViewById = { 'task-recent': 'result' };
state.taskResultSubmissionById = {};
state.taskDetail = deliveredTask;
state.tasks = [deliveredTask];
state.taskDetail = {
  ...deliveredTask,
  metadata: {
    ...deliveredTask.metadata,
    taskOrigin: 'external_delegation',
    delegationId: 'external-delivery-review',
  },
};
state.tasks = [state.taskDetail];
const externalDeliveredWorkspace = renderCollaboration();
assert.match(externalDeliveredWorkspace, /结果已就绪 · 等待接收方交付/);
assert.match(externalDeliveredWorkspace, /data-network-delegation="external-delivery-review"/);
assert.match(externalDeliveredWorkspace, /去委托任务确认交付/);
assert.match(externalDeliveredWorkspace, /发出方验收或打回重做/);
assert.doesNotMatch(externalDeliveredWorkspace, /接受交付并关闭任务/);
assert.doesNotMatch(externalDeliveredWorkspace, /data-accept-delivery-submission=/);
state.agentDelegations = [{ id: 'external-delivery-review', status: 'running' }];
const externalResultBeforeStatusSyncWorkspace = renderCollaboration();
assert.match(externalResultBeforeStatusSyncWorkspace, /去委托任务确认交付/);
assert.match(externalResultBeforeStatusSyncWorkspace, /继续修改后再交付/);
state.agentDelegations = [{ id: 'external-delivery-review', status: 'submitted' }];
const externalSubmittedWorkspace = renderCollaboration();
assert.match(externalSubmittedWorkspace, /已交付 · 等待发出方验收/);
assert.match(externalSubmittedWorkspace, /data-external-delegation-status="submitted"/);
assert.doesNotMatch(externalSubmittedWorkspace, /去委托任务确认交付|继续修改后再交付/);
state.agentDelegations = [{ id: 'external-delivery-review', status: 'submitted', updatedAt: '2026-08-06T01:00:00.000Z' }];
state.collaborationOverview = { groups: [], tasks: [{ id: 'external-delivery-review', status: 'result_accepted', updatedAt: '2026-08-06T01:01:00.000Z' }] };
const externalAcceptedWorkspace = renderCollaboration();
assert.match(externalAcceptedWorkspace, /发出方已确认任务结束/);
assert.doesNotMatch(externalAcceptedWorkspace, /去委托任务确认交付|继续修改后再交付/);
state.collaborationOverview = { groups: [], tasks: [] };
state.agentDelegations = [{ id: 'external-delivery-review', status: 'revision_requested' }];
const externalRevisionWorkspace = renderCollaboration();
assert.match(externalRevisionWorkspace, /发出方已打回 · 等待修改/);
assert.match(externalRevisionWorkspace, /查看打回要求并继续修改/);
state.agentDelegations = [];
state.taskDetail = {
  ...deliveredTask,
  metadata: {
    ...deliveredTask.metadata,
    deliveryRevisionRequestedAt: '2026-08-05T01:00:30.000Z',
    finalDelivery: {
      ...deliveredTask.metadata.finalDelivery, state: 'not_delivered', updatedAt: '2026-08-05T01:00:30.000Z',
    },
  },
};
state.tasks = [state.taskDetail];
const revisionRequestedWorkspace = renderCollaboration();
assert.match(revisionRequestedWorkspace, /已要求修改 · 等待新版本/);
assert.match(revisionRequestedWorkspace, /上一版交付快照/);
assert.doesNotMatch(revisionRequestedWorkspace, /接受交付并关闭任务/);
assert.doesNotMatch(revisionRequestedWorkspace, /任务已关闭/);
state.taskDetail = {
  ...deliveredTask,
  metadata: {
    ...deliveredTask.metadata,
    finalDelivery: {
      ...deliveredTask.metadata.finalDelivery, state: 'closed', userConfirmedAt: '2026-08-05T01:01:00.000Z',
      closedAt: '2026-08-05T01:01:01.000Z', updatedAt: '2026-08-05T01:01:01.000Z',
    },
  },
};
state.tasks = [state.taskDetail];
const closedWorkspace = renderCollaboration();
assert.match(closedWorkspace, /任务已关闭/);
assert.doesNotMatch(closedWorkspace, /接受交付并关闭任务/);
assert.doesNotMatch(closedWorkspace, /data-request-delivery-revision/);
state.taskDetail = {
  ...deliveredTask,
  status: 'failed',
  metadata: {
    ...deliveredTask.metadata,
    finalDelivery: {
      ...deliveredTask.metadata.finalDelivery, state: 'failed', failedAt: '2026-08-05T01:02:00.000Z',
      failureReason: '上传交付文件失败。', retryable: true, updatedAt: '2026-08-05T01:02:00.000Z',
    },
  },
};
state.tasks = [state.taskDetail];
const failedWorkspace = renderCollaboration();
assert.match(failedWorkspace, /上传交付文件失败/);
assert.match(failedWorkspace, /重试交付/);
assert.match(failedWorkspace, /交付文件快照 · 当前交付失败/);
assert.doesNotMatch(failedWorkspace, /已正式交付 · 等待你确认/);
state.taskWorkspaceViewById = {};
state.activeTaskWorkspaceKind = '';
state.activeTaskWorkspaceId = '';
state.activeTaskSourceContext = null;
state.activeTaskReturnAnchorId = '';
state.activeTaskReturnSurface = '';

state.languageMode = 'zh-CN';
state.agentDelegations = [{
  id: 'delegation-blocked', requesterUserId: 'peer-user', recipientUserId: 'ui-user', title: '跨用户交付任务',
  instruction: '生成一份可编辑交付文件', status: 'blocked', lastError: '必要交付物未通过校验。',
  requester: { id: 'peer-user', displayName: '发起人' },
  metadata: { failureCode: 'deliverable_missing', executionFailureDetail: 'PPT Agent 没有生成 PPTX 文件', syncState: 'pending' },
  updatedAt: new Date().toISOString(),
}];
state.networkDelegationId = 'delegation-blocked';
state.networkConversationMessages = [];
const blockedPanel = renderNetworkPanel();
assert.match(blockedPanel, /必要交付物未通过校验/);
assert.match(blockedPanel, /云端同步暂时中断/);
assert.match(blockedPanel, /完全开放重试/);
assert.match(blockedPanel, /AI 自动审查/);
state.pptxPluginStatus = { installed: false, available: true };
state.agentDelegations[0] = {
  ...state.agentDelegations[0],
  metadata: {
    syncState: 'pending',
    failureCode: 'ppt_skill_install_required',
    publicFailure: {
      code: 'ppt_skill_install_required', stage: 'preflight',
      message: '接收方当前设备尚未安装 PPT 制作 Skill，PPT Agent 因此无法执行任务。',
    },
  },
};
const missingPptSkillPanel = renderNetworkPanel();
assert.match(missingPptSkillPanel, /接收方当前设备尚未安装 PPT 制作 Skill/);
assert.match(missingPptSkillPanel, /data-plugin-install="ppt_creation"/);
assert.match(missingPptSkillPanel, /安装 PPT 制作 Skill/);
assert.match(missingPptSkillPanel, /data-open-plugin-settings[^>]*data-plugin-id="ppt_creation"/);
assert.doesNotMatch(missingPptSkillPanel, />重新调度 Agent</);
state.languageMode = 'en';
const englishMissingPptSkillPanel = renderNetworkPanel();
assert.match(englishMissingPptSkillPanel, /The recipient device does not have the PPT Creation Skill installed/);
assert.match(englishMissingPptSkillPanel, /Failure stage: preflight/);
assert.doesNotMatch(englishMissingPptSkillPanel, /接收方当前设备尚未安装 PPT 制作 Skill/);
state.languageMode = 'zh-CN';
state.pptxPluginStatus = { installed: true, available: true };
assert.match(renderNetworkPanel(), /Skill 已安装，重新调度 Agent/);
state.agentDelegations[0] = {
  ...state.agentDelegations[0],
  status: 'draft_ready',
  metadata: { ...state.agentDelegations[0].metadata, draftReadyAt: new Date().toISOString() },
};
assert.match(renderNetworkPanel(), /本地结果已保存，等待同步/);
state.networkDelegationId = '';

state.agentDelegations = [{
  id: 'delegation-result-status-lag', requesterUserId: 'peer-user', recipientUserId: 'ui-user', title: '结果已生成但状态同步稍慢',
  instruction: '生成并交付结果', status: 'running', requester: { id: 'peer-user', displayName: '发起人' },
  metadata: { executionProgress: { phase: 'delivering', completed: 2, total: 2 } },
}];
state.networkDelegationId = 'delegation-result-status-lag';
state.networkConversationMessages = [{
  id: 'status-lag-candidate', role: 'assistant', content: '已经生成的最终结果。', createdAt: new Date().toISOString(),
  metadata: { delegationId: 'delegation-result-status-lag', privateTaskWorkspace: true, publishCandidate: true, revisionId: 'status-lag-revision' },
}];
state.networkDelegationRunsById = {
  'delegation-result-status-lag': [{ workId: 'stale-running-receipt', deliveryStatus: 'running' }],
};
const statusLagDeliveryPanel = renderNetworkPanel();
assert.match(statusLagDeliveryPanel, /确认并交付到任务群/);
assert.doesNotMatch(statusLagDeliveryPanel, /处理中，暂不可交付|disabled>确认并交付到任务群/);
state.networkDelegationRunsById = {};
state.networkConversationMessages = [];
state.networkDelegationId = '';

state.messages = [{
  id: 'delivery-notice', role: 'assistant', content: 'PPT Agent 已完成任务，回复已送达它的主会话。',
  metadata: { agentDeliveryCompleted: true, targetSessionId: 'ppt-session' }, createdAt: new Date().toISOString(),
}];
assert.match(renderMessageList(), /data-agent-delivery-session="ppt-session"/);
assert.match(renderMessageList(), /打开 Agent 回复/);

state.friendOverview = {
  friends: [
    { friend: { id: 'peer-selected', displayName: '入选用户' } },
    { friend: { id: 'peer-rejected', displayName: '未入选用户' } },
  ],
  requests: { incoming: [], outgoing: [] },
  organizations: [],
};
state.messages = [{
  id: 'ubuddy-selection-result', role: 'assistant', content: '参与人选择已经保存。',
  metadata: {
    uBuddySelection: {
      version: 1,
      selectionMode: 'candidate_pool',
      candidateUserIds: ['peer-selected', 'peer-rejected'],
      requiredUserIds: ['peer-selected'],
      selectedUserIds: ['peer-selected'],
      profileRevisionSnapshots: [{ ownerUserId: 'peer-selected', profileRevision: 3 }],
      selectionDecision: {
        status: 'ready', confidence: 0.87, strategyVersion: 'ubuddy_peer_route_shadow_candidate_v1',
        rationale: '入选用户的任务类型与报告交付物匹配度更高。',
        rejectedCandidates: [{ userId: 'peer-rejected', reason: '当前公开负载较高。' }],
      },
    },
  },
  createdAt: new Date().toISOString(),
}];
const selectionResult = renderMessageList();
assert.match(selectionResult, /class="ubuddy-selection-card"/);
assert.match(selectionResult, /<details class="ubuddy-selection-card"[^>]*>\s*<summary>/);
assert.doesNotMatch(selectionResult, /<details class="ubuddy-selection-card"[^>]*open/);
assert.match(selectionResult, /多人候选/);
assert.match(selectionResult, /入选用户/);
assert.match(selectionResult, /必须参与/);
assert.match(selectionResult, /未入选用户/);
assert.match(selectionResult, /当前公开负载较高/);
assert.match(selectionResult, /87%/);
assert.match(selectionResult, /ubuddy_peer_route_shadow_candidate_v1/);

state.homeMode = 'secretary';
state.uBuddyExpandedMessageIds = {};
state.messages = [{
  id: 'ubuddy-long-reply', role: 'assistant',
  content: Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 行修改说明和验证结论。`).join('\n'),
  createdAt: new Date().toISOString(),
}];
const collapsedUBuddyReply = renderMessageList();
assert.match(collapsedUBuddyReply, /is-ubuddy-response/);
assert.match(collapsedUBuddyReply, /ubuddy-long-response is-collapsed/);
assert.match(collapsedUBuddyReply, /data-long-message-toggle="ubuddy-long-reply"[^>]*aria-expanded="false"[^>]*>查看全部/);
state.uBuddyExpandedMessageIds = { 'ubuddy-long-reply': true };
const expandedUBuddyReply = renderMessageList();
assert.match(expandedUBuddyReply, /ubuddy-long-response is-expanded/);
assert.match(expandedUBuddyReply, /aria-expanded="true"[^>]*>收起/);
state.homeMode = 'department';
state.uBuddyExpandedMessageIds = {};

state.messages = [{
  id: 'ubuddy-live-progress', role: 'assistant', content: '代码 Agent：正在执行节点任务',
  metadata: {
    transient: 'run-status', stage: 'executing', taskRunId: 'task-live', taskType: 'code_change',
    objective: { summary: '修改 uBuddy 协作进度展示并验证结果。', deliverables: ['完成代码修改', '运行相关测试'] },
    taskProgress: { total: 4, completed: 1, running: 1, queued: 1, waiting: 0, failed: 0, percent: 25 },
    taskSnapshot: {
      taskRunId: 'task-live', taskStatus: 'running', phase: 'executing',
      progress: { total: 4, completed: 1, running: 1, queued: 1, waiting: 0, failed: 0, percent: 25 },
      activeNodes: [{ id: 'node-code', title: '修改 renderer', agentId: 'ppt', status: 'running' }],
    },
    progressMilestones: [
      { key: 'objective-confirmed', title: '任务目标已确认', detail: '修改 uBuddy 协作进度展示并验证结果。', status: 'completed' },
      { key: 'node-plan:completed', title: '分析事件链路', detail: '已完成', status: 'completed', agentId: 'ppt' },
    ],
  },
}];
const liveProgress = renderMessageList();
assert.match(liveProgress, /任务目标已确认/);
assert.match(liveProgress, /代码修改/);
assert.match(liveProgress, /执行中 · 38% · 执行节点 1\/4/);
assert.match(liveProgress, /修改 renderer/);
assert.match(liveProgress, /最近进展/);
assert.doesNotMatch(liveProgress, /data-task-card-action="open_flow_graph"/);
assert.match(liveProgress, /data-task-run-id="task-live"/);

state.tasks = [{ id: 'external-task-run', status: 'completed', nodes: [], metadata: {} }];
state.agentDelegations = [{
  id: 'external-delegation', requesterUserId: 'peer-user', recipientUserId: 'ui-user', status: 'draft_ready',
  requester: { id: 'peer-user', displayName: '外部发起人' },
  metadata: {
    preliminaryResult: '答案是 2。',
    generatedTaskFiles: [{ id: 'generated-answer', name: '答案.md', type: 'text/markdown', size: 12 }],
    executionProgress: { phase: 'awaiting_delivery', message: '任务处理完成', completed: 2, total: 2 },
  },
}];
state.messages = [{
  id: 'external-ubuddy-task', role: 'assistant', content: '外部发起人的任务已经完成，等待你确认后交付。',
  metadata: {
    uBuddyTaskQueued: true, taskRunId: 'external-task-run', externalDelegationId: 'external-delegation',
    externalDelegationStatus: 'draft_ready', externalRequesterName: '外部发起人',
    processOnly: true,
    externalDelegationDeliveryDraft: {
      version: 1, candidateMessageId: 'candidate-answer', candidateRevisionId: 'candidate-answer',
      submissionText: '答案是 2。',
      attachments: [{ id: 'generated-answer', selectionKey: 'generated-answer', name: '答案.md', type: 'text/markdown', size: 12 }],
    },
    taskSnapshot: { taskRunId: 'external-task-run', taskStatus: 'completed', phase: 'delivering', progress: { completed: 2, total: 2 } },
  },
}];
const externalTaskChat = renderMessageList();
assert.match(externalTaskChat, /确认并交付给发出方/);
assert.match(externalTaskChat, /data-agent-delegation-respond="submit"/);
assert.match(externalTaskChat, /<details class="external-delegation-delivery-review"[^>]*>\s*<summary/);
assert.doesNotMatch(externalTaskChat, /<details class="external-delegation-delivery-review"[^>]*open/);
assert.match(externalTaskChat, /答案\.md/);
assert.match(externalTaskChat, /Text · 1 个交付文件 · 点击展开确认/);
assert.doesNotMatch(externalTaskChat, /交付内容\.md/);
assert.match(externalTaskChat, />交付正文</);
assert.match(externalTaskChat, /对方实际会看到/);
assert.match(externalTaskChat, /答案是 2。/);
assert.match(externalTaskChat, /data-external-delegation-delivery-file="external-delegation"/);
assert.match(externalTaskChat, /答案.md/);
state.agentDelegations = [{
  ...state.agentDelegations[0], status: 'running',
}];
const externalTaskChatWithLaggingStatus = renderMessageList();
assert.match(externalTaskChatWithLaggingStatus, /确认并交付给发出方/);
assert.doesNotMatch(externalTaskChatWithLaggingStatus, /只同步脱敏节点进度/);
state.agentDelegations[0] = { ...state.agentDelegations[0], status: 'draft_ready' };
state.externalDelegationDeliveryDrafts = {
  'external-delegation': {
    text: '编辑后的答案：2。路径 /home/private/result.md', selectedAttachmentKeys: [],
    candidateMessageId: 'candidate-answer', candidateRevisionId: 'candidate-answer',
  },
};
const editedExternalTaskChat = renderMessageList();
assert.match(editedExternalTaskChat, /编辑后的答案：2。/);
assert.match(editedExternalTaskChat, /\[本地路径已隐藏\]/);
assert.doesNotMatch(editedExternalTaskChat, /value="generated-answer" checked/);
state.externalDelegationDeliveryDrafts['external-delegation'].candidateRevisionId = 'stale-candidate';
const refreshedExternalTaskChat = renderMessageList();
assert.match(refreshedExternalTaskChat, /答案是 2。/);
assert.doesNotMatch(refreshedExternalTaskChat, /编辑后的答案：2。/);

state.externalDelegationDeliveryDrafts = {};
state.agentDelegations = [{
  id: 'sender-delegation', requesterUserId: 'ui-user', recipientUserId: 'peer-user', status: 'running',
  title: '发出方实时节点任务', instruction: '整理公开节点进度',
  metadata: {
    preliminaryResult: '不应提前展示的私有结果',
    executionProgress: {
      phase: 'executing', message: '接收方 uBuddy 正在执行', completed: 1, total: 2,
      nodes: [
        { id: 'node-a', title: '整理公开资料', agentName: '通用 Agent', status: 'completed' },
        { id: 'node-b', title: '生成最终答案', agentName: '写作 Agent', status: 'running' },
      ],
    },
  },
}];
state.messages = [{
  id: 'sender-task-host', role: 'assistant', content: '任务已派发。',
  metadata: { publishedTaskCards: [{ delegationId: 'sender-delegation', title: '发出方实时节点任务', workspaceKind: 'delegation' }] },
}];
const senderNodeProgress = renderMessageList();
assert.match(senderNodeProgress, /公开节点状态/);
assert.match(senderNodeProgress, /整理公开资料/);
assert.match(senderNodeProgress, /通用 Agent/);
assert.match(senderNodeProgress, /生成最终答案/);
assert.match(senderNodeProgress, /写作 Agent/);
assert.doesNotMatch(senderNodeProgress, /不应提前展示的私有结果/);

state.agentDelegations = [{
  id: 'submitted-external-delegation', requesterUserId: 'peer-user', recipientUserId: 'ui-user', status: 'submitted',
  requester: { id: 'peer-user', displayName: '外部发起人' },
  metadata: { latestResult: '已实际交付的最终答案：2。', resultAttachments: [] },
}];
state.messages = [{
  id: 'submitted-external-host', role: 'assistant', content: '任务结果已提交。',
  metadata: {
    uBuddyTaskQueued: true, taskRunId: 'external-task-run', externalDelegationId: 'submitted-external-delegation',
    externalDelegationStatus: 'submitted', processOnly: true,
    taskSnapshot: { taskRunId: 'external-task-run', taskStatus: 'completed', phase: 'delivering', progress: { completed: 2, total: 2 } },
  },
}];
const submittedExternalTaskChat = renderMessageList();
assert.match(submittedExternalTaskChat, /等待发出方验收/);
assert.match(submittedExternalTaskChat, /已实际交付的最终答案：2。/);

state.networkPanelView = 'tasks';
state.networkDelegationId = 'requester-review-task';
state.agentDelegations = [{
  id: 'requester-review-task', requesterUserId: 'ui-user', recipientUserId: 'peer-user', status: 'submitted',
  title: '等待发出方最终验收', instruction: '检查结果后决定结束或打回',
  recipient: { id: 'peer-user', displayName: '任务接收人' },
  metadata: {
    latestResult: '已经交付的结果。',
    resultAttachments: [{
      remote_file_id: 'requester-review-file', remote_file_kind: 'collaboration_task',
      filename: '交付报告.docx', content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 2048, sha256: 'review-file-sha256',
    }],
  },
}];
const requesterReviewPanel = renderNetworkPanel();
assert.match(requesterReviewPanel, /确认任务结束/);
assert.match(requesterReviewPanel, /打回重做/);
assert.doesNotMatch(requesterReviewPanel, />接受结果</);
assert.doesNotMatch(requesterReviewPanel, />请求修改</);
state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), 'requester-review-task': 'result' };
const requesterResultPanel = renderNetworkPanel();
assert.match(requesterResultPanel, /已经交付的结果。/);
assert.match(requesterResultPanel, /交付报告\.docx/);
assert.match(requesterResultPanel, /requester-review-file/);
state.taskWorkspaceViewById = {};
state.collaborationTaskActionBusyById = { 'requester-review-task': 'accept_result' };
const requesterReviewBusyPanel = renderNetworkPanel();
assert.match(requesterReviewBusyPanel, /aria-busy="true"/);
assert.match(requesterReviewBusyPanel, /disabled>确认中…/);
assert.match(requesterReviewBusyPanel, /disabled>打回重做/);
state.collaborationTaskActionBusyById = {};
state.networkDelegationId = '';

state.currentTab = 'chat';
state.collaborationGroupId = 'shared-group';
state.collaborationGroupDetail = {
  group: {
    id: 'shared-group', ownerUserId: 'ui-user', title: '共享工作区任务群', status: 'active',
    metadata: {
      virtualParticipants: [{ agentInstanceId: 'shared-analysis-agent', agentFamilyId: 'analysis_agent', displayName: '分析 Agent', status: 'queued' }],
      uBuddySelection: {
        version: 1, selectionMode: 'all_selected',
        candidateUserIds: ['peer-selected', 'peer-rejected'], requiredUserIds: ['peer-selected', 'peer-rejected'],
        selectedUserIds: ['peer-selected', 'peer-rejected'], profileRevisionSnapshots: [],
        selectionDecision: {
          status: 'ready', confidence: 1, strategyVersion: 'legacy_all_mentions_v1', rejectedCandidates: [],
          rationale: '用户明确要求全员参与，因此跳过自动筛选。',
        },
      },
    },
  },
  workspace: { id: 'shared-group', scope: 'collaboration_group', revision: 3, readOnly: false },
  members: [
    { userId: 'ui-user', role: 'owner', status: 'active', user: state.currentUser },
    { userId: 'peer-user', role: 'member', status: 'active', user: { id: 'peer-user', displayName: '小周' } },
  ],
  messages: [
    {
      id: 'group-human-message', senderUserId: 'peer-user', content: '先确认一下研究范围',
      sender: { id: 'peer-user', displayName: '好友' }, createdAt: '2026-08-11T09:58:00.000Z',
    },
    {
      id: 'group-ubuddy-request', senderUserId: 'ui-user', content: '@我的uBuddy 请整理研究范围',
      sender: state.currentUser, createdAt: '2026-08-11T09:59:00.000Z',
      metadata: { mentions: [{ principalType: 'ubuddy', ownerUserId: 'ui-user', displayText: '@我的uBuddy', mentionId: 'mention_work_1', source: 'picker' }] },
    },
    {
      id: 'group-agent-message', senderUserId: 'ui-user', senderAgentId: 'secretary_agent', content: '正在整理研究范围。',
      sender: state.currentUser, createdAt: '2026-08-11T09:59:30.000Z',
    },
  ],
  tasks: [],
};
state.collaborationGroupWorkspace = { id: 'shared-group', scope: 'collaboration_group', revision: 3, syncStatus: 'synced' };
const sharedGroupChat = renderChat();
assert.match(sharedGroupChat, /data-collaboration-group-workspace/);
assert.match(sharedGroupChat, /共享工作区 · 版本 3/);
assert.match(sharedGroupChat, /class="ubuddy-selection-card"/);
assert.match(sharedGroupChat, /用户要求全员/);
assert.match(sharedGroupChat, /用户明确要求全员参与，因此跳过自动筛选/);
assert.match(sharedGroupChat, /class="message assistant[^>]*is-human-message[^>]*is-ubuddy-group-human[^>]*data-message-id="group-human-message"/);
assert.match(sharedGroupChat, /class="message user[^>]*is-ubuddy-work-request[^>]*data-message-id="group-ubuddy-request"/);
assert.match(sharedGroupChat, /<mark class="social-mention-token">@我的uBuddy<\/mark> 请整理研究范围/);
assert.match(sharedGroupChat, /data-collaboration-members-toggle[^>]*aria-expanded="false"/);
assert.doesNotMatch(sharedGroupChat, /id="collaboration-member-popover"/);
assert.doesNotMatch(sharedGroupChat, /class="collaboration-shared-goal"/, 'legacy groups must not infer a shared goal');
state.collaborationGroupDetail = {
  ...state.collaborationGroupDetail,
  group: {
    ...state.collaborationGroupDetail.group,
    metadata: {
      ...state.collaborationGroupDetail.group.metadata,
      taskSummary: {
        version: 1,
        objective: '形成一份可用于管理层决策的完整环境治理方案',
        deliverables: ['治理报告.docx'],
        acceptanceCriteria: ['关键结论可核验'],
        constraints: ['使用中文'],
        deadline: '2026-08-20',
      },
    },
  },
  tasks: [{ id: 'subtitle-check-task', title: '个人分工', instruction: '只整理附录数据', status: 'working', recipientUserId: 'peer-user' }],
};
const sharedGoalChat = renderChat();
const sharedGoalHeader = sharedGoalChat.slice(0, sharedGoalChat.indexOf('<nav class="collaboration-mobile-tabs"'));
assert.match(sharedGoalHeader, /<details class="collaboration-shared-goal">/);
assert.doesNotMatch(sharedGoalHeader, /<details class="collaboration-shared-goal"[^>]*open/);
assert.match(sharedGoalHeader, /最终目标[^]*形成一份可用于管理层决策的完整环境治理方案/);
assert.match(sharedGoalHeader, /治理报告\.docx[^]*关键结论可核验[^]*使用中文[^]*2026-08-20/);
assert.doesNotMatch(sharedGoalHeader, /只整理附录数据/, 'the group subtitle must not reuse one assignee instruction');
state.collaborationGroupDetail = { ...state.collaborationGroupDetail, tasks: [] };
state.collaborationMembersOpen = true;
const sharedGroupMembersOpen = renderChat();
assert.match(sharedGroupMembersOpen, /class="collaboration-members-menu"[^]*?data-collaboration-members-toggle[^>]*aria-expanded="true"[^]*?id="collaboration-member-popover"/);
assert.match(sharedGroupMembersOpen, /工作群成员/);
assert.match(sharedGroupMembersOpen, /2 位成员 · 1 个 Agent/);
assert.match(sharedGroupMembersOpen, /小周的 uBuddy/);
assert.match(sharedGroupMembersOpen, /分析 Agent[^]*?本地 Agent · 排队中/);
assert.match(sharedGroupMembersOpen, /<em>创建者<\/em>/);
assert.match(sharedGroupMembersOpen, /<em>成员<\/em>/);
const sharedGroupDetailBeforePendingProjection = state.collaborationGroupDetail;
state.collaborationMembersOpen = true;
state.collaborationGroupDetail = {
  ...sharedGroupDetailBeforePendingProjection,
  members: [...sharedGroupDetailBeforePendingProjection.members,
    { userId: 'peer-05', role: 'member', status: 'active', user: { id: 'peer-05', displayName: '测试账号 05' } },
    { userId: 'peer-07', role: 'member', status: 'active', user: { id: 'peer-07', displayName: '测试账号 07' } }],
  plannedParticipants: [
    { userId: 'peer-user', status: 'active', user: { id: 'peer-user', displayName: '小周' } },
    { userId: 'peer-05', status: 'active', user: { id: 'peer-05', displayName: '测试账号 05' } },
    { userId: 'peer-07', status: 'active', user: { id: 'peer-07', displayName: '测试账号 07' } },
    { userId: 'peer-09', status: 'awaiting_presence', user: { id: 'peer-09', displayName: '测试账号 09' } },
  ],
};
const pendingParticipantGroup = renderChat();
assert.match(pendingParticipantGroup, /data-collaboration-members-toggle[^>]*>[^]*?<span>4\+1<\/span>/);
assert.match(pendingParticipantGroup, /测试账号 09[^]*?任务已保留，成员上线后自动补派[^]*?待上线补派/);
assert.match(pendingParticipantGroup, /测试账号 09的 uBuddy[^]*?等待成员上线/);
assert.match(pendingParticipantGroup, /<b>1 等待中<\/b>/,
  'the progress summary must count participants whose assignments are waiting for presence');

state.collaborationGroupDetail = sharedGroupDetailBeforePendingProjection;
state.collaborationMembersOpen = false;
const groupAgentMessageIndex = sharedGroupChat.indexOf('data-message-id="group-agent-message"');
const groupAgentMessage = sharedGroupChat.slice(sharedGroupChat.lastIndexOf('<article', groupAgentMessageIndex), sharedGroupChat.indexOf('</article>', groupAgentMessageIndex) + '</article>'.length);
assert.match(groupAgentMessage, /class="message assistant[^>]*is-agent-message/);
assert.doesNotMatch(groupAgentMessage, /class="message user/);
assert.doesNotMatch(groupAgentMessage, /is-human-message|is-ubuddy-group-human|is-ubuddy-work-request/);
state.collaborationGroupDetail = {
  ...state.collaborationGroupDetail,
  tasks: [{
    id: 'group-task-private', title: '整理多人任务方案', instruction: '先研究需求，再输出方案。', status: 'working',
    requesterUserId: 'another-group-member', recipientUserId: 'peer-user', createdAt: '2026-08-11T10:00:00.000Z', metadata: {
      executionProgress: {
        message: '正在整理方案',
        milestones: [
          { key: 'scope', title: '范围已确认', status: 'completed', occurredAt: '2026-08-11T10:01:00.000Z' },
          { key: 'research', title: '资料已收集', status: 'completed', occurredAt: '2026-08-11T10:02:00.000Z' },
          { key: 'draft', title: '正在编写方案', status: 'running', occurredAt: '2026-08-11T10:03:00.000Z' },
        ],
      },
    },
  }],
};
state.collaborationGroupDetail.messages.push({
  id: 'group-task-assigned', senderUserId: 'ui-user', senderAgentId: 'secretary_agent',
  content: '任务已收到。', createdAt: '2026-08-11T10:02:00.000Z',
  metadata: { type: 'task_assigned', delegationId: 'group-task-private' },
});
state.collaborationGroupDetail.messages.push({
  id: 'group-task-summary', senderUserId: 'ui-user', senderAgentId: 'secretary_agent',
  content: '任务已经完成调研阶段。', createdAt: '2026-08-11T10:03:00.000Z',
  metadata: {
    type: 'ubuddy_task_summary', taskId: 'group-task-private', stage: 'started', summaryVersion: 1,
    conclusion: '调研范围已经明确，任务正在进入方案整理阶段。', highlights: ['已确认研究范围', '已收集公开资料'],
    risk: '', nextStep: '整理方案并提交相关成员确认。', occurredAt: '2026-08-11T10:03:00.000Z',
  },
});
state.collaborationGroupDetail.messages.push({
  id: 'group-peer-coordination', senderUserId: 'peer-user', senderAgentId: 'secretary_agent',
  content: '@我的uBuddy 请确认方案交付接口。', createdAt: '2026-08-11T10:04:00.000Z',
  metadata: { type: 'ubuddy_peer_coordination', threadId: 'thread-1', turn: 2, taskId: 'group-task-private' },
});
state.collaborationGroupDetail.messages.push({
  id: 'group-peer-receipt', senderUserId: 'ui-user', senderAgentId: 'secretary_agent',
  content: 'uBuddy 已收到工作对齐请求。', createdAt: '2026-08-11T10:04:10.000Z',
  metadata: { type: 'ubuddy_peer_coordination_receipt', inReplyTo: 'group-peer-coordination', threadId: 'thread-1', receiptStatus: 'processing' },
});
const splitGroupChat = renderChat();
assert.match(splitGroupChat, /collaboration-workbench-panes/);
assert.match(splitGroupChat, /class="collaboration-public-pane"/);
assert.match(splitGroupChat, /class="collaboration-side-pane"/);
assert.match(splitGroupChat, /class="collaboration-progress-pane"/);
assert.match(splitGroupChat, /data-collaboration-progress-task="group-task-private"/);
assert.match(splitGroupChat, /collaboration-progress-participant[^>]*owner-tone-1[^>]*data-ubuddy-owner-user-id="peer-user"/);
assert.equal((splitGroupChat.match(/class="collaboration-progress-participant/g) || []).length, 1,
  'multiple milestones from one uBuddy must render as one participant summary');
assert.match(splitGroupChat, /查看 3 条进展记录/);
assert.match(splitGroupChat, /<b>1 进行中<\/b><b>0 等待中<\/b>/);
assert.match(splitGroupChat, /collaboration-progress-avatar owner-tone-1[^>]*>\s*<svg/);
assert.doesNotMatch(splitGroupChat, /collaboration-progress-avatar[^>]*>U</);
assert.match(splitGroupChat, /data-collaboration-task-action="withdraw"[^>]*data-delegation-id="group-task-private"/);
assert.match(splitGroupChat, /class="collaboration-task-summary is-active owner-tone-\d"/);
assert.match(splitGroupChat, /调研范围已经明确，任务正在进入方案整理阶段/);
assert.match(splitGroupChat, /data-task-summary-task="group-task-private"/);
assert.match(splitGroupChat, /data-ubuddy-owner-user-id="peer-user"/);
assert.match(splitGroupChat, /<small class="collaboration-task-summary-meta"><span class="collaboration-task-summary-identity"><span>小周的 uBuddy<\/span><b>任务总结<\/b><\/span><span class="collaboration-task-summary-state"><time>[^<]*<\/time><em>[^<]*<\/em><\/span><\/small>/,
  'the uBuddy name, task-summary label, timestamp, and status must share one metadata row');
assert.match(splitGroupChat, /collaboration-task-summary-icon owner-tone-1[^>]*>\s*<svg/);
assert.doesNotMatch(splitGroupChat, /collaboration-task-summary-icon[^>]*>U</);
assert.match(splitGroupChat, /network-secretary-avatar is-owner-ubuddy owner-tone-1[^>]*>\s*<svg/);
assert.match(splitGroupChat, /任务已派发 · 小周的 uBuddy/);
assert.match(splitGroupChat, /uBuddy 工作对齐/);
assert.match(splitGroupChat, /正在处理 · 第 2 \/ 6 条/);
assert.doesNotMatch(splitGroupChat, /uBuddy 已收到工作对齐请求/);
assert.doesNotMatch(splitGroupChat, /id="collaboration-private-form"/);
assert.doesNotMatch(splitGroupChat, /我的 uBuddy<\/button>|data-collaboration-side-pane|collaboration-private-pane/);
assert.match(splitGroupChat, /data-collaboration-mobile-pane="group"/);
assert.match(splitGroupChat, /data-collaboration-mobile-pane="progress"/);
state.collaborationSearchOpen = true;
state.collaborationSearchQuery = '验收关键词';
state.collaborationGroupDetail = {
  ...state.collaborationGroupDetail,
  messages: [{ id: 'group-search-message', senderUserId: 'peer-user', content: '群消息中的验收关键词', sender: { id: 'peer-user', displayName: '好友' }, createdAt: '2026-08-11T10:03:00.000Z' }],
  tasks: state.collaborationGroupDetail.tasks.map((task) => ({
    ...task,
    metadata: { ...task.metadata, executionProgress: { message: '正在核对验收关键词', nodes: [{ id: 'node-search', title: '验收关键词节点', agentName: '研究 Agent', status: 'running' }] } },
  })),
};
const searchedGroupChat = renderChat();
assert.match(searchedGroupChat, /id="collaboration-search-input"/);
assert.match(searchedGroupChat, /data-collaboration-search-result="message" data-collaboration-search-target="group-search-message"/);
assert.match(searchedGroupChat, /data-collaboration-search-result="progress" data-collaboration-search-target="group-task-private"/);
state.collaborationSearchQuery = '没有匹配的词';
assert.match(renderChat(), /没有匹配的协作内容/);
state.collaborationSearchOpen = false;
state.collaborationSearchQuery = '';
state.collaborationPaneByGroupId = { 'shared-group': 'progress' };
assert.match(renderChat(), /class="collaboration-progress-pane"/);
state.collaborationGroupDetail = {
  ...state.collaborationGroupDetail,
  localHistoryOnly: true,
  group: { ...state.collaborationGroupDetail.group, localHistoryOnly: true },
  workspace: { ...state.collaborationGroupDetail.workspace, readOnly: true, localHistoryOnly: true },
};
state.collaborationGroupWorkspace = { ...state.collaborationGroupDetail.workspace };
const localHistoryGroupChat = renderChat();
assert.match(localHistoryGroupChat, /本机历史记录/);
assert.match(localHistoryGroupChat, /只能查看此设备保留的历史内容/);
assert.match(localHistoryGroupChat, /data-collaboration-group-workspace disabled/);
assert.doesNotMatch(localHistoryGroupChat, /id="chat-form"|data-collaboration-group-rename|data-collaboration-group-add-member|data-collaboration-group-close/);
state.networkPanelView = 'messages';
state.networkMessageHomeOpen = true;
state.collaborationGroupId = '';
state.collaborationOverview = { groups: [state.collaborationGroupDetail.group], tasks: [] };
const localHistoryGroupPanel = renderNetworkPanel();
assert.match(localHistoryGroupPanel, /data-collaboration-group="shared-group"/);
assert.match(localHistoryGroupPanel, /本机历史/);
const workspaceControllerSource = fs.readFileSync(new URL('../src/renderer/app/features/network/workspaceController.js', import.meta.url), 'utf8');
assert.match(workspaceControllerSource, /attachmentUnavailable[\s\S]*executionState:\s*'completed'[\s\S]*deliveryState:\s*'blocked'/,
  'a delivery-file failure must preserve completed execution state while marking only delivery as blocked');
assert.match(workspaceControllerSource, /任务内容已经完成，但交付文件已失效/);
const rendererAppSource = fs.readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
assert.match(rendererAppSource, /const showNetworkPanel = collaborationFocusMode \|\| shouldShowNetworkPanel\(isSettings\)/,
  'an open task group must retain the message conversation list beside the main chat area');
assert.doesNotMatch(rendererAppSource, /collaborationFocusMode \? 'collaboration-focus-mode'/,
  'task groups must use the standard message workspace instead of the list-hiding focus layout');
assert.match(rendererAppSource, /maybeAutoOpenDispatchedCollaborationGroup[\s\S]*collaborationAutoOpenedDispatchIds/);
assert.match(rendererAppSource, /state\.networkPanelOpen = true;[\s\S]*state\.networkMessageHomeOpen = true;[\s\S]*state\.messageActivePane = 'list';/);
assert.match(rendererAppSource, /dataset\.longMessageToggle[\s\S]*uBuddyExpandedMessageIds/);
assert.match(rendererAppSource, /uBuddyDispatchRecovery\?\.published[\s\S]*loadLatestRendererMessagePage\(sessionId\)/,
  'successful presence recovery must refresh an open uBuddy secretary session even when social projections are unchanged');
assert.match(rendererAppSource, /已取消未上线成员的自动补派；已发布任务不受影响。/);
const runtimeSource = fs.readFileSync(new URL('../src/main/runtime.js', import.meta.url), 'utf8');
assert.match(runtimeSource, /uBuddyDispatchRecoveryRunning[\s\S]*if \(!expeditePresence\)[^\n]*skipped[\s\S]*await uBuddyDispatchRecoveryCompletion;[\s\S]*recoverUBuddyDispatches\(\{ expeditePresence: true \}\)/,
  'a presence event racing an active recovery scan must wait and immediately retry instead of losing the wake-up');
const chatCssSource = fs.readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
assert.match(chatCssSource, /\.ubuddy-selection-card\s*\{[\s\S]*?background:\s*color-mix\([^;]*var\(--ui-surface/);
assert.match(chatCssSource, /\.ubuddy-selection-card\s*>\s*summary[\s\S]*?cursor:\s*pointer/);
assert.match(chatCssSource, /\.collaboration-progress-avatar\s*\{[\s\S]*?width:\s*36px[\s\S]*?height:\s*36px/);
assert.match(chatCssSource, /\.collaboration-progress-avatar\.owner-tone-1\s*\{[^}]*color:\s*#6940b7[^}]*background:\s*#f0eaff/);
const workspaceCssSource = fs.readFileSync(new URL('../src/renderer/app/core/workspace-ui.css', import.meta.url), 'utf8');
assert.match(workspaceCssSource, /\.message\.is-ubuddy-response[\s\S]*?border-left:\s*0\s*!important/);
assert.match(workspaceCssSource, /\.ubuddy-long-response\.is-collapsed \.message-body[\s\S]*?max-height:/);
assert.match(workspaceCssSource, /collaboration-group-chat-view[\s\S]*?\.is-ubuddy-group-human > \.message-shell[\s\S]*?box-shadow:\s*none/);
assert.match(workspaceCssSource, /collaboration-group-chat-view[\s\S]*?\.is-agent-message > \.message-shell[\s\S]*?background:\s*transparent/);
assert.match(workspaceCssSource, /collaboration-group-chat-view \.social-group-message\.is-human-message \.message-shell[\s\S]*?width:\s*fit-content/,
  'short human messages must size to their content');
assert.match(workspaceCssSource, /collaboration-group-chat-view \.social-group-message\.user[\s\S]*?justify-content:\s*flex-start[\s\S]*?margin-left:\s*0/,
  'all task-group human messages must stay on the left timeline');
assert.match(workspaceCssSource, /is-human-message \.message-footer[\s\S]*?position:\s*absolute[\s\S]*?left:\s*100%/,
  'hidden message actions must not reserve vertical bubble space');
assert.match(workspaceCssSource, /is-human-message\.assistant \.message-body[\s\S]*?font-size:\s*14px\s*!important/,
  'task-group human-message bodies must use the readable 14px size');
assert.match(workspaceCssSource, /collaboration-group-chat-view \.social-message-actor > span[\s\S]*?font-size:\s*13px\s*!important/,
  'task-group sender names must be visually quieter than message text');
assert.match(workspaceCssSource, /\.collaboration-task-summary-meta[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/,
  'task-summary metadata must share one row');

console.log('collaboration task UI smoke passed');
