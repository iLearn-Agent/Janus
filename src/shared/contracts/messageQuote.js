export const MESSAGE_QUOTE_VERSION = 'message_quote_v1';

const ALLOWED_CONVERSATION_KINDS = new Set([
  'agent',
  'social_direct',
  'social_group',
  'collaboration_group',
]);

function cleanText(value = '', limit = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function normalizeMessageQuote(value = null) {
  if (!value || typeof value !== 'object') return null;
  const sourceMessageId = cleanText(value.sourceMessageId || value.source_message_id, 240);
  const excerpt = cleanText(value.excerpt, 1200);
  if (!sourceMessageId || !excerpt) return null;
  return {
    version: MESSAGE_QUOTE_VERSION,
    sourceMessageId,
    sourceConversationId: cleanText(value.sourceConversationId || value.source_conversation_id, 300),
    conversationKind: ALLOWED_CONVERSATION_KINDS.has(value.conversationKind) ? value.conversationKind : 'agent',
    authorLabel: cleanText(value.authorLabel, 120) || '消息',
    role: ['user', 'assistant', 'system', 'friend', 'agent'].includes(value.role) ? value.role : 'friend',
    excerpt,
    createdAt: cleanText(value.createdAt, 80),
  };
}

export function messageQuotePromptText(value = null, userMessage = '') {
  const quote = normalizeMessageQuote(value);
  const current = String(userMessage || '').trim();
  if (!quote) return current;
  return [
    `以下是用户明确引用的一条历史消息（作者：${quote.authorLabel}）：`,
    '--- 引用开始 ---',
    quote.excerpt,
    '--- 引用结束 ---',
    '',
    '用户当前消息：',
    current,
  ].join('\n');
}
