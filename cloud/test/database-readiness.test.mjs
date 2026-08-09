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
    'cloud_sync_entities_v8', 'cloud_sync_changes_v8', 'cloud_sync_snapshots_v8', 'provider_key_applications',
    'janus_database_identity',
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
