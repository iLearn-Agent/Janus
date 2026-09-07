import { pptStyleFromConversation } from '../../../../shared/pptAgents.js';

export function resolveCurrentChatRun({ state = {}, allChatRuns = () => [], chatRunForSession = () => null } = {}) {
  const activeChatKey = String(state.currentChatKey || '').trim();
  if (activeChatKey) {
    const keyRun = allChatRuns().find((run) => !run.nonBlocking && String(run.chatKey || '') === activeChatKey) || null;
    if (keyRun) return keyRun;
  }
  if (state.currentSessionId) return chatRunForSession(state.currentSessionId);
  return null;
}

export function mergeEmployeeConversationOverview(previous = null, incoming = null, workStatus = null) {
  if (!incoming) return previous;
  const incomingWork = incoming.activeWork || null;
  const previousWork = previous?.activeWork || null;
  const sidebarRunning = ['working', 'queued', 'reserved', 'blocked'].includes(String(
    workStatus?.workState || workStatus?.work_state || '',
  ).toLowerCase()) || String(workStatus?.availability || '').toLowerCase() === 'working';
  const incomingHasWork = incomingWork
    && incomingWork.route !== 'none'
    && Boolean(incomingWork.taskRunId || incomingWork.sessionId);
  const previousHasWork = previousWork
    && previousWork.route !== 'none'
    && Boolean(previousWork.taskRunId || previousWork.sessionId);
  return {
    ...(previous || {}),
    ...incoming,
    activeWork: incomingHasWork || !previousHasWork || !sidebarRunning ? incomingWork : previousWork,
    taskQueue: incoming.taskQueue || previous?.taskQueue || { count: 0, taskRunIds: [] },
    historyGroups: Array.isArray(incoming.historyGroups) && incoming.historyGroups.length
      ? incoming.historyGroups : previous?.historyGroups || [],
    historySessions: Array.isArray(incoming.historySessions) && incoming.historySessions.length
      ? incoming.historySessions : previous?.historySessions || [],
  };
}

