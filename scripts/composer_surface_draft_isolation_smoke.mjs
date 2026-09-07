import assert from 'node:assert/strict';
import {
  composerSurfaceKey,
  createComposerDraftController,
  migrateComposerDrafts,
} from '../src/renderer/app/features/chat/composerDraftController.js';

const migrated = migrateComposerDrafts({
  agentConversationDrafts: { 'generalist-a': 'GENERALIST_LEGACY' },
  networkConversationDrafts: {
    'friend-a:person': 'DIRECT_LEGACY',
    'friend-a:group:task-a': 'SOCIAL_GROUP_LEGACY',
    'chat-group:group-a': 'CHAT_GROUP_LEGACY',
    'collaboration:work-a': 'WORK_GROUP_LEGACY',
  },
});
assert.equal(migrated['agent:generalist-a'].text, 'GENERALIST_LEGACY');
assert.equal(migrated['social-direct:friend-a'].text, 'DIRECT_LEGACY');
assert.equal(migrated['social-group:friend-a:task-a'].text, 'SOCIAL_GROUP_LEGACY');
assert.equal(migrated['chat-group:group-a'].text, 'CHAT_GROUP_LEGACY');
assert.equal(migrated['collaboration:work-a'].text, 'WORK_GROUP_LEGACY');

const state = {
  sessions: [], projects: [{ id: 'project-a' }], tasks: [{ id: 'task-a' }],
  currentAgentInstanceId: 'generalist-a', currentSessionId: 'agent-session', currentChatKey: 'agent:generalist-a',
  homeMode: 'department', chatDraft: '', attachments: [], composerMentions: [], secretaryMentions: [],
  composerFileReferences: [], composerMemoryReferences: [], messageQuote: null, composerTaskReference: null,
  uBuddyParticipantSelectionPolicy: 'all_mentioned', composerDraftsBySurface: {},
};
let inputValue = '';
let persisted = null;
const controller = createComposerDraftController({
  state,
  readInputValue: () => inputValue,
  persist: () => { persisted = structuredClone(state.composerDraftsBySurface); },
});
controller.hydrate({ agentConversationDrafts: { 'generalist-a': 'GENERALIST_LEGACY' } });
assert.equal(composerSurfaceKey(state), 'agent:generalist-a');
controller.restore('agent:generalist-a');
assert.equal(state.chatDraft, 'GENERALIST_LEGACY');

inputValue = 'GENERALIST_DRAFT';
state.attachments = [{ id: 'agent-file', file: { name: 'agent.txt' } }];
state.composerFileReferences = [{ referenceId: 'file-ref', projectId: 'project-a', relativePath: 'brief.md' }];
state.composerMemoryReferences = [{ referenceId: 'memory-ref', sourceMemoryId: 'memory-a' }];
controller.capture();

state.homeMode = 'secretary';
state.currentAgentInstanceId = '';
state.currentSessionId = 'ubuddy-session';
state.sessions = [{ id: 'ubuddy-session', departmentId: 'secretary_department', agentInstanceId: 'secretary-instance' }];
assert.equal(composerSurfaceKey(state), 'ubuddy', 'uBuddy must take precedence over the secretary Agent instance');
controller.restore('ubuddy');
assert.equal(state.chatDraft, '');
assert.deepEqual(state.attachments, []);
inputValue = 'UBUDDY_DRAFT';
state.secretaryMentions = [{ principalType: 'user', userId: 'friend-a', displayText: '@Friend' }];
state.composerMentions = [...state.secretaryMentions];
state.composerTaskReference = { taskRunId: 'task-a', displayText: '@任务：A' };
state.uBuddyParticipantSelectionPolicy = 'auto_select';
controller.capture();

state.homeMode = 'department';
state.currentSessionId = '';
state.networkConversationPeerId = 'friend-a';
state.networkConversationMode = 'person';
state.sessions = [];
assert.equal(composerSurfaceKey(state), 'social-direct:friend-a');
controller.restore('social-direct:friend-a');
assert.equal(state.chatDraft, '');
inputValue = 'DIRECT_DRAFT';
controller.capture();

state.networkConversationPeerId = '';
state.chatGroupId = 'group-a';
assert.equal(composerSurfaceKey(state), 'chat-group:group-a');
controller.restore('chat-group:group-a');
inputValue = 'GROUP_DRAFT';
controller.capture();

state.chatGroupId = '';
state.currentAgentInstanceId = 'generalist-a';
controller.restore('agent:generalist-a');
assert.equal(state.chatDraft, 'GENERALIST_DRAFT');
assert.equal(state.attachments[0]?.id, 'agent-file', 'runtime attachments must follow only their source surface');
assert.equal(state.composerFileReferences[0]?.relativePath, 'brief.md');
assert.equal(state.composerMemoryReferences[0]?.sourceMemoryId, 'memory-a');

state.homeMode = 'secretary';
state.currentAgentInstanceId = '';
state.currentSessionId = 'ubuddy-session';
state.sessions = [{ id: 'ubuddy-session', departmentId: 'secretary_department' }];
controller.restore('ubuddy');
assert.equal(state.chatDraft, 'UBUDDY_DRAFT');
assert.equal(state.composerTaskReference?.taskRunId, 'task-a');
assert.equal(state.uBuddyParticipantSelectionPolicy, 'auto_select');

controller.clear('ubuddy');
assert.equal(persisted.ubuddy, undefined);
controller.restore('ubuddy');
assert.equal(state.chatDraft, '');

const restartedState = {
  ...state, homeMode: 'department', currentSessionId: '', currentAgentInstanceId: 'generalist-a', sessions: [],
  attachments: [], composerDraftsBySurface: {},
};
const restarted = createComposerDraftController({ state: restartedState, readInputValue: () => null });
restarted.hydrate({ composerDraftsBySurface: persisted });
restarted.restore('agent:generalist-a');
assert.equal(restartedState.chatDraft, 'GENERALIST_DRAFT');
assert.deepEqual(restartedState.attachments, [], 'browser File attachments must not survive an application restart');
assert.equal(restartedState.composerFileReferences[0]?.relativePath, 'brief.md');

restartedState.projects = [{ id: 'another-project' }];
restarted.restore('agent:generalist-a');
assert.deepEqual(restartedState.composerFileReferences, [], 'stale project references must be discarded');

console.log('composer surface draft isolation smoke passed');
