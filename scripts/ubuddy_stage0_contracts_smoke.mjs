import assert from 'node:assert/strict';

import { classifyUBuddyIntent } from '../src/main/modules/orchestration/application/uBuddyIntentClassifier.js';
import {
  normalizeUBuddyCapabilityProfile,
  uBuddyCapabilityProfile,
  validateUBuddyCapabilityProfile,
} from '../src/shared/contracts/uBuddyCapabilityProfile.js';
import {
  DEFAULT_MAX_QUALITY_REVISIONS,
  DeliveryReviewPolicy,
  FinalDeliveryPolicy,
  MAX_DELIVERY_REVIEW_EVENT_IDS,
  normalizeFinalDeliveryPolicy,
  normalizeDeliveryReviewPolicy,
  transitionFinalDelivery,
  transitionDeliveryReview,
  validateFinalDeliveryPolicy,
  validateDeliveryReviewPolicy,
} from '../src/shared/contracts/uBuddyDeliveryReview.js';
import {
  createUBuddyReadinessProof,
  normalizeUBuddyDispatchV3,
  normalizeUBuddyPeerSelection,
  uBuddyDispatchV3,
  uBuddyPeerSelectionDecision,
  uBuddyReadinessProofMatches,
  validateUBuddyDispatchV3,
  validateUBuddyPeerSelection,
} from '../src/shared/contracts/uBuddyDispatch.js';
import {
  normalizeUBuddyTaskIntake,
  uBuddyTaskIntakeSpec,
  validateUBuddyTaskIntake,
} from '../src/shared/contracts/uBuddyTaskIntake.js';
import {
  buildPublicTaskSummary,
  normalizePublicTaskSummary,
  renderPublicTaskSummaryContext,
} from '../src/shared/contracts/taskSummary.js';
import {
  AgentWorkStatusProjection,
  AgentWorkStatusProjectionEnvelope,
  applyAgentWorkStatusProjection,
  normalizeAgentWorkStatusProjection,
  normalizeAgentWorkStatusProjectionEnvelope,
  validateAgentWorkStatusProjection,
  validateAgentWorkStatusProjectionEnvelope,
} from '../src/shared/contracts/uBuddyWorkStatus.js';
import {
  UBUDDY_PARTICIPANT_SELECTION_POLICIES,
  UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
  createPickerMentionEntity,
  normalizeMentionEntities,
  normalizeMentionSelectionContext,
} from '../src/shared/contracts/mentions.js';
import {
  organizationAudienceRoutingMentions,
  organizationAudienceSnapshotMatches,
  resolveOrganizationAudience,
} from '../src/main/modules/collaboration/application/organizationAudienceResolver.js';
import { normalizeSecretaryDispatchCommand } from '../src/main/runtime.js';

assert.deepEqual([
  uBuddyTaskIntakeSpec.name,
  uBuddyCapabilityProfile.name,
  uBuddyPeerSelectionDecision.name,
  uBuddyDispatchV3.name,
  AgentWorkStatusProjection.name,
  AgentWorkStatusProjectionEnvelope.name,
  DeliveryReviewPolicy.name,
  FinalDeliveryPolicy.name,
], [
  'uBuddyTaskIntakeSpec',
  'uBuddyCapabilityProfile',
  'uBuddyPeerSelectionDecision',
  'uBuddyDispatchV3',
  'AgentWorkStatusProjection',
  'AgentWorkStatusProjectionEnvelope',
  'DeliveryReviewPolicy',
  'FinalDeliveryPolicy',
]);
assert.equal(uBuddyTaskIntakeSpec.version, 'ubuddy_task_intake_v1');
assert.equal(uBuddyCapabilityProfile.version, 'ubuddy_capability_profile_v1');
assert.equal(uBuddyPeerSelectionDecision.version, 'ubuddy_peer_selection_v1');
assert.equal(uBuddyDispatchV3.version, 3);
assert.equal(AgentWorkStatusProjection.version, 'agent_work_status_projection_v1');
assert.equal(AgentWorkStatusProjectionEnvelope.version, 'agent_work_status_projection_v1');
assert.equal(DeliveryReviewPolicy.version, 'delivery_review_policy_v1');
assert.equal(FinalDeliveryPolicy.version, 'final_delivery_policy_v1');