export function createSessionNavigationController({
  state,
  render,
  windowRef,
  documentRef,
  agentDisplayLabels,
  isLegacyChatDepartmentId,
  retractNetworkPanelForChat,
  focusChatInputAtEnd,
  projectById,
  projectName,
  expandProject,
  notify,
  pathBasename,
  openUBuddyConversation,
  closeChatSearch,
  restoreActiveRunTransient,
  restorePersistentDeliveryRuns,
  resetChatSearchState,
  resolveSelectedAgentId,
  scrollMessagesToBottom,
  findSessionById,
  normalizeSearch,
  scheduleChatSearch,
  sessionIsArchived,
  saveThemeMode,
  beginMessagePageRequest = () => 0,
  messagePageRequestIsLatest = () => true,
  captureMessageViewState = () => null,
  restoreMessageViewState = () => false,
  refreshUBuddyTaskViewsForSession = async () => null,
  preserveCurrentComposerDraft = () => {},
  restoreComposerDraft = () => {},
}) {
  let sessionOpenRequestId = 0;

  function invalidateSessionOpenRequests() {
    sessionOpenRequestId += 1;
  }

  function startNewPlainChat({ renderNow = true, focus = true } = {}) {
    preserveCurrentComposerDraft();
    invalidateSessionOpenRequests();
    clearSocialChatSelection();
    retractNetworkPanelForChat();
    beginNewChatView();
    state.activeProjectId = '';
    state.workspaceRoot = '';
    state.workspaceDetached = false;
    state.currentSessionId = '';
    state.contextUsage = null;
    state.messages = [];
    state.attachments = [];
    state.composerTaskReference = null;
    state.taskReferenceMenuOpen = false;
    state.chatDraft = '';
    state.homeMode = 'department';
    state.currentDepartmentId = '';
    state.currentAgentId = '';
    state.currentAgentInstanceId = '';
    restoreComposerDraft(`new:${state.currentChatKey}`);
    state.selectionSource = null;
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
      state.composerMetaOverflowOpen = false;
      state.pptTemplateMenuOpen = false;
      state.agentMenuOpen = false;
      state.sandboxMenuOpen = false;
    state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), chats: true };
    if (renderNow) render();
    if (focus) focusChatInputAtEnd();
  }

  function startNewProjectChat(projectId = state.activeProjectId, { renderNow = true, focus = true } = {}) {
    preserveCurrentComposerDraft();
    invalidateSessionOpenRequests();
    retractNetworkPanelForChat();
    const project = projectById(projectId);
    if (!project) return;
    beginNewChatView();
    expandProject(project.id);
    state.workspaceRoot = project.workspaceRoot || project.workspace_root || '';
    state.workspaceDetached = false;
    state.currentTab = 'chat';
    state.sidebarMode = 'root';
    state.currentSessionId = '';
    state.messages = [];
    state.attachments = [];
    state.chatDraft = '';
    state.homeMode = 'department';
    state.currentDepartmentId = '';
    state.currentAgentId = '';
    state.currentAgentInstanceId = '';
    restoreComposerDraft(`new:${state.currentChatKey}`);
    state.selectionSource = null;
    state.workspaceDetached = false;
    state.workspaceMenuOpen = false;
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.composerMetaOverflowOpen = false;
    state.pptTemplateMenuOpen = false;
    state.agentMenuOpen = false;
    if (renderNow) render();
    if (focus) focusChatInputAtEnd();
  }

  async function createProjectFromWorkspace() {
    state.projectMenuOpenId = '';
    try {
      const selected = await windowRef.janus.selectProjectWorkspace();
      if (selected?.canceled) return;
      const workspaceRoot = selected.workspaceRoot || selected.workspace_root || '';
      const project = await windowRef.janus.createProject({ workspaceRoot, title: pathBasename(workspaceRoot) });
      state.projects = await windowRef.janus.listProjects();
      expandProject(project.id);
      startNewProjectChat(project.id);
      notify('项目已创建。', 'success');
    } catch (error) {
      notify(`创建项目失败：${error.message || error}`, 'error');
      render();
    }
  }

  async function handleProjectAction(action = '', projectId = '') {
    state.projectMenuOpenId = '';
    state.projectMenuKind = '';
    state.projectMenuPosition = null;
    if (action === 'create-project') return createProjectFromWorkspace();
    if (action === 'new-chat') {
      startNewPlainChat();
      return;
    }
    if (action === 'open-ubuddy-chat') return openUBuddyConversation();
    if (action === 'new-project-chat') return startNewProjectChat(projectId);
    const project = projectById(projectId);
    if (!project) return;
    if (action === 'rename-project') {
      state.renameSessionDialog = {
        type: 'project',
        projectId,
        title: project.title || projectName(project),
        draft: project.title || projectName(project),
      };
      render();
      setTimeout(() => {
        const input = documentRef.getElementById('rename-session-input');
        input?.focus();
        input?.select();
      }, 0);
      return;
    }
    if (action === 'archive-project') {
      if (!windowRef.confirm(`确认归档项目“${projectName(project)}”？这个项目下的所有对话都会一起归档。`)) {
        render();
        return;
      }
      try {
        await windowRef.janus.updateProject({ projectId, action: 'archive' });
        state.projects = await windowRef.janus.listProjects();
        state.sessions = await windowRef.janus.listSessions();
        state.expandedProjectIds = (state.expandedProjectIds || []).filter((id) => id !== projectId);
        if (state.activeProjectId === projectId) {
          state.activeProjectId = '';
          resetCurrentChatState();
        }
        notify('项目已归档。', 'success');
        render();
      } catch (error) {
        notify(`项目归档失败：${error.message || error}`, 'error');
        render();
      }
    }
  }

  function startNewChatFromSearch() {
    preserveCurrentComposerDraft();
    invalidateSessionOpenRequests();
    beginNewChatView();
    state.currentTab = 'chat';
    state.sidebarMode = 'chats';
    state.currentSessionId = '';
    state.messages = [];
    state.attachments = [];
    state.homeMode = 'department';
    state.currentDepartmentId = '';
    state.currentAgentId = '';
    state.currentAgentInstanceId = '';
    state.selectionSource = null;
    restoreComposerDraft(`new:${state.currentChatKey}`);
    closeChatSearch();
  }

  function groupSessionsByMonth(items) {
    const now = new Date();
    const groups = new Map();
    for (const item of items || []) {
      const date = parseDate(item.updatedAt || item.updated_at || item.createdAt || item.created_at);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      if (!groups.has(key)) groups.set(key, { date, items: [] });
      groups.get(key).items.push(item);
    }
    return Array.from(groups.values())
      .sort((left, right) => right.date - left.date)
      .map((group) => ({
        label: monthGroupLabel(group.date, now),
        items: group.items.sort((left, right) => (
          parseDate(right.updatedAt || right.updated_at || right.createdAt || right.created_at) -
          parseDate(left.updatedAt || left.updated_at || left.createdAt || left.created_at)
        )),
      }));
  }

  function monthGroupLabel(date, now = new Date()) {
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return '本月';
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  function parseDate(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  function upsertRecentSession(session = {}) {
    if (!session.id) return;
    const now = new Date().toISOString();
    const existing = state.sessions.find((item) => item.id === session.id) || {};
    const next = {
      ...existing,
      ...session,
      title: session.title || existing.title || 'New chat',
      departmentId: session.departmentId ?? existing.departmentId ?? 'general',
      agentId: session.agentId ?? existing.agentId ?? '',
      createdAt: session.createdAt || existing.createdAt || now,
      updatedAt: session.updatedAt || now,
    };
    const byId = new Map();
    for (const item of [next, ...state.sessions]) {
      if (!item?.id || byId.has(item.id)) continue;
      if (item.status === 'deleted' || item.status === 'archived' || item.archived === true) continue;
      byId.set(item.id, item);
    }
    state.sessions = Array.from(byId.values())
      .sort(compareSessionsForDisplay)
      .slice(0, 80);
  }

  function compareSessionsForDisplay(left = {}, right = {}) {
    const leftPinned = left.pinnedAt || left.pinned_at || '';
    const rightPinned = right.pinnedAt || right.pinned_at || '';
    if (leftPinned || rightPinned) {
      if (!leftPinned) return 1;
      if (!rightPinned) return -1;
      const pinnedCompare = String(rightPinned).localeCompare(String(leftPinned));
      if (pinnedCompare) return pinnedCompare;
    }
    return parseDate(right.updatedAt || right.updated_at) - parseDate(left.updatedAt || left.updated_at);
  }

  function toggleTheme() {
    state.themeMode = state.themeMode === 'dark' ? 'light' : 'dark';
    saveThemeMode(state.themeMode);
    render();
  }

  function agentLabel(agent) {
    const stateText = agent.routable === false ? ` (${agent.lifecycleStatus || agent.routingState || 'paused'})` : '';
    return `${agentDisplayLabels[agent.id] || agent.name || agent.id}${stateText}`;
  }

  function shortAgentLabel(agent) {
    if (agentDisplayLabels[agent.id]) return agentDisplayLabels[agent.id];
    return String(agent.name || agent.id || 'Agent')
      .replace(/\s+Agent$/i, '')
      .replace(/\s+Specialist$/i, '')
      .slice(0, 18);
  }

  function clearSocialChatSelection() {
    state.uBuddyCenterOpen = '';
    state.uBuddyCenterError = '';
    state.networkConversationPeerId = '';
    state.networkConversationGroupId = '';
    state.networkConversationMessages = [];
    state.networkConversationBusy = false;
    state.networkDelegationId = '';
    state.collaborationGroupId = '';
    state.collaborationGroupDetail = null;
    state.collaborationGroupWorkspace = null;
    state.collaborationGroupWorkspaceBusy = false;
    state.collaborationAddMemberOpen = false;
    state.collaborationAddMemberUserId = '';
    state.collaborationAddMemberAssignment = '';
    state.collaborationRoutingConfirmation = null;
    state.chatGroupId = '';
    state.chatGroupDetail = null;
    state.networkGroupProfileOpen = false;
    state.networkSelectedGroupId = '';
    state.networkSelectedGroupKind = '';
    state.groupDirectoryProfileDetail = null;
  }

  async function openSession(sessionId, { preserveNetworkPanel = false, preserveDraft = true } = {}) {
    const previousAgentInstanceId = String(state.currentAgentInstanceId || '').trim();
    if (preserveDraft) preserveCurrentComposerDraft();
    const requestId = ++sessionOpenRequestId;
    const messagePageRequestVersion = beginMessagePageRequest(sessionId);
    const pendingSession = findSessionById(sessionId);
    const previousSession = findSessionById(state.currentSessionId);
    const uBuddyViewTransition = pendingSession?.departmentId === 'secretary_department'
      || previousSession?.departmentId === 'secretary_department';
    if (uBuddyViewTransition) captureMessageViewState();
    state.employeeConversationHistoryViewer = null;
    state.followerWorkspaceOpen = false;
    if (!preserveNetworkPanel) retractNetworkPanelForChat();
    if (preserveNetworkPanel && state.networkPanelView === 'messages') {
      state.networkMessageHomeOpen = false;
      state.messageActivePane = 'conversation';
    }
    clearSocialChatSelection();
    state.sessionMenuOpenId = '';
    state.sessionMenuPosition = null;
    state.currentSessionId = sessionId;
    const pendingAgentInstanceId = pendingSession?.agentInstanceId || pendingSession?.agent_instance_id || '';
    const shouldLoadEmployeeConversationOverview = Boolean(
      pendingAgentInstanceId
      && typeof windowRef.janus.employeeConversationOverview === 'function'
    );
    state.currentAgentInstanceId = pendingAgentInstanceId;
    const pendingProject = projectForSession(pendingSession);
    state.activeProjectId = pendingProject?.id || '';
    state.workspaceRoot = pendingProject?.workspaceRoot || pendingProject?.workspace_root
      || pendingSession?.workspaceRoot || pendingSession?.workspace_root || '';
    state.workspaceDetached = false;
    state.currentChatKey = pendingAgentInstanceId ? `agent:${pendingAgentInstanceId}` : `session:${sessionId}`;
    const pendingDepartmentId = String(pendingSession?.departmentId || pendingSession?.department_id || '');
    const targetDraftKey = pendingDepartmentId === 'secretary_department'
      ? 'ubuddy'
      : pendingDepartmentId === 'private_assistant'
        ? 'private-assistant'
        : pendingAgentInstanceId
          ? `agent:${pendingAgentInstanceId}`
          : `session:${sessionId}`;
    restoreComposerDraft(targetDraftKey);
    state.composerImageMode = false;
    syncCurrentChatRun();
    const preloadedPage = state.preloadedMessagePagesBySessionId?.[sessionId] || null;
    state.messages = Array.isArray(preloadedPage?.items) ? preloadedPage.items : [];
    state.messagePagination = {
      sessionId,
      source: preloadedPage?.source || (shouldLoadEmployeeConversationOverview ? 'agent' : 'session'),
      agentInstanceId: preloadedPage?.agentInstanceId || (shouldLoadEmployeeConversationOverview ? pendingAgentInstanceId : ''),
      nextCursor: preloadedPage?.nextCursor || null,
      hasMore: Boolean(preloadedPage?.hasMore),
      loading: !preloadedPage,
      initialLoading: !preloadedPage,
    };
    state.contextUsage = null;
    render();
    const [messagePage, contextUsage, deliveryRuns, employeeConversationOverviewResult] = await Promise.all([
      shouldLoadEmployeeConversationOverview
        ? Promise.resolve({ items: [], nextCursor: null, hasMore: false })
        : typeof windowRef.janus.listMessagePage === 'function'
          ? windowRef.janus.listMessagePage({ sessionId, limit: 200 })
          : windowRef.janus.listMessages(sessionId).then((items) => ({ items, nextCursor: null, hasMore: false })),
      windowRef.janus.chatContextStatus({ sessionId }).catch(() => null),
      windowRef.janus.listAgentDeliveryRuns?.({ sessionId, statuses: ['queued', 'running'], limit: 100 }).catch(() => []) || Promise.resolve([]),
      shouldLoadEmployeeConversationOverview
        ? Promise.resolve()
          .then(() => windowRef.janus.employeeConversationOverview({ agentInstanceId: pendingAgentInstanceId }))
          .then((overview) => ({ overview, error: null }), (error) => ({ overview: null, error }))
        : Promise.resolve({ overview: null, error: null }),
    ]);
    if (requestId !== sessionOpenRequestId || state.currentSessionId !== sessionId) return;
    const employeeConversationOverview = employeeConversationOverviewResult?.overview || null;
    const resolvedAgentInstanceId = String(employeeConversationOverview?.resolvedAgentInstanceId || pendingAgentInstanceId || '');
    const canonicalSession = employeeConversationOverview?.primarySession || null;
    if (canonicalSession?.id && canonicalSession.id !== sessionId) {
      upsertRecentSession(canonicalSession);
      await openSession(canonicalSession.id, { preserveNetworkPanel, preserveDraft: false });
      return;
    }
    const timelineItems = Array.isArray(employeeConversationOverview?.timeline?.items)
      ? employeeConversationOverview.timeline.items
      : [];
    let resolvedMessagePage = messagePage;
    if (shouldLoadEmployeeConversationOverview && !timelineItems.length) {
      resolvedMessagePage = typeof windowRef.janus.listMessagePage === 'function'
        ? await windowRef.janus.listMessagePage({ sessionId, limit: 200 })
        : { items: await windowRef.janus.listMessages(sessionId), nextCursor: null, hasMore: false };
      if (requestId !== sessionOpenRequestId || state.currentSessionId !== sessionId) return;
    }
    const messagePageStillLatest = !messagePageRequestVersion
      || messagePageRequestIsLatest(sessionId, messagePageRequestVersion);
    const currentMessagesStillLoading = state.messagePagination?.sessionId === sessionId
      && state.messagePagination?.loading === true
      && !(state.messages || []).length;
    if (messagePageStillLatest || currentMessagesStillLoading) {
      const useAgentTimeline = shouldLoadEmployeeConversationOverview && timelineItems.length > 0;
      state.messages = useAgentTimeline
        ? messagesFromTimeline(timelineItems, resolvedAgentInstanceId)
        : Array.isArray(resolvedMessagePage?.items) ? resolvedMessagePage.items : [];
      const nextCursor = useAgentTimeline
        ? employeeConversationOverview?.timeline?.nextCursor || null
        : resolvedMessagePage?.nextCursor || null;
      state.messagePagination = {
        sessionId,
        source: useAgentTimeline ? 'agent' : 'session',
        agentInstanceId: useAgentTimeline ? resolvedAgentInstanceId : '',
        nextCursor,
        hasMore: useAgentTimeline ? Boolean(nextCursor) : Boolean(resolvedMessagePage?.hasMore),
        loading: false,
        initialLoading: false,
      };
      state.preloadedMessagePagesBySessionId = {
        ...(state.preloadedMessagePagesBySessionId || {}),
        [sessionId]: {
          items: state.messages,
          source: state.messagePagination.source,
          agentInstanceId: state.messagePagination.agentInstanceId || '',
          nextCursor,
          hasMore: state.messagePagination.hasMore,
        },
      };
    }
    state.contextUsage = contextUsage;
    restorePersistentDeliveryRuns?.(Array.isArray(deliveryRuns) ? deliveryRuns : [], sessionId);
    state.sessions = state.sessions.map((item) => item.id === sessionId
      ? { ...item, unreadDeliveryCount: 0, unreadCount: 0 }
      : item);
    restoreActiveRunTransient();
    const session = state.sessions.find((item) => item.id === sessionId) ||
      (state.chatSearchResults || []).find((item) => item.id === sessionId) ||
      (state.archivedSessions || []).find((item) => item.id === sessionId);
    state.currentAgentInstanceId = session?.agentInstanceId || session?.agent_instance_id || '';
    const currentAgentInstanceId = state.currentAgentInstanceId || pendingAgentInstanceId;
    if (employeeConversationOverview && currentAgentInstanceId) {
      const requestedAgentInstanceId = String(employeeConversationOverview.requestedAgentInstanceId || currentAgentInstanceId);
      const resolvedAgentInstanceId = String(employeeConversationOverview.resolvedAgentInstanceId || requestedAgentInstanceId);
      const primarySessionAgentInstanceId = String(
        employeeConversationOverview.primarySession?.agentInstanceId
          || employeeConversationOverview.primarySession?.agent_instance_id
          || '',
      );
      const identityMatches = resolvedAgentInstanceId
        && (!employeeConversationOverview.primarySession || primarySessionAgentInstanceId === resolvedAgentInstanceId);
      if (identityMatches) {
        state.currentAgentInstanceId = resolvedAgentInstanceId;
        state.currentChatKey = employeeConversationOverview.windowId || `agent:${resolvedAgentInstanceId}`;
        const previousOverview = state.employeeConversationOverviewByInstanceId?.[resolvedAgentInstanceId] || null;
        state.employeeConversationOverviewByInstanceId = {
          ...(state.employeeConversationOverviewByInstanceId || {}),
          [resolvedAgentInstanceId]: mergeEmployeeConversationOverview(
            previousOverview,
            employeeConversationOverview,
            state.agentWorkStatusByInstanceId?.[resolvedAgentInstanceId],
          ),
        };
      } else {
        notify('Agent 会话身份不一致，已停止加载。', 'warning');
      }
    } else if (employeeConversationOverviewResult?.error) {
      notify(`当前会话已打开，但历史对话加载失败：${employeeConversationOverviewResult.error.message || employeeConversationOverviewResult.error}`, 'warning');
    }
    if (session?.departmentId === 'private_assistant') state.privateAssistantResultUnread = false;
    if (session?.departmentId === 'ppt_department') {
      state.pptStyleId = pptStyleFromConversation({ session, messages: state.messages });
    }
    if (session && !sessionIsArchived(session) && !state.sessions.some((item) => item.id === session.id)) {
      state.sessions = [session, ...state.sessions].slice(0, 80);
    }
    state.chatSearchOpen = false;
    resetChatSearchState();
    const sessionProject = projectForSession(session);
    state.interactionMode = ['goal', 'plan'].includes(session?.interactionMode || session?.interaction_mode)
      ? session.interactionMode || session.interaction_mode
      : '';
    state.goalEditor = null;
    state.goalActionBusy = '';
    state.composerToolMenuOpen = false;
    state.composerMetaOverflowOpen = false;
    if (sessionProject?.id) {
      state.workspaceDetached = false;
      state.activeProjectId = sessionProject.id;
      state.workspaceRoot = sessionProject.workspaceRoot || sessionProject.workspace_root || '';
      expandProject(sessionProject.id);
    } else {
      state.activeProjectId = '';
      state.workspaceRoot = session?.workspaceRoot || session?.workspace_root || '';
      state.workspaceDetached = false;
      const sectionKey = session?.departmentId === 'secretary_department' ? 'tasks' : session?.departmentId === 'collaboration' ? 'collaboration' : 'chats';
      state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), [sectionKey]: true };
    }
    state.selectionSource = null;
    if (session?.departmentId === 'general') {
      state.homeMode = 'department';
      state.currentDepartmentId = '';
      state.currentAgentId = '';
    } else if (session?.departmentId === 'collaboration') {
      state.homeMode = 'collaboration';
      state.currentDepartmentId = '';
      state.currentAgentId = '';
    } else if (session?.departmentId === 'image_generation') {
      state.homeMode = 'image';
      state.currentDepartmentId = '';
      state.currentAgentId = '';
    } else if (session?.departmentId === 'secretary_department') {
      state.homeMode = 'secretary';
      state.currentDepartmentId = '';
      state.currentAgentId = '';
    } else if (session?.departmentId === 'private_assistant') {
      state.homeMode = 'private_assistant';
      state.currentDepartmentId = '';
      state.currentAgentId = '';
      state.interactionMode = '';
    } else if (
      (session?.agentId || session?.departmentId) &&
      !isLegacyChatDepartmentId(session?.departmentId) &&
      state.org.departments.some((department) => department.id === session?.departmentId)
    ) {
      state.homeMode = 'department';
      state.currentDepartmentId = session.departmentId || state.currentDepartmentId;
      state.currentAgentId = resolveSelectedAgentId(state.currentDepartmentId, session.agentId || state.currentAgentId);
    } else {
      state.homeMode = 'department';
      state.currentDepartmentId = '';
      state.currentAgentId = '';
    }
    state.currentTab = 'chat';
    render();
    const targetIsUBuddy = session?.departmentId === 'secretary_department';
    const restoredView = targetIsUBuddy ? restoreMessageViewState() : false;
    if (!restoredView) scrollMessagesToBottom({ force: true, settle: true });
    if (targetIsUBuddy) void refreshUBuddyTaskViewsForSession(sessionId, state.messages);
  }

  function messagesFromTimeline(items = [], agentInstanceId = '') {
    return (Array.isArray(items) ? items : []).map((item) => item.message ? {
      ...item.message,
      metadata: { ...(item.message.metadata || {}), timelineSource: item },
    } : {
      id: item.id,
      role: item.role || 'system',
      content: item.content || '',
      createdAt: item.occurredAt || '',
      agentInstanceId,
      metadata: { timelineSource: item, attachments: item.attachments || [] },
    });
  }

  async function loadOlderMessages() {
    const pagination = state.messagePagination || {};
    const sessionId = String(state.currentSessionId || '');
    if (!sessionId || pagination.sessionId !== sessionId || pagination.loading || !pagination.hasMore || !pagination.nextCursor) return false;
    state.messagePagination = { ...pagination, loading: true };
    render();
    try {
      let items = [];
      let nextCursor = null;
      let hasMore = false;
      if (pagination.source === 'agent' && pagination.agentInstanceId && typeof windowRef.janus.agentConversationTimeline === 'function') {
        const page = await windowRef.janus.agentConversationTimeline({
          agentInstanceId: pagination.agentInstanceId,
          before: pagination.nextCursor,
          limit: 80,
        });
        items = messagesFromTimeline(page?.items || [], pagination.agentInstanceId);
        nextCursor = page?.nextCursor || null;
        hasMore = Boolean(nextCursor);
      } else if (typeof windowRef.janus.listMessagePage === 'function') {
        const page = await windowRef.janus.listMessagePage({ sessionId, before: pagination.nextCursor, limit: 80 });
        items = Array.isArray(page?.items) ? page.items : [];
        nextCursor = page?.nextCursor || null;
        hasMore = Boolean(page?.hasMore);
      }
      if (state.currentSessionId !== sessionId || state.messagePagination?.sessionId !== sessionId) return false;
      const existingIds = new Set((state.messages || []).map((message) => String(message?.id || '')).filter(Boolean));
      const older = items.filter((message) => message?.id && !existingIds.has(String(message.id)));
      state.messages = [...older, ...(state.messages || [])];
      state.messagePagination = { ...state.messagePagination, nextCursor, hasMore, loading: false };
      state.preloadedMessagePagesBySessionId = {
        ...(state.preloadedMessagePagesBySessionId || {}),
        [sessionId]: {
          items: state.messages,
          source: state.messagePagination.source,
          agentInstanceId: state.messagePagination.agentInstanceId || '',
          nextCursor,
          hasMore,
        },
      };
      render();
      return true;
    } catch (error) {
      if (state.currentSessionId === sessionId && state.messagePagination?.sessionId === sessionId) {
        state.messagePagination = { ...state.messagePagination, loading: false };
        notify(`加载更早消息失败：${error.message || error}`, 'error');
        render();
      }
      return false;
    }
  }

  function projectForSession(session = {}) {
    if (!session) return null;
    const sessionProjectId = session.projectId || session.project_id || '';
    if (sessionProjectId) return projectById(sessionProjectId);
    const sessionWorkspace = normalizePathKey(session.workspaceRoot || session.workspace_root || '');
    if (!sessionWorkspace) return null;
    return (state.projects || []).find((project) => normalizePathKey(project.workspaceRoot || project.workspace_root || '') === sessionWorkspace) || null;
  }

  function normalizePathKey(value = '') {
    return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function closeRenameSessionDialog() {
    state.renameSessionDialog = null;
    render();
  }

  async function submitRenameSession(event) {
    event.preventDefault();
    const item = state.renameSessionDialog;
    if (!item) return;
    const title = String(documentRef.getElementById('rename-session-input')?.value || item.draft || '').trim();
    const isProject = item.type === 'project';
    if (!title) {
      notify(isProject ? '项目名称不能为空。' : '会话标题不能为空。', 'warning');
      setTimeout(() => documentRef.getElementById('rename-session-input')?.focus(), 0);
      return;
    }
    if (title === item.title) {
      state.renameSessionDialog = null;
      render();
      return;
    }
    try {
      if (isProject) {
        await windowRef.janus.updateProject({ projectId: item.projectId, action: 'rename', title });
        state.projects = await windowRef.janus.listProjects();
        state.renameSessionDialog = null;
        notify('项目已重命名。', 'success');
        render();
        return;
      }
      const updated = await windowRef.janus.updateSession({ sessionId: item.sessionId, action: 'rename', title });
      state.renameSessionDialog = null;
      await refreshSessionsAfterAction(item.sessionId, 'rename', updated);
      notify('会话已重命名。', 'success');
      render();
    } catch (error) {
      notify(`${isProject ? '项目' : '会话'}重命名失败：${error.message || error}`, 'error');
      render();
    }
  }

  async function handleSessionAction(sessionId, action) {
    const session = findSessionById(sessionId);
    if (!session || !action) return;
    if (action === 'delete' && (state.busy || sessionHasActiveChatRun(sessionId))) {
      state.sessionMenuOpenId = '';
      render();
      return notify(sessionHasActiveChatRun(sessionId) ? '该对话仍在生成，结束后再删除。' : '当前操作尚未结束，请稍后再删除会话。', 'warning');
    }
    const payload = { sessionId, action };
    if (action === 'rename') {
      state.sessionMenuOpenId = '';
      state.sessionMenuPosition = null;
      state.renameSessionDialog = {
        type: 'session',
        sessionId,
        title: session.title || 'Untitled',
        draft: session.title || 'Untitled',
      };
      render();
      setTimeout(() => {
        const input = documentRef.getElementById('rename-session-input');
        input?.focus();
        input?.select();
      }, 0);
      return;
    }
    if (action === 'delete') {
      const title = session.title || 'Untitled';
      if (!windowRef.confirm(`确认删除“${title}”？会话中的本地附件副本也会被永久删除；仍被其他会话引用的文件会保留。`)) {
        state.sessionMenuOpenId = '';
        render();
        return;
      }
    }
    state.sessionMenuOpenId = '';
    try {
      const updated = await windowRef.janus.updateSession(payload);
      await refreshSessionsAfterAction(sessionId, action, updated);
      notify(sessionActionSuccessLabel(action), 'success');
      render();
    } catch (error) {
      notify(`会话操作失败：${error.message || error}`, 'error');
      render();
    }
  }

  async function refreshSessionsAfterAction(sessionId, action, updated = null) {
    if (action === 'delete') {
      state.sessions = state.sessions.filter((item) => item.id !== sessionId);
      state.chatSearchResults = (state.chatSearchResults || []).filter((item) => item.id !== sessionId);
      if (state.currentSessionId === sessionId) resetCurrentChatState();
    } else if (updated?.id) {
      state.chatSearchResults = (state.chatSearchResults || []).map((item) => item.id === updated.id ? { ...item, ...updated } : item);
      if (!state.chatSearchResults.some((item) => item.id === updated.id) && state.chatSearchOpen && normalizeSearch(state.chatSearchQuery)) {
        state.chatSearchResults = [updated, ...state.chatSearchResults];
      }
    }
    state.sessions = await windowRef.janus.listSessions();
    if (state.currentTab === 'settings' && state.currentSettingsSection === 'archived') {
      await loadArchivedSessions({ silent: true });
    }
    if (state.chatSearchOpen && normalizeSearch(state.chatSearchQuery)) scheduleChatSearch();
  }

  function resetCurrentChatState() {
    preserveCurrentComposerDraft();
    invalidateSessionOpenRequests();
    beginNewChatView();
    state.currentSessionId = '';
    state.messages = [];
    state.attachments = [];
    state.homeMode = 'department';
    state.currentDepartmentId = '';
    state.currentAgentId = '';
    state.currentAgentInstanceId = '';
    state.selectionSource = null;
    state.currentTab = 'chat';
    restoreComposerDraft(`new:${state.currentChatKey}`);
  }

  function allChatRuns() {
    if (!Array.isArray(state.chatRuns)) state.chatRuns = [];
    return state.chatRuns;
  }

  function beginNewChatView() {
    state.currentChatKey = `new-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.activeChatRun = null;
    state.employeeConversationHistoryViewer = null;
    state.contextUsage = null;
    state.messagePagination = { sessionId: '', source: '', nextCursor: null, hasMore: false, loading: false, initialLoading: false };
    state.interactionMode = '';
    state.goalEditor = null;
    state.goalActionBusy = '';
    state.composerImageMode = false;
    state.composerToolMenuOpen = false;
  }

  function chatRunForChannel(channelId = '') {
    return allChatRuns().find((run) => run.channelId === channelId) || null;
  }

  function chatRunForSession(sessionId = '') {
    if (!sessionId) return null;
    return allChatRuns().find((run) => !run.nonBlocking && (run.displaySessionId || run.sessionId) === sessionId) || null;
  }

  function currentChatRun() {
    return resolveCurrentChatRun({ state, allChatRuns, chatRunForSession });
  }

  function syncCurrentChatRun() {
    state.activeChatRun = currentChatRun();
    return state.activeChatRun;
  }

  function registerChatRun(run) {
    state.chatRuns = [...allChatRuns().filter((item) => item.channelId !== run.channelId), run];
    syncCurrentChatRun();
  }

  function unregisterChatRun(run) {
    if (!run) return;
    state.chatRuns = allChatRuns().filter((item) => item.channelId !== run.channelId);
    syncCurrentChatRun();
  }

  function sessionHasActiveChatRun(sessionId = '') {
    return Boolean(chatRunForSession(sessionId));
  }

  function sessionActionSuccessLabel(action) {
    if (action === 'rename') return '会话已重命名。';
    if (action === 'pin') return '会话已置顶。';
    if (action === 'unpin') return '已取消置顶。';
    if (action === 'archive') return '会话已归档。';
    if (action === 'unarchive') return '已取消归档。';
    if (action === 'delete') return '会话已删除。';
    return '会话已更新。';
  }

  function enterSettings(section = 'account') {
    state.currentTab = 'settings';
    state.currentSettingsSection = section || 'account';
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    if (state.currentSettingsSection === 'archived') loadArchivedSessions({ silent: true });
    render();
  }

  function openSettingsSection(section = 'account') {
    state.currentSettingsSection = section || 'account';
    if (state.currentSettingsSection === 'archived') loadArchivedSessions({ silent: true });
    render();
  }

  async function loadArchivedSessions({ silent = false } = {}) {
    state.archivedSessionsLoading = true;
    state.archivedSessionsError = '';
    if (!silent) render();
    try {
      const [sessions, preferences] = await Promise.all([
        windowRef.janus.listSessions({ includeArchived: true, limit: 200 }),
        typeof windowRef.janus.conversationPreferencesOverview === 'function'
          ? windowRef.janus.conversationPreferencesOverview()
          : Promise.resolve(null),
      ]);
      if (preferences) state.conversationPreferences = preferences;
      state.archivedSessions = (sessions || []).filter(sessionIsArchived);
    } catch (error) {
      state.archivedSessionsError = error.message || String(error);
      state.archivedSessions = state.archivedSessions || [];
    } finally {
      state.archivedSessionsLoading = false;
      if (state.currentTab === 'settings' && state.currentSettingsSection === 'archived') render();
    }
  }

  function setThemeMode(mode) {
    if (!['light', 'dark'].includes(mode)) return;
    state.themeMode = mode;
    saveThemeMode(mode);
    render();
  }




  return {
    startNewPlainChat,
    startNewProjectChat,
    createProjectFromWorkspace,
    handleProjectAction,
    startNewChatFromSearch,
    groupSessionsByMonth,
    monthGroupLabel,
    parseDate,
    upsertRecentSession,
    compareSessionsForDisplay,
    toggleTheme,
    agentLabel,
    shortAgentLabel,
    clearSocialChatSelection,
    openSession,
    loadOlderMessages,
    projectForSession,
    normalizePathKey,
    closeRenameSessionDialog,
    submitRenameSession,
    handleSessionAction,
    refreshSessionsAfterAction,
    resetCurrentChatState,
    allChatRuns,
    beginNewChatView,
    chatRunForChannel,
    chatRunForSession,
    currentChatRun,
    syncCurrentChatRun,
    registerChatRun,
    unregisterChatRun,
    sessionHasActiveChatRun,
    sessionActionSuccessLabel,
    enterSettings,
    openSettingsSection,
    loadArchivedSessions,
    setThemeMode,
  };
}
