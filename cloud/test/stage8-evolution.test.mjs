import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createStage8Authority } from '../../src/cloud/modules/evolution/index.js';
import { createSqliteEvidenceUsageLedger } from '../../src/cloud/modules/evolution/evidenceUsageLedger.js';
import { openCloudDatabase } from '../../src/cloud/server.js';
import { encryptEvolutionPayload } from '../../src/shared/evolution/crypto.js';
import { buildCohortEligibility, calculatePerformanceSnapshot, capClusterEvidenceWeights, enrichPerformanceEventsWithPeerBaselines, performanceLevel } from '../../src/shared/evolution/phase8.js';
import { stableEvolutionEvidenceId } from '../../src/shared/evolution/contracts.js';

test('Stage 8 performance boundaries and final-total user cap', () => {
  assert.equal(performanceLevel(19.99), 'P1');
  assert.equal(performanceLevel(20), 'P2');
  assert.equal(performanceLevel(87.99), 'P8');
  assert.equal(performanceLevel(88), 'P9');
  assert.equal(performanceLevel(95), 'P10');
  const provisional = calculatePerformanceSnapshot([performanceEvent(0)]);
  assert.equal(provisional.provisional, true);
  assert.ok(provisional.contributionWeight <= 1);
  const deduplicated = calculatePerformanceSnapshot([
    ...Array.from({ length: 10 }, (_, index) => performanceEvent(index)),
    { ...performanceEvent(0), occurredAt: new Date().toISOString(), completedAt: new Date().toISOString(), rework: true, firstPass: false },
  ]);
  assert.equal(deduplicated.completedTaskCount, 10);
  assert.equal(deduplicated.provisional, false);
  const evidence = [
    { evidenceId: 'u1a', ownerUserId: 'u1', rawWeight: 8 }, { evidenceId: 'u1b', ownerUserId: 'u1', rawWeight: 2 },
    ...Array.from({ length: 6 }, (_, index) => ({ evidenceId: `u${index + 2}`, ownerUserId: `u${index + 2}`, rawWeight: 1 })),
  ];
  const capped = capClusterEvidenceWeights(evidence);
  const total = capped.reduce((sum, item) => sum + item.effectiveWeight, 0);
  const byUser = userWeights(capped);
  for (const weight of byUser.values()) assert.ok(weight / total <= 0.15 + 1e-10);
  assert.ok(total < evidence.reduce((sum, item) => sum + item.rawWeight, 0));
  assert.ok(Math.abs(capped.find((item) => item.evidenceId === 'u1a').effectiveWeight / capped.find((item) => item.evidenceId === 'u1b').effectiveWeight - 4) < 1e-10);
  assert.deepEqual(userWeights(capClusterEvidenceWeights([...evidence].reverse())), byUser);
  const equal = capClusterEvidenceWeights(Array.from({ length: 7 }, (_, index) => ({ ownerUserId: `equal${index}`, rawWeight: 1 })));
  const equalTotal = equal.reduce((sum, item) => sum + item.effectiveWeight, 0);
  equal.forEach((item) => assert.ok(Math.abs(item.effectiveWeight / equalTotal - 1 / 7) < 1e-10));
  assert.throws(() => capClusterEvidenceWeights(Array.from({ length: 6 }, (_, index) => ({ ownerUserId: `short${index}`, rawWeight: 1 }))), (error) => error.code === 'insufficient_users_for_weight_cap');
  const sixUserCohort = buildCohortEligibility({
    instances: Array.from({ length: 6 }, (_, index) => ({ ownerUserId: `short${index}`, agentInstanceId: `short_i${index}`, agentFamilyId: 'family', status: 'active', syncEnabled: true })),
    evidence: [{ agentInstanceId: 'short_i0', sourceKind: 'task_result' }],
  })[0];
  assert.equal(sixUserCohort.eligible, false);
  assert.ok(sixUserCohort.eligibilityReasons.includes('insufficient_users'));
  const thresholdFallback = buildCohortEligibility({
    instances: Array.from({ length: 7 }, (_, index) => ({ ownerUserId: `fallback_u${index}`, agentInstanceId: `fallback_i${index}`, agentFamilyId: 'fallback_family', departmentId: 'department', capabilityTags: ['delivery'], status: 'active', syncEnabled: true })),
    evidence: Array.from({ length: 15 }, (_, index) => ({ agentInstanceId: `fallback_i${index % 7}`, evidenceId: `fallback_e${index}`, sourceKind: 'task_result' })),
    evidenceThresholds: { total: 15, chat: 5, memory: 3, completedTask: 5 },
  });
  assert.ok(thresholdFallback.find((item) => item.type === 'family')?.eligibilityReasons.includes('insufficient_chat_evidence'));
  assert.ok(thresholdFallback.some((item) => item.type === 'similar' && item.fallbackReason === 'family_ineligible'));
});

