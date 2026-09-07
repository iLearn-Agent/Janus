import assert from 'node:assert/strict';

import {
  classifyMultiMentionTrigger,
  multiMentionTargetUserIds,
} from '../src/shared/contracts/mentions.js';
import {
  decideUBuddyCollaborationMode,
  planUBuddyCollaborationAssignments,
} from '../src/main/modules/orchestration/application/uBuddyCollaborationPlanner.js';

const ownerId = 'owner';
const mentions = [
  { principalType: 'ubuddy', ownerUserId: 'user-a', displayText: '@甲的uBuddy', mentionId: 'mention-a', source: 'picker' },
  { principalType: 'ubuddy', ownerUserId: 'user-b', displayText: '@乙的uBuddy', mentionId: 'mention-b', source: 'picker' },
];

assert.deepEqual(multiMentionTargetUserIds(mentions, {
  content: '@甲的uBuddy @乙的uBuddy 你们收到消息了吗？',
  currentUserId: ownerId,
  source: 'natural_chat_group',
}), ['user-a', 'user-b']);

assert.equal(classifyMultiMentionTrigger({
  content: '@甲的uBuddy @乙的uBuddy 你们收到消息了吗？',
  mentions,
  currentUserId: ownerId,
  source: 'natural_chat_group',
}).classification, 'simple_message');

const taskTrigger = classifyMultiMentionTrigger({
  content: '@甲的uBuddy 做一份高等数学复习文档 @乙的uBuddy 做一份大学物理复习文档',
  mentions,
  currentUserId: ownerId,
  source: 'natural_chat_group',
});
assert.equal(taskTrigger.classification, 'multi_task');
assert.deepEqual(taskTrigger.targetUserIds, ['user-a', 'user-b']);

const mode = await decideUBuddyCollaborationMode({
  prompt: '请让甲完成数学复习文档，其余工作由 uBuddy 自动分给乙。',
  intake: { objective: '准备两份复习文档' },
  mentionedUsers: [{ userId: 'user-a', displayName: '甲' }, { userId: 'user-b', displayName: '乙' }],
  execute: async () => JSON.stringify({
    version: 'UBUDDY_COLLABORATION_MODE_DECISION_V1',
    decision: 'ready',
    collaborationMode: 'manager_delegation',
    initiatorParticipation: 'coordinator_only',
    assignmentIntent: 'auto',
    participantSelectionIntent: 'all',
    explicitAssignments: [],
    confidence: 0.96,
    clarification: { reasonCode: '', question: '', options: [] },
  }),
});
assert.equal(mode.assignmentIntent, 'auto');
assert.equal(mode.collaborationMode, 'manager_delegation');

const plan = await planUBuddyCollaborationAssignments({
  proposalId: 'multi-mention-smoke',
  modeDecision: mode,
  intake: { objective: '准备两份复习文档', explicitSource: '甲负责数学，其余工作由 uBuddy 分给乙。' },
  selectedUsers: [{ userId: 'user-a', displayName: '甲' }, { userId: 'user-b', displayName: '乙' }],
  execute: async () => JSON.stringify({
    assignments: [
      { assignmentId: 'math', assigneeKind: 'user', userId: 'user-a', title: '高等数学复习文档', objective: '完成高等数学复习文档。', deliverables: ['数学文档'], dependencies: [] },
      { assignmentId: 'physics', assigneeKind: 'user', userId: 'user-b', title: '大学物理复习文档', objective: '完成大学物理复习文档。', deliverables: ['物理文档'], dependencies: [] },
    ],
    confidence: 0.95,
    strategyVersion: 'ubuddy_collaboration_assignment_v1',
  }),
});
assert.deepEqual(plan.assignments.map((item) => item.userId), ['user-a', 'user-b']);
assert.equal(plan.confirmationRequired, true);

console.log('uBuddy multi-mention auto-dispatch smoke passed');
