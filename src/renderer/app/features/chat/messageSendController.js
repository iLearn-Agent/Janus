import {
  normalizeMentionEntities,
  UBUDDY_MENTION_SELECTION_VERSION,
  UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
} from '../../../../shared/contracts/mentions.js';
import { normalizeMessageQuote } from '../../../../shared/contracts/messageQuote.js';
import { STRUCTURED_TASK_REFERENCE_VERSION } from '../../../../shared/contracts/taskReference.js';
import {
  UBUDDY_MESSAGE_MODES,
  UBUDDY_MESSAGE_MODE_VERSION,
} from '../../../../shared/contracts/uBuddyMessageMode.js';
import { PPT_AGENT_ID, normalizePptStyleId, pptStyleOption } from '../../../../shared/pptAgents.js';
import { employeeRouteEligibleForChat } from '../../utils/agentIdentity.js';

export function resolveOutgoingAgentInstanceId({
  agentId = '',
  currentSession = null,
  roster = [],
  preferredInstanceId = '',
} = {}) {
  const targetAgentId = String(agentId || '').trim();
  if (!targetAgentId) return '';
  const employees = Array.isArray(roster) ? roster : [];
  const sessionInstanceId = String(currentSession?.agentInstanceId || currentSession?.agent_instance_id || '').trim();
  const sessionAgentId = String(currentSession?.agentId || currentSession?.agent_id || '').trim();
  const candidates = [...new Set([
    String(preferredInstanceId || '').trim(),
    sessionInstanceId,
  ].filter(Boolean))];
  for (const instanceId of candidates) {
    const employee = employees.find((item) => item?.id === instanceId) || null;
    const familyId = String(employee?.agentFamilyId || employee?.agent_family_id
      || (instanceId === sessionInstanceId ? sessionAgentId : '') || '').trim();
    if (familyId === targetAgentId) return instanceId;
  }
  const familyEmployees = employees.filter((employee) => (
    String(employee?.agentFamilyId || employee?.agent_family_id || '').trim() === targetAgentId
  ));
  return familyEmployees.find((employee) => employeeRouteEligibleForChat(employee))?.id
    || familyEmployees[0]?.id
    || '';
}

export function restoreTaskReferenceRequiredComposerState({
  state,
  result = {},
  message = '',
  attachments = [],
  fileReferences = [],
  memoryReferences = [],
  quote = null,
  mentions = [],
} = {}) {
  state.taskReferenceOptions = Array.isArray(result.taskReferenceOptions) ? result.taskReferenceOptions : [];
  state.taskReferenceMenuOpen = true;
  state.taskReferenceOptionsLoading = false;
  state.taskReferenceOptionsError = '';
  state.chatDraft = String(message || '');
  state.attachments = attachments;
  state.composerFileReferences = fileReferences;
  state.composerMemoryReferences = memoryReferences;
  state.messageQuote = quote;
  state.composerMentions = mentions;
}

export function chatRunBelongsToActiveAccount(run = {}, state = {}) {
  const samePrincipal = String(run.ownerUserId || state.currentUser?.id || '') === String(state.currentUser?.id || '');
  const sameWorkspace = String(run.accountWorkspaceId || 'workspace_personal')
    === String(state.activeAccountWorkspace?.id || 'workspace_personal');
  // A run is owned by its principal/workspace, not by the renderer's switch
  // generation. The generation changes whenever the user navigates away and
  // back; retaining it here would make a still-running run permanently
  // invisible after returning to its original workspace.
  return samePrincipal && sameWorkspace;
}

export function chatComposerIsBlocked(state = {}, currentChatRun = () => null) {
  if (currentChatRun()) return true;
  const hasChatRuns = Array.isArray(state.chatRuns) && state.chatRuns.length > 0;
  const activeChatKey = String(state.currentChatKey || '').trim();
  const employeeChatActive = activeChatKey.startsWith('agent:')
    || Boolean(String(state.currentAgentInstanceId || '').trim());
  if (state.busy && employeeChatActive && hasChatRuns) return false;
  return Boolean(
    state.busy
  );
}

export function agentConversationCompletionKeys({ sessionId = '', agentId = '', agentInstanceId = '' } = {}) {
  const cleanSessionId = String(sessionId || '').trim();
  const cleanAgentId = String(agentId || '').trim();
  const cleanAgentInstanceId = String(agentInstanceId || '').trim();
  return [
    cleanSessionId ? `agent:${cleanSessionId}` : '',
    cleanAgentId ? `agent-pending:${cleanAgentId}${cleanAgentInstanceId ? `:${cleanAgentInstanceId}` : ''}` : '',
  ].filter(Boolean);
}

