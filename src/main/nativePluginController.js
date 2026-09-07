import { resolveNativePluginControlTarget } from './nativePluginIntent.js';

function emitChatEvent(onEvent, event = {}) {
  if (!onEvent) return;
  const kind = event.kind || event.type || 'progress';
  onEvent({ ...event, kind, type: event.type || kind });
}

function messageIdentity(session = {}, identity = {}) {
  return {
    agentId: String(identity.agentId ?? session.agentId ?? ''),
    agentInstanceId: String(identity.agentInstanceId ?? session.agentInstanceId ?? ''),
    departmentId: String(identity.departmentId ?? session.departmentId ?? ''),
  };
}

export async function executeNativePluginControlTurn({
  store,
  nativePluginService,
  session,
  user,
  message,
  intent,
  activeRunId,
  requestApproval,
  onEvent,
  identity = {},
  interactionMode = '',
  inquiryMode = false,
  attachments = [],
  mentions = [],
  fileReferences = [],
  memoryReferences = [],
  normalizedQuote = null,
  secretaryControl = false,
  onCatalogChanged = () => {},
  onCompleted = () => {},
} = {}) {
  const persistedIdentity = messageIdentity(session, identity);
  const requestMessage = store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: message,
    ...persistedIdentity,
    metadata: {
      ...(secretaryControl ? { secretaryControl: true } : {}),
      nativePluginControl: {
        version: 1,
        source: 'janus_host',
        action: intent.action,
        query: intent.query,
        status: 'received',
      },
      ...(attachments.length ? { attachments } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(fileReferences.length ? { fileReferences } : {}),
      ...(memoryReferences.length ? { memoryReferences } : {}),
      ...(normalizedQuote ? { quote: normalizedQuote } : {}),
    },
  });
  emitChatEvent(onEvent, {
    kind: 'message-persisted',
    phase: 'request',
    runId: activeRunId,
    sessionId: session.id,
    displaySessionId: session.id,
    messageId: requestMessage.id,
    role: 'user',
  });
  emitChatEvent(onEvent, {
    kind: 'progress',
    stage: 'native_plugin_control',
    planStep: 'native_plugin_control',
    message: '正在核对 Janus 账号级插件目录',
  });

  let answer = '';
  let status = 'failed';
  let plugin = null;
  let errorCode = '';
  let verifiedCatalog = null;
  let observedCatalog = null;
  try {
    const catalog = await nativePluginService.list(user.id);
    observedCatalog = catalog;
    const resolution = resolveNativePluginControlTarget(intent, catalog);
    plugin = resolution.plugin || null;
    if (resolution.status === 'unsupported') {
      status = 'unsupported';
      errorCode = catalog.capability?.code || 'codex_plugin_unsupported';
      answer = catalog.capability?.error || '当前 Codex CLI 不支持原生插件管理。请升级或重新安装 Janus。';
    } else if (resolution.status === 'not_found') {
      status = 'not_found';
      errorCode = 'codex_plugin_not_found';
      answer = intent.action === 'install'
        ? `未在 Janus 当前账号的 marketplace 中找到插件“${intent.query}”。未运行 Shell，也没有创建本地 marketplace。请在“设置 - 技能与插件”刷新目录或添加受信任的 marketplace。`
        : `当前账号未安装插件“${intent.query}”。未运行 Shell，也没有修改任何插件配置。`;
    } else if (resolution.status === 'ambiguous') {
      status = 'ambiguous';
      errorCode = 'codex_plugin_ambiguous';
      answer = `找到多个同名插件，请使用完整插件 ID 重试：${resolution.matches.map((item) => item.pluginId).join('、')}`;
    } else if (resolution.status === 'already_installed') {
      status = 'installed';
      verifiedCatalog = catalog;
      answer = `已核验：${plugin.displayName || plugin.name || plugin.pluginId} 已在当前账号安装并启用。插件 ID：${plugin.pluginId}`;
    } else if (interactionMode === 'plan' || inquiryMode) {
      status = 'read_only';
      errorCode = interactionMode === 'plan' ? 'plan_mode_read_only' : 'ubuddy_inquiry_mode_read_only';
      answer = interactionMode === 'plan'
        ? '当前为 Plan 模式，未执行插件安装或卸载。切换到执行模式后重新发送明确的插件操作请求。'
        : '当前为询问模式，未执行插件安装或卸载。切换到任务模式后重新发送明确的插件操作请求。';
    } else {
      const operationLabel = intent.action === 'install' ? '安装' : '卸载';
      const approvalId = `native-plugin:${requestMessage.id}:${intent.action}:${plugin.pluginId}`;
      store.updateMessage(requestMessage.id, {
        metadata: {
          ...(requestMessage.metadata || {}),
          nativePluginControl: {
            version: 1,
            source: 'janus_host',
            action: intent.action,
            query: intent.query,
            pluginId: plugin.pluginId,
            status: 'awaiting_confirmation',
          },
        },
      });
      const approved = await requestApproval({
        approvalId,
        itemId: approvalId,
        type: `native-plugin-${intent.action}`,
        reason: `确认${operationLabel} Codex 插件 ${plugin.displayName || plugin.name || plugin.pluginId}（${plugin.pluginId}）？`,
      });
      if (!approved) {
        status = 'cancelled';
        answer = `已取消${operationLabel}插件 ${plugin.displayName || plugin.name || plugin.pluginId}，账号级插件配置未修改。`;
      } else {
        verifiedCatalog = intent.action === 'install'
          ? await nativePluginService.install(user.id, plugin.pluginId)
          : await nativePluginService.remove(user.id, plugin.pluginId);
        observedCatalog = verifiedCatalog;
        status = intent.action === 'install' ? 'installed' : 'removed';
        onCatalogChanged({
          user,
          catalog: verifiedCatalog,
          reason: `chat_${intent.action}`,
          pluginId: plugin.pluginId,
        });
        answer = intent.action === 'install'
          ? `${plugin.displayName || plugin.name || plugin.pluginId} 插件已安装并通过账号级状态验证。插件 ID：${plugin.pluginId}。现在会显示在“设置 - 技能与插件”和 @ 列表中。`
          : `${plugin.displayName || plugin.name || plugin.pluginId} 插件已卸载并通过账号级状态验证。插件 ID：${plugin.pluginId}。`;
      }
    }
  } catch (error) {
    status = 'failed';
    errorCode = error?.code || 'codex_plugin_failed';
    answer = `插件${intent.action === 'install' ? '安装' : '卸载'}失败：${error?.message || String(error)}`;
  }

  const finalControl = {
    version: 1,
    source: 'janus_host',
    action: intent.action,
    query: intent.query,
    pluginId: plugin?.pluginId || '',
    status,
    catalogVerified: Boolean(verifiedCatalog),
    ...(errorCode ? { errorCode } : {}),
  };
  store.updateMessage(requestMessage.id, {
    metadata: {
      ...(store.getMessage(requestMessage.id)?.metadata || requestMessage.metadata || {}),
      nativePluginControl: finalControl,
    },
  });
  const saved = store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: answer,
    ...persistedIdentity,
    metadata: {
      ...(secretaryControl ? { secretaryControl: true } : {}),
      sourceMessageId: requestMessage.id,
      nativePluginControl: finalControl,
    },
  });
  if (session.codexThreadId) store.updateSessionThread(session.id, '');
  onCompleted({ status, plugin, catalog: verifiedCatalog });
  return {
    session: store.getSession(session.id),
    workerSession: null,
    message: saved,
    answer,
    uBuddyMode: 'native_plugin_control',
    nativePluginControl: finalControl,
    nativePluginCatalog: observedCatalog,
    artifacts: [],
  };
}
