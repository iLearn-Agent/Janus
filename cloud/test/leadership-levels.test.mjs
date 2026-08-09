import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openCloudDatabase } from '../../src/cloud/server.js';
import { CLOUD_SCHEMA } from '../../src/cloud/modules/persistence/infrastructure/cloudSchema.js';
import { createSqliteLeadershipAuthority } from '../../src/cloud/modules/evolution/leadershipAuthority.js';
import { selectComplexTaskLeader } from '../../src/main/modules/orchestration/domain/taskContext.js';
import {
  calculateLeadershipEvaluation,
  calculateLeadershipSnapshot,
  leadershipAssignmentEligibility,
  leadershipPromotionReadiness,
} from '../../src/shared/evolution/leadership.js';

test('PostgreSQL and embedded SQLite expose the Leadership v1 contract', async () => {
  const postgres = await fs.readFile(new URL('../database/baseline-sync8.sql', import.meta.url), 'utf8');
  for (const source of [postgres, CLOUD_SCHEMA]) {
    for (const table of ['cloud_agent_leadership_events', 'cloud_agent_leadership_evaluations', 'cloud_agent_leadership_levels',
      'cloud_agent_leadership_history', 'cloud_leadership_promotion_actions', 'cloud_leadership_appeals']) assert.ok(source.includes(table), `${table} is missing`);
    for (const level of ['L0', 'L1', 'L2', 'L3']) assert.ok(source.includes(`'${level}'`), `${level} is missing`);
  }
});

test('Leadership score uses the six fixed weights and enforces assignment caps', () => {
  const evaluation = calculateLeadershipEvaluation({
    taskId: 'task', completedAt: new Date().toISOString(), evidenceRefs: ['node:1'],
    governanceReview: { deliveryQuality: 100, decompositionMatching: 80, reviewReworkControl: 70, dependencyCoordination: 60, teamEfficiencyUplift: 50 },
    deterministic: { safety: 90 },
  });
  assert.equal(evaluation.score, 78);
  assert.equal(leadershipAssignmentEligibility({ level: 'L0', role: 'task_lead', assignmentMode: 'normal' }).eligible, false);
  assert.equal(leadershipAssignmentEligibility({ level: 'L0', role: 'task_lead', assignmentMode: 'trial', participantCount: 3, nodeCount: 6,
    ownerApproved: true, professionalLevel: 'P3', professionalProvisional: false }).eligible, true);
  assert.ok(leadershipAssignmentEligibility({ level: 'L1', role: 'task_lead', participantCount: 4 }).reasons.includes('agent_limit_exceeded'));
  assert.ok(leadershipAssignmentEligibility({ level: 'L2', role: 'team_lead', participantCount: 6, nodeCount: 13 }).reasons.includes('node_limit_exceeded'));
  assert.equal(leadershipAssignmentEligibility({ level: 'L3', role: 'cross_team_lead', participantCount: 20, nodeCount: 20,
    taskGroupCount: 4, departmentCount: 3 }).eligible, true);
});

test('Task leader selection prefers eligible personal L level over legacy template rank', () => {
  const selection = selectComplexTaskLeader({
    agents: [
      { id: 'legacy_lead', rank: 'lead', routable: true, departmentId: 'general' },
      { id: 'personal_l2', rank: 'specialist', routable: true, departmentId: 'general' },
    ],
    candidates: [
      { agentId: 'legacy_lead', leadershipLevel: 'L0', leadershipScore: 0, leadershipStatus: 'active' },
      { agentId: 'personal_l2', leadershipLevel: 'L2', leadershipScore: 82, leadershipStatus: 'active' },
    ],
    prompt: 'Coordinate a complex delivery', departmentId: 'general',
  });
  assert.equal(selection.agentId, 'personal_l2');
  assert.equal(selection.leadershipEligible, true);
  assert.equal(selection.coordinationMode, 'appointed_agent_leader');
});

test('Leadership snapshots are provisional below five tasks and require baseline trials for higher levels', () => {
  const now = new Date();
  const evaluations = Array.from({ length: 15 }, (_, index) => strongEvaluation(index, {
    role: index < 2 ? 'team_lead' : 'task_lead', assignmentMode: index < 2 ? 'trial' : 'normal', baselineUplift: 4,
  }));
  assert.equal(calculateLeadershipSnapshot(evaluations.slice(0, 4), { now }).provisional, true);
  const snapshot = calculateLeadershipSnapshot(evaluations, { now, currentLevel: 'L1' });
  const readiness = leadershipPromotionReadiness({ currentLevel: 'L1', score: snapshot.score, taskCount: snapshot.leadershipTaskCount,
    teamLeadTrialCount: snapshot.teamLeadTrialCount, baselineComparisonCount: snapshot.baselineComparisonCount, baselineUplift: snapshot.baselineUplift,
    professionalLevel: 'P5', professionalProvisional: false });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.targetLevel, 'L2');
});

