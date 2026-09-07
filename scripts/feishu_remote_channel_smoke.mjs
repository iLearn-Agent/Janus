import assert from 'node:assert/strict';

import { ConversationSerialQueue } from '../src/main/modules/remoteChannels/application/conversationSerialQueue.js';
import { ExternalUserInputCoordinator } from '../src/main/modules/remoteChannels/application/externalUserInputCoordinator.js';
import { FeishuChannelService, feishuChannelInternals } from '../src/main/modules/remoteChannels/application/feishuChannelService.js';
import { effectiveTaskExecutionPermissionMode } from '../src/main/scheduler.js';
import { ElectronCredentialCodec } from '../src/main/modules/remoteChannels/infrastructure/electronCredentialCodec.js';
import { FeishuConfigRepository } from '../src/main/modules/remoteChannels/infrastructure/feishu/feishuConfigRepository.js';
import { parseFeishuMessageEvent } from '../src/main/modules/remoteChannels/infrastructure/feishu/feishuMessageParser.js';

function event({ id, text, openId = 'ou_owner', tenantKey = 'tenant_a', type = 'text', chatType = 'p2p', senderType = 'user', mentions = [] }) {
  return {
    sender: { sender_type: senderType, tenant_key: tenantKey, sender_id: { open_id: openId } },
    message: {
      message_id: id,
      chat_id: `chat_${openId}`,
      chat_type: chatType,
      message_type: type,
      content: typeof text === 'string' ? JSON.stringify(type === 'text' ? { text } : text) : JSON.stringify(text),
      mentions,
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for Feishu smoke condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const textMessage = parseFeishuMessageEvent(event({ id: 'm_text', text: 'hello' }));
assert.equal(textMessage.accepted, true);
assert.equal(textMessage.text, 'hello');
const janusMentionMessage = parseFeishuMessageEvent(event({ id: 'm_janus_mention', text: '@bob 请整理周报' }));
assert.deepEqual(janusMentionMessage.janusMention, {
  username: 'bob', displayText: '@bob', instruction: '请整理周报',
});
const nativeFeishuMentionMessage = parseFeishuMessageEvent(event({
  id: 'm_native_mention',
  text: '@_user_1 请整理周报',
  mentions: [{ key: '@_user_1', id: { open_id: 'ou_bob' }, name: 'Bob' }],
}));
assert.equal(nativeFeishuMentionMessage.text, '@Bob 请整理周报');
assert.equal(nativeFeishuMentionMessage.janusMention, null, 'native Feishu mentions must not resolve as Janus usernames');

const postMessage = parseFeishuMessageEvent(event({
  id: 'm_post',
  type: 'post',
  text: { zh_cn: { content: [[{ tag: 'text', text: 'hello' }, { tag: 'at', user_name: 'Janus' }]] } },
}));
assert.equal(postMessage.text, 'hello @Janus');
assert.equal(parseFeishuMessageEvent(event({ id: 'm_group', text: 'no', chatType: 'group' })).reason, 'not_p2p');
assert.equal(parseFeishuMessageEvent(event({ id: 'm_bot', text: 'no', senderType: 'bot' })).reason, 'bot_sender');

const queue = new ConversationSerialQueue();
const order = [];
const first = queue.enqueue('chat', async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  order.push('first');
});
const second = queue.enqueue('chat', async () => { order.push('second'); });
await Promise.all([first, second]);
assert.deepEqual(order, ['first', 'second']);

const coordinator = new ExternalUserInputCoordinator({ timeoutMs: 1000 });
const coordinated = coordinator.begin('tenant:chat', {
  runId: 'run_coordinator', requestId: 'request_coordinator', sourceMessageId: 'source_coordinator',
  questions: [
    { id: 'format', header: '格式', question: '选择输出格式', options: [{ label: 'Markdown' }, { label: '纯文本' }] },
    { id: 'language', header: '语言', question: '使用什么语言？' },
  ],
});
assert.equal(coordinated.ok, true);
assert.match(coordinated.prompt, /1\/2/);
assert.equal(coordinator.consume('tenant:chat', '9').status, 'invalid');
const nextQuestion = coordinator.consume('tenant:chat', '2');
assert.equal(nextQuestion.status, 'next');
assert.match(nextQuestion.prompt, /2\/2/);
const completedInput = coordinator.consume('tenant:chat', '中文');
assert.equal(completedInput.status, 'completed');
assert.deepEqual(completedInput.answers, {
  format: { answers: ['纯文本'] },
  language: { answers: ['中文'] },
});
assert.equal(coordinator.size(), 0);
assert.equal(coordinator.begin('secret:chat', {
  questions: [{ id: 'token', question: '输入令牌', isSecret: true }],
}).reason, 'secret_question');
const cancelledInput = new ExternalUserInputCoordinator({ timeoutMs: 1000 });
cancelledInput.begin('cancel:chat', { questions: [{ id: 'choice', question: '继续吗？' }] });
assert.equal(cancelledInput.consume('cancel:chat', '取消').status, 'cancelled');
let expiredInput = null;
const expiringCoordinator = new ExternalUserInputCoordinator({
  timeoutMs: 20,
  onExpired: (pending) => { expiredInput = pending; },
});
expiringCoordinator.begin('expire:chat', {
  runId: 'run_expired', requestId: 'request_expired', sourceMessageId: 'source_expired',
  questions: [{ id: 'choice', question: '继续吗？' }],
});
await waitFor(() => expiredInput !== null);
assert.equal(expiredInput.requestId, 'request_expired');
assert.equal(expiringCoordinator.size(), 0);

assert.equal(effectiveTaskExecutionPermissionMode({ metadata: { source: 'ubuddy_dispatch', executionOptions: {} } }, 'request-approval'), 'task-workspace');
assert.equal(effectiveTaskExecutionPermissionMode({ metadata: { taskOrigin: 'external_delegation' } }, 'request-approval'), 'task-workspace');
assert.equal(effectiveTaskExecutionPermissionMode({ metadata: { source: 'ubuddy_dispatch', executionOptions: { remoteInteractiveApprovals: true } } }, 'task-workspace'), 'request-approval');
const settings = new Map();
const store = {
  settingGet: (key, fallback = '') => settings.get(key) ?? fallback,
  settingSet: (key, value) => settings.set(key, value),
  contextDeviceId: () => 'device_a',
  activeAccountWorkspace: () => ({ id: 'workspace_personal' }),
};
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value) => Buffer.from(`cipher:${value}`),
  decryptString: (value) => value.toString().slice('cipher:'.length),
};
const codec = new ElectronCredentialCodec({ safeStorage, platform: 'linux' });
const repository = new FeishuConfigRepository({ store, codec });
repository.save({ userId: 'user_a', deviceId: 'device_a' }, { appId: 'cli_a', appSecret: 'secret-value' });
const storedCiphertext = [...settings.values()][0];
assert.equal(storedCiphertext.includes('secret-value'), false);
assert.equal(repository.publicStatus(repository.load({ userId: 'user_a', deviceId: 'device_a' })).hasAppSecret, true);
assert.equal(Object.hasOwn(repository.publicStatus(repository.load({ userId: 'user_a', deviceId: 'device_a' })), 'appSecret'), false);
assert.equal(repository.normalize({ selectedProjectId: 'legacy_project' }).messageMode, 'task', 'legacy selected-project config must migrate to TASK mode');
assert.deepEqual(repository.normalize({}).routeTarget, { kind: 'ubuddy', agentInstanceId: '', selectedAt: '' });
assert.deepEqual(repository.normalize({ routeTarget: { kind: 'employee', agentInstanceId: 'agent_instance_writer', selectedAt: 'now' } }).routeTarget, {
  kind: 'employee', agentInstanceId: 'agent_instance_writer', selectedAt: 'now',
});
assert.deepEqual(repository.normalize({ pendingDelegation: {
  username: 'BOB', chatId: 'chat_owner', senderId: 'ou_owner', tenantKey: 'tenant_a', startedAt: 'now',
} }).pendingDelegation, {
  username: 'bob', chatId: 'chat_owner', senderId: 'ou_owner', tenantKey: 'tenant_a', startedAt: 'now',
});
assert.throws(() => new ElectronCredentialCodec({
  safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' },
  platform: 'linux',
}).encrypt('secret'), (error) => error.code === 'secure_storage_unavailable');

