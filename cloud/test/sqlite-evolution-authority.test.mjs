import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createEvolutionAuthority } from '../../src/cloud/modules/evolution/index.js';
import { createSqliteAuthoritativeEvidence } from '../../src/cloud/modules/evolution/authoritativeEvidence.js';
import { createSqliteEvidenceUsageLedger } from '../../src/cloud/modules/evolution/evidenceUsageLedger.js';
import { openCloudDatabase } from '../../src/cloud/server.js';

test('SQLite cloud evolution authority publishes an available Skill and activates or rolls it back only by command', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  const ingest = ctx.authority.ingestEvidence(ctx.grant, evidence('inst', 'first'));
  assert.equal(ingest.accepted.length, 5);
  const queued = ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst' });
  assert.equal(queued.status, 'queued');
  const snapshot=ctx.db.prepare('SELECT * FROM cloud_evolution_run_snapshots WHERE run_id=?').get(queued.run.id);
  assert.ok(snapshot);
  assert.equal(JSON.parse(snapshot.evidence_ids_json).length,5);
  assert.notEqual(snapshot.base_skill_ciphertext,'Follow instructions carefully.');
  const worker = await ctx.authority.tickWorker();
  assert.equal(worker.completed[0].status, 'available');
  assert.equal(worker.completed[0].autoActivated, false);
  const proposed = ctx.authority.getRun(ctx.grant, queued.run.id);
  assert.equal(proposed.status, 'available');
  assert.equal(proposed.candidateVersion.status, 'candidate');
  assert.equal(ctx.db.prepare("SELECT active_personal_skill_version_id FROM cloud_user_agent_instances_v3 WHERE id='inst'").get().active_personal_skill_version_id, '');
  const counts = ctx.authority.evidenceCounts(ctx.grant, { agentInstanceId: 'inst' });
  assert.equal(counts.counts.consumed, 5);
  assert.equal(counts.available, 0);
  assert.equal(ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst' }).reason, 'personal_evolution_not_due');
  const versions = ctx.authority.listVersions(ctx.grant, { agentInstanceId: 'inst' });
  assert.equal(versions.length, 1);
  assert.equal(versions[0].authority, 'cloud');
  assert.equal(versions[0].stabilityStatus, 'stable');
  assert.equal(versions[0].status, 'candidate');
  const activated = ctx.authority.activatePersonalVersion(ctx.grant, {
    agentInstanceId: 'inst', targetVersionId: versions[0].id, commandId: 'activate_v1', expectedActiveVersionId: '',
  });
  assert.equal(activated.status, 'activated');
  assert.equal(activated.activeVersionId, versions[0].id);
  assert.equal(ctx.authority.activatePersonalVersion(ctx.grant, {
    agentInstanceId: 'inst', targetVersionId: versions[0].id, commandId: 'activate_v1', expectedActiveVersionId: '',
  }).idempotent, true);
  const conflict = ctx.authority.activatePersonalVersion(ctx.grant, {
    agentInstanceId: 'inst', targetVersionId: versions[0].id, commandId: 'activate_stale', expectedActiveVersionId: '',
  });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.activeVersionId, versions[0].id);
  const rolledBack = ctx.authority.rollbackPersonalVersion(ctx.grant, {
    agentInstanceId: 'inst', commandId: 'rollback_v1', expectedActiveVersionId: versions[0].id,
  });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.activeVersionId, '');
  const usagePage = ctx.authority.listEvidenceUsage(ctx.grant, { agentInstanceId: 'inst', scope: 'personal', status: 'consumed', limit: 2 });
  assert.equal(usagePage.items.length, 2);
  assert.ok(usagePage.nextCursor);
  assert.equal(Object.hasOwn(usagePage.items[0], 'content'), false);
  assert.equal(Object.hasOwn(usagePage.items[0], 'contentCiphertext'), false);
  const nextUsagePage = ctx.authority.listEvidenceUsage(ctx.grant, {
    agentInstanceId: 'inst', scope: 'personal', status: 'consumed', limit: 10, cursor: usagePage.nextCursor,
  });
  assert.equal(nextUsagePage.items.length, 3);
  assert.throws(() => ctx.authority.listEvidenceUsage(ctx.grant, { agentInstanceId: 'not_owned' }),
    (error) => error.code === 'agent_instance_not_found');
  const evidenceIds = ctx.db.prepare("SELECT evidence_id FROM cloud_evolution_evidence_usage WHERE consumer_id='inst'").all();
  assert.equal(evidenceIds.length, 5);
  for (const item of evidenceIds) assert.deepEqual(ctx.db.prepare(`SELECT to_status FROM cloud_evolution_evidence_usage_events
    WHERE evidence_id=? ORDER BY rowid`).all(item.evidence_id).map((row) => row.to_status), ['available','reserved','consumed']);
});

