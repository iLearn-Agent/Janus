import assert from 'node:assert/strict';

import {
  ensureDelegationWorkspaceSession,
  mergeDelegationWorkspaceMessages,
  privateDelegationWorkspaceMessages,
  syncDelegationWorkspaceMessages,
} from '../src/main/modules/collaboration/application/delegationWorkspaceMessages.js';

const sessions = new Map([
  ['mixed_session', { id: 'mixed_session', userId: 'bob', departmentId: 'collaboration', workspaceRoot: '/tmp/old' }],
]);
const messages = new Map([
  ['mixed_session', [
    { id: 'foreign_user', role: 'user', content: '其他聊天问题', metadata: {} },
    { id: 'foreign_answer', role: 'assistant', content: '其他聊天回答', metadata: {} },
    { id: 'legacy_valid', role: 'assistant', content: '合法任务初稿', metadata: { delegationId: 'task_1', privateTaskWorkspace: true } },
    { id: 'other_task', role: 'assistant', content: '另一个任务', metadata: { delegationId: 'task_2', privateTaskWorkspace: true } },
  ]],
]);
const workspaces = new Map([
  ['task_1:bob', { delegationId: 'task_1', userId: 'bob', sessionId: 'mixed_session', metadata: {} }],
]);
let sessionSequence = 0;
const store = {
  db: {
    prepare() {
      return {
        get(sessionId, delegationId, userId) {
          return [...workspaces.values()].find((workspace) => (
            workspace.sessionId === sessionId
            && !(workspace.delegationId === delegationId && workspace.userId === userId)
          )) || undefined;
        },
      };
    },
  },
  getSession(id) { return sessions.get(id) || null; },
  createSession(input) {
    const session = { id: `canonical_${++sessionSequence}`, ...input };
    sessions.set(session.id, session);
    messages.set(session.id, []);
    return session;
  },
  updateSession(id, patch) {
    const session = { ...(sessions.get(id) || {}), ...patch };
    sessions.set(id, session);
    return session;
  },
  listMessages(sessionId) { return messages.get(sessionId) || []; },
};
const auth = {
  delegationWorkspace(delegationId, userId) { return workspaces.get(`${delegationId}:${userId}`) || null; },
  upsertDelegationWorkspace({ delegationId, userId, sessionId, metadata }) {
    const workspace = { delegationId, userId, sessionId, metadata };
    workspaces.set(`${delegationId}:${userId}`, workspace);
    return workspace;
  },
};
const delegation = {
  id: 'task_1',
  title: '隔离修复任务',
  sessionId: 'mixed_session',
  metadata: {},
};
const repaired = ensureDelegationWorkspaceSession({
  auth,
  store,
  delegation,
  user: { id: 'bob' },
  workspaceRoot: '/tmp/task_1',
  newId: () => 'epoch_task_1',
});
assert.equal(repaired.repaired, true);
assert.equal(repaired.session.departmentId, 'agent_delegation');
assert.equal(repaired.session.userId, 'bob');
assert.equal(repaired.workspaceEpoch, 'epoch_task_1');
assert.equal(repaired.previousWorkspaceSessionId, 'mixed_session');

const repairedDelegation = {
  ...delegation,
  sessionId: repaired.session.id,
  metadata: repaired.metadata,
};
const reopened = ensureDelegationWorkspaceSession({
  auth,
  store,
  delegation: repairedDelegation,
  user: { id: 'bob' },
  workspaceRoot: '/tmp/task_1',
  newId: () => 'unexpected_new_epoch',
});
assert.equal(reopened.repaired, false);
assert.equal(reopened.session.id, repaired.session.id);
assert.equal(reopened.workspaceEpoch, 'epoch_task_1');
messages.get(repaired.session.id).push(
  { id: 'current_valid', role: 'user', content: '继续完善', metadata: { delegationId: 'task_1', privateTaskWorkspace: true, workspaceEpoch: 'epoch_task_1' } },
  { id: 'current_wrong_epoch', role: 'assistant', content: '旧 epoch 内容', metadata: { delegationId: 'task_1', privateTaskWorkspace: true, workspaceEpoch: 'epoch_old' } },
);
const local = privateDelegationWorkspaceMessages(store, repairedDelegation);
assert.deepEqual(local.map((message) => message.id), ['legacy_valid', 'current_valid']);

const merged = mergeDelegationWorkspaceMessages(local, [
  { id: 'remote_contaminated', delegationId: 'task_1', role: 'assistant', content: '云端污染内容', metadata: { privateTaskWorkspace: true } },
  { id: 'remote_legacy_valid', delegationId: 'task_1', role: 'assistant', content: '云端合法旧结果', metadata: { delegationId: 'task_1', privateTaskWorkspace: true } },
  { id: 'remote_current', delegationId: 'task_1', role: 'assistant', content: '云端当前结果', metadata: { delegationId: 'task_1', privateTaskWorkspace: true, workspaceEpoch: 'epoch_task_1' } },
  { id: 'remote_ingress', delegationId: 'task_1', role: 'system', content: '任务群新要求', sourceEventId: 'event_1', metadata: { privateTaskWorkspace: true, type: 'requirements_update', sourceEventId: 'event_1' } },
], 'task_1', 'epoch_task_1');
assert.equal(merged.some((message) => message.id === 'remote_contaminated'), false);
assert.equal(merged.some((message) => message.id === 'remote_legacy_valid'), true);
assert.equal(merged.some((message) => message.id === 'remote_current'), true);
assert.equal(merged.some((message) => message.id === 'remote_ingress'), true);

const uploaded = [];
await syncDelegationWorkspaceMessages({
  async sendDelegationWorkspaceMessage(delegationId, payload) { uploaded.push({ delegationId, payload }); },
}, 'task_1', repaired.session.id, [
  messages.get(repaired.session.id)[0],
  messages.get(repaired.session.id)[1],
  messages.get('mixed_session')[0],
], 'epoch_task_1');
assert.deepEqual(uploaded.map((item) => item.payload.clientMessageId), ['current_valid']);

const workspaceControllerSource = await import('node:fs').then(({ readFileSync }) => readFileSync(new URL('../src/renderer/app/features/network/workspaceController.js', import.meta.url), 'utf8'));
assert.doesNotMatch(workspaceControllerSource, /metadata:\s*\{\s*\.\.\.\(message\.metadata\s*\|\|\s*\{\}\),\s*delegationId,\s*privateTaskWorkspace:\s*true/);

console.log('uBuddy workspace session isolation smoke passed.');
