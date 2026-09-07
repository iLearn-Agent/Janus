import cryptoModule from 'node:crypto';

import {
  hasExplicitDelegationIntent,
  normalizeMentionEntities,
  normalizeMentionSelectionContext,
  UBUDDY_MENTION_SELECTION_VERSION,
  UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
} from '../../../../shared/contracts/mentions.js';
import {
  createUBuddyReadinessProof,
  uBuddyReadinessProofMatches,
  validateUBuddyDispatchV3,
} from '../../../../shared/contracts/uBuddyDispatch.js';
import { uBuddyPlanningDecisionDigest } from '../../../../shared/contracts/uBuddyPlanningSession.js';
import { buildPublicTaskSummary } from '../../../../shared/contracts/taskSummary.js';
import { automaticTaskGroupTitleMetadata, buildTaskGroupTitle } from '../../../../shared/taskGroupTitle.js';
import {
  UBUDDY_COLLABORATION_PLAN_VERSION,
  collaborationPlanRemoteAssignments,
  validateUBuddyCollaborationPlan,
} from '../../../../shared/contracts/uBuddyCollaborationPlan.js';
import {
  DEFAULT_UBUDDY_PLANNER_TIMEOUT_MS,
  buildUBuddyPlannerCandidates,
  createDeliverableContract,
  deliverableContractRequiresValidation,
  planUBuddyContinuously,
  proposeUBuddyTaskGraph,
  recordUBuddyPeerRoutingShadowTaskEvents,
  resolveUBuddyPeerRoutingShadowContextIfEnabled,
  selectBestUBuddyCandidate,
  validateStandaloneDeliverable,
} from '../../orchestration/index.js';
import { classifyPptIntent } from '../../../pptIntent.js';
import { uploadRemoteMessageAttachments } from './messageFileTransfer.js';
import { socialRelayMutationMode, socialRelayUnavailableError } from './socialRelayMutationPolicy.js';
import {
  cacheRemoteMessageFile,
  cacheRemoteMessageFileFromPath,
  downloadRemoteMessageFile,
} from '../remoteMessageFileCache.js';
import { FAST_REMOTE_FILE_BYTES, uploadResumableFileFromPath } from '../resumableFileTransfer.js';

