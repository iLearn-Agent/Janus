import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { createPostgresEvidenceUsageLedger } from '../cloud/src/modules/evolution/evidenceUsageLedger.mjs';
import { stableClusterCohortId } from '../src/shared/evolution/contracts.js';

const databaseUrl = String(process.env.JANUS_REHEARSAL_DATABASE_URL || '');
const allowed = String(process.env.JANUS_ALLOW_DATABASE_REHEARSAL || '').toLowerCase() === 'true';
if (!databaseUrl || !allowed) {
  console.log('Cluster evolution PostgreSQL rehearsal skipped: set JANUS_REHEARSAL_DATABASE_URL and JANUS_ALLOW_DATABASE_REHEARSAL=true.');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'cloud', 'migrations');
const schema = `janus_cluster_rehearsal_${crypto.randomBytes(6).toString('hex')}`;
const common = { connectionString: databaseUrl, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10_000 };
const admin = new pg.Pool({ ...common, max: 1 });
const pool = new pg.Pool({ ...common, max: 6, options: `-c search_path=${schema}` });
const apiDatabaseUrl = (() => {
  const rehearsalUrl = new URL(databaseUrl);
  const url = new URL(String(process.env.DATABASE_URL || databaseUrl));
  url.pathname = rehearsalUrl.pathname;
  if (!process.env.DATABASE_URL) {
    url.username = 'janus_api';
    url.password = String(process.env.JANUS_POSTGRES_API_PASSWORD || '');
  }
  return url.toString();
})();
const api = new pg.Pool({ ...common, connectionString: apiDatabaseUrl, max: 1, options: `-c search_path=${schema}` });

try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of (await fs.readdir(migrationsDir)).filter((item) => item.endsWith('.sql')).sort()) {
    if (file === '031_cluster_stage01_contract.sql') {
      await pool.query(`INSERT INTO users(id,email,display_name,password_hash)
        VALUES('legacy_cluster_user','legacy-cluster@example.test','Legacy Cluster User','rehearsal-hash')`);
      await pool.query("INSERT INTO cloud_agent_families_v3(id,name) VALUES('legacy_cluster_family','Legacy Cluster Agent')");
      await pool.query(`INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,status,sync_enabled)
        VALUES('legacy_cluster_user','legacy_cluster_instance','legacy_cluster_family','active',true)`);
      await pool.query(`INSERT INTO cloud_agent_cohorts(id,cohort_key,identity_version,agent_family_id,status,payload_json)
        VALUES('cohort_cluster_market_v1_legacy','family:legacy_cluster_family','cluster_cohort_identity_v1','legacy_cluster_family','active',$1::jsonb)`,
      [JSON.stringify({ cohortKey:'family:legacy_cluster_family',algorithmVersion:'cluster_market_v1' })]);
      await pool.query(`INSERT INTO cloud_evolution_evidence
        (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,content_ciphertext)
        VALUES('legacy_cluster_evidence','legacy_cluster_user','legacy_cluster_instance','legacy_cluster_family','message','legacy_message','legacy_hash','ciphertext')`);
      await pool.query(`INSERT INTO cloud_evolution_evidence_usage(evidence_id,evolution_scope,consumer_id,status)
        VALUES('legacy_cluster_evidence','cluster','cohort_cluster_market_v1_legacy','available')`);
    }
    let sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    if (file === '035_evolution_worker_security.sql') sql = sql.replaceAll('SCHEMA public', `SCHEMA "${schema}"`);
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations(filename) VALUES($1)', [file]);
  }
  const canonicalId = stableClusterCohortId('family:legacy_cluster_family');
  const migrated = (await pool.query('SELECT id,payload_json FROM cloud_agent_cohorts WHERE id=$1', [canonicalId])).rows[0];
  if (!migrated || Object.hasOwn(migrated.payload_json || {}, 'algorithmVersion')) throw new Error('Legacy cohort did not migrate to its canonical algorithm-independent identity.');
  const migratedConsumer = (await pool.query("SELECT consumer_id FROM cloud_evolution_evidence_usage WHERE evidence_id='legacy_cluster_evidence'")).rows[0]?.consumer_id;
  if (migratedConsumer !== canonicalId) throw new Error('Legacy cohort Evidence usage was not remapped to the canonical consumer.');
  await pool.query(`INSERT INTO users(id,email,display_name,password_hash)
    VALUES('cluster_user','cluster@example.test','Cluster User','rehearsal-hash')`);
  await pool.query("INSERT INTO cloud_agent_families_v3(id,name) VALUES('cluster_family','Cluster Agent')");
  await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id) VALUES('cluster_base','cluster_family')");
  await pool.query(`INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled)
    VALUES('cluster_user','cluster_instance','cluster_family','cluster_base','active',true)`);
  await api.query(`INSERT INTO cloud_evolution_evidence
    (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,content_ciphertext)
    VALUES('cluster_evidence','cluster_user','cluster_instance','cluster_family','message','message','hash','ciphertext')`);
  for (const consumerId of ['cohort_a','cohort_b']) await pool.query(`INSERT INTO cloud_evolution_evidence_usage
    (evidence_id,evolution_scope,consumer_id,status) VALUES('cluster_evidence','cluster',$1,'available')`, [consumerId]);
  const ledger = createPostgresEvidenceUsageLedger(pool);
  const [first, second] = await Promise.all([
    ledger.reserve({ scope:'cluster',consumerId:'cohort_a',runId:'run_a',algorithmVersion:'cluster_market_v2',evidenceIds:['cluster_evidence'],clusterClaims:true }),
    ledger.reserve({ scope:'cluster',consumerId:'cohort_b',runId:'run_b',algorithmVersion:'cluster_market_v2',evidenceIds:['cluster_evidence'],clusterClaims:true }),
  ]);
  if (first.length + second.length !== 1) throw new Error(`Expected one global cluster claim: ${JSON.stringify([first, second])}`);
  const winner = first.length ? { consumerId:'cohort_a',runId:'run_a' } : { consumerId:'cohort_b',runId:'run_b' };
  await ledger.transitionRun({ scope:'cluster',consumerId:winner.consumerId,runId:winner.runId,toStatus:'consumed',transitionReason:'rehearsal',clusterClaims:true });
  await pool.query("UPDATE cloud_evolution_evidence_usage SET status='released' WHERE evidence_id='cluster_evidence' AND evolution_scope='cluster' AND consumer_id=$1", [winner.consumerId])
    .then(() => { throw new Error('Consumed evidence unexpectedly reopened.'); }, () => null);
  const claims = Number((await pool.query("SELECT COUNT(*)::int count FROM cloud_cluster_evidence_claims WHERE claim_state='consumed'")).rows[0].count);
  if (claims !== 1) throw new Error(`Expected one permanent consumed claim, received ${claims}.`);
  console.log('Cluster evolution PostgreSQL rehearsal passed: global claim concurrency and consumed immutability verified.');
} finally {
  await api.end().catch(() => null);
  await pool.end().catch(() => null);
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => null);
  await admin.end().catch(() => null);
}
