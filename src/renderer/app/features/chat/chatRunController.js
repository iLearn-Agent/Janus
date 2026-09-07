import { deriveTaskLifecycleProgress } from '../../../../shared/contracts/uBuddyDeliveryReview.js';
import { parseLocalFileReference, resolveLinkedMessageArtifact } from '../../utils/messageArtifactLinks.js';
import { clearAgentRunNotices as clearAgentRunNoticeState } from '../navigation/notificationState.js';

export function updateCodexHoverPreviewPlacement(row, { windowRef = globalThis.window } = {}) {
  const preview = row?.querySelector?.('.codex-change-hover-preview');
  if (!preview) return null;
  const messageList = row.closest?.('#message-list');
  row.classList.add('is-hover-positioned');
  row.classList.remove('is-preview-above');
  row.style?.removeProperty('--codex-hover-max-height');

  const rowRect = row.getBoundingClientRect?.();
  if (!rowRect) return null;
  const listRect = messageList?.getBoundingClientRect?.();
  const viewportHeight = Number(windowRef?.innerHeight || 0) || Number(listRect?.bottom || rowRect.bottom + 410);
  const boundaryTop = Math.max(0, Number(listRect?.top || 0));
  const boundaryBottom = Math.min(viewportHeight, Number(listRect?.bottom || viewportHeight));
  const spaceAbove = Math.max(0, rowRect.top - boundaryTop);
  const spaceBelow = Math.max(0, boundaryBottom - rowRect.bottom);
  const desiredHeight = Math.min(410, Math.max(96, Number(preview.scrollHeight || preview.getBoundingClientRect?.().height || 410)));
  const openAbove = spaceBelow < desiredHeight + 8 && spaceAbove > spaceBelow;
  const availableHeight = openAbove ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(96, Math.min(410, Math.floor(availableHeight - 8)));
  row.classList.toggle('is-preview-above', openAbove);
  row.style?.setProperty('--codex-hover-max-height', `${maxHeight}px`);
  return { openAbove, maxHeight, spaceAbove, spaceBelow };
}

function clearCodexHoverPreviewPlacement(row) {
  if (!row) return;
  row.classList.remove('is-hover-positioned', 'is-preview-above');
  row.style?.removeProperty('--codex-hover-max-height');
}

export function codexReviewPortalSourceMounted(dialog, { documentRef = globalThis.document } = {}) {
  const sourceMessageId = String(dialog?.dataset?.codexReviewMessageId || '');
  if (!sourceMessageId || !documentRef?.querySelectorAll) return false;
  return [...documentRef.querySelectorAll('#message-list [data-message-id]')]
    .some((node) => String(node.dataset?.messageId || '') === sourceMessageId);
}

export function cleanupStaleCodexReviewPortal(dialog, { documentRef = globalThis.document } = {}) {
  if (!dialog || codexReviewPortalSourceMounted(dialog, { documentRef })) return false;
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  dialog.remove?.();
  return true;
}

export function mountCodexReviewPortal(trigger, { documentRef = globalThis.document, closeExisting = () => {} } = {}) {
  const template = documentRef?.getElementById?.(String(trigger?.dataset?.codexReviewOpen || ''));
  const sourceDialog = template?.content?.querySelector?.('[data-codex-review-dialog]');
  if (!sourceDialog) return null;
  documentRef.querySelectorAll?.('[data-codex-review-dialog][data-codex-review-portaled="true"]')
    .forEach((dialog) => closeExisting(dialog));
  const dialog = sourceDialog.cloneNode(true);
  dialog.dataset.codexReviewPortaled = 'true';
  if (documentRef.querySelector?.('.app-frame.theme-dark')) dialog.classList.add('theme-dark');
  documentRef.body?.append(dialog);
  return dialog;
}

