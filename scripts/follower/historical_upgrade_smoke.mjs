import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-upgrade-'));
const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-upgrade-recovery-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const store = new Store(db, { root });
  const user = { id: 'follower_upgrade_user', displayName: 'Follower Upgrade' };
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES(?,?,?)").run(user.id, 'follower-upgrade@example.test', user.displayName);
  store.ensureAccountWorkspaces({ user });
  const session = store.createSession({ userId: user.id, title: 'Preserved historical session' });
  const message = store.addMessage({ sessionId: session.id, role: 'user', content: 'FOLLOWER_CORE_PRESERVATION_SENTINEL' });
  const before = coreInventory(db, session.id, message.id);
  db.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE IF EXISTS follower_report_projections;
    DROP TABLE IF EXISTS follower_evolution_bindings;
    DROP TABLE IF EXISTS follower_preference_signals;
    DROP TABLE IF EXISTS follower_sync_outbox;
    DROP TABLE IF EXISTS follower_followup_messages;
    DROP TABLE IF EXISTS follower_followup_threads;
    DROP TABLE IF EXISTS follower_report_sources;
    DROP TABLE IF EXISTS follower_reports;
    DROP TABLE IF EXISTS follower_runs;
    DROP TABLE IF EXISTS follower_schedules;
    DROP TABLE IF EXISTS follower_access_events;
    DROP TABLE IF EXISTS follower_access_grants;
    DROP TABLE IF EXISTS follower_workspace_state;
    DROP TABLE IF EXISTS follower_quarantine_events;
    DROP TABLE IF EXISTS work_notification_intents;
    DELETE FROM schema_migrations WHERE id IN ('follower_local_service_v1','follower_cloud_evolution_v1','follower_integrity_hardening_v1','follower_default_cloud_evolution_v1','follower_default_work_sources_v1','database_writer_floor_1_0_0_v1');
    PRAGMA foreign_keys=ON;`);
  db.close(); db = null;
  db = openDatabase(root, { appVersion: '1.0.0' });
  assert.deepEqual(coreInventory(db, session.id, message.id), before);
  for (const table of ['follower_workspace_state','follower_reports','follower_evolution_bindings','follower_report_projections']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  }
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id IN ('follower_local_service_v1','follower_cloud_evolution_v1','follower_integrity_hardening_v1','follower_default_cloud_evolution_v1','follower_default_work_sources_v1')").get().count), 5);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='database_writer_floor_1_0_0_v1'").get().count), 1);
  assert.equal(db.prepare("SELECT min_writer_version FROM database_meta WHERE id='default'").get().min_writer_version, '1.0.0');
  const migratedStore = new Store(db, { root });
  const context = { ownerUserId: user.id, workspaceId: 'workspace_personal' };
  const authorization = migratedStore.followerAccessSnapshot(context);
  const followerRun = migratedStore.createFollowerRun({ id: 'follower_upgrade_run', ...context, kind: 'daily_brief',
    window: { startAt: '2026-08-11T00:00:00.000Z', endAt: '2026-08-12T00:00:00.000Z', timezone: 'Asia/Shanghai' },
    authorization });
  const followerReport = migratedStore.commitFollowerReport({ runId: followerRun.id, reportId: 'follower_upgrade_report',
    report: { schemaVersion: 'follower_report_v2', kind: 'daily_brief', window: followerRun.window, coverage: [],
      claims: [{ id: 'claim_upgrade', status: 'completed', text: 'Historical Follower report', sourceRefs: [] }],
      suggestions: [], summary: 'Historical Follower report' }, renderedBody: 'Historical Follower report',
    syncBody: 'Historical Follower report', privacy: { state: 'passed', validatorVersion: 'follower_privacy_v1',
      validatedHash: 'follower_upgrade_validated_hash', errors: [] } });
  db.prepare('DELETE FROM follower_sync_outbox WHERE report_id=?').run(followerReport.id);
  db.prepare(`UPDATE follower_workspace_state SET report_sync_enabled=0,evolution_enabled=0
    WHERE owner_user_id=? AND account_workspace_id=?`).run(user.id, context.workspaceId);
  db.prepare(`UPDATE follower_access_grants SET enabled=0,revoked_at='2026-08-12T00:00:00.000Z'
    WHERE owner_user_id=? AND account_workspace_id=? AND category IN (
      'sync_sanitized_reports','agent_conversations','task_activity','project_change_metadata','project_file_content')`).run(user.id, context.workspaceId);
  db.prepare(`INSERT INTO follower_access_grants(
    id,owner_user_id,account_workspace_id,category,enabled,scope_version,granted_at,revoked_at,created_at,updated_at
  ) VALUES('legacy_social_grant',?,?, 'social_direct',1,1,'2026-08-12T00:00:00.000Z','','2026-08-12T00:00:00.000Z','2026-08-12T00:00:00.000Z')
  ON CONFLICT(owner_user_id,account_workspace_id,category) DO UPDATE SET enabled=1`).run(user.id, context.workspaceId);
  db.prepare(`UPDATE follower_workspace_state SET disclosure_confirmed=0,disclosure_version=''
    WHERE owner_user_id=? AND account_workspace_id=?`).run(user.id, context.workspaceId);
  migratedStore.upsertFollowerEvolutionBinding({ ...context, patch: { state: 'disabled', reportSyncEnabled: false, evolutionEnabled: false } });
  db.prepare("DELETE FROM schema_migrations WHERE id='follower_default_cloud_evolution_v1'").run();
  db.prepare("DELETE FROM schema_migrations WHERE id='follower_default_work_sources_v1'").run();
  assert.equal(String(db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close(); db = null;
  fs.cpSync(root, recoveryRoot, { recursive: true });
  db = openDatabase(recoveryRoot, { appVersion: '1.0.0' });
  assert.deepEqual(coreInventory(db, session.id, message.id), before);
  assert.equal(db.prepare("SELECT min_writer_version FROM database_meta WHERE id='default'").get().min_writer_version, '1.0.0');
  db.close(); db = null;
  db = openDatabase(root, { appVersion: '1.0.0' });
  assert.deepEqual(coreInventory(db, session.id, message.id), before);
  assert.equal(Number(db.prepare(`SELECT report_sync_enabled FROM follower_workspace_state
    WHERE owner_user_id=? AND account_workspace_id=?`).get(user.id, context.workspaceId).report_sync_enabled), 1);
  assert.equal(Number(db.prepare(`SELECT evolution_enabled FROM follower_workspace_state
    WHERE owner_user_id=? AND account_workspace_id=?`).get(user.id, context.workspaceId).evolution_enabled), 1);
  assert.equal(Number(db.prepare(`SELECT enabled FROM follower_access_grants
    WHERE owner_user_id=? AND account_workspace_id=? AND category='sync_sanitized_reports'`).get(user.id, context.workspaceId).enabled), 1);
  const sourcePolicy = db.prepare(`SELECT category,enabled FROM follower_access_grants
    WHERE owner_user_id=? AND account_workspace_id=? AND category IN (
      'agent_conversations','task_activity','project_change_metadata','project_file_content') ORDER BY category`).all(user.id, context.workspaceId);
  assert.deepEqual(sourcePolicy.map((row) => [row.category, Number(row.enabled)]), [
    ['agent_conversations', 1], ['project_change_metadata', 1], ['project_file_content', 1], ['task_activity', 1],
  ]);
  assert.equal(Number(db.prepare(`SELECT disclosure_confirmed FROM follower_workspace_state
    WHERE owner_user_id=? AND account_workspace_id=?`).get(user.id, context.workspaceId).disclosure_confirmed), 1);
  assert.equal(String(db.prepare(`SELECT disclosure_version FROM follower_workspace_state
    WHERE owner_user_id=? AND account_workspace_id=?`).get(user.id, context.workspaceId).disclosure_version),
  'follower_default_work_sources_v1');
  assert.equal(Number(db.prepare(`SELECT enabled FROM follower_access_grants
    WHERE owner_user_id=? AND account_workspace_id=? AND category='social_direct'`).get(user.id, context.workspaceId).enabled), 1,
  'legacy social grants remain preserved as inactive policy history');
  const migratedBinding = db.prepare(`SELECT state,report_sync_enabled,evolution_enabled FROM follower_evolution_bindings
    WHERE owner_user_id=? AND account_workspace_id=?`).get(user.id, context.workspaceId);
  assert.deepEqual({ state: migratedBinding.state, reportSyncEnabled: Number(migratedBinding.report_sync_enabled),
    evolutionEnabled: Number(migratedBinding.evolution_enabled) }, { state: 'enable_pending', reportSyncEnabled: 1, evolutionEnabled: 1 });
  assert.equal(Number(db.prepare(`SELECT COUNT(*) count FROM follower_sync_outbox
    WHERE report_id=? AND operation='upsert' AND validated_hash=?`).get(followerReport.id, 'follower_upgrade_validated_hash').count), 1);
  db.close(); db = null;
  db = openDatabase(root, { appVersion: '1.0.0' });
  assert.equal(Number(db.prepare(`SELECT COUNT(*) count FROM follower_sync_outbox
    WHERE report_id=? AND operation='upsert' AND validated_hash=?`).get(followerReport.id, 'follower_upgrade_validated_hash').count), 1,
  'second open must not duplicate the migrated upload');
  assert.deepEqual(coreInventory(db, session.id, message.id), before);
  console.log('Follower historical upgrade, recovery-copy, and second-open smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(recoveryRoot, { recursive: true, force: true });
}

function coreInventory(database, sessionId, messageId) {
  const storedSession = database.prepare('SELECT id,user_id,title,status,created_at FROM sessions WHERE id=?').get(sessionId);
  const storedMessage = database.prepare('SELECT id,session_id,role,content,created_at FROM messages WHERE id=?').get(messageId);
  return { storedSession, storedMessage, sessionCount: Number(database.prepare('SELECT COUNT(*) count FROM sessions').get().count),
    messageCount: Number(database.prepare('SELECT COUNT(*) count FROM messages').get().count) };
}
