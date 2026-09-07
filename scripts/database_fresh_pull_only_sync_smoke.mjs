import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CloudSyncService } from '../src/main/cloudSync.js';
import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';
import { assessDatabaseClientCompatibility } from '../src/shared/databaseEvolutionContract.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-fresh-pull-only-'));
let db;
try {
  db = openDatabase(root, { appVersion: '0.2.18', skipMigrationBackup: true });
  db.prepare("INSERT INTO auth_users(id,email,display_name,remote_id) VALUES('pull_user','pull@example.com','Pull','remote_pull_user')").run();
  const store = new Store(db, { root });
  store.settingSet('database:fresh_recovery_state', JSON.stringify({
    mode: 'fresh_database_recovery', quarantineId: 'pull_quarantine', cloudPullCompleted: false,
    localAuditCompleted: true, bidirectionalSyncEnabled: false,
  }));

  let submitted = 0;
  let uploaded = 0;
  let changeRequests = 0;
  const client = {
    async syncV6Capabilities(_state, contract) {
      return { schemaVersion: 6, databaseCompatibility: assessDatabaseClientCompatibility(contract) };
    },
    async syncV6Changes(_state, { cursor }) {
      changeRequests += 1;
      return {
        schemaVersion: 6,
        cursor: String(Number(cursor || 0) + 1),
        hasMore: changeRequests <= 20,
        changes: [],
      };
    },
    async submitV6Batch(_state, payload, contract) {
      submitted += 1;
      assert.equal(assessDatabaseClientCompatibility(contract).compatible, true);
      return { status: 'accepted', acceptedChanges: [], batchId: payload.batch?.id || '' };
    },
  };
  const sync = new CloudSyncService({ root, db, store, client, defaultConfig: {} });
  db.prepare(`UPDATE cloud_sync_state SET user_id='remote_pull_user',device_id='pull_device',server_url='https://sync.example.test',
    device_grant='device-grant',evolution_grant='evolution-grant',sync_schema_version=6 WHERE id='default'`).run();
  sync.ensureEmployeeBootstrap = async () => ({ status: 'ok' });
  sync.applyEmployeeOverview = () => ({});
  sync.syncEmployeeAuthority = async () => ({ status: 'ok' });
  sync.retryDeferredV6IdentityChanges = () => ({ resolved: 0, pending: 0, quarantined: 0 });
  sync.prepareTaskMemoryCloudEnvelopes = async () => ({ status: 'ok' });
  sync.recoverTaskMemoryKeys = async () => ({ status: 'completed', recovered: 0, failures: [] });
  sync.refreshEmployeeProgressionProjections = async () => ({ status: 'ok' });
  sync.syncEvolutionAuthority = async () => ({ status: 'ok' });
  sync.uploadFilesV6 = async () => { uploaded += 1; return 0; };

  const first = await sync.performV6SyncNow({ state: sync.state(), reason: 'fresh_database_first_sync' });
  assert.equal(first.status, 'partial');
  assert.equal(first.sourceBatchStatus, 'pull_only');
  assert.equal(submitted, 0, 'the first sync after a fresh database must not upload a batch');
  assert.equal(uploaded, 0, 'the first sync after a fresh database must not upload files');
  const recoveryAfterFirstPageWindow = JSON.parse(store.settingGet('database:fresh_recovery_state', '{}'));
  assert.equal(recoveryAfterFirstPageWindow.cloudPullCompleted, false,
    'a fresh database must remain pull-only while the server still reports more pages');
  assert.equal(recoveryAfterFirstPageWindow.bidirectionalSyncEnabled, false);

  const second = await sync.performV6SyncNow({ state: sync.state(), reason: 'fresh_database_second_sync' });
  assert.equal(second.status, 'completed');
  assert.equal(second.sourceBatchStatus, 'pull_only');
  assert.equal(submitted, 0);
  assert.equal(uploaded, 0);
  const recoveryAfterPull = JSON.parse(store.settingGet('database:fresh_recovery_state', '{}'));
  assert.equal(recoveryAfterPull.cloudPullCompleted, true);
  assert.equal(recoveryAfterPull.bidirectionalSyncEnabled, true);

  const third = await sync.performV6SyncNow({ state: sync.state(), reason: 'fresh_database_third_sync' });
  assert.ok(['completed', 'partial'].includes(third.status));
  assert.equal(submitted, 1, 'normal upload must resume only after the pull-only pass completes');
  assert.equal(uploaded, 1);
  sync.close();
  process.stdout.write('Database fresh pull-only sync smoke passed.\n');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