const readinessScopedDispatch = {
  version: 3, id: 'readiness-proof-dispatch', title: 'Readiness proof', dispatchType: 'local_agent',
  intent: 'single_agent_task', objective: 'Create a report.', deliverables: ['report.docx'],
  taskIntake: { state: 'ready', objective: 'Create a report.', deliverables: ['report.docx'] },
  privacyScope: 'owner_private', riskLevel: 'low', attachments: [{ id: 'attachment-1', name: 'source.txt' }],
  participants: [], agents: [{ agentId: 'general_agent' }], assignments: [], selectedUserIds: [],
};
readinessScopedDispatch.readinessProof = createUBuddyReadinessProof(readinessScopedDispatch, {
  auditedAt: '2026-08-13T00:00:00.000Z',
});
assert.equal(uBuddyReadinessProofMatches(readinessScopedDispatch), true);
for (const changed of [
  { ...readinessScopedDispatch, deliverables: ['report.pptx'] },
  { ...readinessScopedDispatch, riskLevel: 'high' },
  { ...readinessScopedDispatch, privacyScope: 'direct_delegation' },
  { ...readinessScopedDispatch, attachments: [{ id: 'attachment-2', name: 'other.txt' }] },
  { ...readinessScopedDispatch, agents: [{ agentId: 'ppt' }] },
]) assert.equal(uBuddyReadinessProofMatches(changed), false, 'dispatch scope changes must invalidate readiness proof');

function assertContractFields(contract, value) {
  assert.deepEqual(Object.keys(value).sort(), Object.keys(contract.fields).sort(),
    `${contract.name} field descriptor must match its normalized structure`);
}

const intakeSource = {
  version: 'ubuddy_task_intake_v1',
  state: 'ready',
  objective: '完成一份市场分析报告',
  deliverables: ['报告', '报告'],
  acceptanceCriteria: ['包含数据来源'],
  candidateUserIds: ['user-a', 'user-b', 'user-a'],
  requiredUserIds: ['user-a'],
  privacyScope: 'direct_delegation',
  attachments: [{ id: 'attachment-a', name: '要求.txt', kind: 'text/plain' }],
};
const intakeSourceSnapshot = structuredClone(intakeSource);
const intake = normalizeUBuddyTaskIntake(intakeSource);
assertContractFields(uBuddyTaskIntakeSpec, intake);
assert.deepEqual(intakeSource, intakeSourceSnapshot, 'normalization must not mutate task-intake input');
assert.deepEqual(intake.deliverables, ['报告']);
assert.deepEqual(intake.candidateUserIds, ['user-a', 'user-b']);
assert.notEqual(intake.attachments, intake.attachmentRefs, 'compatibility aliases must not share the canonical array');
assert.notEqual(intake.attachments[0], intake.attachmentRefs[0], 'compatibility aliases must not share attachment objects');
assert.equal(validateUBuddyTaskIntake(intake).valid, true);
assert.equal(validateUBuddyTaskIntake({ ...intakeSource, state: 'raedy' }).diagnostics
  .some((item) => item.code === 'task_intake_state_invalid'), true);
assert.equal(validateUBuddyTaskIntake({ ...intakeSource, privacyScope: 'publik' }).diagnostics
  .some((item) => item.code === 'task_intake_privacy_scope_invalid'), true);
assert.equal(validateUBuddyTaskIntake({ ...intakeSource, riskLevel: 'urgent' }).diagnostics
  .some((item) => item.code === 'task_intake_risk_level_invalid'), true);
assert.equal(validateUBuddyTaskIntake({
  state: 'ready', objective: '', deliverables: [], missingFields: ['objective'],
}).valid, false);
assert.equal(validateUBuddyTaskIntake({
  state: 'needs_clarification',
  candidateUserIds: ['user-a'],
  requiredUserIds: ['user-b'],
  clarification: { question: '最终需要报告还是 PPT？', options: ['报告', 'PPT'] },
}).diagnostics.some((item) => item.code === 'task_intake_required_user_not_candidate'), true);
assert.throws(() => validateUBuddyTaskIntake({ state: 'needs_clarification' }, { throwOnError: true }),
  (error) => error.code === 'ubuddy_task_intake_invalid');