export function createChatRunController({
  api,
  windowRef,
  documentRef,
  state,
  render,
  localizeRoot = () => {},
  translateText = (value) => String(value || ''),
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
  suspendMessageAutoFollow = () => {},
  isMessageInteractionActive = () => false,
  renderMessageList,
  renderMessagePatchSet = null,
  parsePreviewPayload,
  previewFileInfo,
  saveFileFromPayload,
  showFileFromPayload,
  openFileFromPayload,
  copyFilePath,
  openCollaborationTask,
  submitUBuddyClarificationAnswer = async () => false,
  openUBuddyContactPicker = () => {},
  handleTaskCardAction,
  copyCodeBlockText = () => {},
  copyMessageText,
  editMessageFromHistory,
  pathBasename,
  projectForSession,
  activeProject,
  scrollMessagesToBottom,
  imageModelOptions,
  runStatusRefreshMs,
  runUpdateThrottleMs,
  reportPerformance = () => {},
  setTimer = setTimeout,
  setRepeatingTimer = setInterval,
  clearRepeatingTimer = clearInterval,
}) {
  const IMAGE_MODEL_OPTIONS = imageModelOptions;
  const RUN_STATUS_REFRESH_MS = runStatusRefreshMs;
  const RUN_UPDATE_THROTTLE_MS = runUpdateThrottleMs;
  let runStatusTimer = null;
  let runUpdateTimer = null;
  let deferredRunPatchOptions = null;
  let codexReviewPanelWidth = 0;
  let lastSlowRunPatchReportAt = 0;
  const dirtyRunMessageIds = new Set();

  function markDirtyMessage(id = '') {
    const cleanId = String(id || '').trim();
    if (cleanId) dirtyRunMessageIds.add(cleanId);
  }

  function markDirtyMessageAtIndex(index = -1) {
    if (!Number.isInteger(index) || index < 0) return;
    markDirtyMessage(state.messages[index - 1]?.id);
    markDirtyMessage(state.messages[index]?.id);
    markDirtyMessage(state.messages[index + 1]?.id);
  }

  function markRunNoticeUnread(run, kind) {
    if (!run || isRunVisibleInCurrentChat(run)) return;
    run.unreadNotice = true;
    run.unreadNoticeKind = kind;
    run.unreadNoticeAt = Date.now();
  }

  function clearAgentRunNotices({ sessionId = '', agentId = '', agentInstanceId = '', channelId = '' } = {}) {
    return clearAgentRunNoticeState(state, { sessionId, agentId, agentInstanceId, channelId });
  }

  function handleChatRunEvent(channelId, event = {}) {
    const run = chatRunForChannel(channelId);
    if (!run || !event?.kind) return;
    const runInActiveAccount = runBelongsToActiveAccount(run);
    if (event.title) run.sessionTitle = event.title;
    const executionSessionId = String(event.executionSessionId || event.sessionId || '').trim();
    const eventDisplaySessionId = String(event.displaySessionId || '').trim();
    const replaceVisibleDisplaySession = Boolean(
      eventDisplaySessionId
      && run.displaySessionId
      && eventDisplaySessionId !== run.displaySessionId
      && isRunForCurrentChat(run),
    );
    if (eventDisplaySessionId && (!run.displaySessionId || replaceVisibleDisplaySession)) {
      run.displaySessionId = eventDisplaySessionId;
      run.sessionId = eventDisplaySessionId;
      if (replaceVisibleDisplaySession) {
        state.currentSessionId = eventDisplaySessionId;
        state.currentChatKey = `session:${eventDisplaySessionId}`;
      }
    }
    if (executionSessionId) {
      const sessionWasListed = state.sessions.some((item) => item.id === executionSessionId);
      run.executionSessionId = executionSessionId;
      if (!run.displaySessionId) {
        run.displaySessionId = executionSessionId;
        run.sessionId = executionSessionId;
      }
      if (runInActiveAccount
        && !state.currentSessionId
        && state.currentChatKey === run.chatKey
        && isRunForCurrentChat(run)) {
        state.currentSessionId = run.displaySessionId;
        state.currentChatKey = `session:${run.displaySessionId}`;
        state.contextUsage = null;
      }
      syncCurrentChatRun();
      if (runInActiveAccount) upsertRecentSession({
        id: executionSessionId,
        title: run.sessionTitle || run.userMessage || 'New chat',
        departmentId: event.departmentId || run.departmentId || 'general',
        agentId: event.agentId || run.agentId || '',
        agentInstanceId: event.agentInstanceId || event.agent_instance_id || run.agentInstanceId || run.agent_instance_id || '',
        projectId: run.projectId || '',
        workspaceRoot: run.workspaceRoot || '',
        interactionMode: run.interactionMode || '',
        updatedAt: new Date().toISOString(),
        pending: true,
      });
      if (!sessionWasListed && isRunVisibleInCurrentChat(run)) {
        const departmentId = event.departmentId || run.departmentId || 'general';
        if (run.projectId) expandProject(run.projectId);
        else if (departmentId === 'secretary_department') state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), tasks: true };
        else if (departmentId === 'collaboration') state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), collaboration: true };
        else state.sidebarSectionsOpen = { ...(state.sidebarSectionsOpen || {}), chats: true };
        render();
      }
    }
    if (event.agentId) run.agentId = event.agentId;
    if (event.departmentId) run.departmentId = event.departmentId;
    if (event.targetKind) run.targetKind = event.targetKind;
    if (event.taskRunId) run.taskRunId = event.taskRunId;
    if (event.taskType) run.taskType = event.taskType;
    if (event.objective) run.objective = event.objective;
    if (event.blocker !== undefined) run.blocker = event.blocker;
    if (typeof event.pptArtifactPending === 'boolean') {
      run.pptArtifactPending = event.pptArtifactPending;
      if (event.pptArtifactPending && !run.pptArtifactStartedAt) run.pptArtifactStartedAt = Date.now();
    }

    if (event.kind === 'managed-provider-usage') {
      state.managedProviderUsage = event.usage
        ? { ...(state.managedProviderUsage || {}), ...event.usage }
        : state.managedProviderUsage;
      renderRunUpdate(run);
      return;
    }

    if (event.kind === 'private-assistant-usage') {
      state.privateAssistant = event.usage || state.privateAssistant;
      renderRunUpdate(run);
      return;
    }

    if (event.kind === 'approval-request') {
      run.runId = event.runId || run.runId;
      run.approvalRequest = {
        ...event,
        approvalId: String(event.approvalId || event.itemId || `approval-${run.channelId}`),
      };
      run.approvalSubmitting = false;
      markRunNoticeUnread(run, 'request');
      upsertRunProcessEvent(run, {
        activityId: event.itemId || event.approvalId || `approval-${run.channelId}`,
        activityType: 'approval',
        eventOrigin: 'codex',
        approvalType: event.command ? 'command' : 'operation',
        status: 'waiting',
        title: '需要确认一项操作',
        detail: event.reason || 'Janus 请求批准本次操作。',
        command: event.command || '',
        cwd: event.cwd || '',
      });
      upsertProcessTimeline(run, true);
      updateRunStatusMessage(run, 'waiting', 'Janus 正在等待你确认一项操作');
      syncCurrentChatRun();
      render();
      return;
    }

    if (event.kind === 'user-input-request') {
      const shouldFollowQuestionAtBottom = captureMessageScrollState()?.follow === true;
      run.runId = event.runId || run.runId;
      run.userInputRequest = {
        requestId: String(event.requestId || ''),
        itemId: String(event.itemId || ''),
        questions: Array.isArray(event.questions) ? event.questions : [],
        autoResolutionMs: Math.max(0, Number(event.autoResolutionMs || 0)),
      };
      run.userInputSubmitting = false;
      run.userInputError = '';
      run.userInputQuestionIndex = 0;
      run.userInputDraftAnswers = {};
      run.userInputSkippedQuestionIds = [];
      run.userInputExternal = false;
      markRunNoticeUnread(run, 'question');
      upsertRunProcessEvent(run, {
        activityId: event.itemId || event.requestId || `user-input-${run.channelId}`,
        activityType: 'status',
        eventOrigin: 'janus',
        status: 'waiting',
        title: '等待补充信息',
        detail: '选择会用于细化实施计划，不会开始修改文件。',
      });
      upsertProcessTimeline(run, true);
      updateRunStatusMessage(run, 'waiting', '计划存在需要你确认的选项');
      syncCurrentChatRun();
      render();
      settleQuestionScrollAtBottom(run, shouldFollowQuestionAtBottom);
      return;
    }

    if (event.kind === 'user-input-resolved') {
      if (!run.userInputRequest || !event.requestId || run.userInputRequest.requestId === event.requestId) {
        const activityId = event.itemId || run.userInputRequest?.itemId || event.requestId || `user-input-${run.channelId}`;
        run.userInputRequest = null;
        run.userInputSubmitting = false;
        run.userInputError = '';
        run.userInputExternal = false;
        run.userInputQuestionIndex = 0;
        run.userInputDraftAnswers = {};
        run.userInputSkippedQuestionIds = [];
        upsertRunProcessEvent(run, {
          activityId,
          activityType: 'status',
          eventOrigin: 'janus',
          status: event.source === 'cancelled' ? 'cancelled' : 'completed',
          title: event.source === 'auto' ? '已采用推荐选项' : event.source === 'cancelled' ? '补充信息已取消' : '补充信息已确认',
          detail: event.source === 'cancelled' ? '本次信息补充已停止。' : 'Janus 正在根据选择继续当前任务。',
        });
        upsertProcessTimeline(run, true);
        if (event.source !== 'cancelled') updateRunStatusMessage(run, 'working', '选项已确认，正在继续处理');
        syncCurrentChatRun();
        render();
      }
      return;
    }

    if (event.kind === 'plan') {
      run.runId = event.runId || run.runId;
      run.plan = event.plan || null;
      if (event.title) run.sessionTitle = event.title;
      run.taskProgress = null;
      updateRunStatusMessage(run, 'planning', run.targetKind === 'secretary'
        || run.departmentId === 'secretary_department'
        ? 'uBuddy 正在规划执行步骤'
        : '正在规划执行步骤');
      upsertProcessTimeline(run, true);
      renderRunUpdate(run);
      return;
    }

    if (event.kind === 'plan-update') {
      const nativeSteps = (event.plan || []).map((item, index) => ({
        id: `native-plan-${index + 1}`,
        label: item.step || `步骤 ${index + 1}`,
        detail: '',
        status: item.status === 'inProgress' ? 'active' : item.status === 'completed' ? 'completed' : 'pending',
      }));
      run.plan = {
        ...(run.plan || {}),
        mode: 'plan',
        complexity: nativeSteps.length > 3 ? 'complex' : 'moderate',
        confidence: run.plan?.confidence || 1,
        rationale: event.explanation || run.plan?.rationale || 'Janus 正在更新执行步骤。',
        steps: nativeSteps,
      };
      updateRunStatusMessage(run, 'planning', 'Janus 已更新实施计划');
      renderRunUpdate(run);
      return;
    }

    if (event.kind === 'goal-update') {
      run.goal = event.goal || null;
      const goalSessionId = run.executionSessionId || run.displaySessionId || run.sessionId || '';
      if (goalSessionId) {
        upsertRecentSession({
          id: goalSessionId,
          goal: event.goal || null,
          interactionMode: event.goal ? 'goal' : run.interactionMode === 'goal' ? '' : run.interactionMode,
          updatedAt: new Date().toISOString(),
        });
      }
      const status = event.goal?.status;
      if (event.goal && !run.assistantContent) {
        updateRunStatusMessage(run, 'working', status === 'paused' ? '目标已暂停' : status === 'blocked' ? '目标遇到阻塞' : 'Janus 正在持续推进目标');
        renderRunUpdate(run);
      }
      return;
    }

    if (event.kind === 'start') {
      run.runId = event.runId || run.runId;
      const startMessage = run.targetKind === 'agent-delivery'
        ? String(event.message || run.lastStatusText || 'Background agent accepted the task')
        : runOperationFallback(run, 'queued');
      updateRunStatusMessage(run, 'queued', startMessage);
      renderRunUpdate(run);
      return;
    }
    if (event.kind === 'routing') {
      const detail = routeDetailForEvent(event, run);
      updateRunStatusMessage(run, 'routing', detail);
      renderRunUpdate(run);
      return;
    }
    if (event.kind === 'activity') {
      upsertRunProcessEvent(run, event);
      if (isGenericModelConnectionActivity(event)) run.hideInlineRunStatus = true;
      const operation = activeRunOperationLabel(run) || runOperationFallback(run, 'working');
      if (!run.finalAnswerStarted || run.pptArtifactPending) updateRunStatusMessage(run, event.status || 'working', operation);
      upsertProcessTimeline(run, !run.finalAnswerStarted || run.pptArtifactPending);
      if (run.finalAnswerStarted && !run.pptArtifactPending) markProcessSettled(run);
      renderRunUpdate(run);
      return;
    }
    if (event.kind === 'progress' || event.kind === 'heartbeat' || event.kind === 'task-progress') {
      const fallback = event.kind === 'heartbeat'
        ? heartbeatStatusLabel(run, event)
        : 'Janus agent 正在处理';
      if (event.taskProgress) run.taskProgress = event.taskProgress;
      if (event.activeNodes) run.activeNodes = event.activeNodes;
      if (event.kind === 'task-progress') {
        run.taskSnapshot = {
          taskRunId: event.taskRunId || run.taskRunId,
          taskStatus: event.taskStatus || run.taskSnapshot?.taskStatus || '',
          phase: event.phase || run.taskSnapshot?.phase || event.stage || 'executing',
          progress: event.taskProgress || event.progress || run.taskProgress || null,
          activeNodes: event.activeNodes || [],
          changedNodes: event.changedNodes || [],
          resultState: event.resultState || '',
          deliverable: event.deliverable || null,
          technicalDetails: event.technicalDetails || null,
          coordination: event.coordination || event.coordinationSnapshot || run.taskSnapshot?.coordination || null,
        };
        mergeProgressMilestones(run, event);
      } else if (event.taskType || event.objective) {
        mergeProgressMilestones(run, event);
      }
      if (event.pptProgress) {
        const nextPptProgress = event.pptProgress.phase === 'heartbeat' && run.pptProgress
          ? {
              ...run.pptProgress,
              message: event.pptProgress.message || run.pptProgress.message,
              elapsedMinutes: event.pptProgress.elapsedMinutes || run.pptProgress.elapsedMinutes || 0,
            }
          : event.pptProgress;
        run.pptProgress = {
          ...nextPptProgress,
          overallPercent: Math.max(
            Number(run.pptProgress?.overallPercent || 0),
            Number(nextPptProgress.overallPercent || 0),
          ),
        };
      }
      const keepPptProgressVisible = run.departmentId === 'ppt_department'
        && (run.pptArtifactPending || Boolean(run.pptProgress));
      if (!run.assistantContent || keepPptProgressVisible) {
        updateRunStatusMessage(run, event.stage || 'working', progressDetailForEvent(run, event, fallback));
      }
      renderRunUpdate(run);
      return;
    }
    if (event.kind === 'token') {
      if (!event.content) return;
      run.assistantContent += event.content;
      run.assistantStreaming = true;
      if (!run.pptArtifactPending) run.finalAnswerStarted = true;
      if (!run.pptArtifactPending) markProcessSettled(run);
      removeTransientMessage(run.statusMessageId);
      run.statusMessageId = '';
      upsertAssistantStream(run, run.assistantContent, true);
      renderRunUpdate(run);
      return;
    }
    if (event.kind === 'answer') {
      if (!event.content) return;
      run.assistantContent = event.content;
      run.assistantStreaming = event.streaming !== false;
      if (!run.pptArtifactPending) run.finalAnswerStarted = true;
      if (!run.pptArtifactPending) markProcessSettled(run);
      if (run.departmentId === 'ppt_department' && run.pptArtifactPending) {
        updateRunStatusMessage(run, 'working', '页面结构已完成，正在启动 PPTX 生成与校验');
      } else {
        removeTransientMessage(run.statusMessageId);
        run.statusMessageId = '';
      }
      upsertAssistantStream(run, run.assistantContent, run.assistantStreaming);
      if (run.departmentId === 'ppt_department' && run.pptArtifactPending) {
        moveMessageToEnd(run.statusMessageId);
      }
      renderRunUpdate(run);
      return;
    }
    if (event.kind === 'done') {
      run.terminal = true;
      if (event.interactionMode) run.interactionMode = event.interactionMode;
      if (event.plan) run.plan = event.plan;
      run.approvalRequest = null;
      run.approvalSubmitting = false;
      run.userInputRequest = null;
      run.userInputSubmitting = false;
      run.userInputError = '';
      run.userInputExternal = false;
      run.userInputQuestionIndex = 0;
      run.userInputDraftAnswers = {};
      run.userInputSkippedQuestionIds = [];
      run.failed = false;
      run.pptArtifactPending = false;
      markRunNoticeUnread(run, 'completed');
      if (run.targetKind === 'private_assistant' && !isRunVisibleInCurrentChat(run)) {
        state.privateAssistantResultUnread = true;
      }
      if (event.privateAssistantUsage) state.privateAssistant = event.privateAssistantUsage;
      if (event.answer) run.assistantContent = event.answer;
      run.outputArtifacts = Array.isArray(event.outputArtifacts) ? event.outputArtifacts : [];
      run.assistantStreaming = false;
      if (run.taskRunId) {
        updateRunStatusMessage(run, 'completed', `协作已完成：${run.taskProgress?.completed || 0}/${run.taskProgress?.total || 0} 个节点完成`);
        const statusMessage = state.messages.find((message) => message.id === run.statusMessageId);
        if (statusMessage) statusMessage.metadata = { ...(statusMessage.metadata || {}), terminal: true };
      } else {
        removeTransientMessage(run.statusMessageId);
        run.statusMessageId = '';
      }
      markProcessSettled(run);
      if (run.assistantContent) upsertAssistantStream(run, run.assistantContent, false);
      const artifactError = String(event.artifactError || '').trim();
      if (artifactError && isRunForCurrentChat(run)) {
        const artifactErrorId = `run-${channelId}-artifact-error`;
        const existing = state.messages.find((message) => message.id === artifactErrorId);
        const message = {
          id: artifactErrorId,
          role: 'assistant',
          content: artifactError,
          agentId: run.agentId,
          departmentId: run.departmentId,
          createdAt: new Date().toISOString(),
          metadata: {
            pptRenderFailed: true,
            retryable: true,
            errorCode: event.artifactErrorCode || 'ppt_render_failed',
            errorDetail: event.artifactErrorDetail || '',
          },
        };
        if (existing) Object.assign(existing, message);
        else state.messages.push(message);
        markDirtyMessage(artifactErrorId);
      }
      renderRunUpdate(run);
      return;
    }
    if (event.kind === 'cancelled') {
      run.terminal = true;
      run.approvalRequest = null;
      run.approvalSubmitting = false;
      run.userInputRequest = null;
      run.userInputSubmitting = false;
      run.userInputError = '';
      run.userInputExternal = false;
      run.failed = false;
      run.cancelled = true;
      run.assistantStreaming = false;
      run.pptArtifactPending = false;
      removeTransientMessage(run.statusMessageId);
      run.statusMessageId = '';
      upsertRunProcessEvent(run, {
        activityId: `cancelled-${run.channelId}`,
        activityType: 'status',
        status: 'cancelled',
        title: '执行已中断',
        detail: event.message || '处理已停止，以上过程记录均已保留。',
      });
      upsertProcessTimeline(run, false);
      markProcessSettled(run, { status: 'cancelled', expanded: true });
      if (run.assistantContent) {
        run.assistantStreaming = false;
        upsertAssistantStream(run, run.assistantContent, false);
        const assistantMessage = state.messages.find((message) => message.id === run.assistantMessageId);
        if (assistantMessage) assistantMessage.metadata = { ...(assistantMessage.metadata || {}), interrupted: true };
      }
      renderRunUpdate(run);
      return;
    }
    if (event.kind === 'error') {
      run.terminal = true;
      run.approvalRequest = null;
      run.approvalSubmitting = false;
      run.userInputRequest = null;
      run.userInputSubmitting = false;
      run.userInputError = '';
      run.userInputExternal = false;
      run.failed = true;
      run.assistantStreaming = false;
      run.pptArtifactPending = false;
      markRunNoticeUnread(run, 'failed');
      if (run.targetKind === 'private_assistant' && !isRunVisibleInCurrentChat(run)) {
        state.privateAssistantResultUnread = true;
      }
      if (isRunForCurrentChat(run)) {
        upsertRunProcessEvent(run, {
          activityId: `failed-${run.channelId}`,
          activityType: 'status',
          status: 'failed',
          title: '执行失败',
          detail: userVisibleErrorMessage(event.message || '回复生成失败'),
        });
        upsertProcessTimeline(run, false);
        clearRunTransientMessages(run, { processStatus: 'failed', processExpanded: true });
        const errorMessageId = `run-${channelId}-error`;
        state.messages.push({
          id: errorMessageId,
          role: 'assistant',
          content: `执行失败：${userVisibleErrorMessage(event.message || '回复生成失败')}`,
          agentId: run.agentId,
          departmentId: run.departmentId,
        });
        markDirtyMessage(errorMessageId);
      }
      renderRunUpdate(run);
    }
  }

  async function resolveChatApprovalDecision(channelId, approved) {
    const run = chatRunForChannel(channelId);
    const event = run?.approvalRequest || {};
    if (!run || !event.approvalId || run.approvalSubmitting) return;
    const command = String(event.command || '').trim();
    const target = String(event.grantRoot || event.cwd || '').trim();
    run.approvalSubmitting = true;
    syncCurrentChatRun();
    render();
    try {
      const result = await api.resolveChatApproval?.({
        channelId,
        runId: event.runId || run.runId || '',
        approvalId: event.approvalId || '',
        approved,
      });
      if (!result?.ok) throw new Error(result?.reason || '审批请求已经失效。');
      if (run.approvalRequest?.approvalId === event.approvalId) run.approvalRequest = null;
      run.approvalSubmitting = false;
      upsertRunProcessEvent(run, {
        activityId: event.itemId || event.approvalId || `approval-${run.channelId}`,
        activityType: 'approval',
        eventOrigin: 'codex',
        approvalType: event.command ? 'command' : 'operation',
        status: approved ? 'running' : 'cancelled',
        title: approved ? '操作已确认' : '操作未获批准',
        detail: event.reason || '',
        decision: approved ? '仅批准本次' : '拒绝',
        command,
        cwd: target,
      });
      upsertProcessTimeline(run, true);
      updateRunStatusMessage(run, approved ? 'working' : 'waiting', approved ? '已确认本次操作，Janus 继续执行' : '已拒绝本次操作，Janus 将调整方案');
      syncCurrentChatRun();
      render();
    } catch (error) {
      run.approvalSubmitting = false;
      notify(`提交审批结果失败：${error.message || error}`, 'error');
      syncCurrentChatRun();
      render();
    }
  }

  async function submitChatUserInput(event, form, { captureCurrent = true } = {}) {
    event.preventDefault();
    if (form.querySelector('[data-ime-composing="true"]')) return;
    const run = currentChatRun();
    const request = run?.userInputRequest;
    if (!run || !request || request.requestId !== form.dataset.chatUserInputForm || run.userInputSubmitting) return;
    if (Number(run.userInputQuestionIndex || 0) < request.questions.length - 1) {
      if (captureCurrent) advanceChatUserInputSelection(event, form);
      return;
    }
    if (captureCurrent && !captureCurrentChatUserInputAnswer(run, request, form, { required: true })) return;
    const skippedQuestionIds = new Set(run.userInputSkippedQuestionIds || []);
    const answers = Object.fromEntries((request.questions || []).map((question) => [
      question.id,
      run.userInputDraftAnswers?.[question.id] || { answers: [] },
    ]));
    const missing = (request.questions || []).find((question) => (
      !answers[question.id]?.answers?.length && !skippedQuestionIds.has(question.id)
    ));
    if (missing) {
      run.userInputQuestionIndex = Math.max(0, request.questions.findIndex((question) => question.id === missing.id));
      run.userInputError = `请完成“${missing.header || missing.question}”后再继续。`;
      render();
      return;
    }
    run.userInputSubmitting = true;
    run.userInputError = '';
    const submitButton = form.querySelector('[data-chat-user-input-submit], [data-chat-user-input-skip]');
    const submitButtonText = submitButton?.textContent || '跳过';
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = translateText('正在提交…');
    }
    try {
      const result = await api.resolveChatUserInput?.({
        channelId: run.channelId,
        runId: run.runId || '',
        requestId: request.requestId,
        answers,
        skippedQuestionIds: [...skippedQuestionIds],
      });
      if (!result?.ok) throw new Error(result?.reason || '补充信息请求已经失效。');
      if (run.userInputRequest?.requestId === request.requestId) run.userInputRequest = null;
      run.userInputSubmitting = false;
      run.userInputDraftAnswers = {};
      run.userInputSkippedQuestionIds = [];
      run.userInputQuestionIndex = 0;
      syncCurrentChatRun();
      render();
    } catch (error) {
      run.userInputSubmitting = false;
      run.userInputError = error.message || String(error);
      const errorBox = form.querySelector('[data-chat-user-input-error]');
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = translateText(`提交失败：${run.userInputError}`);
      }
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = submitButtonText;
      }
    }
  }

  function navigateChatUserInput(event, form, direction = 1) {
    event.preventDefault();
    const run = currentChatRun();
    const request = run?.userInputRequest;
    if (!run || !request || request.requestId !== form.dataset.chatUserInputForm || run.userInputSubmitting) return;
    if (direction > 0 && !captureCurrentChatUserInputAnswer(run, request, form, { required: true })) return;
    if (direction < 0) captureCurrentChatUserInputAnswer(run, request, form, { required: false });
    const maxIndex = Math.max(0, request.questions.length - 1);
    run.userInputQuestionIndex = Math.max(0, Math.min(maxIndex, Number(run.userInputQuestionIndex || 0) + direction));
    run.userInputError = '';
    syncCurrentChatRun();
    render();
  }

  function advanceChatUserInputSelection(event, form) {
    event?.preventDefault?.();
    const run = currentChatRun();
    const request = run?.userInputRequest;
    if (!run || !request || request.requestId !== form.dataset.chatUserInputForm || run.userInputSubmitting) return;
    if (!captureCurrentChatUserInputAnswer(run, request, form, { required: true })) return;
    if (Number(run.userInputQuestionIndex || 0) >= request.questions.length - 1) {
      void submitChatUserInput({ preventDefault() {} }, form, { captureCurrent: false });
      return;
    }
    run.userInputQuestionIndex += 1;
    run.userInputError = '';
    syncCurrentChatRun();
    render();
  }

  function skipCurrentChatUserInput(event, form) {
    event.preventDefault();
    const run = currentChatRun();
    const request = run?.userInputRequest;
    if (!run || !request || request.requestId !== form.dataset.chatUserInputForm || run.userInputSubmitting) return;
    const question = request.questions[Number(run.userInputQuestionIndex || 0)];
    if (!question) return;
    run.userInputSkippedQuestionIds = [...new Set([...(run.userInputSkippedQuestionIds || []), question.id])];
    if (run.userInputDraftAnswers) delete run.userInputDraftAnswers[question.id];
    if (Number(run.userInputQuestionIndex || 0) >= request.questions.length - 1) {
      void submitChatUserInput(event, form, { captureCurrent: false });
      return;
    }
    run.userInputQuestionIndex += 1;
    run.userInputError = '';
    syncCurrentChatRun();
    render();
  }

  function captureCurrentChatUserInputAnswer(run, request, form, { required = true } = {}) {
    const field = form.querySelector('[data-user-input-question]');
    const questionId = String(field?.dataset.userInputQuestion || '');
    const question = request.questions.find((item) => String(item.id || '') === questionId);
    if (!field || !question) return !required;
    let answer = '';
    if (Array.isArray(question.options) && question.options.length) {
      const selected = field.querySelector('input[type="radio"]:checked');
      answer = selected?.value === '__other__'
        ? String(field.querySelector('[data-user-input-other]')?.value || '').trim()
        : String(selected?.value || '').trim();
    } else {
      answer = String(field.querySelector('[data-user-input-text]')?.value || '').trim();
    }
    if (!answer) {
      if (!required) return false;
      run.userInputError = `请完成“${question.header || question.question}”后再继续。`;
      const errorBox = form.querySelector('[data-chat-user-input-error]');
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = translateText(run.userInputError);
      }
      field.querySelector('input, textarea')?.focus();
      return false;
    }
    run.userInputDraftAnswers = {
      ...(run.userInputDraftAnswers || {}),
      [question.id]: { answers: [answer] },
    };
    run.userInputSkippedQuestionIds = (run.userInputSkippedQuestionIds || []).filter((id) => id !== question.id);
    run.userInputError = '';
    return true;
  }

  function routeDetailForEvent(event, run = {}) {
    if (event.targetKind === 'image') {
      if (event.automaticRoute && event.reason) return event.reason;
      return `${assignmentLabelForRun({ ...run, ...event })} 已接手图像任务`;
    }
    if (event.targetKind === 'collaboration') return 'Mapping collaboration workflow';
    if (event.targetKind === 'normal') return 'Understanding request';
    if (event.targetKind === 'private_assistant') return 'Preparing private assistant response';
    if (event.targetKind === 'secretary' || run.departmentId === 'secretary_department') {
      return event.reason || 'uBuddy 正在选择合适的 Agent';
    }
    const assignment = assignmentLabelForRun({ ...run, ...event });
    return assignment ? `已分配给 ${assignment}` : (event.reason || '已完成路由');
  }

  function progressDetailForEvent(run, event = {}, fallback = 'Working through request') {
    if (run.departmentId === 'ppt_department' && run.pptProgress) {
      return pptProgressDetail(run.pptProgress, event);
    }
    const operation = activeRunOperationLabel(run);
    if (operation) return operation;
    const completed = agentNamesFromEvent(event, ['completedAgents', 'doneAgents', 'finishedAgents']);
    if (completed.length) return `Completed: ${completed.join(', ')}`;
    return friendlyProgressMessage(run, event, fallback);
  }

  function pptProgressDetail(progress = {}, event = {}) {
    const current = Math.max(0, Number(progress.currentSlide || 0));
    const total = Math.max(0, Number(progress.totalSlides || 0));
    const phase = String(progress.phase || 'render');
    const attempt = Math.max(1, Number(progress.attempt || 1));
    const phaseLabels = {
      parse: '正在整理页面计划',
      image: '正在生成页面配图',
      render: '正在制作页面',
      repair: `第 ${attempt} 轮排版修复`,
      qa: '正在检查排版和视觉质量',
      preview: '正在生成 PPT 预览',
      heartbeat: 'PPT 仍在生成和校验',
    };
    const base = String(progress.message || phaseLabels[phase] || '正在制作 PPT');
    if (event.kind !== 'heartbeat') return base;
    const elapsed = Math.max(0, Number(event.elapsed || 0));
    const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}min ${elapsed % 60}s` : `${elapsed}s`;
    if (current > 0 && total > 0) return `第 ${current}/${total} 页 · ${phaseLabels[phase] || base} · 已处理 ${elapsedLabel}`;
    return `${base} · 已处理 ${elapsedLabel}`;
  }

  function friendlyProgressMessage(run = {}, event = {}, fallback = 'Working through request') {
    const raw = String(event.message || '').trim();
    if (raw && !isGenericElapsedMessage(raw) && !isGenericRouteStatus(raw)) return stripRunStatusPrefix(raw);
    if (event.kind === 'heartbeat') return heartbeatStatusLabel(run, event);
    return activeRunOperationLabel(run) || fallback;
  }

  function isGenericElapsedMessage(message = '') {
    return /运行中\s*\d+s?$/.test(message) || /^Janus agent 运行中/.test(message);
  }

  function isGenericRouteStatus(message = '') {
    return /^(普通聊天|智能规划|部门协作|私人助理|图像生成|Janus agent)[：:].*(正在建立连接|已接收请求|正在处理)/.test(message);
  }

  function isGenericModelConnectionActivity(event = {}) {
    return String(event.activityType || '') === 'status'
      && ['模型已连接，正在处理', '模型连接状态更新'].includes(String(event.title || '').trim());
  }

  function suppressInlineRunStatus(run = {}) {
    return run.hideInlineRunStatus === true
      && !run.taskRunId
      && !(run.departmentId === 'ppt_department' && (run.pptArtifactPending || run.pptProgress));
  }

  function stripRunStatusPrefix(message = '') {
    return String(message || '').replace(/^(普通聊天|智能规划|部门协作|私人助理|图像生成(?:\s*\/\s*[^：:]+)?|Janus agent)[：:]\s*/, '').trim();
  }

  function heartbeatStatusLabel(run = {}, event = {}) {
    const operation = activeRunOperationLabel(run);
    if (operation) return operation;
    const elapsed = Number(event.elapsed ?? run.elapsed ?? 0);
    const stage = event.stage || run.lastStatusStage || 'working';
    if (run.targetKind === 'secretary' || run.departmentId === 'secretary_department') {
      if (stage === 'intake') return 'uBuddy 正在确认任务目标、交付物和约束';
      if (stage === 'routing') return 'uBuddy 正在选择合适的 Agent';
      if (stage === 'planning') return 'uBuddy 正在规划执行步骤';
      if (stage === 'dispatching') return 'uBuddy 正在创建任务并安排执行';
      return 'uBuddy 正在处理请求';
    }
    if (stage === 'queued') return runOperationFallback(run, 'queued');
    if (stage === 'routing') return 'Selecting execution route';
    if (run.targetKind === 'image' || run.departmentId === 'image_generation') {
      if (elapsed < 12) return 'Clarifying image transfer method';
      if (elapsed < 45) return 'Preparing inline image delivery';
      return 'Refining visual output';
    }
    if (run.targetKind === 'collaboration' || run.departmentId === 'collaboration') {
      if (elapsed < 12) return 'Breaking down collaboration task';
      if (elapsed < 45) return 'Coordinating department workflow';
      return 'Summarizing collaboration progress';
    }
    if (run.departmentId === 'ppt_department') {
      if (elapsed < 12) return 'Structuring presentation request';
      if (elapsed < 45) return 'Drafting slide content';
      return 'Polishing presentation output';
    }
    if (elapsed < 12) return 'Understanding request';
    if (elapsed < 45) return 'Reasoning through response';
    return 'Working through complex request';
  }

  function runStatusPrefix(run = {}) {
    const assignment = assignmentLabelForRun(run);
    if (!assignment || assignment === 'Janus agent') return '';
    return `${assignment}：`;
  }


  function activeRunOperationLabel(run = {}) {
    const events = Array.isArray(run.processEvents) ? run.processEvents : [];
    const active = [...events].reverse().find((event) => {
      const status = String(event.status || '').trim();
      return !['completed', 'cancelled', 'failed'].includes(status) && String(event.title || '').trim();
    });
    const event = active || [...events].reverse().find((item) => String(item.title || '').trim());
    const title = String(event?.title || '').trim();
    if (!title || title === '处理过程') return '';
    return stripRunStatusPrefix(title);
  }

  function runOperationFallback(run = {}, stage = 'working') {
    if (run.targetKind === 'secretary' || run.departmentId === 'secretary_department') {
      if (stage === 'routing') return 'uBuddy 正在选择合适的 Agent';
      if (stage === 'planning') return 'uBuddy 正在规划执行步骤';
      if (stage === 'dispatching') return 'uBuddy 正在创建任务并安排执行';
      return 'uBuddy 正在理解任务';
    }
    if (stage === 'routing') return 'Selecting execution route';
    if (run.targetKind === 'image' || run.departmentId === 'image_generation') return 'Clarifying image transfer method';
    if (run.targetKind === 'collaboration' || run.departmentId === 'collaboration') return 'Mapping collaboration workflow';
    if (run.targetKind === 'private_assistant' || run.departmentId === 'private_assistant') return 'Preparing private assistant response';
    if (run.departmentId === 'ppt_department') return 'Structuring presentation request';
    if (run.targetKind === 'planning') return 'Planning implementation approach';
    return 'Understanding request';
  }

  function assignmentLabelForRun(run = {}) {
    if (run.targetKind === 'planning') return '智能规划';
    if (run.targetKind === 'collaboration' || run.departmentId === 'collaboration') return '部门协作';
    if (run.targetKind === 'normal' || run.departmentId === 'general') return '普通聊天';
    if (run.targetKind === 'private_assistant' || run.departmentId === 'private_assistant') return '私人助理';
    if (run.targetKind === 'image' || run.departmentId === 'image_generation') {
      return `图像生成 / ${imageModelLabel(run.agentId || state.imageModel || 'gpt-image-2')}`;
    }
    const agent = run.agentId ? agentNameById(run.agentId) : '';
    const department = run.departmentId ? departmentName(run.departmentId) : '';
    if (agent && department) return `${department} / ${agent}`;
    return agent || department || 'Janus agent';
  }

  function agentNamesFromEvent(event = {}, keys = []) {
    const names = [];
    keys.forEach((key) => {
      const value = event[key];
      const entries = Array.isArray(value) ? value : value ? [value] : [];
      entries.forEach((entry) => {
        const raw = typeof entry === 'string'
          ? entry
          : entry?.agentId || entry?.agent_id || entry?.id || entry?.name || entry?.label || '';
        const name = raw ? agentNameById(raw) || raw : '';
        if (name && !names.includes(name)) names.push(name);
      });
    });
    return names;
  }

  function imageModelLabel(modelId) {
    const option = IMAGE_MODEL_OPTIONS.find(([id]) => id === modelId);
    return option?.[1] || String(modelId || 'GPT Image-2');
  }

  function updateRunStatusMessage(run, stage, content) {
    run.lastStatusStage = stage;
    run.lastStatusText = content;
    run.lastStatusAt = Date.now();
    if (suppressInlineRunStatus(run)) {
      removeTransientMessage(run.statusMessageId);
      run.statusMessageId = '';
      ensureRunStatusTimer();
      return;
    }
    const id = run.statusMessageId || `run-${run.channelId}-status`;
    run.statusMessageId = id;
    if (isRunForCurrentChat(run)) {
      upsertTransientMessage(run, 'run-status', {
        id,
        role: 'assistant',
        content,
        agentId: run.agentId,
        departmentId: run.departmentId,
        metadata: {
          transient: 'run-status',
          stage,
          taskProgress: run.taskProgress || null,
          activeNodes: run.activeNodes || [],
          pptProgress: visiblePptProgress(run),
          processEvents: (run.processEvents || []).map((item) => ({ ...item })),
          taskRunId: run.taskRunId || '',
          taskType: run.taskType || '',
          objective: run.objective || null,
          taskSnapshot: run.taskSnapshot || null,
          progressMilestones: (run.progressMilestones || []).map((item) => ({ ...item })),
          blocker: run.blocker || null,
          agentWorkStatusProjection: run.agentWorkStatusProjection || null,
          terminal: Boolean(run.terminal),
        },
      });
    }
    ensureRunStatusTimer();
  }

  function visiblePptProgress(run = {}) {
    if (run.pptProgress) return run.pptProgress;
    if (run.departmentId !== 'ppt_department' || !run.pptArtifactPending) return null;
    return {
      phase: 'parse',
      currentSlide: 0,
      totalSlides: 0,
      phaseCurrent: 0,
      phaseTotal: 1,
      overallPercent: 0,
      attempt: 1,
      message: run.lastStatusText || '正在启动 PPTX 生成与校验',
    };
  }

  function upsertAssistantStream(run, content, streaming) {
    const id = run.assistantMessageId || `run-${run.channelId}-answer`;
    run.assistantMessageId = id;
    if (!isRunForCurrentChat(run)) return;
    upsertTransientMessage(run, 'stream', {
      id,
      role: 'assistant',
      content,
      agentId: run.agentId,
      departmentId: run.departmentId,
      metadata: {
        transient: 'stream',
        streaming,
        ...(run.interactionMode ? { interactionMode: run.interactionMode } : {}),
        ...(run.interactionMode === 'plan' && run.plan ? { plan: run.plan } : {}),
        processEvents: (run.processEvents || []).map((item) => ({ ...item })),
        processDurationMs: Math.max(0, Date.now() - (run.startedAt || Date.now())),
        ...(Array.isArray(run.outputArtifacts) && run.outputArtifacts.length ? { outputArtifacts: run.outputArtifacts } : {}),
      },
    });
    ensureProcessBeforeAssistant(run);
  }

  function upsertRunProcessEvent(run, event = {}) {
    if (!Array.isArray(run.processEvents)) run.processEvents = [];
    const activityId = String(event.activityId || `activity-${run.processEvents.length + 1}`);
    const index = run.processEvents.findIndex((item) => item.activityId === activityId);
    const previous = index >= 0 ? run.processEvents[index] : null;
    const detail = String(event.detail || '');
    const output = String(event.output || '');
    const next = {
      ...previous,
      ...event,
      eventOrigin: String(event.eventOrigin || previous?.eventOrigin || (event.protocolEvents?.length ? 'codex' : 'janus')),
      activityId,
      activityType: String(event.activityType || previous?.activityType || 'activity'),
      status: String(event.status || previous?.status || 'running'),
      title: String(event.title || previous?.title || '处理过程'),
      detail: event.append ? `${previous?.detail || ''}${detail}` : detail || previous?.detail || '',
      command: String(event.command || previous?.command || ''),
      cwd: String(event.cwd || previous?.cwd || ''),
      output: event.appendOutput
        ? `${previous?.output || ''}${output}`
        : output || previous?.output || '',
      reasoningText: event.appendReasoningText
        ? `${previous?.reasoningText || ''}${event.reasoningText || ''}`
        : String(event.reasoningText || previous?.reasoningText || ''),
      summaryParts: Array.isArray(event.summaryParts) && event.summaryParts.length
        ? event.summaryParts
        : previous?.summaryParts || [],
      stageOutput: Boolean(event.stageOutput || previous?.stageOutput),
      nativeSource: String(event.nativeSource || previous?.nativeSource || ''),
      terminalInput: event.appendTerminalInput
        ? `${previous?.terminalInput || ''}${event.terminalInput || ''}`
        : String(event.terminalInput || previous?.terminalInput || ''),
      protocolEvents: mergeRunProtocolEvents(previous?.protocolEvents, event.protocolEvents),
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : previous?.exitCode ?? null,
      durationMs: Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : previous?.durationMs ?? null,
      startedAtMs: Number.isFinite(event.startedAtMs) ? event.startedAtMs : previous?.startedAtMs ?? null,
      completedAtMs: Number.isFinite(event.completedAtMs) ? event.completedAtMs : previous?.completedAtMs ?? null,
      summaryIndex: Number.isInteger(event.summaryIndex) ? event.summaryIndex : previous?.summaryIndex ?? null,
    };
    if (index >= 0) run.processEvents[index] = next;
    else run.processEvents.push(next);
  }

  function mergeRunProtocolEvents(previous = [], incoming = []) {
    const merged = [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(incoming) ? incoming : [])];
    const seen = new Set();
    return merged.filter((event) => {
      const key = String(event?.protocolEventId || [
        event?.threadId || '', event?.turnId || '', event?.itemId || '', event?.method || '',
        event?.emittedAtMs ?? '', event?.receivedAtMs ?? '', event?.sequence ?? '',
      ].join(':'));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => {
      const leftReceivedAt = Number(left?.receivedAtMs || 0);
      const rightReceivedAt = Number(right?.receivedAtMs || 0);
      if (leftReceivedAt && rightReceivedAt && leftReceivedAt !== rightReceivedAt) return leftReceivedAt - rightReceivedAt;
      return Number(left?.sequence || 0) - Number(right?.sequence || 0);
    }).slice(-200);
  }

  function upsertProcessTimeline(run, streaming = true) {
    if (!run.processEvents?.length || !isRunForCurrentChat(run)) return;
    const id = run.processMessageId || `run-${run.channelId}-process`;
    run.processMessageId = id;
    const existing = state.messages.find((message) => message.id === id);
    upsertTransientMessage(run, 'process', {
      id,
      role: 'assistant',
      content: '',
      agentId: run.agentId,
      departmentId: run.departmentId,
      metadata: {
        transient: 'process',
        processEvents: run.processEvents,
        streaming,
        processStatus: streaming
          ? ''
          : run.failed
            ? 'failed'
            : run.cancelled
              ? 'cancelled'
              : existing?.metadata?.processStatus || 'completed',
        expanded: existing?.metadata?.expanded ?? streaming,
        historyExpanded: existing?.metadata?.historyExpanded ?? run.processHistoryExpanded ?? false,
        historyVisibleCount: existing?.metadata?.historyVisibleCount ?? run.processHistoryVisibleCount ?? 20,
        startedAt: run.startedAt || Date.now(),
        durationMs: streaming ? 0 : Math.max(0, Date.now() - (run.startedAt || Date.now())),
      },
    });
    ensureProcessBeforeAssistant(run);
  }

  function ensureProcessBeforeAssistant(run = {}) {
    if (!run.processMessageId || !run.assistantMessageId) return;
    const processIndex = state.messages.findIndex((message) => message.id === run.processMessageId);
    const assistantIndex = state.messages.findIndex((message) => message.id === run.assistantMessageId);
    if (processIndex < 0 || assistantIndex < 0 || processIndex < assistantIndex) return;
    markDirtyMessageAtIndex(processIndex);
    markDirtyMessageAtIndex(assistantIndex);
    const [processMessage] = state.messages.splice(processIndex, 1);
    const nextAssistantIndex = state.messages.findIndex((message) => message.id === run.assistantMessageId);
    state.messages.splice(Math.max(0, nextAssistantIndex), 0, processMessage);
    markDirtyMessageAtIndex(state.messages.findIndex((message) => message.id === run.processMessageId));
    markDirtyMessageAtIndex(state.messages.findIndex((message) => message.id === run.assistantMessageId));
  }

  function upsertTransientMessage(run, kind, message) {
    const index = state.messages.findIndex((item) => item.id === message.id);
    const next = {
      ...message,
      metadata: {
        ...(message.metadata || {}),
        transient: kind,
      },
    };
    if (index >= 0) state.messages[index] = next;
    else state.messages.push(next);
    markDirtyMessage(message.id);
  }

  function removeTransientMessage(id) {
    if (!id) return;
    const index = state.messages.findIndex((message) => message.id === id);
    markDirtyMessageAtIndex(index);
    markDirtyMessage(id);
    state.messages = state.messages.filter((message) => message.id !== id);
  }

  function moveMessageToEnd(id) {
    if (!id) return;
    const index = state.messages.findIndex((message) => message.id === id);
    if (index < 0 || index === state.messages.length - 1) return;
    markDirtyMessageAtIndex(index);
    const [message] = state.messages.splice(index, 1);
    state.messages.push(message);
    markDirtyMessageAtIndex(state.messages.length - 1);
  }

  function clearRunTransientMessages(run, {
    removeDraft = false, removeAssistant = false, processStatus = '', processExpanded = null,
  } = {}) {
    if (!run) return;
    removeTransientMessage(run.statusMessageId);
    run.statusMessageId = '';
    run.lastStatusText = '';
    const settledStatus = processStatus || (run.failed ? 'failed' : run.cancelled ? 'cancelled' : 'completed');
    const keepProcessExpanded = processExpanded == null ? Boolean(run.failed || run.cancelled) : processExpanded;
    markProcessSettled(run, { status: settledStatus, expanded: keepProcessExpanded });
    if (removeAssistant) {
      removeTransientMessage(run.assistantMessageId);
      run.assistantMessageId = '';
      run.assistantContent = '';
    }
  }

  function ensureRunStatusVisible(run = state.activeChatRun) {
    if (suppressInlineRunStatus(run)) return false;
    const allowAlongsideAnswer = run?.departmentId === 'ppt_department'
      && (run?.pptArtifactPending || Boolean(run?.pptProgress));
    if (!run || !run.statusMessageId || (!allowAlongsideAnswer && run.assistantContent)) return false;
    if (!isRunForCurrentChat(run)) return false;
    if (state.messages.some((message) => message.id === run.statusMessageId)) return false;
    upsertTransientMessage(run, 'run-status', {
      id: run.statusMessageId,
      role: 'assistant',
      content: run.lastStatusText || heartbeatStatusLabel(run, { stage: run.lastStatusStage || 'working' }),
      agentId: run.agentId,
      departmentId: run.departmentId,
      metadata: {
        transient: 'run-status',
        stage: run.lastStatusStage || 'working',
        taskProgress: run.taskProgress || null,
        activeNodes: run.activeNodes || [],
        pptProgress: visiblePptProgress(run),
        processEvents: (run.processEvents || []).map((item) => ({ ...item })),
        taskRunId: run.taskRunId || '',
        taskType: run.taskType || '',
        objective: run.objective || null,
        taskSnapshot: run.taskSnapshot || null,
        progressMilestones: (run.progressMilestones || []).map((item) => ({ ...item })),
        blocker: run.blocker || null,
        agentWorkStatusProjection: run.agentWorkStatusProjection || null,
        terminal: Boolean(run.terminal),
      },
    });
    return true;
  }

  function restoreActiveRunTransient() {
    const runs = [state.activeChatRun, ...allChatRuns().filter((run) => run.nonBlocking && isRunForCurrentChat(run))]
      .filter((run, index, items) => run && items.indexOf(run) === index);
    let restored = false;
    for (const run of runs) restored = restoreRunTransient(run) || restored;
    return restored;
  }

  function restoreRunTransient(run) {
    if (!run || !isRunForCurrentChat(run)) return false;
    let restored = false;
    if (run.localUserMessage && !state.messages.some((message) => (
      message.id === run.localUserMessage.id
      || (message.role === 'user' && message.content === run.localUserMessage.content)
    ))) {
      state.messages.push(run.localUserMessage);
      markDirtyMessage(run.localUserMessage.id);
      restored = true;
    }
    if (run.processEvents?.length) {
      upsertProcessTimeline(run, !run.terminal && run.assistantStreaming !== false);
      restored = true;
    }
    if (run.assistantContent) {
      upsertAssistantStream(run, run.assistantContent, run.assistantStreaming !== false);
      restored = true;
    }
    return ensureRunStatusVisible(run) || restored;
  }

  function isRunForCurrentChat(run = {}) {
    if (!runBelongsToActiveAccount(run)) return false;
    const socialPeerId = String(state.networkConversationPeerId || '').trim();
    const nonAgentSurfaceVisible = Boolean(
      state.chatGroupId
      || state.collaborationGroupId
      || state.networkDelegationId
      || state.activeTaskWorkspaceKind
      || state.activeTaskWorkspaceId
      || state.networkConversationGroupId
      || (socialPeerId && socialPeerId !== 'self-secretary')
    );
    if (nonAgentSurfaceVisible) return false;
    const runChatKey = String(run.chatKey || '');
    const activeChatKey = String(state.currentChatKey || '');
    if (runChatKey.startsWith('agent:') && runChatKey === activeChatKey) return true;
    const displaySessionId = run.displaySessionId || run.sessionId || '';
    if (run.nonBlocking && state.currentSessionId) {
      return [displaySessionId, run.executionSessionId || run.workerSessionId || ''].includes(state.currentSessionId);
    }
    if (!displaySessionId || !state.currentSessionId) return !state.currentSessionId && run.chatKey === state.currentChatKey;
    return displaySessionId === state.currentSessionId;
  }

  function runBelongsToActiveAccount(run = {}) {
    // Workspace switch generations are renderer-lifecycle state. A run may
    // legitimately outlive one or more switches and must become visible again
    // when the user returns to the run's original workspace.
    return String(run.ownerUserId || state.currentUser?.id || '') === String(state.currentUser?.id || '')
      && String(run.accountWorkspaceId || 'workspace_personal')
        === String(state.activeAccountWorkspace?.id || 'workspace_personal');
  }

  function isRunVisibleInCurrentChat(run = {}) {
    return state.currentTab === 'chat' && isRunForCurrentChat(run);
  }

  function ensureRunStatusTimer() {
    if (runStatusTimer || !allChatRuns().length) return;
    runStatusTimer = setRepeatingTimer(() => {
      const runs = allChatRuns();
      if (!runs.length) {
        stopRunStatusTimer();
        return;
      }
      updateVisibleProcessDurations();
      for (const run of runs) {
        const keepPptRunActive = run.departmentId === 'ppt_department'
          && (run.pptArtifactPending || Boolean(run.pptProgress));
        if (run.assistantContent && !keepPptRunActive) continue;
        const elapsed = Math.max(0, Math.floor((Date.now() - (
          keepPptRunActive ? run.pptArtifactStartedAt || run.startedAt || Date.now() : run.startedAt || Date.now()
        )) / 1000));
        const heartbeatEvent = {
          stage: run.lastStatusStage || 'working',
          kind: 'heartbeat',
          elapsed,
        };
        const nextText = keepPptRunActive
          ? run.pptProgress
            ? pptProgressDetail(run.pptProgress, heartbeatEvent)
            : `PPTX 生成正在启动 · 已处理 ${elapsed}s`
          : heartbeatStatusLabel(run, heartbeatEvent);
        const missingStatus = isRunForCurrentChat(run) && !state.messages.some((message) => message.id === run.statusMessageId);
        if (nextText !== run.lastStatusText || missingStatus) {
          updateRunStatusMessage(run, run.lastStatusStage || 'working', nextText);
          renderRunUpdate(run);
        }
      }
    }, RUN_STATUS_REFRESH_MS);
  }

  function updateVisibleProcessDurations() {
    documentRef.querySelectorAll?.('[data-process-started-at] [data-process-duration]').forEach((label) => {
      const status = label.closest('[data-process-started-at]');
      const fixedDuration = Math.max(0, Number(status?.dataset?.processDurationMs || 0));
      const startedAt = Math.max(0, Number(status?.dataset?.processStartedAt || 0));
      const elapsedMs = fixedDuration || (startedAt ? Math.max(0, Date.now() - startedAt) : 0);
      const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      label.textContent = minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
    });
  }

  function restorePersistentDeliveryRuns(runs = [], sessionId = state.currentSessionId) {
    const cleanSessionId = String(sessionId || '').trim();
    const normalizedRuns = Array.isArray(runs) ? runs : [];
    state.agentDeliveryRunsBySession = {
      ...(state.agentDeliveryRunsBySession || {}),
      [cleanSessionId]: normalizedRuns,
    };
    for (const receipt of normalizedRuns) ensurePersistentDeliveryRun(receipt);
    syncCurrentChatRun();
    restoreActiveRunTransient();
  }

  function ensurePersistentDeliveryRun(receipt = {}) {
    const workId = String(receipt.workId || '').trim();
    if (!workId || !['queued', 'running'].includes(String(receipt.deliveryStatus || ''))) return null;
    let run = allChatRuns().find((item) => item.nonBlocking && item.workId === workId) || null;
    const events = Array.isArray(receipt.events) ? receipt.events : [];
    const latest = events.at(-1) || null;
    const latestPayload = latest?.payload || {};
    if (!run) {
      run = {
        channelId: `delivery:${workId}`,
        workId,
        nonBlocking: true,
        ownerUserId: receipt.userId || receipt.ownerUserId || state.currentUser?.id || '',
        accountWorkspaceId: receipt.workspaceId || receipt.accountWorkspaceId || 'workspace_personal',
        workspaceSwitchGeneration: Number(state.workspaceSwitchGeneration || 0),
        sessionId: receipt.sourceSessionId || '',
        displaySessionId: receipt.sourceSessionId || '',
        executionSessionId: receipt.targetSessionId || '',
        workerSessionId: receipt.targetSessionId || '',
        chatKey: '',
        departmentId: latestPayload.departmentId || '',
        agentId: latestPayload.agentId || receipt.metadata?.targetAgentId || '',
        userMessage: '',
        sessionTitle: receipt.metadata?.targetAgentName || '后台 Agent 任务',
        statusMessageId: `delivery-${workId}-status`,
        processMessageId: `delivery-${workId}-process`,
        assistantMessageId: '',
        assistantContent: '',
        assistantStreaming: false,
        processEvents: deliveryProcessEvents(events),
        targetKind: 'agent-delivery',
        startedAt: validTimestamp(receipt.metadata?.startedAt || receipt.createdAt),
        lastStatusStage: latest?.stage || (receipt.deliveryStatus === 'queued' ? 'queued' : 'working'),
        lastStatusText: latest?.message || receipt.metadata?.lastMessage || (receipt.deliveryStatus === 'queued' ? '任务正在等待后台 Agent 领取' : '后台 Agent 正在处理'),
        terminal: false,
        agentWorkStatusProjection: receipt.agentWorkStatusProjection || null,
      };
      state.chatRuns = [...allChatRuns(), run];
    } else {
      run.processEvents = deliveryProcessEvents(events);
      run.lastStatusStage = latest?.stage || run.lastStatusStage;
      run.lastStatusText = latest?.message || run.lastStatusText;
      run.executionSessionId = receipt.targetSessionId || run.executionSessionId;
      run.workerSessionId = receipt.targetSessionId || run.workerSessionId;
      run.departmentId = latestPayload.departmentId || run.departmentId;
      run.agentId = latestPayload.agentId || run.agentId;
      run.agentWorkStatusProjection = receipt.agentWorkStatusProjection || run.agentWorkStatusProjection || null;
    }
    updateRunStatusMessage(run, run.lastStatusStage || 'working', run.lastStatusText || '后台 Agent 正在处理');
    if (run.processEvents.length) upsertProcessTimeline(run, true);
    return run;
  }

  function deliveryProcessEvents(events = []) {
    return (Array.isArray(events) ? events : [])
      .filter((event) => !['heartbeat', 'done'].includes(event.kind))
      .map((event) => {
        const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        return {
          ...payload,
          activityId: String(payload.activityId || `delivery-${event.sequenceNo || event.id || Date.now()}`),
          activityType: String(payload.activityType || (event.kind === 'activity' ? 'activity' : 'status')),
          eventOrigin: String(payload.eventOrigin || (event.kind === 'activity' ? 'codex' : 'janus')),
          status: String(event.kind === 'error' ? 'failed' : payload.status || event.status || 'completed'),
          title: String(payload.title || deliveryEventTitle(event)),
          detail: String(payload.detail || event.message || ''),
          command: String(event.command || payload.command || ''),
          output: String(event.output || payload.output || ''),
        };
      })
      .slice(-80);
  }

  function deliveryEventTitle(event = {}) {
    if (event.kind === 'start') return '后台 Agent 已领取任务';
    if (event.kind === 'routing') return '任务路由';
    if (event.kind === 'error') return '执行失败';
    return '执行进度';
  }

  function validTimestamp(value = '') {
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  }

  function handleAgentDeliveryUpdate(payload = {}) {
    const receipt = payload.receipt || null;
    if (!receipt?.workId) return;
    const event = payload.event || null;
    if (event && ['queued', 'running'].includes(String(receipt.deliveryStatus || ''))) {
      const cached = cacheAgentDeliveryEvent(receipt, event);
      const run = ensurePersistentDeliveryRun(cached);
      if (run) {
        handleChatRunEvent(run.channelId, {
          ...(event.payload || {}),
          ...event,
          displaySessionId: receipt.sourceSessionId,
          executionSessionId: receipt.targetSessionId,
          workerSessionId: receipt.targetSessionId,
        });
      }
      return;
    }
    const run = allChatRuns().find((item) => item.nonBlocking && item.workId === receipt.workId);
    if (run) {
      if (isRunForCurrentChat(run)) {
        clearRunTransientMessages(run, { removeDraft: true, removeAssistant: true });
        removeTransientMessage(run.processMessageId);
        run.processMessageId = '';
        run.processEvents = [];
      }
      state.chatRuns = allChatRuns().filter((item) => item !== run);
      syncCurrentChatRun();
    }
    removeCachedAgentDeliveryRun(receipt.workId);
  }

  function cacheAgentDeliveryEvent(receipt = {}, event = {}) {
    let cachedReceipt = null;
    const nextBySession = { ...(state.agentDeliveryRunsBySession || {}) };
    for (const sessionId of [receipt.sourceSessionId, receipt.targetSessionId].filter(Boolean)) {
      const list = Array.isArray(nextBySession[sessionId]) ? [...nextBySession[sessionId]] : [];
      const index = list.findIndex((item) => item.workId === receipt.workId);
      const current = index >= 0 ? list[index] : { ...receipt, events: [] };
      const events = [...(current.events || [])];
      if (!events.some((item) => Number(item.sequenceNo || 0) === Number(event.sequenceNo || 0))) events.push(event);
      cachedReceipt = { ...current, ...receipt, events: events.sort((left, right) => Number(left.sequenceNo || 0) - Number(right.sequenceNo || 0)) };
      if (index >= 0) list[index] = cachedReceipt;
      else list.unshift(cachedReceipt);
      nextBySession[sessionId] = list;
    }
    state.agentDeliveryRunsBySession = nextBySession;
    return cachedReceipt || { ...receipt, events: [event] };
  }

  function removeCachedAgentDeliveryRun(workId = '') {
    const next = {};
    for (const [sessionId, runs] of Object.entries(state.agentDeliveryRunsBySession || {})) {
      next[sessionId] = (Array.isArray(runs) ? runs : []).filter((item) => item.workId !== workId);
    }
    state.agentDeliveryRunsBySession = next;
  }

  function stopRunStatusTimer() {
    if (!runStatusTimer) return;
    clearRepeatingTimer(runStatusTimer);
    runStatusTimer = null;
  }

  function markProcessSettled(run, { status = 'completed', expanded = null } = {}) {
    if (!run?.processMessageId) return;
    run.processEvents = (run.processEvents || []).map((item) => item.status === 'running'
      ? { ...item, status, title: settledProcessTitle(item.title) }
      : item);
    const processMessage = state.messages.find((message) => message.id === run.processMessageId);
    if (processMessage?.metadata?.transient === 'process') {
      const settledExpanded = expanded == null
        ? processMessage.metadata.expanded !== false
        : Boolean(expanded);
      processMessage.metadata = {
        ...processMessage.metadata,
        processEvents: run.processEvents.map((item) => ({ ...item })),
        streaming: false,
        expanded: settledExpanded,
        processStatus: status,
        durationMs: Math.max(0, Date.now() - (run.startedAt || Date.now())),
      };
      markDirtyMessage(run.processMessageId);
    }
  }

  function settledProcessTitle(title = '') {
    return ({
      '正在协调 Agent': 'Agent 协作',
      '正在执行命令': '命令执行',
      '正在处理文件': '文件处理',
      '正在调用工具': '工具调用',
      '正在检索资料': '资料检索',
      '正在处理图像': '图像处理',
    })[String(title || '')] || String(title || '处理过程');
  }

  function renderRunUpdate(run = currentChatRun()) {
    if (run && !isRunVisibleInCurrentChat(run)) return;
    syncCurrentChatRun();
    restoreActiveRunTransient();
    if (runUpdateTimer) return;
    runUpdateTimer = setTimer(() => {
      runUpdateTimer = null;
      patchRunMessages();
    }, RUN_UPDATE_THROTTLE_MS);
  }

  function settleQuestionScrollAtBottom(run, shouldFollow = false) {
    if (!shouldFollow) return;
    const list = documentRef.getElementById('message-list');
    if (!list) return;
    const follow = () => {
      if (documentRef.getElementById('message-list') !== list || !isRunVisibleInCurrentChat(run)) return;
      scrollMessagesToBottom();
    };
    follow();
    windowRef.requestAnimationFrame?.(() => {
      follow();
      windowRef.requestAnimationFrame?.(follow);
    });
  }

  function patchRunMessages({ anchorMessageId = '', allowFollow = true } = {}) {
    const list = documentRef.getElementById('message-list');
    if (!list || state.currentTab !== 'chat') {
      render();
      dirtyRunMessageIds.clear();
      return;
    }
    if (isMessageInteractionActive()) {
      deferredRunPatchOptions = {
        anchorMessageId: anchorMessageId || deferredRunPatchOptions?.anchorMessageId || '',
        allowFollow: Boolean(allowFollow && deferredRunPatchOptions?.allowFollow !== false),
      };
      if (!runUpdateTimer) {
        runUpdateTimer = setTimer(() => {
          runUpdateTimer = null;
          const pending = deferredRunPatchOptions || {};
          deferredRunPatchOptions = null;
          patchRunMessages(pending);
        }, Math.max(16, RUN_UPDATE_THROTTLE_MS));
      }
      return;
    }
    const snapshot = captureMessageScrollState({ allowFollow, anchorMessageId });
    if (typeof renderMessagePatchSet === 'function' && dirtyRunMessageIds.size) {
      const startedAt = performance.now();
      const dirtyIds = [...dirtyRunMessageIds];
      const patchSet = renderMessagePatchSet(dirtyIds);
      const changedRoots = patchMessageListEntries(list, patchSet);
      dirtyIds.forEach((id) => dirtyRunMessageIds.delete(id));
      changedRoots.forEach((root) => localizeRoot(root));
      restoreMessageScrollState(snapshot);
      changedRoots.forEach((root) => wireMessageEvents(root));
      syncActiveRunComposerUi();
      const durationMs = performance.now() - startedAt;
      if (durationMs >= 50 && Date.now() - lastSlowRunPatchReportAt >= 5_000) {
        lastSlowRunPatchReportAt = Date.now();
        reportPerformance('renderer-run-patch-slow', {
        durationMs: Math.round(durationMs),
        dirtyMessageCount: dirtyIds.length,
        changedMessageCount: changedRoots.length,
        messageCount: Array.isArray(state.messages) ? state.messages.length : 0,
        });
      }
      return;
    }
    const changedRoots = reconcileMessageList(list, renderMessageList());
    dirtyRunMessageIds.clear();
    changedRoots.forEach((root) => localizeRoot(root));
    restoreMessageScrollState(snapshot);
    changedRoots.forEach((root) => wireMessageEvents(root));
    syncActiveRunComposerUi();
  }

  function patchMessageListEntries(list, patchSet = {}) {
    const order = Array.isArray(patchSet.order) ? patchSet.order : [];
    const orderIndex = new Map(order.map((id, index) => [String(id || ''), index]));
    const entries = Array.isArray(patchSet.entries) ? patchSet.entries : [];
    const entryIds = new Set(entries.map((entry) => String(entry.id || '')));
    const changed = [];
    for (const requestedId of patchSet.requestedIds || []) {
      if (entryIds.has(String(requestedId || ''))) continue;
      list.querySelector?.(`[data-message-id="${cssEscape(String(requestedId || ''))}"]`)?.remove?.();
    }
    for (const entry of entries) {
      const id = String(entry.id || '');
      if (!id || !entry.markup) continue;
      const template = documentRef.createElement('template');
      template.innerHTML = entry.markup;
      const desiredNode = template.content.firstElementChild;
      if (!desiredNode) continue;
      const current = list.querySelector?.(`[data-message-id="${cssEscape(id)}"]`) || null;
      const sameRender = current && current.dataset?.messageRenderKey === desiredNode.dataset?.messageRenderKey;
      const node = sameRender ? current : desiredNode;
      if (current && !sameRender) {
        current.replaceWith(node);
        changed.push(node);
      } else if (!current) {
        changed.push(node);
      }
      const index = orderIndex.get(id) ?? entry.index ?? 0;
      let reference = null;
      for (let nextIndex = index + 1; nextIndex < order.length; nextIndex += 1) {
        reference = list.querySelector?.(`[data-message-id="${cssEscape(order[nextIndex])}"]`) || null;
        if (reference) break;
      }
      if (node.parentNode !== list || reference !== node.nextElementSibling) list.insertBefore(node, reference);
    }
    return changed;
  }

  function cssEscape(value = '') {
    if (windowRef.CSS?.escape) return windowRef.CSS.escape(String(value || ''));
    return String(value || '').replace(/(["\\])/g, '\\$1');
  }

  function reconcileMessageList(list, markup = '') {
    if (!documentRef.createElement || !list?.children) {
      list.innerHTML = markup;
      return [list];
    }
    const template = documentRef.createElement('template');
    template.innerHTML = markup;
    const desired = [...template.content.children];
    if ([...list.children].some((item) => !String(item.dataset?.messageId || ''))) {
      list.innerHTML = markup;
      return [list];
    }
    const existing = new Map([...list.children].map((item) => [String(item.dataset?.messageId || ''), item]).filter(([id]) => id));
    const desiredIds = new Set();
    const changed = [];
    for (let index = 0; index < desired.length; index += 1) {
      const desiredNode = desired[index];
      const id = String(desiredNode.dataset?.messageId || '');
      if (!id) continue;
      desiredIds.add(id);
      const current = existing.get(id) || null;
      const sameRender = current && current.dataset?.messageRenderKey === desiredNode.dataset?.messageRenderKey;
      const node = sameRender ? current : desiredNode;
      if (current && !sameRender) {
        current.replaceWith(node);
        changed.push(node);
      } else if (!current) {
        changed.push(node);
      }
      const positioned = list.children[index] || null;
      if (node !== positioned) list.insertBefore(node, positioned);
    }
    for (const [id, node] of existing) if (!desiredIds.has(id)) node.remove();
    return changed;
  }

  function codexReviewPanelBounds() {
    const viewportWidth = Math.max(320, Number(windowRef?.innerWidth || documentRef?.documentElement?.clientWidth || 1280));
    const maxWidth = Math.min(900, Math.max(240, viewportWidth - 96));
    const minWidth = Math.min(maxWidth, viewportWidth >= 960 ? 420 : Math.max(280, Math.round(viewportWidth * 0.5)));
    return { minWidth, maxWidth, viewportWidth };
  }

  function applyCodexReviewPanelWidth(dialog, value = 0) {
    if (!dialog) return 0;
    const { minWidth, maxWidth, viewportWidth } = codexReviewPanelBounds();
    const defaultWidth = Math.max(minWidth, Math.min(maxWidth, Math.max(460, Math.min(720, Math.round(viewportWidth * 0.29)))));
    const requested = Number(value);
    const width = Math.round(Math.max(minWidth, Math.min(maxWidth, Number.isFinite(requested) && requested > 0 ? requested : defaultWidth)));
    codexReviewPanelWidth = width;
    dialog.style?.setProperty('--codex-review-width', width + 'px');
    const resizer = dialog.querySelector?.('[data-codex-review-resizer]');
    resizer?.setAttribute('aria-valuemin', String(minWidth));
    resizer?.setAttribute('aria-valuemax', String(maxWidth));
    resizer?.setAttribute('aria-valuenow', String(width));
    return width;
  }

  function bindCodexReviewResizer(dialog) {
    const resizer = dialog?.querySelector?.('[data-codex-review-resizer]');
    if (!resizer || resizer.dataset.codexReviewResizeBound === 'true') return;
    resizer.dataset.codexReviewResizeBound = 'true';
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = applyCodexReviewPanelWidth(dialog, dialog.getBoundingClientRect?.().width || codexReviewPanelWidth);
      documentRef.body?.classList.add('is-resizing-codex-review');
      const move = (moveEvent) => {
        applyCodexReviewPanelWidth(dialog, startWidth + startX - moveEvent.clientX);
      };
      const finish = () => {
        windowRef?.removeEventListener?.('pointermove', move);
        windowRef?.removeEventListener?.('pointerup', finish);
        windowRef?.removeEventListener?.('pointercancel', finish);
        documentRef.body?.classList.remove('is-resizing-codex-review');
      };
      windowRef?.addEventListener?.('pointermove', move);
      windowRef?.addEventListener?.('pointerup', finish);
      windowRef?.addEventListener?.('pointercancel', finish);
    });
    resizer.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const { minWidth, maxWidth } = codexReviewPanelBounds();
      const currentWidth = applyCodexReviewPanelWidth(dialog, dialog.getBoundingClientRect?.().width || codexReviewPanelWidth);
      const nextWidth = event.key === 'Home'
        ? minWidth
        : event.key === 'End'
          ? maxWidth
          : currentWidth + (event.key === 'ArrowLeft' ? 16 : -16);
      applyCodexReviewPanelWidth(dialog, nextWidth);
    });
  }

  function wireMessageEvents(root = documentRef) {
    const openReviewPanel = documentRef.querySelector('[data-codex-review-dialog][data-codex-review-portaled="true"]');
    if (openReviewPanel && root === documentRef) {
      cleanupStaleCodexReviewPortal(openReviewPanel, { documentRef });
    }
    if (!documentRef.querySelector('[data-codex-review-dialog][open]')) {
      documentRef.documentElement?.classList.remove('codex-review-panel-open');
    }
    const handleFileAction = (button, callback) => (event) => {
      if (button.hasAttribute?.('data-codex-file-action')) {
        event.preventDefault();
        event.stopPropagation();
      }
      callback();
    };
    const selectReviewFile = (dialog, fileId = '', { ensureOpen = false, scroll = false } = {}) => {
      if (!dialog || !fileId) return;
      let selectedPath = '';
      dialog.querySelectorAll('[data-codex-review-select]').forEach((button) => {
        const selected = button.dataset.codexReviewSelect === fileId;
        const panel = button.closest?.('[data-codex-review-panel]');
        panel?.classList.toggle('is-active', selected);
        if (selected) {
          selectedPath = String(button.querySelector('.codex-review-file-path')?.textContent || '').trim();
          if (ensureOpen && panel && 'open' in panel) panel.open = true;
          if (scroll) windowRef?.requestAnimationFrame?.(() => panel?.scrollIntoView?.({ block: 'nearest' }));
        }
      });
      const current = dialog.querySelector('[data-codex-review-current]');
      if (current && selectedPath) current.textContent = selectedPath;
    };
    const closeReviewDialog = (dialog) => {
      if (!dialog) return;
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      dialog.remove();
      documentRef.body?.classList.remove('is-resizing-codex-review');
      if (!documentRef.querySelector('[data-codex-review-dialog][open]')) {
        documentRef.documentElement?.classList.remove('codex-review-panel-open');
      }
    };
    const bindReviewDialog = (dialog) => {
      if (!dialog || dialog.dataset.codexReviewBound === 'true') return;
      dialog.dataset.codexReviewBound = 'true';
      applyCodexReviewPanelWidth(dialog, codexReviewPanelWidth);
      bindCodexReviewResizer(dialog);
      dialog.addEventListener('close', () => {
        documentRef.body?.classList.remove('is-resizing-codex-review');
        dialog.remove();
        if (!documentRef.querySelector('[data-codex-review-dialog][open]')) {
          documentRef.documentElement?.classList.remove('codex-review-panel-open');
        }
      });
      dialog.querySelectorAll('[data-codex-review-select]').forEach((button) => {
        button.addEventListener('click', () => selectReviewFile(dialog, String(button.dataset.codexReviewSelect || '')));
      });
      dialog.querySelectorAll('[data-codex-review-close]').forEach((button) => {
        button.addEventListener('click', () => closeReviewDialog(dialog));
      });
    };
    const restoreDisclosurePosition = (snapshot) => {
      restoreMessageScrollState(snapshot);
      const list = documentRef.getElementById('message-list');
      const savedTop = Number(snapshot?.top);
      const maxTop = list ? Math.max(0, list.scrollHeight - list.clientHeight) : 0;
      if (list && Number.isFinite(savedTop) && savedTop <= maxTop) list.scrollTop = savedTop;
    };
    const scheduleDisclosureRestore = (snapshot) => {
      const frame = windowRef?.requestAnimationFrame?.bind(windowRef) || ((callback) => setTimer(callback, 0));
      frame(() => frame(() => {
        restoreDisclosurePosition(snapshot);
        setTimer(() => restoreDisclosurePosition(snapshot), 0);
      }));
    };
    root.querySelectorAll('.codex-change-summary-row').forEach((row) => {
      if (row.dataset.codexHoverPlacementBound === 'true') return;
      row.dataset.codexHoverPlacementBound = 'true';
      const placePreview = () => updateCodexHoverPreviewPlacement(row, { windowRef });
      const clearPreview = () => {
        setTimer(() => {
          if (row.matches?.(':hover') || row.matches?.(':focus-within')) return;
          clearCodexHoverPreviewPlacement(row);
        }, 0);
      };
      row.addEventListener('pointerenter', placePreview);
      row.addEventListener('focusin', placePreview);
      row.addEventListener('pointerleave', clearPreview);
      row.addEventListener('focusout', clearPreview);
    });
    root.querySelectorAll('.codex-change-hover-diff').forEach((preview) => {
      if (preview.dataset.codexHoverWheelBound === 'true') return;
      preview.dataset.codexHoverWheelBound = 'true';
      preview.addEventListener('wheel', (event) => event.stopPropagation());
    });
    root.querySelectorAll('details > summary').forEach((summary) => {
      if (summary.closest('[data-codex-review-dialog]')) return;
      let disclosureSnapshot = null;
      summary.addEventListener('pointerdown', () => {
        const messageId = String(summary.closest('[data-message-id]')?.dataset.messageId || '').trim();
        disclosureSnapshot = captureMessageScrollState({ allowFollow: false, anchorMessageId: messageId });
        suspendMessageAutoFollow();
      }, { capture: true, passive: true });
      summary.addEventListener('touchstart', () => {
        const messageId = String(summary.closest('[data-message-id]')?.dataset.messageId || '').trim();
        disclosureSnapshot = captureMessageScrollState({ allowFollow: false, anchorMessageId: messageId });
        suspendMessageAutoFollow();
      }, { capture: true, passive: true });
      summary.addEventListener('click', () => {
        const messageId = String(summary.closest('[data-message-id]')?.dataset.messageId || '').trim();
        const snapshot = disclosureSnapshot || captureMessageScrollState({ allowFollow: false, anchorMessageId: messageId });
        disclosureSnapshot = null;
        suspendMessageAutoFollow();
        scheduleDisclosureRestore(snapshot);
      });
    });
    root.querySelectorAll('[data-process-expand-all],[data-process-collapse-all]').forEach((button) => {
      button.addEventListener('pointerdown', () => suspendMessageAutoFollow(), { capture: true, passive: true });
    });
    root.querySelectorAll('[data-codex-review-open]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const dialog = mountCodexReviewPortal(button, { documentRef, closeExisting: closeReviewDialog });
        if (!dialog) return;
        localizeRoot(dialog);
        bindReviewDialog(dialog);
        selectReviewFile(dialog, String(button.dataset.codexReviewTarget || ''), { ensureOpen: true, scroll: true });
        if (typeof dialog.show === 'function') {
          if (!dialog.open) dialog.show();
        } else dialog.setAttribute('open', '');
        documentRef.documentElement?.classList.add('codex-review-panel-open');
      });
    });
    root.querySelectorAll('[data-codex-review-dialog][data-codex-review-portaled="true"]').forEach(bindReviewDialog);
    root.querySelectorAll('[data-task-card-action]:not([data-ubuddy-task-jump])').forEach((button) => {
      button.addEventListener('click', () => handleTaskCardAction?.(button));
    });
    root.querySelectorAll('[data-open-collaboration-task]').forEach((button) => {
      button.addEventListener('click', () => openCollaborationTask?.(button.dataset.openCollaborationTask || ''));
    });
    root.querySelectorAll('[data-ubuddy-clarification-form]').forEach((form) => {
      const clarificationMessageId = String(form.dataset.ubuddyClarificationForm || '');
      const updateClarificationDraft = () => {
        if (!clarificationMessageId) return;
        const answers = {};
        form.querySelectorAll('[data-ubuddy-question]').forEach((group) => {
          const questionId = String(group.dataset.ubuddyQuestion || '');
          const selected = group.querySelector('input[type="radio"]:checked');
          const textInput = group.querySelector('[data-ubuddy-clarification-other], [data-ubuddy-clarification-text]');
          if (questionId) answers[questionId] = { selectedValue: String(selected?.value || ''), text: String(textInput?.value || '') };
        });
        const singleAnswer = Object.values(answers).length === 1 ? Object.values(answers)[0] : null;
        state.uBuddyClarificationDrafts = {
          ...(state.uBuddyClarificationDrafts || {}),
          [clarificationMessageId]: {
            answers,
            ...(singleAnswer ? {
              selectedValue: singleAnswer.selectedValue,
              text: singleAnswer.text,
            } : {}),
          },
        };
      };
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (state.uBuddyFeatureFlags?.messageModeV1 === true && state.uBuddyMessageMode === 'ask') return;
        const answers = [];
        let firstMissing = null;
        const questionGroups = [...form.querySelectorAll('[data-ubuddy-question]')];
        questionGroups.forEach((group) => {
          const selected = group.querySelector('input[type="radio"]:checked');
          const questionId = String(group.dataset.ubuddyQuestion || '');
          const value = selected?.value === '__other__'
            ? String(group.querySelector('[data-ubuddy-clarification-other]')?.value || '').trim()
            : selected ? String(selected.value || '').trim() : '';
          if (!value && group.dataset.required !== 'false' && !firstMissing) firstMissing = group;
          const label = selected?.value === '__other__'
            ? value
            : String(selected?.dataset?.ubuddyAnswerLabel || value).trim();
          if (questionId && value) answers.push({ questionId, value, label });
        });
        if (!questionGroups.length) {
          const selected = form.querySelector('input[type="radio"]:checked');
          const value = selected?.value === '__other__'
            ? String(form.querySelector('[data-ubuddy-clarification-other]')?.value || '').trim()
            : selected ? String(selected.value || '').trim() : String(form.querySelector('[data-ubuddy-clarification-text]')?.value || '').trim();
          if (value) answers.push({ questionId: 'clarification_1', value });
        }
        const errorBox = form.querySelector('[data-ubuddy-clarification-error]');
        if (firstMissing || !answers.length) {
          if (errorBox) {
            errorBox.hidden = false;
            errorBox.textContent = translateText('请选择一个选项，或输入自己的答案。');
          }
          firstMissing?.querySelector('input, textarea')?.focus();
          return;
        }
        const submitButton = form.querySelector('button[type="submit"]');
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.textContent = translateText('正在提交…');
        }
        const readableAnswer = answers.length === 1 ? answers[0].value : answers.map((item) => `${item.questionId}: ${item.value}`).join('\n');
        const clarificationMessage = (state.messages || []).find((item) => String(item?.id || '') === clarificationMessageId) || null;
        const continuation = clarificationMessage?.metadata?.uBuddyContinuation || null;
        const planningCheckpoint = clarificationMessage?.metadata?.uBuddyPlanningCheckpoint || null;
        const submitted = await submitUBuddyClarificationAnswer(readableAnswer, {
          messageId: String(form.dataset.ubuddyClarificationForm || ''),
          clarificationResponse: {
            version: 'ubuddy_clarification_response_v1',
            sourceMessageId: clarificationMessageId,
            continuationId: String(continuation?.continuationId || ''),
            continuationKind: String(continuation?.kind || ''),
            planningSessionId: String(planningCheckpoint?.planningSessionId || ''),
            baseRevision: Math.max(0, Number(planningCheckpoint?.revision || 0)),
            answers,
          },
        });
        if (submitted) {
          const nextDrafts = { ...(state.uBuddyClarificationDrafts || {}) };
          delete nextDrafts[clarificationMessageId];
          state.uBuddyClarificationDrafts = nextDrafts;
          return;
        }
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = translateText('确认并继续');
        }
        if (errorBox) {
          errorBox.hidden = false;
          errorBox.textContent = translateText('当前无法提交，请稍后再试。');
        }
      });
      form.querySelectorAll('[data-ubuddy-clarification-other]').forEach((input) => {
        input.addEventListener('focus', () => {
          const radio = input.closest('label')?.querySelector('input[type="radio"]');
          if (radio) radio.checked = true;
          updateClarificationDraft();
        });
      });
      form.querySelectorAll('[data-ubuddy-clarification-other], [data-ubuddy-clarification-text]').forEach((input) => {
        input.addEventListener('input', updateClarificationDraft);
        input.addEventListener('compositionend', updateClarificationDraft);
      });
      form.querySelectorAll('input[type="radio"]').forEach((input) => {
        input.addEventListener('change', updateClarificationDraft);
      });
    });
    root.querySelectorAll('[data-ubuddy-execution-target]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        const target = String(button.dataset.ubuddyExecutionTarget || '');
        if (target === 'contact') {
          openUBuddyContactPicker();
          return;
        }
        if (target !== 'local') return;
        const card = button.closest('.ubuddy-clarification-card');
        card?.querySelectorAll?.('[data-ubuddy-execution-target]').forEach((item) => { item.disabled = true; });
        const english = state.languageMode === 'en';
        const value = english ? 'Complete locally' : '本地完成';
        const executionTargetMessageId = String(button.closest('[data-message-id]')?.dataset.messageId || '');
        const executionTargetMessage = (state.messages || []).find((item) => String(item?.id || '') === executionTargetMessageId) || null;
        const executionTargetCheckpoint = executionTargetMessage?.metadata?.uBuddyPlanningCheckpoint || null;
        const submitted = await submitUBuddyClarificationAnswer(value, {
          messageId: executionTargetMessageId,
          clarificationResponse: {
            version: 'ubuddy_clarification_response_v1',
            sourceMessageId: executionTargetMessageId,
            planningSessionId: String(executionTargetCheckpoint?.planningSessionId || ''),
            baseRevision: Math.max(0, Number(executionTargetCheckpoint?.revision || 0)),
            answers: [{ questionId: 'executionTarget', value }],
          },
        });
        if (!submitted) card?.querySelectorAll?.('[data-ubuddy-execution-target]').forEach((item) => { item.disabled = false; });
      });
    });
    root.querySelectorAll('[data-ubuddy-execution-mode]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        const mode = String(button.dataset.ubuddyExecutionMode || '');
        const choiceId = String(button.dataset.ubuddyExecutionChoiceId || '');
        if (!choiceId || !['direct', 'scheduler'].includes(mode)) return;
        const card = button.closest('.ubuddy-execution-mode-card');
        const buttons = card?.querySelectorAll?.('[data-ubuddy-execution-mode]') || [];
        buttons.forEach((item) => { item.disabled = true; });
        const selectedLabel = mode === 'scheduler' ? '使用多 Agent 协作' : '由 uBuddy 直接完成';
        const submitted = await submitUBuddyClarificationAnswer(selectedLabel, {
          executionModeChoice: { choiceId, mode },
        });
        if (submitted) return;
        buttons.forEach((item) => { item.disabled = false; });
        const errorBox = card?.querySelector?.('[data-ubuddy-execution-mode-error]');
        if (errorBox) {
          errorBox.hidden = false;
          errorBox.textContent = translateText('当前无法提交，请稍后再试。');
        }
      });
    });
    root.querySelectorAll('[data-ubuddy-planning-failure-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        const action = String(button.dataset.ubuddyPlanningFailureAction || '').trim();
        if (!action) return;
        const originalText = button.textContent;
        const submittedAction = state.languageMode === 'en'
          ? (action.startsWith('重新') ? 'Retry plan' : 'Cancel collaboration')
          : action;
        button.disabled = true;
        button.textContent = translateText(action.startsWith('重新') ? '正在重新生成…' : '正在取消…');
        const submitted = await submitUBuddyClarificationAnswer(submittedAction, {
          messageId: String(button.closest('[data-message-id]')?.dataset.messageId || ''),
        });
        if (submitted) return;
        button.disabled = false;
        button.textContent = originalText;
      });
    });
    root.querySelectorAll('[data-ubuddy-planning-restart]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        const sourceMessageId = String(button.dataset.ubuddyPlanningRestart || '').trim();
        if (!sourceMessageId) return;
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = translateText('正在重启…');
        const submitted = await submitUBuddyClarificationAnswer('重新开始持续规划', {
          planningRestartSourceMessageId: sourceMessageId,
        });
        if (submitted) return;
        button.disabled = false;
        button.textContent = originalText;
      });
    });
    root.querySelectorAll('[data-task-progress-toggle]').forEach((details) => {
      details.addEventListener('toggle', () => {
        const taskId = String(details.dataset.taskProgressToggle || '').trim();
        if (!taskId) return;
        state.taskProgressOpenById = {
          ...(state.taskProgressOpenById || {}),
          [taskId]: details.open,
        };
      });
    });
    root.querySelectorAll('[data-task-disclosure-key]').forEach((details) => {
      details.addEventListener('toggle', () => {
        const key = String(details.dataset.taskDisclosureKey || '').trim();
        if (!key) return;
        state.taskDisclosureOpenByKey = {
          ...(state.taskDisclosureOpenByKey || {}),
          [key]: details.open,
        };
      });
    });
    root.querySelectorAll('[data-chat-plan-toggle]').forEach((details) => {
      details.addEventListener('toggle', () => {
        const message = state.messages.find((item) => item.id === details.dataset.chatPlanToggle);
        if (!message) return;
        message.metadata = { ...(message.metadata || {}), planExpanded: details.open };
      });
    });
    root.querySelectorAll('[data-process-toggle]').forEach((details) => {
      details.addEventListener('toggle', () => {
        const message = state.messages.find((item) => item.id === details.dataset.processToggle);
        if (!message) return;
        message.metadata = {
          ...(message.metadata || {}),
          expanded: details.open,
        };
      });
    });
    const setAllProcessDetails = (messageId = '', open = false) => {
      const updateEvents = (events = []) => {
        for (const item of events) {
          if (!item?.activityId) continue;
          item.expanded = open;
          item.commandGroupExpanded = open;
          item.expansionLocked = true;
        }
      };
      const message = state.messages.find((item) => item.id === messageId);
      if (message) {
        const processEvents = Array.isArray(message.metadata?.processEvents) ? message.metadata.processEvents : [];
        updateEvents(processEvents);
        message.metadata = {
          ...(message.metadata || {}),
          expanded: true,
          historyExpanded: open,
          historyVisibleCount: open ? Math.max(20, processEvents.length) : Number(message.metadata?.historyVisibleCount || 20),
        };
      }
      const run = allChatRuns().find((item) => item.processMessageId === messageId);
      if (run) {
        updateEvents(run.processEvents || []);
        run.processHistoryExpanded = open;
        if (open) run.processHistoryVisibleCount = Math.max(20, run.processEvents?.length || 0);
      }
      const messageList = documentRef.getElementById('message-list');
      const mountedMessage = messageList
        ? [...messageList.children].find((item) => String(item.dataset?.messageId || '') === messageId)
        : null;
      if (mountedMessage?.querySelector('.codex-transcript')) {
        const snapshot = captureMessageScrollState({ allowFollow: false, anchorMessageId: messageId });
        mountedMessage.querySelectorAll('[data-codex-command-group-toggle],[data-codex-command-toggle],[data-codex-operation-toggle]')
          .forEach((details) => { details.open = open; });
        restoreMessageScrollState(snapshot);
        return;
      }
      patchRunMessages({ anchorMessageId: messageId, allowFollow: false });
    };
    root.querySelectorAll('[data-process-expand-all]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setAllProcessDetails(String(button.dataset.processExpandAll || ''), true);
      });
    });
    root.querySelectorAll('[data-process-collapse-all]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setAllProcessDetails(String(button.dataset.processCollapseAll || ''), false);
      });
    });
    root.querySelectorAll('[data-process-history-toggle]').forEach((details) => {
      details.addEventListener('toggle', () => {
        const messageId = String(details.dataset.processHistoryToggle || '');
        const message = state.messages.find((item) => item.id === messageId);
        if (message && Boolean(message.metadata?.historyExpanded) === details.open) return;
        if (message) message.metadata = { ...(message.metadata || {}), historyExpanded: details.open };
        const run = allChatRuns().find((item) => item.processMessageId === messageId);
        if (run) run.processHistoryExpanded = details.open;
        patchRunMessages({ anchorMessageId: messageId, allowFollow: false });
      });
    });
    root.querySelectorAll('[data-process-history-more]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const messageId = String(button.dataset.processHistoryMore || '');
        const step = Math.max(1, Number(button.dataset.processHistoryStep || 20));
        const message = state.messages.find((item) => item.id === messageId);
        const current = Number(message?.metadata?.historyVisibleCount || 20);
        if (message) message.metadata = { ...(message.metadata || {}), historyVisibleCount: current + step };
        const run = allChatRuns().find((item) => item.processMessageId === messageId);
        if (run) run.processHistoryVisibleCount = current + step;
        patchRunMessages({ anchorMessageId: messageId, allowFollow: false });
      });
    });
    root.querySelectorAll('[data-process-item-toggle]').forEach((details) => {
      details.addEventListener('toggle', () => {
        const toggleId = String(details.dataset.processItemToggle || '');
        const separator = toggleId.indexOf('::');
        const messageId = separator >= 0 ? toggleId.slice(0, separator) : '';
        const activityId = separator >= 0 ? toggleId.slice(separator + 2) : '';
        if (!messageId || !activityId) return;
        const message = state.messages.find((item) => item.id === messageId);
        const messageItem = message?.metadata?.processEvents?.find((item) => item.activityId === activityId);
        if (messageItem) {
          messageItem.expanded = details.open;
          messageItem.expansionLocked = true;
        }
        const run = allChatRuns().find((item) => item.processMessageId === messageId);
        const runItem = run?.processEvents?.find((item) => item.activityId === activityId);
        if (runItem) {
          runItem.expanded = details.open;
          runItem.expansionLocked = true;
        }
      });
    });
    const updateCodexCommandState = (toggleId = '', field = '', open = false) => {
      const separator = toggleId.indexOf('::');
      const messageId = separator >= 0 ? toggleId.slice(0, separator) : '';
      const activityId = separator >= 0 ? toggleId.slice(separator + 2) : '';
      if (!messageId || !activityId) return;
      const message = state.messages.find((item) => item.id === messageId);
      const messageItem = message?.metadata?.processEvents?.find((item) => item.activityId === activityId);
      if (messageItem) messageItem[field] = open;
      const run = allChatRuns().find((item) => item.processMessageId === messageId);
      const runItem = run?.processEvents?.find((item) => item.activityId === activityId);
      if (runItem) runItem[field] = open;
    };
    root.querySelectorAll('[data-codex-command-group-toggle]').forEach((details) => {
      details.addEventListener('toggle', () => {
        updateCodexCommandState(String(details.dataset.codexCommandGroupToggle || ''), 'commandGroupExpanded', details.open);
      });
    });
    root.querySelectorAll('[data-codex-command-toggle]').forEach((details) => {
      details.addEventListener('toggle', () => {
        updateCodexCommandState(String(details.dataset.codexCommandToggle || ''), 'expanded', details.open);
      });
    });
    root.querySelectorAll('[data-codex-operation-toggle]').forEach((details) => {
      details.addEventListener('toggle', () => {
        updateCodexCommandState(String(details.dataset.codexOperationToggle || ''), 'expanded', details.open);
      });
    });
    const userInputForm = root.querySelector?.('[data-chat-user-input-form]');
    if (userInputForm) {
      userInputForm.addEventListener('submit', (event) => submitChatUserInput(event, userInputForm));
      userInputForm.querySelector('[data-chat-user-input-skip]')?.addEventListener('click', (event) => skipCurrentChatUserInput(event, userInputForm));
      userInputForm.querySelectorAll('.chat-user-input-option > input[type="radio"]:not([value="__other__"])').forEach((input) => {
        input.addEventListener('change', (event) => advanceChatUserInputSelection(event, userInputForm));
      });
      userInputForm.querySelector('[data-chat-user-input-back]')?.addEventListener('click', (event) => navigateChatUserInput(event, userInputForm, -1));
      userInputForm.querySelectorAll('[data-user-input-other]').forEach((input) => {
        const selectOther = () => {
          const radio = input.closest('label')?.querySelector('input[type="radio"]');
          if (radio) radio.checked = true;
        };
        input.addEventListener('focus', selectOther);
        input.addEventListener('input', selectOther);
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          if (event.isComposing || event.keyCode === 229 || input.dataset.imeComposing === 'true') return;
          event.preventDefault();
          advanceChatUserInputSelection(event, userInputForm);
        });
      });
    }
    root.querySelectorAll?.('[data-chat-approval]').forEach((button) => {
      button.addEventListener('click', () => {
        const run = currentChatRun();
        if (!run?.channelId) return;
        void resolveChatApprovalDecision(run.channelId, button.dataset.chatApproval === 'approve');
      });
    });
    const bindFileAction = (selector, action, listener) => {
      root.querySelectorAll(selector).forEach((button) => {
        const boundActions = button.__janusFileActionListeners || new Set();
        if (boundActions.has(action)) return;
        boundActions.add(action);
        button.__janusFileActionListeners = boundActions;
        button.addEventListener('click', listener(button));
      });
    };
    bindFileAction('[data-preview-file]', 'preview', (btn) => handleFileAction(btn, () => previewFileInfo(parsePreviewPayload(btn.dataset.previewFile || ''))));
    bindFileAction('[data-save-file]', 'save', (btn) => () => saveFileFromPayload(parsePreviewPayload(btn.dataset.saveFile || '')));
    bindFileAction('[data-show-file]', 'show', (btn) => handleFileAction(btn, () => showFileFromPayload(parsePreviewPayload(btn.dataset.showFile || ''))));
    bindFileAction('[data-open-file]', 'open', (btn) => handleFileAction(btn, () => openFileFromPayload(parsePreviewPayload(btn.dataset.openFile || ''))));
    root.querySelectorAll('[data-copy-file-path]').forEach((btn) => {
      btn.addEventListener('click', handleFileAction(btn, () => copyFilePath?.(btn.dataset.copyFilePath || '')));
    });
    root.querySelectorAll('[data-preview-local-file]').forEach((btn) => {
      btn.addEventListener('click', () => openLocalMessageFile(
        btn.dataset.previewLocalFile || '',
        btn.textContent || '',
        btn.closest('[data-message-id]')?.dataset.messageId || '',
        btn.closest('[data-message-id]'),
      ));
    });
    root.querySelectorAll('[data-copy-message]').forEach((btn) => {
      btn.addEventListener('click', () => copyMessageText(btn.dataset.copyMessage || ''));
    });
    root.querySelectorAll('[data-copy-code-block]').forEach((btn) => {
      btn.addEventListener('click', () => copyCodeBlockText(btn));
    });
    root.querySelectorAll('[data-edit-message]').forEach((btn) => {
      btn.addEventListener('click', () => editMessageFromHistory(btn.dataset.editMessage || ''));
    });
  }

  function mergeProgressMilestones(run, event = {}) {
    if (!Array.isArray(run.progressMilestones)) run.progressMilestones = [];
    const candidates = [];
    if (event.objective && !run.progressMilestones.some((item) => item.key === 'objective-confirmed')) {
      candidates.push({ key: 'objective-confirmed', status: 'completed', title: '任务目标已确认', detail: event.objective.summary || '' });
    }
    for (const node of event.changedNodes || []) {
      candidates.push({
        key: node.milestoneKey || `${node.id || node.title}:${node.status}`,
        status: node.status || 'running',
        title: node.title || '任务节点',
        detail: node.summary || taskNodeStatusLabel(node.status),
        agentId: node.agentId || '',
      });
    }
    for (const item of candidates) {
      const index = run.progressMilestones.findIndex((entry) => entry.key === item.key);
      if (index >= 0) run.progressMilestones[index] = item;
      else run.progressMilestones.push(item);
    }
    if (run.progressMilestones.length > 12) run.progressMilestones.splice(0, run.progressMilestones.length - 12);
  }

  function taskNodeStatusLabel(status = '') {
    return ({ pending: '等待上游依赖', ready: '等待执行', queued: '已进入执行队列', running: '正在执行', retry_wait: '等待自动重试', waiting: '等待协作信息', blocked: '被失败依赖阻塞', completed: '已完成', failed: '执行失败', cancelled: '已取消' })[status] || '状态已更新';
  }

  function handleTaskUpdate(payload = {}) {
    const task = payload.task || null;
    if (!task?.id) return false;
    const run = allChatRuns().find((item) => item.taskRunId === task.id);
    const nodes = task.nodes || [];
    const progress = {
      total: nodes.length,
      pending: nodes.filter((node) => node.status === 'pending').length,
      ready: nodes.filter((node) => node.status === 'ready').length,
      queued: nodes.filter((node) => node.status === 'queued').length,
      running: nodes.filter((node) => node.status === 'running').length,
      waiting: nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length,
      completed: nodes.filter((node) => node.status === 'completed').length,
      failed: nodes.filter((node) => node.status === 'failed').length,
    };
    const executionPercent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
    const phase = taskProgressPhase(task);
    const lifecycle = deriveTaskLifecycleProgress({
      phase,
      taskStatus: task.status || '',
      executionPercent,
      reviewState: task.deliveryReview?.state || task.metadata?.deliveryReview?.state || task.metadata?.deliveryReviewState || '',
      finalDelivery: task.metadata?.finalDelivery || null,
      acceptanceSource: task.metadata?.deliveryReviewOutcome || '',
      hasConfirmationProtocol: Boolean(
        task.metadata?.finalDelivery || task.deliveryReview || task.metadata?.deliveryReview || task.metadata?.deliveryReviewState,
      ),
    });
    Object.assign(progress, lifecycle, { lifecyclePhase: lifecycle.phase });
    const blockedNode = nodes.find((node) => ['waiting', 'retry_wait', 'blocked', 'failed'].includes(node.status));
    const changedNode = payload.change?.node
      ? publicTaskNode(payload.change.node, payload.change)
      : null;
    const event = {
      kind: 'task-progress',
      taskRunId: task.id,
      taskStatus: task.status,
      phase: lifecycle.phase,
      taskProgress: progress,
      activeNodes: nodes.filter((node) => ['ready', 'queued', 'running'].includes(node.status)).map(publicTaskNode),
      changedNodes: changedNode ? [changedNode] : [],
      blocker: blockedNode ? {
        nodeId: blockedNode.id,
        summary: blockedNode.waitReason || blockedNode.errorText || `${blockedNode.title || '任务节点'}暂时无法继续。`,
        attemptedActions: (blockedNode.recoveryActions || []).slice(-5),
        errorCode: blockedNode.lastErrorCode || '',
        attemptCount: Number(blockedNode.attemptCount || 0),
        maxAttempts: Number(blockedNode.maxAttempts || 3),
        nextRetryAt: blockedNode.nextRetryAt || '',
        suggestedNextStep: blockedNode.status === 'retry_wait'
          ? `系统将于 ${blockedNode.nextRetryAt || '稍后'} 自动重试。`
          : blockedNode.status === 'failed'
            ? '自动恢复已结束；可以重试该节点、调整方案或重新分配 Agent。'
            : '等待所需信息或解除协作依赖后继续。',
        requiresUserDecision: blockedNode.status === 'failed' && !blockedNode.fallback,
      } : null,
      resultState: task.metadata?.resultState || '',
      deliverable: task.metadata?.deliverableResult || null,
      continuedByTaskRunId: String(task.metadata?.continuedByTaskRunId || ''),
      coordination: payload.coordination || payload.coordinationSnapshot || task.metadata?.coordinationSnapshot || task.metadata?.coordination || null,
      technicalDetails: {
        continuedByTaskRunId: String(task.metadata?.continuedByTaskRunId || ''),
        nodes: nodes.map((node) => {
          const declaration = task.metadata?.nodeOutputDeclarations?.[node.id] || {};
          return {
            ...publicTaskNode(node),
            contentType: declaration.contentType || '',
            detail: declaration.contentType && declaration.contentType !== 'deliverable' ? String(node.resultText || '').slice(0, 8000) : '',
          };
        }),
        diagnostics: (task.events || []).filter((item) => /failed|diagnostic|validation/i.test(item.eventType || '')).slice(-20).map((item) => ({
          id: item.id,
          type: item.eventType,
          summary: item.summary,
          createdAt: item.createdAt,
        })),
      },
      message: taskUpdateMessage(task, payload.change, progress),
    };
    if (run) handleChatRunEvent(run.channelId, event);

    let matchedMessage = false;
    for (const message of state.messages || []) {
      if (message.metadata?.taskRunId !== task.id) continue;
      matchedMessage = true;
      const holder = {
        progressMilestones: Array.isArray(message.metadata?.progressMilestones)
          ? [...message.metadata.progressMilestones]
          : [],
      };
      mergeProgressMilestones(holder, event);
      message.content = event.message || message.content;
      message.metadata = {
        ...(message.metadata || {}),
        taskProgress: progress,
        activeNodes: event.activeNodes,
        taskSnapshot: {
          taskRunId: task.id,
          taskStatus: task.status,
          phase: event.phase,
          progress,
          activeNodes: event.activeNodes,
          changedNodes: event.changedNodes,
          resultState: event.resultState,
          deliverable: event.deliverable,
          continuedByTaskRunId: event.continuedByTaskRunId,
          technicalDetails: event.technicalDetails,
          coordination: event.coordination,
        },
        progressMilestones: holder.progressMilestones,
        blocker: event.blocker,
        terminal: ['completed', 'failed', 'cancelled'].includes(String(task.status || '')),
      };
    }
    if (!run && matchedMessage && state.currentTab === 'chat') renderRunUpdate(null);
    return Boolean(run || matchedMessage);
  }

  function publicTaskNode(node = {}, change = null) {
    const activityDetail = change?.type === 'node_activity'
      ? change.detail || change.message || ''
      : change?.type === 'node_heartbeat'
        ? change.message || ''
        : '';
    return {
      id: node.id || '',
      title: change?.type === 'node_activity' ? change.title || node.title || '执行进度' : node.title || '任务节点',
      agentId: node.agentId || '',
      status: change?.activityStatus || node.status || 'pending',
      summary: activityDetail || node.resultSummary || node.waitReason || node.errorText || '',
      attemptCount: Number(node.attemptCount || 0),
      maxAttempts: Number(node.maxAttempts || 3),
      nextRetryAt: node.nextRetryAt || '',
      lastErrorCode: node.lastErrorCode || '',
      recoveryActions: (node.recoveryActions || []).slice(-5),
      createdAt: change?.createdAt || change?.occurredAt || node.updatedAt || node.createdAt || '',
      milestoneKey: change?.type === 'node_activity'
        ? `${node.id}:activity:${change.activityId || change.title || 'progress'}`
        : `${node.id || node.title}:${node.status || 'updated'}`,
    };
  }

  function taskProgressPhase(task = {}) {
    const declaredFailurePhase = String(task.metadata?.failurePhase || task.metadata?.failureStage || '').trim();
    if (['confirming', 'planning', 'executing', 'verifying', 'delivering'].includes(declaredFailurePhase)) return declaredFailurePhase;
    if (task.status === 'completed') return 'delivering';
    if (task.status === 'verifying' || task.metadata?.resultState === 'needs_revision' || task.metadata?.deliveryValidationState === 'failed') return 'verifying';
    return 'executing';
  }

  function taskUpdateMessage(task = {}, change = {}, progress = {}) {
    if (change?.type === 'task_continued_after_user_input' || task.metadata?.continuedByTaskRunId) {
      return '任务已根据你的补充转入后续轮次继续执行；旧轮次仅作为历史记录保留。';
    }
    if (change?.type === 'node_heartbeat' && change.message) return `${change.message}；总体 ${progress.completed || 0}/${progress.total || 0}`;
    if (change?.type === 'node_activity' && change.message) return `${change.message}；总体 ${progress.completed || 0}/${progress.total || 0}`;
    if (change?.node) return `${change.node.title || '任务节点'}：${taskNodeStatusLabel(change.node.status)}；总体 ${progress.completed || 0}/${progress.total || 0}`;
    return `协作推进中：${progress.completed || 0}/${progress.total || 0} 个节点完成`;
  }

  async function openLocalMessageFile(rawPath = '', label = '', messageId = '', messageElement = null) {
    const registeredArtifact = resolveRegisteredMessageArtifact(rawPath, messageId, messageElement);
    if (registeredArtifact) {
      await openFileFromPayload({
        ...registeredArtifact,
        messageId: registeredArtifact.messageId || '',
      });
      return;
    }
    const filePath = resolveMessageLocalFilePath(rawPath);
    if (!filePath) return notify('这个文件路径无效。', 'warning');
    await openFileFromPayload({
      filename: pathBasename(filePath) || String(label || '').trim() || 'file',
      name: pathBasename(filePath) || String(label || '').trim() || 'file',
      path: filePath,
    });
  }

  function resolveRegisteredMessageArtifact(rawPath = '', messageId = '', messageElement = null) {
    const files = messageElement?.querySelectorAll
      ? [...messageElement.querySelectorAll('.message-output-artifacts [data-preview-file], .message-attachments [data-preview-file]')]
        .map((button) => parsePreviewPayload(button.dataset.previewFile || ''))
      : [];
    return resolveLinkedMessageArtifact(rawPath, { messageId, messages: state.messages, files });
  }

  function resolveMessageLocalFilePath(rawPath = '') {
    let value = parseLocalFileReference(rawPath).path;
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the original path when it contains a literal percent sign.
    }
    if (/^file:\/\/\//i.test(value)) {
      value = value.replace(/^file:\/\/\//i, '');
      if (!/^[a-z]:[\\/]/i.test(value)) value = `/${value.replace(/^\/+/, '')}`;
    }
    if (/^[a-z]:[\\/]/i.test(value) || /^\//.test(value) || /^\\\\/.test(value)) return value;
    const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
    const project = projectForSession(session) || activeProject();
    const base = project?.workspaceRoot || project?.workspace_root || session?.workspaceRoot || session?.workspace_root || state.workspaceRoot || '';
    if (!base) return value;
    const separator = String(base).includes('\\') ? '\\' : '/';
    return `${String(base).replace(/[\\/]+$/, '')}${separator}${value.replace(/^\.[\\/]/, '')}`;
  }

  function syncActiveRunComposerUi() {
    const button = documentRef.getElementById('cancel-chat-btn');
    if (!button || !state.activeChatRun) return;
    if (state.activeChatRun.terminal) {
      button.remove();
      return;
    }
    const cancelling = Boolean(state.activeChatRun.cancelling);
    button.classList.toggle('is-cancelling', cancelling);
    button.title = translateText(cancelling ? '正在中止' : '中止生成');
  }

  function handleChatUserInputWindowClosed(payload = {}) {
    const requestId = String(payload.requestId || '');
    if (!requestId || payload.submitted) return;
    const run = allChatRuns().find((item) => item?.userInputRequest?.requestId === requestId) || null;
    if (!run) return;
    run.userInputExternal = false;
    run.userInputError = '';
    syncCurrentChatRun();
    render();
  }

  return {
    assignmentLabelForRun,
    clearAgentRunNotices,
    clearRunTransientMessages,
    handleAgentDeliveryUpdate,
    handleChatUserInputWindowClosed,
    handleChatRunEvent,
    handleTaskUpdate,
    isRunForCurrentChat,
    isRunVisibleInCurrentChat,
    renderRunUpdate,
    restoreActiveRunTransient,
    restorePersistentDeliveryRuns,
    stopRunStatusTimer,
    updateRunStatusMessage,
    wireMessageEvents,
  };
}
