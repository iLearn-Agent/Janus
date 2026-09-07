import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { exportDatabaseDiagnostics } from '../src/main/databaseRecovery.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-diagnostics-v2-'));
const destination = path.join(root, 'database-diagnostics.json');

try {
  const db = openDatabase(root, { appVersion: '0.2.24', skipMigrationBackup: true });
  db.close();
  const lastError = Object.assign(new Error(
    'Shadow database migration preflight failed: Database maintenance failed during migration: '
      + 'agent_alias_context_state_repair_v4:validation:state42: device_context_memory_agent_mismatch:state42',
  ), { code: 'DB_MIGRATION_FAILED', phase: 'shadow_preflight' });
  exportDatabaseDiagnostics(root, { destination, appVersion: '0.2.24', lastError });
  const payload = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(payload.schema, 'janus-database-diagnostics-v2');
  assert.equal(payload.lastError.repairMigrationId, 'agent_alias_context_state_repair_v4');
  assert.equal(payload.lastError.repairStage, 'validation');
  assert.equal(payload.lastError.repairObjectId, 'state42');
  assert.equal(payload.lastError.repairInvariant, 'device_context_memory_agent_mismatch');
  assert.equal(payload.diagnosticEvidence.identityTriggers.length, 10);
  assert.equal(payload.diagnosticEvidence.identityTriggers.every((trigger) => trigger.present && trigger.sqlHash.length === 64), true);
  assert.deepEqual(payload.diagnosticEvidence.health.nonzeroChecks, []);
  assert.equal(JSON.stringify(payload).includes(root), false, 'diagnostics must not expose the local application path');
  process.stdout.write('Database diagnostics v2 smoke passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
