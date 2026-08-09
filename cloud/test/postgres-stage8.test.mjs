import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { DataType, newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createPostgresEvidenceUsageLedger } from '../src/modules/evolution/evidenceUsageLedger.mjs';
import { createPostgresStage8Authority } from '../src/modules/evolution/stage8.mjs';
import { encryptEvolutionPayload } from '../../src/shared/evolution/crypto.js';
import { stableEvolutionEvidenceId } from '../../src/shared/evolution/contracts.js';

test('PostgreSQL Stage 8 contract calculates levels and builds the same family cohort', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  memory.public.registerFunction({
    name: 'md5', args: [DataType.text], returns: DataType.text,
    implementation: (value) => crypto.createHash('md5').update(String(value)).digest('hex'),
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await pool.query('ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS deactivated_at timestamptz');
  const keyring = { activeKeyId: 'test', keys: { test: Buffer.alloc(32, 6).toString('base64') } };
  const modelExecutor = async ({ kind, prompt }) => {
    if (kind === 'cluster_proposal') return JSON.stringify({ summary: 'Shared verification', sections: [{ section_id: 'verification.workflow', title: 'Verification', content: 'Verify every deliverable.', capability_tags: ['verification'], conflict_keys: ['verify'], supporting_instance_ids: ['i0', 'i1', 'i2'] }], eval_cases: [{ input: 'deliver', expected: 'verify' }], risks: ['cost'] });
    if (kind === 'cluster_governance_review') return JSON.stringify({ decision: 'full', rationale: 'bounded', approved_section_ids: ['verification.workflow'] });
    if (kind === 'cluster_support_review') return JSON.stringify({ decision: 'supported', supported_evidence_handles: JSON.parse(prompt).evidence.map((item) => item.evidence_handle) });
    if (kind === 'cluster_privacy_review') return JSON.stringify({ decision: 'pass', flags: [] });
    if (kind === 'cluster_replay_judge') return JSON.stringify({ winner: 'candidate', baseline_score: 0.5, candidate_score: 0.9, privacy_violation: false, role_violation: false });
    return 'verified';
  };
  const service = createPostgresStage8Authority({ pool, env: { JANUS_MARKET_CANARY_MIN_DURATION_MS: '0',JANUS_MARKET_CANARY_MAX_DURATION_MS:'60000' }, modelExecutor, keyring });
  await pool.query("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json) VALUES('family','department','Family',$1::jsonb)", [JSON.stringify({ capabilityTags: ['verification'] })]);
  await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json) VALUES('base','family',$1::jsonb)", [JSON.stringify({ baseSkillContent: 'base' })]);
  for (let index = 0; index < 7; index += 1) {
    const userId = `u${index}`;
    const instanceId = `i${index}`;
    await pool.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,\'hash\')', [userId, `${userId}@example.com`, userId]);
    await pool.query("INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,cluster_contribution_consent) VALUES($1,$2,'family','base','active',true,true,true)", [userId, instanceId]);
    await insertPostgresPerformanceTasks(pool,{userId,instanceId,familyId:'family',count:10});
    for (let evidenceIndex = 0; evidenceIndex < 3; evidenceIndex += 1) {
      const content = `verification evidence ${index}-${evidenceIndex}`;
      const contentHash = sha256(content);
      const evidenceId = stableEvolutionEvidenceId({ ownerUserId: userId, userAgentInstanceId: instanceId, sourceKind: 'task_result', sourceId: `${instanceId}_${evidenceIndex}`, contentHash });
      const encrypted = encryptEvolutionPayload(content, keyring);
      await pool.query(`INSERT INTO cloud_evolution_evidence (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,content_ciphertext,content_nonce,content_tag,encryption_algorithm,key_id,confidence,occurred_at,metadata_json)
        VALUES ($1,$2,$3,'family','task_result',$4,$5,$6,$7,$8,$9,$10,1,now(),$11::jsonb)`, [evidenceId, userId, instanceId, `${instanceId}_${evidenceIndex}`, contentHash, encrypted.ciphertext, encrypted.nonce, encrypted.tag, encrypted.algorithm, encrypted.keyId, JSON.stringify({ taskRelevance: 1, acceptanceQuality: 1, allowedEvolutionScopes: ['cluster'] })]);
    }
    if (index < 5) await insertEvidence(pool, keyring, { userId, instanceId, sourceKind: 'message', sourceId: `${instanceId}_chat`, content: `chat evidence ${instanceId}` });
    if (index < 3) await insertEvidence(pool, keyring, { userId, instanceId, sourceKind: 'memory_version', sourceId: `${instanceId}_memory`, sourceVersionId: `${instanceId}_memory_v1`, content: `memory evidence ${instanceId}` });
  }
  await pool.query("INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,cluster_contribution_consent) VALUES('u0','secretary_instance','secretary_agent','secretary_agent_v1','active',true,true,true)");
  await pool.query("INSERT INTO collaboration_groups(id,owner_user_id,title) VALUES('historical_group','u0','Historical')");
  await pool.query("INSERT INTO collaboration_group_messages(id,group_id,sender_user_id,sender_agent_id,kind,content) VALUES('historical_group_message','historical_group','u0','secretary_agent','agent','historical collaboration verification')");
  await pool.query("INSERT INTO agent_delegations(id,requester_user_id,recipient_user_id,title,status,group_id) VALUES('historical_delegation','u0','u1','Historical delegation','accepted','historical_group')");
  await pool.query("INSERT INTO agent_delegation_revisions(id,delegation_id,author_user_id,revision_no,action,content) VALUES('historical_revision','historical_delegation','u0',1,'submit','historical delegation verification')");
  await pool.query("INSERT INTO cloud_market_adoption_actions(id,user_id,user_agent_instance_id,market_version_id,section_id,action) VALUES('historical_market_action','u0','i0','historical_market','*','adopt')");
  assert.deepEqual(await service.backfillHistoricalEvidence(),{marketActions:1,collaborationMessages:1,delegationEvents:1,quarantined:0});
  assert.deepEqual(await service.backfillHistoricalEvidence(),{marketActions:0,collaborationMessages:0,delegationEvents:0,quarantined:0});
  await pool.query(`INSERT INTO cloud_evolution_collection_boundaries(source_kind,collect_after,reason) VALUES
    ('market_action',now()+interval '1 day','test purge'),
    ('collaboration_message',now()+interval '1 day','test purge'),
    ('delegation_event',now()+interval '1 day','test purge')`);
  await pool.query("DELETE FROM cloud_evolution_evidence WHERE source_id IN ('historical_market_action','historical_group_message','historical_delegation')");
  assert.deepEqual(await service.backfillHistoricalEvidence(),{marketActions:0,collaborationMessages:0,delegationEvents:0,quarantined:0});
  const eligibility = await service.refreshCohorts();
  const cohort = eligibility.find((item) => item.eligible);
  assert.equal(cohort.userCount, 7);
  const cohortContract=(await pool.query('SELECT minimum_user_count,maximum_user_weight_share,participation_policy_version FROM cloud_agent_cohorts WHERE id=$1',[cohort.id])).rows[0];
  assert.equal(Number(cohortContract.minimum_user_count),7);assert.equal(Number(cohortContract.maximum_user_weight_share),0.15);
  assert.equal(cohortContract.participation_policy_version,'cluster_active_synced_mandatory_v1');
  assert.equal((await service.refreshCohorts()).find((item) => item.cohortKey === cohort.cohortKey).id, cohort.id);
  assert.deepEqual(service.capabilities().cluster.evidenceThresholds, { total: 15, chat: 5, memory: 3, completedTask: 5 });
  const level = await service.performance({ agentInstanceId: 'i0' });
  assert.equal(level.provisional, false);
  const queued = await service.requestClusterRun({ cohortId: cohort.id });
  assert.equal(queued.status, 'queued');
  const selectedEvidenceCount = Number((await pool.query('SELECT evidence_count FROM cloud_evolution_runs WHERE id=$1', [queued.runId])).rows[0].evidence_count);
  assert.ok(selectedEvidenceCount >= 29);
  await pool.query("UPDATE cloud_evolution_jobs SET status='claimed',claimed_by='dead_worker',lease_expires_at='2020-01-01T00:00:00.000Z',attempt_count=1");
  const persistedWeights = (await pool.query(`SELECT e.owner_user_id,SUM(w.effective_weight) weight
    FROM cloud_cluster_run_evidence w JOIN cloud_evolution_evidence e ON e.evidence_id=w.evidence_id
    WHERE w.run_id=$1 GROUP BY e.owner_user_id`, [queued.runId])).rows;
  const persistedTotal = persistedWeights.reduce((sum, row) => sum + Number(row.weight), 0);
  persistedWeights.forEach((row) => assert.ok(Number(row.weight) / persistedTotal <= 0.15 + 1e-10));
  const proposalResult = await service.tickClusterWorker();
  assert.equal(proposalResult.completed[0].status, 'governance_approved');
  const supportRows=(await pool.query('SELECT * FROM cloud_market_candidate_section_supports')).rows;
  assert.ok(new Set(supportRows.map((item)=>item.contributor_id)).size>=3);
  assert.ok(supportRows.every((item)=>Number(item.support_confidence)>=0.8&&item.deterministic_pass&&item.reviewer_pass));
  const storedSection=(await pool.query('SELECT content_json,support_count FROM cloud_market_candidate_family_sections')).rows[0];
  assert.equal(JSON.stringify(storedSection.content_json).includes('supportingInstanceIds'),false);
  assert.ok(Number(storedSection.support_count)>=3);
  assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_market_candidate_privacy_reviews WHERE review_stage='final_pre_shadow' AND reviewer_status='passed'")).rows[0].count),1);
  assert.equal((await service.marketVersions({ familyId: 'family' })).length, 0);
  const result = await service.tickClusterWorker();
  assert.equal(result.completed[0].status, 'shadow_passed', JSON.stringify(result.completed[0]));
  const claims = (await pool.query('SELECT claim_state,COUNT(*) count FROM cloud_cluster_evidence_claims GROUP BY claim_state')).rows;
  assert.equal(Number(claims.find((row) => row.claim_state === 'consumed')?.count || 0), 0);
  assert.equal(Number(claims.find((row) => row.claim_state === 'reserved')?.count || 0), selectedEvidenceCount);
  assert.equal((await pool.query('SELECT status FROM cloud_market_agent_candidates')).rows[0].status, 'shadow_passed');
  assert.equal((await pool.query('SELECT status FROM cloud_evolution_jobs')).rows[0].status, 'waiting_canary');
  const defaultCanary=await service.canaryStatus({userId:'u1',agentInstanceId:'i1'});
  assert.equal(defaultCanary.optedIn,true);
  assert.equal(defaultCanary.defaultEnrolled,true);
  assert.equal(await createPostgresEvidenceUsageLedger(pool).releaseExpired(), 0);
  assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster' AND status='reserved'")).rows[0].count), selectedEvidenceCount);
  await pool.query(`INSERT INTO cloud_market_agent_versions
    (id,agent_family_id,parent_version_id,version_kind,status,sections_json,payload_json)
    VALUES ('legacy_market','family','','legacy_sections','released',$1::jsonb,'{}'::jsonb)`, [JSON.stringify(['verification.workflow'])]);
  const publicSection = { sectionId: 'verification.workflow', title: 'Verification', content: 'Verify every deliverable.',
    contentHash: sha256('Verify every deliverable.'), capabilityTags: ['verification'], conflictKeys: ['verify'], supportCount: 3 };
  await pool.query(`INSERT INTO cloud_market_version_sections
    (market_version_id,section_id,title,content_hash,content_json,ordinal)
    VALUES ('legacy_market','verification.workflow','Verification',$1,$2::jsonb,0)`, [publicSection.contentHash, JSON.stringify(publicSection)]);
  const version = (await service.marketVersions({ familyId: 'family' }))[0];
  assert.equal(version.versionKind, 'legacy_sections');
  const overlay = encryptEvolutionPayload('Use my verify preference.', keyring);
  await pool.query(`INSERT INTO cloud_personal_skill_overlay_versions (id,user_id,user_agent_instance_id,agent_family_id,base_agent_version_id,status,stability_status,content_ciphertext,content_nonce,content_tag,encryption_algorithm,key_id)
    VALUES ('overlay','u0','i0','family','base','active','stable',$1,$2,$3,$4,$5)`, [overlay.ciphertext, overlay.nonce, overlay.tag, overlay.algorithm, overlay.keyId]);
  await pool.query("UPDATE cloud_user_agent_instances_v3 SET active_personal_skill_version_id='overlay' WHERE id='i0'");
  assert.equal((await service.setCanaryOptIn({ userId: 'u0', agentInstanceId: 'i0', enabled: false })).optedIn, false);
  assert.equal((await service.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id, action: 'ignore' })).status, 'ignored');
  await service.reconcileMarketCanaries();
  const persistedOptOut = await service.canaryStatus({ userId: 'u0', agentInstanceId: 'i0' });
  assert.equal(persistedOptOut.optedIn, false, 'default enrollment must preserve an explicit Canary opt-out');
  assert.equal(persistedOptOut.explicitlyOptedOut, true);
  assert.equal((await service.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id })).status, 'conflict_required');
  const adopted = await service.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id, conflictResolutions: { 'verification.workflow': 'market' } });
  assert.equal(adopted.effectiveSkill.includes('base'), true);
  assert.equal(adopted.effectiveSkill.includes('Verify every deliverable.'), true);
  await assert.rejects(() => service.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id,
    conflictResolutions: { 'verification.workflow': 'personal' }, expectedEffectiveSkillHash: 'stale_hash' }),
  (error) => error.code === 'market_skill_conflict' && error.details.currentEffectiveSkillHash === adopted.effectiveSkillHash);
  await service.refreshCohorts();
  const marketEvidence=(await pool.query("SELECT * FROM cloud_evolution_evidence WHERE source_kind='market_adoption' ORDER BY occurred_at DESC LIMIT 1")).rows[0];
  assert.ok(marketEvidence.metadata_json.allowedEvolutionScopes.includes('cluster'));
  assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evidence_id=$1 AND evolution_scope='personal'",[marketEvidence.evidence_id])).rows[0].count),1);
  assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evidence_id=$1 AND evolution_scope='cluster'",[marketEvidence.evidence_id])).rows[0].count),1);
  const rolledBack = await service.adopt({ userId: 'u0', agentInstanceId: 'i0', marketVersionId: version.id, action: 'rollback',
    expectedEffectiveSkillHash: adopted.effectiveSkillHash });
  assert.equal(rolledBack.status, 'rolled_back');
  const candidateId = (await pool.query('SELECT id FROM cloud_market_agent_candidates')).rows[0].id;
  assert.equal((await service.setCanaryOptIn({userId:'u0',agentInstanceId:'i0',enabled:true})).optedIn,true);
  const started=await service.tickClusterWorker();
  assert.equal(started.completed.find((item)=>item.candidateId===candidateId)?.status,'canary_running');
  assert.equal((await service.effectiveSkill({userId:'u1',agentInstanceId:'i1'})).canaryCandidateId,candidateId);
  const canaryStartedAt=(await pool.query('SELECT canary_started_at FROM cloud_market_agent_candidates WHERE id=$1',[candidateId])).rows[0].canary_started_at;
  for(let index=0;index<7;index+=1)await insertPostgresCanaryPerformanceEvent(pool,{userId:`u${index}`,instanceId:`i${index}`,familyId:'family',candidateId,startedAt:canaryStartedAt});
  const released=await service.tickClusterWorker();
  assert.equal(released.completed.find((item)=>item.candidateId===candidateId)?.status,'released',JSON.stringify(released));
  const marketBase=(await service.marketVersions({familyId:'family'})).find((item)=>item.id!=='legacy_market');
  assert.equal(marketBase.versionKind,'market_base');assert.equal(marketBase.baseAgentVersionId,'base');
  assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_cluster_evidence_claims WHERE claim_state='consumed'")).rows[0].count),selectedEvidenceCount);
});

