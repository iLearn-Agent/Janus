import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderMessageList } from '../src/renderer/app/views/chatView.js';
import { findPersistedRewriteMessage } from '../src/renderer/app/utils/messageRewrite.js';

state.currentUser = { id: 'rewrite-user', displayName: 'Rewrite User' };
state.currentSessionId = 'rewrite-session';
state.messages = [
  { id: 'rewrite-user-message', sessionId: 'rewrite-session', role: 'user', content: '原问题', metadata: {}, createdAt: '2026-08-04T10:00:00.000Z' },
  { id: 'rewrite-agent-message', sessionId: 'rewrite-session', role: 'assistant', content: '原回复', metadata: {}, createdAt: '2026-08-04T10:00:01.000Z' },
];
state.messageEditingId = 'rewrite-user-message';
state.messageEditingDraft = '修改后的问题';
state.messageEditingBusy = false;
state.messageEditingError = '';

const markup = renderMessageList();
assert.match(markup, /data-message-rewrite-form="rewrite-user-message"/);
assert.match(markup, />修改后的问题<\/textarea>/);
assert.match(markup, />保存并重新生成<\/button>/);
assert.doesNotMatch(markup, /<div class="message-body">原问题<\/div>/);
assert.match(markup, /原回复/);

state.messageEditingBusy = true;
assert.match(renderMessageList(), /正在重新生成…/);

const failedOptimisticMessage = { id: 'local-failed-turn', role: 'user', content: '失败后仍可修改' };
const persistedFailedMessage = findPersistedRewriteMessage(failedOptimisticMessage, [
  { id: 'persisted-earlier-turn', role: 'user', content: '更早的问题' },
  { id: 'persisted-failed-turn', role: 'user', content: '失败后仍可修改' },
  { id: 'persisted-failure-status', role: 'assistant', content: '执行失败：429 Too Many Requests' },
]);
assert.equal(persistedFailedMessage?.id, 'persisted-failed-turn', 'failed replies must resolve the optimistic user message to its persisted id before rewrite');
assert.equal(findPersistedRewriteMessage(failedOptimisticMessage, [
  { id: 'persisted-different-turn', role: 'user', content: '不同的问题' },
]), null, 'rewrite resolution must not fall back to a different persisted user message');
const rendererAppSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
assert.match(rendererAppSource, /const editingMessage = state\.messages\.find[\s\S]*const message = await persistedMessageForRewrite\(editingMessage\)/,
  'rewrite submission must keep the optimistic and persisted messages in separate bindings');
assert.doesNotMatch(rendererAppSource, /const message = state\.messages\.find[\s\S]{0,800}message = await persistedMessageForRewrite/,
  'rewrite submission must not reassign a const message binding');

process.stdout.write('Message rewrite renderer smoke passed.\n');
