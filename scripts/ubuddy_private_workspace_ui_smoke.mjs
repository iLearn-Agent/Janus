import assert from 'node:assert/strict';

import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { renderSidebar } from '../src/renderer/app/views/navigationView.js';
import { renderNetworkPanel } from '../src/renderer/app/views/networkView.js';

Object.assign(state, {
  languageMode: 'zh-CN',
  networkPanelOpen: true,
  networkPanelView: 'tasks',
  networkDelegationId: 'private_task_smoke',
  currentUser: { id: 'bob', displayName: 'Bob' },
  org: {
    agents: [{ id: 'general_agent', name: '治理产品 Agent' }],
  },
  agentDelegations: [{
    id: 'private_task_smoke',
    requesterUserId: 'alice',
    recipientUserId: 'bob',
    title: '制作工作汇报 PPT',
    instruction: '生成可编辑 PPT，并列出待补充信息。',
    status: 'draft_ready',
    groupId: 'private_group_smoke',
    metadata: {
      intakeSummary: '还需要确认受众、页数和截止时间。',
      preliminaryResult: 'PPT 初稿已经生成。',
      ownerConfirmationRequired: true,
    },
    requester: { id: 'alice', displayName: 'Alice' },
    recipient: { id: 'bob', displayName: 'Bob' },
  }],
  collaborationOverview: { groups: [], tasks: [] },
  networkConversationMessages: [
    { id: 'private_initial', role: 'assistant', content: '这是更早的初版。', metadata: { privateTaskWorkspace: true, delegationId: 'private_task_smoke' } },
    { id: 'publisher_private_message', role: 'user', content: '把汇报范围缩小到本周。', metadata: { privateTaskWorkspace: true, delegationId: 'private_task_smoke', attachments: [{ id: 'request_file', name: '本周范围.txt', size: 24 }] } },
    { id: 'private_message', role: 'assistant', content: '这是私人任务草稿。', metadata: { privateTaskWorkspace: true, delegationId: 'private_task_smoke', localMessageId: 'private_answer_v1', attachments: [{ id: 'own_file', name: '本周汇报.pptx' }] } },
    { id: 'coordinated_private_message', role: 'assistant', content: '已完成环境治理应用的功能拆分。', metadata: { privateTaskWorkspace: true, delegationId: 'private_task_smoke', ubuddyTeamCoordination: true, assignedAgentIds: ['general_agent'] } },
    { id: 'private_message_cloud_copy', role: 'assistant', content: '这是不应重复出现的云端副本。', metadata: { privateTaskWorkspace: true, delegationId: 'private_task_smoke', localMessageId: 'private_answer_v1' } },
    { id: 'group_ingress', role: 'system', content: '请修改第二页。', metadata: { privateTaskWorkspace: true, type: 'group_message_ingress', sourceEventId: 'group_event_1', delegationId: 'private_task_smoke' } },
    { id: 'shared_revision', senderUserId: 'alice', senderAgentId: 'secretary_agent', content: '对方 uBuddy 私有文件：do-not-leak.pptx', metadata: { type: 'task_action', action: 'request_revision', delegationId: 'private_task_smoke', attachments: [{ id: 'peer_file', name: 'do-not-leak.pptx' }] } },
  ],
  networkBusyDelegationId: '',
  networkDelegationRunsById: {},
  networkDelegationCommentDrafts: {},
  networkDelegationUBuddyEnabled: {},
  networkDelegationEditingMessageId: '',
  networkDelegationMemoryMenuOpen: true,
  networkDelegationMemory: {
    workspaceRoot: '/tmp/janus-private-task-smoke',
    coordinator: {
      id: 'memory_private_task_smoke',
      displayName: '制作工作汇报 PPT.md',
      content: '# 制作工作汇报 PPT\n\n## Task Updates\n- 已整理初稿',
      decryptionState: 'available',
      agentName: 'uBuddy',
    },
    executionDocuments: [{
      id: 'memory_executor_task_smoke',
      displayName: '制作工作汇报 PPT.md',
      content: '# 执行记录',
      decryptionState: 'available',
      agentName: 'PPT Agent',
    }],
  },
  attachments: [],
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  socialThreads: [],
  socialInbox: [],
});

