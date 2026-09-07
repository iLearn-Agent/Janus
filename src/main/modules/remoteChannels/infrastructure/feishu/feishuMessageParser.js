function parseJson(value) {
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function mentionName(mention = {}) {
  return String(mention.name || mention.user_name || 'user').trim() || 'user';
}

function resolveMentions(text, mentions = []) {
  let result = String(text || '');
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const key = String(mention?.key || '');
    if (key) result = result.replaceAll(key, `@${mentionName(mention)}`);
  }
  return result.trim();
}

function parseJanusUserMention(text, nativeMentions = []) {
  const source = String(text || '').trim();
  const match = source.match(/^@([a-z0-9_]{1,32})(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const displayText = `@${match[1]}`;
  const nativeKeys = new Set((Array.isArray(nativeMentions) ? nativeMentions : [])
    .map((mention) => String(mention?.key || '').trim())
    .filter(Boolean));
  if (nativeKeys.has(displayText)) return null;
  return {
    username: match[1].toLowerCase(),
    displayText,
    instruction: String(match[2] || '').trim(),
  };
}

export function extractFeishuPostText(content = {}) {
  const root = content?.post && typeof content.post === 'object' ? content.post : content;
  if (!root || typeof root !== 'object') return '';
  const blocks = [];
  if (Array.isArray(root.content)) blocks.push(root);
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    if (root[locale] && typeof root[locale] === 'object') blocks.push(root[locale]);
  }
  for (const block of blocks) {
    const parts = [];
    for (const row of Array.isArray(block.content) ? block.content : []) {
      for (const element of Array.isArray(row) ? row : []) {
        if (!element || typeof element !== 'object') continue;
        if (element.tag === 'text' || element.tag === 'a') parts.push(String(element.text || ''));
        else if (element.tag === 'at') parts.push(`@${mentionName(element)}`);
      }
    }
    const text = parts.map((part) => part.trim()).filter(Boolean).join(' ').trim();
    if (text) return text;
  }
  return '';
}

export function parseFeishuMessageEvent(data = {}) {
  const event = data.event || data;
  const sender = event.sender || {};
  const message = event.message || {};
  if (String(sender.sender_type || '').toLowerCase() === 'bot') return { accepted: false, reason: 'bot_sender' };
  if (String(message.chat_type || '').toLowerCase() !== 'p2p') return { accepted: false, reason: 'not_p2p' };
  const messageId = String(message.message_id || '').trim();
  const senderId = String(sender.sender_id?.open_id || '').trim();
  const chatId = String(message.chat_id || senderId).trim();
  if (!messageId || !senderId || !chatId) return { accepted: false, reason: 'missing_identity' };
  const content = parseJson(message.content);
  const messageType = String(message.message_type || '').toLowerCase();
  const janusMention = messageType === 'text' ? parseJanusUserMention(content.text, message.mentions) : null;
  const text = messageType === 'text'
    ? resolveMentions(content.text, message.mentions)
    : messageType === 'post' ? extractFeishuPostText(content) : '';
  if (!['text', 'post'].includes(messageType)) return { accepted: false, reason: 'unsupported_type' };
  if (!text) return { accepted: false, reason: 'empty_content' };
  return {
    accepted: true,
    provider: 'feishu',
    messageId,
    senderId,
    chatId,
    tenantKey: String(sender.tenant_key || event.tenant_key || '').trim(),
    messageType,
    text,
    janusMention,
  };
}

export const feishuMessageParserInternals = { parseJanusUserMention };