export function createCollaborationGroupRuntimeApi(context) {
  const {
    crypto,
    fs,
    path,
    all,
    run,
    deleteSessionManagedAttachments,
    runCodexDoctor,
    runCodexExec,
    runCodexSession,
    codexConfigFiles,
    codexConfigStatus,
    saveCodexConfig,
    saveCodexConfigFiles,
    artifactMessage,
    latestArtifact,
    buildAttachmentContext,
    buildMessageWithAttachments,
    describeFile,
    extractPptSourceVisuals,
    renderUploadedFile,
    uploadFile,
    uploadFileFromPath,
    dataDir,
    buildAgentChatPrompt,
    buildPlainChatPrompt,
    buildResumeTurnPrompt,
    fallbackPptAnswer,
    normalizePptAssistantAnswer,
    renderPptArtifact,
    shouldAttachPptArtifact,
    readCodexVisibleMessages,
    formatChatPlanSummary,
    planHomeChatRoute,
    suggestChatTitle,
    clipText,
    newId,
    sha256Text,
    localDelegationTransitionAllowed,
    localNextDelegationStatus,
    privateAgentDelegationMetadata,
    publicAgentDelegationMetadata,
    publicDelegationSubmissionText,
    normalizePptProgress,
    appendDelegationDecisionPrompt,
    buildAgentDelegationPrompt,
    buildAgentDelegationRouteMessage,
    buildDelegationIntakeSummary,
    buildPrivateDelegationWorkspaceRouteMessage,
    buildPrivateIngressProcessingRequest,
    buildUBuddyDelegationProcessingPrompt,
    collectDelegationGeneratedFiles,
    delegationIntakeRevisionKey,
    deterministicPrivateIngressReply,
    displayAuthUserName,
    delegationWorkspaceEpoch,
    ensureDelegationWorkspaceSession,
    ensureDelegationEditableDraftFile,
    ensureDelegationTaskWorkspace,
    listDelegationWorkspaceDeliverables,
    fallbackUBuddyDelegationProcessing,
    hasExplicitDelegationFileRequest,
    isDelegationInformationOnlyRequest,
    latestDelegationPublishCandidate,
    mergeDelegationWorkspaceMessages,
    parseUBuddyDelegationProcessingAnswer,
    privateDelegationWorkspaceMessages,
    publicDelegationAttachment,
    safeCollaborationFilename,
    snapshotDelegationWorkspaceDeliverables,
    isSecretaryIdentityQuestion,
    isSecretaryContextCollectionMessage,
    isSecretaryPublishConfirmation,
    hasSecretaryAccountReference,
    ensureSecretaryConversationSeed,
    recordSecretaryDelegationFeedback,
    delegationRequiresHumanApproval,
    publicDelegationExecutionFailure,
    localCollaborationTaskAction,
    publicLocalTaskActionMetadata,
    collaborationTaskStatusReply,
    collaborationInstructionForFriend,
    syncCollaborationGroupWorkspace,
    syncDelegationWorkspaceMessages,
    uniqueDelegationAttachments,
    uploadCollaborationTaskAttachments,
    runtimeRoot,
    auth,
    store,
    socialRelay: baseSocialRelay,
    cloudSync,
    org,
    scheduler,
    agentExecution,
    evolution,
    modelCatalog,
    activeRuns,
    activeChatRuns,
    effectiveCurrentUser,
    triggerAutoSync,
    agentStatuses,
    classifyDelegationWorkspaceIntent,
    normalizeWorkspaceKey,
    ChatRunCancelled,
    statusRank,
    enrichPptChatContext,
    sessionPatchFromPayload,
    emitCodexChatEvent,
    emitChatEvent,
    withAsyncHeartbeat,
    collaborationCommandSecret,
    internalWorkspaceExecutionToken,
    runtimeState,
    createUBuddyDiagnosticEmitter,
    uBuddyFeatureFlags,
  } = context;
  const socialRelay = baseSocialRelay;
  const emitUBuddyDiagnostic = createUBuddyDiagnosticEmitter({ source: 'ubuddy-workspace' });
  const activeWorkspaceId = () => {
    const userId = auth.currentUser()?.id || '';
    return userId ? store.activeAccountWorkspace?.({ userId, deviceId: store.contextDeviceId?.() || 'local' })?.id || 'workspace_personal' : 'workspace_personal';
  };
  const workspaceMessageMetadata = (delegation = {}, extra = {}) => ({
    ...extra,
    delegationId: delegation.id || '',
    privateTaskWorkspace: true,
    workspaceEpoch: delegationWorkspaceEpoch(delegation),
  });
  const delegationGroupId = (delegation = {}) => String(delegation.groupId || delegation.group_id || delegation.metadata?.groupId || '').trim();
  const syncSharedTaskWorkspace = async (delegation, user, mode = 'pull') => {
    const groupId = delegationGroupId(delegation);
    if (!groupId) return null;
    return syncCollaborationGroupWorkspace({
      runtimeRoot,
      auth,
      socialRelay,
      userId: user.id,
      groupId,
      workspaceId: delegation.workspaceId || delegation.accountWorkspaceId,
      mode,
    });
  };
  const resolvePrivateWorkspace = async (delegation, user, workspaceRoot, remoteWorkspace = null) => {
    const resolved = ensureDelegationWorkspaceSession({
      auth,
      store,
      delegation,
      user,
      workspaceRoot,
      remoteWorkspace: remoteWorkspace?.workspace || remoteWorkspace,
      newId,
    });
    if (socialRelay.connected() && (resolved.repaired
      || String(remoteWorkspace?.workspace?.metadata?.workspaceEpoch || remoteWorkspace?.metadata?.workspaceEpoch || '') !== resolved.workspaceEpoch)) {
      await socialRelay.updateDelegation(delegation.id, {
        sessionId: resolved.session.id,
        metadata: privateAgentDelegationMetadata(resolved.metadata),
      }).catch(() => null);
    }
    return {
      ...resolved,
      delegation: auth.agentDelegationById(delegation.id) || {
        ...delegation,
        sessionId: resolved.session.id,
        metadata: resolved.metadata,
      },
    };
  };
  const createCommandAuthorization=({ownerUserId,commandId,targetUserIds=[],targetAgentKeys=[],dispatchType='',intent='',requiresTaskGroup=false,selectionDigest='',extended=false,expiresAt=new Date(Date.now()+24*60*60*1000).toISOString()}={})=>{
    const allowedTargetUserIds=[...new Set(targetUserIds.map(String).filter(Boolean))].sort();
    const allowedTargetAgentKeys=[...new Set(targetAgentKeys.map(String).filter(Boolean))].sort();
    const payload=extended
      ? JSON.stringify({ownerUserId:String(ownerUserId||''),commandId:String(commandId||''),allowedTargetUserIds,allowedTargetAgentKeys,
          dispatchType:String(dispatchType||''),intent:String(intent||''),requiresTaskGroup:Boolean(requiresTaskGroup),selectionDigest:String(selectionDigest||''),expiresAt})
      : selectionDigest
        ? JSON.stringify({ownerUserId:String(ownerUserId||''),commandId:String(commandId||''),allowedTargetUserIds,
            selectionDigest:String(selectionDigest),expiresAt})
        : JSON.stringify({ownerUserId:String(ownerUserId||''),commandId:String(commandId||''),allowedTargetUserIds,expiresAt});
    const token=crypto.createHmac('sha256',collaborationCommandSecret).update(payload).digest('hex');
    return extended
      ? {allowedTargetUserIds,allowedTargetAgentKeys,dispatchType:String(dispatchType||''),intent:String(intent||''),requiresTaskGroup:Boolean(requiresTaskGroup),selectionDigest:String(selectionDigest||''),expiresAt,token}
      : {allowedTargetUserIds,...(selectionDigest?{selectionDigest:String(selectionDigest)}:{}),expiresAt,token};
  };
  const assertCommandAuthorization=({userId,commandId,assignments=[],plannedRecipientIds=[],authorization={}}={})=>{
    const allowed=[...new Set((authorization?.allowedTargetUserIds||[]).map(String).filter(Boolean))].sort();
    const extended=Object.prototype.hasOwnProperty.call(authorization||{},'allowedTargetAgentKeys')
      || Object.prototype.hasOwnProperty.call(authorization||{},'dispatchType')
      || Object.prototype.hasOwnProperty.call(authorization||{},'intent')
      || Object.prototype.hasOwnProperty.call(authorization||{},'requiresTaskGroup');
    const expected=createCommandAuthorization({ownerUserId:userId,commandId,targetUserIds:allowed,
      targetAgentKeys:authorization?.allowedTargetAgentKeys||[],dispatchType:authorization?.dispatchType||'',
      intent:authorization?.intent||'',requiresTaskGroup:Boolean(authorization?.requiresTaskGroup),selectionDigest:authorization?.selectionDigest||'',extended,expiresAt:authorization?.expiresAt}).token;
    const assignmentTargets=[...new Set((assignments||[]).map((item)=>String(item.recipientId||'')).filter(Boolean))].sort();
    const targets=assignmentTargets.length?assignmentTargets
      :[...new Set((plannedRecipientIds||[]).map(String).filter(Boolean))].sort();
    if(!commandId||authorization?.token!==expected||Date.parse(authorization?.expiresAt||'')<=Date.now()||!targets.length||JSON.stringify(targets)!==JSON.stringify(allowed)){
      const error=new Error('外部委托必须来自有效的结构化 @ 派发命令。');error.code='collaboration_command_authorization_required';throw error;
    }
  };
  const internalNaturalGroupDispatch = Symbol('internalNaturalGroupDispatch');
  const activeNaturalGroupDispatches = new Set();
  const naturalGroupDispatchTimers = new Map();
  let runtimeApi = null;
  const publishNaturalGroupWorkflowStatus = async (dispatch = {}, {
    workspaceId = '', status = 'planning', content = '', attempt = 0, versionKey = '', extraMetadata = {},
  } = {}) => {
    const groupId = String(dispatch?.sourceType || '') === 'natural_chat_group'
      ? String(dispatch?.sourceGroupId || '').trim()
      : '';
    if (!groupId) return null;
    const resolvedWorkspaceId = String(workspaceId || activeWorkspaceId()).trim() || activeWorkspaceId();
    const version = Math.max(0, Number(attempt || 0));
    const payload = {
      workspaceId: resolvedWorkspaceId,
      content,
      clientMessageId: `ubuddy_multi_workflow:${dispatch.id}:${status}:${version}:${String(versionKey || '')}`.slice(0, 200),
      senderAgentId: 'secretary_agent',
      kind: 'agent',
      metadata: {
        type: 'ubuddy_multi_task_status',
        status,
        dispatchCommandId: dispatch.id,
        sourceMessageId: dispatch.sourceMessageId,
        ownerUserId: auth.currentUser()?.id || '',
        attempt: version,
        ...extraMetadata,
      },
    };
    try {
      return socialRelay.connected()
        ? await socialRelay.sendChatGroupMessage(groupId, payload)
        : auth.sendChatGroupMessage({ groupId, ...payload });
    } catch (error) {
      emitUBuddyDiagnostic('ubuddy_natural_group_status_publish_failed', {
        level: 'warn', data: { commandId: dispatch.id, status, groupId }, error,
      });
      return null;
    }
  };
  const scheduleNaturalGroupDispatch = ({ commandId = '', delayMs = 0 } = {}) => {
    const cleanCommandId = String(commandId || '').trim();
    if (!cleanCommandId || activeNaturalGroupDispatches.has(cleanCommandId) || naturalGroupDispatchTimers.has(cleanCommandId)) return;
    const timer = setTimeout(async () => {
      naturalGroupDispatchTimers.delete(cleanCommandId);
      if (runtimeState.closed || activeNaturalGroupDispatches.has(cleanCommandId)) return;
      const ledger = store.getUBuddyDispatchCommand(cleanCommandId);
      if (!ledger || ledger.ownerUserId !== auth.currentUser()?.id
        || !['selection_saved', 'retry_wait'].includes(String(ledger.status || ''))) return;
      if (ledger.status === 'retry_wait' && Date.parse(ledger.nextAttemptAt || '') > Date.now()) {
        scheduleNaturalGroupDispatch({ commandId: cleanCommandId, delayMs: Date.parse(ledger.nextAttemptAt) - Date.now() });
        return;
      }
      activeNaturalGroupDispatches.add(cleanCommandId);
      let retrySchedule = null;
      try {
        const command = ledger.command || {};
        const outcome = await runtimeApi.dispatchCollaborationCommand({
          content: command.sourceContent || command.instruction,
          sourcePeerId: command.sourcePeerId,
          sourceConversationId: command.sourceConversationId,
          sourceMessageId: command.sourceMessageId,
          sourceGroupId: command.sourceGroupId,
          sourceType: command.sourceType,
          workspaceId: ledger.accountWorkspaceId,
          mentions: command.mentions,
          mentionSelectionVersion: UBUDDY_MENTION_SELECTION_VERSION,
          participantSelectionPolicyVersion: command.participantSelectionPolicyVersion
            || UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
          participantSelectionPolicy: command.participantSelectionPolicy || 'all_mentioned',
          attachments: command.attachments,
          participantPolicy: 'all_mentioned',
          autoExecutionPolicy: 'low_medium_risk',
          [internalNaturalGroupDispatch]: true,
        });
        if (outcome?.waitingForPresence) {
          retrySchedule = { commandId: cleanCommandId, delayMs: 15_000 };
        }
      } catch (error) {
        const failed = store.getUBuddyDispatchCommand(cleanCommandId);
        const retrying = failed?.status === 'retry_wait';
        await publishNaturalGroupWorkflowStatus(failed?.command || ledger.command, {
          workspaceId: failed?.accountWorkspaceId || ledger.accountWorkspaceId,
          status: retrying ? 'retry_wait' : 'failed',
          attempt: failed?.attemptCount || ledger.attemptCount || 0,
          content: retrying
            ? 'uBuddy 暂时无法完成多人分工，已进入自动重试；原群消息已发送，不需要重复发送。'
            : 'uBuddy 未能可靠完成多人分工，因此没有派发任务。原群消息仍然有效，你可以重试或直接说明每个人负责什么。',
          extraMetadata: { retryable: retrying },
        });
        if (retrying) {
          retrySchedule = {
            commandId: cleanCommandId,
            delayMs: Math.max(250, Date.parse(failed.nextAttemptAt || '') - Date.now()),
          };
        }
        emitUBuddyDiagnostic('ubuddy_natural_group_dispatch_failed', {
          level: retrying ? 'warn' : 'error', data: { commandId: cleanCommandId, retrying }, error,
        });
      } finally {
        activeNaturalGroupDispatches.delete(cleanCommandId);
        if (retrySchedule) scheduleNaturalGroupDispatch(retrySchedule);
      }
    }, Math.max(0, Number(delayMs || 0)));
    timer.unref?.();
    naturalGroupDispatchTimers.set(cleanCommandId, timer);
  };
  runtimeApi = {
    collaborationOverview() {
      auth.requireUser();
      const workspaceId = activeWorkspaceId();
      if (socialRelay.connected()) return socialRelay.collaborationOverview({ workspaceId });
      return auth.collaborationOverview({ workspaceId });
    },
    collaborationGroup({ groupId = '', workspaceId: requestedWorkspaceId = '', localHistoryOnly = false } = {}) {
      auth.requireUser();
      const workspaceId = String(requestedWorkspaceId || activeWorkspaceId()).trim() || activeWorkspaceId();
      if (socialRelay.connected()) return socialRelay.collaborationGroup(groupId, { workspaceId, localHistoryOnly: localHistoryOnly === true });
      return auth.collaborationGroup(groupId, { workspaceId });
    },
    async collaborationGroupWorkspace({ groupId = '', mode = 'both' } = {}) {
      const user = auth.requireUser();
      const cleanGroupId = String(groupId || '').trim();
      if (!cleanGroupId) throw new Error('缺少任务群 ID。');
      const workspaceId = activeWorkspaceId();
      if (socialRelay.connected()) await socialRelay.collaborationGroup(cleanGroupId, { workspaceId });
      else auth.collaborationGroup(cleanGroupId, { workspaceId });
      return syncCollaborationGroupWorkspace({
        runtimeRoot,
        auth,
        socialRelay,
        userId: user.id,
        groupId: cleanGroupId,
        workspaceId,
        mode: ['pull', 'push', 'both'].includes(String(mode || '')) ? String(mode) : 'both',
      });
    },
    async dispatchCollaborationCommand({
      content = '', sourcePeerId = '', sourceConversationId = '', sourceMessageId = '', sourceGroupId = '',
      sourceType = 'direct_chat', workspaceId = '', mentions = [], mentionSelectionVersion = '', contextMessages = [],
      attachments = [], participantPolicy = '', autoExecutionPolicy = '', confirmationCommandId = '',
      participantSelectionPolicyVersion = '', participantSelectionPolicy = '',
      [internalNaturalGroupDispatch]: backgroundNaturalGroupDispatch = false,
    } = {}) {
      const user = auth.requireUser();
      const requestedConfirmationCommandId = String(confirmationCommandId || '').trim();
      if (requestedConfirmationCommandId) {
        const currentUser = auth.requireUser();
        const pending = store.getUBuddyDispatchCommand(requestedConfirmationCommandId);
        const confirmableReason = ['high_risk_confirmation_required', 'automatic_collaboration_plan_requires_confirmation']
          .includes(String(pending?.result?.reasonCode || ''));
        if (!pending || pending.ownerUserId !== currentUser.id
          || pending.status !== 'clarification'
          || !confirmableReason) {
          const error = new Error('这项待确认规划已失效、已处理，或不属于当前账号。');
          error.code = 'ubuddy_planning_confirmation_invalid';
          throw error;
        }
        const confirmingHighRisk = pending.result?.reasonCode === 'high_risk_confirmation_required';
        const reopened = store.reopenUBuddyDispatchCommand({
          commandId: requestedConfirmationCommandId,
          result: {
            confirmedHighRisk: confirmingHighRisk,
            planningConfirmed: !confirmingHighRisk,
            confirmedAt: new Date().toISOString(),
          },
        });
        await publishNaturalGroupWorkflowStatus(reopened.command, {
          workspaceId: reopened.accountWorkspaceId,
          status: 'planning',
          attempt: reopened.attemptCount,
          content: pending.result?.reasonCode === 'high_risk_confirmation_required'
            ? '发起人已确认高风险操作范围，uBuddy 正在后台继续持续规划。原群消息已经发送，可以继续聊天。'
            : '发起人已确认持续规划方案，uBuddy 正在后台创建任务并安排执行。',
          extraMetadata: { confirmedHighRisk: confirmingHighRisk, planningConfirmed: !confirmingHighRisk },
        });
        scheduleNaturalGroupDispatch({ commandId: requestedConfirmationCommandId });
        return { ok: true, dispatched: false, queued: true, confirmationAccepted: true, commandId: requestedConfirmationCommandId };
      }
      const normalizedMentions = normalizeMentionEntities(mentions, { content, requirePicker: true });
      const ownMentionTexts = normalizedMentions.filter((item) => item.principalType === 'ubuddy' && item.ownerUserId === auth.currentUser()?.id).map((item) => item.displayText);
      const cleanContent = ownMentionTexts.reduce((text, token) => text.replaceAll(token, ''), String(content || '')).trim();
      if (!cleanContent && !attachments.length) {
        return {
          ok: true,
          dispatched: false,
          clarification: {
            reasonCode: 'missing_requirement',
            content: '我已经识别到接收人，但还缺少明确的任务要求。请补充需要完成的内容、期望交付物或相关附件。',
            sourceConversationId: String(sourceConversationId || '').trim(),
            sourcePeerId: String(sourcePeerId || '').trim(),
            localOnly: true,
          },
        };
      }
      if (!hasExplicitDelegationIntent({ content: cleanContent, mentions: normalizedMentions })) {
        return {
          ok: true,
          dispatched: false,
          contextCollected: true,
          clarification: {
            reasonCode: 'discussion_does_not_authorize_dispatch',
            content: '这条消息已按讨论或背景补充处理，没有创建任务群。需要开始协作时，请明确说明“创建任务”或写清每位参与人的分工。',
            sourceConversationId: String(sourceConversationId || '').trim(),
            sourcePeerId: String(sourcePeerId || '').trim(),
            localOnly: true,
          },
        };
      }
      const dispatchWorkspaceId = String(workspaceId || activeWorkspaceId()).trim() || activeWorkspaceId();
      const friendships = auth.listFriends({ workspaceId: dispatchWorkspaceId });
      const ownUBuddyMentioned = normalizedMentions.some((item) => item.principalType === 'ubuddy' && item.ownerUserId === auth.currentUser()?.id);
      const requestedUserIds = new Set(normalizedMentions.map((item) => (
        item.principalType === 'user' ? item.userId
          : item.principalType === 'ubuddy' && item.ownerUserId !== auth.currentUser()?.id ? item.ownerUserId : ''
      )).filter(Boolean));
      if (ownUBuddyMentioned && sourcePeerId) requestedUserIds.add(String(sourcePeerId).trim());
      const relationships = friendships.filter((item) => requestedUserIds.has(String((item.friend || item.user || item)?.id || '')));
      if (!relationships.length || relationships.length !== requestedUserIds.size) {
        return {
          ok: true,
          dispatched: false,
          clarification: {
            reasonCode: 'missing_recipient',
            content: '我还没有收到可用的结构化接收人。请从 @ 菜单选择已接受的联系人。',
            sourceConversationId: String(sourceConversationId || '').trim(),
            sourcePeerId: String(sourcePeerId || '').trim(),
            localOnly: true,
          },
        };
      }
      const explicitContext = (Array.isArray(contextMessages) ? contextMessages : [])
        .filter((message) => message?.explicitDelegationContext === true)
        .map((message) => `${message.mine ? '我' : '好友'}：${String(message.content || '').trim()}`)
        .filter((line) => !line.endsWith('：'))
        .join('\n');
      const processingContent = [explicitContext ? `本次明确选取的任务上下文：\n${explicitContext}` : '', `本次发布指令：${cleanContent || '请结合附件整理任务。'}`].filter(Boolean).join('\n\n');
      const instruction = cleanContent || '请结合附件完成任务并返回可核验结果。';
      const titleSource = cleanContent || attachments?.[0]?.name || 'uBuddy 任务';
      const title = String(titleSource || instruction || 'uBuddy 任务群').replace(/\s+/g, ' ').slice(0, 80);
      const assignmentSource = normalizedMentions
        .filter((item) => item.principalType === 'user' || (item.principalType === 'ubuddy' && item.ownerUserId !== auth.currentUser()?.id))
        .map((item) => String(item.displayText || '').trim())
        .filter(Boolean)
        .reduce((text, token) => text.replaceAll(token, ''), cleanContent)
        .trim();
      const commandId = String(sourceMessageId || newId('dispatch_command')).trim();
      const candidateUserIds = relationships.map((relationship) => String((relationship.friend || relationship.user || relationship)?.id || '')).filter(Boolean);
      const mentionSelection = normalizeMentionSelectionContext({
        mentions: normalizedMentions,
        content,
        resolvedCandidateUserIds: candidateUserIds,
        participantSelectionPolicyVersion,
        participantSelectionPolicy,
        requirePicker: true,
      });
      const selectionMode = candidateUserIds.length === 1 ? 'explicit_single' : mentionSelection.selectionMode;
      let dispatch = validateUBuddyDispatchV3({
        version: 3,
        id: commandId,
        title,
        dispatchType: 'task_group',
        intent: relationships.length > 1 ? 'multi_agent_task' : 'single_agent_task',
        objective: instruction,
        deliverables: ['完成正式委托并返回可核验结果'],
        requiresTaskGroup: true,
        taskGroupReasons: relationships.length > 1 ? ['multiple_recipients'] : ['explicit_task_group'],
        sourceType: String(sourceType || 'direct_chat').trim(),
        sourcePeerId: String(sourcePeerId || '').trim(),
        sourceConversationId: String(sourceConversationId || `direct:${auth.currentUser()?.id || ''}:${sourcePeerId || ''}`).trim(),
        sourceMessageId: String(sourceMessageId || '').trim(),
        sourceGroupId: String(sourceGroupId || '').trim(),
        sourceContent: cleanContent,
        mentions: normalizedMentions,
        participantSelectionPolicyVersion: mentionSelection.participantSelectionPolicyVersion,
        participantSelectionPolicy: mentionSelection.participantSelectionPolicy,
        contextMessageIds: (Array.isArray(contextMessages) ? contextMessages : [])
          .filter((item) => item?.explicitDelegationContext === true)
          .map((item) => item.id).filter(Boolean),
        instruction,
        attachments: Array.isArray(attachments) ? attachments : [],
        selectionMode,
        candidateUserIds,
        requiredUserIds: ['explicit_single', 'all_selected'].includes(selectionMode) ? candidateUserIds : [],
        selectedUserIds: candidateUserIds,
        profileRevisionSnapshots: [],
        selectionDecision: {
          version: 'ubuddy_peer_selection_v1', status: 'ready', rejectedCandidates: [], scoreBreakdown: [], confidence: 1,
          strategyVersion: 'legacy_all_mentions_v1',
          rationale: '自动 Profile 筛选未启用，沿用所有明确 @ 用户参与的兼容行为。',
          clarification: { reasonCode: '', question: '' },
        },
        participants: relationships.map((relationship) => {
          const friend = relationship.friend || relationship.user || relationship;
          return { userId: friend.id, user: friend, selected: true };
        }),
        assignments: relationships.map((relationship) => {
          const friend = relationship.friend || relationship.user || relationship;
          const friendInstruction = collaborationInstructionForFriend(assignmentSource, friend, instruction);
          const completeInstruction = relationships.length === 1 || friendInstruction === instruction
            ? instruction
            : explicitContext ? `${friendInstruction}\n\n共享背景与要求：\n${explicitContext}` : friendInstruction;
          return { recipientId: friend.id, title: relationships.length > 1 ? `${title} · ${displayAuthUserName(friend)}`.slice(0, 80) : title, instruction: completeInstruction, metadata: { attachments } };
        }),
        missingInfo: [],
        private: true,
        ubuddyProcessingMode: 'deterministic',
        diagnostics: null,
      }, { throwOnError: true }).value;
      let frozenCommandLedger = store.getUBuddyDispatchCommand(commandId);
      if (frozenCommandLedger?.command) {
        const frozen = validateUBuddyDispatchV3(frozenCommandLedger.command, { throwOnError: true }).value;
        const sameSource = frozen.sourceMessageId === dispatch.sourceMessageId
          && frozen.sourceConversationId === dispatch.sourceConversationId
          && frozen.sourceGroupId === dispatch.sourceGroupId
          && frozen.sourceContent === dispatch.sourceContent
          && [...frozen.candidateUserIds].sort().join('|') === [...dispatch.candidateUserIds].sort().join('|');
        if (!sameSource) {
          const error = new Error('派发命令 ID 已被不同请求占用。');
          error.code = 'ubuddy_dispatch_idempotency_conflict';
          throw error;
        }
        dispatch = frozen;
      }
      const continuousPlanningContract = relationships.length > 0 && Boolean(instruction);
      const backgroundContinuousPlanning = continuousPlanningContract
        && dispatch.sourceType === 'natural_chat_group';
      let continuousPlanningSession = null;
      if (continuousPlanningContract) {
        const planningSessionId = `ubuddy-planning:natural:${sha256Text(`${dispatch.sourceConversationId}\n${dispatch.sourceMessageId}`).slice(0, 40)}`;
        continuousPlanningSession = store.getUBuddyPlanningSession({ id: planningSessionId })
          || store.createUBuddyPlanningSession({
            id: planningSessionId,
            ownerUserId: auth.currentUser().id,
            accountWorkspaceId: dispatchWorkspaceId,
            sourceSessionId: dispatch.sourceConversationId,
            sourceMessageId: dispatch.sourceMessageId,
            modelConfig: {},
            plan: {},
            status: 'planning',
          });
        if (frozenCommandLedger?.status !== 'published') {
          dispatch = validateUBuddyDispatchV3({
            ...dispatch,
            version: 3,
            planningSessionId: continuousPlanningSession.id,
            planningRevision: continuousPlanningSession.revision,
          }, { throwOnError: true }).value;
        }
      }
      if (continuousPlanningContract && !frozenCommandLedger) {
        frozenCommandLedger = store.reserveUBuddyDispatchCommand({
          command: dispatch,
          accountWorkspaceId: dispatchWorkspaceId,
          ownerUserId: auth.currentUser().id,
          sourceSessionId: dispatch.sourceConversationId,
          sourceMessageId: dispatch.sourceMessageId,
        }).command;
        if (delegationRequiresHumanApproval({ title, instruction })) {
          const confirmationResult = {
            reasonCode: 'high_risk_confirmation_required',
            content: '这项多人任务包含高风险操作，尚未派发。请由发起人在本群确认操作范围后继续。',
            confirmationRequired: true,
            sourceConversationId: String(sourceConversationId || '').trim(),
            sourcePeerId: String(sourcePeerId || '').trim(),
            localOnly: true,
          };
          frozenCommandLedger = store.clarifyUBuddyDispatchCommand({ commandId, result: confirmationResult });
          await publishNaturalGroupWorkflowStatus(dispatch, {
            workspaceId: dispatchWorkspaceId,
            status: 'confirmation_required',
            content: confirmationResult.content,
            extraMetadata: { confirmationRequired: true, confirmationCommandId: commandId },
          });
          return { ok: true, dispatched: false, commandId, clarification: confirmationResult };
        }
        await publishNaturalGroupWorkflowStatus(dispatch, {
          workspaceId: dispatchWorkspaceId,
          status: 'planning',
          content: '群消息已发送。uBuddy 正在后台判断协作方式并为所有被 @ 的成员生成分工；你可以继续聊天。',
        });
        if (backgroundContinuousPlanning && !backgroundNaturalGroupDispatch) {
          scheduleNaturalGroupDispatch({ commandId });
          return { ok: true, dispatched: false, queued: true, commandId, sourceMessageId: dispatch.sourceMessageId };
        }
      }
      if (backgroundContinuousPlanning && frozenCommandLedger && !backgroundNaturalGroupDispatch) {
        if (frozenCommandLedger.status === 'published') {
          // The normal idempotent replay below reconstructs the frozen task-group result.
        } else if (frozenCommandLedger.status === 'clarification') {
          return { ok: true, dispatched: false, idempotent: true, commandId, clarification: frozenCommandLedger.result };
        } else if (frozenCommandLedger.status === 'failed') {
          return {
            ok: true, dispatched: false, idempotent: true, commandId,
            clarification: {
              reasonCode: 'collaboration_planning_failed',
              content: '原群消息已发送，但 uBuddy 未能可靠完成多人分工。请重试或直接说明每个人负责什么。',
              localOnly: true,
            },
          };
        } else {
          scheduleNaturalGroupDispatch({ commandId,
            delayMs: frozenCommandLedger.status === 'retry_wait'
              ? Math.max(0, Date.parse(frozenCommandLedger.nextAttemptAt || '') - Date.now()) : 0 });
          return { ok: true, dispatched: false, queued: true, idempotent: true, commandId };
        }
      }
      if (backgroundContinuousPlanning && backgroundNaturalGroupDispatch) {
        if (frozenCommandLedger?.status === 'clarification'
          && frozenCommandLedger.result?.confirmedHighRisk !== true
          && frozenCommandLedger.result?.planningConfirmed !== true) {
          return { ok: true, dispatched: false, commandId, clarification: frozenCommandLedger.result };
        }
        frozenCommandLedger = store.claimUBuddyDispatchCommand({ commandId });
        if (!frozenCommandLedger || frozenCommandLedger.status !== 'dispatching') {
          if (frozenCommandLedger?.status === 'published') {
            // Continue to the published replay below.
          } else {
            const error = new Error('多人任务后台规划作业当前不可执行。');
            error.code = 'ubuddy_dispatch_not_recoverable';
            throw error;
          }
        }
      }
      const requiresContinuousPlanning = continuousPlanningContract
        && frozenCommandLedger?.status !== 'published'
        && (backgroundNaturalGroupDispatch || !backgroundContinuousPlanning);
      if (requiresContinuousPlanning) {
        const selectedModel = modelCatalog.resolveSelection({});
        let modeDecision;
        let continuousPlanningDecision;
        try {
          continuousPlanningDecision = await planUBuddyContinuously({
            planningSessionId: continuousPlanningSession.id,
            revision: continuousPlanningSession.revision,
            prompt: processingContent,
            priorDecision: continuousPlanningSession.plan?.decision || null,
            directive: continuousPlanningSession.plan?.decision ? 'retry' : 'initial',
            taskMode: true,
            recentMessages: contextMessages,
            authorizedUsers: relationships.map((relationship) => {
              const friend = relationship.friend || relationship.user || relationship;
              return { userId: friend.id, displayName: displayAuthUserName(friend) };
            }),
            requiredUserIds: candidateUserIds,
            attachments: dispatch.attachments,
            root: runtimeRoot,
            cwd: runtimeRoot,
            model: selectedModel.model,
            plannerThreadId: continuousPlanningSession.codexThreadId,
            plannerSessionId: dispatch.sourceConversationId,
            execute: runCodexSession,
            executionContext: { store, userId: user.id, conversationId: dispatch.sourceConversationId,
              departmentId: 'secretary_department', agentId: 'secretary_agent', executionKind: 'ubuddy_continuous_planning_natural_group' },
          });
          const planningStatus = continuousPlanningDecision.decision === 'awaiting_clarification'
            ? 'awaiting_clarification' : 'ready_to_dispatch';
          continuousPlanningSession = store.updateUBuddyPlanningSession({
            id: continuousPlanningSession.id,
            baseRevision: continuousPlanningSession.revision,
            status: planningStatus,
            plan: { decision: continuousPlanningDecision },
            codexThreadId: continuousPlanningDecision.plannerThreadId,
            lastError: {},
          });
          modeDecision = {
            decision: continuousPlanningDecision.decision === 'awaiting_clarification' ? 'clarification' : 'ready',
            collaborationMode: continuousPlanningDecision.collaboration.mode,
            initiatorParticipation: continuousPlanningDecision.collaboration.initiatorParticipation,
            assignmentIntent: continuousPlanningDecision.collaboration.assignmentIntent,
            explicitAssignments: continuousPlanningDecision.assignments,
            confidence: continuousPlanningDecision.confidence,
            clarification: continuousPlanningDecision.clarifications[0] || { reasonCode: '', question: '' },
          };
        } catch (error) {
          if (continuousPlanningSession) continuousPlanningSession = store.updateUBuddyPlanningSession({
            id: continuousPlanningSession.id,
            baseRevision: continuousPlanningSession.revision,
            status: 'retryable_failure',
            codexThreadId: error?.plannerThreadId === undefined
              ? continuousPlanningSession.codexThreadId : error.plannerThreadId,
            lastError: { code: error?.code || 'ubuddy_continuous_planning_failed', message: String(error?.message || error).slice(0, 2000) },
          });
          if (requiresContinuousPlanning) {
            store.failUBuddyDispatchCommand({
              commandId,
              error: error?.message || error,
              retryable: true,
              retryDelayMs: Math.min(30_000, 1_000 * (2 ** Math.max(0, Number(frozenCommandLedger?.attemptCount || 1) - 1))),
            });
            throw error;
          }
          return {
            ok: true, dispatched: false,
            clarification: {
              reasonCode: 'collaboration_mode_model_failed',
              content: `uBuddy 暂时无法生成可靠的多人分工，因此没有派发。请重试；${String(error?.message || error || '').slice(0, 240)}`,
              sourceConversationId: String(sourceConversationId || '').trim(), sourcePeerId: String(sourcePeerId || '').trim(), localOnly: true,
            },
          };
        }
        if (modeDecision.decision === 'clarification' || modeDecision.collaborationMode === 'peer_collaboration') {
          const question = modeDecision.decision === 'clarification'
            ? modeDecision.clarification.question
            : '这条群消息明确要求发起人也承担工作。请在 uBuddy 主聊天中发起，以便建立发起人的本地分工。';
          const clarification = {
            reasonCode: modeDecision.decision === 'clarification' ? modeDecision.clarification.reasonCode : 'peer_collaboration_requires_ubuddy_chat',
            content: question,
            sourceConversationId: String(sourceConversationId || '').trim(), sourcePeerId: String(sourcePeerId || '').trim(), localOnly: true,
          };
          if (requiresContinuousPlanning) {
            store.clarifyUBuddyDispatchCommand({ commandId, result: clarification });
            await publishNaturalGroupWorkflowStatus(dispatch, {
              workspaceId: dispatchWorkspaceId,
              status: 'action_required',
              attempt: frozenCommandLedger?.attemptCount || 0,
              content: `uBuddy 需要发起人补充确认后才能派发：${question}`,
              extraMetadata: { reasonCode: clarification.reasonCode },
            });
          }
          return {
            ok: true, dispatched: false,
            clarification,
          };
        }
        const allSelectedDecision = {
          version: 'ubuddy_peer_selection_v1', status: 'ready', selectionMode: candidateUserIds.length === 1 ? 'explicit_single' : 'all_selected',
          candidateUserIds, requiredUserIds: candidateUserIds, selectedUserIds: candidateUserIds,
          rejectedCandidates: [], scoreBreakdown: [], confidence: modeDecision.confidence,
          strategyVersion: 'all_mentioned_confirmation_v1', rationale: '所有被明确 @ 的人员都进入分工方案，必须由发起人确认后才会派发。',
          clarification: { reasonCode: '', question: '' },
        };
        let collaborationPlan;
        let profileRevisionSnapshots = [];
        let routingShadow = null;
        if (modeDecision.assignmentIntent === 'explicit') {
          collaborationPlan = validateUBuddyCollaborationPlan({
            version: UBUDDY_COLLABORATION_PLAN_VERSION,
            proposalId: `ubuddy-plan:${commandId}`,
            revision: 1,
            status: 'confirmed',
            collaborationMode: modeDecision.collaborationMode,
            initiatorParticipation: modeDecision.initiatorParticipation,
            assignmentSource: 'explicit_user',
            candidateUserIds,
            requiredUserIds: candidateUserIds,
            selectedUserIds: candidateUserIds,
            profileRevisionSnapshots: [],
            selectionDecision: allSelectedDecision,
            assignments: modeDecision.explicitAssignments,
            finalIntegrator: 'self_ubuddy', confirmationRequired: false,
            confidence: modeDecision.confidence, strategyVersion: 'explicit_user_assignments_v1',
            createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString(),
          }).value;
        } else {
          collaborationPlan = validateUBuddyCollaborationPlan({
            version: UBUDDY_COLLABORATION_PLAN_VERSION,
            proposalId: `ubuddy-plan:${commandId}`,
            revision: Math.max(1, Number(continuousPlanningSession.revision || 1)),
            status: 'awaiting_confirmation',
            collaborationMode: modeDecision.collaborationMode,
            initiatorParticipation: modeDecision.initiatorParticipation,
            assignmentSource: 'ubuddy_planned',
            candidateUserIds,
            requiredUserIds: candidateUserIds,
            selectedUserIds: candidateUserIds,
            profileRevisionSnapshots,
            selectionDecision: allSelectedDecision,
            assignments: continuousPlanningDecision.assignments,
            finalIntegrator: 'self_ubuddy', confirmationRequired: true,
            confidence: modeDecision.confidence, strategyVersion: 'ubuddy_continuous_planning_v1',
            createdAt: new Date().toISOString(), confirmedAt: '',
          }, { throwOnError: true }).value;
        }
        if (modeDecision.assignmentIntent !== 'explicit' && candidateUserIds.length > 1
          && frozenCommandLedger?.result?.planningConfirmed !== true) {
          const assignmentLabels = new Map(relationships.map((relationship) => {
            const friend = relationship.friend || relationship.user || relationship;
            return [String(friend.id || ''), displayAuthUserName(friend)];
          }));
          const planSummary = (collaborationPlan.assignments || []).map((assignment, index) => {
            const assignee = assignment.assigneeKind === 'self'
              ? '发起人'
              : assignmentLabels.get(String(assignment.userId || '')) || assignment.userId || '参与人';
            return `${index + 1}. ${assignee}：${assignment.title || assignment.objective}`;
          }).join('\n');
          const clarification = {
            reasonCode: 'automatic_collaboration_plan_requires_confirmation',
            content: [
              'uBuddy 已生成自动分工方案，但尚未创建任务群。',
              planSummary,
              '请到 uBuddy 主聊天查看完整方案并确认派发；也可以直接说明每个人负责什么后重新发送。',
            ].filter(Boolean).join('\n'),
            sourceConversationId: String(sourceConversationId || '').trim(),
            sourcePeerId: String(sourcePeerId || '').trim(),
            localOnly: true,
            collaborationPlan,
          };
          if (requiresContinuousPlanning) {
            let proposedDispatch = validateUBuddyDispatchV3({
              ...dispatch,
              id: commandId,
              dispatchType: 'task_group',
              requiresTaskGroup: true,
              selectionMode: allSelectedDecision.selectionMode,
              candidateUserIds,
              requiredUserIds: candidateUserIds,
              selectedUserIds: candidateUserIds,
              selectionDecision: allSelectedDecision,
              profileRevisionSnapshots,
              participants: dispatch.participants,
              assignments: collaborationPlanRemoteAssignments(collaborationPlan),
              collaborationPlan,
              ubuddyProcessingMode: 'model_collaboration_confirmation_v1',
              ...(routingShadow ? { routingShadow } : {}),
            }, { throwOnError: true }).value;
            proposedDispatch = freezeNaturalGroupContinuousDispatch(
              proposedDispatch, continuousPlanningSession, continuousPlanningDecision,
            );
            continuousPlanningSession = store.updateUBuddyPlanningSession({
              id: continuousPlanningSession.id,
              baseRevision: continuousPlanningSession.revision,
              status: 'awaiting_confirmation',
              dispatch: proposedDispatch,
            });
            store.replaceUBuddyDispatchCommand({ commandId, command: proposedDispatch });
            store.clarifyUBuddyDispatchCommand({ commandId, result: clarification });
            await publishNaturalGroupWorkflowStatus(proposedDispatch, {
              workspaceId: dispatchWorkspaceId,
              status: 'action_required',
              attempt: frozenCommandLedger?.attemptCount || 0,
              content: clarification.content,
              extraMetadata: {
                reasonCode: clarification.reasonCode,
                uBuddyCollaborationPlan: collaborationPlan,
              },
            });
          }
          return { ok: true, dispatched: false, commandId, clarification, collaborationPlan };
        }
        const plannedAssignments = collaborationPlanRemoteAssignments(collaborationPlan);
        dispatch = validateUBuddyDispatchV3({
          ...dispatch,
          id: commandId,
          dispatchType: 'task_group',
          requiresTaskGroup: true,
          selectionMode: allSelectedDecision.selectionMode,
          candidateUserIds,
          requiredUserIds: candidateUserIds,
          selectedUserIds: candidateUserIds,
          selectionDecision: allSelectedDecision,
          profileRevisionSnapshots,
          participants: dispatch.participants,
          assignments: plannedAssignments,
          collaborationPlan,
          ubuddyProcessingMode: 'model_collaboration_v1',
          ...(routingShadow ? { routingShadow } : {}),
        }, { throwOnError: true }).value;
        dispatch = freezeNaturalGroupContinuousDispatch(
          dispatch, continuousPlanningSession, continuousPlanningDecision,
        );
        continuousPlanningSession = store.updateUBuddyPlanningSession({
          id: continuousPlanningSession.id,
          baseRevision: continuousPlanningSession.revision,
          status: 'dispatching',
          dispatch,
        });
        if (requiresContinuousPlanning) {
          frozenCommandLedger = store.replaceUBuddyDispatchCommand({ commandId, command: dispatch });
        }
      }
      let dispatchLedger = store.getUBuddyDispatchCommand(dispatch.id);
      let routingShadow = null;
      const publishNaturalGroupTaskStatus = async (frozenDispatch, detail) => {
        const naturalGroupId = String(frozenDispatch?.sourceType || '') === 'natural_chat_group'
          ? String(frozenDispatch?.sourceGroupId || '').trim()
          : '';
        const collaborationGroupId = String(detail?.group?.id || '').trim();
        if (!naturalGroupId || !collaborationGroupId) return null;
        const tasks = Array.isArray(detail?.tasks) ? detail.tasks : [];
        const participantLabels = tasks.map((task) => displayAuthUserName(task.recipient || {}) || task.recipientUserId || '')
          .filter(Boolean);
        const payload = {
          workspaceId: dispatchWorkspaceId,
          content: `uBuddy 已完成多人分工并创建关联任务群，共派发 ${tasks.length || frozenDispatch.assignments?.length || 0} 项任务${participantLabels.length ? `：${participantLabels.join('、')}` : ''}。`,
          clientMessageId: `ubuddy_multi_status:${frozenDispatch.id}`.slice(0, 200),
          senderAgentId: 'secretary_agent',
          kind: 'agent',
          metadata: {
            type: 'ubuddy_multi_task_status',
            status: 'dispatched',
            dispatchCommandId: frozenDispatch.id,
            sourceMessageId: frozenDispatch.sourceMessageId,
            collaborationGroupId,
            assignmentCount: tasks.length || frozenDispatch.assignments?.length || 0,
            participantLabels,
          },
        };
        try {
          return socialRelay.connected()
            ? await socialRelay.sendChatGroupMessage(naturalGroupId, payload)
            : auth.sendChatGroupMessage({ groupId: naturalGroupId, ...payload });
        } catch (error) {
          emitUBuddyDiagnostic('ubuddy_natural_group_status_publish_failed', {
            level: 'warn', data: { commandId: frozenDispatch.id, status: 'dispatched', groupId: naturalGroupId }, error,
          });
          return null;
        }
      };
      const replayPublished = async (ledger) => {
        const frozen = validateUBuddyDispatchV3(ledger.command, { throwOnError: true }).value;
        const groupId = String(ledger.result?.groupId || '').trim();
        const frozenWorkspaceId = String(ledger.accountWorkspaceId || dispatchWorkspaceId).trim() || dispatchWorkspaceId;
        const detail = groupId
          ? socialRelay.connected()
            ? await socialRelay.collaborationGroup(groupId, { workspaceId: frozenWorkspaceId })
            : auth.collaborationGroup(groupId, { workspaceId: frozenWorkspaceId })
          : null;
        await publishNaturalGroupTaskStatus(frozen, detail);
        const frozenShadow = frozen.routingShadow || ledger.result?.routingShadow || null;
        return {
          ok: true,
          dispatched: true,
          idempotent: true,
          dispatchType: 'task_group',
          commandId,
          group: detail?.group || null,
          tasks: detail?.tasks || [],
          messages: detail?.messages || [],
          result: { ...(detail || {}), idempotent: true },
          ...(frozenShadow ? { routingShadow: frozenShadow } : {}),
          source: {
            id: commandId,
            content: cleanContent,
            sourceConversationId: frozen.sourceConversationId,
            sourcePeerId: frozen.sourcePeerId,
            localOnly: true,
            uBuddySelection: selectionMetadataForDispatch(frozen),
          },
        };
      };
      if (dispatchLedger) {
        assertDispatchReplayCompatible(dispatch, dispatchLedger.command);
        dispatch = validateUBuddyDispatchV3(dispatchLedger.command, { throwOnError: true }).value;
        routingShadow = dispatch.routingShadow || null;
        if (dispatchLedger.status === 'published') return replayPublished(dispatchLedger);
        if (dispatchLedger.status === 'clarification') {
          return { ok: true, dispatched: false, idempotent: true, ...dispatchLedger.result };
        }
      } else {
        try {
          const profileContext = await resolveUBuddyPeerRoutingShadowContextIfEnabled({
            enabled: Boolean(uBuddyFeatureFlags?.snapshot?.({
              userId: auth.currentUser()?.id || '', workspaceId: dispatchWorkspaceId,
            })?.profileRoutingShadow),
            candidateUserIds: dispatch.candidateUserIds,
            intake: {
              state: 'ready',
              objective: dispatch.objective || dispatch.instruction,
              deliverables: dispatch.deliverables,
              candidateUserIds: dispatch.candidateUserIds,
              requiredUserIds: dispatch.requiredUserIds || [],
            },
            socialRelay,
            publicAvailabilityByUserId: publicPeerAvailabilityByUserId(relationships),
          });
          routingShadow = profileContext.routingShadow;
          if (routingShadow) {
            dispatch = validateUBuddyDispatchV3({
              ...dispatch,
              routingShadow,
              profileRevisionSnapshots: profileContext.profileRevisionSnapshots,
            }, { throwOnError: true }).value;
            emitUBuddyDiagnostic('ubuddy_peer_routing_shadow_evaluated', { data: routingShadow });
          }
        } catch (error) {
          emitUBuddyDiagnostic('ubuddy_peer_routing_shadow_failed', {
            level: 'warn', data: { code: String(error?.code || 'shadow_evaluation_failed') }, error,
          });
        }
        dispatchLedger = store.reserveUBuddyDispatchCommand({
          command: dispatch, accountWorkspaceId: dispatchWorkspaceId, ownerUserId: auth.currentUser().id,
          sourceSessionId: dispatch.sourceConversationId, sourceMessageId: dispatch.sourceMessageId,
        }).command;
      }
      if (!backgroundNaturalGroupDispatch && dispatchLedger.status === 'dispatching'
        && Date.parse(dispatchLedger.leaseExpiresAt || '') > Date.now()) {
        throw Object.assign(new Error('该 uBuddy 派发命令正在执行。'), { code: 'ubuddy_dispatch_in_progress' });
      }
      if (['failed', 'cancelled'].includes(String(dispatchLedger.status || ''))) {
        throw Object.assign(new Error('该 uBuddy 派发命令已经终止，不能继续重放。'), { code: 'ubuddy_dispatch_not_recoverable' });
      }
      if (!(backgroundNaturalGroupDispatch && dispatchLedger.status === 'dispatching')) {
        dispatchLedger = store.claimUBuddyDispatchCommand({ commandId: dispatch.id });
      }
      if (dispatchLedger?.status === 'published') return replayPublished(dispatchLedger);
      if (continuousPlanningContract) {
        const planningSession = store.getUBuddyPlanningSession({ id: dispatch.planningSessionId });
        const planningIdentityValid = planningSession
          && planningSession.ownerUserId === auth.currentUser().id
          && planningSession.accountWorkspaceId === dispatchWorkspaceId
          && planningSession.sourceSessionId === dispatch.sourceConversationId
          && Number(dispatch.planningRevision || 0) > 0
          && Number(dispatch.planningRevision || 0) <= planningSession.revision
          && uBuddyPlanningDecisionDigest(planningSession.plan?.decision || {}) === dispatch.planningDecisionDigest;
        if (!planningIdentityValid || !uBuddyReadinessProofMatches(dispatch)) {
          const error = new Error('自然群组派发的持续规划身份或冻结证明无效。');
          error.code = planningSession ? 'ubuddy_planning_dispatch_proof_invalid' : 'ubuddy_legacy_planning_expired';
          throw error;
        }
      }
      try {
      const sharedTaskSummary = buildPublicTaskSummary({
        taskIntake: dispatch.taskIntake,
        objective: dispatch.objective || dispatch.instruction,
        deliverables: dispatch.deliverables,
      });
      const presenceAssignments = (dispatch.assignments || []).map((assignment, index) => ({
        ...assignment,
        assignmentId: String(assignment.assignmentId || assignment.metadata?.assignmentId || `assignment_${index + 1}`),
        metadata: {
          ...(assignment.metadata || {}),
          ...(sharedTaskSummary ? { taskSummary: sharedTaskSummary } : {}),
        },
      }));
      store.initializePendingDispatchAssignments({ commandId: dispatch.id, assignments: presenceAssignments });
      const pendingRows = store.pendingDispatchAssignments(dispatch.id);
      const unfinishedRows = pendingRows.filter((item) => ['awaiting_presence', 'publishing'].includes(item.status));
      const presence = await socialRelay.queryRecipientPresence({
        userIds: unfinishedRows.map((item) => item.recipientUserId),
      });
      const presenceByUserId = new Map((presence.items || []).map((item) => [String(item.userId || ''), item]));
      let readyRows = unfinishedRows.filter((item) => presenceByUserId.get(item.recipientUserId)?.online);
      const deferredDispatch = readyRows.length < unfinishedRows.length;
      const plannedParticipantsSupported = !deferredDispatch
        || await socialRelay.collaborationPlannedParticipantsSupported?.().catch(() => false);
      const legacyOfflineAssignmentFallback = deferredDispatch && !plannedParticipantsSupported;
      if (legacyOfflineAssignmentFallback) readyRows = unfinishedRows;
      const readyIds = new Set(readyRows.map((item) => item.recipientUserId));
      const readyAssignments = presenceAssignments.filter((item) => readyIds.has(item.recipientId));
      const existingGroupId = String(dispatchLedger?.result?.groupId || '').trim();
      for (const row of readyRows) store.updatePendingDispatchAssignment({
        commandId: dispatch.id,
        assignmentId: row.assignmentId,
        status: 'publishing',
        lastSeenAt: presenceByUserId.get(row.recipientUserId)?.lastSeenAt || '',
        error: '',
      });
      const groupMetadata = {
          source: dispatch.sourceType === 'natural_chat_group' ? 'ubuddy_natural_group_multi_dispatch' : 'ubuddy_direct_structured_dispatch',
          sourceType: dispatch.sourceType,
          sourcePeerId: dispatch.sourcePeerId,
          source_conversation_id: dispatch.sourceConversationId,
          source_message_id: dispatch.sourceMessageId,
          source_group_id: dispatch.sourceGroupId,
          originalInstruction: dispatch.sourceContent,
          ...(sharedTaskSummary ? { taskSummary: sharedTaskSummary } : {}),
          expectedDeliverables: dispatch.deliverables,
          attachments: dispatch.attachments,
          uBuddySelection: selectionMetadataForDispatch(dispatch),
          plannedRecipientIds: [...new Set((dispatch.selectedUserIds || []).map(String).filter(Boolean))],
          ...(routingShadow ? { uBuddyPeerRoutingShadow: routingShadow } : {}),
          taskGroupTitle: automaticTaskGroupTitleMetadata(dispatch.objective || dispatch.title),
        };
      let result = existingGroupId ? { group: { id: existingGroupId }, tasks: [], messages: [] } : null;
      if (existingGroupId) {
        for (const assignment of readyAssignments) {
          const row = pendingRows.find((item) => item.recipientUserId === assignment.recipientId);
          result = await this.updateCollaborationGroup({
            groupId: existingGroupId,
            workspaceId: dispatchWorkspaceId,
            action: 'add_member',
            userId: assignment.recipientId,
            presenceGate: 'online_only',
            assignment: {
              ...assignment,
              assignmentId: row?.assignmentId || assignment.assignmentId,
              clientRequestId: `${dispatch.id}:${row?.assignmentId || assignment.assignmentId}`,
              metadata: { ...(assignment.metadata || {}), assignmentId: row?.assignmentId || assignment.assignmentId },
            },
          });
          const delegation = (result?.tasks || []).find((item) => item.recipientUserId === assignment.recipientId);
          store.updatePendingDispatchAssignment({
            commandId: dispatch.id,
            assignmentId: row?.assignmentId || assignment.assignmentId,
            status: 'published',
            delegationId: delegation?.id || '',
            groupId: existingGroupId,
            error: '',
          });
        }
      } else {
        dispatch.commandAuthorization=createCommandAuthorization({ownerUserId:auth.currentUser().id,commandId:dispatch.id,
          targetUserIds:(readyAssignments.length ? readyAssignments : presenceAssignments).map((item) => item.recipientId),selectionDigest:selectionDigestForDispatch(dispatch),dispatchType:dispatch.dispatchType,
          intent:dispatch.intent,requiresTaskGroup:dispatch.requiresTaskGroup,extended:true});
        result = await this.createCollaborationGroup({
          workspaceId: dispatchWorkspaceId,
          title: buildTaskGroupTitle({
            objective: dispatch.objective || dispatch.title,
            participants: [auth.currentUser(), ...(dispatch.assignments || []).map((assignment) => {
              const relationship = relationships.find((item) => {
                const friend = item.friend || item.user || item;
                return friend.id === assignment.recipientId;
              });
              return relationship?.friend || relationship?.user || relationship || { id: assignment.recipientId };
            })],
          }),
          clientRequestId: dispatch.id,
          presenceGate: legacyOfflineAssignmentFallback ? '' : 'online_only',
          plannedRecipientIds: dispatch.selectedUserIds,
          commandAuthorization: dispatch.commandAuthorization,
          assignments: readyAssignments,
          metadata: groupMetadata,
        });
        const createdGroupId = String(result?.group?.id || '').trim();
        for (const assignment of readyAssignments) {
          const row = pendingRows.find((item) => item.recipientUserId === assignment.recipientId);
          let delegation = (result?.tasks || []).find((item) => item.recipientUserId === assignment.recipientId);
          if (!delegation && createdGroupId) {
            result = await this.updateCollaborationGroup({
              groupId: createdGroupId,
              workspaceId: dispatchWorkspaceId,
              action: 'add_member',
              userId: assignment.recipientId,
              presenceGate: 'online_only',
              assignment: {
                ...assignment,
                assignmentId: row?.assignmentId || assignment.assignmentId,
                clientRequestId: `${dispatch.id}:${row?.assignmentId || assignment.assignmentId}`,
                metadata: { ...(assignment.metadata || {}), assignmentId: row?.assignmentId || assignment.assignmentId },
              },
            });
            delegation = (result?.tasks || []).find((item) => item.recipientUserId === assignment.recipientId);
          }
          if (!delegation) continue;
          store.updatePendingDispatchAssignment({
            commandId: dispatch.id,
            assignmentId: row?.assignmentId || assignment.assignmentId,
            status: 'published',
            delegationId: delegation?.id || '',
            groupId: createdGroupId,
            error: '',
          });
        }
      }
      const groupId = String(result?.group?.id || existingGroupId).trim();
      if (groupId) dispatchLedger = store.checkpointUBuddyDispatchCommand({ commandId: dispatch.id, patch: { groupId } });
      const remaining = store.pendingDispatchAssignments(dispatch.id)
        .filter((item) => ['awaiting_presence', 'publishing'].includes(item.status));
      if (remaining.length) {
        store.deferUBuddyDispatchCommand({ commandId: dispatch.id, reason: 'awaiting_recipient_presence' });
        const assignmentRows = store.pendingDispatchAssignments(dispatch.id);
        const participantLabelById = new Map(relationships.map((relationship) => {
          const friend = relationship.friend || relationship.user || relationship;
          return [String(friend.id || ''), displayAuthUserName(friend)];
        }));
        const pendingRecipientUserIds = remaining.map((item) => item.recipientUserId);
        const pendingRecipientLabels = pendingRecipientUserIds.map((userId) => (
          participantLabelById.get(String(userId)) || displayAuthUserName(auth.getUser?.(userId) || { id: userId })
        ));
        const assignmentCount = assignmentRows.length || presenceAssignments.length;
        const publishedRecipientCount = assignmentRows.filter((item) => item.status === 'published').length;
        const waitingContent = groupId
          ? `已派发 ${publishedRecipientCount}/${assignmentCount} 项分工；${pendingRecipientLabels.join('、')} 当前离线。其任务已保留，上线后会自动加入原工作群并接收分工。`
          : `${pendingRecipientLabels.join('、')} 当前离线。任务已保存在本机，将在对方上线后自动发布。`;
        await publishNaturalGroupWorkflowStatus(dispatch, {
          workspaceId: dispatchWorkspaceId,
          status: 'awaiting_presence',
          content: waitingContent,
          versionKey: cryptoModule.createHash('sha256')
            .update(`${groupId}\n${remaining.map((item) => item.recipientUserId).sort().join('\n')}`)
            .digest('hex').slice(0, 12),
          extraMetadata: {
            assignmentCount,
            publishedRecipientCount,
            pendingRecipientCount: pendingRecipientUserIds.length,
            pendingRecipientUserIds,
            pendingRecipientLabels,
            collaborationGroupId: groupId,
          },
        });
        return {
          ok: true,
          dispatched: Boolean(groupId),
          waitingForPresence: true,
          dispatchType: 'task_group',
          commandId,
          group: result?.group || (groupId ? { id: groupId } : null),
          tasks: result?.tasks || [],
          messages: result?.messages || [],
          result: result || { group: groupId ? { id: groupId } : null, tasks: [], messages: [] },
        };
      }
      if (routingShadow) {
        recordUBuddyPeerRoutingShadowTaskEvents({
          store,
          decision: routingShadow,
          dispatchId: dispatch.id,
          taskRunIds: (result?.tasks || []).map((item) => (
            item?.taskRunId || item?.task_run_id || item?.metadata?.activeTaskRunId || item?.id || ''
          )),
        });
      }
      await publishNaturalGroupTaskStatus(dispatch, result);
      store.completeUBuddyDispatchCommand({ commandId: dispatch.id, result: {
        dispatchType: 'task_group', groupId: result?.group?.id || existingGroupId,
        selection: selectionMetadataForDispatch(dispatch),
        ...(routingShadow ? { routingShadow } : {}),
      } });
      if (dispatch.planningSessionId) {
        const planningSession = store.getUBuddyPlanningSession({ id: dispatch.planningSessionId });
        if (planningSession && planningSession.status !== 'dispatched') store.updateUBuddyPlanningSession({
          id: planningSession.id,
          baseRevision: planningSession.revision,
          status: 'dispatched',
          dispatch,
          lastError: {},
        });
      }
      return {
        ok: true,
        dispatched: true,
        dispatchType: 'task_group',
        commandId,
        group: result?.group || null,
        tasks: result?.tasks || [],
        messages: result?.messages || [],
        result,
        ...(routingShadow ? { routingShadow } : {}),
        source: {
          id: commandId,
          content: cleanContent,
          sourceConversationId: dispatch.sourceConversationId,
          sourcePeerId: dispatch.sourcePeerId,
          localOnly: true,
          uBuddySelection: selectionMetadataForDispatch(dispatch),
        },
      };
      } catch (error) {
        if (error?.code === 'recipient_offline') {
          for (const pending of store.pendingDispatchAssignments(dispatch.id).filter((item) => item.status === 'publishing')) {
            store.updatePendingDispatchAssignment({ commandId: dispatch.id, assignmentId: pending.assignmentId,
              status: 'awaiting_presence', lastSeenAt: error?.details?.lastSeenAt || error?.lastSeenAt || '', error: '' });
          }
          store.deferUBuddyDispatchCommand({ commandId: dispatch.id, reason: 'awaiting_recipient_presence' });
          return { ok: true, dispatched: Boolean(dispatchLedger?.result?.groupId), waitingForPresence: true,
            dispatchType: 'task_group', commandId };
        }
        store.failUBuddyDispatchCommand({ commandId: dispatch.id, error: error?.message || error,
          retryable: ![
            'ubuddy_dispatch_idempotency_conflict',
            'collaboration_command_authorization_required',
            'recipient_presence_capability_required',
          ].includes(String(error?.code || '')),
          retryDelayMs: 1_000 });
        throw error;
      }
    },
    createCollaborationGroup(payload = {}) {
      const user=auth.requireUser();
      assertCommandAuthorization({userId:user.id,commandId:payload.clientRequestId,assignments:payload.assignments,
        plannedRecipientIds:payload.plannedRecipientIds,authorization:payload.commandAuthorization});
      emitUBuddyDiagnostic('collaboration_group_create_started', {
        data: { assignmentCount: Array.isArray(payload.assignments) ? payload.assignments.length : 0 },
      });
      const deliveryMode = socialRelayMutationMode({ socialRelay, user });
      const workspaceId = String(payload.workspaceId || activeWorkspaceId()).trim() || activeWorkspaceId();
      if (deliveryMode === 'remote') {
        return socialRelay.createCollaborationGroup({ ...payload, workspaceId }).then((result) => {
          emitUBuddyDiagnostic('collaboration_group_created', {
            data: {
              groupId: result?.group?.id || '',
              taskCount: Array.isArray(result?.tasks) ? result.tasks.length : 0,
              memberCount: Array.isArray(result?.members) ? result.members.length : 0,
              idempotent: Boolean(result?.idempotent),
            },
          });
          return result;
        });
      }
      if (deliveryMode === 'unavailable') throw socialRelayUnavailableError();
      const result = auth.createCollaborationGroup({ ...payload, workspaceId });
      emitUBuddyDiagnostic('collaboration_group_created', {
        data: {
          groupId: result?.group?.id || '',
          taskCount: Array.isArray(result?.tasks) ? result.tasks.length : 0,
          memberCount: Array.isArray(result?.members) ? result.members.length : 0,
          idempotent: Boolean(result?.idempotent),
        },
      });
      return result;
    },
    sendCollaborationMessage({ groupId = '', ...payload } = {}) {
      const user = auth.requireUser();
      const workspaceId = activeWorkspaceId();
      const detail = socialRelay.connected() ? null : auth.collaborationGroup(groupId, { workspaceId });
      const allowedUserIds = new Set((detail?.members || []).filter((item) => item.status === 'active').map((item) => item.userId));
      const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
      const withMetadata = (attachments = []) => ({
        ...payload,
        metadata: {
          ...metadata,
          ...(attachments.length ? { attachments } : {}),
          mentions: normalizeMentionEntities(metadata.mentions, {
            content: payload.content,
            requirePicker: true,
            ...(detail ? { allowedUserIds } : {}),
          }),
        },
      });
      if (socialRelay.connected()) {
        const accountWorkspaceId = workspaceId;
        return uploadRemoteMessageAttachments({
          runtimeRoot,
          socialRelay,
          userId: user.id,
          scopeKind: 'collaboration_group',
          scopeId: groupId,
          accountWorkspaceId,
          attachments: metadata.attachments,
        }).then((attachments) => socialRelay.sendCollaborationMessage(groupId, { ...withMetadata(attachments), workspaceId }));
      }
      return auth.sendCollaborationMessage({
        groupId,
        workspaceId,
        ...withMetadata(Array.isArray(metadata.attachments) ? metadata.attachments : []),
      });
    },
    async prepareCollaborationGroupSummary({ groupId = '', workspaceId: requestedWorkspaceId = '' } = {}) {
      const user = auth.requireUser();
      const workspaceId = String(requestedWorkspaceId || activeWorkspaceId()).trim() || activeWorkspaceId();
      const detail = socialRelay.connected()
        ? await socialRelay.collaborationGroup(groupId, { workspaceId })
        : auth.collaborationGroup(groupId, { workspaceId });
      if (detail.group?.ownerUserId !== user.id) throw new Error('只有任务群发起人可以准备跨团队汇总。');
      const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
      if (!tasks.length) throw new Error('任务群中没有可汇总的委托。');
      const finalStatuses = new Set(['submitted', 'result_accepted', 'completed', 'declined', 'withdrawn', 'closed', 'failed', 'rejected']);
      const blocked = tasks.filter((task) => task.status === 'blocked');
      const incomplete = tasks.filter((task) => !finalStatuses.has(String(task.status || '')) && task.status !== 'blocked');
      const summaryType = !incomplete.length && !blocked.length ? 'final' : 'progress';
      const fingerprint = sha256Text(JSON.stringify(tasks.map((task) => ({ id: task.id, status: task.status, updatedAt: task.updatedAt, latestResult: task.metadata?.latestResult || '' }))));
      const accountWorkspaceId = detail.group?.workspaceId || detail.group?.accountWorkspaceId || '';
      const secretarySession = store.listSessions({ user, accountWorkspaceId, limit: 200 }).find((item) => item.departmentId === 'secretary_department' && item.status !== 'deleted')
        || store.createSession({
          title: 'uBuddy', departmentId: 'secretary_department', agentId: 'secretary_agent', userId: user.id,
          accountWorkspaceId,
        });
      const existing = store.listMessages(secretarySession.id).find((message) => message.metadata?.collaborationGroupSummaryCandidate
        && message.metadata?.groupId === groupId && message.metadata?.summaryFingerprint === fingerprint && !message.metadata?.summaryInvalidated);
      if (existing) return { candidateMessageId: existing.id, message: existing, summaryType, readyToPublish: summaryType === 'final' };
      const lines = tasks.map((task) => {
        const recipient = displayAuthUserName(task.recipient || {}) || task.recipientUserId || '接收方';
        const result = String(task.metadata?.latestResult || task.metadata?.result || task.lastError || '').trim();
        return `- ${recipient}｜${task.title || '任务'}｜状态：${task.status}${result ? `\n  结果：${result}` : ''}`;
      });
      const base = summaryType === 'final'
        ? [`# ${detail.group?.title || 'uBuddy 任务群'}跨团队汇总`, '', '## 交付物与结论', ...lines, '', '## 分歧、风险与未完成项', '- 请在发布前确认各团队结果、附件和风险描述。'].join('\n')
        : [`# ${detail.group?.title || 'uBuddy 任务群'}进度摘要`, '', ...lines, '', `受阻团队：${blocked.length}；尚未完成：${incomplete.length}。`, '这不是最终汇总，不能作为全部任务已经完成的声明。'].join('\n');
      let content = base;
      try {
        const processed = await this.processAgentDelegationContent({
          phase: 'reply',
          content: `${base}\n\n请整理成发起人私有的跨团队${summaryType === 'final' ? '最终汇总' : '进度摘要'}，保留交付物、分歧、风险、未完成项和附件提示。`,
        });
        content = String(processed?.content || base).trim() || base;
      } catch {
        content = base;
      }
      const attachments = tasks.flatMap((task) => task.metadata?.resultAttachments || task.metadata?.attachments || []).filter((item, index, items) => {
        const key = String(item?.remote_file_id || item?.id || item?.sha256 || item?.name || '');
        return key && items.findIndex((candidate) => String(candidate?.remote_file_id || candidate?.id || candidate?.sha256 || candidate?.name || '') === key) === index;
      }).map((item) => ({ ...item, remote_file_kind: 'collaboration_task', group_id: groupId }));
      const message = store.addMessage({
        sessionId: secretarySession.id,
        role: 'assistant',
        content,
        agentId: 'secretary_agent',
        departmentId: 'secretary_department',
        metadata: {
          secretaryControl: true,
          collaborationGroupSummaryCandidate: true,
          groupId,
          summaryType,
          summaryFingerprint: fingerprint,
          summaryInvalidated: false,
          awaitingOwnerDecision: summaryType === 'final',
          attachments,
        },
      });
      return { candidateMessageId: message.id, message, summaryType, readyToPublish: summaryType === 'final' };
    },
    async publishCollaborationGroupSummary({ groupId = '', candidateMessageId = '' } = {}) {
      const user = auth.requireUser();
      const workspaceId = activeWorkspaceId();
      const candidate = store.getMessage(candidateMessageId);
      if (!candidate || candidate.metadata?.groupId !== groupId || !candidate.metadata?.collaborationGroupSummaryCandidate) throw new Error('跨团队汇总候选不存在。');
      if (candidate.metadata?.summaryType !== 'final' || candidate.metadata?.summaryInvalidated) throw new Error('当前候选不是可发布的最新最终汇总。');
      const prepared = await this.prepareCollaborationGroupSummary({ groupId });
      if (prepared.candidateMessageId !== candidateMessageId) throw new Error('任务状态已变化，请先重新生成跨团队汇总。');
      const attachments = [];
      for (const item of Array.isArray(candidate.metadata?.attachments) ? candidate.metadata.attachments : []) {
        if (item?.remote_file_kind === 'collaboration_group' && item?.group_id === groupId) {
          attachments.push(item);
          continue;
        }
        const sourceFileId = String(item?.remote_file_id || item?.remoteFileId || '').trim();
        if (!sourceFileId) continue;
        const largeTransfer = Number(item?.size || 0) > FAST_REMOTE_FILE_BYTES;
        const materialized = largeTransfer ? await downloadRemoteMessageFile({
          runtimeRoot, socialRelay, describeFile, userId: user.id, workspaceId,
          fileId: sourceFileId, filename: item?.filename || item?.name || sourceFileId,
          contentType: item?.content_type || item?.type || 'application/octet-stream',
          size: item?.size || 0, sha256: item?.sha256 || '', remoteFileKind: 'collaboration_task',
        }) : null;
        if (materialized?.unavailable) throw new Error(materialized.message || '汇总附件暂不可用。');
        const data = largeTransfer ? null : Buffer.from(await socialRelay.downloadCollaborationFile(sourceFileId, { workspaceId }));
        if (!largeTransfer && !data.length) throw new Error(`汇总附件“${item?.filename || item?.name || sourceFileId}”内容为空。`);
        const sha256 = largeTransfer
          ? String(item?.sha256 || '').toLowerCase()
          : crypto.createHash('sha256').update(data).digest('hex');
        if (!sha256 || (item?.sha256 && String(item.sha256).toLowerCase() !== sha256)) throw new Error(`汇总附件“${item?.filename || item?.name || sourceFileId}”校验失败。`);
        const messageFileId = `message_file_${crypto.createHash('sha256').update(`${groupId}:${sourceFileId}:${sha256}`).digest('hex').slice(0, 40)}`;
        const filename = item?.filename || item?.name || sourceFileId;
        const contentType = item?.content_type || item?.type || 'application/octet-stream';
        const uploaded = largeTransfer
          ? await uploadResumableFileFromPath({
            socialRelay, sourcePath: materialized.path, fileId: messageFileId,
            scopeKind: 'collaboration_group', scopeId: groupId, workspaceId,
            filename, contentType, size: Number(item.size), sha256,
          })
          : await socialRelay.uploadCollaborationGroupMessageFile(groupId, messageFileId, {
            workspaceId, filename, contentType, size: data.length, sha256, body: data,
          });
        if (!uploaded?.attachment?.remote_file_id) throw new Error(`汇总附件“${item?.filename || item?.name || sourceFileId}”未能转存到任务群。`);
        const cachePayload = {
          runtimeRoot, userId: socialRelay.remoteUserId?.(user.id) || user.id, fileId: uploaded.attachment.remote_file_id,
          filename: uploaded.attachment.filename || uploaded.attachment.name || filename,
          sha256: uploaded.attachment.sha256 || sha256,
        };
        if (data) cacheRemoteMessageFile({ ...cachePayload, data });
        else cacheRemoteMessageFileFromPath({ ...cachePayload, sourcePath: materialized.path, size: Number(item.size) });
        attachments.push(uploaded.attachment);
      }
      const result = await this.sendCollaborationMessage({
        groupId,
        content: candidate.content,
        senderAgentId: 'secretary_agent',
        kind: 'agent',
        sourceEventId: `group-summary:${candidate.id}`,
        metadata: { type: 'collaboration_group_summary', candidateMessageId: candidate.id, sourceEventId: `group-summary:${candidate.id}`, attachments },
      });
      store.updateMessage(candidate.id, { metadata: { ...candidate.metadata, awaitingOwnerDecision: false, publishedAt: new Date().toISOString(), publishedByUserId: user.id } });
      return result;
    },
    updateCollaborationGroup({ groupId = '', ...payload } = {}) {
      auth.requireUser();
      const action = String(payload.action || 'update').trim().toLowerCase();
      const workspaceId = String(payload.workspaceId || activeWorkspaceId()).trim() || activeWorkspaceId();
      emitUBuddyDiagnostic('collaboration_group_action_started', { data: { groupId, action } });
      if (socialRelay.connected()) {
        return socialRelay.updateCollaborationGroup(groupId, { ...payload, workspaceId }).then((result) => {
          emitUBuddyDiagnostic('collaboration_group_action_completed', {
            data: { groupId, action, status: result?.group?.status || result?.status || '' },
          });
          return result;
        });
      }
      const result = auth.updateCollaborationGroup({ groupId, ...payload, workspaceId });
      emitUBuddyDiagnostic('collaboration_group_action_completed', {
        data: { groupId, action, status: result?.group?.status || result?.status || '' },
      });
      return result;
    },
    async collaborationTaskAction({ delegationId = '', ...payload } = {}) {
      auth.requireUser();
      const action = String(payload.action || '').trim().toLowerCase();
      emitUBuddyDiagnostic('delegation_action_started', {
        data: {
          delegationId,
          action,
          attachmentCount: Array.isArray(payload.metadata?.attachments) ? payload.metadata.attachments.length : 0,
        },
      });
      const currentDelegation = auth.agentDelegationById(String(delegationId || '').trim());
      if (['request_revision', 'update_requirements'].includes(action) && currentDelegation?.groupId) {
        invalidateCollaborationGroupSummaries(store, currentDelegation.groupId, action, auth.currentUser());
      }
      const toleratesConcurrentExecution = ['publish', 'update_requirements'].includes(action);
      if (socialRelay.connected() && !payload.expectedStatus && !toleratesConcurrentExecution) {
        await socialRelay.collaborationOverview({
          workspaceId: activeWorkspaceId(),
          authoritativeTasks: ['submit', 'accept_result', 'request_revision'].includes(action),
        }).catch(() => null);
      }
      const current = auth.agentDelegationById(String(delegationId || '').trim());
      const lifecycleMetadata = collaborationActionLifecycleMetadata(action, current?.metadata || {}, {
        content: payload.content,
        metadata: payload.metadata,
      });
      let actionPayload = {
        ...payload,
        workspaceId: current?.workspaceId || current?.accountWorkspaceId || activeWorkspaceId(),
        expectedStatus: String(payload.expectedStatus || (toleratesConcurrentExecution ? '' : current?.status) || '').trim(),
        metadata: {
          ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
          ...lifecycleMetadata,
        },
      };
      if (socialRelay.connected() && ['submit', 'publish', 'update_requirements'].includes(action)) {
        const metadata = actionPayload.metadata && typeof actionPayload.metadata === 'object' ? actionPayload.metadata : {};
        const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
        if (attachments.length) {
          const directDelegation = !String(current?.groupId || current?.group_id || current?.metadata?.groupId || '').trim();
          if (directDelegation && !await socialRelay.directDelegationFilesSupported()) {
            const error = new Error('当前通信服务版本不支持一对一任务文件交付。任务结果和文件仍保留在本机，升级服务后可以直接重试。');
            error.code = 'direct_delegation_files_server_update_required';
            throw error;
          }
          const uploadedAttachments = await uploadCollaborationTaskAttachments({
            runtimeRoot,
            socialRelay,
            delegationId,
            groupId: String(current?.groupId || current?.group_id || current?.metadata?.groupId || '').trim(),
            userId: auth.currentUser()?.id || '',
            workspaceId: current?.workspaceId || current?.accountWorkspaceId || activeWorkspaceId(),
            attachments,
          });
          emitUBuddyDiagnostic('delegation_attachments_uploaded', {
            data: {
              delegationId,
              action,
              requestedCount: attachments.length,
              uploadedCount: uploadedAttachments.filter((item) => item.remote_file_id && item.sha256).length,
              totalBytes: uploadedAttachments.reduce((sum, item) => sum + Number(item.size || 0), 0),
            },
          });
          actionPayload = {
            ...actionPayload,
            metadata: {
              ...metadata,
              attachments: uploadedAttachments,
            },
          };
        }
      }
      let actionResult;
      if (socialRelay.connected()) {
        try {
          actionResult = await socialRelay.collaborationTaskAction(delegationId, actionPayload);
        } catch (error) {
          const actualStatus = String(error?.details?.actualStatus || '').trim();
          const retryIdempotentSubmit = action === 'submit'
            && Boolean(String(actionPayload.metadata?.sourceWorkspaceMessageId || '').trim())
            && transientCollaborationMutationError(error);
          const retryConcurrentSubmit = action === 'submit'
            && error?.code === 'delegation_status_conflict'
            && ['working', 'running', 'draft_ready', 'revision_requested', 'blocked'].includes(actualStatus);
          if (retryIdempotentSubmit) {
            actionResult = await socialRelay.collaborationTaskAction(delegationId, actionPayload);
          } else if (retryConcurrentSubmit) {
            actionResult = await socialRelay.collaborationTaskAction(delegationId, { ...actionPayload, expectedStatus: actualStatus });
          } else {
            if (!toleratesConcurrentExecution || Number(error?.status || 0) !== 409) throw error;
            actionResult = await socialRelay.collaborationTaskAction(delegationId, { ...actionPayload, expectedStatus: '' });
          }
        }
      } else {
        actionResult = localCollaborationTaskAction(auth, { delegationId, ...actionPayload });
      }
      if (socialRelay.connected() && action === 'submit'
        && !delegationSubmissionConfirmed(actionResult?.delegation?.status)) {
        const refreshDelays = [0, 75, 200, 500];
        let latestDelegation = actionResult?.delegation || null;
        let lastRefreshError = null;
        for (const delayMs of refreshDelays) {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          try {
            await socialRelay.collaborationOverview({
              workspaceId: actionPayload.workspaceId,
              authoritativeTasks: true,
            });
            latestDelegation = auth.agentDelegationById(String(delegationId || '').trim()) || latestDelegation;
            if (delegationSubmissionConfirmed(latestDelegation?.status)) break;
          } catch (error) {
            lastRefreshError = error;
          }
        }
        if (!delegationSubmissionConfirmed(latestDelegation?.status)) {
          const error = new Error('任务结果已发送，但暂时无法确认服务端的提交状态，请刷新后查看，不要重复提交。');
          error.code = 'delegation_submit_convergence_timeout';
          error.retryable = true;
          error.details = {
            delegationId: String(delegationId || '').trim(),
            actualStatus: String(latestDelegation?.status || ''),
            refreshError: String(lastRefreshError?.message || ''),
          };
          throw error;
        }
        actionResult = {
          ...(actionResult || {}),
          delegation: latestDelegation,
          tasks: Array.isArray(actionResult?.tasks)
            ? actionResult.tasks.map((item) => item?.id === latestDelegation.id ? latestDelegation : item)
            : actionResult?.tasks,
        };
      }
      emitUBuddyDiagnostic('delegation_action_completed', {
        data: {
          delegationId,
          action,
          status: actionResult?.delegation?.status || auth.agentDelegationById(String(delegationId || ''))?.status || '',
          idempotent: Boolean(actionResult?.idempotent),
          attachmentCount: Array.isArray(actionPayload.metadata?.attachments) ? actionPayload.metadata.attachments.length : 0,
        },
      });
      return actionResult;
    },
    async collaborationDownloadFile({ fileId = '', name = '', filename = '', contentType = '', type = '', size = 0, sha256 = '', remoteFileKind = '', groupId = '' } = {}) {
      const user = auth.requireUser();
      const workspaceId = activeWorkspaceId();
      const result = await downloadRemoteMessageFile({
        runtimeRoot, socialRelay, describeFile, userId: user.id, workspaceId,
        fileId, name, filename, contentType, type, size, sha256, remoteFileKind, groupId,
      });
      if (result?.unavailable && result.reason === 'forbidden') {
        const error = new Error('当前账号无权下载该任务附件。');
        error.code = result.code || 'collaboration_file_forbidden';
        throw error;
      }
      if (result?.unavailable) return result;
      emitUBuddyDiagnostic('delegation_attachment_download_verified', {
        data: { fileId: String(fileId || '').trim(), byteLength: Number(result?.size || 0), sha256Verified: Boolean(sha256) },
      });
      return result;
    },
    async collaborationWorkspaceMessages({ delegationId = '' } = {}) {
      const user = auth.requireUser();
      let delegation = auth.agentDelegationById(delegationId);
      if (!delegation) throw new Error('任务不存在。');
      if (![delegation.requesterUserId, delegation.recipientUserId].includes(user.id)) throw new Error('无权查看该私有任务工作区。');
      const taskWorkspaceRoot = ensureDelegationTaskWorkspace(runtimeRoot, user.id, delegation);
      await syncSharedTaskWorkspace(delegation, user, 'pull');
      const remote = socialRelay.connected()
        ? await socialRelay.delegationWorkspace(delegationId, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }).catch(() => ({ workspace: null, items: [] }))
        : { workspace: null, items: [] };
      const resolved = await resolvePrivateWorkspace(delegation, user, taskWorkspaceRoot, remote);
      delegation = resolved.delegation;
      const localMessages = privateDelegationWorkspaceMessages(store, delegation);
      if (!socialRelay.connected()) return localMessages;
      return mergeDelegationWorkspaceMessages(localMessages, remote?.items || [], delegationId, resolved.workspaceEpoch);
    },
    async enqueueCollaborationWorkspaceMessage(payload = {}) {
      const user = auth.requireUser();
      const delegationId = String(payload.delegationId || '').trim();
      let delegation = auth.agentDelegationById(delegationId);
      if (!delegation || ![delegation.requesterUserId, delegation.recipientUserId].includes(user.id)) throw new Error('无权使用该私有任务工作区。');
      const taskWorkspaceRoot = ensureDelegationTaskWorkspace(runtimeRoot, user.id, delegation);
      await syncSharedTaskWorkspace(delegation, user, 'pull');
      const remoteWorkspace = socialRelay.connected()
        ? await socialRelay.delegationWorkspace(delegationId, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }).catch(() => null)
        : null;
      const resolved = await resolvePrivateWorkspace(delegation, user, taskWorkspaceRoot, remoteWorkspace);
      delegation = resolved.delegation;
      const session = resolved.session;
      const clientMessageId = String(payload.clientMessageId || newId('workspace_client')).trim();
      const workId = `workspace:${delegationId}:${clientMessageId}`;
      const secretaryInstance = store.findUserAgentInstance?.({ userId: user.id, agentFamilyId: 'secretary_agent' }) || null;
      if (!secretaryInstance?.id) throw new Error('当前用户的 uBuddy 实例不可用。');
      let requestMessage = store.listMessages(session.id).find((message) => message.metadata?.clientMessageId === clientMessageId) || null;
      if (!requestMessage) requestMessage = store.addMessage({
        sessionId: session.id,
        role: 'user',
        content: String(payload.content || '').trim() || '补充了任务相关附件。',
        agentId: 'secretary_agent',
        departmentId: 'agent_delegation',
        metadata: workspaceMessageMetadata(delegation, {
          attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
          clientMessageId,
          queuedWorkId: workId,
          workspaceIntent: 'queued',
          resultState: 'queued',
        }),
      });
      const receipt = store.createAgentDeliveryReceipt({
        userId: user.id,
        sourceSessionId: session.id,
        targetSessionId: session.id,
        targetAgentInstanceId: secretaryInstance.id,
        requestMessageId: requestMessage.id,
        workId,
        metadata: {
          delegationId,
          workspaceEpoch: resolved.workspaceEpoch,
          targetAgentId: 'secretary_agent',
          targetAgentName: 'uBuddy',
          surface: 'delegation_workspace',
          clientMessageId,
        },
      });
      const existing = store.findAgentWork({ workKind: 'ubuddy_workspace_message', workId });
      if (!existing || ['completed', 'failed', 'cancelled'].includes(existing.status)) {
        agentExecution.enqueue({
          userId: user.id,
          agentInstanceId: secretaryInstance.id,
          workKind: 'ubuddy_workspace_message',
          workId,
          workspaceId: delegation.workspaceId || delegation.accountWorkspaceId || '',
          payload: {
            ...payload,
            accountWorkspaceId: delegation.workspaceId || delegation.accountWorkspaceId || '',
            background: false,
            delegationId,
            clientMessageId,
            requestMessageId: requestMessage.id,
            workspaceSessionId: session.id,
          },
        });
      }
      return {
        ok: true,
        queued: true,
        workId,
        receipt: store.getAgentDeliveryReceiptByWorkId(workId) || receipt,
        session,
        delegation,
        messages: await this.collaborationWorkspaceMessages({ delegationId }),
      };
    },
    cancelCollaborationWorkspaceWork({ delegationId = '', workId = '' } = {}) {
      const user = auth.requireUser();
      const delegation = auth.agentDelegationById(String(delegationId || '').trim());
      const receipt = store.getAgentDeliveryReceiptByWorkId(String(workId || '').trim());
      if (!delegation || !receipt || receipt.userId !== user.id || receipt.metadata?.delegationId !== delegation.id) {
        throw new Error('找不到可取消的私有工作区任务。');
      }
      const work = agentExecution.cancel({ workKind: 'ubuddy_workspace_message', workId: receipt.workId, reason: 'cancelled_by_user' });
      if (work?.status === 'cancelled') {
        store.recordAgentDeliveryEvent({ workId: receipt.workId, status: 'cancelled', event: { kind: 'cancelled', stage: 'cancelled', message: '已取消本次私有工作区处理。' } });
        store.completeAgentDeliveryReceipt({ workId: receipt.workId, status: 'cancelled', metadata: { cancelled: true } });
      }
      return { ok: true, cancelled: true, workId: receipt.workId };
    },
    async collaborationWorkspaceMessage({
      delegationId = '',
      content = '',
      processedContent = '',
      attachments = [],
      clientMessageId = '',
      processWithUBuddy = null,
      model = '',
      reasoningEffort = '',
      background = false,
      signal = null,
      onEvent = null,
      requestMessageId = '',
    } = {}) {
      if (background) return this.enqueueCollaborationWorkspaceMessage({
        delegationId, content, processedContent, attachments, clientMessageId, processWithUBuddy, model, reasoningEffort,
      });
      const user = auth.requireUser();
      if (socialRelay.connected()) await socialRelay.collaborationOverview({ workspaceId: activeWorkspaceId() }).catch(() => null);
      let delegation = auth.agentDelegationById(delegationId);
      if (!delegation || ![delegation.requesterUserId, delegation.recipientUserId].includes(user.id)) throw new Error('无权使用该私有任务工作区。');
      if (['closed', 'withdrawn', 'declined', 'rejected'].includes(String(delegation.status || ''))) throw new Error('任务已经结束，私有工作区现为只读。');
      const isRequester = user.id === delegation.requesterUserId;
      const taskWorkspaceRoot = ensureDelegationTaskWorkspace(runtimeRoot, user.id, delegation);
      await syncSharedTaskWorkspace(delegation, user, 'pull');
      const workspaceBaseline = delegationGroupId(delegation) ? snapshotDelegationWorkspaceDeliverables(taskWorkspaceRoot) : null;
      const remoteWorkspace = socialRelay.connected()
        ? await socialRelay.delegationWorkspace(delegationId, { workspaceId: delegation.workspaceId || delegation.accountWorkspaceId }).catch(() => ({ workspace: null, items: [] }))
        : null;
      const resolvedWorkspace = await resolvePrivateWorkspace(delegation, user, taskWorkspaceRoot, remoteWorkspace);
      let session = resolvedWorkspace.session;
      delegation = resolvedWorkspace.delegation;
      const workspaceEpoch = resolvedWorkspace.workspaceEpoch;
      const privateMetadata = (extra = {}) => workspaceMessageMetadata(delegation, { ...extra, workspaceEpoch });
      const currentWorkspaceMessages = () => {
        const localMessages = privateDelegationWorkspaceMessages(store, auth.agentDelegationById(delegationId) || delegation);
        if (!socialRelay.connected()) return localMessages;
        return mergeDelegationWorkspaceMessages(localMessages, remoteWorkspace?.items || [], delegationId, workspaceEpoch);
      };
      const publishWorkspaceEvent = (event = {}) => emitChatEvent(onEvent, {
        ...event,
        delegationId,
        displaySessionId: session.id,
        executionSessionId: session.id,
        targetKind: 'delegation-workspace',
        departmentId: 'agent_delegation',
        agentId: event.agentId || 'secretary_agent',
      });
      const publishTaskProgress = (task = {}, change = {}) => {
        const nodes = Array.isArray(task.nodes) ? task.nodes : [];
        const completed = nodes.filter((node) => node.status === 'completed').length;
        const active = nodes.filter((node) => ['queued', 'running', 'ready'].includes(node.status));
        publishWorkspaceEvent({
          kind: 'task-progress',
          stage: active.some((node) => node.status === 'queued') ? 'queued' : 'working',
          message: change.node?.title ? `${change.node.title}：${change.node.status || change.type || '处理中'}` : 'uBuddy 正在协调任务节点',
          taskRunId: task.id || '',
          taskProgress: { completed, total: nodes.length, running: active.length },
          activeNodes: active.slice(0, 8).map((node) => ({ id: node.id, title: node.title, status: node.status, agentId: node.agentId })),
        });
      };
      const saveWorkspaceUserMessage = (messageContent, extra = {}) => {
        const existing = (requestMessageId ? store.getMessage(requestMessageId) : null)
          || (clientMessageId
            ? store.listMessages(session.id).find((message) => message.metadata?.clientMessageId === clientMessageId)
            : null);
        const metadata = privateMetadata({ ...(existing?.metadata || {}), ...extra, clientMessageId });
        if (existing?.sessionId === session.id && existing.role === 'user') return store.updateMessage(existing.id, { metadata });
        return store.addMessage({
          sessionId: session.id,
          role: 'user',
          content: messageContent,
          agentId: session.agentId || 'secretary_agent',
          departmentId: 'agent_delegation',
          metadata,
        });
      };
      if (delegation.metadata?.taskWorkspaceRoot !== taskWorkspaceRoot) {
        delegation = auth.updateAgentDelegation({
          delegationId,
          sessionId: session.id,
          metadata: { ...(delegation.metadata || {}), workspaceSessionId: session.id, taskWorkspaceRoot, workspaceEpoch },
        });
      }
      const original = String(content || '').trim();
      const processed = String(processedContent || '').trim();
      const shouldProcess = processWithUBuddy == null ? !processed : Boolean(processWithUBuddy);
      const externalExecutionPermissionMode = externalDelegationWorkspacePermissionMode(delegation.metadata?.executionPermissionMode);
      if (!shouldProcess) {
        const saved = [];
        if (original) saved.push(saveWorkspaceUserMessage(original, { attachments }));
        if (processed) saved.push(store.addMessage({
          sessionId: session.id,
          role: 'assistant',
          content: processed,
          agentId: session.agentId || 'secretary_agent',
          departmentId: 'agent_delegation',
          metadata: privateMetadata({
            processedByOwnUBuddy: true,
            attachments,
            publishCandidate: true,
            publishAction: isRequester ? 'update_requirements' : 'submit',
            awaitingOwnerDecision: true,
            resultState: 'complete',
          }),
        }));
        if (socialRelay.connected()) await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, saved, workspaceEpoch);
        return { ok: true, session, messages: currentWorkspaceMessages(), delegation: auth.agentDelegationById(delegationId) };
      }
      if (!original && !attachments.length) throw new Error('请输入需要和 uBuddy 继续处理的内容。');
      const pendingClarification = !isRequester && (String(delegation.status || '') === 'blocked'
        || (String(delegation.status || '') === 'accepted'
          && delegation.metadata?.dependencyState === 'waiting'
          && delegation.metadata?.dependencyReasonCode === 'owner_input_required'))
        ? delegation.metadata?.clarification || null
        : null;
      if (pendingClarification?.question && original) {
        const responseMessage = saveWorkspaceUserMessage(original, {
          attachments,
          workspaceRole: 'recipient',
          workspaceIntent: 'clarification_response',
          externalDelegationClarificationResponse: true,
          externalDelegationClarificationQuestion: pendingClarification.question,
        });
        const previousAnswers = Array.isArray(delegation.metadata?.externalDelegationClarificationAnswers)
          ? delegation.metadata.externalDelegationClarificationAnswers
          : [];
        delegation = auth.updateAgentDelegation({
          delegationId,
          sessionId: session.id,
          metadata: {
            ...(delegation.metadata || {}),
            externalDelegationClarificationAnswers: [...previousAnswers, {
              question: String(pendingClarification.question || '').trim(),
              answer: original,
              answeredAt: new Date().toISOString(),
              sourceMessageId: responseMessage.id,
              source: 'delegation_workspace',
            }].slice(-6),
            dependencyState: 'ready',
            dependencyReasonCode: '',
            clarification: null,
            ownerInputResolvedAt: new Date().toISOString(),
          },
        }) || delegation;
        if (socialRelay.connected()) {
          await syncDelegationWorkspaceMessages(
            socialRelay,
            delegationId,
            session.id,
            [responseMessage],
            workspaceEpoch,
          );
        }
        publishWorkspaceEvent({
          kind: 'status',
          stage: 'preparing',
          message: '已收到补充信息，uBuddy 正在继续原任务。',
        });
        const resumed = await this.startAgentDelegation({
          delegationId,
          execute: true,
          model,
          reasoningEffort,
          sandboxPermission: externalExecutionPermissionMode,
        });
        return {
          ...resumed,
          ok: resumed?.ok !== false,
          action: resumed?.clarification ? 'clarification' : 'clarification_response',
          session,
          messages: currentWorkspaceMessages(),
          delegation: resumed?.delegation || auth.agentDelegationById(delegationId) || delegation,
        };
      }
      publishWorkspaceEvent({ kind: 'start', stage: 'preparing', message: 'uBuddy 已领取私有工作区消息，正在理解要求。' });
      const workspaceBefore = currentWorkspaceMessages();
      const sharedGroupWorkspace = Boolean(delegation.groupId || delegation.group_id || delegation.metadata?.groupId);
      const explicitFileRequest = hasExplicitDelegationFileRequest(original, attachments);
      const executionPrompt = [delegation.title, delegation.instruction, original].filter(Boolean).join('\n\n');
      const pptCreationRequested = classifyPptIntent(isRequester ? original : executionPrompt, { attachments }).creation;
      const informationOnlyRequest = !isRequester && isDelegationInformationOnlyRequest(original);
      let workspaceIntent = await classifyDelegationWorkspaceIntent({
        content: original,
        messages: workspaceBefore,
        delegation,
        currentUser: user,
        runtimeRoot,
        store,
        org,
        model,
        reasoningEffort,
        signal,
        timeoutMs: Number(process.env.JANUS_UBUDDY_WORKSPACE_INTENT_TIMEOUT_MS || 30_000),
        action: isRequester ? 'update_requirements' : 'submit',
      });
      publishWorkspaceEvent({ kind: 'routing', stage: 'planning', message: `uBuddy 已识别本次操作：${workspaceIntent}` });
      if (informationOnlyRequest && workspaceIntent !== 'submit') workspaceIntent = 'message';
      if (isRequester && workspaceIntent === 'execute' && !explicitFileRequest) workspaceIntent = 'organize';
      emitUBuddyDiagnostic('workspace_intent_classified', {
        data: {
          delegationId,
          intent: workspaceIntent,
          requesterWorkspace: isRequester,
          explicitFileRequest,
          pptCreationRequested,
          attachmentCount: attachments.length,
        },
      });
      if (workspaceIntent === 'submit') {
        const confirmation = saveWorkspaceUserMessage(original, { workspaceIntent: 'submit' });
        const candidate = latestDelegationPublishCandidate(workspaceBefore, {
          action: isRequester ? 'update_requirements' : 'submit',
          delegation,
        });
        if (!candidate) {
          emitUBuddyDiagnostic('workspace_submit_clarification', {
            level: 'warn', data: { delegationId, requesterWorkspace: isRequester },
          });
          const clarification = store.addMessage({
            sessionId: session.id,
            role: 'assistant',
            content: sharedGroupWorkspace
              ? '当前还没有可提交的内容。请先告诉我需要整理或修改什么；完成后我会再询问是否提交到任务群。'
              : '当前还没有可交付的内容。请先告诉我需要整理或修改什么；完成后我会再询问是否交付给发起方。',
            agentId: session.agentId || 'secretary_agent',
            departmentId: 'agent_delegation',
            metadata: privateMetadata({ workspaceIntent: 'clarification' }),
          });
          if (socialRelay.connected()) await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, [confirmation, clarification], workspaceEpoch);
          return { ok: true, action: 'clarification', session, messages: currentWorkspaceMessages(), delegation };
        }
        if (socialRelay.connected()) await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, [confirmation], workspaceEpoch);
        const taskAction = isRequester ? 'update_requirements' : 'submit';
        const actionResult = await this.collaborationTaskAction({
          delegationId,
          action: taskAction,
          content: candidate.content,
          metadata: {
            sourceWorkspaceMessageId: candidate.messageId,
            sourceWorkspaceRevisionId: candidate.revisionId,
            sharedFromPrivateWorkspace: true,
            explicitlyConfirmedByOwner: true,
            attachments: candidate.attachments,
          },
        });
        delegation = actionResult?.delegation || auth.agentDelegationById(delegationId) || delegation;
        const acknowledgement = store.addMessage({
          sessionId: session.id,
          role: 'assistant',
          content: taskAction === 'submit'
            ? (sharedGroupWorkspace ? '已提交到任务群。' : '已交付给发起方。')
            : (sharedGroupWorkspace ? '已将这版要求和相关材料更新到任务群。' : '已将这版要求和相关材料同步给接收方。'),
          agentId: session.agentId || 'secretary_agent',
          departmentId: 'agent_delegation',
          metadata: privateMetadata({
            workspaceIntent: taskAction,
            publishedToGroup: true,
            sourceWorkspaceMessageId: candidate.messageId,
          }),
        });
        if (socialRelay.connected()) await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, [acknowledgement], workspaceEpoch);
        return { ok: true, action: taskAction, session, messages: currentWorkspaceMessages(), delegation };
      }
      if (workspaceIntent === 'clarify') {
        const saved = [
          saveWorkspaceUserMessage(original),
          store.addMessage({ sessionId: session.id, role: 'assistant', content: sharedGroupWorkspace
            ? '你是希望继续修改，还是提交到任务群？请明确告诉我。'
            : '你是希望继续修改，还是交付给发起方？请明确告诉我。', agentId: session.agentId || 'secretary_agent', departmentId: 'agent_delegation', metadata: privateMetadata({ workspaceIntent: 'clarification' }) }),
        ];
        if (socialRelay.connected()) await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, saved, workspaceEpoch);
        return { ok: true, action: 'clarification', session, messages: currentWorkspaceMessages(), delegation };
      }
      if (workspaceIntent === 'message') {
        const requestMessage = saveWorkspaceUserMessage(original, { attachments, workspaceRole: isRequester ? 'requester' : 'recipient', workspaceIntent: 'message' });
        const organized = await this.processAgentDelegationContent({
          delegationId,
          phase: 'reply',
          content: original,
          attachments,
          model,
          reasoningEffort,
          contextMessages: workspaceBefore.slice(-30),
          signal,
        });
        const responseMessage = store.addMessage({
          sessionId: session.id,
          role: 'assistant',
          content: String(organized?.content || original).trim(),
          agentId: session.agentId || 'secretary_agent',
          departmentId: 'agent_delegation',
          metadata: privateMetadata({
            processedByOwnUBuddy: true,
            workspaceRole: isRequester ? 'requester' : 'recipient',
            workspaceIntent: 'message',
            publishCandidate: false,
            resultState: 'informational',
            ubuddyProcessingMode: organized?.mode || 'fallback',
          }),
        });
        if (socialRelay.connected()) await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, [requestMessage, responseMessage], workspaceEpoch);
        return { ok: true, action: 'message', session, messages: currentWorkspaceMessages(), delegation };
      }
      if (workspaceIntent === 'organize') {
        const requestMessage = saveWorkspaceUserMessage(original, {
            attachments,
            workspaceRole: isRequester ? 'requester' : 'recipient',
            workspaceIntent: informationOnlyRequest ? 'message' : 'organize',
            supersedesResultCandidate: isRequester,
          });
        const organized = await this.processAgentDelegationContent({
          delegationId,
          phase: informationOnlyRequest ? 'intake' : 'reply',
          content: original,
          attachments,
          model,
          reasoningEffort,
          contextMessages: workspaceBefore.slice(-30),
          signal,
        });
        const answer = appendDelegationDecisionPrompt(String(organized?.content || original).trim(), delegation);
        const responseMessage = store.addMessage({
          sessionId: session.id,
          role: 'assistant',
          content: answer,
          agentId: session.agentId || 'secretary_agent',
          departmentId: 'agent_delegation',
          metadata: privateMetadata({
            processedByOwnUBuddy: true,
            workspaceRole: isRequester ? 'requester' : 'recipient',
            publishCandidate: isRequester,
            publishAction: isRequester ? 'update_requirements' : 'submit',
            awaitingOwnerDecision: true,
            attachments,
            ubuddyProcessingMode: organized?.mode || 'fallback',
            resultState: isRequester ? 'complete' : 'informational',
          }),
        });
        if (socialRelay.connected()) await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, [requestMessage, responseMessage], workspaceEpoch);
        return { ok: true, action: 'message', session, messages: currentWorkspaceMessages(), delegation };
      }
      if (!isRequester && ['assigned', 'accepted', 'revision_requested', 'blocked', 'draft_ready'].includes(String(delegation.status || ''))) {
        delegation = auth.updateAgentDelegation({ delegationId, status: 'working', sessionId: session.id, metadata: delegation.metadata || {} });
        if (socialRelay.connected()) {
          const remoteWorking = await socialRelay.updateDelegation(delegationId, { status: 'working', sessionId: session.id });
          delegation = remoteWorking?.delegation ? (auth.agentDelegationById(delegationId) || delegation) : delegation;
        }
      }
      const localMessageIdsBefore = new Set(store.listMessages(session.id).map((message) => message.id));
      let result;
      try {
        const delegatedTask = delegation.taskRunId ? store.getTaskRun(delegation.taskRunId) : null;
        const candidates = privateWorkspacePlannerCandidates({ store, org, cloudSync, userId: user.id });
        const executionCandidates = pptCreationRequested
          ? candidates.filter((candidate) => candidate.departmentId === 'ppt_department')
          : candidates;
        if (pptCreationRequested && !executionCandidates.length) {
          const pptError = new Error(org.agent('ppt')?.skillInstalled === false
            ? '接收方当前设备尚未安装 PPT 制作 Skill，PPT Agent 无法执行任务。'
            : '当前没有可用的 PPT 员工 Agent，无法生成真实 PPTX；本次不会用 Markdown 草稿冒充交付物。');
          pptError.code = org.agent('ppt')?.skillInstalled === false
            ? 'ppt_skill_install_required'
            : 'ppt_employee_not_active';
          throw pptError;
        }
        if (delegatedTask && !attachments.length) {
          const plannerPrompt = [
            delegatedTask.prompt || delegation.instruction || delegation.title || '',
            workspaceBefore.slice(-30).map((message) => `${message.role === 'user' ? '用户' : message.role === 'assistant' ? 'uBuddy' : '任务更新'}：${message.content || ''}`).join('\n'),
            `用户本次要求：${original || '继续完善当前任务初稿。'}`,
            '请读取候选员工的有效 Skill，并根据 Skill 匹配、P 等级、当前状态和 FIFO 队列重新规划本任务。',
          ].filter(Boolean).join('\n\n');
          let proposal = null;
          let plannerMode = 'fallback';
          try {
            proposal = await proposeUBuddyTaskGraph({
              prompt: plannerPrompt,
              candidates: executionCandidates,
              root: runtimeRoot,
              cwd: taskWorkspaceRoot,
              model,
              reasoningEffort,
              permissionMode: delegatedTask.metadata?.executionOptions?.permissionMode
                || delegatedTask.metadata?.executionOptions?.requestedPermissionMode || externalExecutionPermissionMode,
              signal,
              timeoutMs: Number(process.env.JANUS_UBUDDY_WORKSPACE_PLANNER_TIMEOUT_MS || DEFAULT_UBUDDY_PLANNER_TIMEOUT_MS),
              executionContext: {
                store,
                userId: user.id,
                conversationId: session.id,
                taskRunId: delegatedTask.id,
                departmentId: 'secretary_department',
                agentId: 'secretary_agent',
                executionKind: 'ubuddy_task_graph_revision',
              },
            });
            plannerMode = 'model';
          } catch (error) {
            if (signal?.aborted) throw error;
            const fallback = selectBestUBuddyCandidate(executionCandidates, {
              departmentId: pptCreationRequested ? 'ppt_department' : delegatedTask.departmentId,
              prompt: plannerPrompt,
            });
            if (fallback) proposal = { nodes: [{
              localId: 'private_workspace_revision_final',
              title: '完成私有任务调整',
              objective: `结合原任务和私有工作区上下文完成本次调整：\n${original || '继续完善当前任务初稿。'}`,
              agentId: fallback.agentId,
              dependencies: [],
              outputFormat: '完整的更新后交付物、修改摘要、风险和待确认项',
              isFinal: true,
              priority: 90,
              estimatedMinutes: 30,
            }] };
          }
          if (!proposal) throw new Error('当前没有可由 uBuddy 调度的在职员工 Agent。');
          saveWorkspaceUserMessage(original || '请结合新要求继续完善当前任务初稿。', { attachments, workspaceIntent: 'execute', supersedesResultCandidate: true });
          store.updateTaskRunMetadata?.(delegatedTask.id, {
            externalWorkspaceRevisionInProgress: {
              delegationId,
              workspaceEpoch,
              startedAt: new Date().toISOString(),
            },
          });
          const revision = scheduler.applyUBuddyTaskGraphRevision(delegatedTask.id, proposal, {
            reason: original || 'Private workspace task revision.',
            candidates: executionCandidates,
          });
          let revisedTask = revision.task;
          for (let wave = 0; wave < 12; wave += 1) {
            const ready = store.readyTaskNodes(delegatedTask.id);
            const openCommunications = (store.getTaskRun(delegatedTask.id)?.communications || []).filter((item) => item.status === 'open');
            if (!ready.length && !openCommunications.length) break;
            if (ready.length) revisedTask = await scheduler.runReadyNodes(delegatedTask.id, {
              maxParallel: Math.min(3, ready.length),
              model,
              reasoningEffort,
              permissionMode: delegatedTask.metadata?.executionOptions?.permissionMode
                || delegatedTask.metadata?.executionOptions?.requestedPermissionMode || externalExecutionPermissionMode,
              signal,
              onTaskProgress: publishTaskProgress,
            });
            if (openCommunications.length) revisedTask = await scheduler.resolveOpenCommunications(delegatedTask.id, {
              maxParallel: Math.min(2, openCommunications.length),
              model,
              reasoningEffort,
              permissionMode: delegatedTask.metadata?.executionOptions?.permissionMode
                || delegatedTask.metadata?.executionOptions?.requestedPermissionMode || externalExecutionPermissionMode,
              signal,
            });
          }
          revisedTask = store.getTaskRun(delegatedTask.id);
          const createdNodeIds = Object.values(revision.nodeIdsByLocal || {});
          const failedNodes = (revisedTask.nodes || []).filter((node) => createdNodeIds.includes(node.id) && ['failed', 'waiting', 'blocked'].includes(node.status));
          if (failedNodes.length || !createdNodeIds.some((id) => revisedTask.nodes?.find((node) => node.id === id)?.status === 'completed')) {
            throw new Error(failedNodes.map((node) => node.errorText || node.waitReason).filter(Boolean).join('\n') || 'uBuddy 团队任务图尚未完成。');
          }
          const finalLocalId = proposal.nodes?.find((node) => node.isFinal)?.localId || '';
          const finalNodeId = revision.nodeIdsByLocal?.[finalLocalId] || createdNodeIds.at(-1) || '';
          const finalNode = revisedTask.nodes?.find((node) => node.id === finalNodeId)
            || revisedTask.nodes?.filter((node) => createdNodeIds.includes(node.id) && node.status === 'completed').at(-1);
          const answer = String(finalNode?.resultText || createdNodeIds.map((id) => revisedTask.nodes?.find((node) => node.id === id)?.resultText || '').filter(Boolean).join('\n\n')).trim();
          if (!answer) throw new Error('uBuddy 团队已运行，但没有产生可交付结果。');
          const responseMessage = store.addMessage({
            sessionId: session.id,
            role: 'assistant',
            content: answer,
            agentId: session.agentId || 'secretary_agent',
            departmentId: 'agent_delegation',
            metadata: privateMetadata({
              processedByOwnUBuddy: true,
              ubuddyTeamCoordination: true,
              ubuddyPlannerMode: plannerMode,
              taskRunId: delegatedTask.id,
              taskGraphRevisionId: revision.revision?.id || '',
              assignedAgentIds: [...new Set(proposal.nodes.map((node) => node.agentId))],
            }),
          });
          result = {
            session,
            message: responseMessage,
            answer,
            task: revisedTask,
            coordination: {
              plannerMode,
              taskRunId: delegatedTask.id,
              taskGraphRevisionId: revision.revision?.id || '',
              assignedAgentIds: [...new Set(proposal.nodes.map((node) => node.agentId))],
            },
          };
        } else {
          const selectedCandidate = selectBestUBuddyCandidate(executionCandidates, {
            departmentId: pptCreationRequested ? 'ppt_department' : (delegatedTask?.departmentId || ''),
            prompt: executionPrompt,
          });
          const revisionAgentId = selectedCandidate?.agentId || delegatedTask?.leadAgentId || 'general_agent';
          const revisionDepartmentId = org.agent(revisionAgentId)?.departmentId || 'general';
          saveWorkspaceUserMessage(original || '请结合新上传的材料继续完善当前任务初稿。', { attachments, workspaceIntent: 'execute', supersedesResultCandidate: true });
          const workerResult = await this.sendChat({
            message: original || '请结合新上传的材料继续完善当前任务初稿。',
            routingMessage: buildPrivateDelegationWorkspaceRouteMessage(delegation, original, { isRequester, explicitFileRequest }),
            attachments,
            chatMode: 'agent',
            routePreference: 'explicit',
            departmentId: revisionDepartmentId,
            agentId: revisionAgentId,
            workspaceRoot: taskWorkspaceRoot,
            sandboxPermission: externalExecutionPermissionMode,
            timeoutMs: Number(process.env.JANUS_UBUDDY_WORKSPACE_NODE_TIMEOUT_MS || 1_800_000),
            requestedAccountWorkspaceId: delegation.workspaceId || delegation.accountWorkspaceId || '',
            internalWorkspaceToken: internalWorkspaceExecutionToken,
            signal,
            onEvent: publishWorkspaceEvent,
            contextScope: {
              kind: 'task',
              taskRunId: delegation.taskRunId || delegationId,
              delegationId,
              groupId: delegation.groupId || '',
              title: delegation.title || '',
            },
            model,
            reasoningEffort,
          });
          const responseMessage = store.addMessage({
            sessionId: session.id,
            role: 'assistant',
            content: workerResult.answer || workerResult.message?.content || '',
            agentId: 'secretary_agent',
            departmentId: 'agent_delegation',
            metadata: privateMetadata({
              processedByOwnUBuddy: true,
              workerSessionId: workerResult.session?.id || '',
              workerMessageId: workerResult.message?.id || '',
              assignedAgentIds: [revisionAgentId],
            }),
          });
          result = {
            ...workerResult,
            session,
            message: responseMessage,
            answer: responseMessage.content,
            coordination: {
              plannerMode: selectedCandidate ? 'skill_fallback' : 'legacy_fallback',
              taskRunId: delegation.taskRunId || delegationId,
              assignedAgentIds: [revisionAgentId],
            },
          };
        }
        if (result.task?.id) {
          const workspaceTask = store.getTaskRun(result.task.id) || result.task;
          result.task = workspaceTask;
          if (String(workspaceTask.status || '') !== 'completed') {
            const errors = (workspaceTask.nodes || []).filter((node) => ['failed', 'waiting', 'blocked'].includes(node.status)).map((node) => node.errorText || node.waitReason).filter(Boolean);
            throw new Error(errors.join('\n') || `Workspace task graph ended with status ${workspaceTask.status}.`);
          }
          store.updateTaskRunMetadata?.(workspaceTask.id, { externalWorkspaceRevisionInProgress: null });
        }
      } catch (error) {
        const publicError = publicDelegationExecutionFailure(error);
        emitUBuddyDiagnostic('workspace_execution_failed', {
          level: 'error',
          data: { delegationId, requesterWorkspace: isRequester, pptCreationRequested },
          error,
        });
        for (const message of store.listMessages(session.id)) {
          if (localMessageIdsBefore.has(message.id)) continue;
          if (message.role === 'assistant') {
            store.updateMessage(message.id, {
              content: publicError,
              metadata: privateMetadata({ ...(message.metadata || {}), executionFailed: true, publishCandidate: false, resultState: 'failed' }),
            });
            continue;
          }
          if (message.role !== 'user') continue;
          store.updateMessage(message.id, {
            metadata: privateMetadata({
              ...(message.metadata || {}),
              workspaceRole: isRequester ? 'requester' : 'recipient',
              workspaceIntent: 'execute',
              supersedesResultCandidate: true,
            }),
          });
        }
        store.addMessage({
          sessionId: session.id,
          role: 'assistant',
          content: publicError,
          agentId: session.agentId || 'secretary_agent',
          departmentId: 'agent_delegation',
          metadata: privateMetadata({
            workspaceRole: isRequester ? 'requester' : 'recipient',
            executionFailed: true,
            publishCandidate: false,
            resultState: 'failed',
          }),
        });
        const failureStatus = ['submitted', 'result_accepted'].includes(String(delegation.status || '')) ? delegation.status : 'blocked';
        const failedMetadata = {
          ...(delegation.metadata || {}),
          taskWorkspaceRoot,
          workspaceSessionId: session.id,
          workspaceEpoch,
          workspaceExecutionError: String(error?.message || error).slice(0, 4000),
          workspaceExecutionFailedAt: new Date().toISOString(),
        };
        delegation = auth.updateAgentDelegation({
          delegationId,
          ...(isRequester ? {} : { status: failureStatus }),
          sessionId: session.id,
          metadata: failedMetadata,
        });
        // Keep the revision ownership marker after failure. Task progress can
        // arrive after this catch block; the marker prevents that late event
        // from promoting a private revision failure to a terminal delegation
        // failure. A retry replaces it and a successful revision clears it.
        if (socialRelay.connected()) {
          if (isRequester) {
            await socialRelay.updateDelegation(delegationId, {
              sessionId: session.id,
              metadata: privateAgentDelegationMetadata(failedMetadata),
            });
          } else {
            try {
              await socialRelay.updateDelegation(delegationId, {
                status: failureStatus,
                sessionId: session.id,
                metadata: publicAgentDelegationMetadata(failedMetadata),
              });
            } catch {
              await socialRelay.updateDelegation(delegationId, { status: failureStatus, sessionId: session.id });
            }
          }
          delegation = auth.agentDelegationById(delegationId) || delegation;
          await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, privateDelegationWorkspaceMessages(store, delegation), workspaceEpoch);
        }
        return {
          ok: false,
          action: 'blocked',
          error: publicError,
          session,
          messages: currentWorkspaceMessages(),
          delegation,
        };
      }
      const answerMessage = result.message?.id ? store.getMessage(result.message.id) : null;
      if (answerMessage) {
        result.message = store.updateMessage(answerMessage.id, {
          content: appendDelegationDecisionPrompt(answerMessage.content, delegation),
          metadata: privateMetadata({
            ...(answerMessage.metadata || {}),
            processedByOwnUBuddy: true,
            workspaceRole: isRequester ? 'requester' : 'recipient',
            publishCandidate: true,
            publishAction: isRequester ? 'update_requirements' : 'submit',
            awaitingOwnerDecision: true,
            explicitFileRequest,
            resultState: 'complete',
            ...(result.coordination ? {
              ubuddyTeamCoordination: true,
              ubuddyPlannerMode: result.coordination.plannerMode || '',
              taskRunId: result.coordination.taskRunId || delegation.taskRunId || delegationId,
              taskGraphRevisionId: result.coordination.taskGraphRevisionId || '',
              assignedAgentIds: Array.isArray(result.coordination.assignedAgentIds)
                ? result.coordination.assignedAgentIds
                : [],
            } : {}),
          }),
        });
        result.answer = result.message.content;
      }
      for (const message of store.listMessages(session.id)) {
        if (localMessageIdsBefore.has(message.id) || message.id === result.message?.id) continue;
        if (message.role !== 'user') continue;
        store.updateMessage(message.id, {
          metadata: privateMetadata({
            ...(message.metadata || {}),
            workspaceRole: isRequester ? 'requester' : 'recipient',
            workspaceIntent: 'execute',
            supersedesResultCandidate: true,
            clientMessageId,
          }),
        });
      }
      if (!pptCreationRequested) {
        ensureDelegationEditableDraftFile({
          workspaceRoot: taskWorkspaceRoot,
          delegation,
          answer: result.answer || result.message?.content || '',
          previous: delegation.metadata?.generatedTaskFiles,
          force: explicitFileRequest,
        });
      }
      const pptArtifactReady = !pptCreationRequested
        || listDelegationWorkspaceDeliverables(taskWorkspaceRoot).some((filePath) => /\.pptx$/i.test(filePath));
      const generatedTaskFiles = pptArtifactReady ? collectDelegationGeneratedFiles({
        runtimeRoot,
        store,
        sessionId: session.id,
        workspaceRoot: taskWorkspaceRoot,
        userId: user.id,
        previous: delegation.metadata?.generatedTaskFiles,
        delegationId,
        groupId: delegationGroupId(delegation),
        workspaceEpoch,
        candidateMessageId: result.message?.id || '',
        workspaceBaseline,
      }) : (Array.isArray(delegation.metadata?.generatedTaskFiles) ? delegation.metadata.generatedTaskFiles : []);
      const fileCandidates = generatedTaskFiles.map((item) => item.source_path || item.sourcePath || item.path || '').filter(Boolean);
      const validationTaskId = result.coordination?.taskRunId || delegation.taskRunId || '';
      const validationTask = validationTaskId ? store.getTaskRun(validationTaskId) : null;
      let deliveryValidation = null;
      if (pptArtifactReady) {
        if (isRequester && explicitFileRequest) {
          const contract = createDeliverableContract({
            prompt: original,
            objective: { taskType: 'private_workspace_file', summary: original },
            finalNode: { agentId: session.agentId || 'secretary_agent' },
          });
          if (deliverableContractRequiresValidation(contract)) {
            deliveryValidation = validateStandaloneDeliverable({
              contract,
              prompt: original,
              answer: result.answer || result.message?.content || '',
              workspaceRoot: taskWorkspaceRoot,
              ownerAgent: session.agentId || 'secretary_agent',
              fileCandidates,
            });
          }
        } else if (validationTask?.id) {
          deliveryValidation = validationTask.metadata?.deliverableResult
            || validationTask.metadata?.deliveryReview || null;
        } else {
          const contract = createDeliverableContract({ prompt: delegation.instruction || delegation.title, finalNode: { agentId: session.agentId || '' } });
          if (deliverableContractRequiresValidation(contract)) {
            deliveryValidation = validateStandaloneDeliverable({
              contract,
              prompt: delegation.instruction || delegation.title,
              answer: result.answer || result.message?.content || '',
              workspaceRoot: taskWorkspaceRoot,
              ownerAgent: session.agentId || '',
              fileCandidates,
            });
          }
        }
      }
      const schedulerDeliveryReady = validationTask?.id
        ? ['delivered', 'user_confirmed', 'closed'].includes(String(validationTask.metadata?.finalDelivery?.state || ''))
          || String(validationTask.metadata?.resultState || '') === 'delivered'
        : null;
      const deliveryReady = validationTask?.id
        ? Boolean(schedulerDeliveryReady)
        : Boolean(pptArtifactReady && (!deliveryValidation || deliveryValidation.passed));
      if (deliveryReady) await syncSharedTaskWorkspace(delegation, user, 'push');
      if (!deliveryReady) {
        if (validationTask?.id) {
          const currentTask = store.getTaskRun(validationTask.id) || validationTask;
          const reviewState = String(currentTask.metadata?.deliveryReviewState || '');
          const artifactError = currentTask.metadata?.deliveryValidationSummary
            || '当前交付版本尚未通过 Scheduler 基础交付检查，任务正在修改或等待用户处理。';
          return {
            ok: true,
            action: reviewState === 'action_required' ? 'action_required' : 'delivery_unqualified',
            deliveryReady: false,
            error: artifactError,
            session,
            messages: currentWorkspaceMessages(),
            delegation,
            generatedTaskFiles,
            task: currentTask,
          };
        }
        const artifactError = !pptArtifactReady
          ? 'PPT Designer 没有生成可验证的 PPTX 文件，因此本轮未形成可提交交付物；系统没有用对话记录或 Markdown 草稿冒充 PPT。'
          : deliveryValidation?.summary || '最终交付物未通过 contract 验收，本轮结果需要修正。';
        emitUBuddyDiagnostic('workspace_required_artifact_missing', {
          level: 'error', data: { delegationId, requiredArtifact: pptCreationRequested ? 'pptx' : 'deliverable_contract', requesterWorkspace: isRequester,
            validationCode: deliveryValidation?.failureCode || '' },
        });
        if (result.message?.id) {
          result.message = store.updateMessage(result.message.id, {
            content: `${String(result.message.content || result.answer || '').replace(/\n\n你可以继续告诉我需要修改的地方，或回复“(?:确认提交|提交到任务群)”。\s*$/u, '').trim()}\n\n${artifactError}`.trim(),
            metadata: {
              ...(result.message.metadata || {}),
              publishCandidate: false,
              awaitingOwnerDecision: false,
              resultState: 'incomplete',
              executionDegraded: true,
              requiredArtifact: pptCreationRequested ? 'pptx' : 'deliverable_contract',
            },
          });
        }
        const failedMetadata = {
          ...(delegation.metadata || {}),
          taskWorkspaceRoot,
          workspaceSessionId: session.id,
          workspaceEpoch,
          workspaceExecutionError: artifactError,
          workspaceExecutionFailedAt: new Date().toISOString(),
          requiredArtifact: pptCreationRequested ? 'pptx' : 'deliverable_contract',
        };
        const failureStatus = !isRequester && !['submitted', 'result_accepted'].includes(String(delegation.status || '')) ? 'blocked' : delegation.status;
        delegation = auth.updateAgentDelegation({
          delegationId,
          ...(isRequester ? {} : { status: failureStatus }),
          sessionId: session.id,
          metadata: failedMetadata,
        });
        if (socialRelay.connected()) {
          if (isRequester) {
            await socialRelay.updateDelegation(delegationId, {
              sessionId: session.id,
              metadata: privateAgentDelegationMetadata(failedMetadata),
            }).catch(() => null);
          } else {
            await socialRelay.updateDelegation(delegationId, {
              status: failureStatus,
              sessionId: session.id,
              metadata: publicAgentDelegationMetadata(failedMetadata),
            }).catch(() => null);
          }
          await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, privateDelegationWorkspaceMessages(store, delegation), workspaceEpoch);
          delegation = auth.agentDelegationById(delegationId) || delegation;
        }
        return {
          ok: false,
          action: 'blocked',
          error: artifactError,
          session,
          messages: currentWorkspaceMessages(),
          delegation,
          generatedTaskFiles,
        };
      }
      const nextMetadata = {
        ...(delegation.metadata || {}),
        taskWorkspaceRoot,
        workspaceSessionId: session.id,
        workspaceEpoch,
        preliminaryResult: result.answer || result.message?.content || delegation.metadata?.preliminaryResult || '',
        generatedTaskFiles,
        ...(deliveryValidation ? { deliverableResult: deliveryValidation, resultState: deliveryValidation.resultState } : {}),
        workspaceUpdatedAt: new Date().toISOString(),
        workspaceExecutionError: '',
        workspaceExecutionFailedAt: '',
        workspaceRevisionRecovered: Boolean(delegation.metadata?.workspaceExecutionError) || Boolean(delegation.metadata?.workspaceRevisionRecovered),
        ...(result.coordination ? { ubuddyTeamCoordination: result.coordination } : {}),
      };
      const nextStatus = !isRequester && !['submitted', 'result_accepted'].includes(String(delegation.status || '')) ? 'draft_ready' : delegation.status;
      delegation = auth.updateAgentDelegation({
        delegationId,
        ...(isRequester ? {} : { status: nextStatus }),
        sessionId: session.id,
        metadata: nextMetadata,
      });
      if (socialRelay.connected()) {
        if (isRequester) {
          await socialRelay.updateDelegation(delegationId, {
            sessionId: session.id,
            metadata: privateAgentDelegationMetadata(nextMetadata),
          });
        } else {
          try {
            await socialRelay.updateDelegation(delegationId, {
              status: nextStatus,
              sessionId: session.id,
              metadata: nextMetadata,
            });
          } catch {
            await socialRelay.updateDelegation(delegationId, { status: nextStatus, sessionId: session.id });
            await socialRelay.updateDelegation(delegationId, { status: nextStatus, sessionId: session.id, metadata: nextMetadata }).catch(() => null);
          }
        }
        delegation = auth.agentDelegationById(delegationId) || delegation;
      }
      if (socialRelay.connected()) {
        const localMessages = privateDelegationWorkspaceMessages(store, delegation);
        await syncDelegationWorkspaceMessages(socialRelay, delegationId, session.id, localMessages, workspaceEpoch);
      }
      emitUBuddyDiagnostic('workspace_execution_completed', {
        data: {
          delegationId,
          requesterWorkspace: isRequester,
          status: delegation.status || '',
          generatedFileCount: generatedTaskFiles.length,
          pptArtifactReady,
          plannerMode: result.coordination?.plannerMode || '',
        },
      });
      return { ok: true, action: 'message', session, messages: currentWorkspaceMessages(), delegation, generatedTaskFiles };
    }
  };
  return runtimeApi;
}