const publicTaskSummary = buildPublicTaskSummary({
  taskIntake: {
    objective: '完成公开市场分析', deliverables: ['报告.docx'], acceptanceCriteria: ['事实有来源'],
    constraints: ['使用中文'], deadline: '2026-08-20', knownFacts: ['私人事实'], candidateUserIds: ['private-user'],
  },
  objective: '不得覆盖结构化目标',
  deliverables: ['fallback.txt'],
});
assert.deepEqual(publicTaskSummary, {
  version: 1,
  objective: '完成公开市场分析',
  deliverables: ['报告.docx'],
  acceptanceCriteria: ['事实有来源'],
  constraints: ['使用中文'],
  deadline: '2026-08-20',
});
assert.equal(Object.hasOwn(publicTaskSummary, 'knownFacts'), false);
assert.equal(Object.hasOwn(publicTaskSummary, 'candidateUserIds'), false);
assert.equal(normalizePublicTaskSummary({ objective: '' }), null);
assert.match(renderPublicTaskSummaryContext(publicTaskSummary), /Shared final objective:\n完成公开市场分析/);
assert.match(renderPublicTaskSummaryContext(publicTaskSummary), /Final deliverables:\n- 报告\.docx/);
assert.doesNotMatch(renderPublicTaskSummaryContext(publicTaskSummary), /私人事实|private-user/);

const profile = normalizeUBuddyCapabilityProfile({
  ownerUserId: 'owner-a',
  uBuddyAgentInstanceId: 'secretary-a',
  profileRevision: 1,
  introduction: '擅长整理研究任务并协调报告交付。',
  supportedTaskTypes: ['研究整理', '任务协调'],
  deliverableTypes: ['report', 'presentation', 'unknown'],
  capabilityTags: ['研究', '写作'],
  privacyConstraints: ['不公开私人对话或未确认材料。'],
  evidenceSummary: '根据已通过治理的能力规则生成。',
  sourceEffectiveSkillHash: 'skill-hash-a',
  visibility: 'friends',
  publicationState: 'validated',
  generatedAt: '2026-08-03T10:00:00.000Z',
});
assertContractFields(uBuddyCapabilityProfile, profile);
assert.deepEqual(profile.deliverableTypes, ['report', 'presentation']);
assert.equal(validateUBuddyCapabilityProfile(profile).valid, true);
assert.equal(validateUBuddyCapabilityProfile({ ...profile, visibility: 'publik' }).diagnostics
  .some((item) => item.code === 'profile_visibility_invalid'), true);
assert.equal(validateUBuddyCapabilityProfile({ ...profile, publicationState: 'activ' }).diagnostics
  .some((item) => item.code === 'profile_publication_state_invalid'), true);
for (const sensitiveValue of [
  '联系 owner@example.com 获取资料',
  'password=not-a-real-password',
  '读取 /home/owner/private/report.md',
  '引用私聊原文作为能力证据',
]) {
  const invalid = validateUBuddyCapabilityProfile({ ...profile, introduction: sensitiveValue });
  assert.equal(invalid.valid, false, `sensitive Profile content must be rejected: ${sensitiveValue}`);
}

const selectionSource = {
  status: 'ready',
  selectionMode: 'candidate_pool',
  candidateUserIds: ['user-a', 'user-b', 'user-c'],
  requiredUserIds: ['user-b'],
  selectedUserIds: ['user-a', 'user-b'],
  rejectedCandidates: [{ userId: 'user-c', reasonCode: 'task_type_mismatch', reason: '任务类型不匹配' }],
  profileSnapshots: [
    { ownerUserId: 'user-a', profileRevision: 2, sourceEffectiveSkillHash: 'hash-a' },
    { ownerUserId: 'user-b', profileRevision: 3, sourceEffectiveSkillHash: 'hash-b' },
  ],
  confidence: 0.92,
  strategyVersion: 'ubuddy_peer_route_v1',
  rationale: '两人的能力组合覆盖报告和演示文稿。',
};
const selection = normalizeUBuddyPeerSelection(selectionSource);
assertContractFields(uBuddyPeerSelectionDecision, selection);
assert.equal(validateUBuddyPeerSelection(selection).valid, true);
assert.equal(validateUBuddyPeerSelection({ ...selectionSource, status: 'raedy' }).diagnostics
  .some((item) => item.code === 'peer_selection_status_invalid'), true);
assert.equal(validateUBuddyPeerSelection({ ...selectionSource, selectionMode: 'all_selectd' }).diagnostics
  .some((item) => item.code === 'peer_selection_mode_invalid'), true);
assert.equal(validateUBuddyPeerSelection({
  ...selectionSource,
  profileSnapshots: [{ ownerUserId: 'user-a', profileRevision: 0, sourceEffectiveSkillHash: '' }],
}).diagnostics.some((item) => item.code === 'peer_selection_snapshot_revision_invalid'), true);
assert.equal(validateUBuddyPeerSelection({ ...selectionSource, selectedUserIds: ['user-a'] })
  .diagnostics.some((item) => item.code === 'peer_selection_required_not_selected'), true);
