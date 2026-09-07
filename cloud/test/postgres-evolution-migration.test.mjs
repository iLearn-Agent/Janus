import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { test } from 'node:test';

import { DataType, newDb } from 'pg-mem';

import { createPostgresEvolutionWorker, decidePostgresPersonalRun } from '../src/modules/evolution/worker.mjs';
import { createPostgresAuthoritativeEvidence } from '../src/modules/evolution/authoritativeEvidence.mjs';
import { createPostgresEvidenceUsageLedger } from '../src/modules/evolution/evidenceUsageLedger.mjs';
import { queuePostgresPersonalEvolutionRun } from '../src/modules/evolution/personalQueue.mjs';

test('PostgreSQL evolution schedule migration is idempotent and legacy authority flags do not disable the Worker', async () => {
  const memory = createPgMemory();
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  try {
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(await fs.readFile(new URL('../migrations/008_evolution_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/009_evolution_proposals.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/016_personal_evolution_schedule.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/016_personal_evolution_schedule.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/019_personal_version_health_windows.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/019_personal_version_health_windows.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/022_evidence_contract.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/022_evidence_contract.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/028_evidence_usage_events.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/028_evidence_usage_events.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/032_evidence_collection_ledger.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/034_evidence_validation_lineage.sql', import.meta.url), 'utf8'));
    await pool.query(await pgMemMigration('../migrations/035_evolution_worker_security.sql'));
    await pool.query(await fs.readFile(new URL('../migrations/030_evidence_source_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/030_evidence_source_authority.sql', import.meta.url), 'utf8'));
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='cloud_user_agent_instances_v3'");
    assert.ok(columns.rows.some((row) => row.column_name === 'personal_skill_auto_activate'));
    const scheduleColumns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='cloud_personal_evolution_schedule_states'");
    assert.ok(scheduleColumns.rows.some((row) => row.column_name === 'next_eligible_at'));
    const healthColumns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='cloud_personal_version_health'");
    assert.ok(healthColumns.rows.some((row) => row.column_name === 'last_performance_input_hash'));
    const usageColumns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='cloud_evolution_evidence_usage'");
    assert.ok(usageColumns.rows.some((row) => row.column_name === 'rejection_kind'));
    assert.ok(usageColumns.rows.some((row) => row.column_name === 'transition_reason'));
    const taskEventColumns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='cloud_task_events'");
    assert.ok(taskEventColumns.rows.some((row) => row.column_name === 'owner_user_id'));
    const worker = createPostgresEvolutionWorker({ pool,
      env: { JANUS_CLOUD_EVOLUTION_AUTHORITY: '0', JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY: '1' }, modelExecutor: async () => '' });
    assert.deepEqual(await worker.tick({ limit: 99 }), {
      status: 'ok', authority: 'cloud', workerId: `pg_${process.pid}`,
      rotation: { status: 'not_configured', targetKeyId: '', rewrapped: [], failed: [] }, scheduled: [], completed: [],
    });
  } finally {
    await pool.end();
  }
});

