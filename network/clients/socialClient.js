import { createHttpClient } from '../core/httpClient.js';
import { joinUrl, normalizeBaseUrl } from '../core/url.js';

const DEFAULT_SOCIAL_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SOCIAL_FILE_REQUEST_TIMEOUT_MS = 120_000;

function socialRequestTimeoutMs() {
  return Math.max(1_000, Number(process.env.JANUS_SOCIAL_REQUEST_TIMEOUT_MS || DEFAULT_SOCIAL_REQUEST_TIMEOUT_MS));
}

function socialFileRequestTimeoutMs() {
  return Math.max(10_000, Number(process.env.JANUS_SOCIAL_FILE_REQUEST_TIMEOUT_MS || DEFAULT_SOCIAL_FILE_REQUEST_TIMEOUT_MS));
}

export class SocialClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = socialRequestTimeoutMs() } = {}) {
    this.fetchImpl = fetchImpl;
    this.http = createHttpClient({ fetchImpl, timeoutMs });
  }

  sendEmailCode(state, payload = {}) {
    return this.request(state, '/api/auth/email-code', {
      method: 'POST',
      body: payload,
      auth: ['password_change', 'organization_invitation_reset'].includes(payload.purpose),
    });
  }

  register(state, payload = {}) {
    return this.request(state, '/api/auth/register', { method: 'POST', body: payload, auth: false });
  }

  login(state, payload = {}) {
    return this.request(state, '/api/auth/login', { method: 'POST', body: payload, auth: false });
  }

  refresh(state) {
    return this.request(state, '/api/auth/refresh', { method: 'POST', body: { refreshToken: state.refresh_token }, auth: false });
  }

  logout(state) {
    return this.request(state, '/api/auth/logout', { method: 'POST', body: { refreshToken: state.refresh_token }, auth: false });
  }

  me(state) {
    return this.request(state, '/api/auth/me');
  }

  verifyEmail(state, payload = {}) {
    return this.request(state, '/api/auth/verify-email', { method: 'POST', body: payload });
  }

  resetPassword(state, payload = {}) {
    return this.request(state, '/api/auth/password-reset', { method: 'POST', body: payload, auth: false });
  }

  updateProfile(state, payload = {}) {
    return this.request(state, '/api/auth/profile', { method: 'PATCH', body: payload });
  }

  updatePassword(state, payload = {}) {
    return this.request(state, '/api/auth/password', { method: 'PATCH', body: payload });
  }

  requestProviderKeyApplication(state, payload = {}) {
    return this.request(state, '/api/provider-key-applications', { method: 'POST', body: payload });
  }

  providerKeyApplications(state) {
    return this.request(state, '/api/provider-key-applications');
  }

  decideProviderKeyApplication(state, applicationId, payload = {}) {
    return this.request(state, `/api/provider-key-applications/${encodeURIComponent(applicationId)}/decision`, {
      method: 'POST', body: payload,
    });
  }

  claimProviderKeyApplication(state, applicationId) {
    return this.request(state, `/api/provider-key-applications/${encodeURIComponent(applicationId)}/claim`, { method: 'POST' });
  }

  confirmProviderKeyClaim(state, applicationId) {
    return this.request(state, `/api/provider-key-applications/${encodeURIComponent(applicationId)}/claim-confirm`, { method: 'POST' });
  }

  friends(state) {
    return this.request(state, '/api/friends');
  }

  capabilities(state) {
    return this.request(state, '/api/social/capabilities');
  }

  ownUBuddyCapabilityProfile(state) {
    return this.request(state, '/api/social/ubuddy-profile?capability=ubuddy-capability-profile-v1');
  }

  publishUBuddyCapabilityProfile(state, payload = {}) {
    return this.request(state, '/api/social/ubuddy-profile', {
      method: 'PUT', body: { ...payload, socialCapability: 'ubuddy-capability-profile-v1' },
    });
  }

  unpublishUBuddyCapabilityProfile(state, payload = {}) {
    return this.request(state, '/api/social/ubuddy-profile/unpublish', {
      method: 'POST', body: { ...payload, socialCapability: 'ubuddy-capability-profile-v1' },
    });
  }

  queryUBuddyCapabilityProfiles(state, payload = {}) {
    return this.request(state, '/api/social/ubuddy-profiles/query', {
      method: 'POST', body: { ...payload, socialCapability: 'ubuddy-capability-profile-v1' },
    });
  }

  async streamSocialEvents(state, { cursor = 0, signal = null, onEvent = null } = {}) {
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    const params = new URLSearchParams({ capability: 'delegation-realtime-sse-v1' });
    if (Number(cursor || 0) > 0) params.set('cursor', String(Number(cursor)));
    const route = `/api/social/events/stream?${params.toString()}`;
    const response = await this.fetchImpl(joinUrl(serverUrl, route), {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
        'x-janus-social-capability': 'delegation-realtime-sse-v1',
        ...(Number(cursor || 0) > 0 ? { 'last-event-id': String(Number(cursor)) } : {}),
      },
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText || '');
      const error = new Error(detail || `实时委托连接失败（${response.status}）。`);
      error.status = response.status;
      throw error;
    }
    if (!response.body?.getReader) throw new Error('当前运行环境不支持实时事件流。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary).replace(/\r/g, '');
        buffer = buffer.slice(boundary + 2);
        const parsed = parseServerSentEvent(block);
        if (parsed?.data) {
          try { onEvent?.({ ...JSON.parse(parsed.data), event: parsed.event || '', sequence: Number(parsed.id || 0) || undefined }); } catch {}
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    return { closed: true };
  }

  conversationPreferences(state) {
    const params = new URLSearchParams({ capability: 'conversation-inbox-archive-v1' });
    return this.request(state, `/api/social/conversation-preferences?${params.toString()}`);
  }

  setConversationPreference(state, payload = {}) {
    return this.request(state, '/api/social/conversation-preferences', {
      method: 'POST', body: { ...payload, socialCapability: 'conversation-inbox-archive-v1' },
    });
  }

  createResumableFileUpload(state, payload = {}) {
    return this.request(state, '/api/file-uploads', { method: 'POST', body: payload });
  }

  resumableFileUpload(state, uploadId = '') {
    return this.request(state, `/api/file-uploads/${encodeURIComponent(uploadId)}`);
  }

  uploadResumableFileChunk(state, uploadId = '', chunkIndex = 0, { body, sha256 = '' } = {}) {
    const route = `/api/file-uploads/${encodeURIComponent(uploadId)}/chunks/${encodeURIComponent(chunkIndex)}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'PUT',
      route,
      headers: {
        accept: 'application/json',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
        'content-type': 'application/octet-stream',
        'x-janus-chunk-sha256': sha256,
      },
      body,
      timeoutMs: socialFileRequestTimeoutMs(),
      errorMessage: ({ detail }) => detail || '大文件分片上传失败，请稍后重试。',
    });
  }

  completeResumableFileUpload(state, uploadId = '') {
    return this.request(state, `/api/file-uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST', body: {}, timeoutMs: Math.max(socialFileRequestTimeoutMs(), 300_000),
    });
  }

  searchUsers(state, query = '') {
    return this.request(state, `/api/friends/search?q=${encodeURIComponent(query)}`);
  }

  sendFriendRequest(state, payload = {}) {
    return this.request(state, '/api/friends/requests', { method: 'POST', body: payload });
  }

  acceptFriendRequest(state, requestId) {
    return this.request(state, `/api/friends/requests/${encodeURIComponent(requestId)}/accept`, { method: 'POST' });
  }

  rejectFriendRequest(state, requestId) {
    return this.request(state, `/api/friends/requests/${encodeURIComponent(requestId)}/reject`, { method: 'POST' });
  }

  cancelFriendRequest(state, requestId) {
    return this.request(state, `/api/friends/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST' });
  }

  removeFriend(state, userId) {
    return this.request(state, `/api/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  updateFriendRemark(state, userId, remark = '') {
    return this.request(state, `/api/friends/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { remark } });
  }

  updateContactRemark(state, userId, remark = '') {
    return this.request(state, `/api/contacts/${encodeURIComponent(userId)}/remark`, { method: 'PATCH', body: { remark } });
  }

  blockUser(state, userId) {
    return this.request(state, '/api/friends/block', { method: 'POST', body: { userId } });
  }

  createOrganization(state, payload = {}) {
    return this.request(state, '/api/organizations', { method: 'POST', body: payload });
  }

  joinOrganization(state, payload = {}) {
    return this.request(state, '/api/organizations/join', { method: 'POST', body: payload });
  }

  organizationAction(state, organizationId, payload = {}) {
    return this.request(state, `/api/organizations/${encodeURIComponent(organizationId)}/actions`, { method: 'POST', body: payload });
  }

  chatGroups(state, { workspaceId = '' } = {}) {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    params.set('capability', 'chat-groups-v2');
    return this.request(state, `/api/chat-groups${params.size ? `?${params.toString()}` : ''}`);
  }

  createChatGroup(state, payload = {}) {
    return this.request(state, '/api/chat-groups', { method: 'POST', body: { ...payload, socialCapability: 'chat-groups-v2' } });
  }

  chatGroup(state, groupId, { workspaceId = '' } = {}) {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    params.set('capability', 'chat-groups-v2');
    return this.request(state, `/api/chat-groups/${encodeURIComponent(groupId)}${params.size ? `?${params.toString()}` : ''}`);
  }

  sendChatGroupMessage(state, groupId, payload = {}) {
    return this.request(state, `/api/chat-groups/${encodeURIComponent(groupId)}/messages`, {
      method: 'POST', body: { ...payload, socialCapability: 'chat-groups-v2' },
    });
  }

  uploadChatGroupMessageFile(state, groupId, fileId, {
    filename = 'file', contentType = 'application/octet-stream', size = 0, sha256 = '', workspaceId = '', body,
  } = {}) {
    const params = new URLSearchParams({ capability: 'chat-groups-v2' });
    const route = `/api/chat-groups/${encodeURIComponent(groupId)}/message-files/${encodeURIComponent(fileId)}?${params.toString()}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'PUT',
      route,
      headers: {
        accept: 'application/json',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
        'content-type': 'application/octet-stream',
        'x-janus-filename': encodeURIComponent(filename),
        'x-janus-content-type': contentType,
        'x-janus-file-size': String(size || body?.byteLength || 0),
        'x-janus-file-sha256': sha256,
        'x-janus-workspace-id': workspaceId,
      },
      body,
      timeoutMs: socialFileRequestTimeoutMs(),
      errorMessage: ({ detail }) => detail || '联系人群聊附件上传失败，请稍后重试。',
    });
  }

  downloadChatGroupMessageFile(state, groupId, fileId, { workspaceId = '', stream = false } = {}) {
    const params = new URLSearchParams({ capability: 'chat-groups-v2' });
    if (workspaceId) params.set('workspaceId', workspaceId);
    const route = `/api/chat-groups/${encodeURIComponent(groupId)}/message-files/${encodeURIComponent(fileId)}?${params.toString()}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'GET',
      route,
      responseType: stream ? 'response' : 'arrayBuffer',
      timeoutMs: socialFileRequestTimeoutMs(),
      headers: {
        accept: 'application/octet-stream',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
      },
      errorMessage: '联系人群聊附件下载失败，请稍后重试。',
    });
  }

  updateChatGroup(state, groupId, payload = {}) {
    return this.request(state, `/api/chat-groups/${encodeURIComponent(groupId)}`, {
      method: 'PATCH', body: { ...payload, socialCapability: 'chat-groups-v2' },
    });
  }

  messages(state, { cursor = '', peerId = '', limit = 100, workspaceId = '' } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    params.set('capability', 'account-social-direct-v1');
    if (cursor) params.set('cursor', cursor);
    if (peerId) params.set('peerId', peerId);
    if (workspaceId) params.set('workspaceId', workspaceId);
    return this.request(state, `/api/social/messages?${params.toString()}`);
  }

  sendMessage(state, payload = {}) {
    return this.request(state, '/api/social/messages', {
      method: 'POST', body: { ...payload, socialCapability: 'account-social-direct-v1' },
    });
  }

  uploadSocialFile(state, fileId, {
    recipientId = '', filename = 'file', contentType = 'application/octet-stream', size = 0, sha256 = '', workspaceId = '', body,
  } = {}) {
    const route = `/api/social/files/${encodeURIComponent(fileId)}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'PUT',
      route,
      headers: {
        accept: 'application/json',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
        'content-type': 'application/octet-stream',
        'x-janus-recipient-id': recipientId,
        'x-janus-filename': encodeURIComponent(filename),
        'x-janus-content-type': contentType,
        'x-janus-file-size': String(size || body?.byteLength || 0),
        'x-janus-file-sha256': sha256,
        'x-janus-social-capability': 'account-social-direct-v1',
        ...(workspaceId ? { 'x-janus-workspace-id': workspaceId } : {}),
      },
      body,
      timeoutMs: socialFileRequestTimeoutMs(),
      errorMessage: ({ detail }) => detail || '私聊附件上传失败，请稍后重试。',
    });
  }

  downloadSocialFile(state, fileId, { stream = false, workspaceId = '' } = {}) {
    const params = new URLSearchParams();
    params.set('capability', 'account-social-direct-v1');
    if (workspaceId) params.set('workspaceId', workspaceId);
    const route = `/api/social/files/${encodeURIComponent(fileId)}${params.size ? `?${params.toString()}` : ''}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'GET',
      route,
      responseType: stream ? 'response' : 'arrayBuffer',
      timeoutMs: socialFileRequestTimeoutMs(),
      headers: {
        accept: 'application/octet-stream',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
      },
      errorMessage: '私聊附件下载失败，请稍后重试。',
    });
  }

  uploadCollaborationGroupMessageFile(state, groupId, fileId, {
    filename = 'file', contentType = 'application/octet-stream', size = 0, sha256 = '', workspaceId = '', body,
  } = {}) {
    const route = `/api/collaboration/groups/${encodeURIComponent(groupId)}/message-files/${encodeURIComponent(fileId)}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'PUT',
      route,
      headers: {
        accept: 'application/json',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
        'content-type': 'application/octet-stream',
        'x-janus-filename': encodeURIComponent(filename),
        'x-janus-content-type': contentType,
        'x-janus-file-size': String(size || body?.byteLength || 0),
        'x-janus-file-sha256': sha256,
        'x-janus-workspace-id': workspaceId,
      },
      body,
      timeoutMs: socialFileRequestTimeoutMs(),
      errorMessage: ({ detail }) => detail || '群聊附件上传失败，请稍后重试。',
    });
  }

  downloadCollaborationGroupMessageFile(state, groupId, fileId, { workspaceId = '', stream = false } = {}) {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    const route = `/api/collaboration/groups/${encodeURIComponent(groupId)}/message-files/${encodeURIComponent(fileId)}${params.size ? `?${params.toString()}` : ''}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'GET',
      route,
      responseType: stream ? 'response' : 'arrayBuffer',
      timeoutMs: socialFileRequestTimeoutMs(),
      headers: {
        accept: 'application/octet-stream',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
      },
      errorMessage: '群聊附件下载失败，请稍后重试。',
    });
  }

  updateMessage(state, messageId, payload = {}) {
    return this.request(state, `/api/social/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH', body: { ...payload, socialCapability: 'account-social-direct-v1' },
    });
  }

  markMessageRead(state, messageId, payload = {}) {
    return this.request(state, `/api/social/messages/${encodeURIComponent(messageId)}/read`, {
      method: 'POST', body: { ...payload, socialCapability: 'account-social-direct-v1' },
    });
  }

  delegations(state, { cursor = '', cursorId = '', direction = 'all', limit = 100, workspaceId = '' } = {}) {
    const params = new URLSearchParams({ direction, limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    if (cursorId) params.set('cursorId', cursorId);
    if (workspaceId) params.set('workspaceId', workspaceId);
    return this.request(state, `/api/delegations?${params.toString()}`);
  }

  createDelegation(state, payload = {}) {
    return this.request(state, '/api/delegations', { method: 'POST', body: payload });
  }

  updateDelegation(state, delegationId, payload = {}) {
    return this.request(state, `/api/delegations/${encodeURIComponent(delegationId)}`, { method: 'PATCH', body: payload });
  }

  claimDelegationExecution(state, delegationId, payload = {}) {
    return this.request(state, `/api/delegations/${encodeURIComponent(delegationId)}/execution-claim`, {
      method: 'POST', body: { ...payload, socialCapability: 'delegation-execution-lease-v1' },
    });
  }

  renewDelegationExecutionLease(state, delegationId, payload = {}) {
    return this.request(state, `/api/delegations/${encodeURIComponent(delegationId)}/execution-lease/renew`, {
      method: 'POST', body: { ...payload, socialCapability: 'delegation-execution-lease-v1' },
    });
  }

  releaseDelegationExecutionLease(state, delegationId, payload = {}) {
    return this.request(state, `/api/delegations/${encodeURIComponent(delegationId)}/execution-lease/release`, {
      method: 'POST', body: { ...payload, socialCapability: 'delegation-execution-lease-v1' },
    });
  }

  delegationWorkspace(state, delegationId, { workspaceId = '' } = {}) {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    return this.request(state, `/api/delegations/${encodeURIComponent(delegationId)}/workspace${params.size ? `?${params.toString()}` : ''}`);
  }

  sendDelegationWorkspaceMessage(state, delegationId, payload = {}) {
    return this.request(state, `/api/delegations/${encodeURIComponent(delegationId)}/workspace/messages`, { method: 'POST', body: payload });
  }

  collaborationOverview(state, { workspaceId = '' } = {}) {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    return this.request(state, `/api/collaboration${params.size ? `?${params.toString()}` : ''}`);
  }

  createCollaborationGroup(state, payload = {}) {
    return this.request(state, '/api/collaboration/groups', { method: 'POST', body: payload });
  }

  collaborationGroup(state, groupId, { workspaceId = '' } = {}) {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    return this.request(state, `/api/collaboration/groups/${encodeURIComponent(groupId)}${params.size ? `?${params.toString()}` : ''}`);
  }

  sendCollaborationMessage(state, groupId, payload = {}) {
    return this.request(state, `/api/collaboration/groups/${encodeURIComponent(groupId)}/messages`, { method: 'POST', body: payload });
  }

  updateCollaborationGroup(state, groupId, payload = {}) {
    return this.request(state, `/api/collaboration/groups/${encodeURIComponent(groupId)}`, { method: 'PATCH', body: payload });
  }

  collaborationGroupWorkspace(state, groupId, { sinceRevision = 0, workspaceId = '' } = {}) {
    const params = new URLSearchParams();
    if (Number(sinceRevision || 0) > 0) params.set('sinceRevision', String(Number(sinceRevision)));
    if (workspaceId) params.set('workspaceId', workspaceId);
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request(state, `/api/collaboration/groups/${encodeURIComponent(groupId)}/workspace${suffix}`);
  }

  uploadCollaborationGroupWorkspaceFile(state, groupId, fileId, {
    relativePath = '', filename = 'file', contentType = 'application/octet-stream', size = 0,
    sha256 = '', baseRevision = 0, workspaceId = '', body,
  } = {}) {
    const route = `/api/collaboration/groups/${encodeURIComponent(groupId)}/workspace/files/${encodeURIComponent(fileId)}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'PUT',
      route,
      headers: {
        accept: 'application/json',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
        'content-type': 'application/octet-stream',
        'x-janus-relative-path': encodeURIComponent(relativePath),
        'x-janus-filename': encodeURIComponent(filename),
        'x-janus-content-type': contentType,
        'x-janus-file-size': String(size || body?.byteLength || 0),
        'x-janus-file-sha256': sha256,
        'x-janus-base-revision': String(Math.max(0, Number(baseRevision || 0))),
        'x-janus-workspace-id': workspaceId,
      },
      body,
      timeoutMs: socialFileRequestTimeoutMs(),
      errorMessage: ({ detail }) => detail || '共享工作区文件上传失败，请稍后重试。',
    });
  }

  deleteCollaborationGroupWorkspaceFile(state, groupId, fileId, { baseRevision = 0, workspaceId = '' } = {}) {
    const params = new URLSearchParams({ baseRevision: String(Math.max(0, Number(baseRevision || 0))) });
    if (workspaceId) params.set('workspaceId', workspaceId);
    return this.request(state, `/api/collaboration/groups/${encodeURIComponent(groupId)}/workspace/files/${encodeURIComponent(fileId)}?${params.toString()}`, { method: 'DELETE' });
  }

  downloadCollaborationGroupWorkspaceFile(state, groupId, fileId, { workspaceId = '' } = {}) {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    const route = `/api/collaboration/groups/${encodeURIComponent(groupId)}/workspace/files/${encodeURIComponent(fileId)}${params.size ? `?${params.toString()}` : ''}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'GET',
      route,
      responseType: 'arrayBuffer',
      timeoutMs: socialFileRequestTimeoutMs(),
      headers: {
        accept: 'application/octet-stream',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
      },
      errorMessage: '共享工作区文件下载失败，请稍后重试。',
    });
  }

  collaborationTaskAction(state, delegationId, payload = {}) {
    return this.request(state, `/api/collaboration/tasks/${encodeURIComponent(delegationId)}/action`, { method: 'POST', body: payload });
  }

  publishWorkMemory(state, payload = {}) {
    return this.request(state, '/api/work-memory/publications', { method: 'POST', body: payload });
  }

  appointWorkLeader(state, payload = {}) {
    return this.request(state, '/api/work-memory/appointments', { method: 'POST', body: payload });
  }

  revokeWorkLeader(state, payload = {}) {
    return this.request(state, '/api/work-memory/appointments/revoke', { method: 'POST', body: payload });
  }

  readWorkMemory(state, payload = {}) {
    return this.request(state, '/api/work-memory/read', { method: 'POST', body: payload });
  }

  uploadCollaborationFile(state, delegationId, fileId, { filename = 'file', contentType = 'application/octet-stream', size = 0, sha256 = '', workspaceId = '', body } = {}) {
    const route = `/api/collaboration/tasks/${encodeURIComponent(delegationId)}/files/${encodeURIComponent(fileId)}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'PUT',
      route,
      headers: {
        accept: 'application/json',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
        'content-type': 'application/octet-stream',
        'x-janus-filename': encodeURIComponent(filename),
        'x-janus-content-type': contentType,
        'x-janus-file-size': String(size || body?.byteLength || 0),
        'x-janus-file-sha256': sha256,
        'x-janus-workspace-id': workspaceId,
        'x-janus-social-capability': 'direct-delegation-files-v1',
      },
      body,
      timeoutMs: socialFileRequestTimeoutMs(),
      errorMessage: ({ detail }) => detail || '任务附件上传失败，请稍后重试。',
    });
  }

  downloadCollaborationFile(state, fileId, { workspaceId = '', stream = false } = {}) {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    const route = `/api/collaboration/files/${encodeURIComponent(fileId)}${params.size ? `?${params.toString()}` : ''}`;
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    return this.http.request(joinUrl(serverUrl, route), {
      method: 'GET',
      route,
      responseType: stream ? 'response' : 'arrayBuffer',
      timeoutMs: socialFileRequestTimeoutMs(),
      headers: {
        accept: 'application/octet-stream',
        authorization: state?.access_token ? `Bearer ${state.access_token}` : '',
      },
      errorMessage: '任务附件下载失败，请稍后重试。',
    });
  }

  heartbeat(state, payload = {}) {
    return this.request(state, '/api/presence/heartbeat', { method: 'POST', body: payload });
  }

  async request(state, route, { method = 'GET', body, auth = true, timeoutMs = undefined } = {}) {
    const serverUrl = normalizeBaseUrl(state?.server_url || process.env.JANUS_AUTH_URL || '');
    if (!serverUrl) throw new Error('跨设备通信服务器未配置。');
    const headers = { accept: 'application/json' };
    if (auth && state?.access_token) headers.authorization = `Bearer ${state.access_token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return this.http.request(joinUrl(serverUrl, route), {
      method,
      route,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      errorMessage: ({ detail }) => detail || '通信请求失败，请稍后重试。',
    });
  }
}

function parseServerSentEvent(block = '') {
  if (!block || block.startsWith(':')) return null;
  const result = { id: '', event: '', data: '' };
  for (const line of String(block).split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    if (field === 'data') result.data = result.data ? `${result.data}\n${value}` : value;
    else if (field === 'id') result.id = value;
    else if (field === 'event') result.event = value;
  }
  return result.data ? result : null;
}