function transientCollaborationMutationError(error = null) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
    || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code)
    || /fetch failed|network error|socket hang up|connection (?:closed|reset|refused)|timed? out|temporarily unavailable|bad gateway|gateway timeout/i.test(message);
}

function delegationSubmissionConfirmed(status = '') {
  return ['submitted', 'result_accepted', 'closed'].includes(String(status || '').trim().toLowerCase());
}

function collaborationActionLifecycleMetadata(action = '', currentMetadata = {}, actionContext = {}) {
  const previousProgress = currentMetadata?.executionProgress && typeof currentMetadata.executionProgress === 'object'
    ? currentMetadata.executionProgress
    : {};
  const nextProgress = (phase, message, terminal = false) => ({
    ...previousProgress,
    version: 1,
    sequence: Number(previousProgress.sequence || 0) + 1,
    phase,
    message,
    running: 0,
    waiting: 0,
    updatedAt: new Date().toISOString(),
    terminal,
  });
  const clarification = actionContext?.metadata?.clarification && typeof actionContext.metadata.clarification === 'object'
    ? actionContext.metadata.clarification
    : currentMetadata?.clarification && typeof currentMetadata.clarification === 'object'
      ? currentMetadata.clarification
      : null;
  const clarificationQuestion = String(clarification?.question || '').trim();
  const blockedMessage = clarificationQuestion
    ? `等待接收方补充信息：${clarificationQuestion}`
    : String(actionContext?.content || '').trim() || '任务已受阻，等待处理后继续。';
  return ({
    working: { executionState: 'running', deliveryState: 'executing', failureCode: '', failureStage: '', retryable: false, publicFailure: null, executionProgress: nextProgress('executing', '接收方 uBuddy 正在处理任务') },
    submit: { executionState: 'completed', deliveryState: 'submitted', failureCode: '', failureStage: '', retryable: false, publicFailure: null, executionProgress: nextProgress('delivered', '任务结果和文件已交付到任务群', true) },
    blocked: {
      executionState: 'blocked',
      deliveryState: 'blocked',
      retryable: true,
      executionProgress: {
        ...nextProgress('waiting', blockedMessage),
        lifecyclePhase: 'confirming',
        blocker: {
          summary: clarificationQuestion || blockedMessage,
          userActionRequired: Boolean(clarificationQuestion),
          requiresUserAction: Boolean(clarificationQuestion),
          suggestedNextStep: clarificationQuestion
            ? '接收方在私有任务工作区回复后，uBuddy 会自动继续原任务。'
            : '处理阻塞原因后重试原任务。',
        },
      },
    },
    decline: { executionState: 'stopped', deliveryState: 'declined', retryable: false },
    withdraw: { executionState: 'stopped', deliveryState: 'withdrawn', retryable: false, executionProgress: nextProgress('delivered', '发起人已撤回任务', true) },
    accept_result: { executionState: 'completed', deliveryState: 'accepted', retryable: false, executionProgress: nextProgress('delivered', '发起人已接受任务交付', true) },
    request_revision: { executionState: 'queued', deliveryState: 'revision_requested', failureCode: '', failureStage: '', retryable: false, publicFailure: null, executionProgress: nextProgress('queued', '发起人已提出修改要求，等待重新处理') },
    publish: { executionState: 'queued', deliveryState: 'preparing', failureCode: '', failureStage: '', retryable: false },
    update_requirements: { executionState: 'queued', deliveryState: 'revision_requested', failureCode: '', failureStage: '', retryable: false },
  })[String(action || '').trim().toLowerCase()] || {};
}

