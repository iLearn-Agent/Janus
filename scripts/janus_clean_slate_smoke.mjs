import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { DATABASE_MIGRATION_IDS } from '../src/main/modules/persistence/infrastructure/databaseMigrationRegistry.js';
import { codexStyleUserDataRoot, dbPath } from '../src/main/paths.js';
import {
  DATABASE_EVOLUTION_CONTRACT_VERSION,
  DATABASE_SYNC_CAPABILITIES,
  DATABASE_SYNC_MINIMUM_APP_VERSION,
  DATABASE_SYNC_PROTOCOL_VERSION,
  createDatabaseClientContract,
} from '../src/shared/databaseEvolutionContract.js';

const desktopPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(desktopPackage.name, 'janus');
assert.equal(desktopPackage.desktopName, 'Janus');
assert.equal(desktopPackage.build?.appId, 'local.janus.desktop');
assert.equal(desktopPackage.build?.productName, 'Janus');
assert.equal(desktopPackage.build?.files?.includes('!**/*.bak-*'), true);
assert.equal(desktopPackage.build?.files?.includes('!**/*.orig'), true);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-clean-slate-home-'));
const root = codexStyleUserDataRoot({ homeDir: home });
assert.equal(root, path.join(home, '.janus'));
assert.equal(dbPath(root), path.join(home, '.janus', 'data', 'janus.db'));

let db;
try {
  db = openDatabase(root, { appVersion: DATABASE_SYNC_MINIMUM_APP_VERSION, skipMigrationBackup: true });
  const identity = db.prepare("SELECT product_namespace,data_generation FROM database_meta WHERE id='default'").get();
  assert.deepEqual({ ...identity }, { product_namespace: 'janus', data_generation: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='janus_clean_slate_identity_v1'").get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM auth_users').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sessions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 0);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const contract = createDatabaseClientContract({
    appVersion: DATABASE_SYNC_MINIMUM_APP_VERSION,
    migrationIds: DATABASE_MIGRATION_IDS,
  });
  assert.equal(contract.contractVersion, DATABASE_EVOLUTION_CONTRACT_VERSION);
  assert.equal(contract.syncProtocolVersion, DATABASE_SYNC_PROTOCOL_VERSION);
  assert.equal(contract.migrationHead, DATABASE_MIGRATION_IDS.at(-1));
  assert.equal(contract.appliedMigrationIds.includes('organization_message_research_v1'), true);
  assert.equal(contract.capabilities.includes('janus-clean-slate-v1'), true);
  assert.deepEqual(contract.capabilities, [...DATABASE_SYNC_CAPABILITIES].sort());
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
}

process.stdout.write('Janus clean-slate smoke passed.\n');