export function createMessageSendController({
  api,
  documentRef,
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
  activeAgentInstanceId,
  restorePersistentDeliveryRuns,
  upsertRecentSession = () => {},
  reactivateAgentConversation = () => {},
  beginMessagePageRequest = () => 0,
  messagePageRequestIsLatest = () => true,
  clearAgentConversationDraft = () => {},
  composerSurfaceKey = () => '',
  clearComposerDraft = () => {},
  captureComposerDraft = () => {},
  restoreComposerDraft = () => {},
  getComposerDraftSnapshot = () => null,
  putComposerDraftSnapshot = () => {},
  hasComposerDraft = () => false,
}) {
  async function sendChat(event, options = {}) {
    event.preventDefault();
    if (!state.currentUser) {
      state.currentTab = 'settings';
      notify('请先登录账号再开始对话。', 'warning');
      render();
      return;
    }
    if (state.collaborationGroupId) {
      await sendCollaborationGroupMessage();
      return;
    }
    if (state.chatGroupId) {
      await sendChatGroupMessage();
      return;
    }
    if (state.networkConversationPeerId && state.networkConversationPeerId !== 'self-secretary') {
      if (state.networkConversationMode === 'person') await sendDirectSocialMessage();
      else await sendSocialGroupMessage();
      return;
    }
    const input = documentRef.getElementById('chat-input');
    const outgoingComposerSurfaceKey = composerSurfaceKey();
    const explicitMessage = String(options.message || '').trim();
    const preserveComposer = Boolean(explicitMessage && options.preserveComposer);
    if (!explicitMessage && input?.dataset?.imeComposing === 'true') return;
    const message = explicitMessage || input.value.trim();
    if (!message || chatComposerIsBlocked(state, currentChatRun)) return;
    let outgoingComposerDraftSnapshot = null;
    const originSessionId = state.currentSessionId;
    const originChatKey = state.currentChatKey;
    const currentStoredSession = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
    if (currentStoredSession?.readOnly || currentStoredSession?.writeState === 'read_only') {
      notify('历史会话为只读，请返回员工主会话继续对话。', 'error');
      return;
    }
    const secretaryChat = currentStoredSession?.departmentId === 'secretary_department' || state.homeMode === 'secretary';
    const privateAssistantChat = currentStoredSession?.departmentId === 'private_assistant' || state.homeMode === 'private_assistant';
    const imageChat = state.homeMode === 'image' || Boolean(state.composerImageMode);
    const activeSecretaryChat = secretaryChat && !imageChat;
    const activePrivateAssistantChat = privateAssistantChat && !imageChat;
    const outgoingUBuddyMessageMode = activeSecretaryChat && state.uBuddyFeatureFlags?.messageModeV1 === true
      ? state.uBuddyMessageMode === UBUDDY_MESSAGE_MODES.ASK
        ? UBUDDY_MESSAGE_MODES.ASK
        : UBUDDY_MESSAGE_MODES.TASK
      : '';
    if (activePrivateAssistantChat) state.privateAssistantResultUnread = false;
    const normalizedComposerMentions = !preserveComposer
      ? normalizeMentionEntities([...(state.composerMentions || []), ...(state.secretaryMentions || [])], { content: message, requirePicker: true })
      : [];
    const outgoingMentions = !preserveComposer && !imageChat
      ? activeSecretaryChat
        ? normalizedComposerMentions
        : normalizedComposerMentions.filter((mention) => ['plugin', 'skill'].includes(mention.principalType))
      : [];
    const installedPluginIds = new Set((state.codexPlugins?.installed || [])
      .filter((plugin) => plugin?.installed && plugin?.enabled !== false)
      .map((plugin) => String(plugin.pluginId || '')));
    const unavailablePluginMention = outgoingMentions.find((mention) => (
      mention.principalType === 'plugin' && !installedPluginIds.has(String(mention.pluginId || ''))
    ));
    if (unavailablePluginMention) {
      notify(`${unavailablePluginMention.displayText || '所选插件'}已卸载或停用，请移除引用或重新安装。`, 'warning');
      return;
    }
    const outgoingParticipantSelectionPolicy = state.uBuddyParticipantSelectionPolicy === 'auto_select'
      ? 'auto_select'
      : 'all_mentioned';
    const outgoingAttachmentItems = preserveComposer ? [] : [...state.attachments];
    const outgoingFileReferences = preserveComposer ? [] : [...(state.composerFileReferences || [])];
    const outgoingMemoryReferences = preserveComposer ? [] : [...(state.composerMemoryReferences || [])];
    const outgoingQuote = preserveComposer ? null : normalizeMessageQuote(state.messageQuote);
    const outgoingTaskReference = !preserveComposer && activeSecretaryChat && state.uBuddyFeatureFlags?.structuredTaskReference === true
      && state.composerTaskReference && typeof state.composerTaskReference === 'object'
      ? { ...state.composerTaskReference }
      : null;
    const preserveMessageWorkspace = state.networkPanelOpen && state.networkPanelView === 'messages';
    if (!activeSecretaryChat && !activePrivateAssistantChat && !imageChat && !preserveMessageWorkspace) retractNetworkPanelForChat();
    const collaborationChat = state.homeMode === 'collaboration';
    const normalChat = !activePrivateAssistantChat && !state.currentDepartmentId && !imageChat && !collaborationChat;
    const outgoingDepartmentId = imageChat ? 'image_generation' : activePrivateAssistantChat ? 'private_assistant' : activeSecretaryChat ? 'secretary_department' : collaborationChat ? 'collaboration' : normalChat ? 'general' : state.currentDepartmentId;
    if (outgoingDepartmentId === 'ppt_department' && state.pptxPluginStatus && !state.pptxPluginStatus.ready) {
      state.pluginReturnContext = { pluginId: 'ppt_creation', departmentId: 'ppt_department', agentId: state.currentAgentId || 'ppt' };
      state.currentTab = 'settings';
      state.currentSettingsSection = 'skills';
      state.pluginSearchQuery = 'PPT';
      notify(state.pptxPluginStatus.installed
        ? (state.pptxPluginStatus.missing || 'PPT 制作技能的本机运行环境未就绪，请先修复依赖。')
        : '请先安装 PPT 制作技能，再选择风格开始制作。', 'warning');
      render();
      return;
    }
    const outgoingAgentId = imageChat ? state.imageModel : activePrivateAssistantChat ? 'private_assistant' : activeSecretaryChat ? 'secretary_agent' : collaborationChat ? '' : normalChat ? '' : outgoingDepartmentId === 'ppt_department' ? PPT_AGENT_ID : resolveSelectedAgentId(outgoingDepartmentId, state.currentAgentId);
    const outgoingAgentInstanceId = activePrivateAssistantChat || activeSecretaryChat || imageChat || collaborationChat || normalChat
      ? ''
      : resolveOutgoingAgentInstanceId({
          agentId: outgoingAgentId,
          currentSession: currentStoredSession,
          roster: state.employeeOverview?.roster || [],
          preferredInstanceId: activeAgentInstanceId?.() || '',
        });
    const targetEmployee = outgoingAgentInstanceId
      ? (state.employeeOverview?.roster || []).find((employee) => employee.id === outgoingAgentInstanceId)
      : null;
    if (targetEmployee && !employeeRouteEligibleForChat(targetEmployee)) {
      notify('该 Agent 已停用，无法继续对话。请先在人才市场重新启用。', 'warning');
      return;
    }
    const routePreference = activePrivateAssistantChat || imageChat ? 'explicit' : activeSecretaryChat || normalChat ? 'auto' : 'explicit';
    const currentSessionProject = currentStoredSession?.projectId || currentStoredSession?.project_id
      ? projectById(currentStoredSession.projectId || currentStoredSession.project_id)
      : null;
    const selectedProject = activeProject();
    const outgoingProject = privateAssistantChat
      ? null
      : activeSecretaryChat
        ? selectedProject || currentSessionProject
        : currentSessionProject || selectedProject;
    const outgoingProjectId = privateAssistantChat || state.workspaceDetached ? '' : outgoingProject?.id || '';
    const outgoingWorkspaceRoot = privateAssistantChat || state.workspaceDetached ? '' : outgoingProject?.workspaceRoot || outgoingProject?.workspace_root || state.workspaceRoot || '';
    if (outgoingFileReferences.some((reference) => reference.projectId !== outgoingProjectId)) {
      notify('项目已变化，请移除旧文件引用并重新选择。', 'warning');
      return;
    }
    if (!preserveComposer && outgoingComposerSurfaceKey) {
      captureComposerDraft(outgoingComposerSurfaceKey);
      outgoingComposerDraftSnapshot = getComposerDraftSnapshot(outgoingComposerSurfaceKey);
      clearComposerDraft(outgoingComposerSurfaceKey, { applyToCurrent: false });
    }
    const outgoingInteractionMode = imageChat || privateAssistantChat ? '' : ['goal', 'plan'].includes(state.interactionMode) ? state.interactionMode : '';
    const imageHostDepartmentId = imageChat
      ? currentStoredSession?.departmentId || (privateAssistantChat ? 'private_assistant' : secretaryChat ? 'secretary_department' : state.currentDepartmentId || 'general')
      : '';
    const imageHostAgentId = imageChat
      ? currentStoredSession?.agentId || (privateAssistantChat ? 'private_assistant' : secretaryChat ? 'secretary_agent' : state.currentAgentId || '')
      : '';
    // Snapshot PPT style/template selection before uploads or rerenders can
    // mutate shared composer state. This turn-local context must be the sole
    // source of truth for the artifact rendered from this message.
    const outgoingChatContext = imageChat ? null : buildChatContext(outgoingDepartmentId, outgoingAgentId);
    if (originSessionId) beginMessagePageRequest(originSessionId);
    const channelId = Math.random().toString(16).slice(2);
    const localMessageId = `local-${Date.now()}`;
    const localAttachments = pendingAttachmentsForMessage(outgoingAttachmentItems);
    state.status = '';
    const run = {
      channelId,
      ownerUserId: state.currentUser?.id || '',
      accountWorkspaceId: state.activeAccountWorkspace?.id || 'workspace_personal',
      workspaceSwitchGeneration: Number(state.workspaceSwitchGeneration || 0),
      sessionId: originSessionId,
      displaySessionId: originSessionId,
      executionSessionId: originSessionId,
      workerSessionId: '',
      chatKey: originChatKey,
      departmentId: outgoingDepartmentId,
      agentId: outgoingAgentId,
      agentInstanceId: outgoingAgentInstanceId,
      userMessage: message,
      sessionTitle: currentStoredSession?.title || '',
      statusMessageId: `run-${channelId}-status`,
      processMessageId: '',
      assistantMessageId: '',
      assistantContent: '',
      assistantStreaming: true,
      processEvents: [],
      targetKind: imageChat ? 'image' : activePrivateAssistantChat ? 'private_assistant' : collaborationChat ? 'collaboration' : normalChat ? 'planning' : 'agent',
      routePreference,
      plan: null,
      userInputRequest: null,
      userInputSubmitting: false,
      userInputError: '',
      userInputSkippedQuestionIds: [],
      projectId: outgoingProjectId,
      workspaceRoot: outgoingWorkspaceRoot,
      interactionMode: outgoingInteractionMode,
      uBuddyMessageMode: outgoingUBuddyMessageMode,
      pptStyleId: outgoingDepartmentId === 'ppt_department' ? normalizePptStyleId(state.pptStyleId) : '',
      startedAt: Date.now(),
      failed: false,
      lastStatusStage: 'queued',
      lastStatusText: '',
      pptProgress: null,
      pptArtifactPending: false,
      pptArtifactStartedAt: 0,
      taskRunId: '',
      taskType: '',
      objective: null,
      taskSnapshot: null,
      progressMilestones: [],
      blocker: null,
      permissionMode: activePrivateAssistantChat ? state.privateAssistantPermission : state.sandboxPermission,
    };
    registerChatRun(run);
    if (run.targetKind === 'agent') {
      reactivateAgentConversation({
        sessionId: originSessionId,
        agentId: outgoingAgentId,
        agentInstanceId: outgoingAgentInstanceId,
      });
    }
    let attachments = [];
    run.localUserMessage = {
      id: localMessageId,
      role: 'user',
      content: message,
      agentId: outgoingAgentId,
      agentInstanceId: outgoingAgentInstanceId,
      departmentId: outgoingDepartmentId,
      createdAt: new Date().toISOString(),
      metadata: {
        ...(outgoingQuote ? { quote: outgoingQuote } : {}),
        ...(localAttachments.length ? { attachments: localAttachments } : {}),
        ...(outgoingFileReferences.length ? { fileReferences: outgoingFileReferences } : {}),
        ...(outgoingMemoryReferences.length ? { memoryReferences: outgoingMemoryReferences } : {}),
        ...(outgoingMentions.length ? { mentions: outgoingMentions } : {}),
        ...(outgoingTaskReference ? { taskReference: outgoingTaskReference } : {}),
        ...(outgoingUBuddyMessageMode ? { uBuddyMessageMode: outgoingUBuddyMessageMode } : {}),
        ...(options.clarificationResponse ? {
          uBuddyClarificationResponse: true,
          uBuddyClarificationAnswers: options.clarificationResponse.answers || [],
          sourceMessageId: options.clarificationResponse.sourceMessageId || '',
          continuationId: options.clarificationResponse.continuationId || '',
          continuationKind: options.clarificationResponse.continuationKind || '',
          planningSessionId: options.clarificationResponse.planningSessionId || '',
          planningBaseRevision: Math.max(0, Number(options.clarificationResponse.baseRevision || 0)),
        } : {}),
        ...(outgoingDepartmentId === 'ppt_department' ? {
          pptStyleId: outgoingChatContext?.styleId || normalizePptStyleId(state.pptStyleId),
          pptTemplateId: outgoingChatContext?.templateId || 'none',
        } : {}),
      },
    };
    state.messages.push(run.localUserMessage);
    updateRunStatusMessage(run, 'queued', initialRunOperationLabel(run, { imageChat, attachments: localAttachments, fileReferences: outgoingFileReferences }));
    if (!preserveComposer) {
      input.value = '';
      state.chatDraft = '';
      if (activeSecretaryChat || outgoingMentions.length) {
        state.uBuddyContactPickerOnly = false;
        state.secretaryMentions = [];
        state.composerMentions = [];
        if (activeSecretaryChat) {
          state.uBuddyParticipantSelectionPolicy = 'auto_select';
          state.composerTaskReference = null;
          state.taskReferenceMenuOpen = false;
        }
      }
      state.attachments = [];
      state.composerFileReferences = [];
      state.composerMemoryReferences = [];
      state.messageQuote = null;
    }
    state.modelMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
    render();
    scrollMessagesToBottom({ force: true });
    try {
      attachments = await readyAttachmentsForSend(outgoingAttachmentItems);
      updateLocalMessageAttachments(localMessageId, attachments);
      if (attachments.length && isRunForCurrentChat(run)) {
        render();
        scrollMessagesToBottom();
      }
      const result = activeSecretaryChat ? await api.secretaryChat({
        channelId,
        sessionId: originSessionId,
        projectId: outgoingProjectId,
        workspaceRoot: outgoingWorkspaceRoot,
        interactionMode: outgoingInteractionMode,
        message,
        quotedMessage: outgoingQuote,
        mentions: outgoingMentions,
        mentionSelectionVersion: UBUDDY_MENTION_SELECTION_VERSION,
        participantSelectionPolicyVersion: UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
        participantSelectionPolicy: outgoingParticipantSelectionPolicy,
        taskReference: outgoingTaskReference,
        taskReferenceVersion: STRUCTURED_TASK_REFERENCE_VERSION,
        ...(outgoingUBuddyMessageMode ? {
          uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
          uBuddyMessageMode: outgoingUBuddyMessageMode,
        } : {}),
        executionModeChoice: options.executionModeChoice || null,
        clarificationResponse: options.clarificationResponse || null,
        planningRestartSourceMessageId: options.planningRestartSourceMessageId || '',
        fileReferences: outgoingFileReferences,
        memoryReferences: outgoingMemoryReferences,
        attachments,
        model: currentModelValue(),
        reasoningEffort: currentReasoningValue(),
        sandboxPermission: run.permissionMode,
      }) : await api.sendChat({
        channelId,
        sessionId: originSessionId,
        departmentId: outgoingDepartmentId,
        agentId: outgoingAgentId,
        agentInstanceId: outgoingAgentInstanceId,
        projectId: outgoingProjectId,
        workspaceRoot: outgoingWorkspaceRoot,
        workspaceDetached: state.workspaceDetached,
        interactionMode: outgoingInteractionMode,
        chatMode: imageChat ? 'image' : activePrivateAssistantChat ? 'private_assistant' : collaborationChat ? 'collaboration' : normalChat ? 'normal' : 'agent',
        routePreference,
        chatContext: outgoingChatContext,
        attachments,
        fileReferences: outgoingFileReferences,
        memoryReferences: outgoingMemoryReferences,
        mentions: outgoingMentions,
        imageAttachments: imageChat ? attachments : [],
        imageModel: state.imageModel,
        inlineImageMode: imageChat && state.homeMode !== 'image',
        imageHostDepartmentId,
        imageHostAgentId,
        message,
        quotedMessage: outgoingQuote,
        model: currentModelValue(),
        reasoningEffort: currentReasoningValue(),
        sandboxPermission: run.permissionMode,
      });
      const runAccountStillActive = chatRunBelongsToActiveAccount(run, state);
      if (runAccountStillActive && result.privateAssistantUsage) state.privateAssistant = result.privateAssistantUsage;
      if (runAccountStillActive && result.nativePluginControl) {
        const nativePluginCatalog = result.nativePluginCatalog
          || await api.listCodexPlugins?.().catch(() => null);
        if (chatRunBelongsToActiveAccount(run, state) && nativePluginCatalog) {
          state.codexPlugins = nativePluginCatalog;
        }
      }
      if (runAccountStillActive && result.attachedSkillControl) {
        const attachedSkillCatalog = result.attachedSkillCatalog
          || await api.listAttachedSkills?.().catch(() => null);
        if (chatRunBelongsToActiveAccount(run, state) && attachedSkillCatalog) {
          state.attachedSkillCatalog = attachedSkillCatalog;
        }
      }
      const runWasCurrent = isRunForCurrentChat(run);
      if (result?.cancelled) {
        if (result.session?.id) {
          run.sessionId = result.session.id;
          run.displaySessionId = result.session.id;
          run.executionSessionId = result.workerSession?.id || run.executionSessionId || result.session.id;
          run.workerSessionId = result.workerSession?.id || result.targetSessionId || run.workerSessionId || '';
          if (runAccountStillActive && (runWasCurrent || isRunForCurrentChat(run))) {
            state.currentSessionId = result.session.id;
            state.currentChatKey = `session:${result.session.id}`;
          }
          if (runAccountStillActive) {
            upsertRecentSession(result.session);
            if (run.targetKind === 'agent') {
              reactivateAgentConversation({
                sessionId: result.session.id,
                agentId: result.session.agentId || run.agentId,
                agentInstanceId: result.session.agentInstanceId || run.agentInstanceId,
              });
            }
            const sessions = await api.listSessions().catch(() => null);
            if (chatRunBelongsToActiveAccount(run, state) && Array.isArray(sessions)) {
              state.sessions = sessions;
              upsertRecentSession(result.session);
            }
          }
        }
        if (runAccountStillActive) notify('已中止生成。', 'success');
        return;
      }
      run.sessionId = result.session.id;
      run.displaySessionId = result.session.id;
      run.executionSessionId = result.workerSession?.id || run.executionSessionId || result.session.id;
      run.workerSessionId = result.workerSession?.id || result.targetSessionId || run.workerSessionId || '';
      if (runAccountStillActive && activeSecretaryChat) state.secretarySessionId = result.session.id;
      const runIsCurrent = runAccountStillActive && (runWasCurrent || isRunForCurrentChat(run));
      const actualDepartmentId = result.session?.departmentId || run.departmentId || outgoingDepartmentId;
      const actualAgentId = result.session?.agentId || run.agentId || outgoingAgentId;
      const actualAgentInstanceId = result.message?.agentInstanceId || result.session?.agentInstanceId
        || run.agentInstanceId || outgoingAgentInstanceId || '';
      const completedSession = String(result.message?.content || '').trim()
        ? {
            ...result.session,
            lastMessage: result.message.content,
            lastMessageRole: result.message.role || 'assistant',
            lastMessageAt: result.message.createdAt || result.session.updatedAt || new Date().toISOString(),
          }
        : result.session;
      if (runAccountStillActive) {
        upsertRecentSession(completedSession);
        if (run.targetKind === 'agent') {
          reactivateAgentConversation({
            sessionId: result.session.id,
            agentId: actualAgentId,
            agentInstanceId: actualAgentInstanceId,
          });
        }
      }
      if (runIsCurrent) {
        state.currentSessionId = result.session.id;
        state.currentAgentInstanceId = actualAgentInstanceId;
        state.currentChatKey = actualAgentInstanceId ? `agent:${actualAgentInstanceId}` : `session:${result.session.id}`;
        if (actualDepartmentId === 'secretary_department') {
          state.homeMode = 'secretary';
          state.currentDepartmentId = '';
          state.currentAgentId = '';
        } else if (actualDepartmentId === 'private_assistant') {
          state.homeMode = 'private_assistant';
          state.currentDepartmentId = '';
          state.currentAgentId = '';
          state.interactionMode = '';
        } else if (actualDepartmentId === 'collaboration') {
          state.homeMode = 'collaboration';
          state.currentDepartmentId = '';
          state.currentAgentId = '';
        } else if (actualDepartmentId && actualDepartmentId !== 'general' && actualDepartmentId !== 'image_generation') {
          state.homeMode = 'department';
          state.currentDepartmentId = actualDepartmentId;
          state.currentAgentId = resolveSelectedAgentId(actualDepartmentId, actualAgentId);
        }
      }
      // The main process already persisted the result in the run's original Workspace.
      // A switched Renderer must reload it through that Workspace instead of reading the old Session here.
      if (!runAccountStillActive) return;
      if (outgoingProjectId) expandProject(outgoingProjectId);
      else if (actualDepartmentId === 'secretary_department') state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), tasks: true };
      else if (actualDepartmentId === 'collaboration') state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), collaboration: true };
      else state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), chats: true };
      const completedMessagePageRequestVersion = runIsCurrent
        ? beginMessagePageRequest(result.session.id)
        : 0;
      const canApplyCompletionToCurrentChat = () => Boolean(
        chatRunBelongsToActiveAccount(run, state)
        && isRunForCurrentChat(run)
        && (!completedMessagePageRequestVersion
          || messagePageRequestIsLatest(result.session.id, completedMessagePageRequestVersion))
      );
      const [completedMessagePageResult, sessionsResult] = await Promise.allSettled([
        runIsCurrent
          ? actualAgentInstanceId && api.agentConversationTimeline
            ? api.agentConversationTimeline({ agentInstanceId: actualAgentInstanceId, limit: 200 })
              .then((timeline) => ({
                items: timelineMessages(timeline, actualAgentInstanceId),
                nextCursor: timeline?.nextCursor || null,
                hasMore: Boolean(timeline?.nextCursor),
                source: 'agent',
              }))
            : typeof api.listMessagePage === 'function'
              ? api.listMessagePage({ sessionId: result.session.id, limit: 80 }).then((page) => ({ ...page, source: 'session' }))
              : api.listMessages(result.session.id).then((items) => ({ items, nextCursor: null, hasMore: false, source: 'session' }))
          : Promise.resolve(null),
        api.listSessions(),
      ]);
      if (!chatRunBelongsToActiveAccount(run, state)) return;
      const completedMessagePage = completedMessagePageResult.status === 'fulfilled'
        ? completedMessagePageResult.value
        : null;
      if (completedMessagePageResult.status === 'fulfilled' && canApplyCompletionToCurrentChat()) {
        state.messages = Array.isArray(completedMessagePage?.items) ? completedMessagePage.items : [];
        state.messagePagination = {
          sessionId: result.session.id,
          source: completedMessagePage?.source || 'session',
          agentInstanceId: completedMessagePage?.source === 'agent' ? actualAgentInstanceId : '',
          nextCursor: completedMessagePage?.nextCursor || null,
          hasMore: Boolean(completedMessagePage?.hasMore),
          loading: false,
          initialLoading: false,
        };
        const completedPlan = result.message?.metadata?.plan || null;
        state.chatPlanExecutionPrompt = completedPlan?.executable === true
          ? {
              sessionId: result.session.id,
              messageId: result.message?.id || '',
              plan: completedPlan,
            }
          : null;
      }
      if (canApplyCompletionToCurrentChat() && activeSecretaryChat && result.workId && api.listAgentDeliveryRuns) {
        const deliveryRuns = await api.listAgentDeliveryRuns({
          sessionId: result.session.id,
          statuses: ['queued', 'running'],
          limit: 100,
        }).catch(() => []);
        if (canApplyCompletionToCurrentChat()) restorePersistentDeliveryRuns?.(deliveryRuns, result.session.id);
      }
      if (canApplyCompletionToCurrentChat()) {
        const contextUsage = await api.chatContextStatus({ sessionId: result.session.id }).catch(() => null);
        if (canApplyCompletionToCurrentChat()) state.contextUsage = contextUsage;
      }
      if (!chatRunBelongsToActiveAccount(run, state)) return;
      if (sessionsResult.status === 'fulfilled' && Array.isArray(sessionsResult.value)) {
        state.sessions = sessionsResult.value;
      }
      upsertRecentSession(completedSession);
      if (activeSecretaryChat && (result.collaborationGroup?.id || result.delegation?.id || result.delegations?.length)) {
        await refreshCollaborationOverview(false);
        await refreshSocialThreads(false);
        if (!chatRunBelongsToActiveAccount(run, state)) return;
      }
      if (actualDepartmentId === 'collaboration' || result.task?.id) {
        const tasks = await api.listTasks();
        if (!chatRunBelongsToActiveAccount(run, state)) return;
        state.tasks = tasks;
        if (result.task?.id) {
          const taskDetail = await api.getTask(result.task.id);
          if (!chatRunBelongsToActiveAccount(run, state)) return;
          state.taskDetail = taskDetail;
        }
      }
      let keepComposerDraft = false;
      if (canApplyCompletionToCurrentChat() && activeSecretaryChat && result.taskReferenceRequired) {
        keepComposerDraft = true;
        restoreTaskReferenceRequiredComposerState({
          state,
          result,
          message,
          attachments: outgoingAttachmentItems,
          fileReferences: outgoingFileReferences,
          memoryReferences: outgoingMemoryReferences,
          quote: outgoingQuote,
          mentions: outgoingMentions,
        });
        notify('请选择目标任务或“创建新任务”，原消息和附件已保留。', 'info');
      } else if (canApplyCompletionToCurrentChat() && activeSecretaryChat
        && ['clarification', 'decision_failed', 'intake_failed', 'target_not_found'].includes(String(result.uBuddyMode || ''))
        && outgoingTaskReference?.createNewTask) {
        keepComposerDraft = true;
        state.composerTaskReference = outgoingTaskReference;
        if (['decision_failed', 'intake_failed'].includes(String(result.uBuddyMode || ''))) {
          state.chatDraft = message;
          state.attachments = outgoingAttachmentItems;
          state.composerFileReferences = outgoingFileReferences;
          state.composerMemoryReferences = outgoingMemoryReferences;
          state.messageQuote = outgoingQuote;
          state.composerMentions = outgoingMentions;
        }
      }
      if (!preserveComposer) {
        if (keepComposerDraft) captureComposerDraft(outgoingComposerSurfaceKey, { readInput: false });
      }
    } catch (error) {
      if (!preserveComposer && outgoingComposerDraftSnapshot && !hasComposerDraft(outgoingComposerSurfaceKey)) {
        putComposerDraftSnapshot(outgoingComposerSurfaceKey, outgoingComposerDraftSnapshot);
      }
      if (!preserveComposer && isRunForCurrentChat(run) && !hasComposerDraft(outgoingComposerSurfaceKey)) {
        restoreComposerDraft(outgoingComposerSurfaceKey);
      } else if (!preserveComposer && isRunForCurrentChat(run) && outgoingComposerDraftSnapshot
        && String(state.chatDraft || '') === '') {
        restoreComposerDraft(outgoingComposerSurfaceKey);
      }
      if (isRunForCurrentChat(run)) {
        if (!(state.composerFileReferences || []).length) state.composerFileReferences = outgoingFileReferences;
        if (!(state.composerMemoryReferences || []).length) state.composerMemoryReferences = outgoingMemoryReferences;
        if (!(state.composerMentions || []).length && outgoingMentions.length) state.composerMentions = outgoingMentions;
        if (!state.composerTaskReference && outgoingTaskReference) state.composerTaskReference = outgoingTaskReference;
      }
      if (activePrivateAssistantChat && !(state.currentTab === 'chat' && isRunForCurrentChat(run))) {
        state.privateAssistantResultUnread = true;
      }
      if (isRunForCurrentChat(run)) clearRunTransientMessages(run);
      if (run.cancelling) {
        handleChatRunEvent(channelId, { kind: 'cancelled', agentId: outgoingAgentId, departmentId: outgoingDepartmentId });
        notify('已中止生成。', 'success');
      } else if (isRunForCurrentChat(run)) {
        state.messages.push({
          role: 'assistant',
          content: `执行失败：${userErrorMessage(error)}`,
          agentId: outgoingAgentId,
          departmentId: outgoingDepartmentId,
          createdAt: new Date().toISOString(),
        });
      }
    } finally {
      const runVisibleAtSettlement = state.currentTab === 'chat' && isRunForCurrentChat(run);
      if (isRunForCurrentChat(run)) clearRunTransientMessages(run);
      unregisterChatRun(run);
      if (!allChatRuns().length) stopRunStatusTimer();
      if (runVisibleAtSettlement) {
        render();
        scrollMessagesToBottom();
      } else if (activePrivateAssistantChat && state.privateAssistantResultUnread) {
        render();
      }
    }
  }

  async function sendChatMessage(message = '', {
    preserveComposer = true, executionModeChoice = null, clarificationResponse = null,
    planningRestartSourceMessageId = '',
  } = {}) {
    const cleanMessage = String(message || '').trim();
    if (!cleanMessage || chatComposerIsBlocked(state, currentChatRun)) return false;
    await sendChat({ preventDefault() {} }, {
      message: cleanMessage, preserveComposer, executionModeChoice, clarificationResponse, planningRestartSourceMessageId,
    });
    return true;
  }

  function buildChatContext(departmentId, agentId) {
    const project = activeProject();
    const projectContext = project ? {
      projectId: project.id || '',
      projectTitle: projectName(project),
      workspaceRoot: project.workspaceRoot || project.workspace_root || '',
      workspaceLabel: projectName(project) || workspaceDisplayLabel(),
    } : {};
    if (departmentId === 'collaboration') {
      return {
        mode: 'collaboration',
        type: 'collaboration',
        label: '部门协作',
        ...projectContext,
      };
    }
    if (departmentId !== 'ppt_department') return project ? { mode: 'project', type: 'project', ...projectContext } : null;
    const style = pptStyleOption(state.pptStyleId);
    const template = currentPptTemplate();
    return {
      type: 'ppt',
      ...projectContext,
      styleId: style.id,
      styleLabel: style.label,
      agentId: PPT_AGENT_ID,
      templateId: template.id,
      templateLabel: template.label,
      templatePath: template.path,
      templateSelection: 'explicit',
    };
  }


function initialRunOperationLabel(run = {}, { imageChat = false, attachments = [], fileReferences = [] } = {}) {
  if (run.departmentId === 'secretary_department') return 'uBuddy 正在理解任务';
  const hasImages = imageChat || (attachments || []).some((item) => String(item?.contentType || item?.type || '').startsWith('image/'));
  if (hasImages) return 'Clarifying image transfer method';
  if ((fileReferences || []).length) return 'Inspecting referenced project files';
  if (run.targetKind === 'collaboration' || run.departmentId === 'collaboration') return 'Mapping collaboration workflow';
  if (run.targetKind === 'private_assistant' || run.departmentId === 'private_assistant') return 'Preparing private assistant response';
  if (run.departmentId === 'ppt_department') return 'Structuring presentation request';
  if (run.targetKind === 'planning') return 'Planning implementation approach';
  return 'Understanding request';
}

  return { buildChatContext, sendChat, sendChatMessage };
}

function timelineMessages(timeline = {}, agentInstanceId = '') {
  return (Array.isArray(timeline?.items) ? timeline.items : []).map((item) => item.message ? {
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
