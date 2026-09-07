import assert from 'node:assert/strict';

import { state } from '../src/renderer/app/state.js';
import { renderMessagePatchSet } from '../src/renderer/app/views/chatView.js';

state.currentUser = { id: 'patch-user', displayName: 'Patch User' };
state.currentSessionId = 'patch-session';
state.currentAgentId = 'general_agent';
state.currentDepartmentId = 'general';
state.currentAgentInstanceId = 'patch-agent';
state.sessions = [{ id: 'patch-session', agentId: 'general_agent', departmentId: 'general', agentInstanceId: 'patch-agent' }];
state.org = { agents: [{ id: 'general_agent', displayName: 'General Agent' }] };
state.employeeOverview = { roster: [] };
state.messagePagination = { sessionId: 'patch-session', hasMore: false, loading: false };
state.messages = Array.from({ length: 80 }, (_, index) => ({
  id: `message-${index}`,
  role: index % 2 ? 'assistant' : 'user',
  content: `Message ${index}`,
  createdAt: new Date(Date.UTC(2026, 7, 17, 0, index)).toISOString(),
  metadata: {},
}));

const patch = renderMessagePatchSet(['message-40']);
assert.equal(patch.order.length, 80);
assert.deepEqual(patch.entries.map((entry) => entry.id), ['message-39', 'message-40', 'message-41']);
assert.equal(patch.entries.every((entry) => entry.markup.includes('data-message-render-key=')), true);
assert.equal(patch.entries.every((entry) => (entry.markup.match(/data-message-id=/g) || []).length === 1), true,
  'incremental message markup must contain one stable DOM identity attribute');
assert.equal(patch.entries.some((entry) => entry.markup.includes('Message 5')), false,
  'incremental patch must not render unrelated history messages');

const beforeKey = /data-message-render-key="([^"]+)"/.exec(patch.entries[1].markup)?.[1];
state.messages[40] = { ...state.messages[40], content: 'Updated streaming content' };
const updated = renderMessagePatchSet(['message-40']);
const afterKey = /data-message-render-key="([^"]+)"/.exec(updated.entries[1].markup)?.[1];
assert.notEqual(afterKey, beforeKey);
assert.match(updated.entries[1].markup, /Updated streaming content/);

state.messages = ['a', 'b', 'c', 'd'].map((id, index) => ({
  id: `continuous-${id}`,
  role: 'assistant',
  content: `Continuous ${id}`,
  agentId: 'general_agent',
  createdAt: new Date(Date.UTC(2026, 7, 17, 1, index)).toISOString(),
  metadata: {},
}));
state.messages.splice(1, 1);
const afterRemoval = renderMessagePatchSet(['continuous-a', 'continuous-b', 'continuous-c']);
assert.deepEqual(afterRemoval.order, ['continuous-a', 'continuous-c', 'continuous-d']);
assert.deepEqual(afterRemoval.entries.map((entry) => entry.id), ['continuous-a', 'continuous-c', 'continuous-d']);
assert.match(afterRemoval.entries[0].markup, /has-consecutive-next/);
assert.match(afterRemoval.entries[1].markup, /is-consecutive-message/);

const moved = state.messages.splice(1, 1)[0];
state.messages.push(moved);
const afterReorder = renderMessagePatchSet(['continuous-a', 'continuous-c', 'continuous-d']);
assert.deepEqual(afterReorder.order, ['continuous-a', 'continuous-d', 'continuous-c']);
assert.deepEqual(afterReorder.entries.map((entry) => entry.id), ['continuous-a', 'continuous-d', 'continuous-c']);
assert.match(afterReorder.entries[1].markup, /is-consecutive-message/);
assert.doesNotMatch(afterReorder.entries[1].markup, /has-consecutive-next/,
  'moving an older message after a newer neighbor must recompute timestamp continuity');
assert.doesNotMatch(afterReorder.entries[2].markup, /is-consecutive-message/);
console.log('Renderer message patch set smoke passed.');
