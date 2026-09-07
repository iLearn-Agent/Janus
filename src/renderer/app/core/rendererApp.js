import {
  AGENT_DISPLAY_LABELS,
  ALL_ATTACHMENT_EXTENSIONS,
  IMAGE_ATTACHMENT_EXTENSIONS,
  IMAGE_MODEL_OPTIONS,
  MAX_UPLOAD_FILE_BYTES,
  RUN_STATUS_REFRESH_MS,
  USER_FACING_AGENT_IDS,
  modelCatalogEntry,
  reasoningOptionsForModel,
  textModelOptions,
} from '../constants.js';
import { isCurrentUserAdmin, state } from '../state.js';
import { loadCompletedConversationKeys, loadCompletedConversationTimes, loadComposerDrafts, loadConversationGroups, loadDirectoryStars, loadGroupDirectoryPreferences, loadMessageDefaultOrder, loadOrganizationShareLinks, loadRecentAccountWorkspaceIds, loadRememberedLoginIdentifier, loadUpdateAnnouncementPreferences, saveCompletedConversationKeys, saveCompletedConversationTimes, saveComposerDrafts, saveComposerFavoriteEmojis, saveComposerRecentEmojis, saveContactsListRatio, saveConversationGroups, saveConversationZoomPercent, saveDirectoryStars, saveGroupDirectoryPreferences, saveLanguageMode, saveMessageDefaultOrder, saveMessagePanelWidth, saveNetworkDirectorySectionsOpen, saveOrganizationShareLinks, savePrivateAssistantPermission, saveRecentAccountWorkspaceIds, saveRememberedLoginIdentifier, saveRunLogVisible, saveSandboxPermission, saveThemeMode, saveUpdateAnnouncementPreferences } from '../storage.js';
import { installLocalizedNativeDialogs, localizeDom, normalizeLanguage, translateUBuddyMessageText, translateUiText, translateUserVisibleError } from '../i18n.js';
import { uBuddyControlMessageKind, uBuddyControlMessageText } from '../../../shared/uBuddyControlMessages.js';
import { toggleMessageReaction } from '../../../shared/messageReactions.js';
import { organizationAccountWorkspaceId } from '../../../shared/accountWorkspaces.js';
import { renderDesktopDialog, renderMemoryNameModal, renderNotice, renderPreviewModal, renderRenameSessionModal, renderSocialEditModal, renderWindowTitlebar } from '../components/overlays.js';
import { renderAgentWorkStatus } from '../components/agentWorkStatus.js';
import { renderChatGroupInviteDialog } from '../components/chatGroupDialogs.js';
import {
  clipInline,
  escapeAttr,
  escapeHtml,
  formatBytes,
  formatMessageTime,
  janusBrandText,
  shortHash,
  stripAttachmentResourceBlock,
  stripHiddenMarkdownBlocks,
  userVisibleErrorMessage,
} from '../utils/format.js';
import { normalizeFilePayload } from '../utils/filePayload.js';
import { EMOJI_FAVORITE_MAX_BYTES, emojiFavoriteKey, isSupportedEmojiFavoriteFile, normalizeEmojiFavorite, normalizeEmojiFavorites } from '../../../shared/emojiFavorites.js';
import { findPersistedRewriteMessage } from '../utils/messageRewrite.js';
import { updateChatGroupMemberSelection } from '../utils/chatGroupMemberSelection.js';
import { socialMentionTriggerRemoved } from '../utils/mentionPicker.js';
import { mergeTaskWorkspaceMessages, mergeTaskWorkspaceSnapshot } from '../utils/taskWorkspaceMerge.js';
import { wireUserAvatarFallbacks } from '../utils/avatar.js';
import { pathBasename } from '../utils/path.js';
import { resolveSessionAgentIdentity, sessionMatchesAgentQuery } from '../utils/sessionAgentIdentity.js';
import { createPickerMentionEntity, mentionDeletionRange, normalizeMentionEntities } from '../../../shared/contracts/mentions.js';
import { messageReceiptPopoverLayout } from '../utils/messageReceiptLayout.js';
import { publicDelegationSubmissionText } from '../../../shared/contracts/delegation.js';
import { TASK_CARD_ACTIONS, isTaskCardAction, normalizeTaskSourceContext } from '../../../shared/contracts/taskCard.js';
import { normalizePptStyleId } from '../../../shared/pptAgents.js';
import { normalizeMessageQuote } from '../../../shared/contracts/messageQuote.js';
import { applyAgentWorkStatusProjection, normalizeAgentWorkStatusProjectionEnvelope, sanitizePublicWorkStatusText } from '../../../shared/contracts/uBuddyWorkStatus.js';
import { iconSvg } from '../ui/icons.js';
import {
  SOCIAL_TASK_GROUP_TYPE,
  createSocialTaskGroupId,
  latestSocialTaskGroup,
  socialTaskGroupById,
  socialTaskGroups,
  socialMentionTokens,
} from '../utils/socialTaskGroups.js';
import { renderPlugins } from '../features/plugins/index.js';
import { applyDelegationNoticeUpsert, applyDelegationTaskUpdate, contactDirectoryRelationships, createFriendsController, createNetworkMessageController, createNetworkWorkspaceController, renderContactsWorkspace, renderGroupProfileDialog, renderNetworkPanel } from '../features/network/index.js';
import { createEvolutionController, renderEvolution } from '../features/evolution/index.js';
import { renderPersonalEvolution } from '../features/personalEvolution/index.js';
import { renderEmployeeOverlays, renderEmployees } from '../features/employees/index.js';
import { renderJanusApp } from '../features/janusApp/index.js';
import { cycleMessageDefaultVariant, renderMessageDefaultPage, reorderMessageDefaultVariants } from '../views/messageHomeView.js';
import { renderUpdateAnnouncementDialog } from '../views/releaseNotesView.js';
import { createAuthController, createRuntimeSettingsController, renderAuthPanel, renderSettings } from '../features/settings/index.js';
import {
  composerCapabilities,
  compressChatContextWithRefresh,
  createComposerDraftController,
  createAttachmentController,
  createChatRunController,
  createMessageSendController,
  agentConversationCompletionKeys,
  currentModelValue,
  defaultModelMenuPlacement,
  currentPptTemplate,
  currentPptTemplateValue,
  currentReasoningValue,
  hidePptTemplatePreview,
  isImageComposerMode,
  isPrivateAssistantComposerMode,
  isUBuddyComposerMode,
  movePptTemplatePreview,
  parseArtifactMessage,
  renderChat,
  renderMessageList,
  renderMessagePatchSet,
  messageSupportsReactions,
  renderUBuddyCenterDrawer,
  renderUBuddyTaskDrawer,
  renderUBuddyTaskStrip,
  resetChatContextWithRefresh,
  resetPrivateAssistantContextWithRefresh,
  scheduleComposerMetaMenuPlacement,
  showPptTemplatePreview,
  workspaceDisplayLabel,
} from '../features/chat/index.js';
import {
  createProjectComposerController,
  createSessionNavigationController,
  mergeEmployeeConversationOverview,
  activeProject,
  projectById,
  projectName,
  isProjectExpanded,
  renderChatSearchModal,
  renderSettingsSidebar,
  renderSidebar,
  renderTopbar,
  primaryNavigationNotice,
} from '../features/navigation/index.js';
import { configureCollaborationView, createCollaborationController, renderCollaboration } from '../features/collaboration/index.js';
import { createDesktopEditHistory } from '../platform/editHistory.js';
import { createDesktopMenuController } from '../features/shell/index.js';
import { createUpdatesController } from '../features/updates/index.js';
import { createFollowerController, renderFollowerWorkspace } from '../features/follower/index.js';
import {
  agentWorkStatusFor,
  applyAgentWorkStatusUpdates,
  applyCoordinationUpdate,
  applyEmployeeWorkStatusSnapshot,
  agentWorkEventMatchesWorkspace,
  coordinationForTask,
  shouldApplyAgentTaskProgress,
} from '../features/ubuddy/coordinationState.js';
import { hydrateUBuddyTaskViews, mergeUBuddyTaskView, taskBelongsToSession, uBuddyPendingTaskCount } from '../features/ubuddy/taskDisplayState.js';
import { createLatestRequestCoordinator } from '../features/chat/latestRequestCoordinator.js';
import { renderUBuddyCoordinationPanels } from '../views/ubuddyCoordinationView.js';
import { isLegacyChatDepartmentId } from '../../../shared/departments.js';
import { normalizeReleaseVersion, releaseAnnouncementForVersion } from '../../../shared/releaseAnnouncements.js';
import { buildOrganizationInviteLink, parseOrganizationInviteLink } from '../../../shared/organizationInvites.js';

const app = document.getElementById('app');
const nativeWindowFrame = false;
installLocalizedNativeDialogs(window, () => state.languageMode);
let removeCodexListener = null;
let removeChatSessionUpdatedListener = null;
let removeChatUserInputWindowListener = null;
let removeUpdateListener = null;
let removeAgentUpdateListener = null;
let removeDesktopLifecycleListener = null;
let removeCodexPluginsChangedListener = null;
let removeAttachedSkillsChangedListener = null;
let removeEvolutionProgressListener = null;
let removeModelsListener = null;
let removeSocialListener = null;
let removeEmployeesUpdatedListener = null;
let removeAgentDeliveryListener = null;
let removeTaskUpdateListener = null;
let removeAgentAvailabilityListener = null;
let removeSocialOpenTaskListener = null;
let removeSystemOpenConversationListener = null;
let removeSystemOpenAgentSessionListener = null;
let removeSystemOpenUpdatesListener = null;
let removeSystemOpenFollowerListener = null;
let removeDesktopNotificationListener = null;
let removePptxPluginProgressListener = null;
let noticeTimer = null;
let noticeEnterTimer = null;
let noticeExitTimer = null;
let noticeDeadline = 0;
let noticeRemainingMs = 0;
let noticePaused = false;
const NOTICE_ENTER_MS = 220;
const NOTICE_EXIT_MS = 180;
let modelPlacementTimer = null;
let responsiveLayoutTimer = null;
let chatSearchTimer = null;
let projectReferenceQueryTimer = null;
let projectReferenceRequestSequence = 0;
let taskReferenceOptionsRequestSequence = 0;
let networkMessageSearchTimer = null;
let contactsEmployeeClickTimer = null;
let contactsGroupClickTimer = null;
let contactsContactClickTimer = null;
let activeContactProfileAnimation = null;
let messageDefaultRotationTimer = null;
let messageDefaultDraggedVariantId = -1;
let messageDefaultDragMoved = false;
let employeeMarketSpotlightTimer = null;
let conversationZoomIndicatorTimer = null;
let organizationInviteClipboardCheckBusy = false;
let persistentNavigationEventsInstalled = false;
let persistentDocumentEventsInstalled = false;
let socialReceiptRefreshTimer = null;
let socialReceiptRefreshBusy = false;
let lastSlowRenderReportAt = 0;
const CONVERSATION_ZOOM_LEVELS = Object.freeze([80, 90, 100, 110, 125, 140, 160]);

function responsiveLayoutModeForWidth(width = window.innerWidth) {
  const value = Math.max(0, Number(width || 0));
  if (value <= 900) return 'single';
  if (value < 1180) return 'compact';
  return 'wide';
}

function currentResponsiveLayoutMode() {
  return responsiveLayoutModeForWidth(document.documentElement.clientWidth || window.innerWidth || 0);
}

function responsiveMessagePanelWidth(requestedWidth = 360, layoutMode = 'wide') {
  const requested = Math.min(520, Math.max(280, Math.round(Number(requestedWidth) || 360)));
  if (layoutMode === 'single') return requested;
  const viewportWidth = Math.max(0, document.documentElement.clientWidth || window.innerWidth || 0);
  const expandedSidebarWidth = Math.min(208, Math.max(188, viewportWidth * 0.135));
  const sidebarWidth = state.sidebarCollapsed ? 72 : expandedSidebarWidth;
  const groupingWidth = layoutMode === 'wide' && state.messageGroupSidebarOpen ? 188 : 0;
  const minimumContentWidth = layoutMode === 'wide' ? 390 : 360;
  const available = viewportWidth - sidebarWidth - groupingWidth - minimumContentWidth - 32;
  return Math.min(requested, Math.max(280, Math.floor(available)));
}

function mergeTaskUpdateSnapshot(previous = null, incoming = null) {
  if (!incoming) return previous;
  const agentWorkStatusProjection = mergeAgentWorkStatusProjectionEnvelopes(
    previous?.agentWorkStatusProjection,
    incoming.agentWorkStatusProjection,
  );
  if (!incoming.eventHistoryPartial) return agentWorkStatusProjection
    ? { ...incoming, agentWorkStatusProjection }
    : incoming;
  const mergedEvents = Array.isArray(previous?.events) ? previous.events.map((event) => ({ ...event })) : [];
  const eventIndexes = new Map(mergedEvents.map((event, index) => [String(event?.id || event?.eventId || ''), index]));
  for (const event of incoming.events || []) {
    const key = String(event?.id || event?.eventId || '');
    const index = key ? eventIndexes.get(key) : undefined;
    if (index !== undefined) mergedEvents[index] = { ...mergedEvents[index], ...event };
    else {
      if (key) eventIndexes.set(key, mergedEvents.length);
      mergedEvents.push({ ...event });
    }
  }
  mergedEvents.sort((left, right) => {
    const created = String(left?.createdAt || '').localeCompare(String(right?.createdAt || ''));
    return created || String(left?.id || left?.eventId || '').localeCompare(String(right?.id || right?.eventId || ''));
  });
  return { ...previous, ...incoming, events: mergedEvents,
    ...(agentWorkStatusProjection ? { agentWorkStatusProjection } : {}) };
}

function updateEmployeeConversationWorkFromTask(task = null) {
  if (!task?.id) return [];
  const updated = updateEmployeeTaskProgressStatuses(task);
  const next = { ...(state.employeeConversationOverviewByInstanceId || {}) };
  for (const [agentInstanceId, overview] of Object.entries(next)) {
    if (String(overview?.activeWork?.taskRunId || '') !== String(task.id)) continue;
    const nodes = (task.nodes || []).filter((node) => (
      String(node.agentInstanceId || node.agent_instance_id || '').trim() === agentInstanceId
    ));
    const nodeIds = new Set(nodes.map((node) => String(node.id || '')).filter(Boolean));
    const activeNode = selectEmployeeTaskProgressNode(nodes);
    const blockedNode = nodes.find((node) => ['waiting', 'retry_wait', 'blocked', 'failed'].includes(String(node.status || ''))) || null;
    const projection = employeeTaskProjectionForAgent(task, agentInstanceId);
    const relatedEvents = (task.events || []).filter((event) => (
      employeeTaskProgressEventVisible(event)
      && nodeIds.has(String(event.taskNodeId || event.task_node_id || ''))
    ));
    const latestProgressEvent = latestEmployeeTaskProgressEvent(relatedEvents.filter((event) => (
      ['node_activity', 'node_progress'].includes(String(event.eventType || event.event_type || ''))
      && String(event.summary || '').trim()
    ))) || latestEmployeeTaskProgressEvent(relatedEvents.filter((event) => String(event.summary || '').trim()));
    const completed = nodes.filter((node) => String(node.status || '') === 'completed').length;
    const total = nodes.length;
    const currentAction = sanitizePublicWorkStatusText(projection?.currentAction || latestProgressEvent?.summary
      || activeNode?.title || task.summary || overview.activeWork?.currentAction || '', 500);
    const updatedAt = projection?.updatedAt || latestProgressEvent?.updatedAt || latestProgressEvent?.createdAt
      || task.updatedAt || activeNode?.updatedAt || overview.activeWork?.updatedAt || '';
    next[agentInstanceId] = {
      ...overview,
      activeWork: {
        ...(overview.activeWork || {}),
        title: task.title || overview.activeWork?.title || '正在处理任务',
        summary: task.summary || overview.activeWork?.summary || '',
        status: ['verifying', 'delivering'].includes(String(task.status || ''))
          ? String(task.status) : projection?.status || task.status || overview.activeWork?.status || '',
        currentStage: projection?.currentStage || (blockedNode ? 'blocked' : 'executing'),
        currentAction,
        progress: projection?.progress?.total ? projection.progress : {
          completed, total, percent: total ? Math.round((completed / total) * 100) : null,
        },
        nodes: nodes.slice(0, 12).map((node) => ({ id: node.id || '', title: node.title || '任务节点', status: node.status || 'pending' })),
        recentEvents: projection?.timeline?.length
          ? projection.timeline.slice(-5).map((event) => ({ id: event.id || '', type: event.sourceKind || '', summary: event.summary || '', status: event.status || '', createdAt: event.occurredAt || '' }))
          : sortEmployeeTaskProgressEvents(relatedEvents).slice(-5).map((event) => ({ id: event.id || '', type: event.eventType || '', summary: sanitizePublicWorkStatusText(event.summary, 500), status: event.status || event.payload?.status || '', createdAt: event.updatedAt || event.createdAt || '' })),
        blocker: projection?.blocker || (blockedNode ? { summary: blockedNode.waitReason || blockedNode.errorText || `${blockedNode.title || '任务节点'}暂时受阻。`, status: blockedNode.status || '' } : null),
        updatedAt,
      },
    };
    if (!updated.includes(agentInstanceId)) updated.push(agentInstanceId);
  }
  if (updated.length) state.employeeConversationOverviewByInstanceId = next;
  return updated;
}

function updateEmployeeTaskProgressStatuses(task = null) {
  const ids = taskAgentInstanceIds(task);
  if (!task?.id || !ids.length) return [];
  const nextStatuses = { ...(state.agentWorkStatusByInstanceId || {}) };
  if (['completed', 'failed', 'cancelled'].includes(String(task.status || ''))) {
    for (const agentInstanceId of ids) {
      const currentStatus = nextStatuses[agentInstanceId] || {};
      if (String(currentStatus.taskRunId || '') !== String(task.id)) continue;
      nextStatuses[agentInstanceId] = {
        agentInstanceId,
        name: currentStatus.name || '',
        agentFamilyId: currentStatus.agentFamilyId || '',
        availability: 'idle',
        workState: '',
        currentWork: '',
        taskRunId: '',
        accountWorkspaceId: currentStatus.accountWorkspaceId || '',
        updatedAt: task.updatedAt || currentStatus.updatedAt || '',
        statusSource: 'task_progress',
      };
    }
    state.agentWorkStatusByInstanceId = nextStatuses;
    return ids;
  }
  for (const agentInstanceId of ids) {
    const nodes = (task.nodes || []).filter((node) => (
      String(node.agentInstanceId || node.agent_instance_id || '').trim() === agentInstanceId
    ));
    const nodeIds = new Set(nodes.map((node) => String(node.id || '')).filter(Boolean));
    const projection = employeeTaskProjectionForAgent(task, agentInstanceId);
    const latestProgressEvent = latestEmployeeTaskProgressEvent((task.events || []).filter((event) => (
      employeeTaskProgressEventVisible(event)
      && nodeIds.has(String(event.taskNodeId || event.task_node_id || ''))
      && ['node_activity', 'node_progress'].includes(String(event.eventType || event.event_type || ''))
      && String(event.summary || '').trim()
    )));
    const activeNode = selectEmployeeTaskProgressNode(nodes);
    const currentAction = sanitizePublicWorkStatusText(
      projection?.currentAction || latestProgressEvent?.summary || activeNode?.title || task.summary || '', 500,
    );
    if (!currentAction) continue;
    const updatedAt = projection?.updatedAt || latestProgressEvent?.updatedAt || latestProgressEvent?.createdAt
      || activeNode?.updatedAt || task.updatedAt || '';
    const currentStatus = nextStatuses[agentInstanceId] || {};
    if (!shouldApplyAgentTaskProgress(currentStatus, task.id)) continue;
    const projectedTime = Date.parse(updatedAt || '') || 0;
    const currentTime = Date.parse(currentStatus.updatedAt || '') || 0;
    if (projectedTime < currentTime) continue;
    const projectedStatus = String(projection?.status || activeNode?.status || task.status || 'running');
    nextStatuses[agentInstanceId] = {
      ...currentStatus,
      agentInstanceId,
      availability: 'working',
      workState: ['waiting', 'retry_wait', 'blocked'].includes(projectedStatus) ? 'blocked'
        : ['pending', 'ready'].includes(projectedStatus) ? 'reserved'
          : projectedStatus === 'queued' ? 'queued' : 'running',
      currentWork: currentAction,
      taskRunId: String(task.id),
      updatedAt,
      statusSource: 'task_progress',
    };
  }
  state.agentWorkStatusByInstanceId = nextStatuses;
  return ids;
}

function latestEmployeeTaskProgressEvent(events = []) {
  return sortEmployeeTaskProgressEvents(events).at(-1) || null;
}

function sortEmployeeTaskProgressEvents(events = []) {
  return [...events].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.updated_at || left.createdAt || left.created_at || '') || 0;
    const rightTime = Date.parse(right.updatedAt || right.updated_at || right.createdAt || right.created_at || '') || 0;
    return leftTime - rightTime || String(left.id || left.eventId || '').localeCompare(String(right.id || right.eventId || ''));
  });
}

function employeeTaskProgressEventVisible(event = {}) {
  const activityType = String(event.payload?.activityType || '').toLowerCase();
  return activityType !== 'reasoning'
    && !/prompt|protocol|raw_response/i.test(String(event.eventType || event.event_type || ''));
}

function selectEmployeeTaskProgressNode(nodes = []) {
  const rank = { running: 0, blocked: 1, waiting: 1, retry_wait: 1, queued: 2, ready: 3, pending: 4 };
  return [...nodes].filter((node) => Object.hasOwn(rank, String(node.status || '')))
    .sort((left, right) => (rank[String(left.status || '')] ?? 9) - (rank[String(right.status || '')] ?? 9)
      || String(right.updatedAt || right.updated_at || '').localeCompare(String(left.updatedAt || left.updated_at || '')))[0]
    || nodes.at(-1) || null;
}

function employeeTaskProjectionForAgent(task = null, agentInstanceId = '') {
  const envelope = normalizeAgentWorkStatusProjectionEnvelope(
    task?.agentWorkStatusProjection || task?.metadata?.agentWorkStatusProjection || {},
  );
  return envelope.actors.find((actor) => (
    String(actor.agentInstanceId || '').trim() === String(agentInstanceId || '').trim()
  )) || null;
}

function taskAgentInstanceIds(task = null) {
  return [...new Set((Array.isArray(task?.nodes) ? task.nodes : [])
    .map((node) => String(node.agentInstanceId || node.agent_instance_id || '').trim())
    .filter(Boolean))];
}

async function refreshEmployeeConversationOverview(agentInstanceId = '', { renderAfter = true } = {}) {
  const id = String(agentInstanceId || '').trim();
  if (!id || typeof window.janus.employeeConversationOverview !== 'function') return null;
  const requestVersion = Number(employeeConversationOverviewRequestByInstanceId.get(id) || 0) + 1;
  employeeConversationOverviewRequestByInstanceId.set(id, requestVersion);
  const userId = String(state.currentUser?.id || '');
  const workspaceId = String(state.activeAccountWorkspace?.id || 'workspace_personal');
  const overview = await window.janus.employeeConversationOverview({ agentInstanceId: id }).catch(() => null);
  if (!overview
    || employeeConversationOverviewRequestByInstanceId.get(id) !== requestVersion
    || String(state.currentUser?.id || '') !== userId
    || String(state.activeAccountWorkspace?.id || 'workspace_personal') !== workspaceId
    || String(overview.resolvedAgentInstanceId || id) !== id) return null;
  const previousOverview = state.employeeConversationOverviewByInstanceId?.[id] || null;
  state.employeeConversationOverviewByInstanceId = {
    ...(state.employeeConversationOverviewByInstanceId || {}),
    [id]: mergeEmployeeConversationOverview(
      previousOverview,
      overview,
      state.agentWorkStatusByInstanceId?.[id],
    ),
  };
  if (renderAfter && state.currentTab === 'chat' && String(state.currentAgentInstanceId || '') === id) render();
  return overview;
}

function mergeAgentWorkStatusProjectionEnvelopes(previousValue = null, incomingValue = null) {
  if (!incomingValue) return previousValue;
  const incoming = normalizeAgentWorkStatusProjectionEnvelope(incomingValue);
  if (!previousValue) return incoming;
  const previous = normalizeAgentWorkStatusProjectionEnvelope(previousValue);
  if (previous.scopeKind !== incoming.scopeKind || previous.scopeId !== incoming.scopeId) return incoming;
  const actors = new Map(previous.actors.map((actor) => [actor.projectionId, actor]));
  for (const actor of incoming.actors) {
    const current = actors.get(actor.projectionId) || null;
    if (current && current.taskRunId === actor.taskRunId && current.delegationId === actor.delegationId
      && current.taskNodeId !== actor.taskNodeId && actor.sourceRevision > current.sourceRevision) {
      actors.set(actor.projectionId, actor);
      continue;
    }
    if (current && ['completed', 'failed'].includes(current.status)
      && ['reserved', 'queued', 'running', 'waiting', 'blocked'].includes(actor.status)
      && ['executing', 'verifying'].includes(actor.currentStage)
      && actor.sourceRevision > current.sourceRevision) {
      actors.set(actor.projectionId, actor);
      continue;
    }
    const applied = applyAgentWorkStatusProjection(current, actor);
    if (!current || applied.action === 'applied') actors.set(actor.projectionId, applied.projection);
  }
  const updatedAt = [...actors.values()].map((actor) => actor.updatedAt).filter(Boolean).sort().at(-1)
    || incoming.updatedAt || previous.updatedAt;
  return normalizeAgentWorkStatusProjectionEnvelope({ ...incoming, actors: [...actors.values()], updatedAt });
}
let lastHandledOrganizationInviteLink = '';
const employeeCommandSettlementTrackers = new Map();
let employeeOverviewRefreshSequence = 0;
let employeeOverviewRefreshPromise = null;
let employeeOverviewRefreshMode = '';
let employeeChatOpenRequestId = 0;
const employeeConversationOverviewRequestByInstanceId = new Map();
const messagePageRequestCoordinator = createLatestRequestCoordinator();
const externalSessionRefreshes = new Map();

function reportRendererEvent(level, event, error = null, data = undefined) {
  if (!window.janus?.reportRendererEvent) return;
  Promise.resolve(window.janus.reportRendererEvent({
    level,
    event,
    message: String(error?.message || event || 'renderer_event').slice(0, 2_000),
    data,
    error: error ? {
      name: String(error.name || 'Error'),
      code: String(error.code || ''),
      message: String(error.message || error),
      stack: String(error.stack || ''),
    } : undefined,
  })).catch(() => {});
}

async function loadLatestRendererMessagePage(sessionId = '', limit = 80, { coordinate = true } = {}) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) return null;
  const requestVersion = coordinate ? messagePageRequestCoordinator.begin(cleanSessionId) : 0;
  const agentInstanceId = coordinate
    && String(state.currentSessionId || '') === cleanSessionId
    && state.messagePagination?.source === 'agent'
    ? String(state.messagePagination?.agentInstanceId || state.currentAgentInstanceId || '').trim()
    : '';
  let page;
  if (agentInstanceId && typeof window.janus.agentConversationTimeline === 'function') {
    const timeline = await window.janus.agentConversationTimeline({ agentInstanceId, limit: Math.max(limit, 200) });
    page = {
      items: messagesFromAgentTimeline(timeline?.items || [], agentInstanceId),
      nextCursor: timeline?.nextCursor || null,
      hasMore: Boolean(timeline?.nextCursor),
      source: 'agent',
      agentInstanceId,
    };
  } else if (typeof window.janus.listMessagePage === 'function') {
    page = await window.janus.listMessagePage({ sessionId: cleanSessionId, limit });
  } else {
    const items = await window.janus.listMessages(cleanSessionId);
    page = { items, nextCursor: null, hasMore: false };
  }
  return {
    ...(page || {}),
    ...(coordinate ? {
      rendererMessagePageSessionId: cleanSessionId,
      rendererMessagePageRequestVersion: requestVersion,
    } : {}),
  };
}

function applyLatestRendererMessagePage(sessionId = '', page = null) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!page
    || String(state.currentSessionId || '') !== cleanSessionId
    || String(page.rendererMessagePageSessionId || '') !== cleanSessionId
    || !messagePageRequestCoordinator.isLatest(cleanSessionId, page.rendererMessagePageRequestVersion)) return false;
  state.messages = Array.isArray(page.items) ? page.items : [];
  state.messagePagination = {
    sessionId: cleanSessionId,
    source: page.source || 'session',
    agentInstanceId: page.source === 'agent' ? String(page.agentInstanceId || state.currentAgentInstanceId || '') : '',
    nextCursor: page.nextCursor || null,
    hasMore: Boolean(page.hasMore),
    loading: false,
    initialLoading: false,
  };
  state.preloadedMessagePagesBySessionId = {
    ...(state.preloadedMessagePagesBySessionId || {}),
    [cleanSessionId]: {
      items: state.messages,
      source: state.messagePagination.source,
      agentInstanceId: state.messagePagination.agentInstanceId || '',
      nextCursor: state.messagePagination.nextCursor,
      hasMore: state.messagePagination.hasMore,
    },
  };
  syncCurrentChatRun();
  restoreActiveRunTransient();
  return true;
}

function refreshExternallyUpdatedSession(payload = {}) {
  const sessionId = String(payload.sessionId || '').trim();
  const payloadAgentInstanceId = String(payload.agentInstanceId || '').trim();
  const payloadUserId = String(payload.userId || '').trim();
  const payloadWorkspaceId = String(payload.accountWorkspaceId || payload.workspaceId || '').trim();
  const currentUserId = String(state.currentUser?.id || '').trim();
  const currentWorkspaceId = String(state.activeAccountWorkspace?.id || 'workspace_personal').trim();
  if (!sessionId || !payloadUserId || payloadUserId !== currentUserId
    || !payloadWorkspaceId || payloadWorkspaceId !== currentWorkspaceId) return Promise.resolve(false);

  const currentSessionId = String(state.currentSessionId || '').trim();
  const currentAgentInstanceId = state.messagePagination?.source === 'agent'
    ? String(state.messagePagination?.agentInstanceId || state.currentAgentInstanceId || '').trim()
    : '';
  const refreshesActiveAgent = Boolean(
    payloadAgentInstanceId && currentAgentInstanceId === payloadAgentInstanceId,
  );
  const messageSessionId = refreshesActiveAgent ? currentSessionId : sessionId;
  const shouldRefreshMessages = Boolean(
    messageSessionId && (currentSessionId === sessionId || refreshesActiveAgent),
  );
  const workspaceGeneration = state.workspaceSwitchGeneration;
  const refreshKey = refreshesActiveAgent ? `agent:${payloadAgentInstanceId}` : `session:${sessionId}`;
  const previous = externalSessionRefreshes.get(refreshKey) || Promise.resolve();
  const refresh = previous.catch(() => {}).then(async () => {
    const [sessionsResult, messagePageResult] = await Promise.allSettled([
      window.janus.listSessions(),
      shouldRefreshMessages
        ? loadLatestRendererMessagePage(messageSessionId)
        : Promise.resolve(null),
    ]);
    if (workspaceGeneration !== state.workspaceSwitchGeneration
      || String(state.currentUser?.id || '') !== payloadUserId
      || String(state.activeAccountWorkspace?.id || 'workspace_personal') !== payloadWorkspaceId) return false;
    if (sessionsResult.status === 'fulfilled') state.sessions = sessionsResult.value || state.sessions;
    const activeAgentInstanceId = state.messagePagination?.source === 'agent'
      ? String(state.messagePagination?.agentInstanceId || state.currentAgentInstanceId || '').trim()
      : '';
    const targetStillActive = String(state.currentSessionId || '').trim() === messageSessionId
      && (!refreshesActiveAgent || activeAgentInstanceId === payloadAgentInstanceId);
    const applied = targetStillActive && messagePageResult.status === 'fulfilled' && messagePageResult.value
      ? applyLatestRendererMessagePage(messageSessionId, messagePageResult.value)
      : false;
    if (sessionsResult.status === 'fulfilled' || applied) render();
    return applied;
  }).finally(() => {
    if (externalSessionRefreshes.get(refreshKey) === refresh) externalSessionRefreshes.delete(refreshKey);
  });
  externalSessionRefreshes.set(refreshKey, refresh);
  return refresh;
}

function messagesFromAgentTimeline(items = [], agentInstanceId = '') {
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

window.addEventListener('error', (event) => {
  reportRendererEvent('error', 'renderer-window-error', event.error || new Error(event.message || 'Renderer error'), {
    lineNumber: event.lineno || 0,
    columnNumber: event.colno || 0,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason || 'Unhandled renderer rejection'));
  reportRendererEvent('error', 'renderer-unhandled-rejection', error);
});

function noteDirectoryGroups(overview = {}, { initialize = false } = {}) {
  const nextIds = [...new Set((Array.isArray(overview?.groups) ? overview.groups : []).map((group) => String(group?.id || '').trim()).filter(Boolean))];
  if (!state.networkDirectoryGroupsInitialized || initialize) {
    state.networkDirectoryKnownGroupIds = nextIds;
    state.networkDirectoryGroupsInitialized = true;
    if (initialize) state.networkDirectoryNewGroupIds = [];
    return;
  }
  const known = new Set(state.networkDirectoryKnownGroupIds || []);
  const pending = new Set(state.networkDirectoryNewGroupIds || []);
  if (state.networkDirectorySectionsOpen?.groups === false) {
    nextIds.filter((id) => !known.has(id)).forEach((id) => pending.add(id));
  }
  const current = new Set(nextIds);
  state.networkDirectoryKnownGroupIds = nextIds;
  state.networkDirectoryNewGroupIds = [...pending].filter((id) => current.has(id));
}

function persistComposerDrafts() {
  saveComposerDrafts(rendererWorkspaceStorageScope(), {
    composerDraftsVersion: state.composerDraftsVersion || 2,
    composerDraftsBySurface: state.composerDraftsBySurface || {},
    agentConversationDrafts: state.agentConversationDrafts || {},
    networkConversationDrafts: state.networkConversationDrafts || {},
    networkDelegationCommentDrafts: state.networkDelegationCommentDrafts || {},
    externalDelegationDeliveryDrafts: state.externalDelegationDeliveryDrafts || {},
  });
}

function hydrateComposerDrafts() {
  const scope = rendererWorkspaceStorageScope();
  const userScope = String(state.currentUser?.id || '').trim();
  const drafts = loadComposerDrafts(scope);
  const conversationGroups = loadConversationGroups(scope);
  state.agentConversationDrafts = drafts.agentConversationDrafts || {};
  state.networkConversationDrafts = drafts.networkConversationDrafts || {};
  state.networkDelegationCommentDrafts = drafts.networkDelegationCommentDrafts || {};
  state.externalDelegationDeliveryDrafts = drafts.externalDelegationDeliveryDrafts || {};
  composerDraftController.hydrate(drafts);
  state.completedConversationKeys = loadCompletedConversationKeys(scope);
  state.completedConversationTimes = loadCompletedConversationTimes(scope);
  const legacyCompletionBaseline = Date.now();
  let completionTimesMigrated = false;
  for (const key of state.completedConversationKeys) {
    if (Number(state.completedConversationTimes[key] || 0) > 0) continue;
    state.completedConversationTimes[key] = legacyCompletionBaseline;
    completionTimesMigrated = true;
  }
  if (completionTimesMigrated) saveCompletedConversationTimes(scope, state.completedConversationTimes);
  state.markedConversationKeys = conversationGroups.marked;
  state.unreadConversationKeys = conversationGroups.unread;
  state.directoryStars = loadDirectoryStars(userScope);
  state.groupDirectoryPreferences = loadGroupDirectoryPreferences(userScope);
  state.organizationShareLinks = {
    ...loadOrganizationShareLinks(scope),
    ...loadOrganizationShareLinks(userScope),
  };
  if (userScope && Object.keys(state.organizationShareLinks).length) {
    saveOrganizationShareLinks(userScope, state.organizationShareLinks);
  }
  state.messageDefaultVariantOrder = loadMessageDefaultOrder(scope);
  if (!state.messageDefaultVariantOrder.includes(state.messageDefaultVariantIndex)) {
    state.messageDefaultVariantIndex = state.messageDefaultVariantOrder[0] || 0;
  }
  state.messageDefaultOrderEditorOpen = false;
}

function preserveAgentConversationDraft(agentInstanceId = state.currentAgentInstanceId) {
  const id = String(agentInstanceId || '').trim();
  if (!id) return;
  const value = composerDraftController.capture(`agent:${id}`, { persistAfter: false });
  const drafts = { ...(state.agentConversationDrafts || {}) };
  if (value) drafts[id] = value;
  else delete drafts[id];
  state.agentConversationDrafts = drafts;
  persistComposerDrafts();
}

function restoreAgentConversationDraft(agentInstanceId = '') {
  const id = String(agentInstanceId || '').trim();
  composerDraftController.restore(id ? `agent:${id}` : '', {
    fallbackText: id ? String(state.agentConversationDrafts?.[id] || '') : '',
  });
}

function clearAgentConversationDraft(agentInstanceId = '') {
  const id = String(agentInstanceId || '').trim();
  if (!id || !Object.hasOwn(state.agentConversationDrafts || {}, id)) return;
  const drafts = { ...(state.agentConversationDrafts || {}) };
  delete drafts[id];
  state.agentConversationDrafts = drafts;
  composerDraftController.clear(`agent:${id}`);
}

function rendererWorkspaceStorageScope() {
  const userId = String(state.currentUser?.id || '').trim();
  const workspaceId = String(state.activeAccountWorkspace?.id || 'workspace_personal').trim();
  return userId ? `${userId}:${workspaceId}` : '';
}

function syncRecentAccountWorkspaceState() {
  const userId = String(state.currentUser?.id || '').trim();
  if (!userId) {
    state.recentAccountWorkspaceIds = [];
    state.recentAccountWorkspaceUserId = '';
    state.accountMenuWorkspaceMoreOpen = false;
    return;
  }
  const accountChanged = state.recentAccountWorkspaceUserId !== userId;
  const storedIds = accountChanged
    ? loadRecentAccountWorkspaceIds(userId)
    : (Array.isArray(state.recentAccountWorkspaceIds) ? state.recentAccountWorkspaceIds : []);
  const workspaceIds = new Set((Array.isArray(state.accountWorkspaces) ? state.accountWorkspaces : [])
    .filter((workspace) => workspace?.id)
    .map((workspace) => workspace.id));
  const activeWorkspaceId = String(state.activeAccountWorkspace?.id || '');
  const nextIds = [...new Set([activeWorkspaceId, ...storedIds])]
    .filter((workspaceId) => workspaceId && workspaceIds.has(workspaceId));
  const changed = accountChanged || nextIds.length !== storedIds.length
    || nextIds.some((workspaceId, index) => workspaceId !== storedIds[index]);
  state.recentAccountWorkspaceUserId = userId;
  state.recentAccountWorkspaceIds = nextIds;
  if (changed) saveRecentAccountWorkspaceIds(userId, nextIds);
}

function reactivateAgentConversation({ sessionId = '', agentId = '', agentInstanceId = '' } = {}) {
  const keys = agentConversationCompletionKeys({ sessionId, agentId, agentInstanceId });
  if (!keys.length) return false;
  const completed = new Set(state.completedConversationKeys || []);
  const changed = keys.reduce((removed, key) => completed.delete(key) || removed, false);
  if (!changed) return false;
  state.completedConversationKeys = [...completed];
  const times = { ...(state.completedConversationTimes || {}) };
  keys.forEach((key) => delete times[key]);
  state.completedConversationTimes = times;
  saveCompletedConversationKeys(rendererWorkspaceStorageScope(), state.completedConversationKeys);
  saveCompletedConversationTimes(rendererWorkspaceStorageScope(), state.completedConversationTimes);
  return true;
}

function setConversationCompleted(key = '', completed = true) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return;
  const keys = new Set(state.completedConversationKeys || []);
  const times = { ...(state.completedConversationTimes || {}) };
  if (completed) {
    keys.add(cleanKey);
    times[cleanKey] = Date.now();
  } else {
    keys.delete(cleanKey);
    delete times[cleanKey];
  }
  state.completedConversationKeys = [...keys];
  state.completedConversationTimes = times;
  saveCompletedConversationKeys(rendererWorkspaceStorageScope(), state.completedConversationKeys);
  saveCompletedConversationTimes(rendererWorkspaceStorageScope(), state.completedConversationTimes);
}

function persistDirectoryStars() {
  saveDirectoryStars(String(state.currentUser?.id || '').trim(), state.directoryStars || {});
}

function directoryContactByUserId(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return null;
  const relationship = (state.friendOverview?.friends || []).find((item) => (
    String(item?.friend?.id || item?.user?.id || '') === id
  ));
  if (relationship) return relationship;
  for (const organization of state.friendOverview?.organizations || []) {
    const member = (organization?.members || []).find((item) => String(item?.user?.id || '') === id);
    if (member?.user) return { ...member, friend: member.user, organizationContact: true };
  }
  return null;
}

function contactLegacyStarred(item = {}) {
  const friend = item?.friend || item?.user || {};
  return Boolean(item.starred || item.favorite || item.favourite || item.pinned
    || friend.starred || friend.favorite || friend.favourite || friend.pinned);
}

function contactIsStarredById(userId = '') {
  const id = String(userId || '').trim();
  const overrides = state.directoryStars?.contacts || {};
  if (id && Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] === true;
  return contactLegacyStarred(directoryContactByUserId(id) || {});
}

function toggleContactStar(userId = '') {
  const id = String(userId || '').trim();
  const contact = directoryContactByUserId(id);
  if (!id || !contact || id === String(state.currentUser?.id || '')) return;
  const legacyStarred = contactLegacyStarred(contact);
  const nextStarred = !contactIsStarredById(id);
  const contacts = { ...(state.directoryStars?.contacts || {}) };
  if (nextStarred === legacyStarred) delete contacts[id];
  else contacts[id] = nextStarred;
  state.directoryStars = {
    contacts,
    employees: [...new Set(Array.isArray(state.directoryStars?.employees) ? state.directoryStars.employees : [])],
  };
  state.contactDirectoryContextMenu = null;
  persistDirectoryStars();
  notify(nextStarred ? '已设为星标联系人。' : '已取消星标联系人。', 'success');
  render();
}

function groupPreferenceKey(kind = '', groupId = '') {
  const cleanKind = kind === 'work' ? 'work' : 'contact';
  const cleanId = String(groupId || '').trim();
  return cleanId ? `${cleanKind}:${cleanId}` : '';
}

function persistGroupDirectoryPreferences() {
  saveGroupDirectoryPreferences(String(state.currentUser?.id || '').trim(), state.groupDirectoryPreferences || {});
}

function toggleGroupStar(kind = '', groupId = '') {
  const key = groupPreferenceKey(kind, groupId);
  if (!key) return;
  const starred = { ...(state.groupDirectoryPreferences?.starred || {}) };
  const nextStarred = starred[key] !== true;
  if (nextStarred) starred[key] = true;
  else delete starred[key];
  state.groupDirectoryPreferences = { ...(state.groupDirectoryPreferences || {}), starred };
  persistGroupDirectoryPreferences();
  notify(nextStarred ? '已设为星标群组。' : '已取消星标群组。', 'success');
  render();
}

function updateGroupRemark(kind = '', groupId = '', fallbackTitle = '') {
  const id = String(groupId || '').trim();
  if (!id || kind === 'work') return;
  const detail = chatGroupDetailById(id);
  const membership = detail?.membership || (detail?.members || []).find((member) => String(member.userId || '') === String(state.currentUser?.id || ''));
  state.socialEditDialog = { type: 'chat-group-remark', targetId: id, subtitle: '为这个群聊设置仅自己可见的备注', draft: membership?.remark || '', busy: false, error: '' };
  render();
  requestAnimationFrame(() => document.getElementById('social-edit-input')?.select());
}

function employeeIsStarredById(agentInstanceId = '') {
  const id = String(agentInstanceId || '').trim();
  const employees = Array.isArray(state.directoryStars?.employees) ? state.directoryStars.employees : [];
  return Boolean(id && employees.includes(id));
}

function toggleEmployeeStar(agentInstanceId = '') {
  const id = String(agentInstanceId || '').trim();
  if (!id || !(state.employeeOverview?.roster || []).some((item) => item.id === id)) return;
  const nextStarred = !employeeIsStarredById(id);
  const employeeIds = new Set(Array.isArray(state.directoryStars?.employees) ? state.directoryStars.employees : []);
  if (nextStarred) employeeIds.add(id);
  else employeeIds.delete(id);
  state.directoryStars = {
    contacts: { ...(state.directoryStars?.contacts || {}) },
    employees: [...employeeIds],
  };
  state.employeeContextMenu = null;
  persistDirectoryStars();
  notify(nextStarred ? '已设为星标员工。' : '已取消星标员工。', 'success');
  render();
}
let chatSearchRequestId = 0;
let chatSearchComposing = false;
let networkMessageSearchRequestId = 0;
const taskRunWorkspacePolls = new Map();
let networkMessageSearchComposing = false;
let directorySearchComposing = false;
let activeImeComposition = null;
let imeRenderDeferred = false;
let messageScrollFollow = true;
let messageScrollTop = 0;
let messageScrollInteracting = false;
let messageScrollPointerActive = false;
let messageScrollIdleTimer = null;
let messageScrollLayoutInteraction = false;
let messageScrollFollowEvaluation = 0;
let messageDisclosureScrollSnapshot = null;
let messageHistoryAutoLoadArmed = false;
let messageListResizeObserver = null;
let messageListMutationObserver = null;
let messageScrollLayoutFrame = 0;
let messageBottomSettleGeneration = 0;
let messageScrollRenderPending = false;
let sidebarScrollTop = 0;
let pendingSettingsScrollTop = null;
const MESSAGE_SCROLL_BOTTOM_TOLERANCE = 48;
const MESSAGE_LAYOUT_CONTROL_SELECTOR = 'details > summary, [data-long-message-toggle], [data-process-expand-all], [data-process-collapse-all]';
const PRESERVED_SCROLL_BOTTOM_THRESHOLD = 48;
const MESSAGE_SCROLL_INTERACTION_IDLE_MS = 180;
const RUN_UPDATE_THROTTLE_MS = 160;
const TASK_WORKSPACE_UPDATE_THROTTLE_MS = 400;
const TASK_WORKSPACE_SCROLL_IDLE_MS = 260;
const TASK_WORKSPACE_TYPING_IDLE_MS = 700;
let taskWorkspaceRenderTimer = null;
let taskWorkspaceRenderPending = false;
let taskWorkspaceLastRenderedAt = 0;
let taskWorkspaceInteractionUntil = 0;
let taskWorkspaceTypingUntil = 0;
let taskWorkspaceScrollInteracting = false;
function currentRendererMessageSurfaceKey() {
  return JSON.stringify([
    Number(state.workspaceSwitchGeneration || 0),
    state.currentTab || '',
    Boolean(state.networkPanelOpen),
    state.networkPanelView || '',
    Boolean(state.networkMessageHomeOpen),
    Boolean(state.followerWorkspaceOpen),
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
}
const composerDraftController = createComposerDraftController({
  state,
  readInputValue: () => document.getElementById('chat-input')?.value ?? null,
  persist: persistComposerDrafts,
});

function preserveCurrentComposerDraft() {
  const key = composerDraftController.surfaceKey();
  const value = composerDraftController.capture(key, { persistAfter: false });
  if (key.startsWith('agent:')) {
    const id = key.slice('agent:'.length);
    const drafts = { ...(state.agentConversationDrafts || {}) };
    if (value) drafts[id] = value;
    else delete drafts[id];
    state.agentConversationDrafts = drafts;
  } else {
    const legacyKey = legacyNetworkDraftKey(key);
    if (legacyKey) {
      const drafts = { ...(state.networkConversationDrafts || {}) };
      if (value) drafts[legacyKey] = value;
      else delete drafts[legacyKey];
      state.networkConversationDrafts = drafts;
    }
  }
  persistComposerDrafts();
  return value;
}

function restoreComposerDraft(surfaceKey = '', options = {}) {
  return composerDraftController.restore(surfaceKey || composerDraftController.surfaceKey(), options);
}

function clearComposerDraft(surfaceKey = '', options = {}) {
  const key = String(surfaceKey || composerDraftController.surfaceKey()).trim();
  if (key.startsWith('agent:')) {
    const drafts = { ...(state.agentConversationDrafts || {}) };
    delete drafts[key.slice('agent:'.length)];
    state.agentConversationDrafts = drafts;
  } else {
    const legacyKey = legacyNetworkDraftKey(key);
    if (legacyKey) {
      const drafts = { ...(state.networkConversationDrafts || {}) };
      delete drafts[legacyKey];
      state.networkConversationDrafts = drafts;
    }
  }
  return composerDraftController.clear(key, options);
}

function legacyNetworkDraftKey(surfaceKey = '') {
  const key = String(surfaceKey || '');
  if (key.startsWith('chat-group:') || key.startsWith('collaboration:')) return key;
  if (key.startsWith('social-direct:')) return `${key.slice('social-direct:'.length)}:person`;
  if (key.startsWith('social-group:')) {
    const remainder = key.slice('social-group:'.length);
    const separator = remainder.lastIndexOf(':');
    return separator >= 0 ? `${remainder.slice(0, separator)}:group:${remainder.slice(separator + 1)}` : '';
  }
  return '';
}
document.addEventListener('compositionstart', handleImeCompositionStart, true);
document.addEventListener('compositionend', handleImeCompositionEnd, true);
document.addEventListener('focusout', handleImeCompositionFocusOut, true);
document.addEventListener('paste', handleOrganizationInvitePaste, true);
const desktopEditHistory = createDesktopEditHistory({ documentRef: document, EventCtor: Event });
const authController = createAuthController({
  api: window.janus,
  documentRef: document,
  state,
  render,
  notify,
  hydrateComposerDrafts,
  isCurrentUserAdmin,
  refreshReleaseStatus: (...args) => updatesController.refreshReleaseStatus(...args),
  refreshSocialThreads: (...args) => refreshSocialThreads(...args),
  loadRememberedLoginIdentifier,
  saveRememberedLoginIdentifier,
  userVisibleErrorMessage,
  localizeRoot: (root) => localizeDom(root, state.languageMode),
  translateText: (value) => translateUiText(value, state.languageMode),
  resetWorkspaceScopedState: resetWorkspaceScopedRendererState,
});
const {
  chooseProfileAvatar,
  loginAccount,
  logoutAccount,
  openAvatarViewer,
  refreshBootstrapAfterAuth,
  registerAccount,
  removeProfileAvatar,
  previewProfileAvatar,
  resetAuthUiState,
  resetPasswordByEmail,
  refreshEmailCodeButtonState,
  saveProfile,
  sendEmailCodeFromInput,
  syncAuthDraftFromDom,
  userErrorMessage,
} = authController;
const evolutionController = createEvolutionController({
  api: window.janus,
  state,
  render,
  notify,
  appendStatus,
  shortHash,
  runCodexConnectionTest: (...args) => runtimeSettingsController.runCodexConnectionTest(...args),
  notificationToneForConnectionTest: (...args) => runtimeSettingsController.notificationToneForConnectionTest(...args),
});
const {
  activateUBuddyOrganizationEvolution,
  applyMemoryPolicy,
  beginEvolutionProgress,
  calibrateGate,
  clearEvolutionDemoTimer,
  disableUBuddyOrganizationEvolution,
  evaluateSpecialistExperiment,
  finalizeSpecialistExperiment,
  finishEvolutionProgress,
  handleEvolutionProgress,
  labelArchive,
  refreshUBuddyOrganizationEvolution,
  rollbackSkill,
  runDoctor,
  runEvolution,
  startSpecialistExperiment,
} = evolutionController;
const sessionNavigationController = createSessionNavigationController({
  state,
  render,
  windowRef: window,
  documentRef: document,
  agentDisplayLabels: AGENT_DISPLAY_LABELS,
  isLegacyChatDepartmentId,
  retractNetworkPanelForChat: (...args) => networkWorkspaceController.retractNetworkPanelForChat(...args),
  focusChatInputAtEnd: (...args) => attachmentController.focusActiveComposerInput(...args),
  projectById,
  projectName,
  expandProject,
  notify,
  pathBasename,
  openUBuddyConversation: (...args) => networkWorkspaceController.openUBuddyConversation(...args),
  closeChatSearch,
  restoreActiveRunTransient: (...args) => chatRunController.restoreActiveRunTransient(...args),
  restorePersistentDeliveryRuns: (...args) => chatRunController.restorePersistentDeliveryRuns(...args),
  resetChatSearchState,
  resolveSelectedAgentId,
  scrollMessagesToBottom,
  findSessionById,
  normalizeSearch,
  scheduleChatSearch,
  sessionIsArchived,
  saveThemeMode,
  beginMessagePageRequest: (sessionId) => messagePageRequestCoordinator.begin(sessionId),
  messagePageRequestIsLatest: (sessionId, version) => messagePageRequestCoordinator.isLatest(sessionId, version),
  captureMessageViewState,
  restoreMessageViewState,
  refreshUBuddyTaskViewsForSession,
  preserveCurrentComposerDraft,
  restoreComposerDraft,
});
const {
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
} = sessionNavigationController;
const followerController = createFollowerController({
  api: window.janus,
  state,
  render: () => render({ allowFollowerFollowupRender: true }),
  notify,
  userVisibleErrorMessage,
  clearSocialChatSelection,
});
const removeFollowerUpdatedListener = followerController.removeUpdatedListener;

const attachmentController = createAttachmentController({
  api: window.janus,
  windowRef: window,
  documentRef: document,
  FileReaderCtor: FileReader,
  state,
  render,
  notify,
  formatBytes,
  normalizeFilePayload,
  messageTextForCopy,
  writeClipboardText,
  allExtensions: ALL_ATTACHMENT_EXTENSIONS,
  imageExtensions: IMAGE_ATTACHMENT_EXTENSIONS,
  maxUploadBytes: MAX_UPLOAD_FILE_BYTES,
});
const {
  attachContextFiles,
  attachmentAcceptValue,
  attachmentItemToMessagePayload,
  copyFilePath,
  copyImageFromPayload,
  copyMessageText,
  focusActiveComposerInput,
  imageAttachmentMode,
  installFileDropHandlers,
  materializeCollaborationFile,
  openFileFromPayload,
  pendingAttachmentsForMessage,
  previewAttachment,
  previewFileInfo,
  queueClipboardAttachments,
  queueAttachmentFiles,
  queueUploadedAttachments,
  readyAttachmentsForSend,
  retryAttachment,
  saveFileFromPayload,
  showFileFromPayload,
  updateLocalMessageAttachments,
} = attachmentController;
const projectComposerController = createProjectComposerController({
  api: window.janus,
  state,
  notify,
  render,
  normalizePathKey,
  pathBasename,
  saveSandboxPermission,
  focusChatInputAtEnd,
  currentChatRun,
  isUBuddyComposerMode,
  preserveChatDraftFromInput,
  upsertRecentSession,
  projectById,
});
const {
  clearWorkspaceSelection,
  removeWorkspaceProject,
  selectWorkspaceDirectory,
  selectWorkspaceProject,
  setComposerInteractionMode,
} = projectComposerController;

async function runGoalAction(sessionId = '', action = '', objective = '') {
  const session = (state.sessions || []).find((item) => item.id === sessionId);
  if (!session?.goal || state.goalActionBusy) return;
  if (state.busy || currentChatRun()) {
    notify('当前对话仍在运行，结束后再修改目标。', 'warning');
    return;
  }
  if (action === 'edit') {
    state.goalEditor = { sessionId, draft: session.goal.objective || '', busy: false, error: '' };
    render();
    setTimeout(() => document.querySelector('[data-goal-editor-input]')?.focus(), 0);
    return;
  }
  if (action === 'delete' && !window.confirm('确认删除当前目标？目标模式会保留，你可以继续创建新目标。')) return;
  state.goalActionBusy = sessionId;
  render();
  try {
    const updated = await window.janus.updateGoal({ sessionId, action });
    if (updated?.id) upsertRecentSession(updated);
    state.interactionMode = updated?.interactionMode || 'goal';
    notify(action === 'delete' ? '目标已删除。' : action === 'pause' ? '目标已暂停。' : '目标已继续。', 'success');
  } catch (error) {
    notify(`目标操作失败：${error.message || error}`, 'error');
  } finally {
    state.goalActionBusy = '';
    render();
  }
}

async function saveGoalEditor() {
  const editor = state.goalEditor;
  if (!editor?.sessionId || editor.busy) return;
  const input = document.querySelector('[data-goal-editor-input]');
  const objective = String(input?.value || editor.draft || '').trim();
  if (!objective) {
    state.goalEditor = { ...editor, draft: objective, error: '目标内容不能为空。' };
    render();
    return;
  }
  state.goalEditor = { ...editor, draft: objective, busy: true, error: '' };
  state.goalActionBusy = editor.sessionId;
  render();
  try {
    const updated = await window.janus.updateGoal({ sessionId: editor.sessionId, action: 'edit', objective });
    if (updated?.id) upsertRecentSession(updated);
    state.goalEditor = null;
    notify('目标已更新。', 'success');
  } catch (error) {
    state.goalEditor = { ...state.goalEditor, busy: false, error: error.message || String(error) };
  } finally {
    state.goalActionBusy = '';
    render();
  }
}
const chatRunController = createChatRunController({
  api: window.janus,
  windowRef: window,
  documentRef: document,
  state,
  render,
  localizeRoot: (root) => localizeDom(root, state.languageMode),
  translateText: (value) => translateUiText(value, state.languageMode),
  notify,
  userVisibleErrorMessage,
  chatRunForChannel,
  syncCurrentChatRun,
  upsertRecentSession,
  expandProject,
  agentNameById,
  departmentName,
  allChatRuns,
  currentChatRun,
  captureMessageScrollState,
  restoreMessageScrollState,
  suspendMessageAutoFollow: () => {
    messageScrollFollowEvaluation += 1;
    messageScrollFollow = false;
  },
  isMessageInteractionActive: () => messageScrollInteracting,
  renderMessageList,
  renderMessagePatchSet,
  parsePreviewPayload,
  previewFileInfo,
  saveFileFromPayload,
  showFileFromPayload,
  openFileFromPayload,
  copyFilePath,
  openCollaborationTask,
  submitUBuddyClarificationAnswer: (answer, context = {}) => sendChatMessage(answer, {
    preserveComposer: true,
    executionModeChoice: context.executionModeChoice || null,
    clarificationResponse: context.clarificationResponse || null,
    planningRestartSourceMessageId: context.planningRestartSourceMessageId || '',
  }),
  openUBuddyContactPicker: () => {
    state.uBuddyContactPickerOnly = true;
    state.composerMentionPickerMode = 'mention';
    state.chatDraft = state.languageMode === 'en'
      ? 'Have this contact complete the task discussed above. '
      : '由该联系人完成刚才讨论的任务。';
    state.socialMentionMenuOpen = true;
    state.composerMentionQuery = '';
    state.composerMentionActiveIndex = 0;
    state.composerMentionAnchorStart = 0;
    state.composerMentionAnchorEnd = 0;
    resetProjectReferenceBrowser();
    render();
    setTimeout(() => document.querySelector('[data-project-reference-query]')?.focus(), 0);
  },
  handleTaskCardAction: (button) => handleTaskCardAction(button),
  copyCodeBlockText,
  copyMessageText,
  editMessageFromHistory,
  pathBasename,
  projectForSession,
  activeProject,
  scrollMessagesToBottom,
  imageModelOptions: IMAGE_MODEL_OPTIONS,
  runStatusRefreshMs: RUN_STATUS_REFRESH_MS,
  runUpdateThrottleMs: RUN_UPDATE_THROTTLE_MS,
  reportPerformance: (event, data) => reportRendererEvent('warn', event, null, data),
});
const {
  assignmentLabelForRun,
  clearAgentRunNotices,
  clearRunTransientMessages,
  handleAgentDeliveryUpdate,
  handleChatUserInputWindowClosed,
  handleChatRunEvent,
  handleTaskUpdate,
  isRunForCurrentChat,
  renderRunUpdate,
  restoreActiveRunTransient,
  restorePersistentDeliveryRuns,
  stopRunStatusTimer,
  updateRunStatusMessage,
  wireMessageEvents,
} = chatRunController;
const collaborationController = createCollaborationController({
  api: window.janus,
  state,
  render,
  renderPreservingNetworkComposer: (...args) => networkWorkspaceController.renderPreservingNetworkComposer(...args),
  userErrorMessage,
  notify,
  preserveChatDraftFromInput,
  restoreComposerDraft,
  scrollMessagesToBottom,
  refreshBootstrapAfterAuth,
  documentRef: document,
  windowRef: window,
  cssEscape: CSS.escape,
  noteDirectoryGroups,
  syncCurrentChatRun,
  restoreActiveRunTransient,
  restorePersistentDeliveryRuns,
});
const {
  refreshSocialInbox,
  refreshSocialThreads,
  refreshAgentDelegations,
  refreshCollaborationOverview,
  refreshCollaborationGroupDetail,
  openCollaborationGroup,
  openCollaborationGroupWorkspace,
  closeCollaborationGroup,
  renameCollaborationGroup,
  saveCollaborationGroupName,
  addCollaborationGroupMember,
  closeCollaborationAddMemberPanel,
  confirmCollaborationGroupMember,
  removeCollaborationGroupMember,
  handleCollaborationTaskAction,
} = collaborationController;
const networkWorkspaceController = createNetworkWorkspaceController({
  api: window.janus,
  state,
  render,
  renderConversationTransition,
  notify,
  userErrorMessage,
  preserveChatDraftFromInput,
  restoreComposerDraft,
  focusChatInputAtEnd,
  refreshSocialInbox,
  refreshAgentDelegations,
  refreshSocialThreads,
  refreshCollaborationOverview,
  socialTaskGroups,
  socialTaskGroupById,
  latestSocialTaskGroup,
  socialTaskGroupType: SOCIAL_TASK_GROUP_TYPE,
  scrollMessagesToBottom,
  readyAttachmentsForSend,
  currentModelValue,
  currentReasoningValue,
  persistComposerDrafts,
  focusActiveComposerInput,
  materializeCollaborationFile,
  isCurrentUserAdmin,
  windowRef: window,
  documentRef: document,
  noteDirectoryGroups,
  currentChatRun,
  syncCurrentChatRun,
  restoreActiveRunTransient,
  openTaskRunWorkspace: openCollaborationTask,
  openAgentSession: openSession,
  closeFollowerWorkspace: () => followerController.close(),
});
const {
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
  loadSecretaryConversationMessages,
  openNetworkTask,
  retractNetworkPanelForChat,
} = networkWorkspaceController;
let voiceCallTicker = null;
function activeVoiceCallWorkspaceId() {
  return String(state.activeAccountWorkspace?.id || state.networkConversationWorkspaceId || 'workspace_personal').trim() || 'workspace_personal';
}
async function startVoiceCall(peerId = '') {
  const cleanPeerId = String(peerId || '').trim();
  if (!cleanPeerId) return;
  const peer = (state.friendOverview?.friends || []).map((item) => item.friend || item.user || {}).find((item) => String(item.id || '') === cleanPeerId) || (String(state.networkConversationPeerId || '') === cleanPeerId ? state.networkConversationPeer || { id: cleanPeerId } : { id: cleanPeerId });
  state.voiceCall = { status: 'ringing', peerId: cleanPeerId, startedAt: new Date().toISOString(), muted: false, speaker: true, sharing: false, minimized: false, maximized: false };
  clearInterval(voiceCallTicker);
  try {
    const callId = crypto.randomUUID();
    const workspaceId = activeVoiceCallWorkspaceId();
    state.voiceCall = { ...state.voiceCall, callId };
    await window.janus.sendVoiceCallSignal?.({ recipientId: cleanPeerId, callId, type: 'invite', workspaceId, accountWorkspaceId: workspaceId, senderProfile: state.currentUser || {} });
  } catch (error) {
    console.warn('voice-call-window:open failed', error);
    notify('通话窗口打开失败，请重试。', 'error');
  }
}

async function startVideoRoom(workspaceId = '', groupId = '') {
  void workspaceId; void groupId;
  notify(state.languageMode === 'en' ? 'Group calls are not available yet.' : '多人通话暂未开放，敬请期待。');
}

async function receiveVoiceCall(peerId = '', { callId = '', workspaceId = '', peer = null } = {}) {
  const cleanPeerId = String(peerId || '').trim();
  if (!cleanPeerId) return;
  const resolvedPeer = peer || (state.friendOverview?.friends || []).map((item) => item.friend || item.user || {})
    .find((item) => String(item.id || '') === cleanPeerId) || { id: cleanPeerId };
  return { callId: callId || crypto.randomUUID(), workspaceId: workspaceId || activeVoiceCallWorkspaceId(), peer: resolvedPeer };
}

async function openVoiceCallWindowForState({ incoming: incomingCall = false, callAccepted = false } = {}) {
  const call = state.voiceCall;
  if (!call?.peerId || call.windowOpened || typeof window.janus?.openVoiceCallWindow !== 'function') return false;
  const peer = call.peer || (state.friendOverview?.friends || []).map((item) => item.friend || item.user || {}).find((item) => String(item.id || '') === String(call.peerId)) || { id: call.peerId };
  const workspaceId = activeVoiceCallWorkspaceId();
  try {
    await window.janus.openVoiceCallWindow({
      callId: call.callId, incoming: incomingCall, callAccepted, peerId: call.peerId, peer,
      callerId: String(call.callerId || (incomingCall ? call.peerId : state.currentUser?.id || '')),
      callStartedAt: call.startedAt || new Date().toISOString(), workspaceId, accountWorkspaceId: workspaceId,
      currentUser: state.currentUser || {}, language: state.languageMode, theme: state.themeMode,
      friends: (state.friendOverview?.friends || []).map((item) => item.friend || item.user || {}).filter((item) => item?.id && String(item.id) !== String(call.peerId)),
      hostUserId: String(state.currentUser?.id || ''),
    });
    state.voiceCall = { ...state.voiceCall, windowOpened: true, status: 'external' };
    render();
    return true;
  } catch (error) { console.warn('voice-call-window:open failed', error); notify('通话窗口打开失败，请重试。', 'error'); return false; }
}
window.addEventListener('janus:voice-call-incoming', (event) => {
  const signal = event.detail || {};
  if (String(signal.senderId || signal.sender_id || '') === String(state.currentUser?.id || '')) return;
  if (String(signal.type || '') === 'voice_call.invite' && signal.callId && signal.groupId) {
    notify(state.languageMode === 'en' ? 'Group calls are not available yet.' : '多人通话暂未开放，敬请期待。');
    return;
  }
  if (String(signal.type || '') !== 'invite') return;
  const peerId = signal.senderId || signal.sender_id || signal.peerId || signal.peer_id || '';
  const peer = signal.senderProfile || signal.callerProfile || signal.peer
    || { id: peerId, displayName: signal.callerName || peerId };
  state.voiceCall = { status: 'incoming', callId: String(signal.callId || ''), peerId: String(peerId), peer, callerId: String(signal.senderId || peerId), startedAt: new Date().toISOString(), muted: false, speaker: true, sharing: false, minimized: false, maximized: false, windowOpened: false };
  render();
  void receiveVoiceCall(peerId, {
    callId: signal.callId,
    workspaceId: signal.workspaceId || signal.accountWorkspaceId,
    peer,
  });
});
window.janus?.onVoiceCallSignal?.(() => {
  // The preload bridge dispatches the same payload as janus:voice-call-incoming.
  // Keep this subscription for compatibility, while the DOM event is the single
  // path that opens the incoming call window and prevents duplicate windows.
});
window.janus?.onVoiceCallSignal?.((signal = {}) => {
  if (String(signal.callId || '') !== String(state.voiceCall?.callId || signal.callId || '')) return;
  if (signal.type === 'accept') { state.voiceCall = { ...state.voiceCall, status: 'connecting', callId: signal.callId, startedAt: state.voiceCall.startedAt || new Date().toISOString() }; render(); void openVoiceCallWindowForState({ callAccepted: true }); }
  if (signal.type === 'state' && ['ringing', 'accepted', 'connecting', 'connected', 'failed'].includes(signal.state)) { state.voiceCall = { ...state.voiceCall, status: state.voiceCall.windowOpened ? 'external' : signal.state }; render(); }
  if (signal.type === 'mute') { state.voiceCall = { ...state.voiceCall, muted: Boolean(signal.muted) }; render(); }
  if (['reject', 'cancel', 'hangup'].includes(signal.type)) endVoiceCall();
});

function answerVoiceCall() {
  if (!state.voiceCall?.peerId || state.voiceCall.status !== 'incoming') return;
  state.voiceCall = { ...state.voiceCall, status: 'connecting', startedAt: new Date().toISOString() };
  void openVoiceCallWindowForState({ incoming: true, callAccepted: true }).then(() => window.janus?.sendVoiceCallSignal?.({ recipientId: state.voiceCall.peerId, callId: state.voiceCall.callId, type: 'accept', workspaceId: activeVoiceCallWorkspaceId(), accountWorkspaceId: activeVoiceCallWorkspaceId() }));
  clearInterval(voiceCallTicker);
  voiceCallTicker = setInterval(updateVoiceCallDuration, 1000);
  render();
}
function toggleVoiceCallMinimize() {
  if (!state.voiceCall || state.voiceCall.status === 'idle') return;
  state.voiceCall = { ...state.voiceCall, minimized: !state.voiceCall.minimized, maximized: false };
  const layer = document.querySelector('.voice-call-layer');
  if (layer) { layer.classList.toggle('is-minimized', state.voiceCall.minimized); layer.classList.remove('is-maximized'); }
}
function toggleVoiceCallMaximize() {
  if (!state.voiceCall || state.voiceCall.status === 'idle') return;
  state.voiceCall = { ...state.voiceCall, maximized: !state.voiceCall.maximized, minimized: false };
  const layer = document.querySelector('.voice-call-layer');
  if (layer) { layer.classList.toggle('is-maximized', state.voiceCall.maximized); layer.classList.remove('is-minimized'); }
}

function endVoiceCall() {
  const call = state.voiceCall;
  if (call?.peerId && call?.callId) void window.janus?.sendVoiceCallSignal?.({ recipientId: call.peerId, callId: call.callId, type: call.status === 'incoming' ? 'reject' : 'hangup', workspaceId: activeVoiceCallWorkspaceId(), accountWorkspaceId: activeVoiceCallWorkspaceId() });
  clearInterval(voiceCallTicker);
  voiceCallTicker = null;
  state.voiceCall = { status: 'idle', peerId: '', startedAt: '', muted: false, speaker: true, sharing: false, minimized: false, maximized: false };
  render();
}
function toggleVoiceCallMute() {
  if (!state.voiceCall || state.voiceCall.status === 'idle') return;
  const muted = !state.voiceCall.muted;
  state.voiceCall = { ...state.voiceCall, muted };
  void window.janus?.sendVoiceCallSignal?.({ recipientId: state.voiceCall.peerId, callId: state.voiceCall.callId, type: 'mute', muted, workspaceId: activeVoiceCallWorkspaceId(), accountWorkspaceId: activeVoiceCallWorkspaceId() });
  updateVoiceCallControls();
}
function toggleVoiceCallShare() {
  if (!state.voiceCall || state.voiceCall.status !== 'connected') { notify('接通后才能共享内容。'); return; }
  state.voiceCall = { ...state.voiceCall, sharing: !state.voiceCall.sharing };
  const button = document.querySelector('[data-voice-call-share]');
  if (button) { button.classList.toggle('is-active', Boolean(state.voiceCall.sharing)); const label = button.querySelector('span'); if (label) label.textContent = state.voiceCall.sharing ? '停止共享' : '共享'; }
  notify(state.voiceCall.sharing ? '已进入共享状态。' : '已停止共享。');
}
function showVoiceCallMembers() { notify('当前通话成员：你和对方，共 2 人。'); }
function showVoiceCallMore() { notify('更多通话设置将在菜单中提供。'); }

function toggleVoiceCallSpeaker() {
  if (!state.voiceCall || state.voiceCall.status === 'idle') return;
  state.voiceCall = { ...state.voiceCall, speaker: !state.voiceCall.speaker };
  updateVoiceCallControls();
}function updateVoiceCallDuration() {
  const call = state.voiceCall;
  if (!call || call.status !== 'connected' || !call.startedAt) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000));
  const node = document.querySelector('.voice-call-duration');
  if (node) node.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}
function updateVoiceCallControls() {
  const mute = document.querySelector('[data-voice-call-mute]');
  const speaker = document.querySelector('[data-voice-call-speaker]');
  if (mute) { mute.classList.toggle('is-active', Boolean(state.voiceCall?.muted)); mute.setAttribute('aria-pressed', state.voiceCall?.muted ? 'true' : 'false'); const label = mute.querySelector('span'); if (label) label.textContent = state.voiceCall?.muted ? '取消静音' : '静音'; }
  if (speaker) { speaker.classList.toggle('is-active', state.voiceCall?.speaker !== false); speaker.setAttribute('aria-pressed', state.voiceCall?.speaker === false ? 'false' : 'true'); }
}


const friendsController = createFriendsController({
  api: window.janus,
  state,
  render,
  notify,
  userErrorMessage,
  refreshSocialInbox,
  refreshSocialThreads,
  refreshAgentDelegations,
  openNetworkConversation,
  activateOrganizationWorkspace: activateJoinedOrganizationWorkspace,
  windowRef: window,
  documentRef: document,
});
const {
  refreshFriends,
  showFriendDirectoryView,
  showFriendDirectoryCategory,
  handleAddFriendClick,
  clearFriendSearch,
  openContactAddDialog,
  switchContactAddDialogTab,
  closeContactAddDialog,
  friendNameById,
  createAgentDelegationForFriend,
  startAgentDelegation,
  searchFriends,
  updateFriendOverviewFromResult,
  createOrganization,
  joinOrganization,
  openFriendRequestComposer,
  closeFriendRequestComposer,
  submitFriendRequest,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  removeFriend,
  updateFriendRemark,
  saveFriendRemark,
  blockFriend,
} = friendsController;
const runtimeSettingsController = createRuntimeSettingsController({
  api: window.janus,
  state,
  render,
  notify,
  appendStatus,
  reasoningOptionsForModel,
  modelCatalogEntry,
  escapeAttr,
  escapeHtml,
  documentRef: document,
  windowRef: window,
  translateText: (value) => translateUiText(value, state.languageMode),
});
const {
  changePassword,
  loadFeishuStatus,
  testFeishuConfig,
  saveFeishuConfig,
  regenerateFeishuBindingCode,
  unbindFeishu,
  saveCodexConfig,
  toggleCodexApiKeyVisibility,
  switchCodexConfigMode,
  closeSettingsCustomSelects,
  syncSettingsCustomSelect,
  bindSettingsCustomSelects,
  updateCodexReasoningOptions,
  saveCodexConfigFiles,
  requestProviderKeyApplication,
  loadProviderKeyApplications,
  decideProviderKeyApplication,
  claimProviderKeyApplication,
  sendProviderKeyEmailCode,
  verifyProviderKeyEmail,
  formatCodexAuthJson,
  reloadCodexConfigFiles,
  runCodexConnectionTest,
  summarizeCodexDoctor,
  classifyCodexDoctor,
  isWarningDoctorStatus,
  isFailingDoctorStatus,
  notificationToneForConnectionTest,
  resolveCommunication,
} = runtimeSettingsController;
const updatesController = createUpdatesController({
  state,
  render,
  notify,
  appendStatus,
  windowRef: window,
  documentRef: document,
  requestFrame: requestAnimationFrame,
  isCurrentUserAdmin,
  effectiveJanusVersion,
  compareSemanticVersions,
});
const {
  refreshReleaseStatus,
  checkAllUpdates,
  handleAccountUpdateClick,
  downloadUpdate,
  installUpdate,
  loadPluginCatalog,
  installManagedPlugin,
  openManagedPluginFiles,
  uninstallManagedPlugin,
  importAttachedSkill,
  pickAttachedSkillSource,
  disableAttachedSkillPackage,
  setAttachedSkillAssignment,
  removeAttachedSkillAssignment,
  refreshCodexPlugins,
  installCodexPlugin,
  removeCodexPlugin,
  pickCodexMarketplaceSource,
  addCodexMarketplace,
  upgradeCodexMarketplace,
  removeCodexMarketplace,
  loadPptxPluginStatus,
  downloadPptxPlugin,
  openPptxSkillFile,
  uninstallPptxPlugin,
} = updatesController;

const networkMessageController = createNetworkMessageController({
  api: window.janus,
  documentRef: document,
  state,
  render,
  notify,
  readyAttachmentsForSend,
  currentModelValue,
  currentReasoningValue,
  selectedSocialTaskGroup,
  networkConversationDraftKey,
  persistComposerDrafts,
  composerSurfaceKey: () => composerDraftController.surfaceKey(),
  captureComposerDraft: (surfaceKey, options) => composerDraftController.capture(surfaceKey, options),
  clearComposerDraft,
  restoreComposerDraft,
  getComposerDraftSnapshot: (surfaceKey) => composerDraftController.snapshot(surfaceKey),
  putComposerDraftSnapshot: (surfaceKey, snapshot) => composerDraftController.put(surfaceKey, snapshot),
  hasComposerDraft: (surfaceKey) => composerDraftController.has(surfaceKey),
  refreshSocialThreads,
  scrollMessagesToBottom,
  focusChatInputAtEnd,
  userErrorMessage,
  refreshCollaborationOverview,
  noteDirectoryGroups,
});
const {
  cancelCollaborationRoutingConfirmation,
  confirmCollaborationRoutingTarget,
  sendCollaborationGroupMessage,
  sendChatGroupMessage,
  sendDirectSocialMessage,
  sendSocialGroupMessage,
} = networkMessageController;
const messageSendController = createMessageSendController({
  api: window.janus,
  documentRef: document,
  state,
  render,
  notify,
  sendCollaborationGroupMessage,
  sendChatGroupMessage,
  sendDirectSocialMessage,
  sendSocialGroupMessage,
  currentChatRun,
  retractNetworkPanelForChat,
  resolveSelectedAgentId,
  projectById,
  activeProject,
  pendingAttachmentsForMessage,
  registerChatRun,
  assignmentLabelForRun,
  updateRunStatusMessage,
  scrollMessagesToBottom,
  readyAttachmentsForSend,
  updateLocalMessageAttachments,
  isRunForCurrentChat,
  currentModelValue,
  currentReasoningValue,
  refreshCollaborationOverview,
  refreshSocialThreads,
  expandProject,
  handleChatRunEvent,
  userErrorMessage,
  clearRunTransientMessages,
  unregisterChatRun,
  allChatRuns,
  stopRunStatusTimer,
  projectName,
  workspaceDisplayLabel,
  currentPptTemplate,
  shortAgentLabel,
  agentNameById,
  activeAgentInstanceId: activeComposerMemoryAgentInstanceId,
  restorePersistentDeliveryRuns,
  upsertRecentSession,
  reactivateAgentConversation,
  beginMessagePageRequest: (sessionId) => messagePageRequestCoordinator.begin(sessionId),
  messagePageRequestIsLatest: (sessionId, version) => messagePageRequestCoordinator.isLatest(sessionId, version),
  clearAgentConversationDraft,
  composerSurfaceKey: () => composerDraftController.surfaceKey(),
  clearComposerDraft,
  captureComposerDraft: (surfaceKey, options) => composerDraftController.capture(surfaceKey, options),
  restoreComposerDraft,
  getComposerDraftSnapshot: (surfaceKey) => composerDraftController.snapshot(surfaceKey),
  putComposerDraftSnapshot: (surfaceKey, snapshot) => composerDraftController.put(surfaceKey, snapshot),
  hasComposerDraft: (surfaceKey) => composerDraftController.has(surfaceKey),
});
const { sendChat, sendChatMessage } = messageSendController;
const desktopMenuController = createDesktopMenuController({
  state,
  render,
  closeChatSearch,
  enterSettings,
  logoutAccount,
  setLanguageMode,
  windowRef: window,
  documentRef: document,
  historyRef: history,
  getComputedStyleFn: getComputedStyle,
  requestFrame: requestAnimationFrame,
  editHistory: desktopEditHistory,
  EventCtor: Event,
  startNewPlainChat,
  selectWorkspaceDirectory,
  saveRunLogVisible,
  openChatSearch,
  effectiveJanusVersion,
  pathBasename,
  compareSessionsForDisplay,
  openSession,
  notify,
  openUpdateChangelog,
});
const {
  closeModelMenuOnOutsideClick,
  closeModelMenuOnEscape,
  closeSessionMenuOnOutsideClick,
  closeSessionMenuOnEscape,
  toggleSessionMenu,
  sessionMenuPositionFromButton,
  closeProjectMenuOnOutsideClick,
  closeProjectMenuOnEscape,
  toggleProjectMenu,
  projectMenuPositionFromButton,
  closePluginMenuOnOutsideClick,
  closePluginMenuOnEscape,
  pluginMenuPositionFromButton,
  closeAccountMenuOnOutsideClick,
  handleAccountMenuActionClick,
  handleAccountMenuAction,
  handleLocationHashAction,
  closeAccountMenuOnEscape,
  autoResizeChatInput,
  updateInputTagIndent,
  scheduleModelMenuPlacement,
  updateModelMenuPlacement,
  applyModelMenuPlacementToDom,
  cssPixelVar,
  showDesktopDialog,
  closeDesktopDialog,
  pasteClipboardText,
  closeDesktopMenus,
  toggleDesktopMenu,
  setDesktopMenuOpen,
  switchDesktopMenuOnHover,
  closeDesktopMenuOnOutsideClick,
  closeDesktopMenuOnEscape,
  handleDesktopMenuActionClick,
  handleDesktopMenuAction,
  handleDesktopShortcut,
  runNativeEditCommand,
  selectAdjacentSession,
} = desktopMenuController;

window.addEventListener('hashchange', handleLocationHashAction);
window.addEventListener('focus', checkClipboardForOrganizationInvite);
window.addEventListener('pointerup', finishMessagePointerInteraction);
window.addEventListener('pointercancel', finishMessagePointerInteraction);
window.addEventListener('touchend', finishMessagePointerInteraction, { passive: true });
window.addEventListener('touchcancel', finishMessagePointerInteraction, { passive: true });
window.addEventListener('pointerup', finishTaskWorkspaceScrollInteraction);
window.addEventListener('pointercancel', finishTaskWorkspaceScrollInteraction);
window.addEventListener('touchend', finishTaskWorkspaceScrollInteraction, { passive: true });
window.addEventListener('touchcancel', finishTaskWorkspaceScrollInteraction, { passive: true });

function finishMessageScrollInteraction() {
  if (messageScrollPointerActive) return;
  if (messageScrollIdleTimer) {
    clearTimeout(messageScrollIdleTimer);
    messageScrollIdleTimer = null;
  }
  const interactionActive = messageScrollInteracting;
  const layoutInteraction = messageScrollLayoutInteraction;
  messageScrollLayoutInteraction = false;
  const list = document.getElementById('message-list');
  if (!list) {
    messageScrollInteracting = false;
    flushPendingMessageScrollRender();
    return;
  }
  const evaluation = ++messageScrollFollowEvaluation;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (evaluation !== messageScrollFollowEvaluation) return;
    if (document.getElementById('message-list') !== list) {
      if (interactionActive) messageScrollInteracting = false;
      flushPendingMessageScrollRender();
      return;
    }
    const distanceFromBottom = Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop);
    if (layoutInteraction && distanceFromBottom > MESSAGE_SCROLL_BOTTOM_TOLERANCE) {
      messageScrollFollow = false;
    } else messageScrollFollow = distanceFromBottom <= MESSAGE_SCROLL_BOTTOM_TOLERANCE;
    if (interactionActive) messageScrollInteracting = false;
    flushPendingMessageScrollRender();
  }));
}

function finishMessagePointerInteraction() {
  messageScrollPointerActive = false;
  finishMessageScrollInteraction();
}

function flushPendingMessageScrollRender() {
  if (messageScrollInteracting || !messageScrollRenderPending) return;
  messageScrollRenderPending = false;
  requestAnimationFrame(() => render());
}

function deferMessageScrollInteractionFinish() {
  messageScrollInteracting = true;
  if (messageScrollIdleTimer) clearTimeout(messageScrollIdleTimer);
  messageScrollIdleTimer = setTimeout(() => {
    messageScrollIdleTimer = null;
    if (messageScrollPointerActive) return;
    finishMessageScrollInteraction();
  }, MESSAGE_SCROLL_INTERACTION_IDLE_MS);
}

function rememberMessageViewState(snapshot = null) {
  const key = String(snapshot?.key || '').trim();
  if (!key) return false;
  const renderedList = document.getElementById('message-list');
  if (key === String(state.currentChatKey || '').trim()
    && renderedList?.querySelector?.('.conversation-message-loading')) return false;
  if (state.messagePagination?.initialLoading === true
    && key === String(state.currentChatKey || '').trim()) return false;
  const current = { ...(state.messageViewStateByKey || {}) };
  current[key] = {
    ...snapshot,
    savedAt: Date.now(),
  };
  const entries = Object.entries(current)
    .sort((left, right) => Number(right[1]?.savedAt || 0) - Number(left[1]?.savedAt || 0))
    .slice(0, 80);
  state.messageViewStateByKey = Object.fromEntries(entries);
  return true;
}

function captureMessageViewState() {
  const snapshot = captureMessageScrollState();
  rememberMessageViewState(snapshot);
  return snapshot;
}

function restoreMessageViewState() {
  const list = document.getElementById('message-list');
  const key = String(list?.dataset?.messageScrollKey || '').trim();
  const snapshot = key ? state.messageViewStateByKey?.[key] || null : null;
  if (!snapshot) return false;
  messageScrollFollowEvaluation += 1;
  messageScrollInteracting = false;
  messageScrollLayoutInteraction = false;
  messageScrollFollow = Boolean(snapshot.follow);
  restoreMessageScrollState(snapshot);
  return true;
}

async function refreshUBuddyTaskViewsForSession(sessionId = '', messages = []) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) return null;
  const workspaceGeneration = Number(state.workspaceSwitchGeneration || 0);
  const result = await hydrateUBuddyTaskViews({
    api: window.janus,
    state,
    sessionId: cleanSessionId,
    messages,
    workspaceGeneration,
    isCurrent: () => state.currentSessionId === cleanSessionId,
  });
  if (state.currentSessionId === cleanSessionId) void refreshUBuddyDeliveryCenterCount();
  if (!result?.changed || state.currentSessionId !== cleanSessionId
    || Number(state.workspaceSwitchGeneration || 0) !== workspaceGeneration) return result;
  renderRunUpdate(null);
  patchUBuddyTaskDisplay();
  syncUBuddyPendingBadge();
  return result;
}

function patchUBuddyTaskDisplay() {
  const host = document.querySelector('[data-ubuddy-task-strip-host]');
  const drawerHost = document.querySelector('[data-ubuddy-task-drawer-host]');
  if (host) {
    host.innerHTML = renderUBuddyTaskStrip();
    localizeDom(host, state.languageMode);
    wireUBuddyTaskDisplayEvents(host);
  }
  if (drawerHost) {
    drawerHost.innerHTML = renderUBuddyTaskDrawer();
    localizeDom(drawerHost, state.languageMode);
    wireUBuddyTaskDisplayEvents(drawerHost);
  }
  syncUBuddyTaskUpdateNotice();
}

let uBuddyCenterSearchTimer = null;
const uBuddyCenterRequestCoordinator = createLatestRequestCoordinator();

function cancelUBuddyCenterSearchTimer() {
  if (!uBuddyCenterSearchTimer) return;
  clearTimeout(uBuddyCenterSearchTimer);
  uBuddyCenterSearchTimer = null;
}

function clearUBuddyCenterItems(center = state.uBuddyCenterOpen) {
  if (center === 'tasks' && state.uBuddyTaskCenterPage) {
    state.uBuddyTaskCenterPage = { ...state.uBuddyTaskCenterPage, items: [], nextCursor: '', total: 0 };
  } else if (center === 'deliveries' && state.uBuddyDeliveryCenterPage) {
    state.uBuddyDeliveryCenterPage = { ...state.uBuddyDeliveryCenterPage, items: [], nextCursor: '', total: 0 };
  }
}

function renderUBuddyCenterPreservingFocus() {
  const input = document.querySelector('[data-ubuddy-task-center-search]');
  const restoreSearchFocus = document.activeElement === input;
  const selectionStart = restoreSearchFocus && Number.isFinite(input.selectionStart) ? input.selectionStart : null;
  const selectionEnd = restoreSearchFocus && Number.isFinite(input.selectionEnd) ? input.selectionEnd : null;
  render();
  if (!restoreSearchFocus) return;
  const replacement = document.querySelector('[data-ubuddy-task-center-search]');
  replacement?.focus?.({ preventScroll: true });
  if (replacement && selectionStart !== null && selectionEnd !== null) {
    replacement.setSelectionRange(selectionStart, selectionEnd);
  }
}

async function loadUBuddyCenter({ append = false, renderAfter = true } = {}) {
  const center = state.uBuddyCenterOpen;
  if (!['tasks', 'deliveries'].includes(center) || (append && state.uBuddyCenterLoading)) return null;
  const filter = center === 'tasks' ? state.uBuddyTaskCenterFilter || 'all' : state.uBuddyDeliveryCenterFilter || 'pending';
  const query = center === 'tasks' ? state.uBuddyTaskCenterQuery || '' : '';
  const workspaceGeneration = Number(state.workspaceSwitchGeneration || 0);
  const requestVersion = uBuddyCenterRequestCoordinator.begin('center');
  const previous = center === 'tasks' ? state.uBuddyTaskCenterPage : state.uBuddyDeliveryCenterPage;
  state.uBuddyCenterLoading = true;
  state.uBuddyCenterError = '';
  if (renderAfter) renderUBuddyCenterPreservingFocus();
  try {
    const result = center === 'tasks'
      ? await window.janus.uBuddyTaskCenter({
          filter,
          query,
          cursor: append ? previous?.nextCursor || '' : '',
          limit: 30,
        })
      : await window.janus.uBuddyDeliveryCenter({
          filter,
          cursor: append ? previous?.nextCursor || '' : '',
          limit: 30,
        });
    if (!uBuddyCenterRequestCoordinator.isLatest('center', requestVersion)
      || state.uBuddyCenterOpen !== center
      || Number(state.workspaceSwitchGeneration || 0) !== workspaceGeneration
      || (center === 'tasks' && (state.uBuddyTaskCenterFilter !== filter || state.uBuddyTaskCenterQuery !== query))
      || (center === 'deliveries' && state.uBuddyDeliveryCenterFilter !== filter)) return null;
    const next = append ? {
      ...result,
      items: [...(previous?.items || []), ...(result?.items || [])],
      counts: result?.counts || previous?.counts || {},
    } : result;
    if (center === 'tasks') state.uBuddyTaskCenterPage = next;
    else state.uBuddyDeliveryCenterPage = next;
    return next;
  } catch (error) {
    if (!uBuddyCenterRequestCoordinator.isLatest('center', requestVersion) || state.uBuddyCenterOpen !== center) return null;
    state.uBuddyCenterError = userVisibleErrorMessage(error, '列表加载失败，请重试。');
    return null;
  } finally {
    if (uBuddyCenterRequestCoordinator.isLatest('center', requestVersion)) {
      state.uBuddyCenterLoading = false;
      if (renderAfter) renderUBuddyCenterPreservingFocus();
    }
  }
}

function focusUBuddyCenter() {
  requestAnimationFrame(() => {
    const drawer = document.querySelector('.ubuddy-center-drawer');
    const target = drawer?.querySelector('[data-ubuddy-task-center-search]') || drawer;
    target?.focus?.({ preventScroll: true });
  });
}

async function refreshUBuddyDeliveryCenterCount() {
  if (!window.janus.uBuddyDeliveryCenter || !state.currentUser) return;
  const workspaceGeneration = state.workspaceSwitchGeneration;
  try {
    const result = await window.janus.uBuddyDeliveryCenter({ filter: 'pending', limit: 1 });
    if (workspaceGeneration !== state.workspaceSwitchGeneration) return;
    state.uBuddyDeliveryCenterPage = state.uBuddyCenterOpen === 'deliveries' && state.uBuddyDeliveryCenterPage
      ? { ...state.uBuddyDeliveryCenterPage, counts: result?.counts || state.uBuddyDeliveryCenterPage.counts || {} }
      : result;
    renderUBuddyCenterPreservingFocus();
  } catch {}
}

function wireUBuddyCenterEvents(root = document) {
  root.querySelectorAll?.('[data-ubuddy-center-open]').forEach((button) => {
    button.addEventListener('click', () => {
      const requested = String(button.dataset.ubuddyCenterOpen || 'tasks');
      cancelUBuddyCenterSearchTimer();
      state.uBuddyCenterOpen = state.uBuddyCenterOpen === requested ? '' : requested;
      state.uBuddyCenterError = '';
      uBuddyCenterRequestCoordinator.begin('center');
      state.uBuddyCenterLoading = false;
      render();
      if (state.uBuddyCenterOpen) {
        focusUBuddyCenter();
        void loadUBuddyCenter();
      }
    });
  });
  root.querySelectorAll?.('[data-ubuddy-center-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const closedCenter = state.uBuddyCenterOpen;
      cancelUBuddyCenterSearchTimer();
      uBuddyCenterRequestCoordinator.begin('center');
      state.uBuddyCenterOpen = '';
      state.uBuddyCenterLoading = false;
      state.uBuddyCenterError = '';
      render();
      setTimeout(() => document.querySelector(`[data-ubuddy-center-open="${CSS.escape(closedCenter)}"]`)?.focus(), 0);
    });
  });
  root.querySelectorAll?.('[data-ubuddy-center-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      const filter = String(button.dataset.ubuddyCenterFilter || 'all');
      if (state.uBuddyCenterOpen === 'tasks') state.uBuddyTaskCenterFilter = filter;
      else state.uBuddyDeliveryCenterFilter = filter;
      clearUBuddyCenterItems();
      void loadUBuddyCenter();
    });
  });
  root.querySelector('[data-ubuddy-task-center-search]')?.addEventListener('input', (event) => {
    state.uBuddyTaskCenterQuery = event.target.value || '';
    cancelUBuddyCenterSearchTimer();
    uBuddyCenterSearchTimer = setTimeout(() => {
      uBuddyCenterSearchTimer = null;
      clearUBuddyCenterItems('tasks');
      void loadUBuddyCenter();
    }, 220);
  });
  root.querySelector('[data-ubuddy-center-more]')?.addEventListener('click', () => void loadUBuddyCenter({ append: true }));
  root.querySelector('[data-ubuddy-center-retry]')?.addEventListener('click', () => void loadUBuddyCenter());
  root.querySelectorAll?.('.ubuddy-center-row [data-task-card-action], .ubuddy-center-row [data-network-delegation]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.taskCardAction === TASK_CARD_ACTIONS.CANCEL_TASK) return;
      cancelUBuddyCenterSearchTimer();
      uBuddyCenterRequestCoordinator.begin('center');
      state.uBuddyCenterOpen = '';
      state.uBuddyCenterLoading = false;
    });
  });
  root.querySelectorAll?.('[data-ubuddy-quick-accept]').forEach((button) => {
    button.addEventListener('click', () => void quickAcceptUBuddyDelivery(button));
  });
}

async function quickAcceptUBuddyDelivery(button) {
  const taskRunId = String(button?.dataset?.ubuddyQuickAccept || '').trim();
  const submissionId = String(button?.dataset?.deliverySubmissionId || '').trim();
  const submissionNo = Math.max(1, Number(button?.dataset?.deliverySubmissionNo || 1));
  if (!taskRunId || !submissionId || button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = translateUiText('验收中…', state.languageMode);
  try {
    const result = await window.janus.taskRunWorkspaceMessage({
      taskRunId,
      content: `采用版本 ${submissionNo}，直接交付并停止当前修改。`,
      actionHint: 'accept_submission',
      submissionId,
      clientMessageId: globalThis.crypto?.randomUUID?.() || `task_accept_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      model: currentModelValue(),
      reasoningEffort: currentReasoningValue(),
      sandboxPermission: state.sandboxPermission,
    });
    if (result?.task?.id) {
      const taskIndex = (state.tasks || []).findIndex((item) => item.id === result.task.id);
      if (taskIndex >= 0) state.tasks[taskIndex] = result.task;
      else state.tasks = [result.task, ...(state.tasks || [])];
      mergeUBuddyTaskView(state, result.task);
    }
    if (state.currentSessionId) {
      const page = await loadLatestRendererMessagePage(state.currentSessionId).catch(() => null);
      if (page) applyLatestRendererMessagePage(state.currentSessionId, page);
    }
    await refreshUBuddyDeliveryCenterCount();
    notify(`已验收版本 ${submissionNo}，任务已关闭。`, 'success');
  } catch (error) {
    notify(`快速验收失败：${userErrorMessage(error)}`, 'error');
  } finally {
    render();
  }
}

function wireUBuddyTaskDisplayEvents(root = document) {
  if (root !== document) {
    root.querySelectorAll?.('[data-task-card-action]').forEach((button) => {
      button.addEventListener('click', () => void handleTaskCardAction(button));
    });
  }
  root.querySelectorAll?.('[data-ubuddy-task-drawer-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const sessionId = String(button.dataset.ubuddyTaskDrawerToggle || state.currentSessionId || '').trim();
      if (!sessionId) return;
      const currentlyOpen = Boolean(state.uBuddyTaskDrawerOpenBySessionId?.[sessionId] || state.uBuddyTaskStripOpenBySessionId?.[sessionId]);
      state.uBuddyTaskDrawerOpenBySessionId = {
        ...(state.uBuddyTaskDrawerOpenBySessionId || {}),
        [sessionId]: !currentlyOpen,
      };
      state.uBuddyTaskStripOpenBySessionId = { ...(state.uBuddyTaskStripOpenBySessionId || {}), [sessionId]: false };
      patchUBuddyTaskDisplay();
    });
  });
  root.querySelectorAll?.('[data-ubuddy-task-count-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      const sessionId = String(state.currentSessionId || '').trim();
      if (!sessionId) return;
      state.uBuddyTaskDrawerOpenBySessionId = { ...(state.uBuddyTaskDrawerOpenBySessionId || {}), [sessionId]: true };
      state.uBuddyTaskStripFilterBySessionId = { ...(state.uBuddyTaskStripFilterBySessionId || {}), [sessionId]: String(button.dataset.ubuddyTaskCountFilter || 'needs_my_action') };
      patchUBuddyTaskDisplay();
    });
  });
  root.querySelectorAll?.('[data-ubuddy-task-drawer-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const sessionId = String(state.currentSessionId || '').trim();
      if (!sessionId) return;
      state.uBuddyTaskDrawerOpenBySessionId = { ...(state.uBuddyTaskDrawerOpenBySessionId || {}), [sessionId]: false };
      state.uBuddyTaskStripOpenBySessionId = { ...(state.uBuddyTaskStripOpenBySessionId || {}), [sessionId]: false };
      patchUBuddyTaskDisplay();
    });
  });
  root.querySelectorAll?.('[data-ubuddy-task-strip-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      const sessionId = String(state.currentSessionId || '').trim();
      const filter = String(button.dataset.ubuddyTaskStripFilter || 'active').trim();
      if (!sessionId) return;
      state.uBuddyTaskStripFilterBySessionId = {
        ...(state.uBuddyTaskStripFilterBySessionId || {}),
        [sessionId]: filter,
      };
      patchUBuddyTaskDisplay();
    });
  });
  root.querySelectorAll?.('[data-ubuddy-task-jump]').forEach((button) => {
    button.addEventListener('click', () => {
      const taskRunId = String(button.dataset.ubuddyTaskJump || '').trim();
      const sourceMessageId = String(button.dataset.ubuddyTaskSourceMessage || '').trim();
      const selector = sourceMessageId ? `[data-message-id="${CSS.escape(sourceMessageId)}"]` : '';
      const target = selector ? document.querySelector(`#message-list ${selector}`) : null;
      if (target) {
        messageScrollFollowEvaluation += 1;
        messageScrollFollow = false;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (taskRunId) void handleTaskCardAction(button);
    });
  });
  root.querySelectorAll?.('[data-ubuddy-new-task-updates]').forEach((button) => {
    button.addEventListener('click', () => {
      clearCurrentUBuddyTaskUnseen();
      scrollMessagesToBottom({ force: true, settle: true });
    });
  });
}

function noteCurrentUBuddyTaskUpdate() {
  const sessionId = String(state.currentSessionId || '').trim();
  if (!sessionId) return;
  if (messageScrollFollow && !messageScrollInteracting) {
    clearCurrentUBuddyTaskUnseen();
    return;
  }
  state.uBuddyTaskUnseenBySessionId = {
    ...(state.uBuddyTaskUnseenBySessionId || {}),
    [sessionId]: Math.min(99, Number(state.uBuddyTaskUnseenBySessionId?.[sessionId] || 0) + 1),
  };
  syncUBuddyTaskUpdateNotice();
}

function clearCurrentUBuddyTaskUnseen() {
  const sessionId = String(state.currentSessionId || '').trim();
  if (!sessionId || !Number(state.uBuddyTaskUnseenBySessionId?.[sessionId] || 0)) return;
  state.uBuddyTaskUnseenBySessionId = {
    ...(state.uBuddyTaskUnseenBySessionId || {}),
    [sessionId]: 0,
  };
  syncUBuddyTaskUpdateNotice();
}

function syncUBuddyTaskUpdateNotice() {
  const button = document.querySelector('[data-ubuddy-new-task-updates]');
  if (!button) return;
  const count = Math.max(0, Number(state.uBuddyTaskUnseenBySessionId?.[state.currentSessionId] || 0));
  button.hidden = count <= 0;
  button.textContent = translateUiText(`${count || ''}${count ? ' 条' : ''}新进展 ↓`, state.languageMode);
}

function syncUBuddyPendingBadge() {
  const button = document.querySelector('[data-network-peer="self-secretary"]');
  const badge = button?.querySelector?.('[data-ubuddy-pending-badge]');
  if (!button || !badge) return;
  const count = uBuddyPendingTaskCount({ tasks: state.tasks, taskViewsById: state.uBuddyTaskViewsById });
  const label = state.languageMode === 'en'
    ? `uBuddy, ${count} item${count === 1 ? ' needs' : 's need'} your attention`
    : `uBuddy，有 ${count} 条待处理`;
  button.classList.toggle('has-pending', count > 0);
  button.setAttribute('aria-label', count ? label : 'uBuddy');
  badge.hidden = count <= 0;
  badge.textContent = count > 99 ? '99+' : String(count);
  syncPrimaryNavigationNotices();
}

function syncPrimaryNavigationNotices() {
  for (const id of ['messages', 'friends']) {
    const button = document.querySelector(`[data-network-view="${id}"]`);
    if (!button) continue;
    const notice = primaryNavigationNotice(id);
    button.classList.toggle('has-unread', notice.badgeCount > 0);
    button.classList.toggle('has-pending', notice.pendingCount > 0);
    button.classList.toggle('has-active-run', notice.privateAssistantRunning);
    button.classList.toggle('has-private-result', notice.privateAssistantResultUnread);
    button.dataset.unreadCount = String(notice.unreadCount);
    button.dataset.pendingCount = String(notice.pendingCount);
    button.dataset.notificationCount = String(notice.badgeCount);
    if (notice.ariaLabel) button.setAttribute('aria-label', notice.ariaLabel);
    else button.removeAttribute('aria-label');
    button.querySelector('.sidebar-nav-pending')?.remove();
    let badge = button.querySelector('.sidebar-nav-unread');
    if (notice.badgeCount > 0) {
      if (!badge) {
        badge = document.createElement('b');
        badge.className = 'sidebar-nav-unread';
        badge.setAttribute('aria-hidden', 'true');
        button.append(badge);
      }
      badge.classList.toggle('is-dot', id === 'messages');
      badge.textContent = id === 'messages' ? '' : notice.badgeLabel;
    } else badge?.remove();
  }
}

function applyRemoteStartupBootstrap(boot = {}) {
  state.friendOverview = boot.friendOverview || state.friendOverview;
  state.socialInbox = boot.socialInbox || state.socialInbox;
  state.agentDelegations = boot.agentDelegations || state.agentDelegations;
  state.collaborationOverview = boot.collaboration || state.collaborationOverview;
  state.chatGroupsOverview = boot.chatGroups || state.chatGroupsOverview;
  noteDirectoryGroups(state.collaborationOverview);
  if (state.collaborationOverview?.tasks?.length) state.agentDelegations = state.collaborationOverview.tasks;
  state.socialStatus = boot.socialStatus || state.socialStatus;
  state.employeeOverview = boot.employees || state.employeeOverview;
  applyEmployeeWorkStatusSnapshot(state, state.employeeOverview?.roster || []);
  state.personalEvolutionStatus = boot.personalEvolutionStatus || state.personalEvolutionStatus;
  state.stage8EvolutionStatus = boot.stage8EvolutionStatus || state.stage8EvolutionStatus;
  state.clusterEvolutionOverview = boot.clusterEvolutionOverview || state.clusterEvolutionOverview;
  state.personalEvolutionProposals = boot.personalEvolutionProposals || state.personalEvolutionProposals;
  state.cloudSync = boot.cloudSync || state.cloudSync;
  state.agentStatuses = boot.agentStatuses || state.agentStatuses;
  state.userAgentSettings = boot.userAgentSettings || state.userAgentSettings;
  applyDesktopLifecycle(boot.desktopLifecycle);
  applyModelCatalog(boot.modelCatalog || null);
}

function applyDesktopLifecycle(status = null) {
  if (!status || typeof status !== 'object') return state.desktopLifecycle;
  state.desktopLifecycle = { ...(state.desktopLifecycle || {}), ...status };
  return state.desktopLifecycle;
}

async function setDesktopCloseBehavior(closeBehavior) {
  if (state.desktopLifecycleBusy) return;
  state.desktopLifecycleBusy = true;
  render();
  try {
    applyDesktopLifecycle(await window.janus.setDesktopCloseBehavior(closeBehavior));
    notify(closeBehavior === 'background' ? '关闭窗口后将在后台继续运行。' : '关闭最后一个窗口后将退出 Janus。', 'success');
  } catch (error) {
    notify(userVisibleErrorMessage(error, '无法更新窗口关闭行为。'), 'error');
  } finally {
    state.desktopLifecycleBusy = false;
    render();
  }
}

async function completeStartupBackgroundRefresh({ userId = '', workspaceId = '', workspaceGeneration = 0 } = {}) {
  const startedAt = Date.now();
  const [remoteBoot, appUpdates, agentUpdates] = await Promise.allSettled([
    window.janus.bootstrap({ remote: true, preloadMessages: false }),
    window.janus.updateStatus(),
    window.janus.agentUpdateStatus(),
  ]);
  const stillCurrent = String(state.currentUser?.id || '') === String(userId || '')
    && String(state.activeAccountWorkspace?.id || '') === String(workspaceId || '')
    && state.workspaceSwitchGeneration === workspaceGeneration;
  if (remoteBoot.status === 'fulfilled' && stillCurrent) {
    applyRemoteStartupBootstrap(remoteBoot.value || {});
  } else if (remoteBoot.status === 'rejected') {
    appendStatus(`Janus background bootstrap failed: ${remoteBoot.reason?.message || remoteBoot.reason}`);
  }
  if (appUpdates.status === 'fulfilled') state.updates = appUpdates.value || state.updates;
  else appendStatus(`Software update status failed: ${appUpdates.reason?.message || appUpdates.reason}`);
  if (agentUpdates.status === 'fulfilled') state.agentUpdates = agentUpdates.value || state.agentUpdates;
  else appendStatus(`Agent update status failed: ${agentUpdates.reason?.message || agentUpdates.reason}`);
  if (stillCurrent && isCurrentUserAdmin()) await refreshReleaseStatus(false);
  maybeQueueInitialUpdateAnnouncement();
  if (stillCurrent) render();
  reportRendererEvent('info', 'renderer-background-bootstrap-complete', null, {
    durationMs: Date.now() - startedAt,
    remoteBootstrapOk: remoteBoot.status === 'fulfilled',
  });
}

function installSystemNotificationNavigationListeners() {
  removeSocialOpenTaskListener?.();
  removeSystemOpenConversationListener?.();
  removeSystemOpenAgentSessionListener?.();
  removeSystemOpenUpdatesListener?.();
  removeSystemOpenFollowerListener?.();
  removeSocialOpenTaskListener = window.janus.onSocialOpenTask?.(({ delegationId } = {}) => {
    if (!delegationId) return;
    if (state.uBuddyFeatureFlags?.newTaskWorkspaceUi === false) {
      notify('当前处于旧版任务视图，请从原会话任务卡查看任务。', 'info');
      return;
    }
    void (async () => {
      await openNetworkPanel('tasks');
      await openNetworkDelegation(delegationId);
    })();
  }) || null;
  removeSystemOpenConversationListener = window.janus.onSystemOpenConversation?.(({ peerId } = {}) => {
    if (peerId) void (async () => { await openNetworkPanel('messages'); await openNetworkConversation(peerId, 'person'); })();
  }) || null;
  removeSystemOpenAgentSessionListener = window.janus.onSystemOpenAgentSession?.(({ sessionId } = {}) => {
    if (sessionId) void openSession(sessionId);
  }) || null;
  removeSystemOpenUpdatesListener = window.janus.onSystemOpenUpdates?.(() => {
    handleAccountUpdateClick();
  }) || null;
  removeSystemOpenFollowerListener = window.janus.onSystemOpenFollower?.(({ reportId = '' } = {}) => {
    void (async () => {
      await followerController.open();
      state.followerActiveSection = reportId ? 'reports' : 'overview';
      if (reportId) {
        try { state.followerSelectedReport = await window.janus.followerReportOpen({ reportId }); } catch {}
      }
      render();
    })();
  }) || null;
  removeDesktopNotificationListener?.();
  removeDesktopNotificationListener = window.janus.onDesktopNotification?.((payload = {}) => {
    enqueueDesktopNotification(payload);
  }) || null;
}

function enqueueDesktopNotification(payload = {}) {
  const id = String(payload.id || payload.key || `${Date.now()}-${Math.random()}`);
  if (state.desktopNotifications.some((item) => item.id === id)) return;
  const item = { ...payload, id, createdAt: Date.now() };
  state.desktopNotifications = [...state.desktopNotifications.slice(-19), item];
  syncDesktopNotificationStack();
  clearTimeout(enqueueDesktopNotification.timer);
  enqueueDesktopNotification.timer = setTimeout(() => syncDesktopNotificationStack(), 2800);
}

function syncDesktopNotificationStack() {
  let stack = document.querySelector('.desktop-notification-stack');
  if (!state.desktopNotifications.length) { stack?.remove(); return; }
  if (!stack) { stack = document.createElement('div'); stack.className = 'desktop-notification-stack'; document.querySelector('.shell')?.appendChild(stack); }
  const items = state.desktopNotifications;
  const collapsed = items.length > 1 && !stack.classList.contains('is-expanded');
  const lang = state.languageMode === 'en';
  const countText = lang ? `${items.length} new message${items.length === 1 ? '' : 's'}` : `${items.length} 条新消息`;
  stack.innerHTML = '';
  const summary = document.createElement('div');
  summary.className = 'desktop-notification-summary';
  summary.innerHTML = `<strong>${countText}</strong><button type="button" class="desktop-notification-toggle" aria-label="${lang ? (collapsed ? 'Expand notifications' : 'Collapse notifications') : (collapsed ? '展开通知' : '收起通知')}">${collapsed ? '⌄' : '⌃'}</button>`;
  summary.querySelector('button').onclick = () => { stack.classList.toggle('is-expanded'); syncDesktopNotificationStack(); };
  stack.appendChild(summary);
  const list = document.createElement('div'); list.className = 'desktop-notification-list'; list.hidden = collapsed;
  for (const notice of [...items].reverse()) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'desktop-notification-item';
    row.innerHTML = `<span class="desktop-notification-title">${escapeHtml(notice.title || (lang ? 'New message' : '新消息'))}</span><span class="desktop-notification-body">${escapeHtml(notice.body || '')}</span>`;
    row.onclick = () => {
      state.desktopNotifications = state.desktopNotifications.filter((item) => item.id !== notice.id);
      syncDesktopNotificationStack();
      const target = notice.target || {};
      if (target.channel === 'system:open-conversation' && target.payload?.peerId) void (async () => { await openNetworkPanel('messages'); await openNetworkConversation(target.payload.peerId, 'person'); })();
      if (target.channel === 'social:open-task' && target.payload?.delegationId) void openNetworkDelegation(target.payload.delegationId);
      if (target.channel === 'system:open-agent-session' && target.payload?.sessionId) void openSession(target.payload.sessionId);
      if (target.channel === 'system:open-updates') handleAccountUpdateClick();
      if (target.channel === 'system:open-follower') {
        void (async () => { await followerController.open(); state.followerActiveSection = target.payload?.reportId ? 'reports' : 'overview'; render(); })();
      }
    };
    list.appendChild(row);
  }
  stack.appendChild(list);
}

async function init() {
  void window.janus.setUiLanguage?.(state.languageMode).catch?.(() => {});
  installPersistentNavigationEvents();
  const announcementPreferences = loadUpdateAnnouncementPreferences();
  state.updateAnnouncementAutoPopup = announcementPreferences.autoPopup;
  state.updateAnnouncementLastSeenInstalledVersion = announcementPreferences.lastSeenInstalledVersion;
  state.updateAnnouncementLastSeenAvailableVersion = announcementPreferences.lastSeenAvailableVersion;
  state.updateAnnouncementInitialized = true;
  handleLocationHashAction({ replace: true });
  removeCodexListener = window.janus.onCodexEvent(({ channelId, event }) => {
    appendStatus(`[${channelId}] ${event.kind}: ${event.message || event.content || event.answer || event.threadId || ''}`);
    handleChatRunEvent(channelId, event);
  });
  removeChatSessionUpdatedListener = window.janus.onChatSessionUpdated?.((payload) => {
    void refreshExternallyUpdatedSession(payload).catch((error) => {
      appendStatus(`External Session refresh failed: ${error.message || error}`);
    });
  }) || null;
  removeChatUserInputWindowListener = window.janus.onChatUserInputWindowClosed?.(handleChatUserInputWindowClosed) || null;
  removeUpdateListener = window.janus.onUpdateStatus((payload) => {
    const previousRenderKey = updateCenterRenderKey(state.updates, state.agentUpdates);
    state.updates = payload || state.updates;
    maybeQueueAvailableUpdateAnnouncement();
    if (state.currentUser && previousRenderKey !== updateCenterRenderKey(state.updates, state.agentUpdates)) render();
    else syncUpdateProgressStatus();
  });
  removeAgentUpdateListener = window.janus.onAgentUpdateStatus?.((payload) => {
    const previousRenderKey = updateCenterRenderKey(state.updates, state.agentUpdates);
    const previousBundleId = state.agentUpdates?.current?.bundleId || '';
    state.agentUpdates = payload || state.agentUpdates;
    const installedBundleId = state.agentUpdates?.current?.bundleId || '';
    if (installedBundleId && installedBundleId !== previousBundleId && !state.agentUpdates?.applying) {
      window.janus.bootstrap().then((boot) => {
        state.org = boot.org || state.org;
        state.agentStatuses = boot.agentStatuses || state.agentStatuses;
        if (state.currentUser) render();
      }).catch((error) => appendStatus(`Janus background update refresh failed: ${error.message || error}`));
    }
    if (state.currentUser && previousRenderKey !== updateCenterRenderKey(state.updates, state.agentUpdates)) render();
  }) || null;
  removeDesktopLifecycleListener = window.janus.onDesktopLifecycleChanged?.((payload) => {
    applyDesktopLifecycle(payload);
    if (state.currentTab === 'settings' && state.currentSettingsSection === 'preferences') render();
  }) || null;
  removeCodexPluginsChangedListener = window.janus.onCodexPluginsChanged?.((payload = {}) => {
    const currentUserId = String(state.currentUser?.id || '');
    if (payload.userId && String(payload.userId) !== currentUserId) return;
    if (!payload.catalog) return;
    state.codexPlugins = payload.catalog;
    render();
  }) || null;
  removeAttachedSkillsChangedListener = window.janus.onAttachedSkillsChanged?.((payload = {}) => {
    const currentUserId = String(state.currentUser?.id || '');
    if (payload.userId && String(payload.userId) !== currentUserId) return;
    if (!payload.catalog) return;
    state.attachedSkillCatalog = payload.catalog;
    render();
  }) || null;
  const handlePluginProgress = (payload = {}) => {
    const pluginId = payload.pluginId || 'ppt_creation';
    const progress = payload.pluginId ? payload : { pluginId, ...payload };
    state.pluginOperations = {
      ...(state.pluginOperations || {}),
      [pluginId]: { ...(state.pluginOperations?.[pluginId] || {}), busy: true, progress },
    };
    if (pluginId === 'ppt_creation') state.pluginInstallProgress = progress;
    if (state.currentTab === 'plugins' || (state.currentTab === 'settings' && state.currentSettingsSection === 'skills')) render();
  };
  removePptxPluginProgressListener = window.janus.onPluginProgress?.(handlePluginProgress)
    || window.janus.onPptxPluginProgress?.(handlePluginProgress)
    || null;
  removeEvolutionProgressListener = window.janus.onEvolutionProgress?.((payload) => {
    handleEvolutionProgress(payload);
  }) || null;
  removeModelsListener = window.janus.onModelsUpdated?.((payload) => {
    applyModelCatalog(payload);
    if (state.currentUser) render();
  }) || null;
  removeSocialListener = window.janus.onSocialUpdated?.((payload) => {
    const activeWorkspaceId = state.activeAccountWorkspace?.id || 'workspace_personal';
    const payloadWorkspaceId = payload?.workspaceId || payload?.accountWorkspaceId || '';
    if ((payloadWorkspaceId && payloadWorkspaceId !== activeWorkspaceId)
      || (!payloadWorkspaceId && activeWorkspaceId !== 'workspace_personal')) return;
    const workspaceGeneration = state.workspaceSwitchGeneration;
    const previousRenderKey = socialUiRenderKey();
    state.socialStatus = payload?.status || state.socialStatus;
    state.friendOverview = payload?.friends || state.friendOverview;
    state.socialInbox = payload?.inbox || state.socialInbox;
    state.agentDelegations = payload?.delegations || state.agentDelegations;
    const nextCollaboration = payload?.collaboration || state.collaborationOverview;
    noteDirectoryGroups(nextCollaboration);
    state.collaborationOverview = nextCollaboration;
    state.chatGroupsOverview = payload?.chatGroups || state.chatGroupsOverview;
    if (payload?.collaboration?.tasks?.length) state.agentDelegations = payload.collaboration.tasks;
    if (payload?.delegations || payload?.collaboration?.tasks) {
      if (state.uBuddyCenterOpen === 'deliveries') void loadUBuddyCenter();
      else void refreshUBuddyDeliveryCenterCount();
    }
    syncPrimaryNavigationNotices();
    const socialUiChanged = previousRenderKey !== socialUiRenderKey();
    const recoveredDispatchPublished = Number(payload?.uBuddyDispatchRecovery?.published || 0) > 0;
    if (recoveredDispatchPublished && state.networkConversationPeerId !== 'self-secretary') {
      const sessionId = state.currentSessionId;
      const session = state.sessions.find((item) => item.id === sessionId);
      if (sessionId && session?.departmentId === 'secretary_department') {
        loadLatestRendererMessagePage(sessionId).then((page) => {
          if (workspaceGeneration !== state.workspaceSwitchGeneration || state.currentSessionId !== sessionId) return;
          if (applyLatestRendererMessagePage(sessionId, page)) renderPreservingNetworkComposer();
        }).catch(() => null);
      }
    } else if (recoveredDispatchPublished && !socialUiChanged && state.networkConversationPeerId === 'self-secretary') {
      loadSecretaryConversationMessages().then((applied) => {
        if (workspaceGeneration === state.workspaceSwitchGeneration && applied) renderPreservingNetworkComposer();
      }).catch(() => null);
    }
    if (state.networkPanelOpen || state.collaborationGroupId) {
      if (state.chatGroupId) {
        const groupId = state.chatGroupId;
        window.janus.chatGroup({ groupId }).then((detail) => {
          if (workspaceGeneration !== state.workspaceSwitchGeneration || state.chatGroupId !== groupId) return;
          const previousDetail = state.chatGroupDetail;
          state.chatGroupDetail = detail;
          state.chatGroupDetailCache = { ...(state.chatGroupDetailCache || {}), [groupId]: detail };
          if (!maybeAutoOpenDispatchedCollaborationGroup(detail, groupId, previousDetail)) renderPreservingNetworkComposer();
        }).catch(() => {
          if (workspaceGeneration === state.workspaceSwitchGeneration && state.chatGroupId === groupId) {
            renderPreservingNetworkComposer();
          }
        });
      } else if (state.collaborationGroupId && state.collaborationGroupDetail) {
        refreshCollaborationGroupDetail(state.collaborationGroupId, true).catch(() => {
          renderPreservingNetworkComposer();
        });
      } else if (state.networkConversationPeerId === 'self-secretary') {
        loadSecretaryConversationMessages().then((applied) => {
          if (applied) renderPreservingNetworkComposer();
        }).catch(() => {
          if (state.networkConversationPeerId === 'self-secretary') renderPreservingNetworkComposer();
        });
      } else if (state.networkDelegationId) {
        const delegationId = state.networkDelegationId;
        Promise.all([
          window.janus.collaborationWorkspaceMessages({ delegationId }),
          window.janus.delegationTaskMemory({ delegationId }),
        ]).then(([items, taskMemory]) => {
          if (workspaceGeneration !== state.workspaceSwitchGeneration || state.networkDelegationId !== delegationId) return;
          state.networkConversationMessages = (items || []).filter((message) => {
            const metadata = message?.metadata || {};
            const messageDelegationId = message?.delegationId || message?.delegation_id || metadata.delegationId || metadata.delegation_id || metadata.agentDelegationId || '';
            return messageDelegationId === delegationId && metadata.privateTaskWorkspace === true;
          });
          state.networkDelegationMemory = taskMemory || null;
          state.networkDelegationRunsById = {
            ...(state.networkDelegationRunsById || {}),
            [delegationId]: Array.isArray(taskMemory?.runs) ? taskMemory.runs : (state.networkDelegationRunsById?.[delegationId] || []),
          };
          renderPreservingNetworkComposer();
        }).catch(() => null);
      } else if (state.networkConversationPeerId) {
        const peerId = state.networkConversationPeerId;
        const conversationMode = state.networkConversationMode;
        const conversationGroupId = state.networkConversationGroupId;
        Promise.all([
          window.janus.socialConversation({ peerId }),
          refreshSocialThreads(false),
        ]).then(([items]) => {
          if (workspaceGeneration !== state.workspaceSwitchGeneration
            || state.networkConversationPeerId !== peerId
            || state.networkConversationMode !== conversationMode
            || state.networkConversationGroupId !== conversationGroupId) return;
          state.networkConversationMessages = items || [];
          renderPreservingNetworkComposer();
        }).catch(() => null);
      } else refreshSocialThreads(true).catch(() => renderPreservingNetworkComposer());
    }
  }) || null;
  removeEmployeesUpdatedListener = window.janus.onEmployeesUpdated?.((payload = {}) => {
    const payloadUserId = String(payload.userId || '');
    const payloadWorkspaceId = String(payload.accountWorkspaceId || payload.workspaceId || '');
    const currentUserId = String(state.currentUser?.id || '');
    const currentWorkspaceId = String(state.activeAccountWorkspace?.id || 'workspace_personal');
    if ((payloadUserId && payloadUserId !== currentUserId)
      || (payloadWorkspaceId && payloadWorkspaceId !== currentWorkspaceId)) return;
    if (payload.reason === 'effective_skill_changed') {
      const secretaryInstanceId = state.userAgentSettings?.find((item) => item.agentFamilyId === 'secretary_agent')?.id || '';
      if (!payload.agentInstanceId || !secretaryInstanceId || payload.agentInstanceId === secretaryInstanceId) {
        state.uBuddyCapabilityProfilePreview = null;
        state.uBuddyCapabilityProfilePreviewError = '';
      }
    }
    void refreshEmployeeConversationState({ renderAfter: true, reason: payload.reason || 'employees_updated' });
  }) || null;
  removeAgentDeliveryListener = window.janus.onAgentDeliveryUpdated?.((payload = {}) => {
    const payloadWorkspaceId = payload.receipt?.workspaceId || payload.receipt?.accountWorkspaceId
      || payload.session?.workspaceId || payload.session?.accountWorkspaceId || '';
    if (payloadWorkspaceId && payloadWorkspaceId !== (state.activeAccountWorkspace?.id || 'workspace_personal')) return;
    if (payload.receipt?.workId && payload.receipt?.deliveryStatus) {
      updatePublishedTaskCardStatus(payload.receipt.workId, payload.receipt.deliveryStatus);
    }
    const workspaceGeneration = state.workspaceSwitchGeneration;
    const workspaceDelegationId = String(payload.receipt?.metadata?.delegationId || '');
    if (workspaceDelegationId && payload.receipt?.metadata?.surface === 'delegation_workspace') {
      const currentRuns = [...(state.networkDelegationRunsById?.[workspaceDelegationId] || [])];
      const index = currentRuns.findIndex((item) => item.workId === payload.receipt.workId);
      const previous = index >= 0 ? currentRuns[index] : { ...payload.receipt, events: [] };
      const events = [...(previous.events || [])];
      if (payload.event && !events.some((item) => Number(item.sequenceNo || 0) === Number(payload.event.sequenceNo || 0))) events.push(payload.event);
      const nextReceipt = { ...previous, ...payload.receipt, events: events.sort((left, right) => Number(left.sequenceNo || 0) - Number(right.sequenceNo || 0)) };
      if (['queued', 'running'].includes(String(nextReceipt.deliveryStatus || ''))) {
        if (index >= 0) currentRuns[index] = nextReceipt;
        else currentRuns.unshift(nextReceipt);
      } else if (index >= 0) currentRuns.splice(index, 1);
      state.networkDelegationRunsById = { ...(state.networkDelegationRunsById || {}), [workspaceDelegationId]: currentRuns };
      if (state.networkDelegationId === workspaceDelegationId && !['queued', 'running'].includes(String(nextReceipt.deliveryStatus || ''))) {
        Promise.all([
          window.janus.collaborationWorkspaceMessages({ delegationId: workspaceDelegationId }),
          window.janus.delegationTaskMemory({ delegationId: workspaceDelegationId }),
        ]).then(([messages, memory]) => {
          if (workspaceGeneration !== state.workspaceSwitchGeneration || state.networkDelegationId !== workspaceDelegationId) return;
          state.networkConversationMessages = messages || state.networkConversationMessages;
          state.networkDelegationMemory = memory || state.networkDelegationMemory;
          renderPreservingNetworkComposer();
        }).catch(() => renderPreservingNetworkComposer());
      } else if (state.networkDelegationId === workspaceDelegationId) renderPreservingNetworkComposer();
      return;
    }
    const knownSessionIds = new Set((state.sessions || []).map((session) => session.id));
    handleAgentDeliveryUpdate(payload);
    if (payload.session?.id) upsertRecentSession(payload.session);
    if (payload.sourceSession?.id) upsertRecentSession(payload.sourceSession);
    const targetSessionId = payload.receipt?.targetSessionId || payload.session?.id || '';
    const sourceSessionId = payload.receipt?.sourceSessionId || '';
    if (payload.event && ['queued', 'running'].includes(String(payload.receipt?.deliveryStatus || ''))) {
      const insertedSession = [payload.session?.id, payload.sourceSession?.id]
        .filter(Boolean)
        .some((sessionId) => !knownSessionIds.has(sessionId));
      if (insertedSession) render();
      return;
    }
    const refreshSessionId = state.currentSessionId && [targetSessionId, sourceSessionId].includes(state.currentSessionId)
      ? state.currentSessionId : '';
    Promise.all([
      window.janus.listSessions(),
      refreshSessionId
        ? loadLatestRendererMessagePage(refreshSessionId)
        : Promise.resolve(null),
    ]).then(([sessions, messagePage]) => {
      if (workspaceGeneration !== state.workspaceSwitchGeneration) return;
      state.sessions = sessions || state.sessions;
      if (messagePage) applyLatestRendererMessagePage(refreshSessionId, messagePage);
      if (payload.receipt?.workId && payload.receipt?.deliveryStatus) {
        updatePublishedTaskCardStatus(payload.receipt.workId, payload.receipt.deliveryStatus);
      }
      render();
    }).catch(() => null);
  }) || null;
  removeTaskUpdateListener = window.janus.onTaskUpdated?.((payload = {}) => {
    const noticeUpdate = applyDelegationNoticeUpsert(state, payload);
    if (noticeUpdate.currentSession && state.activeTaskWorkspaceKind !== 'task_run') render();
    const incomingTask = payload.task || null;
    const incomingTaskId = String(incomingTask?.id || payload.taskRunId || payload.task_run_id || '').trim();
    const existingTask = incomingTaskId
      ? (state.taskDetail?.id === incomingTaskId ? state.taskDetail : (state.tasks || []).find((task) => task.id === incomingTaskId) || null)
      : null;
    const activeWorkspaceTaskUpdate = state.activeTaskWorkspaceKind === 'task_run'
      && (String(state.activeTaskWorkspaceId || '') === incomingTaskId
        || String(state.taskDetail?.id || '') === incomingTaskId
        || String(state.taskRunWorkspaceActiveRunById?.[state.activeTaskWorkspaceId] || '') === incomingTaskId);
    const task = activeWorkspaceTaskUpdate
      ? mergeTaskWorkspaceSnapshot(existingTask, incomingTask, mergeTaskUpdateSnapshot) || existingTask
      : mergeTaskUpdateSnapshot(existingTask, incomingTask) || existingTask;
    if (task?.id) mergeUBuddyTaskView(state, task);
    const taskPayload = { ...payload, task };
    const payloadWorkspaceId = task?.workspaceId || task?.accountWorkspaceId
      || payload.delegation?.workspaceId || payload.delegation?.accountWorkspaceId || '';
    if (payloadWorkspaceId && payloadWorkspaceId !== (state.activeAccountWorkspace?.id || 'workspace_personal')) return;
    const workspaceGeneration = state.workspaceSwitchGeneration;
    const coordinationUpdate = applyCoordinationUpdate(state, taskPayload, task);
    const updatedDelegationId = applyDelegationTaskUpdate(state, taskPayload);
    if (state.collaborationGroupDetail && updatedDelegationId) {
      const incomingDelegation = payload.delegation && typeof payload.delegation === 'object' ? payload.delegation : null;
      state.collaborationGroupDetail = {
        ...state.collaborationGroupDetail,
        tasks: (state.collaborationGroupDetail.tasks || []).map((item) => {
          if (String(item?.id || '') !== updatedDelegationId) return item;
          return incomingDelegation
            ? { ...item, ...incomingDelegation, metadata: { ...(item.metadata || {}), ...(incomingDelegation.metadata || {}) } }
            : { ...item, metadata: { ...(item.metadata || {}), executionProgress: state.networkDelegationProgressById?.[updatedDelegationId] || item.metadata?.executionProgress } };
        }),
      };
    }
    const taskChatUpdated = task ? handleTaskUpdate(taskPayload) : false;
    const updatedEmployeeWorkIds = updateEmployeeConversationWorkFromTask(task);
    if (updatedEmployeeWorkIds.length) {
      patchAgentWorkStatusElements(updatedEmployeeWorkIds);
      patchMessageAgentStatusRows(updatedEmployeeWorkIds);
    }
    const assignedEmployeeIds = taskAgentInstanceIds(task);
    const terminalTask = ['completed', 'failed', 'cancelled'].includes(String(task?.status || ''));
    const employeeOverviewRefreshIds = assignedEmployeeIds.filter((agentInstanceId) => {
      const currentTaskRunId = String(state.employeeConversationOverviewByInstanceId?.[agentInstanceId]?.activeWork?.taskRunId || '');
      return terminalTask || currentTaskRunId !== String(task?.id || '');
    });
    if (employeeOverviewRefreshIds.length) {
      void Promise.all(employeeOverviewRefreshIds.map((agentInstanceId) => (
        refreshEmployeeConversationOverview(agentInstanceId, { renderAfter: true })
      )));
    }
    const taskId = task?.id || coordinationUpdate.taskRunId || incomingTaskId;
    const delegationId = String(task?.metadata?.delegationId || updatedDelegationId || payload.delegation?.id || '');
    const delegationSurfaceVisible = Boolean(updatedDelegationId && state.networkDelegationId === updatedDelegationId);
    const taskSurfaceVisible = state.currentTab === 'collaboration'
      || Boolean(state.collaborationGroupId)
      || (state.networkPanelOpen && state.networkPanelView === 'tasks');
    if (!taskId) {
      const delegationChatVisible = state.currentTab === 'chat'
        && Boolean(state.currentSessionId)
        && (state.messages || []).some((message) => String(message.metadata?.externalDelegationId || '') === delegationId);
      if (!noticeUpdate.currentSession && (delegationSurfaceVisible || taskSurfaceVisible || delegationChatVisible)) {
        if (delegationSurfaceVisible) renderPreservingNetworkComposer();
        else render();
      }
      return;
    }
    if (task) {
      const taskIndex = (state.tasks || []).findIndex((item) => item.id === taskId);
      if (taskIndex >= 0) state.tasks[taskIndex] = task;
      else state.tasks = [task, ...(state.tasks || [])];
      if (state.taskDetail?.id === taskId) state.taskDetail = task;
    }
    syncUBuddyPendingBadge();
    const currentSessionTask = Boolean(task && state.currentSessionId
      && taskBelongsToSession(task, state.currentSessionId, state.messages));
    const visibleTaskChangeType = String(payload.change?.type || '');
    const userVisibleTaskChange = currentSessionTask && (
      /(?:failed|blocked|retry|completed|cancelled|action_required|delivery|continued)/i.test(visibleTaskChangeType)
      || ['waiting', 'verifying', 'delivering', 'completed', 'failed', 'cancelled'].includes(String(task?.status || ''))
    );
    if (terminalTask || /(?:delivery|revision|accepted)/i.test(visibleTaskChangeType)) {
      if (state.uBuddyCenterOpen) void loadUBuddyCenter();
      else void refreshUBuddyDeliveryCenterCount();
    }
    if (userVisibleTaskChange) noteCurrentUBuddyTaskUpdate();
    if (currentSessionTask) patchUBuddyTaskDisplay();
    if (coordinationUpdate.applied) {
      patchAgentWorkStatusElements(coordinationUpdate.agentInstanceIds);
      patchUBuddyCoordinationPanels(taskId, task);
    }
    const coordinationOnlyUpdate = coordinationUpdate.applied
      && !terminalTask
      && !payload.change?.node
      && !payload.change?.progress
      && !['node_activity', 'node_progress', 'node_heartbeat'].includes(String(payload.change?.type || ''));
    if (coordinationOnlyUpdate) return;
    const refreshCurrentTaskChat = terminalTask && state.currentSessionId
      && (state.messages || []).some((message) => message.metadata?.taskRunId === taskId);
    const refreshTaskSessionId = refreshCurrentTaskChat ? state.currentSessionId : '';
    const taskChatVisible = state.currentTab === 'chat'
      && Boolean(state.currentSessionId)
      && (state.messages || []).some((message) => message.metadata?.taskRunId === taskId);
    const employeeWorkVisible = state.currentTab === 'chat'
      && [...updatedEmployeeWorkIds, ...assignedEmployeeIds].includes(String(state.currentAgentInstanceId || ''));
    if (!terminalTask) {
      if (delegationSurfaceVisible) renderPreservingNetworkComposer();
      else if (activeWorkspaceTaskUpdate && state.currentTab === 'collaboration') scheduleTaskWorkspaceRender();
      else if (taskSurfaceVisible || ((taskChatVisible || employeeWorkVisible) && !taskChatUpdated)) render();
      return;
    }
    Promise.all([
      window.janus.listTasks(),
      taskId && state.taskDetail?.id === taskId ? window.janus.getTask(taskId) : Promise.resolve(null),
      refreshTaskSessionId ? loadLatestRendererMessagePage(refreshTaskSessionId) : Promise.resolve(null),
    ]).then(([tasks, detail, messagePage]) => {
      if (workspaceGeneration !== state.workspaceSwitchGeneration) return;
      state.tasks = tasks || state.tasks;
      if (detail) {
        state.taskDetail = detail;
        mergeUBuddyTaskView(state, detail);
      }
      syncUBuddyPendingBadge();
      if (messagePage) applyLatestRendererMessagePage(refreshTaskSessionId, messagePage);
      const delegationStillVisible = Boolean(updatedDelegationId && state.networkDelegationId === updatedDelegationId);
      const taskSurfaceStillVisible = state.currentTab === 'collaboration'
        || Boolean(state.collaborationGroupId)
        || (state.networkPanelOpen && state.networkPanelView === 'tasks');
      const taskChatStillVisible = state.currentTab === 'chat'
        && Boolean(messagePage)
        && (state.messages || []).some((message) => message.metadata?.taskRunId === taskId);
      const activeWorkspaceStillVisible = state.activeTaskWorkspaceKind === 'task_run'
        && (String(state.activeTaskWorkspaceId || '') === String(taskId || '')
          || String(state.taskDetail?.id || '') === String(taskId || '')
          || String(state.taskRunWorkspaceActiveRunById?.[state.activeTaskWorkspaceId] || '') === String(taskId || ''));
      if (delegationStillVisible) renderPreservingNetworkComposer();
      else if (activeWorkspaceStillVisible && state.currentTab === 'collaboration') scheduleTaskWorkspaceRender();
      else if (taskChatStillVisible || taskSurfaceStillVisible || employeeWorkVisible
        || (delegationId && (state.collaborationGroupId || state.networkDelegationId))) render();
      if (taskChatStillVisible || currentSessionTask) patchUBuddyTaskDisplay();
    }).catch(() => null);
  }) || null;
  removeAgentAvailabilityListener = window.janus.onAgentAvailabilityChanged?.((payload = {}) => {
    if (!agentWorkEventMatchesWorkspace(payload, state.activeAccountWorkspace?.id || 'workspace_personal')) return;
    const statuses = Array.isArray(payload.statuses) ? payload.statuses : payload?.agentInstanceId ? [payload] : [];
    const familyStatuses = Array.isArray(payload.agentStatuses) ? payload.agentStatuses : [];
    if (!statuses.length && !familyStatuses.length) return;
    if (familyStatuses.length) state.agentStatuses = familyStatuses;
    const ids = applyAgentWorkStatusUpdates(state, statuses);
    if (state.employeeOverview?.roster?.length) {
      const mergedStatuses = new Map(ids.map((agentInstanceId) => [
        String(agentInstanceId), state.agentWorkStatusByInstanceId?.[agentInstanceId] || null,
      ]));
      state.employeeOverview = {
        ...state.employeeOverview,
        roster: state.employeeOverview.roster.map((employee) => mergedStatuses.get(employee.id)
          ? { ...employee, ...mergedStatuses.get(employee.id) }
          : employee),
      };
    }
    const aggregatedStatusVisible = state.currentTab === 'collaboration'
      || (state.networkPanelOpen && (state.networkPanelView === 'tasks' || Boolean(state.collaborationGroupId)));
    if (familyStatuses.length && aggregatedStatusVisible) {
      render();
      return;
    }
    patchAgentWorkStatusElements(ids);
    patchMessageAgentStatusRows(ids);
    for (const status of statuses) {
      const agentInstanceId = String(status?.agentInstanceId || status?.agent_instance_id || '');
      const incomingTaskRunId = String(status?.currentWork?.taskRunId || status?.current_work?.task_run_id
        || status?.currentWork?.payload?.taskRunId || payload.taskRunId || '');
      const cachedTaskRunId = String(state.employeeConversationOverviewByInstanceId?.[agentInstanceId]?.activeWork?.taskRunId || '');
      const incomingWorkState = String(status?.workState || status?.work_state || '').toLowerCase();
      const incomingAvailability = String(status?.availability || '').toLowerCase();
      const runningWithoutTaskIdentity = !incomingTaskRunId
        && (incomingAvailability === 'working' || ['working', 'queued', 'reserved', 'blocked'].includes(incomingWorkState));
      if (agentInstanceId && (runningWithoutTaskIdentity || incomingTaskRunId !== cachedTaskRunId)) {
        void refreshEmployeeConversationOverview(agentInstanceId, { renderAfter: true });
      }
    }
  }) || null;
  window.addEventListener('resize', () => {
    if (state.modelMenuOpen) {
      clearTimeout(modelPlacementTimer);
      modelPlacementTimer = setTimeout(updateModelMenuPlacement, 60);
    }
    if (state.imageModelMenuOpen || state.pptTemplateMenuOpen || state.pptStyleMenuOpen || state.sandboxMenuOpen || state.workspaceMenuOpen) {
      scheduleComposerMetaMenuPlacement();
    }
    const nextMode = currentResponsiveLayoutMode();
    if (nextMode !== state.responsiveLayoutMode) {
      clearTimeout(responsiveLayoutTimer);
      responsiveLayoutTimer = null;
      state.responsiveLayoutMode = nextMode;
      render();
      return;
    }
    const relevantSurface = state.currentTab === 'chat'
      && state.networkPanelOpen
      && ['messages', 'friends'].includes(state.networkPanelView);
    if (!relevantSurface) return;
    clearTimeout(responsiveLayoutTimer);
    responsiveLayoutTimer = setTimeout(() => {
      responsiveLayoutTimer = null;
      render();
    }, 90);
  });
  installFileDropHandlers();
  const localBootstrapStartedAt = Date.now();
  const boot = await window.janus.bootstrap({ remote: false });
  state.appVersion = boot.appVersion || state.appVersion;
  state.appPackaged = boot.appPackaged === true;
  state.updatedLaunch = boot.updatedLaunch === true;
  applyDesktopLifecycle(boot.desktopLifecycle);
  state.root = boot.root;
  state.workspaceRoot = boot.workspaceRoot || boot.workspace_root || '';
  state.org = boot.org;
  state.sessions = boot.sessions || [];
  state.preloadedMessagePagesBySessionId = boot.messagePreload?.sessionPages || {};
  state.projects = boot.projects || [];
  state.tasks = boot.tasks || [];
  state.agentStatuses = boot.agentStatuses || [];
  state.evolution = boot.evolution;
  state.uBuddyOrganizationEvolution = boot.uBuddyOrganizationEvolution || state.uBuddyOrganizationEvolution;
  state.currentUser = boot.currentUser || null;
  state.accountWorkspaces = boot.accountWorkspaces || [];
  state.activeAccountWorkspace = boot.activeAccountWorkspace || null;
  state.startupAccountWorkspace = boot.startupAccountWorkspace || state.startupAccountWorkspace || null;
  state.uBuddyFeatureFlags = boot.uBuddyFeatureFlags || state.uBuddyFeatureFlags;
  hydrateComposerDrafts();
  state.adminUsers = boot.adminUsers || [];
  state.friendOverview = boot.friendOverview || { friends: [], requests: { incoming: [], outgoing: [] } };
  state.socialInbox = boot.socialInbox || [];
  state.socialThreads = boot.messagePreload?.socialThreads || [];
  state.conversationPreferences = boot.conversationPreferences || { preferences: [] };
  state.agentDelegations = boot.agentDelegations || [];
  state.collaborationOverview = boot.collaboration || { groups: [], tasks: state.agentDelegations };
  state.chatGroupsOverview = boot.chatGroups || { groups: [], capability: 'chat-groups-v2' };
  noteDirectoryGroups(state.collaborationOverview, { initialize: true });
  if (state.collaborationOverview.tasks?.length) state.agentDelegations = state.collaborationOverview.tasks;
  state.socialStatus = boot.socialStatus || state.socialStatus;
  state.codexConfig = boot.codexConfig || null;
  state.codexConfigFiles = boot.codexConfigFiles || null;
  state.providerKeyAccess = boot.providerKeyAccess || null;
  state.cloudSync = boot.cloudSync || null;
  state.userAgentSettings = boot.userAgentSettings || [];
  state.evolutionPreference = null;
  state.evolutionPreferenceLoading = false;
  state.evolutionPreferenceError = '';
  state.evolutionUpdates = null;
  state.evolutionUpdatesLoading = false;
  state.evolutionUpdatesError = '';
  state.personalEvolutionVersionsByAgent = {};
  state.personalEvolutionVersionLoadingId = '';
  state.personalEvolutionExpandedAgentIds = [];
  state.evolutionActionBusyKey = '';
  state.personalEvolutionStatus = boot.personalEvolutionStatus || null;
  state.stage8EvolutionStatus = boot.stage8EvolutionStatus || null;
  state.clusterEvolutionOverview = boot.clusterEvolutionOverview || { cohorts: [], runs: [], candidates: [] };
  state.evolutionGrants = [];
  state.personalEvolutionProposals = boot.personalEvolutionProposals || [];
  state.personalEvolutionProposalDetail = null;
  state.employeeContextMenu = null;
  state.employeeMarketDrawer = null;
  state.employeeOverview = boot.employees || null;
  applyEmployeeWorkStatusSnapshot(state, state.employeeOverview?.roster || []);
  state.secretarySessionId = state.sessions.find((session) => session.departmentId === 'secretary_department' && session.status !== 'deleted' && session.writeState !== 'read_only')?.id || '';
  state.privateAssistant = boot.privateAssistant || state.privateAssistant;
  state.managedProviderUsage = boot.managedProviderUsage ?? null;
  state.pluginCatalog = Array.isArray(boot.plugins) ? boot.plugins : state.pluginCatalog;
  state.codexPlugins = boot.codexPlugins || state.codexPlugins;
  state.attachedSkillCatalog = boot.attachedSkills || state.attachedSkillCatalog;
  state.pptxPluginStatus = boot.pptxPluginStatus ?? state.pptxPluginStatus;
  applyModelCatalog(boot.modelCatalog || null);
  if (!state.currentUser) state.currentTab = 'settings';
  const current = state.currentAgentId ? state.org.agents.find((agent) => agent.id === state.currentAgentId) : null;
  if (state.currentDepartmentId && (!current || current.routable === false || !isSelectableAgentForDepartment(state.currentDepartmentId, current.id))) {
    const first = defaultAgentForDepartment(state.currentDepartmentId);
    state.currentDepartmentId = first?.departmentId || '';
    state.currentAgentId = first?.id || '';
  }
  configureCollaborationView({ agentNameById });
  render();
  installSystemNotificationNavigationListeners();
  reportRendererEvent('info', 'renderer-local-bootstrap-complete', null, {
    durationMs: Date.now() - localBootstrapStartedAt,
  });
  void completeStartupBackgroundRefresh({
    userId: state.currentUser?.id || '',
    workspaceId: state.activeAccountWorkspace?.id || '',
    workspaceGeneration: state.workspaceSwitchGeneration,
  });
  if (state.currentUser) setTimeout(() => { void restoreTaskWorkspaceNavigation(); }, 0);
  setTimeout(checkClipboardForOrganizationInvite, 300);
}

let recoveringRenderFailure = false;
let renderedEmployeeMarketDrawerState = null;
let renderedEmployeeMarketDrawerPaused = false;
let renderedEmployeeDetailDrawerKey = '';
let renderedEmployeeDetailDrawerState = null;
let renderedPreviewState = null;
let renderedMessageDefaultVariantKey = '';
let renderRefreshGeneration = 0;
let followerControlRenderDeferred = false;
let followerControlFocusoutArmed = false;

function followerEditingControlActive() {
  const element = document.activeElement;
  return element instanceof Element
    && Boolean(element.closest('[data-follower-workspace]'))
    && element.matches('select, textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])');
}

function armFollowerControlRenderFlush() {
  if (followerControlFocusoutArmed) return;
  followerControlFocusoutArmed = true;
  document.addEventListener('focusout', () => {
    followerControlFocusoutArmed = false;
    setTimeout(() => {
      if (!followerControlRenderDeferred) return;
      if (followerEditingControlActive()) {
        armFollowerControlRenderFlush();
        return;
      }
      followerControlRenderDeferred = false;
      render();
    }, 0);
  }, { once: true });
}

function markRenderRefresh() {
  if (!app.querySelector('.app-frame')) return;
  const generation = ++renderRefreshGeneration;
  document.documentElement.classList.add('is-render-refreshing');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (generation === renderRefreshGeneration) document.documentElement.classList.remove('is-render-refreshing');
  }));
}

function render(options = {}) {
  if (messageScrollInteracting) {
    messageScrollRenderPending = true;
    return undefined;
  }
  if (taskWorkspaceScrollInteracting && state.activeTaskWorkspaceKind === 'task_run') {
    taskWorkspaceRenderPending = true;
    return undefined;
  }
  if (activeImeComposition?.element?.isConnected) {
    syncActiveImeCompositionValue();
    imeRenderDeferred = true;
    return undefined;
  }
  const activeFollowerControl = followerEditingControlActive();
  const managedFollowupRender = Boolean(options?.allowFollowerFollowupRender)
    && document.activeElement?.matches?.('[data-follower-followup-input]');
  if (activeFollowerControl && !managedFollowupRender) {
    followerControlRenderDeferred = true;
    armFollowerControlRenderFlush();
    return undefined;
  }
  followerControlRenderDeferred = false;
  try {
    const startedAt = performance.now();
    if (state.currentTab === 'chat') {
      syncCurrentChatRun();
      restoreActiveRunTransient();
    }
    const result = renderApp();
    const durationMs = performance.now() - startedAt;
    if (durationMs >= 50 && Date.now() - lastSlowRenderReportAt >= 5_000) {
      lastSlowRenderReportAt = Date.now();
      reportRendererEvent('warn', 'renderer-slow-render', null, {
        durationMs: Math.round(durationMs),
        currentTab: state.currentTab,
        networkPanelView: state.networkPanelOpen ? state.networkPanelView : '',
        messageCount: Array.isArray(state.messages) ? state.messages.length : 0,
      });
    }
    return result;
  } catch (error) {
    reportRendererEvent('error', 'renderer-update-failed', error);
    if (!recoveringRenderFailure && state.networkPanelOpen) {
      recoveringRenderFailure = true;
      state.networkPanelOpen = false;
      state.networkPanelView = 'messages';
      state.networkConversationPeerId = '';
      state.networkConversationGroupId = '';
      state.networkConversationMessages = [];
      state.networkDelegationId = '';
      state.collaborationGroupId = '';
      state.collaborationGroupDetail = null;
      try {
        return renderApp();
      } catch {
        // Fall through to the visible recovery message below.
      } finally {
        recoveringRenderFailure = false;
      }
    }
    app.innerHTML = `<pre class="fatal">${escapeHtml(userVisibleErrorMessage(error, '界面渲染失败，请重启后重试。'))}</pre>`;
    return undefined;
  }
}

function renderConversationTransition() {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (reducedMotion || typeof document.startViewTransition !== 'function') {
    render();
    return Promise.resolve();
  }
  document.documentElement.classList.add('is-contact-conversation-transition');
  const transition = document.startViewTransition(() => render());
  return transition.finished.finally(() => {
    document.documentElement.classList.remove('is-contact-conversation-transition');
  });
}

function renderApp() {
  if (taskWorkspaceRenderTimer) clearTimeout(taskWorkspaceRenderTimer);
  taskWorkspaceRenderTimer = null;
  taskWorkspaceRenderPending = false;
  if (state.activeTaskWorkspaceKind === 'task_run') taskWorkspaceLastRenderedAt = Date.now();
  syncRecentAccountWorkspaceState();
  state.responsiveLayoutMode = currentResponsiveLayoutMode();
  state.messageActivePane = state.messageActivePane === 'conversation' ? 'conversation' : 'list';
  state.contactsActivePane = ['directory', 'contacts', 'employees'].includes(state.contactsActivePane)
    ? state.contactsActivePane
    : 'directory';
  if (state.responsiveLayoutMode === 'single' && state.messageActivePane === 'conversation') {
    state.messageGroupSidebarOpen = false;
  }
  normalizeSocialRenderState();
  const activeQuote = normalizeMessageQuote(state.messageQuote);
  if (activeQuote?.sourceConversationId && activeQuote.sourceConversationId !== activeMessageConversationId()) {
    state.messageQuote = null;
  }
  const focusedControlSnapshot = captureFocusedControlState();
  const composerInputSnapshot = captureComposerInputState();
  const messageScrollSnapshot = captureMessageScrollState();
  rememberMessageViewState(messageScrollSnapshot);
  disconnectMessageScrollLayoutTracking();
  const preservedScrollSnapshot = capturePreservedScrollState();
  const sidebarScrollSnapshot = document.querySelector('.sidebar-scroll-region')?.scrollTop ?? sidebarScrollTop;
  const settingsScrollSnapshot = captureSettingsScrollState();
  const chatSearchInputSnapshot = captureChatSearchInputState();
  const employeeMarketScrollSnapshot = captureEmployeeMarketScrollState();
  const persistentEmployeeDetailDrawer = capturePersistentEmployeeDetailDrawer();
  const persistentEmployeeMarketDrawer = detachPersistentEmployeeMarketDrawer();
  const persistentPreviewOverlay = detachPersistentPreviewOverlay();
  markRenderRefresh();
  if (state.currentTab === 'recent') state.currentTab = 'chat';
  if (state.homeMode === 'collaboration') state.homeMode = 'department';
  if (state.currentTab === 'tasks') state.currentTab = isCurrentUserAdmin() ? 'evolution' : 'chat';
  if (!state.currentUser) {
    renderedMessageDefaultVariantKey = '';
    app.innerHTML = `
      <div class="app-frame theme-${escapeAttr(state.themeMode)}">
        ${renderWindowTitlebar({ nativeFrame: nativeWindowFrame })}
        <main class="auth-shell theme-${escapeAttr(state.themeMode)}">
          ${renderAuthPanel()}
          ${renderNotice()}
          ${renderDesktopDialog()}
        </main>
      </div>
    `;
    applyRendererLanguage();
    wireEvents();
    restorePersistentEmployeeDetailDrawer(persistentEmployeeDetailDrawer);
    restorePersistentEmployeeMarketDrawer(persistentEmployeeMarketDrawer);
    restorePersistentPreviewOverlay(persistentPreviewOverlay);
    return;
  }
  maybeQueueInitialUpdateAnnouncement();
  const isSettings = state.currentTab === 'settings' && state.currentUser;
  // Task groups use the same message workspace as uBuddy/direct chats: keep
  // the conversation list visible while the selected group occupies the main
  // chat area.  The focus-mode class used to hide that list and made the chat
  // appear to occupy only half of the available width.
  const collaborationFocusMode = Boolean(state.currentTab === 'chat' && state.collaborationGroupId);
  const showNetworkPanel = collaborationFocusMode || shouldShowNetworkPanel(isSettings);
  const messageConversationOpen = state.currentTab === 'chat'
    && showNetworkPanel
    && state.networkPanelView === 'messages'
    && !state.networkMessageHomeOpen;
  const showMessagePaneResizer = state.currentTab === 'chat'
    && showNetworkPanel
    && state.networkPanelView === 'messages';
  const messagePanelWidth = responsiveMessagePanelWidth(state.messagePanelWidth, state.responsiveLayoutMode);
  const messageDefaultVariantKey = state.currentTab === 'chat'
    && showNetworkPanel
    && state.networkPanelView === 'messages'
    && state.networkMessageHomeOpen
    ? `${rendererWorkspaceStorageScope()}:${Number(state.messageDefaultVariantIndex || 0)}`
    : '';
  const animateMessageDefaultVariant = Boolean(
    messageDefaultVariantKey && messageDefaultVariantKey !== renderedMessageDefaultVariantKey,
  );
  const topbarMarkup = isSettings || state.followerWorkspaceOpen ? '' : renderTopbar({
    pathBasename,
    sessionIsArchived,
    compareSessionsForDisplay,
    agentsForDepartment,
    agentLabel,
    shortAgentLabel,
    groupSessionsByMonth,
    filteredSessions,
    normalizeSearch,
    sessionSubtitle,
    sessionIsPinned,
  });
  app.innerHTML = `
    <div class="app-frame theme-${escapeAttr(state.themeMode)}">
      ${renderWindowTitlebar({ nativeFrame: nativeWindowFrame })}
      <div class="shell layout-${escapeAttr(state.responsiveLayoutMode)} ${!isSettings && state.sidebarCollapsed ? 'sidebar-collapsed' : ''} ${showNetworkPanel ? 'network-panel-open' : ''} ${showNetworkPanel && state.networkPanelView === 'messages' ? `message-layout message-pane-${escapeAttr(state.messageActivePane)}` : ''} ${showNetworkPanel && state.networkPanelView === 'friends' ? `contacts-layout contacts-pane-${escapeAttr(state.contactsActivePane)}` : ''} ${showNetworkPanel && state.networkPanelView === 'friends' && state.contactsActivePane !== 'directory' ? 'contacts-main-entered' : ''} ${messageConversationOpen ? 'message-conversation-open' : ''} ${state.messageGroupSidebarOpen ? 'message-groups-open' : ''} ${isSettings ? 'settings-shell' : ''} theme-${escapeAttr(state.themeMode)}" ${showNetworkPanel && state.networkPanelView === 'messages' ? `style="--network-panel-width:${messagePanelWidth}px"` : ''}>
        ${isSettings ? renderSettingsSidebar({ pathBasename, sessionIsArchived, compareSessionsForDisplay, agentsForDepartment, agentLabel, shortAgentLabel, groupSessionsByMonth, filteredSessions, normalizeSearch, sessionSubtitle, sessionIsPinned }) : renderSidebar({ pathBasename, sessionIsArchived, compareSessionsForDisplay, agentsForDepartment, agentLabel, shortAgentLabel, groupSessionsByMonth, filteredSessions, normalizeSearch, sessionSubtitle, sessionIsPinned })}
        ${showNetworkPanel ? renderNetworkPanel({ agentNameById, departmentName, sessionSubtitle }) : ''}
        ${showMessagePaneResizer ? `<div class="message-pane-resizer" role="separator" aria-orientation="vertical" aria-label="调整消息列表宽度" aria-valuemin="280" aria-valuemax="520" aria-valuenow="${messagePanelWidth}" tabindex="0" data-message-pane-resizer></div>` : ''}
        <main class="main ${topbarMarkup ? 'has-topbar' : 'without-topbar'}">
          ${topbarMarkup}
          <section class="workspace ${isSettings ? 'settings-workspace' : ''}">
            ${state.currentTab === 'chat' ? (showNetworkPanel && state.networkPanelView === 'friends'
              ? renderContactsWorkspace()
              : showNetworkPanel && state.networkPanelView === 'messages' && state.followerWorkspaceOpen
                ? renderFollowerWorkspace(state)
                : showNetworkPanel && state.networkPanelView === 'messages' && state.networkMessageHomeOpen
                ? renderMessageDefaultPage(state.messageDefaultVariantIndex, {
                    variantOrder: state.messageDefaultVariantOrder,
                    orderEditorOpen: state.messageDefaultOrderEditorOpen,
                    animateVariant: animateMessageDefaultVariant,
                  })
                : renderChat({ messageTextForCopy, agentsForDepartment, resolveSelectedAgentId, shortAgentLabel, agentPickerTitle, agentNameById, departmentName, normalizeSearch })) : ''}
            ${state.currentTab === 'collaboration' ? renderCollaboration() : ''}
            ${state.currentTab === 'plugins' ? renderPlugins({ normalizeSearch, loadPptxPluginStatus, importAttachedSkill, pickAttachedSkillSource, disableAttachedSkillPackage, setAttachedSkillAssignment, removeAttachedSkillAssignment }) : ''}
            ${state.currentTab === 'evolution' ? renderEvolution({ agentNameById, departmentName, shortAgentLabel }) : ''}
            ${state.currentTab === 'personal-evolution' ? renderPersonalEvolution() : ''}
            ${state.currentTab === 'employees' ? renderEmployees() : ''}
            ${state.currentTab === 'janus-app' ? renderJanusApp() : ''}
            ${state.currentTab === 'settings' ? renderSettings({ sessionIsArchived, sessionSubtitle, loadPluginCatalog, loadPptxPluginStatus, importAttachedSkill, pickAttachedSkillSource, disableAttachedSkillPackage, setAttachedSkillAssignment, removeAttachedSkillAssignment, loadEvolutionPreference: refreshEvolutionPreference, loadApplicationLoggingStatus: refreshApplicationLoggingStatus, loadUploadCompliance: refreshUploadCompliance, loadUBuddyCapabilityProfilePreview: refreshUBuddyCapabilityProfilePreview, loadUBuddyCapabilityProfileHistory: refreshUBuddyCapabilityProfileHistory, loadOrganizationResearchGovernance: refreshOrganizationResearchGovernance, loadFeishuStatus }) : ''}
          </section>
        </main>
        ${state.currentTab === 'chat' && showNetworkPanel && ['messages', 'friends'].includes(state.networkPanelView) ? renderEmployeeOverlays() : ''}
        ${state.currentTab === 'settings' && state.employeeMarketDrawer ? renderEmployeeOverlays() : ''}
        ${state.networkGroupProfileOpen ? renderGroupProfileDialog() : ''}
        ${renderChatGroupInviteDialog()}
        ${renderNotice()}
        ${renderWorkspaceSwitchProgress()}
        ${renderPreviewModal()}
        ${renderChatSearchModal({ pathBasename, sessionIsArchived, compareSessionsForDisplay, agentsForDepartment, agentLabel, shortAgentLabel, groupSessionsByMonth, filteredSessions, normalizeSearch, sessionSubtitle, sessionIsPinned })}
        ${renderRenameSessionModal()}
        ${renderMemoryNameModal()}
        ${renderSocialEditModal()}
        ${renderDesktopDialog()}
        ${renderMessageContextMenu()}
        ${renderMessageForwardDialog()}
        ${renderUpdateAnnouncementDialog()}
      </div>
    </div>
  `;
  renderedMessageDefaultVariantKey = messageDefaultVariantKey;
  applyRendererLanguage();
  const chatUserInputOverlay = app.querySelector('.chat-user-input-overlay');
  const appFrame = app.querySelector('.app-frame');
  if (chatUserInputOverlay && appFrame) appFrame.append(chatUserInputOverlay);
  const organizationWorkspaceSubmenu = app.querySelector('.organization-settings-workspace-more-submenu');
  const shell = app.querySelector('.shell');
  if (organizationWorkspaceSubmenu && shell) shell.append(organizationWorkspaceSubmenu);
  const chatPlanViewerOverlay = app.querySelector('.chat-plan-viewer-overlay');
  if (chatPlanViewerOverlay && appFrame) appFrame.append(chatPlanViewerOverlay);
  wireEvents();
  restorePersistentEmployeeDetailDrawer(persistentEmployeeDetailDrawer);
  restorePersistentEmployeeMarketDrawer(persistentEmployeeMarketDrawer);
  restorePersistentPreviewOverlay(persistentPreviewOverlay);
  updateInputTagIndent();
  autoResizeChatInput();
  restoreComposerInputState(composerInputSnapshot);
  applyConversationZoomToVisibleList();
  restoreMessageScrollState(messageScrollSnapshot);
  restorePreservedScrollState(preservedScrollSnapshot);
  wireMessageScrollTracking();
  restoreSidebarScrollState(sidebarScrollSnapshot);
  restoreSettingsScrollState(settingsScrollSnapshot);
  restoreChatSearchInputState(chatSearchInputSnapshot);
  restoreEmployeeMarketScrollState(employeeMarketScrollSnapshot);
  restoreFocusedControlState(focusedControlSnapshot);
  syncMessageDefaultRotation();
}

function renderWorkspaceSwitchProgress() {
  if (!state.workspaceSwitchBusy) return '';
  const targetName = String(state.workspaceSwitchTargetName || '').trim()
    || translateUiText('所选工作空间', state.languageMode);
  const title = state.languageMode === 'en'
    ? `Switching to ${targetName}...`
    : `正在切换到 ${targetName}…`;
  const detail = state.languageMode === 'en'
    ? 'Loading messages, projects, tasks, and Memory.'
    : '正在载入消息、项目、任务和 Memory。';
  return `<div class="workspace-switch-progress" role="status" aria-live="assertive" aria-busy="true">
    <div class="workspace-switch-progress-panel">
      <span class="account-workspace-spinner" aria-hidden="true"></span>
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span>
    </div>
  </div>`;
}

function applyRendererLanguage() {
  state.languageMode = normalizeLanguage(state.languageMode);
  document.documentElement.lang = state.languageMode;
  app.querySelectorAll('.app-frame, .shell, .auth-shell').forEach((element) => {
    element.classList.toggle('lang-en', state.languageMode === 'en');
    element.classList.toggle('lang-zh', state.languageMode !== 'en');
  });
  localizeDom(app, state.languageMode);
}

function setLanguageMode(mode) {
  const next = normalizeLanguage(mode);
  state.languageMode = next;
  state.languageMenuOpen = false;
  saveLanguageMode(next);
  void window.janus.setUiLanguage?.(next).catch?.(() => {});
  render();
}

function captureFocusedControlState() {
  const element = document.activeElement;
  if (!element || element === document.body || !app.contains(element)) return null;
  const id = String(element.id || '').trim();
  if (!id) return null;
  return {
    id,
    selectionStart: Number.isInteger(element.selectionStart) ? element.selectionStart : null,
    selectionEnd: Number.isInteger(element.selectionEnd) ? element.selectionEnd : null,
  };
}

function restoreFocusedControlState(snapshot) {
  if (!snapshot?.id) return;
  const element = document.getElementById(snapshot.id);
  if (!element || element.disabled) return;
  try { element.focus({ preventScroll: true }); } catch { element.focus(); }
  if (snapshot.selectionStart == null || typeof element.setSelectionRange !== 'function') return;
  try { element.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd ?? snapshot.selectionStart); } catch {}
}

function capturePreservedScrollState() {
  const snapshot = new Map();
  document.querySelectorAll('[data-preserve-scroll][data-scroll-key]').forEach((element) => {
    const key = String(element.dataset.scrollKey || '').trim();
    if (!key || snapshot.has(key)) return;
    const distanceFromBottom = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
    snapshot.set(key, {
      top: element.scrollTop,
      left: element.scrollLeft,
      followBottom: element.hasAttribute('data-scroll-follow-bottom')
        && distanceFromBottom <= PRESERVED_SCROLL_BOTTOM_THRESHOLD,
    });
  });
  return snapshot;
}

function restorePreservedScrollState(snapshot = new Map()) {
  if (!(snapshot instanceof Map) || !snapshot.size) return;
  document.querySelectorAll('[data-preserve-scroll][data-scroll-key]').forEach((element) => {
    const saved = snapshot.get(String(element.dataset.scrollKey || '').trim());
    if (!saved) return;
    if (saved.followBottom) element.scrollTop = element.scrollHeight;
    else element.scrollTop = Math.min(Number(saved.top || 0), Math.max(0, element.scrollHeight - element.clientHeight));
    element.scrollLeft = Math.min(Number(saved.left || 0), Math.max(0, element.scrollWidth - element.clientWidth));
  });
}

function captureEmployeeMarketScrollState() {
  if (state.currentTab !== 'employees') return null;
  const view = document.querySelector('.employees-view');
  return view ? { scrollTop: view.scrollTop, scrollLeft: view.scrollLeft } : null;
}

function restoreEmployeeMarketScrollState(snapshot) {
  if (!snapshot || state.currentTab !== 'employees') return;
  const view = document.querySelector('.employees-view');
  if (!view) return;
  view.scrollTop = snapshot.scrollTop || 0;
  view.scrollLeft = snapshot.scrollLeft || 0;
}

function detachPersistentEmployeeMarketDrawer() {
  const drawerState = state.employeeMarketDrawer;
  const paused = false;
  if (!drawerState || drawerState !== renderedEmployeeMarketDrawerState || paused !== renderedEmployeeMarketDrawerPaused) return null;
  const drawer = document.querySelector('.employee-market-drawer');
  const layer = drawer?.closest('.employee-drawer-layer');
  if (!layer) return null;
  const focusedElement = layer.contains(document.activeElement) ? document.activeElement : null;
  const scrollTop = drawer.scrollTop;
  const scrollLeft = drawer.scrollLeft;
  layer.remove();
  return { drawerState, paused, layer, focusedElement, scrollTop, scrollLeft };
}

function restorePersistentEmployeeMarketDrawer(snapshot = null) {
  const drawerState = state.employeeMarketDrawer;
  const paused = false;
  const replacement = document.querySelector('.employee-market-drawer')?.closest('.employee-drawer-layer');
  if (snapshot && snapshot.drawerState === drawerState && snapshot.paused === paused && replacement) {
    replacement.replaceWith(snapshot.layer);
    if (snapshot.focusedElement?.isConnected) snapshot.focusedElement.focus({ preventScroll: true });
    const drawer = snapshot.layer.querySelector('.employee-market-drawer');
    if (drawer) {
      drawer.scrollTop = snapshot.scrollTop || 0;
      drawer.scrollLeft = snapshot.scrollLeft || 0;
    }
  }
  renderedEmployeeMarketDrawerState = drawerState || null;
  renderedEmployeeMarketDrawerPaused = paused;
}

function detachPersistentPreviewOverlay() {
  if (!state.preview || state.preview !== renderedPreviewState) return null;
  const overlay = document.querySelector('.preview-overlay');
  if (!overlay) return null;
  const focusedElement = overlay.contains(document.activeElement) ? document.activeElement : null;
  overlay.remove();
  return { preview: state.preview, overlay, focusedElement };
}

function restorePersistentPreviewOverlay(snapshot = null) {
  const replacement = document.querySelector('.preview-overlay');
  if (snapshot && snapshot.preview === state.preview && replacement) {
    replacement.replaceWith(snapshot.overlay);
    if (snapshot.focusedElement?.isConnected) snapshot.focusedElement.focus({ preventScroll: true });
  }
  renderedPreviewState = state.preview || null;
}

function employeeDetailDrawerDescriptor() {
  const agentInstanceId = String(state.employeeSelectedInstanceId || '').trim();
  if (!agentInstanceId) return null;
  const employee = (state.employeeOverview?.roster || []).find((item) => item.id === agentInstanceId) || null;
  if (state.employeeDetailTab === 'memory' && state.employeeMemoryDrawer?.agentInstanceId === agentInstanceId) {
    return {
      key: `memory:${agentInstanceId}`,
      agentInstanceId,
      state: [state.employeeMemoryDrawer, employee, state.employeeOverview?.capabilities],
      selector: '.employee-memory-drawer:not(.employee-overview-drawer):not(.employee-growth-drawer):not(.employee-market-drawer):not(.talent-candidate-drawer)',
    };
  }
  if (state.employeeDetailTab === 'growth' && state.employeeGrowthDrawer?.agentInstanceId === agentInstanceId) {
    return { key: `growth:${agentInstanceId}`, agentInstanceId, state: [state.employeeGrowthDrawer, employee], selector: '.employee-growth-drawer' };
  }
  if (state.employeeDetailTab !== 'overview') return null;
  return employee ? {
    key: `overview:${agentInstanceId}`,
    agentInstanceId,
    state: [employee, state.employeeOverview?.capabilities, state.pluginCatalog, state.pptxPluginStatus, state.currentUser, state.directoryStars],
    selector: '.employee-overview-drawer',
  } : null;
}

function sameEmployeeDetailDrawerState(left = [], right = []) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function capturePersistentEmployeeDetailDrawer() {
  const descriptor = employeeDetailDrawerDescriptor();
  const renderedDrawer = renderedEmployeeDetailDrawerKey
    ? document.querySelector('.employee-overview-drawer, .employee-growth-drawer, .employee-memory-drawer:not(.employee-market-drawer):not(.talent-candidate-drawer)')
    : null;
  const layer = renderedDrawer?.closest('.employee-drawer-layer') || null;
  const snapshot = {
    descriptor,
    previousKey: renderedEmployeeDetailDrawerKey,
    drawer: renderedDrawer,
    layer: null,
    focusedElement: layer?.contains(document.activeElement) ? document.activeElement : null,
    scrollTop: renderedDrawer?.scrollTop || 0,
    scrollLeft: renderedDrawer?.scrollLeft || 0,
  };
  if (
    descriptor
    && layer
    && descriptor.key === renderedEmployeeDetailDrawerKey
    && sameEmployeeDetailDrawerState(descriptor.state, renderedEmployeeDetailDrawerState)
  ) {
    layer.remove();
    snapshot.layer = layer;
  }
  return snapshot;
}

function restorePersistentEmployeeDetailDrawer(snapshot = null) {
  const descriptor = employeeDetailDrawerDescriptor();
  const replacementDrawer = descriptor ? document.querySelector(descriptor.selector) : null;
  const replacementLayer = replacementDrawer?.closest('.employee-drawer-layer') || null;
  if (
    snapshot?.layer
    && descriptor
    && snapshot.descriptor?.key === descriptor.key
    && sameEmployeeDetailDrawerState(snapshot.descriptor?.state, descriptor.state)
    && replacementLayer
  ) {
    replacementLayer.replaceWith(snapshot.layer);
    if (snapshot.focusedElement?.isConnected) snapshot.focusedElement.focus({ preventScroll: true });
    if (snapshot.drawer) {
      snapshot.drawer.scrollTop = snapshot.scrollTop || 0;
      snapshot.drawer.scrollLeft = snapshot.scrollLeft || 0;
    }
  } else if (
    descriptor
    && replacementLayer
    && (snapshot?.previousKey === descriptor.key
      || snapshot?.descriptor?.agentInstanceId === descriptor.agentInstanceId)
  ) {
    replacementLayer.classList.add('is-stable-rerender');
    replacementDrawer.scrollTop = snapshot.scrollTop || 0;
    replacementDrawer.scrollLeft = snapshot.scrollLeft || 0;
  }
  renderedEmployeeDetailDrawerKey = descriptor?.key || '';
  renderedEmployeeDetailDrawerState = descriptor?.state || null;
}

function handleImeCompositionStart(event) {
  const element = event.target;
  if (!isImeTextEntry(element)) return;
  if (activeImeComposition?.element && activeImeComposition.element !== element) {
    activeImeComposition.element.dataset.imeComposing = 'false';
  }
  activeImeComposition = { element, startedAt: Date.now() };
  element.dataset.imeComposing = 'true';
  syncActiveImeCompositionValue();
}

function handleImeCompositionEnd(event) {
  const element = event.target;
  if (!activeImeComposition || activeImeComposition.element !== element) return;
  syncActiveImeCompositionValue();
  element.dataset.imeComposing = 'false';
  activeImeComposition = null;
  queueMicrotask(flushDeferredImeRender);
}

function handleImeCompositionFocusOut(event) {
  const element = event.target;
  if (!activeImeComposition || activeImeComposition.element !== element) return;
  setTimeout(() => {
    if (!activeImeComposition || activeImeComposition.element !== element || document.activeElement === element) return;
    syncActiveImeCompositionValue();
    element.dataset.imeComposing = 'false';
    activeImeComposition = null;
    flushDeferredImeRender();
  }, 0);
}

function isImeTextEntry(element) {
  return element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || Boolean(element?.isContentEditable);
}

function syncActiveImeCompositionValue() {
  const element = activeImeComposition?.element;
  if (!element || element.id !== 'chat-input') return;
  state.chatDraft = element.value || '';
  if (state.chatGroupId) {
    state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [`chat-group:${state.chatGroupId}`]: state.chatDraft };
    persistComposerDrafts();
  } else if (state.collaborationGroupId) {
    state.networkConversationDrafts = {
      ...(state.networkConversationDrafts || {}),
      [`collaboration:${state.collaborationGroupId}`]: state.chatDraft,
    };
    persistComposerDrafts();
  } else if (state.networkConversationPeerId && state.networkConversationPeerId !== 'self-secretary') {
    const key = networkConversationDraftKey(
      state.networkConversationPeerId,
      state.networkConversationMode,
      state.networkConversationGroupId,
    );
    state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [key]: state.chatDraft };
    persistComposerDrafts();
  }
  preserveCurrentComposerDraft();
  syncSocialMentionHighlight(element);
  autoResizeChatInput(element);
}

function flushDeferredImeRender() {
  if (activeImeComposition || !imeRenderDeferred) return;
  imeRenderDeferred = false;
  render();
}

function captureComposerInputState() {
  const input = document.getElementById('chat-input');
  if (!input || document.activeElement !== input) return null;
  return {
    key: input.dataset.chatInputKey || '',
    sessionId: input.dataset.chatInputSession || '',
    value: input.value,
    start: Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length,
    end: Number.isFinite(input.selectionEnd) ? input.selectionEnd : input.value.length,
    direction: input.selectionDirection || 'none',
    scrollTop: input.scrollTop || 0,
  };
}

function restoreComposerInputState(snapshot) {
  if (!snapshot) return;
  const input = document.getElementById('chat-input');
  if (!input
    || input.dataset.chatInputKey !== snapshot.key
    || input.dataset.chatInputSession !== snapshot.sessionId
    || input.value !== snapshot.value) return;
  input.focus({ preventScroll: true });
  const max = input.value.length;
  input.setSelectionRange(Math.min(snapshot.start, max), Math.min(snapshot.end, max), snapshot.direction);
  input.scrollTop = snapshot.scrollTop;
}

function syncMessageDefaultRotation() {
  if (messageDefaultRotationTimer) clearTimeout(messageDefaultRotationTimer);
  messageDefaultRotationTimer = null;
  if (!document.querySelector('[data-message-default-page]')) return;
  if (state.messageDefaultOrderEditorOpen) return;
  if (state.responsiveLayoutMode === 'single' && state.messageActivePane !== 'conversation') return;
  messageDefaultRotationTimer = setTimeout(() => {
    messageDefaultRotationTimer = null;
    if (!state.currentUser || !state.networkMessageHomeOpen || state.currentTab !== 'chat' || state.networkPanelView !== 'messages') return;
    if (state.responsiveLayoutMode === 'single' && state.messageActivePane !== 'conversation') return;
    const order = messageDefaultVariantOrder();
    const position = Math.max(0, order.indexOf(Number(state.messageDefaultVariantIndex || 0)));
    state.messageDefaultVariantIndex = order[(position + 1) % order.length];
    render();
  }, 15000);
}

function messageDefaultVariantOrder() {
  const order = [...new Set((Array.isArray(state.messageDefaultVariantOrder) ? state.messageDefaultVariantOrder : [])
    .map(Number).filter((item) => Number.isInteger(item) && item >= 0 && item < 3))];
  for (let index = 0; index < 3; index += 1) {
    if (!order.includes(index)) order.push(index);
  }
  return order.slice(0, 3);
}

function stepMessageDefaultVariant(direction = 'next') {
  const order = messageDefaultVariantOrder();
  state.messageDefaultVariantIndex = cycleMessageDefaultVariant(order, state.messageDefaultVariantIndex, direction);
  render();
  return true;
}

function persistMessageDefaultVariantOrder(order = []) {
  state.messageDefaultVariantOrder = order;
  saveMessageDefaultOrder(rendererWorkspaceStorageScope(), order);
}

function openTalentMarketFromMessageDefault() {
  state.employeeMarketSpotlight = true;
  const talentMarketTab = document.querySelector('[data-tab="employees"]');
  if (talentMarketTab) talentMarketTab.click();
  else {
    state.networkPanelOpen = false;
    state.currentTab = 'employees';
    state.modelMenuOpen = false;
    render();
    void refreshEmployeeOverview();
  }
  requestAnimationFrame(() => {
    document.querySelector('.employees-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
    document.querySelector('#employee-market-search')?.focus?.({ preventScroll: true });
  });
  clearTimeout(employeeMarketSpotlightTimer);
  employeeMarketSpotlightTimer = setTimeout(() => {
    employeeMarketSpotlightTimer = null;
    state.employeeMarketSpotlight = false;
    document.querySelectorAll('.is-message-home-spotlight').forEach((element) => {
      element.classList.remove('is-message-home-spotlight');
    });
  }, 3200);
}

function normalizeSocialRenderState() {
  const overview = state.friendOverview && typeof state.friendOverview === 'object' ? state.friendOverview : {};
  const requests = overview.requests && typeof overview.requests === 'object' ? overview.requests : {};
  state.friendOverview = {
    ...overview,
    friends: Array.isArray(overview.friends) ? overview.friends : [],
    organizations: Array.isArray(overview.organizations) ? overview.organizations : [],
    requests: {
      ...requests,
      incoming: Array.isArray(requests.incoming) ? requests.incoming : [],
      outgoing: Array.isArray(requests.outgoing) ? requests.outgoing : [],
    },
  };
  state.socialInbox = Array.isArray(state.socialInbox) ? state.socialInbox : [];
  state.socialThreads = Array.isArray(state.socialThreads) ? state.socialThreads : [];
  state.agentDelegations = Array.isArray(state.agentDelegations) ? state.agentDelegations : [];
  const collaboration = state.collaborationOverview && typeof state.collaborationOverview === 'object'
    ? state.collaborationOverview
    : {};
  state.collaborationOverview = {
    ...collaboration,
    groups: Array.isArray(collaboration.groups) ? collaboration.groups : [],
    tasks: Array.isArray(collaboration.tasks) ? collaboration.tasks : [],
  };
  const chatGroups = state.chatGroupsOverview && typeof state.chatGroupsOverview === 'object' ? state.chatGroupsOverview : {};
  state.chatGroupsOverview = { ...chatGroups, groups: Array.isArray(chatGroups.groups) ? chatGroups.groups : [] };
}

function captureChatSearchInputState() {
  const input = document.getElementById('chat-search-modal-input');
  if (!input || document.activeElement !== input) return null;
  return {
    start: Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length,
    end: Number.isFinite(input.selectionEnd) ? input.selectionEnd : input.value.length,
    direction: input.selectionDirection || 'none',
  };
}

function restoreChatSearchInputState(snapshot) {
  if (!snapshot || !state.chatSearchOpen) return;
  const input = document.getElementById('chat-search-modal-input');
  if (!input) return;
  input.focus({ preventScroll: true });
  const max = input.value.length;
  input.setSelectionRange(Math.min(snapshot.start, max), Math.min(snapshot.end, max), snapshot.direction);
}

function restoreSidebarScrollState(scrollTop = 0) {
  const region = document.querySelector('.sidebar-scroll-region');
  if (!region) return;
  const maxTop = Math.max(0, region.scrollHeight - region.clientHeight);
  region.scrollTop = Math.min(Number(scrollTop || 0), maxTop);
  sidebarScrollTop = region.scrollTop;
  region.addEventListener('scroll', () => {
    sidebarScrollTop = region.scrollTop;
  }, { passive: true, capture: true });
}

function captureSettingsScrollState() {
  const region = document.querySelector('.settings-section-view');
  if (!region || state.currentTab !== 'settings') return null;
  return { section: state.currentSettingsSection || 'account', top: region.scrollTop };
}

function restoreSettingsScrollState(snapshot) {
  if (!snapshot || state.currentTab !== 'settings' || snapshot.section !== (state.currentSettingsSection || 'account')) {
    pendingSettingsScrollTop = null;
    return;
  }
  const region = document.querySelector('.settings-section-view');
  if (!region) return;
  const requestedTop = pendingSettingsScrollTop == null ? Number(snapshot.top || 0) : Number(pendingSettingsScrollTop);
  const apply = () => {
    if (!document.body.contains(region) || state.currentTab !== 'settings') return;
    const maxTop = Math.max(0, region.scrollHeight - region.clientHeight);
    region.scrollTop = Math.min(Math.max(0, requestedTop), maxTop);
    pendingSettingsScrollTop = null;
  };
  requestAnimationFrame(() => requestAnimationFrame(apply));
}

function setActiveAccountSection(sectionId = '') {
  if (!sectionId) return;
  document.querySelectorAll('[data-account-section-target]').forEach((button) => {
    const active = button.dataset.accountSectionTarget === sectionId;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  });
  const menu = document.querySelector('[data-account-section-menu]');
  if (menu && menu.value !== sectionId) menu.value = sectionId;
}

let accountSectionNavigatorCleanup = null;
const ACCOUNT_SECTION_NAV_PLACEMENT = 'right';

function wireAccountSectionNavigator() {
  accountSectionNavigatorCleanup?.();
  accountSectionNavigatorCleanup = null;
  const region = document.querySelector('.settings-account-view');
  if (!region) return;
  const anchors = Array.from(region.querySelectorAll('[data-account-section]'));
  if (!anchors.length) return;
  const scrollSpyAnchors = anchors.filter((anchor) => anchor.dataset.accountSection !== 'sign-out');
  const navigator = region.querySelector('.account-section-nav');
  const abortController = new AbortController();

  const positionNavigator = () => {
    if (!navigator) return;
    const bounds = region.getBoundingClientRect();
    const top = bounds.top + 128;
    const left = ACCOUNT_SECTION_NAV_PLACEMENT === 'right'
      ? bounds.right - 100
      : bounds.left - 5;
    navigator.dataset.placement = ACCOUNT_SECTION_NAV_PLACEMENT;
    navigator.style.setProperty('--account-section-nav-left', `${Math.max(0, left)}px`);
    navigator.style.setProperty('--account-section-nav-top', `${top}px`);
    navigator.style.setProperty('--account-section-nav-height', `${Math.max(360, bounds.bottom - top)}px`);
  };

  const updateActiveSection = () => {
    if (region.dataset.settingsSearchJump === 'true') return;
    const atBottom = region.scrollTop + region.clientHeight >= region.scrollHeight - 8;
    let active = atBottom
      ? scrollSpyAnchors.find((anchor) => anchor.dataset.accountSection === 'security') || scrollSpyAnchors.at(-1)
      : scrollSpyAnchors[0];
    const activationLine = region.getBoundingClientRect().top + Math.min(150, region.clientHeight * .22);
    if (!atBottom) {
      scrollSpyAnchors.forEach((anchor) => {
        if (anchor.getBoundingClientRect().top <= activationLine) active = anchor;
      });
    }
    setActiveAccountSection(active?.dataset.accountSection || '');
  };

  const scrollToSection = (sectionId) => {
    const anchor = anchors.find((item) => item.dataset.accountSection === sectionId);
    if (!anchor) return;
    setActiveAccountSection(sectionId);
    const compactMenu = region.querySelector('.account-section-menu');
    const offset = compactMenu && getComputedStyle(compactMenu).display !== 'none'
      ? compactMenu.getBoundingClientRect().height + 12
      : 20;
    const top = region.scrollTop + anchor.getBoundingClientRect().top - region.getBoundingClientRect().top - offset;
    pendingSettingsScrollTop = Math.max(0, top);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    region.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  region.querySelectorAll('[data-account-section-target]').forEach((button) => {
    button.addEventListener('click', () => scrollToSection(button.dataset.accountSectionTarget || ''));
  });
  region.querySelector('[data-account-section-menu]')?.addEventListener('change', (event) => {
    scrollToSection(event.target.value || '');
  });
  region.addEventListener('scroll', updateActiveSection, { passive: true });
  window.addEventListener('resize', positionNavigator, { passive: true, signal: abortController.signal });
  accountSectionNavigatorCleanup = () => abortController.abort();
  positionNavigator();
  requestAnimationFrame(updateActiveSection);
}

function updateCenterRenderKey(appUpdate = {}, agentUpdate = {}) {
  return JSON.stringify([
    appUpdate.enabled,
    appUpdate.checking,
    appUpdate.available,
    appUpdate.downloading,
    appUpdate.downloaded,
    appUpdate.installing,
    appUpdate.version,
    appUpdate.lastError,
    agentUpdate.enabled,
    agentUpdate.checking,
    agentUpdate.available,
    agentUpdate.downloading,
    agentUpdate.downloaded,
    agentUpdate.applying,
    agentUpdate.failureStage,
    agentUpdate.lastError,
    agentUpdate.current?.bundleId,
    agentUpdate.candidate?.artifact?.releaseVersion,
    agentUpdate.candidate?.manifest?.version,
  ]);
}

function socialUiRenderKey({
  status = state.socialStatus,
  friends = state.friendOverview,
  inbox = state.socialInbox,
  delegations = state.agentDelegations,
  collaboration = state.collaborationOverview,
  chatGroups = state.chatGroupsOverview,
} = {}) {
  return JSON.stringify([
    {
      enabled: Boolean(status?.enabled),
      connected: Boolean(status?.connected),
      lastError: String(status?.lastError || status?.last_error || ''),
    },
    friends || null,
    Array.isArray(inbox) ? inbox : [],
    Array.isArray(delegations) ? delegations : [],
    collaboration || { groups: [], tasks: [] },
    chatGroups || { groups: [] },
  ]);
}

function syncUpdateProgressStatus() {
  if (!state.updates?.downloading) return;
  const progress = Number.isFinite(state.updates.downloadProgress) ? `，进度 ${state.updates.downloadProgress}%` : '';
  const message = document.querySelector('[data-update-status-message]');
  if (message) message.textContent = translateUiText(`正在下载最新软件${progress}；下载期间仍可继续使用。`, state.languageMode);
  const readiness = document.querySelector('.update-announcement-readiness');
  if (readiness) readiness.textContent = translateUiText(`正在下载更新${Number.isFinite(state.updates.downloadProgress) ? ` · ${Math.round(state.updates.downloadProgress)}%` : ''}`, state.languageMode);
  const action = document.querySelector('.update-announcement-dialog > footer .btn.primary[disabled]');
  if (action && state.updateAnnouncementDialog?.mode === 'available') action.textContent = translateUiText(`下载中${Number.isFinite(state.updates.downloadProgress) ? ` ${Math.round(state.updates.downloadProgress)}%` : ''}`, state.languageMode);
}

function persistUpdateAnnouncementPreferences() {
  saveUpdateAnnouncementPreferences({
    autoPopup: state.updateAnnouncementAutoPopup,
    lastSeenInstalledVersion: state.updateAnnouncementLastSeenInstalledVersion,
    lastSeenAvailableVersion: state.updateAnnouncementLastSeenAvailableVersion,
  });
}

function maybeQueueInitialUpdateAnnouncement() {
  if (!state.currentUser || !state.updateAnnouncementInitialized || !state.updateAnnouncementAutoPopup || state.updateAnnouncementDialog) return false;
  if (maybeQueueAvailableUpdateAnnouncement()) return true;
  const version = normalizeReleaseVersion(state.appVersion);
  if ((!state.appPackaged && !state.updatedLaunch) || !releaseAnnouncementForVersion(version)) return false;
  if (normalizeReleaseVersion(state.updateAnnouncementLastSeenInstalledVersion) === version) return false;
  state.updateAnnouncementDialog = { mode: 'installed', version, detail: false };
  return true;
}

function maybeQueueAvailableUpdateAnnouncement() {
  if (!state.currentUser || !state.updateAnnouncementInitialized || !state.updateAnnouncementAutoPopup || state.updateAnnouncementDialog) return false;
  if (!state.appPackaged && !state.updatedLaunch) return false;
  const update = state.updates || {};
  const version = normalizeReleaseVersion(update.version);
  if ((!update.available && !update.downloaded) || !version) return false;
  if (normalizeReleaseVersion(state.updateAnnouncementLastSeenAvailableVersion) === version) return false;
  state.updateAnnouncementDialog = { mode: 'available', version, detail: false };
  return true;
}

function openUpdateChangelog(version = '') {
  state.updateAnnouncementDialog = {
    mode: 'history',
    version: normalizeReleaseVersion(version || state.updates?.version || state.appVersion),
    detail: true,
  };
  render();
}

function acknowledgeUpdateAnnouncement(dialog = state.updateAnnouncementDialog) {
  const version = normalizeReleaseVersion(dialog?.version);
  if (version && dialog?.mode === 'available') state.updateAnnouncementLastSeenAvailableVersion = version;
  if (version && dialog?.mode === 'installed') state.updateAnnouncementLastSeenInstalledVersion = version;
  persistUpdateAnnouncementPreferences();
}

function captureMessageScrollState({ allowFollow = true, anchorMessageId = '' } = {}) {
  const list = document.getElementById('message-list');
  if (!list) return null;
  const distanceFromBottom = Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop);
  const nearBottom = distanceFromBottom <= MESSAGE_SCROLL_BOTTOM_TOLERANCE;
  if (nearBottom) messageScrollFollow = true;
  const follow = Boolean(allowFollow && messageScrollFollow && (nearBottom || !messageScrollInteracting));
  messageScrollTop = list.scrollTop;
  const listRect = list.getBoundingClientRect();
  const items = [...list.querySelectorAll(':scope > [data-message-id]')]
    .filter((item) => !String(item.dataset.messageId || '').startsWith('history-loader:'));
  const preferred = anchorMessageId
    ? items.find((item) => String(item.dataset.messageId || '') === String(anchorMessageId))
    : null;
  const anchor = preferred || items.find((item) => item.getBoundingClientRect().bottom > listRect.top + 1) || null;
  return {
    key: String(list.dataset.messageScrollKey || ''),
    follow,
    top: messageScrollTop,
    anchorMessageId: String(anchor?.dataset?.messageId || ''),
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - listRect.top : null,
  };
}

function restoreMessageScrollState(snapshot) {
  const list = document.getElementById('message-list');
  if (!list) return;
  const currentKey = String(list.dataset.messageScrollKey || '');
  const sameConversation = Boolean(snapshot && snapshot.key && currentKey && snapshot.key === currentKey);
  if (!sameConversation) {
    messageScrollFollowEvaluation += 1;
    messageScrollFollow = true;
    messageScrollInteracting = false;
    messageScrollLayoutInteraction = false;
    messageDisclosureScrollSnapshot = null;
    clearMessageAnchorSpacer(list);
    list.scrollTop = list.scrollHeight;
    messageScrollTop = list.scrollTop;
    return;
  }
  const follow = snapshot ? snapshot.follow : messageScrollFollow;
  if (follow) {
    clearMessageAnchorSpacer(list);
    list.scrollTop = list.scrollHeight;
  } else {
    const anchor = snapshot?.anchorMessageId
      ? [...list.querySelectorAll(':scope > [data-message-id]')].find((item) => String(item.dataset.messageId || '') === snapshot.anchorMessageId)
      : null;
    if (anchor && Number.isFinite(snapshot?.anchorOffset)) {
      const listRect = list.getBoundingClientRect();
      const desiredTop = list.scrollTop + anchor.getBoundingClientRect().top - listRect.top - snapshot.anchorOffset;
      const currentSpacer = Math.max(0, Number(list.dataset.messageAnchorSpacer || 0));
      const computedPadding = Math.max(0, Number.parseFloat(getComputedStyle(list).paddingBottom) || 0);
      const basePadding = Math.max(0, computedPadding - currentSpacer);
      const maxTopWithoutSpacer = Math.max(0, list.scrollHeight - list.clientHeight - currentSpacer);
      const nextSpacer = Math.max(0, desiredTop - maxTopWithoutSpacer);
      if (nextSpacer > 0) {
        list.style.paddingBottom = `${basePadding + nextSpacer}px`;
        list.dataset.messageAnchorSpacer = String(nextSpacer);
      } else {
        clearMessageAnchorSpacer(list);
      }
      list.scrollTop = desiredTop;
    } else {
      const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.min(snapshot?.top ?? messageScrollTop, maxTop);
    }
  }
  messageScrollTop = list.scrollTop;
}

function clearMessageAnchorSpacer(list) {
  if (!list?.dataset?.messageAnchorSpacer) return;
  list.style.removeProperty('padding-bottom');
  delete list.dataset.messageAnchorSpacer;
}

function wireMessageScrollTracking() {
  disconnectMessageScrollLayoutTracking();
  const list = document.getElementById('message-list');
  if (!list) return;
  let touchStartY = null;
  let touchScrollIntent = false;
  messageHistoryAutoLoadArmed = false;
  wireMessageScrollLayoutTracking(list);
  const beginMessageScrollInteraction = (layoutControl = null) => {
    messageScrollFollowEvaluation += 1;
    messageScrollInteracting = true;
    messageScrollFollow = false;
    messageScrollLayoutInteraction = Boolean(layoutControl);
    messageDisclosureScrollSnapshot = layoutControl?.matches?.('[data-long-message-toggle]') ? captureMessageScrollState({
      allowFollow: false,
      anchorMessageId: String(layoutControl.closest('[data-message-id]')?.dataset.messageId || '').trim(),
    }) : null;
    messageScrollTop = list.scrollTop;
    deferMessageScrollInteractionFinish();
  };
  list.addEventListener('pointerdown', (event) => {
    const layoutControl = event.target?.closest?.(MESSAGE_LAYOUT_CONTROL_SELECTOR) || null;
    const scrollIntent = event.target === list || Boolean(layoutControl);
    if (!scrollIntent) return;
    messageScrollPointerActive = true;
    beginMessageScrollInteraction(layoutControl);
    if (event.target === list) messageHistoryAutoLoadArmed = true;
  }, { passive: true, capture: true });
  list.addEventListener('touchstart', (event) => {
    const layoutControl = event.target?.closest?.(MESSAGE_LAYOUT_CONTROL_SELECTOR) || null;
    messageScrollPointerActive = true;
    touchStartY = Number(event.touches?.[0]?.clientY);
    touchScrollIntent = false;
    if (layoutControl) beginMessageScrollInteraction(layoutControl);
  }, { passive: true, capture: true });
  list.addEventListener('touchmove', (event) => {
    const currentY = Number(event.touches?.[0]?.clientY);
    if (touchScrollIntent || !Number.isFinite(touchStartY) || !Number.isFinite(currentY)
      || Math.abs(currentY - touchStartY) < 6) return;
    touchScrollIntent = true;
    messageHistoryAutoLoadArmed = true;
    beginMessageScrollInteraction();
  }, { passive: true, capture: true });
  list.addEventListener('touchend', () => {
    touchStartY = null;
    touchScrollIntent = false;
  }, { passive: true, capture: true });
  list.addEventListener('touchcancel', () => {
    touchStartY = null;
    touchScrollIntent = false;
  }, { passive: true, capture: true });
  list.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey) return;
    messageScrollFollowEvaluation += 1;
    deferMessageScrollInteractionFinish();
    if (event.deltaY < 0) {
      messageScrollFollow = false;
      messageHistoryAutoLoadArmed = true;
    }
    messageScrollTop = list.scrollTop;
  }, { passive: true });
  list.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
      messageScrollFollowEvaluation += 1;
      deferMessageScrollInteractionFinish();
      messageScrollFollow = false;
      messageHistoryAutoLoadArmed = true;
    }
  });
  list.addEventListener('scroll', () => {
    if (messageScrollInteracting) deferMessageScrollInteractionFinish();
    const distanceFromBottom = Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop);
    const nearBottom = distanceFromBottom <= MESSAGE_SCROLL_BOTTOM_TOLERANCE;
    // Streamed content can increase scrollHeight without any user scroll intent.
    // Keep following in that case; explicit wheel/pointer/keyboard handlers detach it.
    if (nearBottom) {
      messageScrollFollow = true;
      clearCurrentUBuddyTaskUnseen();
    }
    else if (messageScrollInteracting) messageScrollFollow = false;
    if (messageScrollFollow && list.dataset.messageAnchorSpacer) {
      clearMessageAnchorSpacer(list);
      list.scrollTop = list.scrollHeight;
    }
    messageScrollTop = list.scrollTop;
    if (list.scrollTop <= 160 && messageHistoryAutoLoadArmed
      && state.messagePagination?.hasMore && !state.messagePagination?.loading) {
      messageHistoryAutoLoadArmed = false;
      void loadOlderMessages();
    }
  }, { passive: true });
  list.addEventListener('scrollend', () => {
    if (messageScrollInteracting) finishMessageScrollInteraction();
  }, { passive: true });
}

function wireMessageScrollLayoutTracking(list) {
  if (!list) return;
  const observeMessageItems = () => {
    if (!messageListResizeObserver) return;
    [...list.children].forEach((item) => messageListResizeObserver.observe(item));
  };
  if (typeof ResizeObserver === 'function') {
    messageListResizeObserver = new ResizeObserver(() => scheduleMessageBottomLayoutSettle(list));
    messageListResizeObserver.observe(list);
    observeMessageItems();
  }
  if (typeof MutationObserver === 'function') {
    messageListMutationObserver = new MutationObserver(() => {
      observeMessageItems();
      scheduleMessageBottomLayoutSettle(list);
    });
    messageListMutationObserver.observe(list, { childList: true, subtree: true });
  }
}

function scheduleMessageBottomLayoutSettle(list) {
  if (!list || !messageScrollFollow || messageScrollInteracting) return;
  if (messageScrollLayoutFrame) cancelAnimationFrame(messageScrollLayoutFrame);
  messageScrollLayoutFrame = requestAnimationFrame(() => {
    messageScrollLayoutFrame = 0;
    if (document.getElementById('message-list') !== list || !messageScrollFollow || messageScrollInteracting) return;
    list.scrollTop = list.scrollHeight;
    messageScrollTop = list.scrollTop;
  });
}

function disconnectMessageScrollLayoutTracking() {
  messageListResizeObserver?.disconnect();
  messageListMutationObserver?.disconnect();
  messageListResizeObserver = null;
  messageListMutationObserver = null;
  if (messageScrollLayoutFrame) cancelAnimationFrame(messageScrollLayoutFrame);
  messageScrollLayoutFrame = 0;
}

function shouldShowNetworkPanel(isSettings = false) {
  return Boolean(
    !isSettings && state.currentUser && ['chat', 'collaboration'].includes(state.currentTab) && state.networkPanelOpen
  );
}

function maybeAutoOpenDispatchedCollaborationGroup(detail = null, sourceGroupId = '', previousDetail = null) {
  const groupId = String(sourceGroupId || state.chatGroupId || '').trim();
  if (!groupId || state.chatGroupId !== groupId || state.currentTab !== 'chat') return false;
  const messages = Array.isArray(detail?.messages) ? detail.messages : [];
  const candidate = [...messages].reverse().find((message) => (
    String(message?.metadata?.type || '') === 'ubuddy_multi_task_status'
    && String(message?.metadata?.status || '') === 'dispatched'
    && String(message?.metadata?.collaborationGroupId || '').trim()
  ));
  if (!candidate) return false;
  const previousStates = new Set((previousDetail?.messages || []).map((message) => `${message?.id || ''}:${message?.metadata?.status || ''}:${message?.metadata?.collaborationGroupId || ''}`));
  const candidateState = `${candidate.id || ''}:${candidate.metadata.status || ''}:${candidate.metadata.collaborationGroupId || ''}`;
  if (!previousDetail || previousStates.has(candidateState)) return false;
  const collaborationGroupId = String(candidate.metadata.collaborationGroupId || '').trim();
  const dispatchId = String(candidate.metadata.dispatchCommandId || candidate.id || '').trim();
  const key = `${dispatchId}:${collaborationGroupId}`;
  if (!dispatchId || state.collaborationAutoOpenedDispatchIds?.[key]) return false;
  state.collaborationAutoOpenedDispatchIds = { ...(state.collaborationAutoOpenedDispatchIds || {}), [key]: true };
  void openCollaborationGroup(collaborationGroupId);
  return true;
}

function closeSocialEditDialog() {
  if (state.socialEditDialog?.busy) return;
  state.socialEditDialog = null;
  render();
}

async function submitSocialEditDialog(event) {
  event?.preventDefault?.();
  const item = state.socialEditDialog;
  if (!item) return;
  const value = document.getElementById('social-edit-input')?.value ?? item.draft ?? '';
  if (item.type === 'friend-remark') {
    await saveFriendRemark(item.targetId, value);
    return;
  }
  if (item.type === 'chat-group-remark') {
    await saveChatGroupRemark(item.targetId, value);
    return;
  }
  if (item.type === 'organization-display-name') {
    await saveOrganizationDisplayName(item.targetId, value);
    return;
  }
  if (item.type === 'group-display-name') {
    await saveGroupDisplayName(item.groupKind, item.targetId, value);
    return;
  }
  if (item.type === 'chat-group-rename') {
    await saveChatGroupName(item.targetId, value);
    return;
  }
  if (item.type === 'collaboration-group-rename') {
    await saveCollaborationGroupName(item.targetId, value);
  }
}

async function saveChatGroupRemark(groupId = '', value = '') {
  const id = String(groupId || '').trim();
  const dialog = state.socialEditDialog;
  const remark = String(value || '').trim();
  if (!id || dialog?.type !== 'chat-group-remark' || dialog.targetId !== id || dialog.busy) return;
  if (remark.length > 80) { state.socialEditDialog = { ...dialog, draft: value, error: '群聊备注不能超过 80 个字符。' }; render(); return; }
  state.socialEditDialog = { ...dialog, busy: true, error: '' }; render();
  const detail = await updateChatGroupById(id, 'set_remark', { remark });
  if (!detail) { if (state.socialEditDialog?.type === 'chat-group-remark') { state.socialEditDialog = { ...state.socialEditDialog, busy: false, error: '群聊备注保存失败，请重试。' }; render(); } return; }
  state.socialEditDialog = null;
  notify(remark ? '群聊备注已更新。' : '群聊备注已清除。', 'success');
  render();
}

function closeNetworkFriendMenus(event) {
  if (event?.type === 'keydown' && event.key !== 'Escape') return;
  if (event?.type === 'click' && event.target?.closest?.('.network-friend-menu')) return;
  const openMenus = [...document.querySelectorAll('.network-friend-menu[open]')];
  openMenus.forEach((menu) => menu.removeAttribute('open'));
  if (event?.type === 'keydown' && openMenus.length) {
    event.preventDefault();
    openMenus[0].querySelector('summary')?.focus();
  }
}

function composerProjectMentionPickerOpen() {
  return Boolean(state.socialMentionMenuOpen && document.querySelector('.project-mention-picker.is-open'));
}

function composerMentionPickerOpen() {
  return Boolean(state.socialMentionMenuOpen && document.querySelector('.social-mention-picker.is-open'));
}

function closeComposerMentionPicker({ focusInput = false, selectionStart = null, selectionEnd = null } = {}) {
  if (!composerMentionPickerOpen()) return false;
  state.socialMentionMenuOpen = false;
  state.composerMentionPickerMode = 'mention';
  state.composerMentionQuery = '';
  state.composerMentionActiveIndex = 0;
  resetProjectReferenceBrowser();
  render();
  if (focusInput || Number.isFinite(selectionStart)) {
    setTimeout(() => {
      const input = document.getElementById('chat-input');
      if (!input) return;
      input.focus();
      const valueLength = input.value.length;
      const start = Number.isFinite(selectionStart) ? Math.min(Math.max(0, selectionStart), valueLength) : valueLength;
      const end = Number.isFinite(selectionEnd) ? Math.min(Math.max(start, selectionEnd), valueLength) : start;
      input.setSelectionRange?.(start, end);
      autoResizeChatInput(input);
    }, 0);
  }
  return true;
}

function closeComposerProjectMentionPicker(options = {}) {
  if (!composerProjectMentionPickerOpen()) return false;
  return closeComposerMentionPicker(options);
}

function composerMentionOptions() {
  return [...document.querySelectorAll('.project-mention-picker.is-open [data-composer-mention-option]')]
    .filter((option) => !option.disabled && option.getClientRects().length);
}

function syncComposerMentionActiveOption({ scroll = false } = {}) {
  const options = composerMentionOptions();
  const activeIndex = options.length
    ? Math.min(Math.max(0, Number(state.composerMentionActiveIndex || 0)), options.length - 1)
    : 0;
  state.composerMentionActiveIndex = activeIndex;
  options.forEach((option, index) => {
    const active = index === activeIndex;
    option.classList.toggle('is-active', active);
    option.closest('.project-reference-option')?.classList.toggle('is-active', active);
    option.setAttribute('aria-current', active ? 'true' : 'false');
    if (active && scroll) option.scrollIntoView?.({ block: 'nearest' });
  });
  return options;
}

function handleComposerMentionPickerKeydown(event) {
  if (!composerProjectMentionPickerOpen() || event.isComposing || event.keyCode === 229) return false;
  const options = syncComposerMentionActiveOption();
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeComposerProjectMentionPicker({ focusInput: true });
    return true;
  }
  if (!options.length) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Tab'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') state.composerMentionActiveIndex = 0;
    else if (event.key === 'End') state.composerMentionActiveIndex = options.length - 1;
    else {
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      state.composerMentionActiveIndex = (Number(state.composerMentionActiveIndex || 0) + direction + options.length) % options.length;
    }
    syncComposerMentionActiveOption({ scroll: true });
    return true;
  }
  if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    options[Math.min(state.composerMentionActiveIndex, options.length - 1)]?.click();
    return true;
  }
  return false;
}

function closeComposerMentionPickerOnOutsideClick(event) {
  if (!composerMentionPickerOpen() || event.target?.closest?.('.social-mention-picker')) return;
  closeComposerMentionPicker();
}

function closeComposerMentionPickerOnEscape(event) {
  if (event.key !== 'Escape' || !composerMentionPickerOpen()) return;
  event.preventDefault();
  closeComposerMentionPicker({ focusInput: true });
}

function closeTaskReferencePickerOnOutsideClick(event) {
  if (!state.taskReferenceMenuOpen || event.target?.closest?.('.task-reference-picker')) return;
  taskReferenceOptionsRequestSequence += 1;
  state.taskReferenceMenuOpen = false;
  state.taskReferenceOptionsLoading = false;
  render();
}

function closeUBuddyMessageModeMenuOnOutsideClick(event) {
  if (!state.uBuddyMessageModeMenuOpen || event.target?.closest?.('.ubuddy-message-mode-picker')) return;
  state.uBuddyMessageModeMenuOpen = false;
  render();
}

function closeUBuddyParticipantSelectionMenuOnOutsideClick(event) {
  if (!state.uBuddyParticipantSelectionMenuOpen || event.target?.closest?.('.ubuddy-participant-policy-picker')) return;
  state.uBuddyParticipantSelectionMenuOpen = false;
  render();
}

function closeTaskReferencePickerOnEscape(event) {
  if (event.key !== 'Escape' || !state.taskReferenceMenuOpen) return;
  event.preventDefault();
  taskReferenceOptionsRequestSequence += 1;
  state.taskReferenceMenuOpen = false;
  state.taskReferenceOptionsLoading = false;
  render();
  focusChatInputAtEnd();
}

async function loadTaskReferenceOptions() {
  if (state.uBuddyFeatureFlags?.structuredTaskReference !== true || !window.janus.secretaryTaskReferenceOptions) return;
  const requestSequence = ++taskReferenceOptionsRequestSequence;
  const requestedSessionId = state.currentSessionId || state.secretarySessionId || '';
  const requestedUserId = String(state.currentUser?.id || '');
  state.taskReferenceOptionsLoading = true;
  state.taskReferenceOptionsError = '';
  render();
  try {
    const result = await window.janus.secretaryTaskReferenceOptions({
      sessionId: requestedSessionId,
    });
    if (requestSequence !== taskReferenceOptionsRequestSequence || !isUBuddyComposerMode()
      || String(state.currentUser?.id || '') !== requestedUserId) return;
    if (requestedSessionId && String(state.currentSessionId || state.secretarySessionId || '') !== requestedSessionId) return;
    state.taskReferenceOptions = Array.isArray(result?.tasks) ? result.tasks : [];
    if (result?.sessionId) state.secretarySessionId = result.sessionId;
  } catch (error) {
    if (requestSequence !== taskReferenceOptionsRequestSequence || !isUBuddyComposerMode()
      || String(state.currentUser?.id || '') !== requestedUserId) return;
    state.taskReferenceOptions = [];
    state.taskReferenceOptionsError = userVisibleErrorMessage(error, '无法读取任务列表。');
  } finally {
    if (requestSequence !== taskReferenceOptionsRequestSequence || !isUBuddyComposerMode()
      || String(state.currentUser?.id || '') !== requestedUserId) return;
    state.taskReferenceOptionsLoading = false;
    render();
  }
}

function placeNetworkFriendMenu(menu) {
  if (!menu?.open) {
    menu?.classList.remove('opens-upward');
    return;
  }
  document.querySelectorAll('.network-friend-menu[open]').forEach((other) => {
    if (other !== menu) other.removeAttribute('open');
  });
  requestAnimationFrame(() => {
    const popover = menu.querySelector('.network-friend-menu-popover');
    const summary = menu.querySelector('summary');
    const panel = menu.closest('.network-content') || menu.closest('.network-panel');
    if (!popover || !summary || !panel) return;
    const summaryRect = summary.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const popoverHeight = popover.getBoundingClientRect().height;
    menu.classList.toggle('opens-upward', summaryRect.bottom + 6 + popoverHeight > panelRect.bottom - 8);
  });
}

function wirePrimaryNavigationKeyboard() {
  const navigation = document.querySelector('[data-app-navigation]');
  if (!navigation) return;
  const items = [...navigation.querySelectorAll('[data-app-nav]')];
  navigation.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const current = event.target.closest('[data-app-nav]');
    if (!current) return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(current));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus({ preventScroll: true });
  });
}

function wireAccessibleEmployeeDialogs() {
  const layers = [...document.querySelectorAll('.employee-drawer-layer')];
  const activeLayer = layers.at(-1);
  const dialog = activeLayer?.querySelector('[role="dialog"]');
  if (!activeLayer || !dialog) return;
  dialog.tabIndex = -1;
  const focusableSelector = [
    'button:not(:disabled)',
    'a[href]',
    'input:not(:disabled)',
    'select:not(:disabled)',
    'textarea:not(:disabled)',
    'summary',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const focusableItems = () => [...dialog.querySelectorAll(focusableSelector)]
    .filter((item) => !item.hidden && item.getAttribute('aria-hidden') !== 'true' && item.getClientRects().length);
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      activeLayer.querySelector('[data-employee-detail-close], [data-employee-market-close], [data-employee-memory-close], [data-employee-growth-close]')?.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusableItems();
    if (!items.length) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  });
  requestAnimationFrame(() => {
    if (dialog.contains(document.activeElement)) return;
    (focusableItems()[0] || dialog).focus({ preventScroll: true });
  });
}


async function refreshUploadCompliance({ renderAfter = true } = {}) {
  if (!window.janus?.uploadCompliance || state.uploadComplianceLoading) return state.uploadCompliance;
  state.uploadComplianceLoading = true;
  state.uploadComplianceError = '';
  if (renderAfter) render();
  try {
    state.uploadCompliance = await window.janus.uploadCompliance({ limit: 100 });
    return state.uploadCompliance;
  } catch (error) {
    state.uploadComplianceError = userVisibleErrorMessage(error, '\u65e0\u6cd5\u8bfb\u53d6\u4e0a\u4f20\u5408\u89c4\u8bb0\u5f55\u3002');
    reportRendererEvent('error', 'upload-compliance-load-failed', error);
    return null;
  } finally {
    state.uploadComplianceLoading = false;
    if (state.currentTab === 'settings' && state.currentSettingsSection === 'evolution-sync') render();
  }
}

async function updateUploadComplianceAccount(button) {
  const userId = button?.dataset?.userId || '';
  const action = button?.dataset?.uploadComplianceAction || '';
  if (!userId || state.uploadComplianceBusyUserId) return;
  if (action === 'suspend' && !window.confirm('\u786e\u5b9a\u505c\u7528\u8be5\u4e91\u7aef\u8d26\u53f7\u5417\uff1f\u505c\u7528\u540e\u5bf9\u65b9\u5c06\u65e0\u6cd5\u767b\u5f55\u6216\u7ee7\u7eed\u4f7f\u7528\u4e91\u7aef\u670d\u52a1\u3002')) return;
  state.uploadComplianceBusyUserId = userId;
  render();
  try {
    const payload = { userId, reason: action === 'reactivate' ? 'admin_ui_reactivation' : 'admin_ui_suspension' };
    if (action === 'reactivate') await window.janus.reactivateCloudUser(payload);
    else await window.janus.suspendCloudUser(payload);
    notify(action === 'reactivate' ? '\u8d26\u53f7\u5df2\u6062\u590d\u3002' : '\u8d26\u53f7\u5df2\u505c\u7528\u3002', 'success');
    await refreshUploadCompliance({ renderAfter: false });
  } catch (error) {
    notify(userVisibleErrorMessage(error, action === 'reactivate' ? '\u6062\u590d\u8d26\u53f7\u5931\u8d25\u3002' : '\u505c\u7528\u8d26\u53f7\u5931\u8d25\u3002'), 'error');
    reportRendererEvent('error', 'upload-compliance-action-failed', error);
  } finally {
    state.uploadComplianceBusyUserId = '';
    render();
  }
}

async function refreshApplicationLoggingStatus({ silent = false } = {}) {
  if (!window.janus?.loggingStatus) {
    state.applicationLoggingError = '当前桌面桥接未提供日志状态接口。';
    if (!silent) render();
    return null;
  }
  state.applicationLoggingLoading = true;
  if (!silent) render();
  try {
    state.applicationLoggingStatus = await window.janus.loggingStatus();
    state.applicationLoggingError = '';
    return state.applicationLoggingStatus;
  } catch (error) {
    state.applicationLoggingError = userVisibleErrorMessage(error, '无法读取日志状态。');
    reportRendererEvent('error', 'logging-status-load-failed', error);
    return null;
  } finally {
    state.applicationLoggingLoading = false;
    if (state.currentTab === 'settings' && state.currentSettingsSection === 'diagnostics') render();
  }
}

function activeOrganizationResearchTarget() {
  const organizationId = String(state.activeAccountWorkspace?.organizationId || '');
  const organization = (state.friendOverview?.organizations || []).find((item) => String(item.id || '') === organizationId) || null;
  return { organizationId, organization };
}

async function loadOrganizationResearchResult(button) {
  const messageId = String(button?.dataset?.messageId || '');
  const resultId = String(button?.dataset?.organizationResearchResult || '');
  const organizationId = String(button?.dataset?.organizationId || '');
  if (!messageId || !resultId || !organizationId) return;
  button.disabled = true;
  try {
    const result = await window.janus.organizationResearchResult({ organizationId, resultId });
    state.organizationResearchResultsByMessageId = {
      ...(state.organizationResearchResultsByMessageId || {}), [messageId]: result,
    };
    render();
  } catch (error) {
    notify(userVisibleErrorMessage(error, '调查结果已锁定或当前不可访问。'), 'error');
    button.disabled = false;
  }
}

async function openOrganizationResearchSource(button) {
  const organizationId = String(button?.dataset?.organizationId || '');
  const sourceKind = String(button?.dataset?.sourceKind || '');
  const messageId = String(button?.dataset?.sourceMessageId || '');
  if (!organizationId || !sourceKind || !messageId) return;
  button.disabled = true;
  try {
    const context = await window.janus.organizationResearchSource({ organizationId, sourceKind, messageId });
    showDesktopDialog({
      icon: 'search',
      title: '组织消息来源',
      subtitle: context?.source?.conversationTitle || '有限上下文',
      message: '仅显示命中消息前后各 10 条。',
      rows: (context?.messages || []).slice(0, 21).map((item) => ({
        label: `${item.senderDisplayName || item.senderUserId || '组织成员'} · ${formatMessageTime(item.createdAt || '')}`,
        value: [item.body || '', ...(item.attachmentNames || []).map((name) => `[${name}]`)].filter(Boolean).join(' '),
      })),
    });
  } catch (error) {
    notify(userVisibleErrorMessage(error, '来源已撤回、租约已过期或当前无权访问。'), 'error');
  } finally {
    button.disabled = false;
  }
}

async function refreshOrganizationResearchGovernance({ silent = false } = {}) {
  const { organizationId, organization } = activeOrganizationResearchTarget();
  if (!organizationId || state.organizationResearchLoading) return null;
  state.organizationResearchLoading = true;
  state.organizationResearchError = '';
  if (!silent) render();
  try {
    const scope = ['owner', 'admin'].includes(organization?.role) ? 'organization' : 'self';
    const [policy, audits] = await Promise.all([
      window.janus.organizationResearchPolicy({ organizationId }),
      window.janus.organizationResearchAudits({ organizationId, scope, limit: 100 }),
    ]);
    state.organizationResearchPolicy = policy?.policy
      ? policy
      : { ...policy, organizationId };
    state.organizationResearchAudits = audits;
    return { policy, audits };
  } catch (error) {
    state.organizationResearchError = userVisibleErrorMessage(error, '无法读取组织消息调查设置。');
    return null;
  } finally {
    state.organizationResearchLoading = false;
    if (state.currentTab === 'settings' && state.currentSettingsSection === 'organization-research') render();
  }
}

async function enableActiveOrganizationResearch() {
  const { organizationId, organization } = activeOrganizationResearchTarget();
  if (!organizationId || organization?.role !== 'owner' || state.organizationResearchBusy) return;
  const confirmed = window.confirm([
    '启用后，组织内所有当前成员都可调查启用时间之后的新组织消息。',
    '范围包括组织内私聊、内部群、任务群和组织 Workspace Agent 对话；不包含历史消息、个人空间、私人助理、外部群或跨组织消息。',
    '组织成员不能单独退出索引。离开组织后访问会立即撤销，离线设备最迟在 24 小时租约到期后锁定。',
    '是否确认代表组织启用？',
  ].join('\n\n'));
  if (!confirmed) return;
  state.organizationResearchBusy = true;
  render();
  try {
    await window.janus.enableOrganizationResearch({ organizationId, confirmed: true, confirmationTextVersion: 'v1' });
    state.organizationResearchPolicy = null;
    state.organizationResearchAudits = null;
    await refreshOrganizationResearchGovernance({ silent: true });
    notify('组织消息调查已启用；不会回填启用前的历史消息。', 'success');
  } catch (error) {
    notify(userVisibleErrorMessage(error, '启用组织消息调查失败。'), 'error');
  } finally {
    state.organizationResearchBusy = false;
    render();
  }
}

async function refreshUBuddyCapabilityProfilePreview({ force = false } = {}) {
  if (state.uBuddyFeatureFlags?.profilePreviewV1 !== true) return null;
  if (state.uBuddyCapabilityProfilePreviewLoading) return state.uBuddyCapabilityProfilePreview;
  if (!force && state.uBuddyCapabilityProfilePreview) return state.uBuddyCapabilityProfilePreview;
  state.uBuddyCapabilityProfilePreviewLoading = true;
  state.uBuddyCapabilityProfilePreviewError = '';
  if (state.currentTab === 'settings' && state.currentSettingsSection === 'ubuddy-profile') render();
  try {
    const result = await window.janus.uBuddyCapabilityProfilePreview();
    state.uBuddyCapabilityProfilePreview = result?.enabled ? result : null;
    if (!result?.enabled) state.uBuddyCapabilityProfilePreviewError = '简介预览功能当前未启用。';
    return state.uBuddyCapabilityProfilePreview;
  } catch (error) {
    state.uBuddyCapabilityProfilePreviewError = userVisibleErrorMessage(error, '无法生成 uBuddy 简介预览。');
    return null;
  } finally {
    state.uBuddyCapabilityProfilePreviewLoading = false;
    if (state.currentTab === 'settings' && state.currentSettingsSection === 'ubuddy-profile') render();
  }
}

async function refreshUBuddyCapabilityProfileHistory({ silent = false } = {}) {
  if (state.uBuddyFeatureFlags?.profileHistory !== true || state.uBuddyCapabilityProfileHistoryLoading) {
    return state.uBuddyCapabilityProfileHistory;
  }
  state.uBuddyCapabilityProfileHistoryLoading = true;
  state.uBuddyCapabilityProfileHistoryError = '';
  if (!silent && state.currentTab === 'settings' && state.currentSettingsSection === 'ubuddy-profile') render();
  try {
    state.uBuddyCapabilityProfileHistory = await window.janus.uBuddyCapabilityProfileHistory({ limit: 100 });
    const pending = (state.uBuddyCapabilityProfileHistory?.profiles || [])
      .some((item) => ['pending', 'generating'].includes(item.generationStatus));
    if (pending && state.currentTab === 'settings' && state.currentSettingsSection === 'ubuddy-profile') {
      setTimeout(() => refreshUBuddyCapabilityProfileHistory({ silent: true }), 350);
    }
    return state.uBuddyCapabilityProfileHistory;
  } catch (error) {
    state.uBuddyCapabilityProfileHistoryError = userVisibleErrorMessage(error, '无法读取 uBuddy 简介历史。');
    return null;
  } finally {
    state.uBuddyCapabilityProfileHistoryLoading = false;
    if (state.currentTab === 'settings' && state.currentSettingsSection === 'ubuddy-profile') render();
  }
}

async function regenerateUBuddyCapabilityProfile() {
  if (state.uBuddyCapabilityProfileHistoryBusy) return;
  state.uBuddyCapabilityProfileHistoryBusy = 'regenerate';
  render();
  try {
    const result = await window.janus.regenerateUBuddyCapabilityProfile();
    notify(result?.status === 'idempotent' ? '当前 Skill 已有对应简介版本，未创建重复修订。' : '已提交后台生成；Skill 运行不受影响。', 'success');
    await refreshUBuddyCapabilityProfileHistory({ silent: true });
  } catch (error) {
    notify(userVisibleErrorMessage(error, '无法重新生成 uBuddy 简介。'), 'error');
  } finally {
    state.uBuddyCapabilityProfileHistoryBusy = '';
    render();
  }
}

async function reviewUBuddyCapabilityProfile(button) {
  if (state.uBuddyCapabilityProfileHistoryBusy) return;
  const decision = button?.dataset?.ubuddyProfileReview || '';
  const profileRevision = Number(button?.dataset?.profileRevision || 0);
  if (!profileRevision || !['approve', 'reject'].includes(decision)) return;
  if (decision === 'approve' && !window.confirm('确认该简介的新增能力范围与隐私提示，并允许按所选范围公开吗？')) return;
  state.uBuddyCapabilityProfileHistoryBusy = `${decision}:${profileRevision}`;
  render();
  try {
    await window.janus.reviewUBuddyCapabilityProfile({
      profileRevision,
      decision,
      visibility: button.dataset.profileVisibility || 'friends',
    });
    notify(decision === 'approve'
      ? '简介已确认并启用；公开同步将在可用时继续。'
      : '简介已拒绝；如有上一生效版本将继续使用。', 'success');
    await refreshUBuddyCapabilityProfileHistory({ silent: true });
  } catch (error) {
    notify(userVisibleErrorMessage(error, '无法完成 uBuddy 简介审核。'), 'error');
  } finally {
    state.uBuddyCapabilityProfileHistoryBusy = '';
    render();
  }
}

async function disableUBuddyCapabilityProfilePublication() {
  if (state.uBuddyCapabilityProfileHistoryBusy) return;
  state.uBuddyCapabilityProfileHistoryBusy = 'unpublish';
  render();
  try {
    await window.janus.updateUBuddyCapabilityProfilePublicationPreference({ enabled: false, visibility: 'private' });
    notify('已停止公开 uBuddy 简介；本地历史版本仍保留。', 'success');
    await refreshUBuddyCapabilityProfileHistory({ silent: true });
  } catch (error) {
    notify(userVisibleErrorMessage(error, '无法停止公开 uBuddy 简介。'), 'error');
  } finally {
    state.uBuddyCapabilityProfileHistoryBusy = '';
    render();
  }
}

async function openApplicationLogDirectory() {
  try {
    await window.janus.openLogDirectory();
    notify('日志目录已打开。', 'success');
  } catch (error) {
    notify(userVisibleErrorMessage(error, '无法打开日志目录。'), 'error');
  }
}

async function exportApplicationDiagnosticLog() {
  if (state.applicationLoggingBusy) return;
  state.applicationLoggingBusy = 'export';
  render();
  try {
    const result = await window.janus.exportDiagnosticLog();
    if (!result?.canceled) notify(`诊断日志已导出：${result.name || 'Janus-Diagnostics.log'}`, 'success');
  } catch (error) {
    notify(userVisibleErrorMessage(error, '诊断日志导出失败。'), 'error');
    reportRendererEvent('error', 'logging-export-failed', error);
  } finally {
    state.applicationLoggingBusy = '';
    await refreshApplicationLoggingStatus({ silent: true });
  }
}

function activeMessageConversationKind() {
  if (state.chatGroupId) return 'chat_group';
  if (state.collaborationGroupId) return 'collaboration_group';
  if (state.networkConversationPeerId) return state.networkConversationMode === 'person' ? 'social_direct' : 'social_group';
  return 'agent';
}

function activeMessageConversationId() {
  if (state.chatGroupId) return `chat-group:${state.chatGroupId}`;
  if (state.collaborationGroupId) return `collaboration:${state.collaborationGroupId}`;
  if (state.networkConversationPeerId) {
    return state.networkConversationMode === 'person'
      ? `direct:${state.networkConversationPeerId}`
      : `social-group:${state.networkConversationPeerId}:${state.networkConversationGroupId || ''}`;
  }
  return `session:${state.currentSessionId || state.currentChatKey || ''}`;
}

function activeMessageById(messageId = '') {
  const id = String(messageId || '').trim();
  if (!id) return null;
  const collections = [
    state.messages,
    state.networkConversationMessages,
    state.chatGroupDetail?.messages,
    state.collaborationGroupDetail?.messages,
  ];
  for (const items of collections) {
    const message = (Array.isArray(items) ? items : []).find((item) => String(item?.id || '') === id);
    if (message) return message;
  }
  return null;
}

function messageContextText(message = null, article = null) {
  const attachments = Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : [];
  const content = String(message?.content || '').trim();
  const visibleContent = attachments.length ? stripAttachmentResourceBlock(content).trim() : content;
  if (visibleContent) return stripHiddenMarkdownBlocks(visibleContent).trim();
  const renderedText = String(article?.querySelector?.('.message-body')?.innerText || '').trim();
  if (renderedText) return renderedText;
  if (attachments.some((attachment) => attachment?.favorite_emoji === true)) return '表情';
  if (attachments.length) return '分享了附件。';
  return '';
}

function messageHasForwardableContent(message = null, article = null) {
  if (!message) return false;
  return Boolean(messageContextText(message, article)
    || (Array.isArray(message.metadata?.attachments) && message.metadata.attachments.length));
}

function messageForwardAttachments(message = null) {
  return Array.isArray(message?.metadata?.attachments)
    ? message.metadata.attachments.filter(Boolean).map((attachment) => ({ ...attachment }))
    : [];
}

function messageContextAuthor(message = null, article = null) {
  const actor = String(article?.querySelector?.('.social-message-actor span')?.textContent || '').trim();
  if (actor) return actor;
  if (message?.role === 'user') return '我';
  if (message?.role === 'assistant') return agentNameById(message.agentId) || 'Agent';
  return message?.senderAgentId || message?.sender_agent_id ? 'uBuddy' : '消息';
}

function canWithdrawSocialMessage(message = null) {
  const conversationKind = activeMessageConversationKind();
  if (!message || !['social_direct', 'chat_group'].includes(conversationKind)) return false;
  const senderUserId = String(message.senderUserId || message.sender_user_id || '').trim();
  const createdAt = new Date(message.createdAt || message.created_at || 0).getTime();
  const ageMs = Date.now() - createdAt;
  const naturalPersonMessage = message.kind !== 'agent'
    && !String(message.senderAgentId || message.sender_agent_id || '').trim()
    && !String(message.recipientAgentId || message.recipient_agent_id || '').trim();
  const conversationEligible = conversationKind === 'chat_group'
    ? message.kind === 'friend' && state.chatGroupDetail?.group?.status === 'active'
    : message.metadata?.type === 'direct_message';
  return senderUserId === String(state.currentUser?.id || '').trim()
    && naturalPersonMessage
    && conversationEligible
    && message.metadata?.withdrawn !== true
    && Number.isFinite(ageMs)
    && ageMs >= -30_000
    && ageMs <= 2 * 60 * 1000;
}

function renderMessageContextMenu() {
  const menu = state.messageContextMenu;
  if (!menu) return '';
  if (menu.targetKind === 'image') {
    const fileAvailable = Boolean(menu.file?.path || menu.file?.id || menu.file?.remote_file_id);
    const sourceMessage = activeMessageById(menu.messageId);
    const canForwardImage = Boolean(sourceMessage && messageHasForwardableContent(sourceMessage));
    return `<div class="message-context-layer ${menu.previewContext ? 'is-preview-context' : ''}" data-message-context-dismiss>
      <div class="message-context-menu" role="menu" aria-label="图片操作" style="left:${Number(menu.x || 8)}px;top:${Number(menu.y || 8)}px" data-message-context-id="${escapeAttr(menu.messageId || '')}">
        ${fileAvailable ? `<button type="button" role="menuitem" title="复制图片到剪贴板" data-message-context-action="copy-image">${iconSvg('copy')}<strong>复制图片</strong></button>` : ''}
        <button type="button" role="menuitem" title="添加到收藏表情" data-message-context-action="favorite-image">${iconSvg('star')}<strong>添加到收藏表情</strong></button>
        <button type="button" role="menuitem" title="打开图片预览" data-message-context-action="preview-image">${iconSvg('image')}<strong>预览图片</strong></button>
        ${fileAvailable ? `<button type="button" role="menuitem" title="将图片另存到本机" data-message-context-action="save-image">${iconSvg('download')}<strong>另存为</strong></button>` : ''}
        ${menu.file?.path ? `<button type="button" role="menuitem" title="在文件夹中显示图片" data-message-context-action="show-image">${iconSvg('folder')}<strong>在文件夹中显示</strong></button>` : ''}
        ${fileAvailable ? `<button type="button" role="menuitem" title="使用系统应用打开图片" data-message-context-action="open-image">${iconSvg('external')}<strong>打开文件</strong></button>` : ''}
        ${canForwardImage ? `<button type="button" role="menuitem" title="发送给联系人或群聊" data-message-context-action="forward">${iconSvg('share')}<strong>转发</strong></button>` : ''}
      </div>
    </div>`;
  }
  const contextMessage = activeMessageById(menu.messageId);
  const contextReactionKind = activeMessageConversationKind() === 'chat_group' ? 'group' : 'direct';
  const contextCanReact = messageSupportsReactions(contextMessage, contextReactionKind);
  return `<div class="message-context-layer" data-message-context-dismiss>
    <div class="message-context-menu" role="menu" aria-label="消息操作" style="left:${Number(menu.x || 8)}px;top:${Number(menu.y || 8)}px" data-message-context-id="${escapeAttr(menu.messageId || '')}">
      <button type="button" role="menuitem" title="回复这条消息" data-message-context-action="quote">${iconSvg('message')}<strong>引用</strong></button>
      ${contextCanReact ? `<button type="button" role="menuitem" title="${escapeAttr(translateUiText('添加表情', state.languageMode))}" data-message-reaction-picker="${escapeAttr(menu.messageId || '')}" data-message-reaction-kind="${escapeAttr(contextReactionKind)}" data-message-reaction-group="${escapeAttr(contextReactionKind === 'group' ? state.chatGroupId || '' : '')}" data-message-reaction-workspace-id="${escapeAttr(menu.workspaceId || '')}">${iconSvg('thumbUp')}<strong>${escapeHtml(translateUiText('添加表情', state.languageMode))}</strong></button>` : ''}
      ${menu.forwardable ? `<button type="button" role="menuitem" title="发送给联系人或群聊" data-message-context-action="forward">${iconSvg('share')}<strong>转发</strong></button>` : ''}
      ${menu.inline ? '' : `<button type="button" role="menuitem" title="复制消息正文" data-message-context-action="copy">${iconSvg('copy')}<strong>复制</strong></button>`}
      ${menu.editable ? `<button type="button" role="menuitem" title="修改已发送消息并重新生成回复" data-message-context-action="edit">${iconSvg('edit')}<strong>重新编辑</strong></button>` : ''}
      ${menu.withdrawable ? `<button class="is-danger" type="button" role="menuitem" title="双方将不再看到正文" data-message-context-action="withdraw">${iconSvg('undo')}<strong>撤回</strong></button>` : ''}
    </div>
  </div>`;
}

function forwardContactRows() {
  return contactDirectoryRelationships(state.friendOverview, state.currentUser?.id).map((relationship) => {
    const friend = relationship.friend || relationship.user || relationship;
    if (!friend?.id || friend.id === state.currentUser?.id) return null;
    const label = String(relationship.remark || friend.remark || friend.displayName || friend.display_name || friend.username || friend.email || friend.id).trim();
    const detail = String(friend.username ? `@${friend.username}` : friend.email || '已接受联系人').trim();
    return { id: friend.id, label, detail, initial: label.slice(0, 1).toUpperCase() || '联' };
  }).filter(Boolean);
}

function forwardChatGroupRows() {
  return [...(Array.isArray(state.chatGroupsOverview?.groups) ? state.chatGroupsOverview.groups : [])]
    .filter((group) => group?.id && group.status !== 'dissolved')
    .sort((left, right) => new Date(right.updatedAt || right.updated_at || 0) - new Date(left.updatedAt || left.updated_at || 0))
    .map((group) => {
      const label = String(group.title || '新群聊').trim();
      const memberCount = Math.max(0, Number(group.memberCount || group.member_count || 0));
      return {
        id: group.id,
        label,
        detail: memberCount ? `${memberCount} 位成员 · 群聊` : '联系人群聊',
        initial: [...label][0] || '群',
      };
    });
}

function renderMessageForwardRows(items = [], kind = 'contact') {
  const group = kind === 'group';
  return items.map((item) => {
    const busyKey = `${kind}:${item.id}`;
    const busy = state.messageForwardBusy === busyKey;
    return `<button type="button" data-message-forward-target="${group ? 'group' : 'contact'}" data-message-forward-id="${escapeAttr(item.id)}" data-message-forward-search-text="${escapeAttr(`${item.label} ${item.detail}`.toLowerCase())}" ${state.messageForwardBusy ? 'disabled' : ''} aria-busy="${busy ? 'true' : 'false'}"><b class="${group ? 'is-group' : 'is-contact'}">${escapeHtml(item.initial)}</b><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(busy ? '正在发送…' : item.detail)}</small></span>${busy ? '<i class="message-forward-spinner" aria-hidden="true"></i>' : iconSvg('chevronRight')}</button>`;
  }).join('');
}

function renderMessageForwardDialog() {
  const dialog = state.messageForwardDialog;
  if (!dialog) return '';
  const contacts = forwardContactRows();
  const groups = forwardChatGroupRows();
  return `<div class="message-forward-overlay" data-message-forward-dismiss>
    <section class="message-forward-dialog" role="dialog" aria-modal="true" aria-labelledby="message-forward-title">
      <header><span>${iconSvg('share')}</span><div><strong id="message-forward-title">转发消息</strong><small>选择一个联系人或群聊</small></div><button type="button" data-message-forward-close aria-label="关闭">${iconSvg('x')}</button></header>
      <blockquote><small>原消息 · ${escapeHtml(dialog.authorLabel || '消息')}</small><span>${escapeHtml(String(dialog.content || '').replace(/\s+/g, ' ').slice(0, 240))}</span></blockquote>
      <label class="message-forward-search">${iconSvg('search')}<input type="search" data-message-forward-search placeholder="搜索联系人或群聊" autocomplete="off" /></label>
      <div class="message-forward-contacts" data-message-forward-list>
        ${groups.length ? `<section data-message-forward-section><header><strong>群聊</strong><small>${groups.length}</small></header>${renderMessageForwardRows(groups, 'group')}</section>` : ''}
        ${contacts.length ? `<section data-message-forward-section><header><strong>联系人</strong><small>${contacts.length}</small></header>${renderMessageForwardRows(contacts, 'contact')}</section>` : ''}
        ${groups.length || contacts.length ? '<p class="message-forward-no-results" data-message-forward-no-results hidden>没有匹配的联系人或群聊</p>' : '<p>暂无可转发的联系人或群聊。</p>'}
      </div>
    </section>
  </div>`;
}

async function materializeForwardAttachments(attachments = []) {
  const source = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  const result = [];
  for (const attachment of source) {
    const favorite = normalizeEmojiFavorites(state.composerFavoriteEmojis || []).find((item) => item.kind === 'image'
      && ((attachment.remote_file_id && item.id === attachment.remote_file_id)
        || (attachment.sha256 && item.sha256 === attachment.sha256)
        || (attachment.name && (item.filename === attachment.name || item.name === attachment.name))));
    const inline = String(attachment.value || attachment.url || favorite?.value || favorite?.url || '').trim();
    if (!inline.startsWith('data:')) {
      // A remote file id is scoped to the original conversation and cannot be
      // reused by the destination. Keep local paths eligible for the normal
      // destination upload; remote-only files fail with a clear error below.
      if (attachment.remote_file_id || attachment.remoteFileId || attachment.remote_file_kind || attachment.remoteFileKind) {
        if (attachment.favorite_emoji === true || attachment.favoriteEmoji === true) {
          throw new Error(`附件“${attachment.name || attachment.filename || '表情'}”尚未缓存，请先打开一次后再转发。`);
        }
        continue;
      }
      if (!attachment.path && !attachment.id) continue;
      result.push({ ...attachment, remote_file_id: '', remote_file_kind: '', group_id: '' });
      continue;
    }
    const match = inline.match(/^data:([^;,]+)?;base64,(.+)$/s);
    if (!match?.[2]) throw new Error(`附件“${attachment.name || attachment.filename || 'file'}”内容不完整，无法转发。`);
    const contentType = match[1] || attachment.content_type || attachment.type || 'application/octet-stream';
    const uploaded = await window.janus.uploadFile({
      filename: attachment.filename || attachment.name || 'forwarded-file',
      contentType,
      dataBase64: match[2],
    });
    result.push({
      ...attachment,
      ...uploaded,
      id: uploaded?.id || '',
      name: uploaded?.filename || uploaded?.name || attachment.name || attachment.filename || 'file',
      filename: uploaded?.filename || uploaded?.name || attachment.filename || attachment.name || 'file',
      type: uploaded?.content_type || contentType,
      content_type: uploaded?.content_type || contentType,
      size: uploaded?.size || attachment.size || 0,
      path: uploaded?.path || '',
      remote_file_id: '',
      remote_file_kind: '',
      group_id: '',
      value: inline,
      url: inline,
      favorite_emoji: attachment.favorite_emoji === true || attachment.favoriteEmoji === true,
    });
  }
  return result;
}

function closeMessageContextMenuOnEscape(event) {
  if (event.key !== 'Escape' || (!state.messageContextMenu && !state.messageForwardDialog)) return;
  state.messageContextMenu = null;
  state.messageForwardDialog = null;
  render();
}

function wireMessageContextMenus() {
  const openMessageMenu = (messageId, article, x, y, { inline = false } = {}) => {
    const message = activeMessageById(messageId);
    if (!messageId || !messageContextText(message, article) || message?.metadata?.withdrawn === true) return false;
    const conversationKind = activeMessageConversationKind();
    state.messageContextMenu = {
      messageId,
      workspaceId: String(message?.workspaceId || message?.accountWorkspaceId || message?.account_workspace_id || '').trim(),
      inline,
      editable: conversationKind === 'agent' && canEditMessageFromHistory(message),
      forwardable: Boolean(message),
      withdrawable: canWithdrawSocialMessage(message),
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 178)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 216)),
    };
    render();
    return true;
  };
  const openImageMenu = (target, x, y) => {
    const file = parsePreviewPayload(target?.dataset?.imageContextFile || '');
    if (!file) return false;
    state.messageContextMenu = {
      targetKind: 'image',
      messageId: String(target.closest?.('[data-message-id]')?.dataset.messageId || ''),
      file: normalizeFilePayload(file),
      previewContext: Boolean(target.closest?.('.preview-overlay')),
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 190)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 250)),
    };
    render();
    return true;
  };
  document.querySelectorAll('[data-withdrawn-message-edit]').forEach((button) => button.addEventListener('click', () => {
    const messageId = String(button.dataset.withdrawnMessageEdit || '').trim();
    const message = activeMessageById(messageId);
    const senderUserId = String(message?.senderUserId || message?.sender_user_id || '').trim();
    if (!message || message.metadata?.withdrawn !== true || senderUserId !== String(state.currentUser?.id || '').trim()) return;
    state.chatDraft = stripHiddenMarkdownBlocks(stripAttachmentResourceBlock(message.content || '')).trim();
    state.composerMentions = Array.isArray(message.metadata?.mentions) ? [...message.metadata.mentions] : [];
    const key = state.chatGroupId
      ? `chat-group:${state.chatGroupId}`
      : networkConversationDraftKey(state.networkConversationPeerId, state.networkConversationMode, state.networkConversationGroupId);
    state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [key]: state.chatDraft };
    persistComposerDrafts();
    render();
    focusChatInputAtEnd();
  }));
  document.querySelectorAll('#message-list [data-message-id]').forEach((article) => article.addEventListener('contextmenu', (event) => {
    const messageId = String(article.dataset.messageId || '').trim();
    if (!messageId || !messageHasForwardableContent(activeMessageById(messageId), article)) return;
    event.preventDefault();
    openMessageMenu(messageId, article, event.clientX, event.clientY);
  }));
  document.querySelectorAll('[data-image-context-file]').forEach((target) => target.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openImageMenu(target, event.clientX, event.clientY);
  }));
  document.querySelectorAll('[data-message-inline-more]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const article = button.closest('[data-message-id]');
    const messageId = String(button.dataset.messageInlineMore || article?.dataset.messageId || '').trim();
    const rect = button.getBoundingClientRect();
    openMessageMenu(messageId, article, rect.right - 190, rect.bottom + 4, { inline: true });
  }));
  document.querySelector('[data-message-context-dismiss]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    state.messageContextMenu = null;
    render();
  });
  document.querySelectorAll('[data-message-context-action]').forEach((button) => button.addEventListener('click', async () => {
    const messageId = String(button.closest('[data-message-context-id]')?.dataset.messageContextId || '').trim();
    const article = [...document.querySelectorAll('#message-list [data-message-id]')]
      .find((item) => String(item.dataset.messageId || '') === messageId) || null;
    const message = activeMessageById(messageId);
    const text = messageContextText(message, article);
    const action = button.dataset.messageContextAction;
    const imageFile = state.messageContextMenu?.targetKind === 'image' ? state.messageContextMenu.file : null;
    if (action === 'copy-image' && imageFile) {
      await copyImageFromPayload(imageFile);
    } else if (action === 'favorite-image' && imageFile) {
      state.messageContextMenu = null;
      await addMessageImageToFavorites(imageFile);
    } else if (action === 'preview-image' && imageFile) {
      await previewFileInfo(imageFile);
    } else if (action === 'save-image' && imageFile) {
      await saveFileFromPayload(imageFile);
    } else if (action === 'show-image' && imageFile) {
      await showFileFromPayload(imageFile);
    } else if (action === 'open-image' && imageFile) {
      await openFileFromPayload(imageFile);
    } else if (action === 'copy') {
      try {
        await writeClipboardText(text);
        notify('消息已复制。', 'success');
      } catch (error) {
        notify(userVisibleErrorMessage(error, '复制消息失败。'), 'error');
      }
    } else if (action === 'edit') {
      state.messageContextMenu = null;
      editMessageFromHistory(messageId);
      return;
    } else if (action === 'forward' && message) {
      state.messageForwardDialog = {
        sourceMessageId: messageId,
        sourceConversationKind: activeMessageConversationKind(),
        authorLabel: messageContextAuthor(message, article),
        content: text || (state.messageContextMenu?.targetKind === 'image' ? '表情' : '分享了附件。'),
        attachments: messageForwardAttachments(message),
        favoriteEmoji: message.metadata?.favoriteEmoji === true,
        createdAt: message.createdAt || message.created_at || '',
      };
    } else if (action === 'withdraw' && canWithdrawSocialMessage(message)) {
      state.messageContextMenu = null;
      render();
      try {
        if (activeMessageConversationKind() === 'chat_group') {
          state.chatGroupDetail = await window.janus.updateChatGroup({
            groupId: state.chatGroupId,
            action: 'withdraw_message',
            messageId,
            clientRequestId: globalThis.crypto?.randomUUID?.() || `chat_group_withdraw_${Date.now()}`,
          });
          await refreshChatGroupsOverview({ silent: true });
        } else {
          await window.janus.updateSocialMessage({ messageId, action: 'withdraw' });
          if (window.janus.pollSocialNetwork) await window.janus.pollSocialNetwork({ autoProcess: false }).catch(() => null);
          state.networkConversationMessages = await window.janus.socialConversation({ peerId: state.networkConversationPeerId });
          await refreshSocialThreads(false);
        }
        notify('消息已撤回。', 'success');
      } catch (error) {
        const message = userVisibleErrorMessage(error, '消息撤回失败。');
        notify(/只能修改或撤回委托的补充消息/.test(message)
          ? '当前云端仍是旧版撤回规则，需要更新云端服务后才能撤回自然人私聊消息。'
          : message, 'error');
      }
      render();
      return;
    } else if (action === 'quote' && message) {
      state.messageQuote = normalizeMessageQuote({
        sourceMessageId: messageId,
        sourceConversationId: activeMessageConversationId(),
        conversationKind: activeMessageConversationKind(),
        authorLabel: messageContextAuthor(message, article),
        role: message.role || (message.senderAgentId || message.sender_agent_id ? 'agent' : 'friend'),
        excerpt: text,
        createdAt: message.createdAt || message.created_at || '',
      });
    }
    state.messageContextMenu = null;
    render();
    if (action === 'quote') focusChatInputAtEnd();
    if (action === 'forward') setTimeout(() => document.querySelector('[data-message-forward-search]')?.focus(), 0);
  }));
  document.querySelectorAll('[data-message-rewrite-form]').forEach((form) => form.addEventListener('submit', submitMessageRewrite));
  document.querySelectorAll('[data-message-rewrite-cancel]').forEach((button) => button.addEventListener('click', () => {
    state.messageEditingId = '';
    state.messageEditingDraft = '';
    state.messageEditingError = '';
    render();
  }));
  document.querySelectorAll('[data-message-rewrite-input]').forEach((input) => input.addEventListener('input', () => {
    state.messageEditingDraft = input.value;
  }));
  document.querySelector('[data-message-forward-dismiss]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    state.messageForwardDialog = null;
    render();
  });
  document.querySelector('[data-message-forward-close]')?.addEventListener('click', () => {
    state.messageForwardDialog = null;
    render();
  });
  document.querySelector('[data-message-forward-search]')?.addEventListener('input', (event) => {
    const query = String(event.currentTarget.value || '').trim().toLowerCase();
    let visibleRows = 0;
    document.querySelectorAll('[data-message-forward-section]').forEach((section) => {
      let visibleInSection = 0;
      section.querySelectorAll('[data-message-forward-search-text]').forEach((row) => {
        const visible = !query || String(row.dataset.messageForwardSearchText || '').includes(query);
        row.hidden = !visible;
        if (visible) visibleInSection += 1;
      });
      section.hidden = visibleInSection === 0;
      visibleRows += visibleInSection;
    });
    const empty = document.querySelector('[data-message-forward-no-results]');
    if (empty) empty.hidden = visibleRows > 0;
  });
  document.querySelectorAll('[data-message-forward-target]').forEach((button) => button.addEventListener('click', async () => {
    const dialog = state.messageForwardDialog;
    const targetKind = button.dataset.messageForwardTarget === 'group' ? 'group' : 'contact';
    const targetId = String(button.dataset.messageForwardId || '').trim();
    if (!dialog || !targetId || state.messageForwardBusy) return;
    state.messageForwardBusy = `${targetKind}:${targetId}`;
    render();
    try {
      const forwardedMessage = {
        version: 'message_forward_v1',
        sourceMessageId: dialog.sourceMessageId,
        sourceConversationKind: dialog.sourceConversationKind,
        authorLabel: dialog.authorLabel,
        excerpt: String(dialog.content || '').slice(0, 8000),
        createdAt: dialog.createdAt || '',
        forwardedAt: new Date().toISOString(),
      };
      const sourceAttachments = Array.isArray(dialog.attachments)
        ? dialog.attachments.filter(Boolean).map((attachment) => ({ ...attachment }))
        : [];
      const forwardAttachments = await materializeForwardAttachments(sourceAttachments);
      const forwardedContent = String(dialog.content || '').trim();
      const forwardedMetadata = {
        type: 'forwarded_message',
        forwardedMessage,
        ...(forwardAttachments.length ? { attachments: forwardAttachments } : {}),
        ...(dialog.favoriteEmoji || (forwardAttachments.length && forwardAttachments.every((attachment) => attachment.favorite_emoji === true || attachment.favoriteEmoji === true))
          ? { favoriteEmoji: true }
          : {}),
      };
      if (targetKind === 'group') {
        const detail = await window.janus.sendChatGroupMessage({
          groupId: targetId,
          content: forwardedContent || (sourceAttachments.length ? '\u200b' : ''),
          clientMessageId: globalThis.crypto?.randomUUID?.() || `chat_group_forward_${Date.now()}`,
          metadata: forwardedMetadata,
        });
        if (state.chatGroupId === targetId) state.chatGroupDetail = detail;
        await refreshChatGroupsOverview({ silent: true });
      } else {
        await window.janus.sendSocialMessage({
          recipientId: targetId,
          content: forwardedContent || (sourceAttachments.length ? '\u200b' : ''),
          kind: 'friend',
          metadata: { ...forwardedMetadata, type: 'direct_message' },
        });
        await refreshSocialThreads(false);
      }
      state.messageForwardDialog = null;
      notify(targetKind === 'group' ? '消息已转发到群聊。' : '消息已转发。', 'success');
    } catch (error) {
      notify(userVisibleErrorMessage(error, '消息转发失败。'), 'error');
    } finally {
      state.messageForwardBusy = '';
      render();
    }
  }));
}

function wireAnchoredMessageDisclosures() {
  const controls = [...document.querySelectorAll('#message-list [data-long-message-toggle], #message-list button, #message-list a')]
    .filter((control) => control.matches('[data-long-message-toggle]') || /显示全文|展开全文|收起全文/.test(control.textContent || ''));
  controls.forEach((control) => {
    control.addEventListener('click', (event) => {
      messageScrollFollowEvaluation += 1;
      messageScrollFollow = false;
      const messageId = String(control.closest('[data-message-id]')?.dataset.messageId || '').trim();
      const snapshot = messageDisclosureScrollSnapshot
        || captureMessageScrollState({ allowFollow: false, anchorMessageId: messageId });
      messageDisclosureScrollSnapshot = null;
      if (control.matches('a[href^="#"]')) event.preventDefault();
      const evaluation = messageScrollFollowEvaluation;
      const restoreDisclosurePosition = () => {
        if (evaluation !== messageScrollFollowEvaluation) return;
        restoreMessageScrollState(snapshot);
        const list = document.getElementById('message-list');
        const savedTop = Number(snapshot?.top);
        const maxTop = list ? Math.max(0, list.scrollHeight - list.clientHeight) : 0;
        if (list && Number.isFinite(savedTop) && savedTop <= maxTop) {
          list.scrollTop = savedTop;
          messageScrollTop = list.scrollTop;
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(() => {
        restoreDisclosurePosition();
        setTimeout(restoreDisclosurePosition, 0);
      }));
    });
  });
}

async function clearApplicationDiagnosticLogs() {
  if (state.applicationLoggingBusy) return;
  if (!window.confirm('确定清理轮转日志和旧崩溃文件吗？当前 janus.log 会保留。')) return;
  state.applicationLoggingBusy = 'clear';
  render();
  try {
    const result = await window.janus.clearApplicationLogs();
    notify(`已清理 ${Number(result?.removed || 0)} 个旧日志文件。`, 'success');
  } catch (error) {
    notify(userVisibleErrorMessage(error, '旧日志清理失败。'), 'error');
    reportRendererEvent('error', 'logging-clear-failed', error);
  } finally {
    state.applicationLoggingBusy = '';
    await refreshApplicationLoggingStatus({ silent: true });
  }
}

async function refreshChatGroupsOverview({ silent = false } = {}) {
  try {
    state.chatGroupsOverview = await window.janus.chatGroupsOverview();
    if (!silent) render();
    return state.chatGroupsOverview;
  } catch (error) {
    if (!silent) notify(userVisibleErrorMessage(error, '刷新群聊失败。'), 'error');
    return state.chatGroupsOverview;
  }
}

async function openChatGroup(groupId = '') {
  const id = String(groupId || '').trim();
  if (!id) return;
  followerController.close();
  preserveChatDraftFromInput();
  state.currentTab = 'chat';
  state.networkPanelOpen = true;
  state.networkPanelView = 'messages';
  state.networkMessageHomeOpen = false;
  state.messageActivePane = 'conversation';
  state.networkConversationPeerId = '';
  state.networkConversationGroupId = '';
  state.networkConversationMessages = [];
  state.networkConversationBusy = false;
  state.collaborationGroupId = '';
  state.collaborationGroupDetail = null;
  state.networkGroupProfileOpen = false;
  state.networkSelectedGroupId = '';
  state.networkSelectedGroupKind = '';
  state.groupDirectoryProfileDetail = null;
  state.chatGroupId = id;
  state.currentSessionId = '';
  state.currentChatKey = `chat-group:${id}`;
  state.currentAgentInstanceId = '';
  state.messages = [];
  state.contextUsage = null;
  state.homeMode = 'department';
  const cachedDetail = state.chatGroupDetailCache?.[id] || null;
  const overviewGroup = (state.chatGroupsOverview?.groups || []).find((item) => String(item?.id || '') === id) || null;
  state.chatGroupDetail = cachedDetail || {
    group: { ...(overviewGroup || {}), id },
    membership: null,
    members: [],
    messages: [],
    loading: true,
  };
  restoreComposerDraft(`chat-group:${id}`, {
    fallbackText: state.networkConversationDrafts?.[`chat-group:${id}`] || '',
  });
  render();
  const overviewRefresh = refreshChatGroupsOverview({ silent: true });
  try {
    const detail = await window.janus.chatGroup({ groupId: id });
    if (state.chatGroupId !== id) return;
    state.chatGroupDetail = detail;
    state.chatGroupDetailCache = { ...(state.chatGroupDetailCache || {}), [id]: detail };
    if (maybeAutoOpenDispatchedCollaborationGroup(detail, id)) return;
  } catch (error) {
    if (state.chatGroupId !== id) return;
    notify(userVisibleErrorMessage(error, '打开群聊失败。'), 'error');
    if (!cachedDetail) {
      state.chatGroupId = '';
      state.chatGroupDetail = null;
      state.networkMessageHomeOpen = true;
      state.messageActivePane = 'list';
    }
  }
  void overviewRefresh;
  render();
  scrollMessagesToBottom({ force: true });
}

async function openGroupDirectoryProfile(kind = '', groupId = '') {
  const cleanKind = kind === 'work' ? 'work' : 'contact';
  const id = String(groupId || '').trim();
  if (!id) return;
  state.networkSelectedContactId = '';
  state.networkContactProfileOpen = false;
  state.networkSelectedGroupKind = cleanKind;
  state.networkSelectedGroupId = id;
  state.networkGroupProfileOpen = true;
  const activeChatDetail = cleanKind === 'contact' && String(state.chatGroupId || '') === id
    ? state.chatGroupDetail
    : null;
  state.groupDirectoryProfileDetail = activeChatDetail || state.chatGroupDetailCache?.[id] || null;
  render();
  try {
    const detail = cleanKind === 'work'
      ? await window.janus.collaborationGroup({ groupId: id })
      : await window.janus.chatGroup({ groupId: id });
    if (!state.networkGroupProfileOpen || state.networkSelectedGroupId !== id || state.networkSelectedGroupKind !== cleanKind) return;
    state.groupDirectoryProfileDetail = detail;
    if (cleanKind === 'contact') {
      state.chatGroupDetailCache = { ...(state.chatGroupDetailCache || {}), [id]: detail };
      if (state.chatGroupId === id) state.chatGroupDetail = detail;
    }
  } catch (error) {
    notify(userVisibleErrorMessage(error, '群组详情加载失败。'), 'error');
  }
  render();
}

function closeGroupDirectoryProfile() {
  state.networkGroupProfileOpen = false;
  state.networkSelectedGroupId = '';
  state.networkSelectedGroupKind = '';
  state.groupDirectoryProfileDetail = null;
  render();
}

function openChatGroupInvite(groupId = '') {
  const id = String(groupId || state.chatGroupId || state.networkSelectedGroupId || '').trim();
  const detail = state.chatGroupDetail?.group?.id === id ? state.chatGroupDetail
    : state.groupDirectoryProfileDetail?.group?.id === id ? state.groupDirectoryProfileDetail : null;
  if (!id || !detail) return;
  state.chatGroupInviteOpen = true;
  state.chatGroupInviteBusy = false;
  state.chatGroupInviteUserId = '';
  state.chatGroupInviteGroupDetail = detail;
  render();
}

function chatGroupDetailById(groupId = '') {
  const id = String(groupId || '').trim();
  if (!id) return null;
  if (String(state.chatGroupDetail?.group?.id || '') === id) return state.chatGroupDetail;
  if (String(state.groupDirectoryProfileDetail?.group?.id || '') === id) return state.groupDirectoryProfileDetail;
  return state.chatGroupDetailCache?.[id] || null;
}

function openChatGroupRename(groupId = '') {
  const id = String(groupId || state.chatGroupId || state.networkSelectedGroupId || '').trim();
  const detail = chatGroupDetailById(id);
  const membership = detail?.membership || (detail?.members || []).find((member) => (
    String(member.userId || member.user_id || '') === String(state.currentUser?.id || '')
  ));
  if (!id || !['owner', 'admin'].includes(String(membership?.role || '')) || detail?.group?.status !== 'active') return;
  const overviewGroup = (state.chatGroupsOverview?.groups || []).find((group) => String(group?.id || '') === id) || {};
  state.socialEditDialog = {
    type: 'chat-group-rename',
    targetId: id,
    subtitle: '保存后会同步更新消息列表、聊天标题和群聊详情',
    draft: detail?.group?.title || overviewGroup.title || '新群聊',
    busy: false,
    error: '',
  };
  render();
  requestAnimationFrame(() => document.getElementById('social-edit-input')?.select());
}

function closeChatGroupInvite(event) {
  if (state.chatGroupInviteBusy) return;
  if (event?.currentTarget?.classList?.contains('chat-group-invite-overlay') && event.target !== event.currentTarget) return;
  state.chatGroupInviteOpen = false;
  state.chatGroupInviteUserId = '';
  state.chatGroupInviteGroupDetail = null;
  render();
}

async function submitChatGroupInvite(event) {
  event.preventDefault();
  const groupId = String(state.chatGroupInviteGroupDetail?.group?.id || '').trim();
  const userId = String(state.chatGroupInviteUserId || '').trim();
  if (!groupId || !userId || state.chatGroupInviteBusy) return;
  state.chatGroupInviteBusy = true;
  render();
  const detail = await updateChatGroupById(groupId, 'add_member', { userId });
  if (detail) {
    state.chatGroupInviteOpen = false;
    state.chatGroupInviteUserId = '';
    state.chatGroupInviteGroupDetail = null;
    notify('新成员已加入群聊。', 'success');
  }
  state.chatGroupInviteBusy = false;
  render();
}

function closeChatGroupCreateDialog() {
  if (state.chatGroupCreateBusy) return;
  state.chatGroupCreateOpen = false;
  state.chatGroupCreateTitle = '';
  state.chatGroupCreateMemberIds = [];
  state.chatGroupCreateLastMemberId = '';
  render();
}

async function submitChatGroupCreate(event) {
  event.preventDefault();
  const memberIds = [...new Set(state.chatGroupCreateMemberIds || [])];
  if (!memberIds.length || state.chatGroupCreateBusy) return;
  state.chatGroupCreateBusy = true;
  state.chatGroupCreateTitle = document.querySelector('#chat-group-create-name')?.value || state.chatGroupCreateTitle || '';
  render();
  try {
    const detail = await window.janus.createChatGroup({
      title: state.chatGroupCreateTitle,
      memberIds,
      clientRequestId: globalThis.crypto?.randomUUID?.() || `chat_group_create_${Date.now()}`,
    });
    state.chatGroupCreateOpen = false;
    state.chatGroupCreateTitle = '';
    state.chatGroupCreateMemberIds = [];
    state.chatGroupCreateLastMemberId = '';
    await refreshChatGroupsOverview({ silent: true });
    await openChatGroup(detail?.group?.id || '');
    notify('群聊已创建。', 'success');
  } catch (error) {
    notify(userVisibleErrorMessage(error, '创建群聊失败。'), 'error');
  } finally {
    state.chatGroupCreateBusy = false;
    render();
  }
}

async function updateActiveChatGroup(action = '', payload = {}) {
  const groupId = String(state.chatGroupId || '').trim();
  if (!groupId) return;
  await updateChatGroupById(groupId, action, payload);
}

async function updateChatGroupById(groupId = '', action = '', payload = {}) {
  const id = String(groupId || '').trim();
  if (!id) return null;
  try {
    const detail = await window.janus.updateChatGroup({
      groupId: id,
      action,
      clientRequestId: globalThis.crypto?.randomUUID?.() || `chat_group_action_${Date.now()}`,
      ...payload,
    });
    if (state.chatGroupId === id) state.chatGroupDetail = detail;
    if (state.networkSelectedGroupKind === 'contact' && state.networkSelectedGroupId === id) state.groupDirectoryProfileDetail = detail;
    if (state.chatGroupInviteGroupDetail?.group?.id === id) state.chatGroupInviteGroupDetail = detail;
    state.chatGroupDetailCache = { ...(state.chatGroupDetailCache || {}), [id]: detail };
    if (detail?.group) {
      const overview = state.chatGroupsOverview && typeof state.chatGroupsOverview === 'object'
        ? state.chatGroupsOverview
        : { groups: [] };
      state.chatGroupsOverview = {
        ...overview,
        groups: (Array.isArray(overview.groups) ? overview.groups : []).map((group) => (
          String(group?.id || '') === id ? { ...group, ...detail.group } : group
        )),
      };
    }
    await refreshChatGroupsOverview({ silent: true });
    render();
    return detail;
  } catch (error) {
    notify(userVisibleErrorMessage(error, '群聊操作失败。'), 'error');
    return null;
  }
}

async function saveChatGroupName(groupId = '', value = '') {
  const id = String(groupId || '').trim();
  const dialog = state.socialEditDialog;
  if (!id || dialog?.type !== 'chat-group-rename' || dialog.targetId !== id || dialog.busy) return;
  const title = String(value || '').trim();
  if (!title) {
    state.socialEditDialog = { ...dialog, draft: value, error: '群聊名称不能为空。' };
    render();
    return;
  }
  if (title.length > 80) {
    state.socialEditDialog = { ...dialog, draft: value, error: '群聊名称不能超过 80 个字符。' };
    render();
    return;
  }
  const currentTitle = String(chatGroupDetailById(id)?.group?.title || '').trim();
  if (title === currentTitle) {
    state.socialEditDialog = null;
    render();
    return;
  }
  state.socialEditDialog = { ...dialog, draft: title, busy: true, error: '' };
  render();
  const detail = await updateChatGroupById(id, 'rename', { title });
  if (!detail) {
    if (state.socialEditDialog?.type === 'chat-group-rename' && state.socialEditDialog.targetId === id) {
      state.socialEditDialog = { ...state.socialEditDialog, busy: false, error: '群名保存失败，请重试。' };
      render();
    }
    return;
  }
  state.socialEditDialog = null;
  notify('群聊名称已修改。', 'success');
  render();
}

function openOrganizationDisplayName(organizationId = '', draft = '') {
  const organization = (state.friendOverview?.organizations || []).find((item) => String(item.id || '') === String(organizationId || ''));
  if (!organization) return;
  state.socialEditDialog = {
    type: 'organization-display-name',
    targetId: organization.id,
    subtitle: `仅影响你在“${organization.name || '当前组织'}”中的公开名称；留空恢复账号名称`,
    draft: String(draft || ''),
    busy: false,
    error: '',
  };
  render();
  requestAnimationFrame(() => document.getElementById('social-edit-input')?.select());
}

function openOrganizationNameEdit(event) {
  event?.preventDefault?.();
  const organizationId = String(event?.currentTarget?.dataset?.organizationNameEdit
    || event?.currentTarget?.dataset?.organizationNameDblclick || state.contactsSelectedOrganizationId || '').trim();
  const organization = (state.friendOverview?.organizations || []).find((item) => String(item.id || '') === organizationId);
  if (!organization || organization.role !== 'owner') return;
  state.organizationNameEditId = organizationId;
  state.organizationNameEditDraft = String(organization.name || '');
  state.organizationNameEditBusy = false;
  render();
  requestAnimationFrame(() => document.querySelector('[data-organization-name-input]')?.select());
}

function cancelOrganizationNameEdit() {
  state.organizationNameEditId = '';
  state.organizationNameEditDraft = '';
  state.organizationNameEditBusy = false;
  render();
}

async function saveOrganizationName(organizationId = '', value = '') {
  const id = String(organizationId || '').trim();
  const organization = (state.friendOverview?.organizations || []).find((item) => String(item.id || '') === id);
  if (!id || !organization || organization.role !== 'owner' || state.organizationNameEditBusy) return;
  const name = String(value || '').trim();
  if (name.length < 2 || name.length > 60) {
    notify(translateUiText('组织名称需要 2–60 个字符。', state.languageMode), 'warning');
    return;
  }
  state.organizationNameEditDraft = name;
  state.organizationNameEditBusy = true;
  render();
  try {
    const result = await window.janus.organizationAction({ organizationId: id, action: 'rename', name });
    state.friendOverview = result?.overview || await window.janus.friendsOverview();
    state.organizationNameEditId = '';
    state.organizationNameEditDraft = '';
    notify(translateUiText('组织名称已更新。', state.languageMode), 'success');
  } catch (error) {
    state.organizationNameEditBusy = false;
    notify(userVisibleErrorMessage(error, translateUiText('组织名称保存失败。', state.languageMode)), 'error');
  }
  state.organizationNameEditBusy = false;
  render();
}

async function saveOrganizationDisplayName(organizationId = '', value = '') {
  const dialog = state.socialEditDialog;
  if (dialog?.type !== 'organization-display-name' || dialog.targetId !== organizationId || dialog.busy) return;
  const displayName = String(value || '').trim();
  if (displayName.length > 80) {
    state.socialEditDialog = { ...dialog, draft: value, error: '组织内显示名不能超过 80 个字符。' };
    render();
    return;
  }
  state.socialEditDialog = { ...dialog, draft: displayName, busy: true, error: '' };
  render();
  try {
    const result = await window.janus.organizationAction({ organizationId, action: 'set_display_name', displayName });
    state.friendOverview = result?.overview || await window.janus.friendsOverview();
    state.socialEditDialog = null;
    notify(displayName ? '组织内显示名已更新。' : '已恢复账号名称。', 'success');
  } catch (error) {
    state.socialEditDialog = { ...state.socialEditDialog, busy: false, error: userVisibleErrorMessage(error, '组织内显示名保存失败。') };
  }
  render();
}

function openGroupDisplayName(kind = '', groupId = '', draft = '') {
  const normalizedKind = kind === 'work' ? 'work' : 'contact';
  if (!groupId) return;
  state.socialEditDialog = {
    type: 'group-display-name',
    groupKind: normalizedKind,
    targetId: groupId,
    subtitle: `仅影响你在${normalizedKind === 'work' ? '当前工作群' : '当前群聊'}中的公开名称；留空恢复账号名称`,
    draft: String(draft || ''),
    busy: false,
    error: '',
  };
  render();
  requestAnimationFrame(() => document.getElementById('social-edit-input')?.select());
}

async function saveGroupDisplayName(kind = '', groupId = '', value = '') {
  const dialog = state.socialEditDialog;
  const normalizedKind = kind === 'work' ? 'work' : 'contact';
  if (dialog?.type !== 'group-display-name' || dialog.targetId !== groupId || dialog.busy) return;
  const displayName = String(value || '').trim();
  if (displayName.length > 80) {
    state.socialEditDialog = { ...dialog, draft: value, error: '群内显示名不能超过 80 个字符。' };
    render();
    return;
  }
  state.socialEditDialog = { ...dialog, draft: displayName, busy: true, error: '' };
  render();
  try {
    if (normalizedKind === 'contact') {
      const detail = await updateChatGroupById(groupId, 'set_display_name', { displayName });
      if (!detail) throw new Error('群内显示名保存失败。');
    } else {
      const detail = await window.janus.updateCollaborationGroup({ groupId, action: 'set_display_name', displayName });
      if (state.collaborationGroupId === groupId) state.collaborationGroupDetail = detail;
      if (state.networkSelectedGroupKind === 'work' && state.networkSelectedGroupId === groupId) state.groupDirectoryProfileDetail = detail;
    }
    state.socialEditDialog = null;
    notify(displayName ? '群内显示名已更新。' : '已恢复账号名称。', 'success');
  } catch (error) {
    state.socialEditDialog = { ...state.socialEditDialog, busy: false, error: userVisibleErrorMessage(error, '群内显示名保存失败。') };
  }
  render();
}


async function loadContactUBuddyCapabilityProfile(userId = '') {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId || state.uBuddyFeatureFlags?.profilePublication !== true
    || typeof window.janus.queryUBuddyCapabilityProfiles !== 'function') return;
  const stillSelected = () => state.networkContactProfileOpen && state.networkSelectedContactId === cleanUserId;
  state.uBuddyCapabilityProfileLoadingByUserId = { ...state.uBuddyCapabilityProfileLoadingByUserId, [cleanUserId]: true };
  try {
    const cached = await window.janus.queryUBuddyCapabilityProfiles({ userIds: [cleanUserId], cachedOnly: true });
    const cachedItem = cached?.profiles?.find((item) => String(item.ownerUserId || '') === cleanUserId) || null;
    if (cachedItem) {
      state.uBuddyCapabilityProfilesByUserId = {
        ...state.uBuddyCapabilityProfilesByUserId, [cleanUserId]: { ...cachedItem, cached: true },
      };
      if (stillSelected()) render();
    }
    const refreshed = await window.janus.queryUBuddyCapabilityProfiles({ userIds: [cleanUserId] });
    const item = refreshed?.profiles?.find((entry) => String(entry.ownerUserId || '') === cleanUserId) || null;
    state.uBuddyCapabilityProfilesByUserId = { ...state.uBuddyCapabilityProfilesByUserId, [cleanUserId]: item };
  } catch {
    // A valid local cache remains visible when the social relay is offline.
  } finally {
    state.uBuddyCapabilityProfileLoadingByUserId = { ...state.uBuddyCapabilityProfileLoadingByUserId, [cleanUserId]: false };
    if (stillSelected()) render();
  }
}

function installPersistentNavigationEvents() {
  if (persistentNavigationEventsInstalled) return;
  persistentNavigationEventsInstalled = true;
  document.addEventListener('click', handlePersistentNavigationClick);
}

function handlePersistentNavigationClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !app.contains(target)) return;
  const networkButton = target.closest('[data-network-view]');
  if (networkButton) {
    event.preventDefault();
    void handleNetworkNavigation(networkButton.dataset.networkView || 'messages');
    return;
  }
  const tabButton = target.closest('[data-tab]');
  if (tabButton) {
    event.preventDefault();
    handleTabNavigation(tabButton.dataset.tab || 'chat');
    return;
  }
  const sessionButton = target.closest('[data-session]');
  if (sessionButton && !target.closest('[data-session-menu], [data-session-action]')) {
    event.preventDefault();
    employeeChatOpenRequestId += 1;
    void openSession(sessionButton.dataset.session || '');
  }
}

function handleTabNavigation(nextTab = 'chat') {
  const startedAt = performance.now();
  employeeChatOpenRequestId += 1;
  state.employeeContextMenu = null;
  if (nextTab === 'evolution' && !isCurrentUserAdmin()) {
    state.currentTab = 'settings';
    notify('自进化与任务治理需要管理员权限。', 'warning');
    render();
    return;
  }
  if (nextTab !== 'chat') {
    const messageHomeVisible = state.currentTab === 'chat'
      && state.networkPanelOpen
      && state.networkPanelView === 'messages'
      && state.networkMessageHomeOpen;
    state.primaryChatReturnContext = state.currentTab === 'chat'
      && !messageHomeVisible
      && Boolean(state.currentSessionId || currentChatRun())
      ? {
          kind: 'chat',
          networkPanelOpen: state.networkPanelOpen,
          networkPanelView: state.networkPanelView,
        }
      : null;
    state.networkPanelOpen = false;
  }
  if (nextTab === 'chat') {
    const returningSession = (state.sessions || []).find((session) => session.id === state.currentSessionId) || null;
    if (returningSession?.departmentId === 'private_assistant') state.privateAssistantResultUnread = false;
    state.networkPanelOpen = false;
    state.currentTab = nextTab;
    state.sidebarMode = 'root';
    if (!state.currentSessionId && !currentChatRun()) {
      const selectedProject = (state.projects || []).find((project) => (
        normalizePathKey(project.workspaceRoot || project.workspace_root) === normalizePathKey(state.workspaceRoot)
      ));
      if (selectedProject?.id) startNewProjectChat(selectedProject.id, { renderNow: false, focus: false });
      else startNewPlainChat({ renderNow: false, focus: false });
    }
  }
  state.currentTab = nextTab;
  state.modelMenuOpen = false;
  render();
  scheduleNavigationFirstPaintMetric(`tab:${nextTab}`, startedAt);
  if (nextTab === 'employees') void refreshEmployeeOverview();
}

async function handleNetworkNavigation(view = 'messages') {
  const startedAt = performance.now();
  employeeChatOpenRequestId += 1;
  const employeeRefresh = ['friends', 'messages'].includes(view)
    ? refreshEmployeeOverview({ refreshCloud: false })
    : null;
  const opening = openNetworkPanel(view);
  scheduleNavigationFirstPaintMetric(`network:${view}`, startedAt);
  await opening;
  if (!employeeRefresh) return;
  await employeeRefresh;
  if (view === 'messages' && state.currentTab === 'chat' && state.networkPanelView === 'messages') {
    if (state.networkMessageHomeOpen) render();
    else patchMessageAgentStatusRows((state.employeeOverview?.roster || []).map((employee) => employee.id));
  }
}

function scheduleNavigationFirstPaintMetric(surface = '', startedAt = performance.now()) {
  requestAnimationFrame(() => {
    const durationMs = performance.now() - startedAt;
    if (durationMs < 100) return;
    reportRendererEvent('warn', 'renderer-navigation-first-paint-slow', null, {
      surface,
      durationMs: Math.round(durationMs),
    });
  });
}

function installPersistentDocumentEvents() {
  if (persistentDocumentEventsInstalled) return;
  persistentDocumentEventsInstalled = true;
  document.addEventListener('click', handleAccountWorkspaceShortcutClick);
  document.addEventListener('click', closeModelMenuOnOutsideClick);
  document.addEventListener('click', closeSessionMenuOnOutsideClick);
  document.addEventListener('click', closeProjectMenuOnOutsideClick);
  document.addEventListener('click', closePluginMenuOnOutsideClick);
  document.addEventListener('click', closeAccountMenuOnOutsideClick);
  document.addEventListener('click', closeDesktopMenuOnOutsideClick);
  document.addEventListener('click', handleAccountMenuActionClick, true);
  document.addEventListener('click', closeNetworkFriendMenus);
  document.addEventListener('click', closeContactProfileOnOutsideClick);
  document.addEventListener('click', closeContactDirectoryContextMenu);
  document.addEventListener('click', closeComposerMentionPickerOnOutsideClick);
  document.addEventListener('click', closeTaskReferencePickerOnOutsideClick);
  document.addEventListener('click', closeUBuddyMessageModeMenuOnOutsideClick);
  document.addEventListener('click', closeUBuddyParticipantSelectionMenuOnOutsideClick);
  document.addEventListener('click', closeMessageDefaultOrderEditorOnOutsideClick);
  document.addEventListener('click', closeCollaborationMembersOnOutsideClick);
  document.addEventListener('click', closeOrganizationNameEditOnOutsideClick);
  document.addEventListener('keydown', handleGlobalEscapeShortcut, true);
  document.addEventListener('keydown', closeModelMenuOnEscape);
  document.addEventListener('keydown', closeSessionMenuOnEscape);
  document.addEventListener('keydown', closeProjectMenuOnEscape);
  document.addEventListener('keydown', closePluginMenuOnEscape);
  document.addEventListener('keydown', closeAccountMenuOnEscape);
  document.addEventListener('keydown', closeDesktopMenuOnEscape);
  document.addEventListener('keydown', closeNetworkFriendMenus);
  document.addEventListener('keydown', closeContactDirectoryContextMenu);
  document.addEventListener('keydown', closeMessageContextMenuOnEscape);
  document.addEventListener('keydown', closeComposerMentionPickerOnEscape);
  document.addEventListener('keydown', closeTaskReferencePickerOnEscape);
  document.addEventListener('keydown', handleContextualSearchShortcut);
  document.addEventListener('keydown', handleConversationZoomShortcut);
  document.addEventListener('keydown', handleDesktopShortcut);
  document.addEventListener('wheel', handleConversationZoomWheel, { passive: false, capture: true });
  document.addEventListener('pointerdown', closeLanguageMenuOnOutsidePointer, true);
  window.addEventListener('focus', refreshActiveSocialReceipts);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshActiveSocialReceipts();
  });
  socialReceiptRefreshTimer = socialReceiptRefreshTimer || window.setInterval(refreshActiveSocialReceipts, 1500);
}

function socialReceiptSignature(messages = []) {
  return JSON.stringify((Array.isArray(messages) ? messages : []).map((message) => [
    message?.id || '', message?.updatedAt || message?.updated_at || '', message?.status || '',
    message?.readAt || message?.read_at || '', message?.receiptSummary || null,
    (Array.isArray(message?.receiptDetails) ? message.receiptDetails : []).map((receipt) => [
      receipt?.userId || receipt?.user_id || '', Boolean(receipt?.read), receipt?.readAt || receipt?.read_at || '',
    ]),
  ]));
}

async function refreshActiveSocialReceipts() {
  if (socialReceiptRefreshBusy || !state.currentUser || document.visibilityState === 'hidden') return;
  if (state.currentTab !== 'chat' || !state.networkPanelOpen || state.networkMessageHomeOpen) return;
  const workspaceGeneration = state.workspaceSwitchGeneration;
  const groupId = String(state.chatGroupId || '').trim();
  const peerId = String(state.networkConversationPeerId || '').trim();
  if (!groupId && (!peerId || peerId === 'self-secretary' || state.networkConversationMode !== 'person')) return;
  socialReceiptRefreshBusy = true;
  try {
    if (groupId) {
      const previousSignature = socialReceiptSignature(state.chatGroupDetail?.messages);
      const detail = await window.janus.chatGroup({ groupId });
      if (workspaceGeneration !== state.workspaceSwitchGeneration || String(state.chatGroupId || '') !== groupId) return;
      const nextSignature = socialReceiptSignature(detail?.messages);
      state.chatGroupDetail = detail;
      state.chatGroupDetailCache = { ...(state.chatGroupDetailCache || {}), [groupId]: detail };
      if (previousSignature !== nextSignature) renderPreservingNetworkComposer();
      return;
    }
    const previousSignature = socialReceiptSignature(state.networkConversationMessages);
    const messages = await window.janus.socialConversation({ peerId, limit: 500 });
    if (workspaceGeneration !== state.workspaceSwitchGeneration
      || String(state.networkConversationPeerId || '') !== peerId
      || state.networkConversationMode !== 'person') return;
    const nextSignature = socialReceiptSignature(messages);
    state.networkConversationMessages = messages || [];
    if (previousSignature !== nextSignature) renderPreservingNetworkComposer();
  } catch {
    // Realtime/polling recovery remains available; receipt refresh is best-effort.
  } finally {
    socialReceiptRefreshBusy = false;
  }
}

function closeOrganizationNameEditOnOutsideClick(event) {
  if (!state.organizationNameEditId) return;
  if (event.target?.closest?.('.organization-name-edit-form, [data-organization-name-edit], [data-organization-name-dblclick]')) return;
  cancelOrganizationNameEdit();
}

function closeLanguageMenuOnOutsidePointer(event) {
  if (!state.languageMenuOpen || event.target?.closest?.('.global-language-switch')) return;
  state.languageMenuOpen = false;
  render();
}

function closeMessageDefaultOrderEditorOnOutsideClick(event) {
  if (!state.messageDefaultOrderEditorOpen) return;
  if (event.target?.closest?.('[data-message-default-order-editor], [data-message-default-order-toggle]')) return;
  state.messageDefaultOrderEditorOpen = false;
  render();
}

function closeCollaborationMembersOnOutsideClick(event) {
  if (!state.collaborationMembersOpen || event.target?.closest?.('.collaboration-members-menu')) return;
  state.collaborationMembersOpen = false;
  render();
}

const ESCAPE_DISMISS_CONTROL_SELECTORS = Object.freeze([
  '[data-ubuddy-center-close]',
  '#desktop-dialog-close',
  '[data-codex-review-close]',
  '#close-preview-btn',
  '[data-message-forward-close]',
  '#social-edit-close',
  '#memory-name-close',
  '#rename-session-close',
  '[data-leadership-dialog-close]',
  '[data-organization-action-close]',
  '[data-organization-invite-close]',
  '[data-chat-group-invite-close]',
  '[data-chat-group-create-close]',
  '[data-contact-add-close]',
  '[data-update-announcement-close]',
  '[data-close-chat-plan-viewer]',
  '[data-chat-avatar-profile-close]',
  '[data-message-reaction-close]',
  '[data-collaboration-add-member-cancel]',
  '[data-employee-market-candidate-close]',
  '[data-employee-market-back]',
  '[data-employee-market-close]',
  '[data-employee-detail-close]',
  '[data-plugin-detail-close]',
  '[data-group-profile-close]',
  '[data-contact-profile-close]',
  '#close-chat-search-btn',
]);

const ESCAPE_BACK_CONTROL_SELECTORS = Object.freeze([
  '[data-employee-history-back]',
  '[data-evolution-back]',
  '[data-network-conversation-back]',
  '[data-network-delegation-back]',
  '[data-message-home-back]',
  '#settings-back-btn',
]);

function firstVisibleEscapeControl(selectors = []) {
  for (const selector of selectors) {
    const controls = [...document.querySelectorAll(selector)];
    const control = controls.reverse().find((item) => elementIsVisible(item) && !item.disabled);
    if (control) return control;
  }
  return null;
}

function dismissTopmostEscapeLayer() {
  const control = firstVisibleEscapeControl(ESCAPE_DISMISS_CONTROL_SELECTORS);
  if (!control) return false;
  control.click();
  return true;
}

function closeTopmostEscapeMenu() {
  if (state.collaborationMembersOpen) {
    state.collaborationMembersOpen = false;
    render();
    requestAnimationFrame(() => document.querySelector('[data-collaboration-members-toggle]')?.focus?.({ preventScroll: true }));
    return true;
  }
  if (state.languageMenuOpen) {
    state.languageMenuOpen = false;
    render();
    return true;
  }
  const settingsSelect = [...document.querySelectorAll('.settings-select.open')].filter(elementIsVisible).at(-1);
  if (settingsSelect) {
    settingsSelect.querySelector('[data-settings-select-trigger]')?.click();
    return true;
  }
  if (document.querySelector('.desktop-menu.is-open')) {
    closeDesktopMenus();
    return true;
  }
  const friendMenu = [...document.querySelectorAll('.network-friend-menu[open]')].filter(elementIsVisible).at(-1);
  if (friendMenu) {
    friendMenu.removeAttribute('open');
    friendMenu.querySelector('summary')?.focus?.({ preventScroll: true });
    return true;
  }
  if (state.messageContextMenu || state.messageForwardDialog) {
    state.messageContextMenu = null;
    state.messageForwardDialog = null;
    render();
    return true;
  }
  for (const property of ['employeeContextMenu', 'contactDirectoryContextMenu', 'conversationContextMenu']) {
    if (!state[property]) continue;
    state[property] = null;
    render();
    return true;
  }
  if (state.taskReferenceMenuOpen) {
    taskReferenceOptionsRequestSequence += 1;
    state.taskReferenceMenuOpen = false;
    state.taskReferenceOptionsLoading = false;
    render();
    focusChatInputAtEnd();
    return true;
  }
  if (composerProjectMentionPickerOpen()) {
    closeComposerProjectMentionPicker({ focusInput: true });
    return true;
  }
  if (state.socialMentionMenuOpen) {
    state.socialMentionMenuOpen = false;
    render();
    return true;
  }
  const booleanMenus = [
    'messageDefaultOrderEditorOpen',
    'modelSubmenuOpen',
    'workspaceCreateMenuOpen',
    'accountMenuWorkspaceOpen',
    'accountWorkspaceMenuOpen',
    'organizationSettingsWorkspaceMoreOpen',
    'composerMemoryMenuOpen',
    'composerToolMenuOpen',
    'composerEmojiPickerOpen',
    'uBuddyMessageModeMenuOpen',
    'uBuddyParticipantSelectionMenuOpen',
    'composerMetaOverflowOpen',
    'pptTemplateMenuOpen',
    'pptStyleMenuOpen',
    'imageModelMenuOpen',
    'modelMenuOpen',
    'agentMenuOpen',
    'sandboxMenuOpen',
    'workspaceMenuOpen',
    'networkDelegationMemoryMenuOpen',
    'pluginMenuOpen',
  ];
  for (const property of booleanMenus) {
    if (!state[property]) continue;
    state[property] = false;
    if (property === 'organizationSettingsWorkspaceMoreOpen') state.organizationSettingsWorkspaceMorePosition = null;
    if (property === 'pluginMenuOpen') {
      state.pluginMenuOpenId = '';
      state.pluginMenuPosition = null;
    }
    render();
    return true;
  }
  if (state.sessionMenuOpenId) {
    state.sessionMenuOpenId = '';
    state.sessionMenuPosition = null;
    render();
    return true;
  }
  if (state.projectMenuOpenId) {
    state.projectMenuOpenId = '';
    state.projectMenuKind = '';
    state.projectMenuPosition = null;
    render();
    return true;
  }
  if (state.accountMenuOpen) {
    if (state.accountMenuWorkspaceMoreOpen) {
      state.accountMenuWorkspaceMoreOpen = false;
      render();
      return true;
    }
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    state.accountMenuWorkspaceMoreOpen = false;
    state.accountWorkspaceMenuOpen = false;
    render();
    requestAnimationFrame(() => document.getElementById('account-card')?.focus?.({ preventScroll: true }));
    return true;
  }
  return false;
}

function clearFocusedSearchOnEscape(activeElement) {
  const id = String(activeElement?.id || '');
  const searchStates = {
    'friend-search-query': 'friendSearchQuery',
    'settings-search-input': 'settingsSearchQuery',
    'plugin-search-input': 'pluginSearchQuery',
    'evolution-search-input': 'evolutionSearchQuery',
    'employee-market-search': 'employeeMarketQuery',
  };
  const property = searchStates[id] || '';
  if (property && String(state[property] || '')) {
    state[property] = '';
    render();
    requestAnimationFrame(() => document.getElementById(id)?.focus?.({ preventScroll: true }));
    return true;
  }
  if (id === 'network-conversation-search') {
    resetNetworkMessageSearch({ close: true });
    render();
    return true;
  }
  if (id === 'collaboration-search-input') {
    if (String(state.collaborationSearchQuery || '')) state.collaborationSearchQuery = '';
    else state.collaborationSearchOpen = false;
    state.collaborationSearchActiveIndex = 0;
    render();
    if (state.collaborationSearchOpen) requestAnimationFrame(() => document.getElementById(id)?.focus?.({ preventScroll: true }));
    return true;
  }
  const searchControl = activeElement?.matches?.('input[type="search"], [role="searchbox"], input[id*="search"], input[placeholder*="搜索"]');
  if (!searchControl) return false;
  activeElement.blur();
  return true;
}

function returnFromCurrentEscapeSurface() {
  if (state.collaborationSourcesOpen) {
    state.collaborationSourcesOpen = false;
    render();
    return true;
  }
  if (state.messageGroupSidebarOpen) {
    state.messageGroupSidebarOpen = false;
    render();
    return true;
  }
  const backControl = firstVisibleEscapeControl(ESCAPE_BACK_CONTROL_SELECTORS);
  if (backControl) {
    backControl.click();
    return true;
  }
  if (state.currentTab === 'chat' && state.networkPanelOpen && state.networkPanelView === 'friends'
    && state.contactsActivePane !== 'directory') {
    state.contactsActivePane = 'directory';
    render();
    return true;
  }
  if (state.currentTab === 'chat' && (
    (state.networkPanelOpen && state.networkPanelView === 'messages' && !state.networkMessageHomeOpen)
    || state.collaborationGroupId
  )) {
    state.chatGroupId = '';
    state.chatGroupDetail = null;
    state.collaborationGroupId = '';
    state.collaborationGroupDetail = null;
    state.networkMessageHomeOpen = true;
    state.messageActivePane = 'list';
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    state.collaborationGroupWorkspace = null;
    state.collaborationSearchOpen = false;
    state.collaborationSearchQuery = '';
    state.collaborationMembersOpen = false;
    render();
    return true;
  }
  return false;
}

function openAccountMenuFromEscape() {
  if (!state.currentUser || state.currentTab === 'settings') return false;
  state.accountMenuOpen = true;
  state.accountMenuWorkspaceOpen = false;
  state.accountMenuWorkspaceMoreOpen = false;
  state.accountWorkspaceMenuOpen = false;
  render();
  return true;
}

function isPlainEscapeShortcut(event) {
  return event?.key === 'Escape'
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !event.shiftKey;
}

function handleGlobalEscapeShortcut(event) {
  if (!isPlainEscapeShortcut(event) || event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.target?.dataset?.imeComposing === 'true') return;
  let handled = dismissTopmostEscapeLayer() || closeTopmostEscapeMenu();
  const visibleModal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(elementIsVisible);
  if (!handled && visibleModal) return;
  const activeElement = document.activeElement;
  if (!handled) handled = clearFocusedSearchOnEscape(activeElement);
  if (!handled && activeElement?.closest?.('details[open]')) {
    activeElement.closest('details[open]').open = false;
    handled = true;
  }
  if (!handled && activeElement?.matches?.('input, textarea, [contenteditable="true"]')) {
    activeElement.blur();
    handled = true;
  }
  if (!handled) handled = returnFromCurrentEscapeSurface();
  if (!handled) handled = openAccountMenuFromEscape();
  if (!handled) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function elementIsVisible(element) {
  return Boolean(element && !element.disabled && !element.closest('[hidden]') && element.getClientRects().length);
}

function focusSearchControl(input) {
  if (!elementIsVisible(input)) return false;
  input.focus({ preventScroll: true });
  input.select?.();
  return true;
}

function visibleTransientSearchControl() {
  const selectors = [
    '#chat-search-modal-input',
    '#friend-add-search-query',
    '#ppt-template-search',
    '[data-workspace-project-search]',
    '[data-project-reference-query]',
  ];
  return selectors.map((selector) => document.querySelector(selector)).find(elementIsVisible) || null;
}

function currentViewSearchControl() {
  if (state.currentTab === 'settings') return document.getElementById('settings-search-input');
  if (state.currentTab === 'plugins') return document.getElementById('plugin-search-input');
  if (state.currentTab === 'evolution') return document.getElementById('evolution-search-input');
  if (state.currentTab === 'employees') return document.getElementById('employee-market-search');
  if (state.currentTab === 'chat' && state.networkPanelOpen && state.networkPanelView === 'friends') {
    return document.getElementById('friend-search-query');
  }
  return null;
}

function handleContextualSearchShortcut(event) {
  const searchShortcut = String(event.key || '').toLocaleLowerCase() === 'f'
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
    && !event.shiftKey;
  if (!searchShortcut || event.defaultPrevented) return;

  const transientSearch = visibleTransientSearchControl();
  if (focusSearchControl(transientSearch)) {
    event.preventDefault();
    return;
  }

  const visibleModal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(elementIsVisible);
  if (visibleModal) return;

  const currentSearch = currentViewSearchControl();
  if (focusSearchControl(currentSearch)) {
    event.preventDefault();
    return;
  }

  if (state.currentTab === 'chat') {
    event.preventDefault();
    openChatSearch();
  }
}

function visibleConversationMessageList(target = null) {
  const targetList = target?.closest?.('#message-list') || null;
  const list = targetList || document.getElementById('message-list');
  if (!elementIsVisible(list) || !list.closest('.chat-view.with-messages')) return null;
  const visibleModal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(elementIsVisible);
  return visibleModal ? null : list;
}

function applyConversationZoomToVisibleList(list = document.getElementById('message-list')) {
  if (!list) return false;
  const percent = CONVERSATION_ZOOM_LEVELS.includes(Number(state.conversationZoomPercent))
    ? Number(state.conversationZoomPercent)
    : 100;
  state.conversationZoomPercent = percent;
  const scale = percent / 100;
  list.style.setProperty('--conversation-zoom-scale', String(scale));
  list.style.setProperty('--conversation-font-size', `${(14 * scale).toFixed(2)}px`);
  list.style.setProperty('--conversation-heading-font-size', `${(15 * scale).toFixed(2)}px`);
  list.style.setProperty('--conversation-meta-font-size', `${(12 * scale).toFixed(2)}px`);
  list.style.setProperty('--conversation-small-font-size', `${(10.5 * scale).toFixed(2)}px`);
  list.style.setProperty('--conversation-code-font-size', `${(12 * scale).toFixed(2)}px`);
  list.dataset.conversationZoom = String(percent);
  list.classList.toggle('is-large-conversation-zoom', percent >= 140);
  return true;
}

function showConversationZoomIndicator(list, percent) {
  const panel = list?.closest('.conversation-panel');
  if (!panel) return;
  let indicator = panel.querySelector('[data-conversation-zoom-indicator]');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'conversation-zoom-indicator';
    indicator.dataset.conversationZoomIndicator = '';
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    panel.appendChild(indicator);
  }
  indicator.textContent = translateUiText(`对话缩放 ${percent}%${percent === 100 ? '' : ' · Ctrl/⌘+0 重置'}`, state.languageMode);
  indicator.classList.add('is-visible');
  if (conversationZoomIndicatorTimer) clearTimeout(conversationZoomIndicatorTimer);
  conversationZoomIndicatorTimer = setTimeout(() => {
    indicator.classList.remove('is-visible');
    conversationZoomIndicatorTimer = null;
  }, 1200);
}

function setConversationZoomPercent(percent, { list = null } = {}) {
  const targetList = visibleConversationMessageList(list);
  if (!targetList) return false;
  const nextPercent = CONVERSATION_ZOOM_LEVELS.includes(Number(percent)) ? Number(percent) : 100;
  const distanceFromBottom = Math.max(0, targetList.scrollHeight - targetList.clientHeight - targetList.scrollTop);
  const snapshot = captureMessageScrollState({
    allowFollow: distanceFromBottom <= MESSAGE_SCROLL_BOTTOM_TOLERANCE,
  });
  messageScrollFollow = Boolean(snapshot?.follow);
  state.conversationZoomPercent = nextPercent;
  saveConversationZoomPercent(nextPercent);
  applyConversationZoomToVisibleList(targetList);
  showConversationZoomIndicator(targetList, nextPercent);
  messageScrollFollowEvaluation += 1;
  // Force reflow before restoring the anchor so background-window animation
  // throttling cannot delay or reorder consecutive zoom operations.
  void targetList.offsetHeight;
  restoreMessageScrollState(snapshot);
  return true;
}

function changeConversationZoom(direction, list = null) {
  const current = CONVERSATION_ZOOM_LEVELS.includes(Number(state.conversationZoomPercent))
    ? Number(state.conversationZoomPercent)
    : 100;
  const currentIndex = Math.max(0, CONVERSATION_ZOOM_LEVELS.indexOf(current));
  const nextIndex = Math.min(
    CONVERSATION_ZOOM_LEVELS.length - 1,
    Math.max(0, currentIndex + Math.sign(Number(direction) || 0)),
  );
  return setConversationZoomPercent(CONVERSATION_ZOOM_LEVELS[nextIndex], { list });
}

function handleConversationZoomShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) return;
  const list = visibleConversationMessageList();
  if (!list) return;
  const key = String(event.key || '');
  const code = String(event.code || '');
  const increase = key === '+' || key === '=' || code === 'NumpadAdd';
  const decrease = key === '-' || code === 'NumpadSubtract';
  const reset = key === '0' || code === 'Numpad0';
  if (!increase && !decrease && !reset) return;
  event.preventDefault();
  if (reset) setConversationZoomPercent(100, { list });
  else changeConversationZoom(increase ? 1 : -1, list);
}

function handleConversationZoomWheel(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || !Number(event.deltaY)) return;
  if (!visibleConversationMessageList(event.target)) return;
  // Trackpad pinch gestures are exposed by Chromium as Ctrl/Meta + wheel on
  // Windows and macOS. Consume them so an accidental diagonal gesture never
  // changes either the conversation font size or the browser page zoom.
  event.preventDefault();
  event.stopPropagation();
}

function normalizedPlanStepsForAction(plan = {}) {
  const source = Array.isArray(plan.steps) ? plan.steps : Array.isArray(plan.plan) ? plan.plan : [];
  return source.map((item, index) => ({
    label: String(item?.label || item?.step || `\u6b65\u9aa4 ${index + 1}`).trim(),
    status: String(item?.status || 'pending'),
  })).filter((item) => item.label);
}

function chatPlanMarkdown(plan = {}, title = '\u5b9e\u65bd\u8ba1\u5212') {
  const steps = normalizedPlanStepsForAction(plan);
  const explanation = String(plan.explanation || plan.rationale || '').trim();
  return [`# ${title}`, explanation ? `\n${explanation}` : '', '', ...steps.map((item) => {
    const completed = ['completed', 'complete', 'done'].includes(item.status);
    return `- [${completed ? 'x' : ' '}] ${item.label}`;
  })].join('\n').trim();
}

async function downloadChatPlan(messageId = '') {
  let message = state.messages.find((item) => item.id === messageId);
  const plan = message?.metadata?.plan || null;
  if (!plan) return notify('\u6ca1\u6709\u53ef\u4e0b\u8f7d\u7684\u8ba1\u5212\u3002', 'warning');
  if (!window.janus?.saveTextFile) return notify('\u5f53\u524d\u5ba2\u6237\u7aef\u4e0d\u652f\u6301\u4e0b\u8f7d\u6587\u672c\u8ba1\u5212\u3002', 'warning');
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  const title = `${session?.title || 'Janus'}-\u5b9e\u65bd\u8ba1\u5212`;
  try {
    const result = await window.janus.saveTextFile({
      title: '\u4fdd\u5b58\u5b9e\u65bd\u8ba1\u5212',
      name: `${title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}.md`,
      content: chatPlanMarkdown(plan, title),
    });
    if (!result?.canceled) notify(`\u8ba1\u5212\u5df2\u4fdd\u5b58\uff1a${result.path}`, 'success');
  } catch (error) {
    notify(`\u4fdd\u5b58\u8ba1\u5212\u5931\u8d25\uff1a${error.message || error}`, 'error');
  }
}

async function openChatPlanViewer(messageId = '', mode = 'standalone') {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message?.metadata?.plan) return notify('\u6ca1\u6709\u53ef\u67e5\u770b\u7684\u8ba1\u5212\u3002', 'warning');
  state.chatPlanViewer = {
    messageId,
    mode: mode === 'sidebar' ? 'sidebar' : 'standalone',
  };
  render();
}

function closeChatPlanViewer() {
  if (!state.chatPlanViewer) return;
  state.chatPlanViewer = null;
  render();
}

async function implementChatPlan(messageId = '', { clearContext = false } = {}) {
  if (state.busy || currentChatRun()) return notify('\u5f53\u524d\u5bf9\u8bdd\u4ecd\u5728\u8fd0\u884c\uff0c\u8bf7\u7b49\u5f85\u7ed3\u675f\u540e\u518d\u5b9e\u65bd\u8ba1\u5212\u3002', 'warning');
  const message = state.messages.find((item) => item.id === messageId);
  const plan = message?.metadata?.plan || null;
  const steps = normalizedPlanStepsForAction(plan || {});
  const fullPlan = String(plan?.content || message?.content || '').trim();
  if (!plan || (!steps.length && !fullPlan)) return notify('\u8fd9\u4efd\u8ba1\u5212\u6ca1\u6709\u53ef\u5b9e\u65bd\u7684\u5185\u5bb9\u3002', 'warning');
  state.chatPlanViewer = null;
  if (clearContext) {
    const sessionId = state.currentSessionId;
    if (!sessionId) return notify('\u8bf7\u5148\u6253\u5f00\u8be5\u8ba1\u5212\u6240\u5c5e\u7684\u4f1a\u8bdd\u3002', 'warning');
    notify('\u6b63\u5728\u6e05\u7406\u5f53\u524d Janus \u4e0a\u4e0b\u6587\uff0c\u5b8c\u6210\u540e\u5c06\u7acb\u5373\u5b9e\u65bd\u8ba1\u5212\u3002', 'info');
    try {
      state.contextUsage = await resetChatContextWithRefresh({
        api: window.janus,
        sessionId,
        currentUsage: state.contextUsage,
        commandId: globalThis.crypto?.randomUUID?.() || `plan_context_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      });
      state.sessions = await window.janus.listSessions();
    } catch (error) {
      return notify(userVisibleErrorMessage(error, '\u6e05\u7406\u4e0a\u4e0b\u6587\u5931\u8d25\uff0c\u672a\u5f00\u59cb\u5b9e\u65bd\u8ba1\u5212\u3002'), 'error');
    }
  }
  if (state.interactionMode) await setComposerInteractionMode('');
  if (state.interactionMode) return;
  const explanation = String(plan.explanation || plan.rationale || '').trim();
  state.chatDraft = [
    '\u8bf7\u6309\u7167\u4e0b\u9762\u5df2\u7ecf\u786e\u8ba4\u7684\u8ba1\u5212\u5f00\u59cb\u5b9e\u65bd\u3002\u73b0\u5728\u53ef\u4ee5\u4fee\u6539\u4ee3\u7801\u548c\u6267\u884c\u5fc5\u8981\u9a8c\u8bc1\uff1b\u5b8c\u6210\u540e\u6c47\u62a5\u7ed3\u679c\u3002',
    '\u8bf7\u4fdd\u7559\u4e0b\u5217\u72b6\u6001\u8bed\u4e49\uff1a\u5df2\u5b8c\u6210\u6b65\u9aa4\u53ea\u6821\u9a8c\u5f53\u524d\u7ed3\u679c\uff0c\u4e0d\u8981\u91cd\u590d\u6267\u884c\u4f1a\u4ea7\u751f\u526f\u4f5c\u7528\u7684\u64cd\u4f5c\uff1b\u4ece\u8fdb\u884c\u4e2d\u548c\u5f85\u5904\u7406\u6b65\u9aa4\u7ee7\u7eed\u3002',
    explanation ? `\u8ba1\u5212\u8bf4\u660e\uff1a${explanation}` : '',
    fullPlan ? `\u5b8c\u6574\u8ba1\u5212\uff1a\n${fullPlan}` : '',
    ...steps.map((item, index) => {
      const status = ['completed', 'complete', 'done'].includes(item.status)
        ? '\u5df2\u5b8c\u6210'
        : ['inProgress', 'in_progress', 'active', 'running'].includes(item.status) ? '\u8fdb\u884c\u4e2d' : '\u5f85\u5904\u7406';
      return `${index + 1}. ${item.label}\uff08\u72b6\u6001\uff1a${status}\uff09`;
    }),
  ].filter(Boolean).join('\n');
  render();
  setTimeout(() => {
    focusChatInputAtEnd();
    document.querySelector('#chat-form')?.requestSubmit();
  }, 0);
}

async function modifyChatPlan(messageId = '') {
  if (state.busy || currentChatRun()) return notify('\u5f53\u524d\u5bf9\u8bdd\u4ecd\u5728\u8fd0\u884c\uff0c\u8bf7\u7b49\u5f85\u7ed3\u675f\u540e\u518d\u4fee\u6539\u8ba1\u5212\u3002', 'warning');
  const message = state.messages.find((item) => item.id === messageId);
  if (!message?.metadata?.plan) return notify('\u6ca1\u6709\u53ef\u4fee\u6539\u7684\u8ba1\u5212\u3002', 'warning');
  state.chatPlanViewer = null;
  if (state.interactionMode !== 'plan') await setComposerInteractionMode('plan');
  if (state.interactionMode !== 'plan') return;
  state.chatPlanExecutionPrompt = {
    sessionId: state.currentSessionId,
    messageId,
    plan: message.metadata.plan,
    mode: 'revision_input',
    revisionDraft: '',
    revisionError: '',
    revisionSubmitting: false,
  };
  render();
  setTimeout(() => document.querySelector('[data-chat-plan-revision-input]')?.focus(), 0);
}

async function deferChatPlan(messageId = '') {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message?.metadata?.plan) return notify('\u6ca1\u6709\u53ef\u6682\u5b58\u7684\u8ba1\u5212\u3002', 'warning');
  state.chatPlanViewer = null;
  if (state.interactionMode === 'plan') await setComposerInteractionMode('');
  notify('\u8ba1\u5212\u5df2\u4fdd\u7559\u5728\u5bf9\u8bdd\u4e2d\uff0c\u53ef\u4ee5\u7a0d\u540e\u518d\u5b9e\u65bd\u6216\u4fee\u6539\u3002', 'success');
  render();
}

async function resolveChatPlanExecutionChoice(action = '', messageId = '') {
  const prompt = state.chatPlanExecutionPrompt || null;
  if (!prompt || String(prompt.messageId || '') !== String(messageId || '')) return;
  if (action === 'revise') {
    state.chatPlanExecutionPrompt = {
      ...prompt,
      mode: 'revision_input',
      revisionDraft: String(prompt.revisionDraft || ''),
      revisionError: '',
      revisionSubmitting: false,
    };
    render();
    setTimeout(() => document.querySelector('[data-chat-plan-revision-input]')?.focus(), 0);
    return;
  }
  state.chatPlanExecutionPrompt = null;
  if (action === 'execute') {
    await implementChatPlan(messageId);
    return;
  }
  if (state.interactionMode === 'plan') await setComposerInteractionMode('');
  render();
}

async function submitChatPlanRevision(messageId = '') {
  const prompt = state.chatPlanExecutionPrompt || null;
  if (!prompt || String(prompt.messageId || '') !== String(messageId || '') || prompt.revisionSubmitting) return;
  const input = document.querySelector('[data-chat-plan-revision-input]');
  const revision = String(input?.value || prompt.revisionDraft || '').trim();
  const english = state.languageMode === 'en';
  if (!revision) {
    state.chatPlanExecutionPrompt = { ...prompt, revisionError: english ? 'Tell Janus what should be different before submitting.' : '请先告诉 Janus 哪些地方需要不同。' };
    render();
    setTimeout(() => document.querySelector('[data-chat-plan-revision-input]')?.focus(), 0);
    return;
  }
  const message = state.messages.find((item) => String(item?.id || '') === String(messageId || ''));
  const plan = message?.metadata?.plan || prompt.plan || {};
  const fullPlan = String(plan.content || message?.content || '').trim();
  const request = [
    english ? 'Revise the previous plan according to the feedback below. Do not execute anything yet.' : '请根据下面的意见修订上一版计划，暂时不要执行任何操作。',
    '',
    english ? 'Previous plan:' : '上一版计划：',
    fullPlan,
    '',
    english ? 'Requested changes:' : '希望修改的内容：',
    revision,
  ].filter(Boolean).join('\n');
  state.chatPlanExecutionPrompt = { ...prompt, revisionDraft: revision, revisionSubmitting: true, revisionError: '' };
  render();
  const sent = await sendChatMessage(request, { preserveComposer: true });
  if (!sent) {
    state.chatPlanExecutionPrompt = { ...prompt, mode: 'revision_input', revisionDraft: revision, revisionSubmitting: false, revisionError: english ? 'The revision could not be submitted. Please try again.' : '修订意见提交失败，请重试。' };
    render();
  }
}

function wireEvents() {
  followerController.wire(document);
  wireUserAvatarFallbacks(document);
  installPersistentDocumentEvents();
  wireUBuddyTaskDisplayEvents(document);
  wireUBuddyCenterEvents(document);
  wireMessageContextMenus();
  wireAnchoredMessageDisclosures();
  document.querySelectorAll('[data-long-message-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const messageId = String(button.dataset.longMessageToggle || '').trim();
      if (!messageId) return;
      state.uBuddyExpandedMessageIds = {
        ...(state.uBuddyExpandedMessageIds || {}),
        [messageId]: button.getAttribute('aria-expanded') !== 'true',
      };
      render();
    });
  });
  wireNoticeHoverPause();
  document.querySelectorAll('[data-message-quote-clear]').forEach((button) => button.addEventListener('click', () => {
    state.messageQuote = null;
    render();
    focusChatInputAtEnd();
  }));
  document.querySelectorAll('[data-message-history-load]').forEach((button) => button.addEventListener('click', () => {
    void loadOlderMessages();
  }));
  wirePrimaryNavigationKeyboard();
  wireAccessibleEmployeeDialogs();
  document.querySelectorAll('[data-desktop-menu-trigger]').forEach((btn) => {
    btn.addEventListener('click', toggleDesktopMenu);
  });
  document.querySelectorAll('.desktop-menu').forEach((menu) => {
    menu.addEventListener('mouseenter', switchDesktopMenuOnHover);
  });
  document.querySelectorAll('[data-desktop-menu-action]').forEach((btn) => {
    btn.addEventListener('click', handleDesktopMenuActionClick);
  });
  document.querySelector('#window-minimize-btn')?.addEventListener('click', () => window.janus.minimizeWindow());
  document.querySelector('#window-maximize-btn')?.addEventListener('click', () => window.janus.toggleMaximizeWindow());
  document.querySelector('#window-close-btn')?.addEventListener('click', () => window.janus.closeWindow());
  document.querySelector('#desktop-dialog-close')?.addEventListener('click', closeDesktopDialog);
  document.querySelector('.desktop-dialog-dismiss')?.addEventListener('click', closeDesktopDialog);
  document.querySelector('#desktop-dialog-overlay')?.addEventListener('click', (event) => {
    if (event.target?.id === 'desktop-dialog-overlay') closeDesktopDialog();
  });
  document.querySelector('#collapse-sidebar-btn')?.addEventListener('click', () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    render();
  });
  document.querySelectorAll('[data-message-groups-toggle]').forEach((button) => button.addEventListener('click', () => {
    state.messageGroupSidebarOpen = !state.messageGroupSidebarOpen;
    if (state.messageGroupSidebarOpen) state.sidebarCollapsed = false;
    render();
  }));
  document.querySelectorAll('[data-message-filter]').forEach((button) => button.addEventListener('click', () => {
    state.networkMessageListFilter = button.dataset.messageFilter || 'all';
    render();
  }));
  document.querySelectorAll('[data-conversation-row-key]').forEach((row) => row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const key = String(row.dataset.conversationRowKey || '').trim();
    if (!key) return;
    state.conversationContextMenu = {
      key,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 210)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 150)),
    };
    render();
  }));
  document.querySelector('[data-conversation-context-dismiss]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    state.conversationContextMenu = null;
    render();
  });
  document.querySelectorAll('[data-conversation-group-action]').forEach((button) => button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const key = String(button.closest('[data-conversation-context-key]')?.dataset.conversationContextKey || '').trim();
    const action = button.dataset.conversationGroupAction || '';
    if (!key) return;
    if (action === 'archive') {
      await toggleConversationArchive(key);
      return;
    }
    if (action === 'complete') {
      setConversationCompleted(key, !new Set(state.completedConversationKeys || []).has(key));
    } else if (action === 'mark' || action === 'unread') {
      const field = action === 'mark' ? 'markedConversationKeys' : 'unreadConversationKeys';
      const values = new Set(state[field] || []);
      if (values.has(key)) values.delete(key);
      else values.add(key);
      state[field] = [...values];
      saveConversationGroups(rendererWorkspaceStorageScope(), {
        marked: state.markedConversationKeys,
        unread: state.unreadConversationKeys,
      });
    }
    state.conversationContextMenu = null;
    render();
  }));
  document.querySelectorAll('[data-conversation-complete]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const key = String(button.dataset.conversationComplete || '').trim();
    if (!key) return;
    setConversationCompleted(key, !new Set(state.completedConversationKeys || []).has(key));
    render();
  }));
  document.querySelectorAll('[data-conversation-archive]').forEach((button) => button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await toggleConversationArchive(button.dataset.conversationArchive || '');
  }));
  const messagePaneResizer = document.querySelector('[data-message-pane-resizer]');
  if (messagePaneResizer) {
    const applyMessagePanelWidth = (value) => {
      const width = Math.min(520, Math.max(280, Math.round(Number(value) || 360)));
      state.messagePanelWidth = width;
      document.querySelector('.shell.message-layout')?.style.setProperty('--network-panel-width', `${width}px`);
      messagePaneResizer.setAttribute('aria-valuenow', String(width));
      return width;
    };
    messagePaneResizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const shell = messagePaneResizer.closest('.shell.message-layout');
      if (!shell) return;
      const startX = event.clientX;
      const startWidth = Math.min(520, Math.max(280, Number(state.messagePanelWidth) || 360));
      const shellRect = shell.getBoundingClientRect();
      const resizerRect = messagePaneResizer.getBoundingClientRect();
      const precedingWidth = resizerRect.left - shellRect.left - startWidth;
      const maxWidth = Math.min(520, Math.max(280, shellRect.width - precedingWidth - 360));
      document.body.classList.add('is-resizing-message-pane');
      const move = (moveEvent) => applyMessagePanelWidth(Math.min(maxWidth, startWidth + moveEvent.clientX - startX));
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        document.body.classList.remove('is-resizing-message-pane');
        saveMessagePanelWidth(state.messagePanelWidth);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    });
    messagePaneResizer.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 280 : event.key === 'End' ? 520 : Number(state.messagePanelWidth || 360) + (event.key === 'ArrowLeft' ? -16 : 16);
      saveMessagePanelWidth(applyMessagePanelWidth(next));
    });
  }
  const contactsPaneResizer = document.querySelector('[data-contacts-pane-resizer]');
  if (contactsPaneResizer) {
    const applyContactsRatio = (value) => {
      const columns = contactsPaneResizer.closest('.contacts-workspace-columns');
      if (!columns) return Number(state.contactsListRatio || .38);
      const rect = columns.getBoundingClientRect();
      const available = Math.max(1, rect.width - contactsPaneResizer.getBoundingClientRect().width);
      const readableContactsListWidth = 180;
      const minRatio = Math.max(.18, Math.min(.72, readableContactsListWidth / available));
      const maxRatio = Math.min(.72, Math.max(minRatio, (available - 230) / available));
      const ratio = Math.min(maxRatio, Math.max(minRatio, Number(value) || .38));
      state.contactsListRatio = ratio;
      columns.style.setProperty('--contacts-list-percent', `${ratio * 100}%`);
      columns.closest('.contacts-workspace')?.style.setProperty('--contacts-list-percent', `${ratio * 100}%`);
      contactsPaneResizer.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      return ratio;
    };
    contactsPaneResizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const columns = contactsPaneResizer.closest('.contacts-workspace-columns');
      if (!columns) return;
      const rect = columns.getBoundingClientRect();
      document.body.classList.add('is-resizing-contacts-pane');
      const move = (moveEvent) => applyContactsRatio((moveEvent.clientX - rect.left) / Math.max(1, rect.width));
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        document.body.classList.remove('is-resizing-contacts-pane');
        saveContactsListRatio(state.contactsListRatio);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    });
    contactsPaneResizer.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? .18 : event.key === 'End' ? .72 : Number(state.contactsListRatio || .38) + (event.key === 'ArrowLeft' ? -.03 : .03);
      saveContactsListRatio(applyContactsRatio(next));
    });
  }
  document.querySelector('[data-message-group-settings]')?.addEventListener('click', () => {
    state.messageGroupSidebarOpen = false;
    state.currentTab = 'settings';
    state.currentSettingsSection = 'account';
    state.networkPanelOpen = false;
    render();
  });
  document.querySelector('#settings-back-btn')?.addEventListener('click', () => {
    state.currentTab = 'chat';
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    state.accountMenuWorkspaceMoreOpen = false;
    render();
  });
  document.querySelectorAll('[data-settings-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.settingsSection;
      pendingSettingsScrollTop = null;
      openSettingsSection(section);
      if (section === 'skills') void loadPluginCatalog({ forceRender: true });
    });
  });
  document.querySelectorAll('[data-settings-search-result]').forEach((button) => {
    button.addEventListener('click', () => {
      const section = String(button.dataset.settingsSearchSection || 'account').trim() || 'account';
      const anchorSelector = String(button.dataset.settingsSearchAnchor || '').trim();
      state.settingsSearchQuery = '';
      openSettingsSection(section);
      const reveal = (attempt = 0) => {
        const target = anchorSelector ? document.querySelector(anchorSelector) : null;
        const region = document.querySelector('.settings-section-view');
        if (!target || !region) {
          if (attempt < 10) setTimeout(() => reveal(attempt + 1), 100);
          return;
        }
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const top = Math.max(0, region.scrollTop + target.getBoundingClientRect().top - region.getBoundingClientRect().top - 16);
        region.dataset.settingsSearchJump = 'true';
        const accountSection = String(target.dataset.accountSection || '').trim();
        if (accountSection) setActiveAccountSection(accountSection);
        pendingSettingsScrollTop = top;
        region.scrollTop = top;
        target.classList.add('settings-search-target-highlight');
        window.setTimeout(() => {
          if (region.dataset.settingsSearchJump === 'true') delete region.dataset.settingsSearchJump;
        }, 160);
        window.setTimeout(() => target.classList.remove('settings-search-target-highlight'), reducedMotion ? 900 : 1550);
      };
      requestAnimationFrame(() => reveal());
    });
  });
  document.querySelectorAll('[data-desktop-close-behavior]').forEach((button) => {
    button.addEventListener('click', () => setDesktopCloseBehavior(button.dataset.desktopCloseBehavior));
  });
  wireAccountSectionNavigator();
  document.querySelector('[data-logging-open-directory]')?.addEventListener('click', openApplicationLogDirectory);
  document.querySelector('[data-logging-export]')?.addEventListener('click', exportApplicationDiagnosticLog);
  document.querySelector('[data-logging-clear]')?.addEventListener('click', clearApplicationDiagnosticLogs);
  document.querySelector('[data-feishu-config-form]')?.addEventListener('submit', saveFeishuConfig);
  document.querySelector('[data-feishu-test]')?.addEventListener('click', testFeishuConfig);
  document.querySelector('[data-feishu-regenerate]')?.addEventListener('click', regenerateFeishuBindingCode);
  document.querySelector('[data-feishu-unbind]')?.addEventListener('click', unbindFeishu);
  document.querySelector('[data-mobile-gateway-show]')?.addEventListener('click', async () => {
    try {
      const status = await window.janus.mobileGatewayStatus();
      const addresses = Array.isArray(status.addresses) ? status.addresses.join('\n') : '';
      window.alert(status.listening
        ? `请在手机浏览器打开：\n${addresses}\n\n配对码：${status.pairingCode}\n配对码 5 分钟内有效。`
        : '手机连接服务尚未启动。');
    } catch (error) { notify(userVisibleErrorMessage(error, '无法读取手机连接状态。'), 'error'); }
  });
  document.querySelector('[data-ubuddy-profile-refresh]')?.addEventListener('click', () => refreshUBuddyCapabilityProfilePreview({ force: true }));
  document.querySelector('[data-ubuddy-profile-history-regenerate]')?.addEventListener('click', regenerateUBuddyCapabilityProfile);
  document.querySelectorAll('[data-ubuddy-profile-review]').forEach((button) => button.addEventListener('click', () => reviewUBuddyCapabilityProfile(button)));
  document.querySelector('[data-ubuddy-profile-publication-disable]')?.addEventListener('click', disableUBuddyCapabilityProfilePublication);
  document.querySelector('[data-organization-research-enable]')?.addEventListener('click', enableActiveOrganizationResearch);
  document.querySelectorAll('[data-organization-research-result]').forEach((button) => button.addEventListener('click', () => loadOrganizationResearchResult(button)));
  document.querySelectorAll('[data-organization-research-source]').forEach((button) => button.addEventListener('click', () => openOrganizationResearchSource(button)));
  document.querySelector('#settings-search-input')?.addEventListener('input', (event) => {
    state.settingsSearchQuery = event.target.value || '';
    render();
    setTimeout(() => {
      const input = document.getElementById('settings-search-input');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  });
  document.querySelectorAll('[data-theme-choice]').forEach((btn) => {
    btn.addEventListener('click', () => setThemeMode(btn.dataset.themeChoice));
  });
  document.querySelectorAll('.settings-language-panel [data-language-choice]').forEach((btn) => {
    btn.addEventListener('click', () => setLanguageMode(btn.dataset.languageChoice || 'en'));
  });
  document.querySelector('#startup-workspace-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const workspaceId = String(document.querySelector('#startup-workspace-select')?.value || '').trim();
    await setStartupOrganizationWorkspace(workspaceId);
  });
  document.querySelectorAll('[data-agent-setting]').forEach((input) => {
    input.addEventListener('change', async () => {
      const field = input.dataset.agentSetting || '';
      const payload = {
        agentInstanceId: input.dataset.agentInstanceId || '',
        memoryDocumentId: input.dataset.memoryDocumentId || '',
        [field]: Boolean(input.checked),
      };
      input.disabled = true;
      try {
        const result = await window.janus.updateUserAgentSettings(payload);
        state.userAgentSettings = result.settings || state.userAgentSettings;
        notify('Agent 授权设置已更新。', 'success');
      } catch (error) {
        notify(userVisibleErrorMessage(error, '无法更新 Agent 授权设置。'), 'error');
      } finally {
        render();
      }
    });
  });
  document.querySelector('[data-evolution-updates-check]')?.addEventListener('click', () => {
    checkPersonalEvolutionUpdates();
  });
  document.querySelector('[data-upload-compliance-refresh]')?.addEventListener('click', () => {
    refreshUploadCompliance();
  });
  document.querySelectorAll('[data-upload-compliance-action]').forEach((button) => {
    button.addEventListener('click', () => updateUploadComplianceAccount(button));
  });
  document.querySelectorAll('[data-personal-version-expand]').forEach((button) => {
    button.addEventListener('click', () => togglePersonalVersionHistory(button.dataset.personalVersionExpand || ''));
  });
  document.querySelectorAll('[data-personal-version-activate]').forEach((button) => {
    button.addEventListener('click', () => activatePersonalVersion(button));
  });
  document.querySelectorAll('[data-personal-version-rollback]').forEach((button) => {
    button.addEventListener('click', () => rollbackPersonalVersion(button));
  });
  document.querySelectorAll('[data-personal-evolution-detail]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.employeeSelectedInstanceId = button.dataset.personalEvolutionDetail || state.employeeSelectedInstanceId || '';
      state.currentTab = 'personal-evolution';
      await refreshPersonalEvolutionState();
      render();
    });
  });
  document.querySelectorAll('[data-personal-evolution-settings]').forEach((button) => {
    button.addEventListener('click', async () => {
      const agentInstanceId = button.dataset.personalEvolutionSettings || state.personalEvolutionProposalDetail?.agentInstanceId || '';
      if (agentInstanceId && !state.personalEvolutionExpandedAgentIds.includes(agentInstanceId)) {
        state.personalEvolutionExpandedAgentIds = [...state.personalEvolutionExpandedAgentIds, agentInstanceId];
      }
      enterSettings('evolution-sync');
      await checkPersonalEvolutionUpdates({ renderAfter: false });
      render();
    });
  });
  document.querySelectorAll('[data-settings-market-family]').forEach((button) => {
    button.addEventListener('click', () => openSettingsMarketFamily(button));
  });
  document.querySelector('[data-employees-refresh]')?.addEventListener('click', refreshEmployeeOverview);
  document.querySelector('[data-cluster-evolution-refresh]')?.addEventListener('click', refreshClusterEvolutionOverview);
  document.querySelector('#employee-market-search')?.addEventListener('input', (event) => {
    state.employeeMarketQuery = event.target.value || '';
    render();
    setTimeout(() => {
      const input = document.getElementById('employee-market-search');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  });
  document.querySelectorAll('[data-employee-market-department-option]').forEach((button) => button.addEventListener('click', () => {
    state.employeeMarketDepartmentFilter = button.dataset.employeeMarketDepartmentOption || 'all';
    render();
  }));
  document.querySelector('[data-employee-conflict-dismiss]')?.addEventListener('click', () => {
    state.employeeConflict = null;
    render();
  });
  document.querySelectorAll('[data-employee-cloud-auth-settings]').forEach((button) => button.addEventListener('click', () => {
    enterSettings('account');
  }));
  document.querySelectorAll('[data-employee-recruit]').forEach((button) => button.addEventListener('click', async () => {
    await recruitEmployeeFromMarket(button.dataset.employeeRecruit || '');
  }));
  document.querySelectorAll('[data-employee-profile-form]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const agentInstanceId = form.dataset.employeeProfileForm || '';
    if (!agentInstanceId) return;
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const data = new FormData(form);
      const result = await window.janus.updateEmployeeProfile({
        agentInstanceId,
        displayName: data.get('displayName') || '',
        note: data.get('note') || '',
      });
      const updated = result?.instance;
      if (updated) {
        state.employeeOverview = {
          ...(state.employeeOverview || {}),
          roster: (state.employeeOverview?.roster || []).map((item) => item.id === updated.id ? { ...item, ...updated } : item),
        };
      }
      notify('Agent 名称与备注已保存。', 'success');
    } catch (error) {
      notify(userVisibleErrorMessage(error, '无法保存 Agent 名称与备注。'), 'error');
    } finally {
      render();
    }
  }));
  document.querySelectorAll('[data-employee-profile-reset]').forEach((button) => button.addEventListener('click', () => {
    const form = button.closest('[data-employee-profile-form]');
    const input = form?.querySelector('input[name="displayName"]');
    if (!input) return;
    input.value = '';
    input.focus();
  }));
  document.querySelectorAll('[data-employee-market-reactivate]').forEach((button) => button.addEventListener('click', async () => {
    await reactivateEmployeeFromMarket(button.dataset.employeeMarketReactivate || '', Number(button.dataset.stateRevision || 0));
  }));
  document.querySelectorAll('[data-employee-market-candidate-open]').forEach((element) => {
    const openCandidate = () => {
      state.employeeMarketCandidateId = element.dataset.employeeMarketCandidateOpen || '';
      render();
    };
    if (element.matches('button')) element.addEventListener('click', openCandidate);
    else wireEmployeeCardActivation(element, openCandidate);
  });
  document.querySelectorAll('[data-employee-market-candidate-close]').forEach((button) => button.addEventListener('click', () => {
    state.employeeMarketCandidateId = '';
    render();
  }));
  document.querySelectorAll('[data-employee-reactivate-open-chat]').forEach((button) => button.addEventListener('click', async () => {
    await reactivateEmployeeAndOpenChat(button.dataset.employeeReactivateOpenChat || '', Number(button.dataset.stateRevision || 0));
  }));
  document.querySelectorAll('[data-employee-deactivate]').forEach((button) => button.addEventListener('click', async () => {
    await deactivateEmployeeWithConfirmation({
      agentInstanceId: button.dataset.employeeDeactivate || '',
      expectedStateRevision: Number(button.dataset.stateRevision || 0),
      hasRunningWork: button.dataset.currentWork === 'true',
    });
  }));
  document.querySelectorAll('[data-employee-installed-context]').forEach((button) => button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const agentInstanceId = button.dataset.employeeInstalledContext || '';
    if (!agentInstanceId) return;
    state.employeeContextMenu = {
      agentInstanceId,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 238)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 214)),
    };
    render();
  }));
  document.querySelector('[data-employee-context-menu-dismiss]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    state.employeeContextMenu = null;
    render();
  });
  const employeeContextMenu = document.querySelector('.employee-context-menu');
  employeeContextMenu?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    state.employeeContextMenu = null;
    render();
  });
  document.querySelectorAll('[data-employee-context-action]').forEach((button) => button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const agentInstanceId = button.closest('[data-employee-context-agent]')?.dataset.employeeContextAgent || '';
    const action = button.dataset.employeeContextAction || '';
    const employee = (state.employeeOverview?.roster || []).find((item) => item.id === agentInstanceId) || null;
    state.employeeContextMenu = null;
    render();
    if (!employee) return;
    if (action === 'profile') openEmployeeProfileEditor(agentInstanceId);
    else if (action === 'toggle-star') toggleEmployeeStar(agentInstanceId);
    else if (action === 'memory') await openEmployeeMemory(agentInstanceId);
    else if (action === 'versions') await openEmployeeMarket(agentInstanceId);
    else if (action === 'reactivate') await runEmployeeCommand('reactivate', {
      agentInstanceId, expectedStateRevision: Number(employee.stateRevision || 0),
    });
    else if (action === 'deactivate') await deactivateEmployeeWithConfirmation({
      agentInstanceId,
      expectedStateRevision: Number(employee.stateRevision || 0),
      hasRunningWork: Boolean(employee.currentWork),
    });
  }));
  document.querySelectorAll('[data-employee-reactivate]').forEach((button) => button.addEventListener('click', async () => {
    await runEmployeeCommand('reactivate', { agentInstanceId: button.dataset.employeeReactivate || '', expectedStateRevision: Number(button.dataset.stateRevision || 0) });
  }));
  document.querySelectorAll('[data-employee-sync-retry]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.employeeSyncRetry || '';
    button.disabled = true;
    try {
      const result = await window.janus.retryEmployeeLifecycleSync({ agentInstanceId });
      state.employeeOverview = result?.overview || state.employeeOverview;
      if (result?.sync?.status === 'completed') notify('员工状态已与云端同步。', 'success');
      else notify('同步仍未完成，系统会继续保留本机状态并在后台重试。', 'warning');
    } catch (error) {
      notify(userVisibleErrorMessage(error, '员工状态同步失败，请稍后重试。'), 'error');
      await refreshEmployeeOverview();
    } finally {
      render();
    }
  }));
  document.querySelectorAll('[data-employee-detail]').forEach((button) => button.addEventListener('click', () => {
    const agentInstanceId = button.dataset.employeeDetail || '';
    const tab = button.dataset.employeeDetailTab || 'overview';
    if (tab === 'memory') openEmployeeMemory(agentInstanceId);
    else if (tab === 'skill') openEmployeeMarket(agentInstanceId);
    else if (tab === 'growth') openEmployeeGrowth(agentInstanceId);
    else openEmployeeDetail(agentInstanceId);
  }));
  document.querySelectorAll('[data-employee-star-toggle]').forEach((button) => button.addEventListener('click', () => {
    toggleEmployeeStar(button.dataset.employeeStarToggle || '');
  }));
  document.querySelectorAll('[data-employee-memory]').forEach((button) => button.addEventListener('click', () => openEmployeeMemory(button.dataset.employeeMemory || '')));
  document.querySelectorAll('[data-employee-memory-create]').forEach((button) => button.addEventListener('click', () => {
    const agentInstanceId = button.dataset.employeeMemoryCreate || '';
    const suggested = `新对话 ${(state.employeeMemoryDrawer?.documents || []).filter((item) => item.scope === 'general').length + 1}`;
    openMemoryNameDialog({ agentInstanceId, source: 'employee', suggested });
  }));
  document.querySelectorAll('[data-employee-memory-clear]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.employeeMemoryClear || '';
    if (!window.confirm('当前 Memory 将被封存，并自动创建下一编号空槽。确认清除吗？')) return;
    try {
      const result = await window.janus.clearEmployeeMemory({ agentInstanceId });
      verifyMemoryApplication(result, { memoryDocumentId: result?.current?.id || '' });
      await refreshEmployeeOverview();
      await openEmployeeMemory(agentInstanceId);
      notify('当前 Memory 已封存，已切换到新的空槽。', 'success');
    } catch (error) { notify(userVisibleErrorMessage(error, '无法清除 Memory。'), 'error'); }
  }));
  document.querySelectorAll('[data-employee-memory-switch]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.agentInstanceId || '';
    try {
      const memoryDocumentId = button.dataset.employeeMemorySwitch || '';
      const result = await window.janus.switchEmployeeMemory({ agentInstanceId, memoryDocumentId,
        ...memoryContextSwitchExpectation(state.employeeMemoryDrawer?.contexts) });
      verifyMemoryApplication(result, { memoryDocumentId });
      if (state.currentAgentInstanceId === agentInstanceId && state.currentSessionId) {
        await refreshComposerAfterMemoryChange(agentInstanceId);
      } else {
        await refreshEmployeeOverview();
      }
      await openEmployeeMemory(agentInstanceId);
      notify('已切换当前 Memory，并重置模型线程。', 'success');
    } catch (error) {
      if (error?.code === 'memory_context_state_conflict') await openEmployeeMemory(agentInstanceId);
      notify(userVisibleErrorMessage(error, '无法切换 Memory。'), 'error');
    }
  }));
  document.querySelectorAll('[data-employee-memory-restore]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.agentInstanceId || '';
    try {
      await window.janus.restoreEmployeeMemory({ agentInstanceId, memoryDocumentId: button.dataset.employeeMemoryRestore || '' });
      await openEmployeeMemory(agentInstanceId);
      notify('Memory 已恢复，可再次设为当前。', 'success');
    } catch (error) { notify(userVisibleErrorMessage(error, '无法恢复 Memory。'), 'error'); }
  }));
  document.querySelectorAll('[data-employee-memory-restore-switch]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.agentInstanceId || '';
    const memoryDocumentId = button.dataset.employeeMemoryRestoreSwitch || '';
    try {
      const result = await window.janus.restoreAndSwitchEmployeeMemory({ agentInstanceId, memoryDocumentId,
        ...memoryContextSwitchExpectation(state.employeeMemoryDrawer?.contexts) });
      verifyMemoryApplication(result, { memoryDocumentId });
      if (state.currentAgentInstanceId === agentInstanceId && state.currentSessionId) {
        await refreshComposerAfterMemoryChange(agentInstanceId);
      } else {
        await refreshEmployeeOverview();
      }
      await openEmployeeMemory(agentInstanceId);
      notify('Memory 已恢复并切换，新的模型线程将在下一条消息创建。', 'success');
    } catch (error) {
      if (error?.code === 'memory_context_state_conflict') await openEmployeeMemory(agentInstanceId);
      notify(userVisibleErrorMessage(error, '无法恢复并切换 Memory。'), 'error');
    }
  }));
  document.querySelectorAll('[data-employee-memory-rename]').forEach((button) => button.addEventListener('click', () => {
    const agentInstanceId = button.dataset.agentInstanceId || '';
    openMemoryNameDialog({
      agentInstanceId,
      source: 'employee',
      mode: 'rename',
      memoryDocumentId: button.dataset.employeeMemoryRename || '',
      suggested: button.dataset.memoryName || '',
    });
  }));
  document.querySelectorAll('[data-employee-memory-reference]').forEach((button) => button.addEventListener('click', async () => {
    await referenceArchivedMemoryInComposer({
      agentInstanceId: button.dataset.agentInstanceId || '',
      memoryDocumentId: button.dataset.employeeMemoryReference || '',
      createBranch: false,
    });
  }));
  document.querySelectorAll('[data-employee-memory-branch]').forEach((button) => button.addEventListener('click', async () => {
    await referenceArchivedMemoryInComposer({
      agentInstanceId: button.dataset.agentInstanceId || '',
      memoryDocumentId: button.dataset.employeeMemoryBranch || '',
      createBranch: true,
    });
  }));
  document.querySelectorAll('[data-employee-context-switch]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.agentInstanceId || '';
    try {
      const contextSpaceId = button.dataset.employeeContextSwitch || '';
      const result = await window.janus.switchEmployeeContext({ agentInstanceId, contextSpaceId });
      verifyMemoryApplication(result, { contextSpaceId });
      await openEmployeeMemory(agentInstanceId);
      if (state.currentSessionId) {
        const sessionId = state.currentSessionId;
        const [page, contextUsage] = await Promise.all([
          loadLatestRendererMessagePage(sessionId),
          window.janus.chatContextStatus({ sessionId }).catch(() => null),
        ]);
        if (applyLatestRendererMessagePage(sessionId, page)) state.contextUsage = contextUsage;
      }
      render();
      notify('Context Space 已切换，模型线程已重置。', 'success');
    } catch (error) { notify(userVisibleErrorMessage(error, '无法切换 Context Space。'), 'error'); }
  }));
  document.querySelectorAll('[data-employee-history-session]').forEach((button) => button.addEventListener('click', () => {
    state.employeeMemoryDrawer = null;
    openSession(button.dataset.employeeHistorySession || '');
  }));
  document.querySelectorAll('[data-employee-history-group]').forEach((button) => button.addEventListener('click', () => {
    openEmployeeConversationHistoryGroup(
      button.dataset.agentInstanceId || state.currentAgentInstanceId || '',
      button.dataset.employeeHistoryGroup || '',
    );
  }));
  document.querySelectorAll('[data-employee-history-back]').forEach((button) => button.addEventListener('click', () => {
    state.employeeConversationHistoryViewer = null;
    render();
    scrollMessagesToBottom({ force: true });
  }));
  document.querySelectorAll('[data-employee-active-work]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.employeeActiveWork || '';
    const employee = (state.employeeOverview?.roster || []).find((item) => item.id === agentInstanceId) || null;
    const overview = state.employeeConversationOverviewByInstanceId?.[agentInstanceId] || null;
    if (employee && overview) await openEmployeeActiveWork(employee, overview);
  }));
  document.querySelectorAll('[data-employee-active-work-toggle]').forEach((button) => button.addEventListener('click', () => {
    const agentInstanceId = button.dataset.employeeActiveWorkToggle || '';
    if (!agentInstanceId) return;
    state.employeeActiveWorkCollapsedByInstanceId = {
      ...(state.employeeActiveWorkCollapsedByInstanceId || {}),
      [agentInstanceId]: !Boolean(state.employeeActiveWorkCollapsedByInstanceId?.[agentInstanceId]),
    };
    render();
  }));
  document.querySelectorAll('[data-memory-conflict-resolve]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.agentInstanceId || '';
    try {
      await window.janus.resolveEmployeeMemoryConflict({ agentInstanceId, memoryDocumentId: button.dataset.memoryDocumentId || '', versionId: button.dataset.memoryConflictResolve || '' });
      await openEmployeeMemory(agentInstanceId);
      notify('已采用所选 Memory 分支，其他分支继续保留。', 'success');
    } catch (error) { notify(userVisibleErrorMessage(error, '无法解决 Memory 冲突。'), 'error'); }
  }));
  document.querySelectorAll('[data-employee-memory-archive]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.agentInstanceId || '';
    if (!window.confirm('归档后仍可只读查看、恢复或引用，但不能直接继续发送消息。确认归档吗？')) return;
    try {
      await window.janus.archiveEmployeeMemory({ agentInstanceId, memoryDocumentId: button.dataset.employeeMemoryArchive || '' });
      await openEmployeeMemory(agentInstanceId);
      await refreshEmployeeOverview();
      notify('Memory 已归档。', 'success');
    } catch (error) {
      notify(userVisibleErrorMessage(error, '无法归档 Memory。'), 'error');
    }
  }));
  document.querySelectorAll('[data-employee-market]').forEach((button) => button.addEventListener('click', () => openEmployeeMarket(button.dataset.employeeMarket || '')));
  document.querySelectorAll('[data-employee-market-back]').forEach((button) => button.addEventListener('click', () => {
    const agentInstanceId = button.dataset.employeeMarketBack || state.employeeMarketDrawer?.agentInstanceId || '';
    state.employeeMarketDrawer = null;
    openEmployeeDetail(agentInstanceId);
  }));
  document.querySelectorAll('[data-employee-detail-close]').forEach((button) => button.addEventListener('click', closeEmployeeDetail));
  document.querySelectorAll('[data-employee-memory-close]').forEach((button) => button.addEventListener('click', closeEmployeeDetail));
  document.querySelectorAll('[data-employee-market-close]').forEach((button) => button.addEventListener('click', () => {
    if (state.employeeMarketDrawer?.source === 'employees') closeEmployeeDetail();
    else { state.employeeMarketDrawer = null; render(); }
  }));
  document.querySelectorAll('[data-employee-memory-retry]').forEach((button) => button.addEventListener('click', () => openEmployeeMemory(button.dataset.employeeMemoryRetry || '')));
  document.querySelectorAll('[data-employee-market-retry]').forEach((button) => button.addEventListener('click', () => reopenMarketDrawer()));
  document.querySelectorAll('[data-employee-memory-document]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const details = await window.janus.employeeMemoryDetails({ agentInstanceId: button.dataset.agentInstanceId || '', memoryDocumentId: button.dataset.employeeMemoryDocument || '' });
      state.employeeMemoryDrawer = { ...(state.employeeMemoryDrawer || {}), selectedDocumentId: button.dataset.employeeMemoryDocument || '', details };
      render();
    } catch (error) { notify(userVisibleErrorMessage(error, '无法读取 Memory 上下文。'), 'error'); }
  }));
  document.querySelectorAll('[data-employee-evolution]').forEach((button) => button.addEventListener('click', async () => {
    state.employeeSelectedInstanceId = button.dataset.employeeEvolution || '';
    state.currentTab = 'personal-evolution';
    await refreshPersonalEvolutionState();
    render();
  }));
  document.querySelectorAll('[data-employee-growth]').forEach((button) => button.addEventListener('click', () => openEmployeeGrowth(button.dataset.employeeGrowth || '')));
  document.querySelectorAll('[data-employee-growth-close]').forEach((button) => button.addEventListener('click', closeEmployeeDetail));
  document.querySelectorAll('[data-employee-growth-refresh]').forEach((button) => button.addEventListener('click', () => openEmployeeGrowth(button.dataset.employeeGrowthRefresh || '')));
  document.querySelectorAll('[data-leadership-dialog-close]').forEach((button) => button.addEventListener('click', () => {
    if (state.leadershipDecisionDialog?.busy) return;
    state.leadershipDecisionDialog = null;
    render();
  }));
  document.querySelector('[data-leadership-dialog-form]')?.addEventListener('submit', submitLeadershipDecisionDialog);
  document.querySelectorAll('[data-employee-leadership-trial]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.employeeLeadershipTrial || '';
    const role = button.dataset.role || 'task_lead';
    const participantCount = Number(button.dataset.participantCount || 2);
    const nodeCount = Number(button.dataset.nodeCount || 1);
    const departmentCount = Number(button.dataset.departmentCount || 1);
    if (!window.confirm(`确认让该 Agent 进行一次 ${role} 受控试岗？本次最多协调 ${participantCount} 名 Agent。`)) return;
    try {
      await window.janus.requestEmployeeLeadershipTrial({ agentInstanceId, role, participantCount, nodeCount, departmentCount,
        expectedStateRevision: Number(button.dataset.stateRevision || 0), commandId: `lead_trial_${crypto.randomUUID()}` });
      await refreshEmployeeOverview();
    } catch (error) { window.alert(error.message || String(error)); }
  }));
  document.querySelectorAll('[data-employee-leadership-action]').forEach((button) => button.addEventListener('click', async () => {
    const actionId = button.dataset.employeeLeadershipAction || '';
    const agentInstanceId = button.dataset.agentInstanceId || '';
    const decision = button.dataset.decision || '';
    if (!window.confirm(decision === 'approve' ? '确认应用这次领导职级晋升？' : '确认暂不晋升？')) return;
    try {
      await window.janus.decideEmployeeLeadershipAction({ agentInstanceId, actionId, decision,
        expectedStateRevision: Number(button.dataset.stateRevision || 0), commandId: `lead_decision_${crypto.randomUUID()}` });
      await refreshEmployeeOverview();
    } catch (error) { window.alert(error.message || String(error)); }
  }));
  document.querySelectorAll('[data-employee-leadership-restore]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.employeeLeadershipRestore || '';
    if (!window.confirm('提交领导资格恢复申请？该申请必须由云端治理人员复核。')) return;
    try {
      await window.janus.restoreEmployeeLeadership({ agentInstanceId, expectedStateRevision: Number(button.dataset.stateRevision || 0),
        commandId: `lead_restore_${crypto.randomUUID()}`, reason: 'owner_requested_governance_review' });
      await refreshEmployeeOverview();
    } catch (error) { window.alert(error.message || String(error)); }
  }));
  document.querySelectorAll('[data-employee-leadership-appeal]').forEach((button) => button.addEventListener('click', async () => {
    const agentInstanceId = button.dataset.employeeLeadershipAppeal || '';
    state.leadershipDecisionDialog = {
      kind: 'owner_appeal', agentInstanceId, appealKind: button.dataset.kind || 'assessment',
      title: '提交 Leadership 申诉', description: '治理人员将看到当前评估和状态快照，请说明需要复核的事实。', submitLabel: '提交申诉', busy: false, error: '',
    };
    render();
  }));
  document.querySelectorAll('[data-leadership-governance-action]').forEach((button) => button.addEventListener('click', async () => {
    const decision = button.dataset.decision || '';
    state.leadershipDecisionDialog = {
      kind: 'governance_action', actionId: button.dataset.leadershipGovernanceAction || '', decision,
      expectedStateRevision: Number(button.dataset.stateRevision || 0), title: decision === 'approve' ? '批准 Leadership 治理操作' : '拒绝 Leadership 治理操作',
      description: decision === 'approve' ? '填写批准依据，决定将被 revision 校验并写入审计记录。' : '填写拒绝原因，便于用户理解和后续申诉。',
      submitLabel: decision === 'approve' ? '确认批准' : '确认拒绝', busy: false, error: '',
    };
    render();
  }));
  document.querySelectorAll('[data-leadership-governance-appeal]').forEach((button) => button.addEventListener('click', async () => {
    const decision = button.dataset.decision || '';
    state.leadershipDecisionDialog = {
      kind: 'governance_appeal', appealId: button.dataset.leadershipGovernanceAppeal || '', decision,
      title: decision === 'approve' ? '支持 Leadership 申诉' : '驳回 Leadership 申诉',
      description: decision === 'approve' ? '说明申诉成立的事实与后续处理意见。' : '说明驳回依据，结果将展示给提交申诉的用户。',
      submitLabel: decision === 'approve' ? '支持申诉' : '驳回申诉', busy: false, error: '',
    };
    render();
  }));
  document.querySelectorAll('[data-employee-open-chat]').forEach((button) => button.addEventListener('click', () => openEmployeeChat(button.dataset.employeeOpenChat || '')));
  document.querySelectorAll('[data-chat-clear-context]').forEach((button) => button.addEventListener('click', async () => {
    if (!state.currentSessionId || currentChatRun()) return;
    const sessionId = state.currentSessionId;
    const contextSpaceId = state.contextUsage?.sessionId === sessionId ? String(state.contextUsage?.contextSpaceId || '') : '';
    const operationKey = `${sessionId}:${contextSpaceId || 'default'}`;
    if (state.contextCompressionOperations?.[operationKey]?.status === 'running') return;
    const commandId = globalThis.crypto?.randomUUID?.() || `context_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const operation = {
      key: operationKey,
      sessionId,
      contextSpaceId,
      commandId,
      status: 'running',
      startedAt: Date.now(),
      error: '',
    };
    state.contextCompressionOperations = {
      ...(state.contextCompressionOperations || {}),
      [operationKey]: operation,
    };
    notify('正在使用 Janus 原生能力整理当前线程。原始聊天历史和 Memory 不会删除。', 'info');
    render();
    try {
      const compressedUsage = await withContextCompressionTimeout(compressChatContextWithRefresh({
        api: window.janus, sessionId, currentUsage: state.contextUsage, commandId,
      }), 130_000);
      if (state.contextCompressionOperations?.[operationKey]?.commandId !== commandId) return;
      if (state.currentSessionId !== sessionId) return;
      state.contextUsage = compressedUsage;
      state.sessions = await window.janus.listSessions();
      notify(compressedUsage?.warningLevel === 'provider_compacted'
        ? '上下文已压缩；Janus 线程、原始聊天历史和 Memory 保持不变。'
        : '原生压缩不可用，已创建本地恢复摘要；原始聊天历史和 Memory 保持不变，下次发送将使用新的 Janus 线程。', 'success');
    } catch (error) {
      if (state.contextCompressionOperations?.[operationKey]?.commandId !== commandId) return;
      if (state.currentSessionId === sessionId) {
        state.contextUsage = await window.janus.chatContextStatus({ sessionId }).catch(() => state.contextUsage);
        notify(userVisibleErrorMessage(error, '无法压缩上下文。'), 'error');
      }
    } finally {
      if (state.contextCompressionOperations?.[operationKey]?.commandId === commandId) {
        const next = { ...(state.contextCompressionOperations || {}) };
        delete next[operationKey];
        state.contextCompressionOperations = next;
      }
      render();
    }
  }));
  document.querySelectorAll('[data-private-assistant-reset-context]').forEach((button) => button.addEventListener('click', async () => {
    if (!state.currentSessionId || !isPrivateAssistantComposerMode() || currentChatRun() || state.privateAssistantContextResetBusy) return;
    const sessionId = state.currentSessionId;
    const confirmed = window.confirm('清空后，当前模型线程和对话上下文将从这里重新开始；聊天历史仍会保留在界面中，附件和文件不会删除，也不会影响其他 Agent。确认清空吗？');
    if (!confirmed) return;
    const commandId = globalThis.crypto?.randomUUID?.() || `private_context_reset_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    state.privateAssistantContextResetBusy = true;
    notify('正在清空私人助理上下文…', 'info');
    render();
    try {
      const resetUsage = await resetPrivateAssistantContextWithRefresh({
        api: window.janus,
        sessionId,
        currentUsage: state.contextUsage,
        commandId,
      });
      if (state.currentSessionId !== sessionId) return;
      state.contextUsage = resetUsage;
      state.sessions = await window.janus.listSessions();
      notify('私人助理上下文已清空；历史消息仍保留，但后续回答不会再读取清空前的内容。', 'success');
    } catch (error) {
      if (state.currentSessionId === sessionId) {
        state.contextUsage = await window.janus.chatContextStatus({ sessionId }).catch(() => state.contextUsage);
        notify(userVisibleErrorMessage(error, '无法清空私人助理上下文。'), 'error');
      }
    } finally {
      state.privateAssistantContextResetBusy = false;
      render();
    }
  }));
  document.querySelectorAll('[data-employee-card-chat]').forEach((card) => wireEmployeeCardActivation(card, () => openEmployeeChat(card.dataset.employeeCardChat || '')));
  document.querySelectorAll('[data-contacts-employee-chat]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.opening === 'true') return;
      if (contactsEmployeeClickTimer) clearTimeout(contactsEmployeeClickTimer);
      contactsEmployeeClickTimer = null;
      button.dataset.opening = 'true';
      try {
        await openEmployeeChat(button.dataset.contactsEmployeeChat || '');
      } finally {
        if (button.isConnected) delete button.dataset.opening;
      }
    });
  });
  document.querySelectorAll('[data-contacts-employee-card]').forEach((card) => {
    const employeeId = card.dataset.contactsEmployeeCard || '';
    card.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (!employeeId) return;
      state.employeeContextMenu = {
        agentInstanceId: employeeId,
        x: Math.min(event.clientX, Math.max(8, window.innerWidth - 238)),
        y: Math.min(event.clientY, Math.max(8, window.innerHeight - 214)),
      };
      render();
    });
    card.addEventListener('click', (event) => {
      if (event.target.closest('button, a, input, select, textarea, summary, details')) return;
      if (contactsEmployeeClickTimer) clearTimeout(contactsEmployeeClickTimer);
      contactsEmployeeClickTimer = setTimeout(() => {
        contactsEmployeeClickTimer = null;
        openEmployeeDetail(employeeId);
      }, 220);
    });
    card.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, a, input, select, textarea, summary, details')) return;
      event.preventDefault();
      if (contactsEmployeeClickTimer) clearTimeout(contactsEmployeeClickTimer);
      contactsEmployeeClickTimer = null;
      openEmployeeChat(employeeId);
    });
    card.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openEmployeeDetail(employeeId);
    });
  });
  document.querySelectorAll('[data-market-adopt]').forEach((button) => button.addEventListener('click', () => runMarketSectionAction('adopt', button)));
  document.querySelectorAll('[data-market-adopt-full]').forEach((button) => button.addEventListener('click', () => runMarketSectionAction('adopt', button)));
  document.querySelectorAll('[data-market-rollback-full]').forEach((button) => button.addEventListener('click', () => runMarketSectionAction('rollback', button)));
  document.querySelectorAll('[data-market-rollback]').forEach((button) => button.addEventListener('click', () => runMarketSectionAction('rollback', button)));
  document.querySelectorAll('[data-market-ignore]').forEach((button) => button.addEventListener('click', () => runMarketSectionAction('ignore', button)));
  document.querySelectorAll('[data-market-resolve]').forEach((button) => button.addEventListener('click', () => runMarketSectionAction('adopt', button, button.dataset.marketResolve || 'personal')));
  document.querySelectorAll('[data-market-canary-toggle]').forEach((button)=>button.addEventListener('click',()=>runMarketCanaryAction(button)));
  document.querySelector('[data-evolution-grants-refresh]')?.addEventListener('click', async () => {
    try {
      const result = await window.janus.listEvolutionGrants();
      state.evolutionGrants = result.items || [];
      render();
    } catch (error) { notify(userVisibleErrorMessage(error, '无法读取设备授权。'), 'error'); }
  });
  document.querySelectorAll('[data-evolution-grant-revoke]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await window.janus.revokeEvolutionGrant({ deviceId: button.dataset.evolutionGrantRevoke || '' });
        const result = await window.janus.listEvolutionGrants();
        state.evolutionGrants = result.items || [];
        state.personalEvolutionStatus = await window.janus.personalEvolutionStatus();
        notify('设备演化授权已撤销。', 'success');
        render();
      } catch (error) { notify(userVisibleErrorMessage(error, '无法撤销设备授权。'), 'error'); }
    });
  });
  document.querySelectorAll('[data-evolution-grant-approve]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await window.janus.approveEvolutionGrant({ deviceId: button.dataset.evolutionGrantApprove || '' });
        const result = await window.janus.listEvolutionGrants();
        state.evolutionGrants = result.items || [];
        notify('新设备已批准，可领取 Device Grant。', 'success');
        render();
      } catch (error) { notify(userVisibleErrorMessage(error, '无法批准设备。'), 'error'); }
    });
  });
  document.querySelectorAll('[data-personal-proposal]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        state.personalEvolutionProposalDetail = await window.janus.getPersonalEvolutionProposal({ proposalId: button.dataset.personalProposal });
        render();
      } catch (error) { notify(userVisibleErrorMessage(error, '无法读取 Proposal。'), 'error'); }
    });
  });
  document.querySelectorAll('[data-personal-memory-decision]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await window.janus.decidePersonalEvolution({
          proposalId: button.dataset.proposalId, skillDecision: '',
          memoryDecisions: [{ operationId: button.dataset.operationId, decision: button.dataset.personalMemoryDecision }],
        });
        await refreshPersonalEvolutionState(button.dataset.proposalId);
        notify('Memory 操作决定已保存。', 'success');
      } catch (error) { notify(userVisibleErrorMessage(error, '无法应用 Memory 决定。'), 'error'); }
    });
  });
  document.querySelectorAll('[data-personal-memory-rollback]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await window.janus.rollbackPersonalMemory({
          memoryDocumentId: button.dataset.memoryDocumentId || '',
          targetVersionId: button.dataset.targetVersionId || '',
        });
        await refreshPersonalEvolutionState(button.dataset.proposalId || '');
        notify('Memory 已创建回滚版本。', 'success');
      } catch (error) { notify(userVisibleErrorMessage(error, 'Memory rollback 失败。'), 'error'); }
    });
  });
  document.querySelector('#plugin-search-input')?.addEventListener('input', (event) => {
    state.pluginSearchQuery = event.target.value || '';
    state.pluginPageIndexes = { managed: 0, attached: 0, codex: 0 };
    render();
    setTimeout(() => {
      const input = document.getElementById('plugin-search-input');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  });
  document.querySelector('#attached-skill-source')?.addEventListener('input', (event) => {
    state.attachedSkillImportSource = event.target.value || '';
    const button = document.querySelector('[data-attached-skill-import]');
    if (button && !state.attachedSkillBusy) button.disabled = !String(state.attachedSkillImportSource || '').trim();
  });
  document.querySelector('#codex-marketplace-source')?.addEventListener('input', (event) => {
    state.codexMarketplaceSource = event.target.value || '';
    const button = document.querySelector('[data-codex-marketplace-add]');
    if (button && !state.codexPluginBusy) button.disabled = !String(state.codexMarketplaceSource || '').trim();
  });
  document.querySelector('[data-codex-marketplace-pick]')?.addEventListener('click', () => pickCodexMarketplaceSource());
  document.querySelector('[data-codex-marketplace-add]')?.addEventListener('click', () => addCodexMarketplace());
  document.querySelectorAll('[data-codex-marketplace-upgrade]').forEach((button) => button.addEventListener('click', () => upgradeCodexMarketplace(button.dataset.codexMarketplaceUpgrade || '')));
  document.querySelectorAll('[data-codex-marketplace-remove]').forEach((button) => button.addEventListener('click', () => removeCodexMarketplace(button.dataset.codexMarketplaceRemove || '')));
  document.querySelectorAll('[data-codex-plugin-install]').forEach((button) => button.addEventListener('click', () => installCodexPlugin(button.dataset.codexPluginInstall || '')));
  document.querySelectorAll('[data-codex-plugin-remove]').forEach((button) => button.addEventListener('click', () => removeCodexPlugin(button.dataset.codexPluginRemove || '')));
  document.querySelectorAll('[data-plugin-section-toggle]').forEach((button) => button.addEventListener('click', () => {
    const section = button.dataset.pluginSectionToggle || '';
    if (!section) return;
    state.pluginSectionsOpen = {
      ...(state.pluginSectionsOpen || {}),
      [section]: button.getAttribute('aria-expanded') !== 'true',
    };
    render();
  }));
  document.querySelectorAll('[data-plugin-page]').forEach((button) => button.addEventListener('click', () => {
    const section = button.dataset.pluginPage || '';
    const direction = button.dataset.pageDirection || '';
    if (!section) return;
    const current = Math.max(0, Number(state.pluginPageIndexes?.[section]) || 0);
    state.pluginPageIndexes = {
      ...(state.pluginPageIndexes || {}),
      [section]: direction === 'previous' ? Math.max(0, current - 1) : current + 1,
    };
    render();
  }));
  document.querySelector('[data-attached-skill-import]')?.addEventListener('click', () => importAttachedSkill());
  document.querySelector('[data-attached-skill-pick-source]')?.addEventListener('click', () => pickAttachedSkillSource());
  document.querySelectorAll('[data-attached-skill-disable-package]').forEach((button) => button.addEventListener('click', () => {
    disableAttachedSkillPackage(button.dataset.attachedSkillDisablePackage || '');
  }));
  document.querySelectorAll('[data-attached-skill-assign]').forEach((button) => button.addEventListener('click', () => {
    const skillId = button.dataset.attachedSkillAssign || '';
    const row = button.closest('[data-attached-skill-row]');
    const target = row?.querySelector('[data-attached-skill-target]')?.value || '';
    const enabled = row?.querySelector('[data-attached-skill-enabled]')?.value !== 'false';
    setAttachedSkillAssignment({ skillId, target, enabled });
  }));
  document.querySelectorAll('[data-attached-skill-row]').forEach((row) => {
    const target = row.querySelector('[data-attached-skill-target]');
    const apply = row.querySelector('[data-attached-skill-assign]');
    const sync = () => { if (apply) apply.disabled = !String(target?.value || '').trim() || Boolean(state.attachedSkillBusy); };
    target?.addEventListener('change', sync);
    sync();
  });
  document.querySelectorAll('[data-attached-skill-unassign]').forEach((button) => button.addEventListener('click', () => {
    removeAttachedSkillAssignment({
      skillId: button.dataset.skillId || '',
      scopeType: button.dataset.scopeType || '',
      scopeId: button.dataset.scopeId || '',
    });
  }));
  document.querySelectorAll('[data-plugin-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.pluginFilter = button.dataset.pluginFilter || 'all';
      state.pluginPageIndexes = { ...(state.pluginPageIndexes || {}), managed: 0 };
      render();
    });
  });
  document.querySelector('#plugin-category-select')?.addEventListener('change', (event) => {
    state.pluginCategory = event.target.value || 'all';
    state.pluginPageIndexes = { ...(state.pluginPageIndexes || {}), managed: 0 };
    render();
  });
  document.querySelector('#plugin-sort-select')?.addEventListener('change', (event) => {
    state.pluginSort = event.target.value || 'name';
    state.pluginPageIndexes = { ...(state.pluginPageIndexes || {}), managed: 0 };
    render();
  });
  document.querySelectorAll('[data-open-plugin-settings]').forEach((button) => {
    button.addEventListener('click', () => {
      const pluginAgentFamily = button.dataset.pluginAgentFamily || '';
      state.pluginReturnContext = state.currentDepartmentId === 'ppt_department' || pluginAgentFamily === 'ppt'
        ? { pluginId: button.dataset.pluginId || 'ppt_creation', departmentId: 'ppt_department', agentId: 'ppt', styleId: state.pptStyleId }
        : state.pluginReturnContext;
      state.currentTab = 'settings';
      state.currentSettingsSection = 'skills';
      state.pptStyleMenuOpen = false;
      state.pluginSearchQuery = 'PPT';
      render();
    });
  });
  document.querySelectorAll('[data-plugin-install]').forEach((button) => button.addEventListener('click', () => installManagedPlugin(button.dataset.pluginInstall || '')));
  document.querySelectorAll('[data-plugin-detail]').forEach((button) => button.addEventListener('click', () => {
    state.pluginDetailId = button.dataset.pluginDetail || '';
    render();
  }));
  document.querySelectorAll('[data-plugin-detail-close]').forEach((button) => button.addEventListener('click', () => {
    state.pluginDetailId = '';
    render();
  }));
  document.querySelectorAll('[data-plugin-more]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const pluginId = button.dataset.pluginMore || '';
    const nextOpen = state.pluginMenuOpenId === pluginId ? '' : pluginId;
    state.pluginMenuOpenId = nextOpen;
    state.pluginMenuOpen = Boolean(nextOpen);
    state.pluginMenuPosition = nextOpen ? pluginMenuPositionFromButton(event.currentTarget) : null;
    render();
  }));
  document.querySelectorAll('[data-plugin-open-files]').forEach((button) => button.addEventListener('click', () => openManagedPluginFiles(button.dataset.pluginOpenFiles || '')));
  document.querySelectorAll('[data-plugin-uninstall]').forEach((button) => button.addEventListener('click', () => uninstallManagedPlugin(button.dataset.pluginUninstall || '')));
  document.querySelectorAll('[data-plugin-chat]').forEach((button) => button.addEventListener('click', async () => {
    const pluginId = button.dataset.pluginId || '';
    const returnContext = state.pluginReturnContext?.pluginId === pluginId ? state.pluginReturnContext : null;
    const preservedDraft = preserveChatDraftFromInput();
    if (button.dataset.pluginChat === 'pptx') {
      await refreshEmployeeOverview();
      startNewPlainChat({ renderNow: false, focus: false });
      state.chatDraft = preservedDraft;
    }
    state.currentTab = 'chat';
    state.pluginDetailId = '';
    state.pluginMenuOpen = false;
    state.pluginMenuOpenId = '';
    state.pluginMenuPosition = null;
    if (button.dataset.pluginChat === 'pptx') {
      state.homeMode = 'department';
      state.currentDepartmentId = returnContext?.departmentId || 'ppt_department';
      state.currentAgentId = 'ppt';
      state.selectionSource = 'plugin';
      state.pptStyleId = normalizePptStyleId(returnContext?.styleId || state.pptStyleId);
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      state.networkMessageHomeOpen = false;
      state.messageActivePane = 'conversation';
      state.messageGroupSidebarOpen = false;
      if (!state.chatDraft.trim()) state.chatDraft = '请帮我制作一份 PPT，并导出为可编辑的 .pptx 文件。';
    }
    state.pluginReturnContext = null;
    render();
    setTimeout(() => document.getElementById('chat-input')?.focus(), 0);
  }));
  document.querySelectorAll('[data-archived-session]').forEach((btn) => {
    btn.addEventListener('click', () => openSession(btn.dataset.archivedSession));
  });
  document.querySelector('#rename-session-form')?.addEventListener('submit', submitRenameSession);
  document.querySelector('#rename-session-close')?.addEventListener('click', closeRenameSessionDialog);
  document.querySelector('#rename-session-cancel')?.addEventListener('click', closeRenameSessionDialog);
  document.querySelector('#rename-session-overlay')?.addEventListener('click', (event) => {
    if (event.target?.id === 'rename-session-overlay') closeRenameSessionDialog();
  });
  document.querySelector('#rename-session-input')?.addEventListener('input', (event) => {
    if (state.renameSessionDialog) state.renameSessionDialog.draft = event.target.value;
  });
  document.querySelector('#memory-name-form')?.addEventListener('submit', submitMemoryNameDialog);
  document.querySelector('#memory-name-close')?.addEventListener('click', closeMemoryNameDialog);
  document.querySelector('#memory-name-cancel')?.addEventListener('click', closeMemoryNameDialog);
  document.querySelector('#memory-name-overlay')?.addEventListener('click', (event) => {
    if (event.target?.id === 'memory-name-overlay') closeMemoryNameDialog();
  });
  document.querySelector('#memory-name-input')?.addEventListener('input', (event) => {
    if (state.memoryNameDialog) state.memoryNameDialog.draft = event.target.value;
  });
  document.querySelector('#social-edit-form')?.addEventListener('submit', submitSocialEditDialog);
  document.querySelector('#social-edit-close')?.addEventListener('click', closeSocialEditDialog);
  document.querySelector('#social-edit-cancel')?.addEventListener('click', closeSocialEditDialog);
  document.querySelector('#social-edit-overlay')?.addEventListener('click', (event) => {
    if (event.target?.id === 'social-edit-overlay') closeSocialEditDialog();
  });
  document.querySelector('#social-edit-input')?.addEventListener('input', (event) => {
    if (state.socialEditDialog) state.socialEditDialog = { ...state.socialEditDialog, draft: event.target.value, error: '' };
  });
  document.querySelector('#theme-toggle-btn')?.addEventListener('click', toggleTheme);
  document.querySelector('#language-toggle-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    state.languageMenuOpen = !state.languageMenuOpen;
    render();
  });
  document.querySelectorAll('.global-language-menu [data-language-choice]').forEach((button) => {
    button.addEventListener('click', () => setLanguageMode(button.dataset.languageChoice || 'en'));
  });
  document.querySelector('[data-account-workspace-toggle]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.workspaceSwitchBusy) return;
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    state.accountMenuWorkspaceMoreOpen = false;
    state.accountWorkspaceMenuOpen = !state.accountWorkspaceMenuOpen;
    render();
  });
  document.querySelectorAll('[data-account-workspace-id]:not([data-account-workspace-shortcut])').forEach((button) => {
    button.addEventListener('click', () => switchRendererAccountWorkspace(button.dataset.accountWorkspaceId || ''));
  });
  document.querySelectorAll('[data-account-organization-action]').forEach((button) => button.addEventListener('click', async () => {
    const action = button.dataset.accountOrganizationAction || '';
    state.accountWorkspaceMenuOpen = false;
    if (!state.networkPanelOpen || state.networkPanelView !== 'friends') await openNetworkPanel('friends');
    if (action === 'manage') {
      state.friendDirectoryCategory = 'organizations';
      state.friendDirectoryView = 'contacts';
      state.contactsSelectedOrganizationId = state.activeAccountWorkspace?.organizationId
        || state.startupAccountWorkspace?.organizationId || '';
      render();
      return;
    }
    openContactAddDialog(action === 'create' ? 'create-organization' : 'join-organization');
  }));
  document.querySelector('.app-frame')?.addEventListener('click', (event) => {
    let changed = false;
    if (state.accountWorkspaceMenuOpen && !event.target.closest('.account-workspace-switcher')) {
      state.accountWorkspaceMenuOpen = false;
      changed = true;
    }
    if (state.organizationSettingsWorkspaceMoreOpen
      && !event.target.closest('[data-organization-settings-workspace-more-toggle], .organization-settings-workspace-more-submenu')) {
      state.organizationSettingsWorkspaceMoreOpen = false;
      state.organizationSettingsWorkspaceMorePosition = null;
      changed = true;
    }
    if (changed) render();
  });
  document.querySelectorAll('[data-message-pane]').forEach((button) => {
    button.addEventListener('click', () => {
      state.messageActivePane = button.dataset.messagePane === 'conversation' ? 'conversation' : 'list';
      if (state.messageActivePane === 'conversation') state.messageGroupSidebarOpen = false;
      render();
      requestAnimationFrame(() => {
        if (state.messageActivePane === 'conversation') {
          document.querySelector('#chat-input, [data-message-default-page] button')?.focus?.({ preventScroll: true });
        } else {
          document.querySelector('#sidebar-chat-search-trigger, [data-message-default-page] button')?.focus?.({ preventScroll: true });
        }
      });
    });
  });
  document.querySelector('[data-message-home-back]')?.addEventListener('click', () => {
    if (state.collaborationGroupId) {
      state.collaborationGroupId = '';
      state.collaborationGroupDetail = null;
      state.collaborationGroupWorkspace = null;
      state.collaborationSearchOpen = false;
      state.collaborationSearchQuery = '';
      state.collaborationMembersOpen = false;
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      state.networkMessageHomeOpen = true;
      state.messageActivePane = 'list';
      render();
      requestAnimationFrame(() => document.querySelector('#sidebar-chat-search-trigger, [data-message-default-page] button')?.focus?.({ preventScroll: true }));
      return;
    }
    if (state.responsiveLayoutMode === 'single') {
      state.messageActivePane = 'list';
      state.messageGroupSidebarOpen = false;
      render();
      requestAnimationFrame(() => document.querySelector('#sidebar-chat-search-trigger, [data-message-default-page] button')?.focus?.({ preventScroll: true }));
      return;
    }
    state.chatGroupId = '';
    state.chatGroupDetail = null;
    state.collaborationGroupId = '';
    state.collaborationGroupDetail = null;
    state.networkMessageHomeOpen = true;
    state.messageActivePane = 'list';
    render();
  });
  document.querySelectorAll('[data-message-default-variant]').forEach((button) => button.addEventListener('click', () => {
    state.messageDefaultVariantIndex = Number(button.dataset.messageDefaultVariant || 0) % 3;
    render();
  }));
  document.querySelectorAll('[data-message-default-step]').forEach((button) => button.addEventListener('click', () => {
    stepMessageDefaultVariant(button.dataset.messageDefaultStep || 'next');
  }));
  document.querySelector('[data-message-default-order-toggle]')?.addEventListener('click', () => {
    state.messageDefaultOrderEditorOpen = !state.messageDefaultOrderEditorOpen;
    render();
  });
  document.querySelector('[data-message-default-order-reset]')?.addEventListener('click', () => {
    persistMessageDefaultVariantOrder([0, 1, 2]);
    state.messageDefaultVariantIndex = 0;
    state.messageDefaultOrderEditorOpen = false;
    render();
  });
  document.querySelectorAll('[data-message-default-order-item]').forEach((item) => {
    item.addEventListener('dragstart', (event) => {
      messageDefaultDraggedVariantId = Number(item.dataset.messageDefaultOrderItem);
      messageDefaultDragMoved = false;
      item.classList.add('is-dragging');
      event.dataTransfer?.setData('text/plain', String(messageDefaultDraggedVariantId));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      messageDefaultDragMoved = true;
      item.classList.add('is-drag-over');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    item.addEventListener('dragleave', () => item.classList.remove('is-drag-over'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      const sourceId = Number.isInteger(messageDefaultDraggedVariantId)
        ? messageDefaultDraggedVariantId
        : Number(event.dataTransfer?.getData('text/plain'));
      const targetId = Number(item.dataset.messageDefaultOrderItem);
      const order = messageDefaultVariantOrder();
      if (!order.includes(sourceId) || !order.includes(targetId) || sourceId === targetId) return;
      const next = reorderMessageDefaultVariants(order, sourceId, targetId);
      persistMessageDefaultVariantOrder(next);
      messageDefaultDraggedVariantId = -1;
      render();
      setTimeout(() => { messageDefaultDragMoved = false; }, 0);
    });
    item.addEventListener('dragend', () => {
      messageDefaultDraggedVariantId = -1;
      document.querySelectorAll('.message-default-order-item').forEach((candidate) => candidate.classList.remove('is-dragging', 'is-drag-over'));
    });
    item.addEventListener('click', () => {
      if (messageDefaultDragMoved) {
        messageDefaultDragMoved = false;
        return;
      }
      state.messageDefaultVariantIndex = Number(item.dataset.messageDefaultOrderSelect || 0) % 3;
      render();
    });
  });
  document.querySelector('[data-message-default-action="talent-market"]')?.addEventListener('click', () => {
    openTalentMarketFromMessageDefault();
  });
  document.querySelector('[data-message-default-action="ubuddy"]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    if (messageDefaultRotationTimer) clearTimeout(messageDefaultRotationTimer);
    messageDefaultRotationTimer = null;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = translateUiText('正在打开 uBuddy…', state.languageMode);
    const sessionId = await openUBuddyConversation();
    if (!sessionId && button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = translateUiText('找 uBuddy 整理', state.languageMode);
      syncMessageDefaultRotation();
    }
  });
  document.querySelector('#refresh-btn')?.addEventListener('click', refreshAll);
  document.querySelector('#doctor-btn')?.addEventListener('click', runDoctor);
  document.querySelector('#check-all-updates-btn')?.addEventListener('click', checkAllUpdates);
  document.querySelector('#download-update-btn')?.addEventListener('click', downloadUpdate);
  document.querySelector('#install-update-btn')?.addEventListener('click', installUpdate);
  document.querySelectorAll('[data-update-changelog-open]').forEach((button) => button.addEventListener('click', () => {
    openUpdateChangelog(button.dataset.updateChangelogOpen || '');
  }));
  document.querySelectorAll('[data-update-announcement-auto-popup]').forEach((input) => input.addEventListener('change', () => {
    state.updateAnnouncementAutoPopup = input.checked;
    persistUpdateAnnouncementPreferences();
  }));
  document.querySelector('[data-update-announcement-dismiss]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    acknowledgeUpdateAnnouncement();
    state.updateAnnouncementDialog = null;
    render();
  });
  document.querySelectorAll('[data-update-announcement-close]').forEach((button) => button.addEventListener('click', () => {
    acknowledgeUpdateAnnouncement();
    state.updateAnnouncementDialog = null;
    render();
  }));
  document.querySelector('[data-update-announcement-details]')?.addEventListener('click', () => {
    if (!state.updateAnnouncementDialog) return;
    state.updateAnnouncementDialog = { ...state.updateAnnouncementDialog, detail: true };
    render();
  });
  document.querySelector('[data-update-announcement-summary]')?.addEventListener('click', () => {
    if (!state.updateAnnouncementDialog) return;
    state.updateAnnouncementDialog = { ...state.updateAnnouncementDialog, detail: false };
    render();
  });
  document.querySelector('[data-update-announcement-download]')?.addEventListener('click', downloadUpdate);
  document.querySelector('[data-update-announcement-install]')?.addEventListener('click', installUpdate);
  document.querySelector('#refresh-release-btn')?.addEventListener('click', () => refreshReleaseStatus());
  document.querySelectorAll('[data-department]').forEach((btn) => {
    btn.addEventListener('click', () => selectDepartment(btn.dataset.department));
  });
  document.querySelectorAll('[data-session-menu]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleSessionMenu(btn);
    });
  });
  document.querySelectorAll('[data-session-action]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleSessionAction(btn.dataset.sessionId, btn.dataset.sessionAction);
    });
  });
  document.querySelector('#account-card')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nextOpen = !state.accountMenuOpen;
    state.accountMenuOpen = nextOpen;
    state.accountMenuWorkspaceOpen = false;
    state.accountMenuWorkspaceMoreOpen = false;
    state.accountWorkspaceMenuOpen = false;
    render();
  });
  document.querySelector('#account-card')?.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    const nextOpen = !state.accountMenuOpen;
    state.accountMenuOpen = nextOpen;
    state.accountMenuWorkspaceOpen = false;
    state.accountMenuWorkspaceMoreOpen = false;
    state.accountWorkspaceMenuOpen = false;
    render();
  });
  document.querySelector('[data-account-workspace-account-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.workspaceSwitchBusy) return;
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = !state.accountMenuWorkspaceOpen;
    state.accountMenuWorkspaceMoreOpen = false;
    render();
  });
  document.querySelector('[data-account-workspace-more-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.workspaceSwitchBusy) return;
    state.accountMenuWorkspaceMoreOpen = !state.accountMenuWorkspaceMoreOpen;
    render();
  });
  document.querySelectorAll('[data-account-menu-action]').forEach((btn) => {
    btn.addEventListener('click', handleAccountMenuActionClick);
  });
  document.querySelector('[data-account-update]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    handleAccountUpdateClick();
  });
  document.querySelector('#department-select')?.addEventListener('change', (event) => selectDepartment(event.target.value));
  document.querySelector('#agent-select')?.addEventListener('change', (event) => {
    state.homeMode = 'department';
    state.currentAgentId = event.target.value;
    const selected = state.org.agents.find((agent) => agent.id === state.currentAgentId);
    state.currentDepartmentId = selected?.departmentId || state.currentDepartmentId;
    state.selectionSource = null;
    render();
  });
  document.querySelector('#sidebar-chat-search-trigger')?.addEventListener('click', openChatSearch);
  document.querySelectorAll('[data-friend-directory-view]').forEach((btn) => {
    btn.addEventListener('click', () => showFriendDirectoryView(btn.dataset.friendDirectoryView || 'contacts'));
  });
  document.querySelectorAll('[data-friend-directory-category]').forEach((btn) => {
    btn.addEventListener('click', () => showFriendDirectoryCategory(btn.dataset.friendDirectoryCategory || 'internal'));
  });
  document.querySelectorAll('[data-contact-group-tab]').forEach((button) => button.addEventListener('click', () => {
    state.contactGroupDirectoryTab = button.dataset.contactGroupTab === 'work' ? 'work' : 'contact';
    render();
  }));
  document.querySelectorAll('[data-contacts-pane]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.contactsActivePane = ['directory', 'contacts', 'employees'].includes(btn.dataset.contactsPane)
        ? btn.dataset.contactsPane
        : 'contacts';
      render();
      if (state.contactsActivePane === 'employees' && !state.employeeOverview) refreshEmployeeOverview();
      requestAnimationFrame(() => {
        const target = state.contactsActivePane === 'directory'
          ? document.querySelector('#friend-search-query')
          : state.contactsActivePane === 'employees'
            ? document.querySelector('[data-contacts-employee-card]')
            : document.querySelector('.contacts-list-pane button, .contacts-list-pane input');
        target?.focus?.({ preventScroll: true });
      });
    });
  });
  document.querySelectorAll('[data-friends-refresh]').forEach((btn) => {
    btn.addEventListener('click', () => refreshFriends());
  });
  document.querySelectorAll('[data-network-session]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      employeeChatOpenRequestId += 1;
      if (btn.matches('[data-conversation-search-text]')) resetNetworkMessageSearch({ close: true });
      state.networkConversationPeerId = '';
      state.networkConversationGroupId = '';
      state.networkConversationMessages = [];
      state.networkConversationBusy = false;
      state.networkDelegationId = '';
      state.collaborationGroupId = '';
      state.collaborationGroupDetail = null;
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      clearAgentRunNotices({ sessionId: btn.dataset.networkSession || '' });
      await openSession(btn.dataset.networkSession || '', { preserveNetworkPanel: true });
    });
  });
  document.querySelectorAll('[data-agent-inbox]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      followerController.close();
      preserveCurrentComposerDraft();
      if (btn.matches('[data-conversation-search-text]')) resetNetworkMessageSearch({ close: true });
      const personalAssistant = btn.dataset.agentInboxKind === 'assistant';
      const agentId = btn.dataset.agentInbox || '';
      const agentInstanceId = btn.dataset.agentInboxInstance || '';
      const departmentId = btn.dataset.agentInboxDepartment || '';
      const runChannelId = btn.dataset.agentInboxRun || '';
      const activeRun = !personalAssistant
        ? allChatRuns()
          .filter((run) => (
            (!run.terminal || run.unreadNotice)
            && !run.nonBlocking
            && run.agentId === agentId
            && (!agentInstanceId || (run.agentInstanceId || run.agent_instance_id || '') === agentInstanceId)
            && (!runChannelId || run.channelId === runChannelId)
          ))
          .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))[0] || null
        : null;
      clearAgentRunNotices({ agentId, agentInstanceId });
      const activeRunSessionId = activeRun?.displaySessionId || activeRun?.sessionId || '';
      if (activeRunSessionId) {
        upsertRecentSession({
          id: activeRunSessionId,
          title: activeRun.sessionTitle || activeRun.userMessage || 'New chat',
          departmentId: activeRun.departmentId || departmentId,
          agentId: activeRun.agentId || agentId,
          agentInstanceId: activeRun.agentInstanceId || '',
          projectId: activeRun.projectId || '',
          workspaceRoot: activeRun.workspaceRoot || '',
          interactionMode: activeRun.interactionMode || '',
          updatedAt: new Date().toISOString(),
          pending: true,
        });
        state.networkPanelOpen = true;
        state.networkPanelView = 'messages';
        await openSession(activeRunSessionId, { preserveNetworkPanel: true });
        return;
      }
      if (activeRun) {
        clearSocialChatSelection();
        state.networkMessageHomeOpen = false;
        state.messageActivePane = 'conversation';
        state.currentTab = 'chat';
        state.currentSessionId = '';
        state.currentChatKey = activeRun.chatKey;
        state.messages = [];
        state.attachments = [];
        state.contextUsage = null;
        state.homeMode = 'department';
        state.currentDepartmentId = activeRun.departmentId || departmentId;
        state.currentAgentId = activeRun.agentId || agentId;
        state.currentAgentInstanceId = activeRun.agentInstanceId || agentInstanceId || '';
        restoreAgentConversationDraft(state.currentAgentInstanceId);
        state.selectionSource = state.currentAgentInstanceId ? 'employee' : null;
        state.activeProjectId = activeRun.projectId || '';
        state.workspaceRoot = activeRun.workspaceRoot || '';
        state.workspaceDetached = false;
        state.interactionMode = activeRun.interactionMode || '';
        state.networkPanelOpen = true;
        state.networkPanelView = 'messages';
        syncCurrentChatRun();
        restoreActiveRunTransient();
        render();
        setTimeout(() => focusChatInputAtEnd(), 0);
        return;
      }
      if (agentInstanceId) {
        await openEmployeeChat(agentInstanceId);
        return;
      }
      state.networkMessageHomeOpen = false;
      state.messageActivePane = 'conversation';
      startNewPlainChat({ renderNow: false, focus: false });
      state.currentTab = 'chat';
      state.homeMode = personalAssistant ? 'private_assistant' : 'department';
      state.currentDepartmentId = personalAssistant ? '' : departmentId;
      state.currentAgentId = personalAssistant ? '' : agentId;
      state.selectionSource = null;
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      state.networkDelegationId = '';
      state.collaborationGroupId = '';
      state.collaborationGroupDetail = null;
      render();
      setTimeout(() => focusChatInputAtEnd(), 0);
    });
  });
  document.querySelectorAll('[data-contact-profile]').forEach((btn) => {
    const nextContactId = btn.dataset.contactProfile || '';
    btn.addEventListener('click', () => {
      if (!nextContactId) return;
      if (contactsContactClickTimer) clearTimeout(contactsContactClickTimer);
      contactsContactClickTimer = setTimeout(() => {
        contactsContactClickTimer = null;
        const switchingContact = state.networkContactProfileOpen
          && Boolean(state.networkSelectedContactId)
          && state.networkSelectedContactId !== nextContactId;
        const applyContact = () => {
          state.networkGroupProfileOpen = false;
          state.networkSelectedGroupId = '';
          state.networkSelectedGroupKind = '';
          state.groupDirectoryProfileDetail = null;
          state.networkSelectedContactId = nextContactId;
          state.networkSelectedContactOrganizationId = btn.dataset.organizationMember || '';
          state.networkContactProfileOpen = true;
        };
        if (switchingContact) {
          renderContactProfileTransition(applyContact).then(() => loadContactUBuddyCapabilityProfile(nextContactId));
        }
        else {
          applyContact();
          render();
          void loadContactUBuddyCapabilityProfile(nextContactId);
        }
      }, 220);
    });
    btn.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (!nextContactId) return;
      if (contactsContactClickTimer) clearTimeout(contactsContactClickTimer);
      contactsContactClickTimer = null;
      state.networkContactProfileOpen = false;
      state.networkSelectedContactId = '';
      state.networkSelectedContactOrganizationId = '';
      void openNetworkConversation(nextContactId, 'person');
    });
  });
  document.querySelectorAll('[data-contact-star-toggle]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleContactStar(button.dataset.contactStarToggle || '');
    });
  });
  document.querySelectorAll('[data-organization-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.contactsSelectedOrganizationId = btn.dataset.organizationOpen || '';
      state.organizationSettingsWorkspaceMoreOpen = false;
      state.organizationSettingsWorkspaceMorePosition = null;
      state.networkContactProfileOpen = false;
      state.networkSelectedContactOrganizationId = '';
      render();
    });
  });
  document.querySelector('[data-organization-name-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveOrganizationName(event.currentTarget.dataset.organizationNameForm || '', document.querySelector('[data-organization-name-input]')?.value || '');
  });
  document.querySelector('[data-organization-name-input]')?.addEventListener('input', (event) => {
    const input = event.currentTarget;
    const size = Math.max(8, Math.min(24, Array.from(input.value || '').length + 2));
    state.organizationNameEditDraft = input.value || '';
    input.size = size;
    input.closest('.organization-name-edit-form')?.style.setProperty('--organization-name-edit-size', String(size));
  });
  document.querySelector('[data-organization-name-cancel]')?.addEventListener('click', cancelOrganizationNameEdit);
  document.querySelector('[data-organization-name-edit]')?.addEventListener('click', openOrganizationNameEdit);
  document.querySelector('[data-organization-name-dblclick]')?.addEventListener('dblclick', openOrganizationNameEdit);
  document.querySelectorAll('[data-organization-switch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.contactsSelectedOrganizationId = btn.dataset.organizationSwitch || '';
      state.organizationSettingsWorkspaceMoreOpen = false;
      state.organizationSettingsWorkspaceMorePosition = null;
      state.networkContactProfileOpen = false;
      state.networkSelectedContactOrganizationId = '';
      render();
    });
  });
  document.querySelector('[data-organization-settings-workspace-more-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    if (state.organizationSettingsWorkspaceMoreOpen) {
      state.organizationSettingsWorkspaceMoreOpen = false;
      state.organizationSettingsWorkspaceMorePosition = null;
      render();
      return;
    }
    const rect = button.getBoundingClientRect();
    const itemCount = Number(button.dataset.organizationSettingsWorkspaceMoreCount || 0);
    const submenuHeight = Math.min(360, 38 + itemCount * 48 + 12);
    state.organizationSettingsWorkspaceMorePosition = {
      left: Math.max(12, Math.min(window.innerWidth - 232, rect.right + 8)),
      top: Math.max(48, Math.min(window.innerHeight - submenuHeight - 12, rect.bottom - submenuHeight)),
    };
    state.organizationSettingsWorkspaceMoreOpen = true;
    render();
  });
  document.querySelectorAll('[data-organization-set-default]').forEach((button) => {
    button.addEventListener('click', () => setStartupOrganizationWorkspace(button.dataset.organizationSetDefault || ''));
  });
  document.querySelectorAll('.organization-help').forEach((help) => {
    help.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    help.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
    });
  });
  document.querySelectorAll('[data-contact-profile-close]').forEach((target) => {
    target.addEventListener('click', (event) => {
      if (event.target.closest('[data-contact-profile-dialog]') && !event.target.closest('[data-contact-profile-close]:not(.contact-profile-scrim)')) return;
      state.networkContactProfileOpen = false;
      state.networkSelectedContactId = '';
      state.networkSelectedContactOrganizationId = '';
      render();
    });
  });
  document.querySelectorAll('[data-voice-call-start], [data-contact-profile-call]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const peerId = String(button.dataset.voiceCallStart || button.dataset.contactProfileCall || '').trim();
      if (!peerId) return;
      state.networkContactProfileOpen = false;
      state.networkSelectedContactId = '';
      state.networkSelectedContactOrganizationId = '';
      if (state.networkConversationPeerId !== peerId || state.networkConversationMode !== 'person') {
        void openNetworkConversation(peerId, 'person').then(() => startVoiceCall(peerId));
      } else startVoiceCall(peerId);
    });
  });
  document.querySelectorAll('[data-video-room-start]').forEach((button) => button.addEventListener('click', () => { void startVideoRoom(button.dataset.videoRoomStart || '', button.dataset.videoRoomGroupId || ''); }));
  document.querySelectorAll('[data-voice-call-end]').forEach((button) => button.addEventListener('click', endVoiceCall));
  document.querySelectorAll('[data-voice-call-minimize]').forEach((button) => button.addEventListener('click', toggleVoiceCallMinimize));
  document.querySelectorAll('[data-voice-call-maximize]').forEach((button) => button.addEventListener('click', toggleVoiceCallMaximize));
  document.querySelectorAll('[data-voice-call-answer]').forEach((button) => button.addEventListener('click', answerVoiceCall));
  document.querySelectorAll('[data-voice-call-mute]').forEach((button) => button.addEventListener('click', toggleVoiceCallMute));
  document.querySelectorAll('[data-voice-call-speaker]').forEach((button) => button.addEventListener('click', toggleVoiceCallSpeaker));
  document.querySelectorAll('[data-voice-call-share]').forEach((button) => button.addEventListener('click', toggleVoiceCallShare));
  document.querySelectorAll('[data-voice-call-members]').forEach((button) => button.addEventListener('click', showVoiceCallMembers));
  document.querySelectorAll('[data-voice-call-more]').forEach((button) => button.addEventListener('click', showVoiceCallMore));

  document.querySelectorAll('[data-contact-profile-message]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const peerId = String(button.dataset.contactProfileMessage || '').trim();
      if (!peerId) return;
      state.networkContactProfileOpen = false;
      state.networkSelectedContactId = '';
      state.networkSelectedContactOrganizationId = '';
      void openNetworkConversation(peerId, 'person');
    });
  });
  document.querySelectorAll('[data-avatar-viewer-user]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const userId = String(button.dataset.avatarViewerUser || '').trim();
      const relationship = directoryContactByUserId(userId);
      const user = userId === String(state.currentUser?.id || '')
        ? state.currentUser
        : relationship?.friend || relationship?.user || null;
      if (!user) return;
      openAvatarViewer({
        avatarUrl: user.avatarUrl || user.avatar_url || '',
        displayName: user.remark || user.displayName || user.display_name || user.username || user.email || '联系人',
      });
    });
  });
  document.querySelectorAll('[data-network-peer]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      followerController.close();
      employeeChatOpenRequestId += 1;
      if (btn.matches('[data-conversation-search-text]')) resetNetworkMessageSearch({ close: true });
      const peerId = btn.dataset.networkPeer || '';
      if (btn.dataset.networkMode !== 'group') state.networkSelectedContactId = peerId;
      state.networkContactProfileOpen = false;
      if (peerId === 'self-secretary') {
        await openUBuddyConversation();
        return;
      }
      state.networkMessageHomeOpen = false;
      state.messageActivePane = 'conversation';
      if (peerId === 'self-private-assistant') {
        const sourceSurfaceKey = currentRendererMessageSurfaceKey();
        const activeRun = allChatRuns().find((run) => (
          (run.targetKind === 'private_assistant' || run.departmentId === 'private_assistant') && !run.terminal
        )) || null;
        const activeRunSessionId = activeRun?.displaySessionId || activeRun?.sessionId || '';
        if (activeRun && !activeRunSessionId) {
          preserveCurrentComposerDraft();
          state.privateAssistantResultUnread = false;
          state.currentTab = 'chat';
          state.currentSessionId = '';
          state.currentChatKey = activeRun.chatKey;
          state.messages = [];
          state.homeMode = 'private_assistant';
          state.currentDepartmentId = '';
          state.currentAgentId = '';
          state.currentAgentInstanceId = '';
          state.interactionMode = '';
          state.networkPanelOpen = true;
          state.networkPanelView = 'messages';
          restoreComposerDraft('private-assistant');
          syncCurrentChatRun();
          restoreActiveRunTransient();
          render();
          setTimeout(() => focusChatInputAtEnd(), 0);
          return;
        }
        const existing = (state.sessions || []).find((session) => session.departmentId === 'private_assistant' && session.status !== 'deleted');
        try {
          const session = await window.janus.ensurePrivateAssistantSession({
            sessionId: activeRunSessionId || existing?.id || '',
          });
          if (currentRendererMessageSurfaceKey() !== sourceSurfaceKey) return;
          if (!session?.id) throw new Error('私人助理会话创建失败。');
          state.privateAssistantResultUnread = false;
          upsertRecentSession(session);
          await openSession(session.id, { preserveNetworkPanel: true });
        } catch (error) {
          if (currentRendererMessageSurfaceKey() !== sourceSurfaceKey) return;
          notify(`打开私人助理失败：${userVisibleErrorMessage(error)}`, 'error');
          render();
        }
        return;
      }
      openNetworkConversation(peerId, btn.dataset.networkMode || 'person', btn.dataset.networkGroup || '');
    });
  });
  document.querySelectorAll('.network-friend-menu').forEach((menu) => {
    menu.addEventListener('toggle', () => placeNetworkFriendMenu(menu));
  });
  document.querySelectorAll('[data-collaboration-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      followerController.close();
      employeeChatOpenRequestId += 1;
      if (btn.matches('[data-conversation-search-text]')) resetNetworkMessageSearch({ close: true });
      state.networkMessageHomeOpen = false;
      state.messageActivePane = 'conversation';
      openCollaborationGroup(btn.dataset.collaborationGroup || '');
    });
  });
  document.querySelectorAll('[data-confirm-multi-task]').forEach((button) => {
    button.addEventListener('click', async () => {
      const commandId = String(button.dataset.confirmMultiTask || '').trim();
      if (!commandId || button.disabled) return;
      button.disabled = true;
      try {
        await window.janus.dispatchCollaborationCommand({ confirmationCommandId: commandId });
        notify('已确认操作范围，uBuddy 正在后台生成多人分工。', 'success');
        await refreshSocialThreads(false);
      } catch (error) {
        notify(`确认多人任务失败：${userVisibleErrorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
        render();
      }
    });
  });
  document.querySelectorAll('[data-chat-group]').forEach((button) => button.addEventListener('click', () => {
    employeeChatOpenRequestId += 1;
    if (button.matches('[data-conversation-search-text]')) resetNetworkMessageSearch({ close: true });
    openChatGroup(button.dataset.chatGroup || '');
  }));
  document.querySelectorAll('[data-contact-group-profile]').forEach((button) => {
    const groupId = button.dataset.contactGroupProfile || '';
    const kind = button.dataset.contactGroupKind === 'work' ? 'work' : 'contact';
    button.addEventListener('click', () => {
      if (contactsGroupClickTimer) clearTimeout(contactsGroupClickTimer);
      contactsGroupClickTimer = setTimeout(() => {
        contactsGroupClickTimer = null;
        openGroupDirectoryProfile(kind, groupId);
      }, 220);
    });
    button.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (contactsGroupClickTimer) clearTimeout(contactsGroupClickTimer);
      contactsGroupClickTimer = null;
      state.networkGroupProfileOpen = false;
      state.networkSelectedGroupId = '';
      state.networkSelectedGroupKind = '';
      state.groupDirectoryProfileDetail = null;
      if (kind === 'work') openCollaborationGroup(groupId);
      else openChatGroup(groupId);
    });
  });
  document.querySelectorAll('[data-group-profile-close]').forEach((target) => target.addEventListener('click', (event) => {
    if (event.currentTarget.classList.contains('group-profile-scrim') && event.target !== event.currentTarget) return;
    closeGroupDirectoryProfile();
  }));
  document.querySelectorAll('[data-group-profile-message]').forEach((button) => button.addEventListener('click', () => {
    const groupId = button.dataset.groupProfileMessage || '';
    const kind = button.dataset.groupKind === 'work' ? 'work' : 'contact';
    closeGroupDirectoryProfile();
    if (kind === 'work') openCollaborationGroup(groupId);
    else openChatGroup(groupId);
  }));
  document.querySelectorAll('[data-group-star-toggle]').forEach((button) => button.addEventListener('click', () => {
    toggleGroupStar(button.dataset.groupKind || '', button.dataset.groupStarToggle || '');
  }));
  document.querySelectorAll('[data-group-remark]').forEach((button) => button.addEventListener('click', () => {
    updateGroupRemark(button.dataset.groupKind || '', button.dataset.groupRemark || '', button.dataset.groupTitle || '');
  }));
  document.querySelectorAll('[data-group-display-name]').forEach((button) => button.addEventListener('click', () => {
    openGroupDisplayName(button.dataset.groupKind || '', button.dataset.groupDisplayName || '', button.dataset.currentDisplayName || '');
  }));
  document.querySelectorAll('[data-contact-group-ubuddy]').forEach((button) => button.addEventListener('click', async () => {
    state.networkGroupProfileOpen = false;
    state.networkSelectedGroupId = '';
    state.networkSelectedGroupKind = '';
    state.groupDirectoryProfileDetail = null;
    await openUBuddyConversation();
  }));
  document.querySelectorAll('[data-chat-group-create-open]').forEach((button) => button.addEventListener('click', () => {
    const targetUserId = String(button.dataset.chatGroupCreateTarget || '').trim();
    state.contactDirectoryContextMenu = null;
    state.chatGroupCreateOpen = true;
    state.chatGroupCreateTitle = '';
    state.chatGroupCreateMemberIds = targetUserId ? [targetUserId] : [];
    state.chatGroupCreateLastMemberId = targetUserId;
    render();
    if (targetUserId) requestAnimationFrame(() => [...document.querySelectorAll('[data-chat-group-create-member-row]')]
      .find((row) => row.dataset.chatGroupCreateMemberRow === targetUserId)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }));
  document.querySelectorAll('[data-chat-group-create-close]').forEach((button) => button.addEventListener('click', closeChatGroupCreateDialog));
  document.querySelector('[data-chat-group-create-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeChatGroupCreateDialog();
  });
  document.querySelector('#chat-group-create-name')?.addEventListener('input', (event) => { state.chatGroupCreateTitle = event.target.value || ''; });
  const chatGroupCreateMemberInputs = [...document.querySelectorAll('[data-chat-group-create-member]')];
  const chatGroupCreateSelectAll = document.querySelector('[data-chat-group-create-select-all]');
  if (chatGroupCreateSelectAll) {
    const selectedCount = chatGroupCreateMemberInputs.filter((input) => input.checked).length;
    chatGroupCreateSelectAll.indeterminate = selectedCount > 0 && selectedCount < chatGroupCreateMemberInputs.length;
    chatGroupCreateSelectAll.addEventListener('change', () => {
      state.chatGroupCreateMemberIds = chatGroupCreateSelectAll.checked
        ? chatGroupCreateMemberInputs.map((input) => input.value)
        : [];
      state.chatGroupCreateLastMemberId = '';
      render();
    });
  }
  chatGroupCreateMemberInputs.forEach((input) => input.addEventListener('click', (event) => {
    state.chatGroupCreateMemberIds = updateChatGroupMemberSelection({
      memberIds: chatGroupCreateMemberInputs.map((item) => item.value),
      selectedIds: state.chatGroupCreateMemberIds,
      anchorId: state.chatGroupCreateLastMemberId,
      currentId: input.value,
      checked: input.checked,
      shiftKey: event.shiftKey,
    });
    state.chatGroupCreateLastMemberId = input.value;
    render();
  }));
  document.querySelector('[data-chat-group-create-form]')?.addEventListener('submit', submitChatGroupCreate);
  document.querySelectorAll('[data-chat-group-detail-open]').forEach((button) => button.addEventListener('click', () => {
    openGroupDirectoryProfile('contact', button.dataset.chatGroupDetailOpen || state.chatGroupId || '');
  }));
  document.querySelectorAll('[data-chat-avatar-profile]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const userId = String(button.dataset.chatAvatarProfile || '').trim();
    if (!userId || userId === String(state.currentUser?.id || '')) return;
    const rect = button.getBoundingClientRect();
    const popoverWidth = 272;
    const popoverHeight = 190;
    const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
    const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
    const rightSideLeft = rect.right + 10;
    const left = rightSideLeft + popoverWidth <= viewportWidth - 8
      ? rightSideLeft
      : Math.max(8, rect.left - popoverWidth - 10);
    const top = Math.min(Math.max(8, rect.top - 12), Math.max(8, viewportHeight - popoverHeight - 8));
    state.chatAvatarProfile = {
      userId,
      context: button.dataset.chatAvatarProfileContext === 'group' ? 'group' : 'direct',
      left: Math.round(left),
      top: Math.round(top),
    };
    render();
    requestAnimationFrame(() => {
      const popover = document.querySelector('[data-chat-avatar-profile-popover]');
      if (!popover) return;
      const bounds = popover.getBoundingClientRect();
      const safeWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
      const safeHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
      if (bounds.right > safeWidth - 8) popover.style.left = `${Math.max(8, safeWidth - bounds.width - 8)}px`;
      if (bounds.bottom > safeHeight - 8) popover.style.top = `${Math.max(8, safeHeight - bounds.height - 8)}px`;
      popover.querySelector('[data-chat-avatar-profile-close]')?.focus?.({ preventScroll: true });
    });
  }));
  document.querySelectorAll('[data-chat-avatar-profile-close]').forEach((target) => target.addEventListener('click', (event) => {
    if (target.classList.contains('chat-avatar-profile-layer') && event.target !== target) return;
    event.preventDefault();
    event.stopPropagation();
    closeChatAvatarProfile();
  }));
  document.querySelectorAll('[data-message-receipt]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const messageId = String(button.dataset.messageReceipt || '').trim();
    const direct = button.dataset.messageReceiptKind === 'direct';
    const messages = direct ? state.networkConversationMessages || [] : state.chatGroupDetail?.messages || [];
    const message = messages.find((item) => String(item.id || '') === messageId);
    if (!message) return;
    let details = Array.isArray(message.receiptDetails) ? message.receiptDetails : [];
    if (direct) {
      const peerId = String(message.recipientUserId || message.recipient_user_id || state.networkConversationPeerId || '').trim();
      const relationship = (state.friendOverview?.friends || []).find((item) => String(item?.friend?.id || item?.user?.id || '') === peerId);
      const user = relationship?.friend || relationship?.user || { id: peerId };
      const readAt = message.readAt || message.read_at || '';
      details = [{ userId: peerId, user, read: message.status === 'read' || Boolean(readAt), readAt }];
    }
    const anchor = button.getBoundingClientRect();
    state.messageReceiptPopover = { messageId, details, left: anchor.left, top: anchor.bottom + 8, placement: 'auto' };
    render();
    requestAnimationFrame(() => positionMessageReceiptPopover(anchor));
  }));
  document.querySelector('[data-message-receipt-close]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    state.messageReceiptPopover = null;
    render();
  });
  document.querySelector('[data-message-receipt-popover]')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    state.messageReceiptPopover = null;
    render();
  });
  document.querySelector('[data-message-reaction-popover]')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeMessageReactionPicker();
    render();
  });
  document.querySelector('[data-message-reaction-close]')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-message-reaction-popover]')) return;
    closeMessageReactionPicker();
    render();
  });
  document.querySelectorAll('[data-message-reaction-picker]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = button.getBoundingClientRect();
    state.messageReactionPicker = {
      messageId: String(button.dataset.messageReactionPicker || '').trim(),
      kind: button.dataset.messageReactionKind || 'direct',
      groupId: button.dataset.messageReactionGroup || '',
      workspaceId: button.dataset.messageReactionWorkspaceId || '',
      left: rect.left,
      top: rect.bottom + 8,
    };
    state.messageContextMenu = null;
    render();
    requestAnimationFrame(() => document.querySelector('[data-message-reaction-popover]')?.focus({ preventScroll: true }));
  }));
  document.querySelectorAll('[data-message-reaction-option]').forEach((button) => button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const messageId = String(button.dataset.messageReactionOption || '').trim();
    const emoji = String(button.dataset.messageReactionEmoji || '').trim();
    const kind = button.dataset.messageReactionKind || 'direct';
    const groupId = String(button.dataset.messageReactionGroup || '').trim();
    const workspaceId = String(button.dataset.messageReactionWorkspaceId || '').trim();
    const rollbackReaction = applyOptimisticMessageReaction({ kind, messageId, emoji });
    closeMessageReactionPicker();
    state.messageContextMenu = null;
    render();
    try {
      if (kind === 'group') {
        state.chatGroupDetail = await window.janus.updateChatGroup({ groupId: state.chatGroupId || groupId, action: 'toggle_reaction', messageId, emoji, clientRequestId: globalThis.crypto?.randomUUID?.() || `chat_group_reaction_${Date.now()}` });
        await refreshChatGroupsOverview({ silent: true });
      } else {
        const result = await window.janus.toggleSocialMessageReaction({ messageId, emoji, workspaceId });
        if (result?.message) {
          const updated = result.message;
          state.networkConversationMessages = (state.networkConversationMessages || []).map((message) => String(message.id || '') === String(updated.id || '') ? updated : message);
          if (state.networkConversation?.message) state.networkConversation.message = updated;
        }
        if (window.janus.pollSocialNetwork) await window.janus.pollSocialNetwork({ autoProcess: false }).catch(() => null);
        await refreshSocialThreads(false);
      }
    } catch (error) {
      rollbackReaction();
      render();
      notify(userVisibleErrorMessage(error, translateUiText('表情回应失败。', state.languageMode)), 'error');
    }
  }));
  document.querySelectorAll('[data-message-reaction-toggle]').forEach((button) => button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const messageId = String(button.dataset.messageReactionToggle || '').trim();
    const emoji = String(button.dataset.messageReactionEmoji || '').trim();
    const kind = button.dataset.messageReactionKind || 'direct';
    const groupId = String(button.dataset.messageReactionGroup || '').trim();
    const rollbackReaction = applyOptimisticMessageReaction({ kind, messageId, emoji });
    render();
    const workspaceId = String(button.dataset.messageReactionWorkspaceId || '').trim();
    try {
      if (kind === 'group') {
        state.chatGroupDetail = await window.janus.updateChatGroup({ groupId: state.chatGroupId || groupId, action: 'toggle_reaction', messageId, emoji, clientRequestId: globalThis.crypto?.randomUUID?.() || `chat_group_reaction_${Date.now()}` });
        await refreshChatGroupsOverview({ silent: true });
      } else {
        const result = await window.janus.toggleSocialMessageReaction({ messageId, emoji, workspaceId });
        if (result?.message) {
          const updated = result.message;
          state.networkConversationMessages = (state.networkConversationMessages || []).map((message) => String(message.id || '') === String(updated.id || '') ? updated : message);
        }
        await refreshSocialThreads(false);
      }
      render();
    } catch (error) {
      rollbackReaction();
      render();
      notify(userVisibleErrorMessage(error, translateUiText('表情回应失败。', state.languageMode)), 'error');
    }
  }));
  wireVisibleChatGroupReadReceipt();
  document.querySelector('[data-chat-avatar-profile-popover]')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeChatAvatarProfile();
  });
  document.querySelectorAll('[data-chat-avatar-profile-message]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const peerId = String(button.dataset.chatAvatarProfileMessage || '').trim();
    if (!peerId) return;
    state.chatAvatarProfile = null;
    void openNetworkConversation(peerId, 'person');
  }));
  document.querySelectorAll('[data-chat-group-invite-open]').forEach((button) => button.addEventListener('click', () => openChatGroupInvite(button.dataset.chatGroupId || '')));
  document.querySelectorAll('[data-chat-group-invite-close]').forEach((target) => target.addEventListener('click', closeChatGroupInvite));
  document.querySelectorAll('[data-chat-group-invite-user]').forEach((input) => input.addEventListener('change', () => {
    state.chatGroupInviteUserId = input.checked ? input.value : '';
    render();
  }));
  document.querySelector('[data-chat-group-invite-form]')?.addEventListener('submit', submitChatGroupInvite);
  document.querySelectorAll('[data-chat-group-rename]').forEach((button) => button.addEventListener('click', () => {
    const groupId = button.dataset.chatGroupId || state.chatGroupId || state.networkSelectedGroupId || '';
    openChatGroupRename(groupId);
  }));
  document.querySelectorAll('[data-chat-group-dissolve]').forEach((button) => button.addEventListener('click', async () => {
    const groupId = button.dataset.chatGroupId || state.chatGroupId || state.networkSelectedGroupId || '';
    if (window.confirm('解散后将不能继续发送消息，确定解散吗？')) await updateChatGroupById(groupId, 'dissolve');
  }));
  document.querySelectorAll('[data-chat-group-leave]').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('确定退出该群聊吗？')) return;
    const groupId = button.dataset.chatGroupId || state.chatGroupId || state.networkSelectedGroupId || '';
    await updateChatGroupById(groupId, 'leave');
    if (state.chatGroupId === groupId) {
      state.chatGroupId = '';
      state.chatGroupDetail = null;
      state.networkMessageHomeOpen = true;
      state.messageActivePane = 'list';
    }
    if (state.networkSelectedGroupId === groupId) closeGroupDirectoryProfile();
    render();
  }));
  document.querySelector('[data-collaboration-group-close]')?.addEventListener('click', closeCollaborationGroup);
  document.querySelector('[data-collaboration-group-add-member]')?.addEventListener('click', addCollaborationGroupMember);
  document.querySelector('[data-collaboration-group-workspace]')?.addEventListener('click', openCollaborationGroupWorkspace);
  document.querySelectorAll('[data-collaboration-mobile-pane]').forEach((button) => button.addEventListener('click', () => {
    const groupId = String(state.collaborationGroupId || '');
    const pane = button.dataset.collaborationMobilePane === 'progress' ? 'progress' : 'group';
    state.collaborationMobilePaneByGroupId = { ...(state.collaborationMobilePaneByGroupId || {}), [groupId]: pane };
    state.collaborationPaneByGroupId = { ...(state.collaborationPaneByGroupId || {}), [groupId]: pane };
    render();
  }));
  document.querySelector('[data-collaboration-details-toggle]')?.addEventListener('click', () => {
    const groupId = String(state.collaborationGroupId || '');
    const open = state.collaborationPaneByGroupId?.[groupId] === 'progress';
    state.collaborationPaneByGroupId = { ...(state.collaborationPaneByGroupId || {}), [groupId]: open ? 'group' : 'progress' };
    render();
  });
  document.querySelectorAll('[data-collaboration-details-close]').forEach((button) => button.addEventListener('click', () => {
    const groupId = String(state.collaborationGroupId || '');
    state.collaborationPaneByGroupId = { ...(state.collaborationPaneByGroupId || {}), [groupId]: 'group' };
    render();
    requestAnimationFrame(() => document.querySelector('[data-collaboration-details-toggle]')?.focus({ preventScroll: true }));
  }));
  document.querySelector('[data-collaboration-search-toggle]')?.addEventListener('click', () => {
    state.collaborationSearchOpen = !state.collaborationSearchOpen;
    if (state.collaborationSearchOpen) state.collaborationMembersOpen = false;
    if (!state.collaborationSearchOpen) {
      state.collaborationSearchQuery = '';
      state.collaborationSearchActiveIndex = 0;
    }
    render();
    if (state.collaborationSearchOpen) requestAnimationFrame(() => document.querySelector('#collaboration-search-input')?.focus({ preventScroll: true }));
  });
  document.querySelector('#collaboration-search-input')?.addEventListener('input', (event) => {
    state.collaborationSearchQuery = event.target.value || '';
    state.collaborationSearchActiveIndex = 0;
    render();
    requestAnimationFrame(() => {
      const input = document.querySelector('#collaboration-search-input');
      input?.focus({ preventScroll: true });
      input?.setSelectionRange?.(input.value.length, input.value.length);
    });
  });
  document.querySelector('#collaboration-search-input')?.addEventListener('keydown', (event) => {
    const results = [...document.querySelectorAll('[data-collaboration-search-result]')];
    if (event.key === 'Escape') {
      event.preventDefault();
      if (String(state.collaborationSearchQuery || '')) state.collaborationSearchQuery = '';
      else state.collaborationSearchOpen = false;
      state.collaborationSearchActiveIndex = 0;
      render();
      return;
    }
    if (!results.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Enter') {
      results[Math.max(0, Math.min(results.length - 1, Number(state.collaborationSearchActiveIndex || 0)))]?.click();
      return;
    }
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    state.collaborationSearchActiveIndex = (Number(state.collaborationSearchActiveIndex || 0) + direction + results.length) % results.length;
    render();
    requestAnimationFrame(() => document.querySelector('#collaboration-search-input')?.focus({ preventScroll: true }));
  });
  document.querySelector('[data-collaboration-members-toggle]')?.addEventListener('click', () => {
    state.collaborationMembersOpen = !state.collaborationMembersOpen;
    if (state.collaborationMembersOpen) {
      state.collaborationSearchOpen = false;
      state.collaborationSearchQuery = '';
      state.collaborationSearchActiveIndex = 0;
    }
    render();
    if (state.collaborationMembersOpen) requestAnimationFrame(() => document.querySelector('[data-collaboration-members-close]')?.focus({ preventScroll: true }));
  });
  document.querySelector('[data-collaboration-members-close]')?.addEventListener('click', () => {
    state.collaborationMembersOpen = false;
    render();
    requestAnimationFrame(() => document.querySelector('[data-collaboration-members-toggle]')?.focus({ preventScroll: true }));
  });
  document.querySelectorAll('[data-collaboration-search-result]').forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.collaborationSearchResult || '';
    const targetId = button.dataset.collaborationSearchTarget || '';
    if (kind === 'message') {
      const target = document.querySelector(`[data-message-id="${CSS.escape(targetId)}"]`);
      target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      target?.classList.add('is-collaboration-search-hit');
      setTimeout(() => target?.classList.remove('is-collaboration-search-hit'), 1800);
      return;
    }
    const groupId = String(state.collaborationGroupId || '');
    state.collaborationPaneByGroupId = { ...(state.collaborationPaneByGroupId || {}), [groupId]: 'progress' };
    state.collaborationMobilePaneByGroupId = { ...(state.collaborationMobilePaneByGroupId || {}), [groupId]: 'progress' };
    render();
    requestAnimationFrame(() => {
      const target = document.querySelector(`[data-collaboration-progress-task="${CSS.escape(targetId)}"]`);
      target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      target?.classList.add('is-collaboration-search-hit');
      setTimeout(() => target?.classList.remove('is-collaboration-search-hit'), 1800);
    });
  }));
  document.querySelector('[data-collaboration-review]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const taskId = String(button.dataset.collaborationReviewTask || '');
    const kind = button.dataset.collaborationReview || '';
    state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [taskId]: kind === 'result' ? 'result' : 'activity' };
    const taskButton = document.querySelector(`[data-collaboration-progress-task="${CSS.escape(taskId)}"] [data-task-card-action]`);
    if (taskButton) await handleTaskCardAction(taskButton);
  });
  document.querySelectorAll('[data-collaboration-add-member-cancel]').forEach((btn) => btn.addEventListener('click', closeCollaborationAddMemberPanel));
  document.querySelectorAll('[data-collaboration-add-member-user]').forEach((input) => input.addEventListener('change', (event) => {
    state.collaborationAddMemberUserId = event.target.value || '';
  }));
  document.querySelector('#collaboration-add-member-assignment')?.addEventListener('input', (event) => {
    state.collaborationAddMemberAssignment = event.target.value;
    autoResizeChatInput(event.target);
  });
  document.querySelectorAll('[data-collaboration-routing-target]').forEach((input) => {
    input.addEventListener('change', (event) => {
      if (!state.collaborationRoutingConfirmation) return;
      state.collaborationRoutingConfirmation = {
        ...state.collaborationRoutingConfirmation,
        selectedDelegationId: event.target.value || '',
      };
      render();
    });
  });
  document.querySelector('[data-collaboration-routing-confirm]')?.addEventListener('click', confirmCollaborationRoutingTarget);
  document.querySelector('[data-collaboration-routing-cancel]')?.addEventListener('click', cancelCollaborationRoutingConfirmation);
  document.querySelector('[data-collaboration-add-member-confirm]')?.addEventListener('click', confirmCollaborationGroupMember);
  document.querySelectorAll('[data-collaboration-group-remove-member]').forEach((btn) => {
    btn.addEventListener('click', () => removeCollaborationGroupMember(btn.dataset.collaborationGroupRemoveMember || ''));
  });
  document.querySelectorAll('[data-collaboration-task-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleCollaborationTaskAction(btn.dataset.delegationId || '', btn.dataset.collaborationTaskAction || ''));
  });
  document.querySelectorAll('[data-social-group-section]').forEach((btn) => {
    btn.addEventListener('click', () => toggleSocialGroupSection(btn.dataset.socialGroupSection || ''));
  });
  document.querySelectorAll('[data-directory-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.directorySection || '';
      if (!['requests', 'contacts'].includes(key)) return;
      const current = state.networkDirectorySectionsOpen?.[key] !== false;
      state.networkDirectorySectionsOpen = { ...(state.networkDirectorySectionsOpen || {}), [key]: !current };
      saveNetworkDirectorySectionsOpen(state.networkDirectorySectionsOpen);
      render();
    });
  });
  document.querySelectorAll('[data-network-ubuddy-target]').forEach((btn) => {
    btn.addEventListener('click', () => openUBuddyTaskForFriend(btn.dataset.networkUbuddyTarget || ''));
  });
  document.querySelectorAll('[data-contact-collaboration]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void openContactCollaborationInUBuddy(btn.dataset.contactCollaboration || state.networkSelectedContactId || '');
    });
  });
  document.querySelectorAll('[data-network-delegation]').forEach((btn) => {
    btn.addEventListener('click', () => openNetworkDelegation(btn.dataset.networkDelegation || ''));
  });
  document.querySelectorAll('[data-collaboration-task-progress]').forEach((details) => {
    details.addEventListener('toggle', () => {
      const taskId = details.dataset.collaborationTaskProgress || '';
      if (!taskId) return;
      state.collaborationGroupProgressOpenById = {
        ...(state.collaborationGroupProgressOpenById || {}),
        [taskId]: details.open,
      };
    });
  });
  document.querySelectorAll('[data-task-workspace-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const workspaceId = button.dataset.taskWorkspaceId || state.networkDelegationId || '';
      const view = button.dataset.taskWorkspaceView || 'activity';
      if (state.activeTaskWorkspaceKind === 'task_run') {
        state.taskResultSubmissionById = { ...(state.taskResultSubmissionById || {}), [workspaceId]: '' };
        state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [workspaceId]: view };
        renderPreservingTaskRunWorkspaceComposer();
      } else setTaskWorkspaceView(workspaceId, view);
    });
  });
  const taskWorkspaceBody = document.querySelector('.local-task-workspace-body');
  if (taskWorkspaceBody) {
    for (const eventName of ['wheel', 'touchmove', 'scroll']) {
      taskWorkspaceBody.addEventListener(eventName, noteTaskWorkspaceScrollInteraction, { passive: true });
    }
    taskWorkspaceBody.addEventListener('touchstart', beginTaskWorkspaceScrollInteraction, { passive: true });
    taskWorkspaceBody.addEventListener('pointerdown', beginTaskWorkspaceScrollInteraction, { passive: true });
    taskWorkspaceBody.addEventListener('pointermove', (event) => {
      if (event.buttons) noteTaskWorkspaceScrollInteraction();
    }, { passive: true });
    taskWorkspaceBody.closest('.local-task-workspace')?.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        noteTaskWorkspaceScrollInteraction();
      }
    });
  }
  document.querySelectorAll('.local-task-workspace [data-task-disclosure-key], .network-delegation-detail [data-task-disclosure-key]').forEach((details) => {
    details.addEventListener('toggle', () => {
      const key = String(details.dataset.taskDisclosureKey || '').trim();
      if (!key) return;
      state.taskDisclosureOpenByKey = {
        ...(state.taskDisclosureOpenByKey || {}),
        [key]: details.open,
      };
    });
  });
  const taskRunWorkspaceInput = document.querySelector('#task-run-workspace-input');
  taskRunWorkspaceInput?.addEventListener('input', (event) => {
    const taskRunId = state.activeTaskWorkspaceId || state.taskDetail?.id || '';
    state.taskRunWorkspaceDrafts = { ...(state.taskRunWorkspaceDrafts || {}), [taskRunId]: event.target.value };
    taskWorkspaceTypingUntil = Date.now() + TASK_WORKSPACE_TYPING_IDLE_MS;
    const send = document.querySelector('#task-run-workspace-form .send-btn');
    if (send) send.disabled = !String(event.target.value || '').trim();
  });
  document.querySelector('#task-run-workspace-form')?.addEventListener('submit', sendTaskRunWorkspaceMessage);
  document.querySelectorAll('[data-local-collaboration-task]').forEach((btn) => {
    btn.addEventListener('click', () => openCollaborationTask(btn.dataset.localCollaborationTask || ''));
  });
  document.querySelector('[data-network-conversation-back]')?.addEventListener('click', closeNetworkConversation);
  document.querySelector('[data-network-delegation-back]')?.addEventListener('click', closeNetworkConversation);
  document.querySelector('#network-conversation-form')?.addEventListener('submit', sendNetworkConversationMessage);
  document.querySelector('#network-conversation-input')?.addEventListener('input', (event) => {
    const key = networkConversationDraftKey(state.networkConversationPeerId, state.networkConversationPeerId === 'self-secretary' ? 'ubuddy' : state.networkConversationMode, state.networkConversationGroupId);
    state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [key]: event.target.value };
    persistComposerDrafts();
  });
  document.querySelector('#network-delegation-comment-input')?.addEventListener('input', (event) => {
    state.networkDelegationCommentDrafts = { ...(state.networkDelegationCommentDrafts || {}), [state.networkDelegationId]: event.target.value };
    const send = document.querySelector('#network-delegation-comment-form .send-btn');
    if (send) send.disabled = !String(event.target.value || '').trim() && !(state.attachments || []).length;
    persistComposerDrafts();
    autoResizeChatInput(event.target);
  });
  document.querySelector('#network-delegation-comment-input')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.target.closest('form')?.requestSubmit();
  });
  document.querySelector('#network-delegation-comment-form')?.addEventListener('submit', sendDelegationComment);
  document.querySelector('#work-digest-supplement-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector('[data-work-digest-supplement]');
    const delegationId = event.currentTarget.dataset.delegationId || state.networkDelegationId || '';
    if (input && String(input.value || '').trim()) supplementRecentWorkDigest(delegationId, input.value);
  });
  document.querySelectorAll('[data-delegation-run-cancel]').forEach((button) => {
    button.addEventListener('click', () => cancelDelegationWorkspaceRun(
      button.dataset.delegationId || state.networkDelegationId || '',
      button.dataset.delegationRunCancel || '',
    ));
  });
  document.querySelector('[data-delegation-ubuddy-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    const delegationId = event.currentTarget.dataset.delegationUbuddyToggle || state.networkDelegationId || '';
    const input = document.getElementById('network-delegation-comment-input');
    if (input && delegationId) {
      state.networkDelegationCommentDrafts = { ...(state.networkDelegationCommentDrafts || {}), [delegationId]: input.value };
      persistComposerDrafts();
    }
    const current = state.networkDelegationUBuddyEnabled?.[delegationId] !== false;
    state.networkDelegationUBuddyEnabled = { ...(state.networkDelegationUBuddyEnabled || {}), [delegationId]: !current };
    render();
    setTimeout(() => document.getElementById('network-delegation-comment-input')?.focus(), 0);
  });
  document.querySelector('[data-delegation-memory-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.networkDelegationMemoryMenuOpen = !state.networkDelegationMemoryMenuOpen;
    state.modelMenuOpen = false;
    state.modelSubmenuOpen = false;
    state.composerMemoryMenuOpen = false;
    render();
  });
  document.querySelector('[data-delegation-workspace-open]')?.addEventListener('click', async (event) => {
    event.preventDefault();
    const workspaceRoot = String(state.networkDelegationMemory?.workspaceRoot || '').trim();
    if (!workspaceRoot) return;
    try {
      const error = await window.janus.openPath(workspaceRoot);
      if (error) notify(`打开任务工作区失败：${error}`, 'error');
    } catch (error) {
      notify(`打开任务工作区失败：${userErrorMessage(error)}`, 'error');
    }
  });
  document.querySelectorAll('[data-delegation-message-edit]').forEach((button) => {
    button.addEventListener('click', () => editDelegationMessage(button.dataset.delegationMessageEdit || ''));
  });
  document.querySelectorAll('[data-delegation-message-withdraw]').forEach((button) => {
    button.addEventListener('click', () => withdrawDelegationMessage(button.dataset.delegationMessageWithdraw || ''));
  });
  document.querySelectorAll('[data-publish-collaboration-summary]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidateMessageId = button.dataset.publishCollaborationSummary || '';
      const groupId = button.dataset.collaborationSummaryGroup || '';
      if (!candidateMessageId || !groupId) return;
      button.disabled = true;
      try {
        await api.publishCollaborationGroupSummary({ groupId, candidateMessageId });
        if (state.currentSessionId) {
          const sessionId = state.currentSessionId;
          applyLatestRendererMessagePage(sessionId, await loadLatestRendererMessagePage(sessionId));
        }
        notify('跨团队汇总已发布到任务群。', 'success');
      } catch (error) {
        notify(`发布跨团队汇总失败：${userErrorMessage(error)}`, 'error');
      } finally {
        render();
      }
    });
  });
  document.querySelectorAll('[data-delegation-continue-editing]').forEach((button) => {
    button.addEventListener('click', () => continueEditingDelegationDraft(button.dataset.delegationContinueEditing || ''));
  });
  document.querySelectorAll('[data-delegation-publish-draft]').forEach((button) => {
    button.addEventListener('click', () => publishDelegationWorkspaceDraft({
      delegationId: button.dataset.delegationId || '',
      messageId: button.dataset.delegationPublishDraft || '',
      revisionId: button.dataset.delegationRevisionId || '',
    }));
  });
  document.querySelectorAll('[data-external-delegation-delivery-editor]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const delegationId = event.target.dataset.externalDelegationDeliveryEditor || '';
      if (!delegationId) return;
      const current = state.externalDelegationDeliveryDrafts?.[delegationId] || {};
      state.externalDelegationDeliveryDrafts = {
        ...(state.externalDelegationDeliveryDrafts || {}),
        [delegationId]: {
          ...current, text: event.target.value,
          candidateMessageId: event.target.dataset.externalDelegationCandidateMessageId || '',
          candidateRevisionId: event.target.dataset.externalDelegationCandidateRevisionId || '',
        },
      };
      const preview = document.querySelector(`[data-external-delegation-public-preview="${CSS.escape(delegationId)}"] p`);
      if (preview) preview.textContent = publicDelegationSubmissionText(event.target.value);
      const submit = document.querySelector(`[data-agent-delegation-respond="submit"][data-delegation-id="${CSS.escape(delegationId)}"]`);
      if (submit) submit.disabled = !String(event.target.value || '').trim();
      persistComposerDrafts();
      autoResizeChatInput(event.target);
    });
  });
  document.querySelectorAll('[data-external-delegation-delivery-file]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const delegationId = event.target.dataset.externalDelegationDeliveryFile || '';
      if (!delegationId) return;
      const selectedAttachmentKeys = [...document.querySelectorAll(`[data-external-delegation-delivery-file="${CSS.escape(delegationId)}"]:checked`)]
        .map((item) => item.value).filter(Boolean);
      const editor = document.querySelector(`[data-external-delegation-delivery-editor="${CSS.escape(delegationId)}"]`);
      const current = state.externalDelegationDeliveryDrafts?.[delegationId] || {};
      state.externalDelegationDeliveryDrafts = {
        ...(state.externalDelegationDeliveryDrafts || {}),
        [delegationId]: {
          ...current, ...(editor ? {
            text: editor.value,
            candidateMessageId: editor.dataset.externalDelegationCandidateMessageId || '',
            candidateRevisionId: editor.dataset.externalDelegationCandidateRevisionId || '',
          } : {}), selectedAttachmentKeys,
        },
      };
      persistComposerDrafts();
    });
  });
  document.querySelector('[data-delegation-edit-cancel]')?.addEventListener('click', cancelDelegationMessageEdit);
  document.querySelectorAll('[data-agent-delegation-respond]').forEach((btn) => {
    btn.addEventListener('click', () => respondAgentDelegation(btn.dataset.delegationId || '', btn.dataset.agentDelegationRespond || '', {
      sandboxPermission: btn.dataset.delegationPermission || '',
    }));
  });
  document.querySelectorAll('[data-network-conversation-mode]').forEach((btn) => {
    btn.addEventListener('click', () => openNetworkConversation(state.networkConversationPeerId, btn.dataset.networkConversationMode || 'person'));
  });
  document.querySelectorAll('[data-network-task]').forEach((btn) => {
    btn.addEventListener('click', () => openNetworkTask(btn.dataset.networkTask || ''));
  });
  document.querySelectorAll('[data-sidebar-section]').forEach((btn) => {
    btn.addEventListener('click', () => toggleSidebarSection(btn.dataset.sidebarSection || ''));
  });
  document.querySelector('[data-new-collaboration-chat]')?.addEventListener('click', () => startNewCollaborationChat());
  document.querySelector('[data-toggle-collab-sources]')?.addEventListener('click', toggleCollaborationSources);
  document.querySelectorAll('[data-send-session-to-collab]').forEach((btn) => {
    btn.addEventListener('click', () => sendSessionToCollaboration(btn.dataset.sendSessionToCollab || ''));
  });
  document.querySelectorAll('[data-collaboration-task]').forEach((btn) => {
    btn.addEventListener('click', () => openCollaborationTask(btn.dataset.collaborationTask || ''));
  });
  document.querySelectorAll('[data-agent-delivery-session]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sessionId = btn.dataset.agentDeliverySession || '';
      if (!sessionId) return;
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      await openSession(sessionId, { preserveNetworkPanel: true });
    });
  });
  document.querySelectorAll('[data-delete-collaboration-tasks]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteCollaborationTasks(btn.dataset.deleteCollaborationTasks || '');
    });
  });
  document.querySelectorAll('[data-toggle-project]').forEach((btn) => {
    btn.addEventListener('click', () => toggleProjectExpanded(btn.dataset.toggleProject || ''));
  });
  document.querySelectorAll('[data-sidebar-mode]').forEach((btn) => {
    btn.addEventListener('click', () => selectSidebarMode(btn.dataset.sidebarMode || 'root'));
  });
  document.querySelectorAll('[data-new-project-chat]').forEach((btn) => {
    btn.addEventListener('click', () => startNewProjectChat(btn.dataset.newProjectChat || state.activeProjectId));
  });
  document.querySelectorAll('[data-project-menu]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleProjectMenu(btn);
    });
  });
  document.querySelectorAll('[data-project-action]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleProjectAction(btn.dataset.projectAction, btn.dataset.projectId || '');
    });
  });
  document.querySelector('#chat-search-overlay')?.addEventListener('click', (event) => {
    if (event.target?.id === 'chat-search-overlay') closeChatSearch();
  });
  document.querySelector('#close-chat-search-btn')?.addEventListener('click', closeChatSearch);
  document.querySelector('#chat-search-modal-input')?.addEventListener('compositionstart', () => {
    chatSearchComposing = true;
  });
  document.querySelector('#chat-search-modal-input')?.addEventListener('compositionend', (event) => {
    chatSearchComposing = false;
    state.chatSearchOpen = true;
    state.chatSearchQuery = event.target.value;
    scheduleChatSearch();
    if (!normalizeSearch(state.chatSearchQuery)) render();
  });
  document.querySelector('#chat-search-modal-input')?.addEventListener('input', (event) => {
    state.chatSearchOpen = true;
    state.chatSearchQuery = event.target.value;
    if (chatSearchComposing || event.isComposing) return;
    scheduleChatSearch();
    if (!normalizeSearch(state.chatSearchQuery)) render();
  });
  document.querySelector('[data-search-new-chat]')?.addEventListener('click', () => {
    startNewChatFromSearch();
  });
  document.querySelector('[data-composer-image-mode]')?.addEventListener('click', () => {
    prepareInlineComposerFeatureToggle();
    const enabling = !isImageComposerMode();
    let removedAttachmentCount = 0;
    if (state.homeMode === 'image') state.homeMode = 'department';
    state.composerImageMode = enabling;
    if (enabling) {
      const retained = state.attachments.filter((item) => item.kind === 'image');
      removedAttachmentCount = state.attachments.length - retained.length;
      state.attachments = retained;
      state.interactionMode = '';
    }
    render();
    focusChatInputAtEnd();
    notify(
      enabling
        ? removedAttachmentCount
          ? `已在当前会话切换到 GPT Image-2；${removedAttachmentCount} 个非图片附件未带入。`
          : '已在当前会话切换到 GPT Image-2。'
        : '已切回当前 Agent 的文字模型。',
      removedAttachmentCount ? 'warning' : 'info',
      removedAttachmentCount ? 3600 : 2500,
    );
  });
  document.querySelectorAll('[data-home-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      preserveChatDraftFromInput();
      const nextMode = btn.dataset.homeMode || 'department';
      if (state.homeMode === nextMode) return;
      state.homeMode = nextMode;
      state.composerImageMode = false;
      state.modelMenuOpen = false;
      state.pptTemplateMenuOpen = false;
      state.pptStyleMenuOpen = false;
      state.agentMenuOpen = false;
      if (nextMode === 'image' || nextMode === 'collaboration') {
        state.currentDepartmentId = '';
        state.currentAgentId = '';
        state.selectionSource = null;
      }
      render();
    });
  });
  document.querySelectorAll('[data-department-chip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      preserveChatDraftFromInput();
      const departmentId = btn.dataset.departmentChip;
      const alreadySelected = state.selectionSource === 'manual' && state.currentDepartmentId === departmentId;
      state.sidebarMode = state.activeProjectId && !alreadySelected ? 'project' : 'chats';
      state.currentSessionId = '';
      state.contextUsage = null;
      state.messages = [];
      state.modelMenuOpen = false;
      state.pptTemplateMenuOpen = false;
      if (alreadySelected) {
        clearDepartmentSelection();
      } else {
        selectDepartment(departmentId, { manual: true, selectDefaultAgent: false });
      }
      focusChatInputAtEnd();
    });
  });
  document.querySelectorAll('[data-agent-option]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectAgentOption(btn.dataset.agentOption, btn.dataset.agentDepartment || state.currentDepartmentId);
    });
  });
  document.querySelectorAll('[data-clear-selection]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearDepartmentSelection();
    });
  });
  document.querySelectorAll('[data-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('chat-input');
      if (!input) return;
      state.chatDraft = btn.dataset.prompt || '';
      input.value = state.chatDraft;
      preserveCurrentComposerDraft();
      input.focus();
      autoResizeChatInput(input);
      syncSocialMentionHighlight(input);
    });
  });
  document.querySelector('#chat-input')?.addEventListener('input', (event) => {
    const previousDraft = String(state.chatDraft || '');
    const previouslyUsedSocialModel = composerMentionsUseModel();
    state.chatDraft = event.target.value;
    if (activeImeComposition?.element === event.target || event.isComposing) {
      syncActiveImeCompositionValue();
      return;
    }
    pruneComposerMentions(state.chatDraft);
    pruneComposerProjectReferences(state.chatDraft);
    if (event.target.classList.contains('mention-token-input')) syncSocialMentionHighlight(event.target);
    if (event.target.classList.contains('social-mention-input')
      && socialMentionTriggerRemoved(previousDraft, state.chatDraft)
      && composerMentionPickerOpen()) {
      closeComposerMentionPicker({
        focusInput: true,
        selectionStart: event.target.selectionStart,
        selectionEnd: event.target.selectionEnd,
      });
      return;
    }
    const usesSocialModel = composerMentionsUseModel();
    if (event.target.classList.contains('social-mention-input') && previouslyUsedSocialModel !== usesSocialModel) {
      render();
      focusChatInputAtEnd();
      return;
    }
    const skillCommandQuery = composerSkillCommandQuery(state.chatDraft);
    if (!event.target.classList.contains('social-mention-input') && skillCommandQuery !== null) {
      state.composerMentionPickerMode = 'skill';
      state.composerMentionQuery = skillCommandQuery;
      state.composerMentionActiveIndex = 0;
      const skillRange = composerSkillCommandRange(state.chatDraft);
      state.composerMentionAnchorStart = skillRange?.start ?? state.chatDraft.length;
      state.composerMentionAnchorEnd = Number.isFinite(event.target.selectionEnd) ? event.target.selectionEnd : state.chatDraft.length;
      if (!state.socialMentionMenuOpen) {
        resetProjectReferenceBrowser();
        state.socialMentionMenuOpen = true;
        render();
        setTimeout(() => document.querySelector('[data-project-reference-query]')?.focus(), 0);
        return;
      }
      render();
      return;
    }
    const projectMentionQuery = composerProjectMentionQuery(state.chatDraft);
    if (!event.target.classList.contains('social-mention-input') && projectMentionQuery !== null) {
      state.composerMentionPickerMode = 'mention';
      state.composerMentionQuery = projectMentionQuery;
      state.composerMentionActiveIndex = 0;
      state.composerMentionAnchorStart = Number.isFinite(event.target.selectionStart) ? event.target.selectionStart : state.chatDraft.length;
      state.composerMentionAnchorEnd = Number.isFinite(event.target.selectionEnd) ? event.target.selectionEnd : state.composerMentionAnchorStart;
      if (!state.socialMentionMenuOpen) {
        resetProjectReferenceBrowser();
        bindProjectReferenceBrowserToActiveProject();
        state.socialMentionMenuOpen = true;
        render();
        void refreshCodexPlugins().then(() => { if (state.socialMentionMenuOpen) render(); }).catch(() => {});
        void loadProjectReferenceEntries({ directory: '', query: projectMentionQuery, focusSearch: false });
        focusChatInputAtMentionAnchor();
        return;
      }
      scheduleProjectReferenceQuery(projectMentionQuery, { focusSearch: false });
    } else if (!event.target.classList.contains('social-mention-input') && projectMentionQuery === null && composerProjectMentionPickerOpen()) {
      closeComposerProjectMentionPicker({
        focusInput: true,
        selectionStart: event.target.selectionStart,
        selectionEnd: event.target.selectionEnd,
      });
      return;
    }
    if (state.chatGroupId) {
      state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [`chat-group:${state.chatGroupId}`]: state.chatDraft };
      persistComposerDrafts();
    } else if (state.collaborationGroupId) {
      state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [`collaboration:${state.collaborationGroupId}`]: state.chatDraft };
      persistComposerDrafts();
    }
    if (state.networkConversationPeerId && state.networkConversationPeerId !== 'self-secretary') {
      const key = networkConversationDraftKey(state.networkConversationPeerId, state.networkConversationMode, state.networkConversationGroupId);
      state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [key]: state.chatDraft };
      persistComposerDrafts();
    }
    preserveCurrentComposerDraft();
    if (event.target.classList.contains('social-mention-input')) {
      if (!state.socialMentionMenuOpen && /(^|\s)@$/.test(state.chatDraft)) {
        state.socialMentionMenuOpen = true;
        render();
        void refreshCodexPlugins().then(() => { if (state.socialMentionMenuOpen) render(); }).catch(() => {});
        focusChatInputAtEnd();
        return;
      }
    }
    autoResizeChatInput(event.target);
  });
  document.querySelector('#chat-input.mention-token-input')?.addEventListener('scroll', (event) => {
    syncSocialMentionHighlight(event.target);
  });
  document.querySelector('[data-social-mention-toggle]')?.addEventListener('click', () => {
    preserveChatDraftFromInput();
    state.socialMentionMenuOpen = !state.socialMentionMenuOpen;
    state.composerMentionPickerMode = 'mention';
    if (!state.socialMentionMenuOpen) state.uBuddyContactPickerOnly = false;
    if (state.socialMentionMenuOpen) {
      state.composerMentionQuery = '';
      state.composerMentionActiveIndex = 0;
      state.composerMentionAnchorStart = state.chatDraft.length;
      state.composerMentionAnchorEnd = state.chatDraft.length;
      resetProjectReferenceBrowser();
      bindProjectReferenceBrowserToActiveProject();
      void refreshCodexPlugins().then(() => { if (state.socialMentionMenuOpen) render(); }).catch(() => {});
    } else {
      resetProjectReferenceBrowser();
    }
    render();
    if (state.socialMentionMenuOpen && state.projectReferenceBrowseProjectId) {
      void loadProjectReferenceEntries({ directory: '', query: '', focusSearch: true });
    } else if (state.socialMentionMenuOpen) {
      setTimeout(() => document.querySelector('[data-project-reference-query]')?.focus(), 0);
    } else focusChatInputAtEnd();
  });
  document.querySelector('[data-task-reference-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    preserveChatDraftFromInput();
    state.taskReferenceMenuOpen = !state.taskReferenceMenuOpen;
    state.composerToolMenuOpen = false;
    state.uBuddyMessageModeMenuOpen = false;
    state.uBuddyParticipantSelectionMenuOpen = false;
    state.socialMentionMenuOpen = false;
    if (state.taskReferenceMenuOpen) {
      state.taskReferenceOptions = [];
      state.taskReferenceOptionsLoading = true;
      state.taskReferenceOptionsError = '';
    } else {
      taskReferenceOptionsRequestSequence += 1;
      state.taskReferenceOptionsLoading = false;
    }
    render();
    if (state.taskReferenceMenuOpen) void loadTaskReferenceOptions();
    else focusChatInputAtEnd();
  });
  document.querySelector('[data-ubuddy-message-mode-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.busy || currentChatRun()) return;
    preserveChatDraftFromInput();
    state.uBuddyMessageModeMenuOpen = !state.uBuddyMessageModeMenuOpen;
    state.uBuddyParticipantSelectionMenuOpen = false;
    state.composerToolMenuOpen = false;
    state.taskReferenceMenuOpen = false;
    render();
  });
  document.querySelectorAll('[data-ubuddy-message-mode]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.busy || currentChatRun()) return;
    preserveChatDraftFromInput();
    state.uBuddyMessageMode = button.dataset.ubuddyMessageMode === 'ask' ? 'ask' : 'task';
    state.uBuddyMessageModeMenuOpen = false;
    state.uBuddyParticipantSelectionMenuOpen = false;
    render();
    focusChatInputAtEnd();
  }));
  document.querySelector('[data-ubuddy-participant-policy-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.busy || currentChatRun()) return;
    preserveChatDraftFromInput();
    state.uBuddyParticipantSelectionMenuOpen = !state.uBuddyParticipantSelectionMenuOpen;
    state.uBuddyMessageModeMenuOpen = false;
    state.composerToolMenuOpen = false;
    state.taskReferenceMenuOpen = false;
    render();
  });
  document.querySelectorAll('[data-ubuddy-participant-policy]').forEach((button) => button.addEventListener('click', () => {
    if (state.busy || currentChatRun()) return;
    preserveChatDraftFromInput();
    state.uBuddyParticipantSelectionPolicy = button.dataset.ubuddyParticipantPolicy === 'auto_select'
      ? 'auto_select'
      : 'all_mentioned';
    state.uBuddyParticipantSelectionMenuOpen = false;
    render();
    focusChatInputAtEnd();
  }));
  document.querySelectorAll('[data-task-reference-select]').forEach((button) => button.addEventListener('click', () => {
    const taskRunId = String(button.dataset.taskReferenceSelect || '').trim();
    if (!taskRunId) return;
    const option = (state.taskReferenceOptions || []).find((item) => item.taskRunId === taskRunId) || {};
    state.composerTaskReference = {
      principalType: 'task',
      taskRunId,
      displayText: button.dataset.taskReferenceDisplay || option.displayText || `@任务：${option.title || taskRunId}`,
    };
    state.taskReferenceMenuOpen = false;
    render();
    focusChatInputAtEnd();
  }));
  document.querySelector('[data-task-reference-new]')?.addEventListener('click', () => {
    state.composerTaskReference = {
      principalType: 'task',
      taskRunId: '',
      displayText: '@新任务',
      createNewTask: true,
      action: 'new_task',
    };
    state.taskReferenceMenuOpen = false;
    render();
    focusChatInputAtEnd();
  });
  document.querySelector('[data-task-reference-clear]')?.addEventListener('click', () => {
    state.composerTaskReference = null;
    render();
    focusChatInputAtEnd();
  });
  document.querySelector('[data-select-project-reference-workspace]')?.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const project = await selectWorkspaceDirectory();
    if (!project?.id || !state.socialMentionMenuOpen) return;
    state.projectReferenceBrowseProjectId = project.id;
    state.projectReferenceDirectory = '';
    state.projectReferenceEntries = [];
    state.projectReferenceError = '';
    await loadProjectReferenceEntries({ directory: '', query: state.composerMentionQuery || '' });
  });
  document.querySelector('[data-project-reference-query]')?.addEventListener('input', (event) => {
    state.composerMentionQuery = String(event.currentTarget.value || '');
    state.composerMentionActiveIndex = 0;
    if (state.composerMentionPickerMode === 'skill') {
      render();
      setTimeout(() => {
        const input = document.querySelector('[data-project-reference-query]');
        input?.focus();
        input?.setSelectionRange?.(input.value.length, input.value.length);
      }, 0);
      return;
    }
    scheduleProjectReferenceQuery(state.composerMentionQuery, { renderPeople: true });
  });
  document.querySelector('[data-project-reference-query]')?.addEventListener('keydown', handleComposerMentionPickerKeydown);
  document.querySelectorAll('[data-project-reference-directory]').forEach((button) => button.addEventListener('click', () => {
    state.projectReferenceDirectory = button.dataset.projectReferenceDirectory || '';
    state.composerMentionQuery = '';
    state.composerMentionActiveIndex = 0;
    void loadProjectReferenceEntries({ directory: state.projectReferenceDirectory, query: '' });
  }));
  document.querySelectorAll('[data-project-reference-select]').forEach((button) => button.addEventListener('click', () => {
    insertProjectFileReference({
      relativePath: button.dataset.projectReferenceSelect || '',
      referenceKind: button.dataset.projectReferenceKind || 'file',
    });
  }));
  document.querySelectorAll('[data-project-reference-remove]').forEach((button) => button.addEventListener('click', () => {
    const referenceId = button.dataset.projectReferenceRemove || '';
    state.composerFileReferences = (state.composerFileReferences || []).filter((item) => item.referenceId !== referenceId);
    render();
    focusChatInputAtEnd();
  }));
  document.querySelectorAll('[data-memory-reference-remove]').forEach((button) => button.addEventListener('click', () => {
    const referenceId = button.dataset.memoryReferenceRemove || '';
    state.composerMemoryReferences = (state.composerMemoryReferences || []).filter((item) => item.referenceId !== referenceId);
    render();
    focusChatInputAtEnd();
  }));
  document.querySelectorAll('[data-social-mention]').forEach((btn) => {
    btn.addEventListener('click', () => insertSocialMention({
      token: btn.dataset.socialMention || '',
      principalType: btn.dataset.socialMentionPrincipal || '',
      userId: btn.dataset.socialMentionUser || '',
      ownerUserId: btn.dataset.socialMentionOwner || '',
      audience: btn.dataset.socialMentionAudience || '',
    }));
  });
  document.querySelectorAll('[data-ubuddy-mention-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const skillId = btn.dataset.ubuddyMentionSkill || '';
      if (skillId && state.composerMentionPickerMode === 'skill') {
        insertSkillMention({
          skillId,
          token: btn.dataset.ubuddyMentionSlashToken || `$${btn.dataset.ubuddyMentionToken || ''}`,
        });
        return;
      }
      insertUBuddyMention({
      principalType: btn.dataset.ubuddyMentionPrincipal || 'user',
      userId: btn.dataset.ubuddyMentionUser || '',
      agentId: btn.dataset.ubuddyMentionAgent || '',
      agentInstanceId: btn.dataset.ubuddyMentionAgentInstance || '',
      organizationId: btn.dataset.ubuddyMentionOrganization || '',
      pluginId: btn.dataset.ubuddyMentionPlugin || '',
      skillId,
      audience: btn.dataset.ubuddyMentionAudience || '',
      token: btn.dataset.ubuddyMentionToken || '',
      });
    });
  });
  document.querySelector('[data-social-group-dissolve]')?.addEventListener('click', dissolveSocialTaskGroup);
  document.querySelector('[data-social-group-rename]')?.addEventListener('click', renameSocialTaskGroup);
  document.querySelector('[data-collaboration-group-rename]')?.addEventListener('click', renameCollaborationGroup);
  document.querySelector('#chat-input')?.addEventListener('paste', handleChatInputPaste);
  document.querySelector('#chat-input')?.addEventListener('keydown', (event) => {
    if (activeImeComposition?.element === event.target || event.isComposing || event.keyCode === 229) return;
    if (handleComposerMentionPickerKeydown(event)) return;
    if (handleSocialMentionDelete(event)) return;
    if ((event.key === 'Backspace' || event.key === 'Delete') && event.target.value === '') {
      if (removeLastManualSelection()) event.preventDefault();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    event.target.closest('form')?.requestSubmit();
  });
  syncComposerMentionActiveOption();
  document.querySelector('#model-picker-trigger')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nextOpen = !state.modelMenuOpen;
    state.modelMenuOpen = nextOpen;
    state.modelSubmenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.composerMemoryMenuOpen = false;
    state.networkDelegationMemoryMenuOpen = false;
    if (state.modelMenuOpen) state.modelMenuPlacement = defaultModelMenuPlacement();
    render();
    if (state.modelMenuOpen) scheduleModelMenuPlacement();
  });
  document.querySelectorAll('[data-reasoning-option]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.reasoningEffort = btn.dataset.reasoningOption || 'xhigh';
      render();
    });
  });
  document.querySelector('[data-model-submenu-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.modelSubmenuOpen = !state.modelSubmenuOpen;
    render();
    if (state.modelMenuOpen) scheduleModelMenuPlacement();
  });
  document.querySelectorAll('[data-model-option]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.model = btn.dataset.modelOption || 'gpt-5.6-sol';
      const supported = reasoningOptionsForModel(state.modelCatalog, state.model);
      if (!supported.some(([value]) => value === state.reasoningEffort)) {
        state.reasoningEffort = modelCatalogEntry(state.modelCatalog, state.model)?.defaultReasoningEffort || supported[0]?.[0] || 'medium';
      }
      state.modelSubmenuOpen = false;
      state.modelMenuOpen = false;
      render();
    });
  });
  document.querySelector('[data-agent-inline-trigger]')?.addEventListener('click', (event) => {
    event.preventDefault();
    state.agentMenuOpen = !state.agentMenuOpen;
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.composerToolMenuOpen = false;
    state.composerMemoryMenuOpen = false;
    render();
  });
  document.querySelectorAll('[data-agent-inline-option]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      state.homeMode = 'department';
      const departmentId = btn.dataset.agentInlineDepartment || state.currentDepartmentId;
      state.currentAgentId = resolveSelectedAgentId(departmentId, btn.dataset.agentInlineOption || '');
      state.currentAgentInstanceId = '';
      const selected = state.org.agents.find((agent) => agent.id === state.currentAgentId);
      state.currentDepartmentId = selected?.departmentId || departmentId;
      state.selectionSource = null;
      state.agentMenuOpen = false;
      render();
    });
  });
  document.querySelector('.model-current-row')?.addEventListener('mouseenter', scheduleModelMenuPlacement);
  document.querySelector('.model-current-row')?.addEventListener('focus', scheduleModelMenuPlacement);
  document.querySelector('#image-model-select')?.addEventListener('change', (event) => {
    state.imageModel = event.target.value;
  });
  document.querySelector('#image-model-trigger')?.addEventListener('click', (event) => {
    event.preventDefault();
    state.imageModelMenuOpen = !state.imageModelMenuOpen;
    state.modelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.composerMemoryMenuOpen = false;
    render();
    if (state.imageModelMenuOpen) scheduleComposerMetaMenuPlacement();
  });
  document.querySelectorAll('[data-image-model-option]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      state.imageModel = btn.dataset.imageModelOption || 'gpt-image-2';
      state.imageModelMenuOpen = false;
      render();
    });
  });
  document.querySelector('[data-composer-meta-overflow-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.composerMetaOverflowOpen = !state.composerMetaOverflowOpen;
    state.workspaceMenuOpen = false;
    state.workspaceCreateMenuOpen = false;
    state.composerMemoryMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    render();
  });
  document.querySelector('#ppt-template-trigger')?.addEventListener('click', (event) => {
    event.preventDefault();
    state.composerMetaOverflowOpen = false;
    state.workspaceMenuOpen = false;
    state.workspaceCreateMenuOpen = false;
    state.pptTemplateMenuOpen = !state.pptTemplateMenuOpen;
    state.pptTemplatePreviewId = currentPptTemplateValue();
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.composerMemoryMenuOpen = false;
    render();
    if (state.pptTemplateMenuOpen) {
      scheduleComposerMetaMenuPlacement();
      setTimeout(() => document.getElementById('ppt-template-search')?.focus(), 0);
    }
  });
  document.querySelector('#ppt-template-search')?.addEventListener('input', (event) => {
    state.pptTemplateQuery = event.target.value;
    render();
    scheduleComposerMetaMenuPlacement();
    setTimeout(() => {
      const input = document.getElementById('ppt-template-search');
      if (!input) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }, 0);
  });
  document.querySelector('#ppt-template-search')?.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') event.preventDefault();
  });
  document.querySelector('#ppt-style-trigger')?.addEventListener('click', (event) => {
    event.preventDefault();
    state.composerMetaOverflowOpen = false;
    state.workspaceMenuOpen = false;
    state.workspaceCreateMenuOpen = false;
    state.pptStyleMenuOpen = !state.pptStyleMenuOpen;
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.composerMemoryMenuOpen = false;
    render();
    if (state.pptStyleMenuOpen) scheduleComposerMetaMenuPlacement();
  });
  document.querySelectorAll('[data-ppt-style-option]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      state.homeMode = 'department';
      state.currentDepartmentId = 'ppt_department';
      state.currentAgentId = resolveSelectedAgentId('ppt_department', 'ppt');
      state.pptStyleId = normalizePptStyleId(btn.dataset.pptStyleOption || 'general');
      state.selectionSource = null;
      state.agentMenuOpen = false;
      state.pptStyleMenuOpen = false;
      render();
    });
  });
  document.querySelectorAll('[data-ppt-template-option]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      state.pptTemplateId = btn.dataset.pptTemplateOption || 'none';
      state.pptTemplatePreviewId = state.pptTemplateId;
      state.pptTemplateQuery = '';
      state.pptTemplateMenuOpen = false;
      hidePptTemplatePreview();
      render();
    });
  });
  document.querySelectorAll('[data-ppt-template-preview]').forEach((btn) => {
    btn.addEventListener('mouseenter', (event) => showPptTemplatePreview(btn.dataset.pptTemplatePreview || 'none', event));
    btn.addEventListener('mousemove', movePptTemplatePreview);
  });
  document.querySelectorAll('[data-select-workspace]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectWorkspaceDirectory();
    });
  });
  document.querySelector('[data-create-blank-project]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.workspaceMenuOpen = false;
    state.workspaceCreateMenuOpen = false;
    selectWorkspaceDirectory();
  });
  document.querySelector('[data-workspace-create-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.workspaceCreateMenuOpen = !state.workspaceCreateMenuOpen;
    render();
    if (state.workspaceCreateMenuOpen) scheduleComposerMetaMenuPlacement();
  });
  document.querySelector('[data-workspace-project-search]')?.addEventListener('input', (event) => {
    const query = String(event.currentTarget.value || '').trim().toLowerCase();
    state.workspaceProjectQuery = query;
    let visibleCount = 0;
    document.querySelectorAll('[data-workspace-project-label]').forEach((button) => {
      const visible = !query || String(button.dataset.workspaceProjectLabel || '').includes(query);
      button.hidden = !visible;
      if (visible) visibleCount += 1;
    });
    const empty = document.querySelector('[data-workspace-project-empty]');
    if (empty) empty.hidden = visibleCount !== 0;
  });
  document.querySelector('[data-workspace-menu-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.workspaceMenuOpen = !state.workspaceMenuOpen;
    state.workspaceCreateMenuOpen = false;
    state.workspaceProjectQuery = '';
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.composerMemoryMenuOpen = false;
    state.composerToolMenuOpen = false;
    render();
  });
  document.querySelector('[data-composer-memory-toggle]')?.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.composerMemoryMenuOpen) {
      state.composerMemoryMenuOpen = false;
      render();
      return;
    }
    await openComposerMemoryMenu();
  });
  document.querySelector('[data-composer-memory-checkpoint]')?.addEventListener('click', saveAndClearComposerContext);
  document.querySelector('[data-composer-memory-create]')?.addEventListener('click', createComposerMemory);
  document.querySelector('[data-composer-memory-rename]')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const agentInstanceId = activeComposerMemoryAgentInstanceId();
    openMemoryNameDialog({
      agentInstanceId,
      source: 'composer',
      mode: 'rename',
      memoryDocumentId: button.dataset.composerMemoryRename || '',
      suggested: button.dataset.memoryName || '',
    });
  });
  document.querySelectorAll('[data-composer-memory-switch]').forEach((button) => {
    button.addEventListener('click', () => switchComposerMemory(button.dataset.composerMemorySwitch || ''));
  });
  document.querySelectorAll('[data-composer-memory-restore-switch]').forEach((button) => {
    button.addEventListener('click', () => restoreAndSwitchComposerMemory(button.dataset.composerMemoryRestoreSwitch || ''));
  });
  document.querySelector('[data-workspace-none]')?.addEventListener('click', clearWorkspaceSelection);
  document.querySelectorAll('[data-workspace-project]').forEach((btn) => {
    btn.addEventListener('click', () => selectWorkspaceProject(btn.dataset.workspaceProject || ''));
  });
  document.querySelectorAll('[data-workspace-project-remove]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeWorkspaceProject(btn.dataset.workspaceProjectRemove || '');
    });
  });
  document.querySelector('#sandbox-permission-trigger')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (currentChatRun()) return;
    state.sandboxMenuOpen = !state.sandboxMenuOpen;
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.composerToolMenuOpen = false;
    state.workspaceMenuOpen = false;
    state.workspaceCreateMenuOpen = false;
    state.composerMemoryMenuOpen = false;
    render();
    if (state.sandboxMenuOpen) scheduleComposerMetaMenuPlacement();
  });
  document.querySelectorAll('[data-sandbox-permission]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (currentChatRun()) return;
      const value = btn.dataset.sandboxPermission;
      if (!['request-approval', 'auto-approve', 'full-access'].includes(value)) return;
      if (value === 'full-access' && state.sandboxPermission !== 'full-access') {
        const confirmed = window.confirm(state.languageMode === 'en'
          ? '“Full Access” disables Janus command approvals and file sandboxing, allowing access to local files and commands outside the working directory. Enable it?'
          : '“完全访问”会关闭 Janus 的命令审批和文件沙盒，允许访问工作目录之外的本机文件与命令。确认启用吗？');
        if (!confirmed) return;
      }
      state.sandboxPermission = value;
      state.sandboxMenuOpen = false;
      saveSandboxPermission(value);
      render();
    });
  });
  document.querySelectorAll('[data-private-assistant-permission]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (currentChatRun()) return;
      const value = btn.dataset.privateAssistantPermission;
      if (!['request-approval', 'task-workspace'].includes(value)) return;
      state.privateAssistantPermission = value;
      state.sandboxMenuOpen = false;
      savePrivateAssistantPermission(value);
      render();
    });
  });
  document.querySelector('[data-composer-tool-menu-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.composerToolMenuOpen = !state.composerToolMenuOpen;
    state.composerEmojiPickerOpen = false;
    state.uBuddyMessageModeMenuOpen = false;
    state.uBuddyParticipantSelectionMenuOpen = false;
    state.taskReferenceMenuOpen = false;
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.workspaceMenuOpen = false;
    render();
  });
  document.querySelector('[data-composer-emoji-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const input = document.getElementById('chat-input');
    preserveChatDraftFromInput();
    if (!state.composerEmojiPickerOpen) {
      state.composerEmojiInsertionStart = Number.isFinite(input?.selectionStart)
        ? input.selectionStart : String(state.chatDraft || '').length;
      state.composerEmojiInsertionEnd = Number.isFinite(input?.selectionEnd)
        ? input.selectionEnd : state.composerEmojiInsertionStart;
    }
    state.composerEmojiPickerOpen = !state.composerEmojiPickerOpen;
    if (state.composerEmojiPickerOpen && window.janus.listEmojiFavorites) {
      window.janus.listEmojiFavorites().then((items) => {
        if (Array.isArray(items) && items.length) {
          state.composerFavoriteEmojis = normalizeEmojiFavorites(items);
          saveComposerFavoriteEmojis(state.composerFavoriteEmojis);
          render();
        }
      }).catch(() => {});
    }
    state.composerToolMenuOpen = false;
    state.socialMentionMenuOpen = false;
    state.taskReferenceMenuOpen = false;
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.workspaceMenuOpen = false;
    render();
  });
  document.querySelectorAll('[data-composer-emoji]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      insertComposerEmoji(button.dataset.composerEmoji || '');
    });
  });
  document.querySelectorAll('[data-composer-favorite]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = (state.composerFavoriteEmojis || []).find((entry) => entry.id === button.dataset.composerFavorite);
      if (!item) return;
      if (state.composerFavoriteManageOpen) return;
      if (item.kind === 'image') insertComposerFavoriteImage(item); else insertComposerEmoji(item.value);
    });
  });
  document.querySelectorAll('[data-composer-favorite]').forEach((button) => button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.composerFavoriteContextMenu = { id: button.dataset.composerFavorite || '', x: event.clientX, y: event.clientY };
    render();
  }));
  document.querySelector('[data-composer-favorite-context-close]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    state.composerFavoriteContextMenu = null;
    render();
  });
  document.querySelector('[data-composer-favorite-move-front]')?.addEventListener('click', (event) => {
    const id = event.currentTarget.dataset.composerFavoriteMoveFront || '';
    const list = [...(state.composerFavoriteEmojis || [])];
    const index = list.findIndex((item) => item.id === id);
    if (index > 0) list.unshift(...list.splice(index, 1));
    state.composerFavoriteEmojis = list;
    state.composerFavoriteContextMenu = null;
    window.janus.reorderEmojiFavorites?.({ ids: list.map((item) => item.id) }).catch(() => {});
    saveComposerFavoriteEmojis(list);
    render();
  });
  document.querySelector('[data-composer-favorite-context-remove]')?.addEventListener('click', (event) => {
    const id = event.currentTarget.dataset.composerFavoriteContextRemove || '';
    state.composerFavoriteEmojis = (state.composerFavoriteEmojis || []).filter((item) => item.id !== id);
    state.composerFavoriteContextMenu = null;
    window.janus.removeEmojiFavorite?.({ id }).catch(() => {});
    saveComposerFavoriteEmojis(state.composerFavoriteEmojis);
    render();
  });
  document.querySelectorAll('[data-composer-favorite-manage]').forEach((button) => button.addEventListener('click', () => {
    state.composerFavoriteManageOpen = !state.composerFavoriteManageOpen;
    render();
  }));
  document.querySelector('[data-composer-favorite-done]')?.addEventListener('click', () => {
    state.composerFavoriteManageOpen = false;
    render();
  });
  document.querySelectorAll('[data-composer-emoji-tab]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.composerEmojiTab = button.dataset.composerEmojiTab || 'emoji';
    state.composerFavoriteManageOpen = state.composerEmojiTab === 'manage';
    render();
  }));
  document.querySelectorAll('[data-composer-favorite-upload]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    uploadComposerFavoriteImage();
  }));
  document.querySelector('[data-composer-emoji-store]')?.addEventListener('click', () => notify('表情商城暂未开放。', 'info'));
  document.querySelector('[data-composer-emoji-settings]')?.addEventListener('click', () => notify('表情设置暂未开放。', 'info'));
  document.querySelectorAll('[data-composer-favorite-remove]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const id = button.dataset.composerFavoriteRemove || '';
    state.composerFavoriteEmojis = (state.composerFavoriteEmojis || []).filter((item) => item.id !== id);
    window.janus.removeEmojiFavorite?.({ id }).catch(() => {});
    saveComposerFavoriteEmojis(state.composerFavoriteEmojis);
    render();
  }));
  document.querySelectorAll('[data-composer-favorite-move]').forEach((button) => button.addEventListener('click', () => {
    const list = [...(state.composerFavoriteEmojis || [])];
    const index = Number(button.dataset.composerFavoriteIndex);
    const next = button.dataset.composerFavoriteMove === 'up' ? index - 1 : index + 1;
    if (index < 0 || next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    state.composerFavoriteEmojis = list;
    window.janus.reorderEmojiFavorites?.({ ids: list.map((item) => item.id) }).catch(() => {});
    saveComposerFavoriteEmojis(list);
    render();
  }));
  document.querySelector('[data-composer-add-files]')?.addEventListener('click', (event) => {
    event.preventDefault();
    state.composerToolMenuOpen = false;
    attachContextFiles();
  });
  document.querySelectorAll('[data-composer-interaction-mode]').forEach((button) => {
    button.addEventListener('click', () => setComposerInteractionMode(button.dataset.composerInteractionMode || ''));
  });
  document.querySelectorAll('[data-goal-action]').forEach((button) => {
    button.addEventListener('click', () => runGoalAction(button.dataset.goalSessionId || '', button.dataset.goalAction || ''));
  });
  document.querySelectorAll('[data-goal-expand]').forEach((button) => {
    button.addEventListener('click', () => {
      const sessionId = button.dataset.goalExpand || '';
      const expanded = new Set(state.expandedGoalSessionIds || []);
      if (expanded.has(sessionId)) expanded.delete(sessionId); else expanded.add(sessionId);
      state.expandedGoalSessionIds = [...expanded];
      render();
    });
  });
  document.querySelector('[data-goal-editor-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    saveGoalEditor();
  });
  document.querySelectorAll('[data-goal-editor-cancel]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.goalEditor?.busy) return;
      state.goalEditor = null;
      render();
    });
  });
  document.querySelector('[data-goal-editor-overlay]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget || state.goalEditor?.busy) return;
    state.goalEditor = null;
    render();
  });
  document.querySelector('[data-composer-interaction-indicator]')?.addEventListener('click', () => setComposerInteractionMode(''));
  document.querySelectorAll('[data-open-chat-plan-sidebar]').forEach((button) => {
    button.addEventListener('click', () => openChatPlanViewer(button.dataset.openChatPlanSidebar || '', 'sidebar'));
  });
  document.querySelectorAll('[data-open-chat-plan-standalone]').forEach((button) => {
    button.addEventListener('click', () => openChatPlanViewer(button.dataset.openChatPlanStandalone || '', 'standalone'));
  });
  document.querySelectorAll('[data-close-chat-plan-viewer]').forEach((button) => {
    button.addEventListener('click', closeChatPlanViewer);
  });
  document.querySelector('[data-chat-plan-viewer-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeChatPlanViewer();
  });
  document.querySelectorAll('[data-download-chat-plan]').forEach((button) => {
    button.addEventListener('click', () => downloadChatPlan(button.dataset.downloadChatPlan || ''));
  });
  document.querySelectorAll('[data-implement-chat-plan]').forEach((button) => {
    button.addEventListener('click', () => implementChatPlan(button.dataset.implementChatPlan || ''));
  });
  document.querySelectorAll('[data-chat-plan-execution]').forEach((button) => {
    button.addEventListener('click', () => resolveChatPlanExecutionChoice(
      button.dataset.chatPlanExecution || '',
      button.dataset.chatPlanMessageId || '',
    ));
  });
  document.querySelector('[data-chat-plan-revision-back]')?.addEventListener('click', () => {
    const prompt = state.chatPlanExecutionPrompt;
    if (!prompt) return;
    state.chatPlanExecutionPrompt = { ...prompt, mode: 'choice', revisionError: '', revisionSubmitting: false };
    render();
  });
  document.querySelector('[data-chat-plan-revision-submit]')?.addEventListener('click', () => {
    const prompt = state.chatPlanExecutionPrompt;
    if (prompt?.messageId) void submitChatPlanRevision(prompt.messageId);
  });
  document.querySelector('[data-chat-plan-revision-input]')?.addEventListener('input', (event) => {
    if (!state.chatPlanExecutionPrompt) return;
    state.chatPlanExecutionPrompt = { ...state.chatPlanExecutionPrompt, revisionDraft: event.target.value, revisionError: '' };
  });
  document.querySelector('[data-chat-plan-revision-input]')?.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      const prompt = state.chatPlanExecutionPrompt;
      if (prompt?.messageId) void submitChatPlanRevision(prompt.messageId);
    }
  });
  document.querySelectorAll('[data-implement-chat-plan-clear-context]').forEach((button) => {
    button.addEventListener('click', () => implementChatPlan(button.dataset.implementChatPlanClearContext || '', { clearContext: true }));
  });
  document.querySelectorAll('[data-modify-chat-plan]').forEach((button) => {
    button.addEventListener('click', () => modifyChatPlan(button.dataset.modifyChatPlan || ''));
  });
  document.querySelectorAll('[data-defer-chat-plan]').forEach((button) => {
    button.addEventListener('click', () => deferChatPlan(button.dataset.deferChatPlan || ''));
  });
  document.querySelectorAll('.composer-plus:not([data-composer-tool-menu-toggle]):not([data-composer-add-files])').forEach((button) => button.addEventListener('click', attachContextFiles));
  document.querySelectorAll('[data-remove-attachment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      removeAttachment(btn.dataset.removeAttachment);
      render();
    });
  });
  document.querySelectorAll('[data-retry-attachment]').forEach((btn) => {
    btn.addEventListener('click', () => retryAttachment(btn.dataset.retryAttachment));
  });
  document.querySelectorAll('[data-preview-attachment]').forEach((btn) => {
    btn.addEventListener('click', () => previewAttachment(btn.dataset.previewAttachment));
  });
  document.querySelectorAll('[data-add-emoji-favorite]').forEach((button) => {
    button.addEventListener('click', () => addMessageImageToFavorites(parsePreviewPayload(button.dataset.addEmojiFavorite || '')));
  });
  wireMessageEvents(document);
  document.querySelector('#close-preview-btn')?.addEventListener('click', () => {
    state.preview = null;
    render();
  });
  document.querySelector('.preview-overlay')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      state.preview = null;
      render();
    }
  });
  document.querySelector('#chat-form')?.addEventListener('submit', sendChat);
  document.querySelectorAll('[data-ubuddy-plan-action]').forEach((button) => button.addEventListener('click', () => {
    if (button.disabled) return;
    const input = document.getElementById('chat-input');
    const form = document.getElementById('chat-form');
    if (!input || !form || state.busy) return;
    const action = String(button.dataset.ubuddyPlanAction || '').trim();
    const englishAction = ({
      '确认派发': 'Confirm dispatch',
      '修改方案': 'Revise: ',
      '全员参与': 'All participate',
      '取消方案': 'Cancel dispatch',
    })[action] || action;
    input.value = state.languageMode === 'en'
      ? englishAction
      : action === '修改方案' ? '修改方案：' : action;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (action === '修改方案') {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    form.requestSubmit();
  }));
  document.querySelector('#cancel-chat-btn')?.addEventListener('click', cancelActiveChat);
  document.querySelector('#task-form')?.addEventListener('submit', createTask);
  document.querySelector('#auth-language-toggle')?.addEventListener('click', () => {
    setLanguageMode(state.languageMode === 'en' ? 'zh-CN' : 'en');
  });
  document.querySelector('#login-form')?.addEventListener('submit', loginAccount);
  document.querySelector('#send-login-code-btn')?.addEventListener('click', () => sendEmailCodeFromInput('login'));
  document.querySelector('#register-form')?.addEventListener('submit', registerAccount);
  document.querySelector('#send-register-code-btn')?.addEventListener('click', () => sendEmailCodeFromInput('register'));
  document.querySelector('#send-reset-code-btn')?.addEventListener('click', () => sendEmailCodeFromInput('password_reset'));
  document.querySelector('#send-password-change-code-btn')?.addEventListener('click', () => sendEmailCodeFromInput('password_change'));
  document.querySelector('#password-reset-form')?.addEventListener('submit', resetPasswordByEmail);
  document.querySelectorAll('#login-phone, #login-email, #login-code, #login-new-password, #login-identifier, #login-password, #reset-phone, #reset-email, #reset-code, #reset-new-password, #register-name, #register-email, #register-code, #register-password, #register-password-confirm').forEach((input) => {
    input.addEventListener('input', () => {
      syncAuthDraftFromDom();
      refreshEmailCodeButtonState();
    });
  });
  document.querySelector('#show-password-reset-btn')?.addEventListener('click', () => {
    syncAuthDraftFromDom();
    state.authScreen = 'reset';
    state.authResetMode = 'email';
    state.emailCodeNotice = null;
    state.authFeedback = null;
    render();
  });
  document.querySelector('#show-register-btn')?.addEventListener('click', () => {
    syncAuthDraftFromDom();
    state.authScreen = 'register';
    state.emailCodeNotice = null;
    state.authFeedback = null;
    render();
  });
  document.querySelector('#back-to-login-btn')?.addEventListener('click', () => {
    syncAuthDraftFromDom();
    state.authScreen = 'login';
    state.emailCodeNotice = null;
    state.authFeedback = null;
    render();
  });
  document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      syncAuthDraftFromDom();
      state.authMode = btn.dataset.authMode || 'phone';
      state.authScreen = 'login';
      state.emailCodeNotice = null;
      state.authFeedback = null;
      render();
    });
  });
  document.querySelectorAll('[data-auth-reset-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      syncAuthDraftFromDom();
      state.authResetMode = btn.dataset.authResetMode || 'email';
      state.emailCodeNotice = null;
      state.authFeedback = null;
      render();
    });
  });
  document.querySelector('[data-profile-avatar-preview]')?.addEventListener('click', previewProfileAvatar);
  document.querySelector('[data-profile-avatar-select]')?.addEventListener('click', () => document.querySelector('#profile-avatar-input')?.click());
  document.querySelector('[data-profile-avatar-remove]')?.addEventListener('click', removeProfileAvatar);
  document.querySelector('#profile-avatar-input')?.addEventListener('change', chooseProfileAvatar);
  document.querySelector('#profile-form')?.addEventListener('submit', saveProfile);
  document.querySelector('#password-form')?.addEventListener('submit', changePassword);
  document.querySelector('#logout-btn')?.addEventListener('click', logoutAccount);
  document.querySelector('#refresh-friends-btn')?.addEventListener('click', refreshFriends);
  document.querySelector('[data-conversation-search-toggle]')?.addEventListener('click', () => {
    const toggle = document.querySelector('[data-conversation-search-toggle]');
    const popover = document.querySelector('#network-conversation-search-popover');
    const input = document.querySelector('#network-conversation-search');
    if (!toggle || !popover || !input) return;
    const opening = popover.hidden;
    state.networkMessageSearchOpen = opening;
    popover.hidden = !opening;
    toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (opening) {
      requestAnimationFrame(() => input.focus());
      return;
    }
    resetNetworkMessageSearch({ close: true });
    applyNetworkMessageSearchFilter(input);
    toggle.focus();
  });
  const conversationSearchInput = document.querySelector('#network-conversation-search');
  conversationSearchInput?.addEventListener('compositionstart', () => {
    networkMessageSearchComposing = true;
    clearTimeout(networkMessageSearchTimer);
    networkMessageSearchRequestId += 1;
  });
  conversationSearchInput?.addEventListener('compositionend', (event) => {
    networkMessageSearchComposing = false;
    state.networkMessageSearchOpen = true;
    state.networkMessageSearchQuery = event.target.value || '';
    applyNetworkMessageSearchFilter(event.target);
    scheduleNetworkMessageSearch();
  });
  conversationSearchInput?.addEventListener('input', (event) => {
    if (networkMessageSearchComposing || event.isComposing) return;
    state.networkMessageSearchOpen = true;
    state.networkMessageSearchQuery = event.target.value || '';
    applyNetworkMessageSearchFilter(event.target);
    scheduleNetworkMessageSearch();
  });
  conversationSearchInput?.addEventListener('keydown', (event) => {
    if (networkMessageSearchComposing || event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    const toggle = document.querySelector('[data-conversation-search-toggle]');
    const popover = document.querySelector('#network-conversation-search-popover');
    resetNetworkMessageSearch({ close: true });
    applyNetworkMessageSearchFilter(event.currentTarget);
    if (popover) popover.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    toggle?.focus();
  });
  document.querySelector('[data-conversation-search-clear]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const input = document.querySelector('#network-conversation-search');
    if (!input) return;
    resetNetworkMessageSearch();
    applyNetworkMessageSearchFilter(input);
    input.focus();
  });
  applyNetworkMessageSearchFilter(conversationSearchInput);
  const directorySearchInput = document.querySelector('#friend-search-query');
  if (directorySearchInput) {
    const updateDirectorySearch = (value = directorySearchInput.value) => {
      state.friendSearchQuery = value || '';
      render();
    };
    directorySearchInput.addEventListener('compositionstart', () => { directorySearchComposing = true; });
    directorySearchInput.addEventListener('compositionend', (event) => {
      directorySearchComposing = false;
      updateDirectorySearch(event.target.value);
    });
    directorySearchInput.addEventListener('input', (event) => {
      if (directorySearchComposing || event.isComposing) return;
      updateDirectorySearch(event.target.value);
    });
    directorySearchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !state.friendSearchQuery) return;
      event.preventDefault();
      clearFriendSearch();
    });
  }
  document.querySelectorAll('[data-contact-add-open]').forEach((btn) => {
    btn.addEventListener('click', () => openContactAddDialog(btn.dataset.contactAddOpen || 'contact', {
      targetUserId: btn.dataset.contactAddTarget || '',
    }));
  });
  document.querySelectorAll('[data-contact-add-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchContactAddDialogTab(btn.dataset.contactAddTab || 'contact'));
  });
  document.querySelectorAll('[data-contact-add-close]').forEach((target) => {
    target.addEventListener('click', (event) => {
      if (event.target.closest('[data-contact-add-dialog]') && !event.target.closest('[data-contact-add-close]:not(.contact-add-dialog-scrim)')) return;
      closeContactAddDialog({ focusDirectory: true });
    });
  });
  document.querySelector('[data-contact-add-dialog]')?.addEventListener('keydown', (event) => {
    if (!isPlainEscapeShortcut(event) || event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.target?.dataset?.imeComposing === 'true') return;
    event.preventDefault();
    closeContactAddDialog({ focusDirectory: true });
  });
  document.querySelector('#contact-add-search-form')?.addEventListener('submit', searchFriends);
  document.querySelector('#friend-add-search-query')?.addEventListener('input', (event) => {
    state.friendAddSearchQuery = event.target.value || '';
    if (!state.friendSearchResultQuery || state.friendSearchResultQuery === state.friendAddSearchQuery.trim()) return;
    state.friendSearchResults = [];
    state.friendSearchResultQuery = '';
    state.friendRequestTargetId = '';
    state.friendRequestMessage = '';
    render();
    requestAnimationFrame(() => {
      const input = document.querySelector('#friend-add-search-query');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  });
  document.querySelector('#organization-join-form')?.addEventListener('submit', joinOrganization);
  document.querySelector('#organization-join-link-form')?.addEventListener('submit', joinOrganization);
  document.querySelector('#organization-create-form')?.addEventListener('submit', createOrganization);
  document.querySelector('#organization-join-number')?.addEventListener('input', (event) => {
    state.organizationJoinDraft = { ...(state.organizationJoinDraft || {}), organizationNumber: event.target.value || '' };
  });
  document.querySelector('#organization-join-code')?.addEventListener('input', (event) => {
    state.organizationJoinDraft = { ...(state.organizationJoinDraft || {}), verificationCode: event.target.value || '' };
  });
  document.querySelector('#organization-join-link')?.addEventListener('input', (event) => {
    state.organizationJoinDraft = { ...(state.organizationJoinDraft || {}), shareLink: event.target.value || '' };
  });
  document.querySelector('#organization-join-default')?.addEventListener('change', (event) => {
    state.organizationJoinDraft = { ...(state.organizationJoinDraft || {}), setAsDefault: event.target.checked };
  });
  document.querySelector('#organization-create-name')?.addEventListener('input', (event) => {
    state.organizationCreateDraft = { ...(state.organizationCreateDraft || {}), name: event.target.value || '' };
  });
  document.querySelector('#organization-create-number')?.addEventListener('input', (event) => {
    state.organizationCreateDraft = { ...(state.organizationCreateDraft || {}), organizationNumber: event.target.value || '' };
  });
  document.querySelector('#organization-create-code')?.addEventListener('input', (event) => {
    state.organizationCreateDraft = { ...(state.organizationCreateDraft || {}), verificationCode: event.target.value || '' };
  });
  document.querySelectorAll('[data-contact-directory-context]').forEach((surface) => {
    surface.addEventListener('contextmenu', (event) => {
      if (event.target.closest('a, input, textarea, select, [contenteditable="true"], .friend-request-actions button')) return;
      event.preventDefault();
      const contact = event.target.closest('[data-contact-profile]');
      state.contactDirectoryContextMenu = {
        x: Math.min(event.clientX, Math.max(8, window.innerWidth - 206)),
        y: Math.min(event.clientY, Math.max(8, window.innerHeight - 132)),
        targetUserId: contact?.dataset.contactProfile || '',
        organizationId: contact?.dataset.organizationMember || '',
        targetRole: contact?.dataset.organizationRole || 'member',
      };
      state.networkContactProfileOpen = false;
      render();
    });
  });
  const organizationHeaderMenus = [...document.querySelectorAll('.contacts-organization-share, .contacts-organization-switch')];
  organizationHeaderMenus.forEach((menu) => {
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      organizationHeaderMenus.forEach((other) => {
        if (other !== menu) other.open = false;
      });
    });
  });
  document.querySelector('.app-frame')?.addEventListener('click', (event) => {
    if (event.target.closest('.contacts-organization-share, .contacts-organization-switch')) return;
    organizationHeaderMenus.forEach((menu) => { menu.open = false; });
  });
  document.querySelectorAll('[data-organization-share-generate]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openOrganizationActionDialog('generate_invitation_link', {
        organizationId: button.dataset.organizationShareGenerate || '',
      });
    });
  });
  document.querySelectorAll('[data-organization-share-view]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openOrganizationActionDialog('view_invitation_link', {
        organizationId: button.dataset.organizationShareView || '',
      });
    });
  });
  document.querySelectorAll('[data-organization-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openOrganizationActionDialog(button.dataset.organizationAction || '', {
        organizationId: button.dataset.organizationId || '',
        targetUserId: button.dataset.organizationTarget || '',
      });
    });
  });
  document.querySelectorAll('[data-organization-exit]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const organizationId = button.dataset.organizationExit || '';
      const organization = (state.friendOverview?.organizations || []).find((item) => item.id === organizationId);
      openOrganizationActionDialog(organization?.role === 'owner' ? 'owner_exit' : 'request_exit', { organizationId });
    });
  });
  document.querySelectorAll('[data-organization-exit-review]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const request = (state.friendOverview?.organizationExitRequests || []).find((item) => item.id === button.dataset.organizationExitReview);
      openOrganizationActionDialog('resolve_exit', { organizationId: button.dataset.organizationId || request?.organizationId || '', requestId: request?.id || '', requester: request?.requester || null });
    });
  });
  document.querySelectorAll('[data-organization-notice-ack]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        const result = await window.janus.organizationAction({ action: 'acknowledge_notice', organizationId: button.dataset.organizationId || '', noticeId: button.dataset.organizationNoticeAck || '' });
        if (result?.overview) state.friendOverview = result.overview;
      } catch (error) {
        notify(`无法关闭组织提醒：${userVisibleErrorMessage(error)}`, 'error');
      }
      render();
    });
  });
  document.querySelectorAll('[data-organization-action-close]').forEach((target) => target.addEventListener('click', (event) => {
    if (event.currentTarget.classList.contains('organization-action-scrim') && event.target !== event.currentTarget) return;
    state.organizationActionDialog = null;
    state.organizationActionBusy = false;
    render();
  }));
  document.querySelectorAll('[data-organization-invite-close]').forEach((target) => target.addEventListener('click', (event) => {
    if (event.currentTarget.classList.contains('organization-action-scrim') && event.target !== event.currentTarget) return;
    state.organizationInvitePrompt = null;
    state.organizationInviteBusy = false;
    render();
  }));
  document.querySelector('#organization-invite-default')?.addEventListener('change', (event) => {
    if (state.organizationInvitePrompt) {
      state.organizationInvitePrompt = { ...state.organizationInvitePrompt, setAsDefault: event.target.checked };
    }
  });
  document.querySelector('[data-organization-share-link-copy]')?.addEventListener('click', async () => {
    const link = String(document.querySelector('#organization-share-link-value')?.value || '').trim();
    if (!link) return;
    try {
      await writeClipboardText(link);
      lastHandledOrganizationInviteLink = link;
      notify('组织分享链接已复制。', 'success');
    } catch (error) {
      notify(`复制分享链接失败：${userVisibleErrorMessage(error)}`, 'error');
    }
  });
  document.querySelector('[data-organization-share-regenerate]')?.addEventListener('click', () => {
    if (!state.organizationActionDialog) return;
    state.organizationActionDialog = {
      ...state.organizationActionDialog,
      action: 'generate_invitation_link',
      regenerate: true,
      verificationCode: document.querySelector('#organization-share-invitation-code')?.value || '',
    };
    render();
    requestAnimationFrame(() => document.querySelector('#organization-share-invitation-code')?.focus());
  });
  document.querySelector('[data-organization-invite-confirm]')?.addEventListener('click', confirmOrganizationInvite);
  document.querySelector('#organization-action-form')?.addEventListener('submit', submitOrganizationAction);
  document.querySelector('[data-organization-invitation-reset-open]')?.addEventListener('click', openOrganizationInvitationResetDialog);
  document.querySelector('[data-organization-invitation-reset-from-share]')?.addEventListener('click', () => {
    const dialog = state.organizationActionDialog;
    if (!dialog?.organizationId) return;
    openOrganizationActionDialog('reset_invitation_code', {
      organizationId: dialog.organizationId,
      organizationName: dialog.organizationName || '',
      invitationResetCodeSent: false,
    });
  });
  document.querySelector('[data-organization-invitation-reset-back]')?.addEventListener('click', returnToOrganizationInvitationUpdateDialog);
  document.querySelector('[data-organization-invitation-reset-send-code]')?.addEventListener('click', sendOrganizationInvitationResetCode);
  document.querySelector('#organization-owner-exit-mode')?.addEventListener('change', (event) => {
    const field = document.querySelector('[data-owner-successor-field]');
    if (field) field.hidden = event.target.value !== 'transfer';
  });
  document.querySelectorAll('[data-friend-request]').forEach((btn) => {
    btn.addEventListener('click', () => openFriendRequestComposer(btn.dataset.friendRequest));
  });
  document.querySelector('#friend-request-form')?.addEventListener('submit', submitFriendRequest);
  document.querySelector('#cancel-friend-request-btn')?.addEventListener('click', closeFriendRequestComposer);
  document.querySelector('#friend-request-message')?.addEventListener('input', (event) => {
    state.friendRequestMessage = event.target.value || '';
  });
  document.querySelectorAll('[data-friend-accept]').forEach((btn) => {
    btn.addEventListener('click', () => acceptFriendRequest(btn.dataset.friendAccept));
  });
  document.querySelectorAll('[data-friend-reject]').forEach((btn) => {
    btn.addEventListener('click', () => rejectFriendRequest(btn.dataset.friendReject));
  });
  document.querySelectorAll('[data-friend-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => cancelFriendRequest(btn.dataset.friendCancel));
  });
  document.querySelectorAll('[data-friend-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeFriend(btn.dataset.friendRemove));
  });
  document.querySelectorAll('[data-friend-remark]').forEach((btn) => {
    btn.addEventListener('click', () => updateFriendRemark(btn.dataset.friendRemark || ''));
  });
  document.querySelectorAll('[data-organization-display-name]').forEach((btn) => {
    btn.addEventListener('click', () => openOrganizationDisplayName(btn.dataset.organizationDisplayName || '', btn.dataset.currentDisplayName || ''));
  });
  document.querySelectorAll('[data-friend-block]').forEach((btn) => {
    btn.addEventListener('click', () => blockFriend(btn.dataset.friendBlock));
  });
  document.querySelectorAll('[data-agent-delegation-create]').forEach((btn) => {
    btn.addEventListener('click', () => createAgentDelegationForFriend(btn.dataset.agentDelegationCreate));
  });
  document.querySelectorAll('[data-agent-delegation-start]').forEach((btn) => {
    btn.addEventListener('click', () => startAgentDelegation(btn.dataset.agentDelegationStart));
  });
  document.querySelector('#codex-config-form')?.addEventListener('submit', saveCodexConfig);
  document.querySelector('#toggle-codex-api-key-btn')?.addEventListener('click', toggleCodexApiKeyVisibility);
  document.querySelector('#codex-model')?.addEventListener('change', updateCodexReasoningOptions);
  bindSettingsCustomSelects();
  document.querySelector('[data-advanced-model-service-disclosure]')?.addEventListener('toggle', (event) => {
    state.advancedModelServiceOpen = Boolean(event.currentTarget.open);
  });
  document.querySelector('#codex-file-config-form')?.addEventListener('submit', saveCodexConfigFiles);
  document.querySelector('#provider-key-application-form')?.addEventListener('submit', requestProviderKeyApplication);
  document.querySelectorAll('[data-provider-key-refresh]').forEach((button) => {
    button.addEventListener('click', () => loadProviderKeyApplications());
  });
  document.querySelectorAll('[data-provider-key-decision]').forEach((button) => {
    button.addEventListener('click', () => decideProviderKeyApplication(button.dataset.applicationId || '', button.dataset.providerKeyDecision || ''));
  });
  document.querySelectorAll('[data-provider-key-claim]').forEach((button) => {
    button.addEventListener('click', () => claimProviderKeyApplication(button.dataset.providerKeyClaim || ''));
  });
  document.querySelector('#send-provider-key-email-code-btn')?.addEventListener('click', sendProviderKeyEmailCode);
  document.querySelector('#verify-provider-key-email-btn')?.addEventListener('click', verifyProviderKeyEmail);
  document.querySelector('#provider-key-email-code')?.addEventListener('input', (event) => {
    state.providerKeyEmailCode = event.target.value;
  });
  document.querySelectorAll('[data-codex-config-mode]').forEach((btn) => {
    btn.addEventListener('click', () => switchCodexConfigMode(btn.dataset.codexConfigMode));
  });
  document.querySelector('#codex-auth-json')?.addEventListener('input', (event) => {
    state.codexConfigFiles = {
      ...(state.codexConfigFiles || {}),
      authJson: event.target.value,
    };
  });
  document.querySelector('#codex-config-toml')?.addEventListener('input', (event) => {
    state.codexConfigFiles = {
      ...(state.codexConfigFiles || {}),
      configToml: event.target.value,
    };
  });
  document.querySelector('#format-auth-json-btn')?.addEventListener('click', formatCodexAuthJson);
  document.querySelector('#reload-codex-files-btn')?.addEventListener('click', reloadCodexConfigFiles);
  document.querySelectorAll('[data-task]').forEach((btn) => {
    btn.addEventListener('click', () => openTask(btn.dataset.task));
  });
  document.querySelectorAll('[data-collab-event-history]').forEach((button) => {
    button.addEventListener('click', () => {
      const taskId = String(button.dataset.collabEventHistory || '');
      state.collaborationEventHistoryOpenByTaskId = {
        ...(state.collaborationEventHistoryOpenByTaskId || {}),
        [taskId]: !state.collaborationEventHistoryOpenByTaskId?.[taskId],
      };
      render();
    });
  });
  const updateCollaborationCodexToggle = (toggleId = '', field = '', open = false) => {
    const separator = toggleId.indexOf('::');
    const transcriptId = separator >= 0 ? toggleId.slice(0, separator) : '';
    const activityId = separator >= 0 ? toggleId.slice(separator + 2) : '';
    const taskId = transcriptId.startsWith('task-') ? transcriptId.slice(5) : '';
    if (!taskId || !activityId) return;
    const task = (state.tasks || []).find((item) => item.id === taskId)
      || (state.taskDetail?.id === taskId ? state.taskDetail : null);
    const taskEvent = task?.events?.find((item) => String(item.payload?.activityId || item.activityId || item.id || '') === activityId);
    if (!taskEvent) return;
    if (taskEvent.payload && typeof taskEvent.payload === 'object') taskEvent.payload[field] = open;
    else taskEvent[field] = open;
  };
  document.querySelectorAll('.collaboration-view [data-codex-command-group-toggle]').forEach((details) => {
    details.addEventListener('toggle', () => {
      updateCollaborationCodexToggle(String(details.dataset.codexCommandGroupToggle || ''), 'commandGroupExpanded', details.open);
    });
  });
  document.querySelectorAll('.collaboration-view [data-codex-command-toggle]').forEach((details) => {
    details.addEventListener('toggle', () => {
      updateCollaborationCodexToggle(String(details.dataset.codexCommandToggle || ''), 'expanded', details.open);
    });
  });
  document.querySelector('#run-ready-btn')?.addEventListener('click', runReadyTaskNodes);
  document.querySelectorAll('#network-panel [data-task-card-action]').forEach((button) => {
    button.addEventListener('click', () => handleTaskCardAction(button));
  });
  const bindGlobalFileAction = (selector, action, handler) => {
    document.querySelectorAll(selector).forEach((button) => {
      if (button.closest('.chat-view')) return;
      const boundActions = button.__janusFileActionListeners || new Set();
      if (boundActions.has(action)) return;
      boundActions.add(action);
      button.__janusFileActionListeners = boundActions;
      button.addEventListener('click', () => handler(button));
    });
  };
  bindGlobalFileAction('[data-preview-file]', 'preview', (button) => previewFileInfo(parsePreviewPayload(button.dataset.previewFile || '')));
  bindGlobalFileAction('[data-copy-image]', 'copy-image', (button) => copyImageFromPayload(parsePreviewPayload(button.dataset.copyImage || '')));
  bindGlobalFileAction('[data-save-file]', 'save', (button) => saveFileFromPayload(parsePreviewPayload(button.dataset.saveFile || '')));
  bindGlobalFileAction('[data-show-file]', 'show', (button) => showFileFromPayload(parsePreviewPayload(button.dataset.showFile || '')));
  bindGlobalFileAction('[data-open-file]', 'open', (button) => openFileFromPayload(parsePreviewPayload(button.dataset.openFile || '')));
  document.querySelectorAll('[data-accept-delivery-submission]').forEach((button) => {
    button.addEventListener('click', () => acceptTaskDeliverySubmission(button));
  });
  document.querySelectorAll('[data-request-delivery-revision]').forEach((button) => {
    button.addEventListener('click', () => requestTaskDeliveryRevision(button));
  });
  hydrateRemoteImageAttachmentThumbnails(document);
  hydrateRemoteFavoriteEmojiAttachments(document);
  document.querySelectorAll('[data-open-collaboration-task]').forEach((button) => {
    button.addEventListener('click', () => openCollaborationTask(button.dataset.openCollaborationTask || ''));
  });
  document.querySelectorAll('[data-cancel-ubuddy-task]').forEach((button) => {
    button.addEventListener('click', () => cancelUBuddyTask(button.dataset.cancelUbuddyTask || ''));
  });
  document.querySelectorAll('[data-cancel-pending-dispatch]').forEach((button) => {
    button.addEventListener('click', () => cancelPendingUBuddyDispatch(button.dataset.cancelPendingDispatch || ''));
  });
  document.querySelectorAll('[data-rerun-ubuddy-task]').forEach((button) => {
    button.addEventListener('click', () => rerunUBuddyTask(button.dataset.rerunUbuddyTask || ''));
  });
  document.querySelectorAll('[data-retry-task-node]').forEach((button) => {
    button.addEventListener('click', () => retryFailedTaskNode(
      button.dataset.retryTask || '',
      button.dataset.retryTaskNode || '',
    ));
  });
  document.querySelectorAll('[data-focus-delegation-composer]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.querySelector('#network-delegation-comment-input');
      input?.focus();
      input?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    });
  });
  document.querySelectorAll('[data-work-memory-refresh]').forEach((btn) => {
    btn.addEventListener('click', () => refreshTaskWorkMemory(btn.dataset.workMemoryRefresh));
  });
  document.querySelectorAll('[data-resolve-communication]').forEach((btn) => {
    btn.addEventListener('click', () => resolveCommunication(btn.dataset.resolveCommunication, btn));
  });
  document.querySelector('#dry-run-evolution')?.addEventListener('change', (event) => {
    state.dryRunEvolution = event.target.checked;
  });
  document.querySelectorAll('[data-evolution-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.evolutionScope = btn.dataset.evolutionScope === 'lab' ? 'lab' : 'agents';
      state.evolutionDetail = null;
      render();
    });
  });
  document.querySelectorAll('[data-evolution-detail-id]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      state.evolutionDetail = {
        scope: row.dataset.evolutionDetailScope === 'lab' ? 'lab' : 'agents',
        id: row.dataset.evolutionDetailId || '',
        kind: row.dataset.evolutionDetailKind || '',
      };
      render();
    });
  });
  document.querySelector('[data-evolution-back]')?.addEventListener('click', () => {
    state.evolutionDetail = null;
    render();
  });
  document.querySelector('#evolution-search-input')?.addEventListener('input', (event) => {
    state.evolutionSearchQuery = event.target.value || '';
    state.evolutionDetail = null;
    render();
    setTimeout(() => {
      const input = document.getElementById('evolution-search-input');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  });
  document.querySelector('#run-evolution-btn')?.addEventListener('click', runEvolution);
  document.querySelector('#calibrate-gate-btn')?.addEventListener('click', calibrateGate);
  document.querySelector('#apply-memory-policy-btn')?.addEventListener('click', applyMemoryPolicy);
  document.querySelector('[data-ubuddy-org-evolution-refresh]')?.addEventListener('click', refreshUBuddyOrganizationEvolution);
  document.querySelector('[data-ubuddy-org-evolution-disable]')?.addEventListener('click', disableUBuddyOrganizationEvolution);
  document.querySelectorAll('[data-ubuddy-org-evolution-activate]').forEach((button) => {
    button.addEventListener('click', () => activateUBuddyOrganizationEvolution(button.dataset.ubuddyOrgEvolutionActivate || ''));
  });
  document.querySelectorAll('[data-archive-label]').forEach((btn) => {
    btn.addEventListener('click', () => labelArchive(btn.dataset.archiveLabel, btn.dataset.archiveId, btn.dataset.label));
  });
  document.querySelectorAll('[data-skill-rollback]').forEach((btn) => {
    btn.addEventListener('click', () => rollbackSkill(btn.dataset.skillRollback));
  });
  document.querySelectorAll('[data-specialist-start]').forEach((btn) => {
    btn.addEventListener('click', () => startSpecialistExperiment(btn.dataset.specialistStart));
  });
  document.querySelectorAll('[data-specialist-evaluate]').forEach((btn) => {
    btn.addEventListener('click', () => evaluateSpecialistExperiment(btn.dataset.specialistEvaluate));
  });
  document.querySelectorAll('[data-specialist-finalize]').forEach((btn) => {
    btn.addEventListener('click', () => finalizeSpecialistExperiment(btn.dataset.specialistFinalize, btn.dataset.decision));
  });
}



async function setStartupOrganizationWorkspace(workspaceId = '') {
  const targetId = String(workspaceId || '').trim();
  if (!targetId) return;
  try {
    const result = await window.janus.setStartupAccountWorkspace({ workspaceId: targetId });
    state.startupAccountWorkspace = result?.startupWorkspace || state.startupAccountWorkspace;
    state.accountWorkspaces = result?.workspaces || state.accountWorkspaces;
    notify(`默认组织已设为 ${state.startupAccountWorkspace?.name || '所选组织'}。`, 'success');
  } catch (error) {
    notify(userVisibleErrorMessage(error, '保存默认组织失败。'), 'error');
  }
  render();
}

function closeChatAvatarProfile({ restoreFocus = true } = {}) {
  const userId = String(state.chatAvatarProfile?.userId || '');
  state.chatAvatarProfile = null;
  render();
  if (!restoreFocus || !userId) return;
  requestAnimationFrame(() => {
    const avatar = [...document.querySelectorAll('[data-chat-avatar-profile]')]
      .find((item) => String(item.dataset.chatAvatarProfile || '') === userId);
    avatar?.focus?.({ preventScroll: true });
  });
}

function applyOptimisticMessageReaction({ kind = "direct", messageId = "", emoji = "" } = {}) {
  const userId = String(state.currentUser?.id || "").trim();
  if (!userId || !messageId || !emoji) return () => {};
  const displayName = String(state.currentUser?.displayName || state.currentUser?.display_name || state.currentUser?.name || "我").trim();
  const updateMessage = (message) => String(message?.id || "") === String(messageId)
    ? { ...message, metadata: toggleMessageReaction(message.metadata || {}, { emoji, userId, displayName }) }
    : message;
  if (kind === "group") {
    const previous = state.chatGroupDetail;
    state.chatGroupDetail = previous ? { ...previous, messages: (previous.messages || []).map(updateMessage) } : previous;
    return () => { state.chatGroupDetail = previous; };
  }
  const previousMessages = state.networkConversationMessages;
  const previousConversation = state.networkConversation;
  state.networkConversationMessages = (previousMessages || []).map(updateMessage);
  if (previousConversation?.message) state.networkConversation = { ...previousConversation, message: updateMessage(previousConversation.message) };
  return () => {
    state.networkConversationMessages = previousMessages;
    state.networkConversation = previousConversation;
  };
}

function closeMessageReactionPicker() {
  if (!state.messageReactionPicker) return;
  state.messageReactionPicker = null;
}

function hasOpenMessageReactionPicker() {
  return Boolean(state.messageReactionPicker?.messageId);
}

function positionMessageReceiptPopover(anchor = null) {
  const popover = document.querySelector('[data-message-receipt-popover]');
  if (!popover || !anchor) return;
  const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
  const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
  const bounds = popover.getBoundingClientRect();
  const layout = messageReceiptPopoverLayout({
    anchor, popoverWidth: bounds.width, popoverHeight: bounds.height, viewportWidth, viewportHeight,
  });
  const { placement, left, top, availableHeight } = layout;
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.style.maxHeight = `${availableHeight}px`;
  popover.dataset.placement = placement;
  state.messageReceiptPopover = { ...state.messageReceiptPopover, left, top, placement };
  popover.focus({ preventScroll: true });
}

function wireVisibleChatGroupReadReceipt() {
  const groupId = String(state.chatGroupId || '').trim();
  const currentUserId = String(state.currentUser?.id || '').trim();
  if (!groupId || !currentUserId || document.visibilityState === 'hidden' || typeof IntersectionObserver !== 'function') return;
  const incomingIds = new Set((state.chatGroupDetail?.messages || [])
    .filter((message) => message.kind !== 'system' && String(message.senderUserId || message.sender_user_id || '') !== currentUserId)
    .map((message) => String(message.id || '')).filter(Boolean));
  if (!incomingIds.size) return;
  const visible = [];
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const messageId = String(entry.target?.dataset?.messageId || '');
      if (entry.isIntersecting && entry.intersectionRatio >= 0.55 && incomingIds.has(messageId)) visible.push(messageId);
    }
    if (!visible.length) return;
    const ordered = (state.chatGroupDetail?.messages || []).map((message) => String(message.id || ''));
    const readThroughMessageId = visible.sort((left, right) => ordered.indexOf(right) - ordered.indexOf(left))[0];
    const ackKey = `${groupId}:${readThroughMessageId}`;
    if (state.chatGroupReadReceiptAckKey === ackKey) return;
    state.chatGroupReadReceiptAckKey = ackKey;
    observer.disconnect();
    window.janus.markChatGroupRead?.({ groupId, readThroughMessageId }).catch(() => {
      if (state.chatGroupReadReceiptAckKey === ackKey) state.chatGroupReadReceiptAckKey = '';
    });
  }, { root: document.getElementById('message-list'), threshold: [0.55] });
  document.querySelectorAll('.natural-chat-group-view [data-message-id]').forEach((element) => {
    if (incomingIds.has(String(element.dataset.messageId || ''))) observer.observe(element);
  });
}

async function switchRendererAccountWorkspace(workspaceId = '', { notifySuccess = true, notifyError = true } = {}) {
  const targetId = String(workspaceId || '').trim();
  if (!targetId || state.workspaceSwitchBusy || targetId === state.activeAccountWorkspace?.id) {
    state.accountWorkspaceMenuOpen = false;
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    state.accountMenuWorkspaceMoreOpen = false;
    state.organizationSettingsWorkspaceMoreOpen = false;
    state.organizationSettingsWorkspaceMorePosition = null;
    render();
    return targetId === state.activeAccountWorkspace?.id;
  }
  preserveCurrentComposerDraft();
  const generation = Number(state.workspaceSwitchGeneration || 0) + 1;
  const targetWorkspace = (state.accountWorkspaces || []).find((workspace) => String(workspace.id || '') === targetId) || null;
  state.workspaceSwitchGeneration = generation;
  state.workspaceSwitchBusy = true;
  state.workspaceSwitchTargetName = targetWorkspace?.kind === 'personal'
    ? translateUiText('个人空间', state.languageMode)
    : String(targetWorkspace?.name || translateUiText('所选工作空间', state.languageMode));
  state.accountWorkspaceMenuOpen = false;
  state.accountMenuOpen = false;
  state.accountMenuWorkspaceOpen = false;
  state.accountMenuWorkspaceMoreOpen = false;
  state.organizationSettingsWorkspaceMoreOpen = false;
  state.organizationSettingsWorkspaceMorePosition = null;
  render();
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  try {
    const result = await window.janus.switchAccountWorkspace({ workspaceId: targetId });
    if (generation !== state.workspaceSwitchGeneration) return false;
    const boot = result?.bootstrap;
    if (!boot || result?.activeWorkspace?.id !== targetId) throw new Error('组织切换结果不完整。');
    resetWorkspaceScopedRendererState(targetId);
    applyWorkspaceBootstrap(boot);
    syncRecentAccountWorkspaceState();
    hydrateComposerDrafts();
    if (notifySuccess) {
      const switchedName = result.activeWorkspace.kind === 'personal'
        ? (state.languageMode === 'en' ? 'Personal Workspace' : '个人空间')
        : result.activeWorkspace.name || (state.languageMode === 'en' ? 'Organization' : '组织');
      notify(state.languageMode === 'en' ? `Switched to ${switchedName}.` : `已切换到${switchedName}。`, 'success');
    }
    return true;
  } catch (error) {
    if (generation === state.workspaceSwitchGeneration && notifyError) notify(userVisibleErrorMessage(error, '切换工作空间失败。'), 'error');
    return false;
  } finally {
    if (generation === state.workspaceSwitchGeneration) {
      state.workspaceSwitchBusy = false;
      state.workspaceSwitchTargetName = '';
      render();
    }
  }
}

function handleAccountWorkspaceShortcutClick(event) {
  const button = event.target?.closest?.('[data-account-workspace-shortcut]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  void switchRendererAccountWorkspace(button.dataset.accountWorkspaceId || '');
}

async function activateJoinedOrganizationWorkspace(organization = {}, { setAsDefault = true } = {}) {
  const workspaceId = organizationAccountWorkspaceId(organization?.id || '');
  if (!workspaceId) return { switched: false, defaultSaved: false };
  let defaultSaved = !setAsDefault;
  if (setAsDefault) {
    try {
      const result = await window.janus.setStartupAccountWorkspace({ workspaceId });
      state.startupAccountWorkspace = result?.startupWorkspace || state.startupAccountWorkspace;
      state.accountWorkspaces = result?.workspaces || state.accountWorkspaces;
      defaultSaved = true;
    } catch (error) {
      notify(userVisibleErrorMessage(error, '组织已加入，但保存默认工作空间失败。'), 'warning');
    }
  }
  let switched = false;
  try {
    switched = await switchRendererAccountWorkspace(workspaceId, { notifySuccess: false, notifyError: false }) === true;
  } catch {
    switched = false;
  }
  return { switched, defaultSaved };
}

function resetWorkspaceScopedRendererState(nextWorkspaceId = '') {
  composerDraftController.clearRuntime();
  followerController.resetWorkspace(nextWorkspaceId || 'workspace_personal');
  state.followerWorkspaceOpen = false;
  state.uBuddyMessageMode = 'task';
  state.uBuddyMessageModeMenuOpen = false;
  state.uBuddyParticipantSelectionMenuOpen = false;
  state.sessions = [];
  state.projects = [];
  state.tasks = [];
  state.messages = [];
  state.messagePagination = { sessionId: '', source: '', nextCursor: null, hasMore: false, loading: false, initialLoading: false };
  state.currentSessionId = '';
  state.currentChatKey = `workspace:${String(nextWorkspaceId || 'workspace_personal')}:new:${Date.now()}`;
  state.activeChatRun = null;
  state.chatAvatarProfile = null;
  state.interactionMode = '';
  state.currentProjectId = '';
  state.currentDepartmentId = '';
  state.currentAgentId = '';
  state.currentAgentInstanceId = '';
  state.activeProjectId = '';
  state.taskDetail = null;
  state.activeTaskSourceContext = null;
  state.activeTaskReturnAnchorId = '';
  state.activeTaskReturnSurface = '';
  state.activeTaskWorkspaceKind = '';
  state.activeTaskWorkspaceId = '';
  state.taskResultSubmissionById = {};
  state.taskWorkspaceReturnContext = null;
  state.socialInbox = [];
  state.socialThreads = [];
  state.preloadedMessagePagesBySessionId = {};
  state.networkPanelLoading = false;
  state.networkPanelError = '';
  state.networkConversationMessages = [];
  state.networkConversationPeerId = '';
  state.networkConversationGroupId = '';
  state.networkDelegationId = '';
  state.agentDelegations = [];
  state.collaborationOverview = { groups: [], tasks: [] };
  state.chatGroupsOverview = { groups: [], capability: 'chat-groups-v2' };
  state.chatGroupId = '';
  state.chatGroupDetail = null;
  state.chatGroupDetailCache = {};
  state.chatGroupInviteOpen = false;
  state.chatGroupInviteUserId = '';
  state.chatGroupInviteGroupDetail = null;
  if (state.socialEditDialog?.type === 'chat-group-rename') state.socialEditDialog = null;
  state.collaborationGroupId = '';
  state.collaborationGroupDetail = null;
  state.collaborationGroupWorkspace = null;
  state.collaborationPaneByGroupId = {};
  state.collaborationMobilePaneByGroupId = {};
  state.collaborationSearchOpen = false;
  state.collaborationSearchQuery = '';
  state.collaborationSearchActiveIndex = 0;
  state.collaborationMembersOpen = false;
  state.collaborationAutoOpenedDispatchIds = {};
  state.friendOverview = { friends: [], requests: { incoming: [], outgoing: [] } };
  state.networkGroupProfileOpen = false;
  state.networkSelectedGroupKind = '';
  state.networkSelectedGroupId = '';
  state.contactsSelectedOrganizationId = '';
  state.organizationSettingsWorkspaceMoreOpen = false;
  state.organizationSettingsWorkspaceMorePosition = null;
  state.groupDirectoryProfileDetail = null;
  state.secretarySessionId = '';
  state.uBuddyConversationOpening = false;
  state.uBuddyTaskDrawerOpenBySessionId = {};
  state.uBuddyCenterOpen = '';
  state.uBuddyTaskCenterPage = null;
  state.uBuddyDeliveryCenterPage = null;
  state.uBuddyCenterLoading = false;
  state.uBuddyCenterError = '';
  taskReferenceOptionsRequestSequence += 1;
  state.composerTaskReference = null;
  state.taskReferenceMenuOpen = false;
  state.taskReferenceOptions = [];
  state.taskReferenceOptionsLoading = false;
  state.taskReferenceOptionsError = '';
  state.networkMessageHomeOpen = true;
  state.messageActivePane = 'list';
  state.messageGroupSidebarOpen = false;
  state.networkDelegationRunsById = {};
  state.networkDelegationProgressById = {};
  state.networkDelegationTaskById = {};
  state.agentWorkStatusByInstanceId = {};
  state.uBuddyCoordinationByTaskId = {};
  state.taskProgressOpenById = {};
  state.taskDisclosureOpenByKey = {};
  state.taskWorkspaceLoadingById = {};
  state.uBuddyTaskViewsById = {};
  state.uBuddyTaskViewLoadingById = {};
  state.uBuddyTaskViewErrorById = {};
    state.uBuddyTaskStripOpenBySessionId = {};
    state.uBuddyTaskStripFilterBySessionId = {};
    state.uBuddyTaskDrawerOpenBySessionId = {};
  state.uBuddyTaskUnseenBySessionId = {};
  state.messageViewStateByKey = {};
}

function applyWorkspaceBootstrap(boot = {}) {
  state.workspaceRoot = boot.workspaceRoot || boot.workspace_root || '';
  state.org = boot.org || state.org;
  state.currentUser = boot.currentUser || state.currentUser;
  state.accountWorkspaces = boot.accountWorkspaces || [];
  state.activeAccountWorkspace = boot.activeAccountWorkspace || null;
  state.startupAccountWorkspace = boot.startupAccountWorkspace || state.startupAccountWorkspace || null;
  state.uBuddyFeatureFlags = boot.uBuddyFeatureFlags || state.uBuddyFeatureFlags;
  state.uBuddyOrganizationEvolution = boot.uBuddyOrganizationEvolution || state.uBuddyOrganizationEvolution;
  applyDesktopLifecycle(boot.desktopLifecycle);
  state.sessions = boot.sessions || [];
  state.preloadedMessagePagesBySessionId = boot.messagePreload?.sessionPages || {};
  state.projects = boot.projects || [];
  state.tasks = boot.tasks || [];
  state.agentStatuses = boot.agentStatuses || [];
  state.employeeOverview = boot.employees || null;
  applyEmployeeWorkStatusSnapshot(state, state.employeeOverview?.roster || []);
  state.friendOverview = boot.friendOverview || { friends: [], requests: { incoming: [], outgoing: [] } };
  state.socialInbox = boot.socialInbox || [];
  state.socialThreads = boot.messagePreload?.socialThreads || [];
  state.conversationPreferences = boot.conversationPreferences || state.conversationPreferences || { preferences: [] };
  state.agentDelegations = boot.agentDelegations || [];
  state.collaborationOverview = boot.collaboration || { groups: [], tasks: state.agentDelegations };
  state.chatGroupsOverview = boot.chatGroups || { groups: [], capability: 'chat-groups-v2' };
  state.socialStatus = boot.socialStatus || state.socialStatus;
  state.privateAssistant = boot.privateAssistant || state.privateAssistant;
  state.managedProviderUsage = boot.managedProviderUsage ?? null;
  state.secretarySessionId = state.sessions.find((session) => session.departmentId === 'secretary_department'
    && session.status !== 'deleted' && session.writeState !== 'read_only')?.id || '';
  noteDirectoryGroups(state.collaborationOverview, { initialize: true });
}

async function refreshAll() {
  try {
    const boot = await window.janus.bootstrap();
    state.appVersion = boot.appVersion || state.appVersion;
    state.appPackaged = boot.appPackaged === true;
    state.updatedLaunch = boot.updatedLaunch === true;
    applyDesktopLifecycle(boot.desktopLifecycle);
    state.root = boot.root;
    state.workspaceRoot = boot.workspaceRoot || boot.workspace_root || state.workspaceRoot;
    state.org = boot.org;
    state.sessions = boot.sessions || [];
    state.preloadedMessagePagesBySessionId = boot.messagePreload?.sessionPages || state.preloadedMessagePagesBySessionId || {};
    state.projects = boot.projects || state.projects || [];
    state.tasks = boot.tasks || [];
    state.agentStatuses = boot.agentStatuses || [];
    state.evolution = boot.evolution;
    state.uBuddyOrganizationEvolution = boot.uBuddyOrganizationEvolution || state.uBuddyOrganizationEvolution;
    state.currentUser = boot.currentUser || null;
    state.accountWorkspaces = boot.accountWorkspaces || state.accountWorkspaces || [];
    state.activeAccountWorkspace = boot.activeAccountWorkspace || state.activeAccountWorkspace || null;
    state.startupAccountWorkspace = boot.startupAccountWorkspace || state.startupAccountWorkspace || null;
    state.uBuddyFeatureFlags = boot.uBuddyFeatureFlags || state.uBuddyFeatureFlags;
    hydrateComposerDrafts();
    state.adminUsers = boot.adminUsers || [];
    state.friendOverview = boot.friendOverview || { friends: [], requests: { incoming: [], outgoing: [] } };
    state.socialInbox = boot.socialInbox || [];
    state.socialThreads = boot.messagePreload?.socialThreads || state.socialThreads || [];
    state.agentDelegations = boot.agentDelegations || [];
    state.socialStatus = boot.socialStatus || state.socialStatus;
    state.codexConfig = boot.codexConfig || state.codexConfig;
    state.codexConfigFiles = boot.codexConfigFiles || state.codexConfigFiles;
    state.providerKeyAccess = boot.providerKeyAccess || state.providerKeyAccess;
    state.cloudSync = boot.cloudSync || state.cloudSync;
    state.userAgentSettings = boot.userAgentSettings || state.userAgentSettings || [];
    state.employeeOverview = boot.employees || state.employeeOverview || null;
    applyEmployeeWorkStatusSnapshot(state, state.employeeOverview?.roster || []);
    state.secretarySessionId = state.sessions.find((session) => session.departmentId === 'secretary_department' && session.status !== 'deleted' && session.writeState !== 'read_only')?.id || state.secretarySessionId || '';
    state.privateAssistant = boot.privateAssistant || state.privateAssistant;
    state.managedProviderUsage = boot.managedProviderUsage ?? null;
    state.personalEvolutionStatus = boot.personalEvolutionStatus || state.personalEvolutionStatus || null;
    state.stage8EvolutionStatus = boot.stage8EvolutionStatus || state.stage8EvolutionStatus || null;
    state.clusterEvolutionOverview = boot.clusterEvolutionOverview || state.clusterEvolutionOverview || { cohorts: [], runs: [], candidates: [] };
    state.personalEvolutionProposals = boot.personalEvolutionProposals || state.personalEvolutionProposals || [];
    state.pluginCatalog = Array.isArray(boot.plugins) ? boot.plugins : state.pluginCatalog;
    state.codexPlugins = boot.codexPlugins || state.codexPlugins;
    state.attachedSkillCatalog = boot.attachedSkills || state.attachedSkillCatalog;
    state.pptxPluginStatus = boot.pptxPluginStatus ?? state.pptxPluginStatus;
    state.updates = await window.janus.updateStatus();
    if (isCurrentUserAdmin()) await refreshReleaseStatus(false);
    const current = state.currentAgentId ? state.org.agents.find((agent) => agent.id === state.currentAgentId) : null;
    if (state.currentDepartmentId && (!current || current.routable === false || !isSelectableAgentForDepartment(state.currentDepartmentId, current.id))) {
      const first = defaultAgentForDepartment(state.currentDepartmentId);
      state.currentDepartmentId = first?.departmentId || '';
      state.currentAgentId = first?.id || '';
    }
    if (state.currentSessionId) {
      const sessionId = state.currentSessionId;
      const [page, contextUsage] = await Promise.all([
        loadLatestRendererMessagePage(sessionId),
        window.janus.chatContextStatus({ sessionId }).catch(() => null),
      ]);
      if (applyLatestRendererMessagePage(sessionId, page)) state.contextUsage = contextUsage;
    }
    if (state.taskDetail?.id && isCurrentUserAdmin()) state.taskDetail = await window.janus.getTask(state.taskDetail.id);
    notify('已刷新当前工作区。', 'success');
    render();
  } catch (error) {
    appendStatus(`Refresh error: ${error.message || error}`);
    notify(`刷新失败：${error.message || error}`, 'error');
  }
}

function selectDepartment(departmentId, { manual = false, selectDefaultAgent = true } = {}) {
  state.homeMode = 'department';
  state.composerImageMode = false;
  state.currentDepartmentId = departmentId;
  state.currentAgentInstanceId = '';
  state.sidebarMode = state.activeProjectId ? 'project' : 'chats';
  state.selectionSource = manual ? 'manual' : null;
  state.agentMenuOpen = false;
  if (departmentId === 'ppt_department' && !state.currentSessionId) state.pptStyleId = 'general';
  if (!departmentId) {
    state.currentAgentId = '';
    render();
    return;
  }
  const agent = selectDefaultAgent ? defaultAgentForDepartment(departmentId) : null;
  state.currentAgentId = agent?.id || '';
  render();
}

function selectAgentOption(agentId, departmentId = state.currentDepartmentId) {
  if (!departmentId || !agentId) return;
  if (state.selectionSource === 'manual' && state.currentAgentId === agentId) {
    clearAgentSelection();
    return;
  }
  state.homeMode = 'department';
  state.composerImageMode = false;
  state.currentDepartmentId = departmentId;
  state.sidebarMode = state.activeProjectId ? 'project' : 'chats';
  state.currentAgentId = resolveSelectedAgentId(departmentId, agentId);
  state.currentAgentInstanceId = '';
  state.selectionSource = 'manual';
  state.modelMenuOpen = false;
  state.pptTemplateMenuOpen = false;
  state.pptStyleMenuOpen = false;
  state.imageModelMenuOpen = false;
  state.agentMenuOpen = false;
  render();
  focusChatInputAtEnd();
}

function clearAgentSelection() {
  state.currentAgentId = '';
  state.currentAgentInstanceId = '';
  state.selectionSource = state.currentDepartmentId ? 'manual' : null;
  state.modelMenuOpen = false;
  state.pptTemplateMenuOpen = false;
  state.pptStyleMenuOpen = false;
  state.imageModelMenuOpen = false;
  state.agentMenuOpen = false;
  render();
  focusChatInputAtEnd();
}

function clearDepartmentSelection() {
  state.currentDepartmentId = '';
  state.currentAgentId = '';
  state.currentAgentInstanceId = '';
  state.selectionSource = null;
  state.modelMenuOpen = false;
  state.pptTemplateMenuOpen = false;
  state.pptStyleMenuOpen = false;
  state.imageModelMenuOpen = false;
  state.agentMenuOpen = false;
  render();
  focusChatInputAtEnd();
}

function removeLastManualSelection() {
  if (state.selectionSource !== 'manual') return false;
  if (state.currentAgentId) {
    clearDepartmentSelection();
    return true;
  }
  if (state.currentDepartmentId) {
    clearDepartmentSelection();
    return true;
  }
  return false;
}

function handleChatInputPaste(event) {
  const input = event.currentTarget;
  if (!input) return;
  if (queueClipboardAttachments(event.clipboardData)) {
    event.preventDefault();
    return;
  }
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!text) {
    setTimeout(() => {
      state.chatDraft = input.value || '';
      autoResizeChatInput(input);
      syncSocialMentionHighlight(input);
    }, 0);
    return;
  }
  event.preventDefault();
  const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : start;
  if (typeof input.setRangeText === 'function') {
    input.setRangeText(text, start, end, 'end');
  } else {
    input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
    const cursor = start + text.length;
    input.setSelectionRange(cursor, cursor);
  }
  state.chatDraft = input.value;
  preserveCurrentComposerDraft();
  pruneComposerMentions(state.chatDraft);
  pruneComposerProjectReferences(state.chatDraft);
  if (state.chatGroupId) {
    state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [`chat-group:${state.chatGroupId}`]: state.chatDraft };
    persistComposerDrafts();
  } else if (state.collaborationGroupId) {
    state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [`collaboration:${state.collaborationGroupId}`]: state.chatDraft };
    persistComposerDrafts();
  } else if (state.networkConversationPeerId && state.networkConversationPeerId !== 'self-secretary') {
    const key = networkConversationDraftKey(state.networkConversationPeerId, state.networkConversationMode, state.networkConversationGroupId);
    state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [key]: state.chatDraft };
    persistComposerDrafts();
  }
  syncSocialMentionHighlight(input);
  autoResizeChatInput(input);
  requestAnimationFrame(() => {
    if (!input.isConnected) return;
    syncSocialMentionHighlight(input);
    autoResizeChatInput(input);
    if (input.selectionEnd === input.value.length && input.scrollHeight > input.clientHeight) {
      input.scrollTop = input.scrollHeight;
    }
  });
}

function handleOrganizationInvitePaste(event) {
  const text = event.clipboardData?.getData('text/plain') || '';
  const invite = parseOrganizationInviteLink(text);
  if (!invite) return;
  event.preventDefault();
  event.stopPropagation();
  handleOrganizationInvite(invite, { source: 'paste' });
}

async function checkClipboardForOrganizationInvite() {
  if (!state.currentUser || organizationInviteClipboardCheckBusy || !window.janus.readClipboardText) return;
  organizationInviteClipboardCheckBusy = true;
  try {
    const text = await window.janus.readClipboardText();
    const invite = parseOrganizationInviteLink(text);
    if (invite) handleOrganizationInvite(invite, { source: 'clipboard' });
  } catch {
    // Clipboard inspection is best-effort when the window regains focus.
  } finally {
    organizationInviteClipboardCheckBusy = false;
  }
}

function handleOrganizationInvite(invite = {}, { source = 'clipboard' } = {}) {
  const link = String(invite.link || '').trim();
  if (!link || link === lastHandledOrganizationInviteLink) return false;
  lastHandledOrganizationInviteLink = link;
  if (!state.currentUser) {
    notify('请先登录账号，再使用组织邀请链接。', 'warning');
    return true;
  }
  const membership = (state.friendOverview?.organizations || []).find((organization) => (
    String(organization.organizationNumber || '').trim().toUpperCase()
      === String(invite.organizationNumber || '').trim().toUpperCase()
  ));
  if (membership) {
    notify(`当前账号已经加入组织“${membership.name || membership.organizationNumber}”。`, 'info');
    return true;
  }
  state.organizationInvitePrompt = { ...invite, source, setAsDefault: true };
  state.organizationInviteBusy = false;
  state.currentTab = 'chat';
  state.networkPanelOpen = true;
  state.networkPanelView = 'friends';
  state.friendDirectoryCategory = 'internal';
  state.friendDirectoryView = 'contacts';
  state.contactsActivePane = 'contacts';
  state.contactsSelectedOrganizationId = '';
  state.networkContactProfileOpen = false;
  render();
  return true;
}

function persistOrganizationShareLink(organizationId = '', link = '') {
  const cleanOrganizationId = String(organizationId || '').trim();
  if (!state.currentUser?.id || !cleanOrganizationId) return;
  state.organizationShareLinks = {
    ...(state.organizationShareLinks || {}),
    ...(link ? { [cleanOrganizationId]: String(link).trim() } : {}),
  };
  if (!link) delete state.organizationShareLinks[cleanOrganizationId];
  saveOrganizationShareLinks(String(state.currentUser.id || '').trim(), state.organizationShareLinks);
}

async function confirmOrganizationInvite() {
  const invite = state.organizationInvitePrompt;
  if (!invite || state.organizationInviteBusy) return;
  state.organizationInviteBusy = true;
  render();
  try {
    const result = await window.janus.joinOrganization({
      organizationNumber: invite.organizationNumber || '',
      verificationCode: invite.verificationCode || '',
    });
    const activation = await activateJoinedOrganizationWorkspace(result?.organization, {
      setAsDefault: invite.setAsDefault !== false,
    });
    if (!activation.switched && result?.overview) state.friendOverview = result.overview;
    state.contactsSelectedOrganizationId = result?.organization?.id || '';
    state.organizationInvitePrompt = null;
    const organizationName = result?.organization?.name || invite.organizationName || invite.organizationNumber;
    notify(activation.switched
      ? `已加入并切换到组织“${organizationName}”${invite.setAsDefault !== false && activation.defaultSaved ? '，已设为默认工作空间' : ''}。`
      : `已加入组织“${organizationName}”，但未能自动切换工作空间。`, activation.switched ? 'success' : 'warning');
  } catch (error) {
    const message = userVisibleErrorMessage(error, error.message || '请稍后重试。');
    if (/已经加入该组织/.test(message)) {
      try { state.friendOverview = await window.janus.friendsOverview(); } catch {}
      state.organizationInvitePrompt = null;
      notify('当前账号已经加入该组织。', 'info');
    } else {
      notify(`加入组织失败：${message}`, 'error');
    }
  } finally {
    state.organizationInviteBusy = false;
    render();
  }
}

function insertComposerEmoji(emoji = '') {
  const value = String(emoji || '').trim();
  if (!value) return;
  const input = document.getElementById('chat-input');
  const current = String(input?.value ?? state.chatDraft ?? '');
  const inputSelectionUsable = document.activeElement === input && Number.isFinite(input?.selectionStart);
  const start = inputSelectionUsable
    ? input.selectionStart
    : Number.isFinite(state.composerEmojiInsertionStart) ? state.composerEmojiInsertionStart : current.length;
  const end = inputSelectionUsable
    ? input.selectionEnd
    : Number.isFinite(state.composerEmojiInsertionEnd) ? state.composerEmojiInsertionEnd : start;
  state.chatDraft = current.slice(0, start) + value + current.slice(end);
  if (input) input.value = state.chatDraft;
  const nextPosition = start + value.length;
  state.composerEmojiInsertionStart = nextPosition;
  state.composerEmojiInsertionEnd = nextPosition;
  state.composerRecentEmojis = [
    value,
    ...(Array.isArray(state.composerRecentEmojis) ? state.composerRecentEmojis : []),
  ].filter((item, index, list) => item && list.indexOf(item) === index).slice(0, 24);
  saveComposerRecentEmojis(state.composerRecentEmojis);
  preserveCurrentComposerDraft();
  state.composerEmojiPickerOpen = true;
  render();
  setTimeout(() => {
    const next = document.getElementById('chat-input');
    if (!next) return;
    next.focus();
    next.setSelectionRange(nextPosition, nextPosition);
    autoResizeChatInput(next);
  }, 0);
}

async function insertComposerFavoriteImage(item = {}) {
  try {
    const sources = [item.value, item.url]
      .map((source) => String(source || '').trim())
      .filter((source, index, list) => source && list.indexOf(source) === index);
    const value = sources
      .filter((source) => source.startsWith('data:image/'))
      .sort((left, right) => right.length - left.length)[0]
      || sources[0]
      || '';
    if (!value) throw new Error('该收藏表情暂不可用。');
    let dataBase64 = '';
    let contentType = item.contentType || item.content_type || 'image/png';
    if (value.startsWith('data:')) {
      const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
      contentType = match?.[1] || contentType;
      dataBase64 = match?.[2] || '';
      const normalizedBase64 = dataBase64.replace(/\s+/g, '');
      const padding = normalizedBase64.endsWith('==') ? 2 : normalizedBase64.endsWith('=') ? 1 : 0;
      const decodedSize = Math.max(0, Math.floor(normalizedBase64.length * 3 / 4) - padding);
      const expectedSize = Math.max(0, Number(item.size || item.size_bytes || 0) || 0);
      if (!dataBase64 || (expectedSize && decodedSize !== expectedSize)) {
        throw new Error('收藏表情数据不完整，请重新打开收藏表情面板后重试。');
      }
    } else {
      const response = await fetch(value);
      if (!response.ok) throw new Error('表情图片已失效。');
      const blob = await response.blob();
      contentType = blob.type || contentType;
      dataBase64 = await blobToBase64(blob);
    }
    const uploaded = await window.janus.uploadFile({ filename: item.filename || item.name || 'sticker.png', contentType, dataBase64 });
    const input = document.getElementById('chat-input');
    const savedDraft = String(state.chatDraft || '');
    const savedInput = String(input?.value || '');
    const savedAttachments = [...(state.attachments || [])];
    state.attachments = [];
    // Preserve the exact asset used by the favorites grid.  The upload is
    // still kept for message delivery, while `value/url` makes the message
    // renderer independent from remote preview/download timing.
    queueUploadedAttachments([{ ...uploaded, favorite_emoji: true, value, url: value }], { source: 'favorite-emoji' });
    state.chatDraft = '';
    if (input) input.value = '';
    state.composerEmojiPickerOpen = false;
    render();
    try {
      await sendChat({ preventDefault() {} });
    } finally {
      state.chatDraft = savedDraft;
      state.attachments = savedAttachments;
      const nextInput = document.getElementById('chat-input');
      if (nextInput) nextInput.value = savedInput;
      render();
    }
  } catch (error) {
    notify(error?.message || '表情图片已失效。', 'error');
  }
}

async function uploadComposerFavoriteImage() {
  try {
    const result = await window.janus.selectFiles({ extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] });
    const selected = result?.files?.[0];
    if (!selected || !isSupportedEmojiFavoriteFile(selected)) return;
    if (Number(selected.size || 0) > EMOJI_FAVORITE_MAX_BYTES) throw new Error('单个表情不能超过 2 MB。');
    const favorites = normalizeEmojiFavorites(state.composerFavoriteEmojis || []);
    if (favorites.length >= 300) throw new Error('最多收藏 300 个表情。');
    const favorite = normalizeEmojiFavorite({ ...selected, kind: 'image', url: selected.render_url || selected.preview_url || selected.file_url });
    if (!favorite || !favorite.url) throw new Error('无法读取表情图片。');
    if (favorites.some((item) => emojiFavoriteKey(item) === emojiFavoriteKey(favorite))) throw new Error('该图片已经收藏。');
    const stored = window.janus.addEmojiFavorite
      ? await window.janus.addEmojiFavorite({ ...favorite, path: selected.path, contentType: selected.content_type || selected.type, filename: selected.name || selected.filename })
      : favorite;
    const normalizedStored = normalizeEmojiFavorite(stored) || favorite;
    if (normalizedStored.kind === 'image' && normalizedStored.value?.startsWith('data:')) normalizedStored.url = normalizedStored.value;
    state.composerFavoriteEmojis = [normalizedStored, ...favorites];
    state.composerEmojiTab = 'favorites';
    state.composerFavoriteManageOpen = false;
    saveComposerFavoriteEmojis(state.composerFavoriteEmojis);
    render();
  } catch (error) {
    notify(error?.message || '上传表情失败。', 'error');
  }
}

async function addMessageImageToFavorites(file = {}) {
  try {
    if (!isSupportedEmojiFavoriteFile(file)) throw new Error('只能收藏 PNG、JPG、WebP、GIF 图片。');
    if (Number(file.size || 0) > EMOJI_FAVORITE_MAX_BYTES) throw new Error('单个表情不能超过 2 MB。');
    let sourceFile = { ...file };
    if (!sourceFile.path && !sourceFile.file_url && !sourceFile.fileUrl && !sourceFile.preview_url && !sourceFile.render_url
      && (sourceFile.remote_file_id || sourceFile.remoteFileId)) {
      const materialized = await materializeCollaborationFile(sourceFile);
      sourceFile = { ...sourceFile, ...(materialized || {}) };
    }
    let payload = { ...sourceFile, kind: 'image', contentType: sourceFile.content_type || sourceFile.type, filename: sourceFile.name || sourceFile.filename };
    const url = sourceFile.path || sourceFile.file_url || sourceFile.fileUrl || sourceFile.preview_url || sourceFile.render_url || '';
    if (!file.path && url) {
      if (sourceFile.path && window.janus.readFileBase64) {
        const local = await window.janus.readFileBase64({ path: sourceFile.path });
        if (Number(local?.size || 0) > EMOJI_FAVORITE_MAX_BYTES) throw new Error('单个表情不能超过 2 MB。');
        payload = { ...payload, contentType: sourceFile.content_type || sourceFile.type || payload.contentType, dataBase64: String(local?.dataBase64 || '') };
      } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error('图片暂未下载，请先预览图片后重试。');
        const blob = await response.blob();
        if (blob.size > EMOJI_FAVORITE_MAX_BYTES) throw new Error('单个表情不能超过 2 MB。');
        payload = { ...payload, contentType: blob.type || payload.contentType, dataBase64: await blobToBase64(blob) };
      }
    }
    const stored = await window.janus.addEmojiFavorite(payload);
    state.composerFavoriteEmojis = normalizeEmojiFavorites([stored, ...(state.composerFavoriteEmojis || [])]);
    saveComposerFavoriteEmojis(state.composerFavoriteEmojis);
    notify('已添加到收藏表情。', 'success');
    render();
  } catch (error) {
    notify(error?.message || '添加到表情失败。', 'error');
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || '');
    reader.onerror = () => reject(reader.error || new Error('读取图片失败。'));
    reader.readAsDataURL(blob);
  });
}

function preserveChatDraftFromInput() {
  return preserveCurrentComposerDraft();
}

function closeContactProfileOnOutsideClick(event) {
  if (!state.networkContactProfileOpen) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('[data-contact-profile-dialog], [data-contact-profile], [aria-modal="true"], .dialog-overlay, [data-organization-action-dialog], [data-contact-add-dialog], [data-organization-invite-dialog], .employee-drawer-layer')) return;
  state.networkContactProfileOpen = false;
  state.networkSelectedContactId = '';
  state.networkSelectedContactOrganizationId = '';
  render();
}

function renderContactProfileTransition(applyContact) {
  const currentContent = document.querySelector('.contacts-workspace .contact-profile-body:not(.is-contact-profile-outgoing)');
  const outgoingContent = currentContent?.cloneNode(true) || null;
  if (activeContactProfileAnimation) {
    try { activeContactProfileAnimation.cancel(); } catch {}
    activeContactProfileAnimation = null;
  }
  applyContact();
  render();
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const drawer = document.querySelector('.contacts-workspace .contact-profile-card');
  const incomingContent = drawer?.querySelector('.contact-profile-body');
  if (reducedMotion || !outgoingContent || typeof incomingContent?.animate !== 'function') return Promise.resolve();

  outgoingContent.classList.add('is-contact-profile-outgoing');
  outgoingContent.setAttribute('aria-hidden', 'true');
  outgoingContent.removeAttribute('data-contact-profile-id');
  outgoingContent.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  drawer.classList.add('is-contact-profile-pushing');
  incomingContent.classList.add('is-contact-profile-incoming');
  drawer.append(outgoingContent);

  const options = {
    duration: 230,
    easing: 'cubic-bezier(.32, .72, 0, 1)',
    fill: 'both',
  };
  const outgoingAnimation = outgoingContent.animate([
    { transform: 'translate3d(0, 0, 0)' },
    { transform: 'translate3d(100%, 0, 0)' },
  ], options);
  const incomingAnimation = incomingContent.animate([
    { transform: 'translate3d(-100%, 0, 0)' },
    { transform: 'translate3d(0, 0, 0)' },
  ], options);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    outgoingContent.remove();
    incomingContent.classList.remove('is-contact-profile-incoming');
    drawer.classList.remove('is-contact-profile-pushing');
  };
  const controller = {
    cancel() {
      try { outgoingAnimation.cancel(); } catch {}
      try { incomingAnimation.cancel(); } catch {}
      cleanup();
    },
  };
  activeContactProfileAnimation = controller;
  return Promise.allSettled([outgoingAnimation.finished, incomingAnimation.finished]).finally(() => {
    cleanup();
    if (activeContactProfileAnimation === controller) activeContactProfileAnimation = null;
  });
}

function closeContactDirectoryContextMenu(event) {
  if (!state.contactDirectoryContextMenu) return;
  if (event?.type === 'keydown' && event.key !== 'Escape') return;
  if (event?.type === 'click' && event.target?.closest?.('[data-contact-directory-menu]')) return;
  if (event?.type === 'keydown') event.preventDefault();
  state.contactDirectoryContextMenu = null;
  render();
}

function openOrganizationActionDialog(action = '', details = {}) {
  if (!action || !details.organizationId) return;
  state.contactDirectoryContextMenu = null;
  state.networkContactProfileOpen = false;
  state.organizationActionBusy = false;
  state.organizationActionDialog = { action, invitationResetCodeSent: false, ...details };
  render();
  requestAnimationFrame(() => document.querySelector('#organization-share-invitation-code, #organization-new-invitation-code, #organization-action-code, #organization-owner-exit-mode, #organization-action-form button[type="submit"]')?.focus());
}

function openOrganizationInvitationResetDialog() {
  const dialog = state.organizationActionDialog;
  if (!dialog || dialog.action !== 'update_invitation_code') return;
  state.organizationActionDialog = {
    action: 'reset_invitation_code',
    organizationId: dialog.organizationId,
    organizationName: dialog.organizationName || '',
    invitationResetCodeSent: false,
  };
  render();
  requestAnimationFrame(() => document.querySelector('#organization-new-invitation-code')?.focus());
}

function returnToOrganizationInvitationUpdateDialog() {
  const dialog = state.organizationActionDialog;
  if (!dialog || dialog.action !== 'reset_invitation_code') return;
  state.organizationActionDialog = {
    action: 'update_invitation_code',
    organizationId: dialog.organizationId,
    organizationName: dialog.organizationName || '',
    invitationResetCodeSent: false,
  };
  render();
  requestAnimationFrame(() => document.querySelector('#organization-new-invitation-code')?.focus());
}

function organizationInviteUserName(user = {}) {
  return user.remark || user.displayName || user.display_name || user.username || user.email || user.id || '用户';
}

async function sendOrganizationInvitationResetCode(event) {
  const dialog = state.organizationActionDialog;
  const button = event.currentTarget;
  if (!dialog || dialog.action !== 'reset_invitation_code' || dialog.invitationResetCodeBusy) return;
  const email = String(state.currentUser?.email || '').trim();
  if (!email) {
    notify('当前账号尚未绑定邮箱，无法通过邮箱重置邀请码。', 'warning');
    return;
  }
  dialog.invitationResetCodeBusy = true;
  button.disabled = true;
  button.textContent = translateUiText('发送中…', state.languageMode);
  try {
    const result = await window.janus.sendEmailCode({
      method: 'email', email, purpose: 'organization_invitation_reset',
    });
    dialog.invitationResetCodeSent = true;
    dialog.invitationResetCodeExpiresAt = result?.expiresAt || '';
    button.textContent = translateUiText('重新发送', state.languageMode);
    notify(result?.devCode ? `本地验证码：${result.devCode}` : '验证码已发送到当前账号邮箱。', 'success');
    document.querySelector('#organization-invitation-reset-email-code')?.focus();
  } catch (error) {
    button.textContent = translateUiText('发送验证码', state.languageMode);
    notify(`发送验证码失败：${userVisibleErrorMessage(error, error.message || '请稍后重试。')}`, 'error');
  } finally {
    dialog.invitationResetCodeBusy = false;
    button.disabled = false;
  }
}

async function submitOrganizationAction(event) {
  event.preventDefault();
  const dialog = state.organizationActionDialog;
  if (!dialog || state.organizationActionBusy) return;
  const organization = (state.friendOverview?.organizations || []).find((item) => item.id === dialog.organizationId) || null;
  if (dialog.action === 'view_invitation_link') return;
  if (dialog.action === 'generate_invitation_link') {
    const verificationCode = document.querySelector('#organization-share-invitation-code')?.value || '';
    const owner = organization?.owner || (organization?.members || []).find((member) => member.role === 'owner')?.user || {};
    dialog.verificationCode = verificationCode;
    state.organizationActionBusy = true;
    render();
    try {
      const link = buildOrganizationInviteLink({
        organizationNumber: organization?.organizationNumber || '',
        organizationName: organization?.name || '',
        ownerName: owner?.id ? organizationInviteUserName(owner) : '',
        verificationCode,
      });
      let validationDeferred = false;
      try {
        const validation = await window.janus.organizationAction({
          action: 'validate_invitation_code',
          organizationId: dialog.organizationId,
          verificationCode,
        });
        validationDeferred = validation?.invitationCodeValidation === 'deferred' || validation?.validationUnavailable === true;
      } catch (error) {
        if (!isInvitationCodeValidationDeferredError(error)) throw error;
        validationDeferred = true;
      }
      persistOrganizationShareLink(dialog.organizationId, link);
      lastHandledOrganizationInviteLink = link;
      state.organizationActionDialog = {
        action: 'view_invitation_link',
        organizationId: dialog.organizationId,
        verificationCode,
        shareLink: link,
      };
      notify(validationDeferred
        ? '分享链接已生成；当前云端不支持预校验或网络暂不可用，邀请码将在成员加入时校验。'
        : '组织分享链接已生成，可以直接复制。', validationDeferred ? 'warning' : 'success');
    } catch (error) {
      notify(`生成分享链接失败：${userVisibleErrorMessage(error, error.message || '请检查当前邀请码。')}`, 'error');
    } finally {
      state.organizationActionBusy = false;
      render();
    }
    return;
  }
  const submitterDecision = event.submitter?.dataset.organizationExitDecision || '';
  const payload = {
    action: dialog.action,
    organizationId: dialog.organizationId,
    targetUserId: dialog.targetUserId || '',
    requestId: dialog.requestId || '',
    decision: submitterDecision || dialog.decision || '',
    verificationCode: document.querySelector('#organization-action-code')?.value || '',
    accountPassword: document.querySelector('#organization-action-password')?.value || '',
    rememberSecondaryVerification: Boolean(document.querySelector('#organization-remember-secondary-verification')?.checked),
    secondaryVerificationExpected: Boolean(state.organizationSecondaryVerificationById?.[dialog.organizationId]),
  };
  if (['update_invitation_code', 'reset_invitation_code'].includes(dialog.action)) {
    payload.newInvitationCode = document.querySelector('#organization-new-invitation-code')?.value || '';
    if (dialog.action === 'reset_invitation_code') payload.emailCode = document.querySelector('#organization-invitation-reset-email-code')?.value || '';
    const confirmation = document.querySelector('#organization-confirm-invitation-code')?.value || '';
    if (payload.newInvitationCode !== confirmation) {
      notify('两次输入的新邀请码不一致。', 'warning');
      return;
    }
  }
  if (dialog.action === 'owner_exit') {
    payload.mode = document.querySelector('#organization-owner-exit-mode')?.value || 'auto';
    payload.successorUserId = document.querySelector('#organization-owner-successor')?.value || '';
    if (payload.mode === 'transfer' && !payload.successorUserId) {
      notify('请选择下一任组织创建者。', 'warning');
      return;
    }
  }
  if (dialog.action === 'transfer_owner') {
    payload.retainAdmin = document.querySelector('#organization-transfer-retain-admin')?.value !== 'false';
  }
  state.organizationActionBusy = true;
  render();
  try {
    const result = await window.janus.organizationAction(payload);
    if (result?.secondaryVerificationRemembered) {
      state.organizationSecondaryVerificationById = {
        ...(state.organizationSecondaryVerificationById || {}),
        [dialog.organizationId]: true,
      };
    }
    if (result?.overview) state.friendOverview = result.overview;
    const organizationStillExists = (state.friendOverview?.organizations || []).some((item) => item.id === dialog.organizationId);
    if (!organizationStillExists || result?.exited || result?.dissolved) {
      state.contactsSelectedOrganizationId = '';
      const nextSecondaryVerification = { ...(state.organizationSecondaryVerificationById || {}) };
      delete nextSecondaryVerification[dialog.organizationId];
      state.organizationSecondaryVerificationById = nextSecondaryVerification;
    }
    state.organizationActionDialog = null;
    if (['update_invitation_code', 'reset_invitation_code'].includes(dialog.action)) {
      const updatedOrganization = (state.friendOverview?.organizations || []).find((item) => item.id === dialog.organizationId) || organization;
      const owner = updatedOrganization?.owner || (updatedOrganization?.members || []).find((member) => member.role === 'owner')?.user || {};
      const link = buildOrganizationInviteLink({
        organizationNumber: updatedOrganization?.organizationNumber || '',
        organizationName: updatedOrganization?.name || '',
        ownerName: owner?.id ? organizationInviteUserName(owner) : '',
        verificationCode: payload.newInvitationCode,
      });
      persistOrganizationShareLink(dialog.organizationId, link);
      lastHandledOrganizationInviteLink = link;
    }
    const success = payload.action === 'reset_invitation_code'
      ? '组织邀请码已通过邮箱验证重置。'
      : ({ promote_admin: '已设为管理员。', revoke_admin: '已移除管理员权限。', remove_member: '成员已移出组织。', transfer_owner: payload.retainAdmin ? '组织创建者已转让，你保留管理员身份。' : '组织创建者已转让，你已成为普通成员。', update_invitation_code: '组织邀请码已更新。', request_exit: '退出申请已发送。', resolve_exit: payload.decision === 'reject' ? '已拒绝退出申请。' : '已同意退出申请。', owner_exit: result?.dissolved ? '组织已解散。' : '已退出组织。' })[dialog.action] || '组织操作已完成。';
    notify(success, 'success');
  } catch (error) {
    if (String(error?.code || '').trim() === 'organization_secondary_verification_expired') {
      const nextSecondaryVerification = { ...(state.organizationSecondaryVerificationById || {}) };
      delete nextSecondaryVerification[dialog.organizationId];
      state.organizationSecondaryVerificationById = nextSecondaryVerification;
      notify('本次登录的二次验证已失效，请重新输入组织邀请码和账号密码。', 'warning');
      return;
    }
    notify(`组织操作失败：${userVisibleErrorMessage(error, error.message || '请稍后重试。')}`, 'error');
  } finally {
    state.organizationActionBusy = false;
    render();
  }
}

function isTransientRendererNetworkError(error) {
  const code = String(error?.code || error?.cause?.code || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return ['econnreset', 'econnrefused', 'enotfound', 'eai_again', 'etimedout'].includes(code)
    || /fetch failed|network error|socket hang up|connection (?:closed|refused)|timed? out|temporarily unavailable|bad gateway|gateway timeout|\b(?:502|503|504)\b/.test(message);
}

function isInvitationCodeValidationDeferredError(error) {
  if (isTransientRendererNetworkError(error)) return true;
  const code = String(error?.code || error?.body?.error?.code || error?.body?.code || '').trim().toLowerCase();
  const message = String(error?.message || error?.body?.error?.message || error || '').trim().toLowerCase();
  if (['organization_not_found', 'organization_verification_code_invalid'].includes(code)) return false;
  return ['not_found', 'route_not_found', 'organization_action_invalid'].includes(code)
    || /接口不存在|不支持的组织操作|unsupported organization action|organization action (?:is )?not supported/i.test(message);
}

// Ordinary composer features are inline modes. uBuddy is a persistent primary
// conversation opened from the message list or an employee entry.
function prepareInlineComposerFeatureToggle() {
  preserveChatDraftFromInput();
  state.modelMenuOpen = false;
  state.modelSubmenuOpen = false;
  state.imageModelMenuOpen = false;
  state.pptTemplateMenuOpen = false;
  state.pptStyleMenuOpen = false;
  state.agentMenuOpen = false;
  state.sandboxMenuOpen = false;
  state.composerMemoryMenuOpen = false;
}

function activeSocialFriendName() {
  const peerId = String(state.networkConversationPeerId || '').trim();
  const relationship = directoryContactByUserId(peerId);
  const friend = relationship?.friend || relationship?.user || null;
  return relationship?.remark || friend?.remark || friend?.displayName || friend?.display_name || friend?.username || friend?.email || friend?.id || '';
}

function activeSocialMentionTokens() {
  if (!state.collaborationGroupId) return [...new Set([
    ...socialMentionTokens(activeSocialFriendName()),
    ...(state.composerMentions || []).map((item) => String(item.displayText || '').trim()).filter(Boolean),
  ])].sort((left, right) => right.length - left.length);
  const currentUserId = state.currentUser?.id || '';
  return [...new Set((state.collaborationGroupDetail?.members || []).filter((member) => member.status === 'active').flatMap((member) => {
    const user = member.user || {};
    const name = user.displayName || user.display_name || user.username || user.email || user.id || '';
    if (!name) return [];
    return [`@${name}`, member.userId === currentUserId ? '@我的uBuddy' : `@${name}的uBuddy`];
  }))].sort((left, right) => right.length - left.length);
}

function renderActiveSocialMentionMarkup(value = '') {
  const source = String(value || '');
  const tokens = activeSocialMentionTokens();
  let cursor = 0;
  let markup = '';
  while (cursor < source.length) {
    const token = tokens.find((candidate) => source.startsWith(candidate, cursor));
    if (token) {
      markup += `<mark class="social-mention-token">${escapeHtml(token)}</mark>`;
      cursor += token.length;
    } else {
      markup += escapeHtml(source[cursor]);
      cursor += 1;
    }
  }
  return markup;
}

function syncSocialMentionHighlight(input = document.getElementById('chat-input')) {
  const overlay = input?.closest?.('.mention-token-surface')?.querySelector('.social-mention-highlight');
  if (!overlay || !input?.classList?.contains('mention-token-input')) return;
  overlay.innerHTML = renderActiveSocialMentionMarkup(input.value || '');
  overlay.scrollTop = input.scrollTop || 0;
  overlay.scrollLeft = input.scrollLeft || 0;
}

function handleSocialMentionDelete(event) {
  const input = event.target;
  if (!input?.classList?.contains('mention-token-input')) return false;
  if (!['Backspace', 'Delete'].includes(event.key)) return false;
  const value = String(input.value || '');
  const selectionStart = Number(input.selectionStart || 0);
  const selectionEnd = Number(input.selectionEnd || selectionStart);
  const tokens = activeSocialMentionTokens();
  const range = mentionDeletionRange({ value, tokens, key: event.key, selectionStart, selectionEnd });
  if (!range) return false;
  const { start, end } = range;
  event.preventDefault();
  const previouslyUsedSocialModel = composerMentionsUseModel();
  input.setRangeText('', start, end, 'start');
  state.chatDraft = input.value;
  pruneComposerMentions(state.chatDraft);
  const key = state.collaborationGroupId
    ? `collaboration:${state.collaborationGroupId}`
    : networkConversationDraftKey(state.networkConversationPeerId, 'group', state.networkConversationGroupId);
  state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [key]: state.chatDraft };
  persistComposerDrafts();
  syncSocialMentionHighlight(input);
  autoResizeChatInput(input);
  if (previouslyUsedSocialModel !== composerMentionsUseModel()) {
    render();
    focusChatInputAtEnd();
  }
  return true;
}

function composerMentionsUseModel() {
  return normalizeMentionEntities(state.composerMentions || [], {
    content: state.chatDraft,
    requirePicker: true,
  }).some((item) => item.principalType === 'ubuddy' && item.ownerUserId === state.currentUser?.id);
}

function composerMentionInsertionRange(input, current = '') {
  if (composerProjectMentionPickerOpen()) {
    const anchorStart = Number(state.composerMentionAnchorStart);
    const anchorEnd = Number(state.composerMentionAnchorEnd);
    if (Number.isFinite(anchorStart) && Number.isFinite(anchorEnd)) {
      const start = Math.min(Math.max(0, anchorStart), current.length);
      return { start, end: Math.min(Math.max(start, anchorEnd), current.length) };
    }
  }
  const start = Number.isFinite(input?.selectionStart) ? input.selectionStart : current.length;
  const end = Number.isFinite(input?.selectionEnd) ? input.selectionEnd : start;
  return { start, end };
}

function insertSocialMention({ token = '', principalType = '', userId = '', ownerUserId = '', audience = '' } = {}) {
  const mention = String(token || '').trim();
  if (!mention) return;
  const keepPickerOpen = composerProjectMentionPickerOpen();
  const input = document.getElementById('chat-input');
  const current = String(input?.value ?? state.chatDraft ?? '');
  const { start, end } = composerMentionInsertionRange(input, current);
  const before = current.slice(0, start).replace(/@[^\s@]*$/, '');
  const needsLeadingSpace = before && !/\s$/.test(before);
  const inserted = `${needsLeadingSpace ? ' ' : ''}${mention} `;
  state.chatDraft = `${before}${inserted}${current.slice(end)}`;
  const entity = createPickerMentionEntity({ principalType, userId, ownerUserId, audience, displayText: mention });
  if (entity) state.composerMentions = [
    ...(state.composerMentions || []).filter((item) => `${item.principalType}:${item.userId || item.ownerUserId || item.audience}` !== `${entity.principalType}:${entity.userId || entity.ownerUserId || entity.audience}`),
    entity,
  ];
  const key = state.collaborationGroupId
    ? `collaboration:${state.collaborationGroupId}`
    : networkConversationDraftKey(state.networkConversationPeerId, 'group', state.networkConversationGroupId);
  state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [key]: state.chatDraft };
  persistComposerDrafts();
  if (keepPickerOpen) continueComposerMentionPicking();
  else {
    state.socialMentionMenuOpen = false;
    render();
    focusChatInputAtEnd();
  }
}

function insertUBuddyMention({ principalType = 'user', userId = '', agentId = '', agentInstanceId = '', organizationId = '', pluginId = '', skillId = '', audience = '', token = '' } = {}) {
  const mention = String(token || '').trim();
  if (!(userId || agentId || agentInstanceId || organizationId || pluginId || skillId) || !mention) return;
  const contactPickerSelection = state.uBuddyContactPickerOnly && principalType === 'user';
  const input = document.getElementById('chat-input');
  const current = String(input?.value ?? state.chatDraft ?? '');
  const { start, end } = composerMentionInsertionRange(input, current);
  const before = current.slice(0, start).replace(/@[^\s@]*$/, '');
  const existingKey = `${principalType}:${userId || agentInstanceId || agentId || organizationId || pluginId || skillId}`;
  const alreadySelected = normalizeMentionEntities([...(state.composerMentions || []), ...(state.secretaryMentions || [])], {
    content: state.chatDraft,
    requirePicker: true,
  }).some((item) => `${item.principalType}:${item.userId || item.agentInstanceId || item.agentId || item.organizationId || item.pluginId || item.skillId}` === existingKey);
  if (alreadySelected) {
    state.chatDraft = `${before}${current.slice(end)}`;
    continueComposerMentionPicking();
    return;
  }
  const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${mention} `;
  state.chatDraft = `${before}${inserted}${current.slice(end)}`;
  const entity = createPickerMentionEntity({
    principalType, userId, agentId, agentInstanceId, organizationId, pluginId, skillId, audience, displayText: mention,
  });
  if (!entity) return;
  const entityKey = `${entity.principalType}:${entity.userId || entity.agentInstanceId || entity.agentId || entity.organizationId || entity.pluginId || entity.skillId}`;
  state.secretaryMentions = [
    ...(state.secretaryMentions || []).filter((item) => `${item.principalType}:${item.userId || item.agentInstanceId || item.agentId || item.organizationId || item.pluginId || item.skillId}` !== entityKey),
    entity,
  ];
  state.composerMentions = [...state.secretaryMentions];
  if (contactPickerSelection) {
    state.uBuddyContactPickerOnly = false;
    state.socialMentionMenuOpen = false;
    render();
    focusChatInputAtEnd();
  } else continueComposerMentionPicking();
}

function insertSkillMention({ skillId = '', token = '' } = {}) {
  const cleanId = String(skillId || '').trim();
  const mention = String(token || '').trim();
  if (!cleanId || !mention) return;
  const input = document.getElementById('chat-input');
  const current = String(input?.value ?? state.chatDraft ?? '');
  const { start, end } = composerMentionInsertionRange(input, current);
  const before = current.slice(0, start);
  const needsLeadingSpace = before && !/\s$/.test(before);
  state.chatDraft = `${before}${needsLeadingSpace ? ' ' : ''}${mention} ${current.slice(end)}`;
  const entity = createPickerMentionEntity({ principalType: 'skill', skillId: cleanId, displayText: mention });
  if (entity) {
    const entityKey = `skill:${cleanId}`;
    state.composerMentions = [
      ...(state.composerMentions || []).filter((item) => `skill:${item.skillId || ''}` !== entityKey),
      entity,
    ];
    state.secretaryMentions = [...state.composerMentions];
  }
  state.socialMentionMenuOpen = false;
  state.composerMentionPickerMode = 'mention';
  state.composerMentionQuery = '';
  resetProjectReferenceBrowser();
  render();
  focusChatInputAtEnd();
}

function continueComposerMentionPicking() {
  state.socialMentionMenuOpen = true;
  state.composerMentionPickerMode = 'mention';
  state.composerMentionQuery = '';
  state.composerMentionActiveIndex = 0;
  state.composerMentionAnchorStart = state.chatDraft.length;
  state.composerMentionAnchorEnd = state.chatDraft.length;
  render();
  if (state.projectReferenceBrowseProjectId) {
    void loadProjectReferenceEntries({ directory: state.projectReferenceDirectory || '', query: '', focusSearch: true });
  } else {
    setTimeout(() => document.querySelector('[data-project-reference-query]')?.focus(), 0);
  }
}

function pruneComposerMentions(content = '') {
  state.composerMentions = normalizeMentionEntities(state.composerMentions || [], { content, requirePicker: true });
  state.secretaryMentions = normalizeMentionEntities(state.secretaryMentions || [], { content, requirePicker: true });
}

function composerProjectMentionQuery(content = '') {
  const match = String(content || '').match(/(?:^|\s)@([^\s@]*)$/);
  return match ? match[1] : null;
}

function composerSkillCommandQuery(content = '') {
  const source = String(content || '');
  if (/(?:^|\s)\/$/.test(source)) return '';
  const match = source.match(/(?:^|\s)\/skills?(?:\s+([^\s]*))?$/i);
  return match ? String(match[1] || '') : null;
}

function composerSkillCommandRange(content = '') {
  const source = String(content || '');
  const match = /(?:^|\s)\/$/.exec(source) || /(?:^|\s)\/skills?(?:\s+[^\s]*)?$/i.exec(source);
  if (!match) return null;
  const leading = match[0].startsWith(' ') ? 1 : 0;
  return { start: match.index + leading, end: source.length };
}

function pruneComposerProjectReferences(content = '') {
  const text = String(content || '');
  state.composerFileReferences = (state.composerFileReferences || []).filter((reference) => (
    reference?.source === 'picker' && reference.displayText && text.includes(reference.displayText)
  ));
}

function scheduleProjectReferenceQuery(query = '', { renderPeople = false, focusSearch = true } = {}) {
  if (projectReferenceQueryTimer) clearTimeout(projectReferenceQueryTimer);
  projectReferenceQueryTimer = setTimeout(() => {
    if (renderPeople) render();
    void loadProjectReferenceEntries({ query, focusSearch });
  }, 140);
}

function bindProjectReferenceBrowserToActiveProject() {
  const project = state.workspaceDetached ? null : activeProject();
  state.projectReferenceBrowseProjectId = project?.id || '';
  state.projectReferenceProjectId = '';
  state.projectReferenceDirectory = '';
  state.projectReferenceEntries = [];
  state.projectReferenceLoading = false;
  state.projectReferenceError = '';
  return project;
}

function resetProjectReferenceBrowser() {
  if (projectReferenceQueryTimer) {
    clearTimeout(projectReferenceQueryTimer);
    projectReferenceQueryTimer = null;
  }
  projectReferenceRequestSequence += 1;
  state.projectReferenceBrowseProjectId = '';
  state.projectReferenceProjectId = '';
  state.projectReferenceDirectory = '';
  state.projectReferenceEntries = [];
  state.projectReferenceLoading = false;
  state.projectReferenceError = '';
  state.composerMentionActiveIndex = 0;
}

async function loadProjectReferenceEntries({ directory = state.projectReferenceDirectory || '', query = state.composerMentionQuery || '', focusSearch = true } = {}) {
  const project = projectById(state.projectReferenceBrowseProjectId);
  if (!project?.id) {
    state.projectReferenceProjectId = '';
    state.projectReferenceEntries = [];
    state.projectReferenceLoading = false;
    state.projectReferenceError = '';
    render();
    return;
  }
  const sequence = ++projectReferenceRequestSequence;
  state.projectReferenceLoading = true;
  state.projectReferenceError = '';
  state.projectReferenceProjectId = project.id;
  state.projectReferenceDirectory = directory;
  render();
  try {
    const result = await window.janus.browseProjectFiles({ projectId: project.id, directory, query, limit: 100 });
    if (sequence !== projectReferenceRequestSequence || state.projectReferenceBrowseProjectId !== project.id) return;
    state.projectReferenceEntries = result?.entries || [];
    state.projectReferenceDirectory = result?.directory || directory;
  } catch (error) {
    if (sequence !== projectReferenceRequestSequence) return;
    state.projectReferenceEntries = [];
    state.projectReferenceError = userVisibleErrorMessage(error, '无法读取项目目录。');
  } finally {
    if (sequence !== projectReferenceRequestSequence) return;
    state.projectReferenceLoading = false;
    render();
    const search = document.querySelector('[data-project-reference-query]');
    if (focusSearch && search && state.socialMentionMenuOpen) {
      search.focus();
      search.setSelectionRange?.(search.value.length, search.value.length);
    } else if (!focusSearch && state.socialMentionMenuOpen) {
      focusChatInputAtMentionAnchor();
    }
  }
}

function insertProjectFileReference({ relativePath = '', referenceKind = 'file' } = {}) {
  const project = projectById(state.projectReferenceBrowseProjectId);
  const cleanPath = String(relativePath || '').trim().replaceAll('\\', '/');
  if (!project?.id || activeProject()?.id !== project.id || !cleanPath) return;
  const displayText = `@${cleanPath}`;
  const input = document.getElementById('chat-input');
  const current = String(input?.value ?? state.chatDraft ?? '');
  const { start, end } = composerMentionInsertionRange(input, current);
  const before = current.slice(0, start).replace(/@[^\s@]*$/, '');
  const alreadySelected = (state.composerFileReferences || []).some((item) => (
    item.projectId === project.id && item.referenceKind === referenceKind && item.relativePath === cleanPath
  ));
  if (alreadySelected) {
    state.chatDraft = `${before}${current.slice(end)}`;
    continueComposerMentionPicking();
    return;
  }
  const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${displayText} `;
  state.chatDraft = `${before}${inserted}${current.slice(end)}`;
  const reference = {
    referenceId: globalThis.crypto?.randomUUID?.() || `project_reference_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    referenceKind: referenceKind === 'directory' ? 'directory' : 'file',
    projectId: project.id,
    relativePath: cleanPath,
    name: cleanPath.split('/').at(-1) || cleanPath,
    source: 'picker',
    displayText,
    memoryId: state.composerMemoryContext?.activeMemoryDocumentId || '',
    contextSpaceId: state.composerMemoryContext?.activeContextSpaceId || '',
  };
  state.composerFileReferences = [
    ...(state.composerFileReferences || []).filter((item) => !(item.projectId === project.id && item.referenceKind === reference.referenceKind && item.relativePath === cleanPath)),
    reference,
  ];
  continueComposerMentionPicking();
}

function focusChatInputAtEnd() {
  setTimeout(() => {
    const input = document.getElementById('chat-input');
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, 0);
}

function focusChatInputAtMentionAnchor() {
  setTimeout(() => {
    const input = document.getElementById('chat-input');
    if (!input) return;
    input.focus();
    const start = Math.min(Math.max(0, Number(state.composerMentionAnchorStart || 0)), input.value.length);
    const end = Math.min(Math.max(start, Number(state.composerMentionAnchorEnd || start)), input.value.length);
    input.setSelectionRange(start, end);
    autoResizeChatInput(input);
  }, 0);
}

function removeAttachment(attachmentId) {
  const item = state.attachments.find((entry) => entry.id === attachmentId);
  if (item?.localPreviewUrl) URL.revokeObjectURL(item.localPreviewUrl);
  state.attachments = state.attachments.filter((entry) => entry.id !== attachmentId);
}

function defaultAgentForDepartment(departmentId) {
  return agentsForDepartment(departmentId)[0] || null;
}

function agentsForDepartment(departmentId) {
  if (!departmentId) return [];
  const all = state.org.agents.filter((item) => item.departmentId === departmentId);
  const userFacingIds = USER_FACING_AGENT_IDS[departmentId] || [];
  const configuredUserFacing = userFacingIds
    .map((id) => all.find((item) => item.id === id))
    .filter(Boolean);
  const userFacing = configuredUserFacing.filter((item) => item.routable !== false);
  if (userFacing.length) return userFacing;
  if (departmentId === 'ppt_department' && configuredUserFacing.length) return configuredUserFacing;
  const routable = all.filter((item) => item.routable !== false);
  return routable.length ? routable : all;
}

function isSelectableAgentForDepartment(departmentId, agentId) {
  if (!departmentId) return !agentId;
  return agentsForDepartment(departmentId).some((agent) => agent.id === agentId);
}

function resolveSelectedAgentId(departmentId, agentId) {
  if (!departmentId) return '';
  if (isSelectableAgentForDepartment(departmentId, agentId)) return agentId;
  return defaultAgentForDepartment(departmentId)?.id || '';
}

function agentPickerTitle(departmentId) {
  return departmentId === 'ppt_department' ? '选择 PPT 风格' : '选择 agent';
}

function sessionSubtitle(session) {
  if (!session) return '';
  const departmentId = session.departmentId || session.department_id || '';
  if (departmentId === 'secretary_department') {
    return session.readOnly || session.writeState === 'read_only' ? 'uBuddy 历史 · 只读' : 'uBuddy';
  }
  if (departmentId === 'private_assistant') return '私人助理 · 本地隔离';
  const identity = sessionAgentIdentity(session);
  if (identity?.displayName) return identity.displayName;
  if (departmentId === 'general') return '普通聊天';
  if (departmentId === 'image_generation') return '图像生成';
  return (session.agentId || session.agent_id) || departmentName(departmentId);
}

function sessionAgentIdentityOptions() {
  return {
    employees: state.employeeOverview?.roster || [],
    settings: state.userAgentSettings || [],
    agents: state.org?.agents || [],
    agentName: shortAgentLabel,
  };
}

function sessionAgentIdentity(session = {}) {
  return resolveSessionAgentIdentity(session, sessionAgentIdentityOptions());
}

function localAgentSearchResults(query = '') {
  const byId = new Map();
  for (const session of [...(state.sessions || []), ...(state.archivedSessions || [])]) {
    if (!session?.id || byId.has(session.id) || isInternalDelegationSession(session)) continue;
    if (sessionMatchesAgentQuery(session, query, sessionAgentIdentityOptions())) byId.set(session.id, session);
  }
  return [...byId.values()].sort(compareSessionsForDisplay).slice(0, 50);
}

function mergeChatSearchResults(remoteResults = [], localResults = []) {
  const byId = new Map();
  for (const session of localResults || []) {
    if (session?.id && !isInternalDelegationSession(session)) byId.set(session.id, session);
  }
  for (const session of remoteResults || []) {
    if (session?.id && !isInternalDelegationSession(session)) byId.set(session.id, session);
  }
  return [...byId.values()].sort(compareSessionsForDisplay).slice(0, 50);
}

function sessionIsPinned(session = {}) {
  return Boolean(session.pinned || session.pinnedAt || session.pinned_at);
}

function sessionIsArchived(session = {}) {
  return session.archived === true || session.status === 'archived';
}

function findSessionById(sessionId) {
  return state.sessions.find((item) => item.id === sessionId) ||
    (state.chatSearchResults || []).find((item) => item.id === sessionId) ||
    (state.archivedSessions || []).find((item) => item.id === sessionId) ||
    null;
}

function agentNameById(agentId) {
  if (!agentId) return '';
  const agent = state.org.agents.find((item) => item.id === agentId);
  if (agent) return shortAgentLabel(agent);
  return AGENT_DISPLAY_LABELS[agentId] || agentId;
}

function filteredSessions() {
  const query = normalizeSearch(state.chatSearchQuery);
  if (!query) return state.sessions.filter((session) => !isInternalDelegationSession(session)).slice(0, 20);
  return (state.chatSearchResults || []).filter((session) => !isInternalDelegationSession(session)).slice(0, 50);
}

function isInternalDelegationSession(session = {}) {
  return (session.departmentId || session.department_id || '') === 'agent_delegation';
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function networkMessageSearchRouteKey(session = {}) {
  const agentInstanceId = String(session.agentInstanceId || session.agent_instance_id || '').trim();
  if (agentInstanceId) return `instance:${agentInstanceId}`;
  const agentId = String(session.agentId || session.agent_id || '').trim();
  return agentId ? `agent:${agentId}` : '';
}

function applyNetworkMessageSearchFilter(input = document.querySelector('#network-conversation-search')) {
  const query = normalizeSearch(input?.value ?? state.networkMessageSearchQuery);
  const resultQuery = normalizeSearch(state.networkMessageSearchResultQuery);
  const matchedSessionIds = new Set(resultQuery === query ? state.networkMessageSearchSessionIds || [] : []);
  if (input) state.networkMessageSearchQuery = input.value || '';
  document.querySelectorAll('[data-conversation-search-text]').forEach((item) => {
    const localMatch = normalizeSearch(item.dataset.conversationSearchText || '').includes(query);
    const sessionMatch = matchedSessionIds.has(item.dataset.conversationSearchSession || '');
    item.hidden = Boolean(query && !localMatch && !sessionMatch);
  });
  const clearButton = document.querySelector('[data-conversation-search-clear]');
  if (clearButton) clearButton.hidden = !query;
  input?.closest('.im-panel-search')?.classList.toggle('has-clear', Boolean(query));
  const toggle = document.querySelector('[data-conversation-search-toggle]');
  toggle?.classList.toggle('is-active', Boolean(query));
}

function resetNetworkMessageSearch({ close = false } = {}) {
  clearTimeout(networkMessageSearchTimer);
  networkMessageSearchRequestId += 1;
  networkMessageSearchComposing = false;
  state.networkMessageSearchQuery = '';
  state.networkMessageSearchResultQuery = '';
  state.networkMessageSearchSessionIds = [];
  if (close) state.networkMessageSearchOpen = false;
  const input = document.querySelector('#network-conversation-search');
  if (input) input.value = '';
}

function conversationArchiveTargetForKey(key = '') {
  const value = String(key || '').trim();
  if (value.startsWith('chat-group:')) {
    const conversationId = value.slice('chat-group:'.length);
    const group = (state.chatGroupsOverview?.groups || []).find((item) => item.id === conversationId);
    return group ? { conversationKind: 'chat_group', conversationId, workspaceId: group.workspaceId || group.accountWorkspaceId || '', archived: Boolean(group.archived), revision: Number(group.archiveRevision || 0) } : null;
  }
  if (value.startsWith('task:')) {
    const conversationId = value.slice('task:'.length);
    const group = (state.collaborationOverview?.groups || []).find((item) => item.id === conversationId);
    return group ? { conversationKind: 'collaboration_group', conversationId, workspaceId: group.workspaceId || group.accountWorkspaceId || '', archived: Boolean(group.archived), revision: Number(group.archiveRevision || 0) } : null;
  }
  if (value.startsWith('direct:')) {
    const conversationId = value.slice('direct:'.length);
    const pref = (Array.isArray(state.conversationPreferences?.preferences) ? state.conversationPreferences.preferences : []).find((item) => item.conversationKind === 'social_direct' && item.conversationId === conversationId);
    return { conversationKind: 'social_direct', conversationId, workspaceId: state.activeAccountWorkspace?.id || '', archived: Boolean(pref?.archived), revision: Number(pref?.stateRevision || 0) };
  }
  if (value.startsWith('agent:')) {
    const conversationId = value.slice('agent:'.length);
    const pref = (Array.isArray(state.conversationPreferences?.preferences) ? state.conversationPreferences.preferences : []).find((item) => item.conversationKind === 'agent_session' && item.conversationId === conversationId);
    return { conversationKind: 'agent_session', conversationId, workspaceId: state.activeAccountWorkspace?.id || '', archived: Boolean(pref?.archived), revision: Number(pref?.stateRevision || 0) };
  }
  if (value.startsWith('agent-pending:')) {
    const parts = value.slice('agent-pending:'.length).split(':');
    const agentId = parts.shift() || '';
    const employeeId = parts.join(':');
    const session = (Array.isArray(state.sessions) ? state.sessions : [])
      .filter((item) => item?.status !== 'deleted' && String(item.agentId || item.agent_id || '') === agentId
        && (!employeeId || String(item.agentInstanceId || item.agent_instance_id || '') === employeeId))
      .sort((a, b) => new Date(b.updatedAt || b.updated_at || 0) - new Date(a.updatedAt || a.updated_at || 0))[0];
    const fallback = session?.id ? session : (Array.isArray(state.sessions) ? state.sessions : []).find((item) => item?.id === state.currentSessionId
      && String(item.agentId || item.agent_id || '') === agentId && item?.status !== 'deleted');
    if (fallback?.id) {
      const pref = (Array.isArray(state.conversationPreferences?.preferences) ? state.conversationPreferences.preferences : []).find((item) => item.conversationKind === 'agent_session' && item.conversationId === fallback.id);
      return { conversationKind: 'agent_session', conversationId: fallback.id, workspaceId: fallback.accountWorkspaceId || fallback.account_workspace_id || state.activeAccountWorkspace?.id || '', archived: Boolean(pref?.archived), revision: Number(pref?.stateRevision || 0) };
    }
  }
  return null;
}

function updateConversationArchiveState(target = {}, archived = false) {
  if (['social_direct', 'agent_session'].includes(target.conversationKind)) {
    const overview = state.conversationPreferences || { preferences: [] };
    const preferences = (Array.isArray(overview.preferences) ? overview.preferences : []).filter((item) => !(item.conversationKind === target.conversationKind && item.conversationId === target.conversationId));
    preferences.push({ conversationKind: target.conversationKind, conversationId: target.conversationId, archived, stateRevision: archived === target.archived ? Number(target.revision || 0) : Number(target.revision || 0) + 1 });
    state.conversationPreferences = { ...overview, preferences };
    return;
  }
  const field = target.conversationKind === 'chat_group' ? 'chatGroupsOverview' : 'collaborationOverview';
  const overview = state[field] || { groups: [] };
  state[field] = {
    ...overview,
    groups: (overview.groups || []).map((group) => group.id === target.conversationId
      ? { ...group, archived, archiveRevision: archived === target.archived ? Number(target.revision || 0) : Number(target.revision || 0) + 1 }
      : group),
  };
}

async function toggleConversationArchive(key = '') {
  const target = conversationArchiveTargetForKey(key);
  if (!target) {
    if (String(key || '').startsWith('agent-pending:')) {
      notify('该员工目前还没有可归档的历史对话。请先发送一条消息，建立会话后再归档。', 'info');
    } else {
      notify('当前会话尚未建立，暂时无法归档。', 'info');
    }
    return;
  }
  const archived = !target.archived;
  state.conversationContextMenu = null;
  updateConversationArchiveState(target, archived);
  render();
  try {
    await window.janus.setConversationArchived({
      conversationKind: target.conversationKind,
      conversationId: target.conversationId,
      workspaceId: target.workspaceId,
      archived,
      expectedRevision: target.revision,
      commandId: globalThis.crypto?.randomUUID?.() || `conversation_archive_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    });
    if (target.conversationKind === 'chat_group') state.chatGroupsOverview = await window.janus.chatGroupsOverview();
    else if (target.conversationKind === 'collaboration_group') state.collaborationOverview = await window.janus.collaborationOverview();
    state.conversationPreferences = await window.janus.conversationPreferencesOverview();
    notify(archived ? '会话已归档，消息、任务和文件均已保留。' : '会话已移出归档。', 'success');
  } catch (error) {
    updateConversationArchiveState(target, target.archived);
    notify(userVisibleErrorMessage(error, '无法更新会话归档状态。'), 'error');
  }
  render();
}

function scheduleNetworkMessageSearch() {
  clearTimeout(networkMessageSearchTimer);
  networkMessageSearchRequestId += 1;
  const requestId = networkMessageSearchRequestId;
  const rawQuery = state.networkMessageSearchQuery;
  const query = normalizeSearch(rawQuery);
  state.networkMessageSearchResultQuery = '';
  state.networkMessageSearchSessionIds = [];
  if (!query) {
    applyNetworkMessageSearchFilter();
    return;
  }
  networkMessageSearchTimer = setTimeout(async () => {
    try {
      const results = await window.janus.searchSessions({ query: rawQuery, limit: 100 });
      if (requestId !== networkMessageSearchRequestId) return;
      state.networkMessageSearchResultQuery = rawQuery;
      const matchedSessions = (results || [])
        .filter((session) => !isInternalDelegationSession(session));
      const matchedRouteKeys = new Set(matchedSessions.map(networkMessageSearchRouteKey).filter(Boolean));
      state.networkMessageSearchSessionIds = [...new Set([
        ...matchedSessions.map((session) => session.id).filter(Boolean),
        ...state.sessions
          .filter((session) => matchedRouteKeys.has(networkMessageSearchRouteKey(session)))
          .map((session) => session.id)
          .filter(Boolean),
      ])];
      applyNetworkMessageSearchFilter();
    } catch {
      if (requestId !== networkMessageSearchRequestId) return;
      state.networkMessageSearchResultQuery = rawQuery;
      state.networkMessageSearchSessionIds = [];
      applyNetworkMessageSearchFilter();
    }
  }, 180);
}

function scheduleChatSearch() {
  clearTimeout(chatSearchTimer);
  chatSearchRequestId += 1;
  const requestId = chatSearchRequestId;
  const rawQuery = state.chatSearchQuery;
  const query = normalizeSearch(state.chatSearchQuery);
  state.chatSearchError = '';
  if (!query) {
    state.chatSearchLoading = false;
    state.chatSearchResults = [];
    return;
  }
  state.chatSearchLoading = true;
  state.chatSearchResults = [];
  chatSearchTimer = setTimeout(async () => {
    const localResults = localAgentSearchResults(rawQuery);
    try {
      const results = await window.janus.searchSessions({ query: rawQuery, limit: 50 });
      if (requestId !== chatSearchRequestId) return;
      state.chatSearchResults = mergeChatSearchResults(results, localResults);
      state.chatSearchLoading = false;
      render();
    } catch (error) {
      if (requestId !== chatSearchRequestId) return;
      state.chatSearchResults = localResults;
      state.chatSearchLoading = false;
      state.chatSearchError = localResults.length ? '' : error.message || String(error);
      render();
    }
  }, 300);
}

function openChatSearch() {
  resetChatSearchState();
  state.chatSearchOpen = true;
  render();
  setTimeout(() => document.getElementById('chat-search-modal-input')?.focus(), 50);
}

function resetChatSearchState() {
  clearTimeout(chatSearchTimer);
  chatSearchRequestId += 1;
  state.chatSearchQuery = '';
  state.chatSearchResults = [];
  state.chatSearchLoading = false;
  state.chatSearchError = '';
  chatSearchComposing = false;
}

function closeChatSearch() {
  state.chatSearchOpen = false;
  resetChatSearchState();
  render();
}

function toggleSidebarSection(section) {
  if (!['tasks', 'collaboration', 'projects', 'chats'].includes(section)) return;
  state.sidebarSectionsOpen = {
    ...(state.sidebarSectionsOpen || {}),
    [section]: !state.sidebarSectionsOpen?.[section],
  };
  state.projectMenuOpenId = '';
  state.projectMenuKind = '';
  state.projectMenuPosition = null;
  render();
}

function toggleProjectExpanded(projectId) {
  if (!projectById(projectId)) return;
  const next = new Set(state.expandedProjectIds || []);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  state.expandedProjectIds = Array.from(next);
  state.activeProjectId = projectId;
  state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), projects: true };
  if (next.has(projectId) && state.currentTab === 'chat' && !state.currentSessionId && !state.messages.length) {
    startNewProjectChat(projectId, { renderNow: false, focus: false });
  }
  render();
}

function expandProject(projectId) {
  if (!projectById(projectId)) return;
  state.activeProjectId = projectId;
  state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), projects: true };
  if (!isProjectExpanded(projectId)) state.expandedProjectIds = [...(state.expandedProjectIds || []), projectId];
}

function selectSidebarMode(mode = 'root') {
  if (mode === 'chats') {
    state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), chats: true };
    startNewPlainChat({ renderNow: false });
  }
  if (mode === 'projects') state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), projects: true };
  render();
}

function toggleCollaborationSources() {
  state.collaborationSourcesOpen = !state.collaborationSourcesOpen;
  state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), collaboration: true };
  render();
}

function existingCollaborationTaskForSession(sessionId = '') {
  if (!sessionId) return null;
  return (state.tasks || []).find((task) => task.metadata?.sourceSessionId === sessionId) || null;
}

async function deleteCollaborationTasks(rawIds = '') {
  const taskRunIds = String(rawIds || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!taskRunIds.length || state.busy) return;
  const label = taskRunIds.length > 1 ? `这组 ${taskRunIds.length} 条协作记录` : '这条协作记录';
  if (!window.confirm(`确认删除${label}吗？原始聊天不会被删除。`)) return;
  state.busy = true;
  render();
  try {
    await window.janus.deleteTasks({ taskRunIds });
    state.tasks = await window.janus.listTasks();
    if (state.taskDetail && taskRunIds.includes(state.taskDetail.id)) {
      state.taskDetail = null;
      state.currentTab = 'chat';
    }
    notify('协作记录已删除。', 'success');
  } catch (error) {
    notify(`删除协作记录失败：${error.message || error}`, 'error');
  } finally {
    state.busy = false;
    render();
  }
}

function startNewCollaborationChat({ renderNow = true, focus = true } = {}) {
  preserveCurrentComposerDraft();
  beginNewChatView();
  state.activeProjectId = '';
  state.currentTab = 'chat';
  state.sidebarMode = 'root';
  state.currentSessionId = '';
  state.messages = [];
  state.attachments = [];
  state.chatDraft = '';
  state.homeMode = 'collaboration';
  state.currentDepartmentId = '';
  state.currentAgentId = '';
  state.currentAgentInstanceId = '';
  state.selectionSource = null;
  state.modelMenuOpen = false;
  state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
  state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), collaboration: true };
  restoreComposerDraft(`new:${state.currentChatKey}`);
  if (renderNow) render();
  if (focus) focusChatInputAtEnd();
}

async function openCollaborationTask(taskId = '') {
  if (!taskId) return false;
  const rootTaskId = String(state.activeTaskWorkspaceId || taskId).trim();
  state.taskWorkspaceLoadingById = { ...(state.taskWorkspaceLoadingById || {}), [rootTaskId]: true };
  state.currentTab = 'collaboration';
  state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), collaboration: true };
  render();
  try {
    if (state.activeTaskWorkspaceKind === 'task_run') state.attachments = [];
    const cachedTask = state.taskDetail?.id === taskId
      ? state.taskDetail
      : (state.tasks || []).find((task) => String(task.id || '') === String(taskId)) || null;
    state.taskDetail = mergeTaskWorkspaceSnapshot(cachedTask, await window.janus.getTask(taskId), mergeTaskUpdateSnapshot);
    state.tasks = await window.janus.listTasks();
    if (state.activeTaskWorkspaceKind === 'task_run') {
      const workspace = await window.janus.taskRunWorkspaceMessages({ taskRunId: taskId }).catch(() => null);
      if (workspace) {
        const rootId = workspace.rootTaskRunId || taskId;
        state.activeTaskWorkspaceId = rootId;
        const workspaceMessages = mergeTaskWorkspaceMessages(
          state.taskRunWorkspaceMessagesById?.[rootId],
          workspace.messages,
        );
        state.taskRunWorkspaceMessagesById = { ...(state.taskRunWorkspaceMessagesById || {}), [rootId]: workspaceMessages };
        state.taskRunWorkspaceActiveRunById = { ...(state.taskRunWorkspaceActiveRunById || {}), [rootId]: workspace.activeTaskRunId || taskId };
        if (workspace.activeTaskRunId && workspace.activeTaskRunId !== state.taskDetail.id) {
          const activeTask = await window.janus.getTask(workspace.activeTaskRunId).catch(() => null);
          state.taskDetail = mergeTaskWorkspaceSnapshot(state.taskDetail, activeTask, mergeTaskUpdateSnapshot);
        }
        ensureTaskRunWorkspacePolling(rootId, workspaceMessages);
      }
    }
    state.taskWorkspaceLoadingById = { ...(state.taskWorkspaceLoadingById || {}), [rootTaskId]: false };
    render();
    return true;
  } catch (error) {
    state.taskWorkspaceLoadingById = { ...(state.taskWorkspaceLoadingById || {}), [rootTaskId]: false };
    notify(`打开协作任务失败：${error.message || error}`, 'error');
    return false;
  }
}

async function sendTaskRunWorkspaceMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const rootTaskRunId = String(form?.dataset.taskRunId || state.activeTaskWorkspaceId || state.taskDetail?.id || '').trim();
  const input = document.querySelector('#task-run-workspace-input');
  const content = String(input?.value || state.taskRunWorkspaceDrafts?.[rootTaskRunId] || '').trim();
  const outgoingAttachmentItems = [...(state.attachments || [])];
  if (!rootTaskRunId || (!content && !outgoingAttachmentItems.length)) return;
  const clientMessageId = globalThis.crypto?.randomUUID?.() || `task_supplement_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const optimistic = {
    id: `pending:${clientMessageId}`,
    role: 'user',
    content: content || '补充了任务相关附件。',
    createdAt: new Date().toISOString(),
    metadata: { taskRunWorkspace: true, taskWorkspaceTurn: true, clientMessageId, queueStatus: 'queued', optimistic: true },
  };
  state.taskRunWorkspaceMessagesById = {
    ...(state.taskRunWorkspaceMessagesById || {}),
    [rootTaskRunId]: [...(state.taskRunWorkspaceMessagesById?.[rootTaskRunId] || []), optimistic],
  };
  state.taskRunWorkspaceDrafts = { ...(state.taskRunWorkspaceDrafts || {}), [rootTaskRunId]: '' };
  state.attachments = [];
  render();
  try {
    const attachments = await readyAttachmentsForSend(outgoingAttachmentItems);
    const result = await window.janus.taskRunWorkspaceMessage({
      taskRunId: state.taskRunWorkspaceActiveRunById?.[rootTaskRunId] || state.taskDetail?.id || rootTaskRunId,
      content,
      attachments,
      clientMessageId,
      model: currentModelValue(),
      reasoningEffort: currentReasoningValue(),
      sandboxPermission: state.sandboxPermission,
    });
    state.taskRunWorkspaceMessagesById = {
      ...(state.taskRunWorkspaceMessagesById || {}),
      [rootTaskRunId]: result?.messages || state.taskRunWorkspaceMessagesById?.[rootTaskRunId] || [],
    };
    state.taskRunWorkspaceActiveRunById = {
      ...(state.taskRunWorkspaceActiveRunById || {}),
      [rootTaskRunId]: result?.activeTaskRunId || state.taskRunWorkspaceActiveRunById?.[rootTaskRunId] || rootTaskRunId,
    };
    if (result?.task?.id) {
      state.taskDetail = result.task;
      state.tasks = (state.tasks || []).map((task) => task.id === result.task.id ? result.task : task);
    }
    ensureTaskRunWorkspacePolling(rootTaskRunId, result?.messages || []);
  } catch (error) {
    state.taskRunWorkspaceMessagesById = {
      ...(state.taskRunWorkspaceMessagesById || {}),
      [rootTaskRunId]: (state.taskRunWorkspaceMessagesById?.[rootTaskRunId] || []).map((message) => (
        message.metadata?.clientMessageId === clientMessageId
          ? { ...message, metadata: { ...(message.metadata || {}), optimistic: false, queueStatus: 'failed', queueError: userErrorMessage(error) } }
          : message
      )),
    };
    if (!String(state.taskRunWorkspaceDrafts?.[rootTaskRunId] || '').trim()) {
      state.taskRunWorkspaceDrafts = { ...(state.taskRunWorkspaceDrafts || {}), [rootTaskRunId]: content };
    }
    if (!(state.attachments || []).length) state.attachments = outgoingAttachmentItems;
    notify(`补充要求发送失败：${userErrorMessage(error)}`, 'error');
  } finally {
    render();
    document.querySelector('#task-run-workspace-input')?.focus();
  }
}

async function acceptTaskDeliverySubmission(button) {
  const submissionId = String(button?.dataset?.acceptDeliverySubmission || '').trim();
  const submissionNo = Math.max(1, Number(button?.dataset?.deliverySubmissionNo || 1));
  const rootTaskRunId = String(state.activeTaskWorkspaceId || state.taskDetail?.id || '').trim();
  const activeTaskRunId = String(state.taskRunWorkspaceActiveRunById?.[rootTaskRunId] || state.taskDetail?.id || rootTaskRunId).trim();
  if (!submissionId || !activeTaskRunId) return;
  const taskActive = ['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'cancelling']
    .includes(String(state.taskDetail?.status || ''));
  if (taskActive && !window.confirm(`采用版本 ${submissionNo} 后，当前自动修改、验收和未完成节点都会停止。确认采用吗？`)) return;
  const clientMessageId = globalThis.crypto?.randomUUID?.() || `task_accept_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  button.disabled = true;
  try {
    const result = await window.janus.taskRunWorkspaceMessage({
      taskRunId: activeTaskRunId,
      content: `采用版本 ${submissionNo}，直接交付并停止当前修改。`,
      actionHint: 'accept_submission',
      submissionId,
      clientMessageId,
      model: currentModelValue(),
      reasoningEffort: currentReasoningValue(),
      sandboxPermission: state.sandboxPermission,
    });
    state.taskRunWorkspaceMessagesById = {
      ...(state.taskRunWorkspaceMessagesById || {}),
      [rootTaskRunId]: result?.messages || state.taskRunWorkspaceMessagesById?.[rootTaskRunId] || [],
    };
    if (result?.task?.id) {
      state.taskDetail = result.task;
      state.tasks = (state.tasks || []).map((task) => task.id === result.task.id ? result.task : task);
    } else {
      state.taskDetail = await window.janus.getTask(activeTaskRunId).catch(() => state.taskDetail);
    }
    if (result?.action === 'external_delivery_required') {
      notify(`版本 ${submissionNo} 已保留，请到委托任务确认交付；最终由发出方验收。`, 'info');
    } else {
      notify(`已接受版本 ${submissionNo}，任务已关闭。`, 'success');
    }
  } catch (error) {
    notify(`采用版本失败：${userErrorMessage(error)}`, 'error');
  } finally {
    render();
  }
}

async function requestTaskDeliveryRevision(button) {
  const rootTaskRunId = String(button?.dataset?.requestDeliveryRevision || state.activeTaskWorkspaceId || state.taskDetail?.id || '').trim();
  const activeTaskRunId = String(state.taskRunWorkspaceActiveRunById?.[rootTaskRunId] || state.taskDetail?.id || rootTaskRunId).trim();
  if (!rootTaskRunId || !activeTaskRunId) return;
  const revision = String(window.prompt('请填写需要修改的内容') || '').trim();
  if (!revision) return;
  const clientMessageId = globalThis.crypto?.randomUUID?.() || `task_revision_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  button.disabled = true;
  try {
    const result = await window.janus.taskRunWorkspaceMessage({
      taskRunId: activeTaskRunId,
      content: `修改要求：${revision}`,
      actionHint: 'request_revision',
      clientMessageId,
      model: currentModelValue(),
      reasoningEffort: currentReasoningValue(),
      sandboxPermission: state.sandboxPermission,
    });
    state.taskRunWorkspaceMessagesById = {
      ...(state.taskRunWorkspaceMessagesById || {}),
      [rootTaskRunId]: result?.messages || state.taskRunWorkspaceMessagesById?.[rootTaskRunId] || [],
    };
    state.taskRunWorkspaceActiveRunById = {
      ...(state.taskRunWorkspaceActiveRunById || {}),
      [rootTaskRunId]: result?.activeTaskRunId || activeTaskRunId,
    };
    state.taskDetail = result?.task || await window.janus.getTask(activeTaskRunId).catch(() => state.taskDetail);
    if (state.taskDetail?.id) {
      state.tasks = (state.tasks || []).map((task) => task.id === state.taskDetail.id ? state.taskDetail : task);
    }
    ensureTaskRunWorkspacePolling(rootTaskRunId, result?.messages || []);
    notify('修改要求已提交，任务不会在本轮显示为最终关闭。', 'success');
  } catch (error) {
    notify(`提交修改要求失败：${userErrorMessage(error)}`, 'error');
  } finally {
    render();
  }
}

function ensureTaskRunWorkspacePolling(rootTaskRunId = '', messages = []) {
  const rootId = String(rootTaskRunId || '').trim();
  const pending = (Array.isArray(messages) ? messages : []).some((message) => (
    message.metadata?.taskRunSupplement === true
    && ['queued', 'waiting', 'running'].includes(String(message.metadata?.queueStatus || ''))
  ));
  if (!rootId || !pending || taskRunWorkspacePolls.has(rootId)) return;
  const poll = async () => {
    try {
      const workspace = await window.janus.taskRunWorkspaceMessages({ taskRunId: rootId });
      const workspaceMessages = mergeTaskWorkspaceMessages(
        state.taskRunWorkspaceMessagesById?.[rootId],
        workspace.messages,
      );
      state.taskRunWorkspaceMessagesById = { ...(state.taskRunWorkspaceMessagesById || {}), [rootId]: workspaceMessages };
      state.taskRunWorkspaceActiveRunById = { ...(state.taskRunWorkspaceActiveRunById || {}), [rootId]: workspace.activeTaskRunId || rootId };
      if (state.activeTaskWorkspaceKind === 'task_run' && state.activeTaskWorkspaceId === rootId) {
        if (workspace.activeTaskRunId && workspace.activeTaskRunId !== state.taskDetail?.id) {
          const activeTask = await window.janus.getTask(workspace.activeTaskRunId).catch(() => null);
          state.taskDetail = mergeTaskWorkspaceSnapshot(state.taskDetail, activeTask, mergeTaskUpdateSnapshot);
        }
        renderPreservingTaskRunWorkspaceComposer();
      }
      const stillPending = (workspace.messages || []).some((message) => (
        message.metadata?.taskRunSupplement === true
        && ['queued', 'waiting', 'running'].includes(String(message.metadata?.queueStatus || ''))
      ));
      if (!stillPending) {
        taskRunWorkspacePolls.delete(rootId);
        return;
      }
    } catch {
      // Keep queued workspace messages recoverable across temporary renderer/API failures.
    }
    taskRunWorkspacePolls.set(rootId, setTimeout(poll, 1200));
  };
  taskRunWorkspacePolls.set(rootId, setTimeout(poll, 1200));
}

function noteTaskWorkspaceScrollInteraction() {
  taskWorkspaceInteractionUntil = Date.now() + TASK_WORKSPACE_SCROLL_IDLE_MS;
}

function beginTaskWorkspaceScrollInteraction() {
  taskWorkspaceScrollInteracting = true;
  noteTaskWorkspaceScrollInteraction();
}

function finishTaskWorkspaceScrollInteraction() {
  if (!taskWorkspaceScrollInteracting) return;
  taskWorkspaceScrollInteracting = false;
  noteTaskWorkspaceScrollInteraction();
  if (taskWorkspaceRenderPending) scheduleTaskWorkspaceRender();
}

function scheduleTaskWorkspaceRender() {
  taskWorkspaceRenderPending = true;
  if (taskWorkspaceRenderTimer || taskWorkspaceScrollInteracting) return;
  const queue = () => {
    const now = Date.now();
    const delay = Math.max(
      0,
      taskWorkspaceInteractionUntil - now,
      taskWorkspaceTypingUntil - now,
      TASK_WORKSPACE_UPDATE_THROTTLE_MS - (now - taskWorkspaceLastRenderedAt),
    );
    taskWorkspaceRenderTimer = setTimeout(() => {
      taskWorkspaceRenderTimer = null;
      if (!taskWorkspaceRenderPending) return;
      if (taskWorkspaceScrollInteracting) return;
      if (Date.now() < Math.max(taskWorkspaceInteractionUntil, taskWorkspaceTypingUntil)) {
        queue();
        return;
      }
      taskWorkspaceRenderPending = false;
      if (state.activeTaskWorkspaceKind !== 'task_run' || state.currentTab !== 'collaboration') return;
      taskWorkspaceLastRenderedAt = Date.now();
      renderPreservingTaskRunWorkspaceComposer();
    }, delay);
  };
  queue();
}

function renderPreservingTaskRunWorkspaceComposer() {
  const input = document.querySelector('#task-run-workspace-input');
  const active = document.activeElement === input;
  const selectionStart = active && Number.isFinite(input.selectionStart) ? input.selectionStart : null;
  const selectionEnd = active && Number.isFinite(input.selectionEnd) ? input.selectionEnd : null;
  const scrollTop = Number(input?.scrollTop || 0);
  render();
  if (!active) return;
  const replacement = document.querySelector('#task-run-workspace-input');
  if (!replacement) return;
  replacement.focus({ preventScroll: true });
  if (selectionStart !== null && selectionEnd !== null) replacement.setSelectionRange(selectionStart, selectionEnd);
  replacement.scrollTop = scrollTop;
}

async function handleTaskCardAction(button) {
  const action = String(button?.dataset?.taskCardAction || '').trim();
  if (!isTaskCardAction(action)) return;
  const workspaceId = String(button.dataset.taskWorkspaceId || '').trim();
  const taskRunId = String(button.dataset.taskRunId || '').trim();
  const requestedWorkspaceKind = String(button.dataset.taskWorkspaceKind || '').trim();
  const deliverySubmissionId = String(button.dataset.deliverySubmissionId || '').trim();
  const workspaceKind = requestedWorkspaceKind || (!workspaceId && taskRunId ? 'task_run' : 'delegation');
  const targetSessionId = String(button.dataset.taskTargetSessionId || '').trim();
  const workId = String(button.dataset.taskWorkId || '').trim();
  const sourceContext = normalizeTaskSourceContext({
    source_conversation_id: button.dataset.taskSourceConversationId || '',
    source_message_id: button.dataset.taskSourceMessageId || '',
    source_group_id: button.dataset.taskSourceGroupId || button.dataset.taskGroupId || '',
    task_workspace_id: workspaceId,
  });
  const navigationContext = {
    ...sourceContext,
    returnAnchorId: String(button.dataset.taskReturnAnchorId || '').trim(),
    returnSurface: String(button.dataset.taskReturnSurface || '').trim(),
  };
  const newTaskWorkspaceUiEnabled = state.uBuddyFeatureFlags?.newTaskWorkspaceUi !== false;
  if (action === TASK_CARD_ACTIONS.OPEN_WORKSPACE) {
    if (!workspaceId) {
      notify('任务工作区尚未准备完成，请稍后重试。', 'warning');
      return;
    }
    if (!newTaskWorkspaceUiEnabled) {
      notify('当前处于旧版任务视图，进度和结果保留在本会话任务卡中。', 'info');
      return;
    }
    if (workspaceKind === 'agent_session') {
      beginTaskWorkspaceNavigation(navigationContext, { workspaceKind, workspaceId });
      try {
        await openSession(targetSessionId || workspaceId);
      } catch (error) {
        await returnToTaskSourceChat(navigationContext);
        notify(`打开本地 Agent 工作区失败：${userErrorMessage(error)}`, 'error');
      }
      return;
    }
    if (workspaceKind === 'task_run') {
      state.taskResultSubmissionById = { ...(state.taskResultSubmissionById || {}), [workspaceId || taskRunId]: '' };
      state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [workspaceId || taskRunId]: 'activity' };
      beginTaskWorkspaceNavigation(navigationContext, { workspaceKind, workspaceId });
      const opened = await openCollaborationTask(taskRunId || workspaceId);
      if (!opened) await returnToTaskSourceChat(navigationContext);
      return;
    }
    state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [workspaceId]: 'activity' };
    await openNetworkDelegation(workspaceId, navigationContext);
    return;
  }
  if (action === TASK_CARD_ACTIONS.RETURN_TO_SOURCE_CHAT) {
    await returnToTaskSourceChat(navigationContext);
    return;
  }
  if (action === TASK_CARD_ACTIONS.OPEN_RESULT) {
    if (!workspaceId) {
      notify('任务结果尚未关联到可打开的工作区。', 'warning');
      return;
    }
    if (!newTaskWorkspaceUiEnabled) {
      notify('当前处于旧版任务视图，请在本会话任务卡中查看最终结果。', 'info');
      return;
    }
    if (workspaceKind === 'agent_session') {
      beginTaskWorkspaceNavigation(navigationContext, { workspaceKind, workspaceId });
      try {
        await openSession(targetSessionId || workspaceId);
      } catch (error) {
        await returnToTaskSourceChat(navigationContext);
        notify(`打开本地 Agent 结果失败：${userErrorMessage(error)}`, 'error');
      }
      return;
    }
    if (workspaceKind === 'task_run') {
      state.taskResultSubmissionById = {
        ...(state.taskResultSubmissionById || {}),
        [workspaceId || taskRunId]: deliverySubmissionId,
      };
      state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [workspaceId || taskRunId]: 'result' };
      beginTaskWorkspaceNavigation(navigationContext, { workspaceKind, workspaceId });
      const opened = await openCollaborationTask(taskRunId || workspaceId);
      if (!opened) await returnToTaskSourceChat(navigationContext);
      return;
    }
    state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [workspaceId]: 'result' };
    await openNetworkDelegation(workspaceId, navigationContext);
    return;
  }
  if (action === TASK_CARD_ACTIONS.OPEN_FLOW_GRAPH) {
    // Flow graph is no longer exposed as a user-facing workspace surface.
    // Keep old cards/deep links safe by opening the activity view instead.
    if (workspaceKind === 'task_run') {
      state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [workspaceId || taskRunId]: 'activity' };
      beginTaskWorkspaceNavigation(navigationContext, { workspaceKind, workspaceId: workspaceId || taskRunId });
      const opened = await openCollaborationTask(taskRunId || workspaceId);
      if (!opened) await returnToTaskSourceChat(navigationContext);
      return;
    }
    if (workspaceKind === 'agent_session') {
      if (taskRunId) {
        beginTaskWorkspaceNavigation(navigationContext, { workspaceKind: 'task_run', workspaceId: taskRunId });
        const opened = await openCollaborationTask(taskRunId);
        if (!opened) await returnToTaskSourceChat(navigationContext);
      }
      else notify('这个单 Agent 任务没有协作流程图。', 'warning');
      return;
    }
    if (!workspaceId) {
      if (taskRunId) {
        beginTaskWorkspaceNavigation(navigationContext, { workspaceKind: 'task_run', workspaceId: taskRunId });
        const opened = await openCollaborationTask(taskRunId);
        if (!opened) await returnToTaskSourceChat(navigationContext);
      }
      else notify('协作流程图仍在准备中。', 'warning');
      return;
    }
    state.taskWorkspaceViewById = { ...(state.taskWorkspaceViewById || {}), [workspaceId]: 'activity' };
    await openNetworkDelegation(workspaceId, navigationContext);
    return;
  }
  if (action === TASK_CARD_ACTIONS.CANCEL_TASK) {
    if (workspaceKind === 'agent_session') {
      if (!workId) {
        notify('本地 Agent 任务缺少运行标识，无法停止。', 'warning');
        return;
      }
      if (!window.confirm('停止后，已完成内容会保留，未完成步骤不会继续。确认停止这个任务吗？')) return;
      try {
        const receipt = await window.janus.cancelAgentDelivery({ workId });
        const status = String(receipt?.deliveryStatus || 'cancelled');
        updatePublishedTaskCardStatus(workId, status);
        if (status === 'cancelled') notify('本地 Agent 任务已停止，已完成内容已保留。', 'success');
        else if (status === 'completed') notify('任务已经完成，无需停止。', 'success');
        else if (status === 'failed') notify('任务已经结束，当前状态为执行失败。', 'warning');
        else notify(`任务当前状态：${status}`, 'warning');
        render();
      } catch (error) {
        notify(`停止本地 Agent 任务失败：${userErrorMessage(error)}`, 'error');
      }
      return;
    }
    if (workspaceKind === 'task_run') {
      const cancelledTask = await cancelUBuddyTask(taskRunId || workspaceId);
      if (cancelledTask && state.uBuddyCenterOpen === 'tasks') {
        clearUBuddyCenterItems('tasks');
        await loadUBuddyCenter();
      }
      return;
    }
    const delegation = (state.agentDelegations || []).find((item) => item.id === workspaceId)
      || state.collaborationGroupDetail?.tasks?.find((item) => item.id === workspaceId)
      || null;
    const currentUserId = state.currentUser?.id || '';
    const recipientId = delegation?.recipientUserId || delegation?.recipient_user_id || '';
    const cancellingOwnWorkspaceRun = Boolean(taskRunId && state.networkDelegationId === workspaceId && recipientId === currentUserId);
    if (cancellingOwnWorkspaceRun) {
      const cancelledTask = await cancelUBuddyTask(taskRunId);
      if (cancelledTask) {
        state.networkDelegationTaskById = {
          ...(state.networkDelegationTaskById || {}),
          [workspaceId]: cancelledTask,
        };
        render();
      }
      return;
    }
    if (!workspaceId) {
      if (taskRunId) await cancelUBuddyTask(taskRunId);
      else notify('任务标识缺失，无法取消。', 'warning');
      return;
    }
    if (!window.confirm('取消后，已完成内容会保留，未完成步骤不会继续。确认取消这个任务吗？')) return;
    try {
      await window.janus.collaborationTaskAction({ delegationId: workspaceId, action: 'withdraw', content: '发起人已取消任务。' });
      await refreshCollaborationOverview(false);
      state.agentDelegations = state.collaborationOverview?.tasks || state.agentDelegations;
      if (state.currentSessionId) {
        const sessionId = state.currentSessionId;
        const page = await loadLatestRendererMessagePage(sessionId).catch(() => null);
        if (page) applyLatestRendererMessagePage(sessionId, page);
      }
      notify('任务已取消，已完成内容已保留。', 'success');
      if (state.uBuddyCenterOpen === 'tasks') {
        clearUBuddyCenterItems('tasks');
        await loadUBuddyCenter();
      }
      render();
    } catch (error) {
      notify(`取消任务失败：${userErrorMessage(error)}`, 'error');
    }
  }
}

function updatePublishedTaskCardStatus(identity = '', status = '') {
  const updateMessages = (messages = []) => (Array.isArray(messages) ? messages : []).map((message) => {
    const cards = Array.isArray(message.metadata?.publishedTaskCards) ? message.metadata.publishedTaskCards : null;
    if (!cards) return message;
    return {
      ...message,
      metadata: {
        ...(message.metadata || {}),
        publishedTaskCards: cards.map((card) => (
          [card.workId, card.taskRunId, card.taskWorkspaceId, card.delegationId].includes(identity)
            ? { ...card, status }
            : card
        )),
      },
    };
  });
  state.messages = updateMessages(state.messages);
  if (state.taskWorkspaceReturnContext) {
    state.taskWorkspaceReturnContext.messages = updateMessages(state.taskWorkspaceReturnContext.messages);
  }
}

function buildCollaborationPromptFromSession(session = {}, messages = []) {
  const title = session.title || '未命名聊天';
  const sourceType = session.departmentId === 'general' ? '普通聊天' : sessionSubtitle(session) || session.departmentId || '历史对话';
  const rows = (messages || [])
    .filter((message) => ['user', 'assistant'].includes(message.role))
    .map((message) => {
      const text = messageTextForCopy(message);
      if (!text) return '';
      const role = message.role === 'user' ? '用户' : 'Janus';
      return `${role}: ${text.slice(0, 1200)}`;
    })
    .filter(Boolean)
    .slice(-12);
  return [
    '请把下面这段旧对话作为一个多部门协作任务来处理。',
    '要求：先判断需要哪些部门参与，再拆解任务；如果某个 agent 需要另一个 agent 补充信息，请发起 Agent communication request；最后给出协作进度、已完成内容、阻塞点和下一步。',
    '',
    `来源标题：${title}`,
    `来源类型：${sourceType}`,
    '',
    '旧对话内容：',
    rows.join('\n\n') || '(这条对话没有可读取的正文，请根据标题和上下文建立协作任务。)',
  ].join('\n');
}

async function sendSessionToCollaboration(sessionId = '') {
  if (!sessionId || state.busy) return;
  const session = findSessionById(sessionId) || state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    notify('没有找到这条历史对话。', 'warning');
    return;
  }
  const existingTask = existingCollaborationTaskForSession(sessionId);
  if (existingTask?.id) {
    await openCollaborationTask(existingTask.id);
    notify('这条旧对话已经有协作任务，已为你打开。', 'success');
    return;
  }
  state.collaborationImportingSessionId = sessionId;
  render();
  try {
    const page = await loadLatestRendererMessagePage(sessionId, 80, { coordinate: false });
    const prompt = buildCollaborationPromptFromSession(session, page?.items || []);
    await sendCollaborationPrompt(prompt, { sourceSessionId: sessionId, sourceTitle: session.title || '' });
  } catch (error) {
    notify(`发送到多部门协作失败：${error.message || error}`, 'error');
  } finally {
    state.collaborationImportingSessionId = '';
    render();
  }
}

async function sendCollaborationPrompt(message, { sourceSessionId = '', sourceTitle = '' } = {}) {
  if (!state.currentUser) {
    state.currentTab = 'settings';
    notify('请先登录账号再开始协作。', 'warning');
    render();
    return;
  }
  const prompt = String(message || '').trim();
  if (!prompt || state.busy) return;
  startNewCollaborationChat({ renderNow: false, focus: false });
  const originChatKey = state.currentChatKey;
  const channelId = Math.random().toString(16).slice(2);
  const localMessageId = `local-${Date.now()}`;
  state.status = '';
  const run = {
    channelId,
    sessionId: '',
    displaySessionId: '',
    executionSessionId: '',
    workerSessionId: '',
    chatKey: originChatKey,
    departmentId: 'collaboration',
    agentId: '',
    userMessage: prompt,
    sessionTitle: sourceTitle || prompt.slice(0, 40) || '部门协作',
    statusMessageId: `run-${channelId}-status`,
    processMessageId: '',
    assistantMessageId: '',
    assistantContent: '',
    processEvents: [],
    targetKind: 'collaboration',
    projectId: '',
    workspaceRoot: '',
    startedAt: Date.now(),
    lastStatusStage: 'queued',
    lastStatusText: '',
  };
  registerChatRun(run);
  run.localUserMessage = {
    id: localMessageId,
    role: 'user',
    content: prompt,
    agentId: '',
    departmentId: 'collaboration',
    createdAt: new Date().toISOString(),
    metadata: sourceSessionId ? { sourceSessionId, sourceTitle } : {},
  };
  state.messages.push(run.localUserMessage);
  updateRunStatusMessage(run, 'queued', '部门协作：已接收历史对话，正在建立跨部门图谱');
  render();
  scrollMessagesToBottom({ force: true });
  try {
    const result = await window.janus.sendChat({
      channelId,
      sessionId: '',
      departmentId: 'collaboration',
      agentId: '',
      chatMode: 'collaboration',
      routePreference: 'explicit',
      chatContext: { mode: 'collaboration', type: 'collaboration', label: '部门协作', sourceSessionId, sourceTitle },
      attachments: [],
      imageAttachments: [],
      message: prompt,
      model: currentModelValue(),
      reasoningEffort: currentReasoningValue(),
      sandboxPermission: state.sandboxPermission,
    });
    if (result?.cancelled) {
      notify('已中止协作。', 'success');
      return;
    }
    run.sessionId = result.session.id;
    run.displaySessionId = result.session.id;
    run.executionSessionId = result.session.id;
    const runIsCurrent = isRunForCurrentChat(run);
    if (runIsCurrent) {
      state.currentSessionId = result.session.id;
      state.currentChatKey = `session:${result.session.id}`;
      const [page, contextUsage] = await Promise.all([
        loadLatestRendererMessagePage(result.session.id),
        window.janus.chatContextStatus({ sessionId: result.session.id }).catch(() => null),
      ]);
      if (isRunForCurrentChat(run)) {
        if (applyLatestRendererMessagePage(result.session.id, page)) state.contextUsage = contextUsage;
      }
    }
    state.sessions = await window.janus.listSessions();
    state.tasks = await window.janus.listTasks();
    if (result.task?.id) state.taskDetail = await window.janus.getTask(result.task.id);
    state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), collaboration: true };
    notify('已发送到多部门协作。', 'success');
  } catch (error) {
    if (isRunForCurrentChat(run)) {
      clearRunTransientMessages(run);
      state.messages.push({
        role: 'assistant',
        content: `执行失败：${userErrorMessage(error)}`,
        agentId: '',
        departmentId: 'collaboration',
        createdAt: new Date().toISOString(),
      });
    }
    notify(`多部门协作失败：${error.message || error}`, 'error');
  } finally {
    if (isRunForCurrentChat(run)) clearRunTransientMessages(run);
    unregisterChatRun(run);
    if (!allChatRuns().length) stopRunStatusTimer();
    render();
    scrollMessagesToBottom();
  }
}


async function cancelActiveChat() {
  const run = currentChatRun();
  if (!run) return true;
  if (run.cancelling) return false;
  run.cancelling = true;
  updateRunStatusMessage(run, 'cancelling', '正在中止生成');
  renderRunUpdate();
  try {
    const result = await window.janus.cancelChat({
      runId: run.runId || '',
      channelId: run.channelId || '',
    });
    const settled = Boolean(result) && result.settled !== false;
    // Once the main process accepts the abort, stop rendering this run locally.
    // A provider may take a little longer to unwind; late events are ignored after
    // unregistering, and the shared AbortSignal prevents image artifacts from being saved.
    if (settled || result?.ok) {
      const activeRun = chatRunForChannel(run.channelId);
      if (activeRun) {
        handleChatRunEvent(run.channelId, {
          kind: 'cancelled',
          agentId: run.agentId || '',
          departmentId: run.departmentId || '',
          message: '??????',
        });
        clearRunTransientMessages(activeRun, { processStatus: 'cancelled', processExpanded: true });
        unregisterChatRun(activeRun);
        if (!allChatRuns().length) stopRunStatusTimer();
        render();
      }
      return true;
    }
    if (chatRunForChannel(run.channelId)) {
      run.cancelling = false;
      notify(result?.reason || '???????????', 'warning');
      render();
    }
    return false;
  } catch (error) {
    if (chatRunForChannel(run.channelId)) {
      run.cancelling = false;
      render();
    }
    notify(`中止失败：${error.message || error}`, 'error');
    return false;
  }
}

function editMessageFromHistory(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  const text = messageTextForCopy(message);
  const attachments = Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments.filter(Boolean) : [];
  if (!text && !attachments.length) return notify('这条消息没有可重新编辑的内容。', 'warning');
  if (!canEditMessageFromHistory(message)) {
    notify('只能重新编辑当前会话中最近发送的一条消息。', 'warning');
    return;
  }
  state.messageEditingId = message.id;
  state.messageEditingDraft = text;
  state.messageEditingBusy = false;
  state.messageEditingError = '';
  render();
  setTimeout(() => document.querySelector('[data-message-rewrite-input]')?.focus(), 0);
}

function canEditMessageFromHistory(message = null) {
  if (!message || message.role !== 'user') return false;
  const latest = [...state.messages].reverse().find((item) => item?.role === 'user');
  return Boolean(latest?.id && latest.id === message.id);
}

async function submitMessageRewrite(event) {
  event.preventDefault();
  if (state.messageEditingBusy) return;
  const form = event.currentTarget;
  const messageId = String(form.dataset.messageRewriteForm || '').trim();
  const editingMessage = state.messages.find((item) => item.id === messageId);
  const editedText = String(form.querySelector('[data-message-rewrite-input]')?.value || '').trim();
  if (!editingMessage || !editedText) {
    state.messageEditingError = '消息内容不能为空。';
    render();
    return;
  }
  state.messageEditingBusy = true;
  state.messageEditingError = '';
  render();
  try {
    if (currentChatRun() && !await cancelActiveChat()) throw new Error('当前回复尚未完全中止。');
    const message = await persistedMessageForRewrite(editingMessage);
    if (!message?.id) throw new Error('要重新编辑的消息尚未完成同步，请稍后重试。');
    const result = await window.janus.rewriteLastUserTurn({
      sessionId: state.currentSessionId,
      messageId: message.id,
      commandId: globalThis.crypto?.randomUUID?.() || `message_rewrite_${Date.now()}`,
    });
    const metadata = message.metadata || {};
    state.messages = Array.isArray(result?.messages) ? result.messages : state.messages.filter((item) => !result?.supersededMessageIds?.includes(item.id));
    restoreMessageAttachmentsToComposer(Array.isArray(metadata.attachments) ? metadata.attachments : []);
    state.composerFileReferences = Array.isArray(metadata.fileReferences) ? metadata.fileReferences.map((item) => ({ ...item })) : [];
    state.composerMemoryReferences = Array.isArray(metadata.memoryReferences) ? metadata.memoryReferences.map((item) => ({ ...item })) : [];
    state.messageQuote = metadata.quote || null;
    state.chatDraft = editedText;
    state.messageEditingId = '';
    state.messageEditingDraft = '';
    state.messageEditingBusy = false;
    render();
    const input = document.getElementById('chat-input');
    if (!input) throw new Error('未找到对话输入框。');
    input.value = editedText;
    document.getElementById('chat-form')?.requestSubmit();
  } catch (error) {
    state.messageEditingBusy = false;
    state.messageEditingError = userVisibleErrorMessage(error, '重新编辑失败。');
    render();
  }
}

async function persistedMessageForRewrite(message = null) {
  const messageId = String(message?.id || '').trim();
  if (!messageId.startsWith('local-')) return message;
  const sessionId = String(state.currentSessionId || '').trim();
  if (!sessionId) return null;
  const page = await loadLatestRendererMessagePage(sessionId, 80, { coordinate: false });
  return findPersistedRewriteMessage(message, page?.items || [], {
    textForMessage: messageTextForCopy,
  });
}

function restoreMessageAttachmentsToComposer(attachments = []) {
  for (const item of state.attachments || []) {
    if (item?.localPreviewUrl) URL.revokeObjectURL(item.localPreviewUrl);
  }
  state.attachments = attachments.map((attachment, index) => {
    const uploaded = { ...attachment };
    const name = uploaded.filename || uploaded.name || `attachment-${index + 1}`;
    return {
      id: `edited-${uploaded.id || Date.now()}-${index}`,
      name,
      kind: uploaded.kind || '',
      status: 'done',
      progress: 100,
      uploaded: {
        ...uploaded,
        filename: name,
        name,
      },
    };
  });
}

function messageTextForCopy(message = {}) {
  if (!message || parseArtifactMessage(message.content)) return '';
  const attachments = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
  const content = attachments.length ? stripAttachmentResourceBlock(message.content) : message.content;
  const controlMessageKind = message.role === 'assistant' && message.metadata?.secretaryControl === true
    ? uBuddyControlMessageKind(message.metadata)
    : '';
  const localized = controlMessageKind
    ? uBuddyControlMessageText(controlMessageKind, message.metadata?.controlLanguage || state.languageMode)
    : message.role === 'assistant' && message.metadata?.secretaryControl === true
      ? translateUBuddyMessageText(content, state.languageMode)
      : content;
  return stripHiddenMarkdownBlocks(localized);
}

async function copyCodeBlockText(button) {
  const code = button?.closest?.('.message-code-shell')?.querySelector?.('code');
  const text = code?.textContent ?? '';
  if (!text) return notify('这个代码块没有可复制的内容。', 'warning');
  try {
    await writeClipboardText(text);
    const label = button.querySelector('[data-code-copy-label]');
    const originalLabel = label?.textContent || translateUiText('复制', state.languageMode);
    if (label) label.textContent = translateUiText('已复制', state.languageMode);
    button.classList.add('is-copied');
    window.setTimeout(() => {
      if (!button.isConnected) return;
      if (label) label.textContent = originalLabel;
      button.classList.remove('is-copied');
    }, 1600);
  } catch (error) {
    notify(`复制代码失败：${error.message || error}`, 'error');
  }
}

async function writeClipboardText(text) {
  if (window.janus.writeClipboardText) {
    await window.janus.writeClipboardText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.select();
  const ok = document.execCommand('copy');
  input.remove();
  if (!ok) throw new Error('系统剪贴板不可用');
}


const remoteImageThumbnailCache = new Map();
const remoteImageThumbnailInflight = new Set();
const remoteFavoriteEmojiCache = new Map();
const remoteFavoriteEmojiInflight = new Map();

function hydrateRemoteImageAttachmentThumbnails(root = document) {
  const nodes = Array.from(root?.querySelectorAll?.('.compact-message-image.is-remote-placeholder [data-preview-file]') || []);
  for (const button of nodes) {
    const payloadText = button.dataset.previewFile || '';
    const file = parsePreviewPayload(payloadText);
    const key = file.remote_file_id || file.id || payloadText;
    if (!key || remoteImageThumbnailInflight.has(key)) continue;
    const cachedUrl = remoteImageThumbnailCache.get(key);
    if (cachedUrl) {
      applyRemoteImageThumbnail(button, cachedUrl, file.name || file.filename || 'image');
      continue;
    }
    remoteImageThumbnailInflight.add(key);
    Promise.resolve(materializeCollaborationFile(file))
      .then((downloaded) => {
        const imageUrl = downloaded.fileUrl || downloaded.file_url || downloaded.preview_url || downloaded.download_url || '';
        if (!imageUrl) return;
        remoteImageThumbnailCache.set(key, imageUrl);
        document.querySelectorAll(`.compact-message-image.is-remote-placeholder [data-preview-file="${CSS.escape(payloadText)}"]`).forEach((target) => {
          applyRemoteImageThumbnail(target, imageUrl, downloaded.name || downloaded.filename || file.name || 'image');
        });
      })
      .catch(() => {})
      .finally(() => remoteImageThumbnailInflight.delete(key));
  }
}

function applyRemoteImageThumbnail(button, imageUrl = '', name = 'image') {
  if (!button || !imageUrl) return;
  button.innerHTML = `<img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(name)}" loading="lazy" />`;
  button.closest('.compact-message-image')?.classList.remove('is-remote-placeholder');
  button.closest('.compact-message-image')?.classList.add('has-image-source');
}

function hydrateRemoteFavoriteEmojiAttachments(root = document) {
  const nodes = Array.from(root?.querySelectorAll?.('.message-favorite-emoji-image[data-favorite-emoji-remote]') || []);
  for (const button of nodes) {
    const inlineImage = button.querySelector('img.message-favorite-emoji-img');
    const inlineSource = String(inlineImage?.getAttribute('src') || '').trim();
    // A matching local/cloud favorite already carries the complete original bytes.
    // Do not replace it with an older message-file copy that may have been uploaded
    // by clients affected by the truncated data-URL bug.
    if (inlineSource.startsWith('data:image/')) continue;
    const file = parsePreviewPayload(button.dataset.favoriteEmojiRemote || '');
    if (!file) continue;
    const key = String(file.remote_file_id || file.remoteFileId || file.id || '').trim();
    if (!key) continue;
    const cachedUrl = remoteFavoriteEmojiCache.get(key);
    if (cachedUrl) {
      applyRemoteFavoriteEmoji(button, cachedUrl, file);
      continue;
    }
    let request = remoteFavoriteEmojiInflight.get(key);
    if (!request) {
      request = Promise.resolve(materializeCollaborationFile(file)).then(async (downloaded) => {
        let imageUrl = '';
        // Electron can block or inconsistently repaint file:// images after a
        // full renderer refresh.  Read the verified local cache bytes and use
        // a stable data URL for stickers instead.
        if (downloaded?.path && window.janus.readFileBase64) {
          const result = await window.janus.readFileBase64({ path: downloaded.path });
          const dataBase64 = String(result?.dataBase64 || '').trim();
          const contentType = String(downloaded.content_type || downloaded.type || file.content_type || file.type || 'image/png');
          if (dataBase64) imageUrl = `data:${contentType};base64,${dataBase64}`;
        }
        if (!imageUrl) imageUrl = downloaded?.fileUrl || downloaded?.file_url || downloaded?.preview_url || downloaded?.download_url || '';
        if (!imageUrl) throw new Error('missing image');
        remoteFavoriteEmojiCache.set(key, imageUrl);
        return { imageUrl, downloaded };
      }).finally(() => remoteFavoriteEmojiInflight.delete(key));
      remoteFavoriteEmojiInflight.set(key, request);
    }
    request.then(({ imageUrl, downloaded }) => {
      document.querySelectorAll('.message-favorite-emoji-image[data-favorite-emoji-remote]').forEach((target) => {
        const targetFile = parsePreviewPayload(target.dataset.favoriteEmojiRemote || '');
        const targetKey = String(targetFile?.remote_file_id || targetFile?.remoteFileId || targetFile?.id || '').trim();
        if (targetKey === key) applyRemoteFavoriteEmoji(target, imageUrl, { ...targetFile, ...downloaded });
      });
    }).catch(() => {
      if (!button.isConnected || button.querySelector('img')) return;
      button.classList.remove('is-loading');
      button.classList.add('is-error');
      button.innerHTML = '<span class="message-favorite-emoji-placeholder is-error" title="表情图片加载失败">!</span>';
    });
  }
}

function applyRemoteFavoriteEmoji(button, imageUrl = '', file = {}) {
  if (!button?.isConnected || !imageUrl) return;
  const currentImage = button.querySelector('img');
  const currentSource = String(currentImage?.getAttribute('src') || '').trim();
  if (currentSource.startsWith('data:image/')) return;
  if (currentImage?.src === imageUrl && button.classList.contains('has-image-source')) return;
  button.classList.remove('is-loading', 'is-error');
  button.classList.add('has-image-source');
  const image = document.createElement('img');
  image.src = imageUrl;
  image.alt = '表情';
  image.loading = 'eager';
  image.decoding = 'sync';
  image.addEventListener('error', () => {
    const key = String(file.remote_file_id || file.remoteFileId || file.id || '').trim();
    if (key) remoteFavoriteEmojiCache.delete(key);
    if (!button.isConnected) return;
    button.classList.remove('has-image-source', 'is-loading');
    button.classList.add('is-error');
    button.innerHTML = '<span class="message-favorite-emoji-placeholder is-error" title="表情图片加载失败">!</span>';
  }, { once: true });
  image.className = 'message-favorite-emoji-img';
  button.replaceChildren(image);
  button.dataset.imageContextFile = encodeURIComponent(JSON.stringify({ ...file, fileUrl: imageUrl, file_url: imageUrl }));
}

function parsePreviewPayload(value) {
  try {
    const decoded = decodeURIComponent(String(value || '%7B%7D'));
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    notify('文件预览数据已失效，请刷新后再试。', 'warning');
    return null;
  }
}


function scrollMessagesToBottom({ force = false, settle = false } = {}) {
  if (force) {
    messageScrollFollowEvaluation += 1;
    if (messageScrollIdleTimer) {
      clearTimeout(messageScrollIdleTimer);
      messageScrollIdleTimer = null;
    }
    messageScrollInteracting = false;
    messageScrollLayoutInteraction = false;
    messageDisclosureScrollSnapshot = null;
    messageHistoryAutoLoadArmed = false;
    messageScrollFollow = true;
  }
  if (!messageScrollFollow || messageScrollInteracting) return;
  const list = document.getElementById('message-list');
  if (!list) return;
  list.scrollTop = list.scrollHeight;
  messageScrollTop = list.scrollTop;
  if (settle) scheduleMessageBottomSettle(list);
}

function scheduleMessageBottomSettle(list) {
  if (!list) return;
  const generation = ++messageBottomSettleGeneration;
  const evaluation = messageScrollFollowEvaluation;
  const scrollKey = String(list.dataset.messageScrollKey || '');
  const settle = () => {
    if (generation !== messageBottomSettleGeneration
      || evaluation !== messageScrollFollowEvaluation
      || document.getElementById('message-list') !== list
      || String(list.dataset.messageScrollKey || '') !== scrollKey
      || !messageScrollFollow
      || messageScrollInteracting) return;
    list.scrollTop = list.scrollHeight;
    messageScrollTop = list.scrollTop;
  };
  requestAnimationFrame(() => {
    settle();
    requestAnimationFrame(settle);
  });
  [80, 200, 500, 1_000].forEach((delay) => setTimeout(settle, delay));
}

async function createTask(event) {
  event.preventDefault();
  const prompt = document.getElementById('task-prompt').value.trim();
  if (!prompt) return;
  const departmentId = document.getElementById('task-department').value;
  try {
    const task = await window.janus.createTask({ prompt, departmentId });
    state.taskDetail = task;
    state.tasks = await window.janus.listTasks();
    notify('任务已创建。', 'success');
    render();
  } catch (error) {
    appendStatus(`Task create error: ${error.message || error}`);
    notify(`任务创建失败：${error.message || error}`, 'error');
  }
}

async function openTask(taskId) {
  state.taskDetail = await window.janus.getTask(taskId);
  await refreshTaskWorkMemory(taskId, { renderAfter: false });
  render();
}

async function runReadyTaskNodes() {
  if (!state.taskDetail?.id || state.taskBusy) return;
  state.taskBusy = true;
  render();
  try {
    state.taskDetail = await window.janus.runReadyTasks({ taskRunId: state.taskDetail.id, options: { dryRun: false } });
    state.tasks = await window.janus.listTasks();
    await refreshTaskWorkMemory(state.taskDetail.id, { renderAfter: false });
    notify('已检查并推进所有待执行节点。', 'success');
  } catch (error) {
    appendStatus(`Task error: ${error.message || error}`);
    notify(`运行任务节点失败：${error.message || error}`, 'error');
  } finally {
    state.taskBusy = false;
    render();
  }
}

async function retryFailedTaskNode(taskRunId = '', taskNodeId = '') {
  if (!taskRunId || !taskNodeId || state.taskBusy) return;
  const node = (state.taskDetail?.nodes || []).find((item) => item.id === taskNodeId);
  if (!node || !['failed', 'retry_wait'].includes(node.status)) return;
  if (!window.confirm(`确认从失败节点“${node.title || taskNodeId}”继续吗？该节点成功后，系统会自动推进仍未完成的下游节点。`)) return;
  state.taskBusy = true;
  render();
  try {
    state.taskDetail = await window.janus.retryTaskNode({
      taskRunId,
      taskNodeId,
      options: {
        dryRun: false,
        model: currentModelValue(),
        reasoningEffort: currentReasoningValue(),
      },
    });
    state.tasks = await window.janus.listTasks();
    await refreshTaskWorkMemory(taskRunId, { renderAfter: false });
    const retried = (state.taskDetail?.nodes || []).find((item) => item.id === taskNodeId);
    if (retried?.status === 'completed') notify('失败节点已重试完成，系统已继续推进下游任务。', 'success');
    else notify(`节点重试结束：${retried?.errorText || retried?.status || '状态未知'}`, retried?.status === 'failed' ? 'error' : 'success');
  } catch (error) {
    appendStatus(`Task retry error: ${error.message || error}`);
    notify(`重试失败节点失败：${error.message || error}`, 'error');
  } finally {
    state.taskBusy = false;
    render();
  }
}

async function cancelUBuddyTask(taskRunId = '') {
  const cleanId = String(taskRunId || '').trim();
  if (!cleanId || state.taskBusy) return null;
  if (!window.confirm('停止后，已完成内容会保留，未完成步骤不会继续。确认停止这个任务吗？')) return null;
  state.taskBusy = true;
  render();
  try {
    const task = await window.janus.cancelTask({ taskRunId: cleanId });
    state.tasks = await window.janus.listTasks();
    if (state.taskDetail?.id === cleanId) state.taskDetail = task;
    if (state.currentSessionId) {
      const sessionId = state.currentSessionId;
      applyLatestRendererMessagePage(sessionId, await loadLatestRendererMessagePage(sessionId));
    }
    notify('任务已停止，已完成内容已保留。', 'success');
    return task;
  } catch (error) {
    notify(`停止任务失败：${error.message || error}`, 'error');
    return null;
  } finally {
    state.taskBusy = false;
    render();
  }
}

async function cancelPendingUBuddyDispatch(commandId = '') {
  const cleanId = String(commandId || '').trim();
  if (!cleanId || state.taskBusy) return null;
  if (!window.confirm('取消后，尚未发出的分工不会再自动发布；已经发布的任务不受影响。确认取消吗？')) return null;
  state.taskBusy = true;
  render();
  try {
    const result = await window.janus.cancelPendingUBuddyDispatch({ commandId: cleanId });
    if (state.currentSessionId) {
      const sessionId = state.currentSessionId;
      applyLatestRendererMessagePage(sessionId, await loadLatestRendererMessagePage(sessionId));
    }
    notify('已取消未上线成员的自动补派；已发布任务不受影响。', 'success');
    return result;
  } catch (error) {
    notify(`取消自动补派失败：${error.message || error}`, 'error');
    return null;
  } finally {
    state.taskBusy = false;
    render();
  }
}

async function rerunUBuddyTask(taskRunId = '') {
  const cleanId = String(taskRunId || '').trim();
  if (!cleanId || state.taskBusy) return;
  state.taskBusy = true;
  render();
  try {
    const result = await window.janus.rerunTask({
      taskRunId: cleanId,
      model: currentModelValue(),
      reasoningEffort: currentReasoningValue(),
      sandboxPermission: state.sandboxPermission,
    });
    state.tasks = await window.janus.listTasks();
    if (result?.task?.id) state.taskDetail = await window.janus.getTask(result.task.id);
    if (result?.session?.id) {
      state.currentSessionId = result.session.id;
      state.currentChatKey = `session:${result.session.id}`;
      state.homeMode = 'secretary';
      applyLatestRendererMessagePage(result.session.id, await loadLatestRendererMessagePage(result.session.id));
    }
    notify('已基于原要求重新规划并创建新任务。', 'success');
  } catch (error) {
    notify(`重新执行失败：${error.message || error}`, 'error');
  } finally {
    state.taskBusy = false;
    render();
  }
}

async function refreshTaskWorkMemory(taskId = '', { renderAfter = true } = {}) {
  if (!taskId) return null;
  const workScopeId = `task:${taskId}`;
  state.workMemoryObservability = { workScopeId, outbox: [], audits: [], loading: true, error: '' };
  if (renderAfter) render();
  try {
    const [outbox, audits] = await Promise.all([
      window.janus.workMemoryOutbox({ workScopeId, limit: 100 }),
      window.janus.workMemoryAudits({ workScopeId, limit: 100 }),
    ]);
    state.workMemoryObservability = { workScopeId, outbox: outbox || [], audits: audits || [], loading: false, error: '' };
  } catch (error) {
    state.workMemoryObservability = {
      workScopeId,
      outbox: [],
      audits: [],
      loading: false,
      error: userVisibleErrorMessage(error, '无法读取协作 Memory 状态。'),
    };
  }
  if (renderAfter) render();
  return state.workMemoryObservability;
}



function appendStatus(text) {
  state.status = `${state.status || ''}${state.status ? '\n' : ''}${text}`.slice(-6000);
  const log = document.getElementById('status-log');
  if (log) log.textContent = state.status;
}

function evolutionCommandId(prefix = 'evolution') {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${id}`;
}

function evolutionErrorCode(error) {
  return String(error?.code || error?.body?.error?.code || error?.body?.code || '').trim();
}

async function refreshEvolutionPreference({ renderAfter = true } = {}) {
  if (!state.currentUser || state.evolutionPreferenceLoading
    || (state.evolutionPreference === null && state.evolutionPreferenceError)) return state.evolutionPreference;
  state.evolutionPreferenceLoading = true;
  state.evolutionPreferenceError = '';
  if (renderAfter) render();
  try {
    state.evolutionPreference = await window.janus.evolutionPreference();
  } catch (error) {
    state.evolutionPreferenceError = userVisibleErrorMessage(error, '无法读取账户自进化状态。');
  } finally {
    state.evolutionPreferenceLoading = false;
    if (renderAfter) render();
  }
  return state.evolutionPreference;
}

async function checkPersonalEvolutionUpdates({ renderAfter = true } = {}) {
  if (!state.currentUser || state.evolutionUpdatesLoading) return state.evolutionUpdates;
  state.evolutionUpdatesLoading = true;
  state.evolutionUpdatesError = '';
  if (renderAfter) render();
  try {
    const updates = await window.janus.checkEvolutionUpdates();
    state.evolutionUpdates = updates;
    if (updates?.preference) state.evolutionPreference = updates.preference;
    const availableAgentIds = new Set((updates?.personal || []).map((item) => item.agentInstanceId).filter(Boolean));
    const expandedAgentIds = state.personalEvolutionExpandedAgentIds.filter((id) => availableAgentIds.has(id));
    state.personalEvolutionVersionsByAgent = {};
    for (const agentInstanceId of expandedAgentIds) {
      await loadPersonalEvolutionVersions(agentInstanceId, { renderAfter: false });
    }
    if (renderAfter) notify('云端个人版本检查完成。', 'success');
  } catch (error) {
    state.evolutionUpdatesError = userVisibleErrorMessage(error, '无法检查云端个人版本。');
    if (renderAfter) notify(state.evolutionUpdatesError, 'error');
  } finally {
    state.evolutionUpdatesLoading = false;
    if (renderAfter) render();
  }
  return state.evolutionUpdates;
}

async function togglePersonalVersionHistory(agentInstanceId = '') {
  if (!agentInstanceId) return;
  const expanded = state.personalEvolutionExpandedAgentIds.includes(agentInstanceId);
  state.personalEvolutionExpandedAgentIds = expanded
    ? state.personalEvolutionExpandedAgentIds.filter((id) => id !== agentInstanceId)
    : [...state.personalEvolutionExpandedAgentIds, agentInstanceId];
  render();
  if (!expanded && !state.personalEvolutionVersionsByAgent[agentInstanceId]) {
    await loadPersonalEvolutionVersions(agentInstanceId);
  }
}

async function loadPersonalEvolutionVersions(agentInstanceId = '', { renderAfter = true } = {}) {
  if (!agentInstanceId || state.personalEvolutionVersionLoadingId) return state.personalEvolutionVersionsByAgent[agentInstanceId] || null;
  state.personalEvolutionVersionLoadingId = agentInstanceId;
  if (renderAfter) render();
  try {
    const response = await window.janus.personalEvolutionVersions({ agentInstanceId });
    state.personalEvolutionVersionsByAgent = { ...state.personalEvolutionVersionsByAgent, [agentInstanceId]: response };
    return response;
  } catch (error) {
    notify(userVisibleErrorMessage(error, '无法读取个人 Skill 版本。'), 'error');
    return null;
  } finally {
    state.personalEvolutionVersionLoadingId = '';
    if (renderAfter) render();
  }
}

async function refreshEvolutionVersionState(agentInstanceId = '') {
  const [updates, versions, settings] = await Promise.all([
    window.janus.checkEvolutionUpdates(),
    window.janus.personalEvolutionVersions({ agentInstanceId }),
    window.janus.userAgentSettings(),
  ]);
  state.evolutionUpdates = updates;
  if (updates?.preference) state.evolutionPreference = updates.preference;
  state.personalEvolutionVersionsByAgent = { ...state.personalEvolutionVersionsByAgent, [agentInstanceId]: versions };
  if (Array.isArray(settings)) state.userAgentSettings = settings;
  if (state.employeeMarketDrawer?.agentInstanceId === agentInstanceId) {
    state.employeeMarketDrawer = { ...state.employeeMarketDrawer, personalVersions: versions, personalError: '' };
  }
  if (state.currentTab === 'personal-evolution') await refreshPersonalEvolutionState();
}

async function activatePersonalVersion(button) {
  const agentInstanceId = button?.dataset?.personalVersionActivate || '';
  const versionId = button?.dataset?.versionId || '';
  if (!agentInstanceId || !versionId || state.evolutionActionBusyKey) return;
  const busyKey = `activate:${agentInstanceId}:${versionId}`;
  state.evolutionActionBusyKey = busyKey;
  render();
  try {
    const result = await window.janus.activatePersonalEvolutionVersion({
      agentInstanceId,
      versionId,
      commandId: evolutionCommandId('personal_activate'),
      expectedActiveVersionId: button.dataset.expectedActiveVersionId || '',
    });
    await refreshEvolutionVersionState(agentInstanceId);
    if (result?.status === 'conflict' || result?.code === 'personal_version_conflict') {
      notify('云端当前版本已变化，已刷新版本列表，请重新选择。', 'warning');
    } else {
      notify('个人 Skill 版本已下载并启用。', 'success');
    }
  } catch (error) {
    const conflict = evolutionErrorCode(error) === 'personal_version_conflict';
    if (conflict) {
      try { await refreshEvolutionVersionState(agentInstanceId); } catch { /* retain the original conflict message */ }
      notify('云端当前版本已变化，已刷新版本列表，请重新选择。', 'warning');
    } else {
      notify(userVisibleErrorMessage(error, '无法启用个人 Skill 版本。'), 'error');
    }
  } finally {
    state.evolutionActionBusyKey = '';
    render();
  }
}

async function rollbackPersonalVersion(button) {
  const agentInstanceId = button?.dataset?.personalVersionRollback || '';
  const targetSkillVersionId = button?.dataset?.targetVersionId || '';
  if (!agentInstanceId || state.evolutionActionBusyKey) return;
  const targetKey = targetSkillVersionId || 'base';
  const busyKey = `rollback:${agentInstanceId}:${targetKey}`;
  state.evolutionActionBusyKey = busyKey;
  render();
  try {
    const result = await window.janus.rollbackPersonalSkill({
      agentInstanceId,
      targetSkillVersionId,
      commandId: evolutionCommandId('personal_rollback'),
      expectedActiveVersionId: button.dataset.expectedActiveVersionId || '',
    });
    await refreshEvolutionVersionState(agentInstanceId);
    if (result?.status === 'conflict' || result?.code === 'personal_version_conflict') {
      notify('云端当前版本已变化，已刷新版本列表，请重新选择。', 'warning');
    } else {
      notify(targetSkillVersionId ? '已回退到所选个人 Skill 版本。' : '已恢复基础 Skill。', 'success');
    }
  } catch (error) {
    const conflict = evolutionErrorCode(error) === 'personal_version_conflict';
    if (conflict) {
      try { await refreshEvolutionVersionState(agentInstanceId); } catch { /* retain the original conflict message */ }
      notify('云端当前版本已变化，已刷新版本列表，请重新选择。', 'warning');
    } else {
      notify(userVisibleErrorMessage(error, '无法回退个人 Skill 版本。'), 'error');
    }
  } finally {
    state.evolutionActionBusyKey = '';
    render();
  }
}

async function refreshPersonalEvolutionState(proposalId = '') {
  state.personalEvolutionStatus = await window.janus.personalEvolutionStatus();
  state.personalEvolutionProposals = await window.janus.listPersonalEvolutionProposals({ limit: 100 });
  state.personalEvolutionProposalDetail = proposalId
    ? await window.janus.getPersonalEvolutionProposal({ proposalId })
    : state.personalEvolutionProposalDetail;
}

function activeComposerMemoryAgentInstanceId() {
  const roster = state.employeeOverview?.roster || [];
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  const sessionAgentInstanceId = session?.agentInstanceId || session?.agent_instance_id || '';
  if (sessionAgentInstanceId && state.selectionSource !== 'employee') return sessionAgentInstanceId;
  const explicitlySelected = state.currentAgentInstanceId
    ? roster.find((item) => item.id === state.currentAgentInstanceId)
    : null;
  const explicitlySelectedFamilyId = explicitlySelected?.agentFamilyId || explicitlySelected?.agent_family_id || '';
  if (explicitlySelected && explicitlySelectedFamilyId === state.currentAgentId) {
    return explicitlySelected.id;
  }
  if (sessionAgentInstanceId) return sessionAgentInstanceId;
  if (isUBuddyComposerMode()) return roster.find((item) => item.agentFamilyId === 'secretary_agent')?.id || '';
  return '';
}

async function openComposerMemoryMenu() {
  const agentInstanceId = activeComposerMemoryAgentInstanceId();
  if (!agentInstanceId) {
    notify('当前会话还没有可用的 Agent Memory。', 'warning');
    return;
  }
  state.composerMemoryMenuOpen = true;
  state.composerMemoryBusy = true;
  state.composerMemoryAgentInstanceId = agentInstanceId;
  state.workspaceMenuOpen = false;
  state.workspaceCreateMenuOpen = false;
  state.sandboxMenuOpen = false;
  state.composerToolMenuOpen = false;
  state.modelMenuOpen = false;
  render();
  scheduleComposerMetaMenuPlacement();
  try {
    await loadComposerMemoryState(agentInstanceId);
  } catch (error) {
    state.composerMemoryMenuOpen = false;
    notify(userVisibleErrorMessage(error, '无法读取当前 Memory。'), 'error');
  } finally {
    state.composerMemoryBusy = false;
    render();
    if (state.composerMemoryMenuOpen) scheduleComposerMetaMenuPlacement();
  }
}

async function loadComposerMemoryState(agentInstanceId = activeComposerMemoryAgentInstanceId()) {
  if (!agentInstanceId) return;
  const [documents, contexts] = await Promise.all([
    window.janus.employeeMemoryDocuments({ agentInstanceId }),
    window.janus.employeeContextSpaces({ agentInstanceId }),
  ]);
  state.composerMemoryAgentInstanceId = agentInstanceId;
  state.composerMemoryDocuments = documents || [];
  state.composerMemoryContext = contexts?.current
    ? { ...contexts.current, stateRevision: contexts?.account?.stateRevision }
    : null;
}

function memoryContextSwitchExpectation(contexts = null) {
  const current = contexts?.current || contexts || null;
  const account = contexts?.account || contexts || null;
  return {
    expectedStateRevision: account?.stateRevision,
    expectedActiveContextSpaceId: current?.activeContextSpaceId,
    expectedActiveMemoryDocumentId: current?.activeMemoryDocumentId,
  };
}

async function saveAndClearComposerContext() {
  const agentInstanceId = activeComposerMemoryAgentInstanceId();
  if (!agentInstanceId || !state.currentSessionId || state.composerMemoryBusy || currentChatRun()) return;
  if (!window.confirm('将当前聊天上下文保存到正在使用的 memory.md，然后创建下一空白 Memory。聊天历史仍会保留，确认继续吗？')) return;
  state.composerMemoryBusy = true;
  render();
  try {
    const result = await window.janus.clearEmployeeMemory({
      agentInstanceId,
      sessionId: state.currentSessionId,
      saveCurrentContext: true,
    });
    verifyMemoryApplication(result, { memoryDocumentId: result?.current?.id || '' });
    await refreshComposerAfterMemoryChange(agentInstanceId);
    notify('当前上下文已保存，已切换到新的空白 Memory。', 'success');
  } catch (error) {
    notify(userVisibleErrorMessage(error, '无法保存并清空当前上下文。'), 'error');
  } finally {
    state.composerMemoryBusy = false;
    state.composerMemoryMenuOpen = false;
    render();
  }
}

async function createComposerMemory() {
  const agentInstanceId = activeComposerMemoryAgentInstanceId();
  if (!agentInstanceId || state.composerMemoryBusy || currentChatRun()) return;
  const suggested = `新对话 ${(state.composerMemoryDocuments || []).filter((item) => item.scope === 'general').length + 1}`;
  openMemoryNameDialog({ agentInstanceId, source: 'composer', suggested });
}

function openMemoryNameDialog({ agentInstanceId = '', source = 'employee', mode = 'create', memoryDocumentId = '', suggested = '' } = {}) {
  if (!agentInstanceId) return;
  state.composerMemoryMenuOpen = false;
  state.memoryNameDialog = {
    agentInstanceId,
    source: source === 'composer' ? 'composer' : 'employee',
    mode: mode === 'rename' ? 'rename' : 'create',
    memoryDocumentId: String(memoryDocumentId || ''),
    draft: String(suggested || '').slice(0, 60),
    busy: false,
    error: '',
  };
  render();
  setTimeout(() => {
    const input = document.getElementById('memory-name-input');
    input?.focus();
    input?.select();
  }, 0);
}

function closeMemoryNameDialog() {
  if (state.memoryNameDialog?.busy) return;
  state.memoryNameDialog = null;
  render();
}

async function submitMemoryNameDialog(event) {
  event.preventDefault();
  const dialog = state.memoryNameDialog;
  if (!dialog || dialog.busy) return;
  const displayName = String(new FormData(event.currentTarget).get('displayName') || dialog.draft || '').trim();
  if (!displayName || displayName.length > 60) {
    state.memoryNameDialog = { ...dialog, error: '请输入 1–60 个字符的 Memory 名称。' };
    render();
    setTimeout(() => document.getElementById('memory-name-input')?.focus(), 0);
    return;
  }
  state.memoryNameDialog = { ...dialog, draft: displayName, busy: true, error: '' };
  const renaming = dialog.mode === 'rename';
  if (dialog.source === 'composer') state.composerMemoryBusy = true;
  render();
  try {
    if (renaming) {
      await window.janus.renameEmployeeMemory({
        agentInstanceId: dialog.agentInstanceId,
        memoryDocumentId: dialog.memoryDocumentId,
        displayName,
      });
      if (dialog.source === 'composer') {
        await refreshComposerAfterMemoryChange(dialog.agentInstanceId);
      } else {
        await refreshEmployeeOverview();
        await openEmployeeMemory(dialog.agentInstanceId);
      }
      notify('Memory 已重命名；消息、文件和上下文身份保持不变。', 'success');
    } else {
      const result = await window.janus.createEmployeeMemory({ agentInstanceId: dialog.agentInstanceId, displayName });
      verifyMemoryApplication(result, { memoryDocumentId: result?.document?.id || '' });
      if (dialog.source === 'composer') {
        await refreshComposerAfterMemoryChange(dialog.agentInstanceId);
        notify('已创建并切换到新的空白 Memory。', 'success');
      } else {
        await refreshEmployeeOverview();
        await openEmployeeMemory(dialog.agentInstanceId);
        notify('已创建并应用新的 general Memory，模型线程已重置。', 'success');
      }
    }
    state.memoryNameDialog = null;
  } catch (error) {
    const message = userVisibleErrorMessage(error, renaming ? '无法重命名 Memory。' : '无法创建 Memory。');
    state.memoryNameDialog = { ...dialog, draft: displayName, busy: false, error: message };
    notify(message, 'error');
  } finally {
    state.composerMemoryBusy = false;
    state.composerMemoryMenuOpen = false;
    render();
  }
}

async function switchComposerMemory(memoryDocumentId = '') {
  const agentInstanceId = activeComposerMemoryAgentInstanceId();
  if (!agentInstanceId || !memoryDocumentId || state.composerMemoryBusy || currentChatRun()) return;
  state.composerMemoryBusy = true;
  render();
  try {
    const result = await window.janus.switchEmployeeMemory({ agentInstanceId, memoryDocumentId,
      ...memoryContextSwitchExpectation(state.composerMemoryContext) });
    verifyMemoryApplication(result, { memoryDocumentId });
    await refreshComposerAfterMemoryChange(agentInstanceId);
    notify('Memory 已切换，对应聊天上下文已恢复。', 'success');
  } catch (error) {
    if (error?.code === 'memory_context_state_conflict') await loadComposerMemoryState(agentInstanceId).catch(() => null);
    notify(userVisibleErrorMessage(error, '无法切换 Memory。'), 'error');
  } finally {
    state.composerMemoryBusy = false;
    state.composerMemoryMenuOpen = false;
    render();
  }
}

async function restoreAndSwitchComposerMemory(memoryDocumentId = '') {
  const agentInstanceId = activeComposerMemoryAgentInstanceId();
  if (!agentInstanceId || !memoryDocumentId || state.composerMemoryBusy || currentChatRun()) return;
  state.composerMemoryBusy = true;
  render();
  try {
    const result = await window.janus.restoreAndSwitchEmployeeMemory({
      agentInstanceId,
      memoryDocumentId,
      ...memoryContextSwitchExpectation(state.composerMemoryContext),
    });
    verifyMemoryApplication(result, { memoryDocumentId });
    await refreshComposerAfterMemoryChange(agentInstanceId);
    notify('历史 Memory 已恢复，对应聊天上下文已切换。', 'success');
  } catch (error) {
    if (error?.code === 'memory_context_state_conflict') await loadComposerMemoryState(agentInstanceId).catch(() => null);
    notify(userVisibleErrorMessage(error, '无法恢复并切换 Memory。'), 'error');
  } finally {
    state.composerMemoryBusy = false;
    state.composerMemoryMenuOpen = false;
    render();
  }
}

function verifyMemoryApplication(result = null, { memoryDocumentId = '', contextSpaceId = '' } = {}) {
  const activeMemoryDocumentId = result?.activeMemoryDocumentId || result?.context?.activeMemoryDocumentId || result?.state?.activeMemoryDocumentId || '';
  const activeContextSpaceId = result?.activeContextSpaceId || result?.context?.activeContextSpaceId || result?.state?.activeContextSpaceId || '';
  const manifestHash = result?.memoryManifestHash || '';
  const applied = result?.applicationState === 'applied' && Boolean(activeContextSpaceId && manifestHash);
  if (!applied || (memoryDocumentId && activeMemoryDocumentId !== memoryDocumentId)
    || (contextSpaceId && activeContextSpaceId !== contextSpaceId)) {
    const error = new Error('Memory 已选择，但运行上下文尚未确认应用。请刷新后重试。');
    error.code = 'memory_runtime_context_not_applied';
    throw error;
  }
  return result;
}

async function refreshComposerAfterMemoryChange(agentInstanceId) {
  const [overview] = await Promise.all([
    window.janus.employeeOverview(),
    loadComposerMemoryState(agentInstanceId),
  ]);
  state.employeeOverview = overview || state.employeeOverview;
  if (state.currentSessionId) {
    const sessionId = state.currentSessionId;
    const [page, contextUsage] = await Promise.all([
      loadLatestRendererMessagePage(sessionId),
      window.janus.chatContextStatus({ sessionId }).catch(() => null),
    ]);
    if (applyLatestRendererMessagePage(sessionId, page)) {
      state.contextUsage = contextUsage;
      syncCurrentChatRun();
      restoreActiveRunTransient();
    }
  }
}

async function refreshEmployeeOverview(options = undefined) {
  if (!state.currentUser) return null;
  const localOnly = options?.refreshCloud === false;
  if (employeeOverviewRefreshPromise) {
    const activeRefresh = employeeOverviewRefreshPromise;
    if (!localOnly && employeeOverviewRefreshMode === 'local') {
      await activeRefresh.catch(() => null);
      return refreshEmployeeOverview(options);
    }
    return activeRefresh;
  }
  const refreshSequence = ++employeeOverviewRefreshSequence;
  employeeOverviewRefreshMode = localOnly ? 'local' : 'cloud';
  state.employeeRefreshBusy = true;
  if (employeeSurfaceVisible()) render();
  let refreshPromise;
  refreshPromise = Promise.resolve().then(async () => {
    try {
      const overview = await window.janus.employeeOverview(options);
      if (refreshSequence !== employeeOverviewRefreshSequence) return state.employeeOverview;
      state.employeeOverview = overview;
      applyEmployeeWorkStatusSnapshot(state, overview?.roster || []);
      state.employeeOverviewError = '';
      state.employeeLastRefreshAt = new Date().toISOString();
      return state.employeeOverview;
    } catch (error) {
      state.employeeOverviewError = userVisibleErrorMessage(error, '无法刷新员工状态。');
      notify(state.employeeOverviewError, 'error');
      return null;
    } finally {
      if (employeeOverviewRefreshPromise === refreshPromise) {
        employeeOverviewRefreshPromise = null;
        employeeOverviewRefreshMode = '';
      }
      state.employeeRefreshBusy = false;
      if (employeeSurfaceVisible()) render();
    }
  });
  employeeOverviewRefreshPromise = refreshPromise;
  return refreshPromise;
}

async function refreshEmployeeConversationState({ renderAfter = true, reason = 'employee_identity_refresh' } = {}) {
  if (!state.currentUser) return null;
  if (employeeOverviewRefreshPromise) await employeeOverviewRefreshPromise.catch(() => null);
  const refreshSequence = ++employeeOverviewRefreshSequence;
  const userId = String(state.currentUser.id || '');
  const workspaceId = String(state.activeAccountWorkspace?.id || 'workspace_personal');
  const workspaceGeneration = state.workspaceSwitchGeneration;
  try {
    const [overview, sessions] = await Promise.all([
      window.janus.employeeOverview({ refreshCloud: false }),
      window.janus.listSessions(),
    ]);
    const stillCurrent = refreshSequence === employeeOverviewRefreshSequence
      && String(state.currentUser?.id || '') === userId
      && String(state.activeAccountWorkspace?.id || 'workspace_personal') === workspaceId
      && state.workspaceSwitchGeneration === workspaceGeneration;
    if (!stillCurrent) return null;
    const refreshedSessions = Array.isArray(sessions) ? sessions : [];
    const refreshedSessionIds = new Set(refreshedSessions.map((session) => session.id).filter(Boolean));
    const pendingSessions = (state.sessions || []).filter((session) => session.pending && !refreshedSessionIds.has(session.id));
    state.employeeOverview = overview || state.employeeOverview;
    applyEmployeeWorkStatusSnapshot(state, state.employeeOverview?.roster || []);
    state.sessions = [...pendingSessions, ...refreshedSessions];
    state.employeeOverviewError = '';
    state.employeeLastRefreshAt = new Date().toISOString();
    const employeeIds = new Set((state.employeeOverview?.roster || []).map((employee) => employee.id).filter(Boolean));
    state.employeeConversationOverviewByInstanceId = Object.fromEntries(
      Object.entries(state.employeeConversationOverviewByInstanceId || {})
        .filter(([agentInstanceId]) => employeeIds.has(agentInstanceId)),
    );
    const currentSession = (state.sessions || []).find((session) => session.id === state.currentSessionId) || null;
    if (currentSession) {
      state.currentAgentInstanceId = currentSession.agentInstanceId || currentSession.agent_instance_id || '';
    } else if (state.currentAgentInstanceId && !employeeIds.has(state.currentAgentInstanceId)) {
      state.currentAgentInstanceId = '';
      if (state.selectionSource === 'employee') state.selectionSource = null;
    }
    if (renderAfter) render();
    return { overview: state.employeeOverview, sessions: state.sessions };
  } catch (error) {
    appendStatus(`Employee identity refresh failed (${reason}): ${error.message || error}`);
    reportRendererEvent('warn', 'employee-identity-refresh-failed', error, { reason });
    return null;
  }
}

function employeeSurfaceVisible() {
  return state.currentTab === 'employees'
    || (state.currentTab === 'chat' && state.networkPanelOpen && state.networkPanelView === 'friends');
}

function patchAgentWorkStatusElements(agentInstanceIds = []) {
  const ids = new Set((Array.isArray(agentInstanceIds) ? agentInstanceIds : []).map(String).filter(Boolean));
  if (!ids.size || !document.createElement) return;
  const roster = state.employeeOverview?.roster || [];
  document.querySelectorAll('[data-agent-work-status]').forEach((element) => {
    const agentInstanceId = String(element.dataset.agentWorkStatus || '');
    if (!ids.has(agentInstanceId)) return;
    const employee = roster.find((item) => item.id === agentInstanceId) || {};
    const status = agentWorkStatusFor(state, employee);
    const compact = element.classList.contains('is-compact');
    const lifecycleLabel = element.querySelector('.agent-work-status-main b')?.textContent || '';
    const replacement = markupElement(renderAgentWorkStatus(status, { compact, lifecycleLabel }));
    if (replacement) element.replaceWith(replacement);
  });
}

function patchMessageAgentStatusRows(agentInstanceIds = []) {
  const ids = new Set((Array.isArray(agentInstanceIds) ? agentInstanceIds : []).map(String).filter(Boolean));
  if (!ids.size || !document.createElement) return;
  const roster = state.employeeOverview?.roster || [];
  document.querySelectorAll('[data-agent-instance-row]').forEach((row) => {
    const agentInstanceId = String(row.dataset.agentInstanceRow || '');
    if (!ids.has(agentInstanceId)) return;
    const employee = roster.find((item) => item.id === agentInstanceId) || {};
    const status = agentWorkStatusFor(state, employee);
    const stateLabel = status.availability === 'working'
      ? ({ reserved: '已预留', queued: '排队中', running: '执行中', blocked: '受阻' })[status.workState] || '工作中'
      : '空闲';
    const displayState = translateUiText(stateLabel, state.languageMode);
    const detail = status.availability === 'working' ? String(status.currentWork || '').trim() : '';
    const tone = status.workState === 'blocked' ? 'warning' : status.availability === 'working' ? 'busy' : 'online';
    const indicator = row.querySelector('.im-agent-state');
    if (indicator) {
      indicator.className = `im-agent-state is-${tone}`;
      indicator.title = detail ? `${displayState} · ${detail}` : displayState;
    }
    const preview = row.querySelector('.network-message-preview');
    if (!preview) return;
    const previewLabel = String(row.dataset.agentPreviewLabel || '').trim()
      || translateUiText(row.dataset.agentPreviewTitle || '点击进入会话', state.languageMode);
    const previewTail = [detail, previewLabel].filter(Boolean);
    const stateElement = document.createElement('span');
    stateElement.dataset.agentPreviewState = '';
    stateElement.dataset.noLocalize = '';
    stateElement.textContent = displayState;
    preview.replaceChildren(stateElement);
    if (previewTail.length) {
      preview.append(document.createTextNode(' · '));
      const tailElement = document.createElement('span');
      tailElement.dataset.agentPreviewTail = '';
      tailElement.dataset.noLocalize = '';
      tailElement.textContent = clipInline(previewTail.join(' · '), 76);
      preview.append(tailElement);
    }
  });
}

function patchUBuddyCoordinationPanels(taskRunId = '', task = null) {
  if (!taskRunId || !document.createElement) return;
  const coordination = coordinationForTask(state, taskRunId, task);
  if (!coordination) return;
  const nodes = Array.isArray(task?.nodes) ? task.nodes : [];
  const blockedNode = nodes.find((node) => ['waiting', 'retry_wait', 'blocked', 'failed'].includes(String(node.status || '')));
  const blocker = blockedNode ? {
    summary: blockedNode.waitReason || blockedNode.errorText || `${blockedNode.title || '任务节点'}暂时无法继续。`,
    errorCode: blockedNode.lastErrorCode || '',
    attemptCount: Number(blockedNode.attemptCount || 0),
    maxAttempts: Number(blockedNode.maxAttempts || 0),
    nextRetryAt: blockedNode.nextRetryAt || '',
    attemptedActions: blockedNode.recoveryActions || [],
    suggestedNextStep: blockedNode.status === 'retry_wait' ? '系统将在稍后自动重试。' : '查看任务详情并处理阻塞。',
  } : null;
  const markup = renderUBuddyCoordinationPanels({ state, taskRunId, coordination, task, nodes, blocker });
  const template = document.createElement('template');
  template.innerHTML = markup;
  const desired = [...template.content.children];
  document.querySelectorAll('[data-task-progress-run]').forEach((wrapper) => {
    if (String(wrapper.dataset.taskProgressRun || '') !== taskRunId) return;
    const body = wrapper.querySelector('.collaboration-run-body');
    if (!body) return;
    body.querySelectorAll('[data-ubuddy-allocation-card], [data-ubuddy-task-progress-card]').forEach((item) => item.remove());
    for (const item of [...desired].reverse()) body.prepend(item.cloneNode(true));
    localizeDom(body, state.languageMode);
  });
}

function markupElement(markup = '') {
  const template = document.createElement('template');
  template.innerHTML = markup;
  return template.content.firstElementChild || null;
}

async function refreshClusterEvolutionOverview() {
  if (state.clusterEvolutionRefreshBusy) return state.clusterEvolutionOverview;
  state.clusterEvolutionRefreshBusy = true;
  if (state.currentTab === 'employees') render();
  try {
    const [overview, status] = await Promise.all([
      window.janus.clusterEvolutionOverview(),
      window.janus.stage8EvolutionStatus(),
    ]);
    state.clusterEvolutionOverview = overview || { cohorts: [], runs: [], candidates: [] };
    state.stage8EvolutionStatus = status || state.stage8EvolutionStatus;
    return state.clusterEvolutionOverview;
  } catch (error) {
    notify(userVisibleErrorMessage(error, '无法刷新公司集群进化状态。'), 'error');
    return null;
  } finally {
    state.clusterEvolutionRefreshBusy = false;
    if (state.currentTab === 'employees') render();
  }
}

async function runEmployeeCommand(action, payload = {}) {
  if (state.employeeBusyCommandId) return null;
  const commandId = globalThis.crypto?.randomUUID?.() || `employee-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.employeeBusyCommandId = commandId;
  state.employeeBusyAction = action;
  state.employeeBusyTargetId = payload.agentInstanceId || payload.agentFamilyId || '';
  render();
  try {
    const method = action === 'recruit' ? 'recruitEmployee' : action === 'deactivate' ? 'deactivateEmployee' : 'reactivateEmployee';
    const result = await window.janus[method]({ ...payload, commandId });
    state.employeeOverview = result.overview || await window.janus.employeeOverview();
    if (result.status === 'pending_cloud_confirmation') {
      trackEmployeeCommandSettlement({
        commandId,
        agentInstanceId: result.instance?.id || payload.agentInstanceId || '',
        agentFamilyId: result.instance?.agentFamilyId || payload.agentFamilyId || '',
      });
    }
    state.employeeConflict = null;
    if (result.status === 'rejected') {
      notify(userVisibleErrorMessage(Object.assign(new Error(result.code || 'employee_command_rejected'), {
        code: result.code || 'employee_command_rejected', details: result.event || {},
      }), '云端拒绝了本次员工操作，请刷新人才市场后重试。'), 'error');
      return result;
    }
    notify(action === 'recruit'
      ? result.status === 'pending_cloud_confirmation'
        ? '人才已招募，可立即在本机使用；云端状态正在后台同步。'
        : '人才已招募。'
      : action === 'deactivate'
        ? '人才已停用，历史记录继续保留。'
        : result.status === 'pending_cloud_confirmation'
          ? '人才已在本机重新启用；云端状态正在后台同步。'
          : '人才已重新启用。', 'success');
    return result;
  } catch (error) {
    if (error?.code === 'employee_state_conflict') {
      state.employeeConflict = { action, payload, code: error.code, details: error.details || {} };
      await refreshEmployeeOverview();
    }
    notify(userVisibleErrorMessage(error, '员工操作失败。'), 'error');
    return null;
  } finally {
    state.employeeBusyCommandId = '';
    state.employeeBusyAction = '';
    state.employeeBusyTargetId = '';
    render();
  }
}

async function deactivateEmployeeWithConfirmation({
  agentInstanceId = '', expectedStateRevision = 0, hasRunningWork = false,
} = {}) {
  if (!agentInstanceId) return null;
  const runningWorkNote = hasRunningWork ? '当前正在运行的工作不会被强制中止，但所有排队任务会立即取消。\n\n' : '';
  if (!window.confirm(`确认停用这名员工？\n\n${runningWorkNote}停用后会立即释放员工配额，并保留历史会话、Memory、Skill 与成长记录。之后可在消息页或人才市场重新启用。`)) return null;
  const result = await runEmployeeCommand('deactivate', { agentInstanceId, expectedStateRevision });
  if (!result || result.status === 'rejected') return result;
  state.employeeContextMenu = null;
  state.employeeSelectedInstanceId = '';
  state.employeeDetailTab = 'overview';
  state.employeeMemoryDrawer = null;
  state.employeeGrowthDrawer = null;
  state.employeeMarketDrawer = null;
  state.currentTab = 'chat';
  state.networkPanelOpen = true;
  state.networkPanelView = 'messages';
  state.networkMessageHomeOpen = true;
  state.messageActivePane = 'list';
  render();
  return result;
}

function trackEmployeeCommandSettlement({ commandId = '', agentInstanceId = '', agentFamilyId = '' } = {}) {
  const trackerKey = agentInstanceId || (agentFamilyId ? `family:${agentFamilyId}` : '');
  if (!trackerKey) return;
  stopEmployeeCommandSettlementTracking(trackerKey);
  const tracker = {
    commandId,
    agentInstanceId,
    agentFamilyId,
    startedAt: Date.now(),
    timer: null,
    snapshot: employeeLifecycleRenderSnapshot(findTrackedEmployee(state.employeeOverview, { agentInstanceId, agentFamilyId })),
  };
  employeeCommandSettlementTrackers.set(trackerKey, tracker);
  const poll = async () => {
    if (employeeCommandSettlementTrackers.get(trackerKey) !== tracker) return;
    if (Date.now() - tracker.startedAt > 45_000) {
      stopEmployeeCommandSettlementTracking(trackerKey, tracker);
      return;
    }
    try {
      const overview = await window.janus.employeeOverview({ refreshCloud: false });
      if (employeeCommandSettlementTrackers.get(trackerKey) !== tracker) return;
      state.employeeOverview = overview || state.employeeOverview;
      const employee = findTrackedEmployee(state.employeeOverview, tracker);
      const snapshot = employeeLifecycleRenderSnapshot(employee);
      const changed = snapshot !== tracker.snapshot;
      tracker.snapshot = snapshot;
      if (changed && employeeSurfaceVisible()) render();
      const lifecycleSyncPending = employee?.authorityState === 'pending'
        || employee?.employmentState === 'pending_cloud_confirmation';
      if (employee && !lifecycleSyncPending) {
        stopEmployeeCommandSettlementTracking(trackerKey, tracker);
        return;
      }
    } catch {
      // The durable outbox remains authoritative; a later refresh can recover.
    }
    if (employeeCommandSettlementTrackers.get(trackerKey) === tracker) {
      tracker.timer = setTimeout(poll, 500);
    }
  };
  tracker.timer = setTimeout(poll, 500);
}

function findTrackedEmployee(overview = null, { agentInstanceId = '', agentFamilyId = '' } = {}) {
  return (overview?.roster || []).find((item) => (
    (agentInstanceId && item.id === agentInstanceId)
    || (agentFamilyId && item.agentFamilyId === agentFamilyId)
  )) || null;
}

function employeeLifecycleRenderSnapshot(employee = null) {
  if (!employee) return 'missing';
  return JSON.stringify({
    id: employee.id || '',
    employmentState: employee.employmentState || '',
    authorityState: employee.authorityState || '',
    pendingTargetState: employee.pendingTargetState || '',
    routeEligible: employee.routeEligible !== false,
    stateRevision: Number(employee.stateRevision || 0),
    syncStatus: employee.lifecycleSync?.status || '',
    syncTargetState: employee.lifecycleSync?.targetState || '',
    syncAttemptCount: Number(employee.lifecycleSync?.attemptCount || 0),
    syncLastError: employee.lifecycleSync?.lastError || '',
  });
}

function stopEmployeeCommandSettlementTracking(trackerKey = '', expectedTracker = null) {
  const tracker = employeeCommandSettlementTrackers.get(trackerKey);
  if (!tracker || (expectedTracker && tracker !== expectedTracker)) return;
  if (tracker.timer) clearTimeout(tracker.timer);
  employeeCommandSettlementTrackers.delete(trackerKey);
}

function clearEmployeeCommandSettlementTracking() {
  for (const trackerKey of employeeCommandSettlementTrackers.keys()) {
    stopEmployeeCommandSettlementTracking(trackerKey);
  }
}

function wireEmployeeCardActivation(card, action) {
  card.addEventListener('click', (event) => {
    if (event.target.closest('button, a, input, select, textarea, summary, details')) return;
    action();
  });
  card.addEventListener('keydown', (event) => {
    if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    action();
  });
}

async function recruitEmployeeFromMarket(agentFamilyId = '') {
  if (!agentFamilyId) return;
  state.employeeMarketActionErrors = { ...(state.employeeMarketActionErrors || {}), [agentFamilyId]: '' };
  const result = await runEmployeeCommand('recruit', { agentFamilyId });
  if (!result || result.status === 'rejected') {
    state.employeeMarketActionErrors = { ...(state.employeeMarketActionErrors || {}), [agentFamilyId]: '招募失败，请重试。' };
    render();
    return;
  }
  const nextErrors = { ...(state.employeeMarketActionErrors || {}) };
  delete nextErrors[agentFamilyId];
  state.employeeMarketActionErrors = nextErrors;
  state.employeeMarketCandidateId = '';
  render();
}

async function reactivateEmployeeFromMarket(agentInstanceId = '', expectedStateRevision = 0) {
  if (!agentInstanceId) return;
  state.employeeMarketActionErrors = { ...(state.employeeMarketActionErrors || {}), [agentInstanceId]: '' };
  const result = await runEmployeeCommand('reactivate', { agentInstanceId, expectedStateRevision });
  if (!result || result.status === 'rejected') {
    state.employeeMarketActionErrors = { ...(state.employeeMarketActionErrors || {}), [agentInstanceId]: '重新启用失败，请重试。' };
    render();
    return;
  }
  const nextErrors = { ...(state.employeeMarketActionErrors || {}) };
  delete nextErrors[agentInstanceId];
  state.employeeMarketActionErrors = nextErrors;
  state.employeeMarketCandidateId = '';
  render();
}

async function reactivateEmployeeAndOpenChat(agentInstanceId = '', expectedStateRevision = 0) {
  if (!agentInstanceId) return;
  const result = await runEmployeeCommand('reactivate', { agentInstanceId, expectedStateRevision });
  if (!result) return;
  const reactivated = (result?.overview?.roster || state.employeeOverview?.roster || [])
    .find((item) => item.id === agentInstanceId);
  if (reactivated?.routeEligible) await openEmployeeChatAfterCommand(reactivated.id, '人才已重新启用，但暂时无法打开员工聊天。');
}

async function openEmployeeChatAfterCommand(agentInstanceId = '', fallbackMessage = '') {
  try {
    await openEmployeeChat(agentInstanceId);
  } catch (error) {
    notify(userVisibleErrorMessage(error, fallbackMessage || '员工状态已更新，但暂时无法打开聊天。'), 'error');
  }
}

function openEmployeeDetail(agentInstanceId = '') {
  if (!agentInstanceId) return;
  state.employeeSelectedInstanceId = agentInstanceId;
  state.employeeDetailTab = 'overview';
  state.employeeMemoryDrawer = null;
  state.employeeGrowthDrawer = null;
  state.employeeMarketDrawer = null;
  render();
}

function openEmployeeProfileEditor(agentInstanceId = '') {
  if (!agentInstanceId) return;
  openEmployeeDetail(agentInstanceId);
  const form = [...document.querySelectorAll('[data-employee-profile-form]')]
    .find((item) => item.dataset.employeeProfileForm === agentInstanceId);
  const editor = form?.closest('.employee-profile-editor');
  if (!editor) return;
  editor.open = true;
  editor.scrollIntoView({ block: 'center' });
  const input = editor.querySelector('input[name="displayName"]');
  input?.focus({ preventScroll: true });
  input?.select();
}

function closeEmployeeDetail() {
  state.employeeSelectedInstanceId = '';
  state.employeeDetailTab = 'overview';
  state.employeeMemoryDrawer = null;
  state.employeeGrowthDrawer = null;
  state.employeeMarketDrawer = null;
  render();
}

async function openEmployeeGrowth(agentInstanceId = '') {
  if (!agentInstanceId) return;
  state.employeeSelectedInstanceId = agentInstanceId;
  state.employeeDetailTab = 'growth';
  state.employeeMemoryDrawer = null;
  state.employeeMarketDrawer = null;
  state.employeeGrowthDrawer = { agentInstanceId, history: [], loading: true, error: '' };
  render();
  try {
    const result = await window.janus.employeeLeadershipHistory({ agentInstanceId, limit: 30 });
    state.employeeGrowthDrawer = { agentInstanceId, history: result?.items || [], loading: false, error: '' };
  } catch (error) {
    state.employeeGrowthDrawer = { agentInstanceId, history: [], loading: false,
      error: userVisibleErrorMessage(error, '无法读取 Leadership 评估历史。') };
  }
  render();
}

async function submitLeadershipDecisionDialog(event) {
  event.preventDefault();
  const dialog = state.leadershipDecisionDialog;
  if (!dialog || dialog.busy) return;
  const reason = String(new FormData(event.currentTarget).get('reason') || '').trim();
  if (!reason) return;
  state.leadershipDecisionDialog = { ...dialog, busy: true, error: '' };
  render();
  try {
    if (dialog.kind === 'owner_appeal') {
      await window.janus.submitEmployeeLeadershipAppeal({
        agentInstanceId: dialog.agentInstanceId, appealKind: dialog.appealKind || 'assessment', reason,
        commandId: `lead_appeal_${crypto.randomUUID()}`,
      });
    } else if (dialog.kind === 'governance_action') {
      await window.janus.decideLeadershipGovernanceAction({
        actionId: dialog.actionId, decision: dialog.decision, reason,
        expectedStateRevision: Number(dialog.expectedStateRevision || 0), commandId: `lead_governance_${crypto.randomUUID()}`,
      });
    } else if (dialog.kind === 'governance_appeal') {
      await window.janus.decideLeadershipGovernanceAppeal({ appealId: dialog.appealId, decision: dialog.decision, reason });
    }
    state.leadershipDecisionDialog = null;
    await refreshEmployeeOverview();
    if (state.employeeGrowthDrawer?.agentInstanceId) await openEmployeeGrowth(state.employeeGrowthDrawer.agentInstanceId);
    notify(dialog.kind === 'owner_appeal' ? 'Leadership 申诉已提交。' : 'Leadership 治理决定已保存。', 'success');
  } catch (error) {
    state.leadershipDecisionDialog = { ...dialog, busy: false, error: userVisibleErrorMessage(error, '无法提交 Leadership 治理操作。') };
    render();
  }
}

async function openEmployeeMemory(agentInstanceId = '') {
  state.employeeContextMenu = null;
  state.employeeSelectedInstanceId = agentInstanceId;
  state.employeeDetailTab = 'memory';
  state.employeeGrowthDrawer = null;
  state.employeeMarketDrawer = null;
  state.employeeMemoryDrawer = { agentInstanceId, documents: [], contexts: null, details: null, loading: true, error: '' };
  render();
  try {
    const [documents, contexts] = await Promise.all([
      window.janus.employeeMemoryDocuments({ agentInstanceId }),
      window.janus.employeeContextSpaces({ agentInstanceId }),
    ]);
    const employee = (state.employeeOverview?.roster || []).find((item) => item.id === agentInstanceId);
    const selected = documents.find((item) => item.id === employee?.currentMemory?.id)
      || documents.find((item) => item.scope === 'general' && item.lifecycleState === 'active')
      || documents[0]
      || null;
    const details = selected
      ? await window.janus.employeeMemoryDetails({ agentInstanceId, memoryDocumentId: selected.id })
      : null;
    state.employeeMemoryDrawer = { agentInstanceId, documents, contexts, selectedDocumentId: selected?.id || '', details, loading: false, error: '' };
    render();
  } catch (error) {
    const message = userVisibleErrorMessage(error, '无法读取员工 Memory。');
    state.employeeMemoryDrawer = { ...(state.employeeMemoryDrawer || {}), agentInstanceId, loading: false, error: message };
    render();
    notify(message, 'error');
  }
}

async function referenceArchivedMemoryInComposer({ agentInstanceId = '', memoryDocumentId = '', createBranch = false } = {}) {
  if (!agentInstanceId || !memoryDocumentId) return;
  try {
    let details = state.employeeMemoryDrawer?.details?.document?.id === memoryDocumentId
      ? state.employeeMemoryDrawer.details
      : await window.janus.employeeMemoryDetails({ agentInstanceId, memoryDocumentId });
    if (!details?.document || details.document.lifecycleState !== 'archived') {
      notify('只能引用已归档 Memory。', 'warning');
      return;
    }
    if (createBranch) {
      const result = await window.janus.createEmployeeMemory({
        agentInstanceId,
        displayName: `${details.document.displayName || '历史 Memory'} · 后续讨论`,
      });
      verifyMemoryApplication(result, { memoryDocumentId: result?.document?.id || '' });
      await refreshEmployeeOverview();
    }
    await openEmployeeChat(agentInstanceId);
    const reference = {
      referenceId: globalThis.crypto?.randomUUID?.() || `memory_reference_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      sourceMemoryId: details.document.id,
      sourceContextSpaceId: details.document.contextSpaceId || '',
      sourceContentHash: details.document.contentHash || '',
      displayName: details.document.displayName || '已归档 Memory',
      summary: details.document.summary || '',
      source: 'picker',
      readOnly: true,
    };
    state.composerMemoryReferences = [
      ...(state.composerMemoryReferences || []).filter((item) => item.sourceMemoryId !== memoryDocumentId),
      reference,
    ];
    state.employeeMemoryDrawer = null;
    render();
    focusChatInputAtEnd();
    notify(createBranch ? '已创建新的 Memory，并添加只读历史引用。' : '已把归档 Memory 作为只读历史资料加入当前输入。', 'success');
  } catch (error) {
    notify(userVisibleErrorMessage(error, createBranch ? '无法基于归档 Memory 新建对话。' : '无法引用归档 Memory。'), 'error');
  }
}

async function openEmployeeMarket(agentInstanceId = '') {
  const setting = (state.userAgentSettings || []).find((item) => item.id === agentInstanceId)
    || (state.employeeOverview?.roster || []).find((item) => item.id === agentInstanceId)
    || {};
  return openMarketSkill({
    source: 'employees',
    agentInstanceId,
    agentFamilyId: setting.agentFamilyId || setting.family?.id || '',
    familyName: setting.family?.name || setting.agentFamilyId || 'Agent',
    recruited: true,
  });
}

async function openSettingsMarketFamily(button) {
  return openMarketSkill({
    source: 'settings',
    agentInstanceId: button?.dataset?.agentInstanceId || '',
    agentFamilyId: button?.dataset?.settingsMarketFamily || '',
    familyName: button?.dataset?.familyName || button?.dataset?.settingsMarketFamily || 'Agent',
    recruited: button?.dataset?.recruited === 'true',
  });
}

async function reopenMarketDrawer() {
  const drawer = state.employeeMarketDrawer;
  if (!drawer) return null;
  return openMarketSkill({
    source: drawer.source || 'employees',
    agentInstanceId: drawer.agentInstanceId || '',
    agentFamilyId: drawer.agentFamilyId || '',
    familyName: drawer.familyName || drawer.agentFamilyId || 'Agent',
    recruited: drawer.recruited !== false,
  });
}

async function openMarketSkill({ source = 'employees', agentInstanceId = '', agentFamilyId = '', familyName = '', recruited = true } = {}) {
  state.employeeContextMenu = null;
  const requestId = globalThis.crypto?.randomUUID?.() || `market_open_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  state.employeeSelectedInstanceId = source === 'employees' ? agentInstanceId : '';
  state.employeeDetailTab = source === 'employees' ? 'skill' : 'overview';
  state.employeeMemoryDrawer = null;
  state.employeeGrowthDrawer = null;
  state.employeeMarketDrawer = { requestId, source, agentInstanceId, agentFamilyId, familyName, recruited, items: [], effectiveSkill: null,
    canary: null, personalVersions: null, personalError: '', conflictPreview: null, loading: true, busy: false, error: '' };
  render();
  try {
    const [result, personalResult] = await Promise.all([
      window.janus.marketVersions({ agentInstanceId, agentFamilyId }),
      recruited && agentInstanceId
        ? window.janus.personalEvolutionVersions({ agentInstanceId }).catch((error) => ({ error }))
        : Promise.resolve(null),
    ]);
    if (state.employeeMarketDrawer?.requestId !== requestId) return null;
    state.employeeMarketDrawer = { requestId, source, agentInstanceId, agentFamilyId: result.agentFamilyId || agentFamilyId, familyName, recruited,
      items: result.items || [], effectiveSkill: result.effectiveSkill || null, canary: result.canary || null,
      personalVersions: personalResult?.error ? null : personalResult,
      personalError: personalResult?.error ? userVisibleErrorMessage(personalResult.error, '无法读取这个 Agent 的个人版本。') : '',
      conflictPreview: null, loading: false, busy: false, error: '' };
    render();
    return state.employeeMarketDrawer;
  } catch (error) {
    if (state.employeeMarketDrawer?.requestId !== requestId) return null;
    const message = userVisibleErrorMessage(error, '无法读取人才市场版本。');
    state.employeeMarketDrawer = { ...(state.employeeMarketDrawer || {}), source, agentInstanceId, agentFamilyId, familyName,
      recruited, loading: false, busy: false, error: message };
    render();
    notify(message, 'error');
    return null;
  }
}

async function runMarketSectionAction(action, button, resolution = '') {
  const drawer = state.employeeMarketDrawer;
  if (!drawer || drawer.busy || (drawer.conflictPreview && !resolution)) return;
  const marketVersionId = button.dataset.marketVersionId || '';
  const sectionId = button.dataset.marketSectionId || '';
  const mode = button.dataset.marketMode || drawer.pendingMode || 'sections';
  const accumulatedResolutions = { ...(drawer.pendingConflictResolutions || {}) };
  if (resolution && sectionId) accumulatedResolutions[sectionId] = resolution;
  const payload = { agentInstanceId: drawer.agentInstanceId, marketVersionId, mode,
    commandId: globalThis.crypto?.randomUUID?.() || `market_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    expectedEffectiveSkillHash: drawer.effectiveSkill?.effectiveSkillHash || '' };
  if (mode === 'sections') payload.sectionIds = [sectionId];
  if (Object.keys(accumulatedResolutions).length) payload.conflictResolutions = accumulatedResolutions;
  state.employeeMarketDrawer = { ...drawer, busy: true, error: '' };
  render();
  try {
    const method = action === 'rollback' ? 'rollbackMarketSections' : action === 'ignore' ? 'ignoreMarketSections' : 'adoptMarketSections';
    const result = await window.janus[method](payload);
    if (result.status === 'conflict_required') {
      state.employeeMarketDrawer = { ...drawer, busy: false, conflictPreview: result, pendingMode: mode, pendingConflictResolutions: accumulatedResolutions };
      render();
      return;
    }
    await reopenMarketDrawer();
    await refreshEmployeeOverview();
    await checkPersonalEvolutionUpdates({ renderAfter: false });
    notify(action === 'rollback' ? `市场 Skill ${mode === 'full' ? '完整版本' : '章节'}已回滚。` : action === 'ignore' ? '已忽略该市场 Skill 章节。' : `市场 Skill ${mode === 'full' ? '完整版本' : '章节'}已采用。`, 'success');
  } catch (error) {
    if (evolutionErrorCode(error) === 'market_skill_conflict') {
      await reopenMarketDrawer();
      await checkPersonalEvolutionUpdates({ renderAfter: false });
      notify('当前有效市场 Skill 已在其他设备发生变化，已刷新详情，请重新选择。', 'warning');
      return;
    }
    if (state.employeeMarketDrawer) {
      state.employeeMarketDrawer = { ...state.employeeMarketDrawer, busy: false };
      render();
    }
    notify(userVisibleErrorMessage(error, '市场 Skill 操作失败。'), 'error');
  }
}

async function runMarketCanaryAction(button){
  const drawer=state.employeeMarketDrawer;if(!drawer||drawer.busy||drawer.conflictPreview)return;
  const enabled=button.dataset.marketCanaryEnabled==='true';
  state.employeeMarketDrawer={...drawer,busy:true,error:''};render();
  try{
    await window.janus.setMarketCanaryOptIn({agentInstanceId:drawer.agentInstanceId,enabled,
      commandId:globalThis.crypto?.randomUUID?.()||`canary_${Date.now()}_${Math.random().toString(16).slice(2)}`});
    await reopenMarketDrawer();
    notify(enabled?'已重新加入真实任务 Canary。':'已退出真实任务 Canary。','success');
  }catch(error){
    if(state.employeeMarketDrawer){state.employeeMarketDrawer={...state.employeeMarketDrawer,busy:false};render();}
    notify(userVisibleErrorMessage(error,'Canary 设置失败。'),'error');
  }
}

async function openEmployeeChat(agentInstanceId = '') {
  preserveCurrentComposerDraft();
  const requestId = ++employeeChatOpenRequestId;
  const requestedAgentInstanceId = String(agentInstanceId || '').trim();
  const sourceSurfaceKey = currentRendererMessageSurfaceKey();
  state.employeeContextMenu = null;
  state.employeeConversationHistoryViewer = null;
  let employee = (state.employeeOverview?.roster || []).find((item) => item.id === requestedAgentInstanceId);
  if (!employee) return;
  if (!employee.routeEligible) {
    await refreshEmployeeOverview();
    if (requestId !== employeeChatOpenRequestId || currentRendererMessageSurfaceKey() !== sourceSurfaceKey) return;
    employee = (state.employeeOverview?.roster || []).find((item) => item.id === requestedAgentInstanceId);
  }
  if (!employee?.routeEligible) {
    const pluginMissing = employee.agentFamilyId === 'ppt' && state.pptxPluginStatus?.installed === false;
    if (pluginMissing) {
      state.pluginReturnContext = { pluginId: 'ppt_creation', departmentId: 'ppt_department', agentId: 'ppt', styleId: state.pptStyleId };
      state.currentTab = 'settings';
      state.currentSettingsSection = 'skills';
      state.pluginSearchQuery = 'PPT';
      notify('PPT 员工已招聘，请先完成本机 PPT 制作技能安装。', 'warning');
      render();
    } else {
      notify('员工已在云端启用，但本机路由状态仍未同步完成，请稍后重试。', 'warning');
    }
    return;
  }
  state.employeeSelectedInstanceId = '';
  state.employeeDetailTab = 'overview';
  state.employeeMemoryDrawer = null;
  state.employeeGrowthDrawer = null;
  state.employeeMarketDrawer = null;
  state.networkConversationPeerId = '';
  state.networkConversationGroupId = '';
  state.networkConversationMessages = [];
  state.networkDelegationId = '';
  state.collaborationGroupId = '';
  state.collaborationGroupDetail = null;
  state.networkMessageHomeOpen = false;
  state.messageActivePane = 'conversation';
  if (employee.agentFamilyId === 'secretary_agent') {
    state.currentTab = 'chat';
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    await openUBuddyConversation();
    return;
  }
  const pendingSurfaceKey = currentRendererMessageSurfaceKey();
  let conversationOverview = null;
  if (typeof window.janus.employeeConversationOverview === 'function') {
    try {
      conversationOverview = await window.janus.employeeConversationOverview({ agentInstanceId: requestedAgentInstanceId });
    } catch (error) {
      if (requestId !== employeeChatOpenRequestId || currentRendererMessageSurfaceKey() !== pendingSurfaceKey) return;
      notify(userVisibleErrorMessage(error, '无法确认 Agent 会话身份，请刷新后重试。'), 'error');
      return;
    }
    if (requestId !== employeeChatOpenRequestId || currentRendererMessageSurfaceKey() !== pendingSurfaceKey) return;
  }
  const overviewRequestedAgentInstanceId = String(conversationOverview?.requestedAgentInstanceId || requestedAgentInstanceId);
  const resolvedAgentInstanceId = String(conversationOverview?.resolvedAgentInstanceId || requestedAgentInstanceId);
  const identityChanged = Boolean(conversationOverview?.identityChanged
    || overviewRequestedAgentInstanceId !== requestedAgentInstanceId
    || resolvedAgentInstanceId !== requestedAgentInstanceId);
  if (identityChanged) {
    const refreshed = await refreshEmployeeConversationState({ renderAfter: false, reason: 'agent_identity_redirect' });
    if (requestId !== employeeChatOpenRequestId || currentRendererMessageSurfaceKey() !== pendingSurfaceKey) return;
    notify(refreshed
      ? 'Agent 身份已同步，请从刷新后的列表重新选择。'
      : 'Agent 身份已变化，但列表刷新失败，请稍后重试。', refreshed ? 'info' : 'error');
    render();
    return;
  }
  const primarySessionAgentInstanceId = String(
    conversationOverview?.primarySession?.agentInstanceId
      || conversationOverview?.primarySession?.agent_instance_id
      || '',
  );
  if (conversationOverview?.primarySession && primarySessionAgentInstanceId !== resolvedAgentInstanceId) {
    await refreshEmployeeConversationState({ renderAfter: false, reason: 'agent_session_identity_mismatch' });
    if (requestId !== employeeChatOpenRequestId || currentRendererMessageSurfaceKey() !== pendingSurfaceKey) return;
    notify('Agent 会话身份不一致，已停止打开并刷新列表。', 'error');
    render();
    return;
  }
  if (conversationOverview) {
    state.employeeConversationOverviewByInstanceId = {
      ...(state.employeeConversationOverviewByInstanceId || {}),
      [resolvedAgentInstanceId]: conversationOverview,
    };
  }
  const activeRun = allChatRuns()
    .filter((run) => !run.terminal && !run.nonBlocking
      && (run.agentInstanceId || run.agent_instance_id || '') === resolvedAgentInstanceId)
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))[0] || null;
  if (activeRun) {
    const activeRunSessionId = activeRun.displaySessionId || activeRun.sessionId || '';
    if (activeRunSessionId) {
      upsertRecentSession({
        id: activeRunSessionId,
        title: activeRun.sessionTitle || activeRun.userMessage || employee.displayName || '员工会话',
        departmentId: activeRun.departmentId || employee.family?.departmentId || '',
        agentId: activeRun.agentId || employee.agentFamilyId || '',
        agentInstanceId: resolvedAgentInstanceId,
        updatedAt: new Date().toISOString(),
        pending: true,
      });
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      await openSession(activeRunSessionId, { preserveNetworkPanel: true });
      return;
    }
    state.currentTab = 'chat';
    state.currentSessionId = '';
    state.currentChatKey = activeRun.chatKey;
    state.messages = [];
    state.attachments = [];
    state.homeMode = 'department';
    state.currentDepartmentId = activeRun.departmentId || employee.family?.departmentId || '';
    state.currentAgentId = activeRun.agentId || employee.agentFamilyId || '';
    state.currentAgentInstanceId = resolvedAgentInstanceId;
    restoreAgentConversationDraft(resolvedAgentInstanceId);
    state.selectionSource = 'employee';
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    syncCurrentChatRun();
    restoreActiveRunTransient();
    render();
    focusChatInputAtEnd();
    return;
  }
  const employeeSessions = (state.sessions || []).filter((session) => (
    session.agentInstanceId === resolvedAgentInstanceId || session.agent_instance_id === resolvedAgentInstanceId
  ));
  const existing = conversationOverview?.primarySession || employeeSessions.find((session) => (
    (session.conversationRole || session.conversation_role) === 'primary'
    && (session.writeState || session.write_state) !== 'read_only'
    && !session.readOnly
  )) || employeeSessions.find((session) => (
    (session.writeState || session.write_state) !== 'read_only' && !session.readOnly
  ));
  if (existing) {
    upsertRecentSession(existing);
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    await openSession(existing.id, { preserveNetworkPanel: true });
    return;
  }
  startNewPlainChat({ renderNow: false, focus: false });
  state.currentTab = 'chat';
  state.homeMode = 'department';
  state.currentDepartmentId = employee.family?.departmentId || '';
  state.currentAgentId = employee.agentFamilyId || '';
  state.currentAgentInstanceId = resolvedAgentInstanceId;
  state.currentChatKey = `agent:${resolvedAgentInstanceId}`;
  restoreAgentConversationDraft(resolvedAgentInstanceId);
  state.selectionSource = 'employee';
  state.socialMentionMenuOpen = false;
  state.networkPanelOpen = true;
  state.networkPanelView = 'messages';
  state.networkMessageHomeOpen = false;
  state.messageActivePane = 'conversation';
  render();
  focusChatInputAtEnd();
}

async function openEmployeeActiveWork(employee = {}, overview = {}) {
  const activeWork = overview?.activeWork || {};
  if (activeWork.route === 'session' && activeWork.sessionId) {
    const session = activeWork.session || {
      id: activeWork.sessionId,
      title: activeWork.title || employee.displayName || '员工当前工作',
      departmentId: employee.family?.departmentId || '',
      agentId: employee.agentFamilyId || '',
      agentInstanceId: employee.id || '',
      updatedAt: activeWork.startedAt || new Date().toISOString(),
    };
    upsertRecentSession(session);
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    await openSession(activeWork.sessionId, { preserveNetworkPanel: true });
    return true;
  }
  if (activeWork.route === 'task_run' && activeWork.taskRunId) {
    const primary = overview.primarySession || null;
    if (primary?.id) {
      upsertRecentSession(primary);
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      await openSession(primary.id, { preserveNetworkPanel: true });
    }
    const sourceContext = {
      source_conversation_id: primary?.id || state.currentSessionId || '',
      returnSurface: primary?.id ? 'session' : '',
    };
    beginTaskWorkspaceNavigation(sourceContext, { workspaceKind: 'task_run', workspaceId: activeWork.taskRunId });
    const opened = await openCollaborationTask(activeWork.taskRunId);
    if (!opened) {
      await returnToTaskSourceChat(sourceContext);
      return false;
    }
    return true;
  }
  return false;
}

async function openEmployeeConversationHistoryGroup(agentInstanceId = '', historyGroupId = '') {
  const cleanAgentInstanceId = String(agentInstanceId || '').trim();
  const cleanHistoryGroupId = String(historyGroupId || '').trim();
  if (!cleanAgentInstanceId || !cleanHistoryGroupId) return;
  state.employeeConversationHistoryViewer = {
    agentInstanceId: cleanAgentInstanceId,
    historyGroupId: cleanHistoryGroupId,
    loading: true,
    error: '',
    detail: null,
  };
  render();
  try {
    const detail = await window.janus.employeeConversationHistoryGroup({
      agentInstanceId: cleanAgentInstanceId,
      historyGroupId: cleanHistoryGroupId,
    });
    if (state.employeeConversationHistoryViewer?.agentInstanceId !== cleanAgentInstanceId
      || state.employeeConversationHistoryViewer?.historyGroupId !== cleanHistoryGroupId) return;
    state.employeeConversationHistoryViewer = {
      agentInstanceId: cleanAgentInstanceId,
      historyGroupId: cleanHistoryGroupId,
      loading: false,
      error: '',
      detail,
    };
    render();
    scrollMessagesToBottom({ force: true });
  } catch (error) {
    if (state.employeeConversationHistoryViewer?.historyGroupId !== cleanHistoryGroupId) return;
    state.employeeConversationHistoryViewer = {
      ...state.employeeConversationHistoryViewer,
      loading: false,
      error: userVisibleErrorMessage(error, '无法读取历史对话。'),
    };
    render();
  }
}

function notify(message, tone = 'info', durationMs = 3600, placement = '', action = null) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceMessage = janusBrandText(tone === 'error' ? userVisibleErrorMessage(message) : String(message || ''));
  const visibleMessage = tone === 'error'
    ? translateUserVisibleError(sourceMessage, state.languageMode, message instanceof Error ? message : null)
    : translateUiText(sourceMessage, state.languageMode);
  const visibleDurationMs = Math.max(NOTICE_ENTER_MS + NOTICE_EXIT_MS, Number(durationMs) || 3600);
  if (noticeTimer) clearTimeout(noticeTimer);
  if (noticeEnterTimer) clearTimeout(noticeEnterTimer);
  if (noticeExitTimer) clearTimeout(noticeExitTimer);
  const visibleAction = typeof action?.onClick === 'function' ? {
    label: translateUiText(String(action.label || '打开对应界面'), state.languageMode),
    onClick: action.onClick,
  } : null;
  state.notice = {
    id,
    message: visibleMessage,
    tone,
    phase: 'entering',
    placement: ['chat-bottom-center', 'chat-bottom-right'].includes(placement) ? placement : '',
    action: visibleAction,
  };
  noticePaused = false;
  noticeRemainingMs = visibleDurationMs;
  noticeDeadline = Date.now() + visibleDurationMs;
  syncNoticeElement();
  noticeEnterTimer = setTimeout(() => {
    if (state.notice?.id !== id || state.notice.phase !== 'entering') return;
    state.notice = { ...state.notice, phase: 'visible' };
    const notice = document.querySelector('.app-notice');
    notice?.classList.remove('is-entering');
    notice?.classList.add('is-visible');
  }, NOTICE_ENTER_MS);
  armNoticeTimer(id, visibleDurationMs);
}

function armNoticeTimer(id = state.notice?.id || '', durationMs = noticeRemainingMs) {
  if (noticeTimer) clearTimeout(noticeTimer);
  const delay = Math.max(0, Number(durationMs || 0));
  noticeRemainingMs = delay;
  noticeDeadline = Date.now() + delay;
  noticeTimer = setTimeout(() => dismissNotice(id), delay);
}

function pauseNoticeTimer() {
  if (!state.notice || state.notice.phase === 'leaving') return;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  noticePaused = true;
  noticeRemainingMs = Math.max(NOTICE_EXIT_MS, noticeDeadline - Date.now());
}

function resumeNoticeTimer() {
  if (!state.notice || state.notice.phase === 'leaving' || noticeTimer) return;
  noticePaused = false;
  armNoticeTimer(state.notice.id, noticeRemainingMs || NOTICE_EXIT_MS);
}

function wireNoticeHoverPause() {
  const notice = document.querySelector('.app-notice');
  if (!notice) return;
  if (notice.classList.contains('is-chat-bottom-center') || notice.classList.contains('is-chat-bottom-right')) placeChatBottomNotice(notice);
  if (notice.dataset.pauseWired === 'true') return;
  notice.dataset.pauseWired = 'true';
  notice.addEventListener('mouseenter', pauseNoticeTimer);
  notice.addEventListener('mouseleave', () => {
    if (!notice.matches(':focus-within')) resumeNoticeTimer();
  });
  notice.addEventListener('focusin', pauseNoticeTimer);
  notice.addEventListener('focusout', () => {
    if (!notice.matches(':hover')) resumeNoticeTimer();
  });
  notice.addEventListener('pointerdown', () => {
    try { notice.focus({ preventScroll: true }); } catch { notice.focus(); }
    pauseNoticeTimer();
  });
  if (typeof state.notice?.action?.onClick === 'function') {
    const noticeId = state.notice.id;
    notice.addEventListener('click', () => activateNoticeAction(noticeId));
    notice.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      activateNoticeAction(noticeId);
    });
  }
  if (noticePaused && !notice.matches(':hover, :focus-within')) resumeNoticeTimer();
}

function activateNoticeAction(id = state.notice?.id || '') {
  const action = state.notice?.id === id ? state.notice.action : null;
  if (typeof action?.onClick !== 'function') return;
  dismissNotice(id);
  Promise.resolve().then(() => action.onClick()).catch((error) => {
    notify(userVisibleErrorMessage(error, '无法打开对应界面。'), 'error');
  });
}

function dismissNotice(id = state.notice?.id || '') {
  if (!id || state.notice?.id !== id || state.notice.phase === 'leaving') return;
  if (noticeTimer) clearTimeout(noticeTimer);
  if (noticeEnterTimer) clearTimeout(noticeEnterTimer);
  state.notice = { ...state.notice, phase: 'leaving' };
  noticeDeadline = 0;
  noticeRemainingMs = 0;
  noticePaused = false;
  const notice = document.querySelector('.app-notice');
  notice?.classList.remove('is-entering', 'is-visible');
  notice?.classList.add('is-leaving');
  noticeExitTimer = setTimeout(() => {
    if (state.notice?.id !== id || state.notice.phase !== 'leaving') return;
    state.notice = null;
    syncNoticeElement();
  }, NOTICE_EXIT_MS);
}

function withContextCompressionTimeout(promise, timeoutMs = 130_000) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('上下文压缩超时，请稍后重试。后台状态将自动重新校验。');
      error.code = 'chat_context_compression_timeout';
      reject(error);
    }, Math.max(1, Number(timeoutMs || 130_000)));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function syncNoticeElement() {
  document.querySelector('.app-notice')?.remove();
  if (!state.notice) return;
  const shell = document.querySelector('.shell');
  if (!shell) return;
  const notice = document.createElement('div');
  const actionable = typeof state.notice.action?.onClick === 'function';
  const placementClass = state.notice.placement === 'chat-bottom-center'
    ? 'is-chat-bottom-center'
    : state.notice.placement === 'chat-bottom-right' ? 'is-chat-bottom-right' : '';
  notice.className = `app-notice ${state.notice.tone || 'info'} is-${state.notice.phase || 'visible'} ${placementClass} ${actionable ? 'is-actionable' : ''}`;
  notice.setAttribute('role', actionable ? 'button' : 'status');
  notice.tabIndex = 0;
  const message = document.createElement('span');
  message.className = 'app-notice-message';
  message.textContent = state.notice.message;
  notice.appendChild(message);
  if (actionable) {
    const actionLabel = state.notice.action.label || '打开对应界面';
    notice.title = actionLabel;
    notice.setAttribute('aria-label', `${state.notice.message}，${actionLabel}`);
    const indicator = document.createElement('span');
    indicator.className = 'app-notice-action';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML = iconSvg('chevronRight');
    notice.appendChild(indicator);
  }
  shell.appendChild(notice);
  if (['chat-bottom-center', 'chat-bottom-right'].includes(state.notice.placement)) placeChatBottomNotice(notice);
  wireNoticeHoverPause();
}

function placeChatBottomNotice(notice) {
  const chatPane = document.querySelector('.main');
  const composer = document.querySelector('.main #chat-form');
  const paneRect = chatPane?.getBoundingClientRect();
  const composerRect = composer?.getBoundingClientRect();
  if (paneRect && notice.classList.contains('is-chat-bottom-right')) {
    notice.style.left = 'auto';
    notice.style.right = `${Math.max(12, Math.round(window.innerWidth - paneRect.right + 24))}px`;
  } else if (paneRect) {
    notice.style.right = 'auto';
    const targetCenter = paneRect.left + paneRect.width / 2;
    notice.style.left = `${Math.round(targetCenter)}px`;
    const noticeRect = notice.getBoundingClientRect();
    const correction = targetCenter - (noticeRect.left + noticeRect.width / 2);
    if (Math.abs(correction) > .5) notice.style.left = `${Math.round(targetCenter + correction)}px`;
  }
  notice.style.bottom = `${Math.max(24, Math.round(window.innerHeight - (composerRect?.top || paneRect?.bottom || window.innerHeight) + 12))}px`;
}

function effectiveJanusVersion() {
  const appVersion = state.appVersion || '0.1.0';
  const agentVersion = state.agentUpdates?.current?.releaseVersion || '';
  return compareSemanticVersions(agentVersion, appVersion) > 0 ? agentVersion : appVersion;
}

function compareSemanticVersions(left, right) {
  const a = String(left || '0').split(/[.+-]/).map((part) => Number(part) || 0);
  const b = String(right || '0').split(/[.+-]/).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

function departmentName(departmentId) {
  if (departmentId === 'collaboration') return '部门协作';
  const dept = state.org.departments.find((item) => item.id === departmentId);
  return dept?.name || 'Janus';
}

window.addEventListener('beforeunload', () => {
  preserveCurrentComposerDraft();
  if (removeCodexListener) removeCodexListener();
  if (removeChatSessionUpdatedListener) removeChatSessionUpdatedListener();
  if (removeChatUserInputWindowListener) removeChatUserInputWindowListener();
  if (removeUpdateListener) removeUpdateListener();
  if (removeAgentUpdateListener) removeAgentUpdateListener();
  if (removeDesktopLifecycleListener) removeDesktopLifecycleListener();
  if (removeCodexPluginsChangedListener) removeCodexPluginsChangedListener();
  if (removeAttachedSkillsChangedListener) removeAttachedSkillsChangedListener();
  if (removePptxPluginProgressListener) removePptxPluginProgressListener();
  if (removeEvolutionProgressListener) removeEvolutionProgressListener();
  if (removeModelsListener) removeModelsListener();
  if (removeSocialListener) removeSocialListener();
  if (removeEmployeesUpdatedListener) removeEmployeesUpdatedListener();
  if (removeAgentDeliveryListener) removeAgentDeliveryListener();
  if (removeTaskUpdateListener) removeTaskUpdateListener();
  if (removeAgentAvailabilityListener) removeAgentAvailabilityListener();
  if (removeSocialOpenTaskListener) removeSocialOpenTaskListener();
  if (removeSystemOpenConversationListener) removeSystemOpenConversationListener();
  if (removeSystemOpenAgentSessionListener) removeSystemOpenAgentSessionListener();
  if (removeSystemOpenUpdatesListener) removeSystemOpenUpdatesListener();
  if (removeSystemOpenFollowerListener) removeSystemOpenFollowerListener();
  if (removeFollowerUpdatedListener) removeFollowerUpdatedListener();
  clearEmployeeCommandSettlementTracking();
  clearEvolutionDemoTimer();
});

function applyModelCatalog(catalog) {
  if (catalog && Array.isArray(catalog.models) && catalog.models.length) state.modelCatalog = catalog;
  const options = textModelOptions(state.modelCatalog);
  if (!options.some(([value]) => value === state.model)) state.model = options[0]?.[0] || 'gpt-5.6-sol';
  const reasoningOptions = reasoningOptionsForModel(state.modelCatalog, state.model);
  if (!reasoningOptions.some(([value]) => value === state.reasoningEffort)) {
    state.reasoningEffort = modelCatalogEntry(state.modelCatalog, state.model)?.defaultReasoningEffort || reasoningOptions[0]?.[0] || 'medium';
  }
}

export function startRendererApp() {
  reportRendererEvent('info', 'renderer-started');
  return init().catch((error) => {
    reportRendererEvent('error', 'renderer-startup-failed', error);
    app.innerHTML = `<pre class="fatal">${escapeHtml(userVisibleErrorMessage(error, '应用启动失败，请重启后重试。'))}</pre>`;
  });
}