test('performance V2 counts completed tasks only and replaces client peer baselines', () => {
  const accepted = Array.from({ length: 8 }, (_, index) => ({ ...performanceEvent(index), agentInstanceId: 'target', agentFamilyId: 'family', completed: true }));
  const snapshot = calculatePerformanceSnapshot([
    ...accepted,
    { taskId: 'blocked', agentInstanceId: 'target', agentFamilyId: 'family', eventKind: 'task_blocked', completedAt: new Date().toISOString(), blocked: true, terminal: true },
    { taskId: 'cancelled', agentInstanceId: 'target', agentFamilyId: 'family', eventKind: 'task_cancelled', completedAt: new Date().toISOString(), cancelled: true, terminal: false },
  ]);
  assert.equal(snapshot.completedTaskCount, 8);
  assert.equal(snapshot.terminalAttemptCount, 9);
  assert.equal(snapshot.provisional, true);
  const target = { ...performanceEvent(20), taskId: 'target', agentInstanceId: 'target', agentFamilyId: 'family', completed: true, peerMedianMinutes: 999 };
  const peers = [10,12,14,16,18].map((actualMinutes, index) => ({ ...performanceEvent(30 + index), taskId: `peer_${index}`,
    agentInstanceId: `peer_${index}`, agentFamilyId: 'family', completed: true, actualMinutes }));
  const enriched = enrichPerformanceEventsWithPeerBaselines([target], [target, ...peers]);
  assert.equal(enriched[0].peerMedianMinutes, 14);
  assert.equal(enriched[0].peerBaselineKind, 'task_type');
  assert.equal(enriched[0].peerSampleCount, 5);
});

test('embedded performance ingestion accepts task references and ignores submitted scores', async (t) => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'janus-performance-authority-'));const db=openCloudDatabase(home);t.after(()=>db.close());
  const keyring={activeKeyId:'test',keys:{test:Buffer.alloc(32,4).toString('base64')}};const now=new Date().toISOString();
  db.prepare("INSERT INTO cloud_agent_families_v3(id,name,updated_at) VALUES('family','Family',?)").run(now);
  db.prepare("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,created_at) VALUES('base','family',?)").run(now);
  db.prepare(`INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,cluster_contribution_consent,created_at,updated_at)
    VALUES('authority_user','authority_instance','family','base','active',1,1,1,?,?)`).run(now,now);
  insertSqlitePerformanceTasks(db,{userId:'authority_user',instanceId:'authority_instance',familyId:'family',count:1,now});
  const stage8=createStage8Authority({db,modelExecutor:async()=>'{"decision":"pass"}',keyring});
  const rejected=stage8.recordPerformanceEvents([{ownerUserId:'authority_user',agentInstanceId:'authority_instance',eventKind:'task_accepted',acceptanceScore:1}]);
  assert.equal(rejected.inserted,0);assert.equal(rejected.rejected[0].code,'performance_source_reference_required');
  const deferred=stage8.recordPerformanceEvents([{ownerUserId:'authority_user',agentInstanceId:'authority_instance',sourceKind:'task_node',sourceId:'not_synced_yet'}]);
  assert.equal(deferred.inserted,0);assert.equal(deferred.deferred[0].code,'performance_source_not_ready');
  const foreign=stage8.recordPerformanceEvents([{ownerUserId:'another_user',agentInstanceId:'authority_instance',sourceKind:'task_node',sourceId:'authority_instance_node_0'}]);
  assert.equal(foreign.inserted,0);assert.equal(foreign.rejected[0].code,'performance_source_identity_mismatch');
  const acceptedResult=stage8.recordPerformanceEvents([{ownerUserId:'authority_user',agentInstanceId:'authority_instance',sourceKind:'task_node',
    sourceId:'authority_instance_node_0',acceptanceScore:1,peerMedianMinutes:999,securityViolationCount:99}]);
  assert.equal(acceptedResult.inserted,1);
  const stored=JSON.parse(db.prepare("SELECT payload_json FROM cloud_agent_performance_events WHERE authority='cloud'").get().payload_json);
  assert.equal(stored.acceptanceScore,90);assert.equal(stored.securityViolationCount,0);
  const level=stage8.calculatePerformance({agentInstanceId:'authority_instance'});
  assert.equal(level.algorithmVersion,'performance_90d_100tasks_v2');assert.equal(level.completedTaskCount,1);
  assert.equal(level.peerBaselineKind,'estimate');assert.equal(level.provisional,true);
});

