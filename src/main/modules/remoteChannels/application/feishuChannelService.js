import crypto from 'node:crypto';

import { ConversationSerialQueue } from './conversationSerialQueue.js';
import { ExternalUserInputCoordinator } from './externalUserInputCoordinator.js';

const PAIRING_TTL_MS = 5 * 60 * 1000;
const REPLY_CHUNK_SIZE = 3500;
const TASK_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;
const DELEGATION_CARD_TIMEOUT_MS = 10 * 60 * 1000;
const DELEGATION_CARD_CONTACT_LIMIT = 100;
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const PENDING_DELEGATION_MODES = new Set(['awaiting_confirmation', 'clarification', 'context_collected', 'execution_mode_choice']);
const IMMEDIATE_REMOTE_COMMANDS = new Set(['delegate_picker', 'projects', 'select_project', 'status', 'stop', 'approval', 'task_input', 'set_mode', 'mode_status']);
const TARGET_REMOTE_COMMANDS = new Set(['agents', 'select_agent', 'agent_status']);

function pairingHash(code, salt) {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function pairingMatches(pairing, code) {
  if (!pairing?.hash || !pairing?.salt || Date.parse(pairing.expiresAt || '') <= Date.now()) return false;
  const expected = Buffer.from(pairing.hash, 'hex');
  const actual = Buffer.from(pairingHash(code, pairing.salt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function pairingCommand(text) {
  return String(text || '').trim().match(/^(?:绑定|bind)\s*([0-9]{6})$/i)?.[1] || '';
}
function remoteCommand(text = "") {
  const value = String(text || "").trim();
  if (/^(?:分配任务|委派任务|assign task)$/i.test(value)) return { type: 'delegate_picker', value: '' };
  let match = value.match(/^(?:分配任务|委派任务|assign task)(?:\s*[:：]\s*|\s+)([\s\S]+)$/i);
  if (match) return { type: 'delegate_picker', value: match[1].trim() };
  if (/^(?:智能体列表|员工列表|agents|employees)$/i.test(value)) return { type: 'agents' };
  if (/^(?:当前智能体|当前员工|current agent|current employee)$/i.test(value)) return { type: 'agent_status' };
  match = value.match(/^(?:选择智能体|切换智能体|选择员工|切换员工|select agent|select employee)\s+([\s\S]+)$/i);
  if (match) return { type: 'select_agent', value: match[1].trim() };
  if (/^(?:任务模式|task mode|task)$/i.test(value)) return { type: "set_mode", mode: "task" };
  if (/^(?:询问模式|ask mode|ask)$/i.test(value)) return { type: "set_mode", mode: "ask" };
  if (/^(?:当前模式|模式|mode)$/i.test(value)) return { type: "mode_status" };
  match = value.match(/^(?:任务|task)\s+([\s\S]+)$/i);
  if (match) return { type: "task", value: match[1].trim() };
  if (/^(?:项目列表|projects)$/i.test(value)) return { type: "projects" };
  match = value.match(/^(?:选择项目|select project)\s+([\s\S]+)$/i);
  if (match) return { type: "select_project", value: match[1].trim() };
  match = value.match(/^(?:状态|status)(?:\s+([\w-]+))?$/i);
  if (match) return { type: "status", code: String(match[1] || "").trim() };
  match = value.match(/^(?:停止|stop)\s+([\w-]+)$/i);
  if (match) return { type: "stop", code: match[1] };
  match = value.match(/^(批准|拒绝|approve|reject)\s+(A-[A-Z0-9]+)$/i);
  if (match) return { type: "approval", approved: /^(?:批准|approve)$/i.test(match[1]), code: match[2].toUpperCase() };
  match = value.match(/^(回答|answer)\s+(Q-[A-Z0-9]+)\s+([\s\S]+)$/i);
  if (match) return { type: "task_input", code: match[2].toUpperCase(), value: match[3].trim() };
  match = value.match(/^(跳过|skip|取消|cancel)\s+(Q-[A-Z0-9]+)$/i);
  if (match) return { type: "task_input", code: match[2].toUpperCase(), value: match[1] };
  return null;
}

function delegationPickerCard({ requestId = '', instruction = '', contacts = [] } = {}) {
  const visibleContacts = contacts.slice(0, DELEGATION_CARD_CONTACT_LIMIT);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '选择 Janus 联系人 · 委托给对方 uBuddy' },
    },
    elements: [
      {
        // Feishu's card renderer applies an adaptive foreground to markdown
        // elements. A plain-text div can inherit the light card-title color in
        // some clients, leaving white copy on the card's white body.
        tag: 'markdown',
        content: instruction
          ? `任务：${String(instruction).slice(0, 800)}`
          : '先选择一位 Janus 联系人；确认后任务会交给对方的 uBuddy。',
      },
      {
        tag: 'action',
        layout: 'flow',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: '选择一位联系人进行分配' },
            options: visibleContacts.map((contact) => ({
              text: {
                tag: 'plain_text',
                content: `${contact.displayName || contact.username}${contact.username ? ` (@${contact.username})` : ''} · 对方 uBuddy`.slice(0, 100),
              },
              value: contact.userId,
            })),
            value: { action: 'select_delegation_contact', requestId },
            confirm: {
              title: { tag: 'plain_text', content: '确认分配' },
              text: {
                tag: 'plain_text',
                content: instruction
                  ? '选择后将由 uBuddy 整理委托要求，并继续确认派发流程。'
                  : '选择后请在聊天框发送完整任务要求。',
              },
            },
          },
          {
            tag: 'button',
            type: 'default',
            text: { tag: 'plain_text', content: '取消' },
            value: { action: 'cancel_delegation_contact', requestId },
          },
        ],
      },
      {
        tag: 'note',
        elements: [{
          tag: 'lark_md',
          content: contacts.length > visibleContacts.length
            ? `当前显示前 ${visibleContacts.length} 位联系人，请在 Janus 中整理联系人后重试。`
            : '列表来自 Janus 当前账号可 @ 的好友和组织成员。这里 @ 的是 Janus 用户，不是飞书用户；确认后会委托给对方的 uBuddy。',
        }],
      },
    ],
  };
}

function normalizeCardActionEvent(data = {}) {
  const event = data.event || data;
  const context = event.context || {};
  const value = event.action?.value;
  let normalizedValue = value;
  if (typeof value === 'string') {
    try { normalizedValue = JSON.parse(value); } catch { normalizedValue = {}; }
  }
  return {
    messageId: String(context.open_message_id || event.open_message_id || '').trim(),
    chatId: String(context.open_chat_id || event.open_chat_id || '').trim(),
    operatorOpenId: String(event.operator?.open_id || '').trim(),
    action: String(normalizedValue?.action || '').trim(),
    requestId: String(normalizedValue?.requestId || '').trim(),
    option: String(event.action?.option || '').trim(),
  };
}

function delegationSelectionKey({ tenantKey = '', chatId = '', senderId = '' } = {}) {
  return `${String(tenantKey)}:${String(chatId)}:${String(senderId)}`;
}

function shortCode(prefix, value = "") {
  return prefix + "-" + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 6).toUpperCase();
}

function replyUuid(prefix = '', index = 0) {
  const digest = crypto.createHash('sha256').update(`${prefix}:${index}`).digest('hex').slice(0, 32);
  return `janus-${digest}`;
}

function taskCode(taskRunId = "") {
  return shortCode("T", taskRunId);
}

function publicTaskStatus(task = {}) {
  return ({ planning: "规划中", pending: "待处理", ready: "已就绪", queued: "排队中", running: "执行中", waiting: "等待中", verifying: "校验中", delivering: "交付中", completed: "已完成", failed: "执行失败", cancelling: "停止中", cancelled: "已停止" })[String(task.status || "")] || String(task.status || "未知");
}

function redactApprovalText(value = "") {
  return String(value || "")
    .replace(/((?:^|\s)(?:--?)?(?:token|secret|password|api[-_]?key|access[-_]?key|private[-_]?key)(?:\s+|=))(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)\S+/gi, "$1[REDACTED]");
}

function safeApprovalDetail(event = {}) {
  const command = redactApprovalText(event.command).slice(0, 1200);
  const reason = redactApprovalText(event.reason).slice(0, 600);
  return [reason ? "原因：" + reason : "", command ? "命令：" + command : ""].filter(Boolean).join("\n");
}