test('SQLite cloud authority promotes L0 automatically, proposes L2, and freezes severe violations', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-leadership-'));
  const db = openCloudDatabase(home);
  t.after(async () => { db.close(); await fs.rm(home, { recursive: true, force: true }); });
  const baseTime = Date.now();
  const now = new Date(baseTime).toISOString();
  db.prepare("INSERT INTO users(id,email,display_name,username,password_hash) VALUES('user','leader@example.test','Leader','leader','hash')").run();
  db.prepare(`INSERT INTO cloud_agent_families_v3(id,name,status,routable,instance_kind,recruitable,payload_json,updated_at)
    VALUES('family','Family','active',1,'employee',1,'{}',?)`).run(now);
  db.prepare(`INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,status,sync_enabled,instance_kind,employment_state,payload_json,created_at,updated_at)
    VALUES('user','instance','family','active',1,'employee','active','{}',?,?)`).run(now, now);
  db.prepare(`INSERT INTO cloud_agent_performance_levels(user_agent_instance_id,agent_family_id,score,level,provisional,completed_task_count,payload_json)
    VALUES('instance','family',65,'P6',0,20,'{}')`).run();
  const authority = createSqliteLeadershipAuthority({ db });
  authority.ensureProfiles();
  const l1Trial = authority.requestTrial({ ownerUserId: 'user', agentInstanceId: 'instance', role: 'task_lead', participantCount: 3,
    nodeCount: 6, departmentCount: 1, commandId: 'trial_l1', expectedStateRevision: 0 });
  assert.equal(l1Trial.action, 'trial_approved');
  assert.equal(l1Trial.status, 'approved');
  await assert.rejects(authority.evaluateTask({ ownerUserId: 'user', agentInstanceId: 'instance', taskId: 'not_synced',
    deterministic: { deliveryQuality: 100 } }), (error) => error.code === 'leadership_task_not_synchronized');
  for (let index = 0; index < 5; index += 1) await authority.evaluateTask({ ownerUserId: 'user', agentInstanceId: 'instance', trustedGovernanceReview: true,
    ...strongEvaluation(index, { assignmentMode: 'trial', completedAt: new Date(baseTime - index * 1000).toISOString() }) });
  const firstL1Window = authority.calculate({ agentInstanceId: 'instance', now: new Date(baseTime) });
  assert.equal(firstL1Window.level, 'L0');
  assert.equal(firstL1Window.promotion.evidenceReady, true);
  for (let index = 5; index < 7; index += 1) await authority.evaluateTask({ ownerUserId: 'user', agentInstanceId: 'instance', trustedGovernanceReview: true,
    ...strongEvaluation(index, { assignmentMode: 'trial', completedAt: new Date(baseTime + 31 * 86400000 + index * 1000).toISOString() }) });
  const promoted = authority.calculate({ agentInstanceId: 'instance', now: new Date(baseTime + 31 * 86400000) });
  assert.equal(promoted.level, 'L1');
  assert.equal(authority.actions({ ownerUserId: 'user', agentInstanceId: 'instance' }).some((item) => item.action === 'promote' && item.status === 'approved'), true);

  for (let index = 7; index < 15; index += 1) await authority.evaluateTask({ ownerUserId: 'user', agentInstanceId: 'instance', trustedGovernanceReview: true,
    ...strongEvaluation(index, { role: index < 9 ? 'team_lead' : 'task_lead', assignmentMode: index < 9 ? 'trial' : 'normal', baselineUplift: 4,
      completedAt: new Date(baseTime + 62 * 86400000 + index * 1000).toISOString() }) });
  const firstL2Window = authority.calculate({ agentInstanceId: 'instance', now: new Date(baseTime + 62 * 86400000) });
  assert.equal(firstL2Window.promotion.evidenceReady, true);
  assert.equal(firstL2Window.promotion.ready, false);
  for (let index = 15; index < 20; index += 1) await authority.evaluateTask({ ownerUserId: 'user', agentInstanceId: 'instance', trustedGovernanceReview: true,
    ...strongEvaluation(index, { baselineUplift: 4, completedAt: new Date(baseTime + 93 * 86400000 + index * 1000).toISOString() }) });
  const l2Ready = authority.calculate({ agentInstanceId: 'instance', now: new Date(baseTime + 93 * 86400000) });
  assert.equal(l2Ready.promotion.targetLevel, 'L2');
  assert.equal(l2Ready.promotion.ready, true);
  const proposal = authority.actions({ ownerUserId: 'user', agentInstanceId: 'instance' }).find((item) => item.toLevel === 'L2' && item.status === 'pending');
  assert.ok(proposal);
  assert.throws(() => authority.decideAction({ actorUserId: 'user', actorRole: 'member', actionId: proposal.id, decision: 'approve' }),
    (error) => error.code === 'leadership_governance_required');
  assert.throws(() => authority.decideAction({ actorUserId: 'admin', actorRole: 'admin', actionId: proposal.id, decision: 'approve', expectedStateRevision: 99 }),
    (error) => error.code === 'leadership_revision_conflict');
  authority.decideAction({ actorUserId: 'admin', actorRole: 'admin', actionId: proposal.id, decision: 'approve', commandId: 'approve_l2', expectedStateRevision: l2Ready.stateRevision });
  assert.equal(authority.status({ agentInstanceId: 'instance' }).level, 'L2');
  assert.throws(() => authority.requestTrial({ ownerUserId: 'user', agentInstanceId: 'instance', role: 'cross_team_lead', participantCount: 20,
    nodeCount: 20, departmentCount: 2, commandId: 'trial_l3_denied' }), (error) => error.code === 'leadership_trial_ineligible');
  db.prepare("UPDATE cloud_agent_performance_levels SET level='P7',provisional=0 WHERE user_agent_instance_id='instance'").run();
  const l3TrialRequest = authority.requestTrial({ ownerUserId: 'user', agentInstanceId: 'instance', role: 'cross_team_lead', participantCount: 20,
    nodeCount: 20, departmentCount: 2, commandId: 'trial_l3' });
  assert.equal(l3TrialRequest.action, 'trial_requested');
  assert.equal(l3TrialRequest.status, 'pending');

  await authority.evaluateTask({ ownerUserId: 'user', agentInstanceId: 'instance', trustedGovernanceReview: true,
    ...strongEvaluation(20, { severeSafetyViolation: true, completedAt: new Date(baseTime + 93 * 86400000 + 25000).toISOString() }) });
  const frozen = authority.calculate({ agentInstanceId: 'instance', now: new Date(baseTime + 93 * 86400000 + 30000) });
  assert.equal(frozen.status, 'frozen');
  const restoreRequest = authority.restore({ ownerUserId: 'user', agentInstanceId: 'instance', commandId: 'restore' });
  assert.equal(restoreRequest.status, 'pending');
  assert.equal(authority.status({ agentInstanceId: 'instance' }).status, 'frozen');
  authority.decideAction({ actorUserId: 'admin', actorRole: 'admin', actionId: restoreRequest.id, decision: 'approve', expectedStateRevision: frozen.stateRevision });
  assert.equal(authority.status({ agentInstanceId: 'instance' }).status, 'active');
  assert.equal(authority.calculate({ agentInstanceId: 'instance', now: new Date(baseTime + 93 * 86400000 + 40000) }).status, 'active', 'reviewed severe evidence must not immediately refreeze');

  const appeal = authority.submitAppeal({ ownerUserId: 'user', agentInstanceId: 'instance', appealKind: 'assessment', reason: 'Evidence mismatch.', commandId: 'appeal' });
  assert.equal(appeal.status, 'pending');
  authority.decideAppeal({ actorUserId: 'admin', actorRole: 'admin', appealId: appeal.id, decision: 'reject', reason: 'Evidence verified.' });
  assert.equal(authority.appeals({ ownerUserId: 'user', agentInstanceId: 'instance' })[0].status, 'rejected');
});

function strongEvaluation(index, { role = 'task_lead', assignmentMode = 'normal', baselineUplift = 3, severeSafetyViolation = false,
  completedAt = new Date(Date.now() - index * 60000).toISOString() } = {}) {
  return {
    taskId: `task_${index}`, assignmentId: `assignment_${index}`, role, assignmentMode, completedAt,
    participantCount: 3, departmentCount: role === 'cross_team_lead' ? 2 : 1, evidenceRefs: [`node:${index}`],
    governanceReview: { deliveryQuality: 90, decompositionMatching: 88, reviewReworkControl: 86, dependencyCoordination: 85, teamEfficiencyUplift: 80, evidenceRefs: [`event:${index}`] },
    deterministic: { safety: severeSafetyViolation ? 0 : 100, severeSafetyViolation },
    baseline: { available: true, kind: 'historical', sampleCount: 5, uplift: baselineUplift, passed: baselineUplift > 0 },
    evaluatorVersion: 'test_v1',
  };
}