test('PostgreSQL Stage 8 skips cluster jobs when selected evidence has fewer than seven users', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  memory.public.registerFunction({
    name: 'md5', args: [DataType.text], returns: DataType.text,
    implementation: (value) => crypto.createHash('md5').update(String(value)).digest('hex'),
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  const keyring = { activeKeyId: 'test', keys: { test: Buffer.alloc(32, 5).toString('base64') } };
  const service = createPostgresStage8Authority({ pool, env: {}, modelExecutor: async () => '{}', keyring });
  await pool.query("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json) VALUES('family','department','Family',$1::jsonb)", [JSON.stringify({ capabilityTags: ['verification'] })]);
  await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json) VALUES('base','family','{}'::jsonb)");
  for (let index = 0; index < 7; index += 1) {
    const userId = `cap_u${index}`;
    const instanceId = `cap_i${index}`;
    await pool.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,\'hash\')', [userId, `${userId}@example.com`, userId]);
    await pool.query("INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,cluster_contribution_consent) VALUES($1,$2,'family','base','active',true,true)", [userId, instanceId]);
    const evidenceCount = index === 6 ? 1 : 30;
    const occurredAt = index === 6 ? new Date(Date.now() - 86400000).toISOString() : new Date().toISOString();
    for (let evidenceIndex = 0; evidenceIndex < evidenceCount; evidenceIndex += 1) {
      const content = `weight cap evidence ${index}-${evidenceIndex}`;
      const contentHash = sha256(content);
      const evidenceId = stableEvolutionEvidenceId({ ownerUserId: userId, userAgentInstanceId: instanceId, sourceKind: 'task_result', sourceId: `${instanceId}_${evidenceIndex}`, contentHash });
      const encrypted = encryptEvolutionPayload(content, keyring);
      await pool.query(`INSERT INTO cloud_evolution_evidence (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,content_ciphertext,content_nonce,content_tag,encryption_algorithm,key_id,confidence,occurred_at,metadata_json)
        VALUES ($1,$2,$3,'family','task_result',$4,$5,$6,$7,$8,$9,$10,1,$11,$12::jsonb)`, [evidenceId, userId, instanceId, `${instanceId}_${evidenceIndex}`, contentHash, encrypted.ciphertext, encrypted.nonce, encrypted.tag, encrypted.algorithm, encrypted.keyId, occurredAt, JSON.stringify({ taskRelevance: 1, acceptanceQuality: 1, allowedEvolutionScopes: ['cluster'] })]);
    }
  }
  for (let index = 0; index < 5; index += 1) await insertEvidence(pool, keyring, { userId: `cap_u${index}`, instanceId: `cap_i${index}`, sourceKind: 'message', sourceId: `cap_chat_${index}`, content: `cap chat ${index}` });
  for (let index = 0; index < 3; index += 1) await insertEvidence(pool, keyring, { userId: `cap_u${index}`, instanceId: `cap_i${index}`, sourceKind: 'memory_version', sourceId: `cap_memory_${index}`, sourceVersionId: `cap_memory_v${index}`, content: `cap memory ${index}` });
  const cohort = (await service.refreshCohorts()).find((item) => item.eligible);
  assert.ok(cohort);
  const result = await service.requestClusterRun({ cohortId: cohort.id });
  assert.equal(result.status, 'insufficient_users_for_weight_cap');
  assert.equal(result.userCount, 6);
  assert.equal(result.minimumUsers, 7);
  assert.equal(result.maximumUserWeightShare, 0.15);
  assert.equal(Number((await pool.query('SELECT COUNT(*) count FROM cloud_evolution_jobs')).rows[0].count), 0);
  assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE status='reserved'")).rows[0].count), 0);
  const run = (await pool.query('SELECT status,error_code FROM cloud_evolution_runs WHERE id=$1', [result.runId])).rows[0];
  assert.equal(run.status, 'skipped');
  assert.equal(run.error_code, 'insufficient_users_for_weight_cap');
});

