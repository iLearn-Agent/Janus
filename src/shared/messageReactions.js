import { COMPOSER_DEFAULT_EMOJIS } from './composerEmojis.js';

export const MESSAGE_REACTION_EMOJIS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🎉']);
export const MESSAGE_REACTION_ALL_EMOJIS = Object.freeze([...new Set([...MESSAGE_REACTION_EMOJIS, ...COMPOSER_DEFAULT_EMOJIS])]);

const EMOJI_SET = new Set(MESSAGE_REACTION_ALL_EMOJIS);

export function normalizeMessageReactionEmoji(value = '') {
  const emoji = String(value || '').trim();
  if (!EMOJI_SET.has(emoji)) {
    const error = new Error('不支持的表情回应。');
    error.code = 'message_reaction_emoji_unsupported';
    throw error;
  }
  return emoji;
}

export function normalizeMessageReactions(value = []) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([emoji, items]) => (Array.isArray(items) ? items : []).map((item) => ({ ...item, emoji })))
      : [];
  const seen = new Set();
  const reactions = [];
  for (const item of source) {
    const emoji = String(item?.emoji || '').trim();
    const userId = String(item?.userId || item?.user_id || '').trim();
    if (!EMOJI_SET.has(emoji) || !userId) continue;
    const key = `${emoji}
${userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reactions.push({
      emoji,
      userId,
      displayName: String(item?.displayName || item?.display_name || '').trim().slice(0, 80),
      reactedAt: String(item?.reactedAt || item?.reacted_at || '').trim(),
    });
  }
  return reactions;
}

export function normalizeMessageReactionMetadata(metadata = {}) {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
  const reactions = normalizeMessageReactions(base.reactions);
  if (reactions.length) base.reactions = reactions;
  else delete base.reactions;
  return base;
}

export function toggleMessageReaction(metadata = {}, { emoji = '', userId = '', displayName = '', reactedAt = '' } = {}) {
  const cleanEmoji = normalizeMessageReactionEmoji(emoji);
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) throw new Error('缺少表情回应用户。');
  const base = normalizeMessageReactionMetadata(metadata);
  const reactions = normalizeMessageReactions(base.reactions);
  const index = reactions.findIndex((item) => item.emoji === cleanEmoji && item.userId === cleanUserId);
  if (index >= 0) {
    reactions.splice(index, 1);
  } else {
    reactions.push({
      emoji: cleanEmoji,
      userId: cleanUserId,
      displayName: String(displayName || cleanUserId).trim().slice(0, 80),
      reactedAt: String(reactedAt || new Date().toISOString()),
    });
  }
  if (reactions.length) base.reactions = reactions;
  else delete base.reactions;
  return base;
}

export function messageReactionGroups(metadataOrReactions = {}, currentUserId = '') {
  const reactions = normalizeMessageReactions(Array.isArray(metadataOrReactions) ? metadataOrReactions : metadataOrReactions?.reactions);
  const currentId = String(currentUserId || '').trim();
  const groups = [];
  for (const emoji of MESSAGE_REACTION_ALL_EMOJIS) {
    const users = reactions.filter((item) => item.emoji === emoji);
    if (!users.length) continue;
    groups.push({ emoji, count: users.length, mine: Boolean(currentId && users.some((item) => item.userId === currentId)), users });
  }
  return groups;
}
