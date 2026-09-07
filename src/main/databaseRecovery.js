import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createMigrationBackup, inspectDatabaseBackup, listMigrationBackups, pendingMigrationIds, pinMigrationBackup } from './databaseBackup.js';
import { openDatabase } from './db.js';
import { dataDir, dbPath } from './paths.js';
import { ensureDirSync } from './utils.js';
import { taskMemoryDeviceKeyPath } from '../shared/taskMemoryCrypto.js';
import { redactDiagnosticText } from '../shared/diagnostics.js';
import { databaseMigrationIdsForVersion } from './modules/persistence/index.js';
import { databaseStructureFingerprint, inspectDatabaseHealth, inspectDatabaseStructure } from './modules/persistence/infrastructure/databaseHealth.js';
import { compareVersions, databaseFileStatus, DatabaseMaintenanceError, readDatabaseMeta } from './modules/persistence/infrastructure/databaseMaintenance.js';

export function inspectDatabaseRecoveryStatus(root, { appVersion = '', lastError = null } = {}) {
  const files = databaseFileStatus(root);
  const backups = listMigrationBackups(root).map(publicBackup);
  const quarantines = listRecoveryQuarantines(root);
  if (!files.exists) return { status: lastError && quarantines.length ? 'recovery_available' : 'healthy', repairable: false, appVersion,
    database: { ...files, integrity: 'missing', fingerprint: '' }, pendingMigrationIds: databaseMigrationIdsForVersion(appVersion), structureIssues: [],
    health: { status: 'healthy', violationCount: 0, checks: [] }, data: publicDatabaseIsolationRisk(emptyDatabaseIsolationRisk()),
    backups, quarantines, lastError: publicError(lastError) };
  let db;
  try {
    db = new DatabaseSync(dbPath(root), { readOnly: true });
    const integrity = String(db.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown');
    if (integrity !== 'ok') return { status: 'manual', repairable: false, appVersion, database: { ...files, integrity, fingerprint: '' },
      pendingMigrationIds: [], structureIssues: [], health: { status: 'critical', violationCount: 1, checks: [] }, backups, quarantines,
      data: publicDatabaseIsolationRisk(emptyDatabaseIsolationRisk()), lastError: publicError(lastError) };
    const meta = readDatabaseMeta(db);
    const minimumWriterVersion = String(meta?.min_writer_version || '');
    const writerIncompatible = Boolean(minimumWriterVersion && appVersion && compareVersions(appVersion, minimumWriterVersion) < 0);
    const pendingMigrationIds = pendingMigrationIdsFor(db, appVersion);
    const structureIssues = inspectDatabaseStructure(db);
    const health = inspectDatabaseHealth(db);
    if (writerIncompatible) return { status: 'incompatible', repairable: false, appVersion,
      database: { ...files, integrity, fingerprint: databaseStructureFingerprint(db), meta },
      pendingMigrationIds, structureIssues, health, data: publicDatabaseIsolationRisk(databaseIsolationRisk(db)), backups, quarantines,
      compatibility: { code: 'DB_DOWNGRADE_BLOCKED', currentAppVersion: appVersion, minimumWriterVersion }, lastError: publicError(lastError) };
    const manualHealthBlock = health.checks?.some((check) => check.count > 0 && check.repairMode === 'manual');
    const repairable = !manualHealthBlock && Boolean(pendingMigrationIds.length || structureIssues.length || health.violationCount);
    const status = manualHealthBlock ? 'manual' : repairable ? 'repairable' : lastError && quarantines.length ? 'recovery_available' : 'healthy';
    return { status, repairable, appVersion,
      database: { ...files, integrity, fingerprint: databaseStructureFingerprint(db), meta: readDatabaseMeta(db) },
      pendingMigrationIds, structureIssues, health, data: publicDatabaseIsolationRisk(databaseIsolationRisk(db)),
      backups, quarantines, lastError: publicError(lastError) };
  } catch (error) {
    return { status: 'manual', repairable: false, appVersion, database: { ...files, integrity: 'unavailable', fingerprint: '' },
      pendingMigrationIds: [], structureIssues: [], health: { status: 'critical', violationCount: 1, checks: [] }, backups, quarantines,
      data: publicDatabaseIsolationRisk(emptyDatabaseIsolationRisk()), lastError: publicError(lastError || error) };
  } finally { try { db?.close(); } catch {} }
}

export function inspectDatabaseIsolationRisk(root) {
  if (!fs.existsSync(dbPath(root))) return publicDatabaseIsolationRisk(emptyDatabaseIsolationRisk());
  const db = new DatabaseSync(dbPath(root), { readOnly: true });
  try { return publicDatabaseIsolationRisk(databaseIsolationRisk(db)); }
  finally { db.close(); }
}

export function listRecoveryQuarantines(root) {
  const directory = path.join(dataDir(root), 'recovery-quarantine');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const quarantineDirectory = path.join(directory, entry.name);
    const databasePath = path.join(quarantineDirectory, 'janus.db');
    if (!fs.existsSync(databasePath)) return [];
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(quarantineDirectory, 'recovery-manifest.json'), 'utf8')); } catch {}
    let summary = emptyRecoveryDataSummary();
    let integrity = 'unavailable';
    try {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        integrity = String(db.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown');
        if (integrity === 'ok') summary = databaseRecoveryDataSummary(db);
      } finally { db.close(); }
    } catch {}
    return [{
      id: entry.name,
      createdAt: String(manifest.createdAt || fs.statSync(databasePath).mtime.toISOString()),
      reason: String(manifest.reason || 'database_quarantine'),
      appVersion: String(manifest.appVersion || ''),
      sizeBytes: fs.statSync(databasePath).size,
      integrity,
      restoredAt: String(manifest.restoredAt || ''),
      data: publicRecoveryDataSummary(summary),
    }];
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function createEmergencyDatabaseSnapshot(root, reason = 'manual_recovery') {
  const target = dbPath(root);
  if (!fs.existsSync(target)) throw new DatabaseMaintenanceError('Database file does not exist.', { code: 'DB_RESTORE_FAILED', phase: 'snapshot' });
  ensureDiskSpace(root, 2, 128 * 1024 * 1024);
  let db;
  try {
    db = new DatabaseSync(target);
    db.exec('PRAGMA journal_mode=WAL');
    if (String(db.prepare('PRAGMA quick_check').get()?.quick_check || '') === 'ok') {
      return { kind: 'verified', ...createMigrationBackup({ db, root, databasePath: target, maintenanceReasons: [reason] }) };
    }
  } catch {} finally { try { db?.close(); } catch {} }
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(dataDir(root), 'recovery-snapshots', id);
  ensureDirSync(directory);
  const files = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${target}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const destination = path.join(directory, `janus.db${suffix}`);
    fs.copyFileSync(source, destination);
    files.push({ name: path.basename(destination), sizeBytes: fs.statSync(destination).size });
  }
  fs.writeFileSync(path.join(directory, 'metadata.json'), `${JSON.stringify({ schema: 'janus-raw-database-snapshot-v1', id, reason, files }, null, 2)}\n`, 'utf8');
  return { kind: 'raw', id, directory, files };
}