async function insertPostgresPerformanceTasks(pool,{userId,instanceId,familyId,count=10}={}){for(let index=0;index<count;index+=1){
  const taskId=`${instanceId}_task_${index}`;const nodeId=`${instanceId}_node_${index}`;const completedAt=new Date(Date.now()-index*1000).toISOString();
  const startedAt=new Date(Date.parse(completedAt)-18*60000).toISOString();
  await pool.query(`INSERT INTO cloud_task_runs(id,owner_user_id,payload_json,updated_at) VALUES($1,$2,$3::jsonb,$4)`,[taskId,userId,
    JSON.stringify({id:taskId,owner_user_id:userId,department_id:familyId,metadata:{accepted:true,acceptanceScore:90,firstPass:true,responseWithinSla:true,hasResponseSignal:true}}),completedAt]);
  await pool.query(`INSERT INTO cloud_task_nodes(id,task_run_id,user_agent_instance_id,payload_json,updated_at) VALUES($1,$2,$3,$4::jsonb,$5)`,[
    nodeId,taskId,instanceId,JSON.stringify({id:nodeId,task_run_id:taskId,agent_instance_id:instanceId,status:'accepted',estimated_minutes:20,
      started_at:startedAt,completed_at:completedAt,evidence_json:JSON.stringify([`evidence_${index}`])}),completedAt]);
}}
async function insertPostgresCanaryPerformanceEvent(pool,{userId,instanceId,familyId,candidateId,startedAt}){
  const occurredAt=new Date(new Date(startedAt).getTime()+1000);const payload={ownerUserId:userId,agentInstanceId:instanceId,
    agentFamilyId:familyId,taskId:`${candidateId}_${instanceId}`,taskTypeKey:'canary',eventKind:'task_accepted',occurredAt:occurredAt.toISOString(),
    completedAt:occurredAt.toISOString(),acceptanceScore:100,accepted:true,completed:true,firstPass:true,evidenceComplete:true,authority:'cloud'};
  await pool.query(`INSERT INTO cloud_agent_performance_events
    (id,owner_user_id,user_agent_instance_id,agent_family_id,task_id,task_type_key,event_kind,occurred_at,source_kind,source_id,source_version_id,source_hash,authority,validation_status,payload_json)
    VALUES($1,$2,$3,$4,$5,'canary','task_accepted',$6,'task_node',$7,$8,$9,'cloud','validated',$10::jsonb)`,[
    `canary_${instanceId}`,userId,instanceId,familyId,payload.taskId,occurredAt,`${candidateId}_${instanceId}`,occurredAt.toISOString(),sha256(JSON.stringify(payload)),JSON.stringify(payload)]);
}
async function insertEvidence(pool, keyring, { userId, instanceId, sourceKind = 'task_result', sourceId, sourceVersionId = '', content }) { const contentHash = sha256(content); const evidenceId = stableEvolutionEvidenceId({ ownerUserId: userId, userAgentInstanceId: instanceId, sourceKind, sourceId, sourceVersionId, contentHash }); const encrypted = encryptEvolutionPayload(content, keyring); await pool.query(`INSERT INTO cloud_evolution_evidence (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,source_version_id,content_hash,content_ciphertext,content_nonce,content_tag,encryption_algorithm,key_id,confidence,occurred_at,metadata_json)
  VALUES ($1,$2,$3,'family',$4,$5,$6,$7,$8,$9,$10,$11,$12,1,now(),$13::jsonb)`, [evidenceId, userId, instanceId, sourceKind, sourceId, sourceVersionId, contentHash, encrypted.ciphertext, encrypted.nonce, encrypted.tag, encrypted.algorithm, encrypted.keyId, JSON.stringify({ taskRelevance: 1, acceptanceQuality: 1, allowedEvolutionScopes: ['cluster'] })]); return evidenceId; }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
