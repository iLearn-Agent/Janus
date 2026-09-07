import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { dataDir } from './paths.js';
import { ensureDirSync, nowIso } from './utils.js';
import { taskMemoryDeviceKeyPath } from '../shared/taskMemoryCrypto.js';

const DEFAULT_BACKUP_RETENTION = 5;

export function pendingMigrationIds(db, migrationIds = []) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return [...migrationIds];
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id));
  return migrationIds.filter((id) => !applied.has(id));
}

export function createMigrationBackup({ db, root, databasePath, migrationIds = [], maintenanceReasons = [], retention = DEFAULT_BACKUP_RETENTION } = {}) {
  if (!db || !root || !databasePath || (!migrationIds.length && !maintenanceReasons.length)) return null;
  const backupDirectory = path.join(dataDir(root), 'migration-backups');
  ensureDirSync(backupDirectory);
  const stamp = nowIso().replace(/[:.]/g, '-');
  const label = (migrationIds.length ? migrationIds : maintenanceReasons).join('_').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  const backupPath = path.join(backupDirectory, `${stamp}-pre-${label}.db`);
  const metadataPath = `${backupPath}.json`;
  const taskMemoryKeySource = taskMemoryDeviceKeyPath(root);
  const taskMemoryKeyBackupPath = `${backupPath}.task-memory-key.json`;
  db.exec('PRAGMA wal_checkpoint(FULL)');
  db.prepare('VACUUM INTO ?').run(backupPath);
  const inspection = inspectDatabaseBackup(backupPath);
  if (inspection.integrity !== 'ok') {
    fs.rmSync(backupPath, { force: true });
    throw new Error(`Migration backup integrity check failed: ${inspection.integrity}`);
  }
  const metadata = {
    schema: 'janus-migration-backup-v1',
    id: path.basename(backupPath, '.db'),
    databasePath,
    backupPath,
    pendingMigrationIds: migrationIds,
    maintenanceReasons,
    createdAt: nowIso(),
    sizeBytes: fs.statSync(backupPath).size,
    integrity: inspection.integrity,
    appliedMigrationIds: inspection.appliedMigrationIds,
    taskMemoryKeyBackupPath: '',
    pinned: false,
  };
  if (taskMemoryKeySource && fs.existsSync(taskMemoryKeySource)) {
    fs.copyFileSync(taskMemoryKeySource, taskMemoryKeyBackupPath);
    fs.chmodSync(taskMemoryKeyBackupPath, 0o600);
    metadata.taskMemoryKeyBackupPath = taskMemoryKeyBackupPath;
  }
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  pruneMigrationBackups(backupDirectory, { retention, preserve: new Set([backupPath, metadataPath]) });
  return metadata;
}

export function listMigrationBackups(root) {
  const directory = path.join(dataDir(root), 'migration-backups');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.db')).map((name) => {
    const backupPath = path.join(directory, name);
    let metadata = {};
    try { metadata = JSON.parse(fs.readFileSync(`${backupPath}.json`, 'utf8')); } catch {}
    return { id: metadata.id || path.basename(name, '.db'), backupPath, createdAt: metadata.createdAt || fs.statSync(backupPath).mtime.toISOString(),
      sizeBytes: metadata.sizeBytes || fs.statSync(backupPath).size, integrity: metadata.integrity || 'unknown',
      pendingMigrationIds: metadata.pendingMigrationIds || [], maintenanceReasons: metadata.maintenanceReasons || [], pinned: Boolean(metadata.pinned),
      taskMemoryKeyBackupPath: metadata.taskMemoryKeyBackupPath || '' };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function pinMigrationBackup(root, backupPath = '') {
  let result = null;
  for (const backup of listMigrationBackups(root)) {
    const metadataPath = `${backup.backupPath}.json`;
    let metadata = {};
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch {}
    const pinned = path.resolve(backup.backupPath) === path.resolve(backupPath);
    fs.writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, pinned }, null, 2)}\n`, 'utf8');
    if (pinned) result = { ...backup, pinned: true };
  }
  return result;
}

export function inspectDatabaseBackup(backupPath) {
  const db = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const integrity = String(db.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown');
    const hasMigrations = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get());
    const appliedMigrationIds = hasMigrations ? db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => row.id) : [];
    return { integrity, appliedMigrationIds };
  } finally {
    db.close();
  }
}

export function pruneMigrationBackups(backupDirectory, { retention = DEFAULT_BACKUP_RETENTION, preserve = new Set() } = {}) {
  if (!fs.existsSync(backupDirectory)) return [];
  const backups = fs.readdirSync(backupDirectory)
    .filter((name) => name.endsWith('.db'))
    .map((name) => path.join(backupDirectory, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  const removed = [];
  let rolling = 0;
  for (const backupPath of backups) {
    let pinned = false;
    try { pinned = Boolean(JSON.parse(fs.readFileSync(`${backupPath}.json`, 'utf8')).pinned); } catch {}
    if (pinned || preserve.has(backupPath) || preserve.has(`${backupPath}.json`)) continue;
    rolling += 1;
    if (rolling <= Math.max(0, Number(retention || DEFAULT_BACKUP_RETENTION))) continue;
    fs.rmSync(backupPath, { force: true });
    fs.rmSync(`${backupPath}.json`, { force: true });
    fs.rmSync(`${backupPath}.task-memory-key.json`, { force: true });
    removed.push(backupPath);
  }
  return removed;
}
