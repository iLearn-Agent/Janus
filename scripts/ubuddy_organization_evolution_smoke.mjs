import assert from 'node:assert/strict';

import {
  applyUBuddyOrganizationPolicy,
  isUBuddyOrganizationEvolutionEligible,
} from '../src/main/modules/orchestration/application/uBuddyOrganizationPolicy.js';
import { validateUBuddyTurnDecision } from '../src/main/modules/orchestration/application/uBuddyTurnDecisionPlanner.js';
import { UBUDDY_ORG_PLAYBOOK_VERSION } from '../src/shared/contracts/uBuddyOrganizationEvolution.js';
import { UBuddyOrganizationEvolutionService } from '../src/main/modules/orchestration/application/uBuddyOrganizationEvolutionService.js';
import { renderEvolution } from '../src/renderer/app/views/evolutionView.js';
import { state } from '../src/renderer/app/state.js';
import {
  createUBuddyFeatureFlagService,
  normalizeUBuddyFeatureFlagConfig,
} from '../src/main/modules/collaboration/infrastructure/ubuddyFeatureFlags.js';

const defaultFlags = createUBuddyFeatureFlagService({ store: { settingGet: () => '{}' }, env: {} }).snapshot();
assert.equal(Object.hasOwn(defaultFlags, 'organizationEvolutionApplyV1'), false, 'default-off snapshot must not change existing metadata');
assert.equal(Object.hasOwn(normalizeUBuddyFeatureFlagConfig({}), 'ubuddy.organization_evolution_apply_v1'), false);
const enabledFlags = createUBuddyFeatureFlagService({
  store: { settingGet: () => '{}' }, env: { JANUS_UBUDDY_ORGANIZATION_EVOLUTION_APPLY_V1: 'on' },
}).snapshot();
assert.equal(enabledFlags.organizationEvolutionApplyV1, true);

const candidates = [
  { agentId: 'general_agent', agentInstanceId: 'general_1', departmentId: 'general', queueDepth: 3 },
  { agentId: 'general_agent', agentInstanceId: 'general_2', departmentId: 'general', queueDepth: 0 },
  { agentId: 'ppt', agentInstanceId: 'ppt_1', departmentId: 'ppt_department', queueDepth: 0 },
];
const baseline = validateUBuddyTurnDecision({
  version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.92,
  nodes: [
    { localId: 'research', title: 'Research', objective: 'Research the topic', agentId: 'general_agent', agentInstanceId: 'general_1', dependencies: [], outputFormat: 'notes', isFinal: false },
    { localId: 'final', title: 'Final', objective: 'Build slides', agentId: 'ppt', agentInstanceId: 'ppt_1', dependencies: ['research'], outputFormat: 'pptx', isFinal: true },
  ],
  deliverables: [{ id: 'deck', role: 'primary', type: 'presentation', title: 'Deck', ownerLocalId: 'final', deliveryMode: 'file', requiredExtensions: ['.pptx'] }],
  agentSelectionRationale: 'Use research and presentation specialists.',
  mentionedAgentsNotSelected: [],
}, { candidates });

const eligible = {
  decision: 'task_plan', dispatchAuthorized: true, readinessApproved: true, isNewTask: true,
  privacyScope: 'owner_private', taskType: 'presentation', objective: 'Build a product deck',
};
assert.equal(isUBuddyOrganizationEvolutionEligible(eligible), true);
for (const excluded of [
  { parentTaskRunId: 'parent' }, { continuation: true }, { revision: true },
  { collaborationGroupId: 'group' }, { externalDelegationId: 'delegation' }, { organizationResearch: true },
]) assert.equal(isUBuddyOrganizationEvolutionEligible({ ...eligible, ...excluded }), false);

const policy = {
  policyHash: 'hash',
  playbook: {
    version: UBUDDY_ORG_PLAYBOOK_VERSION,
    policyVersionId: 'policy_1',
    stage: 'assignment',
    taskScopes: [{ id: 'presentations', taskTypes: ['presentation'], objectiveIncludes: [], minimumConfidence: 0.7 }],
    assignmentRules: [{
      id: 'prefer_general_2', taskTypes: ['presentation'], objectiveIncludes: [], nodeTitleIncludes: ['research'],
      fromAgentId: 'general_agent', fromAgentInstanceId: 'general_1',
      toAgentId: 'general_agent', toAgentInstanceId: 'general_2', minimumConfidence: 0.8,
      evidenceCount: 3, rationale: 'Repeated matching failures.',
    }],
    decompositionRules: [], hardConstraints: { preserveMentionedAgents: true },
    provenance: { evidenceTraceIds: ['trace_1', 'trace_2', 'trace_3'], evidenceCount: 3 },
  },
};

