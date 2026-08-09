import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_DIR = path.resolve(__dirname, '../database');
const BASELINE_PATH = path.join(DATABASE_DIR, 'baseline-sync8.sql');
const SEED_PATH = path.join(DATABASE_DIR, 'seed-agent-catalog.sql');
const MIGRATIONS_DIR = path.join(DATABASE_DIR, 'migrations');
const PG_MEM_BASELINE_PATH = path.resolve(__dirname, '../test/fixtures/pg-mem-baseline.sql');

export const CLOUD_DATABASE_BASELINE_ID = 'baseline_sync8_081';
export const CLOUD_DATABASE_MIGRATION_HEAD = '084_janus_clean_slate_identity.sql';
const CLOUD_REQUIRED_RELATIONS = Object.freeze([
  'accounts',
  'account_memberships_v8',
  'account_workspace_bindings_v8',
  'cloud_sync_batches_v8',
  'cloud_sync_entities_v8',
  'cloud_sync_changes_v8',
  'cloud_sync_snapshots_v8',
  'provider_key_applications',
  'janus_database_identity',
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
  if (pgMem) {
    await pool.query(await fs.readFile(PG_MEM_BASELINE_PATH, 'utf8'));
    await pool.query(await fs.readFile(SEED_PATH, 'utf8'));
    await applyMigrationFiles(pool, migrationsDir, { pgMem: true });
    return;
  }
  const relationCount = Number((await pool.query(`SELECT count(*) AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')`)).rows[0]?.count || 0);
  if (relationCount === 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await fs.readFile(BASELINE_PATH, 'utf8'));
      await client.query(await fs.readFile(SEED_PATH, 'utf8'));
      await client.query("INSERT INTO public.schema_migrations(filename) VALUES('seed_agent_catalog_sync8') ON CONFLICT(filename) DO NOTHING");
      await client.query('COMMIT');
      console.info(`[janus-cloud] applied ${CLOUD_DATABASE_BASELINE_ID}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else {
    const ledger = await pool.query(`SELECT to_regclass('public.schema_migrations') AS relation`);
    if (!ledger.rows[0]?.relation) throw new Error('Non-empty database has no schema_migrations ledger; refusing automatic baseline.');
    const baseline = await pool.query('SELECT 1 FROM public.schema_migrations WHERE filename=$1', [CLOUD_DATABASE_BASELINE_ID]);
    if (!baseline.rowCount) {
      throw new Error(`Existing database must pass mark-baseline-equivalent before post-baseline migrations can run (${CLOUD_DATABASE_BASELINE_ID}).`);
    }
  }
  await applyMigrationFiles(pool, migrationsDir, { pgMem: false });
}

export async function applyMigrationFiles(pool, migrationsDir, { pgMem = pool?.constructor?.name === 'MemPg' } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const existing = await pool.query('SELECT filename FROM public.schema_migrations WHERE filename = $1', [file]);
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
      await client.query('SET LOCAL search_path TO public, pg_catalog');
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [file]);
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
    const result = await pool.query('SELECT filename FROM public.schema_migrations ORDER BY applied_at,filename');
    appliedMigrations = result.rows.map((row) => String(row.filename || '')).filter(Boolean);
  } catch (error) {
    if (error?.code !== '42P01' && !/schema_migrations.*does not exist/i.test(String(error?.message || ''))) throw error;
    migrationTableAvailable = false;
  }
  const relationResult = await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN (
      'accounts','account_memberships_v8','account_workspace_bindings_v8','cloud_sync_batches_v8',
      'cloud_sync_entities_v8','cloud_sync_changes_v8','cloud_sync_snapshots_v8','provider_key_applications',
      'janus_database_identity'
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
