import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const databaseUrl = String(process.env.JANUS_REHEARSAL_DATABASE_URL || '');
const allowed = String(process.env.JANUS_ALLOW_DATABASE_REHEARSAL || '').toLowerCase() === 'true';
if (!databaseUrl || !allowed) {
  console.log('Sync V6 PostgreSQL rehearsal skipped: set JANUS_REHEARSAL_DATABASE_URL and JANUS_ALLOW_DATABASE_REHEARSAL=true.');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'cloud', 'migrations');
const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
const schema = `janus_sync_v6_rehearsal_${crypto.randomBytes(6).toString('hex')}`;
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 1,
  connectionTimeoutMillis: 10_000,
});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for (let pass = 1; pass <= 2; pass += 1) {
    for (const file of files) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [file]);
      if (existing.rowCount) continue;
      await client.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [file]);
    }
  }
  for (const table of [
    'cloud_devices_v6', 'cloud_sync_changes_v6', 'cloud_sync_conflicts_v6', 'cloud_file_objects_v6',
    'cloud_task_key_device_envelopes_v6', 'cloud_task_key_access_audits_v6', 'cloud_chat_context_states',
  ]) {
    const row = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2`, [schema, table]);
    if (!row.rowCount) throw new Error(`Sync V6 rehearsal table is missing: ${table}`);
  }
  const recoveryColumn = await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='cloud_task_security_contexts_v5' AND column_name='cloud_sync_recovery_allowed'`, [schema]);
  if (!recoveryColumn.rowCount) throw new Error('cloud_sync_recovery_allowed migration is missing.');
  await client.query('ROLLBACK');
  console.log(`Sync V6 PostgreSQL rehearsal passed: ${files.length} migrations verified across two migrator passes and rolled back from ${schema}.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => null);
  throw error;
} finally {
  client.release();
  await pool.end();
}