assert.equal(validateUBuddyPeerSelection({
  ...selectionSource,
  selectionMode: 'all_selected',
  selectedUserIds: ['user-a', 'user-b'],
}).diagnostics.some((item) => item.code === 'peer_selection_all_selected_invalid'), true);
assert.equal(validateUBuddyPeerSelection({
  status: 'no_match', selectionMode: 'candidate_pool', candidateUserIds: ['user-a'], selectedUserIds: [],
}).valid, true);

const userAMention = createPickerMentionEntity({ principalType: 'user', userId: 'user-a', displayText: '@用户A' });
const userBMention = createPickerMentionEntity({ principalType: 'user', userId: 'user-b', displayText: '@用户B' });
const organizationMention = createPickerMentionEntity({
  principalType: 'organization',
  organizationId: 'organization-a',
  audience: 'all_members',
  displayText: '@组织所有人',
});
assert.equal(organizationMention.organizationId, 'organization-a');
assert.equal(organizationMention.audience, 'all_members');
assert.equal(normalizeMentionEntities([
  { ...organizationMention, source: 'manual' },
], { content: '@组织所有人 完成报告' }).length, 0, 'manual organization text must not become a structured audience');
const organizationAudience = resolveOrganizationAudience({
  mentions: [organizationMention],
  user: { id: 'owner' },
  activeWorkspace: { id: 'workspace_org_organization-a', workspaceKind: 'organization', organizationId: 'organization-a' },
  organizations: [{
    id: 'organization-a',
    name: '研发组织',
    members: [
      { user: { id: 'owner', displayName: 'Owner' } },
      { user: { id: 'user-a', displayName: '用户A' } },
      { user: { id: 'user-b', displayName: '用户B' } },
    ],
  }],
});
assert.deepEqual(organizationAudience.userIds, ['user-a', 'user-b']);
assert.equal(organizationAudience.snapshot.memberCount, 2);
assert.equal(organizationAudienceSnapshotMatches(organizationAudience.snapshot, {
  ...organizationAudience.snapshot,
  memberUserIds: ['user-b', 'user-a'],
}), true);
assert.deepEqual(organizationAudienceRoutingMentions([organizationMention], organizationAudience)
  .filter((item) => item.principalType === 'user').map((item) => item.userId), ['user-a', 'user-b']);
const personalOrganizationAudience = resolveOrganizationAudience({
  mentions: [organizationMention],
  user: { id: 'owner' },
  activeWorkspace: { id: 'workspace_personal', workspaceKind: 'personal', organizationId: '' },
  organizations: [{
    id: 'organization-a',
    name: '研发组织',
    members: [
      { user: { id: 'owner', displayName: 'Owner' } },
      { user: { id: 'user-a', displayName: '用户A' } },
      { user: { id: 'user-b', displayName: '用户B' } },
    ],
  }],
});
assert.deepEqual(personalOrganizationAudience.userIds, ['user-a', 'user-b']);
assert.throws(() => resolveOrganizationAudience({
  mentions: [organizationMention],
  user: { id: 'owner' },
  activeWorkspace: { id: 'workspace_org_other', workspaceKind: 'organization', organizationId: 'organization-other' },
  organizations: [{
    id: 'organization-a',
    members: [
      { user: { id: 'owner' } },
      { user: { id: 'user-a' } },
    ],
  }],
}), /当前组织 Workspace.*个人 Workspace/);
const legacyMultiUserIntent = classifyUBuddyIntent({
  prompt: '@用户A @用户B 分工完成一份市场分析报告',
  mentions: [userAMention, userBMention],
  friendships: [{ friend: { id: 'user-a' } }, { friend: { id: 'user-b' } }],
  route: { mode: 'direct' },
});
assert.equal(legacyMultiUserIntent.executionMode, 'task_group');
assert.deepEqual(legacyMultiUserIntent.targetUsers.map((item) => item.id), ['user-a', 'user-b'],
  'Stage 0 must preserve the legacy behavior that every mentioned user is an execution target');
assert.equal(normalizeMentionSelectionContext({
  mentions: [userAMention, userBMention], content: '@用户A @用户B 一起完成报告',
}).selectionMode, 'all_selected');
assert.equal(normalizeMentionSelectionContext({
  mentions: [userAMention, userBMention], content: '@用户A @用户B 选择合适的人完成报告',
  participantSelectionPolicyVersion: UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
  participantSelectionPolicy: UBUDDY_PARTICIPANT_SELECTION_POLICIES.AUTO_SELECT,
}).selectionMode, 'candidate_pool');

