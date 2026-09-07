import { escapeHtml } from './format.js';

export const SOCIAL_TASK_GROUP_TYPE = 'social_task_group';

export function socialTaskGroupId(message = {}) {
  const metadata = message.metadata || {};
  return String(metadata.taskGroupId || metadata.groupId || '').trim();
}

export function isSocialTaskGroupEvent(message = {}) {
  return String(message.metadata?.type || '') === SOCIAL_TASK_GROUP_TYPE;
}

export function latestSocialTaskGroup(messages = []) {
  return socialTaskGroups(messages).at(-1) || null;
}

export function socialTaskGroups(messages = []) {
  const groups = new Map();
  const ordered = [...(messages || [])].sort((left, right) => (
    new Date(left.createdAt || left.created_at || 0).getTime()
    - new Date(right.createdAt || right.created_at || 0).getTime()
  ));
  for (const message of ordered) {
    if (!isSocialTaskGroupEvent(message)) continue;
    const metadata = message.metadata || {};
    const id = socialTaskGroupId(message);
    if (!id) continue;
    const action = String(metadata.action || '').toLowerCase();
    if (action !== 'created') continue;
    groups.set(id, {
      id,
      creatorUserId: String(metadata.initiatorUserId || metadata.creatorUserId || message.senderUserId || message.sender_user_id || '').trim(),
      title: String(metadata.groupTitle || metadata.title || '四方任务群聊').trim(),
      createdAt: message.createdAt || message.created_at || '',
      updatedAt: message.updatedAt || message.updated_at || message.createdAt || message.created_at || '',
      lastMessage: message,
      dissolved: false,
      dissolvedAt: '',
    });
  }
  for (const message of ordered) {
    if (!isSocialTaskGroupEvent(message)) continue;
    const metadata = message.metadata || {};
    const id = socialTaskGroupId(message);
    if (!id || !groups.has(id)) continue;
    const action = String(metadata.action || '').toLowerCase();
    if (action === 'renamed') {
      groups.set(id, {
        ...groups.get(id),
        title: String(metadata.groupTitle || metadata.title || groups.get(id).title || '四方任务群聊').trim(),
        updatedAt: message.updatedAt || message.updated_at || message.createdAt || message.created_at || groups.get(id).updatedAt,
        lastMessage: message,
      });
    } else if (action === 'dissolved') {
      groups.set(id, {
        ...groups.get(id),
        dissolved: true,
        dissolvedAt: message.createdAt || message.created_at || '',
        updatedAt: message.updatedAt || message.updated_at || message.createdAt || message.created_at || groups.get(id).updatedAt,
        lastMessage: message,
      });
    }
  }
  for (const message of ordered) {
    const id = socialTaskGroupId(message);
    if (!id || !groups.has(id)) continue;
    const group = groups.get(id);
    groups.set(id, {
      ...group,
      updatedAt: message.updatedAt || message.updated_at || message.createdAt || message.created_at || group.updatedAt,
      lastMessage: message,
    });
  }
  return [...groups.values()].sort((left, right) => (
    new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime()
  ));
}

export function socialTaskGroupById(messages = [], groupId = '') {
  const cleanId = String(groupId || '').trim();
  if (!cleanId) return null;
  return socialTaskGroups(messages).find((group) => group.id === cleanId) || null;
}

export function messagesForSocialTaskGroup(messages = [], group = null) {
  if (!group?.id) return [...(messages || [])];
  return (messages || []).filter((message) => socialTaskGroupId(message) === group.id);
}

export function createSocialTaskGroupId() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `social_task_group_${random}`;
}

export function socialMentionTokens(friendName = '') {
  const cleanName = String(friendName || '').trim();
  return [
    cleanName ? `@${cleanName}的uBuddy` : '',
    cleanName ? `@${cleanName}` : '',
    '@我的uBuddy',
    '@好友的uBuddy',
    '@对方的uBuddy',
  ].filter(Boolean).sort((left, right) => right.length - left.length);
}

export function renderSocialMentionMarkup(value = '', friendName = '') {
  const source = String(value || '');
  if (!source) return '';
  const tokens = socialMentionTokens(friendName);
  let cursor = 0;
  let markup = '';
  while (cursor < source.length) {
    const token = tokens.find((candidate) => source.startsWith(candidate, cursor));
    if (token) {
      markup += `<mark class="social-mention-token">${escapeHtml(token)}</mark>`;
      cursor += token.length;
      continue;
    }
    markup += escapeHtml(source[cursor]);
    cursor += 1;
  }
  return markup;
}