test('PostgreSQL personal queue enforces the 24-hour cadence for manual and force requests', async () => {
  const memory = createPgMemory();
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  const keyring = { activeKeyId: '', keys: {}, allowPlaintextTestOnly: true };
  try {
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(await fs.readFile(new URL('../migrations/008_evolution_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/016_personal_evolution_schedule.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/022_evidence_contract.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/028_evidence_usage_events.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/032_evidence_collection_ledger.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/034_evidence_validation_lineage.sql', import.meta.url), 'utf8'));
    await pool.query(await pgMemMigration('../migrations/035_evolution_worker_security.sql'));
    await pool.query("INSERT INTO users(id) VALUES('user')");
    await pool.query("INSERT INTO cloud_agent_families_v3(id,name) VALUES('family','Agent')");
    await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id) VALUES('base','family')");
    await pool.query(`INSERT INTO cloud_user_agent_instances_v3
      (user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent)
      VALUES ('user','inst','family','base','active',true,true)`);
    const firstEvaluationAt = new Date('2026-01-01T00:00:00.000Z');
    const firstEvaluation = await queuePostgresPersonalEvolutionRun(pool, {
      userId: 'user', agentInstanceId: 'inst', force: true, now: firstEvaluationAt, keyring,
    });
    assert.equal(firstEvaluation.status, 'insufficient_evidence');
    assert.equal(firstEvaluation.nextEligibleAt, '2026-01-02T00:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      await pool.query(`INSERT INTO cloud_evolution_evidence
        (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,content_ciphertext,occurred_at)
        VALUES ($1,'user','inst','family','message',$2,$3,'',now())`, [`e${index}`, `m${index}`, `h${index}`]);
      await pool.query("INSERT INTO cloud_evolution_evidence_usage(evidence_id,evolution_scope,consumer_id,status) VALUES($1,'personal','inst','available')", [`e${index}`]);
    }
    const early = await queuePostgresPersonalEvolutionRun(pool, {
      userId: 'user', agentInstanceId: 'inst', triggerKind: 'manual', force: true,
      now: new Date('2026-01-01T12:00:00.000Z'), keyring,
    });
    assert.equal(early.status, 'deferred');
    assert.equal(early.reason, 'personal_evolution_not_due');
    const queued = await queuePostgresPersonalEvolutionRun(pool, {
      userId: 'user', agentInstanceId: 'inst', triggerKind: 'manual',
      now: new Date('2026-01-02T00:00:00.000Z'), keyring,
    });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.run.evidenceCount, 5);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM cloud_evolution_evidence_usage WHERE status='reserved'")).rows[0].count, 5);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM cloud_evolution_evidence_usage_events WHERE to_status='reserved'")).rows[0].count, 5);
    assert.equal((await queuePostgresPersonalEvolutionRun(pool, {
      userId: 'user', agentInstanceId: 'inst', triggerKind: 'manual', force: true,
      now: new Date('2026-01-02T01:00:00.000Z'), keyring,
    })).reason, 'personal_evolution_already_running');
    const schedule = (await pool.query("SELECT * FROM cloud_personal_evolution_schedule_states WHERE user_agent_instance_id='inst'")).rows[0];
    assert.equal(schedule.last_status, 'queued');
    assert.equal(schedule.last_evidence_count, 5);
    assert.equal(schedule.last_run_id, queued.run.id);
  } finally {
    await pool.end();
  }
});

test('PostgreSQL Worker publishes an available Skill without activation and consumes its evidence', async () => {
  const memory = createPgMemory();
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  const keyring = { activeKeyId: '', keys: {}, allowPlaintextTestOnly: true };
  try {
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(await fs.readFile(new URL('../migrations/008_evolution_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/016_personal_evolution_schedule.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/022_evidence_contract.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/028_evidence_usage_events.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/032_evidence_collection_ledger.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/034_evidence_validation_lineage.sql', import.meta.url), 'utf8'));
    await pool.query(await pgMemMigration('../migrations/035_evolution_worker_security.sql'));
    await pool.query("INSERT INTO users(id) VALUES('user')");
    await pool.query("INSERT INTO cloud_agent_families_v3(id,name) VALUES('family','Agent')");
    await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json) VALUES('base','family','{\"baseSkillContent\":\"Follow instructions carefully.\"}')");
    await pool.query(`INSERT INTO cloud_user_agent_instances_v3
      (user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent)
      VALUES ('user','inst','family','base','active',true,true)`);
    for (let index = 0; index < 5; index += 1) {
      await pool.query(`INSERT INTO cloud_evolution_evidence
        (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,
         content_ciphertext,encryption_algorithm,occurred_at)
        VALUES ($1,'user','inst','family','message',$2,$3,$4,'plain_test_only',now())`,
      [`e${index}`, `m${index}`, `h${index}`, Buffer.from(`failed task ${index}`).toString('base64')]);
      await pool.query("INSERT INTO cloud_evolution_evidence_usage(evidence_id,evolution_scope,consumer_id,status) VALUES($1,'personal','inst','available')", [`e${index}`]);
    }
    const queued = await queuePostgresPersonalEvolutionRun(pool, { userId: 'user', agentInstanceId: 'inst', triggerKind: 'manual', keyring });
    // pg-mem does not apply PostgreSQL's UPDATE ... = ANY(text[]) semantics used by the queue primitive.
    await pool.query("UPDATE cloud_evolution_evidence_usage SET status='reserved',run_id=$1 WHERE consumer_id='inst'", [queued.run.id]);
    const worker = createPostgresEvolutionWorker({
      pool,
      env: { JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY: '1' },
      modelExecutor: approvedModel,
    });
    const result = await worker.tick();
    assert.equal(result.completed[0].status, 'available', JSON.stringify(result.completed[0]));
    assert.equal(result.completed[0].autoActivated, false);
    assert.equal((await pool.query('SELECT status FROM cloud_evolution_runs')).rows[0].status, 'available');
    assert.equal((await pool.query('SELECT status FROM cloud_personal_skill_overlay_versions')).rows[0].status, 'candidate');
    assert.equal((await pool.query('SELECT status FROM cloud_personal_evolution_proposals_v4')).rows[0].status, 'ready');
    assert.equal((await pool.query("SELECT active_personal_skill_version_id FROM cloud_user_agent_instances_v3 WHERE id='inst'")).rows[0].active_personal_skill_version_id, '');
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM cloud_evolution_evidence_usage WHERE status='consumed'")).rows[0].count, 5);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM cloud_evolution_evidence_usage_events WHERE to_status='consumed'")).rows[0].count, 5);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM cloud_evolution_evidence_access_audits WHERE purpose='personal_evolution' AND result='allowed'")).rows[0].count,5);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM cloud_evolution_apply_journals')).rows[0].count, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM cloud_personal_evolution_actions_v4 WHERE target_kind='skill' AND decision='accept'")).rows[0].count, 0);
  } finally {
    await pool.end();
  }
});

test('PostgreSQL Ledger releases orphaned leases with an audit event', async () => {
  const memory = createPgMemory();
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  try {
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(await fs.readFile(new URL('../migrations/008_evolution_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/022_evidence_contract.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/028_evidence_usage_events.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/032_evidence_collection_ledger.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/034_evidence_validation_lineage.sql', import.meta.url), 'utf8'));
    await pool.query(await pgMemMigration('../migrations/035_evolution_worker_security.sql'));
    await pool.query("INSERT INTO users(id) VALUES('user')");
    await pool.query("INSERT INTO cloud_agent_families_v3(id,name) VALUES('family','Agent')");
    await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id) VALUES('base','family')");
    await pool.query(`INSERT INTO cloud_user_agent_instances_v3
      (user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent)
      VALUES ('user','inst','family','base','active',true,true)`);
    for (const id of ['orphaned']) {
      await pool.query(`INSERT INTO cloud_evolution_evidence
        (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,content_ciphertext)
        VALUES ($1,'user','inst','family','message',$1,$1,'')`, [id]);
      await pool.query("INSERT INTO cloud_evolution_evidence_usage(evidence_id,evolution_scope,consumer_id,status) VALUES($1,'personal','inst','available')", [id]);
    }
    const ledger = createPostgresEvidenceUsageLedger(pool);
    assert.deepEqual(await ledger.reserve({ scope: 'personal', consumerId: 'inst', runId: 'missing_run', algorithmVersion: 'test',
      evidenceIds: ['orphaned'], leaseMinutes: 1 }), ['orphaned']);
    await pool.query("UPDATE cloud_evolution_evidence_usage SET lease_expires_at='2000-01-01' WHERE evidence_id='orphaned'");
    assert.equal(await ledger.releaseExpired(), 1);
    assert.equal((await pool.query("SELECT status FROM cloud_evolution_evidence_usage WHERE evidence_id='orphaned'")).rows[0].status, 'released');
    assert.equal((await pool.query("SELECT transition_reason FROM cloud_evolution_evidence_usage_events WHERE evidence_id='orphaned' AND to_status='released'")).rows[0].transition_reason,
      'expired_or_orphaned_reservation');

  } finally {
    await pool.end();
  }
});

test('PostgreSQL Ledger rolls back a pooled reservation when its audit insert fails', async () => {
  let status = 'available';
  let transactionStatus = status;
  const commands = [];
  const client = {
    async query(sql) {
      commands.push(sql);
      if (sql === 'BEGIN') { transactionStatus = status; return { rows: [] }; }
      if (sql === 'COMMIT') return { rows: [] };
      if (sql === 'ROLLBACK') { status = transactionStatus; return { rows: [] }; }
      if (sql.includes('SELECT * FROM cloud_evolution_evidence_usage')) return { rows: [{
        evidence_id: 'evidence', evolution_scope: 'personal', consumer_id: 'inst', status,
        run_id: '', algorithm_version: '', re_evaluation_basis_hash: '',
      }] };
      if (sql.includes("UPDATE cloud_evolution_evidence_usage SET status='reserved'")) {
        status = 'reserved';
        return { rows: [{ evidence_id: 'evidence' }] };
      }
      if (sql.includes('INSERT INTO cloud_evolution_evidence_usage_events')) throw new Error('audit unavailable');
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { async query() { return { rows: [] }; }, async connect() { return client; } };
  await assert.rejects(createPostgresEvidenceUsageLedger(pool).reserve({
    scope: 'personal', consumerId: 'inst', runId: 'run', algorithmVersion: 'algorithm', evidenceIds: ['evidence'],
  }), /audit unavailable/);
  assert.equal(status, 'available');
  assert.equal(commands[0], 'BEGIN');
  assert.equal(commands.at(-1), 'ROLLBACK');
  assert.equal(commands.includes('COMMIT'), false);
});

test('PostgreSQL user rejection evaluates evidence without consuming it', async () => {
  const memory = createPgMemory();
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  try {
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(await fs.readFile(new URL('../migrations/008_evolution_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/009_evolution_proposals.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/016_personal_evolution_schedule.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/022_evidence_contract.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/028_evidence_usage_events.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/032_evidence_collection_ledger.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/034_evidence_validation_lineage.sql', import.meta.url), 'utf8'));
    await pool.query(await pgMemMigration('../migrations/035_evolution_worker_security.sql'));
    await pool.query("INSERT INTO users(id) VALUES('user')");
    await pool.query("INSERT INTO cloud_agent_families_v3(id,name) VALUES('family','Agent')");
    await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id) VALUES('base','family')");
    await pool.query(`INSERT INTO cloud_user_agent_instances_v3
      (user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent)
      VALUES ('user','inst','family','base','active',true,true)`);
    await pool.query(`INSERT INTO cloud_evolution_evidence
      (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,content_ciphertext)
      VALUES ('evidence','user','inst','family','message','message','hash','')`);
    await pool.query(`INSERT INTO cloud_evolution_runs
      (id,evolution_scope,owner_user_id,user_agent_instance_id,agent_family_id,consumer_id,algorithm_version,status,candidate_personal_skill_version_id)
      VALUES ('run','personal','user','inst','family','inst','algorithm','proposed','candidate')`);
    await pool.query(`INSERT INTO cloud_evolution_evidence_usage
      (evidence_id,evolution_scope,consumer_id,status,run_id,algorithm_version)
      VALUES ('evidence','personal','inst','reserved','run','algorithm')`);
    await pool.query(`INSERT INTO cloud_personal_skill_overlay_versions
      (id,user_id,user_agent_instance_id,agent_family_id,base_agent_version_id,status,stability_status)
      VALUES ('candidate','user','inst','family','base','candidate','candidate')`);
    await pool.query(`INSERT INTO cloud_personal_evolution_proposals_v4
      (user_id,id,user_agent_instance_id,agent_family_id,status,payload_json)
      VALUES ('user','run','inst','family','ready','{}')`);
    const result = await decidePostgresPersonalRun(pool, {
      userId: 'user', runId: 'run', decisions: [{ targetKind: 'skill', targetId: 'candidate', decision: 'reject' }],
    });
    assert.equal(result.run.status, 'evaluated_rejected');
    const usage = (await pool.query("SELECT * FROM cloud_evolution_evidence_usage WHERE evidence_id='evidence'")).rows[0];
    assert.equal(usage.status, 'evaluated_rejected');
    assert.equal(usage.rejection_kind, 'user_rejected');
    assert.ok(usage.re_evaluation_basis_hash);
  } finally {
    await pool.end();
  }
});

test('PostgreSQL cloud-native Evidence uses the Worker envelope and creates usage only after validation', async () => {
  const memory=createPgMemory();const pg=memory.adapters.createPg();const pool=new pg.Pool();
  try{
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    for(const migration of ['008_evolution_authority.sql','016_personal_evolution_schedule.sql','022_evidence_contract.sql',
      '028_evidence_usage_events.sql','032_evidence_collection_ledger.sql','034_evidence_validation_lineage.sql']){
      await pool.query(await fs.readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8'));
    }
    await pool.query(await pgMemMigration('../migrations/035_evolution_worker_security.sql'));
    await pool.query("INSERT INTO users(id) VALUES('user')");
    await pool.query("INSERT INTO cloud_agent_families_v3(id,name) VALUES('family','Agent')");
    await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json) VALUES('base','family','{\"baseSkillContent\":\"Follow instructions carefully.\"}')");
    await pool.query("INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent) VALUES('user','inst','family','base','active',true,true)");
    const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048,
      publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
    const created=[];
    for(let index=0;index<5;index+=1)created.push(await createPostgresAuthoritativeEvidence(pool,{
      keyring:{activeKeyId:'',keys:{},allowPlaintextTestOnly:true},envelopeKeyring:{activeKeyId:'worker',keys:{worker:publicKey}},
      ownerUserId:'user',userAgentInstanceId:'inst',sourceKind:'message',sourceId:`cloud_message_${index}`,
      content:`cloud-native verification evidence ${index} about runtime reliability and explicit failure handling`,
    }));
    assert.ok(created.every((item)=>item.inserted));
    assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_evolution_evidence WHERE validation_status='pending_validation'")).rows[0].count),5);
    assert.equal(Number((await pool.query('SELECT COUNT(*) count FROM cloud_evolution_evidence_usage')).rows[0].count),0);
    const worker=createPostgresEvolutionWorker({pool,env:{JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY:'1',
      JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID:'worker',JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON:JSON.stringify({worker:privateKey})},
    modelExecutor:approvedModel});
    const tick=await worker.tick();
    assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_evolution_evidence WHERE validation_status='validated'")).rows[0].count),5);
    assert.equal(tick.completed[0].status,'available',JSON.stringify(tick.completed[0]));
    assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE status='consumed'")).rows[0].count),5);
    assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_personal_skill_overlay_versions WHERE status='candidate'")).rows[0].count),1);
  }finally{await pool.end();}
});

async function pgMemMigration(relativePath) {
  const sql = await fs.readFile(new URL(relativePath, import.meta.url), 'utf8');
  return sql.split(/--\s*requires-real-postgres-tail:[^\r\n]*/i, 1)[0];
}

async function approvedModel({ kind }) {
  if (kind === 'personal_proposal') return JSON.stringify({
    summary: 'Improve runtime reliability',
    overlay_text: 'Add runtime reliability checks, explicit failure handling, and verification before delivery.',
    memory_operations: [],
    eval_cases: [{ input: 'Handle a failed task.', expected: 'Verify before delivery.' }],
    risks: ['Overfitting to a single failure pattern.'],
  });
  if (kind === 'personal_review') return JSON.stringify({ decision: 'full', rationale: 'Grounded and bounded.', risks: [] });
  if (kind === 'personal_replay_judge') return JSON.stringify({ winner: 'tie', before_score: 1, after_score: 1, rationale: 'No regression.' });
  return 'Verify before delivery.';
}

function createPgMemory() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  memory.public.registerFunction({
    name: 'md5', args: [DataType.text], returns: DataType.text,
    implementation: (value) => crypto.createHash('md5').update(String(value)).digest('hex'),
  });
  return memory;
}