export function repairDatabase(root, { appVersion = '', onProgress = null, beforeReplace = null } = {}) {
  reportRecoveryProgress(onProgress, 'inspect', 5, '正在检查数据库结构和一致性');
  const inspection = inspectDatabaseRecoveryStatus(root, { appVersion });
  if (inspection.status === 'incompatible') {
    throw new DatabaseMaintenanceError(`This database requires Janus ${inspection.compatibility.minimumWriterVersion} or newer.`,
      { code: 'DB_DOWNGRADE_BLOCKED', phase: 'preflight', recoveryEligible: false });
  }
  if (!inspection.repairable && ['healthy', 'recovery_available'].includes(inspection.status)) {
    reportRecoveryProgress(onProgress, 'complete', 100, '数据库已经健康，无需修复');
    return { status: 'not_needed', code: 'DB_HEALTHY', inspection };
  }
  reportRecoveryProgress(onProgress, 'backup', 15, '正在创建修复前安全备份');
  const snapshot = createEmergencyDatabaseSnapshot(root, 'automatic_repair');
  if (snapshot.kind !== 'verified') throw new DatabaseMaintenanceError('The database cannot be repaired automatically; restore a verified backup.',
    { code: 'DB_INTEGRITY_FAILED', phase: 'repair_copy', backupId: snapshot.id || '' });
  ensureDiskSpace(root, 3, 256 * 1024 * 1024);
  const target = dbPath(root);
  const workRoot = path.join(dataDir(root), 'recovery-work', crypto.randomUUID());
  const workDatabase = dbPath(workRoot);
  ensureDirSync(path.dirname(workDatabase));
  reportRecoveryProgress(onProgress, 'copy', 30, '正在创建数据库修复副本');
  let source;
  try { source = new DatabaseSync(target); source.exec('PRAGMA wal_checkpoint(FULL)'); source.prepare('VACUUM INTO ?').run(workDatabase); }
  finally { try { source?.close(); } catch {} }
  if (inspection.health?.blocking?.length) {
    const work = new DatabaseSync(workDatabase);
    try { if (work.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) work.prepare("DELETE FROM schema_migrations WHERE id='database_core_consistency_repair_v1'").run(); }
    finally { work.close(); }
  }
  const repairSource = new DatabaseSync(workDatabase, { readOnly: true });
  let repairBefore;
  try { repairBefore = databaseRecoveryDataSummary(repairSource, { includeMessageDigest: true }); } finally { repairSource.close(); }
  let repaired;
  let repairAfter;
  try {
    reportRecoveryProgress(onProgress, 'migrate', 50, '正在修复旧结构和历史数据');
    repaired = openDatabase(workRoot, { appVersion: appVersion || undefined, skipMigrationBackup: true });
    reportRecoveryProgress(onProgress, 'validate', 72, '正在验证聊天、Agent 和 Memory 数据');
    const integrity = String(repaired.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown');
    if (integrity !== 'ok' || inspectDatabaseHealth(repaired).blocking.length) throw new Error('The repaired copy did not pass validation.');
    repairAfter = databaseRecoveryDataSummary(repaired, { includeMessageDigest: true });
    assertRecoveryDataPreserved(repairBefore, repairAfter);
    reportRecoveryProgress(onProgress, 'checkpoint', 84, '正在将修复结果安全写入磁盘');
    repaired.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    repaired.exec('PRAGMA journal_mode=DELETE');
  } finally { try { repaired?.close(); } catch {} }
  const emergency = `${target}.before-repair-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    reportRecoveryProgress(onProgress, 'replace', 94, '正在替换正式数据库');
    if (typeof beforeReplace === 'function') beforeReplace({ target, workDatabase, emergency });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
    fs.renameSync(target, emergency);
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${workDatabase}${suffix}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${target}${suffix}`);
    }
    if (inspectDatabaseBackup(target).integrity !== 'ok') throw new Error('Replacement integrity check failed.');
    const finalInspection = inspectDatabaseRecoveryStatus(root, { appVersion });
    if (finalInspection.repairable || !['healthy', 'recovery_available'].includes(finalInspection.status)) {
      throw new Error(`Replacement still requires database repair (${finalInspection.pendingMigrationIds.length} pending migrations, ${finalInspection.health?.violationCount || 0} consistency violations).`);
    }
    pinMigrationBackup(root, snapshot.backupPath);
    reportRecoveryProgress(onProgress, 'complete', 100, '修复完成，正在重新启动 Janus');
    return { status: 'repaired', code: 'DB_REPAIRED', backupId: snapshot.id, emergencyCreated: Boolean(emergency),
      data: publicRecoveryDataSummary(repairAfter), inspection: finalInspection };
  } catch (error) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
    if (fs.existsSync(emergency)) fs.renameSync(emergency, target);
    throw new DatabaseMaintenanceError(`Database replacement failed: ${error?.message || error}`, { code: 'DB_RESTORE_FAILED', phase: 'repair_replace', backupId: snapshot.id, cause: error });
  } finally { fs.rmSync(workRoot, { recursive: true, force: true }); }
}