const html = renderNetworkPanel();
assert.doesNotMatch(html, /我和我的 uBuddy/);
assert.match(html, /原始任务要求/);
assert.match(html, /仅自己可见/);
assert.match(html, /群共享工作区/);
assert.match(html, /工作区文件群内可见/);
assert.match(html, /来自任务群的公开更新/);
assert.match(html, /提交到任务群/);
assert.match(html, /network-delegation-update agent/);
assert.match(html, /network-delegation-update mine/);
assert.match(html, /network-delegation-update mine[^]*?network-delegation-update-avatar[^]*?network-delegation-message-shell[^]*?<strong>Bob<\/strong>/);
assert.match(html, /network-delegation-update agent[^]*?network-delegation-update-avatar[^]*?network-delegation-message-shell[^]*?<strong>我的 uBuddy<\/strong>/);
assert.match(html, /network-delegation-message-bubble[^]*?把汇报范围缩小到本周/);
assert.match(html, /本周范围\.txt/);
assert.match(html, /network-task-workspace-tabs[^]*?data-task-workspace-view="activity"[^]*?data-task-workspace-view="result"[^]*?network-delegation-private-workspace/);
assert.doesNotMatch(html, /data-task-workspace-view="flow"/);
assert.match(html, /network-delegation-ingress/);
assert.match(html, /data-agent-delegation-submit/);
assert.match(html, /data-delegation-publish-draft="coordinated_private_message"/);
assert.match(html, /data-delegation-continue-editing/);
assert.match(html, /network-delegation-draft-result/);
assert.doesNotMatch(html, /network-delegation-stage-strip|network-delegation-workflow/);
assert.doesNotMatch(html, /data-social-mention-toggle/);
assert.equal((html.match(/class="composer-plus"/g) || []).length, 1);
assert.equal((html.match(/这是私人任务草稿。/g) || []).length, 1);
assert.doesNotMatch(html, /这是不应重复出现的云端副本/);
assert.doesNotMatch(html, /PPT 初稿已经生成/);
assert.doesNotMatch(html, /do-not-leak\.pptx/);
assert.doesNotMatch(html, /Alice 的 uBuddy|Bob 的 uBuddy/);
assert.doesNotMatch(html, /network-delegation-progress-card/);
assert.match(html, /id="network-delegation-comment-form"/);
assert.match(html, /id="model-picker-trigger"/);
assert.match(html, /network-delegation-meta-bar/);
assert.match(html, /data-delegation-workspace-open/);
assert.match(html, /data-delegation-memory-toggle/);
assert.match(html, /本任务独立 Memory/);
assert.match(html, /制作工作汇报 PPT\.md/);
assert.match(html, /执行 Agent 的任务 Memory/);
assert.match(html, /uBuddy 已协调 1 个 Agent/);
assert.match(html, /按 Skill、等级和队列分配给：治理产品 Agent/);

const cachedGroupTask = state.agentDelegations[0];
state.agentDelegations = [];
state.collaborationGroupDetail = { tasks: [cachedGroupTask] };
const cachedGroupWorkspaceHtml = renderNetworkPanel();
assert.match(cachedGroupWorkspaceHtml, /id="network-delegation-comment-input"/,
  'a task opened from the current group must mount its composer before the global task refresh completes');
state.agentDelegations = [cachedGroupTask];
state.collaborationGroupDetail = null;

state.networkDelegationRunsById = {
  private_task_smoke: [{
    workId: 'workspace:private_task_smoke:progress',
    deliveryStatus: 'running',
    metadata: { delegationId: 'private_task_smoke', surface: 'delegation_workspace' },
    events: [{
      sequenceNo: 1,
      kind: 'task-progress',
      stage: 'working',
      message: '正在生成汇报页面',
      payload: { taskProgress: { completed: 2, total: 5, running: 1 } },
    }],
  }],
};
const progressHtml = renderNetworkPanel();
assert.match(progressHtml, /network-delegation-progress-card/);
assert.match(progressHtml, /正在生成汇报页面/);
assert.match(progressHtml, /已完成 2 \/ 5 个(?:执行)?节点/);
assert.match(progressHtml, /data-delegation-run-cancel=/);
state.networkDelegationRunsById = {};

