#!/usr/bin/env node

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createPgPool } from '../src/db.mjs';

const dryRun = process.argv.includes('--dry-run');
const sqlitePath = argument('--sqlite') || process.env.JANUS_LEGACY_CLOUD_DB || '';
const databaseUrl = process.env.DATABASE_MIGRATOR_URL || '';
if (!sqlitePath) throw new Error('Pass --sqlite or set JANUS_LEGACY_CLOUD_DB explicitly.');
if (!fs.existsSync(sqlitePath)) throw new Error(`Legacy SQLite database was not found: ${sqlitePath}`);
if (!databaseUrl) throw new Error('DATABASE_MIGRATOR_URL is required.');

const ephemeral = new Set([
  'auth_access_tokens', 'auth_refresh_tokens', 'auth_email_verifications', 'cloud_sync_grants',
  'request_audit', 'sync_batches', 'sync_migrations', 'release_manifests', 'server_records',
]);
const orderedTables = [
  'users', 'devices', 'friend_requests', 'friendships', 'social_messages', 'user_presence',
  'social_ubuddy_capability_profiles', 'social_ubuddy_capability_profile_commands',
  'collaboration_groups', 'collaboration_group_members', 'collaboration_group_messages',
  'agent_delegations', 'agent_delegation_revisions', 'agent_delegation_workspaces', 'agent_delegation_workspace_messages',
  'cloud_agent_families_v3', 'cloud_agent_versions_v3', 'cloud_user_agent_instances_v3',
  'cloud_projects_v2', 'cloud_conversations_v2', 'cloud_messages_v2', 'cloud_transcripts_v2', 'cloud_model_executions_v2',
  'cloud_memory_documents_v3', 'cloud_memory_document_versions_v3', 'cloud_memory_sync_mappings', 'cloud_agent_context_spaces',
  'cloud_task_runs', 'cloud_task_nodes', 'file_objects', 'file_links',
];

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const pool = createPgPool(databaseUrl);
const summary = { dryRun, source: {}, compatible: {}, imported: {}, skippedTables: [] };
try {
  const targetTables = new Set((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((row) => row.table_name));
  const sourceTables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  const client = dryRun ? null : await pool.connect();
  try {
    if (client) await client.query('BEGIN');
    for (const table of orderedTables) {
      if (ephemeral.has(table) || !sourceTables.has(table) || !targetTables.has(table)) {
        summary.skippedTables.push(table);
        continue;
      }
      const rows = sqlite.prepare(`SELECT * FROM ${quoteSqlite(table)}`).all();
      summary.source[table] = rows.length;
      const columns = await targetColumns(pool, table);
      const sourceColumns = new Set(sqlite.prepare(`PRAGMA table_info(${quoteSqlite(table)})`).all().map((row) => row.name));
      const shared = columns.filter((column) => sourceColumns.has(column.name) && column.generated === 'NEVER');
      summary.compatible[table] = shared.map((column) => column.name);
      if (!shared.length || dryRun) continue;
      let imported = 0;
      for (const row of rows) {
        const values = shared.map((column) => convertValue(row[column.name], column));
        const names = shared.map((column) => quotePg(column.name)).join(',');
        const placeholders = shared.map((_, index) => `$${index + 1}`).join(',');
        await client.query(`INSERT INTO ${quotePg(table)} (${names}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
        imported += 1;
      }
      summary.imported[table] = imported;
    }
    if (client) await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally {
    client?.release();
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  sqlite.close();
  await pool.end();
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

async function targetColumns(pool, table) {
  const result = await pool.query(`SELECT column_name AS name,data_type AS type,is_generated AS generated
    FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  return result.rows;
}

function convertValue(value, column) {
  if (value === undefined || value === null) return null;
  if (column.type === 'boolean') return value === true || value === 1 || value === '1' || value === 'true';
  if (['json', 'jsonb'].includes(column.type)) {
    if (typeof value !== 'string') return JSON.stringify(value);
    try { return JSON.stringify(JSON.parse(value || '{}')); } catch { return JSON.stringify({ legacyValue: value }); }
  }
  if (column.type.includes('timestamp') && value === '') return null;
  return value;
}

function quotePg(value) { return `"${String(value).replaceAll('"', '""')}"`; }
function quoteSqlite(value) { return `"${String(value).replaceAll('"', '""')}"`; }
