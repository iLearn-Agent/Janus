import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const electronRequire = createRequire(import.meta.url);
const { desktopCapturer } = electronRequire('electron');

import {
  installPlugin,
  pluginCatalog,
  pluginInstallPath,
  pluginStatus,
  uninstallPlugin,
} from '../pluginRegistry.js';
import {
  applicationLoggingStatus,
  clearRotatedApplicationLogs,
  exportApplicationLogs,
  getApplicationLogger,
  newDiagnosticId,
} from '../../shared/logging/index.js';
import { uiText } from '../../shared/uiLanguage.js';

export function writeImageFileToClipboard({ clipboard, nativeImage, file = {} } = {}) {
  const contentType = String(file.content_type || file.type || '').toLowerCase();
  if (file.kind !== 'image' && !contentType.startsWith('image/')) throw new Error('所选文件不是可复制的图片。');
  if (Number(file.size || 0) > 80 * 1024 * 1024) throw new Error('图片过大，无法直接复制到剪贴板。');
  if (!file.path || !nativeImage?.createFromPath || !clipboard?.writeImage) throw new Error('当前系统不支持复制图片。');
  const image = nativeImage.createFromPath(file.path);
  if (!image || image.isEmpty?.()) throw new Error('图片无法读取或格式不受剪贴板支持。');
  clipboard.writeImage(image);
  return { ok: true, size: image.getSize?.() || null };
}

export function canAccessTaskRun(user = null, task = null) {
  return Boolean(user && task && task.ownerUserId === user.id);
}