state.networkDelegationProgressById = {
  private_task_smoke: {
    phase: 'executing', message: '正在同步跨用户公开进度', completed: 3, total: 6,
    running: 1, waiting: 0, failed: 0, currentStep: { title: '生成流程图', status: 'running' },
  },
};
const sharedProgressHtml = renderNetworkPanel();
assert.match(sharedProgressHtml, /data-delegation-progress="private_task_smoke"/);
assert.match(sharedProgressHtml, /正在同步跨用户公开进度/);
assert.match(sharedProgressHtml, /50% · 执行节点 3\/6/);
state.networkDelegationMemory.taskRunId = 'delegated-task-run';
state.networkDelegationTaskById = {
  private_task_smoke: {
    id: 'delegated-task-run', status: 'running', metadata: { delegationId: 'private_task_smoke', taskType: 'file_generation' },
    nodes: [
      { id: 'node-research', title: '整理汇报资料', agentId: 'general_agent', status: 'completed', attemptCount: 1, maxAttempts: 3 },
      { id: 'node-slides', title: '生成 PPT 页面', agentId: 'general_agent', status: 'running', attemptCount: 1, maxAttempts: 3 },
      { id: 'node-qa', title: '校验交付物', agentId: 'general_agent', status: 'failed', attemptCount: 3, maxAttempts: 3 },
    ],
  },
};
const fullProgressHtml = renderNetworkPanel();
assert.ok(fullProgressHtml.indexOf('network-delegation-unified-progress') < fullProgressHtml.indexOf('network-delegation-chat-timeline'));
assert.equal((fullProgressHtml.match(/network-delegation-unified-progress/g) || []).length, 1);
assert.match(fullProgressHtml, /节点状态/);
assert.match(fullProgressHtml, /整理汇报资料/);
assert.match(fullProgressHtml, /生成 PPT 页面/);
assert.doesNotMatch(fullProgressHtml, /data-task-card-action="open_flow_graph"/);
assert.match(fullProgressHtml, /data-task-card-action="cancel_task" data-task-run-id="delegated-task-run"/);
assert.match(fullProgressHtml, /data-task-card-action="return_to_source_chat"/);
assert.match(fullProgressHtml, /data-retry-task-node="node-qa"/);
assert.match(fullProgressHtml, /data-focus-delegation-composer/);
state.networkDelegationTaskById = {};
state.networkDelegationMemory.taskRunId = '';
state.networkDelegationProgressById = {};

state.agentDelegations = [{
  ...cachedGroupTask,
  status: 'blocked',
  metadata: {
    ...cachedGroupTask.metadata,
    executionState: 'blocked',
    deliveryState: 'blocked',
    clarification: {
      question: '请提供你最近开展的主要工作、当前进展和可核实记录。',
      options: [],
    },
    executionProgress: {
      phase: 'preparing',
      lifecyclePhase: 'confirming',
      percent: 5,
      message: '接收方 uBuddy 已接收任务，正在准备执行环境',
    },
  },
}];
const clarificationHtml = renderNetworkPanel();
assert.match(clarificationHtml, /等待你补充信息/);
assert.match(clarificationHtml, /等待你补充信息 · 5%/);
assert.match(clarificationHtml, /请提供你最近开展的主要工作、当前进展和可核实记录/);
assert.match(clarificationHtml, /不会新建任务/);
assert.doesNotMatch(clarificationHtml, /重新调度 Agent/);
assert.match(clarificationHtml, /id="network-delegation-comment-form"/);
state.currentUser = { id: 'alice', displayName: 'Alice' };
const requesterClarificationHtml = renderNetworkPanel();
assert.match(requesterClarificationHtml, /等待接收方回复 · 5%/);
assert.doesNotMatch(requesterClarificationHtml, /等待你补充信息 · 5%/);
state.currentUser = { id: 'bob', displayName: 'Bob' };
state.agentDelegations = [cachedGroupTask];

state.networkBusyDelegationId = 'private_task_smoke';
state.networkDelegationCommentDrafts = { private_task_smoke: '这是下一条排队消息。' };
state.networkDelegationPendingMessages = {
  private_task_smoke: {
    id: 'pending:private-task-message',
    role: 'user',
    content: '请把第三页改成风险矩阵。',
    createdAt: new Date().toISOString(),
    metadata: { delegationId: 'private_task_smoke', optimistic: true, privateTaskWorkspace: true },
  },
};
const busyHtml = renderNetworkPanel();
assert.match(busyHtml, /请把第三页改成风险矩阵/);
assert.match(busyHtml, /已发送 · uBuddy 正在处理/);
assert.match(busyHtml, /进度会持续同步到任务群/);
assert.match(busyHtml, /uBuddy 正在处理任务/);
assert.doesNotMatch(busyHtml, /正在更新任务状态，请稍候/);
assert.doesNotMatch(busyHtml, /id="network-delegation-comment-input"[^>]*disabled/);
assert.doesNotMatch(busyHtml, /class="send-btn"[^>]*disabled/);
state.networkBusyDelegationId = '';
state.networkDelegationCommentDrafts = {};
state.networkDelegationPendingMessages = {};

state.currentUser = { id: 'alice', displayName: 'Alice' };
const publisherHtml = renderNetworkPanel();
assert.doesNotMatch(publisherHtml, /我和我的 uBuddy/);
assert.match(publisherHtml, /需要文件时请明确说明/);
assert.match(publisherHtml, /id="network-delegation-comment-form"/);
assert.doesNotMatch(publisherHtml, /确认发布到群聊|data-delegation-publish-draft/);

