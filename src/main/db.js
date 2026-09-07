import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createMigrationBackup, pendingMigrationIds, pinMigrationBackup } from './databaseBackup.js';
import { ensureDirSync } from './utils.js';
import { dataDir, dbPath } from './paths.js';
import { DATABASE_MIGRATIONS, databaseMigrationIdsForVersion, ensureLegacyAccountWorkspaceColumns, ensureLegacyAuthUserColumns, ensureLegacyCollaborationGroupMessageColumns, ensureLegacyContactOrganizationColumns, ensureLegacyDelegationWorkspaceRoutingColumns, ensureLegacyMessageContextColumns, ensureLegacySessionCanonicalStructure, ensureLegacySessionColumns, ensureLegacyUserAgentInstanceColumns, ensureLegacyWorkScopeFederationColumns, migrateDatabase, repairPrimaryAgentSessionUniqueness, SQLITE_SCHEMA } from './modules/persistence/index.js';
import { assertDatabaseHealth, databaseStructureFingerprint, inspectDatabaseHealth, inspectDatabaseStructure } from './modules/persistence/infrastructure/databaseHealth.js';
import { appendDatabaseMaintenanceEvent, assertDatabaseWriterCompatible, databaseMaintenanceNeeded, DatabaseMaintenanceError,
  markDatabaseStartupStarted, readDatabaseMeta, readDatabaseStartupState, recordDatabaseMaintenanceRun, updateDatabaseMeta } from './modules/persistence/infrastructure/databaseMaintenance.js';
import { assertDatabaseInventoryPreserved, collectDatabaseInventory } from './modules/persistence/infrastructure/databaseInventory.js';

const DEFAULT_APP_VERSION = readPackageVersion();