test('Stage 8 waits at Shadow, then publishes an immutable market base after a default-on real-user Canary', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-stage8-'));
  const db = openCloudDatabase(home);
  t.after(() => db.close());
  const keyring = { activeKeyId: 'test', keys: { test: Buffer.alloc(32, 8).toString('base64') } };
  const env = { JANUS_MARKET_CANARY_MIN_DURATION_MS: '0', JANUS_MARKET_CANARY_MAX_DURATION_MS: '60000' };
  const modelExecutor = async ({ kind, prompt }) => {
    if (kind === 'cluster_proposal') return JSON.stringify({
      summary: 'Shared verification procedure',
      sections: [{ section_id: 'verification.workflow', title: 'Verification Workflow', content: 'Always verify output before delivery.', capability_tags: ['verification'], conflict_keys: ['verify'], supporting_instance_ids: ['i0', 'i1', 'i2'] }],
      eval_cases: [{ input: 'Deliver an artifact', expected: 'Verify it first' }], risks: ['Over-verification'],
    });
    if (kind === 'cluster_governance_review') return JSON.stringify({ decision: 'full', rationale: 'Within family role.', approved_section_ids: ['verification.workflow'] });
    if (kind === 'cluster_support_review') return JSON.stringify({ decision: 'supported', supported_evidence_handles: JSON.parse(prompt).evidence.map((item) => item.evidence_handle) });
    if (kind === 'cluster_privacy_review') return JSON.stringify({ decision: 'pass', flags: [], rationale: 'Public and reusable.' });
    if (kind === 'cluster_replay_judge') return JSON.stringify({ winner: 'candidate', baseline_score: 0.7, candidate_score: 0.9, privacy_violation: false, role_violation: false, rationale: 'Improved.' });
    return 'Verified response.';
  };
  const stage8 = createStage8Authority({ db, env, modelExecutor, keyring });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json,updated_at) VALUES('family','department','Family',?,?)").run(JSON.stringify({ capabilityTags: ['verification'] }), now);
  db.prepare("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json,created_at) VALUES('base','family',?,?)").run(JSON.stringify({ baseSkillContent: 'Base skill.' }), now);
  for (let userIndex = 0; userIndex < 7; userIndex += 1) {
    const userId = `u${userIndex}`;
    const instanceId = `i${userIndex}`;
    db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,cluster_contribution_consent,payload_json,created_at,updated_at)
      VALUES (?,?, 'family','base','active',1,1,1,'{}',?,?)`).run(userId, instanceId, now, now);
    insertSqlitePerformanceTasks(db,{userId,instanceId,familyId:'family',count:10,now});
    for (let evidenceIndex = 0; evidenceIndex < 3; evidenceIndex += 1) {
      const content = `Repeated verification evidence ${userIndex}-${evidenceIndex}`;
      const contentHash = sha256(content);
      const identity = { ownerUserId: userId, userAgentInstanceId: instanceId, sourceKind: 'task_result', sourceId: `${instanceId}_e${evidenceIndex}`, sourceVersionId: '', contentHash };
      const evidenceId = stableEvolutionEvidenceId(identity);
      const encrypted = encryptEvolutionPayload(content, keyring);
      db.prepare(`INSERT INTO cloud_evolution_evidence (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,content_ciphertext,content_nonce,content_tag,encryption_algorithm,key_id,confidence,occurred_at,metadata_json)
        VALUES (?,?,?,'family','task_result',?,?,?,?,?,?,?,1,?,?)`).run(evidenceId, userId, instanceId, identity.sourceId, contentHash, encrypted.ciphertext, encrypted.nonce, encrypted.tag, encrypted.algorithm, encrypted.keyId, now, JSON.stringify({ taskRelevance: 1, acceptanceQuality: 1, allowedEvolutionScopes: ['cluster'] }));
    }
    if (userIndex < 5) insertEvidence(db, keyring, { userId, instanceId, familyId: 'family', sourceKind: 'message', sourceId: `${instanceId}_chat`, content: `chat evidence ${instanceId}`, now });
    if (userIndex < 3) insertEvidence(db, keyring, { userId, instanceId, familyId: 'family', sourceKind: 'memory_version', sourceId: `${instanceId}_memory`, sourceVersionId: `${instanceId}_memory_v1`, content: `memory evidence ${instanceId}`, now });
  }
  const eligibility = stage8.refreshCohorts();
  const eligible = eligibility.find((item) => item.eligible);
  assert.ok(eligible);
  assert.equal(eligible.userCount, 7);
  assert.equal(eligible.evidenceBreakdown.chat, 5);
  assert.equal(eligible.evidenceBreakdown.memory, 3);
  db.prepare("INSERT OR IGNORE INTO cloud_user_evolution_preferences(user_id,enabled) VALUES('u0',1)").run();
  db.prepare("UPDATE cloud_user_evolution_preferences SET enabled=0 WHERE user_id='u0'").run();
  assert.equal(db.prepare("SELECT enabled FROM cloud_user_evolution_preferences WHERE user_id='u0'").get().enabled, 1,
    'the cloud database must normalize direct legacy pause writes');
  const mandatoryCohort = stage8.refreshCohorts().find((item) => item.cohortKey === eligible.cohortKey);
  assert.equal(mandatoryCohort.eligible, true);
  assert.equal(mandatoryCohort.userCount, 7, 'mandatory upload keeps every synchronized account in cluster cohorts');
  assert.equal(stage8.refreshCohorts().find((item) => item.cohortKey === eligible.cohortKey).id, eligible.id);
  assert.deepEqual(stage8.capabilities().cluster.evidenceThresholds, { total: 15, chat: 5, memory: 3, completedTask: 5 });
  const queued = stage8.requestClusterRun({ cohortId: eligible.id });
  assert.equal(queued.status, 'queued');
  const selectedEvidenceCount = queued.run.evidenceCount;
  assert.ok(selectedEvidenceCount >= 29);
  db.prepare("UPDATE cloud_evolution_jobs SET status='claimed',claimed_by='dead_worker',lease_expires_at='2020-01-01T00:00:00.000Z',attempt_count=1").run();
  const proposalWorker = await stage8.tickClusterWorker();
  assert.equal(proposalWorker.completed[0].status, 'governance_approved', JSON.stringify(proposalWorker.completed[0]));
  const supportRows=db.prepare('SELECT * FROM cloud_market_candidate_section_supports').all();
  assert.ok(new Set(supportRows.map((item)=>item.contributor_id)).size>=3);
  assert.ok(supportRows.every((item)=>Number(item.support_confidence)>=0.8&&item.deterministic_pass&&item.reviewer_pass));
  const candidateSection=db.prepare('SELECT content_json,support_count FROM cloud_market_candidate_family_sections').get();
  assert.equal(JSON.stringify(candidateSection.content_json).includes('supportingInstanceIds'),false);
  assert.ok(Number(candidateSection.support_count)>=3);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_market_candidate_privacy_reviews WHERE review_stage='final_pre_shadow' AND reviewer_status='passed'").get().count,1);
  assert.equal(stage8.marketVersions({ familyId: 'family' }).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_cluster_evidence_claims WHERE claim_state='reserved'").get().count, selectedEvidenceCount);
  const worker = await stage8.tickClusterWorker();
  assert.equal(worker.completed[0].status, 'shadow_passed', JSON.stringify(worker.completed[0]));
  assert.equal(stage8.requestClusterRun({ cohortId: eligible.id }).status, 'deferred');
  assert.equal(stage8.marketVersions({ familyId: 'family' }).length, 0);
  assert.equal(db.prepare('SELECT status FROM cloud_market_agent_candidates').get().status, 'shadow_passed');
  assert.equal(db.prepare('SELECT status FROM cloud_evolution_jobs').get().status, 'waiting_canary');
  const defaultCanary=stage8.canaryStatus({userId:'u1',agentInstanceId:'i1'});
  assert.equal(defaultCanary.optedIn,true);
  assert.equal(defaultCanary.defaultEnrolled,true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM cloud_cluster_run_evidence').get().count, selectedEvidenceCount);
  const persistedWeights = db.prepare(`SELECT e.owner_user_id user_id,SUM(w.effective_weight) weight
    FROM cloud_cluster_run_evidence w JOIN cloud_evolution_evidence e ON e.evidence_id=w.evidence_id GROUP BY e.owner_user_id`).all();
  const persistedTotal = persistedWeights.reduce((sum, row) => sum + Number(row.weight), 0);
  persistedWeights.forEach((row) => assert.ok(Number(row.weight) / persistedTotal <= 0.15 + 1e-10));
  const clusterUsage = db.prepare("SELECT status,COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster' GROUP BY status").all();
  assert.equal(clusterUsage.find((row) => row.status === 'reserved').count, selectedEvidenceCount);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_cluster_evidence_claims WHERE claim_state='reserved'").get().count, selectedEvidenceCount);
  assert.ok(db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evolution_scope='personal'").get().count > 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evolution_scope='personal' AND status<>'available'").get().count, 0);
  assert.equal(createSqliteEvidenceUsageLedger(db).releaseExpired({ now: '2099-01-01T00:00:00.000Z' }), 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster' AND status='reserved'").get().count, selectedEvidenceCount);

  db.prepare(`INSERT INTO cloud_market_agent_versions
    (id,agent_family_id,parent_version_id,version_kind,status,sections_json,payload_json,created_at)
    VALUES ('legacy_market','family','','legacy_sections','released','["verification.workflow"]','{}',?)`).run(now);
  db.prepare(`INSERT INTO cloud_market_version_sections
    (market_version_id,section_id,title,content_hash,content_json,ordinal,created_at)
    VALUES ('legacy_market','verification.workflow','Verification Workflow',?,?,0,?)`).run(
    sha256('Always verify output before delivery.'), JSON.stringify({ sectionId: 'verification.workflow', title: 'Verification Workflow',
      content: 'Always verify output before delivery.', contentHash: sha256('Always verify output before delivery.'), conflictKeys: ['verify'] }), now);
  const version = stage8.marketVersions({ familyId: 'family' })[0];
  assert.equal(version.versionKind, 'legacy_sections');

  db.prepare(`INSERT INTO cloud_user_agent_skill_versions_v3 (user_id,id,user_agent_instance_id,base_agent_version_id,authority,stability_status,status,payload_json,created_at,updated_at)
    VALUES ('u0','overlay','i0','base','cloud','stable','active',?, ?, ?)`).run(JSON.stringify({ overlayText: 'Use my personal verify rule.' }), now, now);
  db.prepare("UPDATE cloud_user_agent_instances_v3 SET active_personal_skill_version_id='overlay' WHERE user_id='u0' AND id='i0'").run();
  db.prepare("UPDATE cloud_user_evolution_preferences SET enabled=0 WHERE user_id='u0'").run();
  assert.equal(stage8.setCanaryOptIn({ userId: 'u0', agentInstanceId: 'i0', enabled: false }).optedIn, false);
  assert.equal(stage8.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id, action: 'ignore' }).status, 'ignored');
  stage8.reconcileMarketCanaries();
  const persistedOptOut = stage8.canaryStatus({ userId: 'u0', agentInstanceId: 'i0' });
  assert.equal(persistedOptOut.optedIn, false, 'default enrollment must preserve an explicit Canary opt-out');
  assert.equal(persistedOptOut.explicitlyOptedOut, true);
  const preview = stage8.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id });
  assert.equal(preview.status, 'conflict_required');
  assert.equal(preview.conflicts[0].sectionId, 'verification.workflow');
  const personalWins = stage8.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id, conflictResolutions: { 'verification.workflow': 'personal' } });
  assert.equal(personalWins.conflicts[0].resolution, 'personal');
  assert.equal(personalWins.effectiveSkill.includes('Always verify output'), false);
  assert.equal(personalWins.effectiveSkill.includes('Base skill.'), true);
  assert.throws(() => stage8.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id,
    conflictResolutions: { 'verification.workflow': 'market' }, expectedEffectiveSkillHash: 'stale_hash' }),
  (error) => error.code === 'market_skill_conflict' && error.details.currentEffectiveSkillHash === personalWins.effectiveSkillHash);
  const marketWins = stage8.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id,
    conflictResolutions: { 'verification.workflow': 'market' }, expectedEffectiveSkillHash: personalWins.effectiveSkillHash,
    commandId: 'market_wins_once' });
  assert.equal(marketWins.effectiveSkill.includes('Always verify output'), true);
  assert.equal(stage8.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id,
    conflictResolutions: { 'verification.workflow': 'market' }, expectedEffectiveSkillHash: 'stale_after_success',
    commandId: 'market_wins_once' }).idempotent, true);
  stage8.refreshCohorts();
  const marketEvidence=db.prepare("SELECT * FROM cloud_evolution_evidence WHERE source_kind='market_adoption' ORDER BY occurred_at DESC LIMIT 1").get();
  assert.ok(JSON.parse(marketEvidence.metadata_json).allowedEvolutionScopes.includes('cluster'));
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evidence_id=? AND evolution_scope='personal'").get(marketEvidence.evidence_id).count,1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evidence_id=? AND evolution_scope='cluster'").get(marketEvidence.evidence_id).count,1);
  db.prepare("UPDATE cloud_user_evolution_preferences SET enabled=0 WHERE user_id='u0'").run();
  const rollback = stage8.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id, action: 'rollback',
    expectedEffectiveSkillHash: marketWins.effectiveSkillHash });
  assert.equal(rollback.adoptedSections.length, 0);
  const candidateId = db.prepare('SELECT id FROM cloud_market_agent_candidates').get().id;
  assert.equal(stage8.setCanaryOptIn({userId:'u0',agentInstanceId:'i0',enabled:true}).optedIn,true);
  const started=await stage8.tickClusterWorker();
  assert.equal(started.completed.find((item)=>item.candidateId===candidateId)?.status,'canary_running');
  assert.equal(stage8.effectiveSkill({userId:'u1',agentInstanceId:'i1'}).canaryCandidateId,candidateId);
  const canaryStartedAt=db.prepare('SELECT canary_started_at FROM cloud_market_agent_candidates WHERE id=?').get(candidateId).canary_started_at;
  for(let index=0;index<7;index+=1)insertSqliteCanaryPerformanceEvent(db,{userId:`u${index}`,instanceId:`i${index}`,familyId:'family',candidateId,startedAt:canaryStartedAt});
  const released=await stage8.tickClusterWorker();
  assert.equal(released.completed.find((item)=>item.candidateId===candidateId)?.status,'released',JSON.stringify(released));
  const marketBase=stage8.marketVersions({familyId:'family'}).find((item)=>item.id!=='legacy_market');
  assert.equal(marketBase.versionKind,'market_base');
  assert.equal(marketBase.baseAgentVersionId,'base');
  const fullBase=stage8.adopt({userId:'u1',agentInstanceId:'i1',marketVersionId:marketBase.id});
  assert.equal(fullBase.fullMarketVersionId,marketBase.id);
  assert.equal(fullBase.effectiveSkill.includes('Base skill.'),true);
  assert.equal(fullBase.effectiveSkill.includes('Always verify output before delivery.'),true);
  const overlayPreview=stage8.adopt({userId:'u0',agentInstanceId:'i0',marketVersionId:marketBase.id});
  assert.equal(overlayPreview.status,'conflict_required');
  const overlayPreserved=stage8.adopt({userId:'u0',agentInstanceId:'i0',marketVersionId:marketBase.id,
    conflictResolutions:{'verification.workflow':'personal'}});
  assert.equal(overlayPreserved.effectiveSkill.includes('Use my personal verify rule.'),true);
  assert.equal(overlayPreserved.effectiveSkill.includes('Always verify output before delivery.'),false);
  assert.throws(()=>db.prepare("UPDATE cloud_market_agent_versions SET payload_json='{}' WHERE id=?").run(marketBase.id),/immutable/);
  assert.throws(()=>db.prepare("DELETE FROM cloud_market_version_sections WHERE market_version_id=?").run(marketBase.id),/immutable/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_cluster_evidence_claims WHERE claim_state='consumed'").get().count,selectedEvidenceCount);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster' AND status='consumed'").get().count,selectedEvidenceCount);
});

test('Stage 8 remains enabled without a feature flag while model-dependent execution stays paused', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-stage8-disabled-'));
  const db = openCloudDatabase(home);
  t.after(() => db.close());
  const stage8 = createStage8Authority({ db, env: {} });
  assert.deepEqual(stage8.refreshCohorts(), []);
  assert.equal(stage8.capabilities().performance.enabled, true);
  assert.equal(stage8.capabilities().cluster.executionAvailable, false);
  assert.equal(stage8.capabilities().market.queryAvailable, true);
  assert.equal(stage8.capabilities().market.adoptionAvailable, false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM cloud_agent_cohorts').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM cloud_market_agent_versions').get().count, 0);
});

test('Stage 8 reports execution readiness separately from performance availability', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-stage8-readiness-'));
  const db = openCloudDatabase(home);
  t.after(() => db.close());
  const stage8 = createStage8Authority({ db, env: {} });
  const capabilities = stage8.capabilities();
  assert.equal(capabilities.performance.mutationEnabled, true);
  assert.equal(capabilities.cluster.enabled, true);
  assert.equal(capabilities.cluster.executionAvailable, false);
  assert.equal(capabilities.market.candidateGenerationAvailable,false);
  assert.equal(capabilities.market.publishingAvailable,true);
  assert.equal(capabilities.cluster.realCanaryAvailable,true);
});

test('Stage 8 skips cluster jobs when selected evidence has fewer than seven positive-weight users', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-stage8-weight-cap-'));
  const db = openCloudDatabase(home);
  t.after(() => db.close());
  const keyring = { activeKeyId: 'test', keys: { test: Buffer.alloc(32, 7).toString('base64') } };
  const stage8 = createStage8Authority({ db, env: {}, modelExecutor: async () => '{}', keyring });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json,updated_at) VALUES('family','department','Family',?,?)").run(JSON.stringify({ capabilityTags: ['verification'] }), now);
  db.prepare("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json,created_at) VALUES('base','family','{}',?)").run(now);
  for (let index = 0; index < 7; index += 1) {
    const userId = `cap_u${index}`;
    const instanceId = `cap_i${index}`;
    db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,cluster_contribution_consent,payload_json,created_at,updated_at)
      VALUES (?,?, 'family','base','active',1,1,'{}',?,?)`).run(userId, instanceId, now, now);
    const evidenceCount = index === 6 ? 1 : 30;
    const occurredAt = index === 6 ? new Date(Date.parse(now) - 86400000).toISOString() : now;
    for (let evidenceIndex = 0; evidenceIndex < evidenceCount; evidenceIndex += 1) insertEvidence(db, keyring, { userId, instanceId, familyId: 'family', sourceId: `${instanceId}_${evidenceIndex}`, content: `weight cap evidence ${instanceId}-${evidenceIndex}`, now: occurredAt });
  }
  for (let index = 0; index < 5; index += 1) insertEvidence(db, keyring, { userId: `cap_u${index}`, instanceId: `cap_i${index}`, familyId: 'family', sourceKind: 'message', sourceId: `cap_chat_${index}`, content: `cap chat ${index}`, now });
  for (let index = 0; index < 3; index += 1) insertEvidence(db, keyring, { userId: `cap_u${index}`, instanceId: `cap_i${index}`, familyId: 'family', sourceKind: 'memory_version', sourceId: `cap_memory_${index}`, sourceVersionId: `cap_memory_v${index}`, content: `cap memory ${index}`, now });
  const cohort = stage8.refreshCohorts().find((item) => item.eligible);
  assert.ok(cohort);
  const result = stage8.requestClusterRun({ cohortId: cohort.id });
  assert.equal(result.status, 'insufficient_users_for_weight_cap');
  assert.equal(result.userCount, 6);
  assert.equal(result.minimumUsers, 7);
  assert.equal(result.maximumUserWeightShare, 0.15);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM cloud_evolution_jobs').get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE status='reserved'").get().count, 0);
  const run = db.prepare('SELECT status,error_code FROM cloud_evolution_runs WHERE id=?').get(result.runId);
  assert.equal(run.status, 'skipped');
  assert.equal(run.error_code, 'insufficient_users_for_weight_cap');
});

