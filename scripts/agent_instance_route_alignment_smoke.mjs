import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveOutgoingAgentInstanceId } from '../src/renderer/app/features/chat/messageSendController.js';

const oldSession = {
  id: 'session-general',
  agentId: 'general_agent',
  agentInstanceId: 'instance-general',
};
const roster = [
  { id: 'instance-general', agentFamilyId: 'general_agent', routeEligible: true },
  { id: 'instance-general-b', agentFamilyId: 'general_agent', routeEligible: true },
];

assert.equal(resolveOutgoingAgentInstanceId({
  agentId: 'general_agent',
  currentSession: oldSession,
  roster,
  preferredInstanceId: 'instance-general-b',
}), 'instance-general-b');

assert.equal(resolveOutgoingAgentInstanceId({
  agentId: 'general_agent',
  currentSession: oldSession,
  roster,
  preferredInstanceId: 'instance-general',
}), 'instance-general');

assert.equal(resolveOutgoingAgentInstanceId({
  agentId: 'research_agent',
  currentSession: oldSession,
  roster,
  preferredInstanceId: 'instance-general',
}), '');

assert.equal(resolveOutgoingAgentInstanceId({
  agentId: 'general_agent',
  currentSession: null,
  roster: [
    { id: 'instance-general-inactive', agentFamilyId: 'general_agent', routeEligible: false },
    { id: 'instance-general-active', agentFamilyId: 'general_agent', routeEligible: true },
  ],
}), 'instance-general-active');

const chatViewSource = await readFile(new URL('../src/renderer/app/views/chatView.js', import.meta.url), 'utf8');
const memoryEmployeeResolver = chatViewSource.match(/function activeComposerMemoryEmployee\(\)[\s\S]*?function memoryCapabilityMessage/)?.[0] || '';
assert.match(memoryEmployeeResolver, /state\.currentAgentInstanceId[\s\S]*item\.id === state\.currentAgentInstanceId[\s\S]*return selected/);
assert.doesNotMatch(memoryEmployeeResolver, /item\.agentFamilyId === state\.currentAgentId && item\.routeEligible/);

console.log('agent instance route alignment smoke passed');
