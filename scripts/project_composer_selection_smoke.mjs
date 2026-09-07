import { strict as assert } from 'node:assert';

import { createProjectComposerController } from '../src/renderer/app/features/navigation/projectComposerController.js';

const project = { id: 'project-smoke', title: 'Smoke project', workspaceRoot: '/tmp/project-smoke' };
const updates = [];
const state = {
  busy: false,
  currentSessionId: 'session-current',
  messages: [{ id: 'message-current', role: 'assistant', content: 'keep me' }],
  currentDepartmentId: 'general',
  currentAgentId: 'general_agent',
  selectionSource: 'manual',
  chatDraft: 'keep draft',
  activeProjectId: '',
  workspaceRoot: '',
  workspaceDetached: false,
  expandedProjectIds: [],
};

const controller = createProjectComposerController({
  api: {
    updateSession: async (payload) => {
      updates.push(payload);
      return { id: payload.sessionId, title: 'Current session' };
    },
  },
  state,
  notify: () => {},
  render: () => {},
  normalizePathKey: (value) => String(value || '').toLowerCase(),
  pathBasename: (value) => String(value || '').split('/').pop() || '',
  saveSandboxPermission: () => {},
  focusChatInputAtEnd: () => {},
  currentChatRun: () => null,
  isUBuddyComposerMode: () => false,
  preserveChatDraftFromInput: () => {},
  upsertRecentSession: () => {},
  projectById: (projectId) => projectId === project.id ? project : null,
});

const messages = state.messages;
await controller.selectWorkspaceProject(project.id);
assert.equal(state.currentSessionId, 'session-current');
assert.equal(state.messages, messages);
assert.equal(state.messages[0].content, 'keep me');
assert.equal(state.currentDepartmentId, 'general');
assert.equal(state.currentAgentId, 'general_agent');
assert.equal(state.selectionSource, 'manual');
assert.equal(state.chatDraft, 'keep draft');
assert.equal(state.activeProjectId, project.id);
assert.equal(state.workspaceRoot, project.workspaceRoot);
assert.deepEqual(updates, [{
  sessionId: 'session-current',
  projectId: project.id,
  workspaceRoot: project.workspaceRoot,
}]);

state.currentSessionId = '';
state.messages = [];
state.currentDepartmentId = 'general';
state.currentAgentId = 'general_agent';
state.selectionSource = 'manual';
state.chatDraft = 'new agent draft';
state.activeProjectId = '';
state.workspaceRoot = '';
await controller.selectWorkspaceProject(project.id);
assert.equal(state.currentSessionId, '');
assert.deepEqual(state.messages, []);
assert.equal(state.currentDepartmentId, 'general');
assert.equal(state.currentAgentId, 'general_agent');
assert.equal(state.selectionSource, 'manual');
assert.equal(state.chatDraft, 'new agent draft');
assert.equal(state.activeProjectId, project.id);
assert.equal(updates.length, 1, 'a not-yet-sent chat must not create or switch sessions when selecting a project');

process.stdout.write('Project composer selection smoke passed.\n');
