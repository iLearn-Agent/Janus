import {
  classifyMultiMentionTrigger,
  createPickerMentionEntity,
  normalizeMentionEntities,
  UBUDDY_MENTION_SELECTION_VERSION,
  UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
} from '../../../../shared/contracts/mentions.js';
import { messageQuotePromptText, normalizeMessageQuote } from '../../../../shared/contracts/messageQuote.js';

export function createNetworkMessageController({
  api,
  documentRef,
  state,
  render,
  notify,
  readyAttachmentsForSend,
  currentModelValue,
  currentReasoningValue,
  selectedSocialTaskGroup,
  networkConversationDraftKey,
  persistComposerDrafts,
  composerSurfaceKey = () => '',
  captureComposerDraft = () => {},
  clearComposerDraft = () => {},
  restoreComposerDraft = () => undefined,
  getComposerDraftSnapshot = () => null,
  putComposerDraftSnapshot = () => {},
  hasComposerDraft = () => false,
  refreshSocialThreads,
  scrollMessagesToBottom,
  focusChatInputAtEnd,
  userErrorMessage,
  refreshCollaborationOverview,
  noteDirectoryGroups,
}) {
  function beginComposerSubmission({ surfaceKey, legacyDraftKey, input, content, attachments, quote }) {
    captureComposerDraft(surfaceKey);
    const snapshot = getComposerDraftSnapshot(surfaceKey) || {
      draft: {
        text: content,
        mentions: [...(state.composerMentions || [])],
        secretaryMentions: [...(state.secretaryMentions || [])],
        fileReferences: [...(state.composerFileReferences || [])],
        memoryReferences: [...(state.composerMemoryReferences || [])],
        quote,
        taskReference: state.composerTaskReference || null,
        participantSelectionPolicy: state.uBuddyParticipantSelectionPolicy,
      },
      attachments: [...attachments],
    };
    clearComposerDraft(surfaceKey, { applyToCurrent: false });
    if (legacyDraftKey && state.networkConversationDrafts) delete state.networkConversationDrafts[legacyDraftKey];
    const activeSurfaceKey = composerSurfaceKey();
    if (!activeSurfaceKey || activeSurfaceKey === surfaceKey) {
      if (input) input.value = '';
      clearCurrentComposerState();
    }
    persistComposerDrafts();
    return snapshot;
  }

  function restoreFailedComposerSubmission({ surfaceKey, legacyDraftKey, snapshot, input }) {
    if (!snapshot || hasComposerDraft(surfaceKey)) return false;
    putComposerDraftSnapshot(surfaceKey, snapshot);
    const text = String(snapshot.draft?.text || '');
    if (legacyDraftKey && text) {
      state.networkConversationDrafts = { ...(state.networkConversationDrafts || {}), [legacyDraftKey]: text };
      persistComposerDrafts();
    }
    const activeSurfaceKey = composerSurfaceKey();
    if (!activeSurfaceKey || activeSurfaceKey === surfaceKey) {
      const restoredText = restoreComposerDraft(surfaceKey);
      if (restoredText === undefined) applyComposerSnapshot(snapshot);
      if (input) input.value = state.chatDraft;
    }
    return true;
  }

  function clearCurrentComposerState() {
    state.chatDraft = '';
    state.composerMentions = [];
    state.secretaryMentions = [];
    state.attachments = [];
    state.composerFileReferences = [];
    state.composerMemoryReferences = [];
    state.messageQuote = null;
    state.composerTaskReference = null;
  }

  function applyComposerSnapshot(snapshot = {}) {
    const draft = snapshot.draft || snapshot;
    state.chatDraft = String(draft.text || '');
    state.composerMentions = [...(draft.mentions || [])];
    state.secretaryMentions = [...(draft.secretaryMentions || [])];
    state.attachments = [...(snapshot.attachments || [])];
    state.composerFileReferences = [...(draft.fileReferences || [])];
    state.composerMemoryReferences = [...(draft.memoryReferences || [])];
    state.messageQuote = draft.quote || null;
    state.composerTaskReference = draft.taskReference || null;
    state.uBuddyParticipantSelectionPolicy = draft.participantSelectionPolicy === 'auto_select'
      ? 'auto_select'
      : 'all_mentioned';
  }

  function mergeDispatchedCollaboration(result = {}) {
    const group = result?.group || result?.result?.group || null;
    const tasks = Array.isArray(result?.tasks) ? result.tasks
      : Array.isArray(result?.result?.tasks) ? result.result.tasks : [];
    const mergeById = (current = [], incoming = []) => {
      const merged = new Map((Array.isArray(current) ? current : [])
        .filter((item) => item?.id).map((item) => [String(item.id), item]));
      for (const item of incoming) {
        if (!item?.id) continue;
        const previous = merged.get(String(item.id)) || {};
        merged.set(String(item.id), {
          ...previous,
          ...item,
          metadata: { ...(previous.metadata || {}), ...(item.metadata || {}) },
        });
      }
      return [...merged.values()];
    };
    if (!group?.id && !tasks.length) return { group: null, tasks: [] };
    const nextOverview = {
      ...(state.collaborationOverview || {}),
      groups: mergeById(state.collaborationOverview?.groups, group?.id ? [group] : []),
      tasks: mergeById(state.collaborationOverview?.tasks, tasks),
    };
    state.collaborationOverview = nextOverview;
    if (tasks.length) state.agentDelegations = mergeById(state.agentDelegations, tasks);
    noteDirectoryGroups?.(nextOverview);
    return { group, tasks };
  }

  async function sendChatGroupMessage() {
    const groupId = String(state.chatGroupId || '').trim();
    const input = documentRef.getElementById('chat-input');
    const content = String(input?.value || state.chatDraft || '').trim();
    const outgoingAttachmentItems = [...state.attachments];
    const favoriteEmoji = outgoingAttachmentItems.length === 1 && outgoingAttachmentItems.every((item) => item.source === 'favorite-emoji');
    const outgoingQuote = normalizeMessageQuote(state.messageQuote);
    const outgoingSurfaceKey = composerSurfaceKey() || `chat-group:${groupId}`;
    const legacyDraftKey = `chat-group:${groupId}`;
    if (!groupId || (!content && !outgoingAttachmentItems.length) || state.networkConversationBusy) return;
    if (state.chatGroupDetail?.group?.status === 'dissolved') {
      notify('群聊已解散，只能查看历史消息。', 'warning');
      return;
    }
    const selectedMentions = activeComposerMentions(content);
    const groupUBuddyAudience = selectedMentions.find((item) => item.principalType === 'group_audience' && item.audience === 'member_ubuddies');
    const mentions = groupUBuddyAudience ? [
      ...selectedMentions,
      ...(state.chatGroupDetail?.members || []).filter((member) => member.status === 'active').map((member) => createPickerMentionEntity({
        principalType: 'ubuddy', ownerUserId: member.userId || member.user?.id || '', displayText: groupUBuddyAudience.displayText,
      })).filter(Boolean),
    ] : selectedMentions;
    const outgoingDraftSnapshot = beginComposerSubmission({
      surfaceKey: outgoingSurfaceKey,
      legacyDraftKey,
      input,
      content,
      attachments: outgoingAttachmentItems,
      quote: outgoingQuote,
    });
    const operationId = `chat-group-send:${groupId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    state.networkConversationOperationId = operationId;
    state.networkConversationBusy = true;
    render();
    let messagePersisted = false;
    try {
      const attachments = await readyAttachmentsForSend(outgoingAttachmentItems);
      if (outgoingAttachmentItems.length && !attachments.length) throw new Error('附件尚未成功上传。');
      const clientMessageId = `chat_group_ui_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const multiMention = classifyMultiMentionTrigger({
        content,
        mentions,
        currentUserId: state.currentUser?.id || '',
        source: 'natural_chat_group',
        attachmentCount: attachments.length,
      });
      const multiMentionCommandId = multiMention.classification === 'multi_task'
        ? `ubuddy-group-dispatch:${clientMessageId}`
        : '';
      const userResult = await api.sendChatGroupMessage({
        groupId,
        content: favoriteEmoji ? '\u200b' : content || '分享了附件。',
        clientMessageId,
        metadata: {
          mentions,
          ...(multiMention.classification !== 'none' ? {
            uBuddyMultiMention: {
              ...multiMention,
              commandId: multiMentionCommandId,
              sourceType: 'natural_chat_group',
            },
          } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(favoriteEmoji ? { favoriteEmoji: true } : {}),
          ...(outgoingQuote ? { quote: outgoingQuote } : {}),
        },
      });
      state.chatGroupDetailCache = { ...(state.chatGroupDetailCache || {}), [groupId]: userResult };
      if (String(state.chatGroupId || '') === groupId) state.chatGroupDetail = userResult;
      messagePersisted = true;
      if (state.networkConversationOperationId === operationId) {
        state.networkConversationBusy = false;
        state.networkConversationOperationId = '';
      }
      render();
      scrollMessagesToBottom({ force: true });
      if (multiMention.classification === 'multi_task') {
        const sourceMessage = (userResult.messages || []).find((item) => item.id === clientMessageId)
          || (userResult.messages || []).at(-1);
        const publicContext = (userResult.messages || []).slice(-30).map((message) => ({
          id: message.id || '',
          content: `${message.sender?.displayName || message.sender?.display_name || message.sender?.username || '群成员'}${message.senderAgentId ? '的 uBuddy' : ''}：${message.content || ''}`,
          metadata: message.metadata || {},
        }));
        const dispatched = await api.dispatchCollaborationCommand({
          content: messageQuotePromptText(outgoingQuote, content || '请结合附件完成多人任务。'),
          mentions,
          mentionSelectionVersion: UBUDDY_MENTION_SELECTION_VERSION,
          participantSelectionPolicyVersion: UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
          participantSelectionPolicy: 'auto_select',
          sourceType: 'natural_chat_group',
          sourceConversationId: `chat-group:${groupId}`,
          sourceMessageId: sourceMessage?.id || clientMessageId,
          sourceGroupId: groupId,
          workspaceId: userResult.group?.workspaceId || userResult.group?.accountWorkspaceId || '',
          contextMessages: publicContext,
          attachments,
          participantPolicy: 'auto_select',
          autoExecutionPolicy: 'low_medium_risk',
        });
        if (dispatched?.dispatched) {
          notify(`uBuddy 已为 ${multiMention.targetUserIds.length} 位成员拆分并派发任务。`, 'success');
          const refreshedGroup = await api.chatGroup({ groupId }).catch(() => state.chatGroupDetailCache?.[groupId] || userResult);
          state.chatGroupDetailCache = { ...(state.chatGroupDetailCache || {}), [groupId]: refreshedGroup };
          if (String(state.chatGroupId || '') === groupId) state.chatGroupDetail = refreshedGroup;
          await refreshCollaborationOverview(false);
        } else if (dispatched?.queued) {
          notify(`群消息已发送，uBuddy 正在后台为 ${multiMention.targetUserIds.length} 位成员规划分工。`, 'success');
        } else if (dispatched?.clarification?.content) {
          notify(dispatched.clarification.content, 'warning');
        }
      }
      const ownUBuddy = mentions.some((item) => item.principalType === 'ubuddy' && item.ownerUserId === state.currentUser?.id);
      if (ownUBuddy && multiMention.classification !== 'multi_task') {
        const sourceMessage = (userResult.messages || []).find((item) => item.id === clientMessageId) || (userResult.messages || []).at(-1);
        const publicContext = (userResult.messages || []).slice(-30).map((message) => ({
          content: `${message.sender?.displayName || message.sender?.display_name || message.sender?.username || '群成员'}${message.senderAgentId ? '的 uBuddy' : ''}：${message.content || ''}`,
          metadata: message.metadata || {},
        }));
        const processed = await api.processAgentDelegationContent({
          phase: 'reply',
          content: messageQuotePromptText(outgoingQuote, `请仅依据群聊公开上下文回答这次对我的提及：${content.replaceAll('@我的uBuddy', '').trim()}。不要代替我做正式承诺。`),
          contextMessages: publicContext,
          attachments,
          model: currentModelValue(),
          reasoningEffort: currentReasoningValue(),
          sandboxPermission: state.sandboxPermission,
        });
        const reply = String(processed?.content || '').trim() || '我已结合群聊公开上下文完成整理。';
        const agentReplyDetail = await api.sendChatGroupMessage({
          groupId,
          content: `${reply}\n\n正式结果或承诺仍由你确认后提交。`,
          senderAgentId: 'secretary_agent',
          kind: 'agent',
          metadata: { type: 'ubuddy_context_reply', inReplyTo: sourceMessage?.id || '', publicContextOnly: true, ubuddyProcessingMode: processed?.mode || 'fallback' },
        });
        state.chatGroupDetailCache = { ...(state.chatGroupDetailCache || {}), [groupId]: agentReplyDetail };
        if (String(state.chatGroupId || '') === groupId) state.chatGroupDetail = agentReplyDetail;
      }
      state.chatGroupsOverview = await api.chatGroupsOverview();
    } catch (error) {
      if (!messagePersisted) {
        restoreFailedComposerSubmission({
          surfaceKey: outgoingSurfaceKey,
          legacyDraftKey,
          snapshot: outgoingDraftSnapshot,
          input,
        });
      }
      notify(messagePersisted
        ? `群消息已发送，但 uBuddy 启动多人任务失败：${userErrorMessage(error)}`
        : `群消息发送失败：${userErrorMessage(error)}`, 'error');
    } finally {
      if (state.networkConversationOperationId === operationId) {
        state.networkConversationBusy = false;
        state.networkConversationOperationId = '';
      }
      render();
      scrollMessagesToBottom({ force: true });
    }
  }

  async function sendSocialGroupMessage() {
    const peerId = String(state.networkConversationPeerId || '').trim();
    const input = documentRef.getElementById('chat-input');
    const content = String(input?.value || state.chatDraft || '').trim();
    const outgoingAttachmentItems = [...state.attachments];
    const favoriteEmoji = outgoingAttachmentItems.length === 1
      && outgoingAttachmentItems.every((item) => item.source === 'favorite-emoji');
    const outgoingQuote = normalizeMessageQuote(state.messageQuote);
    const outgoingSurfaceKey = composerSurfaceKey()
      || `social-group:${peerId}:${state.networkConversationGroupId || 'legacy'}`;
    if (!peerId || (!content && !outgoingAttachmentItems.length) || state.networkConversationBusy) return;
    const selfMessage = peerId === state.currentUser?.id;
    const relationship = (state.friendOverview?.friends || []).find((item) => item.friend?.id === peerId);
    const friend = selfMessage ? state.currentUser : relationship?.friend || null;
    if (!friend) {
      notify('好友关系不存在或尚未同步。', 'error');
      return;
    }
    const friendName = selfMessage
      ? state.currentUser?.displayName || state.currentUser?.display_name || state.currentUser?.username || state.currentUser?.email || state.currentUser?.id || friend.id
      : relationship.remark || friend.remark || friend.displayName || friend.display_name || friend.username || friend.email || friend.id;
    const mentions = activeComposerMentions(content);
    const delegatesToFriendUBuddy = !selfMessage && mentions.some((item) => item.principalType === 'ubuddy' && item.ownerUserId === peerId);
    const delegatesThroughOwnUBuddy = !selfMessage && mentions.some((item) => item.principalType === 'ubuddy' && item.ownerUserId === state.currentUser?.id);
    const friendUBuddyTokens = mentions.filter((item) => item.principalType === 'ubuddy' && item.ownerUserId === peerId).map((item) => item.displayText);
    const taskGroup = selectedSocialTaskGroup();
    if (taskGroup?.dissolved) {
      notify('该任务群聊已经解散，请从好友列表重新发布任务。', 'warning');
      return;
    }
    const draftKey = networkConversationDraftKey(peerId, 'group', state.networkConversationGroupId);
    const outgoingDraftSnapshot = beginComposerSubmission({
      surfaceKey: outgoingSurfaceKey,
      legacyDraftKey: draftKey,
      input,
      content,
      attachments: outgoingAttachmentItems,
      quote: outgoingQuote,
    });
    state.networkConversationBusy = true;
    state.socialMentionMenuOpen = false;
    render();
    let messagePersisted = false;
    try {
      const attachments = await readyAttachmentsForSend(outgoingAttachmentItems);
      let outgoingContent = favoriteEmoji ? '\u200b' : content || '分享了附件。';
      let processed = null;
      if (delegatesThroughOwnUBuddy) {
        let instruction = content;
        for (const token of friendUBuddyTokens) instruction = instruction.replaceAll(token, '');
        instruction = instruction.replaceAll('@我的uBuddy', '');
        instruction = instruction.replace(/^\s*[:：,，-]+\s*/, '').trim();
        if (!instruction && !attachments.length) throw new Error('请在 @我的 uBuddy 后填写具体内容。');
        processed = await api.processAgentDelegationContent({
          phase: 'create',
          content: messageQuotePromptText(outgoingQuote, instruction || '请结合附件整理后转达。'),
          attachments,
          ...(outgoingQuote ? { quote: outgoingQuote } : {}),
          model: currentModelValue(),
          reasoningEffort: currentReasoningValue(),
          sandboxPermission: state.sandboxPermission,
        });
        const processedInstruction = String(processed?.content || instruction).trim();
        outgoingContent = `${delegatesToFriendUBuddy ? `@${friendName}的uBuddy ` : ''}${processedInstruction}`.trim();
      }
      await api.sendSocialMessage({
        recipientId: peerId,
        workspaceId: state.networkConversationWorkspaceId || undefined,
        content: outgoingContent,
        kind: delegatesThroughOwnUBuddy ? 'agent' : 'friend',
        senderAgentId: delegatesThroughOwnUBuddy ? 'secretary_agent' : '',
        recipientAgentId: delegatesToFriendUBuddy ? 'secretary_agent' : '',
        metadata: {
          type: 'social_task_group_message',
          source: 'social_task_group_chat',
          taskGroupId: taskGroup?.id || '',
          groupId: taskGroup?.id || '',
          mentions,
          originalContent: delegatesThroughOwnUBuddy ? content.slice(0, 8000) : '',
          processedByOwnUBuddy: delegatesThroughOwnUBuddy,
          ubuddyProcessingMode: processed?.mode || (delegatesThroughOwnUBuddy ? 'fallback' : 'direct'),
          attachments,
          ...(favoriteEmoji ? { favoriteEmoji: true } : {}),
          ...(outgoingQuote ? { quote: outgoingQuote } : {}),
        },
      });
      messagePersisted = true;
      if (delegatesThroughOwnUBuddy) notify('我的 uBuddy 已整理内容并发送到四方任务群。', 'success');
      const [messages, inbox] = await Promise.all([
        api.socialConversation({ peerId }),
        api.socialInbox(),
      ]);
      state.networkConversationMessages = messages || [];
      state.socialInbox = inbox || [];
      await refreshSocialThreads(false);
    } catch (error) {
      if (!messagePersisted) {
        restoreFailedComposerSubmission({
          surfaceKey: outgoingSurfaceKey,
          legacyDraftKey: draftKey,
          snapshot: outgoingDraftSnapshot,
          input,
        });
      }
      notify(messagePersisted
        ? `消息已发送，但刷新会话失败：${error.message || error}`
        : `发送失败：${error.message || error}`, 'error');
    } finally {
      state.networkConversationBusy = false;
      render();
      scrollMessagesToBottom({ force: true });
      focusChatInputAtEnd();
    }
  }

  async function sendDirectSocialMessage() {
    const peerId = String(state.networkConversationPeerId || '').trim();
    const selfMessage = peerId === state.currentUser?.id;
    const input = documentRef.getElementById('chat-input');
    const content = String(input?.value || state.chatDraft || '').trim();
    const outgoingAttachmentItems = [...state.attachments];
    const favoriteEmoji = outgoingAttachmentItems.length === 1 && outgoingAttachmentItems.every((item) => item.source === 'favorite-emoji');
    const outgoingQuote = normalizeMessageQuote(state.messageQuote);
    const outgoingSurfaceKey = composerSurfaceKey() || `social-direct:${peerId}`;
    if (!peerId || (!content && !outgoingAttachmentItems.length) || state.networkConversationBusy) return;
    const mentions = selfMessage ? [] : activeComposerMentions(content);
    const legacyDraftKey = networkConversationDraftKey(peerId, 'person', '');
    const outgoingDraftSnapshot = beginComposerSubmission({
      surfaceKey: outgoingSurfaceKey,
      legacyDraftKey,
      input,
      content,
      attachments: outgoingAttachmentItems,
      quote: outgoingQuote,
    });
    state.networkConversationBusy = true;
    render();
    let messagePersisted = false;
    try {
      const attachments = await readyAttachmentsForSend(outgoingAttachmentItems);
      const effectiveMentions = [...mentions];
      const delegationContent = [
        effectiveMentions.map((item) => item.displayText).filter((token) => token && !content.includes(token)).join(' '),
        content,
      ].filter(Boolean).join(' ').trim();
      if (!selfMessage && effectiveMentions.some((item) => item.principalType === 'ubuddy' && item.ownerUserId === state.currentUser?.id)) {
        const sourceMessageId = globalThis.crypto?.randomUUID?.() || `direct_task_source_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const dispatched = await api.dispatchCollaborationCommand({
          content: messageQuotePromptText(outgoingQuote, delegationContent),
          mentions: effectiveMentions,
          mentionSelectionVersion: UBUDDY_MENTION_SELECTION_VERSION,
          participantSelectionPolicyVersion: UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
          participantSelectionPolicy: 'auto_select',
          sourcePeerId: peerId,
          sourceConversationId: `direct:${state.currentUser?.id || ''}:${peerId}`,
          sourceMessageId,
          sourceGroupId: '',
          contextMessages: [],
          attachments,
        });
        messagePersisted = true;
        const localMessage = dispatched?.clarification
          ? {
              id: `local-ubuddy-${sourceMessageId}`,
              senderUserId: '',
              senderAgentId: 'secretary_agent',
              recipientUserId: state.currentUser?.id || '',
              content: dispatched.clarification.content,
              createdAt: new Date().toISOString(),
              metadata: { type: 'ubuddy_local_clarification', localOnly: true, reasonCode: dispatched.clarification.reasonCode },
            }
          : null;
        state.networkConversationMessages = [
          ...(await api.socialConversation({ peerId }) || []),
          ...(localMessage ? [localMessage] : []),
        ];
        if (dispatched?.dispatched) {
          mergeDispatchedCollaboration(dispatched);
          render();
          notify('uBuddy 已直接派发任务。', 'success');
        }
      } else {
        await api.sendSocialMessage({
          recipientId: peerId,
          workspaceId: state.networkConversationWorkspaceId || undefined,
          content: favoriteEmoji ? '\u200b' : content || '分享了附件。',
          kind: 'friend',
          metadata: {
            type: 'direct_message',
            attachments,
            ...(favoriteEmoji ? { favoriteEmoji: true } : {}),
            mentions,
            ...(outgoingQuote ? { quote: outgoingQuote } : {}),
          },
        });
        messagePersisted = true;
        state.networkConversationMessages = await api.socialConversation({ peerId });
        await refreshSocialThreads(false);
      }
    } catch (error) {
      if (!messagePersisted) {
        restoreFailedComposerSubmission({
          surfaceKey: outgoingSurfaceKey,
          legacyDraftKey,
          snapshot: outgoingDraftSnapshot,
          input,
        });
      }
      notify(messagePersisted
        ? `消息已发送，但刷新会话失败：${userErrorMessage(error)}`
        : `发送失败：${userErrorMessage(error)}`, 'error');
    } finally {
      state.networkConversationBusy = false;
      render();
      scrollMessagesToBottom({ force: true });
    }
  }

  async function sendCollaborationGroupMessage() {
    const groupId = String(state.collaborationGroupId || '').trim();
    const input = documentRef.getElementById('chat-input');
    const content = String(input?.value || state.chatDraft || '').trim();
    const outgoingAttachmentItems = [...state.attachments];
    const outgoingQuote = normalizeMessageQuote(state.messageQuote);
    const outgoingSurfaceKey = composerSurfaceKey() || `collaboration:${groupId}`;
    const legacyDraftKey = `collaboration:${groupId}`;
    if (!groupId || (!content && !outgoingAttachmentItems.length) || state.networkConversationBusy) return;
    if (state.collaborationGroupDetail?.group?.status === 'closed') {
      notify('该任务群聊已经解散，只能查看历史记录。', 'warning');
      return;
    }
    const mentions = activeComposerMentions(content);
    const outgoingDraftSnapshot = beginComposerSubmission({
      surfaceKey: outgoingSurfaceKey,
      legacyDraftKey,
      input,
      content,
      attachments: outgoingAttachmentItems,
      quote: outgoingQuote,
    });
    state.networkConversationBusy = true;
    render();
    let messagePersisted = false;
    try {
      const attachments = await readyAttachmentsForSend(outgoingAttachmentItems);
      const outgoingContent = content || '分享了附件。';
      const ownUBuddy = mentions.some((item) => item.principalType === 'ubuddy' && item.ownerUserId === state.currentUser?.id);
      const clientMessageId = `group_ui_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      if (ownUBuddy) {
        const userResult = await api.sendCollaborationMessage({
          groupId,
          content: outgoingContent,
          clientMessageId,
          senderAgentId: '',
          kind: 'friend',
          metadata: { mentions, mentionsOwnUBuddy: true, attachments, ...(outgoingQuote ? { quote: outgoingQuote } : {}) },
        });
        messagePersisted = true;
        captureCollaborationRoutingConfirmation(userResult, { groupId, content: outgoingContent, clientMessageId });
        const sourceMessage = (userResult.messages || []).at(-1);
        const publicContext = (userResult.messages || []).slice(-30).map((message) => ({
          content: `${message.sender?.displayName || message.sender?.display_name || message.sender?.username || '群成员'}${message.senderAgentId ? '的 uBuddy' : ''}：${message.content || ''}`,
          metadata: message.metadata || {},
        }));
        const processed = await api.processAgentDelegationContent({
          phase: 'reply',
          content: messageQuotePromptText(outgoingQuote, `请仅依据任务群公开上下文回答我的这次提及：${outgoingContent.replaceAll('@我的uBuddy', '').trim()}。不要替我作正式承诺。`),
          attachments,
          contextMessages: publicContext,
          model: currentModelValue(),
          reasoningEffort: currentReasoningValue(),
          sandboxPermission: state.sandboxPermission,
        });
        const reply = String(processed?.content || '').trim() || '我已结合任务群公开上下文完成整理。';
        state.collaborationGroupDetail = await api.sendCollaborationMessage({
          groupId,
          content: `${reply}\n\n正式结果或承诺仍由你确认后提交。`,
          senderAgentId: 'secretary_agent',
          kind: 'agent',
          metadata: { type: 'ubuddy_context_reply', inReplyTo: sourceMessage?.id || '', publicContextOnly: true, ubuddyProcessingMode: processed?.mode || 'fallback' },
        });
      } else {
        const userResult = await api.sendCollaborationMessage({
          groupId,
          content: outgoingContent,
          clientMessageId,
          senderAgentId: '',
          kind: 'friend',
          metadata: { mentions, attachments, ...(outgoingQuote ? { quote: outgoingQuote } : {}) },
        });
        messagePersisted = true;
        state.collaborationGroupDetail = userResult;
        captureCollaborationRoutingConfirmation(userResult, { groupId, content: outgoingContent, clientMessageId });
      }
      await refreshCollaborationOverview(false);
    } catch (error) {
      if (!messagePersisted) {
        restoreFailedComposerSubmission({
          surfaceKey: outgoingSurfaceKey,
          legacyDraftKey,
          snapshot: outgoingDraftSnapshot,
          input,
        });
      }
      notify(messagePersisted
        ? `群消息已发送，但 uBuddy 回复或任务刷新失败：${userErrorMessage(error)}`
        : `群消息发送失败：${userErrorMessage(error)}`, 'error');
    } finally {
      state.networkConversationBusy = false;
      render();
      scrollMessagesToBottom({ force: true });
    }
  }

  function captureCollaborationRoutingConfirmation(result = {}, { groupId = '', content = '', clientMessageId = '' } = {}) {
    const routing = result.routing || {};
    if (!result.needsRoutingConfirmation && !routing.needsRoutingConfirmation) return;
    const candidates = Array.isArray(routing.candidates) ? routing.candidates : [];
    const candidateDelegationIds = Array.isArray(routing.candidateDelegationIds)
      ? routing.candidateDelegationIds
      : candidates.map((item) => item?.delegationId || item?.id || '').filter(Boolean);
    const sourceMessageId = String(routing.sourceGroupMessageId || routing.sourceMessageId || clientMessageId || '').trim();
    state.collaborationRoutingConfirmation = {
      groupId,
      sourceMessageId,
      content,
      candidates,
      candidateDelegationIds,
      selectedDelegationId: candidateDelegationIds.length === 1 ? candidateDelegationIds[0] : '',
    };
  }

  async function confirmCollaborationRoutingTarget() {
    const confirmation = state.collaborationRoutingConfirmation;
    const delegationId = String(confirmation?.selectedDelegationId || '').trim();
    if (!confirmation?.groupId || !confirmation.sourceMessageId || !delegationId || state.networkConversationBusy) return;
    state.networkConversationBusy = true;
    render();
    try {
      state.collaborationGroupDetail = await api.sendCollaborationMessage({
        groupId: confirmation.groupId,
        content: confirmation.content || '确认任务更新目标。',
        senderAgentId: '',
        kind: 'friend',
        metadata: {
          routingConfirmationFor: confirmation.sourceMessageId,
          delegationId,
        },
      });
      state.collaborationRoutingConfirmation = null;
      await refreshCollaborationOverview(false);
      notify('这条群消息已准确同步到所选任务的私有 uBuddy 会话。', 'success');
    } catch (error) {
      notify(`确认任务更新目标失败：${userErrorMessage(error)}`, 'error');
    } finally {
      state.networkConversationBusy = false;
      render();
      scrollMessagesToBottom({ force: true });
    }
  }

  function cancelCollaborationRoutingConfirmation() {
    state.collaborationRoutingConfirmation = null;
    render();
    focusChatInputAtEnd();
  }

  function activeComposerMentions(content = '') {
    return normalizeMentionEntities(state.composerMentions || [], { content, requirePicker: true });
  }

  return {
    cancelCollaborationRoutingConfirmation,
    confirmCollaborationRoutingTarget,
    sendCollaborationGroupMessage,
    sendChatGroupMessage,
    sendDirectSocialMessage,
    sendSocialGroupMessage,
  };
}
