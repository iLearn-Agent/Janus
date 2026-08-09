import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createFileObjectService, objectKeyForUser } from '../src/modules/sync/fileObjects.mjs';
import { createMemoryObjectStore, createS3ObjectStore } from '../src/modules/sync/objectStore.mjs';
import { createSyncV6Service } from '../src/modules/sync/syncV6.mjs';

test('Sync V6 file objects use per-user SHA paths and verify size/checksum before download', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await pool.query(`INSERT INTO account_workspaces(id,workspace_kind,name,status)
    VALUES('workspace_personal','personal','个人空间','active')`);
  await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash) VALUES
    ('user_a','user_a@example.test','User A','user_a','test-hash'),
    ('user_b','user_b@example.test','User B','user_b','test-hash')`);
  const store = createMemoryObjectStore();
  const service = createFileObjectService({ pool, objectStore: store, apiError });
  const body = Buffer.from('verified cloud file');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const grantA = { userId: 'user_a', deviceId: 'device_a' };

  const initiated = await service.initiate(grantA, { sha256, sizeBytes: body.length, contentType: 'text/plain' });
  assert.equal(initiated.status, 'upload_required');
  assert.equal(initiated.objectKey, objectKeyForUser('user_a', sha256));
  store.put({ objectKey: initiated.objectKey, body, contentType: 'text/plain' });
  const completed = await service.complete(grantA, { sha256 });
  assert.equal(completed.status, 'verified');
  assert.equal(completed.checksumVerified, true);
  const sync = createSyncV6Service({ pool, apiError, env: { JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '0' } });
  const refBatch = await sync.submitBatch(grantA, { batchId: 'file_ref_batch', changes: [{
    changeId: 'file_ref_change', entityType: 'file_ref', entityId: 'file_ref_1', operation: 'upsert', baseRevision: 0,
    occurredAt: new Date().toISOString(), payload: { id: 'file_ref_1', sha256 },
  }] });
  assert.equal(refBatch.conflictCount, 0);
  assert.equal(Number((await pool.query('SELECT reference_count FROM cloud_file_objects_v6 WHERE user_id=$1 AND sha256=$2', ['user_a', sha256])).rows[0].reference_count), 1);
  assert.match((await service.download(grantA, sha256)).download.url, /^memory:\/\/download\//);
  assert.equal((await service.initiate(grantA, { sha256, sizeBytes: body.length })).status, 'already_uploaded');

  await assert.rejects(service.download({ userId: 'user_b', deviceId: 'device_b' }, sha256),
    (error) => error.code === 'file_object_not_found');

  const wrongBody = Buffer.from('different checksum');
  const expectedSha = crypto.createHash('sha256').update(Buffer.alloc(wrongBody.length, 1)).digest('hex');
  const wrong = await service.initiate(grantA, { sha256: expectedSha, sizeBytes: wrongBody.length });
  store.put({ objectKey: wrong.objectKey, body: wrongBody });
  await assert.rejects(service.complete(grantA, { sha256: expectedSha }),
    (error) => error.code === 'file_checksum_mismatch');
  await pool.query(`UPDATE cloud_file_objects_v6 SET upload_expires_at=$1,unreferenced_at=$1
    WHERE user_id=$2 AND sha256=$3`, [new Date(0), grantA.userId, expectedSha]);
  const cleanupBody = Buffer.from('cleanup trigger');
  const cleanupSha = crypto.createHash('sha256').update(cleanupBody).digest('hex');
  await service.initiate(grantA, { sha256: cleanupSha, sizeBytes: cleanupBody.length });
  assert.equal(store.objects.has(wrong.objectKey), false, 'expired unreferenced pending uploads must be removed from object storage');
  assert.equal((await pool.query('SELECT storage_status FROM cloud_file_objects_v6 WHERE user_id=$1 AND sha256=$2', [grantA.userId, expectedSha])).rows[0].storage_status,
    'deleted');
  await assert.rejects(service.initiate(grantA, { sha256, sizeBytes: 60 * 1024 * 1024 + 1 }),
    (error) => error.code === 'file_size_invalid');
});

test('S3 client URLs use the public endpoint while server verification uses the private endpoint', async () => {
  const sha256 = crypto.createHash('sha256').update('signed checksum head').digest('hex');
  const checksum = Buffer.from(sha256, 'hex').toString('base64');
  let request = null;
  const store = createS3ObjectStore({
    env: {
      JANUS_S3_ENDPOINT: 'https://s3-internal.example.test',
      JANUS_S3_PUBLIC_ENDPOINT: 'https://s3-public.example.test',
      JANUS_S3_REGION: 'us-east-1',
      JANUS_S3_BUCKET: 'janus-test',
      JANUS_S3_ACCESS_KEY_ID: 'test-access-key',
      JANUS_S3_SECRET_ACCESS_KEY: 'test-secret-key',
      JANUS_S3_FORCE_PATH_STYLE: 'true',
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 200, headers: {
        'content-length': '42', 'x-amz-checksum-sha256': checksum, etag: '"test-etag"',
      } });
    },
  });

  const initiated = await store.initiateUpload({
    objectKey: `users/user_a/sha256/${sha256.slice(0, 2)}/${sha256}`,
    sha256,
    sizeBytes: 42,
    contentType: 'text/plain',
  });
  assert.equal(new URL(initiated.url).host, 's3-public.example.test');
  const head = await store.headObject({ objectKey: `users/user_a/sha256/${sha256.slice(0, 2)}/${sha256}` });
  assert.equal(new URL(request.url).host, 's3-internal.example.test');
  assert.equal(request.options.method, 'HEAD');
  assert.equal(request.options.headers['x-amz-checksum-mode'], 'ENABLED');
  assert.match(new URL(request.url).searchParams.get('X-Amz-SignedHeaders') || '', /x-amz-checksum-mode/);
  assert.equal(head.sizeBytes, 42);
  assert.equal(head.checksumSha256, checksum);
  assert.equal(head.etag, 'test-etag');
});

function apiError(code, message, status) { const error = new Error(message); error.code = code; error.status = status; return error; }