export function registerIpcHandlers({
  ipcMain,
  app,
  BrowserWindow, screen,
  dialog,
  shell,
  clipboard,
  nativeImage,
  getRuntime,
  getMainWindow,
  getUpdateService,
  getAgentBundleService,
  getFeishuChannelService,
  getDesktopTrayController,
  getMobileGateway,
  onAuthenticationChanged = null,
  requestAppQuit = () => app.quit(),
  createAppWindow,
  refreshCodexSystemProxy,
  refreshModelCatalog,
  getUiLanguage = () => 'zh-CN',
  setUiLanguage = () => 'zh-CN',
  onClosePromptResponse = null,
}) {
  const t = (zh, en) => uiText(zh, en, getUiLanguage());
  const ipcLogger = getApplicationLogger('ipc', { testFileName: 'desktop-ipc.jsonl' });
  const rendererLogger = getApplicationLogger('electron-renderer');
  const rendererLogRate = new Map();
  ipcMain.handle('mobile-gateway:status', async () => getMobileGateway?.()?.status?.() || { listening: false, addresses: [] });
  const registerHandle = ipcMain.handle.bind(ipcMain);
  ipcMain = {
    handle(channel, listener) {
      return registerHandle(channel, async (...args) => {
        const started = Date.now();
        const requestId = newDiagnosticId('ipc');
        const context = { requestId, ipcChannel: channel, windowId: args[0]?.sender?.id || null };
        ipcLogger.debug('ipc_start', { message: channel, context });
        try {
          const runtime = getRuntime?.();
          const scopeWorkspace = runtime?.runInCurrentAccountWorkspace
            && channel !== 'account-workspaces:switch'
            && !channel.startsWith('auth:');
          const result = await (scopeWorkspace
            ? runtime.runInCurrentAccountWorkspace(() => listener(...args))
            : listener(...args));
          const durationMs = Date.now() - started;
          if (durationMs >= 2_000) {
            ipcLogger.warn('ipc_slow', { message: channel, durationMs, context, data: { status: 'completed' } });
          } else {
            ipcLogger.debug('ipc_end', { message: channel, durationMs, context, data: { status: 'completed' } });
          }
          return result;
        } catch (error) {
          ipcLogger.error('ipc_error', {
            message: channel,
            durationMs: Date.now() - started,
            context,
            data: { status: 'failed' },
            error,
          });
          throw error;
        }
      });
    },
  };
  const requireRuntime = () => {
    const runtime = getRuntime();
    if (!runtime) throw new Error('Runtime is not ready.');
    return runtime;
  };
  const requireFeishuChannelService = () => {
    const service = getFeishuChannelService?.();
    if (!service) throw new Error('飞书连接服务尚未准备好。');
    return service;
  };
  const auxiliaryWindows = new Map();
  const auxiliaryWindowKeys = new Map();
  const auxiliaryWindowPayload = (event, payload = {}) => {
    const token = String(payload.token || '').trim();
    const entry = auxiliaryWindows.get(token);
    if (!entry || entry.window?.isDestroyed?.() || entry.window.webContents.id !== event.sender.id) return null;
    return entry.payload;
  };
  const closeAuxiliaryWindow = (event, payload = {}) => {
    const token = String(payload.token || '').trim();
    const entry = auxiliaryWindows.get(token);
    if (!entry || entry.window?.isDestroyed?.() || entry.window.webContents.id !== event.sender.id) return false;
    entry.submitted = Boolean(payload.submitted);
    entry.window.close();
    return true;
  };
  const createAuxiliaryWindow = ({ source, kind, key = '', title, page, payload, width, height, minWidth, minHeight, frame = true }) => {
    if (key) {
      const existingToken = auxiliaryWindowKeys.get(key);
      const existing = existingToken ? auxiliaryWindows.get(existingToken) : null;
      if (existing?.window && !existing.window.isDestroyed()) {
        if (existing.window.isMinimized()) existing.window.restore();
        existing.window.show();
        existing.window.focus();
        return { ok: true, token: existingToken, windowId: existing.window.id, reused: true };
      }
      auxiliaryWindowKeys.delete(key);
    }
    const token = newDiagnosticId('plan_question');
    const window = new BrowserWindow({
      width,
      height,
      minWidth,
      minHeight,
      center: true,
      title,
      frame,
      autoHideMenuBar: true,
      backgroundColor: '#f5f7fb',
      webPreferences: {
        preload: path.join(app.getAppPath(), 'src/preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    const entry = { token, kind, key, payload, window, source, submitted: false };
    auxiliaryWindows.set(token, entry);
    if (key) auxiliaryWindowKeys.set(key, token);
    window.loadFile(path.join(app.getAppPath(), 'src/renderer', page), {
      query: { token, language: getUiLanguage(), platform: process.platform, callId: String(payload.callId || '') },
    });
    window.on('closed', () => {
      auxiliaryWindows.delete(token);
      if (key && auxiliaryWindowKeys.get(key) === token) auxiliaryWindowKeys.delete(key);
      if (kind === 'question' && source && !source.isDestroyed?.()) {
        source.send('chat:user-input-window-closed', {
          requestId: String(payload.requestId || ''),
          submitted: entry.submitted,
        });
      }
    });
    return { ok: true, token, windowId: window.id, reused: false };
  };

  ipcMain.handle('aux-window:payload', auxiliaryWindowPayload);
  ipcMain.handle('aux-window:close', closeAuxiliaryWindow);
  ipcMain.handle('aux-window:minimize', (event, payload = {}) => {
    const entry = auxiliaryWindows.get(String(payload.token || '').trim());
    if (!entry || entry.window?.isDestroyed?.() || entry.window.webContents.id !== event.sender.id) return false;
    entry.window.minimize(); return true;
  });
  ipcMain.handle('aux-window:toggle-maximize', (event, payload = {}) => {
    const entry = auxiliaryWindows.get(String(payload.token || '').trim());
    if (!entry || entry.window?.isDestroyed?.() || entry.window.webContents.id !== event.sender.id) return false;
    if (entry.window.isMaximized()) entry.window.unmaximize(); else entry.window.maximize(); return true;
  });
  ipcMain.handle('voice-call-window:sharing-mode', (event, payload = {}) => {
    const entry = auxiliaryWindows.get(String(payload.token || '').trim());
    if (!entry || entry.kind !== 'voice-call' || entry.window?.isDestroyed?.() || entry.window.webContents.id !== event.sender.id) return false;
    const sharing = Boolean(payload.sharing);
    entry.window.setAlwaysOnTop(sharing, sharing ? 'floating' : 'normal');
    entry.window.setResizable(!sharing);
    if (sharing) { const display = screen.getPrimaryDisplay?.(); const area = display?.workArea || { x: 0, y: 0, width: 1280, height: 800 }; const width = Math.min(860, area.width - 48); entry.window.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: area.y + 18, width, height: 78 }); }
    else { entry.window.setResizable(true); entry.window.setSize(980, 700); entry.window.center(); }
    return true;
  });
  ipcMain.handle('voice-call-window:desktop-sources', async (event, payload = {}) => {
    const entry = auxiliaryWindows.get(String(payload.token || '').trim());
    if (!entry || entry.kind !== 'voice-call' || entry.window?.isDestroyed?.()
      || entry.window.webContents.id !== event.sender.id) return [];
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail?.toDataURL?.() || '',
      icon: source.appIcon?.toDataURL?.() || '',
    }));
  });
  ipcMain.handle('voice-call:signal', (_event, payload = {}) => requireRuntime().sendVoiceCallSignal(payload));
  ipcMain.handle('voice-call:record', (_event, payload = {}) => requireRuntime().recordVoiceCall(payload));
  ipcMain.handle('voice-call:leave', (_event, payload = {}) => requireRuntime().leaveVoiceCall(payload));
  ipcMain.handle('voice-call:chat', (_event, payload = {}) => requireRuntime().sendVoiceCallChat(payload));
  ipcMain.handle('voice-call:invite', (_event, payload = {}) => requireRuntime().inviteVoiceCallParticipant(payload));
  ipcMain.handle('voice-call:kick', (_event, payload = {}) => requireRuntime().kickVoiceCallParticipant(payload));
  ipcMain.handle('voice-call:ice-servers', async () => {
    try {
      const result = await requireRuntime().getVoiceCallIceServers();
      if (Array.isArray(result?.iceServers)) return result.iceServers;
    } catch (error) {
      console.warn('voice-call:ice-servers cloud lookup failed; using local fallback', error?.message || error);
    }
    try { return JSON.parse(process.env.JANUS_VOICE_CALL_ICE_SERVERS || '[]'); } catch { return []; }
  });
  ipcMain.handle('video-room:config', async (_event, payload = {}) => {
    return requireRuntime().getVideoRoomConfig(String(payload.workspaceId || '').trim(), {
      callId: String(payload.callId || '').trim(), groupId: String(payload.groupId || '').trim(),
    });
  });
  ipcMain.handle('aux-window:focus-main', () => {
    const window = getMainWindow?.();
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  });
  ipcMain.handle('app:set-ui-language', (_event, payload = {}) => ({ language: setUiLanguage(payload.language) }));
  ipcMain.handle('voice-call-window:open', (event, payload = {}) => createAuxiliaryWindow({
    source: event.sender,
    kind: 'voice-call',
    // A call window belongs to one signaling session, not one peer. Reusing
    // by peer kept stale payloads (including an old "Unnamed user" profile)
    // and made later incoming calls appear with the previous call context.
    key: `voice-call:${String(payload.peerId || '').trim()}:${String(payload.callId || '').trim()}`,
    title: `语音通话 - ${String(payload.peer?.displayName || payload.peer?.display_name || payload.peer?.username || '联系人')}`,
    page: 'voiceCallWindow.html',
    payload,
    width: 980,
    height: 700,
    minWidth: 420,
    minHeight: 560,
    frame: false,
  }));
  ipcMain.handle('video-room-window:open', (event, payload = {}) => createAuxiliaryWindow({
    source: event.sender,
    kind: 'video-room',
    key: `video-room:${String(payload.workspaceId || '').trim()}`,
    title: '多人通话',
    page: 'multiPartyCallWindow.html',
    payload,
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    frame: false,
  }));
  ipcMain.handle('plan-question-window:open', (event, payload = {}) => createAuxiliaryWindow({
    source: event.sender,
    kind: 'question',
    key: `question:${String(payload.requestId || '').trim()}`,
    title: payload.planMode === false
      ? t('补充所需信息', 'Provide More Information')
      : t('确认计划选项', 'Confirm Plan Options'),
    page: 'planQuestionWindow.html',
    payload: {
      channelId: String(payload.channelId || ''),
      runId: String(payload.runId || ''),
      requestId: String(payload.requestId || ''),
      planMode: payload.planMode !== false,
      questions: (Array.isArray(payload.questions) ? payload.questions : []).slice(0, 3),
    },
    width: 820,
    height: 720,
    minWidth: 620,
    minHeight: 500,
  }));
  const employeeMutationWithDiagnostics = async (action, payload, callback) => {
    const identity = {
      action,
      commandId: String(payload?.commandId || ''),
      agentFamilyId: String(payload?.agentFamilyId || ''),
      agentInstanceId: String(payload?.agentInstanceId || ''),
      expectedStateRevision: Number(payload?.expectedStateRevision || 0),
    };
    ipcLogger.info('employee_lifecycle_requested', { data: identity });
    const response = await employeeMutation(callback);
    ipcLogger[response.ok ? 'info' : 'warn']('employee_lifecycle_settled', {
      data: {
        ...identity,
        ok: response.ok,
        status: String(response.result?.status || ''),
        resolvedAgentInstanceId: String(response.result?.instance?.id || ''),
        errorCode: String(response.error?.code || ''),
      },
    });
    return response;
  };
  ipcMain.handle('app:bootstrap', async (_event, payload = {}) => {
    const rt = requireRuntime();
    const boot = await rt.bootstrap(payload);
    const plugins = pluginCatalog(rt.root, { appVersion: app.getVersion() });
    const codexPlugins = boot.currentUser ? await rt.nativePluginCatalog() : null;
    return {
      ...boot,
      appVersion: app.getVersion(),
      appPackaged: app.isPackaged,
      updatedLaunch: process.argv.includes('--updated'),
      desktopLifecycle: getDesktopTrayController?.()?.status?.() || {},
      plugins,
      codexPlugins,
      pptxPluginStatus: plugins.find((plugin) => plugin.id === 'ppt_creation')?.status || null,
    };
  });
  ipcMain.handle('account-workspaces:list', async () => requireRuntime().listAccountWorkspaces());
  ipcMain.handle('account-workspaces:switch', async (_event, payload = {}) => {
    const result = await requireRuntime().switchAccountWorkspace(payload);
    Promise.resolve(getFeishuChannelService?.()?.reconcile?.()).catch((error) => {
      console.warn('[janus] Feishu channel reconcile after workspace switch failed:', error?.message || error);
    });
    return result;
  });
  ipcMain.handle('account-workspaces:set-startup', async (_event, payload = {}) => requireRuntime().setStartupAccountWorkspace(payload));
  ipcMain.handle('follower:overview', async (_event, payload = {}) => requireRuntime().followerOverview(payload));
  ipcMain.handle('follower:access-update', async (_event, payload = {}) => requireRuntime().followerAccessUpdate(payload));
  ipcMain.handle('follower:preferences-update', async (_event, payload = {}) => requireRuntime().followerPreferencesUpdate(payload));
  ipcMain.handle('follower:schedule-upsert', async (_event, payload = {}) => requireRuntime().followerScheduleUpsert(payload));
  ipcMain.handle('follower:schedules-list', async (_event, payload = {}) => requireRuntime().followerSchedulesList(payload));
  ipcMain.handle('follower:run-cancel', async (_event, payload = {}) => requireRuntime().followerRunCancel(payload));
  ipcMain.handle('follower:runs-list', async (_event, payload = {}) => requireRuntime().followerRunsList(payload));
  ipcMain.handle('follower:reports-list', async (_event, payload = {}) => requireRuntime().followerReportsList(payload));
  ipcMain.handle('follower:report-open', async (_event, payload = {}) => requireRuntime().followerReportOpen(payload));
  ipcMain.handle('follower:report-sources', async (_event, payload = {}) => requireRuntime().followerReportSources(payload));
  ipcMain.handle('follower:report-mark-read', async (_event, payload = {}) => requireRuntime().followerReportMarkRead(payload));
  ipcMain.handle('follower:report-delete', async (_event, payload = {}) => requireRuntime().followerReportDelete(payload));
  ipcMain.handle('follower:followup-open', async (_event, payload = {}) => requireRuntime().followerFollowupOpen(payload));
  ipcMain.handle('follower:followup-send', async (_event, payload = {}) => requireRuntime().followerFollowupSend(payload));
  ipcMain.handle('follower:followup-cancel', async (_event, payload = {}) => requireRuntime().followerFollowupCancel(payload));
  ipcMain.handle('follower:followup-delete', async (_event, payload = {}) => requireRuntime().followerFollowupDelete(payload));
  ipcMain.handle('follower:cloud-settings-update', async (_event, payload = {}) => requireRuntime().followerCloudSettingsUpdate(payload));
  ipcMain.handle('follower:cloud-sync', async (_event, payload = {}) => requireRuntime().followerCloudSync(payload));
  ipcMain.handle('follower:feedback-record', async (_event, payload = {}) => requireRuntime().followerFeedbackRecord(payload));
  ipcMain.handle('follower:evolution-status', async (_event, payload = {}) => requireRuntime().followerEvolutionStatus(payload));
  ipcMain.handle('follower:evolution-rollback', async (_event, payload = {}) => requireRuntime().followerEvolutionRollback(payload));
  ipcMain.handle('follower:evolution-decide', async (_event, payload = {}) => requireRuntime().followerEvolutionDecide(payload));
  ipcMain.handle('auth:me', async () => requireRuntime().currentUser());
  ipcMain.handle('auth:login', async (_event, payload = {}) => {
    const result = await requireRuntime().authLogin(payload);
    await getFeishuChannelService?.()?.reconcile?.();
    onAuthenticationChanged?.({ authenticated: true });
    return result;
  });
  ipcMain.handle('auth:register', async (_event, payload = {}) => {
    const result = await requireRuntime().authRegister(payload);
    await getFeishuChannelService?.()?.reconcile?.();
    onAuthenticationChanged?.({ authenticated: true });
    return result;
  });
  ipcMain.handle('auth:send-email-code', async (_event, payload = {}) => requireRuntime().authSendEmailCode(payload));
  ipcMain.handle('auth:verify-email', async (_event, payload = {}) => requireRuntime().authVerifyEmail(payload));
  ipcMain.handle('auth:reset-password-email', async (_event, payload = {}) => requireRuntime().authResetPasswordByEmail(payload));
  ipcMain.handle('auth:logout', async () => {
    const result = await requireRuntime().authLogout();
    await getFeishuChannelService?.()?.reconcile?.();
    onAuthenticationChanged?.({ authenticated: false });
    return result;
  });
  ipcMain.handle('feishu:status', async () => requireFeishuChannelService().status());
  ipcMain.handle('feishu:test-config', async (_event, payload = {}) => requireFeishuChannelService().testConfig(payload));
  ipcMain.handle('feishu:save-config', async (_event, payload = {}) => requireFeishuChannelService().saveConfig(payload));
  ipcMain.handle('feishu:enable', async () => requireFeishuChannelService().enable());
  ipcMain.handle('feishu:disable', async () => requireFeishuChannelService().disable());
  ipcMain.handle('feishu:regenerate-binding-code', async () => requireFeishuChannelService().regenerateBindingCode());
  ipcMain.handle('feishu:unbind', async () => requireFeishuChannelService().unbind());
  ipcMain.handle('auth:profile', async () => requireRuntime().authProfile());
  ipcMain.handle('auth:update-profile', async (_event, payload = {}) => requireRuntime().authUpdateProfile(payload));
  ipcMain.handle('auth:update-password', async (_event, payload = {}) => requireRuntime().authUpdatePassword(payload));
  ipcMain.handle('admin:users', async () => requireRuntime().adminListUsers());
  ipcMain.handle('admin:update-user-role', async (_event, payload = {}) => requireRuntime().adminUpdateUserRole(payload));
  ipcMain.handle('admin:reset-user-password', async (_event, payload = {}) => requireRuntime().adminResetUserPassword(payload));
  ipcMain.handle('admin:delete-user', async (_event, payload = {}) => requireRuntime().adminDeleteUser(payload));
  ipcMain.handle('friends:overview', async () => requireRuntime().friendsOverview());
  ipcMain.handle('friends:update-remark', async (_event, payload = {}) => requireRuntime().friendUpdateRemark(payload));
  ipcMain.handle('social:inbox', async (_event, payload = {}) => requireRuntime().socialInbox(payload));
  ipcMain.handle('social:conversation', async (_event, payload = {}) => requireRuntime().socialConversation(payload));
  ipcMain.handle('social:conversation-summaries', async (_event, payload = {}) => requireRuntime().socialConversationSummaries(payload));
  ipcMain.handle('social:poll', async (_event, payload = {}) => requireRuntime().pollSocialNetwork(payload));
  ipcMain.handle('social:send-message', async (_event, payload = {}) => requireRuntime().socialSendMessage(payload));
  ipcMain.handle('social:update-message', async (_event, payload = {}) => requireRuntime().socialUpdateMessage(payload));
  ipcMain.handle('social:toggle-reaction', async (_event, payload = {}) => requireRuntime().socialToggleMessageReaction(payload));
  ipcMain.handle('social:emoji-favorites-list', async () => requireRuntime().listEmojiFavorites());
  ipcMain.handle('social:emoji-favorites-add', async (_event, payload = {}) => requireRuntime().addEmojiFavorite(payload));
  ipcMain.handle('social:emoji-favorites-remove', async (_event, payload = {}) => requireRuntime().removeEmojiFavorite(payload));
  ipcMain.handle('social:emoji-favorites-reorder', async (_event, payload = {}) => requireRuntime().reorderEmojiFavorites(payload));
  ipcMain.handle('social:mark-read', async (_event, payload = {}) => requireRuntime().socialMarkRead(payload));
  ipcMain.handle('social:status', async () => requireRuntime().socialStatus());
  ipcMain.handle('social:set-conversation-archived', async (_event, payload = {}) => requireRuntime().setConversationArchived(payload));
  ipcMain.handle('social:conversation-preferences', async () => requireRuntime().conversationPreferencesOverview());
  ipcMain.handle('ubuddy:capability-profile-preview', async () => requireRuntime().uBuddyCapabilityProfilePreview());
  ipcMain.handle('social:ubuddy-profiles-query', async (_event, payload = {}) => requireRuntime().queryUBuddyCapabilityProfiles(payload));
  ipcMain.handle('social:ubuddy-profile-publication-status', async () => requireRuntime().uBuddyCapabilityProfilePublicationStatus());
  ipcMain.handle('ubuddy:capability-profile-history', async (_event, payload = {}) => requireRuntime().uBuddyCapabilityProfileHistory(payload));
  ipcMain.handle('ubuddy:capability-profile-regenerate', async () => requireRuntime().regenerateUBuddyCapabilityProfile());
  ipcMain.handle('ubuddy:capability-profile-review', async (_event, payload = {}) => requireRuntime().reviewUBuddyCapabilityProfile(payload));
  ipcMain.handle('ubuddy:capability-profile-publication-preference', async (_event, payload = {}) => requireRuntime().updateUBuddyCapabilityProfilePublicationPreference(payload));
  ipcMain.handle('social:ubuddy-profile-publish', async (_event, payload = {}) => requireRuntime().publishUBuddyCapabilityProfile(payload));
  ipcMain.handle('social:ubuddy-profile-unpublish', async (_event, payload = {}) => requireRuntime().unpublishUBuddyCapabilityProfile(payload));
  ipcMain.handle('social:ubuddy-profile-publication-retry', async () => requireRuntime().retryUBuddyCapabilityProfilePublication());
  ipcMain.handle('chat-groups:overview', async () => requireRuntime().chatGroupsOverview());
  ipcMain.handle('chat-groups:group', async (_event, payload = {}) => requireRuntime().chatGroup(payload));
  ipcMain.handle('chat-groups:create', async (_event, payload = {}) => requireRuntime().createChatGroup(payload));
  ipcMain.handle('chat-groups:send-message', async (_event, payload = {}) => requireRuntime().sendChatGroupMessage(payload));
  ipcMain.handle('chat-groups:mark-read', async (_event, payload = {}) => requireRuntime().markChatGroupRead(payload));
  ipcMain.handle('chat-groups:update', async (_event, payload = {}) => requireRuntime().updateChatGroup(payload));
  ipcMain.handle('secretary:ensure-session', async (_event, payload = {}) => requireRuntime().ensureSecretarySession(payload));
  ipcMain.handle('secretary:task-reference-options', async (_event, payload = {}) => requireRuntime().secretaryTaskReferenceOptions(payload));
  ipcMain.handle('secretary:chat', async (event, payload = {}) => {
    await refreshCodexSystemProxy();
    return requireRuntime().secretaryChat({
      ...payload,
      onEvent: payload.channelId ? (item) => event.sender.send('codex:event', { channelId: payload.channelId, event: item }) : null,
    });
  });
  ipcMain.handle('private-assistant:status', async () => requireRuntime().privateAssistantStatus());
  ipcMain.handle('managed-provider-usage:status', async () => requireRuntime().managedProviderUsageStatus());
  ipcMain.handle('private-assistant:ensure-session', async (_event, payload = {}) => requireRuntime().ensurePrivateAssistantSession(payload));
  ipcMain.handle('private-assistant:reset-context', async (_event, payload = {}) => requireRuntime().resetPrivateAssistantContext(payload));
  ipcMain.handle('delegations:list', async (_event, payload = {}) => requireRuntime().agentDelegations(payload));
  ipcMain.handle('delegations:create', async (_event, payload = {}) => requireRuntime().createAgentDelegation(payload));
  ipcMain.handle('delegations:process-content', async (event, payload = {}) => {
    await refreshCodexSystemProxy();
    const channelId = String(payload.channelId || '');
    return requireRuntime().processAgentDelegationContent({
      ...payload,
      onEvent: channelId ? (item) => event.sender.send('codex:event', { channelId, event: item }) : null,
    });
  });
  ipcMain.handle('delegations:respond', async (_event, payload = {}) => requireRuntime().respondAgentDelegation(payload));
  ipcMain.handle('delegations:start', async (_event, payload = {}) => requireRuntime().startAgentDelegation(payload));
  ipcMain.handle('delegations:work-digest-supplement', async (_event, payload = {}) => requireRuntime().supplementRecentWorkDigest(payload));
  ipcMain.handle('delegations:task-memory', async (_event, payload = {}) => requireRuntime().delegationTaskMemory(payload));
  ipcMain.handle('collaboration:overview', async () => requireRuntime().collaborationOverview());
  ipcMain.handle('collaboration:dispatch-command', async (_event, payload = {}) => requireRuntime().dispatchCollaborationCommand(payload));
  ipcMain.handle('collaboration:cancel-pending-dispatch', async (_event, payload = {}) => requireRuntime().cancelPendingUBuddyDispatch(payload));
  ipcMain.handle('collaboration:group', async (_event, payload = {}) => requireRuntime().collaborationGroup(payload));
  ipcMain.handle('collaboration:group-workspace', async (_event, payload = {}) => requireRuntime().collaborationGroupWorkspace(payload));
  ipcMain.handle('collaboration:send-message', async (_event, payload = {}) => requireRuntime().sendCollaborationMessage(payload));
  ipcMain.handle('collaboration:prepare-summary', async (_event, payload = {}) => requireRuntime().prepareCollaborationGroupSummary(payload));
  ipcMain.handle('collaboration:publish-summary', async (_event, payload = {}) => requireRuntime().publishCollaborationGroupSummary(payload));
  ipcMain.handle('collaboration:update-group', async (_event, payload = {}) => requireRuntime().updateCollaborationGroup(payload));
  ipcMain.handle('collaboration:task-action', async (_event, payload = {}) => requireRuntime().collaborationTaskAction(payload));
  ipcMain.handle('collaboration:download-file', async (_event, payload = {}) => requireRuntime().collaborationDownloadFile(payload));
  ipcMain.handle('collaboration:workspace-messages', async (_event, payload = {}) => requireRuntime().collaborationWorkspaceMessages(payload));
  ipcMain.handle('collaboration:workspace-message', async (_event, payload = {}) => requireRuntime().collaborationWorkspaceMessage({ ...payload, background: payload.background !== false }));
  ipcMain.handle('collaboration:workspace-cancel', async (_event, payload = {}) => requireRuntime().cancelCollaborationWorkspaceWork(payload));
  ipcMain.handle('task-run:workspace-messages', async (_event, payload = {}) => requireRuntime().taskRunWorkspaceMessages(payload));
  ipcMain.handle('task-run:workspace-message', async (_event, payload = {}) => requireRuntime().taskRunWorkspaceTurn(payload));
  ipcMain.handle('friends:search-users', async (_event, payload = {}) => requireRuntime().friendSearch(payload));
  ipcMain.handle('friends:send-request', async (_event, payload = {}) => requireRuntime().friendSendRequest(payload));
  ipcMain.handle('friends:accept-request', async (_event, payload = {}) => requireRuntime().friendAcceptRequest(payload));
  ipcMain.handle('friends:reject-request', async (_event, payload = {}) => requireRuntime().friendRejectRequest(payload));
  ipcMain.handle('friends:cancel-request', async (_event, payload = {}) => requireRuntime().friendCancelRequest(payload));
  ipcMain.handle('friends:remove', async (_event, payload = {}) => requireRuntime().friendRemove(payload));
  ipcMain.handle('friends:block', async (_event, payload = {}) => requireRuntime().friendBlock(payload));
  ipcMain.handle('organizations:create', async (_event, payload = {}) => requireRuntime().organizationCreate(payload));
  ipcMain.handle('organizations:join', async (_event, payload = {}) => requireRuntime().organizationJoin(payload));
  ipcMain.handle('organizations:action', async (_event, payload = {}) => requireRuntime().organizationAction(payload));
  ipcMain.handle('organization-research:policy', async (_event, payload = {}) => requireRuntime().organizationResearchPolicy(payload));
  ipcMain.handle('organization-research:enable', async (_event, payload = {}) => requireRuntime().enableOrganizationResearch(payload));
  ipcMain.handle('organization-research:sync', async (_event, payload = {}) => requireRuntime().syncOrganizationResearch(payload));
  ipcMain.handle('organization-research:investigate', async (_event, payload = {}) => requireRuntime().investigateOrganizationMessages(payload));
  ipcMain.handle('organization-research:source', async (_event, payload = {}) => requireRuntime().organizationResearchSource(payload));
  ipcMain.handle('organization-research:result', async (_event, payload = {}) => requireRuntime().organizationResearchResult(payload));
  ipcMain.handle('organization-research:audits', async (_event, payload = {}) => requireRuntime().organizationResearchAudits(payload));
  ipcMain.handle('cloud:status', async () => requireRuntime().cloudStatus());
  ipcMain.handle('cloud:save-config', async (_event, payload = {}) => requireRuntime().saveCloudConfig(payload));
  ipcMain.handle('cloud:sync-now', async (_event, payload = {}) => requireRuntime().syncCloudNow(payload));
  ipcMain.handle('cloud:upload-compliance', async (_event, payload = {}) => requireRuntime().uploadCompliance(payload));
  ipcMain.handle('cloud:suspend-user', async (_event, payload = {}) => requireRuntime().suspendCloudUser(payload));
  ipcMain.handle('cloud:reactivate-user', async (_event, payload = {}) => requireRuntime().reactivateCloudUser(payload));
  ipcMain.handle('cloud:trace-file', async (_event, payload = {}) => requireRuntime().traceCloudFile(payload));
  ipcMain.handle('cloud:trace-conversation', async (_event, payload = {}) => requireRuntime().traceCloudConversation(payload));
  ipcMain.handle('agents:user-settings', async () => requireRuntime().userAgentSettings());
  ipcMain.handle('agents:update-user-settings', async (_event, payload = {}) => requireRuntime().updateUserAgentSettings(payload));
  ipcMain.handle('employees:overview', async (_event, payload = {}) => requireRuntime().employeeOverview(payload));
  ipcMain.handle('employees:availability', async (_event, payload = {}) => requireRuntime().agentAvailability(payload));
  ipcMain.handle('employees:recruit', async (_event, payload = {}) => employeeMutationWithDiagnostics('recruit', payload, () => requireRuntime().recruitEmployee(payload)));
  ipcMain.handle('employees:update-profile', async (_event, payload = {}) => employeeMutation(() => requireRuntime().updateEmployeeProfile(payload)));
  ipcMain.handle('employees:deactivate', async (_event, payload = {}) => employeeMutationWithDiagnostics('deactivate', payload, () => requireRuntime().deactivateEmployee(payload)));
  ipcMain.handle('employees:reactivate', async (_event, payload = {}) => employeeMutationWithDiagnostics('reactivate', payload, () => requireRuntime().reactivateEmployee(payload)));
  ipcMain.handle('employees:retry-sync', async (_event, payload = {}) => employeeMutation(() => requireRuntime().retryEmployeeLifecycleSync(payload)));
  ipcMain.handle('employees:events', async (_event, payload = {}) => requireRuntime().employeeRecruitmentEvents(payload));
  ipcMain.handle('employees:memory-documents', async (_event, payload = {}) => requireRuntime().employeeMemoryDocuments(payload));
  ipcMain.handle('employees:memory-details', async (_event, payload = {}) => requireRuntime().employeeMemoryDetails(payload));
  ipcMain.handle('employees:memory-versions', async (_event, payload = {}) => requireRuntime().employeeMemoryVersions(payload));
  ipcMain.handle('employees:memory-create', async (_event, payload = {}) => employeeMutation(() => requireRuntime().createEmployeeMemory(payload)));
  ipcMain.handle('employees:memory-archive', async (_event, payload = {}) => employeeMutation(() => requireRuntime().archiveEmployeeMemory(payload)));
  ipcMain.handle('employees:memory-switch', async (_event, payload = {}) => employeeMutation(() => requireRuntime().switchEmployeeMemory(payload)));
  ipcMain.handle('employees:memory-clear', async (_event, payload = {}) => employeeMutation(() => requireRuntime().clearEmployeeMemory(payload)));
  ipcMain.handle('employees:memory-restore', async (_event, payload = {}) => employeeMutation(() => requireRuntime().restoreEmployeeMemory(payload)));
  ipcMain.handle('employees:memory-restore-switch', async (_event, payload = {}) => employeeMutation(() => requireRuntime().restoreAndSwitchEmployeeMemory(payload)));
  ipcMain.handle('employees:memory-rename', async (_event, payload = {}) => employeeMutation(() => requireRuntime().renameEmployeeMemory(payload)));
  ipcMain.handle('employees:memory-conflicts', async (_event, payload = {}) => requireRuntime().employeeMemoryConflicts(payload));
  ipcMain.handle('employees:memory-conflict-resolve', async (_event, payload = {}) => employeeMutation(() => requireRuntime().resolveEmployeeMemoryConflict(payload)));
  ipcMain.handle('employees:context-spaces', async (_event, payload = {}) => requireRuntime().employeeContextSpaces(payload));
  ipcMain.handle('employees:context-switch', async (_event, payload = {}) => employeeMutation(() => requireRuntime().switchEmployeeContext(payload)));
  ipcMain.handle('employees:session-history', async (_event, payload = {}) => requireRuntime().employeeSessionHistory(payload));
  ipcMain.handle('employees:conversation-overview', async (_event, payload = {}) => requireRuntime().employeeConversationOverview(payload));
  ipcMain.handle('employees:conversation-history-group', async (_event, payload = {}) => requireRuntime().employeeConversationHistoryGroup(payload));
  ipcMain.handle('agents:conversation-open', async (_event, payload = {}) => requireRuntime().openAgentConversation(payload));
  ipcMain.handle('agents:conversation-timeline', async (_event, payload = {}) => requireRuntime().agentConversationTimeline(payload));
  ipcMain.handle('employees:leadership-history', async (_event, payload = {}) => requireRuntime().employeeLeadershipHistory(payload));
  ipcMain.handle('employees:leadership-trial', async (_event, payload = {}) => employeeMutation(() => requireRuntime().requestEmployeeLeadershipTrial(payload)));
  ipcMain.handle('employees:leadership-decision', async (_event, payload = {}) => employeeMutation(() => requireRuntime().decideEmployeeLeadershipAction(payload)));
  ipcMain.handle('employees:leadership-restore', async (_event, payload = {}) => employeeMutation(() => requireRuntime().restoreEmployeeLeadership(payload)));
  ipcMain.handle('employees:leadership-appeals', async (_event, payload = {}) => requireRuntime().employeeLeadershipAppeals(payload));
  ipcMain.handle('employees:leadership-appeal-submit', async (_event, payload = {}) => employeeMutation(() => requireRuntime().submitEmployeeLeadershipAppeal(payload)));
  ipcMain.handle('employees:leadership-governance-queue', async () => requireRuntime().leadershipGovernanceQueue());
  ipcMain.handle('employees:leadership-governance-decision', async (_event, payload = {}) => employeeMutation(() => requireRuntime().decideLeadershipGovernanceAction(payload)));
  ipcMain.handle('employees:leadership-appeal-decision', async (_event, payload = {}) => employeeMutation(() => requireRuntime().decideLeadershipGovernanceAppeal(payload)));
  ipcMain.handle('work-memory:progress', async (_event, payload = {}) => requireRuntime().workMemoryProgress(payload));
  ipcMain.handle('work-memory:read', async (_event, payload = {}) => requireRuntime().readWorkMemory(payload));
  ipcMain.handle('work-memory:publish', async (_event, payload = {}) => requireRuntime().publishWorkMemory(payload));
  ipcMain.handle('work-memory:outbox', async (_event, payload = {}) => requireRuntime().workMemoryPublicationStatus(payload));
  ipcMain.handle('work-memory:audits', async (_event, payload = {}) => requireRuntime().workMemoryAudits(payload));
  ipcMain.handle('work-memory:appoint', async (_event, payload = {}) => requireRuntime().appointWorkMemoryLeader(payload));
  ipcMain.handle('work-memory:revoke', async (_event, payload = {}) => requireRuntime().revokeWorkMemoryLeader(payload));
  ipcMain.handle('personal-evolution:status', async () => requireRuntime().personalEvolutionStatus());
  ipcMain.handle('personal-evolution:preference', async () => requireRuntime().evolutionPreference());
  ipcMain.handle('personal-evolution:set-preference', async (_event, payload = {}) => requireRuntime().setEvolutionPreference(payload));
  ipcMain.handle('personal-evolution:check-updates', async () => requireRuntime().checkEvolutionUpdates());
  ipcMain.handle('personal-evolution:versions', async (_event, payload = {}) => requireRuntime().personalEvolutionVersions(payload));
  ipcMain.handle('personal-evolution:activate-version', async (_event, payload = {}) => requireRuntime().activatePersonalEvolutionVersion(payload));
  ipcMain.handle('personal-evolution:schedule', async (_event, payload = {}) => requireRuntime().personalEvolutionSchedule(payload));
  ipcMain.handle('personal-evolution:grants', async () => requireRuntime().listEvolutionGrants());
  ipcMain.handle('personal-evolution:grant-revoke', async (_event, payload = {}) => requireRuntime().revokeEvolutionGrant(payload));
  ipcMain.handle('personal-evolution:grant-approve', async (_event, payload = {}) => requireRuntime().approveEvolutionGrant(payload));
  ipcMain.handle('personal-evolution:list', async (_event, payload = {}) => requireRuntime().listPersonalEvolutionProposals(payload));
  ipcMain.handle('personal-evolution:get', async (_event, payload = {}) => requireRuntime().getPersonalEvolutionProposal(payload));
  ipcMain.handle('personal-evolution:run', async (_event, payload = {}) => requireRuntime().runPersonalEvolution(payload));
  ipcMain.handle('ubuddy-organization-evolution:overview', async () => requireRuntime().uBuddyOrganizationEvolutionOverview());
  ipcMain.handle('ubuddy-organization-evolution:activate', async (_event, payload = {}) => requireRuntime().activateUBuddyOrganizationEvolution(payload));
  ipcMain.handle('ubuddy-organization-evolution:disable', async (_event, payload = {}) => requireRuntime().disableUBuddyOrganizationEvolution(payload));
  ipcMain.handle('personal-evolution:decide', async (_event, payload = {}) => requireRuntime().decidePersonalEvolution(payload));
  ipcMain.handle('personal-evolution:rollback-skill', async (_event, payload = {}) => requireRuntime().rollbackPersonalSkill(payload));
  ipcMain.handle('personal-evolution:rollback-memory', async (_event, payload = {}) => requireRuntime().rollbackPersonalMemory(payload));
  ipcMain.handle('stage8-evolution:status', async () => requireRuntime().stage8EvolutionStatus());
  ipcMain.handle('stage8-evolution:performance', async (_event, payload = {}) => requireRuntime().agentPerformanceLevel(payload));
  ipcMain.handle('stage8-evolution:cluster-overview', async () => requireRuntime().clusterEvolutionOverview());
  ipcMain.handle('stage8-evolution:market-versions', async (_event, payload = {}) => requireRuntime().marketVersions(payload));
  ipcMain.handle('stage8-evolution:canary-opt-in',async(_event,payload={})=>requireRuntime().setMarketCanaryOptIn(payload));
  ipcMain.handle('stage8-evolution:adopt', async (_event, payload = {}) => requireRuntime().adoptMarketSections(payload));
  ipcMain.handle('stage8-evolution:rollback', async (_event, payload = {}) => requireRuntime().rollbackMarketSections(payload));
  ipcMain.handle('stage8-evolution:ignore', async (_event, payload = {}) => requireRuntime().ignoreMarketSections(payload));
  ipcMain.handle('release:latest', async (_event, payload = {}) => requireRuntime().latestRelease(payload));
  ipcMain.handle('codex:doctor', async () => {
    await refreshCodexSystemProxy();
    return requireRuntime().doctor();
  });
  ipcMain.handle('codex:config', async () => requireRuntime().codexConfig());
  ipcMain.handle('codex:config-files', async () => requireRuntime().codexConfigFiles());
  ipcMain.handle('codex:request-provider-key', async (_event, payload = {}) => requireRuntime().requestProviderKeyApplication(payload));
  ipcMain.handle('codex:provider-key-applications', async () => requireRuntime().providerKeyApplications());
  ipcMain.handle('codex:decide-provider-key', async (_event, payload = {}) => requireRuntime().decideProviderKeyApplication(payload));
  ipcMain.handle('codex:claim-provider-key', async (_event, payload = {}) => {
    const result = await requireRuntime().claimProviderKeyApplication(payload);
    await refreshCodexSystemProxy();
    const modelCatalog = await refreshModelCatalog('provider-key-claim');
    return { ...result, modelCatalog };
  });
  ipcMain.handle('codex:save-config', async (_event, payload = {}) => {
    const result = requireRuntime().saveCodexConfig(payload);
    await refreshCodexSystemProxy();
    return result;
  });
  ipcMain.handle('models:list', async () => requireRuntime().modelCatalogStatus());
  ipcMain.handle('models:refresh', async () => {
    requireRuntime().auth.requireAdmin();
    return refreshModelCatalog('manual');
  });
  ipcMain.handle('codex:save-config-files', async (_event, payload = {}) => {
    const result = await requireRuntime().saveCodexConfigFiles(payload);
    await refreshCodexSystemProxy();
    return result;
  });
  ipcMain.handle('files:upload', async (_event, payload = {}) => requireRuntime().uploadFile(payload));
  ipcMain.handle('files:read-base64', async (_event, payload = {}) => {
    const filePath = String(payload?.path || '');
    if (!filePath) throw new Error('缺少文件路径。');
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('文件不存在。');
    return { dataBase64: fs.readFileSync(filePath).toString('base64'), size: stat.size };
  });
  ipcMain.handle('files:upload-path', async (_event, payload = {}) => requireRuntime().uploadFileFromPath(payload));
  ipcMain.handle('files:select', async (event, payload = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
    const extensions = normalizeFileDialogExtensions(payload.extensions);
    const result = await dialog.showOpenDialog(parent, {
      title: t('选择要添加到对话的文件', 'Choose Files to Add to the Conversation'),
      buttonLabel: t('添加到对话', 'Add to Conversation'),
      properties: ['openFile', 'multiSelections'],
      filters: extensions.length ? [{ name: t('支持的文件', 'Supported Files'), extensions }] : undefined,
    });
    if (result.canceled || !result.filePaths?.length) return { canceled: true, files: [] };
    const files = [];
    const errors = [];
    for (const sourcePath of result.filePaths) {
      const extension = path.extname(sourcePath).slice(1).toLowerCase();
      if (extensions.length && !extensions.includes(extension)) {
        errors.push(`${path.basename(sourcePath)} 格式暂不支持`);
        continue;
      }
      try {
        files.push(requireRuntime().uploadFileFromPath({ sourcePath }));
      } catch (error) {
        errors.push(`${path.basename(sourcePath)}：${error.message || error}`);
      }
    }
    return {
      canceled: false,
      files,
      errors,
    };
  });
  ipcMain.handle('files:render', async (_event, payload = {}) => requireRuntime().renderUploadedFileAsync(payload));
  ipcMain.handle('files:open-path', async (_event, filePath = '') => {
    if (!filePath) return '';
    return shell.openPath(String(filePath));
  });
  ipcMain.handle('files:open-file', async (_event, payload = {}) => {
    const info = requireRuntime().describeFile(payload);
    return shell.openPath(info.path);
  });
  ipcMain.handle('files:show-in-folder', async (_event, payload = {}) => {
    const info = requireRuntime().describeFile(payload);
    shell.showItemInFolder(info.path);
    return info;
  });
  ipcMain.handle('files:save-copy', async (event, payload = {}) => {
    const info = requireRuntime().describeFile(payload);
    const parent = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
    const result = await dialog.showSaveDialog(parent, {
      title: t('保存文件', 'Save File'),
      defaultPath: path.join(app.getPath('downloads'), info.name || 'file'),
      buttonLabel: t('保存', 'Save'),
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.copyFileSync(info.path, result.filePath);
    return {
      canceled: false,
      path: result.filePath,
      name: path.basename(result.filePath),
      size: fs.statSync(result.filePath).size,
    };
  });
  ipcMain.handle('files:save-text', async (event, payload = {}) => {
    const content = String(payload.content || '');
    if (!content.trim()) throw new Error('没有可保存的文本内容。');
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('文本内容过大，无法直接保存。');
    const requestedName = path.basename(String(payload.name || 'Janus-plan.md').trim()) || 'Janus-plan.md';
    const parent = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
    const result = await dialog.showSaveDialog(parent, {
      title: String(payload.title || t('保存计划', 'Save Plan')),
      defaultPath: path.join(app.getPath('downloads'), requestedName),
      buttonLabel: t('保存', 'Save'),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { canceled: false, path: result.filePath, name: path.basename(result.filePath), size: fs.statSync(result.filePath).size };
  });
  ipcMain.handle('logging:status', async () => applicationLoggingStatus());
  ipcMain.handle('logging:open-directory', async () => {
    const status = applicationLoggingStatus();
    if (!status.directory) throw new Error('日志目录尚未初始化。');
    const openError = await shell.openPath(status.directory);
    if (openError) throw new Error(openError);
    return { ok: true, directory: status.directory };
  });
  ipcMain.handle('logging:export', async (event) => {
    try { getRuntime()?.uBuddyDiagnosticReport?.(); } catch (error) {
      ipcLogger.warn('ubuddy-diagnostic-report-failed', { error });
    }
    const parent = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const result = await dialog.showSaveDialog(parent, {
      title: t('导出诊断日志', 'Export Diagnostic Logs'),
      defaultPath: path.join(app.getPath('downloads'), `Janus-Diagnostics-${stamp}.log`),
      buttonLabel: t('导出', 'Export'),
      filters: [{ name: 'Janus Log', extensions: ['log'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, ...await exportApplicationLogs({ destination: result.filePath }) };
  });
  ipcMain.handle('logging:clear', async () => clearRotatedApplicationLogs());
  ipcMain.handle('logging:renderer-event', async (event, payload = {}) => {
    const senderId = event.sender?.id || 0;
    const now = Date.now();
    const bucket = rendererLogRate.get(senderId) || { startedAt: now, count: 0 };
    if (now - bucket.startedAt >= 60_000) {
      bucket.startedAt = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    rendererLogRate.set(senderId, bucket);
    if (bucket.count > 120) return { accepted: false, reason: 'rate_limited' };
    const level = ['info', 'warn', 'error'].includes(String(payload.level || '')) ? String(payload.level) : 'error';
    const rawData = payload.data && typeof payload.data === 'object' ? payload.data : undefined;
    let data = rawData;
    if (rawData) {
      try {
        if (JSON.stringify(rawData).length > 16_384) data = { oversized: true };
      } catch {
        data = { invalid: true };
      }
    }
    rendererLogger[level](String(payload.event || 'renderer_event'), {
      message: String(payload.message || payload.event || 'renderer_event').slice(0, 2_000),
      context: { windowId: senderId },
      data,
      error: payload.error && typeof payload.error === 'object' ? payload.error : undefined,
    });
    return { accepted: true };
  });
  ipcMain.handle('clipboard:write-text', async (_event, text = '') => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });
  ipcMain.handle('clipboard:read-text', async () => clipboard.readText());
  ipcMain.handle('clipboard:write-image', async (_event, payload = {}) => {
    const file = requireRuntime().describeFile(payload);
    return writeImageFileToClipboard({ clipboard, nativeImage, file });
  });
  ipcMain.handle('workspace:select', async (event) => {
    const testWorkspaceRoot = process.env.JANUS_ENABLE_TEST_HOOKS === '1'
      ? String(process.env.JANUS_TEST_WORKSPACE_SELECTION_ROOT || '').trim()
      : '';
    if (testWorkspaceRoot) {
      const workspaceRoot = path.resolve(testWorkspaceRoot);
      if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error('测试项目路径不是文件夹。');
      return {
        canceled: false,
        root: getRuntime()?.root || '',
        workspaceRoot,
        workspace_root: workspaceRoot,
        requiresRestart: false,
      };
    }
    const parent = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
    const result = await dialog.showOpenDialog(parent, {
      title: t('选择项目', 'Choose Project'),
      buttonLabel: t('选择项目', 'Choose Project'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true, root: getRuntime()?.root || '' };
    const workspaceRoot = path.resolve(result.filePaths[0]);
    return {
      canceled: false,
      root: getRuntime()?.root || '',
      workspaceRoot,
      workspace_root: workspaceRoot,
      requiresRestart: false,
    };
  });
  ipcMain.handle('workspace:select-project', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
    const result = await dialog.showOpenDialog(parent, {
      title: t('选择项目工作区', 'Choose Project Workspace'),
      buttonLabel: t('创建项目', 'Create Project'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    return { canceled: false, workspaceRoot: result.filePaths[0], workspace_root: result.filePaths[0] };
  });
  ipcMain.handle('org:list', async () => requireRuntime().org.list());
  ipcMain.handle('projects:list', async (_event, payload = {}) => requireRuntime().listProjects(payload));
  ipcMain.handle('projects:browse-files', async (_event, payload = {}) => requireRuntime().browseProjectFiles(payload));
  ipcMain.handle('projects:create', async (_event, payload = {}) => requireRuntime().createProject(payload));
  ipcMain.handle('projects:update', async (_event, payload = {}) => requireRuntime().updateProject(payload));
  ipcMain.handle('sessions:list', async (_event, payload = {}) => requireRuntime().listSessions(payload));
  ipcMain.handle('agent-deliveries:list', async (_event, payload = {}) => requireRuntime().listAgentDeliveryRuns(payload));
  ipcMain.handle('agent-deliveries:cancel', async (_event, payload = {}) => requireRuntime().cancelAgentDeliveryRun(payload));
  ipcMain.handle('sessions:search', async (_event, payload = {}) => requireRuntime().searchSessions(payload));
  ipcMain.handle('chat:context-status', async (_event, payload = {}) => requireRuntime().chatContextStatus(payload));
  ipcMain.handle('chat:clear-context', async (_event, payload = {}) => requireRuntime().clearChatContext(payload));
  ipcMain.handle('chat:reset-context', async (_event, payload = {}) => requireRuntime().resetChatContext(payload));
  ipcMain.handle('sessions:update', async (_event, payload = {}) => requireRuntime().updateSession(payload));
  ipcMain.handle('goals:update', async (_event, payload = {}) => requireRuntime().updateGoal(payload));
  ipcMain.handle('messages:list', async (_event, sessionId) => requireRuntime().listMessages(sessionId));
  ipcMain.handle('messages:list-page', async (_event, payload = {}) => requireRuntime().listMessagePage(payload));
  ipcMain.handle('messages:rewrite-last-turn', async (_event, payload = {}) => requireRuntime().rewriteLastUserTurn(payload));
  ipcMain.handle('chat:send', async (event, payload) => {
    await refreshCodexSystemProxy();
    const channelId = payload?.channelId || '';
    const requestedIdentity = {
      channelId: String(channelId),
      sessionId: String(payload?.sessionId || ''),
      departmentId: String(payload?.departmentId || ''),
      agentId: String(payload?.agentId || ''),
      agentInstanceId: String(payload?.agentInstanceId || ''),
      chatMode: String(payload?.chatMode || ''),
    };
    ipcLogger.info('chat_route_requested', { data: requestedIdentity });
    const result = await requireRuntime().sendChat({
      ...payload,
      skipAgentQueue: false,
      internalRequestMessageId: '',
      internalResponseMetadata: null,
      onEvent: channelId
        ? (item) => event.sender.send('codex:event', { channelId, event: item })
        : null,
    });
    ipcLogger.info('chat_route_resolved', {
      data: {
        ...requestedIdentity,
        resolvedSessionId: String(result?.session?.id || ''),
        resolvedAgentId: String(result?.session?.agentId || ''),
        resolvedAgentInstanceId: String(result?.session?.agentInstanceId || ''),
        sessionChanged: Boolean(requestedIdentity.sessionId && requestedIdentity.sessionId !== String(result?.session?.id || '')),
        instanceChanged: Boolean(requestedIdentity.agentInstanceId
          && requestedIdentity.agentInstanceId !== String(result?.session?.agentInstanceId || '')),
      },
    });
    return result;
  });
  ipcMain.handle('chat:cancel', async (_event, payload = {}) => requireRuntime().cancelChat(payload));
  ipcMain.handle('chat:resolve-approval', async (_event, payload = {}) => requireRuntime().resolveChatApproval(payload));
  ipcMain.handle('chat:resolve-user-input', async (_event, payload = {}) => requireRuntime().resolveChatUserInput(payload));
  const requireOwnedTask = (rt, taskRunId) => {
    const user = rt.auth.requireUser();
    const task = rt.store.getTaskRun(String(taskRunId || ''));
    if (!canAccessTaskRun(user, task)) throw new Error('无权访问该协作任务。');
    rt.store.requireAccountWorkspace({ userId: user.id, workspaceId: task.workspaceId });
    const active = rt.store.activeAccountWorkspace({ userId: user.id, deviceId: rt.store.contextDeviceId?.() || 'local' });
    if (active?.id !== task.workspaceId) throw new Error('该任务不属于当前工作空间。');
    return { user, task };
  };
  ipcMain.handle('tasks:list', async (_event, payload = {}) => {
    const rt = requireRuntime();
    rt.auth.requireUser();
    return rt.listTaskViews();
  });
  ipcMain.handle('ubuddy:task-center', async (_event, payload = {}) => requireRuntime().uBuddyTaskCenter(payload));
  ipcMain.handle('ubuddy:delivery-center', async (_event, payload = {}) => requireRuntime().uBuddyDeliveryCenter(payload));
  ipcMain.handle('tasks:get', async (_event, taskRunId) => {
    const rt = requireRuntime();
    requireOwnedTask(rt, taskRunId);
    return rt.getTaskView(taskRunId);
  });
  ipcMain.handle('tasks:create', async (_event, payload) => {
    const rt = requireRuntime();
    const user = rt.auth.requireUser();
    const activeWorkspace = rt.store.activeAccountWorkspace({ userId: user.id, deviceId: rt.store.contextDeviceId?.() || 'local' });
    return rt.scheduler.createTaskRun({ ...payload, userId: user.id,
      metadata: { ...(payload?.metadata || {}), accountWorkspaceId: activeWorkspace?.id || 'workspace_personal' } });
  });
  ipcMain.handle('tasks:run-ready', async (_event, payload) => requireRuntime().runReadyTaskNodes({ taskRunId: payload.taskRunId, options: payload.options || {} }));
  ipcMain.handle('tasks:retry-node', async (_event, payload = {}) => requireRuntime().retryTaskNode({
    taskRunId: payload.taskRunId,
    taskNodeId: payload.taskNodeId,
    options: payload.options || {},
  }));
  ipcMain.handle('tasks:cancel', async (_event, payload = {}) => requireRuntime().cancelTaskRun(payload));
  ipcMain.handle('tasks:rerun', async (_event, payload = {}) => requireRuntime().rerunTaskRun(payload));
  ipcMain.handle('tasks:delete', async (_event, payload = {}) => {
    const rt = requireRuntime();
    const ids = Array.isArray(payload.taskRunIds) ? payload.taskRunIds : [payload.taskRunId || payload.id].filter(Boolean);
    return ids.map((id) => {
      requireOwnedTask(rt, id);
      return rt.store.deleteTaskRun(String(id));
    }).filter(Boolean);
  });
  ipcMain.handle('tasks:add-node', async (_event, payload) => {
    const rt = requireRuntime();
    requireOwnedTask(rt, payload.taskRunId);
    return rt.scheduler.addTaskNode(payload.taskRunId, payload.node || {}, payload.options || {});
  });
  ipcMain.handle('tasks:resolve-communication', async (_event, payload) => {
    const rt = requireRuntime();
    const communication = rt.store.getCommunication(payload.communicationId);
    requireOwnedTask(rt, communication?.taskRunId || '');
    return rt.scheduler.resolveCommunication(payload.communicationId, payload.response || {});
  });
  ipcMain.handle('tasks:apply-timeouts', async (_event, payload) => {
    const rt = requireRuntime();
    requireOwnedTask(rt, payload.taskRunId);
    return rt.scheduler.applyTimeouts(payload.taskRunId, payload.options || {});
  });
  ipcMain.handle('agents:statuses', async () => requireRuntime().agentStatuses());
  ipcMain.handle('memory:audit', async (_event, payload = {}) => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    return rt.store.recordMemoryAudit(payload);
  });
  ipcMain.handle('memory:apply-policy', async (_event, payload = {}) => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    return rt.store.applyMemoryLifecyclePolicy(payload);
  });
  ipcMain.handle('evolution:overview', async () => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    return rt.store.evolutionOverview();
  });
  ipcMain.handle('evolution:run', async () => { throw cloudAuthorityRequired(); });
  ipcMain.handle('evolution:archive-label', async () => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    throw cloudAuthorityRequired();
  });
  ipcMain.handle('evolution:rollback-skill', async () => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    throw cloudAuthorityRequired();
  });
  ipcMain.handle('evolution:calibrate-gate', async () => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    throw cloudAuthorityRequired();
  });
  ipcMain.handle('evolution:specialist-start', async () => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    throw cloudAuthorityRequired();
  });
  ipcMain.handle('evolution:specialist-evaluate', async () => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    throw cloudAuthorityRequired();
  });
  ipcMain.handle('evolution:specialist-finalize', async () => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    throw cloudAuthorityRequired();
  });
  ipcMain.handle('evolution:career-transition', async () => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    throw cloudAuthorityRequired();
  });
  ipcMain.handle('evolution:holdout-add', async () => {
    const rt = requireRuntime();
    rt.auth.requireAdmin();
    throw cloudAuthorityRequired();
  });
  ipcMain.handle('plugins:list', async () => pluginCatalog(requireRuntime().root, { appVersion: app.getVersion() }));
  ipcMain.handle('codex-plugins:list', async () => requireRuntime().nativePluginCatalog());
  ipcMain.handle('codex-plugins:install', async (_event, payload = {}) => requireRuntime().installNativePlugin(payload));
  ipcMain.handle('codex-plugins:remove', async (_event, payload = {}) => requireRuntime().removeNativePlugin(payload));
  ipcMain.handle('codex-plugin-marketplaces:add', async (_event, payload = {}) => requireRuntime().addNativePluginMarketplace(payload));
  ipcMain.handle('codex-plugin-marketplaces:pick-source', async () => {
    requireRuntime().auth.requireUser();
    const options = { title: '选择 Codex marketplace 目录', properties: ['openDirectory'] };
    const parent = getMainWindow?.();
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return { canceled: result.canceled, source: result.filePaths?.[0] || '' };
  });
  ipcMain.handle('codex-plugin-marketplaces:upgrade', async (_event, payload = {}) => requireRuntime().upgradeNativePluginMarketplace(payload));
  ipcMain.handle('codex-plugin-marketplaces:remove', async (_event, payload = {}) => requireRuntime().removeNativePluginMarketplace(payload));
  ipcMain.handle('plugins:status', async (_event, payload = {}) => pluginStatus(requireRuntime().root, payload.pluginId, { appVersion: app.getVersion() }));
  ipcMain.handle('plugins:install', async (event, payload = {}) => {
    const rt = requireRuntime();
    rt.auth.requireUser();
    const pluginId = String(payload.pluginId || '').trim();
    const result = await installPlugin(rt.root, pluginId, {
      appVersion: app.getVersion(),
      onProgress: (progress) => {
        const item = { pluginId, ...progress };
        event.sender.send('plugins:progress', item);
        if (pluginId === 'ppt_creation') event.sender.send('plugins:pptx-progress', progress);
      },
    });
    rt.refreshAgentIdentityCatalog?.();
    return result;
  });
  ipcMain.handle('plugins:uninstall', async (_event, payload = {}) => {
    const rt = requireRuntime();
    rt.auth.requireUser();
    const result = await uninstallPlugin(rt.root, payload.pluginId, { appVersion: app.getVersion() });
    rt.refreshAgentIdentityCatalog?.();
    return result;
  });
  ipcMain.handle('plugins:open-files', async (_event, payload = {}) => {
    const rt = requireRuntime();
    rt.auth.requireUser();
    const item = pluginStatus(rt.root, payload.pluginId, { appVersion: app.getVersion() });
    if (!item.status.installed) throw new Error(`请先安装${item.name}。`);
    const directoryPath = pluginInstallPath(rt.root, payload.pluginId);
    Promise.resolve(shell.openPath(directoryPath))
      .then((openError) => {
        if (openError) ipcLogger.error('plugin-directory-open-failed', { message: openError, data: { pluginId } });
      })
      .catch((error) => ipcLogger.error('plugin-directory-open-failed', { error, data: { pluginId } }));
    return { ok: true, path: directoryPath };
  });
  ipcMain.handle('skills:attached-list', async () => requireRuntime().attachedSkillCatalog());
  ipcMain.handle('skills:attached-inbox-path', async () => {
    requireRuntime().auth.requireUser();
    return { path: requireRuntime().attachedSkillInboxPath?.() || '' };
  });
  ipcMain.handle('skills:attached-inbox-scan', async () => {
    const rt = requireRuntime();
    rt.auth.requireUser();
    return rt.scanAttachedSkillInbox?.() || { ok: false, skipped: true };
  });
  ipcMain.handle('skills:attached-pick-source', async () => {
    requireRuntime().auth.requireUser();
    const options = {
      title: '选择 Skill 包目录', properties: ['openDirectory'],
    };
    const parent = getMainWindow?.();
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return { canceled: result.canceled, source: result.filePaths?.[0] || '' };
  });
  ipcMain.handle('skills:attached-import', async (_event, payload = {}) => requireRuntime().importAttachedSkillPackage(payload));
  ipcMain.handle('skills:attached-assign', async (_event, payload = {}) => requireRuntime().assignAttachedSkill(payload));
  ipcMain.handle('skills:attached-assign-batch', async (_event, payload = {}) => requireRuntime().assignAttachedSkillsBatch(payload));
  ipcMain.handle('skills:attached-unassign', async (_event, payload = {}) => requireRuntime().removeAttachedSkillAssignment(payload));
  ipcMain.handle('skills:attached-effective', async (_event, payload = {}) => requireRuntime().effectiveAttachedSkills(payload));
  ipcMain.handle('skills:attached-disable', async (_event, payload = {}) => requireRuntime().disableAttachedSkillPackage(payload));
  ipcMain.handle('plugins:pptx-status', async () => pluginStatus(requireRuntime().root, 'ppt_creation', { appVersion: app.getVersion() }).status);
  ipcMain.handle('plugins:uninstall-pptx', async () => {
    const rt = requireRuntime();
    rt.auth.requireUser();
    const result = await uninstallPlugin(rt.root, 'ppt_creation', { appVersion: app.getVersion() });
    rt.refreshAgentIdentityCatalog?.();
    return result.status;
  });
  ipcMain.handle('plugins:download-pptx', async (event) => {
    const rt = requireRuntime();
    rt.auth.requireUser();
    const result = await installPlugin(rt.root, 'ppt_creation', {
      appVersion: app.getVersion(),
      onProgress: (progress) => event.sender.send('plugins:pptx-progress', progress),
    });
    rt.refreshAgentIdentityCatalog?.();
    return result.status;
  });
  ipcMain.handle('plugins:open-pptx-skill', async () => {
    const rt = requireRuntime();
    rt.auth.requireUser();
    const directoryPath = pluginInstallPath(rt.root, 'ppt_creation');
    Promise.resolve(shell.openPath(directoryPath)).catch((error) => ipcLogger.error('plugin-directory-open-failed', { error, data: { pluginId: 'ppt_creation' } }));
    return { ok: true, path: directoryPath };
  });
  ipcMain.handle('updates:status', async () => getUpdateService()?.status() || {});
  ipcMain.handle('updates:check', async () => {
    if (!requireRuntime().currentUser()) throw new Error('请先登录。');
    return getUpdateService()?.checkNow() || {};
  });
  ipcMain.handle('updates:install', async () => {
    if (!requireRuntime().currentUser()) throw new Error('请先登录。');
    return getUpdateService()?.installNow() || {};
  });
  ipcMain.handle('updates:download', async () => {
    if (!requireRuntime().currentUser()) throw new Error('请先登录。');
    return getUpdateService()?.downloadNow() || {};
  });
  ipcMain.handle('agent-updates:status', async () => getAgentBundleService()?.status() || {});
  ipcMain.handle('agent-updates:check', async () => {
    if (!requireRuntime().currentUser()) throw new Error('请先登录。');
    return getAgentBundleService()?.checkNow() || {};
  });
  ipcMain.handle('agent-updates:download', async () => {
    if (!requireRuntime().currentUser()) throw new Error('请先登录。');
    return getAgentBundleService()?.downloadNow() || {};
  });
  ipcMain.handle('agent-updates:apply', async () => {
    if (!requireRuntime().currentUser()) throw new Error('请先登录。');
    return getAgentBundleService()?.applyNow() || {};
  });
  ipcMain.handle('agent-updates:rollback', async () => {
    if (!requireRuntime().currentUser()) throw new Error('请先登录。');
    return getAgentBundleService()?.rollbackNow() || {};
  });
  ipcMain.handle('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle('desktop-close-prompt:respond', (_event, payload = {}) => onClosePromptResponse?.(payload) || false);
  ipcMain.handle('desktop-lifecycle:status', async () => getDesktopTrayController?.()?.status?.() || {});
  ipcMain.handle('desktop-lifecycle:set-close-behavior', async (_event, payload = {}) => {
    requireRuntime();
    const controller = getDesktopTrayController?.();
    if (!controller) throw new Error('Desktop lifecycle is not ready.');
    const status = controller.setCloseBehavior(payload.closeBehavior);
    for (const window of BrowserWindow.getAllWindows()) {
      try { window.webContents?.send?.('desktop-lifecycle:changed', status); } catch {}
    }
    return status;
  });
  ipcMain.handle('app-menu:command', async (event, command = '') => {
    const window = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
    const webContents = window?.webContents;
    switch (String(command || '')) {
      case 'new-window':
        createAppWindow({ secondary: true });
        return true;
      case 'exit':
        requestAppQuit('desktop-menu');
        return true;
      case 'reload-browser-page':
        webContents?.reload();
        return true;
      case 'back':
        if (webContents?.canGoBack()) webContents.goBack();
        return true;
      case 'forward':
        if (webContents?.canGoForward()) webContents.goForward();
        return true;
      case 'zoom-in':
        webContents?.setZoomLevel(Math.min(4, webContents.getZoomLevel() + 0.5));
        return true;
      case 'zoom-out':
        webContents?.setZoomLevel(Math.max(-3, webContents.getZoomLevel() - 0.5));
        return true;
      case 'actual-size':
        webContents?.setZoomLevel(0);
        return true;
      case 'toggle-full-screen': {
        if (!window) return false;
        const isFullScreen = Boolean(window.__janusFullScreen || window.isFullScreen());
        window.__janusFullScreen = !isFullScreen;
        if (isFullScreen) {
          window.setFullScreen(false);
          if (window.__janusMaximizedFallback && window.isMaximized()) window.unmaximize();
          window.__janusMaximizedFallback = false;
          return { fullScreen: false };
        }
        window.setFullScreen(true);
        setTimeout(() => {
          if (window.isDestroyed() || window.isFullScreen()) return;
          window.__janusMaximizedFallback = true;
          window.maximize();
        }, 250);
        return { fullScreen: true };
      }
      case 'documentation':
        await shell.openExternal('https://github.com/iLearn-Agent/Janus#readme');
        return true;
      case 'system-status':
        await shell.openExternal('https://status.openai.com/');
        return true;
      case 'send-feedback':
        await shell.openExternal('https://github.com/iLearn-Agent/Janus/issues/new');
        return true;
      case 'start-performance-trace':
        webContents?.openDevTools({ mode: 'detach' });
        return true;
      default:
        return false;
    }
  });
}

async function employeeMutation(callback) {
  try {
    return { ok: true, result: await callback() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error?.code || 'employee_command_failed',
        message: error?.message || String(error),
        details: error?.details || {},
      },
    };
  }
}

function cloudAuthorityRequired() {
  const error = new Error('Evolution mutation is available only through the cloud authority.');
  error.code = 'cloud_authority_required';
  return error;
}

function normalizeFileDialogExtensions(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().replace(/^\./, '').toLowerCase())
    .filter((value) => /^[a-z0-9]{1,12}$/.test(value)))];
}