function privateWorkspacePlannerCandidates({ store, org, cloudSync, userId = '' } = {}) {
  return buildUBuddyPlannerCandidates({
    store,
    org,
    userId,
    performanceForAgent: (agentInstanceId) => cloudSync.stage8Projection(`performance:${agentInstanceId}`)?.payload || null,
    leadershipForAgent: (agentInstanceId) => {
      const projection = cloudSync.stage8Projection(`leadership:${agentInstanceId}`);
      const leadership = projection?.payload || null;
      const approvedTrial = (cloudSync.stage8Projection(`leadership_actions:${agentInstanceId}`)?.payload || [])
        .find((item) => item.action === 'trial_approved' && item.status === 'approved');
      return leadership ? { ...leadership, approvedTrial, projectionUpdatedAt: projection.updatedAt || '' } : null;
    },
  });
}

function freezeNaturalGroupContinuousDispatch(dispatch = {}, planningSession = null, decision = null) {
  if (!planningSession?.id || !decision) {
    const error = new Error('自然群组新任务缺少持续规划会话。');
    error.code = 'ubuddy_planning_session_required';
    throw error;
  }
  const frozen = validateUBuddyDispatchV3({
    ...dispatch,
    version: 3,
    planningSessionId: planningSession.id,
    planningRevision: planningSession.revision,
    planningDecisionDigest: uBuddyPlanningDecisionDigest(decision),
    readinessProof: null,
  }, { throwOnError: true }).value;
  return validateUBuddyDispatchV3({
    ...frozen,
    readinessProof: createUBuddyReadinessProof(frozen),
  }, { throwOnError: true }).value;
}

