import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MARKER_NAME = 'test-profile-seed-v1.json';
const COPY_DIRECTORIES = ['config', 'departments', 'system_agents', 'skills', 'outputs'];

/**
 * Seed the isolated test profile from the stable profile once. The database is
 * copied through SQLite's VACUUM INTO so WAL contents are included safely. The
 * test profile then receives a new device identity and must obtain fresh cloud
 * grants; local history and employee records remain available for validation.
 */
export function importStableProfileForTest({ targetRoot = '', stableRoot = '', appVersion = '', logger = console } = {}) {
  const target = path.resolve(String(targetRoot || '').trim());
  const stable = path.resolve(String(stableRoot || '').trim());
  if (!target || !stable || target === stable) return { status: 'skipped', reason: 'invalid_roots' };

  const targetData = path.join(target, 'data');
  const targetDbPath = path.join(targetData, 'janus.db');
  const stableDbPath = path.join(stable, 'data', 'janus.db');
  const markerPath = path.join(targetData, MARKER_NAME);
  if (fs.existsSync(targetDbPath) && fs.statSync(targetDbPath).size > 0) {
    const marker = readMarker(markerPath);
    return { status: 'already_seeded', markerPath, appVersion: marker?.appVersion || '', requestedVersion: String(appVersion || '').trim() };
  }
  if (!fs.existsSync(stableDbPath)) return { status: 'skipped', reason: 'stable_database_missing' };

  fs.mkdirSync(targetData, { recursive: true });
  const backupPath = fs.existsSync(targetDbPath)
    ? backupExistingTestProfile(target, targetData)
    : '';
  const temporaryDb = path.join(targetData, `.janus-stable-import-${process.pid}-${Date.now()}.db`);
  let sourceDb;
  try {
    sourceDb = new DatabaseSync(stableDbPath, { readOnly: false });
    sourceDb.exec('PRAGMA wal_checkpoint(FULL)');
    sourceDb.prepare('VACUUM INTO ?').run(temporaryDb);
  } finally {
    try { sourceDb?.close(); } catch {}
  }

  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${targetDbPath}${suffix}`, { force: true });
  }
  fs.renameSync(temporaryDb, targetDbPath);
  copyProfileDirectories(stable, target);
  const deviceId = resetCopiedCloudIdentity(targetDbPath);
  const marker = {
    schemaVersion: 1,
    status: 'imported',
    sourceRoot: stable,
    sourceDatabaseSha256: sha256File(stableDbPath),
    appVersion: String(appVersion || '').trim(),
    importedAt: new Date().toISOString(),
    testDeviceId: deviceId,
    backupPath,
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  logger.info?.(`[janus-test] imported stable profile into ${target}`);
  return { ...marker, markerPath };
}

function readMarker(markerPath) {
  try {
    const value = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function backupExistingTestProfile(targetRoot, targetData) {
  const backupRoot = path.join(targetData, 'test-profile-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${path.join(targetData, 'janus.db')}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backupRoot, `janus.db${suffix}`));
  }
  for (const name of [...COPY_DIRECTORIES, 'PROJECT_MEMORY.md']) {
    const source = path.join(targetRoot, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(backupRoot, name), { recursive: true });
  }
  return backupRoot;
}

function copyProfileDirectories(sourceRoot, targetRoot) {
  for (const name of COPY_DIRECTORIES) {
    const source = path.join(sourceRoot, name);
    if (!fs.existsSync(source)) continue;
    fs.rmSync(path.join(targetRoot, name), { recursive: true, force: true });
    fs.cpSync(source, path.join(targetRoot, name), { recursive: true });
  }
  for (const name of ['PROJECT_MEMORY.md']) {
    const source = path.join(sourceRoot, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(targetRoot, name));
  }
}

function resetCopiedCloudIdentity(databasePath) {
  const db = new DatabaseSync(databasePath);
  const deviceId = `device_test_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    db.exec('BEGIN IMMEDIATE');
    const authColumns = new Set(db.prepare('PRAGMA table_info(cloud_auth_state)').all().map((row) => row.name));
    if (authColumns.has('device_id')) {
      db.prepare(`UPDATE cloud_auth_state SET device_id=?,last_social_cursor='',last_social_message_cursor='',last_delegation_cursor='',last_presence_at='',last_error='',updated_at=? WHERE id='default'`).run(deviceId, now);
    }
    const syncColumns = new Set(db.prepare('PRAGMA table_info(cloud_sync_state)').all().map((row) => row.name));
    if (syncColumns.has('device_id')) {
      db.prepare(`UPDATE cloud_sync_state SET device_id=?,device_grant='',evolution_grant='',sync_capabilities_json='{}',last_sync_cursor='',last_v6_cursor='',last_identity_cursor='',last_personal_evolution_cursor='',last_success_at='',last_error='',updated_at=? WHERE id='default'`).run(deviceId, now);
    }
    db.prepare(`DELETE FROM app_settings WHERE key LIKE 'social:realtime_cursor:%' OR key IN ('social:realtime_status','social:realtime_error','social:last_realtime_event')`).run();
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
  return deviceId;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
