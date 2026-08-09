const MAX_FILE_BYTES = 60 * 1024 * 1024;

export function createFileObjectService({ pool, objectStore, apiError, env = process.env }) {
  const quotaBytes = positiveInteger(env.JANUS_SYNC_V6_STORAGE_QUOTA_BYTES, 5 * 1024 * 1024 * 1024);
  return {
    capabilities() {
      return { available: Boolean(objectStore?.available), maximumBytes: MAX_FILE_BYTES, quotaBytes, checksum: 'sha256', deduplication: 'per_user' };
    },
    async initiate(grant, input = {}) {
      requireStore(objectStore, apiError);
      await cleanupUnreferencedObjects(pool, objectStore).catch(() => null);
      const sha256 = validSha(input.sha256, apiError);
      const sizeBytes = Number(input.sizeBytes ?? input.size_bytes ?? 0);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_FILE_BYTES) {
        throw apiError('file_size_invalid', `Cloud Sync files must be between 0 and ${MAX_FILE_BYTES} bytes.`, 413);
      }
      const contentType = String(input.contentType || input.content_type || 'application/octet-stream').slice(0, 255);
      const objectKey = objectKeyForUser(grant.userId, sha256);
      return inTransaction(pool, async (client) => {
        await client.query(`INSERT INTO cloud_sync_usage_v7(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`, [grant.userId]);
        await client.query(`SELECT user_id FROM cloud_sync_usage_v7 WHERE user_id=$1 FOR UPDATE`, [grant.userId]);
        const existing = (await client.query(`SELECT * FROM cloud_file_objects_v6 WHERE user_id=$1 AND sha256=$2`, [grant.userId, sha256])).rows[0];
        if (existing?.storage_status === 'verified' && Number(existing.size_bytes) === sizeBytes) {
          return { status: 'already_uploaded', sha256, sizeBytes, objectKey, upload: null };
        }
        const storage = (await client.query(`SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM cloud_file_objects_v6
          WHERE user_id=$1 AND storage_status IN ('pending','uploaded','verified')`, [grant.userId])).rows[0];
        const replacedBytes = existing && ['pending', 'uploaded', 'verified'].includes(existing.storage_status) ? Number(existing.size_bytes || 0) : 0;
        const projectedBytes = Number(storage?.bytes || 0) - replacedBytes + sizeBytes;
        if (projectedBytes > quotaBytes) {
          const error = apiError('file_storage_quota_exceeded', 'Cloud Sync storage quota would be exceeded.', 413);
          error.quotaBytes = quotaBytes;
          error.usedBytes = Number(storage?.bytes || 0);
          throw error;
        }
        const upload = await objectStore.initiateUpload({ objectKey, sha256, sizeBytes, contentType });
        const referenceCount = await countReferences(client, grant.userId, sha256);
        await client.query(`INSERT INTO cloud_file_objects_v6 (
          user_id,sha256,object_key,size_bytes,content_type,storage_status,reference_count,checksum_verified,
          upload_expires_at,unreferenced_at,metadata_json,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,'pending',$6,false,$7,$8,$9::jsonb,now(),now())
        ON CONFLICT(user_id,sha256) DO UPDATE SET object_key=excluded.object_key,size_bytes=excluded.size_bytes,
          content_type=excluded.content_type,storage_status='pending',reference_count=excluded.reference_count,
          checksum_verified=false,upload_expires_at=excluded.upload_expires_at,
          unreferenced_at=excluded.unreferenced_at,metadata_json=excluded.metadata_json,updated_at=now()`, [
          grant.userId, sha256, objectKey, sizeBytes, contentType, referenceCount, upload.expiresAt,
          referenceCount ? null : new Date(), JSON.stringify({ initiatedByDeviceId: grant.deviceId }),
        ]);
        await refreshStorageUsage(client, grant.userId);
        return { status: 'upload_required', sha256, sizeBytes, objectKey, upload };
      });
    },
    async complete(grant, input = {}) {
      requireStore(objectStore, apiError);
      const sha256 = validSha(input.sha256, apiError);
      const row = (await pool.query(`SELECT * FROM cloud_file_objects_v6 WHERE user_id=$1 AND sha256=$2`, [grant.userId, sha256])).rows[0];
      if (!row) throw apiError('file_upload_not_initiated', 'File upload was not initiated.', 404);
      const head = await objectStore.headObject({ objectKey: row.object_key });
      if (!head) throw apiError('file_object_not_found', 'Uploaded object was not found.', 409);
      const expectedChecksum = Buffer.from(sha256, 'hex').toString('base64');
      if (Number(head.sizeBytes) !== Number(row.size_bytes)) throw apiError('file_size_mismatch', 'Uploaded file size does not match the manifest.', 409);
      if (String(head.checksumSha256 || '') !== expectedChecksum) throw apiError('file_checksum_mismatch', 'Uploaded file SHA-256 checksum was not verified.', 409);
      const completed = (await pool.query(`UPDATE cloud_file_objects_v6 SET storage_status='verified',checksum_verified=true,
        upload_expires_at=NULL,updated_at=now(),metadata_json=$1::jsonb WHERE user_id=$2 AND sha256=$3 RETURNING *`, [
        JSON.stringify({ ...(row.metadata_json || {}), completedByDeviceId: grant.deviceId, etag: head.etag || '' }), grant.userId, sha256,
      ])).rows[0];
      await refreshStorageUsage(pool, grant.userId);
      return objectPayload(completed);
    },
    async download(grant, shaValue) {
      requireStore(objectStore, apiError);
      const sha256 = validSha(shaValue, apiError);
      const row = (await pool.query(`SELECT * FROM cloud_file_objects_v6
        WHERE user_id=$1 AND sha256=$2 AND storage_status='verified'`, [grant.userId, sha256])).rows[0];
      if (!row) throw apiError('file_object_not_found', 'File object was not found.', 404);
      return { ...objectPayload(row), download: await objectStore.downloadUrl({ objectKey: row.object_key }) };
    },
  };
}

