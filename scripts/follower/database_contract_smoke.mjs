import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { assertDatabaseMigrationRegistry, databaseMigration } from '../../src/main/modules/persistence/infrastructure/databaseMigrationRegistry.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-db-'));
let db;
try {
  assert.equal(assertDatabaseMigrationRegistry(), true);
  const declaration = databaseMigration('follower_local_service_v1');
  assert.equal(declaration?.riskDeclarationSource, 'explicit');
  assert.equal(declaration?.risk?.idempotent, true);
  assert.equal(declaration?.risk?.rollbackSafe, true);
  const cloudDeclaration = databaseMigration('follower_cloud_evolution_v1');
  assert.equal(cloudDeclaration?.riskDeclarationSource, 'explicit');
  assert.equal(cloudDeclaration?.risk?.idempotent, true);
  assert.deepEqual(cloudDeclaration?.risk?.requiredCapabilities, ['follower-report-projection-v1', 'follower-system-service-v1', 'follower-evidence-v1']);
  db = openDatabase(root, { appVersion: '1.0.0' });
  const required = [
    'follower_workspace_state', 'follower_access_grants', 'follower_access_events', 'follower_schedules',
    'follower_runs', 'follower_reports', 'follower_report_sources', 'follower_followup_threads',
    'follower_followup_messages', 'follower_sync_outbox', 'follower_preference_signals', 'follower_evolution_bindings',
    'follower_report_projections', 'work_notification_intents',
    'follower_quarantine_events',
  ];
  for (const table of required) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('follower_report_sources') WHERE name='ref_id'").get());
  const before = {
    sessions: Number(db.prepare('SELECT COUNT(*) count FROM sessions').get().count),
    messages: Number(db.prepare('SELECT COUNT(*) count FROM messages').get().count),
    tasks: Number(db.prepare('SELECT COUNT(*) count FROM task_runs').get().count),
    digests: Number(db.prepare('SELECT COUNT(*) count FROM work_digest_jobs').get().count),
  };
  const store = new Store(db, { root });
  const access = store.updateFollowerAccess({ ownerUserId: 'follower_test_user', workspaceId: 'workspace_personal',
    disclosureConfirmed: false, disclosureVersion: '', grants: { task_activity: false, agent_conversations: false,
      project_change_metadata: false, project_file_content: false } });
  assert.equal(access.disclosureConfirmed, true);
  assert.equal(access.disclosureVersion, 'follower_default_work_sources_v1');
  assert.deepEqual(Object.fromEntries(['task_activity', 'agent_conversations', 'project_change_metadata', 'project_file_content']
    .map((category) => [category, access.grants[category]])), {
    task_activity: true, agent_conversations: true, project_change_metadata: true, project_file_content: true,
  });
  assert.equal('social_direct' in access.grants, false);
  assert.equal('social_groups' in access.grants, false);
  assert.equal('private_assistant' in access.grants, false);
  const run = store.createFollowerRun({ ownerUserId: 'follower_test_user', workspaceId: 'workspace_personal', kind: 'daily_brief',
    clientRequestId: 'manual_request_1', window: { startAt: '2026-08-11T16:00:00.000Z', endAt: '2026-08-12T12:00:00.000Z', timezone: 'Asia/Shanghai' }, authorization: access });
  assert.equal(store.createFollowerRun({ ownerUserId: 'follower_test_user', workspaceId: 'workspace_personal', kind: 'daily_brief',
    clientRequestId: 'manual_request_1', window: run.window, authorization: access }).id, run.id);
  const report = store.commitFollowerReport({ runId: run.id, report: { schemaVersion: 'follower_report_v2', kind: 'daily_brief', window: run.window,
    coverage: [], claims: [], suggestions: [], summary: 'No activity.' }, renderedBody: 'No activity.', syncBody: 'No activity.', sources: [],
    privacy: { state: 'passed', validatorVersion: 'follower_privacy_v1', validatedHash: 'hash' } });
  assert.equal(report.runId, run.id);
  assert.equal(store.getFollowerRun(run.id).status, 'completed');
  assert.throws(() => store.createFollowerRun({ ownerUserId: 'follower_test_user', workspaceId: 'workspace_personal', kind: 'daily_brief',
    clientRequestId: 'manual_request_1', window: { ...run.window, endAt: '2026-08-12T13:00:00.000Z' }, authorization: access }),
  (error) => error.code === 'follower_run_identity_collision');
  assert.throws(() => store.commitFollowerReport({ runId: run.id, report: { ...report.report, summary: 'Conflicting report.' },
    renderedBody: 'Conflicting report.', syncBody: 'Conflicting report.', sources: [],
    privacy: { state: 'passed', validatorVersion: 'follower_privacy_v1', validatedHash: 'different_hash' } }),
  (error) => error.code === 'follower_report_identity_collision');
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM follower_quarantine_events').get().count), 2);
  const after = {
    sessions: Number(db.prepare('SELECT COUNT(*) count FROM sessions').get().count),
    messages: Number(db.prepare('SELECT COUNT(*) count FROM messages').get().count),
    tasks: Number(db.prepare('SELECT COUNT(*) count FROM task_runs').get().count),
    digests: Number(db.prepare('SELECT COUNT(*) count FROM work_digest_jobs').get().count),
  };
  assert.deepEqual(after, before);
  assert.equal(String(db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close(); db = null;
  db = openDatabase(root, { appVersion: '1.0.0' });
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM follower_reports').get().count), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='follower_local_service_v1'").get().count), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='follower_cloud_evolution_v1'").get().count), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='follower_integrity_hardening_v1'").get().count), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='follower_default_work_sources_v1'").get().count), 1);
  console.log('Follower database contract smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
