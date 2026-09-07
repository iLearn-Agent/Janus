import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repairDatabase } from '../src/main/databaseRecovery.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-repair-cli-'));
try {
  const payload = repairDatabase(root, { appVersion: '0.2.16' });
  assert.equal(payload.status, 'not_needed');
  assert.equal(payload.code, 'DB_HEALTHY');
  const mainSource = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /databaseRepairHeadless[\s\S]*runHeadlessDatabaseRepair\(\)/,
    'Electron entrypoint must route --repair-database --headless to the repair command');
  assert.match(mainSource, /result\.status === 'not_needed' \? 2 : 0/,
    'healthy database CLI status must retain its documented exit code');
  process.stdout.write('Database repair CLI smoke passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
