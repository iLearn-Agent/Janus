import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLUSTER_EVOLUTION_ALGORITHM_VERSION,
  CLUSTER_MINIMUM_USERS,
  CLUSTER_PARTICIPATION_POLICY_VERSION,
  DEFAULT_CLUSTER_EVIDENCE_THRESHOLDS,
  MARKET_CANARY_MODE,
  MARKET_CANDIDATE_STATES,
  clusterEvidenceCategory,
  clusterEvidenceThresholdsFromEnv,
  clusterReEvaluationBasisHash,
  evidenceRejectionKindForReason,
  evidenceUsageTransitionAllowed,
  evolutionEvidenceClusterScopeAutomatic,
  evolutionReEvaluationBasisHash,
  normalizeEvidenceRejectionKind,
  normalizeEvolutionEvidenceIdentity,
  normalizeEvolutionEvidenceSourceKind,
  marketCandidateTransitionAllowed,
  stableEvolutionEvidenceId,
  stableClusterCohortId,
  stableClusterCohortKey,
} from '../../src/shared/evolution/contracts.js';
import { evaluateRealUserCanary, PERFORMANCE_ALGORITHM_VERSION, selectClusterEligibleEvidence } from '../../src/shared/evolution/phase8.js';

test('evolution evidence identities keep the stable ID contract and validate registered sources', () => {
  assert.equal(stableEvolutionEvidenceId({
    ownerUserId: 'user', userAgentInstanceId: 'instance', sourceKind: 'message',
    sourceId: 'message-1', contentHash: 'hash-1',
  }), 'evidence_8db94539dccbc2e00fe63248ab1735be4f09341fd02860493e7f47f54fcb19a8');
  assert.equal(normalizeEvolutionEvidenceSourceKind('message'), 'message');
  assert.equal(normalizeEvolutionEvidenceSourceKind('task_node_result'), 'task_node_result');
  assert.throws(() => normalizeEvolutionEvidenceSourceKind('arbitrary_source'), (error) => error.code === 'evidence_source_kind_invalid');
  assert.throws(() => normalizeEvolutionEvidenceIdentity({
    ownerUserId: 'user', userAgentInstanceId: 'instance', sourceKind: 'memory_version',
    sourceId: 'memory', contentHash: 'hash',
  }), (error) => error.code === 'memory_version_required');
});

test('evidence usage transitions and re-evaluation basis are deterministic', () => {
  assert.equal(evidenceUsageTransitionAllowed({ from: 'available', to: 'reserved' }), true);
  assert.equal(evidenceUsageTransitionAllowed({ from: 'released', to: 'reserved' }), true);
  assert.equal(evidenceUsageTransitionAllowed({ from: 'reserved', to: 'consumed' }), true);
  assert.equal(evidenceUsageTransitionAllowed({ from: 'reserved', to: 'evaluated_rejected' }), true);
  assert.equal(evidenceUsageTransitionAllowed({ from: 'reserved', to: 'released' }), true);
  assert.equal(evidenceUsageTransitionAllowed({ from: 'consumed', to: 'reserved' }), false);
  assert.equal(evidenceUsageTransitionAllowed({
    from: 'evaluated_rejected', to: 'reserved', currentRunId: 'run-1', nextRunId: 'run-2',
    currentReEvaluationBasisHash: 'basis-1', nextReEvaluationBasisHash: 'basis-2',
  }), true);
  assert.equal(evidenceUsageTransitionAllowed({
    from: 'evaluated_rejected', to: 'reserved', currentRunId: 'run-1', nextRunId: 'run-2',
    currentReEvaluationBasisHash: 'basis-1', nextReEvaluationBasisHash: 'basis-1',
  }), false);
  const first = evolutionReEvaluationBasisHash({
    algorithmVersion: 'algorithm', policyVersion: 'policy', relatedEvidenceIds: ['b', 'a', 'a'],
  });
  const second = evolutionReEvaluationBasisHash({
    algorithmVersion: 'algorithm', policyVersion: 'policy', relatedEvidenceIds: ['a', 'b'],
  });
  assert.equal(first, second);
  assert.equal(normalizeEvidenceRejectionKind('user_rejected'), 'user_rejected');
  assert.equal(evidenceRejectionKindForReason('market_mixed_rejected'), 'mixed');
  assert.throws(() => normalizeEvidenceRejectionKind('unknown'), (error) => error.code === 'evidence_rejection_kind_invalid');
});