const replies = [];
const cards = [];
const agentCalls = [];
const employeeAgentCalls = [];
const delegationCalls = [];
const sessionUpdates = [];
const userInputResolutions = [];
const externalCancellations = [];
const taskCalls = [];
const taskApprovals = [];
const chatApprovals = [];
const taskInputResolutions = [];
const taskCancellations = [];
const fakeTasks = new Map();
let pendingExternalInput = null;
let activeClient = null;
class FakeClient {
  constructor(options) { this.options = options; activeClient = this; }
  async testConnection() { return { ok: true }; }
  start() { this.options.onStatus?.({ connectionState: 'connecting' }); }
  stop() {}
  connectionStatus() { return { state: 'connected' }; }
  async reply(messageId, text, uuid) { replies.push({ messageId, text, uuid }); }
  async replyCard(messageId, card, uuid) { cards.push({ messageId, card, uuid }); }
}
const runtime = {
  store,
  currentUser: () => ({ id: 'user_a' }),
  ensureSecretarySession: () => ({ id: 'session_ubuddy' }),
  externalChannelProjects() { return [{ id: 'project_a', title: 'Alpha' }, { id: 'project_b', title: 'Beta' }]; },
  externalChannelContacts() {
    return [{ userId: 'user_bob', username: 'bob', displayName: '测试账号07' }];
  },
  externalChannelAgents() {
    return [
      { agentInstanceId: 'agent_instance_research', agentFamilyId: 'research_agent', displayName: '研究员一号', familyName: '研究员', departmentName: '研究部' },
      { agentInstanceId: 'agent_instance_writer', agentFamilyId: 'writer_agent', displayName: '写作助手', familyName: '写作助手', departmentName: '内容部' },
    ];
  },
  resolveExternalChannelJanusMention({ username, displayText, mentionId }) {
    if (username !== 'bob') return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      contact: { userId: 'user_bob', username: 'bob', displayName: 'Bob' },
      mention: {
        principalType: 'user', userId: 'user_bob', ownerUserId: '', agentId: '', agentInstanceId: '',
        organizationId: '', pluginId: '', audience: '', displayText, mentionId, source: 'picker',
      },
    };
  },
  async externalChannelDelegation(payload) {
    delegationCalls.push(payload);
    payload.onEvent?.({
      kind: 'message-persisted', phase: 'request', runId: `delegation_run_${payload.externalMessageId}`,
      sessionId: 'session_ubuddy', displaySessionId: 'session_ubuddy',
      messageId: `delegation_request_${payload.externalMessageId}`, role: 'user',
    });
    return payload.mentions.length
      ? { session: { id: 'session_ubuddy' }, answer: '委托方案待确认', uBuddyMode: 'awaiting_confirmation' }
      : { session: { id: 'session_ubuddy' }, answer: '委托已派发', uBuddyMode: 'dispatched' };
  },
  async externalChannelAgentChat(payload) {
    employeeAgentCalls.push(payload);
    payload.onEvent?.({
      kind: 'message-persisted', phase: 'request', runId: `employee_run_${payload.externalMessageId}`,
      sessionId: 'session_employee', displaySessionId: 'session_employee',
      messageId: `employee_request_${payload.externalMessageId}`, role: 'user',
    });
    if (payload.message === '执行受控命令') {
      payload.onEvent?.({
        kind: 'approval-request', runId: 'employee_run_approval', approvalId: 'employee_approval_1',
        command: 'npm test --token employee-secret', reason: '运行员工测试',
      });
    }
    return { session: { id: 'session_employee', agentInstanceId: payload.agentInstanceId }, answer: `employee:${payload.message}` };
  },
  resolveExternalChannelApproval(payload) {
    chatApprovals.push(payload);
    return { ok: true, approved: payload.approved };
  },
  async externalChannelTask(payload) {
    taskCalls.push(payload);
    const task = { id: 'task_remote_1', title: payload.message, status: 'running', ownerUserId: 'user_a', metadata: { sourceSecretaryMessageId: 'request_task_remote_1' } };
    fakeTasks.set(task.id, task);
    payload.onEvent?.({ kind: 'task-progress', taskRunId: task.id, sourceMessageId: 'request_task_remote_1' });
    return { session: { id: 'session_ubuddy' }, task, taskRunId: task.id, answer: '任务已开始' };
  },
  externalTaskStatus({ taskRunId }) { return fakeTasks.get(taskRunId) || null; },
  externalTaskResult({ taskRunId }) { const task = fakeTasks.get(taskRunId); return task ? { task, text: '任务已完成：远程文字结果' } : null; },
  cancelExternalTask({ taskRunId }) { const task = fakeTasks.get(taskRunId); if (!task) return null; task.status = 'cancelled'; taskCancellations.push(taskRunId); return task; },
  async cancelExternalTaskInteraction(payload) { taskCancellations.push('interaction:' + payload.runId); return { ok: true }; },
  resolveExternalTaskApproval(payload) { taskApprovals.push(payload); return { ok: true, approved: payload.approved }; },
  resolveExternalTaskUserInput(payload) { taskInputResolutions.push(payload); return { ok: true }; },
  async externalChannelChat(payload) {
    agentCalls.push(payload);
    payload.onEvent?.({
      kind: 'message-persisted', phase: 'request', runId: `run_${payload.externalMessageId}`,
      sessionId: 'session_ubuddy', displaySessionId: 'session_ubuddy',
      messageId: `request_${payload.externalMessageId}`, role: 'user',
    });
    if (payload.message === 'confirm plan') {
      return new Promise((resolve, reject) => {
        pendingExternalInput = { payload, resolve, reject };
        payload.onEvent?.({
          kind: 'user-input-request', runId: 'run_feishu_input', requestId: 'request_feishu_input', itemId: 'item_feishu_input',
          questions: [
            { id: 'format', header: '格式', question: '选择输出格式', options: [{ label: 'Markdown' }, { label: '纯文本' }] },
            { id: 'language', header: '语言', question: '使用什么语言？', options: null },
          ],
        });
      });
    }
    if (payload.message === 'secret plan') {
      return new Promise((resolve, reject) => {
        pendingExternalInput = { payload, resolve, reject };
        payload.onEvent?.({
          kind: 'user-input-request', runId: 'run_feishu_secret', requestId: 'request_feishu_secret', itemId: 'item_feishu_secret',
          questions: [{ id: 'token', header: '凭证', question: '请输入访问令牌', isSecret: true }],
        });
      });
    }
    return { session: { id: 'session_ubuddy' }, answer: `answer:${payload.message}` };
  },
  resolveExternalChannelUserInput(payload) {
    userInputResolutions.push(payload);
    if (!pendingExternalInput || payload.runId !== 'run_feishu_input' || payload.requestId !== 'request_feishu_input') {
      return { ok: false, reason: 'expired' };
    }
    const pending = pendingExternalInput;
    pendingExternalInput = null;
    pending.payload.onEvent?.({
      kind: 'user-input-resolved', runId: payload.runId, requestId: payload.requestId, source: 'user',
    });
    pending.resolve({ session: { id: 'session_ubuddy' }, answer: 'confirmed answer' });
    return { ok: true };
  },
  async cancelExternalChannelChat(payload) {
    externalCancellations.push(payload);
    if (pendingExternalInput) {
      const pending = pendingExternalInput;
      pendingExternalInput = null;
      pending.resolve({ cancelled: true, session: { id: 'session_ubuddy' }, answer: '' });
    }
    return { ok: true, cancelled: true };
  },
};
const service = new FeishuChannelService({
  runtime,
  credentialCodec: new ElectronCredentialCodec({ safeStorage, platform: 'linux' }),
  configRepository: new FeishuConfigRepository({
    store: runtime.store,
    codec: new ElectronCredentialCodec({ safeStorage, platform: 'linux' }),
  }),
  clientFactory: (options) => new FakeClient(options),
  parseMessageEvent: parseFeishuMessageEvent,
  onSessionUpdated: (payload) => sessionUpdates.push(payload),
  logger: { error() {}, warn() {} },
});
const saved = await service.saveConfig({ appId: 'cli_a', appSecret: 'app_secret_a', domain: 'feishu', enabled: true });
assert.equal(saved.connectionState, 'connected');
assert.match(saved.bindingCode, /^[0-9]{6}$/);
assert.ok(activeClient);