function splitReply(text, chunkSize = REPLY_CHUNK_SIZE) {
  const source = String(text || '').trim();
  if (!source) return [];
  const chunks = [];
  let rest = source;
  while (rest.length > chunkSize) {
    let boundary = rest.lastIndexOf('\n', chunkSize);
    if (boundary < Math.floor(chunkSize * 0.6)) boundary = rest.lastIndexOf(' ', chunkSize);
    if (boundary < Math.floor(chunkSize * 0.6)) boundary = chunkSize;
    chunks.push(rest.slice(0, boundary).trim());
    rest = rest.slice(boundary).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function safeErrorMessage(error) {
  const code = String(error?.code || '');
  if (code === 'external_channel_user_changed') return 'Janus 当前登录账号已变化，请在桌面端重新启用飞书连接。';
  if (code === 'external_channel_workspace_changed') return 'Janus 当前工作空间已变化，请在桌面端重新保存飞书连接。';
  if (code === 'external_channel_read_only_unavailable') return '当前版本尚未启用只读问答模式，飞书消息未执行。';
  if (code === 'external_channel_task_unavailable') return '当前版本尚未启用飞书远程任务模式。';
  if (code === 'external_channel_project_unavailable') return '所选项目已经不可用，请重新发送“项目列表”并选择项目。';
  if (code === 'external_channel_agent_unavailable') return '所选智能体已停用或不可用，请发送“智能体列表”重新选择。';
  return '处理消息时发生错误，请回到 Janus 桌面端查看连接状态后重试。';
}

export class FeishuChannelService {
  constructor({
    runtime, credentialCodec, configRepository, clientFactory, parseMessageEvent,
    onSessionUpdated = () => {}, logger = console, userInputTimeoutMs,
  } = {}) {
    this.runtime = runtime;
    this.logger = logger;
    this.codec = credentialCodec;
    this.repository = configRepository;
    this.clientFactory = clientFactory;
    this.parseMessageEvent = parseMessageEvent;
    this.onSessionUpdated = onSessionUpdated;
    if (!this.codec || !this.repository || typeof this.clientFactory !== 'function' || typeof this.parseMessageEvent !== 'function') {
      throw new Error('Feishu channel infrastructure dependencies are required.');
    }
    this.queue = new ConversationSerialQueue();
    this.cancelledSourceMessageIds = new Set();
    this.taskApprovals = new Map();
    this.chatApprovals = new Map();
    this.taskInputs = new Map();
    this.taskSourceRoutes = new Map();
    this.delegationCards = new Map();
    this.delegationSelections = new Map();
    this.userInputs = new ExternalUserInputCoordinator({
      timeoutMs: userInputTimeoutMs,
      onExpired: (pending) => this.expireUserInput(pending),
    });
    this.client = null;
    this.activeScope = null;
    this.config = null;
    this.bindingCode = '';
    this.connection = { connectionState: 'disabled', lastError: '' };
  }

  currentScope({ required = true } = {}) {
    const user = this.runtime?.currentUser?.() || null;
    if (!user?.id) {
      if (!required) return null;
      throw new Error('请先登录 Janus 账号。');
    }
    return { userId: user.id, deviceId: this.runtime.store?.contextDeviceId?.() || 'local' };
  }

  activeWorkspaceId() {
    const user = this.runtime?.currentUser?.();
    return user ? this.runtime.store?.activeAccountWorkspace?.({
      userId: user.id,
      deviceId: this.runtime.store?.contextDeviceId?.() || 'local',
    })?.id || 'workspace_personal' : '';
  }

  loadCurrentConfig() {
    const scope = this.currentScope();
    const sameScope = this.activeScope?.userId === scope.userId && this.activeScope?.deviceId === scope.deviceId;
    if (!sameScope) {
      this.activeScope = scope;
      this.config = this.repository.load(scope);
      this.bindingCode = '';
    }
    return this.config;
  }

  persist(config = this.config) {
    if (!this.activeScope) this.activeScope = this.currentScope();
    this.config = this.repository.save(this.activeScope, { ...config, updatedAt: new Date().toISOString() });
    return this.config;
  }

  status() {
    let config = null;
    let storageError = '';
    try { config = this.loadCurrentConfig(); } catch (error) { storageError = String(error?.message || error); }
    const liveConnectionState = this.client?.connectionStatus?.()?.state || '';
    const connectionState = liveConnectionState === 'failed'
      ? 'error'
      : ['connecting', 'connected', 'reconnecting'].includes(liveConnectionState)
        ? liveConnectionState
        : this.connection.connectionState;
    return {
      ...this.repository.publicStatus(config),
      connectionState,
      lastError: this.connection.lastError || storageError,
      bindingCode: this.bindingCode,
      bindingCodeExpiresAt: config?.pairing?.expiresAt || '',
      secureStorage: this.codec.status(),
      queuedConversationCount: this.queue.size(),
      pendingUserInputCount: this.userInputs.size(),
      pendingTaskApprovalCount: this.taskApprovals.size,
      pendingChatApprovalCount: this.chatApprovals.size,
      pendingTaskInputCount: this.taskInputs.size,
      pendingDelegationCardCount: this.delegationCards.size,
      pendingDelegationSelectionCount: this.delegationSelections.size,
    };
  }

  async testConfig({ appId = '', appSecret = '', domain = 'feishu' } = {}) {
    const existing = this.loadCurrentConfig();
    const candidate = {
      appId: String(appId || existing?.appId || '').trim(),
      appSecret: String(appSecret || existing?.appSecret || ''),
      domain: domain === 'lark' ? 'lark' : 'feishu',
    };
    if (!candidate.appId || !candidate.appSecret) throw new Error('请填写 App ID 和 App Secret。');
    const client = this.clientFactory({ config: candidate, logger: this.logger });
    await client.testConnection();
    return { ok: true, appId: candidate.appId, domain: candidate.domain };
  }

  async saveConfig({ appId = '', appSecret = '', domain = 'feishu', enabled = false } = {}) {
    const existing = this.loadCurrentConfig();
    const nextAppId = String(appId || '').trim();
    const nextSecret = String(appSecret || existing?.appSecret || '');
    if (!nextAppId || !nextSecret) throw new Error('请填写 App ID 和 App Secret。');
    const sameApp = existing?.appId === nextAppId && existing?.domain === (domain === 'lark' ? 'lark' : 'feishu');
    const accountWorkspaceId = this.activeWorkspaceId();
    const session = this.runtime.ensureSecretarySession({
      sessionId: sameApp ? existing?.sessionId || '' : '',
      accountWorkspaceId,
    });
    this.persist({
      ...(sameApp ? existing : {}),
      enabled: enabled === true,
      appId: nextAppId,
      appSecret: nextSecret,
      domain: domain === 'lark' ? 'lark' : 'feishu',
      accountWorkspaceId,
      sessionId: session.id,
      binding: sameApp ? existing?.binding || null : null,
      pairing: sameApp ? existing?.pairing || null : null,
      recentMessageIds: sameApp ? existing?.recentMessageIds || [] : [],
    });
    if (!this.config.binding && !this.config.pairing) this.regenerateBindingCode();
    await this.reconcile();
    return this.status();
  }

  async enable() {
    const config = this.loadCurrentConfig();
    if (!config?.appId || !config?.appSecret) throw new Error('请先保存飞书 App ID 和 App Secret。');
    this.persist({ ...config, enabled: true });
    await this.reconcile();
    return this.status();
  }

  async disable() {
    const config = this.loadCurrentConfig();
    if (config) this.persist({ ...config, enabled: false });
    this.stop();
    return this.status();
  }

  regenerateBindingCode() {
    const config = this.loadCurrentConfig();
    if (!config?.appId || !config?.appSecret) throw new Error('请先保存飞书配置。');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('hex');
    this.bindingCode = code;
    this.persist({
      ...config,
      binding: null,
      pairing: { hash: pairingHash(code, salt), salt, expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString() },
    });
    return this.status();
  }

  unbind() {
    const config = this.loadCurrentConfig();
    if (!config) return this.status();
    this.bindingCode = '';
    this.persist({
      ...config,
      binding: null,
      pairing: null,
      selectedProjectId: '',
      messageMode: 'ask',
      routeTarget: { kind: 'ubuddy', agentInstanceId: '', selectedAt: '' },
      taskRoutes: [],
      pendingDelegation: null,
    });
    for (const pending of this.taskApprovals.values()) if (pending.timer) clearTimeout(pending.timer);
    this.taskApprovals.clear();
    for (const pending of this.chatApprovals.values()) if (pending.timer) clearTimeout(pending.timer);
    this.chatApprovals.clear();
    this.taskInputs.clear();
    this.taskSourceRoutes.clear();
    this.clearDelegationCards();
    return this.regenerateBindingCode();
  }

  async reconcile() {
    const scope = this.currentScope({ required: false });
    if (!scope) {
      this.stop();
      this.activeScope = null;
      this.config = null;
      return this.status();
    }
    let config;
    try { config = this.loadCurrentConfig(); } catch (error) {
      this.stop();
      this.connection = { connectionState: 'error', lastError: String(error?.message || error) };
      return this.status();
    }
    if (!config?.enabled || !config.appId || !config.appSecret) {
      this.stop();
      return this.status();
    }
    if (config.accountWorkspaceId !== this.activeWorkspaceId()) {
      this.stop();
      this.connection = {
        connectionState: 'paused',
        lastError: '当前账户工作空间与飞书配置不一致；切回原工作空间或重新保存配置。',
      };
      return this.status();
    }
    if (this.client) this.stop();
    this.client = this.clientFactory({
      config,
      logger: this.logger,
      onMessage: (event) => this.receive(event),
      onCardAction: (event) => this.receiveCardAction(event),
      onStatus: (update) => { this.connection = { ...this.connection, ...update }; },
    });
    this.client.start();
    queueMicrotask(() => this.drainPendingTaskNotifications().catch((error) => {
      this.logger.warn?.('Feishu task notification reconciliation failed.', error);
    }));
    return this.status();
  }

  stop() {
    this.client?.stop?.();
    this.client = null;
    this.clearDelegationCards();
    this.connection = { connectionState: 'disabled', lastError: '' };
  }

  clearDelegationCards() {
    for (const pending of this.delegationCards.values()) if (pending.timer) clearTimeout(pending.timer);
    this.delegationCards.clear();
    for (const pending of this.delegationSelections.values()) if (pending.timer) clearTimeout(pending.timer);
    this.delegationSelections.clear();
  }

  receiveCardAction(rawEvent) {
    const event = normalizeCardActionEvent(rawEvent);
    const binding = this.config?.binding;
    if (!binding?.openId || event.operatorOpenId !== binding.openId) {
      return { toast: { type: 'error', content: '当前飞书账号没有操作这张卡片的权限。' } };
    }
    const pending = this.delegationCards.get(event.requestId);
    if (!pending || pending.expiresAt <= Date.now()) {
      if (pending?.timer) clearTimeout(pending.timer);
      this.delegationCards.delete(event.requestId);
      return { toast: { type: 'warning', content: '这张联系人卡片已失效，请重新发送“分配任务”。' } };
    }
    if (pending.chatId !== event.chatId || pending.senderId !== event.operatorOpenId) {
      return { toast: { type: 'error', content: '卡片会话校验失败，请重新发起分配任务。' } };
    }
    if (event.action === 'cancel_delegation_contact') {
      if (pending.timer) clearTimeout(pending.timer);
      this.delegationCards.delete(event.requestId);
      return { toast: { type: 'success', content: '已取消本次任务分配。' } };
    }
    if (event.action !== 'select_delegation_contact') {
      return { toast: { type: 'warning', content: '无法识别这个卡片操作。' } };
    }
    const contact = pending.contacts.find((item) => item.userId === event.option);
    if (!contact?.username) {
      return { toast: { type: 'error', content: '联系人已经不可用，请重新发起分配任务。' } };
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.delegationCards.delete(event.requestId);
    if (!pending.instruction) {
      const selectionKey = delegationSelectionKey(pending.incoming);
      const timer = setTimeout(() => this.delegationSelections.delete(selectionKey), DELEGATION_CARD_TIMEOUT_MS);
      timer.unref?.();
      this.delegationSelections.set(selectionKey, {
        contact,
        expiresAt: Date.now() + DELEGATION_CARD_TIMEOUT_MS,
        timer,
      });
      void this.replyChunks(
        pending.incoming.messageId,
        `已选择 ${contact.displayName || contact.username}（@${contact.username}）。请直接发送完整任务要求。`,
        `delegation-card-selected:${event.requestId}`,
      ).catch((error) => this.logger.warn?.('Feishu delegation card selection prompt failed.', error));
      return { toast: { type: 'success', content: `已选择 ${contact.displayName || contact.username}，请继续发送任务要求。` } };
    }
    const incoming = {
      ...pending.incoming,
      text: `@${contact.username} ${pending.instruction}`,
      janusMention: {
        username: contact.username,
        displayText: `@${contact.username}`,
        instruction: pending.instruction,
      },
    };
    const key = `${incoming.tenantKey}:${incoming.chatId || incoming.senderId}`;
    this.queue.enqueue(key, () => this.processJanusUserDelegation(incoming)).catch((error) => {
      this.logger.error?.('Feishu delegation card selection failed.', error);
      void this.replyChunks(
        incoming.messageId,
        '联系人已选择，但委托处理失败。请重新发送“分配任务”。',
        `delegation-card-error:${event.requestId}`,
      ).catch(() => {});
    });
    return { toast: { type: 'success', content: `已选择 ${contact.displayName || contact.username}，uBuddy 正在整理委托。` } };
  }

  receive(rawEvent) {
    const incoming = this.parseMessageEvent(rawEvent);
    if (!incoming.accepted || !this.config?.enabled) return { accepted: false, reason: incoming.reason || 'disabled' };
    this.connection = { connectionState: 'connected', lastError: '' };
    if ((this.config.recentMessageIds || []).includes(incoming.messageId)) return { accepted: false, reason: 'duplicate' };
    this.persist({
      ...this.config,
      recentMessageIds: [...(this.config.recentMessageIds || []), incoming.messageId],
    });
    const key = `${incoming.tenantKey}:${incoming.chatId || incoming.senderId}`;
    const binding = this.config?.binding;
    const boundSender = binding?.openId === incoming.senderId
      && (!binding.tenantKey || binding.tenantKey === incoming.tenantKey);
    const immediateCommand = boundSender ? remoteCommand(incoming.text) : null;
    if (immediateCommand && IMMEDIATE_REMOTE_COMMANDS.has(immediateCommand.type)) {
      void this.processRemoteCommand(incoming, immediateCommand).catch((error) => {
        this.logger.error?.('Feishu immediate command response failed.', error);
      });
      return { accepted: true, immediateCommand: immediateCommand.type };
    }
    if (boundSender && immediateCommand && TARGET_REMOTE_COMMANDS.has(immediateCommand.type) && this.userInputs.has(key)) {
      void this.processRemoteCommand(incoming, immediateCommand).catch((error) => {
        this.logger.error?.('Feishu target command response failed.', error);
      });
      return { accepted: true, immediateCommand: immediateCommand.type };
    }
    if (boundSender && this.userInputs.has(key)) {
      void this.processUserInput(incoming, key).catch((error) => {
        this.logger.error?.('Feishu user-input response failed.', error);
      });
      return { accepted: true, userInput: true };
    }
    this.queue.enqueue(key, () => this.processIncoming(incoming)).catch((error) => {
      this.logger.error?.('Feishu queued message failed.', error);
    });
    return { accepted: true, queued: true };
  }

  async processIncoming(incoming) {
    const code = pairingCommand(incoming.text);
    const binding = this.config?.binding;
    if (!binding) {
      if (!code || !pairingMatches(this.config?.pairing, code)) return;
      this.bindingCode = '';
      this.persist({
        ...this.config,
        binding: { openId: incoming.senderId, tenantKey: incoming.tenantKey, boundAt: new Date().toISOString() },
        pairing: null,
      });
      await this.replyChunks(incoming.messageId, '绑定成功。当前为 ASK 模式，可以进行只读问答。\n如需执行项目任务，请发送“项目列表”并选择项目。', `bind:${incoming.messageId}`);
      return;
    }
    if (binding.openId !== incoming.senderId || (binding.tenantKey && binding.tenantKey !== incoming.tenantKey)) return;
    if (code) {
      await this.replyChunks(incoming.messageId, '此飞书账号已经绑定，无需重复绑定。', `bound:${incoming.messageId}`);
      return;
    }
    const command = remoteCommand(incoming.text);
    if (command) {
      await this.processRemoteCommand(incoming, command);
      return;
    }
    const selectionKey = delegationSelectionKey(incoming);
    const pendingSelection = this.delegationSelections.get(selectionKey);
    if (pendingSelection) {
      if (pendingSelection.timer) clearTimeout(pendingSelection.timer);
      this.delegationSelections.delete(selectionKey);
      if (pendingSelection.expiresAt > Date.now() && pendingSelection.contact?.username) {
        await this.processJanusUserDelegation({
          ...incoming,
          text: `@${pendingSelection.contact.username} ${incoming.text}`,
          janusMention: {
            username: pendingSelection.contact.username,
            displayText: `@${pendingSelection.contact.username}`,
            instruction: incoming.text,
          },
        });
        return;
      }
    }
    const pendingDelegation = this.config?.pendingDelegation;
    const continuesDelegation = pendingDelegation
      && pendingDelegation.chatId === incoming.chatId
      && pendingDelegation.senderId === incoming.senderId
      && (!pendingDelegation.tenantKey || pendingDelegation.tenantKey === incoming.tenantKey);
    if (incoming.janusMention || continuesDelegation) {
      await this.processJanusUserDelegation(incoming, { continuesDelegation });
      return;
    }
    if (this.config?.routeTarget?.kind === 'employee') {
      await this.processAgentChat(incoming);
      return;
    }
    if (this.config?.messageMode === 'task') {
      await this.processRemoteCommand(incoming, { type: 'task', value: String(incoming.text || '').trim() });
      return;
    }
    await this.replyChunks(incoming.messageId, '已收到，正在处理。', `ack:${incoming.messageId}`);
    try {
      const conversationKey = `${incoming.tenantKey}:${incoming.chatId || incoming.senderId}`;
      const result = await this.runtime.externalChannelChat({
        provider: 'feishu',
        expectedUserId: this.activeScope.userId,
        accountWorkspaceId: this.config.accountWorkspaceId,
        sessionId: this.config.sessionId,
        externalMessageId: incoming.messageId,
        externalUserId: incoming.senderId,
        externalChatId: incoming.chatId,
        message: incoming.text,
        onEvent: (event) => this.handleExternalEvent(incoming, conversationKey, event),
      });
      if (result?.cancelled && this.cancelledSourceMessageIds.delete(incoming.messageId)) {
        this.notifySessionUpdated({
          sessionId: result?.session?.id || this.config.sessionId,
          phase: 'cancelled',
          externalMessageId: incoming.messageId,
          messageId: result?.message?.id || '',
        });
        return;
      }
      if (result?.session?.id && result.session.id !== this.config.sessionId) {
        this.persist({ ...this.config, sessionId: result.session.id });
      }
      this.notifySessionUpdated({
        sessionId: result?.session?.id || this.config.sessionId,
        phase: 'completed',
        externalMessageId: incoming.messageId,
        messageId: result?.message?.id || '',
      });
      await this.replyChunks(incoming.messageId, result?.answer || 'uBuddy 已完成处理，但没有返回文本内容。', `answer:${incoming.messageId}`);
    } catch (error) {
      if (this.cancelledSourceMessageIds.delete(incoming.messageId)) return;
      this.logger.error?.('Feishu agent request failed.', error);
      await this.replyChunks(incoming.messageId, safeErrorMessage(error), `error:${incoming.messageId}`);
    }
  }

  async processJanusUserDelegation(incoming, { continuesDelegation = false } = {}) {
    let mentions = [];
    let username = this.config?.pendingDelegation?.username || '';
    if (incoming.janusMention) {
      username = incoming.janusMention.username;
      if (!incoming.janusMention.instruction) {
        await this.replyChunks(
          incoming.messageId,
          `请在 @${username} 后补充任务要求和期望交付物。`,
          `delegation-requirement:${incoming.messageId}`,
        );
        return;
      }
      const resolved = this.runtime.resolveExternalChannelJanusMention({
        ...this.externalRuntimeScope(incoming),
        username,
        displayText: incoming.janusMention.displayText,
        mentionId: `feishu:${incoming.messageId}:${username}`,
      });
      if (!resolved?.ok) {
        const message = resolved?.reason === 'ambiguous'
          ? `Janus 通讯录中存在重复用户名 @${username}，为避免误派，本次委托已停止。`
          : `Janus 通讯录中没有用户 @${username}。请确认用户名，并先在 Janus 中添加为联系人或组织成员。`;
        await this.replyChunks(incoming.messageId, message, `delegation-contact:${incoming.messageId}`);
        return;
      }
      mentions = [resolved.mention];
      this.persist({
        ...this.config,
        routeTarget: { kind: 'ubuddy', agentInstanceId: '', selectedAt: new Date().toISOString() },
        pendingDelegation: {
          username,
          chatId: incoming.chatId,
          senderId: incoming.senderId,
          tenantKey: incoming.tenantKey,
          startedAt: new Date().toISOString(),
        },
      });
      await this.replyChunks(
        incoming.messageId,
        `已识别 Janus 委托对象：${resolved.contact.displayName}（@${username}）。正在整理委托要求。`,
        `delegation-ack:${incoming.messageId}`,
      );
    } else if (continuesDelegation) {
      await this.replyChunks(incoming.messageId, `已收到，正在继续处理给 @${username} 的委托。`, `delegation-continue:${incoming.messageId}`);
    }
    try {
      const conversationKey = `${incoming.tenantKey}:${incoming.chatId || incoming.senderId}`;
      const result = await this.runtime.externalChannelDelegation({
        ...this.externalRuntimeScope(incoming),
        sessionId: this.config.sessionId,
        externalMessageId: incoming.messageId,
        message: incoming.text,
        mentions,
        onEvent: (event) => this.handleExternalEvent(incoming, conversationKey, event),
      });
      const pending = PENDING_DELEGATION_MODES.has(String(result?.uBuddyMode || ''));
      this.persist({
        ...this.config,
        ...(result?.session?.id ? { sessionId: result.session.id } : {}),
        pendingDelegation: pending ? this.config.pendingDelegation : null,
      });
      this.notifySessionUpdated({
        sessionId: result?.session?.id || this.config.sessionId,
        phase: result?.uBuddyMode === 'cancelled' ? 'cancelled' : 'completed',
        externalMessageId: incoming.messageId,
        messageId: result?.message?.id || '',
      });
      await this.replyChunks(incoming.messageId, result?.answer || 'uBuddy 已处理委托，但没有返回文本内容。', `delegation-answer:${incoming.messageId}`);
    } catch (error) {
      this.persist({ ...this.config, pendingDelegation: null });
      this.logger.error?.('Feishu Janus user delegation failed.', error);
      await this.replyChunks(incoming.messageId, safeErrorMessage(error), `delegation-error:${incoming.messageId}`);
    }
  }

  agents() {
    return this.runtime.externalChannelAgents({
      expectedUserId: this.activeScope?.userId || '',
      accountWorkspaceId: this.config?.accountWorkspaceId || '',
    });
  }

  selectedAgent() {
    const selectedId = this.config?.routeTarget?.kind === 'employee'
      ? this.config.routeTarget.agentInstanceId
      : '';
    return selectedId ? this.agents().find((item) => item.agentInstanceId === selectedId) || null : null;
  }

  async processAgentChat(incoming) {
    const selected = this.selectedAgent();
    if (!selected) {
      await this.replyChunks(
        incoming.messageId,
        '所选智能体已停用或不可用，请发送“智能体列表”重新选择，或发送“选择智能体 uBuddy”。',
        `agent-unavailable:${incoming.messageId}`,
      );
      return;
    }
    await this.replyChunks(incoming.messageId, `已收到，正在交给 ${selected.displayName} 处理。`, `agent-ack:${incoming.messageId}`);
    try {
      const conversationKey = `${incoming.tenantKey}:${incoming.chatId || incoming.senderId}`;
      const result = await this.runtime.externalChannelAgentChat({
        ...this.externalRuntimeScope(incoming),
        agentInstanceId: selected.agentInstanceId,
        projectId: this.config?.selectedProjectId || '',
        externalMessageId: incoming.messageId,
        message: incoming.text,
        onEvent: (event) => this.handleExternalEvent(incoming, conversationKey, event, { agent: selected }),
      });
      if (result?.cancelled && this.cancelledSourceMessageIds.delete(incoming.messageId)) {
        this.notifySessionUpdated({
          sessionId: result?.session?.id || '', phase: 'cancelled', externalMessageId: incoming.messageId,
          messageId: result?.message?.id || '',
          agentInstanceId: result?.session?.agentInstanceId || selected.agentInstanceId,
        });
        return;
      }
      this.notifySessionUpdated({
        sessionId: result?.session?.id || '', phase: 'completed', externalMessageId: incoming.messageId,
        messageId: result?.message?.id || '',
        agentInstanceId: result?.session?.agentInstanceId || selected.agentInstanceId,
      });
      await this.replyChunks(
        incoming.messageId,
        result?.answer || `${selected.displayName} 已完成处理，但没有返回文本内容。`,
        `agent-answer:${incoming.messageId}`,
      );
    } catch (error) {
      if (this.cancelledSourceMessageIds.delete(incoming.messageId)) return;
      this.logger.error?.('Feishu employee Agent request failed.', error);
      await this.replyChunks(incoming.messageId, safeErrorMessage(error), `agent-error:${incoming.messageId}`);
    }
  }

  async processTaskInput(incoming, command) {
    const pending = this.taskInputs.get(command.code);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.taskInputs.delete(command.code);
      await this.replyChunks(incoming.messageId, "该补充请求已失效或不存在。", "task-input-expired:" + incoming.messageId);
      return;
    }
    const response = pending.coordinator.consume("input", command.value);
    if (!response.handled || response.status === "invalid") {
      await this.replyChunks(incoming.messageId, response.message || "回答格式无效。", "task-input-invalid:" + incoming.messageId);
      return;
    }
    if (response.status === "next") {
      await this.replyChunks(incoming.messageId, response.prompt + "\n\n请回复“回答 " + command.code + " 你的答案”。", "task-input-next:" + incoming.messageId);
      return;
    }
    if (response.status === "cancelled") {
      this.taskInputs.delete(command.code);
      await this.runtime.cancelExternalTaskInteraction({ ...this.externalRuntimeScope(incoming), taskRunId: pending.taskRunId, runId: pending.runId });
      const task = this.runtime.cancelExternalTask({ ...this.externalRuntimeScope(incoming), taskRunId: pending.taskRunId });
      await this.replyChunks(incoming.messageId, task ? "任务已停止。" : "任务已经结束。", "task-input-cancel:" + incoming.messageId);
      return;
    }
    const result = this.runtime.resolveExternalTaskUserInput({
      ...this.externalRuntimeScope(incoming), taskRunId: pending.taskRunId, runId: pending.runId, requestId: pending.requestId,
      answers: response.answers, skippedQuestionIds: response.skippedQuestionIds,
    });
    if (result?.ok) this.taskInputs.delete(command.code);
    await this.replyChunks(incoming.messageId, result?.ok ? "已收到补充，任务继续执行。" : result?.reason || "补充请求已失效。", "task-input-result:" + incoming.messageId);
  }

  async handleTaskUpdated(payload = {}) {
    const task = payload?.task || null;
    if (!task?.id || !this.config?.enabled || !this.client) return false;
    let route = (this.config.taskRoutes || []).find((item) => item.taskRunId === task.id);
    if (!route) {
      const sourceRoute = this.taskSourceRoutes.get(String(task.metadata?.sourceSecretaryMessageId || ''));
      if (sourceRoute) {
        route = { taskRunId: task.id, ...sourceRoute, deliveredEventKeys: [] };
        this.persist({ ...this.config, taskRoutes: [...(this.config.taskRoutes || []).filter((item) => item.taskRunId !== task.id), route] });
      }
    }
    if (!route) return false;
    const event = payload?.change?.interaction || null;
    if (payload?.change?.type === "node_interaction" && event?.kind === "approval-request") {
      const eventKey = "approval:" + String(event.approvalId || "");
      if (route.deliveredEventKeys.includes(eventKey)) return false;
      const code = shortCode("A", task.id + ":" + event.approvalId);
      const approvalTimer = setTimeout(() => {
        const pending = this.taskApprovals.get(code);
        if (!pending) return;
        this.taskApprovals.delete(code);
        this.runtime.resolveExternalTaskApproval({ ...this.externalRuntimeScope(route), taskRunId: task.id, runId: event.runId, approvalId: event.approvalId, approved: false });
        void this.replyChunks(route.externalMessageId, "审批 " + code + " 已超时，Janus 已自动拒绝。", "approval-timeout:" + event.approvalId).catch(() => {});
      }, TASK_INTERACTION_TIMEOUT_MS);
      approvalTimer.unref?.();
      this.taskApprovals.set(code, { taskRunId: task.id, runId: event.runId, approvalId: event.approvalId, expiresAt: Date.now() + TASK_INTERACTION_TIMEOUT_MS, timer: approvalTimer });
      await this.replyChunks(route.externalMessageId, "任务 " + taskCode(task.id) + " 请求审批（" + code + "）\n" + (safeApprovalDetail(event) || "Janus 请求执行一项受控操作。") + "\n\n回复“批准 " + code + "”或“拒绝 " + code + "”。", eventKey);
      this.markTaskEventDelivered(task.id, eventKey);
      return true;
    }
    if (payload?.change?.type === "node_interaction" && event?.kind === "user-input-request") {
      const eventKey = "input:" + String(event.requestId || "");
      if (route.deliveredEventKeys.includes(eventKey)) return false;
      if ((event.questions || []).some((question) => question.isSecret)) {
        await this.runtime.cancelExternalTaskInteraction({ ...this.externalRuntimeScope(route), taskRunId: task.id, runId: event.runId });
        this.runtime.cancelExternalTask({ ...this.externalRuntimeScope(route), taskRunId: task.id });
        await this.replyChunks(route.externalMessageId, "任务需要敏感信息。飞书通道不会收集此类内容，任务已停止；请回到 Janus 桌面端重新发起。", eventKey);
        this.markTaskEventDelivered(task.id, eventKey);
        return true;
      }
      const code = shortCode("Q", task.id + ":" + event.requestId);
      const coordinator = new ExternalUserInputCoordinator({ timeoutMs: TASK_INTERACTION_TIMEOUT_MS, onExpired: () => {
        this.taskInputs.delete(code);
        void this.runtime.cancelExternalTaskInteraction({ ...this.externalRuntimeScope(route), taskRunId: task.id, runId: event.runId })
          .finally(() => this.runtime.cancelExternalTask({ ...this.externalRuntimeScope(route), taskRunId: task.id }));
        void this.replyChunks(route.externalMessageId, "补充请求 " + code + " 已超时，任务已停止。", "task-input-timeout:" + event.requestId).catch(() => {});
      } });
      const started = coordinator.begin("input", event);
      if (!started.ok) return false;
      this.taskInputs.set(code, { coordinator, taskRunId: task.id, runId: event.runId, requestId: event.requestId, expiresAt: Date.now() + TASK_INTERACTION_TIMEOUT_MS });
      await this.replyChunks(route.externalMessageId, "任务 " + taskCode(task.id) + " 需要补充（" + code + "）\n" + started.prompt + "\n\n请回复“回答 " + code + " 你的答案”。", eventKey);
      this.markTaskEventDelivered(task.id, eventKey);
      return true;
    }
    if (payload?.change?.type === "task_finalized" && TERMINAL_TASK_STATUSES.has(String(task.status || ""))) {
      const eventKey = "terminal:" + task.status;
      if (route.deliveredEventKeys.includes(eventKey)) return false;
      const result = this.runtime.externalTaskResult({ ...this.externalRuntimeScope(route), taskRunId: task.id });
      const text = result?.text || ("任务" + publicTaskStatus(task) + "：" + (task.title || taskCode(task.id)));
      await this.replyChunks(route.externalMessageId, text, eventKey);
      this.markTaskEventDelivered(task.id, eventKey);
      return true;
    }
    return false;
  }

  markTaskEventDelivered(taskRunId, eventKey) {
    const routes = (this.config.taskRoutes || []).map((route) => route.taskRunId === taskRunId
      ? { ...route, deliveredEventKeys: [...new Set([...(route.deliveredEventKeys || []), eventKey])].slice(-40) }
      : route);
    this.persist({ ...this.config, taskRoutes: routes });
  }


  projects() {
    return this.runtime.externalChannelProjects({
      expectedUserId: this.activeScope?.userId || "",
      accountWorkspaceId: this.config?.accountWorkspaceId || "",
    });
  }

  contacts() {
    return this.runtime.externalChannelContacts({
      expectedUserId: this.activeScope?.userId || '',
      accountWorkspaceId: this.config?.accountWorkspaceId || '',
    });
  }

  taskRoute(code = "") {
    const clean = String(code || "").trim().toUpperCase();
    const routes = this.config?.taskRoutes || [];
    if (!clean) return routes.at(-1) || null;
    return routes.find((route) => route.taskRunId === code || taskCode(route.taskRunId) === clean) || null;
  }

  async processRemoteCommand(incoming, command) {
    if (command.type === 'delegate_picker') {
      const contacts = this.contacts();
      if (!contacts.length) {
        await this.replyChunks(
          incoming.messageId,
          '当前 Janus 账号没有可分配的联系人，请先添加好友或加入包含其他成员的组织。',
          `delegation-card-empty:${incoming.messageId}`,
        );
        return;
      }
      const requestId = crypto.randomUUID();
      this.persist({
        ...this.config,
        routeTarget: { kind: 'ubuddy', agentInstanceId: '', selectedAt: new Date().toISOString() },
        pendingDelegation: null,
      });
      const timer = setTimeout(() => this.delegationCards.delete(requestId), DELEGATION_CARD_TIMEOUT_MS);
      timer.unref?.();
      this.delegationCards.set(requestId, {
        requestId,
        instruction: command.value,
        contacts,
        incoming: { ...incoming },
        chatId: incoming.chatId,
        senderId: incoming.senderId,
        expiresAt: Date.now() + DELEGATION_CARD_TIMEOUT_MS,
        timer,
      });
      try {
        await this.client.replyCard(
          incoming.messageId,
          delegationPickerCard({ requestId, instruction: command.value, contacts }),
          replyUuid(`delegation-card:${incoming.messageId}`),
        );
      } catch (error) {
        clearTimeout(timer);
        this.delegationCards.delete(requestId);
        this.logger.warn?.('Feishu delegation contact card delivery failed.', error);
        await this.replyChunks(
          incoming.messageId,
          '联系人选择卡片发送失败。请确认飞书应用已启用消息卡片能力和 card.action.trigger 回调后重试。',
          `delegation-card-fallback:${incoming.messageId}`,
        );
      }
      return;
    }
    if (command.type === 'agents') {
      const agents = this.agents();
      const selectedId = this.config?.routeTarget?.kind === 'employee'
        ? this.config.routeTarget.agentInstanceId
        : '';
      const text = agents.length
        ? [
            '已招募智能体：',
            ...agents.map((agent, index) => `${index + 1}. ${agent.displayName}${agent.familyName && agent.familyName !== agent.displayName ? `（${agent.familyName}）` : ''}${agent.departmentName ? ` · ${agent.departmentName}` : ''}${agent.agentInstanceId === selectedId ? '（当前）' : ''}`),
            '',
            '发送“选择智能体 序号或名称”切换；发送“选择智能体 uBuddy”返回 uBuddy。',
          ].join('\n')
        : '当前没有可用的已招募智能体。发送“选择智能体 uBuddy”可继续使用 uBuddy。';
      await this.replyChunks(incoming.messageId, text, `agents:${incoming.messageId}`);
      return;
    }
    if (command.type === 'agent_status') {
      const selected = this.selectedAgent();
      const target = this.config?.routeTarget?.kind === 'employee'
        ? selected
          ? `${selected.displayName}${selected.familyName && selected.familyName !== selected.displayName ? `（${selected.familyName}）` : ''}`
          : '已失效的智能体'
        : 'uBuddy';
      const mode = this.config?.messageMode === 'task' ? 'TASK' : 'ASK';
      await this.replyChunks(
        incoming.messageId,
        `当前智能体：${target}\nuBuddy 模式：${mode}\n\n智能体直聊不创建 T-XXXXXX 任务；切回 uBuddy 后继续使用上述模式。`,
        `agent-status:${incoming.messageId}`,
      );
      return;
    }
    if (command.type === 'select_agent') {
      if (this.userInputs.size() > 0) {
        await this.replyChunks(incoming.messageId, '当前正在等待你的回答，暂时不能切换智能体。请先完成当前回答，或发送“取消”。', `agent-input-pending:${incoming.messageId}`);
        return;
      }
      if (/^(?:ubuddy|uBuddy|秘书|秘书智能体)$/i.test(command.value)) {
        this.persist({
          ...this.config,
          routeTarget: { kind: 'ubuddy', agentInstanceId: '', selectedAt: new Date().toISOString() },
          pendingDelegation: null,
        });
        const mode = this.config?.messageMode === 'task' ? 'TASK' : 'ASK';
        await this.replyChunks(incoming.messageId, `已切换到 uBuddy。当前为 ${mode} 模式。`, `agent-selected:${incoming.messageId}`);
        return;
      }
      const agents = this.agents();
      const index = Number(command.value);
      const lookup = String(command.value || '').toLowerCase();
      const matches = agents.filter((agent, agentIndex) => (
        agentIndex + 1 === index
        || agent.agentInstanceId === command.value
        || agent.displayName.toLowerCase() === lookup
        || agent.familyName.toLowerCase() === lookup
      ));
      if (matches.length !== 1) {
        await this.replyChunks(
          incoming.messageId,
          matches.length
            ? '智能体名称不唯一，请发送“智能体列表”后使用序号选择。'
            : '没有找到该智能体，请发送“智能体列表”查看可用智能体。',
          `agent-invalid:${incoming.messageId}`,
        );
        return;
      }
      this.persist({
        ...this.config,
        routeTarget: { kind: 'employee', agentInstanceId: matches[0].agentInstanceId, selectedAt: new Date().toISOString() },
        pendingDelegation: null,
      });
      await this.replyChunks(
        incoming.messageId,
        `已切换到智能体：${matches[0].displayName}。\n之后发送普通文字会直接进入该智能体的桌面主会话和 Memory，不经过 uBuddy，也不会创建 T-XXXXXX 任务。`,
        `agent-selected:${incoming.messageId}`,
      );
      return;
    }
    if (command.type === "mode_status") {
      const mode = this.config?.messageMode === 'task' ? 'TASK' : 'ASK';
      const detail = mode === 'TASK'
        ? '当前为 TASK 模式。选择的项目会作为任务工作区，普通文字会启动任务。'
        : '当前为 ASK 模式。普通文字只进行只读问答，不执行任务。';
      const selected = this.selectedAgent();
      const target = this.config?.routeTarget?.kind === 'employee'
        ? selected?.displayName || '已失效的智能体'
        : 'uBuddy';
      await this.replyChunks(incoming.messageId, `当前模式：${mode}\n当前智能体：${target}\n${detail}\n\n发送“任务模式”或“询问模式”会切回 uBuddy。`, "mode-status:" + incoming.messageId);
      return;
    }
    if (command.type === "set_mode") {
      const nextMode = command.mode === 'task' ? 'task' : 'ask';
      if (nextMode === 'task' && this.userInputs.size() > 0) {
        await this.replyChunks(incoming.messageId, "当前 ASK 正在等待你的回答，暂时不能切换到 TASK。请先完成当前回答，或发送“取消”。", "mode-input-pending:" + incoming.messageId);
        return;
      }
      if (nextMode === 'task' && !this.config?.selectedProjectId) {
        await this.replyChunks(incoming.messageId, "切换到 TASK 模式前，请先发送“项目列表”，再发送“选择项目 序号”。", "mode-project-required:" + incoming.messageId);
        return;
      }
      this.persist({
        ...this.config,
        messageMode: nextMode,
        routeTarget: { kind: 'ubuddy', agentInstanceId: '', selectedAt: new Date().toISOString() },
        pendingDelegation: null,
      });
      const label = nextMode === 'task' ? 'TASK' : 'ASK';
      await this.replyChunks(incoming.messageId, `已切换到 ${label} 模式。${nextMode === 'task' ? '之后发送普通文字即可启动项目任务。' : '之后发送普通文字只进行只读问答。'}`, "mode-set:" + incoming.messageId);
      return;
    }
    if (command.type === "projects") {
      const projects = this.projects();
      const selected = this.config?.selectedProjectId || "";
      const text = projects.length ? ["可用项目：", ...projects.map((project, index) => String(index + 1) + ". " + project.title + (project.id === selected ? "（当前）" : "")), "", "发送“选择项目 序号或项目名”设置默认项目。"].join("\n") : "当前账户工作空间没有可用项目，请先在 Janus 桌面端创建项目。";
      await this.replyChunks(incoming.messageId, text, "projects:" + incoming.messageId);
      return;
    }
    if (command.type === "select_project") {
      if (this.userInputs.size() > 0) {
        await this.replyChunks(incoming.messageId, "当前 ASK 正在等待你的回答，暂时不能选择项目并进入 TASK。请先完成当前回答，或发送“取消”。", "project-input-pending:" + incoming.messageId);
        return;
      }
      const projects = this.projects();
      const index = Number(command.value);
      const matches = projects.filter((project, projectIndex) => project.id === command.value || projectIndex + 1 === index || project.title.toLowerCase() === command.value.toLowerCase());
      if (matches.length !== 1) {
        await this.replyChunks(incoming.messageId, matches.length ? "项目名称不唯一，请发送“项目列表”后使用序号选择。" : "没有找到该项目，请发送“项目列表”查看可用项目。", "project-invalid:" + incoming.messageId);
        return;
      }
      this.persist({
        ...this.config,
        selectedProjectId: matches[0].id,
        messageMode: 'task',
        routeTarget: { kind: 'ubuddy', agentInstanceId: '', selectedAt: new Date().toISOString() },
        pendingDelegation: null,
      });
      await this.replyChunks(incoming.messageId, "已选择项目：“" + matches[0].title + "”。\n当前已进入 TASK 模式；之后直接发送任务文字即可执行。", "project-selected:" + incoming.messageId);
      return;
    }
    if (command.type === "task") {
      if (!this.config?.selectedProjectId) {
        if (this.config?.routeTarget?.kind !== 'ubuddy') {
          this.persist({
            ...this.config,
            routeTarget: { kind: 'ubuddy', agentInstanceId: '', selectedAt: new Date().toISOString() },
            pendingDelegation: null,
          });
        }
        await this.replyChunks(incoming.messageId, "请先发送“项目列表”，再用“选择项目 序号”设置任务项目。", "task-project-required:" + incoming.messageId);
        return;
      }
      if (this.config?.messageMode !== 'task' || this.config?.routeTarget?.kind !== 'ubuddy') {
        this.persist({
          ...this.config,
          messageMode: 'task',
          routeTarget: { kind: 'ubuddy', agentInstanceId: '', selectedAt: new Date().toISOString() },
          pendingDelegation: null,
        });
      }
      await this.replyChunks(incoming.messageId, "已收到，正在规划任务。", "task-ack:" + incoming.messageId);
      const result = await this.runtime.externalChannelTask({
        ...this.externalRuntimeScope(incoming),
        sessionId: this.config.sessionId,
        projectId: this.config.selectedProjectId,
        externalMessageId: incoming.messageId,
        message: command.value,
        onEvent: (event) => this.handleExternalEvent(incoming, incoming.tenantKey + ":" + (incoming.chatId || incoming.senderId), event),
      });
      if (result?.session?.id && result.session.id !== this.config.sessionId) this.persist({ ...this.config, sessionId: result.session.id });
      if (!result?.taskRunId) {
        await this.replyChunks(incoming.messageId, result?.answer || "uBuddy 没有创建任务，请根据提示补充后重试。", "task-not-created:" + incoming.messageId);
        return;
      }
      const existingRoute = (this.config.taskRoutes || []).find((item) => item.taskRunId === result.taskRunId);
      const route = { taskRunId: result.taskRunId, externalMessageId: incoming.messageId, chatId: incoming.chatId, senderId: incoming.senderId, tenantKey: incoming.tenantKey, projectId: this.config.selectedProjectId, createdAt: existingRoute?.createdAt || new Date().toISOString(), deliveredEventKeys: existingRoute?.deliveredEventKeys || [] };
      this.persist({ ...this.config, taskRoutes: [...(this.config.taskRoutes || []).filter((item) => item.taskRunId !== route.taskRunId), route] });
      await this.replyChunks(incoming.messageId, "任务已开始：" + taskCode(result.taskRunId) + "\n" + (result.task?.title || command.value) + "\n状态：" + publicTaskStatus(result.task || {}), "task-created:" + result.taskRunId);
      return;
    }
    if (command.type === "status" || command.type === "stop") {
      const route = this.taskRoute(command.code);
      if (!route) {
        await this.replyChunks(incoming.messageId, "没有找到对应的飞书任务。", "task-missing:" + incoming.messageId);
        return;
      }
      if (command.type === "stop") {
        for (const [code, pending] of this.taskApprovals) {
          if (pending.taskRunId !== route.taskRunId) continue;
          if (pending.timer) clearTimeout(pending.timer);
          this.runtime.resolveExternalTaskApproval({ ...this.externalRuntimeScope(incoming), taskRunId: pending.taskRunId, runId: pending.runId, approvalId: pending.approvalId, approved: false });
          this.taskApprovals.delete(code);
        }
        for (const [code, pending] of this.taskInputs) {
          if (pending.taskRunId !== route.taskRunId) continue;
          await this.runtime.cancelExternalTaskInteraction({ ...this.externalRuntimeScope(incoming), taskRunId: pending.taskRunId, runId: pending.runId });
          this.taskInputs.delete(code);
        }
      }
      const task = command.type === "stop"
        ? this.runtime.cancelExternalTask({ ...this.externalRuntimeScope(incoming), taskRunId: route.taskRunId })
        : this.runtime.externalTaskStatus({ ...this.externalRuntimeScope(incoming), taskRunId: route.taskRunId });
      await this.replyChunks(incoming.messageId, task ? taskCode(task.id) + " " + (task.title || "任务") + "\n状态：" + publicTaskStatus(task) + (task.summary ? "\n" + task.summary : "") : "任务不存在或已不属于当前用户。", "task-status:" + incoming.messageId);
      return;
    }
    if (command.type === "approval") {
      const pendingChat = this.chatApprovals.get(command.code);
      if (pendingChat) {
        if (pendingChat.expiresAt <= Date.now()) {
          if (pendingChat.timer) clearTimeout(pendingChat.timer);
          this.chatApprovals.delete(command.code);
          await this.replyChunks(incoming.messageId, '该审批已失效或不存在。', `chat-approval-expired:${incoming.messageId}`);
          return;
        }
        const result = this.runtime.resolveExternalChannelApproval({
          ...this.externalRuntimeScope(incoming),
          agentInstanceId: pendingChat.agentInstanceId,
          runId: pendingChat.runId,
          approvalId: pendingChat.approvalId,
          approved: command.approved,
        });
        if (result?.ok) {
          if (pendingChat.timer) clearTimeout(pendingChat.timer);
          this.chatApprovals.delete(command.code);
        }
        await this.replyChunks(
          incoming.messageId,
          result?.ok ? (command.approved ? '已批准，智能体继续处理。' : '已拒绝，智能体将根据结果继续处理。') : result?.reason || '审批已失效。',
          `chat-approval-result:${incoming.messageId}`,
        );
        return;
      }
      const pending = this.taskApprovals.get(command.code);
      if (!pending || pending.expiresAt <= Date.now()) {
        this.taskApprovals.delete(command.code);
        await this.replyChunks(incoming.messageId, "该审批已失效或不存在。", "approval-expired:" + incoming.messageId);
        return;
      }
      const result = this.runtime.resolveExternalTaskApproval({ ...this.externalRuntimeScope(incoming), taskRunId: pending.taskRunId, runId: pending.runId, approvalId: pending.approvalId, approved: command.approved });
      if (result?.ok) {
        if (pending.timer) clearTimeout(pending.timer);
        this.taskApprovals.delete(command.code);
      }
      await this.replyChunks(incoming.messageId, result?.ok ? (command.approved ? "已批准，任务继续执行。" : "已拒绝，任务将根据结果继续处理。") : result?.reason || "审批已失效。", "approval-result:" + incoming.messageId);
      return;
    }
    if (command.type === "task_input") {
      await this.processTaskInput(incoming, command);
    }
  }


  handleExternalEvent(incoming, conversationKey, event = {}, { agent: routedAgent = null } = {}) {
    if (event.kind === 'task-progress' && event.taskRunId) {
      const route = {
        taskRunId: String(event.taskRunId), externalMessageId: incoming.messageId, chatId: incoming.chatId, senderId: incoming.senderId,
        tenantKey: incoming.tenantKey, projectId: this.config?.selectedProjectId || '', createdAt: new Date().toISOString(), deliveredEventKeys: [],
      };
      this.persist({ ...this.config, taskRoutes: [...(this.config.taskRoutes || []).filter((item) => item.taskRunId !== route.taskRunId), route] });
      return;
    }
    if (event.kind === 'message-persisted' && event.phase === 'request') {
      if (remoteCommand(incoming.text)?.type === 'task' && event.messageId) {
        this.taskSourceRoutes.set(String(event.messageId), {
          externalMessageId: incoming.messageId, chatId: incoming.chatId, senderId: incoming.senderId,
          tenantKey: incoming.tenantKey, projectId: this.config?.selectedProjectId || '', createdAt: new Date().toISOString(),
        });
      }
      this.notifySessionUpdated({
        sessionId: event.displaySessionId || event.sessionId || this.config?.sessionId || '',
        phase: 'request_persisted',
        externalMessageId: incoming.messageId,
        messageId: event.messageId || '',
        agentInstanceId: event.agentInstanceId || routedAgent?.agentInstanceId || '',
      });
      return;
    }
    if (event.kind === 'approval-request') {
      if (!routedAgent?.agentInstanceId) return;
      const code = shortCode('A', `${event.runId}:${event.approvalId}`);
      const timer = setTimeout(() => {
        const pending = this.chatApprovals.get(code);
        if (!pending) return;
        this.chatApprovals.delete(code);
        this.runtime.resolveExternalChannelApproval({
          ...this.externalRuntimeScope(incoming),
          agentInstanceId: pending.agentInstanceId,
          runId: pending.runId,
          approvalId: pending.approvalId,
          approved: false,
        });
        void this.replyChunks(
          incoming.messageId,
          `审批 ${code} 已超时，Janus 已自动拒绝。`,
          `chat-approval-timeout:${event.approvalId}`,
        ).catch(() => {});
      }, TASK_INTERACTION_TIMEOUT_MS);
      timer.unref?.();
      this.chatApprovals.set(code, {
        agentInstanceId: routedAgent.agentInstanceId,
        runId: event.runId,
        approvalId: event.approvalId,
        expiresAt: Date.now() + TASK_INTERACTION_TIMEOUT_MS,
        timer,
      });
      void this.replyChunks(
        incoming.messageId,
        `${routedAgent.displayName} 请求审批（${code}）\n${safeApprovalDetail(event) || 'Janus 请求执行一项受控操作。'}\n\n回复“批准 ${code}”或“拒绝 ${code}”。`,
        `chat-approval:${event.approvalId}`,
      ).catch((error) => this.logger.error?.('Feishu Agent approval prompt failed.', error));
      return;
    }
    if (event.kind === 'user-input-resolved') {
      this.userInputs.clear(conversationKey, event.requestId);
      return;
    }
    if (event.kind !== 'user-input-request') return;
    const started = this.userInputs.begin(conversationKey, {
      ...event,
      sourceMessageId: incoming.messageId,
    });
    if (!started.ok) {
      if (started.reason === 'secret_question') {
        this.cancelledSourceMessageIds.add(incoming.messageId);
        void this.runtime.cancelExternalChannelChat({
          ...this.externalRuntimeScope(incoming),
          runId: event.runId,
        }).then((result) => {
          if (!result?.ok) this.cancelledSourceMessageIds.delete(incoming.messageId);
        }).finally(() => this.replyChunks(
          incoming.messageId,
          '本次处理需要敏感信息。为保护凭证，飞书通道不会收集此类内容，请回到 Janus 桌面端重新发起。',
          `secret-input:${incoming.messageId}`,
        )).catch((error) => this.logger.error?.('Feishu secret-input cancellation failed.', error));
      }
      return;
    }
    void this.replyChunks(incoming.messageId, started.prompt, `input:${incoming.messageId}`)
      .catch((error) => this.logger.error?.('Feishu user-input prompt failed.', error));
  }

  async processUserInput(incoming, conversationKey) {
    const response = this.userInputs.consume(conversationKey, incoming.text);
    if (!response.handled) return;
    if (response.status === 'invalid') {
      await this.replyChunks(incoming.messageId, response.message, `input-invalid:${incoming.messageId}`);
      return;
    }
    if (response.status === 'next') {
      await this.replyChunks(incoming.messageId, response.prompt, `input-next:${incoming.messageId}`);
      return;
    }
    if (response.status === 'cancelled') {
      this.cancelledSourceMessageIds.add(response.pending.sourceMessageId);
      const result = await this.runtime.cancelExternalChannelChat({
        ...this.externalRuntimeScope(incoming),
        runId: response.pending.runId,
      });
      if (!result?.ok) this.cancelledSourceMessageIds.delete(response.pending.sourceMessageId);
      await this.replyChunks(
        incoming.messageId,
        result?.ok ? '本次处理已取消。' : result?.reason || '本次处理已经结束。',
        `input-cancel:${incoming.messageId}`,
      );
      return;
    }
    const result = await this.runtime.resolveExternalChannelUserInput({
      ...this.externalRuntimeScope(incoming),
      runId: response.pending.runId,
      requestId: response.pending.requestId,
      answers: response.answers,
      skippedQuestionIds: response.skippedQuestionIds,
    });
    await this.replyChunks(
      incoming.messageId,
      result?.ok ? '已确认，Janus 正在继续处理。' : result?.reason || '这项确认已经失效，请重新发起请求。',
      `input-confirm:${incoming.messageId}`,
    );
  }

  async expireUserInput(pending) {
    this.cancelledSourceMessageIds.add(pending.sourceMessageId);
    const binding = this.config?.binding;
    const incoming = {
      senderId: binding?.openId || '',
      chatId: pending.key.split(':').slice(1).join(':'),
    };
    try {
      const result = await this.runtime.cancelExternalChannelChat({
        ...this.externalRuntimeScope(incoming),
        runId: pending.runId,
      });
      if (!result?.ok) this.cancelledSourceMessageIds.delete(pending.sourceMessageId);
      await this.replyChunks(
        pending.sourceMessageId,
        '等待确认已超时，本次处理已取消。请重新发送原请求。',
        `input-expired:${pending.sourceMessageId}`,
      );
    } catch (error) {
      this.logger.error?.('Feishu user-input expiration failed.', error);
    }
  }

  externalRuntimeScope(incoming) {
    return {
      provider: 'feishu',
      expectedUserId: this.activeScope?.userId || '',
      accountWorkspaceId: this.config?.accountWorkspaceId || '',
      externalUserId: incoming.senderId,
      externalChatId: incoming.chatId,
    };
  }

  notifySessionUpdated({
    sessionId = '', phase = '', externalMessageId = '', messageId = '', agentInstanceId = '',
  } = {}) {
    const payload = {
      provider: 'feishu',
      source: 'external_channel',
      phase: String(phase || ''),
      sessionId: String(sessionId || ''),
      messageId: String(messageId || ''),
      externalMessageId: String(externalMessageId || ''),
      agentInstanceId: String(agentInstanceId || ''),
      userId: String(this.activeScope?.userId || ''),
      accountWorkspaceId: String(this.config?.accountWorkspaceId || ''),
      occurredAt: new Date().toISOString(),
    };
    if (!payload.sessionId || !payload.userId || !payload.accountWorkspaceId) return false;
    try {
      this.onSessionUpdated(payload);
      return true;
    } catch (error) {
      this.logger.warn?.('Feishu session update notification failed.', error);
      return false;
    }
  }

  async drainPendingTaskNotifications() {
    for (const route of this.config?.taskRoutes || []) {
      try {
        const task = this.runtime.externalTaskStatus({ ...this.externalRuntimeScope(route), taskRunId: route.taskRunId });
        if (task && TERMINAL_TASK_STATUSES.has(String(task.status || ''))) {
          await this.handleTaskUpdated({ task, change: { type: 'task_finalized' } });
        }
      } catch (error) {
        this.logger.warn?.('Feishu pending task notification failed.', error);
      }
    }
  }

  async replyChunks(messageId, text, uuidPrefix) {
    const chunks = splitReply(text);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.client.reply(messageId, chunks[index], replyUuid(uuidPrefix, index));
    }
  }
}

export function createFeishuChannelService(options = {}) {
  return new FeishuChannelService(options);
}

export const feishuChannelInternals = { pairingCommand, pairingHash, pairingMatches, remoteCommand, replyUuid, safeApprovalDetail, splitReply, taskCode };