export function restoreDatabaseBackup(root, backupId = '') {
  const backup = listMigrationBackups(root).find((item) => item.id === backupId);
  if (!backup || inspectDatabaseBackup(backup.backupPath).integrity !== 'ok') throw new DatabaseMaintenanceError('The selected verified backup is unavailable.', { code: 'DB_RESTORE_FAILED', phase: 'restore_select' });
  ensureDiskSpace(root, 2, 128 * 1024 * 1024);
  const target = dbPath(root); const key = taskMemoryDeviceKeyPath(root); const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const emergency = `${target}.before-restore-${stamp}`; const keyEmergency = `${key}.before-restore-${stamp}`;
  if (fs.existsSync(target)) fs.copyFileSync(target, emergency);
  if (fs.existsSync(key)) fs.copyFileSync(key, keyEmergency);
  try {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
    fs.copyFileSync(backup.backupPath, target);
    if (backup.taskMemoryKeyBackupPath && fs.existsSync(backup.taskMemoryKeyBackupPath)) {
      fs.copyFileSync(backup.taskMemoryKeyBackupPath, key);
      fs.chmodSync(key, 0o600);
    }
    if (inspectDatabaseBackup(target).integrity !== 'ok') throw new Error('Restored database failed validation.');
    return { status: 'restored', code: 'DB_RESTORED', backupId, emergencyCreated: Boolean(emergency) };
  } catch (error) {
    if (fs.existsSync(emergency)) fs.copyFileSync(emergency, target);
    if (fs.existsSync(keyEmergency)) fs.copyFileSync(keyEmergency, key);
    throw new DatabaseMaintenanceError(`Database restore failed: ${error?.message || error}`, { code: 'DB_RESTORE_FAILED', phase: 'restore_replace', backupId, cause: error });
  }
}

