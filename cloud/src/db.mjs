import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

export const CLOUD_DATABASE_MIGRATION_HEAD = '096_voice_call_state.sql';
const CLOUD_REQUIRED_RELATIONS = Object.freeze([
  'accounts',
  'account_memberships_v8',
  'account_workspace_bindings_v8',
  'cloud_sync_batches_v8',
  'cloud_sync_entities_v8',
  'cloud_sync_changes_v8',
  'cloud_sync_snapshots_v8',
  'cloud_sync_reference_repairs',
  'provider_key_applications',
  'janus_database_identity',
  'organization_research_policies',
  'organization_research_documents',
  'organization_research_changes',
  'organization_research_device_leases',
  'organization_research_audits',
  'cloud_follower_report_projections',
  'cloud_follower_report_changes',
  'cloud_follower_raw_reports',
  'cloud_follower_followup_messages',
  'cloud_follower_service_bindings',
  'cloud_follower_preference_signals',
  'cloud_follower_system_bundles',
  'cloud_follower_personal_decisions',
  'cloud_follower_cluster_candidate_evidence',
  'cloud_follower_cluster_reviews',
  'ubuddy_org_trace_events',
  'ubuddy_org_pattern_evidence',
  'ubuddy_org_evolution_run_events',
  'ubuddy_org_policy_versions',
  'ubuddy_org_policy_evaluations',
  'ubuddy_org_activation_commands',
  'ubuddy_org_policy_health_events',
  'chat_group_message_receipts',
  'emoji_favorites',
  'voice_call_sessions',
  'voice_call_participants',
  'voice_call_events',
]);

export function createPgPool(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  return new pg.Pool({
    connectionString: databaseUrl,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
}

export async function migrate(pool, migrationsDir = MIGRATIONS_DIR) {
  const pgMem = pool?.constructor?.name === 'MemPg';
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const existing = await pool.query('SELECT filename FROM schema_migrations WHERE filename = $1', [file]);
    if (existing.rowCount > 0) continue;
    let sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    if (pgMem && sql.includes('requires-real-postgres:')) {
      console.info(`[janus-cloud] skipped real-PostgreSQL migration ${file} under pg-mem`);
      continue;
    }
    if (pgMem && sql.includes('requires-real-postgres-tail:')) {
      sql = sql.split(/--\s*requires-real-postgres-tail:[^\r\n]*/i, 1)[0];
      console.info(`[janus-cloud] skipped real-PostgreSQL tail for ${file} under pg-mem`);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.info(`[janus-cloud] applied migration ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function assertDatabaseRole(pool, role, { required = true } = {}) {
  if (!required) return true;
  const result = await pool.query("SELECT pg_has_role(current_user,$1,'member') AS allowed", [role]);
  if (!result.rows[0]?.allowed) throw new Error(`Database login must be a member of ${role}.`);
  return true;
}

export async function cloudDatabaseReadiness(pool) {
  let appliedMigrations = [];
  let migrationTableAvailable = true;
  try {
    const result = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    appliedMigrations = result.rows.map((row) => String(row.filename || '')).filter(Boolean);
  } catch (error) {
    if (error?.code !== '42P01' && !/schema_migrations.*does not exist/i.test(String(error?.message || ''))) throw error;
    migrationTableAvailable = false;
  }
  const relationResult = await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN (
      'accounts','account_memberships_v8','account_workspace_bindings_v8','cloud_sync_batches_v8',
      'cloud_sync_entities_v8','cloud_sync_changes_v8','cloud_sync_snapshots_v8','provider_key_applications',
      'cloud_sync_reference_repairs',
      'janus_database_identity','organization_research_policies','organization_research_documents',
      'organization_research_changes','organization_research_device_leases','organization_research_audits',
      'cloud_follower_report_projections','cloud_follower_report_changes','cloud_follower_raw_reports','cloud_follower_followup_messages','cloud_follower_service_bindings','cloud_follower_preference_signals','cloud_follower_system_bundles',
      'cloud_follower_personal_decisions','cloud_follower_cluster_candidate_evidence','cloud_follower_cluster_reviews',
      'ubuddy_org_trace_events','ubuddy_org_pattern_evidence','ubuddy_org_evolution_run_events',
      'ubuddy_org_policy_versions','ubuddy_org_policy_evaluations','ubuddy_org_activation_commands','ubuddy_org_policy_health_events',
      'chat_group_message_receipts','emoji_favorites',
      'voice_call_sessions','voice_call_participants','voice_call_events'
    )`);
  const availableRelations = new Set(relationResult.rows.map((row) => String(row.table_name || '')));
  const missingRelations = CLOUD_REQUIRED_RELATIONS.filter((name) => !availableRelations.has(name));
  const employeeProfileColumn = await pool.query(`SELECT 1 AS available FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cloud_user_agent_instances_v3'
      AND column_name='family_instance_seq' LIMIT 1`);
  const missingColumns = employeeProfileColumn.rows.length ? [] : ['cloud_user_agent_instances_v3.family_instance_seq'];
  const missingMigrations = appliedMigrations.includes(CLOUD_DATABASE_MIGRATION_HEAD)
    ? [] : [CLOUD_DATABASE_MIGRATION_HEAD];
  return {
    ready: migrationTableAvailable && missingMigrations.length === 0 && missingRelations.length === 0 && missingColumns.length === 0,
    migrationHead: appliedMigrations.at(-1) || '',
    requiredMigrationHead: CLOUD_DATABASE_MIGRATION_HEAD,
    missingMigrations,
    missingRelations,
    missingColumns,
  };
}

export async function assertCloudDatabaseReady(pool) {
  const readiness = await cloudDatabaseReadiness(pool);
  if (readiness.ready) return readiness;
  const error = new Error(`Cloud database migration is incomplete: ${[
    ...readiness.missingMigrations,
    ...readiness.missingRelations,
    ...readiness.missingColumns,
  ].join(', ')}`);
  error.code = 'CLOUD_DATABASE_MIGRATION_REQUIRED';
  error.readiness = readiness;
  throw error;
}

export async function inTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