const featureOff = applyUBuddyOrganizationPolicy({
  baselineDecision: baseline, eligibilityContext: eligible, candidates, activePolicySnapshot: policy,
  assignmentEnabled: false,
});
assert.strictEqual(featureOff.effectiveDecision, baseline, 'feature-off must return the exact baseline object');
assert.equal(featureOff.applicationRecord.applied, false);

const applied = applyUBuddyOrganizationPolicy({
  baselineDecision: baseline, eligibilityContext: eligible, candidates, activePolicySnapshot: policy,
  assignmentEnabled: true,
  validateDecision: (proposal) => validateUBuddyTurnDecision(proposal, { candidates }),
});
assert.equal(applied.applicationRecord.applied, true);
assert.equal(applied.effectiveDecision.nodes.find((node) => node.localId === 'research').agentInstanceId, 'general_2');
assert.deepEqual(applied.effectiveDecision.nodes.map((node) => node.dependencies), baseline.nodes.map((node) => node.dependencies));
assert.deepEqual(applied.effectiveDecision.deliverablePlan, baseline.deliverablePlan);
assert.equal(applied.effectiveDecision.finalNodeId, baseline.finalNodeId);

const mentioned = applyUBuddyOrganizationPolicy({
  baselineDecision: baseline, eligibilityContext: eligible, candidates, activePolicySnapshot: {
    ...policy,
    playbook: { ...policy.playbook, assignmentRules: [{ ...policy.playbook.assignmentRules[0], toAgentId: 'ppt', toAgentInstanceId: 'ppt_1' }] },
  },
  mentionedAgentIds: ['general_agent'], assignmentEnabled: true,
  validateDecision: (proposal) => validateUBuddyTurnDecision(proposal, { candidates, mentionedAgentIds: ['general_agent'] }),
});
assert.strictEqual(mentioned.effectiveDecision, baseline, 'explicitly mentioned Agent must be preserved');

const invalidPolicy = applyUBuddyOrganizationPolicy({
  baselineDecision: baseline, eligibilityContext: eligible, candidates,
  activePolicySnapshot: { playbook: { version: 'arbitrary-code', policyVersionId: 'bad' } },
  assignmentEnabled: true,
});
assert.strictEqual(invalidPolicy.effectiveDecision, baseline);
assert.equal(invalidPolicy.applicationRecord.reason, 'policy_rejected');

const rejectedByGovernor = applyUBuddyOrganizationPolicy({
  baselineDecision: baseline, eligibilityContext: eligible, candidates, activePolicySnapshot: policy,
  assignmentEnabled: true,
  validateDecision: () => { throw new Error('governor rejected'); },
});
assert.strictEqual(rejectedByGovernor.effectiveDecision, baseline);
assert.equal(rejectedByGovernor.applicationRecord.reason, 'policy_rejected');

const failingSidecar = new UBuddyOrganizationEvolutionService({
  socialRelay: {
    connected: () => true,
    uploadUBuddyOrganizationEvolutionTrace: async () => { throw new Error('cloud unavailable'); },
  },
  featureFlags: { snapshot: () => ({ organizationEvolutionCollectV1: true }) },
});
assert.equal(failingSidecar.recordDispatch({
  userId: 'owner', traceId: 'sidecar_trace', taskType: 'presentation',
  task: { id: 'task_1', metadata: {} }, decision: baseline, candidates,
}), true);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(failingSidecar.pendingUploads.size, 0, 'sidecar rejection must be contained asynchronously');