export function objectKeyForUser(userId, sha256) {
  return `users/${encodeURIComponent(String(userId))}/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

async function countReferences(pool, userId, sha256) {
  const rows = (await pool.query('SELECT payload_json FROM cloud_file_refs_v6 WHERE user_id=$1', [userId])).rows;
  return rows.filter((row) => String(row.payload_json?.sha256 || '') === sha256).length;
}
async function refreshStorageUsage(client, userId) {
  const row = (await client.query(`SELECT
    COALESCE(SUM(CASE WHEN storage_status='verified' THEN size_bytes ELSE 0 END),0) AS verified_bytes,
    COALESCE(SUM(CASE WHEN storage_status IN ('pending','uploaded') THEN size_bytes ELSE 0 END),0) AS pending_bytes
    FROM cloud_file_objects_v6 WHERE user_id=$1`, [userId])).rows[0] || {};
  await client.query(`INSERT INTO cloud_sync_usage_v7(user_id,verified_storage_bytes,pending_storage_bytes,updated_at)
    VALUES($1,$2,$3,now()) ON CONFLICT(user_id) DO UPDATE SET
    verified_storage_bytes=excluded.verified_storage_bytes,pending_storage_bytes=excluded.pending_storage_bytes,updated_at=now()`, [
    userId, Number(row.verified_bytes || 0), Number(row.pending_bytes || 0),
  ]);
}
async function cleanupUnreferencedObjects(pool, objectStore, { limit = 10 } = {}) {
  if (typeof objectStore?.deleteObject !== 'function') return { deleted: 0 };
  const cutoff = new Date(Date.now() - 7 * 86400000);
  const rows = (await pool.query(`SELECT * FROM cloud_file_objects_v6
    WHERE reference_count=0 AND (
      (storage_status IN ('verified','failed') AND unreferenced_at IS NOT NULL AND unreferenced_at<$1)
      OR (storage_status IN ('pending','uploaded') AND upload_expires_at IS NOT NULL AND upload_expires_at<now())
    ) ORDER BY COALESCE(unreferenced_at,upload_expires_at) LIMIT $2`, [cutoff, limit])).rows;
  let deleted = 0;
  for (const row of rows) {
    await objectStore.deleteObject({ objectKey: row.object_key });
    await pool.query(`UPDATE cloud_file_objects_v6 SET storage_status='deleted',updated_at=now()
      WHERE user_id=$1 AND sha256=$2 AND reference_count=0`, [row.user_id, row.sha256]);
    deleted += 1;
  }
  return { deleted };
}
function objectPayload(row = {}) { return { status: row.storage_status, sha256: row.sha256, sizeBytes: Number(row.size_bytes || 0),
  contentType: row.content_type, objectKey: row.object_key, checksumVerified: Boolean(row.checksum_verified),
  referenceCount: Number(row.reference_count || 0), createdAt: row.created_at, updatedAt: row.updated_at }; }
function validSha(value, apiError) { const sha = String(value || '').trim().toLowerCase(); if (!/^[a-f0-9]{64}$/.test(sha)) throw apiError('file_sha256_invalid', 'A lowercase SHA-256 hex digest is required.', 400); return sha; }
function requireStore(store, apiError) { if (!store?.available) throw apiError('object_store_unavailable', 'S3-compatible object storage is not configured.', 503); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
async function inTransaction(pool, callback) { const client = await pool.connect(); try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