test('registered account evolution evidence upload is mandatory and the managed preference remains idempotent', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  const initial = ctx.authority.preference(ctx.grant);
  assert.equal(initial.enabled, true);
  assert.equal(initial.stateRevision, 1);
  assert.equal(initial.mutable, false);
  assert.throws(() => ctx.authority.setPreference(ctx.grant, {
    enabled: false, commandId: 'pause_account', expectedStateRevision: 1,
  }), (error) => error.code === 'evolution_preference_managed' && error.status === 409);
  assert.equal(ctx.db.prepare("SELECT personal_evolution_consent FROM cloud_user_agent_instances_v3 WHERE id='inst'").get().personal_evolution_consent, 1);
  const accepted = ctx.authority.ingestEvidence(ctx.grant, evidence('inst', 'mandatory'));
  assert.equal(accepted.status, 'accepted');
  const confirmed = ctx.authority.setPreference(ctx.grant, {
    enabled: true, commandId: 'confirm_managed', expectedStateRevision: 1,
  });
  assert.equal(confirmed.enabled, true);
  assert.equal(confirmed.stateRevision, 2);
  assert.equal(ctx.authority.setPreference(ctx.grant, {
    enabled: true, commandId: 'confirm_managed', expectedStateRevision: 1,
  }).idempotent, true);
  assert.equal(ctx.db.prepare("SELECT personal_evolution_consent FROM cloud_user_agent_instances_v3 WHERE id='inst'").get().personal_evolution_consent, 1);
});

test('explicit base Skill rollback clears a multi-version personal overlay chain', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  let activeVersionId = '';
  for (const prefix of ['base_restore_v1', 'base_restore_v2']) {
    ctx.authority.ingestEvidence(ctx.grant, evidence('inst', prefix));
    makePersonalEvolutionDue(ctx);
    assert.equal(ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst' }).status, 'queued');
    const completed = await ctx.authority.tickWorker();
    const versionId = completed.completed[0].versionId;
    const activated = ctx.authority.activatePersonalVersion(ctx.grant, {
      agentInstanceId: 'inst', targetVersionId: versionId, commandId: `activate_${prefix}`, expectedActiveVersionId: activeVersionId,
    });
    assert.equal(activated.status, 'activated');
    activeVersionId = versionId;
  }
  const active = ctx.authority.listVersions(ctx.grant, { agentInstanceId: 'inst' }).find((item) => item.status === 'active');
  assert.ok(active.parentVersionId, 'fixture must have a prior stable personal version');
  const restored = ctx.authority.rollbackPersonalVersion(ctx.grant, {
    agentInstanceId: 'inst', targetVersionId: '', commandId: 'restore_base_skill', expectedActiveVersionId: active.id,
  });
  assert.equal(restored.status, 'rolled_back');
  assert.equal(restored.activeVersionId, '');
  assert.equal(ctx.db.prepare("SELECT active_personal_skill_version_id FROM cloud_user_agent_instances_v3 WHERE id='inst'").get().active_personal_skill_version_id, '');
});

test('update checks include every recruitable Family and do not activate available personal versions', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  const now = new Date().toISOString();
  for (const id of ['market_family_a', 'market_family_b']) {
    ctx.db.prepare(`INSERT INTO cloud_agent_families_v3 (
      id,department_id,name,status,instance_kind,recruitable,payload_json,updated_at
    ) VALUES (?,'market_department',?,'active','employee',1,'{}',?)`).run(id, id, now);
  }
  ctx.authority.ingestEvidence(ctx.grant, evidence('inst', 'updates'));
  ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst' });
  assert.equal((await ctx.authority.tickWorker()).completed[0].status, 'available');
  const before = ctx.db.prepare("SELECT active_personal_skill_version_id FROM cloud_user_agent_instances_v3 WHERE id='inst'").get();
  const updates = ctx.authority.updates(ctx.grant, {
    stage8: { marketVersions: ({ familyId }) => familyId === 'market_family_a' ? [{ id: 'released_a', status: 'released', sections: [] }] : [] },
  });
  assert.equal(updates.personal[0].availableCount, 1);
  assert.deepEqual(updates.market.map((item) => item.agentFamilyId), ['market_family_a', 'market_family_b']);
  assert.deepEqual(updates.market.map((item) => item.updateStatus), ['view_only_available', 'no_published_version']);
  assert.deepEqual(updates.market.map((item) => item.availableVersionCount), [1, 0]);
  assert.deepEqual(ctx.db.prepare("SELECT active_personal_skill_version_id FROM cloud_user_agent_instances_v3 WHERE id='inst'").get(), before);
});

test('temporary Worker failure preserves reservations while governance rejection is terminal for that algorithm', async (t) => {
  const failing = await context({ modelExecutor: async () => { throw new Error('temporary model outage'); } });
  t.after(() => failing.close());
  failing.authority.ingestEvidence(failing.grant, evidence('inst', 'temporary'));
  failing.authority.requestPersonalRun(failing.grant, { agentInstanceId: 'inst' });
  const failure = await failing.authority.tickWorker();
  assert.equal(failure.completed[0].status, 'failed_retryable');
  assert.equal(failing.authority.evidenceCounts(failing.grant, { agentInstanceId: 'inst' }).counts.released, 5);
  assert.equal(failing.db.prepare('SELECT status FROM cloud_evolution_runs').get().status, 'failed_retryable');
  for (let retry = 0; retry < 2; retry += 1) {
    failing.db.prepare("UPDATE cloud_evolution_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE status = 'failed_retryable'").run();
    const nextFailure = await failing.authority.tickWorker();
    assert.equal(nextFailure.completed[0].status, retry === 0 ? 'failed_retryable' : 'failed_terminal');
  }
  assert.equal(failing.authority.evidenceCounts(failing.grant, { agentInstanceId: 'inst' }).counts.released, 5);

  const rejected = await context({ modelExecutor: rejectedModel });
  t.after(() => rejected.close());
  rejected.authority.ingestEvidence(rejected.grant, evidence('inst', 'rejected'));
  rejected.authority.requestPersonalRun(rejected.grant, { agentInstanceId: 'inst' });
  const rejection = await rejected.authority.tickWorker();
  assert.equal(rejection.completed[0].status, 'evaluated_rejected');
  assert.equal(rejected.authority.evidenceCounts(rejected.grant, { agentInstanceId: 'inst' }).counts.evaluated_rejected, 5);
  const rejectedRun = rejected.authority.getRun(rejected.grant, rejection.completed[0].runId);
  assert.ok(rejectedRun.evidenceUsage.every((item) => item.rejectionKind === 'gate'));
  assert.ok(rejectedRun.evidenceUsage.every((item) => item.reEvaluationBasisHash));
});