const dispatchInput = {
  id: 'dispatch-a',
  title: '市场分析',
  dispatchType: 'task_group',
  intent: 'multi_agent_task',
  objective: '完成市场分析',
  deliverables: ['报告'],
  sourceType: 'secretary_chat',
  sourceConversationId: 'session-a',
  sourceMessageId: 'message-a',
  route: { mode: 'direct', LocalPath: '/home/owner/private' },
  attachments: [{ id: 'attachment-a', name: '要求.txt', type: 'text/plain', LocalPath: '/home/owner/要求.txt' }],
  mentions: [{ principalType: 'user', userId: 'user-a', displayText: '@用户A', mentionId: 'mention-a' }],
  participants: [{ userId: 'user-a' }, { userId: 'user-b' }],
  assignments: [
    { recipientId: 'user-a', title: '报告', instruction: '完成报告', path: '/home/owner/private' },
    { recipientId: 'user-b', title: '校验', instruction: '校验报告' },
  ],
  peerSelection: {
    status: 'ready', selectionMode: 'all_selected', candidateUserIds: ['user-a', 'user-b'],
    selectedUserIds: ['user-a', 'user-b'], confidence: 1, strategyVersion: 'legacy_explicit_v1', rationale: '旧语义为全部参与。',
  },
};
const dispatchSnapshot = structuredClone(dispatchInput);
const dispatch = normalizeUBuddyDispatchV3(dispatchInput);
assertContractFields(uBuddyDispatchV3, dispatch);
assert.deepEqual(dispatchInput, dispatchSnapshot, 'dispatch normalization must not mutate input');
assert.equal(dispatch.version, 3);
const organizationDispatch = normalizeUBuddyDispatchV3({
  ...dispatchInput,
  mentions: [organizationMention],
  organizationAudienceSnapshot: organizationAudience.snapshot,
});
assert.equal(organizationDispatch.organizationAudienceSnapshot.organizationId, 'organization-a');
assert.equal(organizationDispatch.organizationAudienceSnapshot.memberCount, 2);
assert.equal(validateUBuddyDispatchV3(organizationDispatch).valid, true);
assert.equal(validateUBuddyDispatchV3({
  ...organizationDispatch,
  candidateUserIds: ['user-a'],
}).diagnostics.some((item) => item.code === 'dispatch_organization_audience_candidates_mismatch'), true);
assert.equal(validateUBuddyPeerSelection({
  ...dispatch.selectionDecision,
  selectionMode: dispatch.selectionMode,
  candidateUserIds: dispatch.candidateUserIds,
  requiredUserIds: dispatch.requiredUserIds,
  selectedUserIds: dispatch.selectedUserIds,
  profileSnapshots: dispatch.profileRevisionSnapshots,
}).valid, true);
assert.equal(validateUBuddyDispatchV3(dispatch).valid, true);
assert.throws(() => normalizeSecretaryDispatchCommand({ ...dispatchInput, version: 3 }),
  (error) => error.code === 'ubuddy_dispatch_v3_disabled');
const runtimeDispatch = normalizeSecretaryDispatchCommand({
  ...dispatchInput,
  version: 3,
  sourceSecretarySessionId: 'secretary-session-a',
  continuationRequestMessageId: 'continuation-message-a',
}, { newDispatchStrategy: true });
assert.deepEqual(runtimeDispatch, normalizeUBuddyDispatchV3({
  ...dispatchInput,
  version: 3,
  sourceSecretarySessionId: 'secretary-session-a',
  continuationRequestMessageId: 'continuation-message-a',
}), 'V3 runtime dispatch normalization must use the shared contract');
assert.equal(runtimeDispatch.sourceSecretarySessionId, 'secretary-session-a');
assert.equal(runtimeDispatch.continuationRequestMessageId, 'continuation-message-a');
assert.equal(Object.hasOwn(dispatch.assignments[0], 'path'), false);
assert.equal(dispatch.attachments[0].id, 'attachment-a');
assert.equal(Object.hasOwn(dispatch.attachments[0], 'path'), false);
assert.equal(Object.hasOwn(dispatch.route, 'LocalPath'), false);
assert.equal(validateUBuddyDispatchV3({ ...dispatchInput, version: 2 }).diagnostics
  .some((item) => item.code === 'dispatch_version_unsupported'), true);
