import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AuthService } from '../src/main/auth.js';
import { openDatabase, run } from '../src/main/db.js';
import { SocialRelayService } from '../src/main/socialRelay.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-social-realtime-backoff-'));
let db;

try {
  db = openDatabase(root, { skipMigrationBackup: true });
  const auth = new AuthService(db);

  let streamCall = 0;
  const statuses = [];
  let relay;
  const client = {
    capabilities: async () => ({ capabilities: ['delegation-realtime-sse-v1'] }),
    async streamSocialEvents(_state, { onEvent }) {
      streamCall += 1;
      if (streamCall === 2) onEvent({ id: 'event-1', sequence: 1, type: 'delegation_updated' });
      if (streamCall >= 3) relay.stopRealtimeEvents();
      return { closed: true };
    },
  };
  relay = new SocialRelayService({
    db, auth, client, realtimeRetryBaseMs: 5, realtimeRetryMaxMs: 20,
  });
  run(db, `UPDATE cloud_auth_state SET enabled=1,server_url='https://social.invalid',
    remote_user_id='remote-user',access_token='access-token',refresh_token='refresh-token' WHERE id='default'`);
  await relay.startRealtimeEvents({ onStatus: (status) => statuses.push(status) });
  const reconnects = statuses.filter((status) => status.status === 'reconnecting');
  assert.deepEqual(reconnects.map((status) => status.reason), ['stream_closed', 'stream_closed']);
  assert.deepEqual(reconnects.map((status) => status.retryMs), [5, 5],
    'a valid event must reset the EOF retry delay to the base interval');
  assert.equal(statuses.some((status) => status.status === 'connected'), true);

  run(db, `UPDATE cloud_auth_state SET enabled=1,server_url='https://social.invalid',
    remote_user_id='remote-user',access_token='expired-access',refresh_token='expired-refresh' WHERE id='default'`);
  const unauthorized = new Error('Unauthorized');
  unauthorized.status = 401;
  const refreshExpired = new Error('Refresh token expired');
  refreshExpired.status = 401;
  refreshExpired.code = 'refresh_token_expired';
  const authStatuses = [];
  const authRelay = new SocialRelayService({
    db,
    auth,
    client: {
      capabilities: async () => ({ capabilities: ['delegation-realtime-sse-v1'] }),
      streamSocialEvents: async () => { throw unauthorized; },
      refresh: async () => { throw refreshExpired; },
    },
    realtimeRetryBaseMs: 5,
    realtimeRetryMaxMs: 20,
  });
  const authResult = await authRelay.startRealtimeEvents({ onStatus: (status) => authStatuses.push(status) });
  assert.equal(authResult.status, 'closed');
  assert.equal(authStatuses.at(-1)?.status, 'paused_auth');
  assert.equal(authStatuses.some((status) => status.status === 'error'), false,
    'an expired refresh token must pause instead of entering the reconnect loop');

  console.log('Social realtime backoff smoke passed');
} finally {
  try { db?.close(); } catch {}
  await rm(root, { recursive: true, force: true });
}
