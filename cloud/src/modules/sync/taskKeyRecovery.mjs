import crypto from 'node:crypto';

import {
  cloudTaskMemoryPrivateKeyringFromEnv,
  unwrapTaskKeyFromCloud,
  wrapTaskKeyForDevice,
} from '../../../../src/shared/taskMemoryCrypto.js';

export function createTaskKeyRecoveryService({ pool, apiError, env = process.env }) {
  return {
    async rewrap(grant, input = {}) {
      const taskRunId = String(input.taskRunId || input.task_run_id || '').trim();
      const targetDeviceId = String(input.targetDeviceId || input.target_device_id || grant.deviceId).trim();
      const keyVersion = Math.max(1, Number(input.keyVersion || input.key_version || 1));
      if (!taskRunId) throw apiError('task_run_id_required', 'Task identity is required for key recovery.', 400);
      if (targetDeviceId !== grant.deviceId) {
        await audit(pool, grant, taskRunId, keyVersion, 'denied', 'target_device_mismatch');
        throw apiError('task_key_target_forbidden', 'A device may request a recovery envelope only for itself.', 403);
      }
      try {
        const device = (await pool.query(`SELECT * FROM cloud_devices_v6
          WHERE user_id=$1 AND device_id=$2 AND status='approved'`, [grant.userId, targetDeviceId])).rows[0];
        if (!device?.public_key_pem || !device.public_key_fingerprint) {
          throw apiError('device_public_key_required', 'Approved device has not registered a recovery public key.', 409);
        }
        const security = (await pool.query(`SELECT * FROM cloud_task_security_contexts_v5
          WHERE user_id=$1 AND task_run_id=$2 AND status='active'`, [grant.userId, taskRunId])).rows[0];
        if (!security) throw apiError('task_security_context_not_found', 'Task security context was not found.', 404);
        const synchronizedOwner = (await pool.query(`SELECT d.id FROM cloud_memory_documents_v3 d
          JOIN cloud_user_agent_instances_v3 i ON i.user_id=d.user_id AND i.id=d.user_agent_instance_id
          WHERE d.user_id=$1 AND d.task_run_id=$2 AND d.sync_enabled=true AND i.sync_enabled=true AND i.status='active'
          LIMIT 1`, [grant.userId, taskRunId])).rows[0];
        if (!synchronizedOwner) throw apiError('task_sync_disabled', 'Task Memory recovery is suspended because its Agent is not actively synchronized.', 403);
        if (!security.cloud_sync_recovery_allowed) throw apiError('task_key_recovery_not_allowed', 'Cloud Sync key recovery is disabled for this task.', 403);
        if (Number(security.key_version || 1) !== keyVersion) throw apiError('task_key_version_mismatch', 'Task key version is not available.', 409);
        const payload = security.payload_json && typeof security.payload_json === 'object' ? security.payload_json : {};
        const source = {
          algorithm: payload.cloud_wrap_algorithm || payload.cloudWrapAlgorithm || '',
          keyId: payload.cloud_wrapping_key_id || payload.cloudWrappingKeyId || '',
          wrappedKey: payload.cloud_wrapped_key || payload.cloudWrappedKey || '',
        };
        if (!source.algorithm || !source.keyId || !source.wrappedKey || security.cloud_envelope_state !== 'active') {
          throw apiError('cloud_task_key_envelope_unavailable', 'Cloud task key envelope is unavailable.', 409);
        }
        const existing = (await pool.query(`SELECT * FROM cloud_task_key_device_envelopes_v6
          WHERE user_id=$1 AND task_run_id=$2 AND key_version=$3 AND device_id=$4 AND status='active'
            AND public_key_fingerprint=$5 AND source_cloud_key_id=$6`, [
          grant.userId, taskRunId, keyVersion, targetDeviceId, device.public_key_fingerprint, source.keyId,
        ])).rows[0];
        if (existing) {
          await audit(pool, grant, taskRunId, keyVersion, 'success', 'existing_envelope');
          return envelopePayload(existing);
        }
        const dataKey = unwrapTaskKeyFromCloud(source, cloudTaskMemoryPrivateKeyringFromEnv(env));
        const envelope = wrapTaskKeyForDevice(dataKey, {
          publicKey: device.public_key_pem,
          publicKeyFingerprint: device.public_key_fingerprint,
        });
        const row = (await pool.query(`INSERT INTO cloud_task_key_device_envelopes_v6 (
          user_id,task_run_id,key_version,device_id,wrapping_algorithm,public_key_fingerprint,wrapped_key,
          source_cloud_key_id,status,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',now(),now())
        ON CONFLICT(user_id,task_run_id,key_version,device_id) DO UPDATE SET
          wrapping_algorithm=excluded.wrapping_algorithm,public_key_fingerprint=excluded.public_key_fingerprint,
          wrapped_key=excluded.wrapped_key,source_cloud_key_id=excluded.source_cloud_key_id,status='active',updated_at=now()
        RETURNING *`, [
          grant.userId, taskRunId, keyVersion, targetDeviceId, envelope.algorithm,
          envelope.publicKeyFingerprint, envelope.wrappedKey, source.keyId,
        ])).rows[0];
        await audit(pool, grant, taskRunId, keyVersion, 'success', 'rewrapped');
        return envelopePayload(row);
      } catch (error) {
        await audit(pool, grant, taskRunId, keyVersion, 'denied', error.code || 'rewrap_failed').catch(() => null);
        throw error;
      }
    },
  };
}

function envelopePayload(row = {}) {
  return {
    taskRunId: row.task_run_id, keyVersion: Number(row.key_version || 1), deviceId: row.device_id,
    algorithm: row.wrapping_algorithm, publicKeyFingerprint: row.public_key_fingerprint,
    wrappedKey: row.wrapped_key, sourceCloudKeyId: row.source_cloud_key_id,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function audit(pool, grant, taskRunId, keyVersion, outcome, reasonCode) {
  await pool.query(`INSERT INTO cloud_task_key_access_audits_v6 (
    id,user_id,task_run_id,key_version,requesting_device_id,action,outcome,reason_code,created_at
  ) VALUES($1,$2,$3,$4,$5,'rewrap',$6,$7,now())`, [
    `keyaudit_${crypto.randomUUID()}`, grant.userId, taskRunId, keyVersion, grant.deviceId, outcome, reasonCode,
  ]);
}