assert.equal(validateUBuddyDispatchV3({
  ...dispatchInput,
  assignments: dispatchInput.assignments.slice(0, 1),
}).diagnostics.some((item) => item.code === 'dispatch_selected_assignment_missing'), true);
assert.equal(validateUBuddyDispatchV3({
  ...dispatchInput,
  peerSelection: {
    ...dispatchInput.peerSelection,
    selectionMode: 'candidate_pool',
    selectedUserIds: ['user-a'],
    rejectedCandidates: [{ userId: 'user-b', reasonCode: 'lower_score', reason: '匹配度较低。' }],
  },
}).diagnostics.some((item) => item.code === 'dispatch_participant_not_selected'), true,
'a non-selected candidate must not remain a participant');
assert.equal(validateUBuddyDispatchV3({
  ...dispatchInput,
  participants: [{ userId: 'user-a' }],
  peerSelection: {
    ...dispatchInput.peerSelection,
    selectionMode: 'candidate_pool',
    selectedUserIds: ['user-a'],
    rejectedCandidates: [{ userId: 'user-b', reasonCode: 'lower_score', reason: '匹配度较低。' }],
  },
}).diagnostics.some((item) => item.code === 'dispatch_assignment_not_selected'), true,
'a non-selected candidate must not retain an assignment');
assert.equal(validateUBuddyDispatchV3({
  id: 'dispatch-message', title: '询问时间', dispatchType: 'simple_message', intent: 'simple_message',
  objective: '请问明天几点开会？', participants: [{ userId: 'user-a' }],
  peerSelection: {
    status: 'ready', selectionMode: 'explicit_single', candidateUserIds: ['user-a'], selectedUserIds: ['user-a'],
    strategyVersion: 'explicit_message_v1', rationale: '用户明确选择了唯一接收人。',
  },
}).valid, true, 'a lightweight message must not require task deliverables');
assert.equal(validateUBuddyDispatchV3({
  id: 'dispatch-local', title: '本地报告', dispatchType: 'local_agent', intent: 'single_agent_task',
  objective: '完成本地报告', deliverables: ['报告'], agents: [{ agentId: 'general_agent', agentInstanceId: 'agent-a' }],
}).valid, true, 'a local Agent dispatch must not require a remote peer-selection decision');
assert.throws(() => validateUBuddyDispatchV3({ ...dispatchInput, id: '' }, { throwOnError: true }),
  (error) => error.code === 'ubuddy_dispatch_v3_invalid');

const projected = normalizeAgentWorkStatusProjection({
  actorKind: 'local_agent', agentInstanceId: 'agent-a', taskRunId: 'task-a', status: 'running',
  currentAction: '读取 file:///home/owner/private/report.md，使用 ghp_1234567890abcdef，并联系 owner@example.com',
  progress: { completed: 2, total: 5 }, visibility: 'participant_public',
  sourceEventId: 'event-a', sourceRevision: 3, updatedAt: '2026-08-03T10:00:00.000Z',
});
assertContractFields(AgentWorkStatusProjection, projected);
assert.equal(projected.progress.percent, 40);
assert.doesNotMatch(projected.currentAction, /\/home\/owner|owner@example\.com|ghp_1234567890abcdef/);
assert.equal(validateAgentWorkStatusProjection(projected).valid, true);
const projectedEnvelope = normalizeAgentWorkStatusProjectionEnvelope({
  scopeKind: 'task_run', scopeId: 'task-a', actors: [projected], updatedAt: projected.updatedAt,
});
assertContractFields(AgentWorkStatusProjectionEnvelope, projectedEnvelope);
assert.equal(validateAgentWorkStatusProjectionEnvelope(projectedEnvelope).valid, true);
assert.equal(validateAgentWorkStatusProjection({ ...projected, status: 'runnning' }).diagnostics
  .some((item) => item.code === 'work_status_value_invalid'), true);
assert.equal(validateAgentWorkStatusProjection({ ...projected, visibility: 'publik' }).diagnostics
  .some((item) => item.code === 'work_status_visibility_invalid'), true);
assert.equal(validateAgentWorkStatusProjection({ ...projected, actorKind: 'local_agnet' }).diagnostics
  .some((item) => item.code === 'work_status_actor_kind_invalid'), true);
assert.equal(validateAgentWorkStatusProjection({ ...projected, currentStage: 'exectuing' }).diagnostics
  .some((item) => item.code === 'work_status_stage_invalid'), true);
