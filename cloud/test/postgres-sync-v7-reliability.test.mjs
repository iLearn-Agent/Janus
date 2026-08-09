import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createFileObjectService } from '../src/modules/sync/fileObjects.mjs';
import { createMemoryObjectStore } from '../src/modules/sync/objectStore.mjs';
import { createSyncV6Service } from '../src/modules/sync/syncV6.mjs';

test('Sync V7 compaction restores lagging devices with an isolated snapshot followed by newer changes', async (t) => {
  const { pool } = await createReliabilityDatabase(t);
  const service = createSyncV6Service({
    pool, apiError,
    env: { JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '0', JANUS_SYNC_V6_COMPACTION_CHANGE_THRESHOLD: '2', JANUS_SYNC_V6_BATCH_RATE_LIMIT: '100' },
  });
  const grantA = { userId: 'user_a', deviceId: 'device_a' };
  const first = await service.submitBatch(grantA, batch('batch_snapshot', [
    change('change_project_1', 'project', 'project_1', { id: 'project_1', title: 'Snapshot project' }),
    change('change_message_1', 'message', 'message_1', { id: 'message_1', conversationId: 'conversation_1', content: 'Snapshot message' }),
  ]));
  assert.ok(Number(first.cursor) > 0);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM cloud_sync_changes_v6 WHERE user_id='user_a'")).rows[0].count), 0);

  await service.submitBatch(grantA, batch('batch_after_snapshot', [
    change('change_project_2', 'project', 'project_2', { id: 'project_2', title: 'After snapshot' }),
  ]));
  const recovered = await service.changes({ userId: 'user_a', deviceId: 'device_new' }, { cursor: '0', limit: 100 });
  assert.equal(recovered.resetRequired, true);
  assert.ok(Number(recovered.snapshot.cursor) > 0);
  assert.deepEqual(recovered.snapshot.entities.map((item) => item.entityId).sort(), ['message_1', 'project_1']);
  assert.deepEqual(recovered.changes.map((item) => item.entityId), ['project_2']);
  assert.ok(Number(recovered.cursor) > Number(recovered.snapshot.cursor));

  const current = await service.changes(grantA, { cursor: recovered.snapshot.cursor, limit: 100 });
  assert.equal(current.resetRequired, false);
  assert.deepEqual(current.changes.map((item) => item.entityId), ['project_2']);
  const isolated = await service.changes({ userId: 'user_b', deviceId: 'device_b' }, { cursor: '0', limit: 100 });
  assert.equal(isolated.resetRequired, false);
  assert.equal(isolated.snapshot, null);
  assert.deepEqual(isolated.changes, []);

  const metricsA = await service.metrics(grantA);
  const metricsB = await service.metrics({ userId: 'user_b', deviceId: 'device_b' });
  assert.equal(metricsA.changeCount, 3);
  assert.equal(metricsA.retainedChangeCount, 1);
  assert.equal(metricsA.snapshot.entityCount, 2);
  assert.equal(metricsB.changeCount, 0);
  assert.equal(metricsB.snapshot.entityCount, 0);
});

test('Sync V7 batch rate limits reset at a new window', async (t) => {
  const { pool } = await createReliabilityDatabase(t);
  const service = createSyncV6Service({
    pool, apiError,
    env: { JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '0', JANUS_SYNC_V6_COMPACTION_CHANGE_THRESHOLD: '1000', JANUS_SYNC_V6_BATCH_RATE_LIMIT: '1', JANUS_SYNC_V6_RATE_LIMIT_WINDOW_MS: '60000' },
  });
  const grant = { userId: 'user_a', deviceId: 'device_rate' };
  await service.submitBatch(grant, batch('batch_rate_1', []));
  await assert.rejects(service.submitBatch(grant, batch('batch_rate_2', [])),
    (error) => error.code === 'sync_rate_limit_exceeded' && error.status === 429 && error.retryAfterMs > 0);
  await pool.query(`UPDATE cloud_sync_rate_limits_v7 SET window_started_at=$1
    WHERE user_id='user_a' AND device_id='device_rate'`, [new Date(0)]);
  assert.equal((await service.submitBatch(grant, batch('batch_rate_3', []))).status, 'accepted');
});

test('Sync V7 file quota counts pending and verified bytes per user', async (t) => {
  const { pool } = await createReliabilityDatabase(t);
  const objectStore = createMemoryObjectStore();
  const files = createFileObjectService({ pool, objectStore, apiError, env: { JANUS_SYNC_V6_STORAGE_QUOTA_BYTES: '10' } });
  const grantA = { userId: 'user_a', deviceId: 'device_a' };
  const bodyA = Buffer.from('12345678');
  const shaA = crypto.createHash('sha256').update(bodyA).digest('hex');
  const pending = await files.initiate(grantA, { sha256: shaA, sizeBytes: bodyA.length });
  assert.equal(pending.status, 'upload_required');
  const bodyTooLarge = Buffer.from('abc');
  const shaTooLarge = crypto.createHash('sha256').update(bodyTooLarge).digest('hex');
  await assert.rejects(files.initiate(grantA, { sha256: shaTooLarge, sizeBytes: bodyTooLarge.length }),
    (error) => error.code === 'file_storage_quota_exceeded' && error.quotaBytes === 10 && error.usedBytes === 8);

  objectStore.put({ objectKey: pending.objectKey, body: bodyA });
  await files.complete(grantA, { sha256: shaA });
  const service = createSyncV6Service({ pool, apiError });
  const metricsA = await service.metrics(grantA);
  assert.deepEqual(metricsA.storage, { verifiedBytes: 8, pendingBytes: 0 });

  const grantB = { userId: 'user_b', deviceId: 'device_b' };
  const allowedForOtherUser = await files.initiate(grantB, { sha256: shaTooLarge, sizeBytes: bodyTooLarge.length });
  assert.equal(allowedForOtherUser.status, 'upload_required');
  assert.deepEqual((await service.metrics(grantB)).storage, { verifiedBytes: 0, pendingBytes: 3 });
});

async function createReliabilityDatabase(t) {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await pool.query(`INSERT INTO account_workspaces(id,workspace_kind,name,status)
    VALUES('workspace_personal','personal','Personal','active')`);
  await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash) VALUES
    ('user_a','user_a@example.test','User A','user_a','test-hash'),
    ('user_b','user_b@example.test','User B','user_b','test-hash')`);
  return { pool };
}

function batch(id, changes) {
  return { schemaVersion: 6, batch: { id }, changes };
}

function change(changeId, entityType, entityId, payload) {
  return { changeId, entityType, entityId, operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(), payload };
}

function apiError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