test('cluster contracts freeze thresholds, evidence categories, and algorithm-independent cohort identity', () => {
  assert.equal(CLUSTER_EVOLUTION_ALGORITHM_VERSION, 'cluster_market_v2');
  assert.equal(CLUSTER_MINIMUM_USERS, 7);
  assert.equal(CLUSTER_PARTICIPATION_POLICY_VERSION, 'cluster_active_synced_mandatory_v1');
  assert.equal(PERFORMANCE_ALGORITHM_VERSION, 'performance_90d_100tasks_v2');
  assert.equal(MARKET_CANARY_MODE, 'real_user_default_on');
  assert.ok(MARKET_CANDIDATE_STATES.includes('shadow_passed'));
  assert.equal(marketCandidateTransitionAllowed('governance_approved', 'shadow_passed'), true);
  assert.equal(marketCandidateTransitionAllowed('shadow_passed', 'released'), false);
  assert.deepEqual(clusterEvidenceThresholdsFromEnv({}), DEFAULT_CLUSTER_EVIDENCE_THRESHOLDS);
  assert.deepEqual(clusterEvidenceThresholdsFromEnv({
    JANUS_PHASE8_CLUSTER_MIN_EVIDENCE: '20',
    JANUS_PHASE8_CLUSTER_MIN_CHAT_EVIDENCE: '6',
    JANUS_PHASE8_CLUSTER_MIN_MEMORY_EVIDENCE: '4',
    JANUS_PHASE8_CLUSTER_MIN_COMPLETED_TASK_EVIDENCE: '8',
  }), { total: 20, chat: 6, memory: 4, completedTask: 8 });
  assert.throws(() => clusterEvidenceThresholdsFromEnv({ JANUS_PHASE8_CLUSTER_MIN_EVIDENCE: '12' }),
    (error) => error.code === 'cluster_evidence_thresholds_invalid');
  assert.equal(clusterEvidenceCategory('message'), 'chat');
  assert.equal(clusterEvidenceCategory('memory_version'), 'memory');
  assert.equal(clusterEvidenceCategory('task_acceptance'), 'completedTask');
  assert.equal(clusterEvidenceCategory('market_rollback'), 'other');
  assert.equal(evolutionEvidenceClusterScopeAutomatic('market_adoption'), true);
  assert.equal(evolutionEvidenceClusterScopeAutomatic('market_rejection'), true);
  assert.equal(evolutionEvidenceClusterScopeAutomatic('market_rollback'), true);
  const familyKey = stableClusterCohortKey({ type: 'family', familyId: 'family' });
  assert.equal(familyKey, 'family:family');
  assert.equal(stableClusterCohortId(familyKey), stableClusterCohortId(familyKey));
  assert.equal(stableClusterCohortKey({ type: 'similar', departmentId: 'department', capabilityTags: ['b', 'a', 'a'] }), 'similar:department:a|b');
});

test('cluster rejected evidence reopens only for the same category or a version basis change', () => {
  const cohortKey = 'family:family';
  const evidence = [
    { evidenceId: 'chat-1', sourceKind: 'message' },
    { evidenceId: 'memory-1', sourceKind: 'memory_version' },
  ];
  const oldBasis = clusterReEvaluationBasisHash({ cohortKey, evidenceCategory: 'chat', algorithmVersion: 'algorithm', relatedEvidenceIds: ['chat-1'] });
  const unchanged = selectClusterEligibleEvidence({
    cohortKey, evidence, algorithmVersion: 'algorithm',
    usage: [{ evidenceId: 'chat-1', status: 'evaluated_rejected', reEvaluationBasisHash: oldBasis }],
  });
  assert.equal(unchanged.some((item) => item.evidenceId === 'chat-1'), false);
  const sameCategory = selectClusterEligibleEvidence({
    cohortKey, evidence: [...evidence, { evidenceId: 'chat-2', sourceKind: 'message' }], algorithmVersion: 'algorithm',
    usage: [{ evidenceId: 'chat-1', status: 'evaluated_rejected', reEvaluationBasisHash: oldBasis }],
  });
  assert.equal(sameCategory.find((item) => item.evidenceId === 'chat-1')?.eligibilityKind, 'reconsiderable');
  const versionChange = selectClusterEligibleEvidence({
    cohortKey, evidence, algorithmVersion: 'algorithm-v2',
    usage: [{ evidenceId: 'chat-1', status: 'evaluated_rejected', reEvaluationBasisHash: oldBasis }],
  });
  assert.equal(versionChange.find((item) => item.evidenceId === 'chat-1')?.eligibilityKind, 'reconsiderable');
  const consumed = selectClusterEligibleEvidence({ cohortKey, evidence, claims: [{ evidenceId: 'chat-1', claimState: 'consumed' }] });
  assert.equal(consumed.some((item) => item.evidenceId === 'chat-1'), false);
});

test('real-user Canary requires enrolled user coverage and rejects safety regressions',()=>{
  const assignments=Array.from({length:7},(_,index)=>({ownerUserId:`u${index}`,agentInstanceId:`i${index}`,status:'enrolled',baselineScore:80,baselineFailureRate:0}));
  const approved=evaluateRealUserCanary({assignments,events:assignments.map((item,index)=>({ownerUserId:item.ownerUserId,
    agentInstanceId:item.agentInstanceId,taskId:`t${index}`,accepted:true,completed:true,acceptanceScore:90}))});
  assert.equal(approved.status,'approved');assert.equal(approved.userCount,7);assert.equal(approved.caseCount,7);
  const unsafe=evaluateRealUserCanary({assignments,events:assignments.map((item,index)=>({ownerUserId:item.ownerUserId,
    agentInstanceId:item.agentInstanceId,taskId:`t${index}`,accepted:true,completed:true,acceptanceScore:90,confirmedPrivacyViolation:index===0}))});
  assert.equal(unsafe.status,'rejected');assert.equal(unsafe.reason,'canary_privacy_violation');
  const insufficient=evaluateRealUserCanary({assignments,events:approved.caseCount?[]:[]});
  assert.equal(insufficient.status,'insufficient');
});
