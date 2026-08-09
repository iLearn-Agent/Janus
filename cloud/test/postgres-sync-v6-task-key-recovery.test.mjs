import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createTaskKeyRecoveryService } from '../src/modules/sync/taskKeyRecovery.mjs';
import {
  LocalTaskMemoryKeyring,
  decryptTaskMemoryContent,
  encryptTaskMemoryContent,
  wrapTaskKeyForCloud,
} from '../../src/shared/taskMemoryCrypto.js';

test('Sync V6 rewraps a cloud task DEK only to an approved device and the device restores its local envelope', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-key-recovery-'));
  t.after(async () => { await pool.end(); await fs.rm(root, { recursive: true, force: true }); });
  await migrate(pool);
  await pool.query("INSERT INTO users(id,email,display_name,username,password_hash) VALUES('user_a','user_a@example.test','User A','user_a','test-hash')");
  await pool.query("INSERT INTO cloud_agent_families_v3(id,department_id,name,role,payload_json) VALUES('family','general','Family','agent','{}'::jsonb)");
  await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json) VALUES('base','family','{}'::jsonb)");
  await pool.query(`INSERT INTO cloud_user_agent_instances_v3(
    user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,cluster_contribution_consent
  ) VALUES('user_a','instance','family','base','active',true,true,true)`);
  await pool.query(`INSERT INTO cloud_memory_documents_v3(user_id,id,user_agent_instance_id,scope,slot_no,task_run_id,sync_enabled,payload_json)
    VALUES('user_a','task_memory','instance','task',0,'task_1',true,'{}'::jsonb)`);

  const cloudPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cloudKeyId = 'cloud_key_1';
  const publicKeyring = { activeKeyId: cloudKeyId, keys: { [cloudKeyId]: cloudPair.publicKey.export({ type: 'spki', format: 'pem' }) } };
  const env = {
    JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID: cloudKeyId,
    JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON: JSON.stringify({
      [cloudKeyId]: cloudPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  };
  const deviceKeyring = new LocalTaskMemoryKeyring({ root });
  const identity = deviceKeyring.recoveryIdentity();
  await pool.query(`INSERT INTO cloud_devices_v6 (
    user_id,device_id,status,public_key_pem,public_key_fingerprint,approved_at
  ) VALUES('user_a','device_new','approved',$1,$2,now())`, [identity.publicKey, identity.publicKeyFingerprint]);

  const dataKey = crypto.randomBytes(32);
  const cloudEnvelope = wrapTaskKeyForCloud(dataKey, publicKeyring);
  await pool.query(`INSERT INTO cloud_task_security_contexts_v5 (
    user_id,task_run_id,owner_user_id,local_key_id,cloud_key_id,key_version,cloud_sync_recovery_allowed,
    cloud_envelope_state,status,payload_json
  ) VALUES('user_a','task_1','user_a','local_key','cloud_key',1,true,'active','active',$1::jsonb)`, [JSON.stringify({
    cloud_wrap_algorithm: cloudEnvelope.algorithm,
    cloud_wrapping_key_id: cloudEnvelope.keyId,
    cloud_wrapped_key: cloudEnvelope.wrappedKey,
  })]);

  const service = createTaskKeyRecoveryService({ pool, apiError, env });
  const grant = { userId: 'user_a', deviceId: 'device_new', scopes: ['sync:keys'] };
  const recovered = await service.rewrap(grant, { taskRunId: 'task_1', keyVersion: 1 });
  assert.equal(recovered.deviceId, 'device_new');
  assert.equal(recovered.publicKeyFingerprint, identity.publicKeyFingerprint);
  assert.notEqual(recovered.wrappedKey, cloudEnvelope.wrappedKey);

  const localEnvelope = deviceKeyring.rewrapRecoveredTaskKey(recovered, { taskRunId: 'task_1', keyVersion: 1 });
  const restoredKey = deviceKeyring.unwrapTaskKey(localEnvelope, { taskRunId: 'task_1', keyVersion: 1 });
  assert.deepEqual(restoredKey, dataKey);
  const encrypted = encryptTaskMemoryContent('cross-device private Memory', dataKey, {
    documentId: 'memory_task_1', versionNo: 1, keyVersion: 1,
  });
  assert.equal(decryptTaskMemoryContent(encrypted, restoredKey), 'cross-device private Memory');

  const again = await service.rewrap(grant, { taskRunId: 'task_1', keyVersion: 1 });
  assert.equal(again.wrappedKey, recovered.wrappedKey);
  await assert.rejects(service.rewrap(grant, { taskRunId: 'task_1', targetDeviceId: 'other_device' }),
    (error) => error.code === 'task_key_target_forbidden');
  await pool.query("UPDATE cloud_devices_v6 SET status='revoked' WHERE user_id='user_a' AND device_id='device_new'");
  await assert.rejects(service.rewrap(grant, { taskRunId: 'task_1' }),
    (error) => error.code === 'device_public_key_required');
  assert.ok(Number((await pool.query("SELECT COUNT(*)::int AS count FROM cloud_task_key_access_audits_v6 WHERE user_id='user_a'")).rows[0].count) >= 4);
});

function apiError(code, message, status) { const error = new Error(message); error.code = code; error.status = status; return error; }