test('Skill decisions are rejected in favor of the version activation command', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  ctx.authority.ingestEvidence(ctx.grant, evidence('inst', 'user-reject'));
  const queued = ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst' });
  await ctx.authority.tickWorker();
  const run = ctx.authority.getRun(ctx.grant, queued.run.id);
  assert.equal(run.status, 'available');
  assert.throws(() => ctx.authority.decidePersonalRun(ctx.grant, {
    runId: run.id,
    decisions: [{ targetKind: 'skill', targetId: run.candidatePersonalSkillVersionId, decision: 'reject' }],
  }), (error) => error.code === 'personal_version_activation_required');
});

test('rejected personal Evidence is reconsidered once after five fresh related items change its basis', async (t) => {
  let reject = true;
  const ctx = await context({ modelExecutor: (input) => reject ? rejectedModel(input) : approvedModel(input) });
  t.after(() => ctx.close());
  const firstEvidence = ctx.authority.ingestEvidence(ctx.grant, evidence('inst', 'basis-old')).accepted;
  ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst' });
  assert.equal((await ctx.authority.tickWorker()).completed[0].status, 'evaluated_rejected');

  reject = false;
  ctx.authority.ingestEvidence(ctx.grant, evidence('inst', 'basis-new'));
  makePersonalEvolutionDue(ctx);
  const second = ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst' });
  assert.equal(second.status, 'queued');
  assert.equal(second.run.evidenceCount, 10);
  assert.equal((await ctx.authority.tickWorker()).completed[0].status, 'available');
  assert.equal(ctx.authority.evidenceCounts(ctx.grant, { agentInstanceId: 'inst' }).counts.consumed, 10);
  for (const evidenceId of firstEvidence) {
    const transitions = ctx.db.prepare(`SELECT to_status FROM cloud_evolution_evidence_usage_events
      WHERE evidence_id=? AND evolution_scope='personal' ORDER BY rowid`).all(evidenceId).map((row) => row.to_status);
    assert.deepEqual(transitions, ['available','reserved','evaluated_rejected','reserved','consumed']);
  }
});

test('expired orphaned reservations are released with an auditable transition', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  ctx.authority.ingestEvidence(ctx.grant, evidence('inst', 'expired'));
  const evidenceIds = ctx.db.prepare("SELECT evidence_id FROM cloud_evolution_evidence_usage WHERE consumer_id='inst'").all().map((row) => row.evidence_id);
  const ledger = createSqliteEvidenceUsageLedger(ctx.db);
  assert.equal(ledger.reserve({ scope: 'personal', consumerId: 'inst', runId: 'orphaned_run', algorithmVersion: 'test',
    evidenceIds, leaseExpiresAt: '2000-01-01T00:00:00.000Z' }).length, 5);
  assert.equal(ledger.releaseExpired({ now: '2026-01-01T00:00:00.000Z' }), 5);
  assert.equal(ctx.authority.evidenceCounts(ctx.grant, { agentInstanceId: 'inst' }).counts.released, 5);
  const releases = ctx.db.prepare(`SELECT * FROM cloud_evolution_evidence_usage_events
    WHERE to_status='released' AND transition_reason='expired_or_orphaned_reservation'`).all();
  assert.equal(releases.length, 5);
});

test('two consecutive health regressions roll back to the prior stable cloud version', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  let activeVersionId = '';
  for (const prefix of ['v1', 'v2']) {
    ctx.authority.ingestEvidence(ctx.grant, evidence('inst', prefix));
    makePersonalEvolutionDue(ctx);
    assert.equal(ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst' }).status, 'queued');
    const available = await ctx.authority.tickWorker();
    assert.equal(available.completed[0].status, 'available');
    const versionId = available.completed[0].versionId;
    const activated = ctx.authority.activatePersonalVersion(ctx.grant, {
      agentInstanceId: 'inst', targetVersionId: versionId, commandId: `activate_${prefix}`, expectedActiveVersionId: activeVersionId,
    });
    assert.equal(activated.status, 'activated');
    activeVersionId = versionId;
  }
  const versions = ctx.authority.listVersions(ctx.grant, { agentInstanceId: 'inst' });
  const active = versions.find((item) => item.status === 'active');
  assert.ok(active.parentVersionId);
  assert.equal(ctx.authority.evaluateVersionHealth({ userId: 'user', agentInstanceId: 'inst', score: 90, failureRate: 0.05, completedTaskCount: 10 }).status, 'healthy');
  assert.equal(ctx.authority.evaluateVersionHealth({ userId: 'user', agentInstanceId: 'inst', score: 75, failureRate: 0.20, completedTaskCount: 20 }).status, 'regressing');
  const rollback = ctx.authority.evaluateVersionHealth({ userId: 'user', agentInstanceId: 'inst', score: 74, failureRate: 0.22, completedTaskCount: 30 });
  assert.equal(rollback.status, 'rolled_back');
  assert.equal(rollback.previousVersionId, active.parentVersionId);
  assert.equal(ctx.db.prepare("SELECT active_personal_skill_version_id FROM cloud_user_agent_instances_v3 WHERE id='inst'").get().active_personal_skill_version_id,
    active.parentVersionId);
});