export function openDatabase(root, {
  beforeCommit = null,
  skipMigrationBackup = false,
  skipMigrationPreflight = false,
  appVersion = DEFAULT_APP_VERSION,
} = {}) {
  const databasePath = dbPath(root);
  ensureDirSync(databasePath.split(/[\\/][^\\/]+$/)[0]);
  const existedBeforeOpen = fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;
  const previousStartupState = readDatabaseStartupState(root);
  const runId = `db_${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  let db = new DatabaseSync(databasePath);
  let migrationBackup = null;
  let transactionStarted = false;
  let committed = false;
  let phase = 'preflight';
  let pending = [];
  let reasons = [];
  let fingerprintBefore = '';
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    if (existedBeforeOpen) {
      const quick = String(db.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown');
      if (quick !== 'ok') throw new DatabaseMaintenanceError(`Database quick_check failed: ${quick}`, { code: 'DB_INTEGRITY_FAILED', phase });
      assertDatabaseWriterCompatible(db, appVersion);
    }
    pending = pendingMigrationIds(db, databaseMigrationIdsForVersion(appVersion));
    const structureIssues = existedBeforeOpen ? inspectDatabaseStructure(db) : [];
    const preflightHealth = existedBeforeOpen ? inspectDatabaseHealth(db) : { checks: [], blocking: [] };
    const forceCoreRepair = preflightHealth.blocking.length > 0;
    if (forceCoreRepair && !pending.includes('database_core_consistency_repair_v1')) pending.push('database_core_consistency_repair_v1');
    fingerprintBefore = databaseStructureFingerprint(db);
    reasons = databaseMaintenanceNeeded({ pendingMigrationIds: pending, structureIssues, previousStartupState });
    const lastFullAuditAt = String(readDatabaseMeta(db)?.last_full_audit_at || '');
    const lastFullAuditMs = Date.parse(lastFullAuditAt);
    if (existedBeforeOpen && (!Number.isFinite(lastFullAuditMs) || Date.now() - lastFullAuditMs >= 7 * 24 * 60 * 60 * 1000)) reasons.push('scheduled_full_audit');
    reasons.push(...preflightHealth.checks.filter((check) => check.count > 0).map((check) => `health:${check.ruleId}:${check.count}`));
    reasons = [...new Set(reasons)];
    appendDatabaseMaintenanceEvent(root, { runId, status: 'started', phase, migrationId: pending[0] || '', appVersion,
      data: { pendingMigrationCount: pending.length, structureIssueCount: structureIssues.length, previousUncleanExit: previousStartupState?.clean === false } });
    const hasHealthViolations = preflightHealth.checks.some((check) => check.count > 0);
    if (existedBeforeOpen && !skipMigrationPreflight && (pending.length || structureIssues.length || hasHealthViolations)) {
      phase = 'shadow_preflight';
      runDatabaseMigrationPreflight(db, root, { appVersion });
    }
    if (existedBeforeOpen && (pending.length || structureIssues.length || hasHealthViolations) && !skipMigrationBackup) {
      phase = 'backup';
      migrationBackup = createMigrationBackup({ db, root, databasePath, migrationIds: pending, maintenanceReasons: reasons });
    }
    phase = 'transaction';
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    ensureLegacyAuthUserColumns(db);
    ensureLegacyContactOrganizationColumns(db);
    ensureLegacyCollaborationGroupMessageColumns(db);
    ensureLegacyDelegationWorkspaceRoutingColumns(db);
    ensureLegacyWorkScopeFederationColumns(db);
    ensureLegacyAccountWorkspaceColumns(db);
    ensureLegacySessionColumns(db);
    ensureLegacyMessageContextColumns(db);
    ensureLegacyUserAgentInstanceColumns(db);
    ensureLegacySessionCanonicalStructure(db);
    repairPrimaryAgentSessionUniqueness(db);
    phase = 'schema';
    const schemaLayers = splitSchemaIndexes(SQLITE_SCHEMA);
    db.exec(schemaLayers.tables);
    if (forceCoreRepair) db.prepare("DELETE FROM schema_migrations WHERE id='database_core_consistency_repair_v1'").run();
    phase = 'migration';
    migrateDatabase(db);
    repairPrimaryAgentSessionUniqueness(db);
    phase = 'constraints';
    db.exec(schemaLayers.indexes);
    phase = 'validation';
    let health = inspectDatabaseHealth(db);
    if (health.blocking.length && !forceCoreRepair) {
      phase = 'self_heal';
      db.prepare("DELETE FROM schema_migrations WHERE id='database_core_consistency_repair_v1'").run();
      migrateDatabase(db);
      repairPrimaryAgentSessionUniqueness(db);
      db.exec(schemaLayers.indexes);
      health = inspectDatabaseHealth(db);
      if (!pending.includes('database_core_consistency_repair_v1')) pending.push('database_core_consistency_repair_v1');
    }
    health = assertDatabaseHealth(db);
    syncDatabaseQuarantine(db, health);
    const fingerprintAfter = databaseStructureFingerprint(db);
    for (const migrationId of pending) {
      const migration = DATABASE_MIGRATIONS.find((item) => item.id === migrationId);
      recordDatabaseMaintenanceRun(db, { id: `${runId}:${migrationId}`, runKind: migration?.kind, appVersion, migrationId,
        codeChecksum: migration ? `${migration.checksum}:${migration.riskChecksum}` : '', phase: 'committed', status: 'committed', fingerprintBefore, fingerprintAfter,
        scannedCount: health.checks.length, repairedCount: health.checks.filter((item) => item.count === 0).length,
        quarantinedCount: health.checks.filter((item) => item.repairMode === 'quarantine').reduce((sum, item) => sum + item.count, 0),
        backupId: migrationBackup?.id || '', startedAt, completedAt: new Date().toISOString() });
    }
    if (!pending.length && reasons.length) {
      recordDatabaseMaintenanceRun(db, { id: runId, runKind: 'audit', appVersion, phase: 'committed', status: 'committed',
        fingerprintBefore, fingerprintAfter, scannedCount: health.checks.length,
        quarantinedCount: health.checks.filter((item) => item.repairMode === 'quarantine').reduce((sum, item) => sum + item.count, 0),
        backupId: migrationBackup?.id || '', startedAt, completedAt: new Date().toISOString() });
    }
    updateDatabaseMeta(db, { appVersion, fingerprint: fingerprintAfter, healthStatus: health.status,
      fullAudit: Boolean(pending.length || previousStartupState?.clean === false || reasons.includes('scheduled_full_audit')), minimumWriterVersion: pending.length ? appVersion : '' });
    if (typeof beforeCommit === 'function') beforeCommit(db);
    phase = 'commit';
    db.exec('COMMIT');
    transactionStarted = false;
    committed = true;
    if (pending.length || reasons.length) {
      phase = 'post_commit_verify';
      db.close();
      db = new DatabaseSync(databasePath);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA journal_mode = WAL');
      const integrity = String(db.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown');
      if (integrity !== 'ok') throw new DatabaseMaintenanceError(`Post-migration integrity_check failed: ${integrity}`, { code: 'DB_INTEGRITY_FAILED', phase, backupId: migrationBackup?.id || '' });
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new DatabaseMaintenanceError('Post-migration foreign_key_check failed.', { code: 'DB_INVARIANT_FAILED', phase, backupId: migrationBackup?.id || '' });
      assertDatabaseHealth(db);
    }
    const fingerprint = databaseStructureFingerprint(db);
    if (migrationBackup?.backupPath) pinMigrationBackup(root, migrationBackup.backupPath);
    appendDatabaseMaintenanceEvent(root, { runId, status: 'committed', phase: 'complete', appVersion, backupId: migrationBackup?.id || '', data: { pendingMigrationCount: pending.length, fingerprint } });
    markDatabaseStartupStarted(root, { appVersion, fingerprint });
    Object.defineProperty(db, 'migrationBackup', { value: migrationBackup, configurable: true });
    Object.defineProperty(db, 'maintenance', { value: { runId, reasons, pendingMigrationIds: pending, fingerprint, previousUncleanExit: previousStartupState?.clean === false }, configurable: true });
    return db;
  } catch (error) {
    if (transactionStarted) try { db.exec('ROLLBACK'); } catch {}
    try { db.close(); } catch {}
    const wrapped = error instanceof DatabaseMaintenanceError ? error : new DatabaseMaintenanceError(`Database maintenance failed during ${phase}: ${error?.message || error}`,
      { code: String(error?.code || '').startsWith('DB_') ? error.code : phase === 'backup' ? 'DB_BACKUP_FAILED' : 'DB_MIGRATION_FAILED', phase,
        migrationId: pending[0] || '', recoveryEligible: existedBeforeOpen, backupId: migrationBackup?.id || '', cause: error, health: error?.health || null });
    appendDatabaseMaintenanceEvent(root, { runId, status: committed ? 'failed_after_commit' : transactionStarted ? 'rolled_back' : 'failed', phase,
      migrationId: wrapped.migrationId, appVersion, errorCode: wrapped.code, errorSummary: wrapped.message, backupId: wrapped.backupId });
    throw wrapped;
  }
}

export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params).map((row) => ({ ...row }));
}

export function get(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : null;
}

export function run(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

function runDatabaseMigrationPreflight(sourceDb, root, { appVersion = DEFAULT_APP_VERSION } = {}) {
  const workRoot = path.join(dataDir(root), 'migration-preflight', crypto.randomUUID());
  const workDatabase = dbPath(workRoot);
  ensureDirSync(path.dirname(workDatabase));
  const before = collectDatabaseInventory(sourceDb, { includeContentFingerprints: true });
  let migrated;
  try {
    sourceDb.exec('PRAGMA wal_checkpoint(FULL)');
    sourceDb.prepare('VACUUM INTO ?').run(workDatabase);
    migrated = openDatabase(workRoot, {
      appVersion,
      skipMigrationBackup: true,
      skipMigrationPreflight: true,
    });
    const integrity = String(migrated.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown');
    if (integrity !== 'ok') throw new Error(`Shadow migration integrity_check failed: ${integrity}`);
    const foreignKeyFailures = migrated.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyFailures.length) throw new Error(`Shadow migration foreign_key_check failed with ${foreignKeyFailures.length} violations.`);
    assertDatabaseHealth(migrated);
    const after = collectDatabaseInventory(migrated, { includeContentFingerprints: true });
    assertDatabaseInventoryPreserved(before, after);
  } catch (error) {
    throw new DatabaseMaintenanceError(`Shadow database migration preflight failed: ${error?.message || error}`, {
      code: 'DB_MIGRATION_FAILED', phase: 'shadow_preflight', recoveryEligible: true, cause: error,
    });
  } finally {
    try { migrated?.close(); } catch {}
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

function readPackageVersion() {
  try { return String(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0'); }
  catch { return '0.0.0'; }
}

function syncDatabaseQuarantine(db, health) {
  const upsert = db.prepare(`INSERT INTO database_quarantine_records(
    id,rule_id,source_table,source_id,reason_code,resolution_status,metadata_json,resolved_at
  ) VALUES(?,?, 'database_audit','summary',?,?,?,?)
  ON CONFLICT(rule_id,source_table,source_id,reason_code) DO UPDATE SET
    resolution_status=excluded.resolution_status,metadata_json=excluded.metadata_json,resolved_at=excluded.resolved_at`);
  for (const check of health.checks) {
    const pending = check.repairMode === 'quarantine' && check.count > 0;
    upsert.run(`quarantine_${check.ruleId}`, check.ruleId, check.ruleId, pending ? 'pending' : 'resolved',
      JSON.stringify({ count: check.count, severity: check.severity, repairMode: check.repairMode }), pending ? '' : new Date().toISOString());
  }
}

function splitSchemaIndexes(schema = '') {
  const indexes = [];
  const tables = String(schema || '').replace(/CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]*?;/gi, (statement) => {
    indexes.push(statement);
    return '';
  });
  return { tables, indexes: indexes.join('\n') };
}
