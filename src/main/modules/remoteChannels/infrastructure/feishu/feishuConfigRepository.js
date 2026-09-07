const KEY_PREFIX = 'remote_channel:feishu:v1';

export class FeishuConfigRepository {
  constructor({ store, codec, maxRecentMessageIds = 1000 } = {}) {
    this.store = store;
    this.codec = codec;
    this.maxRecentMessageIds = maxRecentMessageIds;
  }

  key({ userId, deviceId }) {
    return `${KEY_PREFIX}:${String(userId || '').trim()}:${String(deviceId || 'local').trim()}`;
  }

  load(scope) {
    const encrypted = this.store?.settingGet?.(this.key(scope), '') || '';
    if (!encrypted) return null;
    const parsed = JSON.parse(this.codec.decrypt(encrypted));
    return this.normalize(parsed);
  }

  save(scope, value) {
    const normalized = this.normalize(value);
    this.store.settingSet(this.key(scope), this.codec.encrypt(JSON.stringify(normalized)));
    return normalized;
  }

  normalize(value = {}) {
    const recentMessageIds = [...new Set((Array.isArray(value.recentMessageIds) ? value.recentMessageIds : [])
      .map((item) => String(item || '').trim()).filter(Boolean))].slice(-this.maxRecentMessageIds);
    const taskRoutes = (Array.isArray(value.taskRoutes) ? value.taskRoutes : []).slice(-100).map((route) => ({
      taskRunId: String(route?.taskRunId || ""), externalMessageId: String(route?.externalMessageId || ""),
      chatId: String(route?.chatId || ""), senderId: String(route?.senderId || ""), tenantKey: String(route?.tenantKey || ""),
      projectId: String(route?.projectId || ""), createdAt: String(route?.createdAt || ""),
      deliveredEventKeys: [...new Set((Array.isArray(route?.deliveredEventKeys) ? route.deliveredEventKeys : []).map(String).filter(Boolean))].slice(-40),
    })).filter((route) => route.taskRunId && route.externalMessageId);
    const pendingDelegation = value.pendingDelegation?.username && value.pendingDelegation?.chatId
      ? {
          username: String(value.pendingDelegation.username).trim().toLowerCase(),
          chatId: String(value.pendingDelegation.chatId).trim(),
          senderId: String(value.pendingDelegation.senderId || '').trim(),
          tenantKey: String(value.pendingDelegation.tenantKey || '').trim(),
          startedAt: String(value.pendingDelegation.startedAt || ''),
        }
      : null;
    return {
      version: 1,
      enabled: value.enabled === true,
      appId: String(value.appId || '').trim(),
      appSecret: String(value.appSecret || ''),
      domain: value.domain === 'lark' ? 'lark' : 'feishu',
      accountWorkspaceId: String(value.accountWorkspaceId || '').trim(),
      sessionId: String(value.sessionId || '').trim(),
      selectedProjectId: String(value.selectedProjectId || '').trim(),
      messageMode: value.messageMode === 'task'
        ? 'task'
        : value.messageMode === 'ask'
          ? 'ask'
          : String(value.selectedProjectId || '').trim() ? 'task' : 'ask',
      routeTarget: value.routeTarget?.kind === 'employee' && String(value.routeTarget.agentInstanceId || '').trim()
        ? {
            kind: 'employee',
            agentInstanceId: String(value.routeTarget.agentInstanceId).trim(),
            selectedAt: String(value.routeTarget.selectedAt || ''),
          }
        : { kind: 'ubuddy', agentInstanceId: '', selectedAt: '' },
      taskRoutes,
      pendingDelegation,
      binding: value.binding?.openId ? {
        openId: String(value.binding.openId),
        tenantKey: String(value.binding.tenantKey || ''),
        boundAt: String(value.binding.boundAt || ''),
      } : null,
      pairing: value.pairing?.hash ? {
        hash: String(value.pairing.hash),
        salt: String(value.pairing.salt || ''),
        expiresAt: String(value.pairing.expiresAt || ''),
      } : null,
      recentMessageIds,
      updatedAt: String(value.updatedAt || new Date().toISOString()),
    };
  }

  publicStatus(value = null) {
    const config = value ? this.normalize(value) : null;
    return {
      configured: Boolean(config?.appId && config?.appSecret),
      enabled: config?.enabled === true,
      appId: config?.appId || '',
      hasAppSecret: Boolean(config?.appSecret),
      domain: config?.domain || 'feishu',
      accountWorkspaceId: config?.accountWorkspaceId || '',
      sessionId: config?.sessionId || '',
      selectedProjectId: config?.selectedProjectId || '',
      messageMode: config?.messageMode || 'ask',
      routeTarget: config?.routeTarget || { kind: 'ubuddy', agentInstanceId: '', selectedAt: '' },
      remoteTaskCount: config?.taskRoutes?.length || 0,
      bound: Boolean(config?.binding?.openId),
      boundAt: config?.binding?.boundAt || '',
    };
  }
}