export function startFreshDatabase(root, { appVersion = '', beforeReplace = null } = {}) {
  const target = dbPath(root);
  if (!fs.existsSync(target)) return { status: 'not_needed', code: 'DB_MISSING' };
  ensureDiskSpace(root, 3, 256 * 1024 * 1024);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const quarantineDirectory = path.join(dataDir(root), 'recovery-quarantine', id);
  const workRoot = path.join(dataDir(root), 'fresh-database-work', crypto.randomUUID());
  const workDatabase = dbPath(workRoot);
  ensureDirSync(quarantineDirectory);
  ensureDirSync(path.dirname(workDatabase));

  let fresh;
  let preparationError = null;
  try {
    fresh = openDatabase(workRoot, { appVersion: appVersion || undefined, skipMigrationBackup: true });
    if (String(fresh.prepare('PRAGMA integrity_check').get()?.integrity_check || '') !== 'ok' || inspectDatabaseHealth(fresh).blocking.length) {
      throw new Error('Fresh database validation failed.');
    }
    fresh.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fresh.exec('PRAGMA journal_mode=DELETE');
    fresh.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('database:fresh_recovery_state',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(JSON.stringify({
        mode: 'fresh_database_recovery', quarantineId: id, cloudPullCompleted: false,
        localAuditCompleted: true, bidirectionalSyncEnabled: false, createdAt: new Date().toISOString(),
      }), new Date().toISOString());
  } catch (error) { preparationError = error; }
  finally { try { fresh?.close(); } catch {} }
  if (preparationError) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    throw new DatabaseMaintenanceError(`Could not create a verified fresh database: ${preparationError?.message || preparationError}`, {
      code: 'DB_MIGRATION_FAILED', phase: 'fresh_database_prepare', recoveryEligible: true, cause: preparationError,
    });
  }

  const preservedFiles = [];
  const preserve = (source, name) => {
    if (!fs.existsSync(source)) return;
    const destination = path.join(quarantineDirectory, name);
    fs.copyFileSync(source, destination);
    const sourceSize = fs.statSync(source).size;
    if (fs.statSync(destination).size !== sourceSize) throw new Error(`Quarantine copy verification failed for ${name}.`);
    preservedFiles.push({ name, sizeBytes: sourceSize });
  };
  preserve(target, 'janus.db');
  preserve(`${target}-wal`, 'janus.db-wal');
  preserve(`${target}-shm`, 'janus.db-shm');
  preserve(taskMemoryDeviceKeyPath(root), 'task-memory-device-key.json');
  const originalStatus = inspectDatabaseRecoveryStatus(root, { appVersion });
  const manifestPath = path.join(quarantineDirectory, 'recovery-manifest.json');
  const manifest = {
    schema: 'janus-database-quarantine-v1', id, createdAt: new Date().toISOString(), appVersion,
    reason: 'fresh_database_fallback', preservedFiles,
    original: { status: originalStatus.status, integrity: originalStatus.database.integrity, fingerprint: originalStatus.database.fingerprint },
    replacement: { status: 'prepared', fingerprint: inspectDatabaseBackup(workDatabase).integrity === 'ok' ? databaseFingerprintForFile(workDatabase) : '' },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  try {
    if (typeof beforeReplace === 'function') beforeReplace({ target, workDatabase, quarantineDirectory });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${workDatabase}${suffix}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${target}${suffix}`);
    }
    if (inspectDatabaseBackup(target).integrity !== 'ok') throw new Error('Fresh database replacement failed integrity_check.');
    const finalFingerprint = databaseFingerprintForFile(target);
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, replacement: { status: 'active', fingerprint: finalFingerprint } }, null, 2)}\n`, 'utf8');
    return { status: 'fresh_database_created', code: 'DB_FRESH_START_READY', quarantineId: id,
      preservedFileCount: preservedFiles.length, oldDatabasePreserved: true, fingerprint: finalFingerprint };
  } catch (error) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
    for (const [name, suffix] of [['janus.db', ''], ['janus.db-wal', '-wal'], ['janus.db-shm', '-shm']]) {
      const source = path.join(quarantineDirectory, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, `${target}${suffix}`);
    }
    throw new DatabaseMaintenanceError(`Fresh database fallback failed: ${error?.message || error}`, {
      code: 'DB_RESTORE_FAILED', phase: 'fresh_database_replace', recoveryEligible: true, cause: error,
    });
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

export function restoreQuarantinedDatabase(root, quarantineId = '', { appVersion = '' } = {}) {
  const candidate = listRecoveryQuarantines(root).find((item) => item.id === String(quarantineId || ''));
  if (!candidate) throw new DatabaseMaintenanceError('The selected isolated database is unavailable.', {
    code: 'DB_RESTORE_FAILED', phase: 'quarantine_select', recoveryEligible: true,
  });
  if (candidate.integrity !== 'ok') throw new DatabaseMaintenanceError('The selected isolated database failed integrity validation.', {
    code: 'DB_INTEGRITY_FAILED', phase: 'quarantine_select', recoveryEligible: true,
  });
  const quarantineDirectory = path.join(dataDir(root), 'recovery-quarantine', candidate.id);
  const sourceDatabase = path.join(quarantineDirectory, 'janus.db');
  ensureDiskSpaceForBytes(root, (fs.statSync(sourceDatabase).size + databaseFileStatus(root).sizeBytes) * 3 + 256 * 1024 * 1024);
  const currentSnapshot = fs.existsSync(dbPath(root)) ? createEmergencyDatabaseSnapshot(root, 'before_quarantine_restore') : null;
  const workRoot = path.join(dataDir(root), 'quarantine-restore-work', crypto.randomUUID());
  const workDatabase = dbPath(workRoot);
  ensureDirSync(path.dirname(workDatabase));
  for (const suffix of ['', '-wal', '-shm']) {
    const source = path.join(quarantineDirectory, `janus.db${suffix}`);
    if (fs.existsSync(source)) fs.copyFileSync(source, `${workDatabase}${suffix}`);
  }
  let before = null;
  let repaired = null;
  try {
    const source = new DatabaseSync(workDatabase, { readOnly: true });
    try {
      const integrity = String(source.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown');
      if (integrity !== 'ok') throw new Error(`Isolated database quick_check failed: ${integrity}`);
      before = databaseRecoveryDataSummary(source, { includeMessageDigest: true });
    } finally { source.close(); }
    repaired = openDatabase(workRoot, { appVersion: appVersion || undefined, skipMigrationBackup: true });
    const integrity = String(repaired.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown');
    const foreignKeyFailures = repaired.prepare('PRAGMA foreign_key_check').all();
    const health = inspectDatabaseHealth(repaired);
    const after = databaseRecoveryDataSummary(repaired, { includeMessageDigest: true });
    assertRecoveryDataPreserved(before, after);
    if (integrity !== 'ok' || foreignKeyFailures.length || health.blocking.length) {
      throw new Error('The repaired isolated database did not pass validation.');
    }
    repaired.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    repaired.exec('PRAGMA journal_mode=DELETE');
    repaired.close();
    repaired = null;
    replaceWithRepairedQuarantine(root, { workDatabase, quarantineDirectory, currentSnapshot });
    const manifestWarning = updateQuarantineRestorationManifest(quarantineDirectory, { appVersion, before, after });
    return { status: 'quarantine_restored', code: 'DB_QUARANTINE_RESTORED', quarantineId: candidate.id,
      backupId: currentSnapshot?.id || '', taskMemoryKeyRestored: fs.existsSync(path.join(quarantineDirectory, 'task-memory-device-key.json')),
      data: publicRecoveryDataSummary(after), warning: manifestWarning, inspection: inspectDatabaseRecoveryStatus(root, { appVersion }) };
  } catch (error) {
    throw new DatabaseMaintenanceError(`Could not repair and restore the isolated database: ${error?.message || error}`, {
      code: error instanceof DatabaseMaintenanceError ? error.code : 'DB_MIGRATION_FAILED',
      phase: 'quarantine_restore', recoveryEligible: true, backupId: currentSnapshot?.id || '', cause: error, health: error?.health || null,
    });
  } finally {
    try { repaired?.close(); } catch {}
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

export function exportDatabaseDiagnostics(root, { destination, appVersion = '', lastError = null } = {}) {
  const inspection = inspectDatabaseRecoveryStatus(root, { appVersion, lastError });
  const payload = {
    schema: 'janus-database-diagnostics-v2',
    createdAt: new Date().toISOString(),
    appVersion,
    ...inspection,
    diagnosticEvidence: collectDatabaseDiagnosticEvidence(root, inspection),
  };
  ensureDirSync(path.dirname(destination)); fs.writeFileSync(destination, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { destination, sizeBytes: fs.statSync(destination).size, status: inspection.status };
}

const pendingMigrationIdsFor = (db, appVersion = '') => pendingMigrationIds(db, databaseMigrationIdsForVersion(appVersion));
const publicBackup = (item) => ({ id: item.id, createdAt: item.createdAt, sizeBytes: item.sizeBytes, integrity: item.integrity,
  pendingMigrationIds: item.pendingMigrationIds, maintenanceReasons: item.maintenanceReasons, pinned: item.pinned });
const publicError = (error) => {
  if (!error) return null;
  const message = redactRecoveryMessage(error.message || error);
  return { code: error.code || 'DB_STARTUP_FAILED', phase: error.phase || '', migrationId: error.migrationId || '', message,
    ...parseMigrationFailureDetail(message) };
};
const redactRecoveryMessage = (value) => redactDiagnosticText(String(value || '')).replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/g, '[path]').slice(0, 1000);

function parseMigrationFailureDetail(message = '') {
  const match = String(message || '').match(/(agent_alias_context_state_repair_v4):([a-z0-9_]+)(?::([^:\s]+))?:\s*([^\n]+)/i);
  if (!match) return {};
  const detail = String(match[4] || '');
  const invariant = detail.match(/^([a-z0-9_]+)(?::([^:\s]+))?/i);
  return {
    repairMigrationId: match[1],
    repairStage: match[2],
    repairObjectId: match[3] || invariant?.[2] || '',
    repairInvariant: invariant?.[1] || '',
  };
}

function collectDatabaseDiagnosticEvidence(root, inspection = {}) {
  const evidence = {
    migration: {
      pendingCount: inspection.pendingMigrationIds?.length || 0,
      pendingIds: inspection.pendingMigrationIds || [],
      missingStructureCount: inspection.structureIssues?.length || 0,
      missingStructures: inspection.structureIssues || [],
    },
    health: {
      status: inspection.health?.status || 'unknown',
      violationCount: Number(inspection.health?.violationCount || 0),
      nonzeroChecks: (inspection.health?.checks || []).filter((check) => Number(check.count || 0) > 0),
    },
    identityTriggers: [],
  };
  if (!fs.existsSync(dbPath(root))) return evidence;
  let db;
  try {
    db = new DatabaseSync(dbPath(root), { readOnly: true });
    evidence.identityTriggers = [
      'trg_sessions_agent_identity_insert', 'trg_sessions_agent_identity_update',
      'trg_messages_agent_identity_insert', 'trg_messages_agent_identity_update',
      'trg_agent_context_spaces_identity_insert', 'trg_agent_context_spaces_identity_update',
      'trg_agent_device_context_state_identity_insert', 'trg_agent_device_context_state_identity_update',
      'trg_agent_context_state_identity_insert', 'trg_agent_context_state_identity_update',
    ].map((name) => {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
      return { name, present: Boolean(row?.sql), sqlHash: row?.sql
        ? crypto.createHash('sha256').update(String(row.sql)).digest('hex') : '' };
    });
  } catch (error) {
    evidence.readError = redactRecoveryMessage(error?.message || error);
  } finally {
    try { db?.close(); } catch {}
  }
  return evidence;
}
function ensureDiskSpace(root, multiplier, reserve) {
  const files = databaseFileStatus(root); const required = (files.sizeBytes + files.walSizeBytes + files.shmSizeBytes) * multiplier + reserve;
  try { const stat = fs.statfsSync(dataDir(root)); if (Number(stat.bavail) * Number(stat.bsize) < required) throw new DatabaseMaintenanceError('Insufficient disk space for safe recovery.', { code: 'DB_DISK_SPACE', phase: 'disk_space' }); }
  catch (error) { if (error instanceof DatabaseMaintenanceError) throw error; }
}

function ensureDiskSpaceForBytes(root, required) {
  try {
    const stat = fs.statfsSync(dataDir(root));
    if (Number(stat.bavail) * Number(stat.bsize) < required) throw new DatabaseMaintenanceError('Insufficient disk space for safe recovery.', {
      code: 'DB_DISK_SPACE', phase: 'disk_space', recoveryEligible: true,
    });
  } catch (error) { if (error instanceof DatabaseMaintenanceError) throw error; }
}

function databaseRecoveryDataSummary(db, { includeMessageDigest = false } = {}) {
  const count = (table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
    ? Number(db.prepare(`SELECT COUNT(*) count FROM "${table}"`).get()?.count || 0) : 0;
  const messageDigest = crypto.createHash('sha256');
  const messageFingerprints = includeMessageDigest ? new Map() : null;
  const attachmentFingerprints = includeMessageDigest ? new Map() : null;
  const chatGroupFingerprints = includeMessageDigest ? recoveryRecordFingerprints(db, 'chat_groups', [
    'id', 'account_workspace_id', 'organization_id', 'owner_user_id', 'title', 'scope_type', 'chat_mode',
    'binding_type', 'binding_id', 'history_visibility', 'status', 'audience_scope', 'client_request_id', 'metadata_json',
    'created_at', 'updated_at', 'dissolved_at',
  ]) : null;
  const chatGroupMemberFingerprints = includeMessageDigest ? recoveryRecordFingerprints(db, 'chat_group_members', [
    'group_id', 'user_id', 'role', 'status', 'invited_by_user_id', 'joined_at', 'left_at', 'last_read_at',
  ], ['group_id', 'user_id']) : null;
  const chatGroupMessageFingerprints = includeMessageDigest ? recoveryRecordFingerprints(db, 'chat_group_messages', [
    'id', 'account_workspace_id', 'group_id', 'sender_user_id', 'sender_agent_id', 'kind', 'content',
    'metadata_json', 'source_event_id', 'created_at', 'updated_at',
  ]) : null;
  const chatGroupOutboxFingerprints = includeMessageDigest ? recoveryRecordFingerprints(db, 'chat_group_outbox', [
    'id', 'account_workspace_id', 'operation_kind', 'aggregate_id', 'idempotency_key', 'payload_hash',
    'payload_json', 'status', 'attempt_count', 'next_attempt_at', 'last_error', 'created_at', 'updated_at',
    'completed_at',
  ]) : null;
  const socialConversationPreferenceFingerprints = includeMessageDigest ? recoveryRecordFingerprints(db, 'social_conversation_preferences', [
    'account_workspace_id', 'user_id', 'conversation_kind', 'conversation_id', 'archived', 'state_revision',
    'base_state_revision', 'last_command_id', 'source_device_id', 'sync_status', 'created_at', 'updated_at',
  ], ['account_workspace_id', 'user_id', 'conversation_kind', 'conversation_id']) : null;
  const socialConversationPreferenceOutboxFingerprints = includeMessageDigest ? recoveryRecordFingerprints(db, 'social_conversation_preference_outbox', [
    'id', 'account_workspace_id', 'user_id', 'conversation_kind', 'conversation_id', 'command_id', 'payload_hash',
    'payload_json', 'status', 'attempt_count', 'next_attempt_at', 'last_error', 'created_at', 'updated_at', 'completed_at',
  ]) : null;
  const socialInboxPreferenceFingerprints = includeMessageDigest ? recoveryRecordFingerprints(db, 'social_inbox_preferences', [
    'account_workspace_id', 'user_id', 'conversation_kind', 'conversation_id', 'archived', 'state_revision', 'last_command_id', 'source_device_id', 'sync_status', 'created_at', 'updated_at',
  ], ['account_workspace_id', 'user_id', 'conversation_kind', 'conversation_id']) : null;
  const socialInboxPreferenceOutboxFingerprints = includeMessageDigest ? recoveryRecordFingerprints(db, 'social_inbox_preference_outbox', [
    'id', 'account_workspace_id', 'user_id', 'conversation_kind', 'conversation_id', 'command_id', 'payload_hash', 'payload_json', 'status', 'attempt_count', 'next_attempt_at', 'last_error', 'created_at', 'updated_at', 'completed_at',
  ]) : null;
  const workspaceStartupPreferenceFingerprints = includeMessageDigest ? recoveryRecordFingerprints(db, 'account_workspace_startup_preferences', [
    'user_id', 'device_id', 'startup_workspace_id', 'updated_at',
  ], ['user_id', 'device_id']) : null;
  if (includeMessageDigest && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get()) {
    for (const row of db.prepare('SELECT id,role,content,created_at FROM messages ORDER BY id').iterate()) {
      const serialized = JSON.stringify([row.id, row.role, row.content, row.created_at]);
      messageDigest.update(`${serialized}\n`);
      messageFingerprints.set(row.id, crypto.createHash('sha256').update(serialized).digest('hex'));
    }
  }
  if (includeMessageDigest && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_attachments'").get()) {
    for (const row of db.prepare(`SELECT id,message_id,name,content_type,size_bytes,sha256
      FROM message_attachments ORDER BY id`).iterate()) {
      const serialized = JSON.stringify([row.id, row.message_id, row.name, row.content_type, row.size_bytes, row.sha256]);
      attachmentFingerprints.set(row.id, crypto.createHash('sha256').update(serialized).digest('hex'));
    }
  }
  return {
    sessions: count('sessions'), messages: count('messages'), users: count('auth_users'), agentInstances: count('user_agent_instances'),
    memoryDocuments: count('memory_documents'), memoryVersions: count('memory_document_versions'),
    attachments: count('message_attachments'), taskRuns: count('task_runs'), taskNodes: count('task_nodes'),
    modelExecutions: count('model_executions'), fileRefs: count('cloud_file_refs'),
    chatGroups: count('chat_groups'), chatGroupMembers: count('chat_group_members'),
    chatGroupMessages: count('chat_group_messages'), chatGroupOutbox: count('chat_group_outbox'),
    socialConversationPreferences: count('social_conversation_preferences'),
    socialConversationPreferenceOutbox: count('social_conversation_preference_outbox'),
    socialInboxPreferences: count('social_inbox_preferences'),
    socialInboxPreferenceOutbox: count('social_inbox_preference_outbox'),
    workspaceStartupPreferences: count('account_workspace_startup_preferences'),
    messageDigest: messageDigest.digest('hex'), messageFingerprints, attachmentFingerprints,
    chatGroupFingerprints, chatGroupMemberFingerprints, chatGroupMessageFingerprints, chatGroupOutboxFingerprints,
    socialConversationPreferenceFingerprints, socialConversationPreferenceOutboxFingerprints,
    socialInboxPreferenceFingerprints, socialInboxPreferenceOutboxFingerprints,
    workspaceStartupPreferenceFingerprints,
  };
}

function emptyRecoveryDataSummary() {
  return { sessions: 0, messages: 0, users: 0, agentInstances: 0, memoryDocuments: 0, memoryVersions: 0,
    attachments: 0, taskRuns: 0, taskNodes: 0, modelExecutions: 0, fileRefs: 0,
    chatGroups: 0, chatGroupMembers: 0, chatGroupMessages: 0, chatGroupOutbox: 0,
    socialConversationPreferences: 0, socialConversationPreferenceOutbox: 0,
    workspaceStartupPreferences: 0, messageDigest: '' };
}

function publicRecoveryDataSummary(summary = {}) {
  return { sessions: Number(summary.sessions || 0), messages: Number(summary.messages || 0), users: Number(summary.users || 0),
    agentInstances: Number(summary.agentInstances || 0), memoryDocuments: Number(summary.memoryDocuments || 0),
    memoryVersions: Number(summary.memoryVersions || 0), attachments: Number(summary.attachments || 0),
    taskRuns: Number(summary.taskRuns || 0), taskNodes: Number(summary.taskNodes || 0),
    modelExecutions: Number(summary.modelExecutions || 0), fileRefs: Number(summary.fileRefs || 0),
    chatGroups: Number(summary.chatGroups || 0), chatGroupMembers: Number(summary.chatGroupMembers || 0),
    chatGroupMessages: Number(summary.chatGroupMessages || 0), chatGroupOutbox: Number(summary.chatGroupOutbox || 0),
    socialConversationPreferences: Number(summary.socialConversationPreferences || 0),
    socialConversationPreferenceOutbox: Number(summary.socialConversationPreferenceOutbox || 0),
    workspaceStartupPreferences: Number(summary.workspaceStartupPreferences || 0) };
}

function assertRecoveryDataPreserved(before, after) {
  for (const key of ['sessions', 'messages', 'users', 'agentInstances', 'memoryDocuments', 'memoryVersions',
    'attachments', 'taskRuns', 'taskNodes', 'modelExecutions', 'fileRefs',
    'chatGroups', 'chatGroupMembers', 'chatGroupMessages', 'chatGroupOutbox',
    'socialConversationPreferences', 'socialConversationPreferenceOutbox', 'workspaceStartupPreferences']) {
    if (Number(after[key] || 0) < Number(before[key] || 0)) throw new Error(`Recovery validation detected data loss in ${key}.`);
  }
  if (before.messageFingerprints instanceof Map && after.messageFingerprints instanceof Map) {
    for (const [messageId, fingerprint] of before.messageFingerprints) {
      if (after.messageFingerprints.get(messageId) !== fingerprint) {
        throw new Error('Recovery validation detected missing or changed chat message content.');
      }
    }
  } else if (before.messageDigest !== after.messageDigest) {
    throw new Error('Recovery validation detected changed chat message content.');
  }
  if (before.attachmentFingerprints instanceof Map && after.attachmentFingerprints instanceof Map) {
    for (const [attachmentId, fingerprint] of before.attachmentFingerprints) {
      if (after.attachmentFingerprints.get(attachmentId) !== fingerprint) {
        throw new Error('Recovery validation detected a missing or changed message attachment.');
      }
    }
  }
  assertRecoveryFingerprintMapPreserved(before.chatGroupFingerprints, after.chatGroupFingerprints, 'chat group');
  assertRecoveryFingerprintMapPreserved(before.chatGroupMemberFingerprints, after.chatGroupMemberFingerprints, 'chat group member');
  assertRecoveryFingerprintMapPreserved(before.chatGroupMessageFingerprints, after.chatGroupMessageFingerprints, 'chat group message');
  assertRecoveryFingerprintMapPreserved(before.chatGroupOutboxFingerprints, after.chatGroupOutboxFingerprints, 'chat group outbox record');
  assertRecoveryFingerprintMapPreserved(before.socialConversationPreferenceFingerprints, after.socialConversationPreferenceFingerprints, 'social conversation preference');
  assertRecoveryFingerprintMapPreserved(before.socialConversationPreferenceOutboxFingerprints, after.socialConversationPreferenceOutboxFingerprints, 'social conversation preference outbox record');
  assertRecoveryFingerprintMapPreserved(before.workspaceStartupPreferenceFingerprints, after.workspaceStartupPreferenceFingerprints, 'workspace startup preference');
}

function recoveryRecordFingerprints(db, table, requestedColumns, requestedIdentityColumns = ['id']) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return new Map();
  const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name || '')));
  const selected = requestedColumns.filter((column) => columns.has(column));
  const identityColumns = requestedIdentityColumns.filter((column) => columns.has(column));
  if (identityColumns.length !== requestedIdentityColumns.length) return new Map();
  const quoted = selected.map((column) => `"${column}"`).join(',');
  const orderBy = identityColumns.map((column) => `"${column}"`).join(',');
  const fingerprints = new Map();
  for (const row of db.prepare(`SELECT ${quoted} FROM "${table}" ORDER BY ${orderBy}`).iterate()) {
    const serialized = JSON.stringify(selected.map((column) => row[column]));
    const identity = JSON.stringify(identityColumns.map((column) => row[column]));
    fingerprints.set(identity, crypto.createHash('sha256').update(serialized).digest('hex'));
  }
  return fingerprints;
}

function assertRecoveryFingerprintMapPreserved(before, after, label) {
  if (!(before instanceof Map) || !(after instanceof Map)) return;
  for (const [identity, fingerprint] of before) {
    if (after.get(identity) !== fingerprint) throw new Error(`Recovery validation detected a missing or changed ${label}.`);
  }
}

function databaseIsolationRisk(db) {
  const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const columns = (table) => has(table)
    ? new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name || ''))) : new Set();
  const messagesColumns = columns('messages');
  const sessionsColumns = columns('sessions');
  const syncStateColumns = columns('cloud_sync_state');
  const revisionColumns = columns('cloud_sync_entity_revisions');
  const scalar = (sql) => Number(db.prepare(sql).get()?.count || 0);
  if (!has('messages') || !has('sessions')) return emptyDatabaseIsolationRisk();
  const totalMessages = scalar('SELECT COUNT(*) count FROM messages');
  const cloudCoverageKnown = has('cloud_sync_entity_revisions') && has('cloud_sync_state')
    && syncStateColumns.has('last_success_at') && revisionColumns.has('entity_type') && revisionColumns.has('entity_id')
    && Boolean(db.prepare("SELECT last_success_at FROM cloud_sync_state WHERE id='default'").get()?.last_success_at);
  const cloudConfirmedMessages = has('cloud_sync_entity_revisions') && revisionColumns.has('entity_type')
    && revisionColumns.has('entity_id') && revisionColumns.has('revision')
    ? scalar(`SELECT COUNT(*) count FROM messages message WHERE EXISTS (
        SELECT 1 FROM cloud_sync_entity_revisions revision
        WHERE revision.entity_type='message' AND revision.entity_id=message.id AND revision.revision>0)`) : 0;
  return {
    sessions: scalar('SELECT COUNT(*) count FROM sessions'),
    messages: totalMessages,
    visibleMessages: messagesColumns.has('visible') ? scalar('SELECT COUNT(*) count FROM messages WHERE visible=1') : totalMessages,
    hiddenMessages: messagesColumns.has('visible') ? scalar('SELECT COUNT(*) count FROM messages WHERE visible=0') : 0,
    privateAssistantMessages: messagesColumns.has('session_id') && sessionsColumns.has('department_id')
      ? scalar(`SELECT COUNT(*) count FROM messages message JOIN sessions session ON session.id=message.session_id
        WHERE session.department_id='private_assistant'`) : 0,
    nonPersonalWorkspaceMessages: messagesColumns.has('account_workspace_id')
      ? scalar(`SELECT COUNT(*) count FROM messages
        WHERE account_workspace_id!='' AND account_workspace_id!='workspace_personal'`) : 0,
    cloudConfirmedMessages,
    localOnlyMessages: cloudCoverageKnown ? Math.max(0, totalMessages - cloudConfirmedMessages) : totalMessages,
    cloudCoverageKnown,
    attachments: has('message_attachments') ? scalar('SELECT COUNT(*) count FROM message_attachments') : 0,
    pendingFileUploads: columns('cloud_file_manifest').has('upload_status')
      ? scalar("SELECT COUNT(*) count FROM cloud_file_manifest WHERE upload_status!='uploaded'") : 0,
    memoryDocuments: has('memory_documents') ? scalar('SELECT COUNT(*) count FROM memory_documents') : 0,
    memoryVersions: has('memory_document_versions') ? scalar('SELECT COUNT(*) count FROM memory_document_versions') : 0,
  };
}

