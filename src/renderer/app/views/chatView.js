import {
  HOME_DEPARTMENT_CHIPS,
  IMAGE_ATTACHMENT_EXTENSIONS,
  IMAGE_MODEL_OPTIONS,
  PPT_TEMPLATE_OPTIONS,
  REASONING_OPTIONS,
  modelCatalogEntry,
  reasoningOptionsForModel,
  textModelOptions,
} from '../constants.js';
import { avatarLabelFromName, state, userInitials } from '../state.js';
import { renderUserAvatar } from '../utils/avatar.js';
import { iconSvg } from '../ui/icons.js';
import { agentAvatarTone, agentInstanceDisplayNameForUi, renderAgentAvatarContent } from '../utils/agentIdentity.js';
import { clipInline, escapeAttr, escapeHtml, formatBytes, formatMessageTime, formatQuotaPercent, formatText, isImageSource, janusBrandText, quotaUsagePercent, statusLabelForAttachment, stripAttachmentResourceBlock } from '../utils/format.js';
import { filePayloadAttr, normalizeFilePayload } from '../utils/filePayload.js';
import { pathBasename } from '../utils/path.js';
import {
  isSocialTaskGroupEvent,
  latestSocialTaskGroup,
  messagesForSocialTaskGroup,
  socialTaskGroupById,
  socialMentionTokens,
} from '../utils/socialTaskGroups.js';
import { PPT_STYLE_OPTIONS, pptStyleOption } from '../../../shared/pptAgents.js';
import { MESSAGE_REACTION_EMOJIS, messageReactionGroups } from '../../../shared/messageReactions.js';
import { COMPOSER_COMMON_EMOJIS, COMPOSER_DEFAULT_EMOJI_CATEGORIES } from '../../../shared/composerEmojis.js';
import { normalizeEmojiFavorites } from '../../../shared/emojiFavorites.js';
import {
  normalizeMentionEntities,
  UBUDDY_PARTICIPANT_SELECTION_POLICIES,
} from '../../../shared/contracts/mentions.js';
import { publicDelegationSubmissionText } from '../../../shared/contracts/delegation.js';
import { normalizeMessageQuote } from '../../../shared/contracts/messageQuote.js';
import { normalizePublicTaskSummary } from '../../../shared/contracts/taskSummary.js';
import { uBuddyControlMessageKind, uBuddyControlMessageText } from '../../../shared/uBuddyControlMessages.js';
import { normalizeLanguage, translateUBuddyMessageText, translateUiText } from '../i18n.js';
import { TASK_CARD_ACTIONS, normalizeTaskSourceContext } from '../../../shared/contracts/taskCard.js';
import { renderFinalDeliverableCard, renderTaskProgressCard } from './taskProgressView.js';
import { renderCodexChangeSummary } from './codexChangeReviewView.js';
import { renderCodexTranscript } from './codexTranscriptView.js';
import { numberAgentInstanceLabels, renderAgentWorkProjectionSummary, workProjectionEnvelope } from '../components/agentWorkProjection.js';
import {
  compareUBuddyTasks,
  taskBelongsToSession,
  taskIdsForMessages,
  taskProgressCounts,
  taskSourceMessageId,
  uBuddyTaskDisplayStatus,
} from '../features/ubuddy/taskDisplayState.js';

let viewDeps = {};
let publishedTaskCardsByMessageId = null;
const CONTINUOUS_MESSAGE_WINDOW_MS = 5 * 60 * 1000;
const MENTION_AGENT_NAME_COLLATOR = new Intl.Collator(['en', 'zh-CN'], { numeric: true, sensitivity: 'base' });

export function renderChat(deps = {}) {
  viewDeps = deps;
  return renderChatView();
}

function messageTextForCopy(...args) {
  return viewDeps.messageTextForCopy?.(...args) || '';
}

function agentsForDepartment(...args) {
  return viewDeps.agentsForDepartment?.(...args) || [];
}

function resolveSelectedAgentId(...args) {
  return viewDeps.resolveSelectedAgentId?.(...args) || '';
}

function shortAgentLabel(...args) {
  return viewDeps.shortAgentLabel?.(...args) || '';
}

function agentPickerTitle(...args) {
  return viewDeps.agentPickerTitle?.(...args) || '';
}

function agentNameById(...args) {
  return viewDeps.agentNameById?.(...args) || '';
}

function departmentName(...args) {
  return viewDeps.departmentName?.(...args) || '';
}

function normalizeSearch(value) {
  return viewDeps.normalizeSearch?.(value) || String(value || '').trim().toLowerCase();
}

function renderChatView() {
  if (state.chatGroupId) {
    return state.chatGroupDetail ? renderNaturalChatGroupChat() : renderNaturalChatGroupLoading();
  }
  if (state.collaborationGroupId) {
    return state.collaborationGroupDetail
      ? renderCollaborationGroupChat()
      : renderCollaborationGroupLoading();
  }
  const socialFriend = activeSocialFriend();
  if (socialFriend) return state.networkConversationMode === 'person' ? renderDirectSocialChat(socialFriend) : renderSocialGroupChat(socialFriend);
  const messages = renderMessageList();
  const planViewer = renderChatPlanViewer();
  const planViewerMode = planViewer ? String(state.chatPlanViewer?.mode || '') : '';
  const localTaskWorkspace = state.activeTaskWorkspaceKind === 'agent_session';
  const employeeConversationSelected = Boolean(state.employeeConversationHistoryViewer
    || (state.currentSessionId && state.currentAgentInstanceId));
  const sessionMessagesLoading = Boolean(
    state.currentSessionId
    && state.messagePagination?.sessionId === state.currentSessionId
    && state.messagePagination?.initialLoading === true
  );
  const shortcutConversationInitial = isMessageShortcutInitialState();
  const messageShortcutInitial = !localTaskWorkspace
    && !state.employeeConversationHistoryViewer
    && !sessionMessagesLoading
    && state.networkPanelOpen
    && state.networkPanelView === 'messages'
    && !state.networkMessageHomeOpen
    && shortcutConversationInitial;
  const hasMessages = (!messageShortcutInitial && Boolean(messages))
    || localTaskWorkspace
    || sessionMessagesLoading
    || (employeeConversationSelected && !messageShortcutInitial);
  return `
    <div class="view chat-view ${hasMessages ? 'with-messages' : 'home'} ${messageShortcutInitial ? 'message-shortcut-initial' : ''} ${planViewerMode === 'sidebar' ? 'has-chat-plan-sidebar' : ''} ${state.draggingFiles ? 'is-dragging-files' : ''}">
      ${hasMessages ? renderConversation(messages) : renderHomeChat()}
      ${planViewer}
      ${renderGoalEditorDialog()}
      ${state.draggingFiles ? renderFileDropHint() : ''}
    </div>
  `;
}

function messageScrollKey() {
  if (state.employeeConversationHistoryViewer) {
    const viewer = state.employeeConversationHistoryViewer;
    return `employee-history:${viewer.agentInstanceId || ''}:${viewer.historyGroupId || ''}`;
  }
  if (state.chatGroupId) return `chat-group:${state.chatGroupId}`;
  if (state.collaborationGroupId) return `collaboration-group:${state.collaborationGroupId}`;
  if (state.networkConversationGroupId) return `social-group:${state.networkConversationGroupId}`;
  if (state.networkConversationPeerId) return `social-peer:${state.networkConversationPeerId}:${state.networkConversationMode || ''}`;
  return String(state.currentChatKey || (state.currentSessionId ? `session:${state.currentSessionId}` : '') || 'chat:new');
}

function isMessageShortcutInitialState() {
  const conversationMessages = Array.isArray(state.messages) ? state.messages : [];
  if (isPrivateAssistantComposerMode()) return conversationMessages.length === 0;
  if (!isUBuddyComposerMode()) return false;
  return conversationMessages.every((message) => (
    message?.role === 'assistant' && message?.metadata?.welcome === true
  ));
}

function renderNaturalChatGroupLoading() {
  const group = (state.chatGroupsOverview?.groups || []).find((item) => item.id === state.chatGroupId) || {};
  const groupTitle = (group.membership?.remark || group.title)
    ? `<strong data-no-localize>${escapeHtml(group.membership?.remark || group.title)}</strong>`
    : '<strong>新群聊</strong>';
  return `<div class="view chat-view with-messages social-group-chat-view natural-chat-group-view" aria-busy="true"><section class="chat-panel conversation-panel social-group-panel">
    <header class="social-group-header"><div class="social-group-heading"><div class="social-group-title"><span class="social-group-avatar">${escapeHtml(naturalChatGroupAvatarLabel(group))}</span><span>${groupTitle}<small>正在同步成员和消息…</small></span></div>${renderSocialConversationCloseButton()}</div></header>
    <div class="message-list social-group-message-list" id="message-list" data-message-scroll-key="${escapeAttr(messageScrollKey())}"><div class="social-group-empty" role="status"><strong>正在打开群聊</strong><span>请稍候。</span></div></div>
  </section></div>`;
}

function renderNaturalChatGroupChat() {
  const detail = state.chatGroupDetail || {};
  const group = detail.group || {};
  const currentUserId = state.currentUser?.id || '';
  const uBuddyParticipating = naturalChatGroupHasUBuddyParticipation(detail.messages || []);
  const activeMembers = (detail.members || []).filter((item) => item.status === 'active');
  const memberCount = activeMembers.length || Number(group.memberCount || 0);
  const groupTitle = (detail.membership?.remark || group.title)
    ? `<strong data-no-localize>${escapeHtml(detail.membership?.remark || group.title)}</strong>`
    : '<strong>新群聊</strong>';
  return `<div class="view chat-view with-messages social-group-chat-view natural-chat-group-view"><section class="chat-panel conversation-panel social-group-panel">
    <header class="social-group-header"><div class="social-group-heading"><div class="social-group-title"><span class="social-group-avatar">${escapeHtml(naturalChatGroupAvatarLabel(group))}</span><span>${groupTitle}<small>${memberCount} 位成员 · 联系人群聊 · ${group.status === 'dissolved' ? '已解散' : detail.loading ? '正在同步' : '进行中'}</small></span></div>
      <div class="social-group-actions"><button class="social-group-detail-button" type="button" data-chat-group-detail-open="${escapeAttr(group.id || state.chatGroupId || '')}" title="查看群聊详情" aria-label="查看群聊详情">${iconSvg('users')}</button><button class="voice-call-entry" type="button" data-video-room-start="${escapeAttr(state.activeAccountWorkspace?.id || group.accountWorkspaceId || '')}" data-video-room-group-id="${escapeAttr(group.id || state.chatGroupId || '')}" title="多人通话" aria-label="多人通话">${iconSvg('video')}<span>多人通话</span></button>${renderSocialConversationCloseButton()}</div></div>
    </header>
    <div class="message-list social-group-message-list" id="message-list" data-message-scroll-key="${escapeAttr(messageScrollKey())}">${renderContinuousMessageSequence(detail.messages || [], (message, continuity) => renderNaturalChatGroupMessage(message, currentUserId, continuity, uBuddyParticipating), naturalChatMessageContinuityKey) || (detail.loading ? '<div class="social-group-empty is-syncing" role="status"><strong>正在同步群聊消息</strong><span>你可以先查看群聊信息，消息会在同步完成后自动显示。</span></div>' : '<div class="social-group-empty"><strong>开始群聊</strong><span>这里是自然人群聊；uBuddy 只会在被明确 @ 时参与。</span></div>')}</div>
    ${group.status === 'dissolved' ? '<div class="social-group-ended"><strong>群聊已解散</strong><span>历史消息已保留，当前为只读。</span></div>' : renderComposer('chat-group')}
  </section>${renderChatAvatarProfilePopover()}${renderMessageReceiptPopover()}${renderMessageReactionPicker()}</div>`;
}

function isEmojiOnlyText(value = '') {
  const text = String(value || '').trim();
  return Boolean(text) && text.length <= 32
    && /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|️|‍)+$/u.test(text);
}

function renderNaturalChatGroupMessage(message = {}, currentUserId = '', continuity = {}, uBuddyParticipating = false) {
  if (message.metadata?.type === 'voice_call_record') return renderVoiceCallRecordCard(message, { group: true, currentUserId, continuity });
  if (message.kind === 'system') return `<div class="social-group-system-event"><span>${escapeHtml(message.content || '')}</span><time>${escapeHtml(formatMessageTime(message.createdAt || message.created_at))}</time></div>`;
  const mine = (message.senderUserId || message.sender_user_id) === currentUserId;
  if (message.metadata?.withdrawn === true) {
    const senderName = naturalChatUserName(message.sender || {});
    return `<div class="withdrawn-direct-event withdrawn-group-event" data-message-id="${escapeAttr(message.id || '')}" role="status"><span>${mine ? '你撤回了一条群聊消息' : `${escapeHtml(senderName)}撤回了一条消息`}</span>${mine ? `<button type="button" data-withdrawn-message-edit="${escapeAttr(message.id || '')}">重新编辑</button>` : ''}</div>`;
  }
  if (['ubuddy_multi_task_status', 'ubuddy_multi_task_summary'].includes(message.metadata?.type)) {
    return renderNaturalMultiTaskCard(message, currentUserId);
  }
  const agent = Boolean(message.senderAgentId || message.sender_agent_id);
  const senderName = mine ? '我' : naturalChatUserName(message.sender || {});
  const actor = agent ? `${senderName === '我' ? '我的' : `${senderName} 的`} uBuddy` : senderName;
  const forwardedMessage = message.metadata?.forwardedMessage || null;
  const attachments = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
  const content = message.metadata?.favoriteEmoji === true ? '' : attachments.length ? stripAttachmentResourceBlock(message.content || '') : message.content || '';
  const humanHighlight = uBuddyParticipating && !agent;
  const workRequest = humanHighlight && messageHasUBuddyMention(message, content, collaborationMentionTokens());
  const avatar = renderSocialMessageAvatar({ mine, agent, friend: message.sender || {}, profileContext: 'group' });
  const avatarSlot = renderMessageAvatarSlot(avatar, continuity.consecutive);
  const receipt = renderMessageReceiptButton(message, { mine });
  const reactions = renderMessageReactions(message, { kind: 'group', groupId: state.chatGroupId, currentUserId });
  const attachmentContent = message.metadata?.favoriteEmoji === true ? renderFavoriteEmojiAttachments(attachments) : renderMessageAttachmentCards(attachments);
  const emojiOnly = isEmojiOnlyText(content);
  const bubbleContent = `${attachmentContent}${forwardedMessage ? renderForwardedMessage(forwardedMessage, content) : String(content).trim() ? `<div class="message-body${emojiOnly ? ' emoji-only-body' : ''}">${emojiOnly ? `<span class="sent-emoji-glyph">${escapeHtml(String(content).trim())}</span>` : formatNaturalChatGroupText(message, content)}</div>` : ''}${renderMessageQuote(message.metadata?.quote)}`;
  return `<article class="message ${mine ? 'user' : 'assistant'} social-group-message has-chat-avatar ${message.metadata?.favoriteEmoji === true ? 'is-favorite-emoji-message' : ''} ${emojiOnly ? 'is-emoji-only-message' : ''} ${continuousMessageClassNames(continuity)} ${agent ? 'is-agent-message' : 'is-human-message'} ${humanHighlight ? 'is-ubuddy-group-human' : ''} ${workRequest ? 'is-ubuddy-work-request' : ''}" data-message-id="${escapeAttr(message.id || '')}">${mine ? '' : avatarSlot}<div class="message-shell">${continuity.consecutive ? '' : `<div class="social-message-actor"><span>${escapeHtml(actor)}</span><time>${escapeHtml(formatMessageTime(message.createdAt || message.created_at))}</time></div>`}<div class="message-bubble">${renderMessageBubbleReceiptAnchor(bubbleContent, receipt)}${reactions}</div>${renderMessageFooter(message, '复制消息', { reactionKind: 'group', reactionGroupId: state.chatGroupId })}</div>${mine ? avatarSlot : ''}</article>`;
}

function messageUBuddyMentions(message = {}, content = message.content || '') {
  return normalizeMentionEntities(message.metadata?.mentions, {
    content,
    requirePicker: true,
  }).filter((mention) => mention.principalType === 'ubuddy');
}

function messageHasUBuddyMention(message = {}, content = message.content || '', fallbackTokens = []) {
  if (messageUBuddyMentions(message, content).length > 0) return true;
  if (Array.isArray(message.metadata?.mentions) && message.metadata.mentions.length > 0) return false;
  return fallbackTokens.some((token) => (
    /ubuddy/i.test(token) && String(content || '').includes(token)
  ));
}

function naturalChatGroupHasUBuddyParticipation(messages = []) {
  return messages.some((message) => (
    Boolean(message?.senderAgentId || message?.sender_agent_id)
    || ['ubuddy_multi_task_status', 'ubuddy_multi_task_summary'].includes(String(message?.metadata?.type || ''))
    || messageHasUBuddyMention(message, message?.content || '', collaborationMentionTokens())
  ));
}

function formatNaturalChatGroupText(message = {}, content = '') {
  const tokens = normalizeMentionEntities(message.metadata?.mentions, {
    content,
    requirePicker: true,
  }).map((mention) => mention.displayText).sort((left, right) => right.length - left.length);
  if (!tokens.length) return formatText(content);
  let markup = formatText(content);
  for (const token of [...new Set(tokens)]) {
    const escapedToken = escapeHtml(token);
    markup = markup.replaceAll(escapedToken, `<mark class="social-mention-token">${escapedToken}</mark>`);
  }
  return markup;
}

function renderNaturalMultiTaskCard(message = {}, currentUserId = '') {
  const metadata = message.metadata || {};
  const summary = metadata.type === 'ubuddy_multi_task_summary';
  const groupId = String(metadata.collaborationGroupId || '').trim();
  const status = String(metadata.status || (summary ? 'completed' : 'dispatched'));
  const labels = Array.isArray(metadata.participantLabels) ? metadata.participantLabels.filter(Boolean) : [];
  const title = summary ? '多人任务已完成' : ({
    planning: '正在规划多人分工',
    retry_wait: '多人分工等待重试',
    awaiting_presence: '等待成员上线',
    cancelled: '已取消等待发布',
    confirmation_required: '多人任务需要确认',
    action_required: '多人任务需要补充信息',
    failed: '多人任务派发失败',
    dispatched: '多人任务已派发',
  })[status] || '多人任务状态更新';
  const publishedRecipientCount = Math.max(0, Number(metadata.publishedRecipientCount || 0));
  const partialPresenceWait = status === 'awaiting_presence' && publishedRecipientCount > 0;
  const detail = labels.length
    ? `${labels.join('、')} · ${Number(metadata.assignmentCount || labels.length)} 项分工`
    : ['planning', 'retry_wait', 'awaiting_presence', 'confirmation_required', 'action_required'].includes(status)
      ? '原群消息已发送'
      : `${Number(metadata.assignmentCount || 0)} 项分工`;
  const canConfirm = status === 'confirmation_required'
    && String(metadata.ownerUserId || '') === String(currentUserId || '')
    && String(metadata.confirmationCommandId || metadata.dispatchCommandId || '').trim();
  const canCancelPending = status === 'awaiting_presence'
    && String(metadata.ownerUserId || '') === String(currentUserId || '')
    && String(metadata.dispatchCommandId || '').trim();
  return `<article class="natural-multi-task-card is-${escapeAttr(status)}" data-message-id="${escapeAttr(message.id || '')}">
    <header><span class="natural-multi-task-icon">U</span><span><small>uBuddy 多人协作</small><strong>${escapeHtml(title)}</strong></span><time>${escapeHtml(formatMessageTime(message.createdAt || message.created_at))}</time></header>
    <p>${formatText(message.content || '')}</p>
    <footer><span>${escapeHtml(detail)}</span>${canConfirm ? `<button type="button" data-confirm-multi-task="${escapeAttr(metadata.confirmationCommandId || metadata.dispatchCommandId)}">确认范围并派发</button>` : ''}${canCancelPending ? `<button type="button" data-cancel-pending-dispatch="${escapeAttr(metadata.dispatchCommandId)}">${partialPresenceWait ? '取消未上线成员补派' : '取消等待发布'}</button>` : ''}${groupId ? `<button type="button" data-collaboration-group="${escapeAttr(groupId)}">打开关联任务群</button>` : ''}</footer>
  </article>`;
}

function naturalChatMemberName(member = {}) {
  return naturalChatUserName(member.user || {}) || member.userId || '成员';
}

function naturalChatGroupAvatarLabel(group = {}) {
  return [...String(group.title || '群').trim()][0] || '群';
}

function naturalChatUserName(user = {}) {
  return user.remark || user.displayName || user.display_name || user.username || user.email || user.id || '成员';
}

function naturalChatMessageContinuityKey(message = {}) {
  return `${message.senderUserId || message.sender_user_id || ''}:${message.senderAgentId || message.sender_agent_id || ''}:${message.kind || ''}`;
}

function renderCollaborationGroupLoading() {
  const group = (state.collaborationOverview?.groups || [])
    .find((item) => String(item?.id || '') === String(state.collaborationGroupId || '')) || {};
  const title = group.title || 'uBuddy 工作群';
  const memberCount = Number(group.memberCount || 0);
  const status = group.status === 'closed' ? '已结束' : '进行中';
  return `<div class="view chat-view with-messages social-group-chat-view collaboration-group-chat-view collaboration-group-loading-view" aria-busy="true" data-collaboration-group-loading="${escapeAttr(state.collaborationGroupId || '')}"><section class="chat-panel conversation-panel social-group-panel">
    <header class="social-group-header"><div class="social-group-heading"><div class="social-group-title"><span class="social-group-avatar">群</span><span><strong>${escapeHtml(title)}</strong><small>${memberCount ? `${memberCount} 位成员 · ` : ''}${status}</small></span></div>${renderSocialConversationCloseButton()}</div></header>
    <div class="message-list social-group-message-list" id="message-list" data-message-scroll-key="${escapeAttr(messageScrollKey())}"><div class="social-group-empty" role="status"><strong>正在打开工作群</strong><span>正在同步群成员、消息和任务进度…</span></div></div>
  </section></div>`;
}

function renderChatUserInputPanel() {
  const run = state.activeChatRun || null;
  const request = run?.userInputRequest || null;
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  if (!request?.requestId || !questions.length) return '';
  const planMode = run?.interactionMode === 'plan';
  const english = state.languageMode === 'en';
  const questionIndex = Math.max(0, Math.min(questions.length - 1, Number(run.userInputQuestionIndex || 0)));
  const question = questions[questionIndex];
  const savedAnswer = String(run.userInputDraftAnswers?.[question.id]?.answers?.[0] || '');
  const options = Array.isArray(question.options) ? question.options : [];
  const optionLabels = options.map((option) => String(option?.label || ''));
  const savedOther = savedAnswer && !optionLabels.includes(savedAnswer) ? savedAnswer : '';
  const name = `chat-user-input-${questionIndex}`;
  const optionMarkup = options.map((option, optionIndex) => `<label class="chat-user-input-option">
      <input type="radio" name="${escapeAttr(name)}" value="${escapeAttr(option.label || '')}" ${savedAnswer === String(option.label || '') ? 'checked' : ''}>
      <span class="chat-user-input-index" aria-hidden="true">${optionIndex + 1}</span>
      <span class="chat-user-input-option-copy"><strong>${escapeHtml(option.label || '')}${optionIndex === 0 ? '<b>推荐</b>' : ''}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</span>
      <span class="chat-user-input-option-arrow" aria-hidden="true">${iconSvg('chevronRight')}</span>
    </label>`).join('');
  const allowOther = Boolean(question.isOther || (planMode && options.length && !question.isSecret));
  const otherMarkup = allowOther ? `<label class="chat-user-input-option is-other">
      <input type="radio" name="${escapeAttr(name)}" value="__other__" ${savedOther ? 'checked' : ''}>
      <span class="chat-user-input-index is-other" aria-hidden="true">${iconSvg('edit')}</span>
      <span class="chat-user-input-option-copy"><strong>${english ? 'Other' : '其他'}</strong></span>
      <input class="chat-user-input-other" data-user-input-other type="${question.isSecret ? 'password' : 'text'}" autocomplete="off" value="${escapeAttr(savedOther)}" placeholder="${english ? 'Tell Janus what should be different' : '告诉 Janus 应该如何调整'}">
    </label>` : '';
  const freeTextMarkup = !options.length
    ? `<input class="chat-user-input-text" data-user-input-text type="${question.isSecret ? 'password' : 'text'}" autocomplete="off" value="${escapeAttr(savedAnswer)}" placeholder="${english ? 'Enter your answer' : '请输入你的回答'}">`
    : '';
  const questionMarkup = `<fieldset class="chat-user-input-question" data-user-input-question="${escapeAttr(question.id || '')}">
      <div class="chat-user-input-options">${optionMarkup}${otherMarkup}${freeTextMarkup}</div>
    </fieldset>`;
  return `<section class="chat-user-input-panel" role="dialog" aria-labelledby="chat-user-input-title">
    <form data-chat-user-input-form="${escapeAttr(request.requestId)}">
      <header class="chat-user-input-header">
        <strong id="chat-user-input-title">${escapeHtml(question.question || question.header || `问题 ${questionIndex + 1}`)}</strong>
        <nav class="chat-user-input-top-navigation" aria-label="问题导航">
          <button type="button" data-chat-user-input-back title="上一题" aria-label="上一题" ${questionIndex === 0 || run.userInputSubmitting ? 'disabled' : ''}>${iconSvg('chevronLeft')}</button>
          <span>${questionIndex + 1} of ${questions.length}</span>
        </nav>
      </header>
      <div class="chat-user-input-body">${questionMarkup}</div>
      <p class="chat-user-input-error" data-chat-user-input-error ${run.userInputError ? '' : 'hidden'}>${escapeHtml(run.userInputError || '')}</p>
      <footer>
        <span>${planMode ? (english ? 'Your answer refines the plan; no files will be changed yet.' : '你的选择只用于细化计划，不会立即修改文件。') : (english ? 'Janus will continue this task after submission.' : '提交后 Janus 会继续当前任务。')}</span>
        <button class="is-primary" type="button" data-chat-user-input-skip ${run.userInputSubmitting ? 'disabled' : ''}>${english ? 'Skip' : '跳过'}</button>
      </footer>
    </form>
  </section>`;
}

function renderChatPlanExecutionPanel() {
  const prompt = state.chatPlanExecutionPrompt || null;
  if (!prompt?.messageId || String(prompt.sessionId || '') !== String(state.currentSessionId || '')) return '';
  const english = state.languageMode === 'en';
  const revising = prompt.mode === 'revision_input';
  const revisionDraft = String(prompt.revisionDraft || '');
  if (revising) {
    return `<section class="chat-user-input-panel chat-plan-execution-panel is-revision" role="dialog" aria-labelledby="chat-plan-execution-title">
      <header class="chat-user-input-header">
        <strong id="chat-plan-execution-title">${english ? 'How should Janus revise this plan?' : '告诉 Janus 如何修改这份计划'}</strong>
      </header>
      <div class="chat-user-input-body chat-plan-revision-body">
        <p class="chat-plan-revision-hint">${english ? 'Describe the steps, constraints, or requirements you want changed. Janus will create a new plan without executing it.' : '请说明需要调整的步骤、约束或需求。Janus 会重新拟定计划，但不会开始执行。'}</p>
        <textarea class="chat-user-input-text chat-plan-revision-input" data-chat-plan-revision-input rows="4" placeholder="${english ? 'For example: keep step 1, remove the database change, and add a rollback check.' : '例如：保留第 1 步，去掉数据库修改，并增加回滚检查。'}">${escapeHtml(revisionDraft)}</textarea>
      </div>
      <p class="chat-user-input-error" data-chat-plan-revision-error ${prompt.revisionError ? '' : 'hidden'}>${escapeHtml(prompt.revisionError || '')}</p>
      <footer>
        <span>${english ? 'The revised plan will need your confirmation again.' : '修订后的计划仍需你再次确认。'}</span>
        <div class="chat-user-input-navigation">
          <button type="button" data-chat-plan-revision-back ${prompt.revisionSubmitting ? 'disabled' : ''}>${english ? 'Back' : '返回'}</button>
          <button class="is-primary" type="button" data-chat-plan-revision-submit ${prompt.revisionSubmitting ? 'disabled' : ''}>${prompt.revisionSubmitting ? (english ? 'Submitting…' : '提交中…') : (english ? 'Regenerate plan' : '重新拟定计划')}</button>
        </div>
      </footer>
    </section>`;
  }
  return `<section class="chat-user-input-panel chat-plan-execution-panel" role="dialog" aria-labelledby="chat-plan-execution-title">
    <header class="chat-user-input-header">
      <strong id="chat-plan-execution-title">${english ? 'What would you like to do with this plan?' : '接下来如何处理这份计划？'}</strong>
    </header>
    <div class="chat-user-input-body">
      <div class="chat-user-input-options">
        <button class="chat-user-input-option" type="button" data-chat-plan-execution="execute" data-chat-plan-message-id="${escapeAttr(prompt.messageId)}">
          <span class="chat-user-input-index" aria-hidden="true">1</span>
          <span class="chat-user-input-option-copy"><strong>${english ? 'Execute this plan' : '执行此计划'}</strong><small>${english ? 'Let the Agent continue with the executable work.' : '允许 Agent 按计划继续完成可执行任务。'}</small></span>
          <span class="chat-user-input-option-arrow" aria-hidden="true">${iconSvg('chevronRight')}</span>
        </button>
        <button class="chat-user-input-option" type="button" data-chat-plan-execution="defer" data-chat-plan-message-id="${escapeAttr(prompt.messageId)}">
          <span class="chat-user-input-index" aria-hidden="true">2</span>
          <span class="chat-user-input-option-copy"><strong>${english ? 'Do not execute for now' : '暂时不执行'}</strong><small>${english ? 'Keep the plan in the conversation and return to normal chat.' : '保留当前计划答复，恢复普通对话输入。'}</small></span>
        </button>
        <button class="chat-user-input-option" type="button" data-chat-plan-execution="revise" data-chat-plan-message-id="${escapeAttr(prompt.messageId)}">
          <span class="chat-user-input-index" aria-hidden="true">3</span>
          <span class="chat-user-input-option-copy"><strong>${english ? 'No — tell Janus what to change' : '否，且告诉 Janus 如何做得不同'}</strong><small>${english ? 'Stay in Plan Mode and regenerate the plan from your feedback.' : '继续留在计划模式，根据你的意见重新拟定计划。'}</small></span>
          <span class="chat-user-input-option-arrow" aria-hidden="true">${iconSvg('chevronRight')}</span>
        </button>
      </div>
    </div>
  </section>`;
}

function renderChatPlanViewer() {
  const viewer = state.chatPlanViewer || null;
  const messageId = String(viewer?.messageId || '');
  const message = messageId ? state.messages.find((item) => item.id === messageId) : null;
  const plan = message?.metadata?.plan || null;
  if (!message || !plan) return '';
  const mode = viewer?.mode === 'standalone' ? 'standalone' : 'sidebar';
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  const title = session?.title || '实施计划';
  const content = `
    <header class="chat-plan-viewer-header">
      <span class="chat-plan-viewer-title"><i>${iconSvg('plan')}</i><span><strong>${escapeHtml(title)}</strong><small>${mode === 'sidebar' ? '计划侧栏' : '独立计划视图'}</small></span></span>
      <button type="button" data-close-chat-plan-viewer title="关闭" aria-label="关闭计划查看器">${iconSvg('x')}</button>
    </header>
    <div class="chat-plan-viewer-body">
      ${renderChatPlanCard(plan, { expanded: true })}
      <section class="chat-plan-viewer-copy"><h3>完整计划内容</h3><div>${formatText(message.content || '')}</div></section>
    </div>
    <footer class="chat-plan-viewer-actions">${renderChatPlanActions(messageId)}</footer>`;
  if (mode === 'sidebar') return `<aside class="chat-plan-viewer is-sidebar" aria-label="计划侧栏">${content}</aside>`;
  return `<div class="chat-plan-viewer-overlay" data-chat-plan-viewer-overlay><section class="chat-plan-viewer is-standalone" role="dialog" aria-modal="true" aria-label="独立查看计划">${content}</section></div>`;
}

function renderDirectSocialChat(friend) {
  const currentUserId = state.currentUser?.id || '';
  const conversationId = `direct:${currentUserId}:${friend.id || ''}`;
  const directMessages = (state.networkConversationMessages || []).filter((message) => {
    const metadata = message.metadata || {};
    return !metadata.taskGroupId && !metadata.groupId;
  });
  const receiptById = new Map(directMessages.map((message) => [String(message.id || ''), message]));
  for (const group of state.collaborationOverview?.groups || []) {
    const metadata = group.metadata || {};
    const sourceConversationId = String(metadata.source_conversation_id || metadata.sourceConversationId || '').trim();
    if (sourceConversationId !== conversationId) continue;
    const groupId = String(group.id || '').trim();
    if (!groupId) continue;
    const id = `local-ubuddy-dispatch-${groupId}`;
    receiptById.set(id, {
      id,
      senderUserId: '',
      senderAgentId: 'secretary_agent',
      recipientUserId: currentUserId,
      content: `任务已派发${group.title ? `：${group.title}` : '，接收方正在处理。'}`,
      createdAt: group.createdAt || group.updatedAt || new Date().toISOString(),
      metadata: {
        type: 'direct_ubuddy_dispatch_receipt',
        localOnly: true,
        collaborationGroupId: groupId,
      },
    });
  }
  const messages = [...receiptById.values()].sort((left, right) => (
    String(left.createdAt || left.created_at || '').localeCompare(String(right.createdAt || right.created_at || ''))
    || String(left.id || '').localeCompare(String(right.id || ''))
  ));
  return `<div class="view chat-view with-messages direct-social-chat-view"><section class="chat-panel conversation-panel social-group-panel direct-social-panel">
    <header class="social-group-header direct-social-header"><div class="social-group-heading"><div class="social-group-title"><span class="social-group-avatar">${escapeHtml(socialInitials(friend))}</span><span><strong>${escapeHtml(socialFriendName(friend))}</strong><small>双人私聊 · 结构化 @ 指令由 uBuddy 直接派发</small></span></div><div class="social-group-actions direct-social-actions"><button class="voice-call-entry" type="button" data-voice-call-start="${escapeAttr(friend.id || '')}" title="${escapeAttr(translateUiText('发起语音通话', state.languageMode))}" aria-label="${escapeAttr(translateUiText('发起语音通话', state.languageMode))}">${iconSvg('phone')}<span>${escapeHtml(translateUiText('语音通话', state.languageMode))}</span></button><button class="voice-call-entry" type="button" data-video-room-start="${escapeAttr(state.activeAccountWorkspace?.id || '')}" title="多人通话" aria-label="多人通话">${iconSvg('video')}<span>多人通话</span></button>${renderSocialConversationCloseButton()}</div></div></header>
    <div class="message-list social-group-message-list" id="message-list" data-message-scroll-key="${escapeAttr(messageScrollKey())}">
      ${messages.length ? renderContinuousMessageSequence(messages, (message, continuity) => renderDirectSocialMessage(message, friend, currentUserId, continuity), socialMessageContinuityKey) : '<div class="social-group-empty"><strong>开始聊天</strong><span>这里始终是你和好友的双人私聊。需要委托时，在输入中 @我的uBuddy。</span></div>'}
      ${renderConversationPublishedTaskCards(conversationId, messages)}
    </div>
    ${renderComposer('social-direct')}
  </section>${renderVoiceCallOverlay(friend)}${renderChatAvatarProfilePopover()}${renderMessageReceiptPopover()}${renderMessageReactionPicker()}</div>`;
}

function renderVoiceCallOverlay(friend = {}) {
  const call = state.voiceCall || {};
  if (call.status === 'idle' || call.status === 'external' || String(call.peerId || '') !== String(friend.id || '')) return '';
  const connected = call.status === 'connected';
  const elapsed = connected && call.startedAt ? Math.max(0, Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000)) : 0;
  const duration = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  const name = socialFriendName(friend);
  if (call.status === 'incoming') return `<div class="voice-call-incoming-layer" role="dialog" aria-modal="false" aria-label="${escapeAttr(name)} ${escapeAttr(translateUiText('邀请你语音通话', state.languageMode))}"><section class="voice-call-incoming-card">${renderUserAvatar(friend, { className: 'voice-call-incoming-avatar', title: name, fallbackLabel: socialInitials(friend) })}<div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(translateUiText('邀请你进行语音通话', state.languageMode))}</span></div><button type="button" class="voice-call-incoming-decline" data-voice-call-end>${iconSvg('phoneOff')}<span>${escapeHtml(translateUiText('拒绝', state.languageMode))}</span></button><button type="button" class="voice-call-incoming-answer" data-voice-call-answer>${iconSvg('phone')}<span>${escapeHtml(translateUiText('接听', state.languageMode))}</span></button></section></div>`;
  const t = (value) => escapeHtml(translateUiText(value, state.languageMode));
  return `<div class="voice-call-layer ${call.minimized ? 'is-minimized' : ''} ${call.maximized ? 'is-maximized' : ''}" role="dialog" aria-modal="true" aria-label="${t('与')} ${escapeAttr(name)} ${t('的语音通话')}">
    <section class="voice-call-card ${connected ? 'is-connected' : 'is-dialing'}">
      <header class="voice-call-windowbar"><div class="voice-call-meeting-meta"><span class="voice-call-chip">${t('语音通话')}</span><strong>${escapeHtml(name)}</strong><span class="voice-call-divider"></span><span class="voice-call-duration">${connected ? duration : t('正在呼叫')}</span><span class="voice-call-live-signal" aria-hidden="true"><i></i><i></i><i></i></span></div><div class="voice-call-window-actions"><button type="button" data-voice-call-minimize title="${t('最小化到后台')}" aria-label="${t('最小化到后台')}">${iconSvg('minimize')}</button><button type="button" data-voice-call-maximize title="${t('最大化')}" aria-label="${t('最大化')}">${iconSvg('maximize')}</button><button type="button" data-voice-call-end title="${t('关闭通话')}" aria-label="${t('关闭通话')}">${iconSvg('x')}</button></div></header>
      <div class="voice-call-stage">
        <div class="voice-call-participant"><div class="voice-call-avatar-wrap">${renderUserAvatar(state.currentUser || {}, { className: 'voice-call-avatar voice-call-self-avatar', title: currentUserDisplayName(), fallbackLabel: userInitials(state.currentUser) })}<span class="voice-call-mic-state">${iconSvg(call.muted ? 'micOff' : 'mic')}</span></div><strong>${escapeHtml(currentUserDisplayName())}${t('（我）')}</strong><small>${call.muted ? t('已静音') : t('麦克风已开启')}</small></div>
        <div class="voice-call-connection"><span></span><small>${connected ? t('通话中') : t('等待接听')}</small><span></span></div>
        <div class="voice-call-participant"><div class="voice-call-avatar-wrap">${renderUserAvatar(friend, { className: 'voice-call-avatar', title: name, fallbackLabel: socialInitials(friend) })}</div><strong>${escapeHtml(name)}</strong><small>${connected ? t('已接通') : t('邀请对方加入语音通话')}</small></div>
      </div>
      <div class="voice-call-quick-actions"><button type="button" class="${call.sharing ? 'is-active' : ''}" data-voice-call-share>${iconSvg('share')}<span>${call.sharing ? t('停止共享') : t('共享')}</span></button><button type="button" data-voice-call-members>${iconSvg('users')}<span>${t('成员')}</span></button><button type="button" data-voice-call-more>${iconSvg('more')}<span>${t('更多')}</span></button></div>
      <div class="voice-call-controls"><button type="button" class="${call.muted ? 'is-active' : ''}" data-voice-call-mute aria-pressed="${call.muted ? 'true' : 'false'}">${iconSvg(call.muted ? 'micOff' : 'mic')}<span>${call.muted ? t('取消静音') : t('静音')}</span></button><button type="button" class="${call.speaker ? 'is-active' : ''}" data-voice-call-speaker aria-pressed="${call.speaker ? 'true' : 'false'}">${iconSvg('speaker')}<span>${t('扬声器')}</span></button><button type="button" class="voice-call-hangup" data-voice-call-end>${iconSvg('phone')}<span>${t('挂断')}</span></button></div>
      ${call.status === 'incoming' ? `<button type="button" class="voice-call-demo-answer" data-voice-call-answer>${t('接听')}</button>` : ''}
    </section>
  </div>`;
}
function renderDirectSocialMessage(message = {}, friend = {}, currentUserId = '', continuity = {}) {
  if (message.metadata?.type === 'voice_call_record') return renderVoiceCallRecordCard(message, { friend, currentUserId, continuity });
  const mine = (message.senderUserId || message.sender_user_id || '') === currentUserId;
  const agent = Boolean(message.senderAgentId || message.sender_agent_id);
  const localOwnBuddy = Boolean(message.metadata?.localOnly) && (message.senderAgentId || message.sender_agent_id) === 'secretary_agent';
  const ownBuddyLabel = translateUiText('我的 uBuddy', state.languageMode);
  const peerBuddyLabel = state.languageMode === 'en'
    ? `${socialFriendName(friend)}'s uBuddy`
    : `${socialFriendName(friend)} 的 uBuddy`;
  const actor = agent ? (mine || localOwnBuddy ? ownBuddyLabel : peerBuddyLabel) : (mine ? translateUiText('我', state.languageMode) : socialFriendName(friend));
  const attachments = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
  const forwardedMessage = message.metadata?.forwardedMessage || null;
  const withdrawn = message.metadata?.withdrawn === true;
  if (withdrawn) {
    return `<div class="withdrawn-direct-event" data-message-id="${escapeAttr(message.id || '')}" role="status"><span>${mine ? '你撤回了一条消息' : '对方撤回了一条消息'}</span>${mine ? `<button type="button" data-withdrawn-message-edit="${escapeAttr(message.id || '')}">重新编辑</button>` : ''}</div>`;
  }
  const avatar = renderSocialMessageAvatar({ mine: mine || localOwnBuddy, agent, friend, profileContext: 'direct' });
  const avatarSlot = renderMessageAvatarSlot(avatar, continuity.consecutive);
  const dispatchGroupId = message.metadata?.type === 'direct_ubuddy_dispatch_receipt'
    ? String(message.metadata?.collaborationGroupId || '').trim()
    : '';
  const dispatchAction = dispatchGroupId
    ? `<div class="message-actions"><button type="button" data-collaboration-group="${escapeAttr(dispatchGroupId)}">打开工作群</button></div>`
    : '';
  const delegationId = String(message.metadata?.delegationId || message.metadata?.delegation_id || '').trim();
  const delegationAction = String(message.metadata?.action || '').trim();
  const delegation = delegationId
    ? (state.agentDelegations || []).find((item) => String(item.id || '') === delegationId) || null
    : null;
  const structuredDelegation = agent && message.metadata?.type === 'agent_delegation'
    && ['assigned', 'publish', 'update_requirements'].includes(delegationAction)
    ? renderDirectDelegationSummary(message, delegation)
    : '';
  const workspaceAction = delegationId && ['assigned', 'publish', 'submit'].includes(delegationAction)
    ? delegationAction === 'submit'
      ? `<div class="direct-delegation-message-actions"><button type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_RESULT}" data-task-workspace-kind="delegation" data-task-workspace-id="${escapeAttr(delegationId)}">${iconSvg('folder')}<span>${escapeHtml(translateUiText('查看交付', state.languageMode))}</span></button></div>`
      : `<div class="direct-delegation-message-actions"><button type="button" data-network-delegation="${escapeAttr(delegationId)}">${iconSvg('folder')}<span>${escapeHtml(translateUiText('前往任务工作区', state.languageMode))}</span></button></div>`
    : '';
  const messageTone = mine && !agent ? 'user' : 'assistant';
  const receipt = renderMessageReceiptButton(message, { mine, directPeer: friend });
  const reactions = renderMessageReactions(message, { kind: 'direct', currentUserId });
  const directContent = message.metadata?.favoriteEmoji === true ? '' : message.content || '';
  const attachmentContent = message.metadata?.favoriteEmoji === true ? renderFavoriteEmojiAttachments(attachments) : renderMessageAttachmentCards(attachments);
  const emojiOnly = isEmojiOnlyText(directContent);
  const bubbleContent = `${attachmentContent}${forwardedMessage ? renderForwardedMessage(forwardedMessage, directContent) : structuredDelegation || (String(directContent).trim() ? `<div class="message-body${emojiOnly ? ' emoji-only-body' : ''}">${emojiOnly ? `<span class="sent-emoji-glyph">${escapeHtml(String(directContent).trim())}</span>` : formatText(directContent)}</div>` : '')}${renderMessageQuote(message.metadata?.quote)}`;
  return `<article class="message ${messageTone} social-group-message direct-social-message has-chat-avatar ${message.metadata?.favoriteEmoji === true ? 'is-favorite-emoji-message' : ''} ${emojiOnly ? 'is-emoji-only-message' : ''} ${continuousMessageClassNames(continuity)} ${agent ? 'is-agent-message' : ''}" data-message-id="${escapeAttr(message.id || '')}">${mine && !agent ? '' : avatarSlot}<div class="message-shell">
    ${continuity.consecutive ? '' : `<div class="social-message-actor"><span>${escapeHtml(actor)}</span><time>${escapeHtml(formatMessageTime(message.createdAt || message.created_at))}</time></div>`}
    <div class="message-bubble">${renderMessageBubbleReceiptAnchor(bubbleContent, receipt)}${reactions}</div>${workspaceAction}${dispatchAction}${renderMessageFooter(message, '复制消息', { reactionKind: 'direct' })}
  </div>${mine && !agent ? avatarSlot : ''}</article>`;
}

function renderVoiceCallRecordCard(message = {}, { group = false, friend = {}, currentUserId = '', continuity = {} } = {}) {
  const metadata = message.metadata || {};
  const status = String(metadata.status || 'ended');
  const english = state.languageMode === 'en';
  const labels = english
    ? { ended: 'Voice call', missed: 'Missed voice call', rejected: 'Declined voice call', cancelled: 'Cancelled voice call', failed: 'Failed voice call', duration: 'Duration', participants: 'participants' }
    : { ended: '语音通话', missed: '未接听的语音通话', rejected: '已拒绝的语音通话', cancelled: '已取消的语音通话', failed: '连接失败的语音通话', duration: '通话时长', participants: '人' };
  const title = labels[status] || labels.ended;
  const secondsValue = Math.max(0, Number(metadata.durationSeconds) || 0);
  const duration = `${String(Math.floor(secondsValue / 60)).padStart(2, '0')}:${String(secondsValue % 60).padStart(2, '0')}`;
  const mine = String(message.senderUserId || message.sender_user_id || '') === String(currentUserId || '');
  const actor = group ? (mine ? (english ? 'You' : '我') : (message.sender?.displayName || message.sender?.username || (english ? 'Participant' : '成员'))) : (mine ? (english ? 'You' : '我') : socialFriendName(friend));
  const icon = status === 'missed' || status === 'rejected' || status === 'failed' ? 'phoneOff' : 'phone';
  const detail = status === 'ended' ? `${labels.duration} ${duration}` : status === 'missed' ? (english ? 'No answer' : '未接听') : '';
  return `<article class="voice-call-record-card status-${escapeAttr(status)} ${mine ? 'is-mine' : ''}" data-message-id="${escapeAttr(message.id || '')}"><div class="voice-call-record-icon">${iconSvg(icon)}</div><div class="voice-call-record-body"><strong>${escapeHtml(actor)}${english ? ' · ' : ' 发起了'}${escapeHtml(title)}</strong><span>${escapeHtml(detail || (metadata.participantCount ? `${metadata.participantCount} ${labels.participants}` : ''))}</span></div><time>${escapeHtml(formatMessageTime(message.createdAt || message.created_at))}</time></article>`;
}

function renderDirectDelegationSummary(message = {}, delegation = null) {
  const metadata = message.metadata || {};
  const intake = metadata.taskSummary && typeof metadata.taskSummary === 'object'
    ? metadata.taskSummary
    : delegation?.metadata?.taskSummary && typeof delegation.metadata.taskSummary === 'object'
      ? delegation.metadata.taskSummary
      : parseDirectDelegationText(message.content || '');
  const objective = String(intake.objective || delegation?.title || '').trim();
  if (!objective) return '';
  const assignedAgentIds = [...new Set([
    ...(Array.isArray(metadata.assignedAgentIds) ? metadata.assignedAgentIds : []),
    ...(Array.isArray(delegation?.metadata?.assignedAgentIds) ? delegation.metadata.assignedAgentIds : []),
  ].map(String).filter(Boolean))];
  const assignedAgentNames = assignedAgentIds.map((agentId) => (
    state.org?.agents?.find((agent) => agent.id === agentId)?.name || agentId
  ));
  const agentText = assignedAgentNames.length
    ? assignedAgentNames.join('、')
    : translateUiText('接收方 uBuddy（Agent 待分配）', state.languageMode);
  const rows = [
    ['任务目标', [objective]],
    ['交付物', normalizeDelegationSummaryItems(intake.deliverables)],
    ['验收标准', normalizeDelegationSummaryItems(intake.acceptanceCriteria)],
    ['约束', normalizeDelegationSummaryItems(intake.constraints)],
    ['截止时间', intake.deadline ? [String(intake.deadline)] : []],
    ['执行 Agent', [agentText]],
  ].filter(([, values]) => values.length);
  return `<div class="message-body direct-delegation-summary"><ul>${rows.map(([label, values]) => {
    const separator = state.languageMode === 'en' ? '; ' : '；';
    const labelSuffix = state.languageMode === 'en' ? ': ' : '：';
    return `<li><strong>${escapeHtml(translateUiText(label, state.languageMode))}${labelSuffix}</strong>${values.map(renderDelegationSummaryValue).join(separator)}</li>`;
  }).join('')}</ul></div>`;
}

function renderDelegationSummaryValue(value = '') {
  return escapeHtml(value).replace(
    /\b(Microsoft\s+Word|Word|DOCX?|PDF|PowerPoint|PPTX?|Excel|XLSX?|CSV|Markdown|MD|JSON|HTML|TXT|PNG|JPE?G|WEBP)\b/gi,
    '<strong>$1</strong>',
  );
}

function parseDirectDelegationText(content = '') {
  const source = String(content || '').replace(/\r/g, '');
  const labels = ['任务目标', '交付物', '验收标准', '约束', '截止时间', '隐私范围', '风险等级'];
  const pattern = new RegExp(`(?:^|\\n|\\s)(?:${labels.join('|')})：`, 'g');
  const matches = [...source.matchAll(pattern)];
  const fields = {};
  matches.forEach((match, index) => {
    const label = match[0].trim().slice(0, -1);
    const start = Number(match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? Number(matches[index + 1].index || source.length) : source.length;
    fields[label] = source.slice(start, end).trim();
  });
  return {
    objective: fields['任务目标'] || '',
    deliverables: splitDelegationSummaryField(fields['交付物']),
    acceptanceCriteria: splitDelegationSummaryField(fields['验收标准']),
    constraints: splitDelegationSummaryField(fields['约束']),
    deadline: fields['截止时间'] || '',
  };
}

function splitDelegationSummaryField(value = '') {
  return String(value || '').split(/[；;]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeDelegationSummaryItems(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return splitDelegationSummaryField(value);
}

function renderCollaborationGroupChat() {
  const detail = state.collaborationGroupDetail || {};
  const group = detail.group || {};
  const currentUserId = state.currentUser?.id || '';
  const owner = group.ownerUserId === currentUserId;
  const members = (detail.members || []).filter((item) => item.status === 'active');
  const plannedParticipants = Array.isArray(detail.plannedParticipants) ? detail.plannedParticipants : [];
  const pendingParticipants = plannedParticipants.filter((item) => item.status === 'awaiting_presence');
  const virtualParticipantMap = new Map();
  for (const participant of Array.isArray(group.metadata?.virtualParticipants) ? group.metadata.virtualParticipants : []) {
    const agentInstanceId = String(participant.agentInstanceId || participant.agent_instance_id || '').trim();
    const agentFamilyId = String(participant.agentFamilyId || participant.agentId || '').trim();
    const key = agentInstanceId ? `instance:${agentInstanceId}` : agentFamilyId ? `family:${agentFamilyId}` : `id:${participant.id || virtualParticipantMap.size}`;
    if (!virtualParticipantMap.has(key)) virtualParticipantMap.set(key, { ...participant, agentInstanceId, agentFamilyId });
  }
  const virtualParticipants = numberAgentInstanceLabels([...virtualParticipantMap.values()], {
    familyId: (item) => item.agentFamilyId,
    baseName: (item) => item.displayName || item.agentFamilyId || 'Agent',
  });
  const tasks = [...(detail.tasks || [])].sort((left, right) => {
    const active = (task) => ['running', 'working', 'accepted', 'revision_requested', 'blocked'].includes(String(task.status || '')) ? 1 : 0;
    return active(right) - active(left) || String(right.updatedAt || right.updated_at || '').localeCompare(String(left.updatedAt || left.updated_at || ''));
  });
  const activeTaskCount = tasks.filter((task) => ['running', 'working', 'accepted', 'revision_requested', 'blocked'].includes(String(task.status || ''))).length;
  const routingAnchorPresent = Boolean(state.collaborationRoutingConfirmation?.sourceMessageId)
    && (detail.messages || []).some((message) => message.id === state.collaborationRoutingConfirmation.sourceMessageId);
  const workspace = state.collaborationGroupWorkspace || detail.workspace || {};
  const localHistoryOnly = detail.localHistoryOnly === true
    || group.localHistoryOnly === true
    || group.metadata?.localHistoryOnly === true
    || workspace.localHistoryOnly === true;
  const groupReadOnly = group.status === 'closed' || localHistoryOnly;
  const workspaceStatus = state.collaborationGroupWorkspaceBusy
    ? '同步中'
    : workspace.syncStatus === 'conflict'
      ? '有冲突'
      : workspace.syncStatus === 'error'
        ? '同步失败'
        : groupReadOnly || workspace.readOnly
          ? '只读'
          : workspace.revision ? `版本 ${workspace.revision}` : '共享';
  const groupId = String(group.id || state.collaborationGroupId || '');
  const mobilePane = state.collaborationMobilePaneByGroupId?.[groupId] === 'progress' ? 'progress' : 'group';
  const detailsOpen = state.collaborationPaneByGroupId?.[groupId] === 'progress';
  const searchResults = collaborationSearchResults(detail, tasks);
  const reviewItems = collaborationReviewItems(tasks);
  const subtitle = collaborationGroupSubtitle(group, tasks, members.length, activeTaskCount, pendingParticipants.length);
  return `<div class="view chat-view with-messages social-group-chat-view collaboration-group-chat-view"><section class="chat-panel conversation-panel social-group-panel collaboration-workbench">
    <header class="social-group-header collaboration-workbench-header"><div class="social-group-heading"><div class="social-group-title"><span class="social-group-avatar">${iconSvg('users')}</span><span><strong>${escapeHtml(group.title || 'uBuddy 工作群')}</strong><small>${escapeHtml(subtitle)}</small></span></div>
    <div class="social-group-actions collaboration-header-actions">
      <button class="collaboration-icon-button" type="button" data-collaboration-search-toggle title="搜索群聊与协作进度" aria-label="搜索群聊与协作进度" aria-expanded="${state.collaborationSearchOpen ? 'true' : 'false'}">${iconSvg('search')}</button>
      <div class="collaboration-members-menu">
        <button class="collaboration-icon-button" type="button" data-collaboration-members-toggle title="查看 ${members.length} 位已入群成员${pendingParticipants.length ? `，${pendingParticipants.length} 位待上线补派` : ''}" aria-label="查看工作群参与人" aria-haspopup="dialog" aria-expanded="${state.collaborationMembersOpen ? 'true' : 'false'}" aria-controls="collaboration-member-popover">${iconSvg('users')}<span>${members.length}${pendingParticipants.length ? `+${pendingParticipants.length}` : ''}</span></button>
        ${state.collaborationMembersOpen ? renderCollaborationMemberPopover({ members, plannedParticipants, virtualParticipants, currentUserId, owner, groupReadOnly, groupOwnerUserId: group.ownerUserId }) : ''}
      </div>
      <details class="collaboration-more-menu"><summary class="collaboration-icon-button" title="更多操作" aria-label="更多操作">${iconSvg('more')}</summary><div role="menu">
        <button type="button" role="menuitem" data-collaboration-group-workspace ${state.collaborationGroupWorkspaceBusy || localHistoryOnly ? 'disabled' : ''}>${iconSvg('folder')}<span>共享工作区 · ${escapeHtml(workspaceStatus)}</span></button>
        ${owner && !groupReadOnly ? `<button type="button" role="menuitem" data-collaboration-group-rename>${iconSvg('edit')}<span>修改群名</span></button><button type="button" role="menuitem" data-collaboration-group-add-member>${iconSvg('userPlus')}<span>添加成员</span></button><button class="is-danger" type="button" role="menuitem" data-collaboration-group-close>${iconSvg('stop')}<span>停止全部并归档</span></button>` : ''}
      </div></details>
      ${renderSocialConversationCloseButton()}
    </div></div>
    ${renderCollaborationSharedGoal(group.metadata?.taskSummary)}
    ${state.collaborationSearchOpen ? renderCollaborationSearch(searchResults) : ''}
    ${owner && !localHistoryOnly ? renderUBuddySelectionCard(group.metadata?.uBuddySelection) : ''}
    </header>
    ${owner && !groupReadOnly ? renderCollaborationAddMemberPanel(members) : ''}
    <nav class="collaboration-mobile-tabs" aria-label="工作群视图">
      <button type="button" class="${mobilePane === 'group' ? 'active' : ''}" data-collaboration-mobile-pane="group" aria-pressed="${mobilePane === 'group'}">群聊</button>
      <button type="button" class="${mobilePane === 'progress' ? 'active' : ''}" data-collaboration-mobile-pane="progress" aria-pressed="${mobilePane === 'progress'}">协作进度</button>
    </nav>
    <div class="collaboration-workbench-panes is-mobile-${escapeAttr(mobilePane)}">
      <section class="collaboration-public-pane" aria-label="协作群聊">
        <div class="message-list social-group-message-list" id="message-list" data-message-scroll-key="${escapeAttr(messageScrollKey())}">${renderContinuousMessageSequence(detail.messages || [], (message, continuity) => renderCollaborationGroupMessage(message, currentUserId, tasks, continuity), collaborationMessageContinuityKey) || '<div class="social-group-empty"><strong>工作群已创建</strong><span>在这里同步需求、进度、提交结果和修改意见。</span></div>'}</div>
        ${renderCollaborationDetailsBar(tasks, reviewItems, detailsOpen)}
        ${localHistoryOnly
          ? '<div class="social-group-ended"><strong>本机历史记录</strong><span>该工作群当前不在云端列表中，只能查看此设备保留的历史内容。</span></div>'
          : group.status === 'closed'
            ? '<div class="social-group-ended"><strong>工作群已解散</strong><span>群聊与任务工作区现为只读。</span></div>'
            : `${routingAnchorPresent ? '' : renderCollaborationRoutingConfirmation(tasks)}${renderComposer('collaboration-group')}`}
      </section>
      ${detailsOpen ? '<button class="collaboration-details-backdrop" type="button" data-collaboration-details-close aria-label="收起任务详情"></button>' : ''}
      <aside class="collaboration-side-pane ${detailsOpen ? 'is-open' : ''}" aria-label="任务详情" aria-hidden="${detailsOpen ? 'false' : 'true'}">
        <div class="collaboration-side-content is-progress">${renderCollaborationProgressPane(tasks, members, pendingParticipants)}</div>
      </aside>
    </div>
  </section>${renderChatAvatarProfilePopover()}</div>`;
}

function renderCollaborationMemberPopover({ members = [], plannedParticipants = [], virtualParticipants = [], currentUserId = '', owner = false, groupReadOnly = false, groupOwnerUserId = '' } = {}) {
  const activeMemberIds = new Set(members.map((item) => String(item.userId || '')));
  const pendingParticipants = plannedParticipants.filter((item) => !activeMemberIds.has(String(item.userId || '')));
  const english = state.languageMode === 'en';
  const countLabel = english
    ? `${members.length} member${members.length === 1 ? '' : 's'}${pendingParticipants.length ? ` · ${pendingParticipants.length} pending` : ''}${virtualParticipants.length ? ` · ${virtualParticipants.length} Agent${virtualParticipants.length === 1 ? '' : 's'}` : ''}`
    : `${members.length} 位成员${pendingParticipants.length ? ` · ${pendingParticipants.length} 位待上线` : ''}${virtualParticipants.length ? ` · ${virtualParticipants.length} 个 Agent` : ''}`;
  return `<section class="collaboration-member-popover" id="collaboration-member-popover" role="dialog" aria-label="工作群成员">
    <header><span><strong>工作群成员</strong><small data-no-localize>${countLabel}</small></span><button type="button" data-collaboration-members-close title="关闭" aria-label="关闭">${iconSvg('x')}</button></header>
    <div class="collaboration-member-list">
      ${members.map((item) => {
        const user = item.user || {};
        const name = item.userId === currentUserId ? '我' : socialFriendName(user);
        const isOwner = item.userId === groupOwnerUserId || item.role === 'owner';
        const buddyLabel = item.userId === currentUserId ? (english ? 'My uBuddy' : '我的 uBuddy') : english ? `${socialFriendName(user)}'s uBuddy` : `${socialFriendName(user)}的 uBuddy`;
        const removable = owner && item.userId !== currentUserId && !groupReadOnly;
        return `<article class="collaboration-member-row">
          ${renderUserAvatar(user, { className: 'collaboration-member-avatar', title: name, fallbackLabel: item.userId === currentUserId ? userInitials(state.currentUser) : socialInitials(user) })}
          <span><strong data-no-localize>${escapeHtml(name)}</strong><small data-no-localize>${escapeHtml(buddyLabel)}</small></span>
          <em>${isOwner ? '创建者' : '成员'}</em>
          ${removable ? `<button type="button" data-collaboration-group-remove-member="${escapeAttr(item.userId)}" title="${english ? 'Remove member' : '移除成员'}" aria-label="${escapeAttr(english ? `Remove member ${name}` : `移除成员 ${name}`)}">${iconSvg('x')}</button>` : ''}
        </article>`;
      }).join('')}
      ${pendingParticipants.map((item) => {
        const user = item.user || {};
        const name = socialFriendName(user) || item.userId || '计划参与人';
        return `<article class="collaboration-member-row is-pending">
          ${renderUserAvatar(user, { className: 'collaboration-member-avatar', title: name, fallbackLabel: socialInitials(user) })}
          <span><strong data-no-localize>${escapeHtml(name)}</strong><small>任务已保留，成员上线后自动补派</small></span>
          <em>待上线补派</em>
        </article>`;
      }).join('')}
      ${virtualParticipants.map((item) => `<article class="collaboration-member-row is-agent">
        <span class="collaboration-member-agent-avatar">${iconSvg('spark')}</span>
        <span><strong data-no-localize>${escapeHtml(item.displayName || item.agentFamilyId || 'Agent')}</strong><small>${english ? 'Local Agent' : '本地 Agent'} · ${escapeHtml(employeeTaskNodeStatusLabel(item.status || 'queued'))}</small></span>
        <em>Agent</em>
      </article>`).join('')}
    </div>
  </section>`;
}

function collaborationGroupSubtitle(group = {}, tasks = [], memberCount = 0, activeTaskCount = 0, pendingCount = 0) {
  if (pendingCount) return `${memberCount} 位已入群 · ${pendingCount} 位待上线补派 · ${tasks.length} 个已派任务`;
  if (normalizePublicTaskSummary(group.metadata?.taskSummary)) {
    return `${memberCount} 位成员 · ${tasks.length} 个任务${activeTaskCount ? ` · ${activeTaskCount} 进行中` : ''} · ${group.status === 'closed' ? '已结束' : '实时协作'}`;
  }
  const source = tasks.find((task) => String(task.instruction || task.title || '').trim()) || null;
  const goal = clipInline(String(source?.instruction || source?.title || '').trim(), 110);
  if (goal) return goal;
  return `${memberCount} 位成员 · ${tasks.length} 个任务${activeTaskCount ? ` · ${activeTaskCount} 进行中` : ''} · ${group.status === 'closed' ? '已结束' : '实时协作'}`;
}

function renderCollaborationSharedGoal(value = null) {
  const summary = normalizePublicTaskSummary(value);
  if (!summary) return '';
  const language = state.languageMode;
  const rows = [
    [translateUiText('任务目标', language), [summary.objective]],
    [translateUiText('交付物', language), summary.deliverables],
    [translateUiText('验收标准', language), summary.acceptanceCriteria],
    [translateUiText('约束', language), summary.constraints],
    [translateUiText('截止时间', language), summary.deadline ? [summary.deadline] : []],
  ].filter(([, items]) => items.length);
  return `<details class="collaboration-shared-goal">
    <summary title="${escapeAttr(summary.objective)}"><span class="collaboration-shared-goal-icon">${iconSvg('goal')}</span><span><small>${escapeHtml(translateUiText('最终目标', language))}</small><strong>${escapeHtml(summary.objective)}</strong></span><i>${iconSvg('chevronDown')}</i></summary>
    <dl>${rows.map(([label, items]) => `<div><dt>${escapeHtml(label)}</dt><dd>${items.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</dd></div>`).join('')}</dl>
  </details>`;
}

function collaborationTaskProgress(task = {}) {
  return state.networkDelegationProgressById?.[task.id] || task.metadata?.executionProgress || {};
}

function collaborationProgressTone(task = {}, progress = {}) {
  const status = String(task.status || 'pending');
  if (['blocked', 'failed'].includes(status) || progress.blocker) return 'blocked';
  if (['submitted', 'draft_ready', 'action_required'].includes(status)) return 'review';
  if (['result_accepted', 'completed', 'closed'].includes(status)) return 'completed';
  if (['working', 'running', 'accepted', 'revision_requested'].includes(status)) return 'running';
  return 'waiting';
}

function collaborationProgressParticipants(tasks = [], members = []) {
  const memberById = new Map(members.map((member) => [String(member.userId || member.user?.id || ''), member]));
  const groups = new Map();
  for (const task of tasks) {
    const recipientId = String(task.recipientUserId || task.recipient_user_id || task.ownerUserId || 'unassigned');
    const member = memberById.get(recipientId) || {};
    const name = recipientId === String(state.currentUser?.id || '') ? '我的 uBuddy' : `${socialFriendName(task.recipient || member.user || {}) || '成员'}的 uBuddy`;
    const item = groups.get(recipientId) || { id: recipientId, name, member, tasks: [] };
    item.tasks.push(task);
    groups.set(recipientId, item);
  }
  const rank = { review: 0, blocked: 1, running: 2, waiting: 3, completed: 4 };
  return [...groups.values()].map((item) => {
    const tones = item.tasks.map((task) => collaborationProgressTone(task, collaborationTaskProgress(task)));
    item.tone = tones.sort((left, right) => rank[left] - rank[right])[0] || 'waiting';
    item.updatedAt = item.tasks.map((task) => task.updatedAt || task.updated_at || task.createdAt || '').sort().at(-1) || '';
    return item;
  }).sort((left, right) => rank[left.tone] - rank[right.tone] || String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function renderCollaborationProgressPane(tasks = [], members = [], pendingParticipants = []) {
  const participants = collaborationProgressParticipants(tasks, members);
  const counts = participants.reduce((result, item) => ({ ...result, [item.tone]: Number(result[item.tone] || 0) + 1 }), {});
  const waitingCount = Number(counts.waiting || 0) + pendingParticipants.length;
  if (!participants.length && !pendingParticipants.length) return `<div class="collaboration-progress-empty"><span class="collaboration-progress-empty-icon">${iconSvg('tasks')}</span><strong>等待任务发布</strong><p>任务开始后，这里会按参与者汇总当前状态。</p></div>`;
  return `<section class="collaboration-progress-pane"><header><span><strong>任务详情</strong><small>每位参与者只显示一张最新状态摘要</small></span><button type="button" data-collaboration-details-close title="收起任务详情" aria-label="收起任务详情">${iconSvg('x')}</button><div class="collaboration-progress-summary" aria-label="协作状态统计"><b>${Number(counts.running || 0)} 进行中</b><b>${waitingCount} 等待中</b><b>${Number(counts.review || 0)} 待处理</b><b>${Number(counts.blocked || 0)} 受阻</b><b>${Number(counts.completed || 0)} 已完成</b></div></header><div class="collaboration-progress-timeline">${participants.map(renderCollaborationProgressParticipant).join('')}${pendingParticipants.map(renderCollaborationPendingParticipant).join('')}</div></section>`;
}

function renderCollaborationPendingParticipant(item = {}) {
  const userId = String(item.userId || '');
  const name = `${socialFriendName(item.user || {}) || userId || '协作成员'}的 uBuddy`;
  return `<article class="collaboration-progress-participant is-waiting" data-ubuddy-owner-user-id="${escapeAttr(userId)}"><i class="collaboration-progress-node"></i><header><span class="collaboration-progress-avatar" title="${escapeAttr(name)}">${iconSvg('spark')}</span><span><strong>${escapeHtml(name)}</strong><small>等待成员上线</small></span><em>等待中</em></header><div class="collaboration-progress-pending">分工已保留，成员上线后再接收任务。</div></article>`;
}

function collaborationProgressEvents(tasks = [], members = []) {
  const memberById = new Map(members.map((member) => [String(member.userId || member.user?.id || ''), member]));
  const events = [];
  const push = (task, event = {}) => {
    const recipientId = String(task.recipientUserId || task.recipient_user_id || task.ownerUserId || '');
    const member = memberById.get(recipientId) || {};
    const actor = recipientId === String(state.currentUser?.id || '')
      ? '我的 uBuddy'
      : `${socialFriendName(task.recipient || member.user || {}) || '协作成员'}的 uBuddy`;
    const occurredAt = event.occurredAt || task.updatedAt || task.updated_at || task.createdAt || task.created_at || '';
    events.push({
      ...event,
      task,
      ownerUserId: event.ownerUserId || recipientId,
      actor: event.actor || actor,
      occurredAt: event.occurredAt || occurredAt,
      sequence: Number(event.sequence || 0),
    });
  };
  for (const task of tasks) {
    const progress = collaborationTaskProgress(task);
    const milestones = Array.isArray(progress.milestones) ? progress.milestones : [];
    const milestoneKeys = new Set();
    for (const milestone of milestones) {
      const key = String(milestone.key || `${milestone.title}:${milestone.status}`);
      milestoneKeys.add(key);
      push(task, {
        id: `milestone:${task.id}:${key}`,
        status: milestone.status || 'running',
        eventType: milestone.eventType || 'milestone',
        title: milestone.title || task.title || '任务进展',
        summary: milestone.detail || milestone.title || '任务状态已更新',
        actor: milestone.agentName || undefined,
        occurredAt: milestone.occurredAt || progress.updatedAt,
        sequence: milestone.sequence,
      });
    }
    for (const node of Array.isArray(progress.nodes) ? progress.nodes : []) {
      const key = `${node.id || node.title}:${node.status || 'updated'}`;
      if (milestoneKeys.has(key)) continue;
      const occurredAt = node.completedAt || node.updatedAt || node.startedAt;
      if (!occurredAt && milestones.length) continue;
      push(task, {
        id: `node:${task.id}:${key}`,
        status: node.status || 'pending', eventType: `node_${node.status || 'updated'}`,
        title: node.title || task.title || '任务节点',
        summary: node.summary || collaborationTimelineStatusCopy(node.status, node.title),
        actor: node.agentName || undefined, occurredAt: occurredAt || progress.updatedAt,
      });
    }
    if (progress.blocker && !events.some((event) => event.task?.id === task.id && ['blocked', 'failed'].includes(String(event.status)))) {
      push(task, {
        id: `blocker:${task.id}:${progress.sequence || 0}`, status: 'blocked', eventType: 'blocked',
        title: '任务遇到阻塞', summary: progress.blocker.summary || '当前任务暂时无法继续。',
        nextStep: progress.blocker.suggestedNextStep || '', occurredAt: progress.updatedAt,
      });
    }
    const lifecycleStatuses = new Set(['assigned', 'accepted', 'working', 'running', 'draft_ready', 'submitted', 'revision_requested', 'result_accepted', 'completed', 'closed', 'failed']);
    const taskStatus = String(task.status || '');
    const hasLifecycleEvent = events.some((event) => event.task?.id === task.id && String(event.status || '') === taskStatus);
    if (lifecycleStatuses.has(taskStatus) && !hasLifecycleEvent) {
      const lifecycleTitle = {
        assigned: '任务已派发', accepted: '任务已接收', working: '任务开始执行', running: '任务正在执行',
        draft_ready: '结果草稿已完成', submitted: '结果已提交', revision_requested: '收到修改要求',
        result_accepted: '结果已验收', completed: '任务已完成', closed: '任务已关闭', failed: '任务执行失败',
      }[taskStatus] || '任务状态更新';
      push(task, {
        id: `lifecycle:${task.id}:${taskStatus}:${progress.sequence || task.updatedAt || task.updated_at || ''}`,
        status: taskStatus, eventType: `task_${taskStatus}`, title: lifecycleTitle,
        summary: progress.message || collaborationTimelineStatusCopy(taskStatus, task.title),
        occurredAt: progress.updatedAt || task.updatedAt || task.updated_at || task.createdAt || task.created_at,
        sequence: Number(progress.sequence || 0),
      });
    }
    if (!milestones.length && !(progress.nodes || []).length && !events.some((event) => event.task?.id === task.id)) {
      push(task, {
        id: `task:${task.id}:${task.status || 'assigned'}`, status: task.status || 'assigned', eventType: 'task_status',
        title: task.title || '协作任务', summary: progress.message || collaborationTimelineStatusCopy(task.status, task.title),
        occurredAt: progress.updatedAt || task.updatedAt || task.updated_at || task.createdAt || task.created_at,
      });
    }
  }
  return events
    .filter((event) => event.occurredAt || event.summary)
    .sort((left, right) => (Date.parse(left.occurredAt || 0) || 0) - (Date.parse(right.occurredAt || 0) || 0)
      || left.sequence - right.sequence || String(left.id).localeCompare(String(right.id)));
}

function collaborationTimelineStatusCopy(status = '', title = '') {
  const label = title || '当前工作';
  if (['completed', 'done', 'result_accepted'].includes(String(status))) return `${label}已完成`;
  if (['blocked', 'failed'].includes(String(status))) return `${label}暂时受阻`;
  if (['waiting', 'retry_wait'].includes(String(status))) return `${label}正在等待所需输入`;
  if (['submitted', 'draft_ready'].includes(String(status))) return `${label}已提交并等待审核`;
  return `正在推进${label}`;
}

function renderCollaborationProgressEvent(event = {}) {
  const status = String(event.status || 'running');
  const resolvedTone = ['blocked', 'failed'].includes(status) ? 'blocked'
    : ['completed', 'done', 'result_accepted', 'closed'].includes(status) ? 'completed'
      : ['submitted', 'draft_ready', 'revision_requested'].includes(status) ? 'review'
        : ['assigned', 'pending', 'queued', 'waiting', 'retry_wait'].includes(status) ? 'waiting' : 'running';
  const label = { blocked: '受阻', completed: '已完成', review: '待确认', running: '进行中', waiting: '等待中' }[resolvedTone] || '进行中';
  const next = event.nextStep || (resolvedTone === 'running' ? '完成当前工作后同步下一项关键进展' : '');
  const ownerUserId = String(event.ownerUserId || event.task?.recipientUserId || event.task?.recipient_user_id || event.task?.ownerUserId || '').trim();
  const ownerTone = uBuddyOwnerTone(ownerUserId);
  const avatarTitle = event.actor || 'uBuddy';
  return `<article class="collaboration-progress-event collaboration-progress-task is-${escapeAttr(resolvedTone)} owner-tone-${ownerTone}" data-collaboration-progress-task="${escapeAttr(event.task?.id || '')}" data-progress-event-id="${escapeAttr(event.id || '')}" data-ubuddy-owner-user-id="${escapeAttr(ownerUserId)}">
    <i class="collaboration-progress-node"></i>
    <header><span class="collaboration-progress-avatar owner-tone-${ownerTone}" title="${escapeAttr(avatarTitle)}" aria-label="${escapeAttr(`${avatarTitle}的头像`)}">${iconSvg('spark')}</span><span><strong>${escapeHtml(avatarTitle)}</strong><small>${escapeHtml(formatMessageTime(event.occurredAt))}</small></span><em>${escapeHtml(label)}</em></header>
    <div class="collaboration-progress-event-body"><small>${escapeHtml(event.task?.title || '协作任务')}</small><strong>${escapeHtml(event.title || '任务进展')}</strong><p>${escapeHtml(event.summary || '')}</p></div>
    <footer>${next ? `<span><strong>下一步</strong>${escapeHtml(next)}</span>` : '<span></span>'}<button type="button" ${taskCardActionAttributes(TASK_CARD_ACTIONS.OPEN_WORKSPACE, event.task || {})}>查看任务</button></footer>
  </article>`;
}

function renderCollaborationProgressParticipant(participant = {}) {
  const toneLabel = { review: '待处理', blocked: '受阻', running: '进行中', waiting: '等待中', completed: '已完成' }[participant.tone] || '等待中';
  const ownerTone = uBuddyOwnerTone(participant.id);
  return `<article class="collaboration-progress-participant is-${escapeAttr(participant.tone)} owner-tone-${ownerTone}" data-ubuddy-owner-user-id="${escapeAttr(participant.id || '')}"><i class="collaboration-progress-node"></i><header><span class="collaboration-progress-avatar owner-tone-${ownerTone}" title="${escapeAttr(participant.name)}" aria-label="${escapeAttr(`${participant.name}的头像`)}">${iconSvg('spark')}</span><span><strong>${escapeHtml(participant.name)}</strong><small>${participant.tasks.length > 1 ? `${participant.tasks.length} 项任务 · ` : ''}${escapeHtml(formatMessageTime(participant.updatedAt))}</small></span><em>${escapeHtml(toneLabel)}</em></header><div>${participant.tasks.map(renderCollaborationProgressTask).join('')}</div></article>`;
}

function renderCollaborationProgressTask(task = {}) {
  const progress = collaborationTaskProgress(task);
  const nodes = Array.isArray(progress.nodes) ? progress.nodes : [];
  const running = nodes.find((node) => ['running', 'working', 'accepted'].includes(String(node.status || '')));
  const completed = nodes.filter((node) => ['completed', 'done', 'result_accepted'].includes(String(node.status || ''))).slice(-3);
  const current = progress.blocker?.summary || running?.title || progress.currentStep?.title || progress.message
    || (['working', 'running', 'accepted'].includes(String(task.status || '')) ? '正在推进任务并整理公开进展' : task.title || '任务正在准备');
  const history = collaborationTaskHistory(progress);
  const currentUserId = String(state.currentUser?.id || '');
  const group = state.collaborationGroupDetail?.group || {};
  const canWithdraw = group.status !== 'closed' && group.ownerUserId === currentUserId
    && ['assigned', 'preparing', 'awaiting_approval', 'accepted', 'running', 'working', 'draft_ready', 'submitted', 'revision_requested', 'blocked', 'failed'].includes(String(task.status || ''));
  const busy = Boolean(state.collaborationTaskActionBusyById?.[task.id]);
  return `<section class="collaboration-progress-task" data-collaboration-progress-task="${escapeAttr(task.id || '')}"><header><strong>${escapeHtml(task.title || '协作任务')}</strong><span>${escapeHtml(taskStatusLabel(task.status))}</span></header><p>${escapeHtml(current)}</p>${completed.length ? `<div class="collaboration-progress-details"><strong>最近完成</strong>${completed.map((node) => `<span>${iconSvg('check')}<b>${escapeHtml(node.title || '已完成节点')}</b></span>`).join('')}</div>` : ''}${history.length ? `<details class="collaboration-progress-history"><summary>查看 ${history.length} 条进展记录</summary><div>${history.map((item) => `<span><time>${escapeHtml(formatMessageTime(item.occurredAt))}</time><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail)}</small></span>`).join('')}</div></details>` : ''}<footer><div class="collaboration-progress-actions"><button type="button" ${taskCardActionAttributes(TASK_CARD_ACTIONS.OPEN_WORKSPACE, task)}>查看任务</button>${canWithdraw ? `<button class="is-danger" type="button" data-collaboration-task-action="withdraw" data-delegation-id="${escapeAttr(task.id)}" ${busy ? 'disabled' : ''}>${busy ? '正在停止…' : task.status === 'failed' ? '撤回并归档' : '停止任务'}</button>` : ''}</div></footer></section>`;
}

function collaborationTaskHistory(progress = {}) {
  const entries = [
    ...(Array.isArray(progress.milestones) ? progress.milestones.map((item) => ({
      key: item.key || `${item.title}:${item.status}`,
      title: item.title || '任务进展', detail: item.detail || taskNodeStatusLabel(item.status),
      occurredAt: item.occurredAt || '',
    })) : []),
    ...(Array.isArray(progress.nodes) ? progress.nodes.filter((item) => item.updatedAt || item.completedAt || item.startedAt).map((item) => ({
      key: `${item.id || item.title}:${item.status}`,
      title: item.title || '任务节点', detail: item.summary || taskNodeStatusLabel(item.status),
      occurredAt: item.updatedAt || item.completedAt || item.startedAt || '',
    })) : []),
  ];
  return [...new Map(entries.map((item) => [item.key, item])).values()]
    .sort((left, right) => (Date.parse(right.occurredAt || 0) || 0) - (Date.parse(left.occurredAt || 0) || 0))
    .slice(0, 20);
}

function collaborationReviewItems(tasks = []) {
  const items = [];
  for (const task of tasks) {
    const status = String(task.status || '');
    if (['submitted', 'draft_ready'].includes(status)) items.push({ kind: 'result', task, title: '任务结果等待审核', detail: task.title || '查看交付结果' });
    else if (collaborationTaskProgress(task).blocker) items.push({ kind: 'task', task, title: '任务需要你的处理', detail: collaborationTaskProgress(task).blocker.summary || task.title || '查看阻塞详情' });
  }
  const rank = { result: 0, task: 1 };
  return items.sort((left, right) => rank[left.kind] - rank[right.kind]);
}

function renderCollaborationReviewBar(items = []) {
  const item = items[0];
  return `<aside class="collaboration-review-bar"><span class="collaboration-review-icon">${iconSvg('clipboard')}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}${items.length > 1 ? ` · 另有 ${items.length - 1} 项` : ''}</small></span><button type="button" data-collaboration-review="${escapeAttr(item.kind)}" data-collaboration-review-task="${escapeAttr(item.task.id || '')}">查看审核</button></aside>`;
}

function renderCollaborationDetailsBar(tasks = [], reviewItems = [], open = false) {
  const review = reviewItems[0] || null;
  const summary = review
    ? `${review.detail}${reviewItems.length > 1 ? ` · 另有 ${reviewItems.length - 1} 项` : ''}`
    : `${tasks.length} 项任务 · 查看当前进度和执行记录`;
  return `<aside class="collaboration-details-bar ${review ? 'has-review' : ''}"><span class="collaboration-review-icon">${iconSvg('clipboard')}</span><span><strong>任务详情</strong><small>${escapeHtml(summary)}</small></span><button type="button" data-collaboration-details-toggle aria-expanded="${open ? 'true' : 'false'}">${open ? '收起' : '展开详情'}</button></aside>`;
}

function collaborationSearchResults(detail = {}, tasks = []) {
  const query = normalizeSearch(state.collaborationSearchQuery || '');
  if (!query) return [];
  const results = [];
  for (const message of detail.messages || []) {
    const actor = socialFriendName(message.sender || {});
    const haystack = normalizeSearch(`${actor} ${message.content || ''}`);
    if (haystack.includes(query)) results.push({ kind: 'message', id: message.id || '', label: actor || '群消息', detail: clipInline(message.content || '', 100) });
  }
  for (const task of tasks) {
    const progress = collaborationTaskProgress(task);
    const nodes = Array.isArray(progress.nodes) ? progress.nodes : [];
    const text = [task.title, task.instruction, progress.message, progress.currentStep?.title, ...nodes.flatMap((node) => [node.title, node.agentName])].filter(Boolean).join(' ');
    if (normalizeSearch(text).includes(query)) results.push({ kind: 'progress', id: task.id || '', label: task.title || '协作任务', detail: clipInline(progress.message || progress.currentStep?.title || task.instruction || '', 100) });
  }
  return results.slice(0, 50);
}

function renderCollaborationSearch(results = []) {
  const query = state.collaborationSearchQuery || '';
  return `<section class="collaboration-search-panel"><label>${iconSvg('search')}<input id="collaboration-search-input" type="search" value="${escapeAttr(query)}" placeholder="搜索消息、任务、节点或 Agent" autocomplete="off" aria-label="搜索协作内容"></label>${query ? `<div class="collaboration-search-results" role="listbox">${results.length ? results.map((item, index) => `<button type="button" role="option" class="${index === Number(state.collaborationSearchActiveIndex || 0) ? 'active' : ''}" data-collaboration-search-result="${escapeAttr(item.kind)}" data-collaboration-search-target="${escapeAttr(item.id)}"><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.kind === 'message' ? '群消息' : '协作进度')}</small></span><p>${escapeHtml(item.detail || '')}</p></button>`).join('') : '<p class="collaboration-search-empty">没有匹配的协作内容</p>'}</div>` : ''}</section>`;
}

function renderCollaborationRoutingConfirmation(tasks = []) {
  const confirmation = state.collaborationRoutingConfirmation;
  if (!confirmation || confirmation.groupId !== state.collaborationGroupId) return '';
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const candidates = (confirmation.candidates || confirmation.candidateDelegationIds || [])
    .map((candidate) => {
      const id = typeof candidate === 'string' ? candidate : candidate.delegationId || candidate.id || '';
      const task = taskById.get(id) || {};
      return {
        id,
        title: (typeof candidate === 'object' ? candidate.title : '') || task.title || '未命名任务',
        detail: (typeof candidate === 'object' ? candidate.detail || candidate.recipientName : '') || task.instruction || '',
      };
    })
    .filter((candidate) => candidate.id);
  return `<section class="collaboration-routing-confirmation" aria-label="选择任务更新目标">
    <div><strong>这条消息可能对应多个任务</strong><span>请选择需要更新的任务。uBuddy 不会自行猜测，也不会重复发送群消息。</span></div>
    <p>${escapeHtml(confirmation.content || '')}</p>
    <div class="collaboration-routing-options">${candidates.map((candidate) => `<label><input type="radio" name="collaboration-routing-target" value="${escapeAttr(candidate.id)}" data-collaboration-routing-target ${confirmation.selectedDelegationId === candidate.id ? 'checked' : ''}><span><strong>${escapeHtml(candidate.title)}</strong>${candidate.detail ? `<small>${escapeHtml(clipInline(candidate.detail, 80))}</small>` : ''}</span></label>`).join('')}</div>
    <div class="collaboration-routing-actions"><button type="button" class="btn secondary" data-collaboration-routing-cancel>暂不更新任务</button><button type="button" class="btn primary" data-collaboration-routing-confirm ${!confirmation.selectedDelegationId ? 'disabled' : ''}>确认更新这个任务</button></div>
  </section>`;
}

function renderCollaborationAddMemberPanel(members = []) {
  if (!state.collaborationAddMemberOpen) return '';
  const memberIds = new Set(members.map((item) => item.userId));
  const candidates = (state.friendOverview?.friends || []).map((item) => ({
    ...(item.friend || {}), online: item.online === true || item.friend?.online === true,
  })).filter((friend) => friend.id && !memberIds.has(friend.id));
  return `<section class="collaboration-add-member-panel" aria-label="添加群成员">
    <div class="collaboration-add-member-head"><div><strong>添加好友和对方 uBuddy</strong><small>选择好友，并明确分配给对方 uBuddy 的任务说明</small></div><button type="button" data-collaboration-add-member-cancel aria-label="关闭">×</button></div>
    <div class="collaboration-add-member-candidates">${candidates.length ? candidates.map((friend) => `<label><input type="radio" name="collaboration-add-member" value="${escapeAttr(friend.id)}" data-collaboration-add-member-user ${state.collaborationAddMemberUserId === friend.id ? 'checked' : ''}>${renderUserAvatar(friend, { className: 'network-user-avatar', title: socialFriendName(friend), fallbackLabel: socialInitials(friend) })}<span><strong>${escapeHtml(socialFriendName(friend))}</strong><small><i class="contact-presence-dot ${friend.online ? 'is-online' : 'is-offline'}" aria-hidden="true"></i>${friend.online ? '在线' : '离线'} · ${escapeHtml(friend.username ? `@${friend.username}` : friend.email || friend.id)}</small></span></label>`).join('') : '<div class="collaboration-add-member-empty">没有可添加的好友</div>'}</div>
    <label class="collaboration-add-member-assignment"><span>任务说明</span><textarea id="collaboration-add-member-assignment" rows="3" placeholder="例如：请整理近期工作并制作流程图">${escapeHtml(state.collaborationAddMemberAssignment || '')}</textarea></label>
    <div class="collaboration-add-member-actions"><button class="btn secondary" type="button" data-collaboration-add-member-cancel>取消</button><button class="btn primary" type="button" data-collaboration-add-member-confirm ${!candidates.length ? 'disabled' : ''}>添加并派发任务</button></div>
  </section>`;
}

function renderCollaborationGroupMessage(message = {}, currentUserId = '', tasks = [], continuity = {}) {
  if (String(message.metadata?.type || '') === 'ubuddy_peer_coordination_receipt') return '';
  const mine = message.senderUserId === currentUserId;
  const agent = Boolean(message.senderAgentId);
  const visualMine = mine && !agent;
  const actorName = socialFriendName(message.sender || {});
  const actor = agent ? (mine ? '我的 uBuddy' : `${actorName} 的 uBuddy`) : (mine ? currentUserDisplayName() : actorName);
  const avatar = renderSocialMessageAvatar({
    mine, agent, friend: message.sender || {}, profileContext: 'group', showOwnerAvatar: false,
  });
  const attachments = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
  const content = attachments.length ? stripAttachmentResourceBlock(message.content || '') : message.content || '';
  const humanHighlight = !agent;
  const workRequest = humanHighlight && messageHasUBuddyMention(message, content, collaborationMentionTokens());
  const delegationId = String(message.metadata?.delegationId || message.metadata?.delegation_id || '').trim();
  const task = delegationId ? tasks.find((item) => item.id === delegationId) || null : null;
  if (String(message.metadata?.type || '') === 'ubuddy_task_summary') {
    const summaryTask = tasks.find((item) => String(item.id || '') === String(message.metadata?.taskId || '')) || task || {};
    return renderCollaborationTaskSummary(message, summaryTask);
  }
  const inlineTaskCard = task && String(message.metadata?.type || '') === 'task_assigned'
    ? renderTaskCardArticle(task, {
      label: '任务已派发',
      returnAnchorId: message.id || '',
      sourceContext: {
        source_group_id: state.collaborationGroupId || task.groupId || task.group_id || '',
        source_message_id: task.metadata?.source_message_id || '',
        returnSurface: 'group',
      },
    })
    : '';
  const routingConfirmation = state.collaborationRoutingConfirmation?.sourceMessageId === message.id
    ? renderCollaborationRoutingConfirmation(tasks)
    : '';
  if (['delegation_milestone', 'task_action'].includes(String(message.metadata?.type || ''))) {
    const action = String(message.metadata?.action || message.metadata?.status || '');
    const tone = ['blocked', 'failed'].includes(action) ? 'failed' : ['submitted', 'result_accepted'].includes(action) ? 'delivered' : action === 'draft_ready' ? 'ready' : 'running';
    const progress = message.metadata?.executionProgress || {};
    const total = Number(progress.total || 0);
    const completed = Number(progress.completed || 0);
    const percent = total ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;
    return `<article class="message assistant social-group-message is-agent-message collaboration-task-milestone tone-${escapeAttr(tone)} has-chat-avatar" data-message-id="${escapeAttr(message.id || '')}">${avatar}<div class="message-shell"><div class="social-message-actor"><span>${escapeHtml(actor)}</span><time>${escapeHtml(formatMessageTime(message.createdAt))}</time></div><div class="collaboration-task-milestone-head"><strong>${escapeHtml(taskStatusLabel(message.metadata?.status || action))}</strong><span>${escapeHtml(content || message.metadata?.publicFailure?.message || '任务状态已更新')}</span></div>${total ? `<div class="network-delegation-progress-track"><i style="width:${percent}%"></i></div><small>已完成 ${completed} / ${total} 个节点</small>` : ''}${attachments.length ? renderMessageAttachmentCards(attachments) : ''}${routingConfirmation}</div></article>`;
  }
  const peerCoordination = message.metadata?.type === 'ubuddy_peer_coordination';
  return `<article class="message ${visualMine ? 'user' : 'assistant'} social-group-message has-chat-avatar ${continuousMessageClassNames(continuity)} ${agent ? 'is-agent-message' : 'is-human-message is-ubuddy-group-human'} ${workRequest ? 'is-ubuddy-work-request' : ''} ${peerCoordination ? 'is-peer-coordination' : ''}" data-message-id="${escapeAttr(message.id || '')}">${renderMessageAvatarSlot(avatar, continuity.consecutive)}<div class="message-shell">${continuity.consecutive ? '' : `<div class="social-message-actor"><span>${escapeHtml(actor)}</span><time>${escapeHtml(formatMessageTime(message.createdAt))}</time></div>`}${peerCoordination ? `<div class="ubuddy-peer-thread-label"><span>uBuddy 工作对齐</span><small>${escapeHtml(collaborationCoordinationStatus(message))}</small></div>` : ''}${attachments.length ? renderMessageAttachmentCards(attachments) : ''}${renderCollaborationGroupMessageBody(message, content, agent)}${renderMessageQuote(message.metadata?.quote)}${inlineTaskCard}${routingConfirmation}${renderMessageFooter(message, '复制消息')}</div></article>`;
}

function collaborationCoordinationStatus(message = {}) {
  const metadata = message.metadata || {};
  if (metadata.coordinationComplete === true || metadata.replyStatus === 'stopped') return '已结束';
  const turn = Math.max(1, Number(metadata.turn || 1));
  const replied = (state.collaborationGroupDetail?.messages || []).some((candidate) => (
    String(candidate.metadata?.inReplyTo || '') === String(message.id || '')
    && candidate.metadata?.type === 'ubuddy_peer_coordination'
  ));
  if (replied) return `已回复 · 第 ${turn} / 6 条`;
  const receipt = (state.collaborationGroupDetail?.messages || []).findLast((candidate) => (
    String(candidate.metadata?.inReplyTo || '') === String(message.id || '')
    && candidate.metadata?.type === 'ubuddy_peer_coordination_receipt'
  ));
  if (receipt?.metadata?.receiptStatus === 'processing') return `正在处理 · 第 ${turn} / 6 条`;
  const status = String(metadata.replyStatus || '');
  if (status === 'processing') return `正在处理 · 第 ${turn} / 6 条`;
  if (status === 'replied') return `已回复 · 第 ${turn} / 6 条`;
  if (status === 'failed') return '处理失败';
  const createdAt = Date.parse(message.createdAt || message.created_at || 0);
  if (status === 'queued' && Number.isFinite(createdAt) && Date.now() - createdAt >= 10 * 60_000) return '等待对方上线';
  return `第 ${turn} / 6 条`;
}

function renderCollaborationTaskSummary(message = {}, task = {}) {
  const metadata = message.metadata || {};
  const ownerUserId = String(
    metadata.responsibleUBuddyOwnerUserId
      || task.recipientUserId || task.recipient_user_id
      || message.senderUserId || message.sender_user_id
      || state.currentUser?.id || '',
  ).trim();
  const owner = collaborationMemberUser(ownerUserId);
  const ownerName = ownerUserId === String(state.currentUser?.id || '')
    ? currentUserDisplayName()
    : socialFriendName(owner || { id: ownerUserId });
  const uBuddyTitle = `${ownerName || '成员'}的 uBuddy`;
  const ownerTone = uBuddyOwnerTone(ownerUserId);
  const stage = String(metadata.stage || 'updated');
  const tone = stage === 'blocked' ? 'blocked'
    : ['submitted', 'revision_requested'].includes(stage) ? 'review'
      : stage === 'completed' ? 'completed' : 'active';
  const stageLabel = {
    planned: '任务计划', started: '开始执行', recovered: '已恢复', blocked: '需要关注',
    submitted: '等待审核', revision_requested: '正在修改', completed: '任务完成',
  }[stage] || '任务摘要';
  const highlights = Array.isArray(metadata.highlights) ? metadata.highlights.filter(Boolean).slice(0, 3) : [];
  const occurredAt = metadata.occurredAt || message.createdAt || message.created_at || '';
  return `<article class="collaboration-task-summary is-${escapeAttr(tone)} owner-tone-${ownerTone}" data-message-id="${escapeAttr(message.id || '')}" data-task-summary-task="${escapeAttr(task.id || metadata.taskId || '')}" data-ubuddy-owner-user-id="${escapeAttr(ownerUserId)}">
    <header><span class="collaboration-task-summary-icon owner-tone-${ownerTone}" title="${escapeAttr(uBuddyTitle)}" aria-label="${escapeAttr(`${uBuddyTitle}的头像`)}">${iconSvg('spark')}</span><span><small class="collaboration-task-summary-meta"><span class="collaboration-task-summary-identity"><span>${escapeHtml(uBuddyTitle)}</span><b>任务总结</b></span><span class="collaboration-task-summary-state"><time>${escapeHtml(formatMessageTime(occurredAt))}</time><em>${escapeHtml(stageLabel)}</em></span></small><strong>${escapeHtml(task.title || '协作任务')}</strong></span></header>
    <div class="collaboration-task-summary-conclusion">${escapeHtml(metadata.conclusion || message.content || '任务状态已经更新。')}</div>
    ${highlights.length ? `<section><strong>关键成果</strong>${highlights.map((item) => `<span>${iconSvg('check')}<b>${escapeHtml(item)}</b></span>`).join('')}</section>` : ''}
    ${metadata.risk ? `<aside><strong>${metadata.requiresUserAction ? '需要你处理' : '风险与待确认'}</strong><span>${escapeHtml(metadata.risk)}</span></aside>` : ''}
    <footer><span><strong>下一步</strong>${escapeHtml(metadata.nextStep || '继续关注任务进展。')}</span><button type="button" ${taskCardActionAttributes(TASK_CARD_ACTIONS.OPEN_WORKSPACE, task)}>查看任务</button></footer>
  </article>`;
}

function renderCollaborationGroupMessageBody(message = {}, content = '', agent = false) {
  const text = String(content || '').trim();
  if (!text) return '';
  const body = `<div class="message-body">${formatCollaborationGroupText(text)}</div>`;
  if (!agent || !uBuddyResponseNeedsCollapse(text)) return body;
  const expanded = Boolean(state.uBuddyExpandedMessageIds?.[message.id]);
  return `<div class="ubuddy-long-response ${expanded ? 'is-expanded' : 'is-collapsed'}">${body}<button type="button" data-long-message-toggle="${escapeAttr(message.id || '')}" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? '收起' : '查看全部'}</button></div>`;
}

function renderCollaborationTaskChip(task = {}) {
  const progress = state.networkDelegationProgressById?.[task.id] || task.metadata?.executionProgress || null;
  const total = Number(progress?.total || 0);
  const completed = Number(progress?.completed || 0);
  const percent = total ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;
  const failed = ['blocked', 'failed'].includes(String(task.status || ''));
  const active = ['running', 'working', 'accepted', 'revision_requested'].includes(String(task.status || ''));
  const explicitlyOpen = Object.prototype.hasOwnProperty.call(state.collaborationGroupProgressOpenById || {}, task.id)
    ? Boolean(state.collaborationGroupProgressOpenById[task.id])
    : active;
  const nodes = Array.isArray(progress?.nodes) ? progress.nodes : [];
  const blocker = progress?.blocker || null;
  const taskWorkspaceUiEnabled = state.uBuddyFeatureFlags?.newTaskWorkspaceUi !== false;
  return `<details class="collaboration-task-chip ${failed ? 'is-failed' : ''}" data-collaboration-task-progress="${escapeAttr(task.id)}"${explicitlyOpen ? ' open' : ''}>
    <summary><span><strong>${escapeHtml(task.title || '任务')}</strong><small>${escapeHtml(taskStatusLabel(task.status))}${total ? ` · ${completed}/${total}` : ''}</small></span><b>${percent}%</b></summary>
    ${total ? `<i><b style="width:${percent}%"></b></i>` : ''}
    <div class="collaboration-task-public-progress">
      <p>${escapeHtml(progress?.message || progress?.currentStep?.title || '任务进度已更新')}</p>
      ${nodes.length ? `<section><strong>公开节点状态</strong>${nodes.map((node) => `<div class="is-${escapeAttr(node.status || 'pending')}"><span>${escapeHtml(node.title || '任务节点')}</span><small>${node.agentName ? `${escapeHtml(node.agentName)} · ` : ''}${escapeHtml(taskNodeStatusLabel(node.status))}</small></div>`).join('')}</section>` : ''}
      ${blocker ? `<aside><strong>任务受阻</strong><span>${escapeHtml(blocker.summary || '当前节点暂时无法继续。')}</span>${blocker.suggestedNextStep ? `<small>${escapeHtml(blocker.suggestedNextStep)}</small>` : ''}</aside>` : ''}
      ${taskWorkspaceUiEnabled
        ? `<button type="button" ${taskCardActionAttributes(TASK_CARD_ACTIONS.OPEN_WORKSPACE, task)}>打开任务工作区</button>`
        : '<small>进度和结果保留在当前任务卡中。</small>'}
    </div>
  </details>`;
}

function collaborationMentionItems() {
  const currentUserId = state.currentUser?.id || '';
  const detail = state.chatGroupId ? state.chatGroupDetail : state.collaborationGroupDetail;
  const members = (detail?.members || []).filter((member) => member.status === 'active');
  const english = state.languageMode === 'en';
  const targetCount = Math.max(0, members.length - 1);
  const audienceItems = [
    { token: english ? '@Everyone' : '@所有人', label: english ? 'Everyone' : '所有人', detail: english ? `${targetCount} human members; uBuddy is excluded` : `${targetCount} 位自然人成员，不包含 uBuddy`, tone: 'everyone', principalType: 'group_audience', audience: 'human_members' },
    { token: english ? '@Group uBuddies' : '@群内uBuddy', label: english ? 'Group uBuddies' : '群内 uBuddy', detail: english ? `Explicitly notify ${targetCount} member uBuddies` : `明确通知 ${targetCount} 位成员的 uBuddy`, tone: 'friend-agent', principalType: 'group_audience', audience: 'member_ubuddies' },
  ];
  return [...audienceItems, ...members.flatMap((member) => {
    const name = socialFriendName(member.user || {});
    const self = member.userId === currentUserId;
    return [
      { token: `@${name}`, label: self ? `我（${name}）` : name, detail: '提及群成员', tone: 'friend', principalType: 'user', userId: member.userId },
      { token: self ? '@我的uBuddy' : `@${name}的uBuddy`, label: self ? '我的 uBuddy' : `${name} 的 uBuddy`, detail: '请秘书结合群聊公开上下文答复', tone: self ? 'own-agent' : 'friend-agent', principalType: 'ubuddy', ownerUserId: member.userId },
    ];
  })];
}

function collaborationMentionTokens() {
  return [...new Set(collaborationMentionItems().map((item) => item.token))].sort((left, right) => right.length - left.length);
}

function renderMentionMarkup(value = '', tokens = []) {
  const source = String(value || '');
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

function formatCollaborationGroupText(content = '') {
  return renderMentionMarkup(content, collaborationMentionTokens()).replaceAll('\n', '<br>');
}

function taskStatusLabel(status = '') {
  return ({ pending: '等待启动', ready: '准备执行', queued: '等待 Agent 领取', assigned: '已派发', preparing: 'uBuddy处理中', accepted: '待处理', running: '处理中', working: '调整中', draft_ready: '待确认交付', submitted: '已交付 · 待验收', revision_requested: '需修改', result_accepted: '已验收', completed: '已完成', cancelled: '已停止', blocked: '执行受阻', failed: '执行失败', declined: '已拒绝', withdrawn: '已撤回', closed: '已关闭' })[status] || status;
}

function activeSocialFriend() {
  if (!state.networkPanelOpen) return null;
  const peerId = String(state.networkConversationPeerId || '').trim();
  if (!peerId || peerId === 'self-secretary') return null;
  if (peerId === state.currentUser?.id) return {
    ...state.currentUser,
    remark: '',
  };
  const relationship = (state.friendOverview?.friends || []).find((item) => (
    String(item?.friend?.id || item?.user?.id || '') === peerId
  ));
  if (relationship) {
    const friend = relationship.friend || relationship.user || null;
    return friend ? { ...friend, remark: relationship.remark || friend.remark || '' } : null;
  }
  for (const organization of state.friendOverview?.organizations || []) {
    const member = (organization?.members || []).find((item) => String(item?.user?.id || '') === peerId);
    if (member?.user) return member.user;
  }
  return null;
}

function renderSocialGroupChat(friend) {
  const taskGroup = socialTaskGroupById(state.networkConversationMessages || [], state.networkConversationGroupId)
    || latestSocialTaskGroup(state.networkConversationMessages || []);
  const messages = messagesForSocialTaskGroup(state.networkConversationMessages || [], taskGroup)
    .sort((left, right) => new Date(left.createdAt || left.created_at || 0).getTime() - new Date(right.createdAt || right.created_at || 0).getTime());
  return `
    <div class="view chat-view with-messages social-group-chat-view">
      <section class="chat-panel conversation-panel social-group-panel">
        ${renderSocialGroupHeader(friend, taskGroup)}
        <div class="message-list social-group-message-list" id="message-list" data-message-scroll-key="${escapeAttr(messageScrollKey())}">
          ${messages.length ? renderContinuousMessageSequence(messages, (message, continuity) => renderSocialGroupMessage(message, friend, continuity), socialGroupMessageContinuityKey) : renderSocialGroupEmpty(friend)}
        </div>
        <div class="social-group-ended legacy-social-group-ended"><strong>旧版群聊 · 只读</strong><span>历史内容已保留。新的委托请在好友私聊中 @我的uBuddy，经确认后创建真实任务群。</span></div>
      </section>
      ${renderChatAvatarProfilePopover()}
    </div>
  `;
}

function renderSocialGroupHeader(friend, taskGroup = null) {
  const friendName = socialFriendName(friend);
  const canDissolve = false;
  const canRename = false;
  const participants = [
    ['我', 'self'],
    ['我的 uBuddy', 'own-agent'],
    [friendName, 'friend'],
    [`${friendName} 的 uBuddy`, 'friend-agent'],
  ];
  return `
    <header class="social-group-header">
      <div class="social-group-heading">
        <div class="social-group-title">
          <span class="social-group-avatar">${escapeHtml(socialInitials(friend))}</span>
          <span><strong>${escapeHtml(taskGroup?.title || friendName)}</strong><small>${escapeHtml(friendName)} · ${taskGroup?.dissolved ? '已结束' : '进行中'} · 四方任务群聊</small></span>
        </div>
        <div class="social-group-actions">
          ${canRename ? '<button class="social-group-rename" type="button" data-social-group-rename>修改群名</button>' : ''}
          ${canDissolve ? '<button class="social-group-dissolve" type="button" data-social-group-dissolve>解散群聊</button>' : ''}
          ${renderSocialConversationCloseButton()}
        </div>
      </div>
      <div class="social-group-participants" aria-label="群组角色">
        ${participants.map(([label, tone]) => `<span class="social-participant tone-${tone}">${escapeHtml(label)}${tone.includes('agent') ? '<span class="ubuddy-beta-badge">Beta</span>' : ''}</span>`).join('')}
      </div>
    </header>
  `;
}

function renderSocialConversationCloseButton() {
  const singlePane = state.responsiveLayoutMode === 'single' || Boolean(state.collaborationGroupId);
  return `<button class="social-group-close" type="button" data-message-home-back title="${singlePane ? '返回消息列表' : '关闭当前会话'}" aria-label="${singlePane ? '返回消息列表' : '关闭当前会话'}">${iconSvg(singlePane ? 'chevronLeft' : 'x')}</button>`;
}

function renderSocialGroupMessage(message = {}, friend = {}, continuity = {}) {
  if (isSocialTaskGroupEvent(message)) return renderSocialTaskGroupEvent(message, friend);
  const currentUserId = state.currentUser?.id || '';
  const senderId = message.senderUserId || message.sender_user_id || '';
  const mine = senderId === currentUserId;
  const agent = Boolean(
    message.kind === 'agent'
    || message.senderAgentId || message.sender_agent_id
  );
  const actor = agent
    ? (mine ? '我的 uBuddy' : `${socialFriendName(friend)} 的 uBuddy`)
    : (mine ? '我' : socialFriendName(friend));
  const delegationId = message.metadata?.delegationId || message.metadata?.delegation_id || '';
  const attachments = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
  const content = attachments.length ? stripAttachmentResourceBlock(message.content) : message.content;
  const humanHighlight = !agent;
  const workRequest = humanHighlight && messageHasUBuddyMention(message, content, socialMentionTokens(socialFriendName(friend)));
  const avatar = renderSocialMessageAvatar({ mine, agent, friend, profileContext: 'group' });
  const avatarSlot = renderMessageAvatarSlot(avatar, continuity.consecutive);
  return `
    <article class="message ${mine ? 'user' : 'assistant'} social-group-message has-chat-avatar ${continuousMessageClassNames(continuity)} ${agent ? 'is-agent-message' : 'is-human-message is-ubuddy-group-human'} ${workRequest ? 'is-ubuddy-work-request' : ''}" data-message-id="${escapeAttr(message.id || '')}">
      ${mine ? '' : avatarSlot}
      <div class="message-shell">
        ${continuity.consecutive ? '' : `<div class="social-message-actor"><span>${escapeHtml(actor)}</span><time>${escapeHtml(formatMessageTime(message.createdAt || message.created_at))}</time></div>`}
        ${message.title && !delegationId ? `<strong class="social-message-title">${escapeHtml(message.title)}</strong>` : ''}
        ${attachments.length ? renderMessageAttachmentCards(attachments) : ''}
        ${String(content || '').trim() ? `<div class="message-body">${formatSocialGroupText(content, friend)}</div>` : ''}
        ${renderMessageQuote(message.metadata?.quote)}
        ${renderMessageFooter(message, '复制消息')}
      </div>
      ${mine ? avatarSlot : ''}
    </article>
  `;
}

function renderSocialTaskGroupEvent(message = {}, friend = {}) {
  const metadata = message.metadata || {};
  const currentUserId = state.currentUser?.id || '';
  const senderId = message.senderUserId || message.sender_user_id || '';
  const actor = senderId === currentUserId ? '你' : socialFriendName(friend);
  const dissolved = metadata.action === 'dissolved';
  const renamed = metadata.action === 'renamed';
  const label = dissolved
    ? `${actor} 已解散群聊，任务结束`
    : renamed
      ? `${actor} 将群聊名称修改为“${metadata.groupTitle || metadata.title || '四方任务群聊'}”`
      : `${actor} 创建了四方任务群聊`;
  return `<div class="social-group-system-event ${dissolved ? 'is-ended' : ''}"><span>${escapeHtml(label)}</span><time>${escapeHtml(formatMessageTime(message.createdAt || message.created_at))}</time></div>`;
}

function formatSocialGroupText(content = '', friend = {}) {
  let markup = formatText(content);
  for (const token of socialMentionTokens(socialFriendName(friend))) {
    const escapedToken = escapeHtml(token);
    markup = markup.replaceAll(escapedToken, `<mark class="social-mention-token">${escapedToken}</mark>`);
  }
  return markup;
}

function renderSocialGroupEmpty(friend) {
  return `<div class="social-group-empty"><strong>开始四方任务对接</strong><span>你、好友和双方 uBuddy 都在这里沟通，任务结束后由发起人解散群聊。</span></div>`;
}

function socialFriendName(friend = {}) {
  const relationshipRemark = (state.friendOverview?.friends || [])
    .find((item) => (item.friend || item.user || {}).id === friend.id)?.remark || '';
  return friend.remark || relationshipRemark || friend.displayName || friend.display_name || friend.username || friend.email || friend.id || '好友';
}

function socialInitials(friend = {}) {
  return avatarLabelFromName(socialFriendName(friend)) || '友';
}

function renderSocialMessageAvatar({ mine = false, agent = false, friend = {}, profileContext = '', showOwnerAvatar = true } = {}) {
  if (agent) {
    const ownerUser = mine ? state.currentUser || {} : friend || {};
    const ownerUserId = String(ownerUser?.id || '').trim();
    return renderAgentAvatar({
      agentId: 'secretary_agent',
      title: mine ? '我的 uBuddy' : `${socialFriendName(friend)} 的 uBuddy`,
      ownerUserId,
      ownerUser,
      showOwnerAvatar,
    });
  }
  const user = mine ? state.currentUser : friend;
  const title = mine ? currentUserDisplayName() : socialFriendName(friend);
  const label = mine ? userInitials(state.currentUser) : socialInitials(friend);
  const avatar = renderPersonAvatar(label, title, mine ? 'self' : 'peer', user);
  const userId = String(user?.id || '').trim();
  if (mine || !userId || !profileContext) return avatar;
  const expanded = String(state.chatAvatarProfile?.userId || '') === userId;
  return `<button class="chat-message-avatar-button" type="button" data-chat-avatar-profile="${escapeAttr(userId)}" data-chat-avatar-profile-context="${escapeAttr(profileContext)}" aria-label="查看${escapeAttr(title)}的简介" aria-haspopup="dialog" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="chat-avatar-profile-popover">${avatar}</button>`;
}

function renderChatAvatarProfilePopover() {
  const profile = state.chatAvatarProfile;
  if (!profile?.userId) return '';
  const user = chatAvatarProfileUser(profile.userId);
  if (!user) return '';
  const name = socialFriendName(user);
  const account = user.username ? `@${user.username}` : user.email || user.id || '';
  const organization = chatAvatarProfileOrganization(user.id);
  const introduction = clipInline(String(user.bio || user.introduction || user.signature || user.headline || '').trim(), 140);
  const canMessage = profile.context === 'group' && String(user.id || '') !== String(state.currentUser?.id || '');
  const left = Math.max(8, Number(profile.left || 8));
  const top = Math.max(8, Number(profile.top || 8));
  return `<div class="chat-avatar-profile-layer" data-chat-avatar-profile-close>
    <aside class="chat-avatar-profile-popover" id="chat-avatar-profile-popover" role="dialog" aria-modal="false" aria-label="联系人简介" style="left:${left}px;top:${top}px" data-chat-avatar-profile-popover tabindex="-1">
      <button class="chat-avatar-profile-close" type="button" data-chat-avatar-profile-close aria-label="关闭">${iconSvg('x')}</button>
      <div class="chat-avatar-profile-head">
        ${renderUserAvatar(user, { className: 'chat-avatar-profile-image', title: name, fallbackLabel: socialInitials(user), viewerUserId: user.id })}
        <div><strong>${escapeHtml(name)}</strong>${account ? `<small>${escapeHtml(account)}</small>` : ''}</div>
      </div>
      <p>${escapeHtml(introduction || organization || '联系人')}</p>
      ${organization && introduction ? `<span class="chat-avatar-profile-organization">${escapeHtml(organization)}</span>` : ''}
      ${canMessage ? `<button class="chat-avatar-profile-message" type="button" data-chat-avatar-profile-message="${escapeAttr(user.id)}">${iconSvg('message')}<span>发起私聊</span></button>` : ''}
    </aside>
  </div>`;
}

function chatAvatarProfileUser(userId = '') {
  const cleanId = String(userId || '').trim();
  if (!cleanId) return null;
  const relationship = (state.friendOverview?.friends || []).find((item) => (
    String(item?.friend?.id || item?.user?.id || '') === cleanId
  ));
  if (relationship) {
    const user = relationship.friend || relationship.user || {};
    return { ...user, remark: relationship.remark || user.remark || '' };
  }
  for (const detail of [state.chatGroupDetail, state.collaborationGroupDetail]) {
    const member = (detail?.members || []).find((item) => String(item?.user?.id || item?.userId || '') === cleanId);
    if (member?.user) return member.user;
  }
  for (const organization of state.friendOverview?.organizations || []) {
    const member = (organization?.members || []).find((item) => String(item?.user?.id || '') === cleanId);
    if (member?.user) return member.user;
  }
  const active = activeSocialFriend();
  return String(active?.id || '') === cleanId ? active : null;
}

function chatAvatarProfileOrganization(userId = '') {
  for (const organization of state.friendOverview?.organizations || []) {
    if ((organization?.members || []).some((item) => String(item?.user?.id || '') === String(userId || ''))) {
      return organization.name || organization.title || '';
    }
  }
  return '';
}

function currentUserDisplayName() {
  const user = state.currentUser || {};
  return user.remark || user.displayName || user.display_name || user.username || user.email || user.id || '我';
}

function renderPersonAvatar(label = '', title = '', tone = 'peer', user = {}) {
  const avatarUser = tone === 'self' ? state.currentUser || user : user;
  return renderUserAvatar(avatarUser, {
    className: `chat-message-avatar is-person is-${tone}`,
    title,
    fallbackLabel: label,
  });
}

function renderAgentAvatar({ agentId = '', title = '', privateAssistant = false, ownerUserId = '', ownerUser = null, showOwnerAvatar = true } = {}) {
  const cleanTitle = title || 'Agent';
  const generalistAvatar = String(agentId || '').trim() === 'general_agent';
  const secretaryAvatar = !privateAssistant && (
    String(agentId || '').trim() === 'secretary_agent'
    || /uBuddy/i.test(cleanTitle)
  );
  const ownerToneClass = secretaryAvatar && ownerUserId ? `owner-tone-${uBuddyOwnerTone(ownerUserId)}` : '';
  const currentUserId = String(state.currentUser?.id || '').trim();
  const peerOwnerId = String(ownerUserId || '').trim();
  const suppliedOwner = ownerUser && typeof ownerUser === 'object' ? ownerUser : null;
  const peerOwner = showOwnerAvatar && secretaryAvatar && peerOwnerId && peerOwnerId !== currentUserId
    ? suppliedOwner && String(suppliedOwner.id || '') === peerOwnerId
      ? suppliedOwner
      : collaborationMemberUser(peerOwnerId) || { id: peerOwnerId }
    : null;
  const ownerName = peerOwner ? socialFriendName(peerOwner) : '';
  const ownerAvatar = peerOwner ? renderUserAvatar(peerOwner, {
    className: 'ubuddy-owner-avatar',
    title: `${ownerName}的账号头像`,
    fallbackLabel: socialInitials(peerOwner),
  }) : '';
  return `<span class="chat-message-avatar is-agent tone-${agentAvatarTone(agentId, cleanTitle)} ${generalistAvatar ? 'is-generalist' : ''} ${secretaryAvatar ? 'is-ubuddy' : ''} ${privateAssistant ? 'is-private' : ''} ${ownerToneClass} ${ownerAvatar ? 'has-owner-avatar' : ''}"${ownerAvatar ? ` data-ubuddy-owner-user="${escapeAttr(peerOwnerId)}"` : ''} title="${escapeAttr(cleanTitle)}" aria-label="${escapeAttr(`${cleanTitle}的头像`)}">${privateAssistant ? iconSvg('shield') : secretaryAvatar ? iconSvg('spark') : renderAgentAvatarContent(agentId, cleanTitle)}${ownerAvatar}</span>`;
}

function collaborationMemberUser(userId = '') {
  const cleanId = String(userId || '').trim();
  if (!cleanId) return null;
  if (cleanId === String(state.currentUser?.id || '')) return state.currentUser || null;
  const member = (state.collaborationGroupDetail?.members || []).find((item) => (
    String(item?.userId || item?.user?.id || '') === cleanId
  ));
  return member?.user || chatAvatarProfileUser(cleanId) || { id: cleanId };
}

function uBuddyOwnerTone(userId = '') {
  const source = String(userId || 'ubuddy').trim() || 'ubuddy';
  const memberIds = [...new Set((state.collaborationGroupDetail?.members || [])
    .map((member) => String(member?.userId || member?.user?.id || '').trim())
    .filter(Boolean))];
  const memberIndex = memberIds.indexOf(source);
  if (memberIndex >= 0) return memberIndex % 6;
  let hash = 0;
  for (const character of source) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return hash % 6;
}

function renderMessageAvatarSlot(avatar = '', consecutive = false) {
  return consecutive ? '<span class="chat-message-avatar-spacer" aria-hidden="true"></span>' : avatar;
}

function continuousMessageClassNames({ consecutive = false, continuesNext = false } = {}) {
  return `${consecutive ? 'is-consecutive-message' : ''} ${continuesNext ? 'has-consecutive-next' : ''}`.trim();
}

function renderContinuousMessageSequence(messages = [], renderer, continuityKey) {
  const items = Array.isArray(messages) ? messages : [];
  return items.map((message, index) => {
    return renderer(message, messageContinuityAt(items, index, continuityKey));
  }).join('');
}

function messageContinuityAt(items = [], index = 0, continuityKey = null) {
  const message = items[index] || {};
  const previous = items[index - 1] || null;
  const previousTime = messageContinuityTime(previous || {});
  const currentTime = messageContinuityTime(message);
  const timeGapMs = previousTime && currentTime ? currentTime - previousTime : NaN;
  return {
    consecutive: messagesAreContinuous(previous, message, continuityKey),
    continuesNext: messagesAreContinuous(message, items[index + 1], continuityKey),
    showMessageTime: Boolean(previous && currentTime && Number.isFinite(timeGapMs) && timeGapMs > 2 * 60_000),
    timeGapMs,
  };
}

function messagesAreContinuous(previous, current, continuityKey) {
  if (!previous || !current || typeof continuityKey !== 'function') return false;
  if (previous.metadata?.withdrawn === true || current.metadata?.withdrawn === true) return false;
  const previousKey = continuityKey(previous);
  const currentKey = continuityKey(current);
  if (!previousKey || previousKey !== currentKey) return false;
  const previousTime = messageContinuityTime(previous);
  const currentTime = messageContinuityTime(current);
  if (!previousTime || !currentTime) return true;
  const delta = currentTime - previousTime;
  return delta >= 0 && delta <= CONTINUOUS_MESSAGE_WINDOW_MS;
}

function messageContinuityTime(message = {}) {
  const value = message.createdAt || message.created_at || message.updatedAt || message.updated_at || '';
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function socialMessageContinuityKey(message = {}) {
  const senderId = String(message.senderUserId || message.sender_user_id || '').trim();
  if (!senderId) return '';
  const agentId = String(message.senderAgentId || message.sender_agent_id || (message.kind === 'agent' ? 'agent' : '')).trim();
  return `${senderId}:${agentId ? `agent:${agentId}` : 'person'}`;
}

function collaborationMessageContinuityKey(message = {}) {
  if (['delegation_milestone', 'task_action'].includes(String(message.metadata?.type || ''))) return '';
  return socialMessageContinuityKey(message);
}

function socialGroupMessageContinuityKey(message = {}) {
  if (isSocialTaskGroupEvent(message)) return '';
  return socialMessageContinuityKey(message);
}

function standardMessageContinuityKey(message = {}) {
  const metadata = message.metadata || {};
  const transient = String(metadata.transient || '');
  if (['run-status', 'draft', 'process'].includes(transient)) return '';
  if (metadata.uBuddyTaskQueued || metadata.uBuddyTaskTerminalTaskRunId) return '';
  if (parseArtifactMessage(message.content)) return '';
  if (message.role === 'user') return `user:${state.currentUser?.id || 'self'}`;
  if (message.role !== 'assistant') return '';
  const agentInstanceId = message.agentInstanceId || message.agent_instance_id || metadata.agentInstanceId || metadata.agent_instance_id || state.currentAgentInstanceId || '';
  const agentId = message.agentId || message.agent_id || metadata.agentId || metadata.agent_id || state.currentAgentId || '';
  const departmentId = message.departmentId || message.department_id || metadata.departmentId || metadata.department_id || state.currentDepartmentId || '';
  return `assistant:${agentInstanceId || agentId || departmentId || 'default'}`;
}

function renderStandardMessageAvatar(message = {}) {
  if (message.role === 'user') return renderPersonAvatar(userInitials(state.currentUser), currentUserDisplayName(), 'self', state.currentUser);
  if (message.role !== 'assistant') return '';
  const metadata = message.metadata || {};
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  const agentId = message.agentId || message.agent_id || metadata.agentId || metadata.agent_id || session?.agentId || session?.agent_id || state.currentAgentId || '';
  const departmentId = message.departmentId || message.department_id || metadata.departmentId || metadata.department_id || session?.departmentId || session?.department_id || state.currentDepartmentId || '';
  const employeeId = message.agentInstanceId || message.agent_instance_id || metadata.agentInstanceId || metadata.agent_instance_id || session?.agentInstanceId || session?.agent_instance_id || state.currentAgentInstanceId || '';
  const employee = (state.employeeOverview?.roster || []).find((item) => item.id === employeeId) || null;
  const agent = (state.org?.agents || []).find((item) => item.id === agentId) || null;
  const privateAssistant = departmentId === 'private_assistant' || state.homeMode === 'private_assistant';
  const secretary = agentId === 'secretary_agent' || departmentId === 'secretary_department' || state.homeMode === 'secretary';
  const title = privateAssistant
    ? '私人助理'
    : secretary
      ? 'uBuddy'
      : employee
        ? agentInstanceDisplayNameForUi(employee, employee.family?.name || agent?.displayName || agent?.display_name || agent?.name || session?.title || 'Agent')
        : agent?.displayName || agent?.display_name || agent?.name || session?.title || 'Agent';
  return renderAgentAvatar({
    agentId: agentId || employee?.agentFamilyId || (privateAssistant ? 'private_assistant' : secretary ? 'secretary_agent' : ''),
    title,
    privateAssistant,
  });
}

export function renderMessageList() {
  const messagesToRender = messagesForMessageList();
  publishedTaskCardsByMessageId = buildPublishedTaskCardIndex(messagesToRender);
  try {
    const pagination = renderMessageHistoryPagination();
    const messages = renderContinuousMessageSequence(messagesToRender, (message, continuity) => (
      withStableMessageIdentity(renderMessage(message, continuity), message, continuity)
    ), standardMessageContinuityKey);
    return `${pagination}${messages}`;
  } finally {
    publishedTaskCardsByMessageId = null;
  }
}

export function renderMessagePatchSet(messageIds = []) {
  const requested = new Set((Array.isArray(messageIds) ? messageIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean));
  const messagesToRender = messagesForMessageList();
  const indexes = new Map(messagesToRender.map((message, index) => [String(message?.id || ''), index]));
  const expanded = new Set(requested);
  for (const id of requested) {
    const index = indexes.get(id);
    if (!Number.isInteger(index)) continue;
    const previousId = String(messagesToRender[index - 1]?.id || '');
    const nextId = String(messagesToRender[index + 1]?.id || '');
    if (previousId) expanded.add(previousId);
    if (nextId) expanded.add(nextId);
  }
  publishedTaskCardsByMessageId = buildPublishedTaskCardIndex(messagesToRender);
  try {
    const entries = [...expanded]
      .map((id) => ({ id, index: indexes.get(id) }))
      .filter((entry) => Number.isInteger(entry.index))
      .sort((left, right) => left.index - right.index)
      .map((entry) => {
        const message = messagesToRender[entry.index];
        const continuity = messageContinuityAt(messagesToRender, entry.index, standardMessageContinuityKey);
        return {
          ...entry,
          markup: withStableMessageIdentity(renderMessage(message, continuity), message, continuity),
        };
      });
    return {
      requestedIds: [...requested],
      order: messagesToRender.map((message) => String(message?.id || '')).filter(Boolean),
      entries,
    };
  } finally {
    publishedTaskCardsByMessageId = null;
  }
}

function messagesForMessageList() {
  return projectAcceptedTaskDeliveryMessages(state.messages)
    .filter((message) => !(message?.role === 'assistant'
      && message?.metadata?.secretaryControl === true
      && message?.metadata?.welcome === true))
    .filter((message) => !(message?.role === 'user' && message?.metadata?.uBuddyClarificationResponse === true));
}

function projectAcceptedTaskDeliveryMessages(messages = []) {
  const source = Array.isArray(messages) ? messages : [];
  const terminalByTaskRunId = new Map();
  source.forEach((message, index) => {
    const taskRunId = String(
      message?.metadata?.taskRunId
      || message?.metadata?.taskSnapshot?.taskRunId
      || message?.metadata?.uBuddyTaskTerminalTaskRunId
      || '',
    ).trim();
    if (!taskRunId) return;
    const items = terminalByTaskRunId.get(taskRunId) || [];
    items.push({ index, message });
    terminalByTaskRunId.set(taskRunId, items);
  });
  if (!terminalByTaskRunId.size) return source;

  const replacements = new Map();
  const suppressed = new Set();
  for (const [taskRunId, items] of terminalByTaskRunId) {
    const terminalItems = items.filter((item) => item.message.metadata?.uBuddyTaskTerminalTaskRunId === taskRunId);
    if (!terminalItems.length) continue;
    const liveTask = state.uBuddyTaskViewsById?.[taskRunId]
      || (state.tasks || []).find((task) => String(task.id || '') === taskRunId)
      || (state.taskDetail?.id === taskRunId ? state.taskDetail : null);
    const latest = terminalItems.at(-1)?.message || {};
    const liveDeliverable = liveTask?.metadata?.deliverableResult || null;
    const latestDeliverable = latest.metadata?.deliverableResult || null;
    const accepted = liveTask?.metadata?.deliveryReviewOutcome === 'owner_override'
      || liveTask?.metadata?.finalDelivery?.state === 'closed'
      || latestDeliverable?.acceptanceSource === 'owner_override';
    if (!accepted) continue;

    const host = terminalItems[0];
    const deliverable = liveDeliverable || latestDeliverable || host.message.metadata?.deliverableResult || null;
    const publishProcessMessage = items.find((item) => (
      normalizedUBuddyTaskPublishProcess(item.message.metadata?.uBuddyTaskPublishProcess)
    ))?.message || null;
    const publishProcessMetadata = publishProcessMessage ? {
      uBuddyTaskPublishProcess: publishProcessMessage.metadata.uBuddyTaskPublishProcess,
      processEvents: publishProcessMessage.metadata.processEvents
        || publishProcessMessage.metadata.uBuddyTaskPublishProcess.events
        || [],
      processDurationMs: Number(publishProcessMessage.metadata.processDurationMs || 0),
      expanded: publishProcessMessage.metadata.expanded === true,
    } : {};
    replacements.set(host.index, {
      ...host.message,
      updatedAt: latest.updatedAt || latest.updated_at || host.message.updatedAt || host.message.updated_at || '',
      metadata: {
        ...(host.message.metadata || {}),
        ...(latest.metadata || {}),
        ...publishProcessMetadata,
        ...(deliverable ? { deliverableResult: deliverable, resultState: deliverable.resultState || 'accepted' } : {}),
        uBuddyTaskQueued: false,
        transient: '',
        terminal: true,
        uBuddyFinalDeliveryMessage: true,
        uBuddyDeliveryAcceptedInPlace: true,
      },
    });
    items.forEach((item) => {
      if (item.index !== host.index && (
        terminalItems.includes(item)
        || item.message.metadata?.uBuddyTaskQueued === true
        || item.message.metadata?.transient === 'run-status'
      )) suppressed.add(item.index);
    });
  }
  if (!replacements.size) return source;
  return source.flatMap((message, index) => (
    suppressed.has(index) ? [] : [replacements.get(index) || message]
  ));
}

function renderMessageHistoryPagination() {
  const pagination = state.messagePagination || {};
  if (pagination.sessionId !== state.currentSessionId
    || pagination.initialLoading === true
    || (!pagination.hasMore && !pagination.loading)) return '';
  const renderKey = `${pagination.loading ? 'loading' : 'ready'}:${String(pagination.nextCursor?.id || '')}`;
  return `<div class="message-history-pagination" data-message-id="history-loader:${escapeAttr(state.currentSessionId || '')}" data-message-render-key="${escapeAttr(renderKey)}">
    <button type="button" data-message-history-load ${pagination.loading ? 'disabled aria-busy="true"' : ''}>${pagination.loading ? '正在加载更早消息…' : '加载更早消息'}</button>
  </div>`;
}

function withStableMessageIdentity(markup = '', message = {}, continuity = {}) {
  const id = String(message?.id || '').trim();
  if (!id) return markup;
  const renderKey = messageRenderKey(message, continuity);
  return String(markup).replace(/^(\s*<article\b)([^>]*)(>)/, (_match, opening, attributes, close) => {
    const cleanedAttributes = String(attributes || '')
      .replace(/\sdata-message-id=(?:"[^"]*"|'[^']*')/i, '')
      .replace(/\sdata-message-render-key=(?:"[^"]*"|'[^']*')/i, '');
    return `${opening} data-message-id="${escapeAttr(id)}" data-message-render-key="${renderKey}"${cleanedAttributes}${close}`;
  });
}

function messageRenderKey(message = {}, continuity = {}) {
  const controlMessageLanguage = message.role === 'assistant'
    && message.metadata?.secretaryControl === true
    ? state.languageMode
    : '';
  const serialized = JSON.stringify([
    message.id || '', message.role || '', message.content || '', message.createdAt || message.created_at || '',
    message.updatedAt || message.updated_at || '', message.metadata || {}, continuity, controlMessageLanguage,
  ]);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function renderFileDropHint() {
  const imageMode = isImageComposerMode();
  return `
    <div class="file-drop-hint" aria-hidden="true">
      <div class="file-drop-hint-panel">
        ${iconSvg(imageMode ? 'image' : 'upload')}
        <strong>${imageMode ? '松开上传图片' : '松开上传文件'}</strong>
        <span>${imageMode ? '支持 PNG / JPG / WEBP' : '支持文档、PDF、PPTX 和图片附件'}</span>
      </div>
    </div>
  `;
}

function renderMessage(message, continuity = {}) {
  if (message?.role === 'assistant' && message?.metadata?.secretaryControl === true
    && message?.metadata?.welcome === true) return '';
  if (message.metadata?.transient === 'run-status') return renderRunStatusMessage(message, continuity);
  if (message.metadata?.uBuddyTaskQueued) return renderRunStatusMessage(message, continuity);
  if (message.metadata?.uBuddyTaskTerminalTaskRunId && message.metadata?.taskRunId
    && message.metadata?.uBuddyFinalDeliveryMessage !== true) return renderRunStatusMessage(message, continuity);
  if (message.metadata?.transient === 'process') return renderProcessMessage(message);
  if (message.metadata?.transient === 'stream') return renderStreamingMessage(message, continuity);
  const artifact = parseArtifactMessage(message.content);
  if (artifact?.kind === 'image') return renderImageArtifactMessage(artifact.data, message);
  if (artifact?.kind === 'ppt') return renderPptArtifactMessage(artifact.data, message);
  const attachments = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
  const fileReferences = Array.isArray(message.metadata?.fileReferences) ? message.metadata.fileReferences : [];
  const sourceContent = attachments.length ? stripAttachmentResourceBlock(message.content) : message.content;
  const controlMessageKind = message.role === 'assistant' && message.metadata?.secretaryControl === true
    ? uBuddyControlMessageKind(message.metadata)
    : '';
  const content = controlMessageKind
    ? uBuddyControlMessageText(controlMessageKind, message.metadata?.controlLanguage || state.languageMode)
    : message.role === 'assistant' && message.metadata?.secretaryControl === true
      ? translateUBuddyMessageText(sourceContent, state.languageMode)
      : sourceContent;
  const taskPublishProcess = normalizedUBuddyTaskPublishProcess(message.metadata?.uBuddyTaskPublishProcess);
  const avatar = renderStandardMessageAvatar(message);
  const avatarSlot = renderMessageAvatarSlot(avatar, continuity.consecutive);
  const clarificationPrompt = message.role === 'assistant'
    ? renderUBuddyExecutionModeChoice(message) || renderUBuddyClarificationPrompt(message)
    : '';
  const pendingDispatchAction = message.metadata?.dispatchAwaitingPresence === true
    ? `<button type="button" class="btn secondary ubuddy-pending-dispatch-cancel" data-cancel-pending-dispatch="${escapeAttr(message.metadata?.dispatchCommandId || '')}">${Number(message.metadata?.publishedRecipientCount || 0) > 0 ? '取消未上线成员补派' : '取消等待发布'}</button>`
    : '';
  const rendersUBuddyDeliveryCard = message.role === 'assistant'
    && Boolean(message.metadata?.deliverableResult)
    && Boolean(message.metadata?.taskRunId || message.metadata?.uBuddyTaskTerminalTaskRunId);
  const codexChangeSummary = message.role === 'assistant'
    ? renderCodexChangeSummary(message.metadata?.processEvents, { messageId: message.id })
    : '';
  const outputArtifactCards = codexChangeSummary
    ? ''
    : renderOutputArtifactCards(message.metadata?.outputArtifacts, message);
  return `
    <article class="message ${escapeAttr(message.role)} ${avatar ? 'has-chat-avatar' : ''} ${message.role === 'assistant' && isUBuddyComposerMode() ? 'is-ubuddy-response' : ''} ${continuousMessageClassNames(continuity)} ${attachments.length ? 'has-attachments' : ''}" data-message-id="${escapeAttr(message.id || '')}">
      ${message.role === 'assistant' ? avatarSlot : ''}
      <div class="message-shell">
        ${rendersUBuddyDeliveryCard ? '' : renderMessageHead(message)}
        ${message.metadata?.taskReference ? renderMessageTaskReference(message.metadata.taskReference) : ''}
        ${attachments.length ? renderMessageAttachmentCards(attachments) : ''}
        ${fileReferences.length ? renderMessageProjectReferences(fileReferences) : ''}
        ${message.role === 'assistant' ? renderProcessTimeline(message.metadata?.processEvents, {
          messageId: message.id,
          expanded: message.metadata?.expanded === true,
          historyExpanded: message.metadata?.historyExpanded === true,
          historyVisibleCount: Number(message.metadata?.historyVisibleCount || 0),
          durationMs: Number(message.metadata?.processDurationMs || 0),
          processStatus: taskPublishProcess?.status || (message.metadata?.failed
            ? 'failed'
            : message.metadata?.cancelled || message.metadata?.interrupted
              ? 'cancelled'
              : 'completed'),
          settledLabel: uBuddyTaskPublishProcessLabel(taskPublishProcess),
        }) : ''}
        ${message.role === 'assistant' ? renderSettledCollaborationProgress(message.metadata?.collaboration) : ''}
        ${clarificationPrompt || (message.role === 'user' && state.messageEditingId === message.id
          ? renderInlineMessageEditor(message)
          : message.role === 'assistant' && message.metadata?.deliverableResult
          ? renderFinalDeliverableCard(message.metadata.deliverableResult, {
              resultState: message.metadata.resultState || '',
              fallback: content,
              chatTaskRunId: String(message.metadata?.taskRunId || message.metadata?.uBuddyTaskTerminalTaskRunId || ''),
              messageSentAt: message.createdAt || message.created_at || '',
              showMessageTime: continuity.showMessageTime === true,
              acceptedActionTaskRunId: message.metadata?.uBuddyDeliveryAcceptedInPlace
                ? String(message.metadata?.taskRunId || message.metadata?.uBuddyTaskTerminalTaskRunId || '')
                : '',
            })
          : renderMessageResult(content, message))}
        ${renderPptRenderFailureDetails(message)}
        ${message.role === 'assistant' ? renderUBuddyCollaborationPlanningFailureCard(message.metadata?.uBuddyCollaborationPlanningFailure, message) : ''}
        ${message.role === 'assistant' ? renderUBuddyCollaborationPlanCard(message.metadata?.uBuddyCollaborationPlan, message) : ''}
        ${message.role === 'assistant' ? renderUBuddySelectionCard(message.metadata?.uBuddySelection) : ''}
        ${codexChangeSummary}
        ${renderMessageQuote(message.metadata?.quote)}
        ${outputArtifactCards}
        ${renderPublishedTaskCards(publishedTaskCardsForMessage(message), message.id || '')}
        ${renderCollaborationSummaryActions(message)}
        ${renderAgentDeliveryAction(message)}
        ${pendingDispatchAction}
        ${renderMessageFooter(message, message.role === 'user' ? '复制消息' : '复制回答')}
      </div>
      ${message.role === 'user' ? avatarSlot : ''}
    </article>
  `;
}

function renderUBuddyExecutionModeChoice(message = {}) {
  const choice = message.metadata?.uBuddyExecutionModeChoice;
  if (!choice || typeof choice !== 'object') return '';
  const choiceId = String(choice.choiceId || '').trim();
  const status = String(choice.status || 'pending');
  const selectedMode = String(choice.selectedMode || '');
  const recommendedMode = String(choice.recommendedMode || '');
  const taskActionsDisabled = uBuddyTaskActionsDisabled();
  const option = (mode, label, description) => {
    const recommended = recommendedMode === mode;
    const selected = selectedMode === mode;
    return `<button type="button" class="ubuddy-execution-mode-option${recommended ? ' is-recommended' : ''}${selected ? ' is-selected' : ''}"
      data-ubuddy-execution-mode="${escapeAttr(mode)}" data-ubuddy-execution-choice-id="${escapeAttr(choiceId)}"${status === 'resolved' || taskActionsDisabled ? ' disabled' : ''}>
      <span><strong>${escapeHtml(label)}</strong>${recommended ? '<em>推荐</em>' : ''}</span>
      <small>${escapeHtml(description)}</small>
    </button>`;
  };
  const selectedLabel = selectedMode === 'scheduler' ? '使用多 Agent 协作' : '由 uBuddy 直接完成';
  return `<section class="ubuddy-execution-mode-card is-${escapeAttr(status)}" aria-label="uBuddy 执行方式选择"${uBuddyTaskActionHintAttributes()}>
    <header><span>选择执行方式</span><small>${status === 'resolved' ? `已选择：${escapeHtml(selectedLabel)}` : '仅本次任务生效'}</small></header>
    <p>${escapeHtml(String(choice.routingRationale || '两种执行方式都可行，请选择更符合本次需求的一种。'))}</p>
    <div class="ubuddy-execution-mode-options">
      ${option('direct', '由 uBuddy 直接完成', choice.directModeSummary || '流程更快，不创建多 Agent 任务图。')}
      ${option('scheduler', '使用多 Agent 协作', choice.schedulerModeSummary || '拆分任务、跟踪进度、审核并统一交付。')}
    </div>
    <p class="ubuddy-clarification-error" data-ubuddy-execution-mode-error hidden></p>
  </section>`;
}

function renderUBuddyClarificationPrompt(message = {}) {
  const metadata = message.metadata || {};
  const legacy = metadata.clarification && typeof metadata.clarification === 'object' ? metadata.clarification : null;
  const questions = (Array.isArray(metadata.clarifications) && metadata.clarifications.length
    ? metadata.clarifications
    : legacy?.question ? [{ id: legacy.reasonCode || 'clarification_1', question: legacy.question, options: legacy.options || [], allowOther: true, required: true }] : [])
    .map((question, index) => ({ ...question, id: String(question.id || `question_${index + 1}`), question: String(question.question || '').trim() }))
    .filter((question) => question.question);
  if (!metadata.dispatchClarification || !questions.length) return '';
  const messageId = String(message.id || '').trim();
  const messageIndex = state.messages.findIndex((item) => item === message || (messageId && String(item?.id || '') === messageId));
  const laterMessages = messageIndex >= 0 ? state.messages.slice(messageIndex + 1) : [];
  const structuredResponse = laterMessages.find((item) => (
    item?.role === 'user'
    && item?.metadata?.uBuddyClarificationResponse === true
    && String(item.metadata?.sourceMessageId || '') === messageId
  ));
  const legacyResponse = laterMessages.find((item) => (
    item?.role === 'user'
    && item?.metadata?.uBuddyMessageMode !== 'ask'
    && item?.metadata?.uBuddyClarificationResponse !== true
  ));
  const pending = messageIndex >= 0 && !structuredResponse && !legacyResponse;
  if (!pending) {
    const receivedAnswers = Array.isArray(structuredResponse?.metadata?.uBuddyClarificationAnswers)
      ? structuredResponse.metadata.uBuddyClarificationAnswers.map((item) => String(item?.label || item?.value || '').trim()).filter(Boolean)
      : [];
    return `<section class="ubuddy-clarification-card is-resolved" aria-label="uBuddy 澄清问题">
      <header><span>需要确认</span><small>${structuredResponse ? '已接收答案' : '已通过后续消息回答'}</small></header>
      <p>${escapeHtml(questions.map((question) => question.question).join('；'))}</p>
      ${receivedAnswers.length ? `<div class="ubuddy-clarification-received"><strong>已确认</strong><span>${escapeHtml(receivedAnswers.join('；'))}</span></div>` : ''}
    </section>`;
  }
  if (!metadata.uBuddyPlanningCheckpoint) return renderExpiredUBuddyPlanningCard(message, '这张旧版澄清卡已过期，不能继续提交答案。');
  const draft = state.uBuddyClarificationDrafts?.[messageId] || {};
  const plan = metadata.uBuddyPreDispatchPlan || {};
  const planDetails = [
    ...(plan.executionPlan?.steps || []).map((step, index) => `${index + 1}. ${step}`),
    ...(plan.safeAssumptions || []).map((item) => `默认：${item}`),
  ];
  const executionTargetQuestion = questions.length === 1 && questions[0].answerType === 'execution_target'
    ? questions[0]
    : null;
  if (executionTargetQuestion) {
    const english = state.languageMode === 'en';
    const option = (target, icon, label, description) => `<button type="button" class="ubuddy-execution-target-option" data-ubuddy-execution-target="${escapeAttr(target)}"${uBuddyTaskActionsDisabled() ? ' disabled' : ''}>
      <span class="ubuddy-execution-target-icon" aria-hidden="true">${iconSvg(icon)}</span>
      <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span>
      <span class="ubuddy-execution-target-arrow" aria-hidden="true">${iconSvg('chevronRight')}</span>
    </button>`;
    return `<section class="ubuddy-clarification-card ubuddy-execution-target-card is-pending" aria-label="${english ? 'Choose who completes the task' : '选择任务执行方'}"${uBuddyTaskActionHintAttributes()}>
      <header><span>${english ? 'EXECUTION TARGET' : '选择执行方'}</span><small>${english ? 'No task has been created' : '尚未创建任务'}</small></header>
      <p>${escapeHtml(executionTargetQuestion.question)}</p>
      <div class="ubuddy-execution-target-options">
        ${option('local', 'tasks', english ? 'Complete locally' : '本地完成', english ? 'uBuddy will select an appropriate local Agent.' : '由 uBuddy 选择合适的本地 Agent 执行。')}
        ${option('contact', 'userPlus', english ? 'Complete with a contact' : '@ 联系人完成', english ? 'Open the contact list and choose a recipient.' : '打开联系人列表，明确选择任务接收人。')}
      </div>
      <footer><small>${english ? 'A contact is never selected from conversation history alone.' : '不会仅凭聊天记录自动选择联系人。'}</small></footer>
    </section>`;
  }
  const questionMarkup = questions.map((question, questionIndex) => {
    const options = (Array.isArray(question.options) ? question.options : []).map((option) => typeof option === 'string'
      ? { value: option.trim(), label: option.trim(), description: '' }
      : {
          value: String(option?.value || option?.label || '').trim(),
          label: String(option?.label || '').trim(),
          description: String(option?.description || '').trim(),
        }).filter((option) => option.label && option.value);
    const questionDraft = draft.answers?.[question.id] || (questions.length === 1 ? draft : {});
    const selectedValue = String(questionDraft.selectedValue || '');
    const name = `ubuddy-clarification-${messageId}-${question.id}`;
    const optionsMarkup = options.map((option) => {
      const optionValue = String(option.value || option.label);
      return `<label class="chat-user-input-option"><input type="radio" name="${escapeAttr(name)}" data-ubuddy-question-id="${escapeAttr(question.id)}" data-ubuddy-answer-label="${escapeAttr(option.label)}" value="${escapeAttr(optionValue)}"${selectedValue === optionValue ? ' checked' : ''}><span class="chat-user-input-radio" aria-hidden="true"></span><span class="chat-user-input-option-copy"><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</span></label>`;
    }).join('');
    const legacyInputId = questions.length === 1 ? ` id="ubuddy-clarification-input-${escapeAttr(messageId || messageIndex)}"` : '';
    const custom = `<label class="chat-user-input-option is-other"><input type="radio" name="${escapeAttr(name)}" data-ubuddy-question-id="${escapeAttr(question.id)}" value="__other__"${selectedValue === '__other__' ? ' checked' : ''}><span class="chat-user-input-radio" aria-hidden="true"></span><span class="chat-user-input-option-copy"><strong>其他答案</strong><small>输入更符合你实际情况的回答</small></span><textarea${legacyInputId} class="chat-user-input-other" data-ubuddy-clarification-other data-ubuddy-question-id="${escapeAttr(question.id)}" rows="2" placeholder="请输入你的答案">${escapeHtml(questionDraft.text || '')}</textarea></label>`;
    return `<fieldset class="ubuddy-clarification-question" data-ubuddy-question="${escapeAttr(question.id)}" data-required="${question.required === false ? 'false' : 'true'}"><legend><small>${escapeHtml(question.header || `问题 ${questionIndex + 1}`)}</small><strong>${escapeHtml(question.question)}</strong>${question.reason ? `<span>${escapeHtml(question.reason)}</span>` : ''}</legend><div class="chat-user-input-options">${optionsMarkup}${custom}</div></fieldset>`;
  }).join('');
  return `<section class="ubuddy-clarification-card is-pending" aria-label="uBuddy 等待用户回答"${uBuddyTaskActionHintAttributes()}>
    <header><span>派发前计划</span><small>尚未创建或派发任务</small></header>
    ${plan.executionPlan?.summary ? `<p><strong>执行方案：</strong>${escapeHtml(plan.executionPlan.summary)}</p>` : ''}
    ${planDetails.length || plan.knownFacts?.length || plan.criticalUnknowns?.length ? `<details class="ubuddy-plan-details"><summary>展开规划详情</summary><div>${planDetails.map((item) => `<p>${escapeHtml(item)}</p>`).join('')}${(plan.knownFacts || []).map((item) => `<p>已确认：${escapeHtml(item)}</p>`).join('')}${(plan.criticalUnknowns || []).map((item) => `<p>待确认：${escapeHtml(item.name || item)}</p>`).join('')}</div></details>` : ''}
    <form data-ubuddy-clarification-form="${escapeAttr(messageId)}">
      ${questionMarkup}
      <p class="ubuddy-clarification-error" data-ubuddy-clarification-error hidden></p>
      <footer><small>提交后 uBuddy 会重新规划并检查派发条件。</small><button type="submit"${uBuddyTaskActionsDisabled() ? ' disabled' : ''}>确认并继续</button></footer>
    </form>
  </section>`;
}

function renderUBuddyCollaborationPlanningFailureCard(failure = null, message = {}) {
  if (!failure || typeof failure !== 'object') return '';
  const status = String(failure.status || 'retryable');
  if (status === 'resolved') return '';
  if (status === 'retryable' && !message.metadata?.uBuddyPlanningCheckpoint) {
    return renderExpiredUBuddyPlanningCard(message, '这张旧版规划失败卡已过期，不能再调用旧分工链路。');
  }
  const codeLabels = {
    collaboration_assignment_timeout: '生成超时',
    collaboration_assignment_provider_failed: '模型服务暂时不可用',
    collaboration_assignment_invalid_json: '方案格式未通过检查',
    collaboration_assignment_validation_failed: '方案完整性未通过检查',
    collaboration_assignment_execution_failed: '方案生成未完成',
  };
  const label = codeLabels[failure.code] || '方案生成未完成';
  const disabledAttribute = uBuddyTaskActionsDisabled() ? ' disabled' : '';
  return `<section class="ubuddy-collaboration-planning-failure is-${escapeAttr(status)}" aria-label="uBuddy 多人分工生成状态"${uBuddyTaskActionHintAttributes()}>
    <header><span>多人分工方案</span><strong>${escapeHtml(status === 'cancelled' ? '已取消' : status === 'resolved' ? '已恢复' : '尚未生成')}</strong></header>
    <p>${escapeHtml(label)}。参与人选择和任务要求已保留，且没有派发任何任务。</p>
    ${status === 'retryable' ? `<footer>
      <button class="btn primary" type="button" data-ubuddy-planning-failure-action="重新生成分工方案"${disabledAttribute}>重新生成方案</button>
      <button class="btn ghost" type="button" data-ubuddy-planning-failure-action="取消本次协作"${disabledAttribute}>取消</button>
      <small title="${escapeAttr(String(failure.code || ''))}">错误编号：${escapeHtml(String(failure.code || 'unknown'))}</small>
    </footer>` : ''}
  </section>`;
}

function renderInlineMessageEditor(message = {}) {
  const draft = state.messageEditingDraft || stripAttachmentResourceBlock(message.content || '');
  return `<form class="message-inline-editor" data-message-rewrite-form="${escapeAttr(message.id || '')}">
    <textarea data-message-rewrite-input rows="3" aria-label="重新编辑已发送消息" ${state.messageEditingBusy ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>
    ${state.messageEditingError ? `<p>${escapeHtml(state.messageEditingError)}</p>` : ''}
    <div><button type="button" data-message-rewrite-cancel ${state.messageEditingBusy ? 'disabled' : ''}>取消</button><button type="submit" ${state.messageEditingBusy ? 'disabled' : ''}>${state.messageEditingBusy ? '正在重新生成…' : '保存并重新生成'}</button></div>
  </form>`;
}

function renderMessageProjectReferences(references = []) {
  return `<div class="message-project-references">${references.map((reference) => `<span>${iconSvg(reference.referenceKind === 'directory' ? 'folder' : 'document')}<b>${escapeHtml(reference.relativePath || reference.name || '项目文件')}</b><small>只读项目引用</small></span>`).join('')}</div>`;
}

function renderUBuddySelectionCard(value = null) {
  if (!value || typeof value !== 'object') return '';
  const candidateIds = Array.isArray(value.candidateUserIds) ? value.candidateUserIds : [];
  const selectedIds = new Set(Array.isArray(value.selectedUserIds) ? value.selectedUserIds : []);
  const rejected = new Map((value.selectionDecision?.rejectedCandidates || []).map((item) => [String(item.userId || ''), item]));
  const selected = candidateIds.filter((userId) => selectedIds.has(userId));
  const unselected = candidateIds.filter((userId) => !selectedIds.has(userId));
  const modeLabel = ({ explicit_single: '明确单人', all_selected: '用户要求全员', candidate_pool: '多人候选' })[value.selectionMode] || '参与人选择';
  const rationale = String(value.selectionDecision?.rationale || '').trim();
  return `<details class="ubuddy-selection-card" aria-label="参与人选择结果">
    <summary><span>参与人选择</span><strong>${escapeHtml(modeLabel)}</strong><em>${Math.round(Number(value.selectionDecision?.confidence || 0) * 100)}%</em><i>${iconSvg('chevronDown')}</i></summary>
    <div class="ubuddy-selection-content">
      <div class="ubuddy-selection-list is-selected"><b>已选择</b>${selected.map((userId) => { const online = selectionUserOnline(userId); return `<span><i class="contact-presence-dot ${online ? 'is-online' : 'is-offline'}" aria-hidden="true"></i>${escapeHtml(selectionUserLabel(userId))}<small>${online ? '在线' : '离线'}${(value.requiredUserIds || []).includes(userId) ? ' · 必须参与' : ''}</small></span>`; }).join('') || '<span>暂无</span>'}</div>
      ${unselected.length ? `<div class="ubuddy-selection-list is-rejected"><b>未选择</b>${unselected.map((userId) => `<span>${escapeHtml(selectionUserLabel(userId))}<small>${escapeHtml(rejected.get(userId)?.reason || '当前未进入最终派发')}</small></span>`).join('')}</div>` : ''}
      ${rationale ? `<p>${escapeHtml(translateUiText(rationale, state.languageMode))}</p>` : ''}
      ${value.selectionDecision?.strategyVersion ? `<small class="ubuddy-selection-strategy">${escapeHtml(value.selectionDecision.strategyVersion)}</small>` : ''}
    </div>
  </details>`;
}

function renderUBuddyCollaborationPlanCard(plan = null, message = {}) {
  if (!plan || typeof plan !== 'object') return '';
  if (plan.status === 'awaiting_confirmation' && !message.metadata?.uBuddyPlanningCheckpoint) {
    return renderExpiredUBuddyPlanningCard(message, '这张旧版待确认方案已过期，不能继续派发。');
  }
  const modeLabel = plan.collaborationMode === 'peer_collaboration' ? '同事协作 · 发起人参与' : '负责人派发 · 发起人协调';
  const assignments = Array.isArray(plan.assignments) ? plan.assignments : [];
  const assignmentLabels = new Map(assignments.map((item) => [String(item.assignmentId || ''),
    item.assigneeKind === 'self' ? '你（本地 uBuddy/Agent）' : selectionUserLabel(item.userId)]));
  const statusLabel = ({ awaiting_confirmation: '等待确认', confirmed: '已确认', cancelled: '已取消', superseded: '已替换' })[plan.status] || plan.status || '';
  const disabledAttribute = uBuddyTaskActionsDisabled() ? ' disabled' : '';
  return `<section class="ubuddy-collaboration-plan-card" aria-label="uBuddy 多人分工方案"${uBuddyTaskActionHintAttributes()}>
    <header><div><span>多人分工方案</span><strong>${escapeHtml(modeLabel)}</strong></div><em>${escapeHtml(statusLabel)}</em></header>
    <div class="ubuddy-collaboration-assignments">${assignments.map((item, index) => {
      const dependencies = (item.dependencies || []).map((id) => assignmentLabels.get(String(id)) || id).filter(Boolean);
      const online = item.assigneeKind === 'self' || selectionUserOnline(item.userId);
      return `<article><b>${index + 1}</b><div><strong><i class="contact-presence-dot ${online ? 'is-online' : 'is-offline'}" aria-hidden="true"></i>${escapeHtml(assignmentLabels.get(String(item.assignmentId || '')) || item.userId || '参与人')}<small>${item.assigneeKind === 'self' ? '本机' : online ? '在线' : '离线'}</small></strong><span>${escapeHtml(item.title || item.objective || '')}</span>${item.objective && item.objective !== item.title ? `<p>${escapeHtml(item.objective)}</p>` : ''}${dependencies.length ? `<small>依赖：${escapeHtml(dependencies.join('、'))}</small>` : ''}</div></article>`;
    }).join('')}</div>
    <footer><span>最终整合：发起人的 uBuddy</span>${plan.status === 'awaiting_confirmation' ? `<div>
      <button class="btn primary" type="button" data-ubuddy-plan-action="确认派发"${disabledAttribute}>确认派发</button>
      <button class="btn secondary" type="button" data-ubuddy-plan-action="修改方案"${disabledAttribute}>修改</button>
      <button class="btn secondary" type="button" data-ubuddy-plan-action="全员参与"${disabledAttribute}>全员参与</button>
      <button class="btn ghost" type="button" data-ubuddy-plan-action="取消方案"${disabledAttribute}>取消</button>
    </div>` : ''}</footer>
  </section>`;
}

function renderExpiredUBuddyPlanningCard(message = {}, detail = '') {
  const sourceMessageId = String(message.metadata?.sourceMessageId || message.id || '').trim();
  const disabledAttribute = uBuddyTaskActionsDisabled() || !sourceMessageId ? ' disabled' : '';
  return `<section class="ubuddy-clarification-card is-resolved" aria-label="旧版 uBuddy 规划已过期"${uBuddyTaskActionHintAttributes()}>
    <header><span>规划已过期</span><small>未创建或派发任务</small></header>
    <p>${escapeHtml(detail || '这张卡片来自旧版规划链路，不能继续操作。')}</p>
    <footer><small>重启会恢复原任务的参与人、附件和引用，并创建新的持续规划会话。</small><button type="button" data-ubuddy-planning-restart="${escapeAttr(sourceMessageId)}"${disabledAttribute}>重新开始规划</button></footer>
  </section>`;
}

function uBuddyTaskActionsDisabled() {
  return state.uBuddyFeatureFlags?.messageModeV1 === true && state.uBuddyMessageMode === 'ask';
}

function uBuddyTaskActionHintAttributes() {
  return uBuddyTaskActionsDisabled()
    ? ` title="${escapeAttr('当前为讨论模式，切换到任务模式后可操作')}" data-ubuddy-task-actions-disabled="true"`
    : '';
}

function selectionUserLabel(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return '未知用户';
  if (id === state.currentUser?.id) return currentUserDisplayName();
  const relationship = (state.friendOverview?.friends || []).find((item) => String((item.friend || item.user || item)?.id || '') === id);
  if (relationship) return socialFriendName(relationship.friend || relationship.user || relationship);
  for (const organization of state.friendOverview?.organizations || []) {
    const member = (organization.members || []).find((item) => String(item?.user?.id || '') === id);
    if (member?.user) return socialFriendName(member.user);
  }
  return id;
}

function selectionUserOnline(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return false;
  if (id === String(state.currentUser?.id || '')) return true;
  const relationship = (state.friendOverview?.friends || []).find((item) => (
    String((item.friend || item.user || item)?.id || '') === id
  ));
  if (relationship) return relationship.online === true || relationship.friend?.online === true || relationship.user?.online === true;
  for (const organization of state.friendOverview?.organizations || []) {
    const member = (organization.members || []).find((item) => String(item?.user?.id || '') === id);
    if (member) return member.online === true || member.user?.online === true;
  }
  return false;
}

function renderMessageTaskReference(reference = {}) {
  return `<div class="message-task-reference"><span>${iconSvg('tasks')}<b>${escapeHtml(reference.displayText || (reference.createNewTask ? '@新任务' : '@任务'))}</b><small>${reference.createNewTask ? '独立新任务' : '结构化任务引用'}</small></span></div>`;
}

function renderPublishedTaskCards(cards = [], hostMessageId = '') {
  const items = Array.isArray(cards) ? cards : [];
  if (!items.length) return '';
  return `<section class="ubuddy-published-task-cards" aria-label="已发布任务">${items.map((card) => {
    const workspaceId = card.taskWorkspaceId || card.task_workspace_id || card.delegationId || card.sourceContext?.task_workspace_id || '';
    const workspaceKind = card.workspaceKind || card.workspace_kind || (card.delegationId ? 'delegation' : card.targetSessionId ? 'agent_session' : card.taskRunId ? 'task_run' : 'delegation');
    const liveTask = workspaceKind === 'delegation'
      ? (state.agentDelegations || []).find((task) => task.id === (card.delegationId || workspaceId)) || null
      : workspaceKind === 'task_run'
        ? (state.tasks || []).find((task) => task.id === (card.taskRunId || workspaceId)) || null
        : null;
    const status = String(
      liveTask?.status
      || (workspaceKind === 'agent_session' ? agentSessionPublishedTaskStatus(card) : '')
      || card.status
      || 'assigned',
    );
    const task = {
      id: workspaceId,
      delegationId: card.delegationId || '',
      workspaceKind,
      targetSessionId: card.targetSessionId || '',
      workId: card.workId || '',
      title: liveTask?.title || card.title || 'uBuddy 任务',
      instruction: liveTask?.instruction || card.instruction || '',
      status,
      groupId: liveTask?.groupId || liveTask?.group_id || liveTask?.metadata?.groupId || card.groupId || '',
      taskRunId: liveTask?.taskRunId || liveTask?.task_run_id || liveTask?.metadata?.activeTaskRunId || card.taskRunId || '',
      metadata: {
        ...(card.sourceContext || {}),
        ...(liveTask?.metadata || {}),
        task_workspace_id: workspaceId,
      },
    };
    return renderTaskCardArticle(task, {
      label: '任务已发布',
      returnAnchorId: card.returnAnchorId || card.hostMessageId || hostMessageId,
      sourceContext: { ...(card.sourceContext || {}), returnSurface: 'session' },
    });
  }).join('')}</section>`;
}

function renderTaskCardArticle(task = {}, { label = '任务', returnAnchorId = '', sourceContext = {} } = {}) {
  const status = String(task.status || 'assigned');
  const ownerUserId = String(
    task.recipientUserId || task.recipient_user_id
      || task.metadata?.responsibleUBuddyOwnerUserId
      || task.metadata?.recipientUserId || task.metadata?.recipient_user_id
      || state.currentUser?.id || '',
  ).trim();
  const owner = collaborationMemberUser(ownerUserId);
  const ownerName = ownerUserId === String(state.currentUser?.id || '')
    ? currentUserDisplayName()
    : socialFriendName(owner || { id: ownerUserId });
  const uBuddyTitle = `${ownerName || '成员'}的 uBuddy`;
  const ownerTone = uBuddyOwnerTone(ownerUserId);
  const terminal = ['result_accepted', 'closed', 'completed', 'declined', 'withdrawn', 'rejected', 'failed', 'cancelled'].includes(status);
  const resultReady = ['submitted', 'result_accepted', 'completed', 'closed'].includes(status);
  const context = {
    ...(task.metadata || {}),
    ...(sourceContext || {}),
  };
  const workspaceKind = String(task.workspaceKind || task.workspace_kind || 'delegation');
  const canOpenFlow = workspaceKind !== 'agent_session' || Boolean(task.taskRunId || task.task_run_id);
  const taskWorkspaceUiEnabled = state.uBuddyFeatureFlags?.newTaskWorkspaceUi !== false;
  const publicProgress = task.metadata?.executionProgress || null;
  const publicTotal = Math.max(0, Number(publicProgress?.total || 0));
  const publicCompleted = Math.max(0, Number(publicProgress?.completed || 0));
  const publicPercent = publicTotal ? Math.max(0, Math.min(100, Math.round((publicCompleted / publicTotal) * 100))) : 0;
  const publicNodes = Array.isArray(publicProgress?.nodes) ? publicProgress.nodes : [];
  const cancelLabel = workspaceKind === 'agent_session'
    ? '停止单 Agent 任务'
    : workspaceKind === 'task_run'
      ? (task.groupId ? '停止本地 Agent 流程' : '停止整个任务')
      : task.groupId ? '取消此成员任务' : '取消任务';
  return `<article class="ubuddy-published-task-card collaboration-card status-${escapeAttr(status)}" data-task-workspace-id="${escapeAttr(task.id || '')}">
    <div class="ubuddy-published-task-card-head"><span class="network-secretary-avatar is-owner-ubuddy owner-tone-${ownerTone}" title="${escapeAttr(uBuddyTitle)}" aria-label="${escapeAttr(`${uBuddyTitle}的头像`)}">${iconSvg('spark')}</span><span><small>${escapeHtml(`${label} · ${uBuddyTitle}`)}</small><strong>${escapeHtml(task.title || 'uBuddy 任务')}</strong></span><b>${escapeHtml(taskStatusLabel(status))}</b></div>
    ${task.instruction ? `<p>${escapeHtml(clipInline(task.instruction, 180))}</p>` : ''}
    ${publicProgress ? `<div class="ubuddy-published-task-card-progress"><span>${escapeHtml(publicProgress.message || publicProgress.currentStep?.title || 'uBuddy 正在处理')}</span>${publicTotal ? `<small>${publicCompleted}/${publicTotal}</small><div><i style="width:${publicPercent}%"></i></div>` : ''}</div>` : ''}
    ${publicNodes.length ? `<details class="ubuddy-published-task-public-nodes"${taskDisclosureAttributes(`${task.id || task.taskRunId || 'task'}:public-nodes`, !terminal)}><summary>公开节点状态 <span>${publicCompleted}/${publicTotal || publicNodes.length}</span></summary><div>${publicNodes.map((node) => `<article class="is-${escapeAttr(node.status || 'pending')}"><span>${escapeHtml(node.title || '任务节点')}</span><small>${node.agentName ? `${escapeHtml(node.agentName)} · ` : ''}${escapeHtml(taskNodeStatusLabel(node.status))}</small></article>`).join('')}</div></details>` : ''}
    <div class="ubuddy-published-task-card-actions">
      ${taskWorkspaceUiEnabled ? `<button class="btn primary" type="button" ${taskCardActionAttributes(TASK_CARD_ACTIONS.OPEN_WORKSPACE, task, { sourceContext: context, returnAnchorId })}>打开任务工作区</button>` : ''}
      ${taskWorkspaceUiEnabled && resultReady ? `<button class="btn secondary" type="button" ${taskCardActionAttributes(TASK_CARD_ACTIONS.OPEN_RESULT, task, { sourceContext: context, returnAnchorId })}>查看结果</button>` : ''}
      ${terminal ? '' : `<button class="btn secondary muted" type="button" ${taskCardActionAttributes(TASK_CARD_ACTIONS.CANCEL_TASK, task, { sourceContext: context, returnAnchorId })}>${escapeHtml(cancelLabel)}</button>`}
    </div>
  </article>`;
}

function taskDisclosureAttributes(key = '', defaultOpen = false) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return defaultOpen ? ' open' : '';
  const hasState = Object.prototype.hasOwnProperty.call(state.taskDisclosureOpenByKey || {}, cleanKey);
  const open = hasState ? Boolean(state.taskDisclosureOpenByKey[cleanKey]) : Boolean(defaultOpen);
  return ` data-task-disclosure-key="${escapeAttr(cleanKey)}"${open ? ' open' : ''}`;
}

function renderConversationPublishedTaskCards(sourceConversationId = '', existingMessages = []) {
  const existingKeys = new Set((Array.isArray(existingMessages) ? existingMessages : []).flatMap((message) => (
    Array.isArray(message?.metadata?.publishedTaskCards) ? message.metadata.publishedTaskCards : []
  )).flatMap((card) => [card.delegationId, card.taskWorkspaceId, card.task_workspace_id, card.taskRunId, card.task_run_id].map((value) => String(value || '').trim()).filter(Boolean)));
  const tasks = (state.agentDelegations || []).filter((task) => {
    const context = normalizeTaskSourceContext(task.metadata || {});
    const taskKeys = [task.id, task.taskRunId, task.task_run_id, task.metadata?.activeTaskRunId].map((value) => String(value || '').trim());
    return context.source_conversation_id === String(sourceConversationId || '').trim()
      && !taskKeys.some((key) => key && existingKeys.has(key));
  }).sort((left, right) => String(left.createdAt || left.created_at || '').localeCompare(String(right.createdAt || right.created_at || '')));
  const groups = new Map();
  for (const task of tasks) {
    const context = normalizeTaskSourceContext(task.metadata || {});
    const sourceMessageId = context.source_message_id || `legacy:${task.id}`;
    const group = groups.get(sourceMessageId) || [];
    group.push(task);
    groups.set(sourceMessageId, group);
  }
  return [...groups.entries()].map(([sourceMessageId, groupTasks]) => {
    const first = groupTasks[0] || {};
    const sourceText = String(first.metadata?.originalInstruction || first.instruction || '通过 uBuddy 发起任务').trim();
    const cards = [...new Map(groupTasks.map((task) => {
      const key = `${String(task.title || '').trim()}\n${String(task.instruction || '').trim()}`;
      return [key, task];
    })).values()].map((task) => ({
      delegationId: task.id,
      title: task.title,
      instruction: task.instruction,
      status: task.status,
      groupId: task.groupId || task.group_id || task.metadata?.groupId || '',
      taskRunId: task.taskRunId || task.task_run_id || task.metadata?.activeTaskRunId || '',
      sourceContext: normalizeTaskSourceContext(task.metadata || {}),
    }));
    return `<section class="direct-private-task-thread" data-task-source-message-id="${escapeAttr(sourceMessageId)}">
      <article class="message user social-group-message direct-social-message direct-private-task-source" data-message-id="${escapeAttr(sourceMessageId)}">
        <div class="message-shell"><div class="social-message-actor"><span>我 · 仅自己可见</span></div><div class="message-body">${formatText(sourceText)}</div></div>
      </article>
      ${renderPublishedTaskCards(cards, sourceMessageId)}
    </section>`;
  }).join('');
}

function taskCardActionAttributes(action = '', task = {}, { sourceContext = {}, returnAnchorId = '' } = {}) {
  const context = normalizeTaskSourceContext({
    ...(task.metadata || {}),
    ...(sourceContext || {}),
    task_workspace_id: task.id || task.taskWorkspaceId || '',
  });
  const taskRunId = String(task.taskRunId || task.task_run_id || task.metadata?.activeTaskRunId || '').trim();
  const groupId = String(task.groupId || task.group_id || task.metadata?.groupId || '').trim();
  const workspaceKind = String(task.workspaceKind || task.workspace_kind || (task.delegationId ? 'delegation' : 'delegation')).trim();
  return [
    `data-task-card-action="${escapeAttr(action)}"`,
    `data-task-workspace-id="${escapeAttr(context.task_workspace_id)}"`,
    `data-task-source-conversation-id="${escapeAttr(context.source_conversation_id)}"`,
    `data-task-source-message-id="${escapeAttr(context.source_message_id)}"`,
    `data-task-source-group-id="${escapeAttr(context.source_group_id)}"`,
    `data-task-return-anchor-id="${escapeAttr(returnAnchorId)}"`,
    `data-task-return-surface="${escapeAttr(sourceContext.returnSurface || '')}"`,
    `data-task-group-id="${escapeAttr(groupId)}"`,
    `data-task-run-id="${escapeAttr(taskRunId)}"`,
    `data-task-workspace-kind="${escapeAttr(workspaceKind)}"`,
    `data-task-target-session-id="${escapeAttr(task.targetSessionId || task.target_session_id || '')}"`,
    `data-task-work-id="${escapeAttr(task.workId || task.work_id || '')}"`,
  ].join(' ');
}

function publishedTaskCardsForMessage(message = {}) {
  const messageId = String(message.id || '').trim();
  const attached = publishedTaskCardsByMessageId?.get(messageId) || buildPublishedTaskCardIndex(state.messages).get(messageId) || [];
  return attached;
}

function buildPublishedTaskCardIndex(messages = []) {
  const allMessages = Array.isArray(messages) ? messages : [];
  const sourceMessageIds = new Set(allMessages.map((item) => String(item.id || '').trim()).filter(Boolean));
  const progressHostByTaskRunId = new Map();
  for (const message of allMessages) {
    const taskRunId = String(message?.metadata?.taskRunId || message?.metadata?.taskSnapshot?.taskRunId || '').trim();
    if (!taskRunId || !message?.id) continue;
    if (message.metadata?.uBuddyTaskQueued || message.metadata?.uBuddyTaskTerminalTaskRunId || message.metadata?.transient === 'run-status') {
      progressHostByTaskRunId.set(taskRunId, String(message.id));
    }
  }
  const byMessageId = new Map();
  const indexesByMessageId = new Map();
  for (const host of allMessages) {
    const hostId = String(host.id || '').trim();
    for (const card of Array.isArray(host.metadata?.publishedTaskCards) ? host.metadata.publishedTaskCards : []) {
      const sourceId = normalizeTaskSourceContext(card.sourceContext || card).source_message_id;
      const cardTaskRunId = String(card.taskRunId || card.task_run_id || '').trim();
      const targetId = progressHostByTaskRunId.get(cardTaskRunId)
        || (sourceId && sourceMessageIds.has(sourceId) ? sourceId : hostId);
      if (!targetId) continue;
      const key = String(card.taskWorkspaceId || card.task_workspace_id || card.delegationId || card.taskRunId || card.workId || '');
      if (!key) continue;
      const cards = byMessageId.get(targetId) || [];
      const indexes = indexesByMessageId.get(targetId) || new Map();
      if (indexes.has(key)) cards[indexes.get(key)] = card;
      else {
        indexes.set(key, cards.length);
        cards.push(card);
      }
      indexesByMessageId.set(targetId, indexes);
      byMessageId.set(targetId, cards);
    }
  }
  return byMessageId;
}

function agentSessionPublishedTaskStatus(card = {}) {
  const workId = String(card.workId || card.work_id || '').trim();
  if (!workId) return '';
  const notification = [...(state.messages || [])].reverse().find((message) => (
    String(message.metadata?.workId || '') === workId
    && (message.metadata?.agentDeliveryCompleted || message.metadata?.agentDeliveryFailed || message.metadata?.agentDeliveryCancelled)
  ));
  if (notification?.metadata?.agentDeliveryCancelled) return 'cancelled';
  if (notification?.metadata?.agentDeliveryFailed || notification?.metadata?.agentDeliveryNeedsRevision) return 'failed';
  if (notification?.metadata?.agentDeliveryCompleted) return 'completed';
  for (const runs of Object.values(state.agentDeliveryRunsBySession || {})) {
    const receipt = (Array.isArray(runs) ? runs : []).find((item) => item.workId === workId);
    if (receipt?.deliveryStatus) return String(receipt.deliveryStatus);
  }
  return '';
}

function renderMessageResult(content = '', message = {}) {
  if (message.metadata?.organizationResearchResultId) return renderOrganizationResearchResult(content, message);
  return renderMessageBody(content, message);
}

function renderOrganizationResearchResult(content = '', message = {}) {
  const loaded = state.organizationResearchResultsByMessageId?.[message.id] || null;
  const citations = loaded?.citations || message.metadata?.organizationResearchCitations || [];
  const placeholder = /^\[organization-research-result:[^\]]+\]$/.test(String(content || '').trim());
  const body = loaded?.answer || (placeholder ? '' : content);
  const resultId = String(message.metadata?.organizationResearchResultId || '');
  const organizationId = String(message.metadata?.organizationResearchOrganizationId || '');
  return `<section class="organization-research-answer ${body ? '' : 'is-locked'}">
    ${body ? `<div class="message-body">${formatText(body)}</div>` : `<div class="organization-research-locked"><span>${iconSvg('lock')}</span><strong>组织调查结果已加密</strong><button class="btn secondary" type="button" data-organization-research-result="${escapeAttr(resultId)}" data-organization-id="${escapeAttr(organizationId)}" data-message-id="${escapeAttr(message.id || '')}">查看结果</button></div>`}
    ${citations.length ? `<div class="organization-research-citations"><strong>来源</strong>${citations.map((citation, index) => `<button type="button" data-organization-research-source data-organization-id="${escapeAttr(citation.organizationId || organizationId)}" data-source-kind="${escapeAttr(citation.sourceKind || '')}" data-source-message-id="${escapeAttr(citation.messageId || '')}"><span>${index + 1}</span><div><strong>${escapeHtml(citation.author || '组织成员')}</strong><small>${escapeHtml(formatMessageTime(citation.timestamp || ''))}${citation.attachmentNames?.length ? ` · ${escapeHtml(citation.attachmentNames.join('、'))}` : ''}</small></div>${iconSvg('chevronRight')}</button>`).join('')}</div>` : ''}
  </section>`;
}

function renderMessageBody(content = '', message = {}) {
  const text = String(content || '').trim();
  if (!text) return '';
  const formatted = formatMessageTextWithSkillCommands(text, message);
  if (message.role === 'assistant' && isUBuddyComposerMode() && uBuddyResponseNeedsCollapse(text)) {
    const expanded = Boolean(state.uBuddyExpandedMessageIds?.[message.id]);
    return `<div class="ubuddy-long-response ${expanded ? 'is-expanded' : 'is-collapsed'}"><div class="message-body">${formatted}</div><button type="button" data-long-message-toggle="${escapeAttr(message.id || '')}" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? '收起' : '查看全部'}</button></div>`;
  }
  return `<div class="message-body">${formatted}</div>`;
}

function formatMessageTextWithSkillCommands(content = '', message = {}) {
  let markup = formatText(content);
  if (message.role !== 'user') return markup;
  const skillTokens = normalizeMentionEntities(message.metadata?.mentions, {
    content,
    requirePicker: true,
  }).filter((mention) => mention.principalType === 'skill')
    .map((mention) => mention.displayText)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const token of [...new Set(skillTokens)]) {
    const escapedToken = escapeHtml(token);
    markup = markup.replaceAll(escapedToken, `<mark class="skill-command-token">${escapedToken}</mark>`);
  }
  return markup;
}

function uBuddyResponseNeedsCollapse(content = '') {
  const text = String(content || '').trim();
  return text.length > 520 || text.split('\n').length > 12;
}

function renderPptRenderFailureDetails(message = {}) {
  if (message.metadata?.pptRenderFailed !== true) return '';
  const detail = String(message.metadata?.errorDetail || message.metadata?.error || '').trim();
  if (!detail) return '';
  const code = String(message.metadata?.errorCode || 'ppt_render_failed').trim();
  return `<details class="ppt-render-failure-details"><summary>错误详情</summary><div><code>${escapeHtml(code)}</code><pre>${escapeHtml(detail)}</pre></div></details>`;
}

function renderMessageQuote(value = null) {
  const quote = normalizeMessageQuote(value);
  if (!quote) return '';
  const excerpt = clipInline(quote.excerpt, 120);
  return `<blockquote class="message-quote" data-quoted-message-id="${escapeAttr(quote.sourceMessageId)}" title="${escapeAttr(`${quote.authorLabel}：${quote.excerpt}`)}"><strong>${escapeHtml(quote.authorLabel)}</strong><span>${escapeHtml(excerpt)}</span></blockquote>`;
}

function renderForwardedMessage(value = null, fallbackContent = '') {
  if (!value || typeof value !== 'object') return '';
  const author = String(value.authorLabel || '原消息').trim();
  const content = String(value.excerpt || fallbackContent || '').trim();
  if (!content) return '';
  return `<div class="message-body forwarded-message"><header><span>${iconSvg('share')}</span><span><strong>转发的消息</strong><small>来自 ${escapeHtml(author)}</small></span></header><div class="forwarded-message-content">${formatText(content)}</div></div>`;
}

function renderAgentDeliveryAction(message = {}) {
  const metadata = message.metadata || {};
  if (!metadata.targetSessionId || (!metadata.agentDeliveryCompleted && !metadata.agentDeliveryFailed)) return '';
  return `<div class="collaboration-summary-actions"><button class="btn primary" type="button" data-agent-delivery-session="${escapeAttr(metadata.targetSessionId)}">打开 Agent 回复</button></div>`;
}

function renderCollaborationSummaryActions(message = {}) {
  const metadata = message.metadata || {};
  if (!metadata.collaborationGroupSummaryCandidate) return '';
  if (metadata.summaryInvalidated) return '<div class="collaboration-summary-actions"><span>任务已变化，此汇总已失效。</span></div>';
  if (metadata.publishedAt) return '<div class="collaboration-summary-actions"><span>已发布到任务群</span></div>';
  if (metadata.summaryType !== 'final') return '<div class="collaboration-summary-actions"><span>进度摘要，仅供私下查看</span></div>';
  return `<div class="collaboration-summary-actions"><button class="btn primary" type="button" data-publish-collaboration-summary="${escapeAttr(message.id)}" data-collaboration-summary-group="${escapeAttr(metadata.groupId || '')}">确认并发布到任务群</button></div>`;
}

export function renderMessageAttachmentCards(attachments = []) {
  return `
    <div class="message-attachments compact-attachment-strip">
      ${attachments.map((item) => {
        const file = normalizeFilePayload(item);
        const payload = filePayloadAttr(file);
        const visualKind = attachmentVisualKind({ kind: file.kind, uploaded: { filename: file.name }, name: file.name });
        if (visualKind === 'image') {
          const imageUrl = attachmentImageUrl(file);
          return `
          <figure class="message-attachment-card message-attachment-image-card compact-message-image ${imageUrl ? 'has-image-source' : 'is-remote-placeholder'}" title="${escapeAttr(file.name)}">
            <button class="message-attachment-image-main" type="button" data-preview-file="${payload}" data-image-context-file="${payload}" aria-label="预览图片 ${escapeAttr(file.name)}">
              ${imageUrl
                ? `<img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(file.name)}" loading="lazy" />`
                : `<span class="message-attachment-image-placeholder">${iconSvg('image')}<small>点击加载</small></span>`}
            </button>
            <figcaption>
              <span class="message-attachment-text"><strong>${escapeHtml(file.name)}</strong></span>
              ${renderFileActionButtons(file, 'message-attachment-actions')}
            </figcaption>
          </figure>
        `;
        }
        return `
          <div class="message-attachment-card" title="${escapeAttr(file.name)}">
            <button class="message-attachment-main" type="button" data-preview-file="${payload}">
              <span class="message-attachment-icon attachment-kind-${escapeAttr(visualKind)}">${messageAttachmentIcon(file, visualKind)}</span>
              <span class="message-attachment-text">
                <strong>${escapeHtml(file.name)}</strong>
                <small>${escapeHtml(messageAttachmentKindLabel(visualKind))}${file.size ? ` · ${escapeHtml(formatBytes(file.size))}` : ''}</small>
              </span>
            </button>
            ${renderFileActionButtons(file, 'message-attachment-actions')}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderFavoriteEmojiAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).map((item) => {
    const sourceItem = item && typeof item === 'object' ? item : {};
    const file = normalizeFilePayload(sourceItem);
    const favorite = normalizeEmojiFavorites(state.composerFavoriteEmojis || []).find((entry) => entry.kind === 'image' && ((file.sha256 && entry.sha256 === file.sha256) || (file.remote_file_id && entry.id === file.remote_file_id) || (file.remoteFileId && entry.id === file.remoteFileId) || (file.name && (entry.filename === file.name || entry.name === file.name))));
    const candidates = [sourceItem.value, sourceItem.url, sourceItem.file_url, sourceItem.preview_url, favorite?.value, favorite?.url, attachmentImageUrl(file)].map((value) => String(value || '').trim());
    // Prefer the original bytes carried by the message over an asynchronously
    // generated preview URL, which can briefly be blank or malformed.
    const imageUrl = candidates.find((value) => value.startsWith('data:image/'))
      || candidates.find(isImageSource)
      || '';
    const payload = filePayloadAttr(file);
    const remotePayload = file.remote_file_id || file.remoteFileId ? ` data-favorite-emoji-remote="${escapeAttr(payload)}"` : '';
    const fallback = `<span class="message-favorite-emoji-placeholder" title="表情图片暂未加载"></span>`;
    return `<button class="message-favorite-emoji-image ${imageUrl ? 'has-image-source' : 'is-loading'}" type="button" data-favorite-emoji-file="${escapeAttr(payload)}" data-image-context-file="${escapeAttr(payload)}"${remotePayload} aria-label="查看大图">${imageUrl ? renderEmojiAsset(imageUrl, '表情', 'message') : fallback}</button>`;
  }).join('');
}

function renderEmojiAsset(source = '', name = '表情', mode = 'favorite') {
  const imageUrl = String(source || '').trim();
  if (!imageUrl) return '';
  if (mode === "message") return `<img class="message-favorite-emoji-img" src="${escapeAttr(imageUrl)}" alt="${escapeAttr(name)}" loading="eager" decoding="sync" />`;
  return `<span class="emoji-asset-slot emoji-asset-${escapeAttr(mode)}"><img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(name)}" loading="eager" decoding="async" /></span>`;
}

function renderOutputArtifactCards(artifacts = [], message = {}) {
  const files = (Array.isArray(artifacts) ? artifacts : []).map((artifact) => normalizeFilePayload({
    ...artifact,
    messageId: message.id || '',
    sessionId: message.sessionId || message.session_id || state.currentSessionId || '',
  })).filter((file) => file.path || file.relative_path || file.remote_file_id);
  if (!files.length) return '';
  return `<details class="message-output-artifacts" aria-label="输出文件">
    <summary class="message-output-artifacts-head"><strong>输出文件</strong><span>${files.length} 个</span></summary>
    <div class="message-output-artifact-list">${files.map((file) => {
      const payload = filePayloadAttr(file);
      const visualKind = attachmentVisualKind({ kind: file.kind, uploaded: { filename: file.name }, name: file.name });
      const imageUrl = visualKind === 'image' ? (file.file_url || file.fileUrl || '') : '';
      return `<article class="message-output-artifact">
        <button class="message-output-artifact-main" type="button" data-preview-file="${payload}"${visualKind === 'image' ? ` data-image-context-file="${payload}"` : ''}>
          ${imageUrl
            ? `<img class="message-output-artifact-thumb" src="${escapeAttr(imageUrl)}" alt="${escapeAttr(file.name)}" />`
            : `<span class="message-attachment-icon attachment-kind-${escapeAttr(visualKind)}">${messageAttachmentIcon(file, visualKind)}</span>`}
          <span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(messageAttachmentKindLabel(visualKind))}${file.size ? ` · ${escapeHtml(formatBytes(file.size))}` : ''}</small></span>
        </button>
        ${renderFileActionButtons(file, 'message-output-artifact-actions')}
      </article>`;
    }).join('')}</div>
  </details>`;
}

function renderRunStatusMessage(message, continuity = {}) {
  const metadata = message.metadata || {};
  const content = String(message.content || '').trim();
  if (!content) return '';
  const taskRunId = String(metadata.taskRunId || metadata.taskSnapshot?.taskRunId || '').trim();
  const externalDelegationId = String(metadata.externalDelegationId || '').trim();
  const liveDelegation = externalDelegationId
    ? (state.agentDelegations || []).find((item) => item.id === externalDelegationId) || null
    : null;
  const liveDelegationProgress = externalDelegationId
    ? state.networkDelegationProgressById?.[externalDelegationId] || liveDelegation?.metadata?.executionProgress || null
    : null;
  const attachedCards = publishedTaskCardsForMessage(message);
  const mergedTaskCard = attachedCards.find((card) => publishedCardMatchesTask(card, taskRunId)) || null;
  const publishedCards = renderPublishedTaskCards(attachedCards.filter((card) => card !== mergedTaskCard), message.id || '');
  const pptProgress = metadata.pptProgress && typeof metadata.pptProgress === 'object' ? metadata.pptProgress : null;
  const taskProgress = metadata.taskSnapshot?.progress || metadata.taskProgress || liveDelegationProgress || null;
  const externalDelegationActions = renderExternalDelegationRunActions(metadata);
  const hasTaskProgress = Boolean(metadata.taskRunId || metadata.objective || taskProgress || externalDelegationId);
  const progressNodes = Array.isArray(taskProgress?.nodes) ? taskProgress.nodes : [];
  const taskPublishProcess = renderPersistedUBuddyTaskPublishProcess(message);
  if (hasTaskProgress) return `${taskPublishProcess}${renderCollaborationRunProgress({
    content: taskProgress?.message || content,
    taskRunId,
    delegationId: mergedTaskCard?.delegationId || externalDelegationId,
    title: mergedTaskCard?.title || liveDelegation?.title || '',
    taskCard: mergedTaskCard,
    taskType: metadata.taskType || '',
    objective: metadata.objective || null,
    phase: metadata.taskSnapshot?.phase || taskProgress?.phase || metadata.stage || 'preparing',
    taskStatus: metadata.taskSnapshot?.taskStatus || taskProgress?.taskStatus || liveDelegation?.status || '',
    progress: taskProgress || {},
    activeNodes: metadata.taskSnapshot?.activeNodes || metadata.activeNodes
      || progressNodes.filter((node) => ['ready', 'queued', 'running'].includes(String(node.status || ''))),
    milestones: metadata.progressMilestones || taskProgress?.milestones || [],
    blocker: metadata.blocker || taskProgress?.blocker || null,
    deliverable: metadata.deliverableResult || metadata.taskSnapshot?.deliverable || null,
    resultState: metadata.resultState || metadata.taskSnapshot?.resultState || '',
    technicalDetails: metadata.taskSnapshot?.technicalDetails || null,
    coordinationSnapshot: metadata.taskSnapshot?.coordination || metadata.coordinationSnapshot || null,
    continuedByTaskRunId: metadata.continuedByTaskRunId || metadata.taskSnapshot?.continuedByTaskRunId || '',
    processOnly: Boolean(metadata.processOnly),
    terminal: Boolean(metadata.terminal),
    sourceContext: {
      ...(mergedTaskCard?.sourceContext || {}),
      source_conversation_id: state.currentSessionId || '',
      source_message_id: message.id || '',
      returnSurface: 'session',
    },
    createdAt: message.createdAt || message.created_at || '',
    updatedAt: taskProgress?.updatedAt || message.updatedAt || message.updated_at || '',
    showMessageTime: continuity.showMessageTime === true,
  })}${externalDelegationActions}${publishedCards}`;
  if (!pptProgress) return publishedCards;
  const deliveryProjection = state.uBuddyFeatureFlags?.agentWorkDetailProjection === true
    ? workProjectionEnvelope(metadata.agentWorkStatusProjection)
    : null;
  const deliveryActor = deliveryProjection?.actors[0] || null;
  return `
    <article class="message assistant run-status-message ${pptProgress ? 'has-ppt-progress' : ''}" data-stage="${escapeAttr(metadata.stage || 'working')}">
      <div class="run-inline-status" aria-live="polite">
        <span class="run-pulse" aria-hidden="true"></span>
        <span>${escapeHtml(content)}</span>
      </div>
      ${deliveryActor ? renderAgentWorkProjectionSummary(deliveryActor, { showTimeline: true }) : ''}
      ${pptProgress ? renderPptRunProgress(pptProgress) : ''}
    </article>${publishedCards}
  `;
}

function publishedCardMatchesTask(card = {}, taskRunId = '') {
  const cleanTaskRunId = String(taskRunId || '').trim();
  if (!cleanTaskRunId) return false;
  return [card.taskRunId, card.task_run_id, card.taskWorkspaceId, card.task_workspace_id,
    card.sourceContext?.task_workspace_id].some((value) => String(value || '').trim() === cleanTaskRunId);
}

function renderExternalDelegationRunActions(metadata = {}) {
  const delegationId = String(metadata.externalDelegationId || '').trim();
  if (!delegationId) return '';
  const delegation = (state.agentDelegations || []).find((item) => item.id === delegationId) || null;
  const delegationStatus = String(delegation?.status || '');
  const messageStatus = String(metadata.externalDelegationStatus || '');
  const deliveryDraft = metadata.externalDelegationDeliveryDraft && typeof metadata.externalDelegationDeliveryDraft === 'object'
    ? metadata.externalDelegationDeliveryDraft
    : null;
  const authoritativeStatus = ['submitted', 'result_accepted', 'closed', 'revision_requested'].includes(delegationStatus)
    ? delegationStatus
    : '';
  const status = authoritativeStatus || (deliveryDraft && messageStatus === 'draft_ready'
    ? 'draft_ready'
    : delegationStatus || messageStatus || 'running');
  const requesterName = metadata.externalRequesterName || delegation?.requester?.displayName || delegation?.requester?.display_name || '其他用户';
  if (status === 'draft_ready') return renderExternalDelegationDeliveryReview({ delegationId, delegation, metadata, requesterName });
  if (status === 'submitted') return renderExternalDelegationSubmittedSnapshot({ delegationId, delegation, metadata });
  const label = status === 'revision_requested' ? '发出方提出了修改要求，uBuddy 将继续在原任务中处理。'
    : status === 'result_accepted' ? '发出方已经验收本次交付。'
      : status === 'blocked' ? '任务暂时受阻，公开阻塞信息已同步给发出方。'
        : `来自 ${requesterName} 的外部任务；只同步脱敏节点进度。`;
  return `<section class="external-delegation-run-actions status-${escapeAttr(status)}" data-external-delegation-id="${escapeAttr(delegationId)}">
    <span>${escapeHtml(label)}</span>
  </section>`;
}

function externalDelegationAttachmentKey(item = {}) {
  return String(item.selectionKey || item.id || item.fileId || item.file_id || item.remote_file_id
    || item.source_path || item.sourcePath || item.path || item.relative_path
    || `${item.name || item.filename || ''}:${Number(item.size || 0)}`).trim();
}

function renderExternalDelegationDeliveryReview({ delegationId = '', delegation = null, metadata = {}, requesterName = '其他用户' } = {}) {
  const descriptor = metadata.externalDelegationDeliveryDraft && typeof metadata.externalDelegationDeliveryDraft === 'object'
    ? metadata.externalDelegationDeliveryDraft : {};
  const storedDraft = state.externalDelegationDeliveryDrafts?.[delegationId] || null;
  const descriptorRevisionId = String(descriptor.candidateRevisionId || descriptor.candidateMessageId || '');
  const persistedDraft = storedDraft && (!storedDraft.candidateRevisionId || storedDraft.candidateRevisionId === descriptorRevisionId)
    ? storedDraft : null;
  const defaultText = descriptor.submissionText || publicDelegationSubmissionText(delegation?.metadata?.preliminaryResult || '');
  const draftText = persistedDraft && Object.prototype.hasOwnProperty.call(persistedDraft, 'text')
    ? String(persistedDraft.text || '') : defaultText;
  const publicPreview = publicDelegationSubmissionText(draftText);
  const files = (Array.isArray(descriptor.attachments) && descriptor.attachments.length
    ? descriptor.attachments : Array.isArray(delegation?.metadata?.generatedTaskFiles) ? delegation.metadata.generatedTaskFiles : [])
    .map((item) => ({ ...item, selectionKey: externalDelegationAttachmentKey(item) }))
    .filter((item) => item.selectionKey);
  const selectedKeys = Array.isArray(persistedDraft?.selectedAttachmentKeys)
    ? new Set(persistedDraft.selectedAttachmentKeys.map((item) => String(item || '')))
    : new Set(files.map((item) => item.selectionKey));
  const busy = state.networkBusyDelegationId === delegationId;
  const leadFile = files.length ? normalizeFilePayload(files[0]) : null;
  const leadFileKind = leadFile
    ? attachmentVisualKind({ kind: leadFile.kind, uploaded: { filename: leadFile.name }, name: leadFile.name })
    : '';
  const summaryTitle = leadFile?.name || '交付正文';
  const summaryMeta = leadFile
    ? `${messageAttachmentKindLabel(leadFileKind)} · ${files.length} 个交付文件 · 点击展开确认`
    : '无交付文件 · 点击展开确认';
  return `<details class="external-delegation-delivery-review" data-external-delegation-id="${escapeAttr(delegationId)}">
    <summary class="external-delegation-delivery-summary">
      <span class="external-delegation-delivery-summary-icon">${leadFile ? messageAttachmentIcon(leadFile, leadFileKind) : iconSvg('document')}</span>
      <span class="external-delegation-delivery-summary-copy"><small>来自 ${escapeHtml(requesterName)} 的任务</small><strong>${escapeHtml(summaryTitle)}</strong><em>${escapeHtml(summaryMeta)}</em></span>
      <b>待确认</b>
      <span class="external-delegation-delivery-summary-chevron">${iconSvg('chevronDown')}</span>
    </summary>
    <div class="external-delegation-delivery-review-body">
      <header><strong>确认本次交付内容</strong><b>仅你可见</b></header>
      <label class="external-delegation-delivery-editor"><span>交付正文</span><textarea rows="5" data-external-delegation-delivery-editor="${escapeAttr(delegationId)}" data-external-delegation-candidate-message-id="${escapeAttr(descriptor.candidateMessageId || '')}" data-external-delegation-candidate-revision-id="${escapeAttr(descriptorRevisionId)}" ${busy ? 'disabled' : ''}>${escapeHtml(draftText)}</textarea></label>
      <section class="external-delegation-public-preview" data-external-delegation-public-preview="${escapeAttr(delegationId)}"><strong>对方实际会看到</strong><p>${escapeHtml(publicPreview)}</p></section>
      ${files.length ? `<fieldset class="external-delegation-delivery-files"><legend>随结果发送的文件</legend>${files.map((file, index) => { const checkboxId = `external-delivery-file-${delegationId}-${index}`; return `<article><label for="${escapeAttr(checkboxId)}"><input id="${escapeAttr(checkboxId)}" type="checkbox" data-external-delegation-delivery-file="${escapeAttr(delegationId)}" value="${escapeAttr(file.selectionKey)}" ${selectedKeys.has(file.selectionKey) ? 'checked' : ''} ${busy ? 'disabled' : ''}/><span>随结果发送</span></label><div>${renderMessageAttachmentCards([file])}</div></article>`; }).join('')}</fieldset>` : '<p class="external-delegation-no-files">本次交付没有生成附件文件。</p>'}
      <p class="external-delegation-privacy-note">只会发送上面的正文和已勾选文件；不会公开私人会话、Memory、执行记录或本地路径。</p>
      <div class="external-delegation-delivery-actions"><button class="btn secondary" type="button" data-network-task="${escapeAttr(delegationId)}">打开完整任务工作区</button><button class="btn primary" type="button" data-agent-delegation-respond="submit" data-delegation-id="${escapeAttr(delegationId)}" ${busy ? 'disabled' : ''}>确认并交付给发出方</button></div>
    </div>
  </details>`;
}

function renderExternalDelegationSubmittedSnapshot({ delegationId = '', delegation = null, metadata = {} } = {}) {
  const snapshot = metadata.externalDelegationSubmittedSnapshot && typeof metadata.externalDelegationSubmittedSnapshot === 'object'
    ? metadata.externalDelegationSubmittedSnapshot : {};
  const content = String(snapshot.content || delegation?.metadata?.latestResult || '').trim();
  const attachments = Array.isArray(snapshot.attachments) ? snapshot.attachments
    : Array.isArray(delegation?.metadata?.resultAttachments) ? delegation.metadata.resultAttachments : [];
  return `<section class="external-delegation-submitted-snapshot is-compact" data-external-delegation-id="${escapeAttr(delegationId)}">
    <header><span><small>已交付</small><strong>等待发出方验收</strong></span>${snapshot.submittedAt ? `<time>${escapeHtml(formatMessageTime(snapshot.submittedAt))}</time>` : ''}</header>
    <p>${escapeHtml(clipInline(content || '结果已经提交给发出方。', 160))}</p>
    <footer><span>${attachments.length ? `${attachments.length} 个交付文件` : '交付结果已保存'}</span><button type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_WORKSPACE}" data-task-workspace-kind="delegation" data-task-workspace-id="${escapeAttr(delegationId)}">查看任务</button></footer>
  </section>`;
}

function renderCollaborationRunProgress({ content = '', taskRunId = '', delegationId = '', title = '', taskCard = null, taskType = '', objective = null, phase = 'executing', taskStatus = '', progress = {}, activeNodes = [], milestones = [], blocker = null, deliverable = null, resultState = '', technicalDetails = null, coordinationSnapshot = null, processOnly = false, terminal = false, sourceContext = null, continuedByTaskRunId = '', createdAt = '', updatedAt = '', showMessageTime = false } = {}) {
  const liveTask = taskRunId
    ? state.uBuddyTaskViewsById?.[taskRunId] || (state.tasks || []).find((task) => task.id === taskRunId) || null
    : null;
  const liveStatus = String(liveTask?.status || taskStatus || '');
  const successorTaskRunId = String(liveTask?.metadata?.continuedByTaskRunId
    || continuedByTaskRunId
    || technicalDetails?.continuedByTaskRunId
    || '');
  const finished = terminal || ['completed', 'failed', 'cancelled'].includes(liveStatus);
  const cancellable = taskRunId && !finished && ['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'cancelling'].includes(liveStatus || 'ready');
  const rerunnable = taskRunId && !successorTaskRunId && ['cancelled', 'failed'].includes(liveStatus);
  return renderTaskProgressCard({
    content,
    taskRunId,
    delegationId,
    title: title || liveTask?.title || taskCard?.title || '',
    taskType,
    objective,
    phase,
    taskStatus: liveStatus,
    progress,
    activeNodes,
    nodes: liveTask?.nodes || technicalDetails?.nodes || [],
    milestones,
    blocker,
    deliverable: deliverable || liveTask?.metadata?.deliverableResult || null,
    resultState: resultState || liveTask?.metadata?.resultState || '',
    technicalDetails,
    coordinationSnapshot,
    continuedByTaskRunId: successorTaskRunId,
    processOnly,
    terminal,
    sourceContext,
    createdAt,
    updatedAt,
    showMessageTime,
    open: !finished,
    compact: true,
    controls: {
      canOpenWorkspace: Boolean(taskRunId || delegationId),
      canOpenResult: Boolean(finished || deliverable || liveTask?.metadata?.deliverableResult),
      canOpen: Boolean(taskRunId),
      canCancel: Boolean(cancellable),
      canRerun: Boolean(rerunnable),
      canRetry: true,
    },
    agentName: agentDisplayName,
    taskNodeStatusLabel,
    taskTypeLabel,
  });
}

function renderSettledCollaborationProgress(collaboration = null) {
  const snapshot = collaboration?.progressSnapshot;
  if (!snapshot?.taskRunId) return '';
  return renderCollaborationRunProgress({
    content: snapshot.taskStatus === 'completed' ? '任务已完成，展开查看节点进度。' : '任务已结束，展开查看执行情况。',
    taskRunId: snapshot.taskRunId,
    taskType: collaboration.taskType || snapshot.taskType || '',
    objective: collaboration.objective || snapshot.objective || null,
    phase: snapshot.phase || 'delivering',
    taskStatus: snapshot.taskStatus || '',
    progress: snapshot.progress || {},
    activeNodes: snapshot.activeNodes || [],
    milestones: snapshot.changedNodes || [],
    blocker: snapshot.blocker || null,
    continuedByTaskRunId: snapshot.continuedByTaskRunId || '',
    terminal: true,
  }).replace('message assistant run-status-message collaboration-run-message', 'settled-collaboration-progress');
}

function taskTypeLabel(value = '') {
  return ({ code_change: '代码修改', file_generation: '文件生成', command_execution: '命令执行', research: '调研', explanation: '解释说明', qa: '问答', collaboration: '多 Agent 协作' })[value] || '协作任务';
}

function taskNodeStatusLabel(value = '') {
  return ({ pending: '等待依赖', ready: '待执行', queued: '排队中', running: '执行中', retry_wait: '等待自动重试', waiting: '等待信息', blocked: '依赖失败阻塞', cancelling: '正在停止', completed: '已完成', failed: '失败', cancelled: '已取消' })[value] || '处理中';
}

function agentDisplayName(agentId = '') {
  return agentNameById(agentId) || agentId || 'Agent';
}

function renderLiveReasoningSummary(items = []) {
  const reasoning = (Array.isArray(items) ? items : [])
    .filter((item) => item?.activityType === 'reasoning' && String(item.detail || '').trim())
    .at(-1);
  if (!reasoning) return '';
  return `<div class="run-thinking-summary" aria-live="polite">
    <p>${escapeHtml(reasoning.detail).replaceAll('\n', '<br>')}</p>
    <small>展示可审计摘要，不展示私有思维链或隐藏提示词。</small>
  </div>`;
}

function renderPptRunProgress(progress = {}) {
  const current = Math.max(0, Number(progress.currentSlide || 0));
  const total = Math.max(0, Number(progress.totalSlides || 0));
  const overallPercent = Math.max(0, Math.min(100, Math.round(Number(progress.overallPercent || 0))));
  const trackPercent = Math.max(3, overallPercent);
  const attempt = Math.max(1, Number(progress.attempt || 1));
  const labels = {
    parse: '页面计划',
    image: '页面配图',
    render: '页面制作',
    repair: `第 ${attempt} 轮修复`,
    qa: '排版自检',
    preview: '生成预览',
    heartbeat: '持续处理',
  };
  const phaseCurrent = Math.max(0, Number(progress.phaseCurrent || 0));
  const phaseTotal = Math.max(0, Number(progress.phaseTotal || 0));
  const phase = String(progress.phase || 'render');
  const pageLabel = phase === 'image'
    ? phaseTotal
      ? `${Math.min(phaseCurrent, phaseTotal)} / ${phaseTotal} 张配图${current > 0 ? ` · 第 ${Math.min(current, total || current)} 页` : ''}`
      : '正在检查配图需求'
    : total
      ? current > 0 ? `当前 ${Math.min(current, total)} / ${total} 页` : `共 ${total} 页`
      : '准备中';
  const phaseOrder = ['parse', 'image', 'render', 'qa', 'preview'];
  const phaseNames = ['计划', '配图', '制作', '自检', '预览'];
  const normalizedPhase = phase === 'repair' ? 'qa' : phase;
  const activePhaseIndex = Math.max(0, phaseOrder.indexOf(normalizedPhase));
  const allComplete = overallPercent >= 100;
  const statusLabels = {
    cached: '命中缓存',
    retrying: '正在重试',
    fallback: '备用生成器',
    failed: '配图失败',
  };
  const badges = [
    statusLabels[progress.status] || '',
    phase === 'image' && Number(progress.cacheHits || 0) > 0 ? `缓存复用 ${Number(progress.cacheHits)}` : '',
    phase === 'image' && Number(progress.concurrency || 1) > 1 ? `并行 ${Number(progress.concurrency)}` : '',
  ].filter(Boolean);
  return `
    <div class="ppt-run-progress" data-phase="${escapeAttr(phase)}">
      <div class="ppt-run-progress-stages" aria-label="PPT 生成阶段">
        ${phaseNames.map((name, index) => `
          <span class="${allComplete || index < activePhaseIndex ? 'is-complete' : index === activePhaseIndex ? 'is-active' : ''}">
            <i>${allComplete || index < activePhaseIndex ? '✓' : index + 1}</i>${escapeHtml(name)}
          </span>
        `).join('')}
      </div>
      <div class="ppt-run-progress-meta">
        <span>${escapeHtml(labels[phase] || 'PPT 制作')} · ${escapeHtml(pageLabel)}</span>
        <strong>总体 ${overallPercent}%</strong>
      </div>
      <div class="ppt-run-progress-track"><i style="width:${trackPercent}%"></i></div>
      ${progress.slideTitle || badges.length ? `
        <div class="ppt-run-progress-detail">
          ${progress.slideTitle ? `<span class="ppt-run-progress-title">${escapeHtml(progress.slideTitle)}</span>` : '<span></span>'}
          ${badges.length ? `<span class="ppt-run-progress-badges">${badges.map((badge) => `<b>${escapeHtml(badge)}</b>`).join('')}</span>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function normalizeChatPlan(plan = {}) {
  const source = Array.isArray(plan.steps) ? plan.steps : Array.isArray(plan.plan) ? plan.plan : [];
  const steps = source.map((item, index) => {
    const rawStatus = String(item?.status || 'pending');
    const status = ['completed', 'complete', 'done'].includes(rawStatus)
      ? 'completed'
      : ['active', 'running', 'inProgress', 'in_progress'].includes(rawStatus) ? 'active' : 'pending';
    return {
      label: String(item?.label || item?.step || `步骤 ${index + 1}`).trim(),
      detail: String(item?.detail || item?.description || '').trim(),
      status,
    };
  }).filter((item) => item.label);
  const content = String(plan.content || '').trim();
  return {
    explanation: String(plan.explanation || plan.rationale || (content ? '计划已生成，可审查后选择下一步。' : '')).trim(),
    steps,
  };
}

function renderChatPlanCard(plan = {}, { messageId = '', live = false, expanded = true } = {}) {
  const normalized = normalizeChatPlan(plan);
  if (!normalized.steps.length && !normalized.explanation) return '';
  const total = normalized.steps.length;
  const completed = normalized.steps.filter((item) => item.status === 'completed').length;
  const activeIndex = normalized.steps.findIndex((item) => item.status === 'active');
  const current = total ? activeIndex >= 0 ? activeIndex + 1 : Math.min(total, completed + (completed < total ? 1 : 0)) : 0;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const statusText = total
    ? `Step ${current || 1} / ${total} · 已完成 ${completed} / ${total}`
    : live ? '正在整理实施步骤' : '计划已生成，可审查后选择下一步';
  const header = `<span class="chat-plan-card-heading"><span class="chat-plan-card-icon">${iconSvg('plan')}</span><span><strong>${live ? '计划进行中' : '实施计划'}</strong><small>${statusText}</small></span></span>${total || live ? `<span class="chat-plan-card-percent">${percent}%</span>` : ''}`;
  const body = `<div class="chat-plan-card-body">
    ${normalized.explanation ? `<p class="chat-plan-explanation">${escapeHtml(normalized.explanation)}</p>` : ''}
    ${total ? `<div class="chat-plan-progress"><i style="width:${percent}%"></i></div><div class="chat-plan-steps">${normalized.steps.map((item, index) => `<div class="chat-plan-step is-${escapeAttr(item.status)}"><span>${item.status === 'completed' ? '✓' : index + 1}</span><div><strong>${escapeHtml(item.label)}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}</div></div>`).join('')}</div>` : ''}
    ${messageId ? renderChatPlanActions(messageId) : ''}
  </div>`;
  if (live) return `<section class="interaction-work-card chat-plan-card is-live" aria-label="计划模式进度"><div class="chat-plan-card-summary">${header}</div>${body}</section>`;
  return `<details class="chat-plan-card" data-chat-plan-toggle="${escapeAttr(messageId)}"${expanded ? ' open' : ''}><summary class="chat-plan-card-summary">${header}</summary>${body}</details>`;
}

function renderChatPlanActions(messageId = '') {
  if (!messageId) return '';
  return `<div class="chat-plan-actions">
    <button type="button" data-open-chat-plan-standalone="${escapeAttr(messageId)}">${iconSvg('external')}单独打开</button>
    <details class="chat-plan-more-actions">
      <summary>更多操作${iconSvg('chevronDown')}</summary>
      <div>
        <button type="button" data-modify-chat-plan="${escapeAttr(messageId)}">修改计划</button>
        <button type="button" data-defer-chat-plan="${escapeAttr(messageId)}">稍后实施</button>
        <button type="button" data-implement-chat-plan-clear-context="${escapeAttr(messageId)}">实施计划（清空当前上下文）</button>
      </div>
    </details>
    <button class="is-primary" type="button" data-implement-chat-plan="${escapeAttr(messageId)}">${iconSvg('play')}实施计划</button>
  </div>`;
}

function renderInteractionWorkCard() {
  const currentSession = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  const activeRun = state.activeChatRun || null;
  if (state.interactionMode === 'goal') {
    const goal = activeRun?.interactionMode === 'goal' ? activeRun.goal || currentSession?.goal || null : currentSession?.goal || null;
    return renderGoalStatusCard(goal);
  }
  if (state.interactionMode === 'plan') {
    return '';
  }
  return '';
}

function renderGoalStatusCard(goal = null) {
  const objective = String(goal?.objective || '').trim();
  if (!objective) {
    return `<section class="interaction-work-card interaction-mode-ready mode-goal" aria-label="目标模式已开启"><span>${iconSvg('goal')}</span><div><strong>目标模式已开启</strong><small>发送下一条消息以设定持续目标，后续进度与状态会显示在这里。</small></div></section>`;
  }
  const rawStatus = String(goal?.status || 'active');
  const status = ({ completed: 'complete', done: 'complete', usage_limited: 'usageLimited', budget_limited: 'budgetLimited' })[rawStatus] || rawStatus;
  const statusInfo = ({
    active: ['进行中的目标', '正在推进'], paused: ['已暂停的目标', '已暂停'], complete: ['已完成的目标', '目标完成'],
    blocked: ['受阻的目标', '遇到阻塞'], usageLimited: ['受限的目标', '用量受限'], budgetLimited: ['受限的目标', '历史预算受限'],
  })[status] || ['进行中的目标', '正在推进'];
  const tokensUsed = Math.max(0, Number(goal?.tokensUsed ?? goal?.tokens_used ?? 0));
  const timeUsed = Math.max(0, Number(goal?.timeUsedSeconds ?? goal?.time_used_seconds ?? 0));
  const tokenLabel = `已用 ${formatGoalTokenCount(tokensUsed)} Token`;
  const sessionId = state.currentSessionId || '';
  const expanded = (state.expandedGoalSessionIds || []).includes(sessionId);
  const busy = state.goalActionBusy === sessionId;
  const pauseAction = status === 'paused' ? 'resume' : 'pause';
  const pauseLabel = status === 'paused' ? '继续目标' : '暂停目标';
  return `<section class="interaction-work-card goal-status-card is-${escapeAttr(status)}" aria-label="${escapeAttr(statusInfo[0])}">
    <div class="goal-status-compact">
      <span class="goal-status-icon">${iconSvg('goal')}</span>
      <div class="goal-status-copy"><small>${escapeHtml(statusInfo[0])}</small><strong title="${escapeAttr(objective)}">${escapeHtml(objective)}</strong></div>
      <div class="goal-status-actions" aria-label="目标操作">
        <button type="button" data-goal-action="edit" data-goal-session-id="${escapeAttr(sessionId)}" title="编辑目标" aria-label="编辑目标" ${busy ? 'disabled' : ''}>${iconSvg('edit')}</button>
        <button type="button" data-goal-action="${pauseAction}" data-goal-session-id="${escapeAttr(sessionId)}" title="${pauseLabel}" aria-label="${pauseLabel}" ${busy || ['complete'].includes(status) ? 'disabled' : ''}>${iconSvg(status === 'paused' ? 'play' : 'pause')}</button>
        <button class="is-danger" type="button" data-goal-action="delete" data-goal-session-id="${escapeAttr(sessionId)}" title="删除目标" aria-label="删除目标" ${busy ? 'disabled' : ''}>${iconSvg('trash')}</button>
        <span class="goal-status-token">${escapeHtml(tokenLabel)}</span>
        <button class="goal-status-expand ${expanded ? 'is-expanded' : ''}" type="button" data-goal-expand="${escapeAttr(sessionId)}" title="${expanded ? '收起详情' : '展开详情'}" aria-label="${expanded ? '收起目标详情' : '展开目标详情'}" aria-expanded="${expanded ? 'true' : 'false'}">${iconSvg('chevronDown')}</button>
      </div>
    </div>
    ${expanded ? `<div class="goal-status-details"><p>${escapeHtml(objective)}</p><div><span>${escapeHtml(statusInfo[1])}</span>${timeUsed ? `<span>已推进 ${escapeHtml(formatGoalDuration(timeUsed))}</span>` : ''}<span>${escapeHtml(tokenLabel)}</span></div></div>` : ''}
  </section>`;
}

function renderGoalEditorDialog() {
  const editor = state.goalEditor;
  if (!editor?.sessionId) return '';
  return `<div class="goal-editor-overlay" data-goal-editor-overlay role="presentation">
    <form class="goal-editor-dialog" data-goal-editor-form role="dialog" aria-modal="true" aria-labelledby="goal-editor-title">
      <header><strong id="goal-editor-title">编辑目标</strong><button type="button" data-goal-editor-cancel title="关闭" aria-label="关闭">${iconSvg('x')}</button></header>
      <label><span>目标内容</span><textarea data-goal-editor-input maxlength="4000" rows="5" required>${escapeHtml(editor.draft || '')}</textarea></label>
      ${editor.error ? `<p role="alert">${escapeHtml(editor.error)}</p>` : ''}
      <footer><button type="button" data-goal-editor-cancel>取消</button><button class="is-primary" type="submit" ${editor.busy ? 'disabled' : ''}>${editor.busy ? '保存中…' : '保存目标'}</button></footer>
    </form>
  </div>`;
}

function formatGoalTokenCount(value = 0) {
  const amount = Math.max(0, Number(value) || 0);
  if (amount >= 1_000_000) return `${Math.round(amount / 100_000) / 10}M`;
  if (amount >= 1_000) return `${Math.round(amount / 100) / 10}K`;
  return String(Math.round(amount));
}

function formatGoalDuration(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total >= 3600) return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分钟`;
  if (total >= 60) return `${Math.floor(total / 60)} 分钟`;
  return `${total} 秒`;
}

function renderProcessMessage(message) {
  const metadata = message.metadata || {};
  const avatar = renderStandardMessageAvatar(message);
  return `
    <article class="message assistant process-message ${avatar ? 'has-chat-avatar' : ''} ${metadata.streaming === false ? 'is-settled' : 'is-streaming'}">
      ${renderMessageAvatarSlot(avatar, false)}
      <div class="message-shell">${renderProcessTimeline(metadata.processEvents, {
        messageId: message.id,
        streaming: metadata.streaming !== false,
        expanded: metadata.expanded,
        historyExpanded: metadata.historyExpanded,
        historyVisibleCount: Number(metadata.historyVisibleCount || 0),
        startedAt: Number(metadata.startedAt || 0),
        durationMs: Number(metadata.durationMs || 0),
        processStatus: metadata.processStatus || (metadata.failed ? 'failed' : metadata.cancelled || metadata.interrupted ? 'cancelled' : ''),
      })}</div>
    </article>
  `;
}

function renderProcessTimeline(items = [], {
  messageId = '', streaming = false, expanded = false, startedAt = 0, durationMs = 0, processStatus = '', settledLabel = '',
} = {}) {
  if (state.uBuddyFeatureFlags?.newProcessEventStream === false) return '';
  const transcript = renderCodexTranscript(userFacingCodexEvents(items), {
    messageId, streaming, startedAt, durationMs,
  }).replaceAll('<div class="codex-transcript-label">思考</div>', '');
  if (!transcript || streaming) return transcript;
  const label = settledLabel || (processStatus === 'failed' ? '处理失败' : processStatus === 'cancelled' ? '已中断' : '已处理');
  const duration = formatProcessDuration(durationMs);
  return `<details class="codex-process-disclosure" data-process-toggle="${escapeAttr(messageId)}"${expanded ? ' open' : ''}>
    <summary><span>${label}</span>${duration ? `<small>${escapeHtml(duration)}</small>` : ''}</summary>
    ${transcript}
  </details>`;
}

function normalizedUBuddyTaskPublishProcess(value = null) {
  if (!value || value.version !== 'ubuddy_task_publish_process_v1' || !Array.isArray(value.events) || !value.events.length) return null;
  const events = value.events.filter((item) => item && typeof item === 'object');
  if (!events.length) return null;
  const status = ['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(String(value.status || ''))
    ? String(value.status) : 'completed';
  return {
    ...value,
    status,
    durationMs: Math.max(0, Number(value.durationMs || 0)),
    events,
  };
}

function uBuddyTaskPublishProcessLabel(processOrStatus = '') {
  const process = processOrStatus && typeof processOrStatus === 'object' ? processOrStatus : null;
  const status = String(process?.status || processOrStatus || '');
  if (status === 'waiting') {
    const latest = Array.isArray(process?.events) ? process.events.at(-1) || {} : {};
    const context = `${latest.title || ''} ${latest.detail || ''}`;
    if (/执行方式|选择执行/.test(context)) return '等待选择执行方式';
    if (/确认后|等待.{0,8}确认|确认新方案|再次确认/.test(context)) return '等待确认';
    return '等待补充信息';
  }
  return ({ completed: '任务已发布', failed: '任务发布失败', cancelled: '任务发布已取消' })[status] || '';
}

function renderPersistedUBuddyTaskPublishProcess(message = {}) {
  const process = normalizedUBuddyTaskPublishProcess(message.metadata?.uBuddyTaskPublishProcess);
  if (!process) return '';
  const avatar = renderStandardMessageAvatar(message);
  const expanded = process.status === 'completed' ? message.metadata?.expanded === true : true;
  return `<article class="message assistant process-message ubuddy-task-publish-process-message ${avatar ? 'has-chat-avatar' : ''} is-settled">
    ${avatar}
    <div class="message-shell">${renderProcessTimeline(process.events, {
      messageId: message.id || '',
      expanded,
      durationMs: process.durationMs,
      processStatus: process.status,
      settledLabel: uBuddyTaskPublishProcessLabel(process),
    })}</div>
  </article>`;
}

function userFacingCodexEvents(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!item || typeof item !== 'object') return item;
    const { reasoningText, ...visibleItem } = item;
    if (visibleItem.payload && typeof visibleItem.payload === 'object' && !Array.isArray(visibleItem.payload)) {
      const { reasoningText: payloadReasoningText, ...visiblePayload } = visibleItem.payload;
      if (String(visiblePayload.activityType || visibleItem.activityType || '') === 'reasoning'
        && !String(visiblePayload.detail || visibleItem.detail || '').trim()
        && !(Array.isArray(visiblePayload.summaryParts) && visiblePayload.summaryParts.some((part) => String(part?.text || part || '').trim()))
        && String(payloadReasoningText || reasoningText || '').trim()) {
        visiblePayload.detail = safeReasoningProgressLabel(visiblePayload.status || visibleItem.status);
      }
      visibleItem.payload = visiblePayload;
    }
    if (String(visibleItem.activityType || '') === 'reasoning'
      && !String(visibleItem.detail || '').trim()
      && !(Array.isArray(visibleItem.summaryParts) && visibleItem.summaryParts.some((part) => String(part?.text || part || '').trim()))
      && String(reasoningText || '').trim()) {
      visibleItem.detail = safeReasoningProgressLabel(visibleItem.status);
    }
    return visibleItem;
  });
}

function safeReasoningProgressLabel(status = '') {
  return ['running', 'waiting'].includes(String(status || ''))
    ? '正在分析请求并整理可验证信息。'
    : '已完成分析与信息整理。';
}

function isTechnicalProcessActivity(item = {}) {
  if (['protocol', 'usage'].includes(item.activityType)) return true;
  if (item.activityType !== 'status' || item.status === 'cancelled') return false;
  const methods = (item.protocolEvents || []).map((event) => String(event?.method || ''));
  return methods.some((method) => method === 'thread/status/changed' || method === 'turn/completed');
}

function renderProcessTechnicalStream(items = []) {
  const activities = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!activities.length) return '';
  const events = activities.flatMap((item) => Array.isArray(item.protocolEvents) ? item.protocolEvents : []);
  return `<details class="process-technical-stream">
    <summary>技术事件 · ${activities.length} 项${events.length ? ` · ${events.length} 个原始事件` : ''}</summary>
    <div>
      ${events.length ? renderProtocolEventEntries(events) : activities.map((item) => `<p>${escapeHtml(item.title || item.detail || 'Janus 技术事件')}</p>`).join('')}
    </div>
  </details>`;
}

function renderProcessItem(item = {}, { messageId = '', isLatest = false, isLatestCommand = false } = {}) {
  if (item.activityType === 'command') return renderCommandProcessItem(item, { messageId, isLatestCommand });
  const type = String(item.activityType || 'activity');
  const status = String(item.status || 'running');
  const title = type === 'reasoning' ? '思考' : type === 'commentary' ? '执行说明' : item.title || '处理过程';
  const preview = processItemPreview(item);
  const duration = processItemDuration(item);
  const toggleId = `${messageId}::${item.activityId || ''}`;
  const open = item.expansionLocked
    ? item.expanded === true
    : status === 'running' || status === 'waiting' || (isLatest && type !== 'protocol');
  return `
    <details class="process-detail-card is-${escapeAttr(status)} type-${escapeAttr(type)}" data-process-item-toggle="${escapeAttr(toggleId)}"${open ? ' open' : ''}>
      <summary class="process-detail-head">
        <span class="process-detail-status"><i></i><strong>${escapeHtml(title)}</strong></span>
        <span class="process-detail-preview">${escapeHtml(preview || processStatusLabel(status))}</span>
        ${duration ? `<small>${escapeHtml(duration)}</small>` : ''}
      </summary>
      <div class="process-detail-body">
        ${renderProcessDetailSections(item)}
        ${renderProcessTechnicalDetails(item)}
      </div>
    </details>
  `;
}

function processItemPreview(item = {}) {
  if (item.activityType === 'file' && Array.isArray(item.changes) && item.changes.length) {
    return `${item.changes.length} 个文件变更`;
  }
  if (item.activityType === 'tool') {
    return [item.toolServer, item.toolName].filter(Boolean).join(' / ') || String(item.detail || '');
  }
  if (item.activityType === 'agent') {
    return String(item.agentTool || item.agentPath || item.detail || '');
  }
  if (item.activityType === 'usage' && (item.usage?.last?.totalTokens || item.usage?.totalTokens)) {
    return `${item.usage.last?.totalTokens || item.usage.totalTokens} tokens`;
  }
  return clipInline(String(item.detail || item.reasoningText || item.command || item.itemType || ''), 180);
}

function processItemDuration(item = {}) {
  const durationMs = Number.isFinite(item.durationMs)
    ? Math.max(0, item.durationMs)
    : Number.isFinite(item.startedAtMs) && Number.isFinite(item.completedAtMs)
      ? Math.max(0, item.completedAtMs - item.startedAtMs)
      : 0;
  return formatProcessDuration(durationMs);
}

function processStatusLabel(status = '') {
  return ({
    running: '正在运行',
    waiting: '等待处理',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    blocked: '受阻',
  })[String(status || '')] || String(status || '过程详情');
}

function renderProcessDetailSections(item = {}) {
  const sections = [];
  const add = (label, value, options = {}) => {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value) && !value.length) return;
    if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return;
    sections.push(renderProcessDetailValue(label, value, options));
  };
  const detail = String(item.detail || '').trim();
  const reasoningText = String(item.reasoningText || '').trim();
  const responseText = String(item.responseText || '').trim();
  add('说明', detail);
  if (reasoningText && reasoningText !== detail) add('思考过程', reasoningText);
  if (responseText && responseText !== detail && responseText !== reasoningText) add('回复内容', responseText);
  add('引用的记忆', item.memoryCitation, { json: true });
  if (Array.isArray(item.changes) && item.changes.length) sections.push(renderProcessFileChanges(item.changes));
  add('文件差异', item.diff);
  add('工具服务', item.toolServer);
  add('工具名称', item.toolName);
  add('工具参数', item.arguments, { json: true });
  add('工具结果', item.result, { json: typeof item.result !== 'string' });
  add('工具错误', item.error, { json: typeof item.error !== 'string' });
  add('执行结果', item.success === null || item.success === undefined ? '' : item.success ? '成功' : '失败');
  add('Agent 操作', item.agentTool);
  add('Agent 任务', item.prompt);
  add('Agent 状态', item.agentsStates, { json: true });
  add('检索词', item.query);
  add('检索动作', item.searchAction, { json: true });
  add('检索结果', item.searchResults, { json: true });
  add('文件路径', item.path);
  add('修订后的图像提示词', item.revisedPrompt);
  add('审查内容', item.review);
  add('计划', item.plan, { json: true });
  add('目标', item.goal, { json: true });
  add('问题', item.questions, { json: true });
  add('验证结果', item.verifications, { json: true });
  if (item.warning && typeof item.warning === 'object') {
    add('警告', item.warning.summary || item.warning.message || item.warning.details || prettyProcessJson(item.warning));
    if (item.warning.details && item.warning.details !== item.warning.summary) add('补充说明', item.warning.details);
  } else {
    add('警告', item.warning);
  }
  add('路由原因', item.rerouteReason, { json: typeof item.rerouteReason !== 'string' });
  return sections.join('') || '<p class="process-command-empty">暂无额外结构化详情。</p>';
}

function renderProcessTechnicalDetails(item = {}) {
  const sections = [];
  const add = (label, value, options = {}) => {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value) && !value.length) return;
    if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return;
    sections.push(renderProcessDetailValue(label, value, options));
  };
  add('Thread ID', item.threadId);
  add('Turn ID', item.turnId);
  add('Item ID', item.itemId || item.activityId);
  add('Item type', item.itemType);
  add('App context', item.appContext, { json: true });
  add('Plugin ID', item.pluginId);
  add('MCP resource URI', item.mcpAppResourceUri);
  add('发送线程', item.senderThreadId);
  add('接收线程', item.receiverThreadIds, { json: true });
  add('Agent 线程', item.agentThreadId);
  add('Agent 路径', item.agentPath);
  add('模型', item.model);
  add('Reasoning effort', item.reasoningEffort);
  add('Token 使用量', item.usage, { json: true });
  add('Hook', item.hook, { json: true });
  add('Hook prompt fragments', item.hookFragments, { json: true });
  add('权限', item.permissions, { json: true });
  add('安全缓冲', item.safetyBuffering, { json: true });
  add('审核元数据', item.moderationMetadata, { json: true });
  add('Sandbox setup', item.sandboxSetup, { json: true });
  add('原始响应', item.rawResponse, { json: true });
  add('RPC result', item.rpcResult, { json: true });
  add('RPC error', item.rpcError, { json: true });
  add('来源模型', item.fromModel);
  add('目标模型', item.toModel);
  const protocol = renderProtocolEventDetails(item.protocolEvents);
  if (!sections.length && !protocol) return '';
  const eventCount = Array.isArray(item.protocolEvents) ? item.protocolEvents.length : 0;
  return `<details class="process-technical-details">
    <summary>技术详情${eventCount ? ` · ${eventCount} 个原始事件` : ''}</summary>
    <div>${sections.join('')}${protocol}</div>
  </details>`;
}

function renderProcessFileChanges(changes = []) {
  return `<div class="process-detail-section"><small>文件修改</small><div class="process-file-changes">${changes.map((change) => `
    <details class="process-file-change">
      <summary><strong>${escapeHtml(change.kind || 'update')}</strong><code>${escapeHtml(change.path || '')}</code></summary>
      ${change.movePath ? `<p>移动到：<code>${escapeHtml(change.movePath)}</code></p>` : ''}
      ${change.diff ? `<pre><code>${escapeHtml(change.diff)}</code></pre>` : '<p>Janus 暂无 diff 内容。</p>'}
    </details>
  `).join('')}</div></div>`;
}

function renderProcessDetailValue(label, value, { json = false } = {}) {
  const text = json ? prettyProcessJson(value) : String(value ?? '');
  return `<div class="process-detail-section"><small>${escapeHtml(label)}</small><pre><code>${escapeHtml(text)}</code></pre></div>`;
}

function renderProtocolEventDetails(events = []) {
  if (!Array.isArray(events) || !events.length) return '';
  return `<details class="process-native-protocol">
    <summary>上游原始协议 · ${events.length} 个事件</summary>
    <div>${renderProtocolEventEntries(events)}</div>
  </details>`;
}

function renderProtocolEventEntries(events = []) {
  return events.map((event) => `<details>
      <summary><code>${escapeHtml(protocolEventSummary(event))}</code></summary>
      <pre><code>${escapeHtml(prettyProcessJson(event.envelope ?? event))}</code></pre>
    </details>`).join('');
}

function protocolEventSummary(event = {}) {
  const direction = event.direction === 'client' ? '→' : '←';
  const parts = [`#${String(event.sequence || '')}`, `${direction} ${String(event.method || 'event')}`];
  const emittedAtMs = Number(event.emittedAtMs);
  const receivedAtMs = Number(event.receivedAtMs);
  if (Number.isFinite(emittedAtMs) && emittedAtMs > 0) parts.push(`emitted ${new Date(emittedAtMs).toISOString()}`);
  if (Number.isFinite(receivedAtMs) && receivedAtMs > 0) parts.push(`received ${new Date(receivedAtMs).toISOString()}`);
  return parts.join(' · ');
}

function prettyProcessJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function renderCommandProcessItem(item = {}, { messageId = '', isLatestCommand = false } = {}) {
  const status = String(item.status || 'running');
  const failed = status === 'failed' || (Number.isInteger(item.exitCode) && item.exitCode !== 0);
  const rawCommand = String(item.command || item.detail || '').trim();
  const command = humanReadableProcessCommand(item, rawCommand);
  const output = String(item.output || '');
  const longCommand = command.length > 180 || command.split('\n').length > 3 || output.length > 1200;
  const open = item.expansionLocked
    ? item.expanded === true
    : isLatestCommand && !longCommand;
  const durationMs = Number.isFinite(item.durationMs)
    ? Math.max(0, item.durationMs)
    : Number.isFinite(item.startedAtMs) && Number.isFinite(item.completedAtMs)
      ? Math.max(0, item.completedAtMs - item.startedAtMs)
      : 0;
  const duration = formatProcessDuration(durationMs);
  const labels = {
    running: '命令执行 · 正在运行', waiting: '命令执行 · 等待批准', completed: failed ? '命令执行 · 需检查' : '命令执行 · 已完成',
    failed: '命令执行 · 需检查', cancelled: '命令执行 · 已取消', blocked: '命令执行 · 等待处理',
  };
  const meta = [
    duration,
    Number.isInteger(item.exitCode) ? `退出码 ${item.exitCode}` : '',
  ].filter(Boolean).join(' · ');
  const toggleId = `${messageId}::${item.activityId || ''}`;
  return `
    <details class="process-command is-${escapeAttr(status)}${failed ? ' has-failed' : ''}" data-process-item-toggle="${escapeAttr(toggleId)}"${open ? ' open' : ''}>
      <summary class="process-command-head">
        <span class="process-command-status"><i></i>${escapeHtml(labels[status] || '命令执行')}</span>
        <code title="${escapeAttr(command)}">${escapeHtml(command || '命令执行')}</code>
        ${meta ? `<span class="process-command-meta">${escapeHtml(meta)}</span>` : ''}
      </summary>
      <div class="process-command-body">
        ${command ? `<div><small>命令</small><pre><code>${escapeHtml(command)}</code></pre></div>` : ''}
        ${item.terminalInput ? `<div><small>终端输入</small><pre><code>${escapeHtml(item.terminalInput)}</code></pre></div>` : ''}
        ${output ? `<div><small>输出</small><pre class="process-command-output"><code>${escapeHtml(output)}</code></pre></div>` : '<p class="process-command-empty">暂无命令输出。</p>'}
        ${renderCommandTechnicalDetails(item)}
      </div>
    </details>
  `;
}

function humanReadableProcessCommand(item = {}, fallback = '') {
  const actionCommands = (Array.isArray(item.commandActions) ? item.commandActions : [])
    .map((action) => String(action?.command || '').trim())
    .filter(Boolean);
  return actionCommands.length === 1 ? actionCommands[0] : String(fallback || '').trim();
}

function renderCommandTechnicalDetails(item = {}) {
  const sections = [];
  const rawCommand = String(item.command || item.detail || '').trim();
  const displayCommand = humanReadableProcessCommand(item, rawCommand);
  if (rawCommand && rawCommand !== displayCommand) sections.push(renderProcessDetailValue('原始命令', rawCommand));
  if (item.threadId) sections.push(renderProcessDetailValue('Thread ID', item.threadId));
  if (item.turnId) sections.push(renderProcessDetailValue('Turn ID', item.turnId));
  if (item.itemId || item.activityId) sections.push(renderProcessDetailValue('Item ID', item.itemId || item.activityId));
  if (item.cwd) sections.push(renderProcessDetailValue('工作目录', item.cwd));
  if (item.processId) sections.push(renderProcessDetailValue('Process ID', item.processId));
  if (item.source) sections.push(renderProcessDetailValue('来源', item.source));
  if (Array.isArray(item.commandActions) && item.commandActions.length) {
    sections.push(renderProcessDetailValue('解析后的命令动作', item.commandActions, { json: true }));
  }
  const protocol = renderProtocolEventDetails(item.protocolEvents);
  if (!sections.length && !protocol) return '';
  const eventCount = Array.isArray(item.protocolEvents) ? item.protocolEvents.length : 0;
  return `<details class="process-technical-details">
    <summary>技术详情${eventCount ? ` · ${eventCount} 个原始事件` : ''}</summary>
    <div>${sections.join('')}${protocol}</div>
  </details>`;
}

function formatProcessDuration(durationMs = 0) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  if (!totalSeconds) return '';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderStreamingMessage(message, continuity = {}) {
  const metadata = message.metadata || {};
  const avatar = renderStandardMessageAvatar(message);
  const codexChangeSummary = metadata.streaming === false
    ? renderCodexChangeSummary(metadata.processEvents, { messageId: message.id })
    : '';
  const outputArtifactCards = codexChangeSummary
    ? ''
    : renderOutputArtifactCards(metadata.outputArtifacts, message);
  return `
    <article class="message assistant streaming-message has-chat-avatar ${continuousMessageClassNames(continuity)} ${metadata.streaming === false ? '' : 'is-streaming'}">
      ${renderMessageAvatarSlot(avatar, continuity.consecutive)}
      <div class="message-shell">
        ${renderMessageHead(message)}
        <div class="message-body">${formatText(message.content || '')}${metadata.streaming === false ? '' : '<span class="streaming-cursor" aria-hidden="true"></span>'}</div>
        ${codexChangeSummary}
        ${outputArtifactCards}
        ${renderMessageFooter(message, metadata.streaming === false ? '复制回答' : '复制当前内容')}
      </div>
    </article>
  `;
}

function renderMessageHead(message = {}) {
  const time = renderMessageTime(message);
  return time ? `<div class="message-head">${time}</div>` : '';
}

export function messageSupportsReactions(message = {}, kind = 'direct') {
  if (!message?.id || message.metadata?.localOnly || message.metadata?.withdrawn === true || message.kind === 'system') return false;
  if (String(message.kind || 'friend') !== 'friend') return false;
  if (String(message.senderAgentId || message.sender_agent_id || '').trim()) return false;
  if (String(message.recipientAgentId || message.recipient_agent_id || '').trim()) return false;
  if (kind === 'direct') {
    return ['', 'direct_message'].includes(String(message.metadata?.type || ''));
  }
  if (kind === 'group') return state.chatGroupDetail?.group?.status !== 'dissolved';
  return false;
}

function renderMessageReactions(message = {}, { kind = 'direct', groupId = '', currentUserId = '' } = {}) {
  if (!messageSupportsReactions(message, kind)) return '';
  const messageId = String(message.id || '').trim();
  const workspaceId = String(message.workspaceId || message.accountWorkspaceId || message.account_workspace_id || '').trim();
  const groups = messageReactionGroups(message.metadata || {}, currentUserId || state.currentUser?.id || '');
  if (!groups.length) return '';
  const language = state.languageMode;
  return `<div class="message-reaction-row ${groups.length ? 'has-reactions' : ''}">${groups.map((group) => {
    const names = reactionDisplayNames(group, { kind });
    const visibleNames = names.slice(0, 3);
    const extra = Math.max(0, names.length - visibleNames.length);
    const label = names.join(' ');
    return `<button class="message-reaction-chip ${group.mine ? 'is-mine' : ''}" type="button" data-message-reaction-toggle="${escapeAttr(messageId)}" data-message-reaction-kind="${escapeAttr(kind)}" data-message-reaction-group="${escapeAttr(groupId)}" data-message-reaction-workspace-id="${escapeAttr(workspaceId)}" data-message-reaction-emoji="${escapeAttr(group.emoji)}" title="${escapeAttr(label)}" aria-label="${escapeAttr(`${group.emoji}，${label}`)}"><span class="message-reaction-emoji">${escapeHtml(group.emoji)}</span><span class="message-reaction-divider" aria-hidden="true">|</span><span class="message-reaction-names">${escapeHtml(visibleNames.join(' '))}</span>${extra ? `<span class="message-reaction-extra">+${extra}</span>` : ''}</button>`;
  }).join('')}<button class="message-reaction-add" type="button" data-message-reaction-picker="${escapeAttr(messageId)}" data-message-reaction-kind="${escapeAttr(kind)}" data-message-reaction-group="${escapeAttr(groupId)}" data-message-reaction-workspace-id="${escapeAttr(workspaceId)}" title="${escapeAttr(translateUiText('添加表情', language))}" aria-label="${escapeAttr(translateUiText('添加表情', language))}">+</button></div>`;
}

function reactionDisplayNames(group = {}, { kind = 'direct' } = {}) {
  return (group.users || []).map((item) => {
    const userId = String(item.userId || item.user_id || '').trim();
    if (kind === 'group') {
      const member = (state.chatGroupDetail?.members || []).find((entry) => String(entry.userId || entry.user?.id || '') === userId);
      return naturalChatMemberName(member || { user: item, userId }) || item.displayName || userId;
    }
    if (userId === String(state.currentUser?.id || '')) return socialFriendName(state.currentUser || item);
    const friend = (state.friendOverview?.friends || []).find((entry) => String((entry.friend || entry.user || {}).id || '') === userId);
    return socialFriendName(friend?.friend || friend?.user || item) || item.displayName || userId;
  }).filter(Boolean);
}

function renderMessageReactionAction(message = {}, { kind = 'direct', groupId = '' } = {}) {
  if (!messageSupportsReactions(message, kind)) return '';
  const messageId = String(message.id || '').trim();
  const workspaceId = String(message.workspaceId || message.accountWorkspaceId || message.account_workspace_id || '').trim();
  const label = translateUiText('添加表情回应', state.languageMode);
  return `<button class="message-action-btn message-reaction-action" type="button" data-message-reaction-picker="${escapeAttr(messageId)}" data-message-reaction-kind="${escapeAttr(kind)}" data-message-reaction-group="${escapeAttr(groupId)}" data-message-reaction-workspace-id="${escapeAttr(workspaceId)}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" aria-haspopup="dialog">${iconSvg('thumbUp')}</button>`;
}

function renderMessageReactionPicker() {
  const picker = state.messageReactionPicker;
  if (!picker?.messageId) return '';
  const visibleMessages = picker.kind === 'group' ? state.chatGroupDetail?.messages || [] : state.networkConversationMessages || [];
  const message = visibleMessages.find((item) => String(item.id || '') === String(picker.messageId)) || null;
  if (!message || !messageSupportsReactions(message, picker.kind || 'direct')) return '';
  const messageElement = document.querySelector(`[data-message-id="${CSS.escape(String(message.id || ''))}"]`);
  const anchor = messageElement?.querySelector('.message-footer [data-message-reaction-picker], .message-reaction-row, .message-bubble, .social-message-bubble') || messageElement;
  const rect = anchor?.getBoundingClientRect?.() || messageElement?.getBoundingClientRect?.();
  const width = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
  const height = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
  const panelWidth = Math.min(300, Math.max(250, width - 24));
  const panelHeight = Math.min(300, Math.max(240, height - 56));
  const anchorLeft = Number.isFinite(rect?.left) ? rect.left : Number(picker.left || 8);
  const anchorRight = Number.isFinite(rect?.right) ? rect.right : anchorLeft;
  const messageRect = messageElement?.getBoundingClientRect?.() || rect;
  const messageLeft = Number.isFinite(messageRect?.left) ? messageRect.left : anchorLeft;
  const messageRight = Number.isFinite(messageRect?.right) ? messageRect.right : anchorRight;
  const left = Math.max(8, Math.min(anchorLeft, Math.max(8, width - panelWidth - 8)));
  const belowTop = Number.isFinite(rect?.bottom) ? rect.bottom + 8 : Number(picker.top || 8);
  const aboveTop = Number.isFinite(rect?.top) ? rect.top - panelHeight - 8 : belowTop;
  const hasRoomBelow = belowTop + panelHeight <= height - 8;
  const hasRoomAbove = aboveTop >= 8;
  const top = hasRoomBelow ? belowTop : hasRoomAbove ? aboveTop : Math.max(8, Math.min(belowTop, height - panelHeight - 8));
  const adjustedLeft = messageRight + panelWidth + 8 <= width ? Math.max(8, Math.min(messageRight + 8, width - panelWidth - 8))
    : messageLeft - panelWidth - 8 >= 8 ? messageLeft - panelWidth - 8 : left;
  const option = (emoji) => `<button type="button" role="menuitem" data-message-reaction-option="${escapeAttr(picker.messageId)}" data-message-reaction-kind="${escapeAttr(picker.kind || 'direct')}" data-message-reaction-group="${escapeAttr(picker.groupId || '')}" data-message-reaction-workspace-id="${escapeAttr(picker.workspaceId || '')}" data-message-reaction-emoji="${escapeAttr(emoji)}" title="${escapeAttr(`${translateUiText('回应', state.languageMode)} ${emoji}`)}">${escapeHtml(emoji)}</button>`;
  return `<div class="message-reaction-picker-layer" data-message-reaction-close>
    <div class="message-reaction-picker is-complete" role="dialog" aria-label="${escapeAttr(translateUiText('选择一个表情', state.languageMode))}" style="left:${adjustedLeft}px;top:${top}px;--reaction-picker-height:${panelHeight}px" tabindex="-1" data-message-reaction-popover>
      <header><strong>${escapeHtml(translateUiText('表情回应', state.languageMode))}</strong><span>${escapeHtml(translateUiText('选择一个表情', state.languageMode))}</span></header>
      <section><h4>${escapeHtml(translateUiText('常用表情', state.languageMode))}</h4><div class="message-reaction-grid">${MESSAGE_REACTION_EMOJIS.map(option).join('')}</div></section>
      <div class="message-reaction-scroll">
        <h4>${escapeHtml(translateUiText('默认表情', state.languageMode))}</h4>
        ${COMPOSER_DEFAULT_EMOJI_CATEGORIES.map((category) => `<section><h5>${escapeHtml(translateUiText(category.name, state.languageMode))}</h5><div class="message-reaction-grid">${category.emojis.map(option).join('')}</div></section>`).join('')}
      </div>
    </div>
  </div>`;
}

function renderMessageReceiptButton(message = {}, { mine = false, directPeer = null } = {}) {
  if (!mine || message.metadata?.localOnly || message.metadata?.withdrawn === true || message.kind === 'system') return '';
  const agent = Boolean(message.senderAgentId || message.sender_agent_id);
  if (agent) return '';
  const groupSummary = message.receiptSummary || message.receipt_summary || null;
  const direct = Boolean(directPeer);
  if (direct && String(directPeer?.id || '') === String(state.currentUser?.id || '')) return '';
  const total = direct ? 1 : Math.max(0, Number(groupSummary?.total || 0));
  if (!total) return '';
  const read = direct
    ? (message.status === 'read' || Boolean(message.readAt || message.read_at) ? 1 : 0)
    : Math.max(0, Math.min(total, Number(groupSummary?.read || 0)));
  const complete = read === total;
  const label = state.languageMode === 'en' ? `${read} of ${total} read` : `${read}/${total} 已读`;
  return `<button class="message-receipt-trigger${complete ? ' is-complete' : ''}" type="button" data-message-receipt="${escapeAttr(message.id || '')}" data-message-receipt-kind="${direct ? 'direct' : 'group'}" style="--receipt-progress:${(read / total) * 100}%;--receipt-segments:${total}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" aria-haspopup="dialog"><span aria-hidden="true"></span></button>`;
}

function renderMessageBubbleReceiptAnchor(content = '', receipt = '') {
  if (!receipt) return content;
  return `<div class="message-bubble-receipt-anchor">${content}${receipt}</div>`;
}

function renderMessageReceiptPopover() {
  const popover = state.messageReceiptPopover;
  if (!popover?.messageId) return '';
  const visibleMessages = state.chatGroupId ? state.chatGroupDetail?.messages || [] : state.networkConversationMessages || [];
  if (!visibleMessages.some((message) => String(message.id || '') === String(popover.messageId))) return '';
  const details = Array.isArray(popover.details) ? popover.details : [];
  const read = details.filter((item) => item.read);
  const unread = details.filter((item) => !item.read);
  const renderColumn = (title, items, readColumn) => `<section class="message-receipt-column ${readColumn ? 'is-read' : 'is-unread'}"><header><strong>${items.length}</strong><span>${escapeHtml(title)}</span></header><div>${items.length ? items.map((item) => {
    const receiptUser = item.user || {};
    const userId = String(item.userId || item.user_id || receiptUser.id || '').trim();
    const currentUser = userId && userId === String(state.currentUser?.id || '') ? state.currentUser : null;
    const knownUser = currentUser || chatAvatarProfileUser(userId);
    const user = knownUser ? { ...receiptUser, ...knownUser, id: userId || knownUser.id } : { ...receiptUser, id: userId || receiptUser.id };
    const name = socialFriendName(user) || item.userId || '群成员';
    return `<article>${renderUserAvatar(user, { className: 'network-user-avatar message-receipt-avatar', title: name, fallbackLabel: socialInitials(user) })}<span><strong data-no-localize>${escapeHtml(name)}</strong>${readColumn && item.readAt ? `<small>${escapeHtml(formatMessageTime(item.readAt))}</small>` : ''}</span></article>`;
  }).join('') : `<p>${readColumn ? '暂无已读成员' : '全部成员已读'}</p>`}</div></section>`;
  return `<div class="message-receipt-layer" data-message-receipt-close><aside class="message-receipt-popover" role="dialog" aria-modal="false" aria-label="消息已读情况" data-message-receipt-popover data-placement="${escapeAttr(popover.placement || 'auto')}" style="left:${Math.max(8, Number(popover.left || 8))}px;top:${Math.max(8, Number(popover.top || 8))}px" tabindex="-1">
    ${renderColumn('已读', read, true)}${renderColumn('未读', unread, false)}
  </aside></div>`;
}

function renderMessageFooter(message = {}, label = '复制回答', options = {}) {
  const actions = renderMessageActions(message, label, options);
  if (!actions) return '';
  return `<div class="message-footer">${actions}</div>`;
}

function renderMessageActions(message, label = '复制回答', { reactionKind = '', reactionGroupId = '' } = {}) {
  if (message?.metadata?.favoriteEmoji === true) return '';
  const canCopy = isCopyableMessage(message);
  const canOpenMenu = Boolean(message?.id && String(message?.content || '').trim());
  const reactionAction = reactionKind ? renderMessageReactionAction(message, { kind: reactionKind, groupId: reactionGroupId }) : '';
  if (!canCopy && !canOpenMenu && !reactionAction) return '';
  return `
    <div class="message-actions">
      ${canCopy ? `
        <button class="message-action-btn" type="button" data-copy-message="${escapeAttr(message.id)}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">
          ${iconSvg('copy')}
        </button>
      ` : ''}
      ${canOpenMenu ? `
        <button class="message-action-btn" type="button" data-message-inline-more="${escapeAttr(message.id)}" title="更多操作" aria-label="更多操作">
          ${iconSvg('more')}
        </button>
      ` : ''}
      ${reactionAction}
    </div>
  `;
}

function attachmentImageUrl(file = {}) {
  return file.fileUrl || file.file_url || file.preview_url || file.previewUrl || file.download_url || file.downloadUrl || file.url || '';
}

function messageAttachmentIcon(file = {}, visualKind = 'file') {
  if (visualKind === 'image' && attachmentImageUrl(file)) {
    return `<img src="${escapeAttr(attachmentImageUrl(file))}" alt="" />`;
  }
  const labels = {
    pdf: 'PDF',
    word: 'W',
    ppt: 'P',
    excel: 'X',
    text: 'TXT',
    code: 'CODE',
    archive: 'ZIP',
    installer: 'APP',
    image: 'IMG',
    file: 'FILE',
  };
  return `<span class="file-type-badge file-type-${escapeAttr(visualKind)}">${escapeHtml(labels[visualKind] || 'FILE')}</span>`;
}

function messageAttachmentKindLabel(visualKind = 'file') {
  return ({
    pdf: 'PDF',
    word: 'Word',
    ppt: 'PowerPoint',
    excel: 'Spreadsheet',
    text: 'Text',
    code: 'Code',
    archive: 'Archive',
    installer: 'Installer',
    image: 'Image',
    file: 'File',
  })[visualKind] || 'File';
}

function renderMessageTime(message = {}) {
  const label = formatMessageTime(message.createdAt || message.created_at || message.metadata?.createdAt || '');
  if (!label) return '';
  return `<div class="message-time">${escapeHtml(label)}</div>`;
}

function isCopyableMessage(message = {}) {
  if (!message.id || !String(message.content || '').trim()) return false;
  if (message.metadata?.transient === 'run-status') return false;
  if (parseArtifactMessage(message.content)) return false;
  return true;
}

export function parseArtifactMessage(content) {
  const text = String(content || '');
  if (!text.startsWith('__JANUS_ARTIFACT__')) return null;
  try {
    const payload = JSON.parse(text.slice('__JANUS_ARTIFACT__'.length));
    return payload?.kind && payload?.data ? payload : null;
  } catch {
    return null;
  }
}

export function renderTaskArtifactMessage(content) {
  const artifact = parseArtifactMessage(content);
  if (artifact?.kind === 'image') return renderImageArtifactMessage(artifact.data);
  if (artifact?.kind === 'ppt') return renderPptArtifactMessage(artifact.data);
  return '';
}

function renderFileActionButtons(file = {}, className = 'artifact-file-actions') {
  const payload = filePayloadAttr(file);
  const remotelyDownloadable = Boolean(file.remote_file_id || file.remoteFileId);
  const imageFavorite = attachmentVisualKind({ kind: file.kind, uploaded: { filename: file.name }, name: file.name }) === 'image';
  if (!file.path && !remotelyDownloadable) return `<span class="${escapeAttr(className)}">${iconSvg('chevronRight')}</span>`;
  return `
    <span class="${escapeAttr(className)}">
      ${imageFavorite ? `<button class="artifact-icon-action" type="button" data-add-emoji-favorite="${payload}" title="添加到表情" aria-label="添加到表情">☆</button>` : ''}
      <button class="artifact-icon-action" type="button" data-save-file="${payload}" title="另存为" aria-label="另存为">${iconSvg('download')}</button>
      ${file.path ? `<button class="artifact-icon-action" type="button" data-show-file="${payload}" title="在文件夹中显示" aria-label="在文件夹中显示">${iconSvg('folder')}</button>` : ''}
      <button class="artifact-icon-action" type="button" data-open-file="${payload}" title="打开文件" aria-label="打开文件">${iconSvg('external')}</button>
    </span>
  `;
}

function renderImageArtifactMessage(artifact, message = {}) {
  const file = artifact || {};
  const name = file.name || 'generated-image.png';
  const preview = file.preview || {};
  const imageUrl = file.file_url || file.url || file.download_url || '';
  const imageFile = normalizeFilePayload({
    kind: 'image',
    name,
    path: file.path || '',
    fileUrl: imageUrl,
    file_url: imageUrl,
    download_url: file.download_url || imageUrl,
    size: file.size || 0,
    messageId: message.id || '',
    sessionId: message.sessionId || message.session_id || state.currentSessionId || '',
  });
  const previewPayload = filePayloadAttr(imageFile);
  return `
    <article class="message system artifact-message">
      <div class="artifact-card artifact-image-card">
        <div class="artifact-filebar">
          <button class="artifact-file-main" type="button" data-preview-file="${previewPayload}">
            <span class="artifact-file-icon artifact-file-image">${iconSvg('image')}</span>
            <span class="artifact-file-name">${escapeHtml(name)}</span>
          </button>
          ${renderFileActionButtons(imageFile)}
        </div>
        <button class="artifact-preview artifact-image-preview" type="button" data-preview-file="${previewPayload}" data-image-context-file="${previewPayload}">
          <img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(preview.subtitle || name)}" />
        </button>
        <div class="artifact-companion">
          <div class="artifact-companion-preview artifact-image-caption">
            <div class="artifact-image-model">${escapeHtml(file.model || state.imageModel)}</div>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderPptArtifactMessage(artifact, message = {}) {
  const ppt = artifact || {};
  const deckName = ppt.deck_name || 'presentation.pptx';
  const hasNotes = Boolean(ppt.notes_file || ppt.notes_url || ppt.notes);
  const notesName = ppt.notes_name || 'speaker_notes.md';
  const preview = ppt.preview || {};
  const slideImageUrls = ppt.deck_slide_urls || (ppt.slide_image_files || []).map((file) => file.file_url).filter(Boolean);
  const officePdfUrl = ppt.deck_pdf_url || ppt.pdf_file?.file_url || '';
  const hasOfficePreview = Boolean(slideImageUrls.length || officePdfUrl);
  const deckFile = normalizeFilePayload({
    kind: 'pptx',
    name: deckName,
    filename: deckName,
    path: ppt.deck || ppt.deck_file?.path || '',
    fileUrl: ppt.deck_url || ppt.deck_file?.file_url || '',
    file_url: ppt.deck_url || ppt.deck_file?.file_url || '',
    download_url: ppt.deck_file?.download_url || ppt.deck_url || '',
    office_pdf_url: officePdfUrl,
    preview_render_mode: ppt.preview_render_mode || (hasOfficePreview ? 'office' : 'fallback'),
    cover_url: ppt.deck_cover_url || ppt.cover_file?.file_url || '',
    slide_image_urls: slideImageUrls,
    size: ppt.deck_file?.size || 0,
    messageId: message.id || '',
    sessionId: message.sessionId || message.session_id || state.currentSessionId || '',
  });
  const notesFile = hasNotes ? normalizeFilePayload({
    kind: ppt.notes_file?.kind || 'markdown',
    name: notesName,
    filename: notesName,
    path: ppt.notes || ppt.notes_file?.path || '',
    fileUrl: ppt.notes_url || ppt.notes_file?.file_url || '',
    file_url: ppt.notes_url || ppt.notes_file?.file_url || '',
    download_url: ppt.notes_file?.download_url || ppt.notes_url || '',
    size: ppt.notes_file?.size || 0,
    messageId: message.id || '',
    sessionId: message.sessionId || message.session_id || state.currentSessionId || '',
  }) : null;
  const deckPayload = filePayloadAttr(deckFile);
  const notesPayload = notesFile ? filePayloadAttr(notesFile) : '';
  const coverUrl = hasOfficePreview ? ppt.deck_cover_url || ppt.cover_file?.file_url || '' : '';
  return `
    <article class="message system artifact-message ppt-artifact-message">
      <div class="artifact-card artifact-preview-card">
        <div class="artifact-filebar">
          <button class="artifact-file-main" type="button" data-preview-file="${deckPayload}">
            <span class="artifact-file-icon artifact-file-ppt">${iconSvg('presentation')}</span>
            <span class="artifact-file-name">${escapeHtml(deckName)}</span>
          </button>
          ${renderFileActionButtons(deckFile)}
        </div>
        <button class="artifact-preview artifact-preview-ppt ${coverUrl ? 'has-cover-image' : ''}" type="button" data-preview-file="${deckPayload}">
          ${coverUrl
            ? `<img class="ppt-cover-preview-image" src="${escapeAttr(coverUrl)}" alt="${escapeAttr(preview.title || deckName)}" />`
            : `<div class="ppt-preview-slide"><div class="ppt-preview-title">${escapeHtml(preview.title || 'PPT 文件已生成')}</div><div class="ppt-preview-subtitle">${escapeHtml(preview.subtitle || '')}</div></div>`}
        </button>
        ${notesFile ? `<div class="artifact-companion">
          <div class="artifact-secondary-link">
            <button class="artifact-file-main" type="button" data-preview-file="${notesPayload}">
              <span class="artifact-file-icon artifact-file-md">${iconSvg('document')}</span>
              <span class="artifact-file-name">${escapeHtml(notesName)}</span>
            </button>
            ${renderFileActionButtons(notesFile)}
          </div>
          <div class="artifact-companion-preview artifact-paper-preview">
            <div class="artifact-paper-text">${escapeHtml(preview.notes_excerpt || 'Speaker notes are available.')}</div>
          </div>
        </div>` : ''}
      </div>
    </article>
  `;
}

function renderConversation(messages) {
  if (state.employeeConversationHistoryViewer) {
    return `
      <section class="chat-panel conversation-panel employee-history-viewer-panel">
        ${renderEmployeeConversationHistoryViewer()}
      </section>
    `;
  }
  return `
    <section class="chat-panel conversation-panel">
      <div class="conversation-top-stack">
        ${renderLocalTaskWorkspaceHeader()}
        ${renderEmployeeConversationContext()}
      </div>
      <div class="conversation-content-stage">
        ${isCurrentUBuddyConversation() ? renderUBuddyCenterDrawer() : ''}
        <div class="message-list" id="message-list" data-message-scroll-key="${escapeAttr(messageScrollKey())}">${messages || renderConversationLoadingState()}</div>
      </div>
      ${renderUBuddyNewUpdatesButton()}
      ${renderComposer('compact')}
    </section>
  `;
}

export function renderUBuddyTaskStrip() {
  if (state.uBuddyFeatureFlags?.newTaskWorkspaceUi === false || !isCurrentUBuddyConversation()) return '';
  const sessionId = String(state.currentSessionId || '').trim();
  if (!sessionId) return '';
  const tasks = uBuddyTasksForCurrentSession(sessionId);
  if (!tasks.length) return '';
  const currentUserId = String(state.currentUser?.id || '').trim();
  const counts = tasks.reduce((result, task) => {
    const group = uBuddyTaskDisplayStatus(task, { currentUserId }).group;
    result[group] = Number(result[group] || 0) + 1;
    return result;
  }, {});
  const drawerOpen = Boolean(state.uBuddyTaskDrawerOpenBySessionId?.[sessionId] || state.uBuddyTaskStripOpenBySessionId?.[sessionId]);
  return `<section class="ubuddy-task-strip" data-ubuddy-task-strip="${escapeAttr(sessionId)}">
    <header class="ubuddy-task-strip-head">
      <span class="ubuddy-task-strip-title">${iconSvg('tasks')}<span><strong>任务</strong><small>${tasks.length} 个任务</small></span></span>
      <div class="ubuddy-task-strip-counts" aria-label="任务状态概览">
        ${renderUBuddyTaskCount('needs_my_action', '待我处理', counts.needs_my_action || 0, true)}
        ${renderUBuddyTaskCount('waiting_counterparty', '等待对方', counts.waiting_counterparty || 0)}
        ${renderUBuddyTaskCount('active', '进行中', (counts.active || 0) + (counts.retrying || 0))}
      </div>
      <button class="ubuddy-task-drawer-toggle" type="button" data-ubuddy-task-drawer-toggle="${escapeAttr(sessionId)}" aria-expanded="${drawerOpen ? 'true' : 'false'}" aria-label="${drawerOpen ? '关闭任务面板' : '打开任务面板'}" title="${drawerOpen ? '关闭任务面板' : '打开任务面板'}">${iconSvg(drawerOpen ? 'panelRightClose' : 'panelRightOpen')}</button>
    </header>
  </section>`;
}

export function renderUBuddyCenterDrawer() {
  if (!isCurrentUBuddyConversation() || !state.uBuddyCenterOpen) return '';
  const delivery = state.uBuddyCenterOpen === 'deliveries';
  const page = delivery ? state.uBuddyDeliveryCenterPage : state.uBuddyTaskCenterPage;
  const items = Array.isArray(page?.items) ? page.items : [];
  const title = delivery ? '交付中心' : '全部任务';
  const subtitle = delivery ? '需要你最终审核的交付' : '当前工作空间的 uBuddy 任务';
  return `<div class="ubuddy-center-layer" data-ubuddy-center-layer>
    <button class="ubuddy-center-backdrop" type="button" data-ubuddy-center-close aria-label="关闭${escapeAttr(title)}"></button>
    <aside class="ubuddy-center-drawer" role="dialog" aria-modal="false" aria-label="${escapeAttr(title)}" tabindex="-1">
      <header><span>${iconSvg(delivery ? 'clipboard' : 'tasks')}<span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span></span><button type="button" data-ubuddy-center-close aria-label="关闭" title="关闭">${iconSvg('x')}</button></header>
      ${delivery ? renderDeliveryCenterFilters(page?.counts || {}) : renderTaskCenterControls(page?.counts || {})}
      <div class="ubuddy-center-list" data-ubuddy-center-list>
        ${state.uBuddyCenterLoading && !items.length ? '<div class="ubuddy-center-state"><i></i><span>正在读取…</span></div>' : ''}
        ${state.uBuddyCenterError ? `<div class="ubuddy-center-state is-error"><span>${escapeHtml(state.uBuddyCenterError)}</span><button type="button" data-ubuddy-center-retry>重新加载</button></div>` : ''}
        ${items.map((item) => delivery ? renderDeliveryCenterRow(item) : renderTaskCenterRow(item)).join('')}
        ${!state.uBuddyCenterLoading && !state.uBuddyCenterError && !items.length ? `<div class="ubuddy-center-empty">${delivery ? '当前分类没有交付记录。' : '当前分类没有任务。'}</div>` : ''}
      </div>
      ${page?.nextCursor ? `<footer><button type="button" data-ubuddy-center-more ${state.uBuddyCenterLoading ? 'disabled' : ''}>${state.uBuddyCenterLoading ? '正在加载…' : '加载更多'}</button></footer>` : ''}
    </aside>
  </div>`;
}

function renderTaskCenterControls(counts = {}) {
  const filter = state.uBuddyTaskCenterFilter || 'all';
  return `<div class="ubuddy-center-controls"><label>${iconSvg('search')}<input type="search" data-ubuddy-task-center-search value="${escapeAttr(state.uBuddyTaskCenterQuery || '')}" placeholder="搜索任务" aria-label="搜索任务"></label><nav aria-label="任务筛选">${[
    ['all', '全部'], ['needs_action', '待我处理'], ['active', '进行中'], ['waiting', '等待中'], ['closed', '已结束'],
  ].map(([key, label]) => `<button type="button" data-ubuddy-center-filter="${key}" class="${filter === key ? 'is-active' : ''}"><span>${label}</span><b>${Math.max(0, Number(counts[key] || 0))}</b></button>`).join('')}</nav></div>`;
}

function renderDeliveryCenterFilters(counts = {}) {
  const filter = state.uBuddyDeliveryCenterFilter || 'pending';
  return `<nav class="ubuddy-delivery-center-filters" aria-label="交付筛选">${[
    ['pending', '待审核'], ['accepted', '已验收'], ['revision_requested', '已打回'],
  ].map(([key, label]) => `<button type="button" data-ubuddy-center-filter="${key}" class="${filter === key ? 'is-active' : ''}"><span>${label}</span><b>${Math.max(0, Number(counts[key] || 0))}</b></button>`).join('')}</nav>`;
}

function renderTaskCenterRow(item = {}) {
  const labels = { needs_action: '待我处理', active: '进行中', waiting: '等待中', closed: '已结束' };
  const progress = item.progress || {};
  const kind = item.kind === 'delegation' ? 'delegation' : 'task_run';
  const workspaceId = item.delegationId || item.taskRunId || item.id || '';
  const attrs = kind === 'delegation'
    ? `data-network-delegation="${escapeAttr(item.delegationId || item.id || '')}"`
    : `data-task-card-action="${TASK_CARD_ACTIONS.OPEN_WORKSPACE}" data-task-workspace-kind="task_run" data-task-workspace-id="${escapeAttr(item.taskRunId || item.id || '')}" data-task-run-id="${escapeAttr(item.taskRunId || item.id || '')}" data-task-source-conversation-id="${escapeAttr(item.sourceConversationId || '')}" data-task-source-message-id="${escapeAttr(item.sourceMessageId || '')}" data-task-return-surface="session"`;
  const status = String(item.status || '').toLowerCase();
  const cancellable = kind === 'task_run'
    ? ['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'cancelling'].includes(status)
    : item.requester === true && ['assigned', 'preparing', 'awaiting_approval', 'accepted', 'running', 'working', 'draft_ready', 'submitted', 'revision_requested', 'blocked', 'failed'].includes(status);
  const cancelAttrs = `data-task-card-action="${TASK_CARD_ACTIONS.CANCEL_TASK}" data-task-workspace-kind="${kind}" data-task-workspace-id="${escapeAttr(workspaceId)}"${kind === 'task_run' ? ` data-task-run-id="${escapeAttr(workspaceId)}"` : ''}`;
  return `<article class="ubuddy-center-row is-${escapeAttr(item.group || 'active')}"><button class="ubuddy-center-row-open" type="button" ${attrs}><span class="ubuddy-center-row-head"><strong>${escapeHtml(item.title || '未命名任务')}</strong><em>${escapeHtml(labels[item.group] || item.status || '任务')}</em></span><p>${escapeHtml(clipInline(item.summary || '查看任务详情和执行记录。', 120))}</p><span class="ubuddy-center-row-meta"><small>${escapeHtml(item.actor || 'uBuddy')}</small><small>${Number(progress.total || 0) ? `${Math.max(0, Number(progress.completed || 0))}/${Math.max(0, Number(progress.total || 0))} · ` : ''}${escapeHtml(formatMessageTime(item.updatedAt || item.sortTime) || '刚刚更新')}</small></span></button>${cancellable ? `<footer><button class="is-danger" type="button" ${cancelAttrs} ${status === 'cancelling' ? 'disabled' : ''}>${status === 'cancelling' ? '正在结束…' : '结束任务'}</button></footer>` : ''}</article>`;
}

function renderDeliveryCenterRow(item = {}) {
  const statusLabel = { pending: '待审核', accepted: '已验收', revision_requested: '已打回' }[item.status] || '交付';
  const attrs = item.kind === 'delegation'
    ? `data-network-delegation="${escapeAttr(item.delegationId || '')}"`
    : `data-task-card-action="${TASK_CARD_ACTIONS.OPEN_RESULT}" data-task-workspace-kind="task_run" data-task-workspace-id="${escapeAttr(item.taskRunId || '')}" data-task-run-id="${escapeAttr(item.taskRunId || '')}" data-delivery-submission-id="${escapeAttr(item.submissionId || '')}" data-task-source-conversation-id="${escapeAttr(item.sourceConversationId || '')}" data-task-source-message-id="${escapeAttr(item.sourceMessageId || '')}" data-task-return-surface="session"`;
  return `<article class="ubuddy-center-row ubuddy-delivery-row is-${escapeAttr(item.status || 'pending')}"><button type="button" ${attrs}><span class="ubuddy-center-row-head"><strong>${escapeHtml(item.title || '任务交付')}</strong><em>${escapeHtml(statusLabel)}</em></span><p>${escapeHtml(clipInline(item.summary || item.decisionSummary || '查看本次交付内容。', 120))}</p><span class="ubuddy-center-row-meta"><small>版本 ${Math.max(1, Number(item.versionNo || 1))} · ${Math.max(0, Number(item.fileCount || 0))} 个文件 · ${escapeHtml(item.actor || 'uBuddy')}</small><small>${escapeHtml(formatMessageTime(item.decidedAt || item.submittedAt || item.sortTime) || '')}</small></span></button></article>`;
}

export function renderUBuddyTaskDrawer() {
  if (state.uBuddyFeatureFlags?.newTaskWorkspaceUi === false || !isCurrentUBuddyConversation()) return '';
  const sessionId = String(state.currentSessionId || '').trim();
  if (!sessionId || !state.uBuddyTaskDrawerOpenBySessionId?.[sessionId] && !state.uBuddyTaskStripOpenBySessionId?.[sessionId]) return '';
  const tasks = uBuddyTasksForCurrentSession(sessionId);
  const currentUserId = String(state.currentUser?.id || '').trim();
  const counts = tasks.reduce((result, task) => {
    const group = uBuddyTaskDisplayStatus(task, { currentUserId }).group;
    result[group] = Number(result[group] || 0) + 1;
    return result;
  }, {});
  const filter = state.uBuddyTaskStripFilterBySessionId?.[sessionId]
    || (counts.needs_my_action ? 'needs_my_action'
      : counts.active || counts.retrying ? 'active'
        : counts.waiting_counterparty ? 'waiting_counterparty'
          : counts.closed ? 'closed' : 'all');
  const visibleTasks = filterUBuddyTasks(tasks, filter).slice(0, 24);
  return `<div class="ubuddy-task-drawer-layer" data-ubuddy-task-drawer-layer>
    <button class="ubuddy-task-drawer-backdrop" type="button" data-ubuddy-task-drawer-close aria-label="关闭任务面板"></button>
    <aside class="ubuddy-task-drawer" role="dialog" aria-modal="false" aria-label="uBuddy 任务">
      <header><span>${iconSvg('tasks')}<span><strong>任务</strong><small>集中查看进展和待办</small></span></span><button type="button" data-ubuddy-task-drawer-close aria-label="关闭任务面板" title="关闭">${iconSvg('x')}</button></header>
      <nav class="ubuddy-task-strip-filters" aria-label="任务筛选">
        ${renderUBuddyTaskFilter('needs_my_action', '待我处理', counts.needs_my_action || 0, filter)}
        ${renderUBuddyTaskFilter('waiting_counterparty', '等待对方', counts.waiting_counterparty || 0, filter)}
        ${renderUBuddyTaskFilter('active', '进行中', (counts.active || 0) + (counts.retrying || 0), filter)}
        ${renderUBuddyTaskFilter('closed', '已结束', counts.closed || 0, filter)}
        ${renderUBuddyTaskFilter('all', '全部', tasks.length, filter)}
      </nav>
      <div class="ubuddy-task-strip-list">${visibleTasks.map((task) => renderUBuddyTaskStripRow(task)).join('') || '<p class="ubuddy-task-strip-empty">当前分类没有任务。</p>'}</div>
    </aside>
  </div>`;
}

function renderUBuddyTaskCount(filter, label, count, urgent = false) {
  return `<button type="button" class="${urgent && count ? 'has-items' : ''}" data-ubuddy-task-count-filter="${escapeAttr(filter)}"><span>${escapeHtml(label)}</span><b>${Math.max(0, Number(count || 0))}</b></button>`;
}

function renderUBuddyTaskFilter(key, label, count, selected) {
  return `<button type="button" class="${selected === key ? 'is-active' : ''}" data-ubuddy-task-strip-filter="${escapeAttr(key)}"><span>${escapeHtml(label)}</span><b>${Math.max(0, Number(count || 0))}</b></button>`;
}

function renderUBuddyTaskStripRow(task = {}) {
  const status = uBuddyTaskDisplayStatus(task, { currentUserId: state.currentUser?.id || '' });
  const progress = taskProgressCounts(task);
  const activeNode = (task.nodes || []).find((node) => ['running', 'queued', 'ready', 'retry_wait', 'waiting', 'blocked'].includes(String(node.status || '')));
  const sourceMessageId = taskSourceMessageId(task, state.messages);
  const updatedAt = task.updatedAt || task.updated_at || task.createdAt || task.created_at || '';
  const cancellable = ['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'cancelling'].includes(String(task.status || ''));
  const deliveryPending = task.confirmationRequired === true
    || task.metadata?.confirmationRequired === true
    || String(task.metadata?.finalDelivery?.state || '').toLowerCase() === 'delivered'
    || ['submitted'].includes(String(task.status || '').toLowerCase());
  const navigationAttributes = `data-task-workspace-kind="task_run" data-task-workspace-id="${escapeAttr(task.id || '')}" data-task-run-id="${escapeAttr(task.id || '')}" data-task-source-conversation-id="${escapeAttr(state.currentSessionId || '')}" data-task-source-message-id="${escapeAttr(sourceMessageId)}" data-task-return-surface="session"`;
  const primaryAction = deliveryPending ? TASK_CARD_ACTIONS.OPEN_RESULT : TASK_CARD_ACTIONS.OPEN_WORKSPACE;
  const primaryLabel = deliveryPending ? (status.group === 'needs_my_action' ? '查看并验收' : '查看交付') : status.group === 'needs_my_action' ? '查看并处理' : '打开任务';
  return `<article class="ubuddy-task-strip-row is-${escapeAttr(status.tone)}">
    <button class="ubuddy-task-strip-row-open" type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_WORKSPACE}" ${navigationAttributes}>
      <span class="ubuddy-task-strip-row-main"><strong>${escapeHtml(task.title || '未命名任务')}</strong><small>${escapeHtml(activeNode?.title || task.summary || status.label)}</small></span>
      <span class="ubuddy-task-strip-row-meta"><b>${escapeHtml(status.label)}</b><small>${progress.total ? `${progress.completed}/${progress.total} · ` : ''}${escapeHtml(formatMessageTime(updatedAt) || '刚刚更新')}</small></span>
    </button>
    <footer><button type="button" data-task-card-action="${primaryAction}" ${navigationAttributes}>${escapeHtml(primaryLabel)}</button>${cancellable ? `<button class="is-danger" type="button" data-task-card-action="${TASK_CARD_ACTIONS.CANCEL_TASK}" ${navigationAttributes}>${task.status === 'cancelling' ? '正在停止…' : '停止整个任务'}</button>` : ''}</footer>
  </article>`;
}

function filterUBuddyTasks(tasks = [], filter = 'needs_my_action') {
  if (filter === 'all') return tasks;
  if (filter === 'active') return tasks.filter((task) => ['active', 'retrying'].includes(uBuddyTaskDisplayStatus(task, { currentUserId: state.currentUser?.id || '' }).group));
  return tasks.filter((task) => uBuddyTaskDisplayStatus(task, { currentUserId: state.currentUser?.id || '' }).group === filter);
}

function uBuddyTasksForCurrentSession(sessionId = '') {
  const ids = new Set(taskIdsForMessages(state.messages));
  for (const task of state.tasks || []) if (taskBelongsToSession(task, sessionId, state.messages)) ids.add(String(task.id || ''));
  return [...ids]
    .map((id) => state.uBuddyTaskViewsById?.[id] || (state.tasks || []).find((task) => String(task.id || '') === id) || null)
    .filter(Boolean)
    .sort((left, right) => compareUBuddyTasks(left, right, { currentUserId: state.currentUser?.id || '' }));
}

function isCurrentUBuddyConversation() {
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  return state.homeMode === 'secretary' || session?.departmentId === 'secretary_department';
}

function renderUBuddyNewUpdatesButton() {
  if (!isCurrentUBuddyConversation() || !state.currentSessionId) return '';
  const count = Math.max(0, Number(state.uBuddyTaskUnseenBySessionId?.[state.currentSessionId] || 0));
  return `<button class="ubuddy-new-task-updates" type="button" data-ubuddy-new-task-updates ${count ? '' : 'hidden'}>${count ? `${count} 条新进展` : '新进展'} ↓</button>`;
}

function renderConversationLoadingState() {
  if (!state.currentSessionId
    || state.messagePagination?.sessionId !== state.currentSessionId
    || state.messagePagination?.initialLoading !== true) return '';
  return `<div class="conversation-message-loading" role="status" aria-live="polite" aria-label="正在加载对话消息">
    <span class="conversation-message-loading-avatar" aria-hidden="true"></span>
    <span class="conversation-message-loading-lines" aria-hidden="true"><i></i><i></i><i></i></span>
    <small>正在加载对话…</small>
  </div>`;
}

function renderEmployeeConversationContext() {
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  const agentInstanceId = session?.agentInstanceId || session?.agent_instance_id || state.currentAgentInstanceId || '';
  const overview = agentInstanceId ? state.employeeConversationOverviewByInstanceId?.[agentInstanceId] : null;
  const activeWork = overview?.activeWork || {};
  const hasActiveTask = activeWork.route === 'task_run'
    && activeWork.taskRunId
    && !['completed', 'failed', 'cancelled'].includes(String(activeWork.status || '').toLowerCase());
  const historyGroups = Array.isArray(overview?.historyGroups) ? overview.historyGroups : [];
  const historySessions = Array.isArray(overview?.historySessions) ? overview.historySessions : [];
  if (!hasActiveTask && !historyGroups.length && !historySessions.length) return '';
  return `<aside class="employee-conversation-context ${hasActiveTask ? 'has-active-work' : 'is-history-only'}" data-employee-conversation-context="${escapeAttr(agentInstanceId)}"${hasActiveTask ? ' aria-live="polite"' : ''}>
    ${hasActiveTask ? renderEmployeeActiveTask(agentInstanceId, activeWork, overview?.taskQueue) : ''}
    ${historyGroups.length ? `<details class="employee-conversation-history"><summary>历史对话 ${historyGroups.length}</summary><div>${historyGroups.map((item) => `<button type="button" data-employee-history-group="${escapeAttr(item.id || '')}" data-agent-instance-id="${escapeAttr(agentInstanceId)}"><span><strong>${escapeHtml(item.title || '历史对话')}</strong><small>${escapeHtml(`${employeeHistoryKindLabel(item.kind)} · ${Number(item.messageCount || 0)} 条 · ${formatMessageTime(item.lastMessageAt || '')}`)}</small></span><em>只读查看</em></button>`).join('')}</div></details>` : historySessions.length ? `<details class="employee-conversation-history"><summary>历史会话 ${historySessions.length}</summary><div>${historySessions.map((item) => `<button type="button" data-employee-history-session="${escapeAttr(item.id || '')}"><span><strong>${escapeHtml(item.title || '历史会话')}</strong><small>${escapeHtml(formatMessageTime(item.updatedAt || item.updated_at || item.createdAt || item.created_at))}</small></span><em>只读查看</em></button>`).join('')}</div></details>` : ''}
  </aside>`;
}

function renderEmployeeActiveTask(agentInstanceId = '', activeWork = {}, taskQueue = {}) {
  const collapsed = Boolean(state.employeeActiveWorkCollapsedByInstanceId?.[agentInstanceId]);
  const english = state.languageMode === 'en';
  const status = String(activeWork.status || 'running').toLowerCase();
  const stage = String(activeWork.currentStage || '').toLowerCase();
  const statusLabel = ({ verifying: '验证中', delivering: '交付中' })[stage]
    || ({ pending: '已预留', ready: '已预留', queued: '排队中', running: '执行中', waiting: '等待恢复', blocked: '受阻', verifying: '验证中', delivering: '交付中' })[status]
    || '执行中';
  const nodes = Array.isArray(activeWork.nodes) ? activeWork.nodes : [];
  const recentEvents = Array.isArray(activeWork.recentEvents) ? activeWork.recentEvents : [];
  const progressCompleted = Math.max(0, Number(activeWork.progress?.completed || 0));
  const progressTotal = Math.max(0, Number(activeWork.progress?.total || 0));
  const progressPercent = progressTotal
    ? Math.max(0, Math.min(100, Number.isFinite(Number(activeWork.progress?.percent))
      ? Number(activeWork.progress.percent) : Math.round((progressCompleted / progressTotal) * 100)))
    : 0;
  const queueCount = Math.max(0, Number(taskQueue?.count || 0));
  const updatedAt = activeWork.updatedAt || activeWork.startedAt || '';
  const taskTitle = activeWork.title || '正在处理任务';
  const currentAction = activeWork.currentAction || activeWork.summary || '任务信息更新中';
  return `<article class="employee-conversation-active-work ${collapsed ? 'is-collapsed' : ''}" aria-label="${english ? 'Agent current task' : 'Agent 当前工作'}">
    <header><span><small>${english ? 'Agent Current Task' : 'Agent 当前工作'}</small><strong title="${escapeAttr(taskTitle)}">${escapeHtml(taskTitle)}</strong></span><span class="employee-conversation-work-head-actions"><em>${escapeHtml(statusLabel)}</em><button class="${collapsed ? '' : 'is-expanded'}" type="button" data-employee-active-work-toggle="${escapeAttr(agentInstanceId)}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? (english ? 'Expand task information' : '展开任务信息') : (english ? 'Collapse task information' : '折叠任务信息')}" aria-label="${collapsed ? (english ? 'Expand task information' : '展开任务信息') : (english ? 'Collapse task information' : '折叠任务信息')}">${iconSvg('chevronDown')}</button></span></header>
    ${collapsed ? '' : `<div class="employee-conversation-work-expanded">
    <p title="${escapeAttr(currentAction)}">${escapeHtml(currentAction)}</p>
    ${progressTotal ? `<span class="employee-conversation-work-progress"><span><b>${english ? 'Task Progress' : '任务进度'}</b><small>${progressCompleted}/${progressTotal} ${english ? `nodes · ${progressPercent}%` : `节点 · ${progressPercent}%`}</small></span><i aria-hidden="true"><b style="width:${progressPercent}%"></b></i></span>` : ''}
    <span class="employee-conversation-work-details ${activeWork.blocker?.summary ? 'has-blocker' : ''}">
      ${activeWork.blocker?.summary ? `<span class="employee-conversation-work-blocker"><b>当前受阻</b><span>${escapeHtml(activeWork.blocker.summary)}</span></span>` : ''}
      ${nodes.length ? `<span class="employee-conversation-work-nodes">${nodes.slice(0, 3).map((node) => `<span><b>${escapeHtml(node.title || '任务节点')}</b><small>${escapeHtml(employeeTaskNodeStatusLabel(node.status))}</small></span>`).join('')}</span>` : ''}
      ${recentEvents.length ? `<span class="employee-conversation-work-events">${recentEvents.slice(-1).map((event) => `<span><b>${escapeHtml(event.summary || '任务状态已更新')}</b><small>${escapeHtml(formatMessageTime(event.createdAt || ''))}</small></span>`).join('')}</span>` : ''}
    </span>
    </div>`}
    ${collapsed ? `<p class="employee-conversation-work-collapsed-note">${english ? 'Task information is collapsed. Expand it to view progress and execution details.' : '任务信息已折叠，展开后可查看进度和执行详情。'}</p>` : ''}
    <footer><span>${queueCount ? `${english ? `${queueCount} queued tasks` : `后续 ${queueCount} 个任务`} · ` : ''}${escapeHtml(updatedAt ? formatMessageTime(updatedAt) : english ? 'Updated just now' : '刚刚更新')}</span><button type="button" data-employee-active-work="${escapeAttr(agentInstanceId)}">${english ? 'Open Task Workspace' : '打开任务工作区'} ${iconSvg('chevronRight')}</button></footer>
  </article>`;
}

function employeeTaskNodeStatusLabel(status = '') {
  return ({ pending: '等待中', ready: '已预留', queued: '排队中', running: '执行中', retry_wait: '等待重试', waiting: '等待恢复', blocked: '受阻', completed: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过' })[String(status || '')] || '状态更新中';
}

function renderEmployeeConversationHistoryViewer() {
  const viewer = state.employeeConversationHistoryViewer || {};
  const detail = viewer.detail || null;
  const group = detail?.group || null;
  const title = group?.title || '历史对话';
  const body = viewer.loading
    ? '<div class="employee-history-viewer-empty" role="status">正在读取历史对话…</div>'
    : viewer.error
      ? `<div class="employee-history-viewer-empty is-error" role="alert">${escapeHtml(viewer.error)}</div>`
      : renderEmployeeHistoryMessages(detail?.messages || []);
  return `<div class="employee-history-viewer" data-employee-history-viewer="${escapeAttr(viewer.historyGroupId || '')}">
    <header><button type="button" data-employee-history-back>${iconSvg('chevronLeft')}<span>返回当前对话</span></button><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(`${employeeHistoryKindLabel(group?.kind)} · 只读历史${group ? ` · ${Number(group.messageCount || 0)} 条消息` : ''}`)}</small></span></header>
    <div class="message-list employee-history-message-list" id="message-list" data-message-scroll-key="${escapeAttr(messageScrollKey())}">${body}</div>
  </div>`;
}

function renderEmployeeHistoryMessages(messages = []) {
  if (!messages.length) return '<div class="employee-history-viewer-empty">这组历史记录没有可见消息。</div>';
  return messages.map((message) => {
    const role = message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant';
    if (role === 'system') return `<div class="social-group-system-event"><span>${escapeHtml(message.content || '')}</span><time>${escapeHtml(formatMessageTime(message.createdAt || ''))}</time></div>`;
    const attachments = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
    const content = attachments.length ? stripAttachmentResourceBlock(message.content || '') : message.content || '';
    return `<article class="message ${role} employee-history-message" data-message-id="${escapeAttr(message.id || '')}"><div class="message-shell"><div class="social-message-actor"><span>${role === 'user' ? '你' : 'Agent'}</span><time>${escapeHtml(formatMessageTime(message.createdAt || ''))}</time></div>${attachments.length ? renderMessageAttachmentCards(attachments) : ''}${String(content).trim() ? `<div class="message-body">${formatText(content)}</div>` : ''}</div></article>`;
  }).join('');
}

function employeeHistoryKindLabel(kind = '') {
  return ({ project: '项目', task: '任务', memory: 'Memory', legacy: '旧会话' })[String(kind || '')] || '历史';
}

function renderLocalTaskWorkspaceHeader() {
  if (state.activeTaskWorkspaceKind !== 'agent_session') return '';
  const task = {
    id: state.activeTaskWorkspaceId || state.currentSessionId || '',
    workspaceKind: 'agent_session',
    metadata: state.activeTaskSourceContext || {},
  };
  return `<header class="local-task-workspace-return"><button type="button" ${taskCardActionAttributes(TASK_CARD_ACTIONS.RETURN_TO_SOURCE_CHAT, task, {
    sourceContext: { ...(state.activeTaskSourceContext || {}), returnSurface: state.activeTaskReturnSurface || 'session' },
    returnAnchorId: state.activeTaskReturnAnchorId || '',
  })}>${iconSvg('chevronLeft')}<span>返回原聊天</span></button><strong>本地 Agent 任务工作区</strong></header>`;
}

function renderHomeChat() {
  const standaloneImageMode = state.homeMode === 'image';
  const privateAssistant = isPrivateAssistantComposerMode();
  return `
    <section class="home-stage">
      <div class="home-center ${standaloneImageMode ? 'image-home' : privateAssistant ? 'private-assistant-home' : 'work-home'}">
        <h1>${privateAssistant ? '这里仅属于你' : '今天有什么计划？'}</h1>
        ${renderComposer(standaloneImageMode ? 'image' : 'hero')}
      </div>
    </section>
  `;
}

function renderUBuddyMessageModeControl({ disabled = false } = {}) {
  if (state.uBuddyFeatureFlags?.messageModeV1 !== true) return '';
  const english = state.languageMode === 'en';
  const mode = state.uBuddyMessageMode === 'ask' ? 'ask' : 'task';
  const open = state.uBuddyMessageModeMenuOpen === true;
  const label = mode === 'ask' ? (english ? 'Ask' : '讨论') : (english ? 'Task' : '任务');
  const option = (value, optionLabel, title, icon) => `<button type="button" role="menuitemradio" aria-checked="${mode === value ? 'true' : 'false'}" class="${mode === value ? 'is-active' : ''}" data-ubuddy-message-mode="${value}" title="${escapeAttr(title)}" ${disabled ? 'disabled' : ''}>${iconSvg(icon)}<span>${escapeHtml(optionLabel)}</span>${mode === value ? iconSvg('check') : '<i></i>'}</button>`;
  return `<div class="ubuddy-message-mode-picker ${open ? 'is-open' : ''}">
    <button class="ubuddy-message-mode-trigger" type="button" data-ubuddy-message-mode-toggle aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}>${iconSvg(mode === 'ask' ? 'helpCircle' : 'tasks')}<span>${escapeHtml(label)}</span>${iconSvg('chevronDown')}</button>
    ${open ? `<div class="ubuddy-message-mode-menu" role="menu" aria-label="${english ? 'uBuddy message mode' : 'uBuddy 消息模式'}">
      ${option('task', english ? 'Task' : '任务', english ? 'Create a task; use @ to delegate it to a contact' : '创建任务；使用 @ 可派发给联系人', 'tasks')}
      ${option('ask', english ? 'Ask' : '讨论', english ? 'Ask a question without creating, delegating, or modifying a task' : '讨论和查询；不会创建、派发或修改任务内容', 'helpCircle')}
    </div>` : ''}
  </div>`;
}

function renderUBuddyParticipantSelectionControl({ disabled = false } = {}) {
  if (state.uBuddyMessageMode === 'ask') return '';
  const mentionedUsers = normalizeMentionEntities(
    [...(state.composerMentions || []), ...(state.secretaryMentions || [])],
    { content: state.chatDraft, requirePicker: true },
  ).filter((item) => ['user', 'ubuddy'].includes(item.principalType));
  if (mentionedUsers.length < 2) return '';
  const policy = state.uBuddyParticipantSelectionPolicy === UBUDDY_PARTICIPANT_SELECTION_POLICIES.AUTO_SELECT
    ? UBUDDY_PARTICIPANT_SELECTION_POLICIES.AUTO_SELECT
    : UBUDDY_PARTICIPANT_SELECTION_POLICIES.ALL_MENTIONED;
  const english = state.languageMode === 'en';
  const open = state.uBuddyParticipantSelectionMenuOpen === true;
  const label = policy === UBUDDY_PARTICIPANT_SELECTION_POLICIES.AUTO_SELECT
    ? (english ? 'Auto select' : '自动筛选')
    : (english ? 'Everyone' : '全部参与');
  const option = (value, optionLabel, title, icon) => `<button type="button" role="menuitemradio" aria-checked="${policy === value ? 'true' : 'false'}" class="${policy === value ? 'is-active' : ''}" data-ubuddy-participant-policy="${value}" title="${escapeAttr(title)}" ${disabled ? 'disabled' : ''}>${iconSvg(icon)}<span>${escapeHtml(optionLabel)}</span>${policy === value ? iconSvg('check') : '<i></i>'}</button>`;
  return `<div class="ubuddy-message-mode-picker ubuddy-participant-policy-picker ${open ? 'is-open' : ''}">
    <button class="ubuddy-message-mode-trigger ubuddy-participant-policy-trigger" type="button" data-ubuddy-participant-policy-toggle aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}>${iconSvg(policy === UBUDDY_PARTICIPANT_SELECTION_POLICIES.AUTO_SELECT ? 'spark' : 'users')}<span>${escapeHtml(label)}</span>${iconSvg('chevronDown')}</button>
    ${open ? `<div class="ubuddy-message-mode-menu ubuddy-participant-policy-menu" role="menu" aria-label="${english ? 'Participant scope' : '参与范围'}">
      ${option(UBUDDY_PARTICIPANT_SELECTION_POLICIES.ALL_MENTIONED, english ? 'Everyone' : '全部参与', english ? 'Assign work to every explicitly selected contact' : '所有明确选择的联系人都获得分工', 'users')}
      ${option(UBUDDY_PARTICIPANT_SELECTION_POLICIES.AUTO_SELECT, english ? 'Auto select' : '自动筛选', english ? 'Let uBuddy select the fewest participants needed for the task' : '由 uBuddy 选择覆盖任务所需的最少参与人', 'spark')}
    </div>` : ''}
  </div>`;
}

function renderComposer(kind) {
  const capabilities = composerCapabilities(kind);
  const { social, socialDirect, collaborationGroup, uBuddy, privateAssistant } = capabilities;
  const compact = kind === 'compact' || social;
  const image = kind === 'image' || (!social && isImageComposerMode());
  const showPluginMention = !social && !image;
  const mentionTokenInput = social || capabilities.showContactMention || showPluginMention;
  const standaloneImage = state.homeMode === 'image';
  const ppt = !social && isPptComposerMode();
  const collaboration = !compact && state.homeMode === 'collaboration';
  const socialFriend = socialDirect || kind === 'social' ? activeSocialFriend() : null;
  const selfTransfer = socialDirect && socialFriend?.id === state.currentUser?.id;
  const socialUsesModel = social && normalizeMentionEntities(state.composerMentions || [], {
    content: state.chatDraft,
    requirePicker: true,
  }).some((item) => item.principalType === 'ubuddy' && item.ownerUserId === state.currentUser?.id);
  const defaultModelQuotaExhausted = !image && state.managedProviderUsage?.managedProvider === true
    && state.managedProviderUsage?.exhausted === true;
  const imageQuotaExhausted = image && state.managedProviderUsage?.imageGenerationExhausted === true;
  const placeholder = social
    ? socialDirect ? '发送普通消息；输入 @我的uBuddy 可直接派发结构化任务' : collaborationGroup ? '输入群消息；@任意 uBuddy 可结合公开上下文答复' : '输入消息；使用 @ 可提及好友或 uBuddy'
    : imageQuotaExhausted
    ? state.languageMode === 'en' ? 'Daily image limit reached; available again at 00:00 Beijing Time' : '今日 5 张图片额度已用完，北京时间 00:00 后可继续使用'
    : defaultModelQuotaExhausted
    ? '今日默认模型服务额度已用完，北京时间 00:00 后可继续使用'
    : privateAssistant
    ? state.privateAssistant?.exhausted ? '本周 Token 额度已用完，重置后可继续对话' : '输入只想留在私人空间里的内容'
    : image
    ? '描述你想生成的图片'
    : ppt
      ? '描述你要绘制的 PPT 主题、受众和页数'
      : uBuddy
        ? state.uBuddyFeatureFlags?.messageModeV1 === true && state.uBuddyMessageMode === 'ask'
          ? state.languageMode === 'en' ? 'Ask uBuddy' : '和 uBuddy 讨论'
          : '告诉 uBuddy 你想完成什么任务'
        : collaboration
          ? '描述复杂任务，Janus 会拆解并协调多个部门处理'
          : '有问题，尽管问';
  const context = !social && !standaloneImage ? composerContext() : null;
  const tags = !social && !standaloneImage ? renderInputTags() : '';
  const contextCompression = currentContextCompressionOperation();
  const contextCompressionBusy = contextCompression?.status === 'running';
  const privateContextResetBusy = privateAssistant && state.privateAssistantContextResetBusy;
  const busy = social
    ? state.networkConversationBusy
    : state.busy || contextCompressionBusy || privateContextResetBusy || state.uBuddyConversationOpening;
  const chatRun = social ? null : state.activeChatRun;
  const pendingUserInput = !social && Boolean(chatRun?.userInputRequest?.requestId);
  const pendingPlanExecution = !social
    && Boolean(state.chatPlanExecutionPrompt?.messageId)
    && String(state.chatPlanExecutionPrompt?.sessionId || '') === String(state.currentSessionId || '');
  const currentSession = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  const readOnlyHistory = !social && Boolean(currentSession?.readOnly || currentSession?.writeState === 'read_only');
  const contextUsage = !social && state.currentSessionId && state.contextUsage?.sessionId === state.currentSessionId
    ? state.contextUsage
    : null;
  const providerCompacted = contextUsage?.warningLevel === 'provider_compacted';
  const contextRemainingPercent = contextUsage?.remainingPercent == null
    ? Math.max(0, Math.min(100, 100 - Number(contextUsage?.usagePercent || 0)))
    : Math.max(0, Math.min(100, Number(contextUsage.remainingPercent)));
  const contextWarningText = providerCompacted
    ? 'Janus 已在当前线程中完成原生上下文压缩；下一轮将重新确认当前 Memory 与运行时上下文'
    : `上下文剩余 ${contextRemainingPercent}% · 当前 ${Number(contextUsage?.usedTokens || 0).toLocaleString()} / ${Number(contextUsage?.contextWindowTokens || 0).toLocaleString()} tokens`;
  const mentionMarkup = collaborationGroup
    ? renderMentionMarkup(state.chatDraft, collaborationMentionTokens())
    : social
      ? renderMentionMarkup(state.chatDraft, directSocialMentionTokens(socialFriend))
      : renderMentionMarkup(state.chatDraft, composerMentionTokens());
  const textareaMarkup = `<textarea id="chat-input" class="${social ? 'social-mention-input ' : ''}${mentionTokenInput ? 'mention-token-input' : ''}" rows="1" data-chat-input-key="${escapeAttr(state.currentChatKey || '')}" data-chat-input-session="${escapeAttr(state.currentSessionId || '')}" ${social ? 'spellcheck="false"' : ''} ${readOnlyHistory ? 'disabled' : ''} placeholder="${escapeAttr(readOnlyHistory ? '这是只读历史会话，不能继续发送消息' : placeholder)}">${readOnlyHistory ? '' : escapeHtml(state.chatDraft)}</textarea>`;
  return `
    <div class="composer-stack ${compact ? 'compact-stack' : ''}">
      ${social ? '' : renderInteractionWorkCard()}
      ${social ? '' : renderChatApprovalPrompt()}
      ${contextUsage && contextUsage.warningLevel !== 'normal' && !providerCompacted ? `<div class="context-usage-warning is-${escapeAttr(contextUsage.warningLevel)}" role="status"><span>${escapeHtml(contextWarningText)}</span><button type="button" data-chat-clear-context ${contextCompressionBusy ? 'disabled' : ''}>${contextCompressionBusy ? '正在压缩…' : '压缩上下文'}</button></div>` : ''}
      ${pendingUserInput ? renderChatUserInputPanel() : pendingPlanExecution ? renderChatPlanExecutionPanel() : `<form class="composer ${compact ? 'compact-composer' : image ? 'image-composer' : 'hero-composer'} ${social ? 'social-group-composer' : ''} ${context ? 'has-context' : ''} ${state.attachments.length ? 'has-attachments' : ''} ${ppt ? 'is-ppt-mode' : ''} ${uBuddy ? 'is-ubuddy-mode' : ''} ${privateAssistant ? 'is-private-assistant-mode' : ''}" id="chat-form">
        ${context ? `
          <div class="composer-context">
            ${iconSvg(context.icon)}
            <span>${escapeHtml(context.label)}</span>
          </div>
        ` : ''}
        <div class="composer-quick-actions">
          ${social ? `
            <button class="composer-plus" type="button" data-composer-add-files title="上传文件" aria-label="上传文件">+</button>
            ${(socialDirect || kind === 'chat-group') ? renderComposerEmojiPicker() : ''}
            ${capabilities.showGroupMention ? renderCollaborationMentionPicker() : capabilities.showSocialMention && !selfTransfer ? renderSocialMentionPicker(socialFriend) : ''}
          ` : `
            ${renderComposerToolMenu({ privateAssistant, uBuddy })}
            ${uBuddy ? `${renderUBuddyMessageModeControl({ disabled: busy || Boolean(chatRun) || readOnlyHistory })}${renderUBuddyParticipantSelectionControl({ disabled: busy || Boolean(chatRun) || readOnlyHistory })}${renderTaskReferencePicker({ showTrigger: false })}` : ''}
            ${!image ? renderProjectMentionPicker({
              includePeople: capabilities.showContactMention,
              includePlugins: showPluginMention,
              includeSkills: showPluginMention,
              includeFiles: !privateAssistant,
            }) : ''}
            ${renderComposerInlineActions({ image, privateAssistant })}
          `}
        </div>
        <div class="composer-main">
          ${renderAttachmentTray()}
          ${renderStructuredReferenceTray()}
          ${renderComposerQuote()}
          <div class="composer-input-line ${tags ? 'has-tags' : ''}">
            ${tags}
            ${mentionTokenInput ? `<div class="mention-token-surface"><div class="social-mention-highlight" aria-hidden="true">${mentionMarkup}</div>${textareaMarkup}</div>` : textareaMarkup}
          </div>
        </div>
        <div class="composer-controls">
          ${social ? socialUsesModel ? renderModelReasoningPicker(currentModelValue(), currentReasoningValue()) : '' : image ? renderImageModelPicker() : renderTextModelControls(compact)}
          ${readOnlyHistory ? '<span class="employee-memory-protected">只读历史</span>' : chatRun?.terminal ? `<button class="send-btn" type="button" title="正在收尾" aria-label="正在收尾" disabled>${iconSvg('send')}</button>` : chatRun ? `
            <button class="send-btn cancel-send-btn ${chatRun.cancelling ? 'is-cancelling' : ''}" id="cancel-chat-btn" type="button" title="${chatRun.cancelling ? '正在中止' : '中止生成'}" aria-label="中止生成">
              ${iconSvg('stop')}
            </button>
          ` : `<button class="send-btn" type="submit" title="${defaultModelQuotaExhausted || imageQuotaExhausted ? '今日额度已用完' : '发送'}" aria-label="发送" ${busy || defaultModelQuotaExhausted || imageQuotaExhausted || (privateAssistant && !image && state.privateAssistant?.exhausted) ? 'disabled' : ''}>${iconSvg('send')}</button>`}
        </div>
      </form>`}
      ${social || pendingUserInput || pendingPlanExecution ? '' : renderComposerMetaBar()}
    </div>
  `;
}

function renderChatApprovalPrompt() {
  const run = state.activeChatRun || null;
  const request = run?.approvalRequest || null;
  if (!request?.approvalId || run.approvalSubmitting) return request?.approvalId ? `<aside class="chat-approval-prompt is-submitting" role="status"><span>${iconSvg('shield')}<strong>正在提交你的选择…</strong></span></aside>` : '';
  const command = String(request.command || '').trim();
  const reason = String(request.reason || '').trim();
  const target = String(request.grantRoot || request.cwd || '').trim();
  return `<aside class="chat-approval-prompt" role="alert" aria-label="操作确认">
    <div class="chat-approval-copy"><span class="chat-approval-icon">${iconSvg('shield')}</span><span><strong>Janus 需要确认一项操作</strong><small>${escapeHtml(janusBrandText(reason || '此操作超出当前自动执行权限。'))}</small></span></div>
    ${(command || target) ? `<details><summary>查看详情</summary><div>${command ? `<pre><code>${escapeHtml(command)}</code></pre>` : ''}${target ? `<small>位置：${escapeHtml(target)}</small>` : ''}</div></details>` : ''}
    <div class="chat-approval-actions"><button type="button" data-chat-approval="reject">拒绝</button><button class="is-primary" type="button" data-chat-approval="approve">仅批准本次</button></div>
  </aside>`;
}

function renderComposerQuote() {
  const quote = normalizeMessageQuote(state.messageQuote);
  if (!quote) return '';
  return `<div class="composer-message-quote"><span><strong>回复 ${escapeHtml(quote.authorLabel)}</strong><small>${escapeHtml(clipInline(quote.excerpt, 180))}</small></span><button type="button" data-message-quote-clear title="取消回复" aria-label="取消回复">${iconSvg('x')}</button></div>`;
}

function renderTaskReferencePicker({ showTrigger = true } = {}) {
  if (state.uBuddyFeatureFlags?.structuredTaskReference !== true) return '';
  if (!showTrigger && !state.taskReferenceMenuOpen) return '';
  const selected = state.composerTaskReference || null;
  const tasks = Array.isArray(state.taskReferenceOptions) ? state.taskReferenceOptions : [];
  const groups = [
    ['active', '活跃任务'],
    ['sleeping', '休眠任务'],
    ['waiting_user', '等待用户任务'],
  ];
  const menuBody = state.taskReferenceOptionsLoading
    ? '<div class="task-reference-empty">正在读取任务…</div>'
    : state.taskReferenceOptionsError
      ? `<div class="task-reference-empty is-error">${escapeHtml(state.taskReferenceOptionsError)}</div>`
      : `${groups.map(([group, label]) => {
          const items = tasks.filter((item) => item.statusGroup === group);
          if (!items.length) return '';
          return `<section class="task-reference-group"><header><strong>${label}</strong><small>${items.length}</small></header>${items.map((item) => `<button type="button" role="menuitem" data-task-reference-select="${escapeAttr(item.taskRunId || '')}" data-task-reference-display="${escapeAttr(item.displayText || `@任务：${item.title || ''}`)}"><span><strong>${escapeHtml(item.title || '未命名任务')}</strong><small>${escapeHtml(item.statusLabel || '进行中')}</small></span><code>${escapeHtml(String(item.taskRunId || '').slice(-8))}</code></button>`).join('')}</section>`;
        }).join('')}${tasks.length ? '' : '<div class="task-reference-empty">当前没有可引用的任务</div>'}`;
  return `<div class="task-reference-picker ${showTrigger ? '' : 'is-menu-only'} ${state.taskReferenceMenuOpen ? 'is-open' : ''}">
    ${showTrigger ? `<button class="task-reference-trigger" type="button" data-task-reference-toggle aria-haspopup="menu" aria-expanded="${state.taskReferenceMenuOpen ? 'true' : 'false'}" title="选择这条消息对应的任务">${iconSvg('tasks')}<span>${selected ? '已选任务' : '任务'}</span></button>` : ''}
    ${state.taskReferenceMenuOpen ? `<div class="task-reference-menu" role="menu" aria-label="选择任务引用"><button class="task-reference-new" type="button" role="menuitem" data-task-reference-new><span>${iconSvg('plus')}<strong>创建新任务</strong></span><small>不关联任何现有任务</small></button>${menuBody}</div>` : ''}
  </div>`;
}

function renderProjectMentionPicker({ includePeople = false, includePlugins = false, includeSkills = false, includeFiles = true } = {}) {
  const activeProject = activeProjectForComposer();
  const activeWorkspaceRoot = String(activeProject?.workspaceRoot || activeProject?.workspace_root || '').trim();
  const projectReferencesAvailable = Boolean(activeProject && !state.workspaceDetached && activeWorkspaceRoot);
  const skillItems = includeSkills ? composerAttachedSkillItems() : [];
  const skillPickerMode = state.composerMentionPickerMode === 'skill';
  if (!projectReferencesAvailable && !includePeople && !includePlugins && !skillItems.length && !skillPickerMode) return '';
  const project = (state.projects || []).find((item) => item.id === state.projectReferenceBrowseProjectId) || null;
  const query = String(state.composerMentionQuery || '').trim().toLowerCase();
  const activeOrganizationId = String(
    state.activeAccountWorkspace?.organizationId || state.activeAccountWorkspace?.organization_id || '',
  ).trim();
  const activeWorkspaceKind = String(
    state.activeAccountWorkspace?.kind
      || state.activeAccountWorkspace?.workspaceKind
      || state.activeAccountWorkspace?.workspace_kind
      || '',
  ).trim();
  const currentUserId = String(state.currentUser?.id || '');
  const joinedOrganizations = (state.friendOverview?.organizations || []).filter((organization) => (
    organization?.id
    && (organization.members || []).some((member) => String(member?.user?.id || '') === currentUserId)
    && (organization.members || []).some((member) => (
      member?.user?.id && String(member.user.id) !== currentUserId
    ))
  ));
  const audienceOrganizations = activeWorkspaceKind === 'organization'
    ? joinedOrganizations.filter((organization) => String(organization.id) === activeOrganizationId)
    : activeWorkspaceKind === 'personal'
      ? joinedOrganizations
      : [];
  const singlePersonalAudience = activeWorkspaceKind === 'personal' && audienceOrganizations.length === 1;
  const organizationAudienceItems = audienceOrganizations.map((organization) => {
    const recipientCount = (organization.members || []).filter((member) => (
      member?.user?.id && String(member.user.id) !== currentUserId
    )).length;
    const organizationName = String(organization.name || '组织');
    return {
      principalType: 'organization',
      organizationId: organization.id,
      audience: 'all_members',
      token: activeWorkspaceKind === 'organization'
        ? '@组织所有人'
        : singlePersonalAudience ? '@所有人' : `@${organizationName}所有人`,
      label: activeWorkspaceKind === 'organization'
        ? '组织所有人'
        : singlePersonalAudience ? '所有人' : `${organizationName} · 所有人`,
      detail: `${organizationName} · ${recipientCount} 位成员，不含我`,
      tone: 'organization',
    };
  });
  const visibleOrganizationAudienceItems = organizationAudienceItems.filter((item) => (
    !query || `${item.label} ${item.detail}`.toLowerCase().includes(query)
  ));
  const friendItems = accountMentionContacts()
    .map(({ user, relationship, organizationNames }) => {
      const friend = relationship ? { ...user, remark: relationship.remark || user.remark || '' } : user;
      const label = socialFriendName(friend);
      const organizationDetail = organizationNames.length ? `组织内联系人 · ${organizationNames.join('、')}` : '';
      return { principalType: 'user', userId: user.id, token: `@${label}`, label, detail: friend.username ? `@${friend.username}` : friend.email || organizationDetail || '联系人', tone: 'friend' };
    })
    .filter((item) => !query || `${item.label} ${item.detail}`.toLowerCase().includes(query));
  const installedPluginNamesByAgentId = new Map();
  (state.pluginCatalog || []).filter((plugin) => plugin?.status?.installed).forEach((plugin) => {
    (plugin.providesAgentIds || []).forEach((agentId) => {
      const names = installedPluginNamesByAgentId.get(agentId) || [];
      installedPluginNamesByAgentId.set(agentId, [...names, plugin.name, ...(plugin.tags || [])].filter(Boolean));
    });
  });
  const agentFamilyOrder = new Map();
  const english = state.languageMode === 'en';
  const agentItems = (state.employeeOverview?.roster || [])
    .filter((employee) => employee?.id && employee.agentFamilyId !== 'secretary_agent' && employee.status !== 'inactive')
    .map((employee) => {
      const label = agentInstanceDisplayNameForUi(employee, employee.name || employee.family?.name || employee.agentFamilyId || 'Agent');
      const familyKey = employee.agentFamilyId || employee.family?.id || employee.id;
      const pluginAliases = installedPluginNamesByAgentId.get(employee.agentFamilyId) || [];
      if (!agentFamilyOrder.has(familyKey)) agentFamilyOrder.set(familyKey, agentFamilyOrder.size);
      return {
        principalType: 'agent',
        agentId: employee.agentFamilyId || '',
        agentInstanceId: employee.id,
        token: `@${label}`,
        label,
        detail: pluginAliases.length
          ? `${english ? 'Installed plugin' : '已安装插件'} · ${pluginAliases[0]}`
          : (english ? 'Local Agent · confirmation required' : '本地 Agent · 确认后执行'),
        tone: 'own-agent',
        searchText: `${label} ${pluginAliases.join(' ')}`,
        familyKey,
        familyOrder: agentFamilyOrder.get(familyKey),
        familyInstanceSeq: Number(employee.familyInstanceSeq || 0),
      };
    })
    .sort((left, right) => left.familyOrder - right.familyOrder
      || MENTION_AGENT_NAME_COLLATOR.compare(left.label, right.label)
      || left.familyInstanceSeq - right.familyInstanceSeq
      || MENTION_AGENT_NAME_COLLATOR.compare(left.agentInstanceId, right.agentInstanceId))
    .filter((item) => !query || `${item.searchText} ${item.detail}`.toLowerCase().includes(query));
  const pluginItems = (state.codexPlugins?.installed || [])
    .filter((plugin) => plugin?.installed && plugin?.enabled !== false && plugin.pluginId)
    .map((plugin) => {
      const label = plugin.displayName || plugin.name || plugin.pluginId;
      return {
        principalType: 'plugin',
        pluginId: plugin.pluginId,
        token: `@${label}`,
        label,
        detail: `${plugin.marketplaceName || 'Codex'} · v${plugin.version || '-'}`,
        tone: 'plugin',
      };
    })
    .filter((item) => !query || `${item.label} ${item.detail} ${item.pluginId}`.toLowerCase().includes(query));
  const visibleSkillItems = skillItems
    .map((skill) => {
      const name = state.languageMode === 'en'
        ? skill.displayNameEn || skill.name || skill.skillKey || skill.id
        : skill.displayNameZhCn || skill.displayNameZh || skill.name || skill.skillKey || skill.id;
      return {
        principalType: 'skill',
        skillId: skill.id,
        token: `@${name}`,
        slashToken: `$${skill.skillKey || skill.name || skill.id}`,
        label: name,
        detail: state.languageMode === 'en'
          ? skill.descriptionEn || skill.description || 'Skill assigned to the current Agent'
          : skill.descriptionZhCn || skill.description || '已分配给当前 Agent 的 Skill',
        tone: 'skill',
      };
    })
    .filter((item) => !query || `${item.label} ${item.detail} ${item.skillId}`.toLowerCase().includes(query));
  const entries = state.projectReferenceProjectId === project?.id ? (state.projectReferenceEntries || []) : [];
  const selectedCount = (state.composerFileReferences || []).length
    + normalizeMentionEntities([...(state.composerMentions || []), ...(state.secretaryMentions || [])], { content: state.chatDraft, requirePicker: true }).length;
  const pickerLabel = state.uBuddyContactPickerOnly
    ? '选择联系人'
    : skillPickerMode
      ? '选择 Skill'
    : includePeople
      ? '选择联系人、Agent、Skill、插件或项目文件'
      : includePlugins && includeFiles
        ? '选择 Skill、插件或项目文件'
        : includePlugins
          ? '选择 Skill 或插件'
          : '选择项目文件';
  const pickerSearchPlaceholder = state.uBuddyContactPickerOnly
    ? '搜索联系人'
    : skillPickerMode
      ? '输入 Skill 名称搜索'
    : includePeople
      ? '输入名称前几个字母搜索'
      : includePlugins
        ? '输入插件名前几个字母搜索'
        : '输入文件名前几个字母搜索';
  return `<div class="social-mention-picker ubuddy-mention-picker project-mention-picker ${state.socialMentionMenuOpen ? 'is-open' : ''}">
    <button class="social-mention-trigger" type="button" data-social-mention-toggle aria-label="${escapeAttr(pickerLabel)}" title="${escapeAttr(pickerLabel)}" aria-haspopup="listbox" aria-expanded="${state.socialMentionMenuOpen ? 'true' : 'false'}">${skillPickerMode ? '/' : '@'}</button>
    ${state.socialMentionMenuOpen ? `<div class="social-mention-menu project-mention-menu ${state.uBuddyContactPickerOnly ? 'is-contact-only' : ''}" role="listbox" aria-multiselectable="true" aria-label="${escapeAttr(pickerLabel)}">
      <label class="project-mention-search"><span>${skillPickerMode ? '/' : '@'}</span><input type="search" data-project-reference-query value="${escapeAttr(state.composerMentionQuery || '')}" placeholder="${escapeAttr(pickerSearchPlaceholder)}" autocomplete="off" spellcheck="false"></label>
      ${!skillPickerMode && includePeople ? `${!state.uBuddyContactPickerOnly && visibleOrganizationAudienceItems.length ? `<section class="project-mention-group project-mention-entity-group" data-project-mention-group="organization"><header><strong>组织范围</strong><small>${activeWorkspaceKind === 'personal' ? '个人空间可用' : '当前组织'}</small></header>${visibleOrganizationAudienceItems.map(renderUBuddyMentionButton).join('')}</section>` : ''}<section class="project-mention-group project-mention-entity-group" data-project-mention-group="contacts"><header><strong>联系人</strong><small>${friendItems.length}</small></header>${friendItems.length
        ? friendItems.map(renderUBuddyMentionButton).join('')
        : '<div class="project-mention-empty">暂无匹配的联系人</div>'}</section>
      ${state.uBuddyContactPickerOnly ? '' : `<section class="project-mention-group project-mention-entity-group" data-project-mention-group="agents"><header><strong>Agent</strong><small>${agentItems.length}</small></header>${agentItems.length
        ? agentItems.map(renderUBuddyMentionButton).join('')
        : '<div class="project-mention-empty">暂无匹配的 Agent</div>'}</section>`}` : ''}
      ${!skillPickerMode && includePlugins && !state.uBuddyContactPickerOnly ? `<section class="project-mention-group project-mention-entity-group" data-project-mention-group="plugins"><header><strong>${english ? 'Installed Plugins' : '已安装插件'}</strong><small>${pluginItems.length}</small></header>${pluginItems.length
        ? pluginItems.map(renderUBuddyMentionButton).join('')
        : '<div class="project-mention-empty">暂无匹配的插件</div>'}</section>` : ''}
      ${(includeSkills || skillPickerMode) && !state.uBuddyContactPickerOnly ? `<section class="project-mention-group project-mention-entity-group" data-project-mention-group="skills"><header><strong>当前 Agent 的 Skills</strong><small>${visibleSkillItems.length}</small></header>${visibleSkillItems.length
        ? visibleSkillItems.map(renderUBuddyMentionButton).join('')
        : '<div class="project-mention-empty">当前 Agent 没有已分配的 Skill</div>'}</section>` : ''}
      ${!skillPickerMode && includeFiles && !state.uBuddyContactPickerOnly ? `<section class="project-mention-group" data-project-mention-group="files"><header><strong>项目文件</strong><small>${escapeHtml(project?.title || '未选择文件夹')}</small></header>
        ${project ? `${renderProjectReferenceBreadcrumbs(project)}${state.projectReferenceLoading ? '<div class="empty">正在读取当前目录…</div>' : state.projectReferenceError ? `<div class="empty is-error">${escapeHtml(state.projectReferenceError)}</div>` : entries.length ? entries.map(renderProjectReferenceEntry).join('') : '<div class="empty">当前目录没有匹配项</div>'}` : '<button class="project-reference-disabled" type="button" data-select-project-reference-workspace>选择文件夹后可以 @ 引用项目文件</button>'}
      </section>` : ''}
      <footer class="project-mention-help"><span>${selectedCount ? (english ? `Selected ${selectedCount} · ` : `已选择 ${selectedCount} 项 · `) : ''}${english ? 'Select multiple' : '可连续多选'}</span><kbd>↑↓</kbd><span>${english ? 'Navigate' : '定位'}</span><kbd>Enter / Tab</kbd><span>${english ? 'Add' : '添加'}</span><kbd>Esc</kbd><span>${english ? 'Done' : '完成'}</span></footer>
    </div>` : ''}
  </div>`;
}

function renderUBuddyMentionButton(item = {}) {
  const principalId = item.userId || item.agentInstanceId || item.agentId || item.organizationId || item.pluginId || item.skillId || '';
  const selected = normalizeMentionEntities([...(state.composerMentions || []), ...(state.secretaryMentions || [])], { content: state.chatDraft, requirePicker: true })
    .some((mention) => mention.principalType === item.principalType
      && (mention.userId || mention.agentInstanceId || mention.agentId || mention.organizationId || mention.pluginId || mention.skillId) === principalId);
  return `<button class="project-mention-entity ${selected ? 'is-selected' : ''}" type="button" role="option" aria-selected="${selected ? 'true' : 'false'}" data-composer-mention-option data-ubuddy-mention-principal="${escapeAttr(item.principalType)}" data-ubuddy-mention-user="${escapeAttr(item.userId || '')}" data-ubuddy-mention-agent="${escapeAttr(item.agentId || '')}" data-ubuddy-mention-agent-instance="${escapeAttr(item.agentInstanceId || '')}" data-ubuddy-mention-organization="${escapeAttr(item.organizationId || '')}" data-ubuddy-mention-plugin="${escapeAttr(item.pluginId || '')}" data-ubuddy-mention-skill="${escapeAttr(item.skillId || '')}" data-ubuddy-mention-audience="${escapeAttr(item.audience || '')}" data-ubuddy-mention-token="${escapeAttr(item.token)}" data-ubuddy-mention-slash-token="${escapeAttr(item.slashToken || '')}"><span class="mention-avatar tone-${escapeAttr(item.tone)}">${item.principalType === 'agent' ? 'A' : item.principalType === 'plugin' ? 'P' : item.principalType === 'skill' ? 'S' : escapeHtml(item.label.slice(0, 1))}</span><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span>${selected ? `<span class="project-mention-selected-mark">${iconSvg('check')}</span>` : ''}</button>`;
}

function composerAttachedSkillItems() {
  const catalog = state.attachedSkillCatalog || {};
  const skills = Array.isArray(catalog.skills) ? catalog.skills : [];
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || {};
  const instanceId = String(state.currentAgentInstanceId || session.agentInstanceId || '').trim();
  const familyId = String(state.currentAgentId || session.agentId || '').trim();
  const departmentId = String(state.currentDepartmentId || session.departmentId || '').trim();
  if (!instanceId && !familyId && !departmentId) return [];
  const assignments = Array.isArray(catalog.assignments) ? catalog.assignments : [];
  const relevant = assignments.filter((item) => (
    (item.scopeType === 'department' && item.scopeId === departmentId)
    || (item.scopeType === 'agent_family' && item.scopeId === familyId)
    || (item.scopeType === 'agent_instance' && item.scopeId === instanceId)
  ));
  const overrides = new Map(relevant.filter((item) => item.scopeType === 'agent_instance').map((item) => [item.skillId, item.enabled]));
  return skills.filter((skill) => {
    if (overrides.has(skill.id)) return overrides.get(skill.id) === true;
    return relevant.some((item) => item.skillId === skill.id && item.enabled === true);
  });
}

function renderProjectReferenceBreadcrumbs(project = {}) {
  const parts = String(state.projectReferenceDirectory || '').split('/').filter(Boolean);
  return `<nav class="project-reference-breadcrumb" aria-label="项目目录"><button type="button" data-project-reference-directory="">${escapeHtml(project.title || '项目')}</button>${parts.map((part, index) => `<span>/</span><button type="button" data-project-reference-directory="${escapeAttr(parts.slice(0, index + 1).join('/'))}">${escapeHtml(part)}</button>`).join('')}</nav>`;
}

function renderProjectReferenceEntry(entry = {}) {
  const directory = entry.kind === 'directory';
  const selected = !directory && (state.composerFileReferences || []).some((reference) => reference.projectId === state.projectReferenceBrowseProjectId && reference.relativePath === entry.relativePath);
  return `<div class="project-reference-option ${directory ? 'is-directory' : 'is-file'} ${selected ? 'is-selected' : ''}"><button type="button" role="option" aria-selected="${selected ? 'true' : 'false'}" data-composer-mention-option ${directory ? `data-project-reference-directory="${escapeAttr(entry.relativePath)}"` : `data-project-reference-select="${escapeAttr(entry.relativePath)}" data-project-reference-kind="file"`}>${renderProjectReferenceFileIcon(entry)}<span><strong>${escapeHtml(entry.name || entry.relativePath)}</strong><small>${escapeHtml(entry.relativePath)}</small></span>${selected ? `<span class="project-mention-selected-mark">${iconSvg('check')}</span>` : ''}</button></div>`;
}

function renderProjectReferenceFileIcon(entry = {}) {
  const presentation = projectReferenceFileIconPresentation(entry);
  if (presentation.kind === 'directory') {
    return `<span class="project-reference-file-icon type-directory" data-project-reference-icon="directory" aria-hidden="true"><svg viewBox="0 0 36 32"><path class="folder-back" d="M2.5 7.5A3.5 3.5 0 0 1 6 4h8l3.2 3H30a3.5 3.5 0 0 1 3.5 3.5v2H2.5Z"/><path class="folder-front" d="M2.5 10.5h31v15A3.5 3.5 0 0 1 30 29H6a3.5 3.5 0 0 1-3.5-3.5Z"/><path class="folder-highlight" d="M5.5 13h25"/></svg></span>`;
  }
  if (presentation.kind === 'image') {
    return `<span class="project-reference-file-icon type-image" data-project-reference-icon="image" aria-hidden="true"><svg viewBox="0 0 32 36"><path class="file-page" d="M6 2.5h13l7 7V32a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2Z"/><path class="file-fold" d="M19 2.5v7h7"/><rect class="image-frame" x="7" y="13" width="16" height="13" rx="2"/><circle class="image-sun" cx="11" cy="17" r="2"/><path class="image-mountain" d="m8 24 4.5-4 3.2 2.8 2.6-2.3L22 24Z"/></svg></span>`;
  }
  return `<span class="project-reference-file-icon type-${escapeAttr(presentation.kind)}" style="--file-icon-accent:${escapeAttr(presentation.accent)}" data-project-reference-icon="${escapeAttr(presentation.kind)}" aria-hidden="true"><svg viewBox="0 0 32 36"><path class="file-page" d="M6 2.5h13l7 7V32a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2Z"/><path class="file-fold" d="M19 2.5v7h7"/></svg><b>${escapeHtml(presentation.badge)}</b></span>`;
}

function projectReferenceFileIconPresentation(entry = {}) {
  if (entry.kind === 'directory') return { kind: 'directory', badge: '', accent: '' };
  const name = String(entry.name || entry.relativePath || '').toLowerCase();
  const extension = name.includes('.') ? name.split('.').at(-1) : '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff'].includes(extension)) {
    return { kind: 'image', badge: '', accent: '#2e9f65' };
  }
  if (extension === 'pdf') return { kind: 'pdf', badge: 'PDF', accent: '#d84b4b' };
  if (['doc', 'docx', 'rtf', 'odt'].includes(extension)) return { kind: 'word', badge: 'W', accent: '#2b67c9' };
  if (['xls', 'xlsx', 'csv', 'ods'].includes(extension)) return { kind: 'sheet', badge: 'X', accent: '#228653' };
  if (['ppt', 'pptx', 'odp'].includes(extension)) return { kind: 'slides', badge: 'P', accent: '#d76a32' };
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(extension)) return { kind: 'archive', badge: 'ZIP', accent: '#9a6a2f' };
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(extension)) return { kind: 'audio', badge: '♪', accent: '#8b55c5' };
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(extension)) return { kind: 'video', badge: '▶', accent: '#7b55c7' };
  if (['db', 'sqlite', 'sqlite3', 'sql'].includes(extension)) return { kind: 'database', badge: 'DB', accent: '#31869b' };
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'kts', 'sh', 'bash', 'zsh', 'fish', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte'].includes(extension)) {
    return { kind: 'code', badge: extension === 'py' ? 'PY' : extension === 'ts' || extension === 'tsx' ? 'TS' : extension === 'js' || extension === 'jsx' ? 'JS' : '</>', accent: '#506fc7' };
  }
  if (['json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env'].includes(extension)) return { kind: 'config', badge: '{}', accent: '#697a91' };
  if (['md', 'markdown'].includes(extension)) return { kind: 'markdown', badge: 'MD', accent: '#4c6f91' };
  if (['txt', 'log'].includes(extension)) return { kind: 'text', badge: 'TXT', accent: '#718096' };
  return { kind: 'generic', badge: String(extension || 'FILE').slice(0, 4).toUpperCase(), accent: '#7b8ba3' };
}

function renderStructuredReferenceTray() {
  const files = Array.isArray(state.composerFileReferences) ? state.composerFileReferences : [];
  const memories = Array.isArray(state.composerMemoryReferences) ? state.composerMemoryReferences : [];
  const taskReference = state.uBuddyFeatureFlags?.structuredTaskReference === true ? state.composerTaskReference : null;
  if (!files.length && !memories.length && !taskReference) return '';
  return `<div class="composer-reference-tray">${taskReference ? `<div class="composer-reference-card is-task"><span>${iconSvg('tasks')}</span><span><strong>${escapeHtml(taskReference.displayText || '@任务')}</strong><small>${taskReference.createNewTask ? '将创建独立 task_run_id' : '消息只进入此任务'}</small></span><button type="button" data-task-reference-clear aria-label="移除任务引用">${iconSvg('x')}</button></div>` : ''}${files.map((reference) => `<div class="composer-reference-card is-file"><span>${iconSvg(reference.referenceKind === 'directory' ? 'folder' : 'document')}</span><span><strong>${escapeHtml(reference.name || reference.relativePath)}</strong><small>${escapeHtml(reference.relativePath)} · 当前项目</small></span><button type="button" data-project-reference-remove="${escapeAttr(reference.referenceId)}" aria-label="移除文件引用">${iconSvg('x')}</button></div>`).join('')}${memories.map((reference) => `<div class="composer-reference-card is-memory"><span>${iconSvg('memory')}</span><span><strong>${escapeHtml(reference.displayName || '历史 Memory')}</strong><small>只读历史摘要 · 不切换当前 Memory</small></span><button type="button" data-memory-reference-remove="${escapeAttr(reference.referenceId)}" aria-label="移除历史引用">${iconSvg('x')}</button></div>`).join('')}</div>`;
}

function renderSocialMentionPicker(friend = {}) {
  const friendName = socialFriendName(friend);
  const additionalFriends = accountMentionContacts()
    .filter(({ user }) => user.id !== friend.id);
  const items = [
    { token: `@${friendName}`, label: friendName, detail: '普通聊天，不创建任务', tone: 'friend', principalType: 'user', userId: friend.id },
    { token: `@${friendName}的uBuddy`, label: `${friendName} 的 uBuddy`, detail: '在群聊中提及对方 uBuddy', tone: 'friend-agent', principalType: 'ubuddy', ownerUserId: friend.id },
    { token: '@我的uBuddy', label: '我的 uBuddy', detail: '整理私有委托草稿，确认后才发布', tone: 'own-agent', principalType: 'ubuddy', ownerUserId: state.currentUser?.id || '' },
    ...additionalFriends.map(({ user: candidate, relationship }) => {
      if (relationship?.remark) candidate = { ...candidate, remark: relationship.remark };
      const name = socialFriendName(candidate);
      return { token: `@${name}`, label: name, detail: '加入委托草稿（需同时 @我的uBuddy）', tone: 'friend', principalType: 'user', userId: candidate.id };
    }),
  ];
  return `
    <div class="social-mention-picker ${state.socialMentionMenuOpen ? 'is-open' : ''}">
      <button class="social-mention-trigger" type="button" data-social-mention-toggle aria-label="提及联系人或 uBuddy" title="提及联系人或 uBuddy" aria-haspopup="menu" aria-expanded="${state.socialMentionMenuOpen ? 'true' : 'false'}">@</button>
      ${state.socialMentionMenuOpen ? `<div class="social-mention-menu" role="menu">
        ${items.map(renderSocialMentionButton).join('')}
      </div>` : ''}
    </div>
  `;
}

function directSocialMentionTokens(friend = {}) {
  return [...new Set([
    ...socialMentionTokens(socialFriendName(friend || {})),
    ...(state.composerMentions || []).map((item) => String(item.displayText || '').trim()).filter(Boolean),
  ])].sort((left, right) => right.length - left.length);
}

function composerMentionTokens() {
  return [...new Set([...(state.composerMentions || []), ...(state.secretaryMentions || [])]
    .map((item) => String(item?.displayText || '').trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

function accountMentionContacts() {
  const currentUserId = String(state.currentUser?.id || '');
  const contacts = new Map();
  for (const relationship of state.friendOverview?.friends || []) {
    const user = relationship?.friend || relationship?.user || relationship;
    const userId = String(user?.id || '');
    if (!userId || userId === currentUserId) continue;
    contacts.set(userId, { user, relationship, organizationNames: [] });
  }
  for (const organization of state.friendOverview?.organizations || []) {
    for (const member of organization?.members || []) {
      const user = member?.user || null;
      const userId = String(user?.id || '');
      if (!userId || userId === currentUserId) continue;
      const entry = contacts.get(userId) || { user, relationship: null, organizationNames: [] };
      const organizationName = String(organization?.name || '').trim();
      if (organizationName && !entry.organizationNames.includes(organizationName)) entry.organizationNames.push(organizationName);
      contacts.set(userId, entry);
    }
  }
  return [...contacts.values()];
}

function renderCollaborationMentionPicker() {
  const items = collaborationMentionItems();
  return `<div class="social-mention-picker collaboration-mention-picker ${state.socialMentionMenuOpen ? 'is-open' : ''}">
    <button class="social-mention-trigger" type="button" data-social-mention-toggle aria-label="提及群成员或 uBuddy" title="提及群成员或 uBuddy" aria-haspopup="menu" aria-expanded="${state.socialMentionMenuOpen ? 'true' : 'false'}">@</button>
    ${state.socialMentionMenuOpen ? `<div class="social-mention-menu" role="menu">${items.map(renderSocialMentionButton).join('')}</div>` : ''}
  </div>`;
}

function renderSocialMentionButton(item = {}) {
  return `<button type="button" role="menuitem" data-social-mention="${escapeAttr(item.token)}" data-social-mention-principal="${escapeAttr(item.principalType || '')}" data-social-mention-user="${escapeAttr(item.userId || '')}" data-social-mention-owner="${escapeAttr(item.ownerUserId || '')}" data-social-mention-audience="${escapeAttr(item.audience || '')}"><span class="mention-avatar tone-${item.tone}">${item.principalType === 'group_audience' ? '@' : String(item.tone || '').includes('agent') ? 'U' : escapeHtml(String(item.label || '').slice(0, 1))}</span><span><strong>${escapeHtml(item.label)}${String(item.tone || '').includes('agent') ? '<span class="ubuddy-beta-badge">Beta</span>' : ''}</strong><small>${escapeHtml(item.detail)}</small></span></button>`;
}


function renderComposerInlineActions({ image = false, privateAssistant = false } = {}) {
  const title = privateAssistant
    ? '在当前会话切换到 GPT Image-2；不会把私人助理历史或 Memory 发送给图片服务'
    : '图像生成';
  return `
    <div class="composer-inline-actions" aria-label="\u5feb\u6377\u529f\u80fd">
      <button class="composer-image-action ${image ? 'active' : ''}" type="button" data-composer-image-mode ${privateAssistant ? 'data-image-entry-source="private_assistant"' : ''} title="${escapeAttr(title)}">
        ${iconSvg('image')}
        <span>\u56fe\u50cf\u751f\u6210</span>
      </button>
    </div>
  `;
}

function renderComposerEmojiPicker() {
  const favorites = normalizeEmojiFavorites(state.composerFavoriteEmojis || []);
  const activeTab = state.composerEmojiTab === 'favorites' ? 'favorites' : 'emoji';
  const contextFavorite = favorites.find((item) => item.id === state.composerFavoriteContextMenu?.id);
  const favoriteImageSource = (item) => {
    const sources = [item.value, item.url].map((value) => String(value || '').trim()).filter(Boolean);
    return sources.find((value) => value.startsWith('data:')) || sources[0] || '';
  };
  const favoriteButton = (item) => `<button type="button" class="composer-emoji-item composer-emoji-image-item ${state.composerFavoriteManageOpen ? 'is-managing' : ''}" data-composer-favorite="${escapeAttr(item.id)}" title="${state.composerFavoriteManageOpen ? '删除表情' : `发送 ${escapeAttr(item.name)}`}" aria-label="${escapeAttr(item.name)}">${item.kind === 'image' ? renderEmojiAsset(favoriteImageSource(item), item.name, 'favorite') : escapeHtml(item.value)}${state.composerFavoriteManageOpen ? `<span class="composer-favorite-remove-badge" data-composer-favorite-remove="${escapeAttr(item.id)}">−</span>` : ''}</button>`;
  const recent = [...new Set([
    ...(Array.isArray(state.composerRecentEmojis) ? state.composerRecentEmojis : []),
    ...COMPOSER_COMMON_EMOJIS,
  ])].slice(0, 8);
  const common = recent.map((emoji) => `
    <button type="button" class="composer-emoji-item" data-composer-emoji="${escapeAttr(emoji)}"
      title="插入 ${escapeAttr(emoji)}" aria-label="插入 ${escapeAttr(emoji)}">${emoji}</button>
  `).join('');
  const categories = COMPOSER_DEFAULT_EMOJI_CATEGORIES.map((category) => `
    <section class="composer-emoji-category">
      <h4>${escapeHtml(category.name)}</h4>
      <div class="composer-emoji-grid">
        ${category.emojis.map((emoji) => `
          <button type="button" class="composer-emoji-item" data-composer-emoji="${escapeAttr(emoji)}"
            title="插入 ${escapeAttr(emoji)}" aria-label="插入 ${escapeAttr(emoji)}">${emoji}</button>
        `).join('')}
      </div>
    </section>
  `).join('');
  const favoriteContent = `<button type="button" class="composer-favorite-add-tile" data-composer-favorite-upload aria-label="添加自定义表情"><span>+</span></button>${favorites.map(favoriteButton).join('')}${state.composerFavoriteManageOpen ? '<button type="button" class="composer-favorite-done-tile" data-composer-favorite-done>完成</button>' : '<button type="button" class="composer-favorite-manage-tile" data-composer-favorite-manage aria-label="管理收藏表情"><span>−</span></button>'}`;
  return `
    <div class="composer-emoji-picker ${state.composerEmojiPickerOpen ? 'is-open' : ''}">
      <button class="composer-emoji-trigger" type="button" data-composer-emoji-toggle
        title="表情" aria-label="打开表情面板" aria-haspopup="dialog"
        aria-expanded="${state.composerEmojiPickerOpen ? 'true' : 'false'}">☺</button>
      ${state.composerEmojiPickerOpen ? `
        <div class="composer-emoji-menu ${activeTab === 'favorites' ? 'is-favorites' : 'is-default-emojis'}" role="dialog" aria-label="选择表情">
          <div class="composer-emoji-menu-head"><strong>${activeTab === 'favorites' ? '收藏表情' : '表情'}</strong></div>
          <div class="composer-emoji-content">
          ${activeTab === 'favorites' ? `<section class="composer-favorites-tab"><div class="composer-emoji-grid">${favoriteContent}</div></section>` : ''}
          ${activeTab === 'emoji' ? `
          <section class="composer-emoji-category composer-emoji-recent">
            <h4>常用表情</h4>
            <div class="composer-emoji-grid">${common || '<span class="composer-emoji-empty">暂无常用表情</span>'}</div>
          </section>
          <div class="composer-emoji-default-label">默认表情</div>
          <div class="composer-emoji-scroll">${categories}</div>
          ` : ''}
          </div>
          <nav class="composer-emoji-tabs" aria-label="表情分类">
            <button type="button" class="composer-emoji-tab composer-emoji-tab-add" data-composer-emoji-store title="表情商城（暂未开放）" aria-label="表情商城（暂未开放）">+</button>
            <button type="button" class="composer-emoji-tab ${activeTab === 'emoji' ? 'is-active' : ''}" data-composer-emoji-tab="emoji" title="表情" aria-label="表情">🙂</button>
            <button type="button" class="composer-emoji-tab ${activeTab === 'favorites' ? 'is-active' : ''}" data-composer-emoji-tab="favorites" title="收藏表情" aria-label="收藏表情">♥</button>
            <button type="button" class="composer-emoji-tab" data-composer-emoji-settings title="表情设置（暂未开放）" aria-label="表情设置（暂未开放）">⚙</button>
          </nav>
          ${contextFavorite ? `<div class="composer-favorite-context-layer" data-composer-favorite-context-close><div class="composer-favorite-context-menu" role="menu" style="left:${Number(state.composerFavoriteContextMenu?.x || 0)}px;top:${Number(state.composerFavoriteContextMenu?.y || 0)}px"><button type="button" role="menuitem" data-composer-favorite-move-front="${escapeAttr(contextFavorite.id)}">移到最前</button><button type="button" role="menuitem" class="is-danger" data-composer-favorite-context-remove="${escapeAttr(contextFavorite.id)}">删除</button></div></div>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderComposerToolMenu({ privateAssistant = false, uBuddy = false } = {}) {
  const english = state.languageMode === 'en';
  const selectedMode = ['goal', 'plan'].includes(state.interactionMode) ? state.interactionMode : '';
  return `
    <div class="composer-tool-picker ${state.composerToolMenuOpen ? 'is-open' : ''}">
      <button class="composer-plus" type="button" data-composer-tool-menu-toggle title="添加" aria-haspopup="menu" aria-expanded="${state.composerToolMenuOpen ? 'true' : 'false'}">+</button>
      ${state.composerToolMenuOpen ? `
        <div class="composer-tool-menu" role="menu" aria-label="添加到对话">
          <button class="composer-tool-option" type="button" data-composer-add-files role="menuitem">
            <span class="composer-tool-icon">${iconSvg('paperclip')}</span>
            <span class="composer-tool-copy"><strong>${privateAssistant ? '主动添加文件' : '文件和文件夹'}</strong>${privateAssistant ? '<small>仅本次私人对话可见</small>' : ''}</span>
          </button>
          ${uBuddy && state.uBuddyFeatureFlags?.structuredTaskReference === true ? `<button class="composer-tool-option" type="button" data-task-reference-toggle role="menuitem"><span class="composer-tool-icon">${iconSvg('tasks')}</span><span class="composer-tool-copy"><strong>关联任务</strong><small>引用已有任务或创建新任务</small></span></button>` : ''}
          ${privateAssistant || uBuddy ? '' : `
          <button class="composer-tool-option ${selectedMode === 'goal' ? 'selected' : ''}" type="button" data-composer-interaction-mode="goal" role="menuitem">
            <span class="composer-tool-icon">${iconSvg('goal')}</span>
            <span class="composer-tool-copy"><strong>${english ? 'Goal' : '目标'}</strong><small>${english ? 'Set an ongoing objective' : '设置要持续追求的目标'}</small></span>
            ${selectedMode === 'goal' ? iconSvg('check') : ''}
          </button>
          <button class="composer-tool-option ${selectedMode === 'plan' ? 'selected' : ''}" type="button" data-composer-interaction-mode="plan" role="menuitem">
            <span class="composer-tool-icon">${iconSvg('plan')}</span>
            <span class="composer-tool-copy"><strong>${english ? 'Plan' : '计划模式'}</strong><small>${english ? 'Review a read-only plan first' : '先规划并确认，不修改文件'}</small></span>
            ${selectedMode === 'plan' ? iconSvg('check') : ''}
          </button>
          `}
        </div>
      ` : ''}
    </div>
  `;
}

export function isPptComposerMode() {
  return !isImageComposerMode() && state.currentDepartmentId === 'ppt_department';
}

export function isImageComposerMode() {
  return state.homeMode === 'image' || Boolean(state.composerImageMode);
}

export function isUBuddyComposerMode() {
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId);
  if (session?.departmentId === 'secretary_department') return true;
  return state.uBuddyConversationOpening === true
    && state.homeMode === 'secretary'
    && state.networkPanelOpen === true
    && state.networkPanelView === 'messages'
    && state.networkMessageHomeOpen !== true;
}

export function composerCapabilities(kind = '') {
  const social = ['social', 'social-direct', 'collaboration-group', 'chat-group'].includes(kind);
  const socialDirect = kind === 'social-direct' || kind === 'social';
  const collaborationGroup = kind === 'collaboration-group' || kind === 'chat-group';
  const privateAssistant = !social && isPrivateAssistantComposerMode();
  const uBuddy = !social && !privateAssistant && isUBuddyComposerMode();
  return {
    social,
    socialDirect,
    collaborationGroup,
    privateAssistant,
    uBuddy,
    showContactMention: uBuddy,
    showSocialMention: socialDirect,
    showGroupMention: collaborationGroup,
    showMemory: !social && !privateAssistant && Boolean(activeComposerMemoryEmployee()?.id),
    showTaskMemory: collaborationGroup,
  };
}

export function isPrivateAssistantComposerMode() {
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId);
  if (session?.id) return session.departmentId === 'private_assistant';
  if (state.currentAgentId || state.currentAgentInstanceId || state.currentDepartmentId) return false;
  return state.homeMode === 'private_assistant';
}

function renderComposerMetaBar() {
  if (isPrivateAssistantComposerMode()) return `<div class="composer-meta-bar is-private-meta">${renderPrivateAssistantMetaBar()}${renderPrivateAssistantPermissionPicker()}${renderContextUsageControl()}${renderPrivateAssistantContextResetControl()}</div>`;
  const secondaryControls = renderComposerSecondaryMetaControls();
  if (isPptComposerMode()) {
    const secondaryOpen = state.composerMetaOverflowOpen || state.workspaceMenuOpen
      || state.composerMemoryMenuOpen || state.sandboxMenuOpen;
    return `
      <div class="composer-meta-bar is-ppt-meta">
        <div class="ppt-primary-meta-controls">
          ${renderPptTemplatePicker({ placement: 'footer' })}
          ${renderPptStylePicker({ placement: 'footer' })}
        </div>
        <button class="composer-meta-overflow-toggle" type="button" data-composer-meta-overflow-toggle title="更多对话设置" aria-label="更多对话设置" aria-expanded="${secondaryOpen ? 'true' : 'false'}">
          ${iconSvg('more')}
        </button>
        <div class="composer-meta-secondary ${secondaryOpen ? 'is-open' : ''}" data-composer-meta-secondary>
          ${secondaryControls}
        </div>
      </div>
    `;
  }
  return `<div class="composer-meta-bar">${secondaryControls}</div>`;
}

function renderComposerSecondaryMetaControls() {
  const workspaceLabel = workspaceDisplayLabel();
  const workspaceTitle = workspaceDisplayTitle();
  const projects = (state.projects || []).filter((project) => !project.archived && project.status !== 'archived' && project.status !== 'deleted');
  return `
    <div class="workspace-picker model-picker menu-align-left menu-above ${state.workspaceMenuOpen ? 'is-open' : ''}">
        <button class="composer-meta-action model-trigger workspace-picker-trigger" type="button" data-workspace-menu-toggle title="${escapeAttr(workspaceTitle)}" aria-haspopup="menu" aria-expanded="${state.workspaceMenuOpen ? 'true' : 'false'}">
          ${iconSvg('folder')}
          <span>${escapeHtml(workspaceLabel)}</span>
          ${iconSvg('chevronDown')}
        </button>
        ${state.workspaceMenuOpen ? `
          <div class="model-menu workspace-picker-menu" role="menu" aria-label="选择项目">
            ${projects.length ? `
              <label class="workspace-project-search">
                ${iconSvg('search')}
                <input type="search" value="${escapeAttr(state.workspaceProjectQuery || '')}" data-workspace-project-search placeholder="搜索项目" autocomplete="off" spellcheck="false" />
              </label>
              <button class="model-menu-option ${state.workspaceDetached || (!state.activeProjectId && !state.workspaceRoot) ? 'selected' : ''}" type="button" data-workspace-none role="menuitem">
                <span>无项目</span>
                ${state.workspaceDetached || (!state.activeProjectId && !state.workspaceRoot) ? iconSvg('check') : ''}
              </button>
              <div class="workspace-project-scroll" role="group" aria-label="历史项目">
                ${projects.map((project) => {
                  const projectLabel = project.title || pathBasename(project.workspaceRoot || project.workspace_root || '') || '未命名项目';
                  return `
                    <div class="workspace-project-option" data-workspace-project-row data-workspace-project-label="${escapeAttr(projectLabel.toLowerCase())}">
                      <button class="model-menu-option ${project.id === state.activeProjectId ? 'selected' : ''}" type="button" data-workspace-project="${escapeAttr(project.id || '')}" role="menuitem" title="${escapeAttr(project.workspaceRoot || project.workspace_root || '')}">
                        ${iconSvg('folder')}
                        <span>${escapeHtml(projectLabel)}</span>
                        ${project.id === state.activeProjectId ? iconSvg('check') : ''}
                      </button>
                      <button class="workspace-project-remove" type="button" data-workspace-project-remove="${escapeAttr(project.id || '')}" aria-label="移除项目 ${escapeAttr(projectLabel)}" title="从项目列表移除">${iconSvg('x')}</button>
                    </div>
                  `;
                }).join('')}
                <div class="workspace-project-empty" data-workspace-project-empty hidden>没有匹配的项目</div>
              </div>
              <div class="model-menu-divider"></div>
            ` : ''}
            <div class="workspace-create-row ${state.workspaceCreateMenuOpen ? 'is-open' : ''}">
              <button class="model-menu-option workspace-create-trigger" type="button" data-workspace-create-toggle role="menuitem" aria-haspopup="menu" aria-expanded="${state.workspaceCreateMenuOpen ? 'true' : 'false'}">
                ${iconSvg('plus')}
                <span>新建项目</span>
                ${iconSvg('chevronRight')}
              </button>
              ${state.workspaceCreateMenuOpen ? `
                <div class="model-menu workspace-create-submenu" role="menu" aria-label="新建项目">
                  <button class="model-menu-option" type="button" data-create-blank-project role="menuitem">
                    ${iconSvg('plus')}
                    <span>新建文件夹</span>
                  </button>
                  <button class="model-menu-option" type="button" data-select-workspace role="menuitem">
                    ${iconSvg('folder')}
                    <span>使用现有文件夹</span>
                  </button>
                </div>
              ` : ''}
            </div>
          </div>
        ` : ''}
      </div>
      ${renderContextUsageControl()}
      ${renderComposerMemoryPicker()}
      ${renderSandboxPermissionPicker()}
      ${renderInteractionModeIndicator()}
  `;
}

function renderContextUsageControl() {
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  if (!session || session.readOnly || session.writeState === 'read_only') return '';
  const usage = state.contextUsage?.sessionId === session.id ? state.contextUsage : {};
  const compression = contextCompressionOperationForSession(session.id);
  const compressionBusy = compression?.status === 'running';
  const privateResetBusy = isPrivateAssistantComposerMode() && state.privateAssistantContextResetBusy;
  const percent = Math.max(0, Number(usage.usagePercent || 0));
  const remainingPercent = usage.remainingPercent == null
    ? Math.max(0, Math.min(100, 100 - percent))
    : Math.max(0, Math.min(100, Number(usage.remainingPercent)));
  const tone = usage.warningLevel && usage.warningLevel !== 'normal' ? ` is-${escapeAttr(usage.warningLevel)}` : '';
  const label = compressionBusy
    ? '压缩中…'
    : usage.measurementState === 'available' ? `上下文剩余 ${remainingPercent}%` : '上下文';
  const title = compressionBusy
    ? '正在使用 Janus 原生能力整理当前线程；原始聊天历史和 Memory 不会删除'
    : '使用 Janus 原生能力整理当前线程；若原生能力不可用，才会创建本地恢复摘要';
  return `<button class="composer-meta-action context-usage-control${tone}${compressionBusy ? ' is-busy' : ''}" type="button" data-chat-clear-context ${compressionBusy || privateResetBusy ? 'disabled' : ''}
    title="${escapeAttr(title)}" aria-busy="${compressionBusy ? 'true' : 'false'}">${iconSvg('clock')}<span>${escapeHtml(label)}</span></button>`;
}

function renderPrivateAssistantContextResetControl() {
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  if (!session || session.departmentId !== 'private_assistant' || session.readOnly || session.writeState === 'read_only') return '';
  const busy = Boolean(state.privateAssistantContextResetBusy || currentContextCompressionOperation()?.status === 'running'
    || (state.activeChatRun && !state.activeChatRun.terminal));
  const title = '清空私人助理的模型线程和当前对话上下文；历史消息仍保留在界面中，不影响其他 Agent，也不会删除附件或文件';
  return `<button class="composer-meta-action private-assistant-reset-control${state.privateAssistantContextResetBusy ? ' is-busy' : ''}" type="button" data-private-assistant-reset-context ${busy ? 'disabled' : ''} title="${escapeAttr(title)}" aria-busy="${state.privateAssistantContextResetBusy ? 'true' : 'false'}">${iconSvg('trash')}<span>${state.privateAssistantContextResetBusy ? '清空中…' : '清空上下文'}</span></button>`;
}

function contextCompressionOperationForSession(sessionId = '') {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) return null;
  return Object.values(state.contextCompressionOperations || {}).find((operation) => (
    operation?.sessionId === cleanSessionId && operation.status === 'running'
  )) || null;
}

function currentContextCompressionOperation() {
  return contextCompressionOperationForSession(state.currentSessionId);
}

function renderComposerMemoryPicker() {
  const employee = activeComposerMemoryEmployee();
  if (!employee?.id) return '';
  const english = normalizeLanguage(state.languageMode) === 'en';
  const capability = state.employeeOverview?.capabilities?.multiMemory || {};
  const documents = state.composerMemoryAgentInstanceId === employee.id
    ? (state.composerMemoryDocuments || []).filter((item) => item.scope === 'general' && item.lifecycleState !== 'archived')
      .sort((left, right) => String(right.lastUsedAt || right.updatedAt || '').localeCompare(String(left.lastUsedAt || left.updatedAt || '')))
    : [];
  const currentMemoryId = state.composerMemoryAgentInstanceId === employee.id
    ? state.composerMemoryContext?.activeMemoryDocumentId || employee.currentMemory?.id || ''
    : employee.currentMemory?.id || '';
  const current = documents.find((item) => item.id === currentMemoryId) || employee.currentMemory || null;
  const readOnly = capability.enabled !== true || capability.readOnly === true;
  const busy = state.composerMemoryBusy || state.busy
    || currentContextCompressionOperation()?.status === 'running'
    || Boolean(state.activeChatRun && !state.activeChatRun.terminal);
  const currentRenameDisabled = busy || readOnly || !current?.id;
  const memoryLabel = english ? 'Memory' : 'Memory';
  const currentLabel = english ? 'Rename current Memory' : '重命名当前 Memory';
  const currentSubLabel = english ? 'Only changes the name; messages and context stay the same.' : '只修改名称，消息和上下文不变。';
  return `<div class="composer-memory-picker model-picker menu-align-left menu-above ${state.composerMemoryMenuOpen ? 'is-open' : ''}">
    <button class="composer-meta-action model-trigger composer-memory-trigger" type="button" data-composer-memory-toggle title="${escapeAttr(english ? 'Switch or save the current Memory' : '切换或保存当前 Memory')}" aria-haspopup="menu" aria-expanded="${state.composerMemoryMenuOpen ? 'true' : 'false'}">
      ${iconSvg('memory')}
      <span>${escapeHtml(current?.displayName || memoryLabel)}</span>
      ${iconSvg('chevronDown')}
    </button>
    ${state.composerMemoryMenuOpen ? `<div class="model-menu composer-memory-menu" role="menu" aria-label="${escapeAttr(english ? 'Memory and context' : 'Memory 与上下文')}">
      <div class="composer-memory-menu-head"><strong>${escapeHtml(current?.displayName || (english ? 'Current Memory' : '当前 Memory'))}</strong><small>${escapeHtml(english ? 'Current chat context · switching opens a new model thread' : '当前对话上下文 · 切换会开启新的模型线程')}</small></div>
      ${state.composerMemoryBusy ? `<div class="composer-memory-loading">${escapeHtml(english ? 'Reading Memory…' : '正在读取 Memory…')}</div>` : `
        <button class="model-menu-option" type="button" data-composer-memory-create role="menuitem" ${busy || readOnly ? 'disabled' : ''}>
          ${iconSvg('plus')}<span><strong>${escapeHtml(english ? 'Create Memory' : '新建 Memory')}</strong><small>${escapeHtml(english ? 'Use a custom name and keep the current context branch' : '自定义名称，保留现有上下文分支')}</small></span>
        </button>
        <button class="model-menu-option" type="button" data-composer-memory-rename="${escapeAttr(current?.id || '')}" data-memory-name="${escapeAttr(current?.displayName || '')}" role="menuitem" ${currentRenameDisabled ? 'disabled' : ''}>
          ${iconSvg('edit')}<span><strong>${escapeHtml(currentLabel)}</strong><small>${escapeHtml(currentSubLabel)}</small></span>
        </button>
        <div class="model-menu-divider"></div>
        <div class="composer-memory-list" role="group" aria-label="${escapeAttr(english ? 'Switchable Memory' : '可切换 Memory')}">
          ${documents.length ? documents.map((document) => {
            const selected = document.id === currentMemoryId;
            return `<button class="model-menu-option ${selected ? 'selected' : ''}" type="button" data-composer-memory-switch="${escapeAttr(document.id)}" role="menuitem" ${busy || readOnly || selected ? 'disabled' : ''}>
              ${iconSvg('document')}<span><strong>${escapeHtml(document.displayName || (english ? `New Conversation ${Number(document.slotNo || 0) + 1}` : `新对话 ${Number(document.slotNo || 0) + 1}`))}</strong><small>${selected ? escapeHtml(english ? 'Current context' : '当前上下文') : escapeHtml(english ? `${Number(document.messageCount || 0)} messages · ${formatMessageTime(document.lastUsedAt || document.updatedAt)}` : `${Number(document.messageCount || 0)} 条消息 · ${formatMessageTime(document.lastUsedAt || document.updatedAt)}`)}</small></span>${selected ? iconSvg('check') : ''}
            </button>`;
          }).join('') : `<div class="composer-memory-loading">${escapeHtml(english ? 'No switchable Memory yet' : '暂无可切换 Memory')}</div>`}
        </div>
        ${readOnly ? `<div class="composer-memory-readonly">${escapeHtml(memoryCapabilityMessage(capability.code, { english }))}</div>` : ''}
      `}
    </div>` : ''}
  </div>`;
}

function activeComposerMemoryEmployee() {
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  const roster = state.employeeOverview?.roster || [];
  const sessionAgentInstanceId = session?.agentInstanceId || session?.agent_instance_id || '';
  if (sessionAgentInstanceId) return roster.find((item) => item.id === sessionAgentInstanceId) || { id: sessionAgentInstanceId, currentMemory: null };
  const selected = state.currentAgentInstanceId
    ? roster.find((item) => item.id === state.currentAgentInstanceId)
    : null;
  if (selected && (!state.currentAgentId || selected.agentFamilyId === state.currentAgentId)) return selected;
  if (isUBuddyComposerMode()) return roster.find((item) => item.agentFamilyId === 'secretary_agent') || null;
  return null;
}

function memoryCapabilityMessage(code = '', { english = false } = {}) {
  const messages = english ? {
    cloud_not_configured: 'Cloud is not connected yet; only local Memory is available.',
    cloud_sync_pending: 'Memory is still setting up first cloud sync; try again later.',
    context_space_contract_unsupported: 'The cloud service is too old to support multi-Memory writes.',
  } : {
    cloud_not_configured: '尚未连接云端；当前只能查看本地 Memory。',
    cloud_sync_pending: 'Memory 正在建立首次云端同步，请稍后重试。',
    context_space_contract_unsupported: '云端服务版本较旧，暂不支持多 Memory 写入。',
  };
  return messages[code] || (english ? 'Memory writes are not ready yet. Try again later.' : 'Memory 写入能力尚未就绪，请稍后重试。');
}

function renderPrivateAssistantMetaBar() {
  const usage = state.privateAssistant || {};
  const providerUsage = state.managedProviderUsage || {};
  const used = Math.max(0, Number(usage.weeklyTokensUsed) || 0);
  const textUsed = usage.weeklyTextTokensUsed == null
    ? used
    : Math.max(0, Number(usage.weeklyTextTokensUsed) || 0);
  const imageCount = Math.max(0, Number(providerUsage.dailyImagesUsed) || 0);
  const imageLimited = providerUsage.imageGenerationLimited === true
    || (providerUsage.imageGenerationLimited == null && providerUsage.managedProvider === true);
  const imageLimit = imageLimited ? Math.max(1, Number(providerUsage.dailyImageLimit) || 5) : null;
  const limit = Math.max(1, Number(usage.weeklyTokenLimit) || 20_000_000);
  const percent = quotaUsagePercent(used, limit);
  const english = state.languageMode === 'en';
  const managedProvider = providerUsage.managedProvider === true;
  const remaining = Math.max(0, Number(usage.weeklyTokensRemaining) || Math.max(0, limit - used));
  const resetLabel = formatPrivateAssistantResetLabel(usage.resetAt, english);
  const lastTurnTokens = Math.max(0, Number(usage.lastTurnTokens) || 0);
  const lastTurnInputTokens = Math.max(0, Number(usage.lastTurnInputTokens) || 0);
  const lastTurnOutputTokens = Math.max(0, Number(usage.lastTurnOutputTokens) || 0);
  const lastTurnCachedInputTokens = Math.max(0, Number(usage.lastTurnCachedInputTokens) || 0);
  const usageSource = usage.usageSource === 'estimated'
    ? english ? 'Estimated' : '本轮估算'
    : english ? 'Reported' : '模型返回';
  const details = english
    ? `Weekly: ${formatPrivateTokenCount(used)} / ${formatPrivateTokenCount(limit)} tokens · ${formatQuotaPercent(percent)}% used · Images: ${imageLimited ? `${imageCount} / ${imageLimit}` : `${imageCount} · Unlimited`} · Resets ${resetLabel}`
    : `本周：${formatPrivateTokenCount(used)} / ${formatPrivateTokenCount(limit)} tokens · 已用 ${formatQuotaPercent(percent)}% · 图片 ${imageLimited ? `${imageCount} / ${imageLimit}` : `${imageCount} 张 · 不限额`} · ${resetLabel}重置`;
  const headline = `${english ? 'Week' : '本周'} ${formatPrivateTokenCount(used)}/${formatPrivateTokenCount(limit)}`;
  const latestBreakdown = `${usageSource} · ${english ? 'In' : '输入'} ${formatPrivateTokenCount(lastTurnInputTokens)}${lastTurnCachedInputTokens > 0 ? (english ? ` (${formatPrivateTokenCount(lastTurnCachedInputTokens)} cached)` : `（缓存 ${formatPrivateTokenCount(lastTurnCachedInputTokens)}）`) : ''} · ${english ? 'Out' : '输出'} ${formatPrivateTokenCount(lastTurnOutputTokens)}`;
  const textCalculation = managedProvider
    ? english
      ? 'Text counts toward the weekly allowance and is still subject to the default model daily allowance.'
      : '文本计入每周额度，仍受默认模型服务每日额度限制。'
    : english
      ? `Custom providers have no daily token limit, but the ${formatPrivateTokenCount(limit)} Private Assistant weekly allowance still applies.`
      : `自配置模型服务无每日 Token 限额，但私人助理仍受每周 ${formatPrivateTokenCount(limit)} Token 额度限制。`;
  const imageCalculation = imageLimited
    ? english ? `Images use a separate shared daily limit of ${imageLimit}.` : `图片使用独立的每日 ${imageLimit} 张共享额度。`
    : english ? 'Custom image providers are tracked separately and have no Janus daily image limit.' : '自定义图片 Provider 单独记录用量，不受 Janus 每日图片限额。';
  const calculationCopy = `${textCalculation} ${imageCalculation}`;
  return `<details class="private-assistant-meta private-assistant-quota-details" data-private-assistant-usage>
    <summary class="private-assistant-quota-trigger" title="${escapeAttr(details)}">
      <span class="private-assistant-quota ${usage.exhausted ? 'is-exhausted' : ''}">
        <span><strong>${escapeHtml(headline)}</strong></span>
        <i><b class="quota-fill is-private ${percent > 0 ? 'has-usage' : ''}" role="progressbar" aria-label="${english ? 'Private Assistant weekly allowance' : '私人助理每周额度'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" style="width:${percent}%"></b></i>
      </span>
      ${iconSvg('chevronDown')}
    </summary>
    <div class="private-assistant-quota-popover">
      <header><strong>${english ? 'Weekly Tokens' : '每周 Token'}</strong><small>${english ? `Reset ${resetLabel}` : `${resetLabel}重置`}</small></header>
      <div class="private-assistant-quota-detail-row is-private-quota"><span>${english ? 'This Week' : '本周'}</span><strong>${formatPrivateTokenCount(used)} / ${formatPrivateTokenCount(limit)}</strong><small>${english ? `${formatQuotaPercent(percent)}% used · ${formatPrivateTokenCount(remaining)} left` : `已用 ${formatQuotaPercent(percent)}% · 剩余 ${formatPrivateTokenCount(remaining)}`}</small></div>
      <div class="private-assistant-quota-detail-row"><span>${english ? 'GPT-5.x Text' : 'GPT-5.x 文本'}</span><strong>${formatPrivateTokenCount(textUsed)} tokens</strong><small>${english ? 'Combined input and output tokens' : '输入与输出 Token 合计'}</small></div>
      ${lastTurnTokens > 0 ? `<div class="private-assistant-quota-detail-row"><span>${english ? 'Latest Turn' : '最近一轮'}</span><strong>${formatPrivateTokenCount(lastTurnTokens)} tokens</strong><small>${escapeHtml(latestBreakdown)}</small></div>` : ''}
      <div class="private-assistant-quota-detail-row"><span>GPT Image-2</span><strong>${imageLimited ? `${imageCount} / ${imageLimit}` : `${imageCount} · ${english ? 'Unlimited' : '不限额'}`}</strong><small>${imageLimited ? (english ? 'Today · Shared' : '今日 · 所有模式共享') : (english ? 'Today · Current provider' : '今日 · 当前 Provider')}</small></div>
      <div class="private-assistant-quota-rule"><strong>${english ? 'Calculation' : '计算方式'}</strong><p>${escapeHtml(calculationCopy)}</p></div>
    </div>
  </details>`;
}

function formatPrivateAssistantResetLabel(value = '', english = false) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return english ? 'next week' : '下周';
  return date.toLocaleString(english ? 'en-US' : 'zh-CN', english
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatPrivateTokenCount(value) {
  const amount = Math.max(0, Number(value) || 0);
  if (amount >= 1_000_000) return `${trimTokenDecimal((amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1))}M`;
  if (amount >= 1_000) return `${trimTokenDecimal((amount / 1_000).toFixed(amount >= 100_000 ? 0 : 1))}K`;
  return String(Math.round(amount));
}

function trimTokenDecimal(value) {
  return String(value).replace(/\.0$/, '');
}

function renderInteractionModeIndicator() {
  const english = state.languageMode === 'en';
  if (state.interactionMode === 'goal') {
    const session = (state.sessions || []).find((item) => item.id === state.currentSessionId);
    const objective = String(session?.goal?.objective || '').trim();
    const status = session?.goal?.status || 'active';
    const statusLabel = english
      ? ({ active: 'Active', paused: 'Paused', blocked: 'Blocked', usageLimited: 'Usage limited', budgetLimited: 'Limited', complete: 'Completed' })[status] || 'Active'
      : ({ active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '用量受限', budgetLimited: '受限', complete: '已完成' })[status] || '进行中';
    const title = objective
      ? (english ? `Goal (${statusLabel}): ${objective}\nClick to exit Goal mode` : `目标（${statusLabel}）：${objective}\n点击退出目标模式`)
      : (english ? 'Goal mode: send your next message to set an objective; click to close' : '目标模式：发送下一条消息以设置目标；点击关闭');
    return `<button class="composer-interaction-indicator mode-goal" type="button" data-composer-interaction-indicator title="${escapeAttr(title)}">${renderInteractionModeIcon('goal')}<span>${english ? 'Goal' : '目标'}</span></button>`;
  }
  if (state.interactionMode === 'plan') {
    return `<button class="composer-interaction-indicator mode-plan" type="button" data-composer-interaction-indicator title="${escapeAttr(english ? 'Plan mode: analyze and create a reviewable plan without changing files; click to close' : '计划模式：只读分析并生成可审查计划；点击关闭')}">${renderInteractionModeIcon('plan')}<span>${english ? 'Plan' : '计划'}</span></button>`;
  }
  return '';
}

function renderInteractionModeIcon(kind) {
  return `<span class="composer-interaction-mode-icon"><span class="composer-interaction-mode-icon-default">${iconSvg(kind)}</span><span class="composer-interaction-mode-icon-close">${iconSvg('x')}</span></span>`;
}

function renderSandboxPermissionPicker() {
  const uBuddy = isUBuddyComposerMode();
  const options = uBuddy ? [
    ['auto-approve', 'permissionAuto', 'AI 自动审查', '由 AI 审查风险操作，任务内所有本机员工 Agent 继承'],
    ['full-access', 'permissionFull', '完全开放', '允许任务内所有本机员工 Agent 使用终端、网络和电脑文件'],
  ] : [
    ['request-approval', 'permissionAsk', '请求批准', '编辑外部文件和使用互联网时始终询问'],
    ['auto-approve', 'permissionAuto', '替我审批', '仅对检测到的风险操作请求批准'],
    ['full-access', 'permissionFull', '完全访问权限', '可不受限制地访问互联网和您电脑上的任何文件'],
  ];
  const activeRun = state.activeChatRun && !state.activeChatRun.terminal ? state.activeChatRun : null;
  const locked = Boolean(activeRun);
  const activeMode = locked ? activeRun.permissionMode : state.sandboxPermission;
  const current = options.find(([value]) => value === activeMode) || options[0];
  const english = state.languageMode === 'en';
  const englishLabel = ({
    'request-approval': 'Request Approval',
    'auto-approve': 'Approve for Me',
    'full-access': 'Full Access',
  })[current[0]] || current[2];
  const displayLabel = locked
    ? english ? `This Turn · ${englishLabel}` : `本轮 · ${current[2]}`
    : current[2];
  const title = locked
    ? english
      ? `This reply is using “${englishLabel}”. Permission can be changed after it finishes.`
      : `当前回复正在使用“${current[2]}”，结束后可调整执行权限。`
    : english ? 'Execution permission' : uBuddy ? 'uBuddy 任务权限' : '执行权限';
  return `
    <div class="sandbox-permission-picker model-picker menu-align-left menu-above ${!locked && state.sandboxMenuOpen ? 'is-open' : ''} ${locked ? 'is-run-locked' : ''} permission-${escapeAttr(current[0])}">
      <button class="model-trigger sandbox-permission-trigger" id="sandbox-permission-trigger" type="button" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" aria-haspopup="${locked ? 'false' : 'menu'}" aria-expanded="${!locked && state.sandboxMenuOpen ? 'true' : 'false'}" ${state.busy || locked ? 'disabled' : ''}>
        ${iconSvg(current[1])}
        <span>${escapeHtml(displayLabel)}</span>
        ${iconSvg(locked ? 'lock' : 'chevronDown')}
      </button>
      ${!locked && state.sandboxMenuOpen ? `
        <div class="model-menu sandbox-permission-menu" role="menu" aria-label="${uBuddy ? 'uBuddy 任务权限' : '沙盒权限'}">
          ${uBuddy ? '<div class="private-assistant-permission-note">所选权限会锁定到本次任务，并由全部本机员工 Agent、重试与返工节点继承。完全开放可使用终端、网络和电脑文件，不包含鼠标、键盘或桌面应用 GUI 自动化。</div>' : ''}
          ${options.map(([value, icon, label, description]) => `
            <button class="sandbox-permission-option ${value === state.sandboxPermission ? 'selected' : ''}" type="button" data-sandbox-permission="${escapeAttr(value)}" role="menuitem">
              <span class="sandbox-permission-option-icon">${iconSvg(icon)}</span>
              <span class="sandbox-permission-option-copy">
                <strong>${escapeHtml(label)}</strong>
                <small>${escapeHtml(description)}</small>
              </span>
              <span class="sandbox-permission-option-check">${value === state.sandboxPermission ? iconSvg('check') : ''}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderPrivateAssistantPermissionPicker() {
  const options = [
    ['request-approval', 'permissionAsk', '请求批准', '在私人工作区内执行风险操作时先询问'],
    ['task-workspace', 'permissionAuto', '隔离空间内执行', '仅在私人助理隔离目录内自动执行，不开放全盘访问'],
  ];
  const activeRun = state.activeChatRun && !state.activeChatRun.terminal ? state.activeChatRun : null;
  const locked = Boolean(activeRun);
  const activeMode = locked ? activeRun.permissionMode : state.privateAssistantPermission;
  const current = options.find(([value]) => value === activeMode) || options[0];
  const english = state.languageMode === 'en';
  const englishLabel = ({
    'request-approval': 'Request Approval',
    'task-workspace': 'Run in Isolated Workspace',
  })[current[0]] || current[2];
  const displayLabel = locked
    ? english ? `This Turn · ${englishLabel}` : `本轮 · ${current[2]}`
    : current[2];
  const title = locked
    ? english
      ? `This reply is using “${englishLabel}”. Permission can be changed after it finishes.`
      : `当前回复正在使用“${current[2]}”，结束后可调整执行权限。`
    : english ? 'Private Assistant permission' : '私人助理权限';
  return `
    <div class="sandbox-permission-picker private-assistant-permission-picker model-picker menu-align-left menu-above ${!locked && state.sandboxMenuOpen ? 'is-open' : ''} ${locked ? 'is-run-locked' : ''} permission-${escapeAttr(current[0])}">
      <button class="model-trigger sandbox-permission-trigger" id="sandbox-permission-trigger" type="button" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" aria-haspopup="${locked ? 'false' : 'menu'}" aria-expanded="${!locked && state.sandboxMenuOpen ? 'true' : 'false'}" ${state.busy || state.privateAssistantContextResetBusy || locked ? 'disabled' : ''}>
        ${iconSvg(current[1])}
        <span>${escapeHtml(displayLabel)}</span>
        ${iconSvg(locked ? 'lock' : 'chevronDown')}
      </button>
      ${!locked && state.sandboxMenuOpen ? `
        <div class="model-menu sandbox-permission-menu private-assistant-permission-menu" role="menu" aria-label="私人助理权限">
          <div class="private-assistant-permission-note">权限始终限制在私人助理隔离工作区，不会开放其他项目、Agent 或本机目录。</div>
          ${options.map(([value, icon, label, description]) => `
            <button class="sandbox-permission-option ${value === state.privateAssistantPermission ? 'selected' : ''}" type="button" data-private-assistant-permission="${escapeAttr(value)}" role="menuitem">
              <span class="sandbox-permission-option-icon">${iconSvg(icon)}</span>
              <span class="sandbox-permission-option-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span>
              <span class="sandbox-permission-option-check">${value === state.privateAssistantPermission ? iconSvg('check') : ''}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function activeProjectForComposer() {
  if (!state.activeProjectId) return null;
  return (state.projects || []).find((project) => project.id === state.activeProjectId) || null;
}

export function workspaceDisplayLabel() {
  if (state.workspaceDetached) return '无项目';
  const project = activeProjectForComposer();
  if (project) return project.title || pathBasename(project.workspaceRoot || project.workspace_root || '') || '项目工作区';
  return state.workspaceRoot ? pathBasename(state.workspaceRoot) : '选择项目';
}

function workspaceDisplayTitle() {
  if (state.workspaceDetached) return '当前对话不属于任何项目';
  const project = activeProjectForComposer();
  if (project) return project.workspaceRoot || project.workspace_root || project.title || '项目工作区';
  return state.workspaceRoot || '选择项目';
}

function renderInputTags() {
  if (state.homeMode === 'collaboration') return '';
  if (state.selectionSource !== 'manual' || !state.currentDepartmentId) return '';
  const chip = HOME_DEPARTMENT_CHIPS.find(([departmentId]) => departmentId === state.currentDepartmentId);
  const deptLabel = chip?.[2] || departmentName(state.currentDepartmentId);
  const deptIcon = chip?.[1] || 'tasks';
  if (state.currentAgentId) {
    return `<div class="input-tags"><button type="button" class="input-tag tag-agent" data-clear-selection="agent" title="移除助手"><span class="tag-agent-dot"></span><span class="tag-label">${escapeHtml(agentNameById(state.currentAgentId))}</span><span class="tag-remove">×</span></button></div>`;
  }
  return `<div class="input-tags"><button type="button" class="input-tag tag-dept" data-clear-selection="department" title="移除部门">${iconSvg(deptIcon)}<span class="tag-label">${escapeHtml(deptLabel)}</span><span class="tag-remove">×</span></button></div>`;
}

export function renderAttachmentTray() {
  if (!state.attachments.length) return '';
  return `
    <div class="attachment-tray">
      ${state.attachments.map((item) => {
        const name = item.uploaded?.filename || item.file?.name || item.name || 'file';
        const size = item.uploaded?.size || item.file?.size || 0;
        const status = item.status || 'queued';
        const uploadedFile = item.uploaded ? normalizeFilePayload({
          ...item.uploaded,
          kind: item.kind,
          name,
          filename: name,
          fileUrl: item.uploaded.file_url || item.uploaded.preview_url || '',
        }) : null;
        const visualKind = attachmentVisualKind(item);
        const uploading = ['queued', 'uploading'].includes(status);
        if (visualKind === 'image') {
          return `
            <figure class="attachment-chip attachment-card attachment-image-chip compact-attachment-tile is-image ${uploading ? 'is-uploading' : ''} ${status === 'error' ? 'is-error' : ''}" title="${escapeAttr(name)}">
              <button class="attachment-image-preview" type="button" data-preview-attachment="${escapeAttr(item.id)}"${uploadedFile && (uploadedFile.path || uploadedFile.id) ? ` data-image-context-file="${filePayloadAttr(uploadedFile)}"` : ''} ${status === 'error' ? 'disabled' : ''} aria-label="预览图片 ${escapeAttr(name)}">
                ${attachmentPreviewContent(item, visualKind)}
                ${uploading ? attachmentProgressRing(item.progress) : ''}
              </button>
              ${status === 'error' ? `<button class="attachment-retry" type="button" data-retry-attachment="${escapeAttr(item.id)}" title="重试上传">${iconSvg('refresh')}</button>` : ''}
              <button class="attachment-remove" type="button" data-remove-attachment="${escapeAttr(item.id)}" title="移除">${iconSvg('x')}</button>
            </figure>
          `;
        }
        return `
          <div class="attachment-chip attachment-card compact-attachment-tile is-${escapeAttr(visualKind)} ${uploading ? 'is-uploading' : ''} ${status === 'error' ? 'is-error' : ''}" title="${escapeAttr(name)}">
            <span class="attachment-preview attachment-kind-${escapeAttr(visualKind)}">
              ${attachmentPreviewContent(item, visualKind)}
              ${uploading ? attachmentProgressRing(item.progress) : ''}
            </span>
            <button class="attachment-main" type="button" data-preview-attachment="${escapeAttr(item.id)}">
              <strong>${escapeHtml(name)}</strong>
              <small>${escapeHtml(statusLabelForAttachment(item))}${size ? ` · ${escapeHtml(formatBytes(size))}` : ''}</small>
            </button>
            ${status === 'error' ? `<button class="attachment-action attachment-retry" type="button" data-retry-attachment="${escapeAttr(item.id)}" title="重试上传">${iconSvg('refresh')}</button>` : ''}
            ${uploadedFile && status === 'done' ? `
              <span class="attachment-actions">
                <button class="attachment-action" type="button" data-save-file="${filePayloadAttr(uploadedFile)}" title="另存为">${iconSvg('download')}</button>
                <button class="attachment-action" type="button" data-show-file="${filePayloadAttr(uploadedFile)}" title="在文件夹中显示">${iconSvg('folder')}</button>
              </span>
            ` : ''}
            <button class="attachment-remove" type="button" data-remove-attachment="${escapeAttr(item.id)}" title="移除">${iconSvg('x')}</button>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function attachmentPreviewContent(item, visualKind = attachmentVisualKind(item)) {
  if (visualKind === 'image') {
    const imageUrl = item.localPreviewUrl || item.uploaded?.file_url || item.uploaded?.preview_url || item.uploaded?.download_url || item.uploaded?.downloadUrl || item.uploaded?.url || item.fileUrl || item.file_url || item.preview_url || item.previewUrl || item.download_url || item.downloadUrl || item.url || '';
    if (imageUrl) return `<img class="attachment-preview-media" src="${escapeAttr(imageUrl)}" alt="" />`;
  }
  const labels = {
    pdf: 'PDF',
    word: 'W',
    ppt: 'P',
    excel: 'X',
    text: 'TXT',
    code: 'CODE',
    archive: 'ZIP',
    installer: 'APP',
    image: 'IMG',
    file: 'FILE',
  };
  return `<span class="attachment-file-icon file-type-badge file-type-${escapeAttr(visualKind)}">${escapeHtml(labels[visualKind] || 'FILE')}</span>`;
}

function attachmentProgressRing(progress) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const safeProgress = Math.max(2, Math.min(100, Number(progress) || 0));
  const offset = circumference * (1 - safeProgress / 100);
  return `<span class="attachment-progress-overlay" aria-hidden="true">
    <svg class="attachment-progress-ring" viewBox="0 0 44 44">
      <circle class="attachment-progress-track" cx="22" cy="22" r="${radius}"></circle>
      <circle class="attachment-progress-value" cx="22" cy="22" r="${radius}" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
    </svg>
  </span>`;
}

function attachmentVisualKind(item = {}) {
  const explicitKind = String(item.kind || item.uploaded?.kind || '').toLowerCase();
  const name = item.file?.name || item.uploaded?.filename || item.filename || item.name || '';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (explicitKind === 'image' || IMAGE_ATTACHMENT_EXTENSIONS.has(ext)) return 'image';
  if (['doc', 'docx', 'word'].includes(explicitKind)) return 'word';
  if (['xls', 'xlsx', 'excel'].includes(explicitKind)) return 'excel';
  if (['ppt', 'pptx'].includes(explicitKind)) return 'ppt';
  if (explicitKind === 'pdf') return 'pdf';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx'].includes(ext)) return 'word';
  if (['ppt', 'pptx'].includes(ext)) return 'ppt';
  if (['xls', 'xlsx', 'csv', 'tsv'].includes(ext)) return 'excel';
  if (['txt', 'md', 'markdown', 'toml', 'yaml', 'yml', 'json', 'xml'].includes(ext)) return 'text';
  if (['js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'html', 'css'].includes(ext)) return 'code';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 'archive';
  if (['exe', 'msi', 'dmg', 'pkg', 'apk', 'appimage', 'deb', 'rpm', 'iso'].includes(ext)) return 'installer';
  return 'file';
}

function renderTextModelControls(compact) {
  const currentModel = currentModelValue();
  const currentReasoning = currentReasoningValue();
  return `
    ${renderModelReasoningPicker(currentModel, currentReasoning)}
    ${compact ? renderAgentInlinePicker() : ''}
  `;
}

function composerContext() {
  if (isUBuddyComposerMode()) return null;
  if (isPrivateAssistantComposerMode()) {
    return {
      icon: 'shield',
      label: '私人助理',
    };
  }
  if (state.homeMode === 'collaboration') {
    return {
      icon: 'tasks',
      label: '部门协作',
    };
  }
  if (state.currentDepartmentId === 'ppt_department') return null;
  if (state.selectionSource === 'manual') return null;
  if (!state.currentDepartmentId) return null;
  const chip = HOME_DEPARTMENT_CHIPS.find(([departmentId]) => departmentId === state.currentDepartmentId);
  const dept = state.org.departments.find((item) => item.id === state.currentDepartmentId);
  if (!chip && !dept) return null;
  return {
    icon: chip?.[1] || 'tasks',
    label: chip?.[2] || dept?.name,
  };
}

function renderPptTemplatePicker({ placement = 'inline' } = {}) {
  const current = currentPptTemplateValue();
  const currentTemplate = currentPptTemplate();
  const previewId = optionValueOrDefault(PPT_TEMPLATE_OPTIONS, state.pptTemplatePreviewId || current, current);
  const query = normalizeSearch(state.pptTemplateQuery);
  const filtered = PPT_TEMPLATE_OPTIONS.filter(([value, label]) => {
    if (!query) return true;
    return normalizeSearch(`${label} ${pptTemplateDescription(value)}`).includes(query);
  });
  return `
    <div class="ppt-template-picker menu-above ${placement === 'footer' ? 'footer-template-picker' : ''} ${state.pptTemplateMenuOpen ? 'is-open' : ''}">
      <button id="ppt-template-trigger" class="ppt-template-trigger" type="button" title="PPT 模板" aria-haspopup="menu" aria-expanded="${state.pptTemplateMenuOpen ? 'true' : 'false'}">
        ${iconSvg('palette')}
        <span>${escapeHtml(currentTemplate.label === '无' ? '不使用模板' : currentTemplate.label)}</span>
        ${iconSvg('chevronDown')}
      </button>
      ${state.pptTemplateMenuOpen ? `
        <div class="ppt-template-menu" role="menu">
          <input class="ppt-template-search" id="ppt-template-search" value="${escapeAttr(state.pptTemplateQuery)}" placeholder="搜索模板..." autocomplete="off" />
          <div class="ppt-template-count">${PPT_TEMPLATE_OPTIONS.length} 个模板</div>
          <div class="ppt-template-options">
            ${filtered.map(([value, label, , previewUrl]) => `
              <button class="ppt-template-option ${value === current ? 'selected' : ''}" type="button" role="menuitem" data-ppt-template-option="${escapeAttr(value)}" data-ppt-template-preview="${escapeAttr(value)}">
                <span class="ppt-template-thumb">${previewUrl ? `<img src="${escapeAttr(previewUrl)}" alt="" />` : iconSvg('palette')}</span>
                <span class="ppt-template-copy">
                  <strong>${escapeHtml(value === 'none' ? '不使用模板' : label)}</strong>
                  <small>${escapeHtml(pptTemplateDescription(value))}</small>
                </span>
                ${value === current ? iconSvg('check') : ''}
              </button>
            `).join('') || '<div class="ppt-template-empty">没有匹配的模板</div>'}
          </div>
          <div id="ppt-template-preview-popover" class="ppt-template-preview-popover">
            ${PPT_TEMPLATE_OPTIONS.map(([value]) => `
              <div class="ppt-template-preview-pane ${value === previewId ? 'active' : ''}" data-ppt-template-pane="${escapeAttr(value)}">
                ${pptTemplatePreviewMarkup(value)}
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderPptStylePicker({ placement = 'inline' } = {}) {
  const selectedStyle = pptStyleOption(state.pptStyleId);
  const selectedStyleLabel = translateUiText(selectedStyle.label, state.languageMode);
  return `
    <div class="ppt-style-picker menu-above ${placement === 'footer' ? 'footer-style-picker' : ''} ${state.pptStyleMenuOpen ? 'is-open' : ''}">
      <button id="ppt-style-trigger" class="ppt-template-trigger ppt-style-trigger" type="button" title="PPT 风格" aria-haspopup="menu" aria-expanded="${state.pptStyleMenuOpen ? 'true' : 'false'}">
        ${iconSvg('presentation')}
        <span>${escapeHtml(selectedStyleLabel)}</span>
        ${iconSvg('chevronDown')}
      </button>
      ${state.pptStyleMenuOpen ? `
        <div class="ppt-style-menu" role="menu">
          ${renderPptStyleOptions()}
        </div>
      ` : ''}
    </div>
  `;
}

function renderPptStyleOptions() {
  const selectedStyle = pptStyleOption(state.pptStyleId);
  const pluginInstalled = Boolean(state.pptxPluginStatus?.installed);
  return `
    <div class="ppt-style-section">
      <div class="ppt-style-label">风格</div>
      <div class="ppt-style-options">
        ${PPT_STYLE_OPTIONS.map((style) => `
          <button class="ppt-style-option ${style.id === selectedStyle.id ? 'selected' : ''}" type="button" data-ppt-style-option="${escapeAttr(style.id)}" role="menuitem" ${pluginInstalled ? '' : 'disabled'}>
            <span>
              <strong>${escapeHtml(translateUiText(style.label, state.languageMode))}</strong>
              <small>${escapeHtml(translateUiText(pluginInstalled ? style.description : '安装 PPT 制作技能后可用。', state.languageMode))}</small>
            </span>
            ${style.id === selectedStyle.id ? iconSvg('check') : ''}
          </button>
        `).join('')}
      </div>
      ${pluginInstalled ? '' : `<button class="ppt-style-install-link" type="button" data-open-plugin-settings data-plugin-id="ppt_creation">${iconSvg('download')}<span>前往设置安装 PPT 制作技能</span></button>`}
    </div>
  `;
}

function pptTemplatePreviewMarkup(templateId) {
  const template = PPT_TEMPLATE_OPTIONS.find(([value]) => value === templateId) || PPT_TEMPLATE_OPTIONS[0];
  const [, label, , previewUrl] = template;
  const displayLabel = templateId === 'none' ? '不使用模板' : label;
  const swatches = pptTemplatePalette(templateId).map((color) => `<i style="background:${escapeAttr(color)}"></i>`).join('');
  if (previewUrl) {
    return `
      <div class="ppt-template-preview-title">${escapeHtml(displayLabel)}</div>
      <img src="${escapeAttr(previewUrl)}" alt="${escapeAttr(label)}封面预览" />
      <strong>${escapeHtml(displayLabel)}</strong>
      <p>${escapeHtml(pptTemplateDescription(templateId))}</p>
      <div class="ppt-template-swatches">${swatches}</div>
    `;
  }
  const svg = pptTemplatePreviewSvg(templateId, label);
  return `
    <div class="ppt-template-preview-title">${escapeHtml(displayLabel)}</div>
    <img src="${escapeAttr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)}" alt="${escapeAttr(label)}封面预览" />
    <strong>${escapeHtml(displayLabel)}</strong>
    <p>${escapeHtml(pptTemplateDescription(templateId))}</p>
    <div class="ppt-template-swatches">${swatches}</div>
  `;
}

function pptTemplateDescription(templateId) {
  return ({
    none: '使用无学校标识的通用多功能页面库，按每页 layout_id 选取模板页。',
    hitsz: '使用哈尔滨工业大学（深圳）多功能页面库，按每页 layout_id 选取模板页。',
    scut: '使用华南理工大学多功能页面库，按每页 layout_id 选取模板页。',
  })[templateId] || '自定义 PPT 模板。';
}

function pptTemplatePalette(templateId) {
  return ({
    none: ['#f8fafc', '#0f172a', '#0f766e', '#2563eb'],
    hitsz: ['#f6fbfd', '#12364a', '#0b5e7a', '#1c78a6'],
    scut: ['#fff8f7', '#40171c', '#b61918', '#16608a'],
  })[templateId] || ['#f8fafc', '#0f172a', '#2563eb', '#14b8a6'];
}

function pptTemplatePreviewSvg(templateId, label) {
  const palette = templateId === 'hitsz'
    ? { bg: '#f6fbfd', ink: '#12364a', accent: '#0b5e7a', accent2: '#1c78a6', muted: '#4b6372' }
    : templateId === 'scut'
      ? { bg: '#fff8f7', ink: '#40171c', accent: '#b61918', accent2: '#16608a', muted: '#704046' }
      : { bg: '#f8fafc', ink: '#0f172a', accent: '#0f766e', accent2: '#2563eb', muted: '#64748b' };
  const title = templateId === 'none' ? 'Editable PPT' : label;
  const subtitle = templateId === 'none' ? '通用页面库 · 无学校标识' : '学校模板 cover/body chrome';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
    <rect width="480" height="270" fill="${palette.bg}"/>
    <rect x="0" y="0" width="44" height="270" fill="${palette.accent}"/>
    <rect x="44" y="0" width="436" height="7" fill="${palette.accent2}"/>
    <rect x="74" y="58" width="324" height="108" rx="8" fill="#fff" stroke="#dce4ee"/>
    <rect x="74" y="58" width="324" height="8" fill="${palette.accent}"/>
    <text x="96" y="108" fill="${palette.ink}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="28" font-weight="700">${escapeHtml(title)}</text>
    <text x="96" y="140" fill="${palette.muted}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="15">${escapeHtml(subtitle)}</text>
    <circle cx="414" cy="216" r="28" fill="${palette.accent2}" opacity="0.22"/>
    <circle cx="438" cy="235" r="16" fill="${palette.accent}" opacity="0.24"/>
  </svg>`;
}

export function renderModelReasoningPicker(currentModel, currentReasoning) {
  const modelLabel = modelLabelFor(currentModel);
  const modelOptions = textModelOptions(state.modelCatalog);
  const reasoningOptions = reasoningOptionsForModel(state.modelCatalog, currentModel);
  return `
    <div class="model-picker ${state.modelMenuOpen ? 'is-open' : ''} ${modelPickerPlacementClass()}">
      <button class="model-trigger" id="model-picker-trigger" type="button" title="模型与推理强度" aria-haspopup="menu" aria-expanded="${state.modelMenuOpen ? 'true' : 'false'}" data-model-current="${escapeAttr(currentModel)}" data-model-latest="${escapeAttr(modelOptions[0]?.[0] || currentModel)}" data-reasoning-current="${escapeAttr(currentReasoning)}">
        <span class="config-model-label">${escapeHtml(shortModelLabel(currentModel))}</span>
        <span class="config-dot" aria-hidden="true"></span>
        <span class="config-tuning-label">${escapeHtml(reasoningLabelFor(currentReasoning))}</span>
        ${iconSvg('chevronDown')}
      </button>
      ${state.modelMenuOpen ? `
        <div class="model-menu" role="menu">
          <div class="model-menu-section">
            <div class="model-menu-label">推理</div>
            ${reasoningOptions.map(([value, label]) => `
              <button class="model-menu-option ${value === currentReasoning ? 'selected' : ''}" type="button" data-reasoning-option="${escapeAttr(value)}" role="menuitem">
                <span>${escapeHtml(label)}</span>
                ${value === currentReasoning ? iconSvg('check') : ''}
              </button>
            `).join('')}
          </div>
          <div class="model-menu-divider"></div>
          <div class="model-current-row-wrap ${state.modelSubmenuOpen ? 'is-open' : ''}">
            <button class="model-current-row" type="button" data-model-submenu-toggle aria-expanded="${state.modelSubmenuOpen ? 'true' : 'false'}">
              <span>${escapeHtml(modelLabel)}</span>
              ${iconSvg('chevronRight')}
            </button>
            ${state.modelSubmenuOpen ? `
              <div class="model-submenu" role="menu" aria-label="\u6a21\u578b">
                <div class="model-menu-label">\u6a21\u578b</div>
                ${modelOptions.map(([value, label]) => `
                  <button class="model-menu-option ${value === currentModel ? 'selected' : ''}" type="button" data-model-option="${escapeAttr(value)}" role="menuitem">
                    <span>${escapeHtml(label)}</span>
                    ${value === currentModel ? iconSvg('check') : ''}
                  </button>
                `).join('')}
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function modelPickerPlacementClass() {
  const placement = state.modelMenuPlacement || {};
  return [
    placement.menu === 'left' ? 'menu-align-left' : 'menu-align-right',
    placement.vertical === 'above' ? 'menu-above' : 'menu-below',
    placement.submenu === 'left'
      ? 'submenu-left'
      : placement.submenu === 'down'
        ? 'submenu-down'
        : placement.submenu === 'up'
          ? 'submenu-up'
          : 'submenu-right',
  ].join(' ');
}


export function defaultModelMenuPlacement() {
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 0;
  if (viewportWidth <= 560) return { menu: 'left', submenu: 'up', vertical: 'above' };
  return { menu: 'right', submenu: 'left', vertical: 'above' };
}

function renderImageModelPicker() {
  const current = imageModelValue();
  return `
    <div class="model-picker image-model-picker ${state.imageModelMenuOpen ? 'is-open' : ''} menu-align-center menu-above">
      <button class="model-trigger image-model-trigger" id="image-model-trigger" type="button" title="生图模型" aria-haspopup="menu" aria-expanded="${state.imageModelMenuOpen ? 'true' : 'false'}">
        <span class="config-model-label">${escapeHtml(imageModelLabelFor(current))}</span>
        ${iconSvg('chevronDown')}
      </button>
      ${state.imageModelMenuOpen ? `
        <div class="model-menu image-model-menu" role="menu">
          <div class="model-menu-label">模型</div>
          ${IMAGE_MODEL_OPTIONS.map(([value, label]) => `
            <button class="model-menu-option ${value === current ? 'selected' : ''}" type="button" data-image-model-option="${escapeAttr(value)}" role="menuitem">
              <span>${escapeHtml(label)}</span>
              ${value === current ? iconSvg('check') : ''}
            </button>
          `).join('')}
        </div>
      ` : ''}
      <select id="image-model-select" class="image-model-select is-hidden-control" title="生图模型" tabindex="-1" aria-hidden="true">
        ${IMAGE_MODEL_OPTIONS.map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
      </select>
    </div>
  `;
}

function imageModelLabelFor(value) {
  return IMAGE_MODEL_OPTIONS.find(([optionValue]) => optionValue === value)?.[1] || value || IMAGE_MODEL_OPTIONS[0][1];
}

export function imageModelValue() {
  return optionValueOrDefault(IMAGE_MODEL_OPTIONS, state.imageModel, 'gpt-image-2');
}

export function currentModelValue() {
  const options = textModelOptions(state.modelCatalog);
  return optionValueOrDefault(options, state.model, options[0]?.[0] || 'gpt-5.6-sol');
}

export function currentReasoningValue() {
  const model = currentModelValue();
  const options = reasoningOptionsForModel(state.modelCatalog, model);
  const fallback = modelCatalogEntry(state.modelCatalog, model)?.defaultReasoningEffort || options[0]?.[0] || 'medium';
  return optionValueOrDefault(options, state.reasoningEffort, fallback);
}

export function currentPptTemplateValue() {
  return optionValueOrDefault(PPT_TEMPLATE_OPTIONS, state.pptTemplateId, 'none');
}

export function currentPptTemplate() {
  const value = currentPptTemplateValue();
  const option = PPT_TEMPLATE_OPTIONS.find(([optionValue]) => optionValue === value) || PPT_TEMPLATE_OPTIONS[0];
  return {
    id: option[0],
    label: option[1],
    path: option[2],
  };
}

export function showPptTemplatePreview(templateId, event) {
  const popover = document.getElementById('ppt-template-preview-popover');
  if (!popover) return;
  state.pptTemplatePreviewId = templateId;
  popover.querySelectorAll('[data-ppt-template-pane]').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.pptTemplatePane === templateId);
  });
  movePptTemplatePreview(event);
}

export function movePptTemplatePreview(event) {
  positionComposerMetaMenus();
}

export function hidePptTemplatePreview() {
  state.pptTemplatePreviewId = currentPptTemplateValue();
}

export function scheduleComposerMetaMenuPlacement() {
  positionComposerMetaMenus();
}

function positionComposerMetaMenus() {
  const configs = [
    {
      pickerSelector: '.workspace-picker.is-open',
      menuSelector: '.workspace-picker-menu',
      preferredMaxHeight: 360,
      minDownHeight: 160,
      forceUp: true,
    },
    {
      pickerSelector: '.sandbox-permission-picker.is-open',
      menuSelector: '.sandbox-permission-menu',
      preferredMaxHeight: 280,
      minDownHeight: 150,
      forceUp: true,
    },
    {
      pickerSelector: '.composer-memory-picker.is-open',
      menuSelector: '.composer-memory-menu',
      preferredMaxHeight: 440,
      minDownHeight: 180,
      forceUp: true,
    },
    {
      pickerSelector: '.ppt-template-picker.is-open',
      menuSelector: '.ppt-template-menu',
      preferredMaxHeight: 460,
      minDownHeight: 180,
      forceUp: true,
    },
    {
      pickerSelector: '.ppt-style-picker.is-open',
      menuSelector: '.ppt-style-menu',
      preferredMaxHeight: 320,
      minDownHeight: 140,
      forceUp: true,
    },
  ];
  configs.forEach(positionComposerMetaMenu);
}

function positionComposerMetaMenu({ pickerSelector, menuSelector, preferredMaxHeight, minDownHeight, forceDown = false, forceUp = false }) {
  const picker = document.querySelector(pickerSelector);
  const menu = picker?.querySelector(menuSelector);
  if (!picker || !menu) return;

  const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 0;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight || 0;
  const frameRect = picker.closest('.main')?.getBoundingClientRect() || {
    top: 0,
    right: viewportWidth,
    bottom: viewportHeight,
    left: 0,
    width: viewportWidth,
    height: viewportHeight,
  };
  const margin = 12;
  const gap = 8;
  const frameLeft = Math.max(0, frameRect.left) + margin;
  const frameRight = Math.min(viewportWidth, frameRect.right) - margin;
  const frameTop = Math.max(0, frameRect.top) + margin;
  const frameBottom = Math.min(viewportHeight, frameRect.bottom) - margin;
  const usableWidth = Math.max(0, frameRight - frameLeft);

  menu.style.top = `calc(100% + ${gap}px)`;
  menu.style.right = 'auto';
  menu.style.bottom = 'auto';
  menu.style.left = '0px';
  menu.style.maxWidth = `${Math.floor(usableWidth)}px`;
  menu.style.maxHeight = '';

  const pickerRect = picker.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const menuWidth = Math.min(menuRect.width, usableWidth);
  const desiredHeight = Math.min(
    preferredMaxHeight,
    Math.max(menu.scrollHeight || 0, menuRect.height || 0),
  );
  const availableBelow = Math.max(0, frameBottom - pickerRect.bottom - gap);
  const availableAbove = Math.max(0, pickerRect.top - frameTop - gap);
  const openUp = forceUp || (!forceDown
    && availableBelow < Math.min(desiredHeight, minDownHeight)
    && availableAbove > availableBelow);
  const availableHeight = openUp ? availableAbove : availableBelow;
  const left = Math.min(
    Math.max(pickerRect.left, frameLeft),
    Math.max(frameLeft, frameRight - menuWidth),
  );

  menu.style.left = `${Math.round(left - pickerRect.left)}px`;
  menu.style.top = openUp ? 'auto' : `calc(100% + ${gap}px)`;
  menu.style.bottom = openUp ? `calc(100% + ${gap}px)` : 'auto';
  menu.style.maxHeight = `${Math.floor(availableHeight)}px`;
  picker.classList.toggle('menu-above', openUp);
  picker.classList.toggle('menu-below', !openUp);
  if (picker.matches('.workspace-picker')) positionWorkspaceCreateSubmenu(picker, menu);
}

function positionWorkspaceCreateSubmenu(picker, menu) {
  const row = picker.querySelector('.workspace-create-row.is-open');
  const submenu = row?.querySelector('.workspace-create-submenu');
  if (!row || !submenu) return;
  const menuRect = menu.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const submenuRect = submenu.getBoundingClientRect();
  submenu.style.top = `${Math.round(menuRect.bottom - rowRect.top - submenuRect.height)}px`;
  submenu.style.bottom = 'auto';
}

function optionValueOrDefault(options, value, fallback) {
  return options.some(([optionValue]) => optionValue === value) ? value : fallback;
}

function modelLabelFor(value) {
  return textModelOptions(state.modelCatalog).find(([optionValue]) => optionValue === value)?.[1] || value || 'GPT-5.6-Sol';
}

function shortModelLabel(value) {
  return modelLabelFor(value).replace(/^GPT-/, '');
}

function reasoningLabelFor(value) {
  return REASONING_OPTIONS.find(([optionValue]) => optionValue === value)?.[1] || '超高';
}

function activeAgentPickerSession() {
  if (!state.currentSessionId) return null;
  return [state.sessions, state.chatSearchResults, state.archivedSessions]
    .flatMap((items) => Array.isArray(items) ? items : [])
    .find((item) => item?.id === state.currentSessionId) || null;
}

function activeAgentPickerIdentity() {
  const session = activeAgentPickerSession();
  const sessionDepartmentId = String(session?.departmentId || session?.department_id || '').trim();
  const agentInstanceId = String(
    session?.agentInstanceId || session?.agent_instance_id || state.currentAgentInstanceId || '',
  ).trim();
  const employee = agentInstanceId
    ? (state.employeeOverview?.roster || []).find((item) => item.id === agentInstanceId) || null
    : null;
  const agentId = String(
    (state.currentDepartmentId && (!sessionDepartmentId || state.currentDepartmentId === sessionDepartmentId)
      ? state.currentAgentId
      : '')
      || session?.agentId || session?.agent_id || employee?.agentFamilyId || employee?.agent_family_id
      || employee?.family?.id || state.currentAgentId || '',
  ).trim();
  const agent = agentId ? (state.org?.agents || []).find((item) => item.id === agentId) || null : null;
  const departmentId = String(
    (state.currentDepartmentId && (!sessionDepartmentId || state.currentDepartmentId === sessionDepartmentId)
      ? state.currentDepartmentId
      : '')
      || sessionDepartmentId || employee?.departmentId || employee?.department_id
      || employee?.family?.departmentId || employee?.family?.department_id
      || agent?.departmentId || agent?.department_id || state.currentDepartmentId || '',
  ).trim();
  return { agentId, departmentId };
}

function renderAgentInlinePicker() {
  if (state.homeMode === 'collaboration') return '<span class="route-status" title="跨部门多 agent 协同">部门协作</span>';
  if (isImageComposerMode() || isPrivateAssistantComposerMode() || isUBuddyComposerMode()) return '';
  const { agentId, departmentId } = activeAgentPickerIdentity();
  if (!departmentId || !agentId || ['ppt_department', 'image_generation', 'private_assistant', 'secretary_department', 'collaboration'].includes(departmentId)) return '';
  const agents = agentsForDepartment(departmentId);
  const current = agents.find((agent) => agent.id === agentId) || agents[0] || null;
  const selectedAgentId = current?.id || '';
  const currentLabel = current ? shortAgentLabel(current) : agentPickerTitle(departmentId);
  return `
    <div class="agent-inline-picker model-picker menu-align-right menu-above ${state.agentMenuOpen ? 'is-open' : ''}">
      <button class="model-trigger agent-inline-trigger" type="button" data-agent-inline-trigger title="${escapeAttr(agentPickerTitle(departmentId))}" aria-haspopup="menu" aria-expanded="${state.agentMenuOpen ? 'true' : 'false'}">
        <span class="config-model-label">${escapeHtml(currentLabel)}</span>
        ${iconSvg('chevronDown')}
      </button>
      ${state.agentMenuOpen ? `
        <div class="model-menu agent-inline-menu" role="menu">
          <div class="model-menu-label">${escapeHtml(agentPickerTitle(departmentId))}</div>
          ${agents.map((agent) => `
            <button class="model-menu-option ${agent.id === selectedAgentId ? 'selected' : ''}" type="button" data-agent-inline-option="${escapeAttr(agent.id)}" data-agent-inline-department="${escapeAttr(departmentId)}" role="menuitem">
              <span>${escapeHtml(shortAgentLabel(agent))}</span>
              ${agent.id === selectedAgentId ? iconSvg('check') : ''}
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}