test('personal rolling schedule enforces the five-evidence floor and manual cadence semantics', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  const initial = ctx.authority.personalSchedule(ctx.grant, { agentInstanceId: 'inst' });
  const initialEligibleAt = initial.nextEligibleAt;
  const forced = ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst', force: true });
  assert.equal(forced.status, 'insufficient_evidence');
  const nextEligibleAt = ctx.authority.personalSchedule(ctx.grant, { agentInstanceId: 'inst' }).nextEligibleAt;
  assert.ok(Date.parse(nextEligibleAt) > Date.parse(initialEligibleAt));

  ctx.authority.ingestEvidence(ctx.grant, evidence('inst', 'scheduled'));
  const early = ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst', triggerKind: 'manual', force: true });
  assert.equal(early.status, 'deferred');
  assert.equal(early.reason, 'personal_evolution_not_due');
  ctx.db.prepare("UPDATE cloud_personal_evolution_schedule_states SET next_eligible_at='2000-01-01T00:00:00.000Z' WHERE user_agent_instance_id='inst'").run();
  const queued = ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst', triggerKind: 'manual' });
  assert.equal(queued.status, 'queued');
  const scheduled = ctx.authority.personalSchedule(ctx.grant, { agentInstanceId: 'inst' });
  assert.equal(scheduled.lastStatus, 'queued');
  assert.equal(scheduled.lastEvidenceCount, 5);
  assert.equal(scheduled.lastRunId, queued.run.id);
  assert.ok(Date.parse(scheduled.nextEligibleAt) > Date.parse(scheduled.lastEvaluatedAt));

  const second = await context({ modelExecutor: approvedModel });
  t.after(() => second.close());
  second.db.prepare("UPDATE cloud_personal_evolution_schedule_states SET next_eligible_at='2000-01-01T00:00:00.000Z' WHERE user_agent_instance_id='inst'").run();
  const tick = await second.authority.tickWorker();
  assert.equal(tick.scheduled[0].status, 'insufficient_evidence');
  const insufficient = second.authority.personalSchedule(second.grant, { agentInstanceId: 'inst' });
  assert.equal(insufficient.lastStatus, 'insufficient_evidence');
  assert.ok(Date.parse(insufficient.nextEligibleAt) > Date.now());
});

test('operational Evidence cannot satisfy the personal threshold but supplements a qualified run', async (t) => {
  const ctx=await context({modelExecutor:approvedModel});
  t.after(()=>ctx.close());
  const operational=Array.from({length:5},(_,index)=>({userAgentInstanceId:'inst',sourceKind:'market_adoption',
    sourceId:`adoption_${index}`,content:`adopted section ${index}`,allowedEvolutionScopes:['personal']}));
  assert.equal(ctx.authority.ingestEvidence(ctx.grant,operational).accepted.length,5);
  const insufficient=ctx.authority.requestPersonalRun(ctx.grant,{agentInstanceId:'inst'});
  assert.equal(insufficient.status,'insufficient_evidence');
  assert.equal(insufficient.thresholdEligibleEvidence,0);
  assert.equal(ctx.authority.ingestEvidence(ctx.grant,evidence('inst','qualified')).accepted.length,5);
  assert.equal(ctx.authority.requestPersonalRun(ctx.grant,{agentInstanceId:'inst',force:true}).reason,'personal_evolution_not_due');
  ctx.db.prepare("UPDATE cloud_personal_evolution_schedule_states SET next_eligible_at='2000-01-01T00:00:00.000Z' WHERE user_agent_instance_id='inst'").run();
  const queued=ctx.authority.requestPersonalRun(ctx.grant,{agentInstanceId:'inst'});
  assert.equal(queued.status,'queued');
  assert.equal(queued.run.evidenceCount,10);
});

