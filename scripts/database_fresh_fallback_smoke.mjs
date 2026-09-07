import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { listMigrationBackups } from '../src/main/databaseBackup.js';
import { openDatabase } from '../src/main/db.js';
import { inspectDatabaseRecoveryStatus, listRecoveryQuarantines, restoreQuarantinedDatabase, startFreshDatabase } from '../src/main/databaseRecovery.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-fresh-fallback-'));
const failureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-quarantine-failure-'));
const failureSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-quarantine-failure-source-'));
const missingKeyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-quarantine-missing-key-'));
const manifestWarningRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-quarantine-manifest-warning-'));
const walSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-quarantine-wal-source-'));
const walRestoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-quarantine-wal-restore-'));
const diskSpaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-quarantine-disk-space-'));
const replaceFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-quarantine-replace-failure-'));
try {
  let db = openDatabase(root, { appVersion: '0.2.14' });
  db.prepare("INSERT INTO app_settings(key,value) VALUES('fresh_fallback_marker','old-local-data')").run();
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('fallback_user','fallback@example.com','Fallback')").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('fallback_family','Fallback','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('fallback_instance','fallback_user','fallback_family','active')").run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('fallback_session','fallback_user','Old conversation','fallback_family','fallback_instance','primary','writable','active')`).run();
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('fallback_message','fallback_session','user','restore this conversation','fallback_family','fallback_instance')`).run();
  db.prepare(`INSERT INTO message_attachments(id,conversation_id,message_id,name,content_type,size_bytes,sha256)
    VALUES('fallback_attachment','fallback_session','fallback_message','fallback.txt','text/plain',8,'fallback-sha')`).run();
  db.prepare(`INSERT INTO task_runs(id,owner_user_id,title,prompt,status)
    VALUES('fallback_task','fallback_user','Fallback task','Preserve task','completed')`).run();
  db.prepare(`INSERT INTO task_nodes(id,task_run_id,title,objective,status)
    VALUES('fallback_node','fallback_task','Fallback node','Preserve node','completed')`).run();
  db.prepare(`INSERT INTO model_executions(id,user_id,conversation_id,task_run_id,task_node_id,status)
    VALUES('fallback_execution','fallback_user','fallback_session','fallback_task','fallback_node','completed')`).run();
  const beforeIsolation = inspectDatabaseRecoveryStatus(root, { appVersion: '0.2.14' });
  assert.equal(beforeIsolation.data.messages, 1);
  assert.equal(beforeIsolation.data.localOnlyMessages, 1);
  assert.equal(beforeIsolation.data.attachments, 1);
  assert.equal(beforeIsolation.data.isolationWarningRequired, true);
  db.close();
  const keyPath = path.join(root, 'data', 'task-memory-device-key.json');
  const keyContent = `${JSON.stringify({ keyId: 'fresh-fallback-key', key: Buffer.alloc(32, 9).toString('base64') })}\n`;
  fs.writeFileSync(keyPath, keyContent, { mode: 0o600 });

  const result = startFreshDatabase(root, { appVersion: '0.2.14' });
  assert.equal(result.status, 'fresh_database_created');
  assert.equal(result.oldDatabasePreserved, true);
  assert.ok(!JSON.stringify(result).includes(root));

  db = new DatabaseSync(path.join(root, 'data', 'janus.db'), { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='fresh_fallback_marker'").get(), undefined);
  const freshRecoveryState = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='database:fresh_recovery_state'").get().value);
  assert.equal(freshRecoveryState.mode, 'fresh_database_recovery');
  assert.equal(freshRecoveryState.cloudPullCompleted, false);
  assert.equal(freshRecoveryState.bidirectionalSyncEnabled, false);
  db.close();
  db = new DatabaseSync(path.join(root, 'data', 'janus.db'));
  db.prepare("INSERT INTO app_settings(key,value) VALUES('post_fallback_marker','new-database-data')").run();
  db.close();

  const quarantine = path.join(root, 'data', 'recovery-quarantine', result.quarantineId);
  assert.ok(fs.existsSync(path.join(quarantine, 'recovery-manifest.json')));
  assert.equal(fs.readFileSync(path.join(quarantine, 'task-memory-device-key.json'), 'utf8'), keyContent);
  const old = new DatabaseSync(path.join(quarantine, 'janus.db'), { readOnly: true });
  assert.equal(old.prepare("SELECT value FROM app_settings WHERE key='fresh_fallback_marker'").get().value, 'old-local-data');
  old.close();
  assert.equal(inspectDatabaseRecoveryStatus(root, { appVersion: '0.2.14' }).status, 'healthy');
  assert.equal(inspectDatabaseRecoveryStatus(root, { appVersion: '0.2.14', lastError: new Error('old startup failed') }).status, 'recovery_available');
  const candidates = listRecoveryQuarantines(root);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].data.sessions, 1);
  assert.equal(candidates[0].data.messages, 1);
  assert.equal(candidates[0].data.attachments, 1);
  assert.equal(candidates[0].data.taskRuns, 1);
  assert.equal(candidates[0].data.taskNodes, 1);
  assert.equal(candidates[0].data.modelExecutions, 1);
  assert.throws(() => restoreQuarantinedDatabase(root, '../not-allowed', { appVersion: '0.2.15' }), (error) => error.code === 'DB_RESTORE_FAILED');
  const restored = restoreQuarantinedDatabase(root, result.quarantineId, { appVersion: '0.2.15' });
  assert.equal(restored.status, 'quarantine_restored');
  assert.equal(restored.data.messages, 1);
  db = new DatabaseSync(path.join(root, 'data', 'janus.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='fresh_fallback_marker'").get().value, 'old-local-data');
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='fallback_message'").get().content, 'restore this conversation');
  assert.equal(db.prepare("SELECT name FROM message_attachments WHERE id='fallback_attachment'").get().name, 'fallback.txt');
  assert.equal(db.prepare("SELECT title FROM task_runs WHERE id='fallback_task'").get().title, 'Fallback task');
  assert.equal(db.prepare("SELECT title FROM task_nodes WHERE id='fallback_node'").get().title, 'Fallback node');
  assert.equal(db.prepare("SELECT status FROM model_executions WHERE id='fallback_execution'").get().status, 'completed');
  db.close();
  assert.equal(fs.readFileSync(keyPath, 'utf8'), keyContent);
  const currentBackup = listMigrationBackups(root).find((backup) => backup.id === restored.backupId);
  assert.ok(currentBackup);
  const backedUpNewDatabase = new DatabaseSync(currentBackup.backupPath, { readOnly: true });
  assert.equal(backedUpNewDatabase.prepare("SELECT value FROM app_settings WHERE key='post_fallback_marker'").get().value, 'new-database-data');
  backedUpNewDatabase.close();
  assert.ok(listRecoveryQuarantines(root)[0].restoredAt);

  db = openDatabase(failureRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO app_settings(key,value) VALUES('active_database_marker','must-survive-failed-restore')").run();
  db.close();
  db = openDatabase(failureSourceRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('failure_user','failure@example.com','Failure')").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('failure_family','Failure','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('failure_canonical','failure_user','failure_family','active')").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('failure_alias','failure_user','failure_family','active')").run();
  db.prepare("INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason) VALUES('failure_alias','failure_canonical','failure_user','forced_failure')").run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('failure_session','failure_user','Failure','failure_family','failure_alias','primary','writable','active')`).run();
  db.exec("CREATE TRIGGER force_quarantine_restore_failure BEFORE UPDATE OF agent_instance_id ON sessions BEGIN SELECT RAISE(ABORT,'forced quarantine restore failure'); END");
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA journal_mode=DELETE');
  db.close();
  const failedQuarantineId = 'forced-migration-failure';
  const failedQuarantine = path.join(failureRoot, 'data', 'recovery-quarantine', failedQuarantineId);
  fs.mkdirSync(failedQuarantine, { recursive: true });
  fs.copyFileSync(path.join(failureSourceRoot, 'data', 'janus.db'), path.join(failedQuarantine, 'janus.db'));
  fs.writeFileSync(path.join(failedQuarantine, 'recovery-manifest.json'), `${JSON.stringify({
    schema: 'janus-database-quarantine-v1', id: failedQuarantineId, createdAt: new Date().toISOString(), reason: 'test_failure',
  })}\n`, 'utf8');
  assert.throws(() => restoreQuarantinedDatabase(failureRoot, failedQuarantineId, { appVersion: '0.2.15' }),
    (error) => error.code === 'DB_MIGRATION_FAILED' && error.phase === 'quarantine_restore');
  db = new DatabaseSync(path.join(failureRoot, 'data', 'janus.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='active_database_marker'").get().value, 'must-survive-failed-restore');
  db.close();
  const corruptQuarantineId = 'corrupt-database';
  const corruptQuarantine = path.join(failureRoot, 'data', 'recovery-quarantine', corruptQuarantineId);
  fs.mkdirSync(corruptQuarantine, { recursive: true });
  fs.writeFileSync(path.join(corruptQuarantine, 'janus.db'), Buffer.from('not-a-sqlite-database'));
  assert.equal(listRecoveryQuarantines(failureRoot).find((item) => item.id === corruptQuarantineId).integrity, 'unavailable');
  assert.throws(() => restoreQuarantinedDatabase(failureRoot, corruptQuarantineId, { appVersion: '0.2.15' }),
    (error) => error.code === 'DB_INTEGRITY_FAILED' && error.phase === 'quarantine_select');
  db = new DatabaseSync(path.join(failureRoot, 'data', 'janus.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='active_database_marker'").get().value, 'must-survive-failed-restore');
  db.close();

  db = openDatabase(missingKeyRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO app_settings(key,value) VALUES('missing_key_old_marker','restore-without-key')").run();
  db.close();
  const missingKeyPath = path.join(missingKeyRoot, 'data', 'task-memory-device-key.json');
  fs.writeFileSync(missingKeyPath, `${JSON.stringify({ keyId: 'old-key', key: Buffer.alloc(32, 3).toString('base64') })}\n`, { mode: 0o600 });
  const missingKeyFallback = startFreshDatabase(missingKeyRoot, { appVersion: '0.2.15' });
  const missingKeyQuarantine = path.join(missingKeyRoot, 'data', 'recovery-quarantine', missingKeyFallback.quarantineId);
  fs.rmSync(path.join(missingKeyQuarantine, 'task-memory-device-key.json'), { force: true });
  const replacementKeyContent = `${JSON.stringify({ keyId: 'replacement-key', key: Buffer.alloc(32, 4).toString('base64') })}\n`;
  fs.writeFileSync(missingKeyPath, replacementKeyContent, { mode: 0o600 });
  const missingKeyRestored = restoreQuarantinedDatabase(missingKeyRoot, missingKeyFallback.quarantineId, { appVersion: '0.2.15' });
  assert.equal(missingKeyRestored.taskMemoryKeyRestored, false);
  assert.equal(fs.readFileSync(missingKeyPath, 'utf8'), replacementKeyContent);
  db = new DatabaseSync(path.join(missingKeyRoot, 'data', 'janus.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='missing_key_old_marker'").get().value, 'restore-without-key');
  db.close();

  db = openDatabase(manifestWarningRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO app_settings(key,value) VALUES('manifest_warning_marker','restore-even-if-manifest-write-fails')").run();
  db.close();
  const manifestFallback = startFreshDatabase(manifestWarningRoot, { appVersion: '0.2.15' });
  const manifestWarningQuarantine = path.join(manifestWarningRoot, 'data', 'recovery-quarantine', manifestFallback.quarantineId);
  const blockedManifestPath = path.join(manifestWarningQuarantine, 'recovery-manifest.json');
  fs.rmSync(blockedManifestPath, { force: true });
  fs.mkdirSync(blockedManifestPath);
  const manifestWarningRestored = restoreQuarantinedDatabase(manifestWarningRoot, manifestFallback.quarantineId, { appVersion: '0.2.15' });
  assert.equal(manifestWarningRestored.status, 'quarantine_restored');
  assert.match(manifestWarningRestored.warning, /manifest could not be updated/i);
  db = new DatabaseSync(path.join(manifestWarningRoot, 'data', 'janus.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='manifest_warning_marker'").get().value, 'restore-even-if-manifest-write-fails');
  db.close();

  const walSource = openDatabase(walSourceRoot, { appVersion: '0.2.15' });
  walSource.exec('PRAGMA wal_autocheckpoint=0');
  walSource.prepare("INSERT INTO app_settings(key,value) VALUES('wal_only_marker','preserve-wal-commit')").run();
  const walSourceDatabase = path.join(walSourceRoot, 'data', 'janus.db');
  assert.ok(fs.existsSync(`${walSourceDatabase}-wal`) && fs.statSync(`${walSourceDatabase}-wal`).size > 0);
  db = openDatabase(walRestoreRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO app_settings(key,value) VALUES('wal_restore_active_marker','current-before-wal-restore')").run();
  db.close();
  const walQuarantineId = 'wal-preservation';
  const walQuarantine = path.join(walRestoreRoot, 'data', 'recovery-quarantine', walQuarantineId);
  fs.mkdirSync(walQuarantine, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${walSourceDatabase}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(walQuarantine, `janus.db${suffix}`));
  }
  fs.writeFileSync(path.join(walQuarantine, 'recovery-manifest.json'), `${JSON.stringify({
    schema: 'janus-database-quarantine-v1', id: walQuarantineId, createdAt: new Date().toISOString(), reason: 'wal_test',
  })}\n`, 'utf8');
  walSource.close();
  const walRestored = restoreQuarantinedDatabase(walRestoreRoot, walQuarantineId, { appVersion: '0.2.15' });
  assert.equal(walRestored.status, 'quarantine_restored');
  db = new DatabaseSync(path.join(walRestoreRoot, 'data', 'janus.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='wal_only_marker'").get().value, 'preserve-wal-commit');
  db.close();

  db = openDatabase(diskSpaceRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO app_settings(key,value) VALUES('disk_space_marker','must-survive-disk-space-refusal')").run();
  db.close();
  const diskSpaceDatabase = path.join(diskSpaceRoot, 'data', 'janus.db');
  const diskStats = fs.statfsSync(path.join(diskSpaceRoot, 'data'));
  fs.writeFileSync(`${diskSpaceDatabase}-wal`, '');
  fs.truncateSync(`${diskSpaceDatabase}-wal`, Number(diskStats.bavail) * Number(diskStats.bsize) + 1024);
  assert.throws(() => startFreshDatabase(diskSpaceRoot, { appVersion: '0.2.15' }),
    (error) => error.code === 'DB_DISK_SPACE' && error.phase === 'disk_space');
  fs.rmSync(`${diskSpaceDatabase}-wal`, { force: true });
  db = new DatabaseSync(diskSpaceDatabase, { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='disk_space_marker'").get().value, 'must-survive-disk-space-refusal');
  db.close();

  db = openDatabase(replaceFailureRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO app_settings(key,value) VALUES('replace_failure_marker','must-survive-replacement-failure')").run();
  db.close();
  assert.throws(() => startFreshDatabase(replaceFailureRoot, {
    appVersion: '0.2.15',
    beforeReplace() { throw new Error('injected fresh database replacement failure'); },
  }), (error) => error.code === 'DB_RESTORE_FAILED' && error.phase === 'fresh_database_replace');
  db = new DatabaseSync(path.join(replaceFailureRoot, 'data', 'janus.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='replace_failure_marker'").get().value, 'must-survive-replacement-failure');
  db.close();
  process.stdout.write('Database fresh fallback smoke passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(failureRoot, { recursive: true, force: true });
  fs.rmSync(failureSourceRoot, { recursive: true, force: true });
  fs.rmSync(missingKeyRoot, { recursive: true, force: true });
  fs.rmSync(manifestWarningRoot, { recursive: true, force: true });
  fs.rmSync(walSourceRoot, { recursive: true, force: true });
  fs.rmSync(walRestoreRoot, { recursive: true, force: true });
  fs.rmSync(diskSpaceRoot, { recursive: true, force: true });
  fs.rmSync(replaceFailureRoot, { recursive: true, force: true });
}