assert.equal(normalizeAgentWorkStatusProjection({
  agentInstanceId: 'agent-a', taskRunId: 'task-a', status: 'running', updatedAt: '2026-08-03T10:00:00.000Z',
}).progress.percent, null, 'unknown work totals must not produce a percentage');
assert.equal(applyAgentWorkStatusProjection(projected, { ...projected }).duplicate, true);
assert.equal(applyAgentWorkStatusProjection(projected, {
  ...projected, sourceEventId: 'event-old', sourceRevision: 2,
}).action, 'stale_revision');
assert.equal(applyAgentWorkStatusProjection(projected, {
  ...projected, sourceEventId: 'event-conflict', status: 'waiting',
}).action, 'revision_conflict');
assert.equal(applyAgentWorkStatusProjection(projected, {
  ...projected, sourceEventId: 'event-unversioned', sourceRevision: 0,
}).action, 'unversioned_rejected');
assert.equal(applyAgentWorkStatusProjection(projected, {
  ...projected, taskRunId: 'task-b', sourceEventId: 'event-other-task', sourceRevision: 4,
}).action, 'scope_mismatch');
assert.equal(applyAgentWorkStatusProjection(projected, {
  ...projected, agentInstanceId: 'agent-b', sourceEventId: 'event-other-agent', sourceRevision: 4,
}).action, 'actor_mismatch');
assert.equal(applyAgentWorkStatusProjection(projected, {
  ...projected, status: 'waiting', sourceEventId: 'event-next', sourceRevision: 4,
  updatedAt: '2026-08-03T10:01:00.000Z',
}).action, 'applied');
const completedProjection = normalizeAgentWorkStatusProjection({
  ...projected, status: 'completed', sourceEventId: 'event-completed', sourceRevision: 5,
  updatedAt: '2026-08-03T10:02:00.000Z',
});
assert.equal(applyAgentWorkStatusProjection(completedProjection, {
  ...completedProjection, status: 'running', sourceEventId: 'event-regression', sourceRevision: 6,
  updatedAt: '2026-08-03T10:03:00.000Z',
}).action, 'terminal_regression');
const unversionedProjection = normalizeAgentWorkStatusProjection({
  ...projected, sourceEventId: 'timestamp-newer', sourceRevision: 0, updatedAt: '2026-08-03T10:05:00.000Z',
});
assert.equal(applyAgentWorkStatusProjection(unversionedProjection, {
  ...unversionedProjection, sourceEventId: 'timestamp-older', updatedAt: '2026-08-03T10:04:00.000Z',
}).action, 'stale_timestamp');

let review = normalizeDeliveryReviewPolicy({ state: 'submitted' });
assertContractFields(DeliveryReviewPolicy, review);
assert.equal(review.maxQualityRevisions, DEFAULT_MAX_QUALITY_REVISIONS);
assert.equal(DEFAULT_MAX_QUALITY_REVISIONS, 2);
assert.equal(MAX_DELIVERY_REVIEW_EVENT_IDS, 1_000);
assert.equal(validateDeliveryReviewPolicy({ state: 'verfying' }).diagnostics
  .some((item) => item.code === 'delivery_review_state_invalid'), true);
const longReviewHistory = normalizeDeliveryReviewPolicy({
  state: 'submitted',
  processedReviewEventIds: Array.from({ length: 150 }, (_item, index) => `review-event-${index}`),
});
assert.equal(longReviewHistory.processedReviewEventIds.length, 150);
assert.equal(transitionDeliveryReview(longReviewHistory, {
  id: 'review-event-0', type: 'verification_started',
}).duplicate, true, 'review events older than the former 100-event window must remain idempotent');
for (let revision = 1; revision <= DEFAULT_MAX_QUALITY_REVISIONS; revision += 1) {
  review = transitionDeliveryReview(review, {
    id: `verification-started-${revision}`, type: 'verification_started',
  }).review;
  const failed = transitionDeliveryReview(review, {
    id: `validation-failed-${revision}`,
    type: 'validation_failed',
    correctable: true,
    failureCodes: ['deliverable_incomplete'],
    requiredChanges: [`完成第 ${revision} 次修改`],
  });
  assert.equal(failed.action, 'revision_requested');
  assert.equal(failed.review.qualityRevisionCount, revision);
  const duplicate = transitionDeliveryReview(failed.review, {
    id: `validation-failed-${revision}`, type: 'validation_failed', correctable: true,
  });
  assert.equal(duplicate.duplicate, true);
  review = transitionDeliveryReview(failed.review, { id: `rework-${revision}`, type: 'rework_started' }).review;
  const replayAfterLaterEvent = transitionDeliveryReview(review, {
    id: `validation-failed-${revision}`, type: 'validation_failed', correctable: true,
  });
  assert.equal(replayAfterLaterEvent.duplicate, true, 'older processed review events must remain idempotent');
}
review = transitionDeliveryReview(review, {
  id: 'verification-started-exhausted', type: 'verification_started',
}).review;
const exhausted = transitionDeliveryReview(review, {
  id: 'validation-failed-exhausted', type: 'validation_failed', correctable: true,
});
assert.equal(exhausted.action, 'revision_exhausted');
assert.equal(exhausted.review.state, 'revision_exhausted');
assert.equal(exhausted.review.qualityRevisionCount, DEFAULT_MAX_QUALITY_REVISIONS);
const hardContractExhausted = transitionDeliveryReview(review, {
  id: 'hard-contract-failed-exhausted', type: 'validation_failed', correctable: true,
  hardContract: true, failureCodes: ['required_file_missing'], requiredChanges: ['Create the required file.'],
});
assert.equal(hardContractExhausted.action, 'revision_exhausted');
assert.equal(hardContractExhausted.review.state, 'action_required');