test('cloud-native Memory versions create encrypted Evidence and personal usage atomically', async (t) => {
  const ctx=await context({modelExecutor:approvedModel});
  t.after(()=>ctx.close());
  const now=new Date().toISOString();
  ctx.db.prepare(`INSERT INTO cloud_memory_documents_v3
    (user_id,id,user_agent_instance_id,agent_family_id,scope,slot_no,sync_enabled,allow_personal_evolution,allow_cluster_evolution,payload_json,created_at,updated_at)
    VALUES ('user','native_memory','inst','family','general',0,1,1,1,'{}',?,?)`).run(now,now);
  ctx.db.prepare(`INSERT INTO cloud_memory_document_versions_v3
    (user_id,id,memory_document_id,version_no,content_hash,payload_json,created_at)
    VALUES ('user','native_memory_v1','native_memory',1,?,?,?)`).run(sha256('cloud Memory update'),JSON.stringify({content:'cloud Memory update'}),now);
  ctx.db.prepare("UPDATE cloud_memory_documents_v3 SET current_version_id='native_memory_v1' WHERE user_id='user' AND id='native_memory'").run();
  const created=createSqliteAuthoritativeEvidence(ctx.db,{keyring:{activeKeyId:'test',keys:{test:Buffer.alloc(32,7).toString('base64')}},
    ownerUserId:'user',userAgentInstanceId:'inst',agentFamilyId:'family',sourceKind:'memory_version',sourceId:'native_memory',
    sourceVersionId:'native_memory_v1',content:'cloud Memory update',occurredAt:now,metadata:{sourceKind:'cloud_personal_evolution'}});
  assert.equal(created.inserted,true);
  const stored=ctx.db.prepare('SELECT * FROM cloud_evolution_evidence WHERE evidence_id=?').get(created.evidenceId);
  assert.equal(stored.personal_threshold_eligible,1);
  assert.notEqual(stored.content_ciphertext,'cloud Memory update');
  assert.equal(ctx.db.prepare(`SELECT status FROM cloud_evolution_evidence_usage
    WHERE evidence_id=? AND evolution_scope='personal' AND consumer_id='inst'`).get(created.evidenceId).status,'available');
});

test('cluster evidence scope is automatic and ignores deprecated cluster consent fields', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  const message = ctx.authority.ingestEvidence(ctx.grant, [{
    userAgentInstanceId: 'inst', sourceKind: 'message', sourceId: 'cluster_message',
    content: 'Reusable synchronized conversation evidence.', allowedEvolutionScopes: ['personal'],
  }]);
  assert.equal(message.accepted.length, 1);
  const stored = ctx.db.prepare('SELECT metadata_json FROM cloud_evolution_evidence WHERE evidence_id=?').get(message.accepted[0]);
  assert.deepEqual(JSON.parse(stored.metadata_json).allowedEvolutionScopes, ['personal', 'cluster']);

  const now = new Date().toISOString();
  ctx.db.prepare(`INSERT INTO cloud_memory_documents_v3
    (user_id,id,user_agent_instance_id,sync_enabled,allow_personal_evolution,allow_cluster_evolution,current_version_id,payload_json,created_at,updated_at)
    VALUES ('user','memory','inst',1,0,0,'memory_v1','{}',?,?)`).run(now, now);
  ctx.db.prepare(`INSERT INTO cloud_memory_document_versions_v3
    (user_id,id,memory_document_id,version_no,content_hash,payload_json,created_at)
    VALUES ('user','memory_v1','memory',1,?,? ,?)`).run(
    sha256('Synchronized memory evidence.'), JSON.stringify({ content: 'Synchronized memory evidence.' }), now,
  );
  const memory = ctx.authority.ingestEvidence(ctx.grant, [{
    userAgentInstanceId: 'inst', sourceKind: 'memory_version', sourceId: 'memory', sourceVersionId: 'memory_v1',
    content: 'Synchronized memory evidence.', allowedEvolutionScopes: ['cluster'],
  }]);
  assert.equal(memory.accepted.length, 1);
});

