import { normalizeTaskSourceContext } from '../../../../shared/contracts/taskCard.js';
import { createPickerMentionEntity } from '../../../../shared/contracts/mentions.js';

export function createNetworkWorkspaceController({
  api,
  state,
  render,
  renderConversationTransition = render,
  notify,
  userErrorMessage,
  preserveChatDraftFromInput,
  restoreComposerDraft = () => {},
  focusChatInputAtEnd,
  refreshSocialInbox,
  refreshAgentDelegations,
  refreshSocialThreads,
  refreshCollaborationOverview,
  socialTaskGroups,
  socialTaskGroupById,
  latestSocialTaskGroup,
  socialTaskGroupType,
  scrollMessagesToBottom,
  readyAttachmentsForSend,
  currentModelValue,
  currentReasoningValue,
  persistComposerDrafts,
  focusActiveComposerInput,
  materializeCollaborationFile,
  isCurrentUserAdmin,
  windowRef,
  documentRef,
  setTimer = setTimeout,
  noteDirectoryGroups,
  currentChatRun,
  syncCurrentChatRun,
  restoreActiveRunTransient,
  restorePersistentDeliveryRuns,
  openTaskRunWorkspace,
  openAgentSession,
  closeFollowerWorkspace = () => {},
}) {
  let delegationOpenSequence = 0;
  let uBuddyOpenSequence = 0;
  let conversationOpenSequence = 0;
  let networkPanelOpenSequence = 0;
  const SOCIAL_TASK_GROUP_TYPE = socialTaskGroupType;
  const currentMessageSurfaceKey = () => JSON.stringify([
    Number(state.workspaceSwitchGeneration || 0),
    state.currentTab || '',
    Boolean(state.networkPanelOpen),
    state.networkPanelView || '',
    Boolean(state.networkMessageHomeOpen),
    state.messageActivePane || '',
    state.networkConversationPeerId || '',
    state.networkConversationMode || '',
    state.networkConversationGroupId || '',
    state.networkDelegationId || '',
    state.collaborationGroupId || '',
    state.chatGroupId || '',
    state.currentSessionId || '',
    state.currentChatKey || '',
    state.homeMode || '',
    state.activeTaskWorkspaceKind || '',
    state.activeTaskWorkspaceId || '',
  ]);
  const loadMessagePage = async (sessionId = '', limit = 200) => {
    const cleanSessionId = String(sessionId || '').trim();
    if (!cleanSessionId) return { items: [], nextCursor: null, hasMore: false };
    if (typeof api.listMessagePage === 'function') return api.listMessagePage({ sessionId: cleanSessionId, limit });
    const items = await api.listMessages(cleanSessionId);
    return { items, nextCursor: null, hasMore: false };
  };
  const applyMessagePage = (sessionId = '', page = null) => {
    if (!page || state.currentSessionId !== sessionId) return false;
    state.messages = Array.isArray(page.items) ? page.items : [];
    state.messagePagination = {
      sessionId,
      source: 'session',
      nextCursor: page.nextCursor || null,
      hasMore: Boolean(page.hasMore),
      loading: false,
      initialLoading: false,
    };
    state.preloadedMessagePagesBySessionId = {
      ...(state.preloadedMessagePagesBySessionId || {}),
      [sessionId]: {
        items: state.messages,
        source: 'session',
        nextCursor: state.messagePagination.nextCursor,
        hasMore: state.messagePagination.hasMore,
      },
    };
    syncCurrentChatRun?.();
    restoreActiveRunTransient?.();
    return true;
  };
  const delegationWorkspaceMessages = (items = [], delegationId = '') => (Array.isArray(items) ? items : []).filter((message) => {
    const metadata = message?.metadata || {};
    const messageDelegationId = String(message?.delegationId || message?.delegation_id || metadata.delegationId || metadata.delegation_id || metadata.agentDelegationId || '');
    return messageDelegationId === String(delegationId || '') && metadata.privateTaskWorkspace === true;
  });
  const taskNavigationStorageKey = () => {
    const userId = String(state.currentUser?.id || '').trim();
    const workspaceId = String(state.activeAccountWorkspace?.id || 'workspace_personal').trim();
    return userId ? `janus-task-workspace-navigation-v2:${userId}:${workspaceId}` : '';
  };
  const legacyTaskNavigationStorageKey = () => {
    const userId = String(state.currentUser?.id || '').trim();
    const workspaceId = String(state.activeAccountWorkspace?.id || 'workspace_personal').trim();
    return userId ? `janus-task-workspace-navigation-v1:${userId}:${workspaceId}` : '';
  };
  function persistTaskWorkspaceNavigation(delegationId = '', sourceContext = {}) {
    const key = taskNavigationStorageKey();
    if (!key || !delegationId) return;
    try {
      windowRef?.sessionStorage?.setItem(key, JSON.stringify({
        workspaceId: delegationId,
        workspaceKind: state.activeTaskWorkspaceKind || 'delegation',
        sourceContext: normalizeTaskSourceContext(sourceContext),
        returnAnchorId: String(sourceContext.returnAnchorId || state.activeTaskReturnAnchorId || '').trim(),
        returnSurface: String(sourceContext.returnSurface || state.activeTaskReturnSurface || '').trim(),
        view: state.taskWorkspaceViewById?.[delegationId] || 'activity',
        sourceScrollTop: Number(state.taskWorkspaceReturnContext?.sourceScrollTop || 0),
      }));
    } catch {
      // Navigation restoration is best-effort in restricted renderer contexts.
    }
  }
  function clearTaskWorkspaceNavigation() {
    const key = taskNavigationStorageKey();
    if (!key) return;
    try { windowRef?.sessionStorage?.removeItem(key); } catch {}
    try { windowRef?.sessionStorage?.removeItem(legacyTaskNavigationStorageKey()); } catch {}
  }
  function clearActiveTaskWorkspace({ clearPersistedNavigation = true } = {}) {
    if (state.networkDelegationId || state.activeTaskWorkspaceKind || state.activeTaskWorkspaceId) {
      delegationOpenSequence += 1;
    }
    state.networkDelegationId = '';
    state.networkConversationBusy = false;
    state.networkDelegationEditingMessageId = '';
    state.networkDelegationMemory = null;
    state.networkDelegationMemoryMenuOpen = false;
    state.taskWorkspaceReturnContext = null;
    state.activeTaskSourceContext = null;
    state.activeTaskReturnAnchorId = '';
    state.activeTaskReturnSurface = '';
    state.activeTaskReturnScrollTop = null;
    state.activeTaskWorkspaceKind = '';
    state.activeTaskWorkspaceId = '';
    if (clearPersistedNavigation) clearTaskWorkspaceNavigation();
  }
  function scrollToTaskSourceAnchor(anchorId = '', sourceScrollTop = null) {
    const cleanId = String(anchorId || '').trim();
    setTimer(() => {
      const list = documentRef?.querySelector?.('#message-list');
      if (list && Number.isFinite(sourceScrollTop)) {
        list.scrollTop = Math.min(Math.max(0, Number(sourceScrollTop)), Math.max(0, list.scrollHeight - list.clientHeight));
        return;
      }
      const elements = documentRef?.querySelectorAll?.('[data-message-id]') || [];
      const target = cleanId ? [...elements].find((element) => element.dataset?.messageId === cleanId) : null;
      if (target) target.scrollIntoView?.({ block: 'center' });
      else scrollMessagesToBottom?.({ force: true });
    }, 0);
  }
  function beginTaskWorkspaceNavigation(sourceContext = {}, { workspaceKind = 'delegation', workspaceId = '', restoring = false } = {}) {
    const preservedDraft = preserveChatDraftFromInput?.();
    if (typeof preservedDraft === 'string') state.chatDraft = preservedDraft;
    const normalizedSourceContext = normalizeTaskSourceContext({
      ...(sourceContext || {}),
      task_workspace_id: workspaceId || sourceContext?.task_workspace_id || sourceContext?.taskWorkspaceId || '',
    });
    const returnAnchorId = String(sourceContext?.returnAnchorId || state.activeTaskReturnAnchorId || '').trim();
    const returnSurface = String(sourceContext?.returnSurface || state.activeTaskReturnSurface || '').trim();
    if (!state.taskWorkspaceReturnContext && !restoring) {
      state.taskWorkspaceReturnContext = {
        currentTab: state.currentTab,
        currentSessionId: state.currentSessionId,
        currentChatKey: state.currentChatKey,
        currentAgentInstanceId: state.currentAgentInstanceId || '',
        homeMode: state.homeMode,
        networkPanelOpen: state.networkPanelOpen,
        networkPanelView: state.networkPanelView,
        networkMessageHomeOpen: state.networkMessageHomeOpen,
        networkConversationPeerId: state.networkConversationPeerId,
        networkConversationGroupId: state.networkConversationGroupId,
        networkConversationMode: state.networkConversationMode,
        networkConversationMessages: state.networkConversationMessages,
        collaborationGroupId: state.collaborationGroupId,
        collaborationGroupDetail: state.collaborationGroupDetail,
        messages: [...(state.messages || [])],
        messagePagination: { ...(state.messagePagination || {}) },
        contextUsage: state.contextUsage || null,
        taskDetail: state.taskDetail || null,
        chatDraft: state.chatDraft || '',
        attachments: [...(state.attachments || [])],
        composerMentions: [...(state.composerMentions || [])],
        secretaryMentions: [...(state.secretaryMentions || [])],
        socialMentionMenuOpen: Boolean(state.socialMentionMenuOpen),
        sourceContext: normalizedSourceContext,
        returnAnchorId,
        returnSurface,
        sourceScrollTop: Number(documentRef?.querySelector?.('#message-list')?.scrollTop || 0),
      };
    }
    state.activeTaskSourceContext = normalizedSourceContext;
    state.activeTaskReturnAnchorId = returnAnchorId;
    state.activeTaskReturnSurface = returnSurface;
    state.activeTaskReturnScrollTop = sourceContext?.sourceScrollTop != null && Number.isFinite(Number(sourceContext.sourceScrollTop))
      ? Number(sourceContext.sourceScrollTop)
      : Number(state.taskWorkspaceReturnContext?.sourceScrollTop || documentRef?.querySelector?.('#message-list')?.scrollTop || 0);
    state.activeTaskWorkspaceKind = String(workspaceKind || 'delegation').trim();
    state.activeTaskWorkspaceId = String(workspaceId || normalizedSourceContext.task_workspace_id || '').trim();
    if (state.activeTaskWorkspaceId) persistTaskWorkspaceNavigation(state.activeTaskWorkspaceId, {
      ...normalizedSourceContext, returnAnchorId, returnSurface,
    });
    return { normalizedSourceContext, returnAnchorId, returnSurface };
  }
  async function openNetworkPanel(view = 'messages') {
    const requestId = ++networkPanelOpenSequence;
    const nextView = ['friends', 'tasks'].includes(view) ? view : 'messages';
    const returnContext = state.primaryChatReturnContext;
    const resumeSelectedChat = nextView === 'messages'
      && state.currentTab !== 'chat'
      && returnContext?.kind === 'chat'
      && Boolean(state.currentSessionId || currentChatRun?.());
    state.primaryChatReturnContext = null;
    if (resumeSelectedChat) {
      const resumedSession = (state.sessions || []).find((session) => session.id === state.currentSessionId) || null;
      if (resumedSession?.departmentId === 'private_assistant') state.privateAssistantResultUnread = false;
      state.currentTab = 'chat';
      state.networkPanelOpen = Boolean(returnContext.networkPanelOpen);
      state.networkPanelView = returnContext.networkPanelView || 'messages';
      state.networkMessageHomeOpen = false;
      state.messageActivePane = 'conversation';
      state.networkPanelLoading = false;
      state.networkPanelError = '';
      state.modelMenuOpen = false;
      state.imageModelMenuOpen = false;
      state.pptTemplateMenuOpen = false;
      state.pptStyleMenuOpen = false;
      state.agentMenuOpen = false;
      state.sandboxMenuOpen = false;
      syncCurrentChatRun?.();
      restoreActiveRunTransient?.();
      render();
      focusChatInputAtEnd();
      scrollMessagesToBottom({ force: true });
      return;
    }
    state.currentTab = nextView === 'tasks' ? 'collaboration' : 'chat';
    state.networkPanelView = nextView;
    state.networkPanelOpen = true;
    if (nextView === 'messages' || nextView === 'friends') {
      state.networkConversationPeerId = '';
      state.networkConversationWorkspaceId = '';
      state.networkConversationGroupId = '';
      state.networkConversationMessages = [];
      state.networkConversationBusy = false;
      state.networkDelegationId = '';
      state.collaborationGroupId = '';
      state.collaborationGroupDetail = null;
      state.collaborationGroupWorkspace = null;
      state.chatGroupId = '';
      state.chatGroupDetail = null;
      state.chatAvatarProfile = null;
    }
    if (nextView === 'messages') {
      state.networkMessageHomeOpen = true;
      state.messageActivePane = 'list';
    }
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.networkPanelLoading = true;
    state.networkPanelError = '';
    const workspaceGeneration = state.workspaceSwitchGeneration;
    const workspaceId = state.activeAccountWorkspace?.id || 'workspace_personal';
    const requestStillCurrent = () => requestId === networkPanelOpenSequence
      && workspaceGeneration === state.workspaceSwitchGeneration
      && workspaceId === (state.activeAccountWorkspace?.id || 'workspace_personal')
      && state.networkPanelOpen
      && state.networkPanelView === nextView
      && state.currentTab === (nextView === 'tasks' ? 'collaboration' : 'chat');
    try {
      const friendsPromise = nextView === 'friends' && api.friendsOverview
        ? api.friendsOverview().then((freshFriends) => {
          if (freshFriends && requestStillCurrent()) {
            state.friendOverview = freshFriends;
            render();
          }
          return freshFriends;
        }).catch(() => null)
        : Promise.resolve(null);
      const social = await api.pollSocialNetwork({ autoProcess: false });
      const responseWorkspaceId = social?.workspaceId || social?.accountWorkspaceId || '';
      if (!requestStillCurrent() || (responseWorkspaceId && responseWorkspaceId !== workspaceId)) return;
      state.socialStatus = social?.status || state.socialStatus;
      state.friendOverview = social?.friends || state.friendOverview;
      state.socialInbox = social?.inbox || state.socialInbox;
      state.agentDelegations = social?.delegations || state.agentDelegations;
      const nextCollaboration = social?.collaboration || state.collaborationOverview;
      noteDirectoryGroups?.(nextCollaboration);
      state.collaborationOverview = nextCollaboration;
      state.chatGroupsOverview = social?.chatGroups || state.chatGroupsOverview;
      void friendsPromise;
    } catch (error) {
      state.networkPanelError = userErrorMessage(error);
      // The cached local state remains usable while the relay is temporarily unavailable.
    }
    if (!requestStillCurrent()) return;
    if (state.networkPanelView === 'messages') {
      await refreshSocialThreads(false);
    } else if (state.networkPanelView === 'tasks') {
      state.tasks = await api.listTasks().catch(() => state.tasks || []);
      const preferred = (state.tasks || []).find((task) => task.id === state.taskDetail?.id)
        || (state.tasks || []).find((task) => String(task.metadata?.source || '').length)
        || state.tasks?.[0]
        || null;
      state.taskDetail = preferred?.id ? await api.getTask(preferred.id).catch(() => preferred) : null;
    }
    if (!requestStillCurrent()) return;
    state.networkPanelLoading = false;
    render();
  }

  async function openUBuddyConversation({ draft = '' } = {}) {
    if (state.uBuddyConversationOpening) return null;
    const requestId = ++uBuddyOpenSequence;
    const currentDraft = preserveChatDraftFromInput();
    const currentSession = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
    const uBuddyConversationVisible = state.currentTab === 'chat'
      && state.networkPanelOpen
      && state.networkPanelView === 'messages'
      && !state.networkMessageHomeOpen;
    const openingFromUBuddy = uBuddyConversationVisible
      && (state.homeMode === 'secretary' || currentSession?.departmentId === 'secretary_department')
      && !currentSession?.readOnly
      && currentSession?.writeState !== 'read_only';
    if (openingFromUBuddy) {
      clearActiveTaskWorkspace();
      state.uBuddyConversationOpening = false;
      syncUBuddyOpeningIndicator(false);
      syncCurrentChatRun?.();
      restoreActiveRunTransient?.();
      applyUBuddyProjectContext(currentSession);
      render();
      focusChatInputAtEnd();
      scrollMessagesToBottom({ force: true });
      return currentSession?.id || state.secretarySessionId || null;
    }
    const optimisticStateKeys = [
      'currentTab', 'networkPanelOpen', 'networkPanelView', 'networkMessageHomeOpen', 'messageActivePane',
      'networkConversationPeerId', 'networkConversationGroupId', 'networkConversationMessages', 'networkConversationDrafts',
      'collaborationGroupId', 'collaborationGroupDetail', 'chatGroupId', 'chatGroupDetail', 'socialMentionMenuOpen',
      'homeMode', 'currentDepartmentId', 'currentAgentId', 'selectionSource', 'modelMenuOpen', 'imageModelMenuOpen',
      'pptTemplateMenuOpen', 'pptStyleMenuOpen', 'agentMenuOpen', 'chatDraft', 'attachments', 'composerMentions',
      'secretaryMentions', 'composerTaskReference', 'taskReferenceMenuOpen', 'currentSessionId', 'currentChatKey',
      'currentAgentInstanceId', 'composerFileReferences', 'composerMemoryReferences', 'messageQuote',
      'messages', 'messagePagination', 'contextUsage', 'uBuddyConversationOpening', 'networkDelegationId',
      'networkConversationBusy', 'networkDelegationEditingMessageId', 'networkDelegationMemory',
      'networkDelegationMemoryMenuOpen', 'taskWorkspaceReturnContext', 'activeTaskSourceContext',
      'activeTaskReturnAnchorId', 'activeTaskReturnSurface', 'activeTaskReturnScrollTop',
      'activeTaskWorkspaceKind', 'activeTaskWorkspaceId',
    ];
    const optimisticStateSnapshot = optimisticStateKeys.map((key) => ({
      key,
      present: Object.prototype.hasOwnProperty.call(state, key),
      value: key === 'networkConversationDrafts' ? { ...(state[key] || {}) } : state[key],
    }));
    const restoreOptimisticState = () => {
      for (const item of optimisticStateSnapshot) {
        if (item.present) state[item.key] = item.value;
        else delete state[item.key];
      }
    };
    const previousConversationKey = state.networkConversationPeerId && state.networkConversationPeerId !== 'self-secretary'
      ? networkConversationDraftKey(state.networkConversationPeerId, state.networkConversationMode, state.networkConversationGroupId)
      : '';
    if (previousConversationKey) {
      state.networkConversationDrafts = {
        ...(state.networkConversationDrafts || {}),
        [previousConversationKey]: currentDraft,
      };
    }
    // A task workspace and the private uBuddy conversation are mutually exclusive
    // renderer surfaces. Clear the old selection before restoring any live run UI.
    // Persisted navigation is removed only after the async open succeeds so a
    // failed transition can still restore the original workspace.
    clearActiveTaskWorkspace({ clearPersistedNavigation: false });
    state.currentTab = 'chat';
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    state.networkMessageHomeOpen = false;
    state.messageActivePane = 'conversation';
    state.networkConversationPeerId = '';
    state.networkConversationWorkspaceId = '';
    state.networkConversationGroupId = '';
    state.networkConversationMessages = [];
    state.networkConversationBusy = false;
    state.collaborationGroupId = '';
    state.collaborationGroupDetail = null;
    state.chatGroupId = '';
    state.chatGroupDetail = null;
    state.socialMentionMenuOpen = false;
    state.homeMode = 'secretary';
    state.currentDepartmentId = '';
    state.currentAgentId = '';
    state.currentAgentInstanceId = '';
    state.selectionSource = null;
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.chatDraft = String(draft || '');
    state.attachments = [];
    state.composerMentions = [];
    state.secretaryMentions = [];
    state.composerFileReferences = [];
    state.composerMemoryReferences = [];
    state.messageQuote = null;
    state.composerTaskReference = null;
    restoreComposerDraft('ubuddy', { fallbackText: String(draft || '') });
    state.taskReferenceMenuOpen = false;
    const preloadedSessionId = String(state.secretarySessionId || '').trim();
    const preloadedPage = preloadedSessionId
      ? state.preloadedMessagePagesBySessionId?.[preloadedSessionId] || null
      : null;
    const hasPreloadedPage = Boolean(preloadedSessionId && preloadedPage);
    state.currentSessionId = '';
    state.currentChatKey = `ubuddy:opening:${requestId}`;
    state.messages = Array.isArray(preloadedPage?.items) ? preloadedPage.items : [];
    state.messagePagination = hasPreloadedPage ? {
      sessionId: preloadedSessionId,
      source: preloadedPage?.source || 'session',
      nextCursor: preloadedPage?.nextCursor || null,
      hasMore: Boolean(preloadedPage?.hasMore),
      loading: !preloadedPage,
      initialLoading: !preloadedPage,
    } : { sessionId: '', source: '', nextCursor: null, hasMore: false, loading: true, initialLoading: true };
    state.contextUsage = null;
    state.uBuddyConversationOpening = true;
    render();
    focusChatInputAtEnd();
    const navigationSnapshot = JSON.stringify([
      state.workspaceSwitchGeneration,
      state.currentTab,
      state.currentSessionId,
      state.currentChatKey,
      state.homeMode,
      state.networkPanelView,
      state.networkMessageHomeOpen,
      state.networkConversationPeerId,
      state.networkConversationGroupId,
      state.networkDelegationId,
      state.collaborationGroupId,
      state.chatGroupId,
      state.activeTaskWorkspaceKind,
      state.activeTaskWorkspaceId,
    ]);
    const navigationStillCurrent = () => navigationSnapshot === JSON.stringify([
      state.workspaceSwitchGeneration,
      state.currentTab,
      state.currentSessionId,
      state.currentChatKey,
      state.homeMode,
      state.networkPanelView,
      state.networkMessageHomeOpen,
      state.networkConversationPeerId,
      state.networkConversationGroupId,
      state.networkDelegationId,
      state.collaborationGroupId,
      state.chatGroupId,
      state.activeTaskWorkspaceKind,
      state.activeTaskWorkspaceId,
    ]);
    let session;
    try {
      session = await api.ensureSecretarySession({ sessionId: state.secretarySessionId || '' });
    } catch (error) {
      if (requestId === uBuddyOpenSequence) {
        if (navigationStillCurrent()) {
          restoreOptimisticState();
          render();
        } else {
          state.uBuddyConversationOpening = false;
          syncUBuddyOpeningIndicator(false);
        }
        notify(`打开 uBuddy 失败：${userErrorMessage(error)}`, 'error');
      }
      return null;
    }
    if (requestId !== uBuddyOpenSequence) return null;
    if (!navigationStillCurrent()) {
      state.uBuddyConversationOpening = false;
      syncUBuddyOpeningIndicator(false);
      return null;
    }

    let messageLoadError = null;
    const [messagePage, contextUsage, friendOverview, deliveryRuns] = await Promise.all([
      loadMessagePage(session.id).catch((error) => {
        messageLoadError = error;
        return { items: [], nextCursor: null, hasMore: false };
      }),
      api.chatContextStatus({ sessionId: session.id }).catch(() => null),
      api.friendsOverview
        ? api.friendsOverview().catch(() => state.friendOverview)
        : Promise.resolve(state.friendOverview),
      api.listAgentDeliveryRuns?.({ sessionId: session.id, statuses: ['queued', 'running'], limit: 100 }).catch(() => []) || Promise.resolve([]),
    ]);
    if (requestId !== uBuddyOpenSequence) return null;
    if (!navigationStillCurrent()) {
      state.uBuddyConversationOpening = false;
      syncUBuddyOpeningIndicator(false);
      return null;
    }
    const pendingDraft = preserveChatDraftFromInput();
    const pendingAttachments = [...(state.attachments || [])];
    const pendingComposerMentions = [...(state.composerMentions || [])];
    const pendingSecretaryMentions = [...(state.secretaryMentions || [])];
    const restoreComposerFocus = documentRef?.activeElement?.id === 'chat-input';

    state.currentTab = 'chat';
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    state.networkMessageHomeOpen = false;
    state.messageActivePane = 'conversation';
    state.networkConversationPeerId = '';
    state.networkConversationGroupId = '';
    state.networkConversationMessages = [];
    state.collaborationGroupId = '';
    state.collaborationGroupDetail = null;
    state.chatGroupId = '';
    state.chatGroupDetail = null;
    state.socialMentionMenuOpen = false;
    state.homeMode = 'secretary';
    state.currentDepartmentId = '';
    state.currentAgentId = '';
    state.currentAgentInstanceId = '';
    state.selectionSource = null;
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.chatDraft = typeof pendingDraft === 'string' ? pendingDraft : String(draft || '');
    state.attachments = pendingAttachments;
    state.composerMentions = pendingComposerMentions;
    state.secretaryMentions = pendingSecretaryMentions;
    state.taskReferenceMenuOpen = false;
    state.secretarySessionId = session.id;
    state.currentSessionId = session.id;
    state.currentChatKey = `session:${session.id}`;
    applyMessagePage(session.id, messagePage);
    state.contextUsage = contextUsage;
    applyUBuddyProjectContext(session);
    const index = state.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...session };
    else state.sessions = [session, ...state.sessions];
    state.friendOverview = friendOverview || state.friendOverview;
    state.uBuddyConversationOpening = false;
    clearTaskWorkspaceNavigation();
    syncCurrentChatRun?.();
    restorePersistentDeliveryRuns?.(Array.isArray(deliveryRuns) ? deliveryRuns : [], session.id);
    restoreActiveRunTransient?.();
    render();
    if (restoreComposerFocus) focusChatInputAtEnd();
    scrollMessagesToBottom({ force: true });
    if (messageLoadError) notify(`刷新 uBuddy 对话失败：${userErrorMessage(messageLoadError)}`, 'error');
    return session.id;
  }

  function syncUBuddyOpeningIndicator(opening = false) {
    const shortcut = documentRef?.querySelector?.('[data-network-peer="self-secretary"]');
    if (!shortcut) return;
    shortcut.classList?.toggle?.('is-opening', opening);
    shortcut.setAttribute?.('aria-busy', opening ? 'true' : 'false');
  }

  function applyUBuddyProjectContext(session = {}) {
    const activeProjectId = state.sidebarMode === 'project' ? String(state.activeProjectId || '').trim() : '';
    const sessionProjectId = String(session.projectId || session.project_id || '').trim();
    const uBuddyProjectId = activeProjectId || sessionProjectId;
    const uBuddyProject = (state.projects || []).find((project) => project.id === uBuddyProjectId) || null;
    if (uBuddyProject) {
      state.activeProjectId = uBuddyProject.id;
      state.workspaceRoot = uBuddyProject.workspaceRoot || uBuddyProject.workspace_root || '';
      state.sidebarMode = 'project';
    } else {
      state.activeProjectId = '';
      state.workspaceRoot = '';
      state.sidebarMode = 'root';
    }
    state.workspaceDetached = false;
  }

  async function openNetworkConversation(peerId = '', mode = 'person', groupId = '') {
    const cleanPeerId = String(peerId || '').trim();
    const requestedGroupId = String(groupId || '').trim();
    const requestedMode = mode === 'group' ? 'group' : 'person';
    if (!cleanPeerId) return;
    closeFollowerWorkspace();
    if (cleanPeerId === 'self-secretary') {
      await openUBuddyConversation();
      return;
    }
    const requestId = ++conversationOpenSequence;
    const sourceSurfaceKey = currentMessageSurfaceKey();
    const requestStillCurrent = () => requestId === conversationOpenSequence
      && state.currentTab === 'chat'
      && state.networkPanelOpen
      && state.networkPanelView === 'messages'
      && !state.networkMessageHomeOpen
      && String(state.networkConversationPeerId || '') === cleanPeerId
      && state.networkConversationMode === requestedMode;
    const previousPeerId = String(state.networkConversationPeerId || '').trim();
    const animateContactSwitch = Boolean(
      previousPeerId
      && previousPeerId !== 'self-secretary'
      && previousPeerId !== cleanPeerId
      && documentRef?.querySelector?.('.chat-view.with-messages .conversation-panel'),
    );
    preserveChatDraftFromInput();
    if (state.networkConversationPeerId && state.networkConversationPeerId !== 'self-secretary') {
      const previousKey = networkConversationDraftKey(state.networkConversationPeerId, state.networkConversationMode, state.networkConversationGroupId);
      state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [previousKey]: state.chatDraft };
    }
    const cachedThread = (state.socialThreads || []).find((thread) => String(thread?.friend?.id || '') === cleanPeerId) || null;
    let prefetchedMessages = Array.isArray(cachedThread?.messages) ? cachedThread.messages : null;
    let prefetchedDelegations = state.agentDelegations || [];
    if (animateContactSwitch && !prefetchedMessages) {
      try {
        [prefetchedMessages, prefetchedDelegations] = await Promise.all([
          api.socialConversation({ peerId: cleanPeerId, limit: 500 }),
          api.listAgentDelegations({ direction: 'all' }),
        ]);
      } catch (error) {
        if (requestId === conversationOpenSequence) notify(`打开${requestedMode === 'group' ? '旧版群组' : '好友私聊'}失败：${error.message || error}`, 'error');
        return;
      }
      if (requestId !== conversationOpenSequence || currentMessageSurfaceKey() !== sourceSurfaceKey) return;
      preserveChatDraftFromInput();
      if (previousPeerId && previousPeerId !== 'self-secretary') {
        const previousKey = networkConversationDraftKey(previousPeerId, state.networkConversationMode, state.networkConversationGroupId);
        state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [previousKey]: state.chatDraft };
      }
    }
    state.currentTab = 'chat';
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    state.networkMessageHomeOpen = false;
    state.messageActivePane = 'conversation';
    state.networkDelegationId = '';
    state.collaborationGroupId = '';
    state.collaborationGroupDetail = null;
    state.chatGroupId = '';
    state.chatGroupDetail = null;
    state.networkConversationPeerId = cleanPeerId;
    const conversationWorkspaceId = String(prefetchedMessages?.[0]?.workspaceId || prefetchedMessages?.[0]?.accountWorkspaceId || '').trim();
    state.networkConversationWorkspaceId = conversationWorkspaceId;
    state.networkConversationGroupId = requestedGroupId;
    state.networkConversationMode = requestedMode;
    state.currentChatKey = requestedMode === 'group'
      ? `social-group:${cleanPeerId}:${requestedGroupId || 'latest'}`
      : `social-peer:${cleanPeerId}`;
    state.chatAvatarProfile = null;
    state.currentSessionId = '';
    state.contextUsage = null;
    state.messages = [];
    state.homeMode = 'department';
    state.currentDepartmentId = '';
    state.currentAgentId = '';
    state.currentAgentInstanceId = '';
    state.selectionSource = null;
    const targetDraftKey = requestedMode === 'group'
      ? `social-group:${cleanPeerId}:${requestedGroupId || 'legacy'}`
      : `social-direct:${cleanPeerId}`;
    restoreComposerDraft(targetDraftKey, {
      fallbackText: state.networkConversationDrafts?.[networkConversationDraftKey(cleanPeerId, state.networkConversationMode, state.networkConversationGroupId)] || '',
    });
    state.socialMentionMenuOpen = false;
    state.networkConversationMessages = prefetchedMessages || [];
    state.networkConversationBusy = !prefetchedMessages;
    if (animateContactSwitch) {
      state.networkConversationMessages = prefetchedMessages || [];
      state.agentDelegations = prefetchedDelegations || [];
      if (state.networkConversationMode === 'group' && !requestedGroupId) {
        const groups = socialTaskGroups(state.networkConversationMessages);
        state.networkConversationGroupId = [...groups].reverse().find((group) => !group.dissolved)?.id
          || groups.at(-1)?.id
          || '';
      }
      restoreComposerDraft(state.networkConversationMode === 'group'
        ? `social-group:${cleanPeerId}:${state.networkConversationGroupId || 'legacy'}`
        : `social-direct:${cleanPeerId}`, {
        fallbackText: state.networkConversationDrafts?.[networkConversationDraftKey(cleanPeerId, state.networkConversationMode, state.networkConversationGroupId)] || '',
      });
      const unread = state.networkConversationMessages.filter((item) => (
        (item.recipientUserId || item.recipient_user_id) === state.currentUser?.id && item.status !== 'read'
        && (state.networkConversationMode !== 'person' || (!item.metadata?.taskGroupId && !item.metadata?.groupId))
      ));
      state.networkConversationBusy = false;
      if (requestId !== conversationOpenSequence) return;
      await renderConversationTransition();
      if (!requestStillCurrent()) return;
      void Promise.all(unread.map((item) => api.markSocialMessageRead({ messageId: item.id }).catch(() => null)));
      void refreshSocialThreads(false);
      if (cachedThread) {
        void Promise.all([
          api.socialConversation({ peerId: cleanPeerId, limit: 500 }),
          api.listAgentDelegations({ direction: 'all' }),
        ]).then(([messages, delegations]) => {
          if (!requestStillCurrent()) return;
          state.networkConversationMessages = messages || state.networkConversationMessages;
          state.agentDelegations = delegations || state.agentDelegations;
          render();
          scrollMessagesToBottom({ force: true });
        }).catch(() => null);
      }
      scrollMessagesToBottom({ force: true });
      focusChatInputAtEnd();
      return;
    }
    try {
      render();
    } catch (error) {
      if (requestStillCurrent()) notify(`打开会话失败：${error.message || error}`, 'error');
      return;
    }
    let unread = [];
    try {
      const [messages, delegations] = await Promise.all([
        api.socialConversation({ peerId: cleanPeerId, limit: 500 }),
        api.listAgentDelegations({ direction: 'all' }),
      ]);
      if (!requestStillCurrent()) return;
      state.networkConversationMessages = messages || [];
      state.agentDelegations = delegations || [];
      if (state.networkConversationMode === 'group' && !requestedGroupId) {
        const groups = socialTaskGroups(state.networkConversationMessages);
        state.networkConversationGroupId = [...groups].reverse().find((group) => !group.dissolved)?.id
          || groups.at(-1)?.id
          || '';
      }
      restoreComposerDraft(state.networkConversationMode === 'group'
        ? `social-group:${cleanPeerId}:${state.networkConversationGroupId || 'legacy'}`
        : `social-direct:${cleanPeerId}`, {
        fallbackText: state.networkConversationDrafts?.[networkConversationDraftKey(cleanPeerId, state.networkConversationMode, state.networkConversationGroupId)] || '',
      });
      unread = state.networkConversationMessages.filter((item) => (
        (item.recipientUserId || item.recipient_user_id) === state.currentUser?.id && item.status !== 'read'
        && (state.networkConversationMode !== 'person' || (!item.metadata?.taskGroupId && !item.metadata?.groupId))
      ));
    } catch (error) {
      if (requestStillCurrent()) notify(`打开${requestedMode === 'group' ? '旧版群组' : '好友私聊'}失败：${error.message || error}`, 'error');
    } finally {
      if (!requestStillCurrent()) return;
      state.networkConversationBusy = false;
      try {
        render();
      } catch (error) {
        notify(`渲染${requestedMode === 'group' ? '群组' : '好友'}消息失败：${error.message || error}`, 'error');
        return;
      }
      await Promise.all(unread.map((item) => api.markSocialMessageRead({ messageId: item.id }).catch(() => null)));
      scrollMessagesToBottom({ force: true });
      focusChatInputAtEnd();
      void refreshSocialThreads(false);
    }
  }

  async function openUBuddyTaskForFriend(friendId = '') {
    const cleanId = String(friendId || '').trim();
    const relationship = (state.friendOverview?.friends || []).find((item) => item.friend?.id === cleanId);
    const friend = relationship?.friend;
    if (!friend) return;
    const name = relationship.remark || friend.remark || friend.displayName || friend.display_name || friend.username || friend.email || friend.id;
    await openNetworkConversation(cleanId, 'person');
    state.chatDraft = `@我的uBuddy 请向 ${name} 发布一个委托：`;
    state.networkConversationDrafts = {
      ...(state.networkConversationDrafts || {}),
      [networkConversationDraftKey(cleanId, 'person', '')]: state.chatDraft,
    };
    render();
    focusChatInputAtEnd();
  }

  async function openContactCollaborationInUBuddy(friendId = '') {
    const cleanId = String(friendId || '').trim();
    if (!cleanId) return false;
    const relationship = (state.friendOverview?.friends || []).find((item) => (
      String(item?.friend?.id || item?.user?.id || '') === cleanId
    ));
    let contact = relationship?.friend || relationship?.user || null;
    if (!contact) {
      for (const organization of state.friendOverview?.organizations || []) {
        const member = (organization?.members || []).find((item) => String(item?.user?.id || '') === cleanId);
        if (member?.user) {
          contact = member.user;
          break;
        }
      }
    }
    if (!contact) {
      notify('未找到该联系人，暂时无法交给 uBuddy 协作。', 'error');
      return false;
    }
    const name = String(
      relationship?.remark || contact.remark || contact.displayName || contact.display_name
      || contact.username || contact.email || contact.id,
    ).trim().replace(/^@+/, '');
    const mention = `@${name}`;
    state.networkContactProfileOpen = false;
    state.networkSelectedContactId = '';
    state.networkSelectedContactOrganizationId = '';
    render();
    const sessionId = await openUBuddyConversation();
    if (!sessionId) return false;
    const entity = createPickerMentionEntity({ principalType: 'user', userId: cleanId, displayText: mention });
    state.chatDraft = `${mention} `;
    state.secretaryMentions = entity ? [entity] : [];
    state.composerMentions = [...state.secretaryMentions];
    render();
    focusChatInputAtEnd();
    return true;
  }

  async function dissolveSocialTaskGroup() {
    const peerId = String(state.networkConversationPeerId || '').trim();
    const taskGroup = selectedSocialTaskGroup();
    const currentUserId = state.currentUser?.id || '';
    if (!peerId || !taskGroup?.id || taskGroup.dissolved || taskGroup.creatorUserId !== currentUserId) return;
    if (!windowRef.confirm('解散群聊后将表示任务结束，且该群聊不能继续发送消息。确定解散吗？')) return;
    state.networkConversationBusy = true;
    render();
    try {
      await api.sendSocialMessage({
        recipientId: peerId,
        content: '任务已结束，四方任务群聊已解散。',
        kind: 'system',
        metadata: {
          type: SOCIAL_TASK_GROUP_TYPE,
          action: 'dissolved',
          taskGroupId: taskGroup.id,
          groupId: taskGroup.id,
          initiatorUserId: taskGroup.creatorUserId,
        },
      });
      state.networkConversationMessages = await api.socialConversation({ peerId });
      state.chatDraft = '';
      state.attachments = [];
      delete state.networkConversationDrafts[networkConversationDraftKey(peerId, 'group', taskGroup.id)];
      await Promise.all([refreshSocialInbox(false), refreshSocialThreads(false)]);
      notify('群聊已解散，任务已结束。', 'success');
    } catch (error) {
      notify(`解散群聊失败：${error.message || error}`, 'error');
    } finally {
      state.networkConversationBusy = false;
      render();
      scrollMessagesToBottom({ force: true });
    }
  }

  async function renameSocialTaskGroup() {
    const peerId = String(state.networkConversationPeerId || '').trim();
    const taskGroup = selectedSocialTaskGroup();
    const currentUserId = state.currentUser?.id || '';
    if (!peerId || !taskGroup?.id || taskGroup.creatorUserId !== currentUserId) return;
    const nextTitle = String(windowRef.prompt('修改群聊名称', taskGroup.title || '四方任务群聊') ?? '').trim();
    if (!nextTitle || nextTitle === taskGroup.title) return;
    if (nextTitle.length > 80) {
      notify('群聊名称不能超过 80 个字符。', 'warning');
      return;
    }
    state.networkConversationBusy = true;
    render();
    try {
      await api.sendSocialMessage({
        recipientId: peerId,
        content: `群聊名称已修改为：${nextTitle}`,
        kind: 'system',
        metadata: {
          type: SOCIAL_TASK_GROUP_TYPE,
          action: 'renamed',
          taskGroupId: taskGroup.id,
          groupId: taskGroup.id,
          groupTitle: nextTitle,
          initiatorUserId: taskGroup.creatorUserId,
        },
      });
      state.networkConversationMessages = await api.socialConversation({ peerId });
      await refreshSocialThreads(false);
      notify('群聊名称已修改。', 'success');
    } catch (error) {
      notify(`修改群聊名称失败：${error.message || error}`, 'error');
    } finally {
      state.networkConversationBusy = false;
      render();
    }
  }

  function selectedSocialTaskGroup() {
    return socialTaskGroupById(state.networkConversationMessages || [], state.networkConversationGroupId)
      || latestSocialTaskGroup(state.networkConversationMessages || []);
  }

  function toggleSocialGroupSection(key = '') {
    if (!['active', 'ended', 'archived'].includes(key)) return;
    state.socialGroupSectionsOpen = {
      ...(state.socialGroupSectionsOpen || {}),
      [key]: state.socialGroupSectionsOpen?.[key] === false,
    };
    render();
  }

  async function openNetworkDelegation(delegationId = '', sourceContext = {}) {
    const cleanId = String(delegationId || '').trim();
    if (!cleanId) return;
    const openSequence = ++delegationOpenSequence;
    const cachedDelegation = [
      ...(state.collaborationGroupDetail?.tasks || []),
      ...(state.agentDelegations || []),
      ...(state.collaborationOverview?.tasks || []),
    ].find((item) => item?.id === cleanId) || null;
    const cachedSourceContext = normalizeTaskSourceContext({
      ...(cachedDelegation?.metadata || {}),
      ...(sourceContext || {}),
      task_workspace_id: cleanId,
    });
    const restoring = sourceContext?.restoring === true;
    const { normalizedSourceContext, returnAnchorId, returnSurface } = beginTaskWorkspaceNavigation({
      ...cachedSourceContext,
      ...sourceContext,
    }, { workspaceKind: 'delegation', workspaceId: cleanId, restoring });
    state.collaborationGroupId = '';
    state.collaborationGroupDetail = null;
    state.currentTab = 'chat';
    state.networkPanelOpen = true;
    state.networkPanelView = 'tasks';
    state.networkConversationPeerId = '';
    state.networkConversationGroupId = '';
    state.networkDelegationId = cleanId;
    state.networkDelegationEditingMessageId = '';
    state.networkDelegationMemory = null;
    state.networkDelegationMemoryMenuOpen = false;
    state.attachments = [];
    state.networkConversationBusy = true;
    persistTaskWorkspaceNavigation(cleanId, { ...normalizedSourceContext, returnAnchorId, returnSurface });
    // Render the cached workspace surface immediately; the async refresh below
    // replaces its data in place instead of showing an unrelated intermediate view.
    render();
    try {
      await refreshCollaborationOverview(false);
      if (openSequence !== delegationOpenSequence || state.networkDelegationId !== cleanId) return;
      state.agentDelegations = state.collaborationOverview?.tasks?.length
        ? state.collaborationOverview.tasks
        : await api.listAgentDelegations({ direction: 'all' });
      if (openSequence !== delegationOpenSequence || state.networkDelegationId !== cleanId) return;
      const delegation = state.agentDelegations.find((item) => item.id === cleanId);
      if (!delegation) throw new Error('任务不存在或暂未同步。');
      const [workspaceMessages, taskMemory] = await Promise.all([
        api.collaborationWorkspaceMessages({ delegationId: cleanId }),
        api.delegationTaskMemory({ delegationId: cleanId }),
      ]);
      if (openSequence !== delegationOpenSequence || state.networkDelegationId !== cleanId) return;
      state.networkConversationMessages = delegationWorkspaceMessages(workspaceMessages, cleanId);
      state.networkDelegationMemory = taskMemory || null;
      state.networkDelegationRunsById = {
        ...(state.networkDelegationRunsById || {}),
        [cleanId]: Array.isArray(taskMemory?.runs) ? taskMemory.runs : [],
      };
      if (taskMemory?.taskRunId) {
        const task = await api.getTask(taskMemory.taskRunId).catch(() => null);
        if (openSequence !== delegationOpenSequence || state.networkDelegationId !== cleanId) return;
        if (task) {
          state.networkDelegationTaskById = {
            ...(state.networkDelegationTaskById || {}),
            [cleanId]: task,
          };
        }
      }
    } catch (error) {
      if (openSequence === delegationOpenSequence && state.networkDelegationId === cleanId) {
        notify(`打开任务失败：${userErrorMessage(error)}`, 'error');
      }
    } finally {
      if (openSequence === delegationOpenSequence && state.networkDelegationId === cleanId) {
        state.networkConversationBusy = false;
        renderPreservingNetworkComposer();
        if (delegationWorkspaceShouldFollowBottom()) scrollDelegationWorkspaceToBottom();
      }
    }
  }

  async function returnToTaskSourceChat(sourceContext = {}) {
    delegationOpenSequence += 1;
    const snapshot = state.taskWorkspaceReturnContext;
    const context = normalizeTaskSourceContext({
      ...(state.activeTaskSourceContext || {}),
      ...(snapshot?.sourceContext || {}),
      ...(sourceContext || {}),
    });
    const returnAnchorId = String(sourceContext?.returnAnchorId || snapshot?.returnAnchorId || state.activeTaskReturnAnchorId || '').trim();
    const returnSurface = String(sourceContext?.returnSurface || snapshot?.returnSurface || state.activeTaskReturnSurface || '').trim();
    const returnScrollTop = sourceContext?.sourceScrollTop != null && Number.isFinite(Number(sourceContext.sourceScrollTop))
      ? Number(sourceContext.sourceScrollTop)
      : snapshot?.sourceScrollTop != null ? Number(snapshot.sourceScrollTop) : state.activeTaskReturnScrollTop;
    state.networkDelegationId = '';
    state.networkConversationBusy = false;
    state.networkDelegationEditingMessageId = '';
    state.networkDelegationMemory = null;
    state.networkDelegationMemoryMenuOpen = false;
    state.attachments = [];
    clearTaskWorkspaceNavigation();
    if (snapshot) {
      const sourceSessionId = String(snapshot.currentSessionId || '').trim();
      const refreshSourceSession = Boolean(sourceSessionId && !snapshot.networkPanelOpen);
      const sourceMessagesRefresh = refreshSourceSession
        ? Promise.resolve().then(() => loadMessagePage(sourceSessionId))
          .then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))
        : null;
      const sourceContextRefresh = refreshSourceSession
        ? Promise.resolve().then(() => api.chatContextStatus({ sessionId: sourceSessionId }))
          .then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))
        : null;
      state.currentTab = snapshot.currentTab || 'chat';
      state.currentSessionId = snapshot.currentSessionId || '';
      state.currentChatKey = snapshot.currentChatKey || (snapshot.currentSessionId ? `session:${snapshot.currentSessionId}` : '');
      state.currentAgentInstanceId = snapshot.currentAgentInstanceId || '';
      state.homeMode = snapshot.homeMode || state.homeMode;
      state.networkPanelOpen = Boolean(snapshot.networkPanelOpen);
      state.networkPanelView = snapshot.networkPanelView || 'messages';
      state.networkMessageHomeOpen = Boolean(snapshot.networkMessageHomeOpen);
      state.networkConversationPeerId = snapshot.networkConversationPeerId || '';
      state.networkConversationWorkspaceId = snapshot.networkConversationWorkspaceId || '';
      state.networkConversationGroupId = snapshot.networkConversationGroupId || '';
      state.networkConversationMode = snapshot.networkConversationMode || 'person';
      state.networkConversationMessages = snapshot.networkConversationMessages || [];
      state.collaborationGroupId = snapshot.collaborationGroupId || '';
      state.collaborationGroupDetail = snapshot.collaborationGroupDetail || null;
      state.messages = [...(snapshot.messages || state.messages || [])];
      state.messagePagination = { ...(snapshot.messagePagination || state.messagePagination || {}) };
      state.contextUsage = refreshSourceSession ? null : snapshot.contextUsage || null;
      state.taskDetail = snapshot.taskDetail || null;
      state.chatDraft = snapshot.chatDraft || '';
      state.attachments = [...(snapshot.attachments || [])];
      state.composerMentions = [...(snapshot.composerMentions || [])];
      state.secretaryMentions = [...(snapshot.secretaryMentions || [])];
      state.socialMentionMenuOpen = Boolean(snapshot.socialMentionMenuOpen);
      state.taskWorkspaceReturnContext = null;
      state.activeTaskSourceContext = null;
      state.activeTaskReturnAnchorId = '';
      state.activeTaskReturnSurface = '';
      state.activeTaskReturnScrollTop = null;
      state.activeTaskWorkspaceKind = '';
      state.activeTaskWorkspaceId = '';
      syncCurrentChatRun?.();
      restoreActiveRunTransient?.();
      render();
      focusActiveComposerInput?.();
      scrollToTaskSourceAnchor(returnAnchorId, returnScrollTop);
      if (sourceMessagesRefresh && sourceContextRefresh) {
        const restoredMessagesReference = state.messages;
        const restoredContextUsageReference = state.contextUsage;
        const workspaceGeneration = Number(state.workspaceSwitchGeneration || 0);
        const refreshStillCurrent = () => state.currentSessionId === sourceSessionId
          && !state.activeTaskWorkspaceKind
          && Number(state.workspaceSwitchGeneration || 0) === workspaceGeneration;
        const messagesApplied = sourceMessagesRefresh.then((messagesResult) => {
          if (!refreshStillCurrent()
            || messagesResult.status !== 'fulfilled'
            || state.messages !== restoredMessagesReference) return;
          state.messages = Array.isArray(messagesResult.value?.items) ? messagesResult.value.items : state.messages;
          state.messagePagination = {
            sessionId: sourceSessionId,
            source: 'session',
            nextCursor: messagesResult.value?.nextCursor || null,
            hasMore: Boolean(messagesResult.value?.hasMore),
            loading: false,
            initialLoading: false,
          };
          syncCurrentChatRun?.();
          restoreActiveRunTransient?.();
          render();
          scrollToTaskSourceAnchor(returnAnchorId, returnScrollTop);
        });
        const contextApplied = sourceContextRefresh.then((contextUsageResult) => {
          if (!refreshStillCurrent() || state.contextUsage !== restoredContextUsageReference) return;
          state.contextUsage = contextUsageResult.status === 'fulfilled'
            ? contextUsageResult.value || null
            : snapshot.contextUsage || null;
          render();
          scrollToTaskSourceAnchor(returnAnchorId, returnScrollTop);
        });
        await Promise.all([messagesApplied, contextApplied]);
      }
      return;
    }
    let targetSurfaceKey = '';
    if (returnSurface === 'group' && context.source_group_id) {
      state.currentTab = 'chat';
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      state.networkMessageHomeOpen = false;
      state.messageActivePane = 'conversation';
      state.networkConversationPeerId = '';
      state.networkConversationGroupId = '';
      state.networkDelegationId = '';
      state.collaborationGroupId = context.source_group_id;
      state.currentSessionId = '';
      state.currentChatKey = `collaboration:${context.source_group_id}`;
      targetSurfaceKey = currentMessageSurfaceKey();
      const groupDetail = await api.collaborationGroup({ groupId: context.source_group_id }).catch(() => null);
      if (currentMessageSurfaceKey() !== targetSurfaceKey) return;
      if (groupDetail) state.collaborationGroupDetail = groupDetail;
    } else if (context.source_conversation_id && !context.source_conversation_id.startsWith('direct:')) {
      state.currentTab = 'chat';
      state.networkPanelOpen = false;
      state.currentSessionId = context.source_conversation_id;
      state.currentChatKey = `session:${context.source_conversation_id}`;
      targetSurfaceKey = currentMessageSurfaceKey();
      const page = await loadMessagePage(context.source_conversation_id).catch(() => null);
      if (currentMessageSurfaceKey() !== targetSurfaceKey) return;
      if (page) applyMessagePage(context.source_conversation_id, page);
    } else if (context.source_conversation_id?.startsWith('direct:')) {
      const peerId = context.source_conversation_id.split(':').slice(2).join(':');
      state.currentTab = 'chat';
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      state.networkMessageHomeOpen = false;
      state.messageActivePane = 'conversation';
      state.networkConversationPeerId = peerId;
      state.networkConversationWorkspaceId = '';
      state.networkConversationGroupId = '';
      state.networkConversationMode = 'person';
      state.collaborationGroupId = '';
      state.currentSessionId = '';
      state.currentChatKey = `social-peer:${peerId}`;
      targetSurfaceKey = currentMessageSurfaceKey();
      const conversationMessages = peerId ? await api.socialConversation({ peerId }).catch(() => null) : null;
      if (currentMessageSurfaceKey() !== targetSurfaceKey) return;
      if (conversationMessages) state.networkConversationMessages = conversationMessages;
    } else if (context.source_group_id) {
      state.currentTab = 'chat';
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      state.networkMessageHomeOpen = false;
      state.messageActivePane = 'conversation';
      state.networkConversationPeerId = '';
      state.networkConversationGroupId = '';
      state.collaborationGroupId = context.source_group_id;
      state.currentSessionId = '';
      state.currentChatKey = `collaboration:${context.source_group_id}`;
      targetSurfaceKey = currentMessageSurfaceKey();
      const groupDetail = await api.collaborationGroup({ groupId: context.source_group_id }).catch(() => null);
      if (currentMessageSurfaceKey() !== targetSurfaceKey) return;
      if (groupDetail) state.collaborationGroupDetail = groupDetail;
    } else {
      state.currentTab = 'chat';
      state.networkPanelView = 'messages';
      targetSurfaceKey = currentMessageSurfaceKey();
    }
    if (targetSurfaceKey && currentMessageSurfaceKey() !== targetSurfaceKey) return;
    state.taskWorkspaceReturnContext = null;
    state.activeTaskSourceContext = null;
    state.activeTaskReturnAnchorId = '';
    state.activeTaskReturnSurface = '';
    state.activeTaskReturnScrollTop = null;
    state.activeTaskWorkspaceKind = '';
    state.activeTaskWorkspaceId = '';
    syncCurrentChatRun?.();
    restoreActiveRunTransient?.();
    render();
    focusActiveComposerInput?.();
    scrollToTaskSourceAnchor(returnAnchorId, returnScrollTop);
  }

  async function restoreTaskWorkspaceNavigation() {
    const key = taskNavigationStorageKey();
    if (!key) return false;
    let saved = null;
    try {
      saved = JSON.parse(windowRef?.sessionStorage?.getItem(key) || windowRef?.sessionStorage?.getItem(legacyTaskNavigationStorageKey()) || 'null');
    } catch {}
    const workspaceId = String(saved?.workspaceId || saved?.delegationId || '').trim();
    if (!workspaceId) return false;
    const workspaceKind = String(saved?.workspaceKind || 'delegation').trim();
    const view = ['activity', 'result', 'flow'].includes(saved.view) ? saved.view : 'activity';
    state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [workspaceId]: view };
    const navigation = {
      ...(saved.sourceContext || {}),
      returnAnchorId: saved.returnAnchorId || '',
      returnSurface: saved.returnSurface || '',
      sourceScrollTop: saved.sourceScrollTop == null ? null : Number(saved.sourceScrollTop),
      restoring: true,
    };
    if (workspaceKind === 'task_run') {
      beginTaskWorkspaceNavigation(navigation, { workspaceKind, workspaceId, restoring: true });
      await openTaskRunWorkspace?.(workspaceId);
    } else if (workspaceKind === 'agent_session') {
      beginTaskWorkspaceNavigation(navigation, { workspaceKind, workspaceId, restoring: true });
      await openAgentSession?.(workspaceId);
    } else await openNetworkDelegation(workspaceId, navigation);
    return true;
  }

  function setTaskWorkspaceView(delegationId = '', view = 'activity') {
    const cleanId = String(delegationId || state.networkDelegationId || '').trim();
    if (!cleanId || !['activity', 'result', 'flow'].includes(view)) return;
    state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [cleanId]: view };
    persistTaskWorkspaceNavigation(cleanId, {
      ...(state.activeTaskSourceContext || {}),
      returnAnchorId: state.activeTaskReturnAnchorId || '',
      returnSurface: state.activeTaskReturnSurface || '',
    });
    renderPreservingNetworkComposer();
  }

  function closeNetworkConversation() {
    preserveChatDraftFromInput();
    const closingDelegation = Boolean(state.networkDelegationId);
    if (closingDelegation) delegationOpenSequence += 1;
    if (closingDelegation) clearTaskWorkspaceNavigation();
    state.networkConversationPeerId = '';
    state.networkConversationGroupId = '';
    state.networkDelegationId = '';
    state.networkConversationMessages = [];
    state.networkConversationBusy = false;
    state.networkConversationMode = 'person';
    state.socialMentionMenuOpen = false;
    state.chatDraft = '';
    state.composerMentions = [];
    state.secretaryMentions = [];
    state.attachments = [];
    state.networkDelegationEditingMessageId = '';
    state.networkDelegationMemory = null;
    state.networkDelegationMemoryMenuOpen = false;
    state.activeTaskSourceContext = null;
    state.activeTaskReturnAnchorId = '';
    state.activeTaskReturnSurface = '';
    state.activeTaskWorkspaceKind = '';
    state.activeTaskWorkspaceId = '';
    state.taskWorkspaceReturnContext = null;
    if (closingDelegation) state.networkPanelView = 'messages';
    render();
  }

  async function sendNetworkConversationMessage(event) {
    event.preventDefault();
    const input = documentRef.getElementById('network-conversation-input');
    const content = String(input?.value || '').trim();
    const peerId = state.networkConversationPeerId;
    if (!content || !peerId || state.networkConversationBusy) return;
    const mode = peerId === 'self-secretary' ? 'ubuddy' : state.networkConversationMode;
    const draftKey = networkConversationDraftKey(peerId, mode, state.networkConversationGroupId);
    state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [draftKey]: content };
    state.networkConversationBusy = true;
    render();
    const surfaceKey = currentMessageSurfaceKey();
    const conversationStillCurrent = () => currentMessageSurfaceKey() === surfaceKey;
    try {
      if (peerId === 'self-secretary') {
        const result = await api.secretaryChat({
          sessionId: state.secretarySessionId || '',
          message: content,
          channelId: `secretary-${Date.now()}`,
          model: currentModelValue(),
          reasoningEffort: currentReasoningValue(),
          sandboxPermission: state.sandboxPermission,
        });
        state.secretarySessionId = result.session?.id || state.secretarySessionId;
        state.socialInbox = await api.socialInbox();
        if (conversationStillCurrent()) await loadSecretaryConversationMessages();
        state.sessions = await api.listSessions();
        state.agentDelegations = await api.listAgentDelegations({ direction: 'all' });
      } else {
        await api.sendSocialMessage({
          recipientId: peerId,
          workspaceId: state.networkConversationWorkspaceId || undefined,
          content,
          kind: 'friend',
          senderAgentId: '',
          recipientAgentId: '',
        });
        const messages = await api.socialConversation({ peerId });
        if (conversationStillCurrent()) state.networkConversationMessages = messages;
      }
      const nextDrafts = { ...(state.networkConversationDrafts || {}) };
      delete nextDrafts[draftKey];
      state.networkConversationDrafts = nextDrafts;
      persistComposerDrafts();
      state.socialInbox = await api.socialInbox();
    } catch (error) {
      notify(`发送失败：${error.message || error}`, 'error');
    } finally {
      if (!conversationStillCurrent()) return;
      const shouldFollowBottom = networkConversationShouldFollowBottom();
      state.networkConversationBusy = false;
      render();
      if (shouldFollowBottom) scrollNetworkConversationToBottom();
    }
  }

  function networkConversationDraftKey(peerId = '', mode = 'person', groupId = '') {
    const cleanMode = mode === 'ubuddy' ? 'ubuddy' : mode === 'group' ? 'group' : 'person';
    return cleanMode === 'group'
      ? `${String(peerId || '')}:${cleanMode}:${String(groupId || 'legacy')}`
      : `${String(peerId || '')}:${cleanMode}`;
  }

  function networkComposerHasFocus() {
    return ['chat-input', 'network-conversation-input', 'network-delegation-comment-input'].includes(documentRef.activeElement?.id || '');
  }

  function renderPreservingNetworkComposer() {
    const active = networkComposerHasFocus() ? documentRef.activeElement : null;
    const activeId = active?.id || '';
    const selectionStart = Number.isFinite(active?.selectionStart) ? active.selectionStart : null;
    const selectionEnd = Number.isFinite(active?.selectionEnd) ? active.selectionEnd : null;
    const scrollTop = Number(active?.scrollTop || 0);
    render();
    if (!activeId) return;
    const next = documentRef.getElementById(activeId);
    if (!next) return;
    next.focus({ preventScroll: true });
    if (selectionStart !== null && selectionEnd !== null) next.setSelectionRange(selectionStart, selectionEnd);
    next.scrollTop = scrollTop;
  }

  async function sendDelegationComment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const delegationId = String(form?.dataset.delegationId || state.networkDelegationId || '').trim();
    const input = documentRef.getElementById('network-delegation-comment-input');
    const content = String(input?.value || '').trim();
    const outgoingAttachmentItems = [...state.attachments];
    const editingMessageId = String(state.networkDelegationEditingMessageId || '').trim();
    if (!delegationId || (!content && !outgoingAttachmentItems.length)) return;
    const clientMessageId = globalThis.crypto?.randomUUID?.() || `workspace_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const originalInput = content || '补充了任务相关附件。';
    const currentPending = Array.isArray(state.networkDelegationPendingMessages?.[delegationId])
      ? state.networkDelegationPendingMessages[delegationId]
      : state.networkDelegationPendingMessages?.[delegationId] ? [state.networkDelegationPendingMessages[delegationId]] : [];
    state.networkDelegationPendingMessages = {
      ...(state.networkDelegationPendingMessages || {}),
      [delegationId]: [...currentPending, {
        id: `pending:${clientMessageId}`,
        role: 'user',
        content: originalInput,
        createdAt: new Date().toISOString(),
        metadata: {
          delegationId,
          privateTaskWorkspace: true,
          clientMessageId,
          optimistic: true,
          attachments: outgoingAttachmentItems,
        },
      }],
    };
    state.networkDelegationCommentDrafts = { ...(state.networkDelegationCommentDrafts || {}), [delegationId]: '' };
    state.networkDelegationEditingMessageId = '';
    state.attachments = [];
    persistComposerDrafts();
    render();
    scrollDelegationWorkspaceToBottom();
    try {
      const delegation = (state.agentDelegations || []).find((item) => item.id === delegationId);
      const attachments = await readyAttachmentsForSend(outgoingAttachmentItems);
      const uBuddyEnabled = state.networkDelegationUBuddyEnabled?.[delegationId] !== false;
      const existingMessage = editingMessageId
        ? (state.networkConversationMessages || []).find((message) => message.id === editingMessageId)
        : null;
      const retainedAttachments = attachments.length
        ? attachments
        : Array.isArray(existingMessage?.metadata?.attachments) ? existingMessage.metadata.attachments : [];
      const workspace = await api.collaborationWorkspaceMessage({
        delegationId,
        content: originalInput,
        attachments: retainedAttachments,
        clientMessageId,
        processWithUBuddy: uBuddyEnabled,
        model: currentModelValue(),
        reasoningEffort: currentReasoningValue(),
      });
      if (workspace?.delegation) {
        state.agentDelegations = (state.agentDelegations || []).map((item) => item.id === delegationId ? workspace.delegation : item);
      }
      if (workspace?.receipt) {
        state.networkDelegationRunsById = {
          ...(state.networkDelegationRunsById || {}),
          [delegationId]: [workspace.receipt, ...(state.networkDelegationRunsById?.[delegationId] || []).filter((item) => item.workId !== workspace.receipt.workId)],
        };
      }
      const pendingMessages = { ...(state.networkDelegationPendingMessages || {}) };
      pendingMessages[delegationId] = (Array.isArray(pendingMessages[delegationId]) ? pendingMessages[delegationId] : []).filter((message) => (
        message.metadata?.clientMessageId !== clientMessageId
      ));
      if (!pendingMessages[delegationId].length) delete pendingMessages[delegationId];
      state.networkDelegationPendingMessages = pendingMessages;
      state.networkConversationMessages = delegationWorkspaceMessages(workspace.messages, delegationId);
      state.networkDelegationMemory = await api.delegationTaskMemory({ delegationId }).catch(() => state.networkDelegationMemory);
      if (workspace?.ok === false) notify(workspace.error || '专业执行未完成，任务仍保持未完成状态。', 'error');
    } catch (error) {
      const refreshedMessages = await api.collaborationWorkspaceMessages({ delegationId }).catch(() => null);
      const serverReceivedMessage = Array.isArray(refreshedMessages) && refreshedMessages.some((message) => (
        message.metadata?.clientMessageId === clientMessageId
      ));
      if (Array.isArray(refreshedMessages)) {
        state.networkConversationMessages = delegationWorkspaceMessages(refreshedMessages, delegationId);
      }
      const pendingMessages = { ...(state.networkDelegationPendingMessages || {}) };
      const list = Array.isArray(pendingMessages[delegationId]) ? pendingMessages[delegationId] : [];
      if (serverReceivedMessage) {
        pendingMessages[delegationId] = list.filter((message) => message.metadata?.clientMessageId !== clientMessageId);
      } else {
        pendingMessages[delegationId] = list.map((message) => message.metadata?.clientMessageId === clientMessageId ? {
          ...message,
          metadata: { ...(message.metadata || {}), optimistic: false, sendFailed: true },
        } : message);
        if (!String(state.networkDelegationCommentDrafts?.[delegationId] || '').trim()) {
          state.networkDelegationCommentDrafts = {
            ...(state.networkDelegationCommentDrafts || {}),
            [delegationId]: content,
          };
          if (!(state.attachments || []).length) state.attachments = outgoingAttachmentItems;
          persistComposerDrafts();
        }
      }
      if (!pendingMessages[delegationId]?.length) delete pendingMessages[delegationId];
      state.networkDelegationPendingMessages = pendingMessages;
      notify(`补充说明发送失败：${userErrorMessage(error)}`, 'error');
    } finally {
      const shouldFollowBottom = delegationWorkspaceShouldFollowBottom();
      render();
      if (shouldFollowBottom) scrollDelegationWorkspaceToBottom();
      focusActiveComposerInput();
    }
  }

  function editDelegationMessage(messageId = '') {
    const message = (state.networkConversationMessages || []).find((item) => item.id === messageId);
    if (!message || message.metadata?.withdrawn) return;
    const delegationId = state.networkDelegationId || message.metadata?.delegationId || '';
    state.networkDelegationEditingMessageId = message.id;
    state.networkDelegationCommentDrafts = {
      ...(state.networkDelegationCommentDrafts || {}),
      [delegationId]: String(message.metadata?.originalInput || message.content || ''),
    };
    persistComposerDrafts();
    state.attachments = [];
    render();
    focusActiveComposerInput();
  }

  function cancelDelegationMessageEdit() {
    const delegationId = state.networkDelegationId || '';
    state.networkDelegationEditingMessageId = '';
    state.networkDelegationCommentDrafts = { ...(state.networkDelegationCommentDrafts || {}), [delegationId]: '' };
    persistComposerDrafts();
    state.attachments = [];
    render();
    focusActiveComposerInput();
  }

  async function withdrawDelegationMessage(messageId = '') {
    const message = (state.networkConversationMessages || []).find((item) => item.id === messageId);
    if (!message || message.metadata?.withdrawn || state.networkBusyDelegationId) return;
    if (!windowRef.confirm('撤回后，对方将看不到这条内容，对方 uBuddy 也会从任务整理中移除它。确认撤回吗？')) return;
    const delegationId = state.networkDelegationId || message.metadata?.delegationId || '';
    const delegation = (state.agentDelegations || []).find((item) => item.id === delegationId);
    const currentUserId = state.currentUser?.id || '';
    const peerId = (delegation?.requesterUserId || delegation?.requester_user_id) === currentUserId
      ? (delegation?.recipientUserId || delegation?.recipient_user_id || '')
      : (delegation?.requesterUserId || delegation?.requester_user_id || '');
    state.networkBusyDelegationId = delegationId;
    render();
    try {
      await api.updateSocialMessage({ messageId, action: 'withdraw', metadata: { delegationId } });
      state.networkConversationMessages = peerId ? await api.socialConversation({ peerId }) : [];
      state.socialInbox = await api.socialInbox();
      if (state.networkDelegationEditingMessageId === messageId) cancelDelegationMessageEdit();
      notify('内容已撤回，对方 uBuddy 会在下次同步时重新整理任务。', 'success');
    } catch (error) {
      notify(`撤回失败：${userErrorMessage(error)}`, 'error');
    } finally {
      state.networkBusyDelegationId = '';
      render();
    }
  }

  function continueEditingDelegationDraft(delegationId = '') {
    if (delegationId && delegationId !== state.networkDelegationId) return;
    const input = documentRef.getElementById('network-delegation-comment-input');
    input?.focus({ preventScroll: true });
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  }

  async function publishDelegationWorkspaceDraft({ delegationId = '', messageId = '', revisionId = '' } = {}) {
    delegationId = String(delegationId || state.networkDelegationId || '').trim();
    const delegation = (state.agentDelegations || []).find((item) => item.id === delegationId);
    const orderedMessages = (state.networkConversationMessages || [])
      .filter((item) => item.metadata?.delegationId === delegationId)
      .sort((left, right) => new Date(left.createdAt || left.created_at || 0) - new Date(right.createdAt || right.created_at || 0));
    const messageIndex = orderedMessages.findIndex((item) => item.id === messageId);
    const message = messageIndex >= 0 ? orderedMessages[messageIndex] : null;
    const contentMessage = message?.role === 'assistant'
      ? message
      : orderedMessages.slice(0, Math.max(0, messageIndex + 1)).reverse().find((item) => item.role === 'assistant') || message;
    const content = String(contentMessage?.content || message?.content || '').trim();
    if (!delegationId || !messageId || !content || state.networkBusyDelegationId) return;
    const currentUserId = state.currentUser?.id || '';
    const requesterId = delegation?.requesterUserId || delegation?.requester_user_id || '';
    const action = currentUserId === requesterId ? 'update_requirements' : 'submit';
    const sharedGroupWorkspace = Boolean(delegation?.groupId || delegation?.group_id || delegation?.metadata?.groupId);
    const candidateIndex = orderedMessages.findIndex((item) => item.id === contentMessage?.id);
    const candidateTail = orderedMessages.slice(Math.max(0, candidateIndex)).filter((item, index) => index === 0 || item.role !== 'user');
    const attachments = uniqueWorkspaceAttachments(candidateTail.flatMap((item) => Array.isArray(item.metadata?.attachments) ? item.metadata.attachments : []));
    state.networkBusyDelegationId = delegationId;
    render();
    try {
      const result = await api.collaborationTaskAction({
        delegationId,
        action,
        content,
        metadata: {
          sourceWorkspaceMessageId: messageId,
          sourceWorkspaceRevisionId: revisionId || messageId,
          sharedFromPrivateWorkspace: true,
          explicitlyConfirmedByOwner: true,
          attachments,
        },
      });
      if (result?.delegation) {
        state.agentDelegations = (state.agentDelegations || []).map((item) => item.id === delegationId ? result.delegation : item);
      }
      state.networkDelegationPublishedMessages = {
        ...(state.networkDelegationPublishedMessages || {}),
        [delegationId]: messageId,
      };
      await refreshCollaborationOverview(false);
      notify(action === 'submit'
        ? (sharedGroupWorkspace ? '已确认提交，结果和选择的文件已发布到任务群。' : '已确认交付，结果和选择的文件已发送给发起方。')
        : (sharedGroupWorkspace ? '已确认发布，这版要求已同步到任务群和接收方 uBuddy。' : '已确认更新，这版要求已同步给接收方 uBuddy。'), 'success');
      await openNetworkDelegation(delegationId);
    } catch (error) {
      if (action === 'submit') {
        const latest = (state.agentDelegations || []).find((item) => item.id === delegationId) || delegation || {};
        const previousProgress = latest.metadata?.executionProgress || {};
        const errorText = String(error?.message || error);
        const failureStage = /upload|上传|附件|文件/i.test(errorText) ? 'delivery_upload' : 'delivery_submit';
        const attachmentUnavailable = /本地文件已经不可用|文件已失效|没有找到.*文件|附件.*不可用/i.test(errorText);
        const failureMessage = attachmentUnavailable
          ? '任务内容已经完成，但交付文件已失效。请继续修改并重新生成文件，或重新选择附件后交付。'
          : failureStage === 'delivery_upload'
            ? '任务内容已经完成并保留，但交付文件上传失败。'
            : (sharedGroupWorkspace ? '任务结果已保留，但提交到任务群失败。' : '任务结果已保留，但交付给发起方失败。');
        const blockedResult = await api.collaborationTaskAction({
          delegationId,
          action: 'blocked',
          content: failureMessage,
          metadata: {
            executionState: 'completed',
            deliveryState: 'blocked',
            failureCode: 'delivery_failed',
            failureStage,
            retryable: true,
            publicFailure: {
              code: 'delivery_failed',
              stage: failureStage,
              message: failureMessage,
              retryable: true,
              occurredAt: new Date().toISOString(),
            },
            executionProgress: {
              ...previousProgress,
              version: 1,
              sequence: Number(previousProgress.sequence || 0) + 1,
              phase: 'blocked',
              taskStatus: previousProgress.taskStatus || 'completed',
              executionPercent: 100,
              lifecyclePhase: 'delivering',
              label: '交付受阻',
              confirmationRequired: true,
              message: failureMessage,
              running: 0,
              terminal: true,
              updatedAt: new Date().toISOString(),
            },
          },
        }).catch(() => null);
        if (blockedResult?.delegation) {
          state.agentDelegations = (state.agentDelegations || []).map((item) => item.id === delegationId ? blockedResult.delegation : item);
        }
      }
      notify(`${action === 'submit' ? '提交任务结果' : '发布任务要求'}失败：${userErrorMessage(error)}`, 'error');
    } finally {
      const shouldFollowBottom = delegationWorkspaceShouldFollowBottom();
      state.networkBusyDelegationId = '';
      render();
      if (shouldFollowBottom) scrollDelegationWorkspaceToBottom();
    }
  }

  function uniqueWorkspaceAttachments(items = []) {
    const seen = new Set();
    return items.filter((item) => {
      const key = String(item?.id || item?.fileId || item?.url || item?.path || item?.source_path || item?.name || '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function respondAgentDelegation(delegationId = '', action = '', options = {}) {
    const cleanId = String(delegationId || '').trim();
    if (!cleanId || state.networkBusyDelegationId) return;
    const currentDelegation = (state.agentDelegations || []).find((item) => item.id === cleanId) || null;
    const hostMessage = (state.messages || []).find((message) => message.metadata?.externalDelegationId === cleanId) || null;
    const deliveryDescriptor = hostMessage?.metadata?.externalDelegationDeliveryDraft || {};
    const storedInlineDraft = state.externalDelegationDeliveryDrafts?.[cleanId] || null;
    const descriptorRevisionId = String(deliveryDescriptor.candidateRevisionId || deliveryDescriptor.candidateMessageId || '');
    const inlineDraft = storedInlineDraft && (!storedInlineDraft.candidateRevisionId || storedInlineDraft.candidateRevisionId === descriptorRevisionId)
      ? storedInlineDraft : null;
    const inlineTextAvailable = inlineDraft && Object.prototype.hasOwnProperty.call(inlineDraft, 'text');
    const draft = String(inlineTextAvailable
      ? inlineDraft.text
      : state.networkDelegationCommentDrafts?.[cleanId]
        || deliveryDescriptor.submissionText
        || currentDelegation?.metadata?.preliminaryResult
        || '').trim();
    const outgoingAttachmentItems = action === 'submit' ? [...state.attachments] : [];
    if (action === 'submit' && !draft) {
      notify('请先填写将发送给发出方的结果。', 'error');
      return;
    }
    state.networkBusyDelegationId = cleanId;
    render();
    try {
      const attachments = action === 'submit' ? await readyAttachmentsForSend(outgoingAttachmentItems) : [];
      const message = draft || (attachments.length ? '处理结果与交付文件见附件。' : '');
      const result = await api.respondAgentDelegation({
        delegationId: cleanId, action, message, attachments,
        ...(action === 'accept' ? {
          sandboxPermission: options.sandboxPermission === 'auto-approve' ? 'auto-approve' : 'full-access',
          model: currentModelValue(),
          reasoningEffort: currentReasoningValue(),
        } : {}),
        ...(action === 'submit' && Array.isArray(inlineDraft?.selectedAttachmentKeys)
          ? { selectedGeneratedAttachmentKeys: inlineDraft.selectedAttachmentKeys }
          : {}),
        ...(action === 'submit' ? {
          sourceWorkspaceMessageId: deliveryDescriptor.candidateMessageId || '',
          sourceWorkspaceRevisionId: deliveryDescriptor.candidateRevisionId || deliveryDescriptor.candidateMessageId || '',
        } : {}),
      });
      state.agentDelegations = result?.delegations || await api.listAgentDelegations({ direction: 'all' });
      state.socialInbox = result?.inbox || await api.socialInbox();
      const delegation = state.agentDelegations.find((item) => item.id === cleanId);
      const currentUserId = state.currentUser?.id || '';
      const peerId = (delegation?.requesterUserId || delegation?.requester_user_id) === currentUserId
        ? (delegation?.recipientUserId || delegation?.recipient_user_id || '')
        : (delegation?.requesterUserId || delegation?.requester_user_id || '');
      if (peerId) state.networkConversationMessages = await api.socialConversation({ peerId });
      if (action === 'submit' || action === 'reject') {
        const nextDrafts = { ...(state.networkDelegationCommentDrafts || {}) };
        delete nextDrafts[cleanId];
        state.networkDelegationCommentDrafts = nextDrafts;
        const nextDeliveryDrafts = { ...(state.externalDelegationDeliveryDrafts || {}) };
        delete nextDeliveryDrafts[cleanId];
        state.externalDelegationDeliveryDrafts = nextDeliveryDrafts;
        persistComposerDrafts();
        if (action === 'submit') state.attachments = [];
      }
      if (action === 'reject') notify('已拒绝该任务，发起方会收到状态更新。', 'success');
      else if (action === 'submit') notify('处理结果已提交给发起方。', 'success');
      else notify('任务已由你接收，现在可以处理并提交结果。', 'success');
    } catch (error) {
      notify(`任务操作失败：${userErrorMessage(error)}`, 'error');
    } finally {
      state.networkBusyDelegationId = '';
      render();
    }
  }

  async function supplementRecentWorkDigest(delegationId = '', content = '') {
    const cleanId = String(delegationId || '').trim();
    const cleanContent = String(content || '').trim();
    if (!cleanId || !cleanContent) return;
    state.networkBusyDelegationId = cleanId;
    render();
    try {
      await api.supplementRecentWorkDigest({ delegationId: cleanId, content: cleanContent });
      await refreshAgentDelegations();
      notify('补充内容已纳入私人汇报草稿。', 'success');
    } catch (error) {
      notify(`补充工作内容失败：${userErrorMessage(error)}`, 'error');
    } finally {
      state.networkBusyDelegationId = '';
      render();
    }
  }

  async function cancelDelegationWorkspaceRun(delegationId = '', workId = '') {
    if (!delegationId || !workId) return;
    try {
      await api.cancelCollaborationWorkspaceWork({ delegationId, workId });
      state.networkDelegationRunsById = {
        ...(state.networkDelegationRunsById || {}),
        [delegationId]: (state.networkDelegationRunsById?.[delegationId] || []).filter((item) => item.workId !== workId),
      };
      notify('已取消本次私有工作区处理。', 'success');
      render();
    } catch (error) {
      notify(`取消处理失败：${userErrorMessage(error)}`, 'error');
    }
  }

  function scrollNetworkConversationToBottom() {
    setTimer(() => {
      const log = documentRef.querySelector('.network-conversation-log');
      if (log) log.scrollTop = log.scrollHeight;
    }, 0);
  }

  function scrollRegionShouldFollowBottom(element, tolerance = 48) {
    if (!element) return true;
    return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop) <= tolerance;
  }

  function networkConversationShouldFollowBottom() {
    return scrollRegionShouldFollowBottom(documentRef.querySelector('.network-conversation-log'));
  }

  function delegationWorkspaceShouldFollowBottom() {
    const regions = [
      documentRef.querySelector('.network-delegation-body'),
      documentRef.getElementById('network-delegation-message-list'),
    ].filter((element) => element && element.scrollHeight > element.clientHeight);
    return !regions.length || regions.every((element) => scrollRegionShouldFollowBottom(element));
  }

  function scrollDelegationWorkspaceToBottom() {
    setTimer(() => {
      const list = documentRef.getElementById('network-delegation-message-list');
      const body = documentRef.querySelector('.network-delegation-body');
      if (list) list.scrollTop = list.scrollHeight;
      if (body) body.scrollTop = body.scrollHeight;
    }, 0);
  }

  async function loadSecretaryConversationMessages() {
    const surfaceKey = currentMessageSurfaceKey();
    if (!state.secretarySessionId) {
      const session = await api.ensureSecretarySession();
      if (currentMessageSurfaceKey() !== surfaceKey) return false;
      state.secretarySessionId = session.id;
    }
    const sessionId = state.secretarySessionId;
    const [messagePage, deliveryRuns] = await Promise.all([
      loadMessagePage(sessionId),
      api.listAgentDeliveryRuns?.({ sessionId, statuses: ['queued', 'running'], limit: 100 }).catch(() => []) || Promise.resolve([]),
    ]);
    if (currentMessageSurfaceKey() !== surfaceKey) return false;
    const sessionMessages = Array.isArray(messagePage?.items) ? messagePage.items : [];
    const feedbackMessages = (state.socialInbox || []).filter((item) => {
      const recipientAgentId = item.recipientAgentId || item.recipient_agent_id || '';
      const metadataType = item.metadata?.type || '';
      return recipientAgentId === 'secretary_agent' || metadataType === 'agent_delegation';
    });
    const merged = new Map();
    [...sessionMessages, ...feedbackMessages].forEach((message) => merged.set(message.id || `${message.role}:${message.createdAt || message.created_at}:${message.content}`, message));
    state.messages = [...merged.values()]
      .sort((left, right) => new Date(left.createdAt || left.created_at || 0).getTime() - new Date(right.createdAt || right.created_at || 0).getTime());
    state.messagePagination = {
      sessionId,
      source: 'session',
      nextCursor: messagePage?.nextCursor || null,
      hasMore: Boolean(messagePage?.hasMore),
      loading: false,
      initialLoading: false,
    };
    syncCurrentChatRun?.();
    restorePersistentDeliveryRuns?.(Array.isArray(deliveryRuns) ? deliveryRuns : [], sessionId);
    restoreActiveRunTransient?.();
    return true;
  }

  async function openNetworkTask(taskId = '') {
    if (!taskId) return;
    state.networkPanelOpen = false;
    if (!isCurrentUserAdmin()) {
      notify('任务详情需要管理员权限。', 'warning');
      render();
      return;
    }
    try {
      state.currentTab = 'evolution';
      state.taskDetail = await api.getTask(taskId);
      render();
    } catch (error) {
      notify(`打开任务失败：${error.message || error}`, 'error');
      render();
    }
  }

  function retractNetworkPanelForChat() {
    networkPanelOpenSequence += 1;
    state.networkPanelLoading = false;
    state.networkPanelOpen = false;
    state.networkPanelView = state.networkPanelView || 'messages';
    state.networkConversationPeerId = '';
    state.networkConversationGroupId = '';
    state.networkConversationMessages = [];
    state.socialMentionMenuOpen = false;
  }


  return {
    openNetworkPanel,
    openUBuddyConversation,
    openNetworkConversation,
    openUBuddyTaskForFriend,
    openContactCollaborationInUBuddy,
    dissolveSocialTaskGroup,
    renameSocialTaskGroup,
    selectedSocialTaskGroup,
    toggleSocialGroupSection,
    openNetworkDelegation,
    returnToTaskSourceChat,
    restoreTaskWorkspaceNavigation,
    beginTaskWorkspaceNavigation,
    setTaskWorkspaceView,
    closeNetworkConversation,
    sendNetworkConversationMessage,
    networkConversationDraftKey,
    networkComposerHasFocus,
    renderPreservingNetworkComposer,
    sendDelegationComment,
    editDelegationMessage,
    cancelDelegationMessageEdit,
    withdrawDelegationMessage,
    continueEditingDelegationDraft,
    publishDelegationWorkspaceDraft,
    uniqueWorkspaceAttachments,
    respondAgentDelegation,
    supplementRecentWorkDigest,
    cancelDelegationWorkspaceRun,
    scrollNetworkConversationToBottom,
    scrollDelegationWorkspaceToBottom,
    loadSecretaryConversationMessages,
    openNetworkTask,
    retractNetworkPanelForChat,
  };
}