function publicPeerAvailabilityByUserId(relationships = []) {
  return Object.fromEntries((Array.isArray(relationships) ? relationships : []).map((relationship) => {
    const friend = relationship?.friend || relationship?.user || relationship || {};
    const userId = String(friend.id || '').trim();
    const publicStatus = friend.publicAvailability || friend.publicStatus
      || relationship?.publicAvailability || relationship?.publicStatus || null;
    return [userId, publicStatus];
  }).filter(([userId, publicStatus]) => userId && publicStatus));
}

function selectionMetadataForDispatch(dispatch = {}) {
  return {
    version: 1,
    selectionMode: dispatch.selectionMode || 'candidate_pool',
    candidateUserIds: dispatch.candidateUserIds || [],
    requiredUserIds: dispatch.requiredUserIds || [],
    selectedUserIds: dispatch.selectedUserIds || [],
    profileRevisionSnapshots: dispatch.profileRevisionSnapshots || [],
    selectionDecision: dispatch.selectionDecision || null,
  };
}

function assertDispatchReplayCompatible(requestedDispatch = {}, frozenDispatch = {}) {
  if (dispatchReplayDigest(requestedDispatch) === dispatchReplayDigest(frozenDispatch)) return;
  const error = new Error('派发命令 ID 已被不同请求占用。');
  error.code = 'ubuddy_dispatch_idempotency_conflict';
  throw error;
}

