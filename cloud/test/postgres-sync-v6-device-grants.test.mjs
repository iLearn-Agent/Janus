import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createDeviceGrantService, routeWithDeviceGrant } from '../src/modules/sync/deviceGrants.mjs';
import { deviceGrantProofMessage, rsaPublicKeyFingerprint } from '../../src/shared/taskMemoryCrypto.js';

test('Sync V6 Device Grants support strict cross-device approval and enforce revocation', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await insertUsers(pool, ['user_a', 'user_b']);

  const service = createDeviceGrantService({ pool, apiError, approvalMode: 'cross_device' });
  const firstKey = deviceIdentity();
  const secondKey = deviceIdentity();
  const first = await service.register({ userId: 'user_a', input: { deviceId: 'device_1', publicKey: firstKey.publicKey } });
  assert.equal(first.status, 'approved');
  assert.match(first.publicKeyFingerprint, /^[a-f0-9]{64}$/);

  const second = await service.register({ userId: 'user_a', input: { deviceId: 'device_2', publicKey: secondKey.publicKey } });
  assert.equal(second.status, 'pending');
  await assert.rejects(service.issueToken({ userId: 'user_a', deviceId: 'device_1', requestedScopes: ['sync:read'],
    proof: signProof(secondKey, 'user_a', 'device_1', ['sync:read']) }), (error) => error.code === 'device_proof_invalid');
  await assert.rejects(
    service.issueToken({ userId: 'user_a', deviceId: 'device_2', requestedScopes: ['sync:read'], proof: signProof(secondKey, 'user_a', 'device_2', ['sync:read']) }),
    (error) => error.code === 'device_not_approved' && error.status === 409,
  );

  const firstGrant = await service.issueToken({
    userId: 'user_a', deviceId: 'device_1', requestedScopes: ['sync:read', 'devices:approve'],
    proof: signProof(firstKey, 'user_a', 'device_1', ['sync:read', 'devices:approve']),
  });
  assert.deepEqual(firstGrant.scopes.sort(), ['devices:approve', 'sync:read']);
  assert.equal((await authorize(pool, firstGrant.token, 'devices:approve')).deviceId, 'device_1');

  const approved = await service.approve({ userId: 'user_a', actorDeviceId: 'device_1', targetDeviceId: 'device_2' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedByDeviceId, 'device_1');
  const secondGrant = await service.issueToken({ userId: 'user_a', deviceId: 'device_2', requestedScopes: ['sync:read'],
    proof: signProof(secondKey, 'user_a', 'device_2', ['sync:read']) });
  assert.equal((await authorize(pool, secondGrant.token, 'sync:read')).userId, 'user_a');

  const otherKey = deviceIdentity();
  const other = await service.register({ userId: 'user_b', input: { deviceId: 'device_1', publicKey: otherKey.publicKey } });
  assert.equal(other.status, 'approved');
  const otherGrant = await service.issueToken({ userId: 'user_b', deviceId: 'device_1', requestedScopes: ['sync:read'],
    proof: signProof(otherKey, 'user_b', 'device_1', ['sync:read']) });
  assert.equal((await authorize(pool, otherGrant.token, 'sync:read')).userId, 'user_b');

  assert.equal((await service.revoke({ userId: 'user_a', actorDeviceId: 'device_1', targetDeviceId: 'device_2' })).status, 'revoked');
  await assert.rejects(authorize(pool, secondGrant.token, 'sync:read'), (error) => error.code === 'device_grant_invalid');
  await assert.rejects(authorize(pool, firstGrant.token, 'sync:write'), (error) => error.code === 'device_grant_scope_denied');
});

test('authenticated device registration automatically authorizes new, replacement, and previously revoked devices', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await insertUsers(pool, ['user_login']);

  const service = createDeviceGrantService({ pool, apiError });
  const firstKey = deviceIdentity();
  const replacementKey = deviceIdentity();
  assert.equal((await service.register({ userId: 'user_login', input: { deviceId: 'device_first', publicKey: firstKey.publicKey } })).status, 'approved');
  const replacement = await service.register({ userId: 'user_login', input: { deviceId: 'device_reinstalled', publicKey: replacementKey.publicKey } });
  assert.equal(replacement.status, 'approved');
  assert.equal(replacement.approvedByDeviceId, 'authenticated_registration');
  const grant = await service.issueToken({
    userId: 'user_login', deviceId: 'device_reinstalled', requestedScopes: ['sync:read'],
    proof: signProof(replacementKey, 'user_login', 'device_reinstalled', ['sync:read']),
  });
  assert.equal(grant.status, 'approved');
  assert.equal((await service.revoke({ userId: 'user_login', actorDeviceId: 'device_first', targetDeviceId: 'device_reinstalled' })).status, 'revoked');
  const reauthorized = await service.register({
    userId: 'user_login', input: { deviceId: 'device_reinstalled', publicKey: replacementKey.publicKey },
  });
  assert.equal(reauthorized.status, 'approved');
  assert.equal(reauthorized.revokedAt, null);
  assert.equal((await service.issueToken({
    userId: 'user_login', deviceId: 'device_reinstalled', requestedScopes: ['sync:read'],
    proof: signProof(replacementKey, 'user_login', 'device_reinstalled', ['sync:read']),
  })).status, 'approved');
});

function apiError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function deviceIdentity() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  return { publicKey, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKeyFingerprint: rsaPublicKeyFingerprint(publicKey) };
}

function signProof(identity, userId, deviceId, scopes) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const message = deviceGrantProofMessage({ userId, deviceId, scopes, timestamp, nonce });
  return { timestamp, nonce, publicKeyFingerprint: identity.publicKeyFingerprint,
    signature: crypto.sign('sha256', Buffer.from(message), identity.privateKey).toString('base64') };
}

function authorize(pool, token, scope) {
  return new Promise((resolve, reject) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const middleware = routeWithDeviceGrant(pool, apiError, scope, async (authorizedRequest) => resolve(authorizedRequest.deviceGrant));
    middleware(req, {}, reject);
  });
}

async function insertUsers(pool, ids) {
  for (const id of ids) await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash)
    VALUES($1,$2,$3,$1,'test-hash')`, [id, `${id}@example.test`, id]);
}