test('cluster rejection releases claims and same-category evidence unlocks one deterministic re-evaluation', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-stage8-reconsider-'));
  const db = openCloudDatabase(home);
  t.after(() => db.close());
  const keyring = { activeKeyId: 'test', keys: { test: Buffer.alloc(32, 4).toString('base64') } };
  const stage8 = createStage8Authority({
    db,
    env: {
      JANUS_PHASE8_CLUSTER_MIN_EVIDENCE: '3', JANUS_PHASE8_CLUSTER_MIN_CHAT_EVIDENCE: '1',
      JANUS_PHASE8_CLUSTER_MIN_MEMORY_EVIDENCE: '1', JANUS_PHASE8_CLUSTER_MIN_COMPLETED_TASK_EVIDENCE: '1',
      JANUS_PHASE8_CLUSTER_EVALUATION_INTERVAL_MS: '0',
    },
    modelExecutor: async ({ kind }) => kind === 'cluster_proposal' ? JSON.stringify({ summary: 'reject', sections: [] }) : '{}',
    keyring,
  });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json,updated_at) VALUES('family','department','Family',?,?)").run(JSON.stringify({ capabilityTags: ['verification'] }), now);
  db.prepare("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json,created_at) VALUES('base','family','{}',?)").run(now);
  const kinds = ['message', 'message', 'message', 'memory_version', 'memory_version', 'task_result', 'task_result'];
  for (let index = 0; index < 7; index += 1) {
    db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,cluster_contribution_consent,payload_json,created_at,updated_at)
      VALUES (?,?, 'family','base','active',1,1,'{}',?,?)`).run(`ru${index}`, `ri${index}`, now, now);
    insertEvidence(db, keyring, { userId: `ru${index}`, instanceId: `ri${index}`, familyId: 'family', sourceKind: kinds[index],
      sourceId: `reject_${index}`, sourceVersionId: kinds[index] === 'memory_version' ? `reject_v${index}` : '', content: `reject evidence ${index}`, now });
  }
  const cohort = stage8.refreshCohorts().find((item) => item.eligible);
  assert.ok(cohort);
  assert.equal(stage8.requestClusterRun({ cohortId: cohort.id }).status, 'queued');
  assert.equal((await stage8.tickClusterWorker()).completed[0].status, 'evaluated_rejected');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_cluster_evidence_claims WHERE claim_state='reserved'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster' AND status='evaluated_rejected'").get().count, 7);
  assert.equal(stage8.refreshCohorts().find((item) => item.cohortKey === cohort.cohortKey).eligible, false);
  insertEvidence(db, keyring, { userId: 'ru0', instanceId: 'ri0', familyId: 'family', sourceKind: 'message', sourceId: 'new_chat', content: 'new chat', now });
  insertEvidence(db, keyring, { userId: 'ru3', instanceId: 'ri3', familyId: 'family', sourceKind: 'memory_version', sourceId: 'new_memory', sourceVersionId: 'new_memory_v1', content: 'new memory', now });
  insertEvidence(db, keyring, { userId: 'ru5', instanceId: 'ri5', familyId: 'family', sourceKind: 'task_result', sourceId: 'new_task', content: 'new task', now });
  const reconsidered = stage8.refreshCohorts().find((item) => item.cohortKey === cohort.cohortKey);
  assert.equal(reconsidered.eligible, true);
  assert.equal(reconsidered.reconsiderableEvidenceCount, 0);
  assert.equal(stage8.requestClusterRun({ cohortId: cohort.id }).status, 'queued');
});

test('same-department similar cohort is reviewed independently for every Agent family before Canary', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-stage8-similar-'));
  const db = openCloudDatabase(home);
  t.after(() => db.close());
  const keyring = { activeKeyId: 'test', keys: { test: Buffer.alloc(32, 9).toString('base64') } };
  const reviewed = [];
  const modelExecutor = async ({ kind, prompt }) => {
    if (kind === 'cluster_proposal') return JSON.stringify({ summary: 'Shared delivery check', sections: [{ section_id: 'shared.delivery_check', title: 'Delivery Check', content: 'Check deliverables before submission.', capability_tags: ['delivery'], conflict_keys: ['deliver'], supporting_instance_ids: ['si0', 'si1', 'si2'] }], eval_cases: [{ input: 'submit', expected: 'check' }] });
    if (kind === 'cluster_governance_review') { reviewed.push(JSON.parse(prompt).familyId); return JSON.stringify({ decision: 'full', approved_section_ids: ['shared.delivery_check'] }); }
    if (kind === 'cluster_support_review') return JSON.stringify({ decision: 'supported', supported_evidence_handles: JSON.parse(prompt).evidence.map((item) => item.evidence_handle) });
    if (kind === 'cluster_privacy_review') return JSON.stringify({ decision: 'pass', flags: [] });
    if (kind === 'cluster_replay_judge') return JSON.stringify({ winner: 'candidate', baseline_score: 0.5, candidate_score: 0.8, privacy_violation: false, role_violation: false });
    return 'checked';
  };
  const stage8 = createStage8Authority({ db, env: { JANUS_PHASE8_CANARY_MIN_DURATION_MS: '0' }, modelExecutor, keyring });
  const now = new Date().toISOString();
  for (const familyId of ['family_a', 'family_b']) {
    db.prepare('INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json,updated_at) VALUES(?,?,?,?,?)').run(familyId, 'department', familyId, JSON.stringify({ capabilityTags: ['delivery'] }), now);
    db.prepare('INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json,created_at) VALUES(?,?,?,?)').run(`base_${familyId}`, familyId, JSON.stringify({ baseSkillContent: `Base ${familyId}` }), now);
  }
  for (let index = 0; index < 7; index += 1) {
    const userId = `su${index}`;
    const instanceId = `si${index}`;
    const familyId = index < 3 ? 'family_a' : 'family_b';
    db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,cluster_contribution_consent,payload_json,created_at,updated_at)
      VALUES (?,?,?,?,'active',1,1,'{}',?,?)`).run(userId, instanceId, familyId, `base_${familyId}`, now, now);
    insertSqlitePerformanceTasks(db,{userId,instanceId,familyId,count:10,now});
    for (let evidenceIndex = 0; evidenceIndex < 3; evidenceIndex += 1) insertEvidence(db, keyring, { userId, instanceId, familyId, sourceId: `${instanceId}_${evidenceIndex}`, content: `delivery evidence ${instanceId}-${evidenceIndex}`, now });
    if (index < 5) insertEvidence(db, keyring, { userId, instanceId, familyId, sourceKind: 'message', sourceId: `${instanceId}_chat`, content: `delivery chat ${instanceId}`, now });
    if (index < 3) insertEvidence(db, keyring, { userId, instanceId, familyId, sourceKind: 'memory_version', sourceId: `${instanceId}_memory`, sourceVersionId: `${instanceId}_memory_v1`, content: `delivery memory ${instanceId}`, now });
  }
  const cohort = stage8.refreshCohorts().find((item) => item.type === 'similar' && item.eligible);
  assert.ok(cohort);
  assert.equal(stage8.requestClusterRun({ cohortId: cohort.id }).status, 'queued');
  assert.equal((await stage8.tickClusterWorker()).completed[0].status, 'governance_approved');
  const result = await stage8.tickClusterWorker();
  assert.equal(result.completed[0].status, 'shadow_passed');
  assert.deepEqual(new Set(reviewed), new Set(['family_a', 'family_b']));
  assert.equal(stage8.marketVersions({ familyId: 'family_a' }).length, 0);
  assert.equal(stage8.marketVersions({ familyId: 'family_b' }).length, 0);
});