function dispatchReplayDigest(dispatch = {}) {
  const comparable = { ...(dispatch || {}) };
  delete comparable.routingShadow;
  delete comparable.profileRevisionSnapshots;
  return cryptoModule.createHash('sha256').update(JSON.stringify(canonicalDispatchValue(comparable))).digest('hex');
}

function canonicalDispatchValue(value) {
  if (Array.isArray(value)) return value.map(canonicalDispatchValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalDispatchValue(value[key])]));
}

function selectionDigestForDispatch(dispatch = {}) {
  return cryptoModule.createHash('sha256').update(JSON.stringify({
    version: Number(dispatch.version || 3),
    selectionMode: String(dispatch.selectionMode || ''),
    candidateUserIds: [...new Set((dispatch.candidateUserIds || []).map(String).filter(Boolean))].sort(),
    requiredUserIds: [...new Set((dispatch.requiredUserIds || []).map(String).filter(Boolean))].sort(),
    selectedUserIds: [...new Set((dispatch.selectedUserIds || []).map(String).filter(Boolean))].sort(),
    profileRevisionSnapshots: (dispatch.profileRevisionSnapshots || []).map((item) => ({
      ownerUserId: String(item?.ownerUserId || ''),
      profileRevision: Number(item?.profileRevision || 0),
      sourceEffectiveSkillHash: String(item?.sourceEffectiveSkillHash || ''),
    })).sort((left, right) => left.ownerUserId.localeCompare(right.ownerUserId)),
    strategyVersion: String(dispatch.selectionDecision?.strategyVersion || ''),
  })).digest('hex');
}

function externalDelegationWorkspacePermissionMode(value = '') {
  return String(value || '').trim() === 'auto-approve' ? 'auto-approve' : 'full-access';
}

function invalidateCollaborationGroupSummaries(store, groupId = '', reason = '', user = null) {
  for (const session of store.listSessions({ limit: 200, includeArchived: true, user })) {
    for (const message of store.listMessages(session.id)) {
      if (!message.metadata?.collaborationGroupSummaryCandidate || message.metadata?.groupId !== groupId || message.metadata?.summaryInvalidated) continue;
      store.updateMessage(message.id, {
        metadata: { ...message.metadata, summaryInvalidated: true, summaryInvalidatedReason: reason, summaryInvalidatedAt: new Date().toISOString(), awaitingOwnerDecision: false },
      });
    }
  }
}