const needsOwner = transitionDeliveryReview(normalizeDeliveryReviewPolicy({ state: 'verifying' }), {
  id: 'validation-owner-action', type: 'validation_failed', correctable: true, requiresUserAction: true,
});
assert.equal(needsOwner.review.state, 'action_required');
assert.equal(needsOwner.review.qualityRevisionCount, 0);
const executionFailure = transitionDeliveryReview(normalizeDeliveryReviewPolicy({ state: 'reworking' }), {
  id: 'execution-failure', type: 'execution_failed', failureCodes: ['network_error'],
});
assert.equal(executionFailure.review.qualityRevisionCount, 0);
assert.equal(executionFailure.review.executionAttemptCount, 1);
assert.equal(transitionDeliveryReview(normalizeDeliveryReviewPolicy({ state: 'submitted' }), {
  id: 'invalid-rework-start', type: 'rework_started',
}).action, 'invalid_transition');
assert.equal(validateDeliveryReviewPolicy({ maxQualityRevisions: 0 }).valid, false);

let finalDelivery = normalizeFinalDeliveryPolicy();
assertContractFields(FinalDeliveryPolicy, finalDelivery);
const delivered = transitionFinalDelivery(finalDelivery, {
  id: 'final-delivery-delivered', type: 'delivered', occurredAt: '2026-08-05T01:00:00.000Z',
});
assert.equal(delivered.delivery.state, 'delivered');
assert.equal(delivered.delivery.closedAt, '', 'delivery must not close before user confirmation');
const confirmed = transitionFinalDelivery(delivered.delivery, {
  id: 'final-delivery-confirmed', type: 'user_confirmed', occurredAt: '2026-08-05T01:01:00.000Z',
});
assert.equal(confirmed.delivery.state, 'user_confirmed');
const closed = transitionFinalDelivery(confirmed.delivery, {
  id: 'final-delivery-closed', type: 'closed', occurredAt: '2026-08-05T01:01:01.000Z',
});
assert.equal(closed.delivery.state, 'closed');
assert.equal(validateFinalDeliveryPolicy(closed.delivery).valid, true);
assert.equal(transitionFinalDelivery(delivered.delivery, {
  id: 'invalid-close-before-confirmation', type: 'closed',
}).action, 'invalid_transition');
const failedDelivery = transitionFinalDelivery(normalizeFinalDeliveryPolicy(), {
  id: 'final-delivery-failed', type: 'delivery_failed', failureReason: 'Upload failed.', retryable: true,
});
assert.equal(failedDelivery.delivery.state, 'failed');
assert.equal(failedDelivery.delivery.failureReason, 'Upload failed.');
assert.equal(transitionFinalDelivery(failedDelivery.delivery, {
  id: 'final-delivery-retry', type: 'retry_started',
}).delivery.state, 'not_delivered');
assert.equal(normalizeFinalDeliveryPolicy({}, {
  reviewState: 'action_required', failureReason: 'Owner input is required.',
}).state, 'not_delivered', 'an action-required explanation must not be misclassified as delivery failure');
assert.equal(validateFinalDeliveryPolicy(normalizeFinalDeliveryPolicy({}, {
  deliveryReviewState: 'accepted', deliveryReviewOutcome: 'owner_override', updatedAt: '2026-08-05T01:03:00.000Z',
})).valid, true, 'legacy owner-accepted tasks must receive compatible confirmation timestamps');

console.log('uBuddy stage 0 contracts smoke passed');
