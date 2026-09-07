import assert from 'node:assert/strict';

import { createNetworkWorkspaceController } from '../src/renderer/app/features/network/workspaceController.js';

function sourceState() {
  return {
    workspaceSwitchGeneration: 1,
    currentTab: 'chat',
    currentSessionId: 'task_workspace_session',
    currentChatKey: 'session:task_workspace_session',
    networkDelegationId: 'task_workspace',
    networkConversationBusy: false,
    networkDelegationEditingMessageId: '',
    networkDelegationMemory: null,
    networkDelegationMemoryMenuOpen: false,
    attachments: [],
    activeTaskSourceContext: { source_conversation_id: 'source_session' },
    activeTaskReturnAnchorId: '',
    activeTaskReturnSurface: 'session',
    activeTaskReturnScrollTop: 0,
    activeTaskWorkspaceKind: 'agent_session',
    activeTaskWorkspaceId: 'task_workspace_session',
    taskWorkspaceReturnContext: {
      currentTab: 'chat',
      currentSessionId: 'source_session',
      currentChatKey: 'session:source_session',
      currentAgentInstanceId: '',
      homeMode: 'work',
      networkPanelOpen: false,
      networkPanelView: 'messages',
      networkMessageHomeOpen: false,
      networkConversationPeerId: '',
      networkConversationGroupId: '',
      networkConversationMode: 'person',
      networkConversationMessages: [],
      collaborationGroupId: '',
      collaborationGroupDetail: null,
      messages: [{ id: 'snapshot_message' }],
      contextUsage: {
        sessionId: 'source_session',
        usedTokens: 51_680,
        contextWindowTokens: 258_400,
        usagePercent: 20,
        remainingPercent: 80,
      },
      taskDetail: null,
      chatDraft: '',
      attachments: [],
      composerMentions: [],
      secretaryMentions: [],
      socialMentionMenuOpen: false,
      sourceContext: { source_conversation_id: 'source_session' },
      returnAnchorId: '',
      returnSurface: 'session',
      sourceScrollTop: 0,
    },
  };
}

function controllerFor(state, api) {
  return createNetworkWorkspaceController({
    api,
    state,
    render: () => {},
    notify: () => {},
    userErrorMessage: (error) => error?.message || String(error),
    focusActiveComposerInput: () => {},
    scrollMessagesToBottom: () => {},
    syncCurrentChatRun: () => {},
    restoreActiveRunTransient: () => {},
    documentRef: { querySelector: () => null, querySelectorAll: () => [] },
    setTimer: (callback) => callback(),
  });
}

let resolveMessages;
const delayedMessages = new Promise((resolve) => { resolveMessages = resolve; });
const refreshedState = sourceState();
const returning = controllerFor(refreshedState, {
  listMessages: () => delayedMessages,
  chatContextStatus: async () => ({
    sessionId: 'source_session',
    usedTokens: 21_755,
    contextWindowTokens: 258_400,
    usagePercent: 4,
    remainingPercent: 96,
  }),
}).returnToTaskSourceChat();

assert.equal(refreshedState.contextUsage, null,
  'the stale 20% snapshot must remain hidden while backend status refreshes');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(refreshedState.contextUsage.remainingPercent, 96,
  'context status must refresh without waiting for the slower message list');
resolveMessages([{ id: 'fresh_message' }]);
await returning;
assert.deepEqual(refreshedState.messages, [{ id: 'fresh_message' }]);
assert.equal(refreshedState.contextUsage.remainingPercent, 96,
  'the backend context status must replace the stale workspace snapshot');

const fallbackState = sourceState();
await controllerFor(fallbackState, {
  listMessages: async () => [{ id: 'fresh_message' }],
  chatContextStatus: async () => { throw new Error('status unavailable'); },
}).returnToTaskSourceChat();
assert.equal(fallbackState.contextUsage.usagePercent, 20,
  'the snapshot is only restored when the backend context refresh fails');

console.log('Workspace context refresh smoke passed.');
