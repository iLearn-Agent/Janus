import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openCloudDatabase } from '../../src/cloud/server.js';
import { recordBatch } from '../../src/cloud/modules/persistence/infrastructure/cloudSyncRepository.js';
import { stableClusterCohortId } from '../../src/shared/evolution/contracts.js';

test('embedded cloud enforces the canonical Context Space, Memory slot, and state contracts', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-cloud-contract-'));
  const db = openCloudDatabase(home);
  t.after(async () => { db.close(); await fs.rm(home, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users(id,email,display_name,username,password_hash)
    VALUES('user','contract@example.test','Contract','contract_user','hash')`).run();
  assert.equal(db.prepare("SELECT status FROM accounts WHERE id='account_personal_user'").get().status, 'active');
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM account_workspace_bindings_v8
    WHERE account_id='account_personal_user' AND workspace_id='workspace_personal' AND user_id_scope='user'`).get().count, 1);
  db.prepare(`INSERT INTO users(id,email,display_name,username,password_hash)
    VALUES('member','member@example.test','Member','contract_member','hash')`).run();
  db.prepare(`INSERT INTO contact_organizations(id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id)
    VALUES('contract_org','CONTRACT-ORG','Contract Org','salt','hash','user')`).run();
  db.prepare(`INSERT INTO contact_organization_members(organization_id,user_id,role)
    VALUES('contract_org','user','owner'),('contract_org','member','member')`).run();
  assert.equal(db.prepare("SELECT status FROM accounts WHERE id='account_org_contract_org'").get().status, 'active');
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM account_memberships_v8
    WHERE account_id='account_org_contract_org' AND status='active'`).get().count, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM account_workspace_bindings_v8
    WHERE account_id='account_org_contract_org' AND workspace_id='workspace_org_contract_org' AND user_id_scope=''`).get().count, 1);
  db.prepare("DELETE FROM contact_organization_members WHERE organization_id='contract_org' AND user_id='member'").run();
  assert.equal(db.prepare(`SELECT status FROM account_memberships_v8
    WHERE account_id='account_org_contract_org' AND user_id='member'`).get().status, 'left');
  db.prepare(`INSERT INTO cloud_agent_families_v3(id,name,status,routable,instance_kind,recruitable,payload_json,updated_at)
    VALUES('family','Family','active',1,'employee',1,'{}',?)`).run(now);
  db.prepare(`INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,status,instance_kind,employment_state,created_at,updated_at)
    VALUES('user','instance','family','active','employee','active',?,?)`).run(now,now);
  insertDocument(db, { id: 'memory_a', cloudKey: 'cloud_a', now });
  assert.throws(() => insertDocument(db, { id: 'memory_b', cloudKey: 'cloud_b', now }), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO cloud_agent_context_spaces(user_id,id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state,created_at,updated_at)
    VALUES('user','context','instance','general_memory','memory_a','active',?,?)`).run(now,now);
  db.prepare(`INSERT INTO cloud_memory_sync_mappings(owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at)
    VALUES('user','instance','cloud_a','memory_a','active',?,?)`).run(now,now);
  recordBatch(db, chatContextBatch({ batchId: 'chat_context_a', contextStateId: 'chatctx_a', contextEpoch: 1, baseStateRevision: 0, now }));
  recordBatch(db, chatContextBatch({ batchId: 'chat_context_b', contextStateId: 'chatctx_b', contextEpoch: 2, baseStateRevision: 1, now }));
  assert.deepEqual(db.prepare(`SELECT id,context_epoch,state_revision FROM cloud_chat_context_states
    WHERE owner_user_id='user' AND session_id='conversation' AND context_space_id='context'`).all()
    .map((row) => ({ ...row })), [
    { id: 'chatctx_a', context_epoch: 2, state_revision: 2 },
  ]);
  assert.throws(() => db.prepare("UPDATE cloud_memory_documents_v3 SET lifecycle_state='unknown' WHERE id='memory_a'").run(), /invalid cloud Memory lifecycle|CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO cloud_agent_performance_levels(user_agent_instance_id,agent_family_id,score,level)
    VALUES('instance','family',50,'P11')`).run(), /invalid performance contract|CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO cloud_agent_leadership_levels(user_agent_instance_id,owner_user_id,agent_family_id,score,level)
    VALUES('instance','user','family',50,'L4')`).run(), /CHECK constraint failed/);

  db.prepare(`INSERT INTO cloud_evolution_evidence(evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash)
    VALUES('evidence','user','instance','family','message','message','hash')`).run();
  db.prepare(`INSERT INTO cloud_evolution_evidence_usage(evidence_id,evolution_scope,consumer_id,status)
    VALUES('evidence','personal','instance','available')`).run();
  assert.throws(() => db.prepare(`INSERT INTO cloud_evolution_evidence_usage(evidence_id,evolution_scope,consumer_id,status)
    VALUES('evidence','cluster','instance','unknown')`).run(), /invalid evidence usage contract|CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE cloud_evolution_evidence_usage SET status='consumed' WHERE evidence_id='evidence'").run(), /invalid evidence usage transition/);
  db.prepare("UPDATE cloud_evolution_evidence_usage SET status='reserved',run_id='legacy_run' WHERE evidence_id='evidence'").run();
  db.prepare("UPDATE cloud_evolution_evidence_usage SET status='consumed' WHERE evidence_id='evidence'").run();
  assert.throws(() => db.prepare("UPDATE cloud_evolution_evidence_usage SET status='reserved',run_id='new_run' WHERE evidence_id='evidence'").run(), /invalid evidence usage transition/);
  assert.throws(() => db.prepare("UPDATE cloud_evolution_evidence_usage SET consumer_id='other_instance' WHERE evidence_id='evidence'").run(), /invalid evidence usage transition/);
  db.prepare(`INSERT INTO cloud_cluster_evidence_claims(evidence_id,consumer_id,run_id,claim_state)
    VALUES('evidence','cohort','cluster_run','reserved')`).run();
  db.prepare("UPDATE cloud_cluster_evidence_claims SET claim_state='consumed' WHERE evidence_id='evidence'").run();
  assert.throws(() => db.prepare("UPDATE cloud_cluster_evidence_claims SET claim_state='reserved',run_id='other_run' WHERE evidence_id='evidence'").run(), /invalid cluster evidence claim transition/);
  db.prepare(`INSERT INTO cloud_evolution_evidence(evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash)
    VALUES('other_evidence','user','instance','family','message','other_message','other_hash')`).run();
  assert.throws(() => db.prepare("UPDATE cloud_cluster_evidence_claims SET evidence_id='other_evidence' WHERE evidence_id='evidence'").run(), /invalid cluster evidence claim transition/);
  assert.throws(() => db.prepare(`INSERT INTO cloud_cluster_evidence_claims(evidence_id,consumer_id,run_id,claim_state)
    VALUES('evidence','other_cohort','other_run','reserved')`).run(), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO cloud_evolution_evidence(evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash)
    VALUES('rejected_evidence','user','instance','family','message','rejected_message','hash')`).run();
  db.prepare(`INSERT INTO cloud_evolution_evidence_usage(evidence_id,evolution_scope,consumer_id,status)
    VALUES('rejected_evidence','personal','instance','available')`).run();
  db.prepare("UPDATE cloud_evolution_evidence_usage SET status='reserved',run_id='rejected_run' WHERE evidence_id='rejected_evidence'").run();
  db.prepare("UPDATE cloud_evolution_evidence_usage SET status='evaluated_rejected',rejection_kind='gate',re_evaluation_basis_hash='basis_1' WHERE evidence_id='rejected_evidence'").run();
  assert.throws(() => db.prepare("UPDATE cloud_evolution_evidence_usage SET status='reserved',rejection_kind='',run_id='rejected_run_2',re_evaluation_basis_hash='basis_1' WHERE evidence_id='rejected_evidence'").run(), /invalid evidence usage transition/);
  db.prepare("UPDATE cloud_evolution_evidence_usage SET status='reserved',rejection_kind='',run_id='rejected_run_2',re_evaluation_basis_hash='basis_2' WHERE evidence_id='rejected_evidence'").run();

  db.prepare(`INSERT INTO cloud_evolution_runs(id,evolution_scope,owner_user_id,user_agent_instance_id,agent_family_id,consumer_id,algorithm_version,trigger_kind,status)
    VALUES('run','personal','user','instance','family','instance','contract','manual','queued')`).run();
  assert.throws(() => db.prepare(`INSERT INTO cloud_evolution_jobs(id,run_id,job_kind,status)
    VALUES('job','run','personal_evolution','unknown')`).run(), /invalid evolution job contract|CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO cloud_personal_evolution_proposals_v4(user_id,id,user_agent_instance_id,agent_family_id,status)
    VALUES('user','proposal','instance','family','running')`).run(), /invalid personal proposal contract|CHECK constraint failed/);

  const contextColumns = db.prepare('PRAGMA table_info(cloud_agent_context_spaces)').all().map((row) => row.name);
  const mappingColumns = db.prepare('PRAGMA table_info(cloud_memory_sync_mappings)').all().map((row) => row.name);
  assert.ok(contextColumns.includes('memory_document_id'));
  assert.equal(contextColumns.includes('legacy_session_id'), false);
  assert.ok(mappingColumns.includes('memory_document_id'));
  assert.equal(mappingColumns.includes('private_key'), false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

function chatContextBatch({ batchId, contextStateId, contextEpoch, baseStateRevision, now }) {
  return {
    schemaVersion: 5,
    batch: { id: batchId, generatedAt: now, cursorFrom: '', cursorTo: now },
    device: { userId: 'user', deviceId: `device_${batchId}` },
    data: {
      conversations: [{ id: 'conversation', agentInstanceId: 'instance', conversationRole: 'primary', writeState: 'writable', updatedAt: now }],
      chatContextStates: [{
        id: contextStateId, session_id: 'conversation', context_space_id: 'context', context_epoch: contextEpoch,
        reset_after_message_id: '', reset_after_created_at: now, base_state_revision: baseStateRevision, updated_at: now,
      }],
    },
  };
}

test('embedded cloud upgrades legacy Context and mapping tables to the canonical constrained shape', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-cloud-contract-upgrade-'));
  let db = openCloudDatabase(home);
  t.after(async () => {
    try { db.close(); } catch {}
    await fs.rm(home, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users(id,email,display_name,username,password_hash)
    VALUES('legacy_user','legacy-contract@example.test','Legacy','legacy_contract','hash')`).run();
  db.prepare(`INSERT INTO cloud_agent_families_v3(id,name,status,routable,instance_kind,recruitable,payload_json,updated_at)
    VALUES('legacy_family','Legacy Family','active',1,'employee',1,'{}',?)`).run(now);
  db.prepare(`INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,status,instance_kind,employment_state,created_at,updated_at)
    VALUES('legacy_user','legacy_instance','legacy_family','active','employee','active',?,?)`).run(now,now);
  insertDocument(db, { userId: 'legacy_user', instanceId: 'legacy_instance', familyId: 'legacy_family', id: 'legacy_memory', cloudKey: 'legacy_cloud_key', now });
  db.exec(`
    DROP TABLE cloud_memory_sync_mappings;
    DROP TABLE cloud_agent_context_spaces;
    CREATE TABLE cloud_agent_context_spaces (
      user_id TEXT NOT NULL,id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,context_kind TEXT NOT NULL,
      memory_cloud_key TEXT NOT NULL DEFAULT '',project_id TEXT NOT NULL DEFAULT '',task_run_id TEXT NOT NULL DEFAULT '',
      delegation_id TEXT NOT NULL DEFAULT '',group_id TEXT NOT NULL DEFAULT '',relationship_user_id TEXT NOT NULL DEFAULT '',
      legacy_session_id TEXT NOT NULL DEFAULT '',lifecycle_state TEXT NOT NULL DEFAULT 'active',payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(user_id,id)
    );
    CREATE TABLE cloud_memory_sync_mappings (
      owner_user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,cloud_key TEXT NOT NULL,canonical_document_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(owner_user_id,user_agent_instance_id,cloud_key)
    );
    INSERT INTO cloud_agent_context_spaces(user_id,id,user_agent_instance_id,context_kind,memory_cloud_key,lifecycle_state,created_at,updated_at)
      VALUES('legacy_user','legacy_context','legacy_instance','general_memory','legacy_cloud_key','active','2026-01-01','2026-01-02');
    INSERT INTO cloud_memory_sync_mappings(owner_user_id,user_agent_instance_id,cloud_key,canonical_document_id,status,created_at,updated_at)
      VALUES('legacy_user','legacy_instance','legacy_cloud_key','legacy_memory','active','2026-01-01','2026-01-02');
    DELETE FROM sync_migrations WHERE id='cloud_context_memory_contract_v8';
  `);
  db.close();
  db = openCloudDatabase(home);

  assert.equal(db.prepare("SELECT memory_document_id FROM cloud_agent_context_spaces WHERE id='legacy_context'").get().memory_document_id, 'legacy_memory');
  assert.equal(db.prepare("SELECT memory_document_id FROM cloud_memory_sync_mappings WHERE cloud_key='legacy_cloud_key'").get().memory_document_id, 'legacy_memory');
  assert.throws(() => db.prepare(`INSERT INTO cloud_agent_context_spaces(
    user_id,id,user_agent_instance_id,context_kind,memory_document_id,created_at,updated_at
  ) VALUES('legacy_user','bad_context','legacy_instance','project','legacy_memory',?,?)`).run(now,now), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO cloud_memory_sync_mappings(
    owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at
  ) VALUES('legacy_user','legacy_instance','bad_key','legacy_memory','unknown',?,?)`).run(now,now), /CHECK constraint failed/);
  assert.ok(db.prepare('PRAGMA foreign_key_list(cloud_agent_context_spaces)').all().length >= 2);
  assert.ok(db.prepare('PRAGMA foreign_key_list(cloud_memory_sync_mappings)').all().length >= 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('embedded cloud upgrades a legacy cohort table before installing evidence contract triggers', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-cloud-cohort-upgrade-'));
  let db = openCloudDatabase(home);
  t.after(async () => {
    try { db.close(); } catch {}
    await fs.rm(home, { recursive: true, force: true });
  });
  db.exec(`
    DROP TABLE cloud_agent_cohorts;
    CREATE TABLE cloud_agent_cohorts (
      id TEXT PRIMARY KEY,
      agent_family_id TEXT NOT NULL DEFAULT '',
      department_id TEXT NOT NULL DEFAULT '',
      capability_tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'inactive',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO cloud_agent_cohorts(
      id,agent_family_id,department_id,capability_tags_json,status,payload_json,created_at,updated_at
    ) VALUES(
      'legacy_family_cohort','legacy_family','legacy_department','[]','active','{}','2026-01-01','2026-01-02'
    );
    DELETE FROM sync_migrations WHERE id IN ('cloud_evidence_contract_v9','cluster_cohort_ledger_contract_v10');
  `);
  db.close();

  db = openCloudDatabase(home);
  const cohort = db.prepare('SELECT * FROM cloud_agent_cohorts WHERE id=?').get(stableClusterCohortId('family:legacy_family'));
  assert.equal(cohort.cohort_key, 'family:legacy_family');
  assert.equal(cohort.identity_version, 'cluster_cohort_identity_v1');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='trigger' AND name='trg_cloud_cohort_contract_insert'").get().count, 1);
  assert.throws(() => db.prepare(`INSERT INTO cloud_agent_cohorts(
    id,cohort_key,identity_version,status
  ) VALUES('invalid_cohort','','cluster_cohort_identity_v1','active')`).run(), /invalid cohort contract/);
});

test('embedded cloud remaps every legacy cohort ledger reference to the stable cohort ID', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-cloud-cohort-ledger-upgrade-'));
  let db = openCloudDatabase(home);
  t.after(async () => {
    try { db.close(); } catch {}
    await fs.rm(home, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const legacyId = 'cohort_cluster_market_v1_legacy';
  const cohortKey = 'family:legacy_family';
  const canonicalId = stableClusterCohortId(cohortKey);
  db.prepare(`INSERT INTO users(id,email,display_name,username,password_hash)
    VALUES('legacy_user','legacy-ledger@example.test','Legacy Ledger','legacy_ledger','hash')`).run();
  db.prepare(`INSERT INTO cloud_agent_families_v3(id,name,status,routable,instance_kind,recruitable,payload_json,updated_at)
    VALUES('legacy_family','Legacy Family','active',1,'employee',1,'{}',?)`).run(now);
  db.prepare(`INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,status,instance_kind,employment_state,created_at,updated_at)
    VALUES('legacy_user','legacy_instance','legacy_family','active','employee','active',?,?)`).run(now,now);
  db.prepare(`INSERT INTO cloud_agent_cohorts(id,cohort_key,identity_version,agent_family_id,status,payload_json,created_at,updated_at)
    VALUES(?,?,'cluster_cohort_identity_v1','legacy_family','active',?, ?,?)`).run(
    legacyId, cohortKey, JSON.stringify({ id: legacyId, cohortKey, algorithmVersion: 'cluster_market_v1' }), now, now);
  db.prepare(`INSERT INTO cloud_agent_cohort_members(cohort_id,user_agent_instance_id,owner_user_id,agent_family_id,performance_level)
    VALUES(?,'legacy_instance','legacy_user','legacy_family','P1')`).run(legacyId);
  db.prepare(`INSERT INTO cloud_evolution_evidence(evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash)
    VALUES('legacy_evidence','legacy_user','legacy_instance','legacy_family','message','legacy_message','legacy_hash')`).run();
  db.prepare(`INSERT INTO cloud_evolution_runs(id,evolution_scope,agent_family_id,cohort_id,consumer_id,algorithm_version,trigger_kind,status,evidence_count)
    VALUES('legacy_run','cluster','legacy_family',?,?,'cluster_market_v1','scheduled','proposed',1)`).run(legacyId,legacyId);
  db.prepare(`INSERT INTO cloud_evolution_jobs(id,run_id,job_kind,status)
    VALUES('legacy_job','legacy_run','cluster_canary','waiting_canary')`).run();
  db.prepare(`INSERT INTO cloud_evolution_evidence_usage(evidence_id,evolution_scope,consumer_id,status,run_id,algorithm_version)
    VALUES('legacy_evidence','cluster',?,'reserved','legacy_run','cluster_market_v1')`).run(legacyId);
  db.prepare(`INSERT INTO cloud_cluster_evidence_claims(evidence_id,consumer_id,run_id,claim_state)
    VALUES('legacy_evidence',?,'legacy_run','reserved')`).run(legacyId);
  db.prepare(`INSERT INTO cloud_evolution_run_snapshots(run_id,snapshot_hash,cohort_snapshot_json)
    VALUES('legacy_run','legacy_snapshot',?)`).run(JSON.stringify({ cohortId: legacyId, cohortKey, algorithmVersion: 'cluster_market_v1' }));
  db.prepare(`INSERT INTO cloud_market_agent_candidates(id,cohort_id,agent_family_id,run_id,status,payload_json,created_at,updated_at)
    VALUES('legacy_candidate',?,'legacy_family','legacy_run','shadow_passed','{}',?,?)`).run(legacyId,now,now);
  db.prepare("DELETE FROM sync_migrations WHERE id='cluster_stage01_contract_v13'").run();
  db.close();

  db = openCloudDatabase(home);
  const cohort = db.prepare('SELECT * FROM cloud_agent_cohorts WHERE id=?').get(canonicalId);
  assert.ok(cohort);
  assert.equal(JSON.parse(cohort.payload_json).id, canonicalId);
  assert.equal(Object.hasOwn(JSON.parse(cohort.payload_json), 'algorithmVersion'), false);
  assert.equal(db.prepare("SELECT cohort_id FROM cloud_agent_cohort_members WHERE user_agent_instance_id='legacy_instance'").get().cohort_id, canonicalId);
  assert.equal(db.prepare("SELECT consumer_id FROM cloud_evolution_evidence_usage WHERE evidence_id='legacy_evidence'").get().consumer_id, canonicalId);
  assert.equal(db.prepare("SELECT consumer_id FROM cloud_cluster_evidence_claims WHERE evidence_id='legacy_evidence'").get().consumer_id, canonicalId);
  const run = db.prepare("SELECT cohort_id,consumer_id,status FROM cloud_evolution_runs WHERE id='legacy_run'").get();
  assert.equal(run.cohort_id, canonicalId);
  assert.equal(run.consumer_id, canonicalId);
  assert.equal(run.status, 'proposed');
  assert.equal(db.prepare("SELECT cohort_id,status FROM cloud_market_agent_candidates WHERE id='legacy_candidate'").get().cohort_id, canonicalId);
  const snapshot = JSON.parse(db.prepare("SELECT cohort_snapshot_json FROM cloud_evolution_run_snapshots WHERE run_id='legacy_run'").get().cohort_snapshot_json);
  assert.equal(snapshot.cohortId, canonicalId);
  assert.equal(Object.hasOwn(snapshot, 'algorithmVersion'), false);
  assert.equal(db.prepare("SELECT status FROM cloud_evolution_jobs WHERE id='legacy_job'").get().status, 'waiting_canary');
  assert.equal(db.prepare("SELECT status FROM cloud_evolution_evidence_usage WHERE evidence_id='legacy_evidence'").get().status, 'reserved');
  assert.throws(() => db.prepare("UPDATE cloud_evolution_evidence_usage SET consumer_id='other' WHERE evidence_id='legacy_evidence'").run(), /invalid evidence usage transition/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

function insertDocument(db, { userId = 'user', instanceId = 'instance', familyId = 'family', id, cloudKey, now }) {
  db.prepare(`INSERT INTO cloud_memory_documents_v3(
    user_id,id,user_agent_instance_id,agent_family_id,cloud_key,scope,slot_no,display_name,visibility,lifecycle_state,payload_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,'general',0,'memory0.md','agent_private','active','{}',?,?)`).run(userId,id,instanceId,familyId,cloudKey,now,now);
}
