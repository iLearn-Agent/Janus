import fs from 'node:fs';
import path from 'node:path';

import { redactDiagnosticText, redactDiagnosticValue } from '../../../../shared/diagnostics.js';
import { dataDir, dbPath } from '../../../paths.js';
import { databaseTableExists, databaseStructureFingerprint, inspectDatabaseHealth, inspectDatabaseStructure } from './databaseHealth.js';

export class DatabaseMaintenanceError extends Error {
  constructor(message, { code = 'DB_MIGRATION_FAILED', phase = '', migrationId = '', recoveryEligible = true, backupId = '', cause = null, health = null } = {}) {
    super(String(message || code), cause ? { cause } : undefined);
    this.name = 'DatabaseMaintenanceError';
    Object.assign(this, { code, phase, migrationId, recoveryEligible: Boolean(recoveryEligible), backupId, health });
  }
}

export const isDatabaseMaintenanceError = (error) => error instanceof DatabaseMaintenanceError || /^DB_[A-Z0-9_]+$/.test(String(error?.code || ''));
const statePath = (root) => path.join(dataDir(root), 'database-startup-state.json');
const logPath = (root) => path.join(dataDir(root), 'database-maintenance.jsonl');

export function readDatabaseStartupState(root) {
  try { return JSON.parse(fs.readFileSync(statePath(root), 'utf8')); } catch { return null; }
}

export function markDatabaseStartupStarted(root, { appVersion = '', fingerprint = '' } = {}) {
  writeState(root, { schema: 'janus-database-startup-state-v1', clean: false, appVersion, fingerprint, startedAt: new Date().toISOString(), closedAt: '' });
}

export function markDatabaseStartupClean(root, { appVersion = '', fingerprint = '' } = {}) {
  const previous = readDatabaseStartupState(root) || {};
  writeState(root, { ...previous, schema: 'janus-database-startup-state-v1', clean: true, appVersion: appVersion || previous.appVersion || '', fingerprint: fingerprint || previous.fingerprint || '', closedAt: new Date().toISOString() });
}

export function appendDatabaseMaintenanceEvent(root, event = {}) {
  try {
    fs.mkdirSync(dataDir(root), { recursive: true });
    const payload = redactDiagnosticValue({ schema: 'janus-database-maintenance-event-v1', timestamp: new Date().toISOString(), ...event,
      errorSummary: redactDiagnosticText(event.errorSummary || '') });
    fs.appendFileSync(logPath(root), `${JSON.stringify(payload)}\n`, 'utf8');
    return true;
  } catch { return false; }
}

export function readDatabaseMeta(db) {
  return databaseTableExists(db, 'database_meta') ? db.prepare("SELECT * FROM database_meta WHERE id='default'").get() || null : null;
}

export function assertDatabaseWriterCompatible(db, appVersion = '') {
  const minimum = String(readDatabaseMeta(db)?.min_writer_version || '');
  if (!minimum || !appVersion || compareVersions(appVersion, minimum) >= 0) return minimum;
  throw new DatabaseMaintenanceError(`This database requires Janus ${minimum} or newer.`, { code: 'DB_DOWNGRADE_BLOCKED', phase: 'preflight' });
}

export function updateDatabaseMeta(db, { appVersion = '', fingerprint = '', healthStatus = '', fullAudit = false, minimumWriterVersion = '' } = {}) {
  if (!databaseTableExists(db, 'database_meta')) return null;
  const existing = readDatabaseMeta(db);
  const minimum = !existing?.min_writer_version || compareVersions(minimumWriterVersion, existing.min_writer_version) > 0 ? minimumWriterVersion : existing.min_writer_version;
  db.prepare(`INSERT INTO database_meta(id,schema_epoch,min_writer_version,last_successful_app_version,last_structure_fingerprint,last_full_audit_at,last_health_status,updated_at)
    VALUES('default',1,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO UPDATE SET
    min_writer_version=excluded.min_writer_version,last_successful_app_version=excluded.last_successful_app_version,
    last_structure_fingerprint=excluded.last_structure_fingerprint,last_full_audit_at=CASE WHEN excluded.last_full_audit_at!='' THEN excluded.last_full_audit_at ELSE database_meta.last_full_audit_at END,
    last_health_status=excluded.last_health_status,updated_at=excluded.updated_at`).run(minimum || '', appVersion, fingerprint, fullAudit ? new Date().toISOString() : '', healthStatus || 'unknown');
  return readDatabaseMeta(db);
}

export function recordDatabaseMaintenanceRun(db, row = {}) {
  if (!databaseTableExists(db, 'database_maintenance_runs')) return null;
  db.prepare(`INSERT OR REPLACE INTO database_maintenance_runs(id,run_kind,app_version,migration_id,code_checksum,phase,status,
    structure_fingerprint_before,structure_fingerprint_after,scanned_count,repaired_count,quarantined_count,backup_id,error_code,error_summary,started_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.runKind || 'migration', row.appVersion || '', row.migrationId || '', row.codeChecksum || '', row.phase || '', row.status || 'committed',
    row.fingerprintBefore || '', row.fingerprintAfter || '', row.scannedCount || 0, row.repairedCount || 0, row.quarantinedCount || 0, row.backupId || '', row.errorCode || '',
    redactDiagnosticText(row.errorSummary || ''), row.startedAt || new Date().toISOString(), row.completedAt || new Date().toISOString());
  return db.prepare('SELECT * FROM database_maintenance_runs WHERE id=?').get(row.id);
}

export const inspectOpenDatabase = (db) => ({ structure: inspectDatabaseStructure(db), fingerprint: databaseStructureFingerprint(db), health: inspectDatabaseHealth(db), meta: readDatabaseMeta(db) });
export function databaseMaintenanceNeeded({ pendingMigrationIds = [], structureIssues = [], previousStartupState = null } = {}) {
  return [...new Set([...pendingMigrationIds.map((id) => `migration:${id}`), ...structureIssues.map((issue) => `structure:${issue.code}:${issue.table || ''}:${issue.column || ''}`),
    ...(previousStartupState?.clean === false ? ['previous_unclean_exit'] : [])])];
}

export function compareVersions(left = '', right = '') {
  const parts = (value) => String(value).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((item) => Number.parseInt(item, 10) || 0);
  const a = parts(left); const b = parts(right);
  for (let index = 0; index < 3; index += 1) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  return 0;
}

export function databaseFileStatus(root) {
  const file = dbPath(root);
  const exists = fs.existsSync(file);
  return { exists, sizeBytes: exists ? fs.statSync(file).size : 0,
    walSizeBytes: fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0,
    shmSizeBytes: fs.existsSync(`${file}-shm`) ? fs.statSync(`${file}-shm`).size : 0 };
}

function writeState(root, state) {
  try { fs.mkdirSync(dataDir(root), { recursive: true }); fs.writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`, 'utf8'); } catch {}
}
