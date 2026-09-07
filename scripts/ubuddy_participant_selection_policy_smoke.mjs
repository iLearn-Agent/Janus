import assert from 'node:assert/strict';

import {
  normalizeMentionSelectionContext,
  UBUDDY_PARTICIPANT_SELECTION_POLICIES,
  UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
} from '../src/shared/contracts/mentions.js';
import { validateUBuddyDispatchV3 } from '../src/shared/contracts/uBuddyDispatch.js';

const userIds = ['user-09', 'user-05', 'user-07'];
const mentions = userIds.map((userId) => ({
  principalType: 'user',
  userId,
  displayText: `@${userId}`,
  mentionId: `mention-${userId}`,
  source: 'picker',
}));
const content = '@user-09 @user-05 @user-07 正式分配 Agent 未来发展趋势研究任务。';

const defaultSelection = normalizeMentionSelectionContext({ mentions, content });
assert.equal(defaultSelection.participantSelectionPolicy, 'auto_select');
assert.equal(defaultSelection.selectionMode, 'candidate_pool');
assert.deepEqual(defaultSelection.candidateUserIds, userIds);
assert.deepEqual(defaultSelection.requiredUserIds, []);

const autoSelection = normalizeMentionSelectionContext({
  mentions,
  content,
  participantSelectionPolicyVersion: UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
  participantSelectionPolicy: UBUDDY_PARTICIPANT_SELECTION_POLICIES.AUTO_SELECT,
});
assert.equal(autoSelection.participantSelectionPolicy, 'auto_select');
assert.equal(autoSelection.selectionMode, 'candidate_pool');
assert.deepEqual(autoSelection.requiredUserIds, []);

const assignments = userIds.map((recipientId, index) => ({
  recipientId,
  title: `研究分工 ${index + 1}`,
  instruction: `由 ${recipientId} 完成独立研究分工。`,
}));
const baseDispatch = {
  version: 3,
  id: 'ubuddy-three-person-policy-smoke',
  title: '未来发展趋势研究',
  dispatchType: 'task_group',
  intent: 'multi_agent_task',
  executionMode: 'task_group',
  objective: '由 09、05、07 分工研究 Agent 未来发展趋势。',
  deliverables: ['三份独立研究成果'],
  requiresTaskGroup: true,
  sourceType: 'secretary_chat',
  sourceConversationId: 'session-policy-smoke',
  sourceMessageId: 'message-policy-smoke',
  sourceContent: content,
  instruction: content,
  mentions,
  participantSelectionPolicyVersion: UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
  participantSelectionPolicy: UBUDDY_PARTICIPANT_SELECTION_POLICIES.ALL_MENTIONED,
  selectionMode: 'all_selected',
  candidateUserIds: userIds,
  requiredUserIds: userIds,
  selectedUserIds: userIds,
  participants: userIds.map((userId) => ({ userId })),
  assignments,
  selectionDecision: {
    version: 'ubuddy_peer_selection_v1',
    status: 'ready',
    confidence: 1,
    strategyVersion: 'all_mentioned_confirmation_v1',
    rationale: '所有明确点名的联系人都必须参与。',
    clarification: { reasonCode: '', question: '' },
  },
};

assert.equal(validateUBuddyDispatchV3(baseDispatch).valid, true);
const omitted09 = validateUBuddyDispatchV3({
  ...baseDispatch,
  requiredUserIds: ['user-05', 'user-07'],
  selectedUserIds: ['user-05', 'user-07'],
  participants: baseDispatch.participants.slice(1),
  assignments: assignments.slice(1),
});
assert.equal(omitted09.valid, false);
assert.ok(omitted09.diagnostics.some((item) => item.code === 'dispatch_all_mentioned_participants_mismatch'));

console.log('uBuddy participant selection policy smoke passed');