test('authoritative Evidence receipts defer unsynchronized sources and validate all terminal task events', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  const pending = {
    clientRecordId: 'outbox_message_pending', userAgentInstanceId: 'inst', sourceKind: 'message',
    sourceId: 'message_pending', content: 'Synchronized message evidence.', allowedEvolutionScopes: ['personal'],
  };
  const deferred = ctx.authority.ingestEvidence(ctx.grant, [pending]);
  assert.deepEqual(deferred.results.map(({ clientRecordId,status,code,retryable }) => ({ clientRecordId,status,code,retryable })), [{
    clientRecordId: 'outbox_message_pending', status: 'deferred', code: 'evidence_source_not_ready', retryable: true,
  }]);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence WHERE source_id='message_pending'").get().count, 0);

  const now = new Date().toISOString();
  ctx.db.prepare(`INSERT INTO cloud_messages_v2(user_id,device_id,id,conversation_id,role,content,payload_json,created_at)
    VALUES('user','device','message_pending','conversation','user',?,?,?)`).run(
    pending.content, JSON.stringify({ agentInstanceId: 'inst', content: pending.content }), now,
  );
  const accepted = ctx.authority.ingestEvidence(ctx.grant, [pending]);
  assert.equal(accepted.results[0].clientRecordId, 'outbox_message_pending');
  assert.equal(accepted.results[0].status, 'accepted');
  assert.ok(accepted.results[0].evidenceId);

  ctx.db.prepare(`INSERT INTO cloud_messages_v2(user_id,device_id,id,conversation_id,role,content,payload_json,created_at)
    VALUES('user','device','message_wrong','conversation','user','wrong',?,?)`).run(JSON.stringify({ agentInstanceId: 'other_instance' }), now);
  const wrong = ctx.authority.ingestEvidence(ctx.grant, [{ ...pending, clientRecordId: 'outbox_message_wrong', sourceId: 'message_wrong' }]);
  assert.equal(wrong.results[0].status, 'rejected');
  assert.equal(wrong.results[0].code, 'evidence_source_identity_mismatch');
  assert.equal(wrong.results[0].retryable, false);

  ctx.db.prepare("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json,updated_at) VALUES('other_family','department','Other Agent','{}',?)").run(now);
  ctx.db.prepare("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json,created_at) VALUES('other_base','other_family','{}',?)").run(now);
  ctx.db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
    user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,payload_json,created_at,updated_at
  ) VALUES ('user','other_inst','other_family','other_base','active',1,1,'{}',?,?)`).run(now, now);
  ctx.db.prepare(`INSERT INTO cloud_memory_documents_v3
    (user_id,id,user_agent_instance_id,sync_enabled,allow_personal_evolution,current_version_id,payload_json,created_at,updated_at)
    VALUES ('user','authority_memory','inst',1,1,'authority_memory_v1','{}',?,?)`).run(now, now);
  ctx.db.prepare(`INSERT INTO cloud_memory_document_versions_v3
    (user_id,id,memory_document_id,version_no,content_hash,payload_json,created_at)
    VALUES ('user','authority_memory_v1','authority_memory',1,?,'{}',?)`).run(sha256('authoritative memory'), now);
  const hashMismatch = ctx.authority.ingestEvidence(ctx.grant, [{
    clientRecordId: 'outbox_memory_hash_mismatch', userAgentInstanceId: 'inst', sourceKind: 'memory_version',
    sourceId: 'authority_memory', sourceVersionId: 'authority_memory_v1', content: 'tampered memory',
    allowedEvolutionScopes: ['personal'],
  }]);
  assert.equal(hashMismatch.results[0].status, 'rejected');
  assert.equal(hashMismatch.results[0].code, 'evidence_source_hash_mismatch');

  ctx.db.prepare(`INSERT INTO cloud_memory_documents_v3
    (user_id,id,user_agent_instance_id,sync_enabled,allow_personal_evolution,current_version_id,payload_json,created_at,updated_at)
    VALUES ('user','other_memory','other_inst',1,1,'other_memory_v1','{}',?,?)`).run(now, now);
  ctx.db.prepare(`INSERT INTO cloud_memory_document_versions_v3
    (user_id,id,memory_document_id,version_no,content_hash,payload_json,created_at)
    VALUES ('user','other_memory_v1','other_memory',1,?,'{}',?)`).run(sha256('other Agent memory'), now);
  const wrongMemoryAgent = ctx.authority.ingestEvidence(ctx.grant, [{
    clientRecordId: 'outbox_memory_wrong_agent', userAgentInstanceId: 'inst', sourceKind: 'memory_version',
    sourceId: 'other_memory', sourceVersionId: 'other_memory_v1', content: 'other Agent memory',
    allowedEvolutionScopes: ['personal'],
  }]);
  assert.equal(wrongMemoryAgent.results[0].status, 'rejected');
  assert.equal(wrongMemoryAgent.results[0].code, 'evidence_source_identity_mismatch');

  ctx.db.prepare("INSERT INTO cloud_task_runs(id,payload_json,updated_at) VALUES('task','{\"ownerUserId\":\"user\"}',?)").run(now);
  ctx.db.prepare("INSERT INTO cloud_task_nodes(id,task_run_id,payload_json,updated_at) VALUES('node','task','{\"agentInstanceId\":\"inst\"}',?)").run(now);
  ctx.db.prepare(`INSERT INTO cloud_memory_documents_v3
    (user_id,id,user_agent_instance_id,agent_family_id,scope,task_run_id,visibility,sync_enabled,allow_personal_evolution,current_version_id,payload_json,created_at,updated_at)
    VALUES ('user','shared_memory','inst','family','task','task','work_summary',1,1,'shared_memory_v1','{}',?,?)`).run(now,now);
  ctx.db.prepare(`INSERT INTO cloud_memory_document_versions_v3
    (user_id,id,memory_document_id,version_no,content_hash,payload_json,created_at)
    VALUES ('user','shared_memory_v1','shared_memory',1,?,?,?)`).run(sha256('task shared summary'),JSON.stringify({content:'task shared summary',visibility:'work_summary'}),now);
  const sharedSummary=ctx.authority.ingestEvidence(ctx.grant,[{clientRecordId:'outbox_task_shared_summary',userAgentInstanceId:'inst',
    sourceKind:'task_shared_summary',sourceId:'shared_memory',sourceVersionId:'shared_memory_v1',taskId:'task',
    content:'task shared summary',allowedEvolutionScopes:['personal']}]);
  assert.equal(sharedSummary.results[0].status,'accepted');
  const missingTaskEvent = ctx.authority.ingestEvidence(ctx.grant, [{
    clientRecordId: 'outbox_task_missing_event', userAgentInstanceId: 'inst', sourceKind: 'task_result', sourceId: 'node',
    taskId: 'task', content: 'new task Evidence without event', allowedEvolutionScopes: ['personal'],
  }]);
  assert.equal(missingTaskEvent.results[0].status, 'rejected');
  assert.equal(missingTaskEvent.results[0].code, 'evidence_source_version_required');
  const legacyTask = ctx.authority.ingestEvidence(ctx.grant, [{
    userAgentInstanceId: 'inst', sourceKind: 'task_result', sourceId: 'node', taskId: 'task',
    content: 'legacy cursor task Evidence', allowedEvolutionScopes: ['personal'],
  }]);
  assert.equal(legacyTask.results[0].status, 'accepted');
  const kinds = [
    ['node_completed','task_result'], ['node_accepted','task_acceptance'], ['node_rework','task_rework'],
    ['node_failed','task_failure'], ['node_blocked','task_blocked'], ['node_cancelled','task_cancelled'],
  ];
  for (const [eventType] of kinds) ctx.db.prepare(`INSERT INTO cloud_task_events(id,task_run_id,task_node_id,event_type,payload_json,created_at)
    VALUES(?,'task','node',?,'{}',?)`).run(`event_${eventType}`, eventType, now);
  const taskEvidence = kinds.map(([eventType,sourceKind], index) => ({
    clientRecordId: `outbox_task_${index}`, userAgentInstanceId: 'inst', sourceKind, sourceId: 'node',
    sourceVersionId: `event_${eventType}`, taskId: 'task', content: `terminal task evidence ${sourceKind}`,
    allowedEvolutionScopes: ['personal'],
  }));
  const taskResult = ctx.authority.ingestEvidence(ctx.grant, [...taskEvidence].reverse());
  assert.equal(taskResult.results.length, 6);
  assert.ok(taskResult.results.every((item) => item.status === 'accepted'));
  assert.deepEqual(taskResult.results.map((item) => item.clientRecordId), taskEvidence.map((item) => item.clientRecordId).reverse());
  assert.deepEqual(new Set(ctx.db.prepare("SELECT source_kind FROM cloud_evolution_evidence WHERE source_id='node'").all().map((row) => row.source_kind)),
    new Set(kinds.map((item) => item[1])));
});

test('health evaluation counts each performance input window once', async (t) => {
  const ctx = await context({ modelExecutor: approvedModel });
  t.after(() => ctx.close());
  ctx.authority.ingestEvidence(ctx.grant, evidence('inst', 'health'));
  ctx.authority.requestPersonalRun(ctx.grant, { agentInstanceId: 'inst' });
  const available = await ctx.authority.tickWorker();
  ctx.authority.activatePersonalVersion(ctx.grant, {
    agentInstanceId: 'inst', targetVersionId: available.completed[0].versionId,
    commandId: 'activate_health', expectedActiveVersionId: '',
  });
  assert.equal(ctx.authority.evaluateVersionHealth({ userId: 'user', agentInstanceId: 'inst', score: 90,
    failureRate: 0.05, completedTaskCount: 10, inputHash: 'baseline' }).status, 'healthy');
  assert.equal(ctx.authority.evaluateVersionHealth({ userId: 'user', agentInstanceId: 'inst', score: 75,
    failureRate: 0.20, completedTaskCount: 20, inputHash: 'regression-1' }).status, 'regressing');
  const duplicate = ctx.authority.evaluateVersionHealth({ userId: 'user', agentInstanceId: 'inst', score: 75,
    failureRate: 0.20, completedTaskCount: 20, inputHash: 'regression-1' });
  assert.equal(duplicate.status, 'regressing');
  assert.equal(duplicate.unchanged, true);
  assert.equal(duplicate.consecutiveRegressionWindows, 1);
});

test('legacy proposed runs converge safely or become stale when their baseline changed', async (t) => {
  const matching = await context({ modelExecutor: approvedModel });
  t.after(() => matching.close());
  matching.authority.ingestEvidence(matching.grant, evidence('inst', 'legacy-match'));
  const queued = matching.authority.requestPersonalRun(matching.grant, { agentInstanceId: 'inst' });
  await matching.authority.tickWorker();
  rewindAppliedRunToLegacyProposal(matching, queued.run.id);
  await matching.authority.tickWorker();
  assert.equal(matching.authority.getRun(matching.grant, queued.run.id).status, 'applied');

  const stale = await context({ modelExecutor: approvedModel });
  t.after(() => stale.close());
  stale.authority.ingestEvidence(stale.grant, evidence('inst', 'legacy-stale'));
  const staleQueued = stale.authority.requestPersonalRun(stale.grant, { agentInstanceId: 'inst' });
  await stale.authority.tickWorker();
  rewindAppliedRunToLegacyProposal(stale, staleQueued.run.id);
  stale.db.prepare("UPDATE cloud_user_agent_instances_v3 SET base_agent_version_id='changed_base' WHERE id='inst'").run();
  await stale.authority.tickWorker();
  const staleRun = stale.authority.getRun(stale.grant, staleQueued.run.id);
  assert.equal(staleRun.status, 'evaluated_rejected');
  assert.equal(staleRun.errorCode, 'legacy_proposal_stale');
  assert.equal(staleRun.proposal.status, 'legacy_proposal_stale');
  assert.equal(staleRun.candidateVersion.status, 'archived');
  assert.equal(stale.authority.evidenceCounts(stale.grant, { agentInstanceId: 'inst' }).counts.released, 5);
});

async function context({ modelExecutor }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-sqlite-evolution-'));
  const db = openCloudDatabase(home);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json,updated_at) VALUES('family','department','Agent','{}',?)").run(now);
  db.prepare("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json,created_at) VALUES('base','family',?,?)").run(JSON.stringify({ baseSkillContent: 'Follow instructions carefully.' }), now);
  db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
    user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,payload_json,created_at,updated_at
  ) VALUES ('user','inst','family','base','active',1,1,'{}',?,?)`).run(now, now);
  const authority = createEvolutionAuthority({
    db,
    env: { JANUS_CLOUD_EVOLUTION_AUTHORITY: 'false' },
    modelExecutor,
    keyring: { activeKeyId: 'test', keys: { test: Buffer.alloc(32, 7).toString('base64') } },
  });
  const issued = authority.issueGrant({ userId: 'user', deviceId: 'device' });
  return { home, db, authority, grant: authority.requireGrant(issued.token, 'evolution:write'), close() { db.close(); } };
}