function performanceEvent(index) {
  return { taskId: `task_${index}`, taskTypeKey: 'artifact', eventKind: 'task_accepted', occurredAt: new Date(Date.now() - index * 1000).toISOString(), completedAt: new Date(Date.now() - index * 1000).toISOString(), acceptanceScore: 90, accepted: true, firstPass: true, estimatedMinutes: 20, actualMinutes: 18, peerMedianMinutes: 20, responseWithinSla: true, hasResponseSignal: true, evidenceComplete: true, securityViolationCount: 0 };
}
function insertSqlitePerformanceTasks(db,{userId,instanceId,familyId,count=10,now}={}){
  for(let index=0;index<count;index+=1){const taskId=`${instanceId}_task_${index}`;const nodeId=`${instanceId}_node_${index}`;
    const completedAt=new Date(Date.parse(now)-index*1000).toISOString();const startedAt=new Date(Date.parse(completedAt)-18*60000).toISOString();
    db.prepare(`INSERT INTO cloud_task_runs(id,owner_user_id,payload_json,updated_at) VALUES(?,?,?,?)`).run(taskId,userId,
      JSON.stringify({id:taskId,owner_user_id:userId,department_id:familyId,metadata:{accepted:true,acceptanceScore:90,firstPass:true,responseWithinSla:true,hasResponseSignal:true}}),completedAt);
    db.prepare(`INSERT INTO cloud_task_nodes(id,task_run_id,user_agent_instance_id,payload_json,updated_at) VALUES(?,?,?,?,?)`).run(nodeId,taskId,instanceId,
      JSON.stringify({id:nodeId,task_run_id:taskId,agent_instance_id:instanceId,status:'accepted',estimated_minutes:20,started_at:startedAt,
        completed_at:completedAt,evidence_json:JSON.stringify([`evidence_${index}`])}),completedAt);
  }
}
function insertSqliteCanaryPerformanceEvent(db,{userId,instanceId,familyId,candidateId,startedAt}){
  const occurredAt=new Date(Date.parse(startedAt)+1000).toISOString();const event={...performanceEvent(0),ownerUserId:userId,
    agentInstanceId:instanceId,agentFamilyId:familyId,taskId:`${candidateId}_${instanceId}`,sourceKind:'task_node',sourceId:`${candidateId}_${instanceId}`,
    sourceVersionId:occurredAt,occurredAt,completedAt:occurredAt,acceptanceScore:100,accepted:true,completed:true,authority:'cloud'};
  db.prepare(`INSERT INTO cloud_agent_performance_events
    (id,owner_user_id,user_agent_instance_id,agent_family_id,task_id,task_type_key,event_kind,occurred_at,source_kind,source_id,source_version_id,source_hash,authority,validation_status,payload_json)
    VALUES (?,?,?,?,?,'canary','task_accepted',?,?,?,?,?,'cloud','validated',?)`).run(`canary_${instanceId}`,userId,instanceId,familyId,event.taskId,
    occurredAt,event.sourceKind,event.sourceId,event.sourceVersionId,sha256(JSON.stringify(event)),JSON.stringify(event));
}
function insertEvidence(db, keyring, { userId, instanceId, familyId, sourceKind = 'task_result', sourceId, sourceVersionId = '', content, now }) { const contentHash = sha256(content); const evidenceId = stableEvolutionEvidenceId({ ownerUserId: userId, userAgentInstanceId: instanceId, sourceKind, sourceId, sourceVersionId, contentHash }); const encrypted = encryptEvolutionPayload(content, keyring); db.prepare(`INSERT INTO cloud_evolution_evidence (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,source_version_id,content_hash,content_ciphertext,content_nonce,content_tag,encryption_algorithm,key_id,confidence,occurred_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(evidenceId, userId, instanceId, familyId, sourceKind, sourceId, sourceVersionId, contentHash, encrypted.ciphertext, encrypted.nonce, encrypted.tag, encrypted.algorithm, encrypted.keyId, now, JSON.stringify({ taskRelevance: 1, acceptanceQuality: 1, allowedEvolutionScopes: ['cluster'] })); return evidenceId; }
function userWeights(items) { return items.reduce((weights, item) => weights.set(item.ownerUserId, (weights.get(item.ownerUserId) || 0) + item.effectiveWeight), new Map()); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