function emptyDatabaseIsolationRisk() {
  return { sessions: 0, messages: 0, visibleMessages: 0, hiddenMessages: 0, privateAssistantMessages: 0,
    nonPersonalWorkspaceMessages: 0, cloudConfirmedMessages: 0, localOnlyMessages: 0, cloudCoverageKnown: false,
    attachments: 0, pendingFileUploads: 0, memoryDocuments: 0, memoryVersions: 0 };
}

function publicDatabaseIsolationRisk(value = {}) {
  return { ...emptyDatabaseIsolationRisk(), ...value,
    cloudCoverageKnown: Boolean(value.cloudCoverageKnown),
    isolationWarningRequired: Number(value.localOnlyMessages || 0) > 0 || Number(value.attachments || 0) > 0
      || Number(value.pendingFileUploads || 0) > 0 };
}

function updateQuarantineRestorationManifest(quarantineDirectory, { appVersion, before, after }) {
  const manifestPath = path.join(quarantineDirectory, 'recovery-manifest.json');
  try {
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, restoredAt: new Date().toISOString(),
      restoration: { status: 'restored', appVersion, before: publicRecoveryDataSummary(before), after: publicRecoveryDataSummary(after) } }, null, 2)}\n`, 'utf8');
    return '';
  } catch (error) {
    return `Database restored, but recovery manifest could not be updated: ${redactRecoveryMessage(error?.message || error)}`;
  }
}

function reportRecoveryProgress(callback, stage, percent, message) {
  if (typeof callback !== 'function') return;
  try { callback({ stage, percent: Math.max(0, Math.min(100, Number(percent || 0))), message, at: new Date().toISOString() }); } catch {}
}

function replaceWithRepairedQuarantine(root, { workDatabase, quarantineDirectory, currentSnapshot }) {
  const target = dbPath(root);
  const key = taskMemoryDeviceKeyPath(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const moved = [];
  const keyEmergency = `${key}.before-quarantine-restore-${stamp}`;
  const replacementKey = path.join(quarantineDirectory, 'task-memory-device-key.json');
  const hadCurrentKey = fs.existsSync(key);
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const current = `${target}${suffix}`;
      if (!fs.existsSync(current)) continue;
      const emergency = `${target}.before-quarantine-restore-${stamp}${suffix}`;
      fs.renameSync(current, emergency);
      moved.push({ current, emergency });
    }
    if (hadCurrentKey) fs.copyFileSync(key, keyEmergency);
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${workDatabase}${suffix}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${target}${suffix}`);
    }
    if (replacementKey && fs.existsSync(replacementKey)) {
      fs.copyFileSync(replacementKey, key);
      fs.chmodSync(key, 0o600);
    }
    if (inspectDatabaseBackup(target).integrity !== 'ok') throw new Error('Restored isolated database failed final integrity validation.');
    if (currentSnapshot?.backupPath) pinMigrationBackup(root, currentSnapshot.backupPath);
  } catch (error) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
    for (const item of moved.reverse()) if (fs.existsSync(item.emergency)) fs.renameSync(item.emergency, item.current);
    if (fs.existsSync(keyEmergency)) fs.copyFileSync(keyEmergency, key);
    else if (!hadCurrentKey) fs.rmSync(key, { force: true });
    throw error;
  }
}

function databaseFingerprintForFile(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return databaseStructureFingerprint(db); } finally { db.close(); }
}