service.receive(event({ id: 'bind_1', text: `绑定 ${saved.bindingCode}` }));
await waitFor(() => replies.some((reply) => reply.messageId === 'bind_1'));
assert.equal(service.status().bound, true);

service.receive(event({ id: 'agents_1', text: '智能体列表' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'agents_1' && /研究员一号/.test(reply.text)));
service.receive(event({ id: 'select_agent_1', text: '选择智能体 1' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'select_agent_1' && /已切换到智能体：研究员一号/.test(reply.text)));
assert.deepEqual(service.status().routeTarget, {
  kind: 'employee', agentInstanceId: 'agent_instance_research', selectedAt: service.status().routeTarget.selectedAt,
});
assert.ok(service.status().routeTarget.selectedAt);

const ubuddyCallsBeforeEmployeeChat = agentCalls.length;
service.receive(event({ id: 'employee_message_1', text: '整理一份研究摘要' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'employee_message_1' && reply.text === 'employee:整理一份研究摘要'));
assert.equal(employeeAgentCalls.length, 1);
assert.equal(employeeAgentCalls[0].agentInstanceId, 'agent_instance_research');
assert.equal(employeeAgentCalls[0].projectId, '');
assert.equal(agentCalls.length, ubuddyCallsBeforeEmployeeChat, 'employee-targeted text must not route through uBuddy');
assert.deepEqual(sessionUpdates.filter((update) => update.externalMessageId === 'employee_message_1').map((update) => update.phase), [
  'request_persisted', 'completed',
]);
assert.ok(sessionUpdates.filter((update) => update.externalMessageId === 'employee_message_1').every((update) => update.sessionId === 'session_employee'));
assert.ok(sessionUpdates.filter((update) => update.externalMessageId === 'employee_message_1').every((update) => (
  update.agentInstanceId === 'agent_instance_research'
)), 'employee Session updates must identify the aggregated Agent timeline');

service.receive(event({ id: 'employee_approval_message', text: '执行受控命令' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'employee_approval_message' && /请求审批/.test(reply.text)));
const employeeApprovalReply = replies.find((reply) => reply.messageId === 'employee_approval_message' && /请求审批/.test(reply.text));
assert.equal(employeeApprovalReply.text.includes('employee-secret'), false);
const employeeApprovalCode = employeeApprovalReply.text.match(/A-[A-Z0-9]+/)?.[0];
assert.ok(employeeApprovalCode);
service.receive(event({ id: 'employee_approval_confirm', text: `批准 ${employeeApprovalCode}` }));
await waitFor(() => replies.some((reply) => reply.messageId === 'employee_approval_confirm' && /智能体继续处理/.test(reply.text)));
assert.equal(chatApprovals.at(-1).agentInstanceId, 'agent_instance_research');
assert.equal(chatApprovals.at(-1).approved, true);

service.receive(event({ id: 'current_agent_1', text: '当前智能体' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'current_agent_1' && /当前智能体：研究员一号/.test(reply.text)));
service.receive(event({ id: 'select_ubuddy_1', text: '选择智能体 uBuddy' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'select_ubuddy_1' && /已切换到 uBuddy/.test(reply.text)));
assert.equal(service.status().routeTarget.kind, 'ubuddy');

service.receive(event({ id: 'unauthorized_1', text: 'secret request', openId: 'ou_other' }));
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(agentCalls.length, 0);
assert.equal(replies.some((reply) => reply.messageId === 'unauthorized_1'), false);

service.receive(event({ id: 'message_1', text: 'status?' }));
service.receive(event({ id: 'message_1', text: 'duplicate' }));
await waitFor(() => replies.some((reply) => reply.text === 'answer:status?'));
assert.equal(agentCalls.length, 1);
assert.equal(agentCalls[0].provider, 'feishu');
assert.equal(agentCalls[0].sessionId, 'session_ubuddy');
assert.equal(replies.filter((reply) => reply.messageId === 'message_1' && reply.text.startsWith('answer:')).length, 1);
assert.deepEqual(sessionUpdates.filter((update) => update.externalMessageId === 'message_1').map((update) => update.phase), [
  'request_persisted', 'completed',
]);
assert.ok(sessionUpdates.filter((update) => update.externalMessageId === 'message_1').every((update) => (
  update.sessionId === 'session_ubuddy'
  && update.userId === 'user_a'
  && update.accountWorkspaceId === 'workspace_personal'
)));

service.receive(event({ id: 'delegation_missing_requirement', text: '@bob' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'delegation_missing_requirement' && /补充任务要求/.test(reply.text)));
assert.equal(delegationCalls.length, 0);

service.receive(event({ id: 'delegation_unknown', text: '@unknown 请整理周报' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'delegation_unknown' && /没有用户 @unknown/.test(reply.text)));
assert.equal(delegationCalls.length, 0);

service.receive(event({ id: 'delegation_mention', text: '@bob 请整理本周项目进展并在明天下午前交付' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'delegation_mention' && /委托方案待确认/.test(reply.text)));
assert.equal(delegationCalls.length, 1);
assert.equal(delegationCalls[0].message, '@bob 请整理本周项目进展并在明天下午前交付');
assert.deepEqual(delegationCalls[0].mentions.map((item) => ({ userId: item.userId, displayText: item.displayText, source: item.source })), [
  { userId: 'user_bob', displayText: '@bob', source: 'picker' },
]);
assert.equal(service.config.pendingDelegation.username, 'bob');

// The pending route is persisted in encrypted channel config and survives service reconciliation.
await service.reconcile();
service.receive(event({ id: 'delegation_confirm', text: '确认派发' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'delegation_confirm' && /委托已派发/.test(reply.text)));
assert.equal(delegationCalls.length, 2);
assert.deepEqual(delegationCalls[1].mentions, []);
assert.equal(service.config.pendingDelegation, null);

service.receive(event({ id: 'delegation_cancelled_by_mode', text: '@bob 请准备另一份周报' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'delegation_cancelled_by_mode' && /委托方案待确认/.test(reply.text)));
assert.equal(service.config.pendingDelegation.username, 'bob');
service.receive(event({ id: 'delegation_switch_to_ask', text: '询问模式' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'delegation_switch_to_ask' && /ASK 模式/.test(reply.text)));
assert.equal(service.config.pendingDelegation, null, 'an explicit mode switch must leave the pending delegation');

const callsBeforeNativeMention = delegationCalls.length;
service.receive(event({
  id: 'native_mention_not_delegation',
  text: '@_user_1 普通飞书提及',
  mentions: [{ key: '@_user_1', id: { open_id: 'ou_bob' }, name: 'Bob' }],
}));
await waitFor(() => replies.some((reply) => reply.messageId === 'native_mention_not_delegation' && /answer:@Bob/.test(reply.text)));
assert.equal(delegationCalls.length, callsBeforeNativeMention);


service.receive(event({ id: 'message_confirm', text: 'confirm plan' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'message_confirm' && /1\/2/.test(reply.text)));
assert.equal(service.status().pendingUserInputCount, 1);
assert.equal(service.status().queuedConversationCount, 1, 'the original Codex turn should still occupy the serial queue');

const longProjectsMessageId = `om_${'p'.repeat(64)}`;
service.receive(event({ id: longProjectsMessageId, text: '项目列表' }));
await waitFor(() => replies.some((reply) => reply.messageId === longProjectsMessageId && /Alpha/.test(reply.text)));
assert.equal(service.status().pendingUserInputCount, 1, 'a project command must not consume pending Codex input');
assert.equal(service.status().queuedConversationCount, 1, 'a project command must bypass the occupied chat queue');

const longSelectMessageId = `om_${'s'.repeat(64)}`;
service.receive(event({ id: longSelectMessageId, text: '选择项目 1' }));
await waitFor(() => replies.some((reply) => reply.messageId === longSelectMessageId && /暂时不能选择项目/.test(reply.text)));
assert.equal(service.status().selectedProjectId, '');
assert.equal(service.status().messageMode, 'ask');
assert.equal(service.status().pendingUserInputCount, 1);
assert.equal(service.status().queuedConversationCount, 1);
assert.ok(replies.find((reply) => reply.messageId === longSelectMessageId)?.uuid.length <= 50, 'reply UUID must stay within Feishu limits');

service.receive(event({ id: 'confirm_unauthorized', text: '1', openId: 'ou_other' }));
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(userInputResolutions.length, 0);
assert.equal(replies.some((reply) => reply.messageId === 'confirm_unauthorized'), false);

service.receive(event({ id: 'confirm_invalid', text: '9' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'confirm_invalid' && /没有找到对应选项/.test(reply.text)));
assert.equal(userInputResolutions.length, 0);

service.receive(event({ id: 'confirm_format', text: '2' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'confirm_format' && /2\/2/.test(reply.text)));
assert.equal(service.status().queuedConversationCount, 1, 'a partial answer must bypass the occupied prompt queue');

service.receive(event({ id: 'confirm_language', text: '中文' }));
service.receive(event({ id: 'confirm_language', text: 'duplicate' }));
await waitFor(() => replies.some((reply) => reply.text === 'confirmed answer'));
assert.equal(userInputResolutions.length, 1);
assert.deepEqual(userInputResolutions[0].answers, {
  format: { answers: ['纯文本'] },
  language: { answers: ['中文'] },
});
assert.deepEqual(userInputResolutions[0].skippedQuestionIds, []);
assert.equal(service.status().pendingUserInputCount, 0);
assert.equal(replies.filter((reply) => reply.messageId === 'confirm_language' && /已确认/.test(reply.text)).length, 1);
assert.equal(externalCancellations.length, 0);

service.receive(event({ id: 'select_project_after_ask', text: '选择项目 1' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'select_project_after_ask' && /已进入 TASK 模式/.test(reply.text)));
assert.equal(service.status().selectedProjectId, 'project_a');
assert.equal(service.status().messageMode, 'task');

const askCallCountBeforeBareTask = agentCalls.length;
service.receive(event({ id: 'bare_task_1', text: '阅读当前项目目录，给出一份纯文字项目报告，不要修改文件' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'bare_task_1' && /任务已开始：T-/.test(reply.text)));
assert.equal(taskCalls.length, 1);
assert.equal(taskCalls[0].projectId, 'project_a');
assert.equal(taskCalls[0].message, '阅读当前项目目录，给出一份纯文字项目报告，不要修改文件');
assert.equal(agentCalls.length, askCallCountBeforeBareTask, 'plain text in TASK mode must not fall back to ASK');
assert.equal(service.status().messageMode, 'task');

service.receive(event({ id: 'ask_mode_1', text: '询问模式' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'ask_mode_1' && /ASK 模式/.test(reply.text)));
assert.equal(service.status().messageMode, 'ask');

const taskCallCountBeforePlainAsk = taskCalls.length;
service.receive(event({ id: 'plain_ask_1', text: '只说明这个项目使用了什么技术，不要执行任务' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'plain_ask_1' && /answer:只说明/.test(reply.text)));
assert.equal(taskCalls.length, taskCallCountBeforePlainAsk, 'plain text in ASK mode must not create a task');

service.receive(event({ id: 'message_secret', text: 'secret plan' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'message_secret' && /不会收集此类内容/.test(reply.text)));
assert.equal(externalCancellations.length, 1);
assert.equal(externalCancellations[0].runId, 'run_feishu_secret');
assert.equal(replies.some((reply) => reply.messageId === 'message_secret' && /处理消息时发生错误/.test(reply.text)), false);
assert.equal(replies.some((reply) => reply.messageId === 'message_secret' && /没有返回文本内容/.test(reply.text)), false);
assert.deepEqual(sessionUpdates.filter((update) => update.externalMessageId === 'message_secret').map((update) => update.phase), [
  'request_persisted', 'cancelled',
]);

service.receive(event({ id: 'task_1', text: '任务 检查登录逻辑' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'task_1' && /任务已开始：T-/.test(reply.text)));
assert.equal(taskCalls.length, 2);
assert.equal(taskCalls[1].projectId, 'project_a');
assert.equal(taskCalls[1].message, '检查登录逻辑');
assert.equal(service.status().messageMode, 'task', 'an explicit task command must switch and keep the persistent TASK mode');
assert.equal(service.status().remoteTaskCount, 1);

const approvalPayload = {
  task: fakeTasks.get('task_remote_1'),
  change: { type: 'node_interaction', interaction: {
    kind: 'approval-request', runId: 'task_run_active_1', approvalId: 'approval_remote_1',
    command: 'npm test token=top-secret --token hidden-secret Authorization=Bearer hidden-bearer', reason: '运行项目测试',
  } },
};
await service.handleTaskUpdated(approvalPayload);
const approvalReply = replies.find((reply) => reply.messageId === 'task_1' && /请求审批/.test(reply.text));
assert.ok(approvalReply);
assert.equal(approvalReply.text.includes('top-secret'), false);
assert.equal(approvalReply.text.includes('hidden-secret'), false);
assert.equal(approvalReply.text.includes('hidden-bearer'), false);
const approvalCode = approvalReply.text.match(/A-[A-Z0-9]+/)?.[0];
assert.ok(approvalCode);
service.receive(event({ id: 'approve_task_1', text: '批准 ' + approvalCode }));
await waitFor(() => replies.some((reply) => reply.messageId === 'approve_task_1' && /已批准/.test(reply.text)));
assert.equal(taskApprovals.length, 1);
assert.equal(taskApprovals[0].taskRunId, 'task_remote_1');
assert.equal(taskApprovals[0].approved, true);

await service.handleTaskUpdated({
  task: fakeTasks.get('task_remote_1'),
  change: { type: 'node_interaction', interaction: {
    kind: 'user-input-request', runId: 'task_run_active_2', requestId: 'input_remote_1',
    questions: [{ id: 'scope', question: '检查哪个范围？', options: [{ label: '全部' }, { label: '登录' }] }],
  } },
});
const inputReply = replies.find((reply) => reply.messageId === 'task_1' && /需要补充/.test(reply.text));
const inputCode = inputReply?.text.match(/Q-[A-Z0-9]+/)?.[0];
assert.ok(inputCode);
service.receive(event({ id: 'answer_task_1', text: '回答 ' + inputCode + ' 2' }));
await waitFor(() => replies.some((reply) => reply.messageId === 'answer_task_1' && /任务继续执行/.test(reply.text)));
assert.deepEqual(taskInputResolutions[0].answers, { scope: { answers: ['登录'] } });

const remoteTask = fakeTasks.get('task_remote_1');
remoteTask.status = 'completed';
const terminalPayload = { task: remoteTask, change: { type: 'task_finalized' } };
await service.handleTaskUpdated(terminalPayload);
await service.handleTaskUpdated(terminalPayload);
assert.equal(replies.filter((reply) => reply.messageId === 'task_1' && /远程文字结果/.test(reply.text)).length, 1);

const approvalPayloadForStop = {
  task: { ...fakeTasks.get('task_remote_1'), status: 'running' },
  change: { type: 'node_interaction', interaction: { kind: 'approval-request', runId: 'task_run_stop_1', approvalId: 'approval_stop_1', command: 'npm test' } },
};
fakeTasks.get('task_remote_1').status = 'running';
await service.handleTaskUpdated(approvalPayloadForStop);
service.receive(event({ id: 'stop_task_1', text: '停止 ' + feishuChannelInternals.taskCode('task_remote_1') }));
await waitFor(() => replies.some((reply) => reply.messageId === 'stop_task_1' && /已停止/.test(reply.text)));
assert.ok(taskApprovals.some((item) => item.runId === 'task_run_stop_1' && item.approved === false));

service.receive(event({ id: 'delegation_card_missing', text: '分配任务' }));
await waitFor(() => cards.some((item) => item.messageId === 'delegation_card_missing'));
const emptyTaskCard = cards.find((item) => item.messageId === 'delegation_card_missing').card;
const emptyTaskCardBody = emptyTaskCard.elements.find((item) => item.tag === 'markdown');
assert.ok(emptyTaskCardBody, 'delegation card body should use Feishu adaptive markdown text');
assert.match(emptyTaskCardBody.content, /对方的 uBuddy/);
assert.equal(emptyTaskCard.elements.find((item) => item.tag === 'note')?.elements?.[0]?.tag, 'lark_md');
const emptyTaskSelection = emptyTaskCard.elements.find((item) => item.tag === 'action').actions.find((item) => item.tag === 'select_static');
const emptyTaskDelegationCount = delegationCalls.length;
const emptyTaskSelectionResult = activeClient.options.onCardAction({
  context: { open_message_id: 'card_missing', open_chat_id: 'chat_ou_owner' },
  operator: { open_id: 'ou_owner' },
  action: {
    value: { action: 'select_delegation_contact', requestId: emptyTaskSelection.value.requestId },
    tag: 'select_static',
    option: 'user_bob',
  },
});
assert.match(emptyTaskSelectionResult.toast.content, /继续发送任务要求/);
assert.equal(service.status().pendingDelegationSelectionCount, 1);
await waitFor(() => replies.some((reply) => reply.messageId === 'delegation_card_missing' && /请直接发送完整任务要求/.test(reply.text)));
service.receive(event({ id: 'delegation_card_followup', text: '整理联系人选择测试并提交 Markdown' }));
await waitFor(() => delegationCalls.length === emptyTaskDelegationCount + 1);
assert.equal(delegationCalls.at(-1).message, '@bob 整理联系人选择测试并提交 Markdown');
assert.equal(service.status().pendingDelegationSelectionCount, 0);

service.receive(event({ id: 'delegation_card_cancel', text: '分配任务：整理取消测试' }));
await waitFor(() => cards.some((item) => item.messageId === 'delegation_card_cancel'));
const cancelCard = cards.find((item) => item.messageId === 'delegation_card_cancel').card;
const cancelActions = cancelCard.elements.find((item) => item.tag === 'action').actions;
const cancelRequestId = cancelActions.find((item) => item.tag === 'select_static').value.requestId;
const unauthorizedCardResult = activeClient.options.onCardAction({
  context: { open_message_id: 'card_cancel', open_chat_id: 'chat_ou_owner' },
  operator: { open_id: 'ou_other' },
  action: { value: { action: 'cancel_delegation_contact', requestId: cancelRequestId }, tag: 'button' },
});
assert.match(unauthorizedCardResult.toast.content, /没有操作/);
const cancelledCardResult = activeClient.options.onCardAction({
  context: { open_message_id: 'card_cancel', open_chat_id: 'chat_ou_owner' },
  operator: { open_id: 'ou_owner' },
  action: { value: { action: 'cancel_delegation_contact', requestId: cancelRequestId }, tag: 'button' },
});
assert.match(cancelledCardResult.toast.content, /已取消/);

const delegationCountBeforeCard = delegationCalls.length;
service.receive(event({ id: 'delegation_card_select', text: '分配任务 总结本周项目进展并提交 Markdown' }));
await waitFor(() => cards.some((item) => item.messageId === 'delegation_card_select'));
const selectionCard = cards.find((item) => item.messageId === 'delegation_card_select').card;
const selection = selectionCard.elements.find((item) => item.tag === 'action').actions.find((item) => item.tag === 'select_static');
assert.match(selection.options[0].text.content, /测试账号07 \(@bob\)/);
const selectedCardResult = activeClient.options.onCardAction({
  context: { open_message_id: 'card_select', open_chat_id: 'chat_ou_owner' },
  operator: { open_id: 'ou_owner' },
  action: {
    value: { action: 'select_delegation_contact', requestId: selection.value.requestId },
    tag: 'select_static',
    option: 'user_bob',
  },
});
assert.match(selectedCardResult.toast.content, /已选择\s*测试账号07/);
await waitFor(() => delegationCalls.length === delegationCountBeforeCard + 1);
assert.equal(delegationCalls.at(-1).message, '@bob 总结本周项目进展并提交 Markdown');
assert.deepEqual(delegationCalls.at(-1).mentions.map((item) => item.userId), ['user_bob']);
assert.equal(service.status().pendingDelegationCardCount, 0);

const salt = 'salt';
const hash = feishuChannelInternals.pairingHash('123456', salt);
assert.equal(feishuChannelInternals.pairingMatches({ hash, salt, expiresAt: new Date(Date.now() + 1000).toISOString() }, '123456'), true);
assert.equal(feishuChannelInternals.pairingMatches({ hash, salt, expiresAt: new Date(Date.now() - 1).toISOString() }, '123456'), false);
assert.deepEqual(feishuChannelInternals.splitReply('a'.repeat(8000)).map((part) => part.length), [3500, 3500, 1000]);

service.stop();

const { state } = await import('../src/renderer/app/state.js');
const { renderSettings } = await import('../src/renderer/app/views/settingsView.js');
const { renderSettingsSidebar } = await import('../src/renderer/app/views/navigationView.js');
const { createRuntimeSettingsController } = await import('../src/renderer/app/features/settings/runtimeSettingsController.js');
state.currentUser = { id: 'user_a', displayName: 'User A' };
state.currentSettingsSection = 'connections';
state.feishuLoading = false;
state.feishuStatus = {
  configured: true,
  enabled: true,
  appId: 'cli_public',
  hasAppSecret: true,
  domain: 'feishu',
  bound: false,
  bindingCode: '654321',
  connectionState: 'connected',
  secureStorage: { secure: true },
};
const settingsHtml = renderSettings();
assert.match(settingsHtml, /飞书连接/);
assert.match(settingsHtml, /绑定 654321/);
assert.match(settingsHtml, /class="feishu-enabled-toggle"/);
assert.match(settingsHtml, /class="feishu-switch-control"/);
assert.equal(settingsHtml.includes('app_secret_a'), false);
assert.match(renderSettingsSidebar(), /data-settings-section="connections"/);

let statusCalls = 0;
state.currentTab = 'settings';
state.currentSettingsSection = 'connections';
state.feishuStatus = null;
state.feishuLoading = false;
const pollingController = createRuntimeSettingsController({
  api: {
    async feishuStatus() {
      statusCalls += 1;
      return { connectionState: statusCalls === 1 ? 'connecting' : 'connected' };
    },
  },
  state,
  render() {},
  notify() {},
  appendStatus() {},
  reasoningOptionsForModel: () => [],
  modelCatalogEntry: () => null,
  escapeAttr: (value) => String(value || ''),
  escapeHtml: (value) => String(value || ''),
  documentRef: { addEventListener() {}, querySelectorAll: () => [] },
  windowRef: { setTimeout, clearTimeout },
});
await pollingController.loadFeishuStatus();
await waitFor(() => state.feishuStatus?.connectionState === 'connected', 2500);
assert.equal(statusCalls, 2);

console.log('Feishu remote channel smoke passed.');
