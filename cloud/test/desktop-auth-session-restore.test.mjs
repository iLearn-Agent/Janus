import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openDatabase } from '../../src/main/db.js';
import { SocialRelayService } from '../../src/main/socialRelay.js';

test('desktop session restore preserves refresh credentials across a transient network failure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-auth-restore-network-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  let logoutCount = 0;
  const auth = {
    currentUser: () => ({ id: 'local_network_user', remoteId: 'remote_network_user', remoteBound: true, authProvider: 'cloud' }),
    logout() { logoutCount += 1; },
  };
  const relay = new SocialRelayService({
    db,
    auth,
    defaultServerUrl: 'https://cloud.example.test',
    client: {
      async me() { throw new Error('fetch failed'); },
    },
  });
  db.prepare(`UPDATE cloud_auth_state SET access_token='expired_access',refresh_token='saved_refresh',
    remote_user_id='remote_network_user',updated_at=? WHERE id='default'`).run(new Date().toISOString());

  const restored = await relay.restoreSession();
  const saved = db.prepare("SELECT access_token,refresh_token,remote_user_id,last_error FROM cloud_auth_state WHERE id='default'").get();
  assert.equal(restored.restored, false);
  assert.equal(restored.retryable, true);
  assert.equal(restored.reason, 'session_restore_unavailable');
  assert.equal(saved.access_token, 'expired_access');
  assert.equal(saved.refresh_token, 'saved_refresh');
  assert.equal(saved.remote_user_id, 'remote_network_user');
  assert.equal(saved.last_error, 'fetch failed');
  assert.equal(logoutCount, 0);
});