state.agentDelegations = [{
  ...state.agentDelegations[0],
  status: 'failed',
  metadata: {
    ...state.agentDelegations[0].metadata,
    failureCode: 'execution_failed',
    failureStage: 'verification',
    publicFailure: { code: 'execution_failed', stage: 'verification', message: '必要交付物未通过校验。', retryable: false },
  },
}];
const requesterFailureHtml = renderNetworkPanel();
assert.match(requesterFailureHtml, /必要交付物未通过校验/);
assert.match(requesterFailureHtml, /失败阶段：verification/);
assert.doesNotMatch(requesterFailureHtml, /查看本地诊断/);

Object.assign(state, {
  networkPanelView: 'messages',
  networkDelegationId: '',
  collaborationGroupId: 'private_group_smoke',
  socialMentionMenuOpen: true,
  collaborationAddMemberOpen: true,
  collaborationAddMemberUserId: 'carol',
  collaborationAddMemberAssignment: '整理近期工作并制作流程图',
  collaborationRoutingConfirmation: {
    groupId: 'private_group_smoke',
    sourceMessageId: 'ambiguous_message',
    content: '请同步更新流程图。',
    candidateDelegationIds: ['task_bob', 'task_carol'],
    selectedDelegationId: 'task_bob',
  },
  friendOverview: { friends: [{ friend: { id: 'carol', displayName: 'Carol' } }], requests: { incoming: [], outgoing: [] } },
  collaborationGroupDetail: {
    group: { id: 'private_group_smoke', title: '工作汇报', ownerUserId: 'alice', status: 'active' },
    members: [
      { userId: 'alice', status: 'active', user: { id: 'alice', displayName: 'Alice' } },
      { userId: 'bob', status: 'active', user: { id: 'bob', displayName: 'Bob' } },
    ],
    tasks: [
      { id: 'task_bob', title: 'Bob 流程图', instruction: '制作工作流程图', status: 'running', metadata: { executionProgress: { phase: 'executing', completed: 2, total: 4, message: '正在绘制流程图', nodes: [{ id: 'public-node-1', title: '梳理流程节点', agentName: '治理产品 Agent', status: 'completed' }, { id: 'public-node-2', title: '绘制流程图', agentName: '治理产品 Agent', status: 'running' }] } } },
      { id: 'task_carol', title: 'Carol 数据整理', instruction: '整理近期数据' },
    ],
    messages: [
      { id: 'm1', senderUserId: 'alice', content: '@Bob的uBuddy 请先整理', sender: { displayName: 'Alice' } },
      { id: 'm2', senderUserId: 'bob', senderAgentId: 'secretary_agent', content: 'Bob 流程图：接收方 uBuddy 已开始处理。', createdAt: new Date().toISOString(), sender: { displayName: 'Bob' }, metadata: { type: 'delegation_milestone', action: 'running', status: 'running', delegationId: 'task_bob', executionProgress: { completed: 2, total: 4 } } },
    ],
  },
  chatDraft: '@Bob的uBuddy 请先整理',
});
const groupHtml = renderChat();
assert.match(groupHtml, /data-social-mention-toggle/);
assert.match(groupHtml, /data-collaboration-group-rename/);
assert.doesNotMatch(groupHtml, /social-composer-context">任务群/);
assert.match(groupHtml, /@Alice/);
assert.match(groupHtml, /@我的uBuddy/);
assert.match(groupHtml, /@Bob/);
assert.match(groupHtml, /@Bob的uBuddy/);
assert.match(groupHtml, /collaboration-add-member-panel/);
assert.match(groupHtml, /整理近期工作并制作流程图/);
assert.match(groupHtml, /collaboration-routing-confirmation/);
assert.match(groupHtml, /data-collaboration-routing-confirm/);
assert.match(groupHtml, /Bob 流程图/);
assert.match(groupHtml, /<strong>处理中<\/strong>/);
assert.match(groupHtml, /network-delegation-progress-track[^]*?width:50%/);
assert.doesNotMatch(groupHtml, /data-cancel-ubuddy-task|data-retry-task-node/);
assert.match(groupHtml, /collaboration-task-milestone/);
assert.match(groupHtml, /已完成 2 \/ 4 个节点/);

state.currentUser = { id: 'bob', displayName: 'Bob' };
const memberGroupHtml = renderChat();
assert.doesNotMatch(memberGroupHtml, /data-collaboration-group-rename/);
state.currentUser = { id: 'alice', displayName: 'Alice' };

state.collaborationOverview = { groups: [], tasks: [] };
state.agentDelegations = [{ id: 'badge_task', recipientUserId: 'alice', status: 'running' }];
const sidebarHtml = renderSidebar();
assert.doesNotMatch(sidebarHtml, /data-network-view="tasks"|sidebar-task-badge/);
console.log('uBuddy private task workspace UI smoke passed');
