import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';

Object.assign(state, {
  currentUser: { id: 'private-user', displayName: 'Private User' },
  languageMode: 'en',
  homeMode: 'private_assistant',
  currentSessionId: '',
  currentChatKey: 'private-new',
  sessions: [],
  messages: [],
  attachments: [],
  chatDraft: '生成一张水墨人物画',
  privateAssistant: {
    exhausted: false,
    weeklyTokensUsed: 20_000,
    weeklyTextTokensUsed: 20_000,
    weeklyImageEquivalentTokensUsed: 10_000,
    weeklyImageCount: 1,
    weeklyTokenLimit: 20_000_000,
    resetAt: '',
  },
  managedProviderUsage: {
    managedProvider: true,
    dailyTokensUsed: 40_000,
    dailyTokensRemaining: 9_960_000,
    dailyTokenLimit: 20_000_000,
    usagePercent: 0.4,
    exhausted: false,
    dailyImagesUsed: 1,
    dailyImagesRemaining: 4,
    dailyImageLimit: 5,
    imageGenerationExhausted: false,
  },
  collaborationGroupId: '',
  collaborationGroupDetail: null,
  networkConversationPeerId: '',
  org: { departments: [], agents: [], hrs: [], leaders: [] },
});

const homeHtml = renderChat();
assert.match(homeHtml, /data-composer-image-mode/);
assert.match(homeHtml, /data-image-entry-source="private_assistant"/);
assert.match(homeHtml, /在当前会话切换到 GPT Image-2；不会把私人助理历史或 Memory 发送给图片服务/);
assert.match(homeHtml, /GPT-5\.x Text<\/span><strong>20K tokens/);
assert.match(homeHtml, /GPT Image-2<\/span><strong>1 \/ 5/);
assert.match(homeHtml, /Week 20K\/20M/);
assert.match(homeHtml, /Weekly Tokens/);
assert.match(homeHtml, /Text counts toward the weekly allowance/);
assert.match(homeHtml, /Images use a separate shared daily limit of 5/);
assert.doesNotMatch(homeHtml, /equivalent tokens|Token equivalent|等价 Token/i);
assert.doesNotMatch(homeHtml, /private-assistant-privacy/);

state.languageMode = 'zh-CN';
const chineseHomeHtml = renderChat();
assert.match(chineseHomeHtml, /文本计入每周额度/);
assert.match(chineseHomeHtml, /图片使用独立的每日 5 张共享额度/);
assert.match(chineseHomeHtml, /GPT Image-2<\/span><strong>1 \/ 5/);
assert.doesNotMatch(chineseHomeHtml, /等价 Token/);
state.languageMode = 'en';

state.currentSessionId = 'private-session';
state.sessions = [{
  id: 'private-session',
  departmentId: 'private_assistant',
  agentId: 'private_assistant',
  userId: 'private-user',
}];
state.messages = [{
  id: 'private-message',
  role: 'assistant',
  content: '私人助理历史消息',
  departmentId: 'private_assistant',
  agentId: 'private_assistant',
  metadata: { privateAssistant: true, localOnly: true },
}];
state.privateAssistantPermission = 'request-approval';
state.sandboxMenuOpen = true;
const conversationHtml = renderChat();
assert.match(conversationHtml, /data-composer-image-mode/);
assert.match(conversationHtml, /data-image-entry-source="private_assistant"/);
assert.match(conversationHtml, /data-private-assistant-reset-context/);
assert.match(conversationHtml, /清空上下文/);
assert.match(conversationHtml, /data-private-assistant-permission="request-approval"/);
assert.match(conversationHtml, /隔离空间内执行/);

const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
assert.match(rendererSource, /const enabling = !isImageComposerMode\(\)/);
assert.match(rendererSource, /state\.composerImageMode = enabling/);
assert.doesNotMatch(rendererSource, /data-composer-image-mode[\s\S]{0,800}state\.currentSessionId = ''/);
assert.match(rendererSource, /已在当前会话切换到 GPT Image-2/);
assert.match(rendererSource, /data-private-assistant-reset-context/);
assert.match(rendererSource, /resetPrivateAssistantContextWithRefresh/);
assert.match(rendererSource, /后续回答不会再读取清空前的内容/);
const sendControllerSource = readFileSync(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
assert.match(sendControllerSource, /activePrivateAssistantChat \? state\.privateAssistantPermission : state\.sandboxPermission/);

console.log('private assistant image entry smoke passed');
