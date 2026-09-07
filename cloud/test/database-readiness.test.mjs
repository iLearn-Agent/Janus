import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import {
  CLOUD_DATABASE_MIGRATION_HEAD,
  assertCloudDatabaseReady,
  cloudDatabaseReadiness,
} from '../src/db.mjs';

test('cloud database readiness fails closed until the Janus Sync9 schema is complete', async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await pool.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  await pool.query('CREATE TABLE cloud_user_agent_instances_v3(id text PRIMARY KEY)');

  const before = await cloudDatabaseReadiness(pool);
  assert.equal(before.ready, false);
  assert.deepEqual(before.missingMigrations, [CLOUD_DATABASE_MIGRATION_HEAD]);
  assert.ok(before.missingRelations.includes('accounts'));
  assert.deepEqual(before.missingColumns, ['cloud_user_agent_instances_v3.family_instance_seq']);
  await assert.rejects(() => assertCloudDatabaseReady(pool), (error) => (
    error.code === 'CLOUD_DATABASE_MIGRATION_REQUIRED'
      && error.readiness?.requiredMigrationHead === CLOUD_DATABASE_MIGRATION_HEAD
  ));

  for (const table of [
    'accounts', 'account_memberships_v8', 'account_workspace_bindings_v8', 'cloud_sync_batches_v8',
    'cloud_sync_entities_v8', 'cloud_sync_changes_v8', 'cloud_sync_snapshots_v8', 'cloud_sync_reference_repairs',
    'provider_key_applications',
    'janus_database_identity', 'organization_research_policies', 'organization_research_documents',
    'organization_research_changes', 'organization_research_device_leases', 'organization_research_audits',
    'cloud_follower_report_projections', 'cloud_follower_report_changes', 'cloud_follower_raw_reports', 'cloud_follower_followup_messages',
    'cloud_follower_service_bindings', 'cloud_follower_preference_signals', 'cloud_follower_system_bundles',
    'cloud_follower_personal_decisions', 'cloud_follower_cluster_candidate_evidence',
    'cloud_follower_cluster_reviews',
    'ubuddy_org_trace_events', 'ubuddy_org_pattern_evidence', 'ubuddy_org_evolution_run_events',
    'ubuddy_org_policy_versions', 'ubuddy_org_policy_evaluations', 'ubuddy_org_activation_commands',
    'ubuddy_org_policy_health_events', 'chat_group_message_receipts', 'emoji_favorites',
    'voice_call_sessions', 'voice_call_participants', 'voice_call_events',
  ]) await pool.query(`CREATE TABLE ${table}(id text)`);
  await pool.query('ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN family_instance_seq integer NOT NULL DEFAULT 0');
  await pool.query('INSERT INTO schema_migrations(filename) VALUES($1)', [CLOUD_DATABASE_MIGRATION_HEAD]);

  const after = await assertCloudDatabaseReady(pool);
  assert.equal(after.ready, true);
  assert.equal(after.migrationHead, CLOUD_DATABASE_MIGRATION_HEAD);
  assert.deepEqual(after.missingRelations, []);
  assert.deepEqual(after.missingColumns, []);
  await pool.end();
});
