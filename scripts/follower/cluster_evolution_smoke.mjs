import assert from 'node:assert/strict';

import { evaluateFollowerClusterEvidence } from '../../src/shared/follower/cloudContracts.js';

function signal(user, index, sourceKind, signalKind, lineage = `${signalKind}:${index}`) {
  return { evidenceId: `e_${user}_${sourceKind}_${index}`, ownerUserId: user, serviceInstanceId: `service_${user}`,
    sourceKind, signalKind, lineageKey: lineage, occurredAt: `2026-08-12T00:${String(index).padStart(2, '0')}:00.000Z` };
}

const balanced = [];
for (let index = 1; index <= 7; index += 1) {
  const user = `user_${index}`;
  balanced.push(signal(user, index, 'follower_report_feedback', 'report_feedback'));
  balanced.push(signal(user, index, 'follower_suggestion_outcome', 'suggestion_outcome'));
  balanced.push(signal(user, index, 'follower_preference_instruction', 'verbosity'));
}
balanced.push({ ...balanced[0], evidenceId: 'duplicate_lineage_newer', occurredAt: '2026-08-12T01:00:00.000Z' });
const eligible = evaluateFollowerClusterEvidence(balanced);
assert.equal(eligible.eligible, true);
assert.equal(eligible.evidenceCount, 21, 'lineage duplicates must not inflate evidence');
assert.ok(eligible.maximumUserShare <= 0.15);

const dominated = [...balanced];
for (let index = 20; index < 30; index += 1) {
  dominated.push(signal('user_1', index, 'follower_report_feedback', 'report_feedback', `extra:${index}`));
}
const rejected = evaluateFollowerClusterEvidence(dominated);
assert.equal(rejected.eligible, false);
assert.ok(rejected.reasons.includes('follower_cluster_user_weight_exceeded'));

console.log('Follower cluster evidence threshold, lineage, and user-weight smoke passed');