function evidence(agentInstanceId, prefix) {
  return Array.from({ length: 5 }, (_, index) => ({
    userAgentInstanceId: agentInstanceId,
    sourceKind: 'message',
    sourceId: `${prefix}_${index}`,
    content: `failed task ${prefix} ${index}`,
    allowedEvolutionScopes: ['personal'],
    occurredAt: new Date(Date.now() + index).toISOString(),
  }));
}

function makePersonalEvolutionDue(ctx) {
  ctx.db.prepare(`UPDATE cloud_personal_evolution_schedule_states
    SET next_eligible_at='2000-01-01T00:00:00.000Z' WHERE user_agent_instance_id='inst'`).run();
}

function rewindAppliedRunToLegacyProposal(ctx, runId) {
  const run = ctx.db.prepare('SELECT * FROM cloud_evolution_runs WHERE id=?').get(runId);
  const proposalRow = ctx.db.prepare('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE id=?').get(runId);
  const proposal = JSON.parse(proposalRow.payload_json);
  const usage = ctx.db.prepare(`SELECT evidence_id,evolution_scope,consumer_id,algorithm_version,reserved_at
    FROM cloud_evolution_evidence_usage WHERE run_id=?`).all(runId);
  proposal.status = 'ready';
  proposal.decision = 'pending';
  proposal.skillActionStatus = 'none';
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    ctx.db.prepare('DELETE FROM cloud_personal_evolution_actions_v4 WHERE proposal_id=?').run(runId);
    ctx.db.prepare('DELETE FROM cloud_evolution_apply_journals WHERE run_id=?').run(runId);
    ctx.db.prepare("UPDATE cloud_user_agent_skill_versions_v3 SET status='candidate',stability_status='candidate' WHERE id=?").run(run.candidate_personal_skill_version_id);
    ctx.db.prepare("UPDATE cloud_user_agent_instances_v3 SET active_personal_skill_version_id='' WHERE id=?").run(run.user_agent_instance_id);
    ctx.db.prepare("UPDATE cloud_evolution_runs SET status='proposed',completed_at='',error_code='',error_text='' WHERE id=?").run(runId);
    ctx.db.prepare("UPDATE cloud_personal_evolution_proposals_v4 SET status='ready',payload_json=? WHERE id=?").run(JSON.stringify(proposal), runId);
    ctx.db.prepare('DELETE FROM cloud_evolution_evidence_usage WHERE run_id=?').run(runId);
    for (const row of usage) ctx.db.prepare(`INSERT INTO cloud_evolution_evidence_usage (
      evidence_id,evolution_scope,consumer_id,status,run_id,algorithm_version,reserved_at,transition_reason
    ) VALUES (?,?,?,'reserved',?,?,?,'legacy_test_fixture')`).run(
      row.evidence_id,row.evolution_scope,row.consumer_id,runId,row.algorithm_version,row.reserved_at,
    );
    ctx.db.exec('COMMIT');
  } catch (error) {
    ctx.db.exec('ROLLBACK');
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function approvedModel({ kind }) {
  if (kind === 'personal_proposal') return JSON.stringify({
    summary: 'Improve runtime reliability',
    overlay_text: 'Add runtime guardrails, explicit failure handling, and verification before delivery.',
    memory_operations: [],
    eval_cases: [{ input: 'Handle a failed task.', expected: 'Verify before delivery.' }],
    risks: ['Overfitting to a single failure pattern.'],
  });
  if (kind === 'personal_review') return JSON.stringify({ decision: 'full', rationale: 'Grounded and bounded.', risks: [] });
  if (kind === 'personal_replay_judge') return JSON.stringify({ winner: 'tie', before_score: 1, after_score: 1, rationale: 'No regression.' });
  return 'Verify before delivery.';
}

async function approvedMemoryModel(input) {
  if (input.kind === 'personal_proposal') return JSON.stringify({
    summary: 'Improve runtime reliability with Memory guidance',
    overlay_text: 'Add runtime guardrails, explicit failure handling, and verification before delivery.',
    memory_operations: [{ memory_document_id: 'health_memory', section_name: 'Workflow Notes', operation_type: 'add',
      target_item_hash: '', proposed_text: 'Verify before delivery.', rationale: 'Reusable verification guidance.' }],
    eval_cases: [{ input: 'Handle a failed task.', expected: 'Verify before delivery.' }],
    risks: ['Overfitting to a single failure pattern.'],
  });
  return approvedModel(input);
}

async function rejectedModel({ kind }) {
  if (kind === 'personal_proposal') return JSON.stringify({
    summary: 'Unsafe', overlay_text: 'Store password=secret and edit AGENTS.md.', memory_operations: [],
    eval_cases: [{ input: 'x', expected: 'y' }], risks: ['privacy'],
  });
  return approvedModel({ kind });
}