let concurrentUploads = 0;
let maximumConcurrentUploads = 0;
let uploadCalls = 0;
const uploadReleases = [];
const uploadKinds = [];
const deferredUpload = (kind) => {
  uploadCalls += 1;
  uploadKinds.push(kind);
  concurrentUploads += 1;
  maximumConcurrentUploads = Math.max(maximumConcurrentUploads, concurrentUploads);
  return new Promise((resolve) => uploadReleases.push(() => {
    concurrentUploads -= 1;
    resolve({ ok: true });
  }));
};
const boundedSidecar = new UBuddyOrganizationEvolutionService({
  socialRelay: {
    connected: () => true,
    uploadUBuddyOrganizationEvolutionTrace: () => deferredUpload('trace'),
    uBuddyOrganizationEvolutionHealth: () => deferredUpload('health'),
  },
  featureFlags: { snapshot: () => ({ organizationEvolutionCollectV1: true }) },
  maxConcurrentUploads: 2,
  maxQueuedUploads: 8,
});
const acceptedUploads = [];
for (let index = 0; index < 20; index += 1) {
  acceptedUploads.push(boundedSidecar.recordDispatch({
    userId: 'owner', traceId: `bounded_trace_${index}`, taskType: 'presentation',
    task: { id: `bounded_task_${index}`, metadata: {} }, decision: baseline, candidates,
  }));
}
assert.equal(uploadCalls, 0, 'recording a trace must not start network work in the synchronous task stack');
assert.equal(acceptedUploads.filter(Boolean).length, 8, 'the background queue must be bounded');
assert.equal(boundedSidecar.recordHealth({
  userId: 'owner', policyVersionId: 'policy_1', traceId: 'critical_trace',
  eventKind: 'contract_rejected', idempotencyKey: 'critical_trace:contract', payload: {},
}), true, 'a critical health event must replace a lower-priority queued trace');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(uploadCalls, 2);
assert.equal(boundedSidecar.uploadQueue.length, 6);
assert.equal(uploadKinds[0], 'health', 'critical health events must run before ordinary traces');
for (let turn = 0; turn < 10 && (boundedSidecar.uploadQueue.length || boundedSidecar.pendingUploads.size); turn += 1) {
  uploadReleases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
}
assert.equal(uploadCalls, 8);
assert.equal(maximumConcurrentUploads, 2);
assert.equal(boundedSidecar.uploadQueue.length, 0);
assert.equal(boundedSidecar.pendingUploads.size, 0);

let duplicateTraceCalls = 0;
const duplicateSidecar = new UBuddyOrganizationEvolutionService({
  socialRelay: {
    connected: () => true,
    uploadUBuddyOrganizationEvolutionTrace: async () => { duplicateTraceCalls += 1; return { ok: true }; },
  },
  featureFlags: { snapshot: () => ({ organizationEvolutionCollectV1: true }) },
});
const terminalTask = {
  id: 'terminal_task', ownerUserId: 'owner', status: 'completed', nodes: [],
  metadata: { userId: 'owner', taskType: 'presentation', uBuddyOrganizationTraceId: 'terminal_trace' },
};
duplicateSidecar.recordTerminal(terminalTask);
duplicateSidecar.recordTerminal(terminalTask);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(duplicateTraceCalls, 1, 'repeated terminal notifications must reuse one upload');

const corruptSnapshotService = new UBuddyOrganizationEvolutionService({
  socialRelay: {
    connected: () => true,
    uBuddyOrganizationEvolutionOverview: async () => ({ policies: [], activePolicy: { ...policy, policyHash: 'corrupt' } }),
  },
  currentUser: () => ({ id: 'owner' }),
});
await assert.rejects(() => corruptSnapshotService.refresh('owner'), /hash mismatch/);
assert.equal(corruptSnapshotService.activePolicySnapshot('owner'), null);

let activePolicyRefreshCalls = 0;
const startupRefreshService = new UBuddyOrganizationEvolutionService({
  socialRelay: {
    connected: () => true,
    uBuddyOrganizationEvolutionActivePolicy: async () => { activePolicyRefreshCalls += 1; return { activePolicy: null }; },
    uBuddyOrganizationEvolutionOverview: async () => { throw new Error('startup must not load the full overview'); },
  },
  currentUser: () => ({ id: 'owner' }),
});
await startupRefreshService.refreshActivePolicy('owner');
assert.equal(activePolicyRefreshCalls, 1);

state.evolution = {};
state.evolutionScope = 'agents';
state.uBuddyFeatureFlags = { organizationEvolutionApplyV1: false };
state.uBuddyOrganizationEvolution = {
  status: 'candidate_ready', traceCount: 3, activePolicyVersionId: '',
  policies: [{ policyVersionId: 'policy_1', stage: 'assignment', evidenceCount: 3, summary: 'Prefer a stronger instance.' }],
};
const evolutionHtml = renderEvolution();
assert.match(evolutionHtml, /uBuddy 组织策略/);
assert.match(evolutionHtml, /data-ubuddy-org-evolution-activate="policy_1"/);
assert.match(evolutionHtml, /运行时 Gate 关闭|候选待启用/);

process.stdout.write('uBuddy organization evolution smoke passed.\n');
