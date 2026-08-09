import crypto from 'node:crypto';

import { cloudEmployeeCapability, cloudMultiMemoryCapability, normalizeCloudMemoryVisibility } from '../../../../src/shared/cloudContracts.js';
import { canonicalPptAgentId, isLegacyPptAgentId } from '../../../../src/shared/pptAgents.js';
import { canonicalGeneralAgentId, isLegacyGeneralAgentId } from '../../../../src/shared/generalAgents.js';
import {
  canonicalAgentFamilyName,
  defaultAgentInstanceDisplayName,
  isDefaultAgentInstanceDisplayName,
} from '../../../../src/shared/agentInstanceNaming.js';
import {
  DATABASE_SYNC_CAPABILITIES,
  DATABASE_SYNC_MINIMUM_APP_VERSION,
  DATABASE_SYNC_MINIMUM_MIGRATION_ID,
  DATABASE_SYNC_PROTOCOL_VERSION,
  assessDatabaseClientCompatibility,
} from '../../../../src/shared/databaseEvolutionContract.js';

const MAX_BATCH_CHANGES = 2_000;
const MAX_CHANGE_BYTES = 512 * 1024;
const canonicalEmployeeAgentFamilyId = (value = '') => canonicalGeneralAgentId(canonicalPptAgentId(value));
const IMMUTABLE_TYPES = new Set([
  'agent_version', 'user_agent_skill_version', 'memory_document_version', 'message', 'transcript', 'task_event', 'conversation_alias',
]);
const USER_SCOPED_TYPES = new Set([
  'project', 'conversation', 'conversation_alias', 'message', 'transcript', 'model_execution', 'file_ref', 'file_object',
  'user_agent_instance', 'agent_instance_alias', 'user_agent_skill_version', 'memory_document',
  'memory_document_alias', 'memory_document_version', 'agent_context_space', 'agent_context_state', 'chat_context_state', 'task_security_context', 'personal_evolution_proposal',
  'personal_evolution_memory_operation', 'task_run', 'task_node', 'communication', 'memory_sync_mapping',
  'task_event',
]);
const ACCOUNT_WORKSPACE_SCOPED_TYPES = new Set([
  'project', 'conversation', 'conversation_alias', 'message', 'model_execution', 'task_run',
]);
const V5_COLLECTIONS = Object.freeze({
  projects: 'project', conversations: 'conversation', sessions: 'conversation', conversationAliases: 'conversation_alias', messages: 'message',
  codexTranscripts: 'transcript', modelExecutions: 'model_execution', fileRefs: 'file_ref',
  agentFamilies: 'agent_family', agentVersions: 'agent_version', userAgentInstances: 'user_agent_instance',
  userAgentSkillVersions: 'user_agent_skill_version', userAgentInstanceAliases: 'agent_instance_alias',
  memoryDocuments: 'memory_document', memoryDocumentVersions: 'memory_document_version',
  memoryDocumentAliases: 'memory_document_alias', agentContextSpaces: 'agent_context_space', agentContextStates: 'agent_context_state',
  chatContextStates: 'chat_context_state',
  memorySyncMappings: 'memory_sync_mapping', taskSecurityContexts: 'task_security_context',
  personalEvolutionProposals: 'personal_evolution_proposal',
  personalEvolutionMemoryOperations: 'personal_evolution_memory_operation', taskRuns: 'task_run',
  taskNodes: 'task_node', taskEvents: 'task_event', communications: 'communication',
});

export function createSyncV6Service({ pool, apiError, env = process.env }) {
  const compactionThreshold = positiveInteger(env.JANUS_SYNC_V6_COMPACTION_CHANGE_THRESHOLD, 10_000);
  const batchRateLimit = positiveInteger(env.JANUS_SYNC_V6_BATCH_RATE_LIMIT, 120);
  const rateLimitWindowMs = positiveInteger(env.JANUS_SYNC_V6_RATE_LIMIT_WINDOW_MS, 60_000);
  const requireClientContract = !['0', 'false', 'no', 'off'].includes(String(env.JANUS_SYNC_REQUIRE_CLIENT_CONTRACT || '1').trim().toLowerCase());
  const compatibility = (clientContract = {}) => {
    return assessDatabaseClientCompatibility(clientContract, {
      requireContract: requireClientContract,
      minimumProtocolVersion: DATABASE_SYNC_PROTOCOL_VERSION,
      maximumProtocolVersion: DATABASE_SYNC_PROTOCOL_VERSION,
      minimumAppVersion: DATABASE_SYNC_MINIMUM_APP_VERSION,
      minimumMigrationId: DATABASE_SYNC_MINIMUM_MIGRATION_ID,
      requiredCapabilities: DATABASE_SYNC_CAPABILITIES,
    });
  };
  const requireCompatibility = (clientContract = {}) => {
    const result = compatibility(clientContract);
    if (!result.compatible) {
      throw apiError(result.reasons.includes('client_contract_missing') ? 'sync_client_contract_required' : 'sync_client_incompatible',
        `Desktop database contract is incompatible: ${result.reasons.join(', ')}`, 409);
    }
    return result;
  };
  return {
    capabilities(clientContract = {}) {
      return {
        schemaVersion: 8, authority: 'cloud', deviceGrantRequired: true, cursorKind: 'account_sequence',
        accountScoped: true,
        supportedAccountKinds: ['personal'], organizationCoreSync: false,
        maximumBatchChanges: MAX_BATCH_CHANGES, maximumChangeBytes: MAX_CHANGE_BYTES,
        conflictPolicy: 'preserve_and_report', fileStorage: 's3_compatible', taskKeyRecovery: 'cloud_rewrap',
        databaseContractRequired: requireClientContract,
        databaseCompatibility: compatibility(clientContract),
        multiMemory: cloudMultiMemoryCapability(true),
        employees: cloudEmployeeCapability(true),
        entityTypes: [...new Set([...Object.values(V5_COLLECTIONS), 'file_object'])],
      };
    },

    async submitBatch(grant, input = {}) {
      assertBatchDevice(grant, input, apiError);
      const clientCompatibility = requireCompatibility(input.clientContract || {});
      const effectiveClient = compatibleClientContract(clientCompatibility.client);
      const accountId = await requireSyncAccount(pool, grant, input.accountId || input.account_id, apiError);
      const scopedGrant = { ...grant, accountId };
      const legacyCompat = !Array.isArray(input.changes);
      const changes = legacyCompat ? v5BatchToChanges(input) : input.changes;
      if (!Array.isArray(changes) || changes.length > MAX_BATCH_CHANGES) {
        throw apiError('sync_batch_too_large', `A Sync V6 batch may contain at most ${MAX_BATCH_CHANGES} changes.`, 413);
      }
      const batchId = text(input.batch?.id || input.batchId || `syncv6_${crypto.randomUUID()}`, 255);
      const payloadHash = sha256(stableJson({ accountId, deviceId: grant.deviceId, changes }));
      return inTransaction(pool, async (client) => {
        await ensureV8AccountProjection(client, scopedGrant);
        await enforceRateLimit(client, scopedGrant, 'batch_submit', { limit: batchRateLimit, windowMs: rateLimitWindowMs, apiError });
        const duplicate = (await client.query(`SELECT * FROM cloud_sync_batches_v8
          WHERE account_id=$1 AND user_id=$2 AND device_id=$3 AND payload_hash=$4`, [accountId, grant.userId, grant.deviceId, payloadHash])).rows[0];
        if (duplicate) return batchResponse(duplicate, [], true);
        await client.query(`INSERT INTO cloud_sync_batches_v8 (
          id,account_id,user_id,device_id,client_cursor,item_count,payload_hash,status,created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',now())`, [
          batchId, accountId, grant.userId, grant.deviceId, String(input.cursor || input.batch?.cursorFrom || ''), changes.length, payloadHash,
        ]);
        await client.query(`INSERT INTO cloud_sync_batches_v6 (
          id,user_id,device_id,client_cursor,item_count,payload_hash,status,created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'processing',now())`, [
          batchId, grant.userId, grant.deviceId, String(input.cursor || input.batch?.cursorFrom || ''), changes.length, payloadHash,
        ]);
        const accepted = [];
        const conflicts = [];
        const batchContext = {
          conversationRedirects: new Map(), pendingConversationTouches: new Map(),
          clientProtocolVersion: Number(effectiveClient.syncProtocolVersion || 0),
          accountId,
        };
        for (let index = 0; index < changes.length; index += 1) {
          const normalized = normalizeChange(changes[index], { batchId, index, legacyCompat, apiError });
          const result = await applyChange(client, scopedGrant, batchId, normalized, { legacyCompat, apiError, batchContext });
          if (result.conflict) conflicts.push(result.conflict);
          if (result.accepted) accepted.push(result.accepted);
          accepted.push(...(result.generated || []).filter(Boolean));
        }
        for (const [conversationId, updatedAt] of batchContext.pendingConversationTouches) {
          const canonicalTouch = await touchCanonicalConversation(client, scopedGrant, batchId, conversationId, updatedAt);
          if (canonicalTouch) accepted.push(canonicalTouch);
        }
        const cursor = accepted.reduce((max, item) => Math.max(max, Number(item.sequenceId || 0)), 0);
        const row = (await client.query(`UPDATE cloud_sync_batches_v6 SET accepted_cursor=$1,conflict_count=$2,
          status=$3 WHERE id=$4 RETURNING *`, [String(cursor), conflicts.length, conflicts.length ? 'accepted_with_conflicts' : 'accepted', batchId])).rows[0];
        const v8Row = (await client.query(`UPDATE cloud_sync_batches_v8 SET accepted_cursor=$1,conflict_count=$2,
          status=$3 WHERE id=$4 RETURNING *`, [String(cursor), conflicts.length, conflicts.length ? 'accepted_with_conflicts' : 'accepted', batchId])).rows[0];
        await recordSyncUsage(client, grant.userId, { accountId, acceptedCount: accepted.length, conflictCount: conflicts.length, cursor });
        await maybeCompactChanges(client, grant.userId, compactionThreshold);
        await maybeCompactAccountChanges(client, accountId, compactionThreshold);
        return { ...batchResponse(v8Row || row, conflicts, false), accountId, acceptedChanges: accepted };
      });
    },

    async changes(grant, { cursor = '', limit = 200, clientContract = {}, accountId: requestedAccountId = '' } = {}) {
      const clientCompatibility = requireCompatibility(clientContract);
      const effectiveClient = compatibleClientContract(clientCompatibility.client);
      const accountId = await requireSyncAccount(pool, grant, requestedAccountId, apiError);
      await inTransaction(pool, (client) => ensureV8AccountProjection(client, { ...grant, accountId }));
      const after = parseCursor(cursor, apiError);
      const pageSize = Math.min(500, Math.max(1, Number(limit || 200)));
      const snapshotRow = (await pool.query(`SELECT * FROM cloud_sync_snapshots_v8 WHERE account_id=$1`, [accountId])).rows[0];
      const snapshotCursor = Number(snapshotRow?.snapshot_cursor || 0);
      const resetRequired = Boolean(snapshotRow) && ((!String(cursor || '').trim() && after === 0) || snapshotCursor > after);
      const changeCursor = resetRequired ? snapshotCursor : after;
      const { rows } = await pool.query(`SELECT * FROM cloud_sync_changes_v8
        WHERE account_id=$1 AND sequence_id>$2 ORDER BY sequence_id LIMIT $3`, [accountId, changeCursor, pageSize + 1]);
      const snapshotEntities = resetRequired && Array.isArray(snapshotRow?.entities_json) ? snapshotRow.entities_json : [];
      const incompatible = [...snapshotEntities, ...rows].find((row) => !changeSupportedByClient(row, effectiveClient));
      if (incompatible) {
        throw apiError('sync_client_incompatible', `Desktop database contract cannot apply ${incompatible.entityType || incompatible.entity_type}.`, 409);
      }
      const page = rows.slice(0, pageSize);
      const nextCursor = Number(page.at(-1)?.sequence_id || changeCursor);
      await pool.query(`INSERT INTO cloud_sync_device_cursors_v8(account_id,user_id,device_id,last_cursor,last_seen_at,reset_count)
        VALUES($1,$2,$3,$4,now(),$5) ON CONFLICT(account_id,user_id,device_id) DO UPDATE SET
        last_cursor=GREATEST(cloud_sync_device_cursors_v8.last_cursor,excluded.last_cursor),last_seen_at=now(),
        reset_count=cloud_sync_device_cursors_v8.reset_count+excluded.reset_count`, [
        accountId, grant.userId, grant.deviceId, nextCursor, resetRequired ? 1 : 0,
      ]);
      return {
        schemaVersion: 8, accountId, cursor: String(nextCursor), hasMore: rows.length > pageSize, resetRequired,
        snapshot: resetRequired ? { cursor: String(snapshotCursor), entities: snapshotEntities } : null,
        changes: page.map(changePayload),
      };
    },

    async metrics(grant, { accountId: requestedAccountId = '' } = {}) {
      const accountId = await requireSyncAccount(pool, grant, requestedAccountId, apiError);
      const [usageResult, storageResult, deviceResult, snapshotResult, logResult] = await Promise.all([
        pool.query(`SELECT * FROM cloud_sync_usage_v8 WHERE account_id=$1`, [accountId]),
        pool.query(`SELECT
          COALESCE(SUM(CASE WHEN storage_status='verified' THEN size_bytes ELSE 0 END),0) AS verified_bytes,
          COALESCE(SUM(CASE WHEN storage_status IN ('pending','uploaded') THEN size_bytes ELSE 0 END),0) AS pending_bytes
          FROM cloud_file_objects_v6 WHERE user_id=$1`, [grant.userId]),
        pool.query(`SELECT COUNT(*) AS count FROM cloud_devices_v6 WHERE user_id=$1 AND status!='revoked'`, [grant.userId]),
        pool.query(`SELECT snapshot_cursor,entity_count,updated_at FROM cloud_sync_snapshots_v8 WHERE account_id=$1`, [accountId]),
        pool.query(`SELECT COUNT(*) AS count,COALESCE(MAX(sequence_id),0) AS cursor FROM cloud_sync_changes_v8 WHERE account_id=$1`, [accountId]),
      ]);
      const usage = usageResult.rows[0] || {};
      const storage = storageResult.rows[0] || {};
      const snapshot = snapshotResult.rows[0] || {};
      const log = logResult.rows[0] || {};
      return {
        schemaVersion: 8,
        accountId,
        changeCount: Number(usage.change_count || 0),
        conflictCount: Number(usage.conflict_count || 0),
        latestCursor: String(Math.max(Number(usage.last_change_cursor || 0), Number(log.cursor || 0), Number(snapshot.snapshot_cursor || 0))),
        retainedChangeCount: Number(log.count || 0),
        snapshot: { cursor: String(snapshot.snapshot_cursor || 0), entityCount: Number(snapshot.entity_count || 0), updatedAt: snapshot.updated_at || null },
        storage: { verifiedBytes: Number(storage.verified_bytes || 0), pendingBytes: Number(storage.pending_bytes || 0) },
        activeDeviceCount: Number(deviceResult.rows[0]?.count || 0),
      };
    },
  };
}

async function requireSyncAccount(db, grant, requestedAccountId, apiError) {
  const accountId = text(requestedAccountId || `account_personal_${grant.userId}`, 255);
  if (accountId === `account_personal_${grant.userId}`) {
    await ensurePersonalSyncAccount(db, grant.userId);
  }
  const membership = (await db.query(`SELECT account.account_kind,membership.role,membership.status
    FROM accounts account JOIN account_memberships_v8 membership ON membership.account_id=account.id
    WHERE account.id=$1 AND membership.user_id=$2 AND membership.status='active'`, [accountId, grant.userId])).rows[0];
  if (!membership) throw apiError('sync_account_access_denied', 'The authenticated user is not an active member of this Sync account.', 403);
  if (membership.account_kind !== 'personal') {
    throw apiError('sync_account_kind_unsupported', 'Organization core Sync is not enabled until account-scoped materialized storage is available.', 409);
  }
  return accountId;
}

async function ensurePersonalSyncAccount(db, userId) {
  const accountId = `account_personal_${userId}`;
  await db.query(`INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
    SELECT $1,'personal',id,'',COALESCE(display_name,'个人账号'),'active',created_at,updated_at FROM users WHERE id=$2
    ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at`, [accountId, userId]);
  await db.query(`INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
    SELECT $1,id,'owner','active',created_at,updated_at FROM users WHERE id=$2
    ON CONFLICT(account_id,user_id) DO UPDATE SET role='owner',status='active',updated_at=excluded.updated_at`, [accountId, userId]);
  await db.query(`INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
    SELECT $1,'workspace_personal',id,'personal',created_at,updated_at FROM users WHERE id=$2
    ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='personal',updated_at=excluded.updated_at`, [accountId, userId]);
}

async function ensureV8AccountProjection(client, grant) {
  await client.query(`INSERT INTO cloud_sync_entities_v8(
      account_id,entity_type,entity_id,revision,deleted,content_hash,payload_json,origin_user_id,origin_device_id,occurred_at,updated_at
    ) SELECT $1,entity_type,entity_id,revision,deleted,content_hash,payload_json,$2,origin_device_id,occurred_at,updated_at
    FROM cloud_sync_entities_v6 WHERE user_id=$2
    ON CONFLICT(account_id,entity_type,entity_id) DO NOTHING`, [grant.accountId, grant.userId]);
  const existingSnapshot = (await client.query('SELECT 1 FROM cloud_sync_snapshots_v8 WHERE account_id=$1', [grant.accountId])).rows[0];
  if (existingSnapshot) return;
  const entities = (await client.query(`SELECT * FROM cloud_sync_entities_v8
    WHERE account_id=$1 ORDER BY entity_type,entity_id`, [grant.accountId])).rows.map((row) => snapshotChangePayload(row, 0));
  await client.query(`INSERT INTO cloud_sync_snapshots_v8(account_id,snapshot_cursor,entity_count,entities_json,created_at,updated_at)
    VALUES($1,0,$2,$3::jsonb,now(),now()) ON CONFLICT(account_id) DO NOTHING`, [
    grant.accountId, entities.length, JSON.stringify(entities),
  ]);
}

async function enforceRateLimit(client, grant, operation, { limit, windowMs, apiError }) {
  await client.query(`INSERT INTO cloud_sync_rate_limits_v7(user_id,device_id,operation,window_started_at,request_count,updated_at)
    VALUES($1,$2,$3,now(),0,now()) ON CONFLICT(user_id,device_id,operation) DO NOTHING`, [grant.userId, grant.deviceId, operation]);
  const row = (await client.query(`SELECT * FROM cloud_sync_rate_limits_v7
    WHERE user_id=$1 AND device_id=$2 AND operation=$3 FOR UPDATE`, [grant.userId, grant.deviceId, operation])).rows[0];
  const elapsed = Date.now() - Date.parse(row.window_started_at);
  if (!Number.isFinite(elapsed) || elapsed >= windowMs) {
    await client.query(`UPDATE cloud_sync_rate_limits_v7 SET window_started_at=now(),request_count=1,updated_at=now()
      WHERE user_id=$1 AND device_id=$2 AND operation=$3`, [grant.userId, grant.deviceId, operation]);
    return;
  }
  if (Number(row.request_count || 0) >= limit) {
    const error = apiError('sync_rate_limit_exceeded', 'Cloud Sync request rate limit exceeded.', 429);
    error.retryAfterMs = Math.max(1, windowMs - elapsed);
    throw error;
  }
  await client.query(`UPDATE cloud_sync_rate_limits_v7 SET request_count=request_count+1,updated_at=now()
    WHERE user_id=$1 AND device_id=$2 AND operation=$3`, [grant.userId, grant.deviceId, operation]);
}

async function recordSyncUsage(client, userId, { accountId = '', acceptedCount = 0, conflictCount = 0, cursor = 0 } = {}) {
  await client.query(`INSERT INTO cloud_sync_usage_v7(user_id,last_change_cursor,change_count,conflict_count,updated_at)
    VALUES($1,$2,$3,$4,now()) ON CONFLICT(user_id) DO UPDATE SET
    last_change_cursor=GREATEST(cloud_sync_usage_v7.last_change_cursor,excluded.last_change_cursor),
    change_count=cloud_sync_usage_v7.change_count+excluded.change_count,
    conflict_count=cloud_sync_usage_v7.conflict_count+excluded.conflict_count,updated_at=now()`, [
    userId, Number(cursor || 0), Number(acceptedCount || 0), Number(conflictCount || 0),
  ]);
  if (accountId) await client.query(`INSERT INTO cloud_sync_usage_v8(account_id,last_change_cursor,change_count,conflict_count,updated_at)
    VALUES($1,$2,$3,$4,now()) ON CONFLICT(account_id) DO UPDATE SET
    last_change_cursor=GREATEST(cloud_sync_usage_v8.last_change_cursor,excluded.last_change_cursor),
    change_count=cloud_sync_usage_v8.change_count+excluded.change_count,
    conflict_count=cloud_sync_usage_v8.conflict_count+excluded.conflict_count,updated_at=now()`, [
    accountId, Number(cursor || 0), Number(acceptedCount || 0), Number(conflictCount || 0),
  ]);
}

async function maybeCompactAccountChanges(client, accountId, threshold) {
  await client.query(`INSERT INTO cloud_sync_compaction_states_v8(account_id) VALUES($1)
    ON CONFLICT(account_id) DO NOTHING`, [accountId]);
  const state = (await client.query(`SELECT * FROM cloud_sync_compaction_states_v8 WHERE account_id=$1 FOR UPDATE`, [accountId])).rows[0];
  const compactedThrough = Number(state?.compacted_through || 0);
  const pending = Number((await client.query(`SELECT COUNT(*) AS count FROM cloud_sync_changes_v8
    WHERE account_id=$1 AND sequence_id>$2`, [accountId, compactedThrough])).rows[0]?.count || 0);
  if (pending < threshold) return { compacted: false, pending };
  const cursor = Number((await client.query(`SELECT MAX(sequence_id) AS cursor FROM cloud_sync_changes_v8
    WHERE account_id=$1`, [accountId])).rows[0]?.cursor || compactedThrough);
  const entities = (await client.query(`SELECT * FROM cloud_sync_entities_v8
    WHERE account_id=$1 ORDER BY entity_type,entity_id`, [accountId])).rows.map((row) => snapshotChangePayload(row, cursor));
  await client.query(`INSERT INTO cloud_sync_snapshots_v8(account_id,snapshot_cursor,entity_count,entities_json,created_at,updated_at)
    VALUES($1,$2,$3,$4::jsonb,now(),now()) ON CONFLICT(account_id) DO UPDATE SET
    snapshot_cursor=excluded.snapshot_cursor,entity_count=excluded.entity_count,entities_json=excluded.entities_json,updated_at=now()`, [
    accountId, cursor, entities.length, JSON.stringify(entities),
  ]);
  await client.query(`UPDATE cloud_sync_compaction_states_v8 SET compacted_through=$1,last_snapshot_cursor=$1,
    last_compacted_at=now(),updated_at=now() WHERE account_id=$2`, [cursor, accountId]);
  await client.query(`DELETE FROM cloud_sync_changes_v8 WHERE account_id=$1 AND sequence_id<=$2`, [accountId, cursor]);
  return { compacted: true, cursor, entityCount: entities.length };
}

async function maybeCompactChanges(client, userId, threshold) {
  await client.query(`INSERT INTO cloud_sync_compaction_states_v7(user_id) VALUES($1)
    ON CONFLICT(user_id) DO NOTHING`, [userId]);
  const state = (await client.query(`SELECT * FROM cloud_sync_compaction_states_v7 WHERE user_id=$1 FOR UPDATE`, [userId])).rows[0];
  const compactedThrough = Number(state?.compacted_through || 0);
  const pending = Number((await client.query(`SELECT COUNT(*) AS count FROM cloud_sync_changes_v6
    WHERE user_id=$1 AND sequence_id>$2`, [userId, compactedThrough])).rows[0]?.count || 0);
  if (pending < threshold) return { compacted: false, pending };
  const cursor = Number((await client.query(`SELECT MAX(sequence_id) AS cursor FROM cloud_sync_changes_v6
    WHERE user_id=$1`, [userId])).rows[0]?.cursor || compactedThrough);
  const entities = (await client.query(`SELECT * FROM cloud_sync_entities_v6
    WHERE user_id=$1 ORDER BY entity_type,entity_id`, [userId])).rows.map((row) => snapshotChangePayload(row, cursor));
  await client.query(`INSERT INTO cloud_sync_snapshots_v7(user_id,snapshot_cursor,entity_count,entities_json,created_at,updated_at)
    VALUES($1,$2,$3,$4::jsonb,now(),now()) ON CONFLICT(user_id) DO UPDATE SET
    snapshot_cursor=excluded.snapshot_cursor,entity_count=excluded.entity_count,entities_json=excluded.entities_json,updated_at=now()`, [
    userId, cursor, entities.length, JSON.stringify(entities),
  ]);
  await client.query(`UPDATE cloud_sync_compaction_states_v7 SET compacted_through=$1,last_snapshot_cursor=$1,
    last_compacted_at=now(),updated_at=now() WHERE user_id=$2`, [cursor, userId]);
  await client.query(`DELETE FROM cloud_sync_changes_v6 WHERE user_id=$1 AND sequence_id<=$2`, [userId, cursor]);
  return { compacted: true, cursor, entityCount: entities.length };
}

function snapshotChangePayload(row = {}, cursor = 0) {
  return {
    changeId: `snapshot_${row.entity_type}_${row.entity_id}_${row.revision}`,
    sequenceId: String(cursor),
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.deleted ? 'delete' : 'upsert',
    baseRevision: Math.max(0, Number(row.revision || 1) - 1),
    revision: Number(row.revision || 1),
    contentHash: row.content_hash || '',
    occurredAt: row.occurred_at,
    acceptedAt: row.updated_at,
    minimumProtocolVersion: minimumProtocolForEntity(row.entity_type),
    requiredCapabilities: requiredCapabilitiesForEntity(row.entity_type),
    payload: row.payload_json || {},
  };
}

export function v5BatchToChanges(input = {}) {
  const result = [];
  const batchId = input.batch?.id || 'legacy_batch';
  const data = input.data || {};
  for (const [collection, entityType] of Object.entries(V5_COLLECTIONS)) {
    for (const [index, payload] of (Array.isArray(data[collection]) ? data[collection] : []).entries()) {
      const entityId = entityIdFor(entityType, payload);
      if (!entityId) continue;
      const occurredAt = entityTimestamp(payload, input.batch?.generatedAt);
      result.push({
        changeId: `legacy_${sha256(`${batchId}:${collection}:${entityId}:${stableJson(payload)}`).slice(0, 40)}`,
        entityType, entityId, operation: deletedOperation(entityType, payload), baseRevision: Number(payload.revision || 0),
        occurredAt, payload,
      });
    }
  }
  for (const file of Array.isArray(input.files) ? input.files : []) {
    if (!file?.sha256) continue;
    result.push({
      changeId: `legacy_${sha256(`${batchId}:file:${file.sha256}`).slice(0, 40)}`, entityType: 'file_object',
      entityId: String(file.sha256), operation: 'upsert', baseRevision: 0,
      occurredAt: input.batch?.generatedAt || new Date().toISOString(), payload: file,
    });
  }
  return result;
}

async function applyChange(client, grant, batchId, change, { legacyCompat, apiError, batchContext }) {
  let { entityType, entityId, payload } = change;
  const generated = [];
  let conversationReferenceRedirected = false;
  payload = ownedPayload(entityType, payload, grant.userId);
  if (ACCOUNT_WORKSPACE_SCOPED_TYPES.has(entityType)) {
    const accountWorkspaceId = field(payload, 'account_workspace_id', 'accountWorkspaceId')
      || field(payload, 'workspace_id', 'workspaceId') || 'workspace_personal';
    if (accountWorkspaceId === 'workspace_personal') {
      await client.query(`INSERT INTO account_workspaces(id,workspace_kind,name,status,updated_at)
        VALUES('workspace_personal','personal','个人空间','active',now())
        ON CONFLICT(id) DO UPDATE SET status='active',updated_at=excluded.updated_at`);
      await client.query(`INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,updated_at)
        VALUES('workspace_personal',$1,'owner','active',now())
        ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner',status='active',updated_at=excluded.updated_at`, [grant.userId]);
    }
    const membership = (await client.query(`SELECT 1 FROM account_workspace_memberships
      WHERE workspace_id=$1 AND user_id=$2 AND status='active'`, [accountWorkspaceId, grant.userId])).rows[0];
    if (!membership) throw apiError('account_workspace_forbidden', '工作空间不存在或你已不在该工作空间中。', 403);
    payload = {
      ...payload,
      account_workspace_id: accountWorkspaceId,
      accountWorkspaceId,
      workspace_id: accountWorkspaceId,
      workspaceId: accountWorkspaceId,
    };
  }

  if (entityType === 'conversation_alias') {
    if (Number(batchContext?.clientProtocolVersion || 0) < DATABASE_SYNC_PROTOCOL_VERSION) {
      throw apiError('sync_entity_protocol_required', 'Conversation aliases require Sync protocol 7.', 409);
    }
    if (change.operation === 'delete') throw apiError('conversation_alias_immutable', 'Conversation aliases are immutable.', 409);
    const aliasConversationId = field(payload, 'alias_conversation_id', 'aliasConversationId') || entityId;
    const requestedCanonicalId = field(payload, 'canonical_conversation_id', 'canonicalConversationId')
      || field(payload, 'conversation_id', 'conversationId');
    if (!aliasConversationId || !requestedCanonicalId || aliasConversationId === requestedCanonicalId) {
      throw apiError('conversation_alias_invalid', 'Conversation alias requires distinct alias and canonical conversation ids.', 400);
    }
    await acquireAdvisoryLock(client, ['conversation-alias', grant.userId, aliasConversationId].join('\u001f'));
    const canonicalConversationId = await resolveCloudConversationAliasTarget(client, grant.userId, requestedCanonicalId, {
      forbiddenAliasId: aliasConversationId,
      apiError,
    });
    const canonicalConversation = (await client.query(`SELECT payload_json FROM cloud_conversations_v6
      WHERE user_id=$1 AND id=$2`, [grant.userId, canonicalConversationId])).rows[0];
    if (!canonicalConversation) throw apiError('conversation_alias_target_missing', 'Canonical conversation does not exist.', 409);
    const canonicalWorkspaceId = field(canonicalConversation.payload_json, 'account_workspace_id', 'accountWorkspaceId')
      || field(canonicalConversation.payload_json, 'workspace_id', 'workspaceId') || 'workspace_personal';
    const requestedWorkspaceId = field(payload, 'account_workspace_id', 'accountWorkspaceId') || 'workspace_personal';
    if (canonicalWorkspaceId !== requestedWorkspaceId) {
      throw apiError('conversation_alias_workspace_mismatch', 'Conversation alias cannot cross Workspace boundaries.', 409);
    }
    const canonicalKind = field(canonicalConversation.payload_json, 'conversation_kind', 'conversationKind') || 'direct';
    if (canonicalKind !== 'direct') throw apiError('conversation_alias_kind_invalid', 'Only direct Agent conversations may be aliased.', 409);
    entityId = aliasConversationId;
    payload = {
      ...payload,
      id: aliasConversationId,
      alias_conversation_id: aliasConversationId,
      aliasConversationId,
      canonical_conversation_id: canonicalConversationId,
      canonicalConversationId,
      conversation_id: canonicalConversationId,
      conversationId: canonicalConversationId,
      account_workspace_id: canonicalWorkspaceId,
      accountWorkspaceId: canonicalWorkspaceId,
      workspace_id: canonicalWorkspaceId,
      workspaceId: canonicalWorkspaceId,
      conversation_kind: 'direct',
      conversationKind: 'direct',
    };
  }

  if (entityType === 'user_agent_instance') {
    const rawFamilyId = field(payload, 'agent_family_id', 'agentFamilyId');
    const familyId = canonicalEmployeeAgentFamilyId(rawFamilyId);
    if (!familyId) return conflictResult(await preserveConflict(client, grant, batchId, change, 'agent_family_required', null));
    payload = { ...payload, agent_family_id: familyId, agentFamilyId: familyId };
    let existing = (await client.query(`SELECT * FROM cloud_user_agent_instances_v3
      WHERE user_id=$1 AND id=$2`, [grant.userId, entityId])).rows[0];
    if (!existing && isLegacyPptAgentId(rawFamilyId)) {
      const canonical = (await client.query(`SELECT * FROM cloud_user_agent_instances_v3
        WHERE user_id=$1 AND agent_family_id=$2 ORDER BY created_at,id LIMIT 1`, [grant.userId, familyId])).rows[0];
      if (canonical?.id && canonical.id !== entityId) {
        generated.push(await recordAliasChange(client, grant, batchId, 'agent_instance_alias', entityId, canonical.id));
        entityId = canonical.id;
        payload = { ...payload, id: canonical.id };
        existing = canonical;
      }
    }
    if (!existing && (field(payload, 'instance_kind', 'instanceKind') || 'employee') === 'employee') {
      return conflictResult(await preserveConflict(client, grant, batchId, change, 'employee_bootstrap_required', null));
    }
    if (existing) payload = authoritativeInstancePayload(payload, existing);
  }
  if (entityType === 'agent_instance_alias') {
    payload = { ...payload, alias_instance_id: field(payload, 'alias_instance_id', 'aliasInstanceId') || entityId };
  }
  if (['user_agent_skill_version', 'memory_document'].includes(entityType)) {
    const instanceId = field(payload, 'user_agent_instance_id', 'userAgentInstanceId');
    if (instanceId) payload = setField(payload, 'user_agent_instance_id', await canonicalInstanceId(client, grant.userId, instanceId));
  }
  if (entityType === 'user_agent_skill_version') {
    const instanceId = field(payload, 'user_agent_instance_id', 'userAgentInstanceId');
    const instance = instanceId && (await client.query(
      'SELECT id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [grant.userId, instanceId],
    )).rows[0];
    if (!instance) return conflictResult(await preserveConflict(
      client, grant, batchId, { ...change, entityId, payload }, 'agent_instance_dependency_missing', null,
    ));
  }
  if (entityType === 'memory_document') {
    const instanceId = field(payload, 'user_agent_instance_id', 'userAgentInstanceId');
    const instance = instanceId && (await client.query(
      'SELECT id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [grant.userId, instanceId],
    )).rows[0];
    if (!instance) return conflictResult(await preserveConflict(
      client, grant, batchId, { ...change, entityId, payload }, 'memory_instance_dependency_missing', null,
    ));
    const scope = String(payload.scope || 'general');
    const slotNo = Number(payload.slot_no ?? payload.slotNo ?? 0);
    const taskRunId = field(payload, 'task_run_id', 'taskRunId');
    const projectId = field(payload, 'project_id', 'projectId');
    const relationshipId = field(payload, 'relationship_id', 'relationshipId');
    await acquireAdvisoryLock(client, ['memory',grant.userId,instanceId,scope,slotNo,taskRunId,projectId,relationshipId].join('\u001f'));
    const canonical = (await client.query(`SELECT id FROM cloud_memory_documents_v3
      WHERE user_id=$1 AND user_agent_instance_id=$2 AND scope=$3 AND slot_no=$4
        AND task_run_id=$5 AND project_id=$6 AND relationship_id=$7 ORDER BY created_at,id LIMIT 1`,
    [grant.userId, instanceId, scope, slotNo, taskRunId, projectId, relationshipId])).rows[0]?.id;
    if (canonical && canonical !== entityId) {
      generated.push(await recordAliasChange(client, grant, batchId, 'memory_document_alias', entityId, canonical));
      entityId = canonical;
      payload = { ...payload, id: canonical };
    }
  }
  if (entityType === 'memory_document_alias') {
    payload = { ...payload, alias_document_id: field(payload, 'alias_document_id', 'aliasDocumentId') || entityId };
  }
  if (entityType === 'agent_context_space') {
    const instanceId = await canonicalInstanceId(client, grant.userId, field(payload, 'user_agent_instance_id', 'userAgentInstanceId'));
    const memoryDocumentId = await canonicalDocumentId(client, grant.userId,
      field(payload, 'memory_document_id', 'memoryDocumentId') || await documentIdForCloudKey(client, grant.userId, field(payload, 'memory_cloud_key', 'memoryCloudKey')));
    const instance = instanceId && (await client.query(
      'SELECT id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [grant.userId, instanceId],
    )).rows[0];
    if (!instance) return conflictResult(await preserveConflict(
      client, grant, batchId, { ...change, entityId, payload }, 'context_instance_dependency_missing', null,
    ));
    if (memoryDocumentId) {
      const memory = (await client.query(
        'SELECT id FROM cloud_memory_documents_v3 WHERE user_id=$1 AND id=$2 AND user_agent_instance_id=$3',
        [grant.userId, memoryDocumentId, instanceId],
      )).rows[0];
      if (!memory) return conflictResult(await preserveConflict(
        client, grant, batchId, { ...change, entityId, payload }, 'context_memory_dependency_missing', null,
      ));
    }
    payload = setField(setField(payload, 'user_agent_instance_id', instanceId), 'memory_document_id', memoryDocumentId);
    const identity = contextIdentity(payload);
    await acquireAdvisoryLock(client, [grant.userId,'context',...identity].join('\u001f'));
    const canonical = (await client.query(`SELECT id FROM cloud_agent_context_spaces WHERE user_id=$1 AND user_agent_instance_id=$2
      AND context_kind=$3 AND COALESCE(memory_document_id,'')=$4 AND project_id=$5 AND task_run_id=$6
      AND delegation_id=$7 AND group_id=$8 AND relationship_user_id=$9 LIMIT 1`, [grant.userId,...identity])).rows[0]?.id;
    if (canonical && canonical !== entityId) {
      entityId = canonical;
      payload = { ...payload, id: canonical };
    }
  }
  if (entityType === 'agent_context_state') {
    const instanceId = await canonicalInstanceId(client, grant.userId,
      field(payload, 'user_agent_instance_id', 'userAgentInstanceId') || entityId);
    if (!instanceId) return conflictResult(await preserveConflict(client, grant, batchId, change, 'agent_instance_required', null));
    entityId = instanceId;
    const memoryDocumentId = await canonicalDocumentId(client, grant.userId,
      field(payload, 'active_memory_document_id', 'activeMemoryDocumentId')
        || await documentIdForCloudKey(client, grant.userId, field(payload, 'active_memory_cloud_key', 'activeMemoryCloudKey')));
    let contextSpaceId = field(payload, 'active_context_space_id', 'activeContextSpaceId');
    if (memoryDocumentId) {
      contextSpaceId = (await client.query(`SELECT id FROM cloud_agent_context_spaces
        WHERE user_id=$1 AND user_agent_instance_id=$2 AND context_kind='general_memory' AND memory_document_id=$3
        LIMIT 1`, [grant.userId, instanceId, memoryDocumentId])).rows[0]?.id || contextSpaceId;
    }
    let primaryConversationId = field(payload, 'primary_conversation_id', 'primaryConversationId')
      || field(payload, 'primary_session_id', 'primarySessionId');
    await acquireAdvisoryLock(client, ['agent-context-state', grant.userId, instanceId].join('\u001f'));
    const canonicalPrimaryConversationId = (await client.query(`SELECT id FROM cloud_conversations_v6
      WHERE user_id=$1 AND conversation_role='primary' AND write_state='writable'
        AND COALESCE(payload_json->>'agentInstanceId',payload_json->>'agent_instance_id','')=$2
        AND COALESCE(payload_json->>'status','active')<>'deleted'
      ORDER BY updated_at DESC,id DESC LIMIT 1`, [grant.userId, instanceId])).rows[0]?.id || '';
    if (canonicalPrimaryConversationId) primaryConversationId = canonicalPrimaryConversationId;
    const current = (await client.query(`SELECT * FROM cloud_agent_context_states
      WHERE owner_user_id=$1 AND user_agent_instance_id=$2 FOR UPDATE`, [grant.userId, instanceId])).rows[0];
    const expected = Number(payload.base_state_revision ?? payload.baseStateRevision ?? 0);
    if (current && expected !== Number(current.state_revision || 0)) {
      return conflictResult(await preserveConflict(client, grant, batchId, { ...change, entityId, payload },
        'context_state_revision_mismatch', { revision: current.state_revision, payload_json: current }));
    }
    if (memoryDocumentId) {
      const memory = (await client.query(`SELECT lifecycle_state FROM cloud_memory_documents_v3
        WHERE user_id=$1 AND id=$2 AND user_agent_instance_id=$3 AND scope='general'`,
      [grant.userId, memoryDocumentId, instanceId])).rows[0];
      if (!memory || memory.lifecycle_state === 'archived') {
        return conflictResult(await preserveConflict(client, grant, batchId, { ...change, entityId, payload },
          'context_state_memory_invalid', { revision: current?.state_revision || 0, payload_json: current || {} }));
      }
    }
    if (contextSpaceId) {
      const context = (await client.query(`SELECT id FROM cloud_agent_context_spaces
        WHERE user_id=$1 AND id=$2 AND user_agent_instance_id=$3 AND lifecycle_state<>'archived'`,
      [grant.userId, contextSpaceId, instanceId])).rows[0];
      if (!context) return conflictResult(await preserveConflict(client, grant, batchId, { ...change, entityId, payload },
        'context_state_space_invalid', { revision: current?.state_revision || 0, payload_json: current || {} }));
    }
    if (primaryConversationId) {
      const conversation = (await client.query(`SELECT id FROM cloud_conversations_v6
        WHERE user_id=$1 AND id=$2 AND COALESCE(payload_json->>'agentInstanceId',payload_json->>'agent_instance_id','')=$3`,
      [grant.userId, primaryConversationId, instanceId])).rows[0];
      if (!conversation) return conflictResult(await preserveConflict(client, grant, batchId, { ...change, entityId, payload },
        'context_state_conversation_invalid', { revision: current?.state_revision || 0, payload_json: current || {} }));
    }
    payload = {
      ...payload,
      id: instanceId,
      owner_user_id: grant.userId,
      ownerUserId: grant.userId,
      user_agent_instance_id: instanceId,
      userAgentInstanceId: instanceId,
      primary_conversation_id: primaryConversationId,
      primaryConversationId,
      active_context_space_id: contextSpaceId,
      activeContextSpaceId: contextSpaceId,
      active_memory_document_id: memoryDocumentId,
      activeMemoryDocumentId: memoryDocumentId,
      state_revision: Number(current?.state_revision || 0) + 1,
      stateRevision: Number(current?.state_revision || 0) + 1,
      base_state_revision: Number(current?.state_revision || 0),
      baseStateRevision: Number(current?.state_revision || 0),
      source_device_id: grant.deviceId,
      sourceDeviceId: grant.deviceId,
    };
  }
  if (['message', 'transcript', 'model_execution', 'file_ref'].includes(entityType)) {
    const conversationId = field(payload, 'conversation_id', 'conversationId');
    const canonicalConversationId = batchContext?.conversationRedirects?.get(conversationId) || '';
    if (canonicalConversationId) {
      payload = setField(payload, 'conversation_id', canonicalConversationId);
      conversationReferenceRedirected = true;
      const activityAt = entityTimestamp(payload);
      const currentTouch = batchContext?.pendingConversationTouches?.get(canonicalConversationId) || '';
      if (activityAt && (!currentTouch || activityAt > currentTouch)) {
        batchContext?.pendingConversationTouches?.set(canonicalConversationId, activityAt);
      }
    }
  }
  if (entityType === 'chat_context_state') {
    const requestedSessionId = field(payload, 'session_id', 'sessionId');
    const sessionId = batchContext?.conversationRedirects?.get(requestedSessionId) || requestedSessionId;
    if (sessionId !== requestedSessionId) {
      payload = setField(payload, 'session_id', sessionId);
      conversationReferenceRedirected = true;
    }
    let contextSpaceId = field(payload, 'context_space_id', 'contextSpaceId');
    if (!sessionId) return conflictResult(await preserveConflict(client, grant, batchId, change, 'chat_context_session_required', null));
    const conversation = (await client.query('SELECT id,payload_json FROM cloud_conversations_v6 WHERE user_id=$1 AND id=$2', [grant.userId, sessionId])).rows[0];
    if (!conversation) return conflictResult(await preserveConflict(client, grant, batchId, change, 'chat_context_session_invalid', null));
    if (contextSpaceId) {
      let context = (await client.query(`SELECT id,user_agent_instance_id FROM cloud_agent_context_spaces
        WHERE user_id=$1 AND id=$2 AND lifecycle_state<>'archived'`, [grant.userId, contextSpaceId])).rows[0];
      if (!context && field(payload, 'context_kind', 'contextKind')) {
        const instanceId = await canonicalInstanceId(client, grant.userId,
          field(payload, 'user_agent_instance_id', 'userAgentInstanceId')
            || String(conversation.payload_json?.agentInstanceId || conversation.payload_json?.agent_instance_id || ''));
        const memoryDocumentId = await canonicalDocumentId(client, grant.userId,
          field(payload, 'memory_document_id', 'memoryDocumentId')
            || await documentIdForCloudKey(client, grant.userId, field(payload, 'memory_cloud_key', 'memoryCloudKey')));
        const identity = [instanceId,field(payload,'context_kind','contextKind'),memoryDocumentId,
          field(payload,'project_id','projectId'),field(payload,'task_run_id','taskRunId'),field(payload,'delegation_id','delegationId'),
          field(payload,'group_id','groupId'),field(payload,'relationship_user_id','relationshipUserId')];
        context = (await client.query(`SELECT id,user_agent_instance_id FROM cloud_agent_context_spaces
          WHERE user_id=$1 AND user_agent_instance_id=$2 AND context_kind=$3 AND COALESCE(memory_document_id,'')=$4
            AND project_id=$5 AND task_run_id=$6 AND delegation_id=$7 AND group_id=$8 AND relationship_user_id=$9
            AND lifecycle_state<>'archived' LIMIT 1`, [grant.userId,...identity])).rows[0];
        if (context) contextSpaceId = context.id;
      }
      if (!context) return conflictResult(await preserveConflict(client, grant, batchId, change, 'chat_context_space_invalid', null));
      const conversationInstanceId = String(conversation.payload_json?.agentInstanceId || conversation.payload_json?.agent_instance_id || '');
      if (conversationInstanceId && conversationInstanceId !== String(context.user_agent_instance_id || '')) {
        return conflictResult(await preserveConflict(client, grant, batchId, change, 'chat_context_space_owner_mismatch', null));
      }
    }
    await acquireAdvisoryLock(client, ['chat-context-state', grant.userId, sessionId, contextSpaceId].join('\u001f'));
    const current = (await client.query(`SELECT * FROM cloud_chat_context_states
      WHERE owner_user_id=$1 AND session_id=$2 AND context_space_id=$3 FOR UPDATE`, [
      grant.userId, sessionId, contextSpaceId,
    ])).rows[0];
    if (current?.id) entityId = current.id;
    const expected = Number(payload.base_state_revision ?? payload.baseStateRevision ?? 0);
    if (current && expected !== Number(current.state_revision || 0)) {
      return conflictResult(await preserveConflict(client, grant, batchId, { ...change, entityId, payload },
        'chat_context_state_revision_mismatch', { revision: current.state_revision, payload_json: current }));
    }
    payload = {
      ...payload, id: entityId, owner_user_id: grant.userId, ownerUserId: grant.userId,
      session_id: sessionId, sessionId, context_space_id: contextSpaceId, contextSpaceId,
      state_revision: Number(current?.state_revision || 0) + 1,
      stateRevision: Number(current?.state_revision || 0) + 1,
      base_state_revision: Number(current?.state_revision || 0),
      baseStateRevision: Number(current?.state_revision || 0),
      source_device_id: grant.deviceId, sourceDeviceId: grant.deviceId,
    };
  }
  if (entityType === 'memory_sync_mapping') {
    const instanceId = await canonicalInstanceId(client, grant.userId, field(payload, 'user_agent_instance_id', 'userAgentInstanceId'));
    const memoryDocumentId = await canonicalDocumentId(client, grant.userId, field(payload, 'memory_document_id', 'memoryDocumentId'));
    const dependencies = instanceId && memoryDocumentId && (await client.query(`SELECT d.id FROM cloud_memory_documents_v3 d
      JOIN cloud_user_agent_instances_v3 i ON i.user_id=d.user_id AND i.id=d.user_agent_instance_id
      WHERE d.user_id=$1 AND d.id=$2 AND d.user_agent_instance_id=$3`, [grant.userId, memoryDocumentId, instanceId])).rows[0];
    if (!dependencies) return conflictResult(await preserveConflict(
      client, grant, batchId, { ...change, entityId, payload }, 'memory_mapping_dependency_missing', null,
    ));
    const cloudKey = field(payload, 'cloud_key', 'cloudKey') || entityId;
    const active = (await client.query(`SELECT cloud_key FROM cloud_memory_sync_mappings
      WHERE owner_user_id=$1 AND memory_document_id=$2 AND status='active' LIMIT 1`, [grant.userId,memoryDocumentId])).rows[0];
    payload = setField(setField(payload, 'user_agent_instance_id', instanceId), 'memory_document_id', memoryDocumentId);
    payload = setField(payload, 'cloud_key', cloudKey);
    payload = { ...payload, id: cloudKey, status: active && active.cloud_key !== cloudKey ? 'superseded' : (payload.status || 'active') };
    entityId = cloudKey;
  }
  if (entityType === 'memory_document_version') {
    const rawDocumentId = field(payload, 'memory_document_id', 'memoryDocumentId');
    const documentId = rawDocumentId ? await canonicalDocumentId(client, grant.userId, rawDocumentId) : '';
    if (documentId) payload = setField(payload, 'memory_document_id', documentId);
    const document = documentId && (await client.query(
      'SELECT id FROM cloud_memory_documents_v3 WHERE user_id=$1 AND id=$2', [grant.userId, documentId],
    )).rows[0];
    if (!document) return conflictResult(await preserveConflict(
      client, grant, batchId, { ...change, entityId, payload }, 'memory_document_dependency_missing', null,
    ));
    const baseVersionId = field(payload, 'base_version_id', 'baseVersionId');
    if (documentId && baseVersionId) {
      const currentVersionId = (await client.query(`SELECT current_version_id FROM cloud_memory_documents_v3 WHERE user_id=$1 AND id=$2`, [grant.userId, documentId])).rows[0]?.current_version_id || '';
      if (currentVersionId && currentVersionId !== baseVersionId) payload = {
        ...payload,
        conflict_state: 'unresolved', conflictState: 'unresolved',
        branch_id: field(payload, 'branch_id', 'branchId') === 'main' ? `branch_${entityId}` : field(payload, 'branch_id', 'branchId'),
      };
    }
    payload = await renumberMemoryVersion(client, grant.userId, entityId, payload);
  }
  if (entityType === 'conversation' && field(payload, 'agent_instance_id', 'agentInstanceId')
    && (payload.conversationRole || payload.conversation_role) === 'primary'
    && (payload.writeState || payload.write_state) === 'writable') {
    const agentInstanceId = field(payload, 'agent_instance_id', 'agentInstanceId');
    const accountWorkspaceId = field(payload, 'account_workspace_id', 'accountWorkspaceId') || 'workspace_personal';
    let canonical = (await client.query(`SELECT canonical_conversation_id FROM cloud_conversation_aliases_v7
      WHERE user_id=$1 AND alias_conversation_id=$2`, [grant.userId, entityId])).rows[0]?.canonical_conversation_id || '';
    if (canonical) canonical = await resolveCloudConversationAliasTarget(client, grant.userId, canonical, { apiError });
    if (!canonical) canonical = (await client.query(`SELECT conversation.id FROM cloud_conversations_v6 conversation
      LEFT JOIN cloud_sync_entities_v6 entity ON entity.user_id=conversation.user_id
        AND entity.entity_type='conversation' AND entity.entity_id=conversation.id
      WHERE conversation.user_id=$1 AND conversation.id!=$2
      AND (entity.entity_id IS NULL OR entity.deleted=false)
      AND conversation.conversation_role='primary' AND conversation.write_state='writable'
      AND COALESCE(conversation.payload_json->>'agentInstanceId',conversation.payload_json->>'agent_instance_id','')=$3
      AND COALESCE(conversation.payload_json->>'accountWorkspaceId',conversation.payload_json->>'account_workspace_id',
        conversation.payload_json->>'workspaceId',conversation.payload_json->>'workspace_id','workspace_personal')=$4
      AND COALESCE(conversation.payload_json->>'status','active')<>'deleted'
      ORDER BY conversation.updated_at DESC,conversation.id DESC LIMIT 1`, [
      grant.userId, entityId, agentInstanceId, accountWorkspaceId,
    ])).rows[0]?.id || '';
    let predecessorAliasId = '';
    if (!canonical && change.operation !== 'delete') {
      predecessorAliasId = (await client.query(`SELECT conversation.id FROM cloud_conversations_v6 conversation
        JOIN cloud_sync_entities_v6 entity ON entity.user_id=conversation.user_id
          AND entity.entity_type='conversation' AND entity.entity_id=conversation.id AND entity.deleted=true
        WHERE conversation.user_id=$1 AND conversation.id!=$2
          AND COALESCE(conversation.payload_json->>'agentInstanceId',conversation.payload_json->>'agent_instance_id','')=$3
          AND COALESCE(conversation.payload_json->>'accountWorkspaceId',conversation.payload_json->>'account_workspace_id',
            conversation.payload_json->>'workspaceId',conversation.payload_json->>'workspace_id','workspace_personal')=$4
          AND COALESCE(conversation.payload_json->>'conversationRole',conversation.payload_json->>'conversation_role','')='primary'
        ORDER BY conversation.updated_at DESC,conversation.id DESC LIMIT 1`, [
        grant.userId, entityId, agentInstanceId, accountWorkspaceId,
      ])).rows[0]?.id || '';
    }
    if (canonical) payload = {
      ...payload, conversationRole: 'history', conversation_role: 'history', writeState: 'read_only', write_state: 'read_only',
      supersededBySessionId: canonical, superseded_by_session_id: canonical,
    };
    if (canonical) {
      batchContext?.conversationRedirects?.set(entityId, canonical);
      if (Number(batchContext?.clientProtocolVersion || 0) >= DATABASE_SYNC_PROTOCOL_VERSION) {
        generated.push(await recordAliasChange(client, grant, batchId, 'conversation_alias', entityId, canonical, {
          accountWorkspaceId: field(payload, 'account_workspace_id', 'accountWorkspaceId') || 'workspace_personal',
          agentInstanceId,
        }));
      }
    }
    if (!canonical && predecessorAliasId && Number(batchContext?.clientProtocolVersion || 0) >= DATABASE_SYNC_PROTOCOL_VERSION) {
      generated.push(await recordAliasChange(client, grant, batchId, 'conversation_alias', predecessorAliasId, entityId, {
        accountWorkspaceId,
        agentInstanceId,
      }));
    }
  }

  const contentHash = entityContentHash(entityType,
    conversationReferenceRedirected ? { ...change, contentHash: '' } : change, payload);
  const existingV8 = grant.accountId ? (await client.query(`SELECT * FROM cloud_sync_entities_v8
    WHERE account_id=$1 AND entity_type=$2 AND entity_id=$3 FOR UPDATE`, [grant.accountId, entityType, entityId])).rows[0] : null;
  const existingV6 = (await client.query(`SELECT * FROM cloud_sync_entities_v6
    WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3 FOR UPDATE`, [grant.userId, entityType, entityId])).rows[0];
  const existing = existingV8 || existingV6;
  if (existing && existing.content_hash === contentHash && existing.deleted === (change.operation === 'delete')) {
    return { accepted: null, generated, duplicate: true };
  }
  if (existing && IMMUTABLE_TYPES.has(entityType)) {
    return { generated, ...conflictResult(await preserveConflict(client, grant, batchId, { ...change, entityId, payload }, 'immutable_id_hash_mismatch', existing)) };
  }
  const baseMismatch = existing && Number(change.baseRevision || 0) !== Number(existing.revision || 0);
  const legacyOlder = legacyCompat && existing && Date.parse(change.occurredAt) < Date.parse(existing.occurred_at);
  if (baseMismatch && (!legacyCompat || legacyOlder)) {
    return { generated, ...conflictResult(await preserveConflict(client, grant, batchId, { ...change, entityId, payload }, 'base_revision_mismatch', existing)) };
  }
  const revision = Number(existing?.revision || 0) + 1;
  const deleted = change.operation === 'delete';
  await client.query(`INSERT INTO cloud_sync_entities_v6 (
    user_id,entity_type,entity_id,revision,deleted,content_hash,payload_json,origin_device_id,occurred_at,updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,now())
  ON CONFLICT(user_id,entity_type,entity_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,
    content_hash=excluded.content_hash,payload_json=excluded.payload_json,origin_device_id=excluded.origin_device_id,
    occurred_at=excluded.occurred_at,updated_at=now()`, [
    grant.userId, entityType, entityId, revision, deleted, contentHash, JSON.stringify(payload), grant.deviceId, change.occurredAt,
  ]);
  if (grant.accountId) await client.query(`INSERT INTO cloud_sync_entities_v8 (
    account_id,entity_type,entity_id,revision,deleted,content_hash,payload_json,origin_user_id,origin_device_id,occurred_at,updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,now())
  ON CONFLICT(account_id,entity_type,entity_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,
    content_hash=excluded.content_hash,payload_json=excluded.payload_json,origin_user_id=excluded.origin_user_id,
    origin_device_id=excluded.origin_device_id,occurred_at=excluded.occurred_at,updated_at=now()`, [
    grant.accountId, entityType, entityId, revision, deleted, contentHash, JSON.stringify(payload), grant.userId, grant.deviceId, change.occurredAt,
  ]);
  const accepted = await insertChange(client, grant, batchId, { ...change, entityType, entityId, payload, contentHash }, revision);
  await materialize(client, grant.userId, entityType, entityId, payload, revision, deleted);
  if (entityType === 'user_agent_skill_version' && !deleted) await reconcileServerSkillActivation(client, grant.userId, payload);
  return { accepted, generated };
}

async function recordAliasChange(client, grant, batchId, aliasType, aliasId, canonicalId, options = {}) {
  const instance = aliasType === 'agent_instance_alias';
  const conversation = aliasType === 'conversation_alias';
  const payload = conversation
    ? {
        user_id: grant.userId,
        alias_conversation_id: aliasId,
        canonical_conversation_id: canonicalId,
        conversation_id: canonicalId,
        account_workspace_id: options.accountWorkspaceId || 'workspace_personal',
        conversation_kind: 'direct',
        agent_instance_id: options.agentInstanceId || '',
        reason: 'agent_single_window_canonicalization',
      }
    : instance
    ? { user_id: grant.userId, alias_instance_id: aliasId, canonical_instance_id: canonicalId, reason: 'cross_device_family_conflict' }
    : { user_id: grant.userId, alias_document_id: aliasId, canonical_document_id: canonicalId, reason: 'cross_device_memory_conflict' };
  const contentHash = sha256(stableJson(payload));
  const existing = (await client.query(`SELECT * FROM cloud_sync_entities_v6
    WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3`, [grant.userId, aliasType, aliasId])).rows[0];
  if (existing?.content_hash === contentHash) return null;
  const revision = Number(existing?.revision || 0) + 1;
  await client.query(`INSERT INTO cloud_sync_entities_v6 (
    user_id,entity_type,entity_id,revision,content_hash,payload_json,origin_device_id,occurred_at,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6::jsonb,'cloud_canonicalizer',now(),now())
  ON CONFLICT(user_id,entity_type,entity_id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,
    payload_json=excluded.payload_json,origin_device_id=excluded.origin_device_id,occurred_at=now(),updated_at=now()`,
  [grant.userId, aliasType, aliasId, revision, contentHash, JSON.stringify(payload)]);
  if (grant.accountId) await client.query(`INSERT INTO cloud_sync_entities_v8(
    account_id,entity_type,entity_id,revision,deleted,content_hash,payload_json,origin_user_id,origin_device_id,occurred_at,updated_at
  ) VALUES($1,$2,$3,$4,false,$5,$6::jsonb,$7,'cloud_canonicalizer',now(),now())
  ON CONFLICT(account_id,entity_type,entity_id) DO UPDATE SET revision=excluded.revision,deleted=false,
    content_hash=excluded.content_hash,payload_json=excluded.payload_json,origin_user_id=excluded.origin_user_id,
    origin_device_id=excluded.origin_device_id,occurred_at=now(),updated_at=now()`, [
    grant.accountId, aliasType, aliasId, revision, contentHash, JSON.stringify(payload), grant.userId,
  ]);
  const accepted = await insertChange(client, { ...grant, deviceId: 'cloud_canonicalizer' }, batchId, {
    changeId: `canonical_${sha256(`${grant.userId}:${aliasType}:${aliasId}:${canonicalId}`).slice(0, 40)}`,
    entityType: aliasType, entityId: aliasId, operation: 'upsert', baseRevision: Number(existing?.revision || 0),
    occurredAt: new Date().toISOString(), payload, contentHash,
  }, revision);
  await materialize(client, grant.userId, aliasType, aliasId, payload, revision, false);
  return accepted;
}

async function touchCanonicalConversation(client, grant, batchId, conversationId, updatedAt) {
  const conversation = (await client.query(`SELECT revision,payload_json FROM cloud_conversations_v6
    WHERE user_id=$1 AND id=$2 FOR UPDATE`, [grant.userId, conversationId])).rows[0];
  if (!conversation) return null;
  const currentUpdatedAt = entityTimestamp(conversation.payload_json);
  if (!updatedAt || (currentUpdatedAt && updatedAt <= currentUpdatedAt)) return null;
  const existing = (await client.query(`SELECT revision FROM cloud_sync_entities_v6
    WHERE user_id=$1 AND entity_type='conversation' AND entity_id=$2 FOR UPDATE`, [grant.userId, conversationId])).rows[0];
  const revision = Math.max(Number(conversation.revision || 0), Number(existing?.revision || 0)) + 1;
  const payload = setField(conversation.payload_json || {}, 'updated_at', updatedAt);
  const contentHash = sha256(stableJson(payload));
  await client.query(`INSERT INTO cloud_sync_entities_v6(
    user_id,entity_type,entity_id,revision,deleted,content_hash,payload_json,origin_device_id,occurred_at,updated_at
  ) VALUES($1,'conversation',$2,$3,false,$4,$5::jsonb,'cloud_canonicalizer',$6,now())
  ON CONFLICT(user_id,entity_type,entity_id) DO UPDATE SET revision=excluded.revision,deleted=false,
    content_hash=excluded.content_hash,payload_json=excluded.payload_json,origin_device_id=excluded.origin_device_id,
    occurred_at=excluded.occurred_at,updated_at=now()`, [
    grant.userId, conversationId, revision, contentHash, JSON.stringify(payload), updatedAt,
  ]);
  if (grant.accountId) await client.query(`INSERT INTO cloud_sync_entities_v8(
    account_id,entity_type,entity_id,revision,deleted,content_hash,payload_json,origin_user_id,origin_device_id,occurred_at,updated_at
  ) VALUES($1,'conversation',$2,$3,false,$4,$5::jsonb,$6,'cloud_canonicalizer',$7,now())
  ON CONFLICT(account_id,entity_type,entity_id) DO UPDATE SET revision=excluded.revision,deleted=false,
    content_hash=excluded.content_hash,payload_json=excluded.payload_json,origin_user_id=excluded.origin_user_id,
    origin_device_id=excluded.origin_device_id,occurred_at=excluded.occurred_at,updated_at=now()`, [
    grant.accountId, conversationId, revision, contentHash, JSON.stringify(payload), grant.userId, updatedAt,
  ]);
  const accepted = await insertChange(client, { ...grant, deviceId: 'cloud_canonicalizer' }, batchId, {
    changeId: `canonical_${sha256(`${batchId}:conversation-touch:${conversationId}:${revision}`).slice(0, 40)}`,
    entityType: 'conversation', entityId: conversationId, operation: 'upsert',
    baseRevision: revision - 1, occurredAt: updatedAt, payload, contentHash,
  }, revision);
  await materialize(client, grant.userId, 'conversation', conversationId, payload, revision, false);
  return accepted;
}

async function insertChange(client, grant, batchId, change, revision) {
  const legacyRow = (await client.query(`INSERT INTO cloud_sync_changes_v6 (
    change_id,user_id,device_id,batch_id,entity_type,entity_id,operation,base_revision,revision,content_hash,payload_json,occurred_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
  ON CONFLICT(change_id) DO UPDATE SET change_id=excluded.change_id RETURNING *`, [
    change.changeId, grant.userId, grant.deviceId, batchId, change.entityType, change.entityId, change.operation,
    Number(change.baseRevision || 0), revision, change.contentHash || sha256(stableJson(change.payload)),
    JSON.stringify(change.payload || {}), change.occurredAt,
  ])).rows[0];
  if (!grant.accountId) return changePayload(legacyRow);
  const row = (await client.query(`INSERT INTO cloud_sync_changes_v8 (
    change_id,account_id,user_id,device_id,batch_id,entity_type,entity_id,operation,base_revision,revision,content_hash,payload_json,occurred_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
  ON CONFLICT(change_id) DO UPDATE SET change_id=excluded.change_id RETURNING *`, [
    change.changeId, grant.accountId, grant.userId, grant.deviceId, batchId, change.entityType, change.entityId, change.operation,
    Number(change.baseRevision || 0), revision, change.contentHash || sha256(stableJson(change.payload)),
    JSON.stringify(change.payload || {}), change.occurredAt,
  ])).rows[0];
  return { ...changePayload(row), accountId: grant.accountId };
}

async function preserveConflict(client, grant, batchId, change, kind, existing) {
  const id = `syncconf_${crypto.randomUUID()}`;
  const row = (await client.query(`INSERT INTO cloud_sync_conflicts_v6 (
    id,user_id,device_id,batch_id,change_id,entity_type,entity_id,conflict_kind,server_revision,
    client_base_revision,server_payload_json,client_payload_json,status,created_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,'preserved',now()) RETURNING *`, [
    id, grant.userId, grant.deviceId, batchId, change.changeId, change.entityType, change.entityId, kind,
    Number(existing?.revision || 0), Number(change.baseRevision || 0), JSON.stringify(existing?.payload_json || {}), JSON.stringify(change.payload || {}),
  ])).rows[0];
  if (grant.accountId) await client.query(`INSERT INTO cloud_sync_conflicts_v8 (
    id,account_id,user_id,device_id,batch_id,change_id,entity_type,entity_id,conflict_kind,server_revision,
    client_base_revision,server_payload_json,client_payload_json,status,created_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,'preserved',now())`, [
    id, grant.accountId, grant.userId, grant.deviceId, batchId, change.changeId, change.entityType, change.entityId, kind,
    Number(existing?.revision || 0), Number(change.baseRevision || 0), JSON.stringify(existing?.payload_json || {}), JSON.stringify(change.payload || {}),
  ]);
  return { id: row.id, changeId: row.change_id, entityType: row.entity_type, entityId: row.entity_id,
    kind: row.conflict_kind, serverRevision: Number(row.server_revision || 0), clientBaseRevision: Number(row.client_base_revision || 0),
    status: row.status, createdAt: row.created_at };
}

async function materialize(client, userId, type, id, payload, revision, deleted) {
  if (deleted) {
    if (type === 'conversation') {
      const tombstone = JSON.stringify({ ...payload, status: 'deleted' });
      return client.query(`UPDATE cloud_conversations_v6 SET revision=$1,conversation_role='history',write_state='read_only',
        superseded_by_session_id='',payload_json=$2::jsonb,updated_at=now() WHERE user_id=$3 AND id=$4`, [
        revision, tombstone, userId, id,
      ]);
    }
    if (type === 'file_ref') {
      const previous = (await client.query('SELECT payload_json FROM cloud_file_refs_v6 WHERE user_id=$1 AND id=$2', [userId, id])).rows[0];
      await client.query('DELETE FROM cloud_file_refs_v6 WHERE user_id=$1 AND id=$2', [userId, id]);
      const oldSha = String(previous?.payload_json?.sha256 || '');
      if (oldSha) await refreshFileReferenceCount(client, userId, oldSha);
    }
    return;
  }
  const json = JSON.stringify(payload || {});
  if (type === 'project') return materializeSimple(client, 'cloud_projects_v6', userId, id, revision, json);
  if (type === 'conversation') return client.query(`INSERT INTO cloud_conversations_v6 (
    user_id,id,revision,conversation_role,write_state,superseded_by_session_id,payload_json,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now()) ON CONFLICT(user_id,id) DO UPDATE SET revision=excluded.revision,
    conversation_role=excluded.conversation_role,write_state=excluded.write_state,superseded_by_session_id=excluded.superseded_by_session_id,
    payload_json=excluded.payload_json,updated_at=now()`, [
    userId,id,revision,payload.conversationRole || payload.conversation_role || 'standard',payload.writeState || payload.write_state || 'writable',
    field(payload,'superseded_by_session_id','supersededBySessionId'),json,
  ]);
  if (type === 'conversation_alias') return client.query(`INSERT INTO cloud_conversation_aliases_v7 (
    user_id,alias_conversation_id,canonical_conversation_id,account_workspace_id,agent_instance_id,reason,payload_json,created_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now()) ON CONFLICT(user_id,alias_conversation_id) DO UPDATE SET
    canonical_conversation_id=excluded.canonical_conversation_id,account_workspace_id=excluded.account_workspace_id,
    agent_instance_id=excluded.agent_instance_id,reason=excluded.reason,payload_json=excluded.payload_json`, [
    userId,id,field(payload,'canonical_conversation_id','canonicalConversationId') || field(payload,'conversation_id','conversationId'),
    field(payload,'account_workspace_id','accountWorkspaceId') || 'workspace_personal',
    field(payload,'agent_instance_id','agentInstanceId'),field(payload,'reason') || 'agent_single_window_canonicalization',json,
  ]);
  if (type === 'message') return client.query(`INSERT INTO cloud_messages_v6 (
    user_id,id,revision,context_space_id,payload_json,updated_at
  ) VALUES($1,$2,$3,$4,$5::jsonb,now()) ON CONFLICT(user_id,id) DO UPDATE SET revision=excluded.revision,
    context_space_id=excluded.context_space_id,payload_json=excluded.payload_json,updated_at=now()`, [
    userId,id,revision,field(payload,'context_space_id','contextSpaceId'),json,
  ]);
  if (type === 'model_execution') return materializeSimple(client, 'cloud_model_executions_v6', userId, id, revision, json);
  if (type === 'file_ref') {
    const previous = (await client.query('SELECT payload_json FROM cloud_file_refs_v6 WHERE user_id=$1 AND id=$2', [userId, id])).rows[0];
    await materializeSimple(client, 'cloud_file_refs_v6', userId, id, revision, json);
    const oldSha = String(previous?.payload_json?.sha256 || '');
    const nextSha = String(payload.sha256 || '');
    if (oldSha && oldSha !== nextSha) await refreshFileReferenceCount(client, userId, oldSha);
    if (nextSha) await refreshFileReferenceCount(client, userId, nextSha);
    return;
  }
  if (type === 'agent_family') {
    if (isLegacyPptAgentId(id)) return null;
    if (isLegacyGeneralAgentId(id)) {
      const familyJson = JSON.stringify({
        ...payload,
        name: 'Generalist',
        status: 'retired',
        routable: false,
        instance_kind: 'unavailable',
        instanceKind: 'unavailable',
        recruitable: false,
        default_for_new_user: false,
        defaultForNewUser: false,
        quota_cost: 0,
        quotaCost: 0,
      });
      return client.query(`INSERT INTO cloud_agent_families_v3(
        id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,
        default_for_new_user,quota_cost,payload_json,updated_at
      ) VALUES($1,$2,'Generalist',$3,'retired',false,$4,'unavailable',false,false,0,$5::jsonb,now())
      ON CONFLICT(id) DO UPDATE SET name='Generalist',status='retired',routable=false,
        instance_kind='unavailable',recruitable=false,default_for_new_user=false,quota_cost=0,
        payload_json=$5::jsonb,updated_at=now()`, [
        id, field(payload, 'department_id', 'departmentId') || 'general', payload.role || 'agent',
        field(payload, 'current_version_id', 'currentVersionId'), familyJson,
      ]);
    }
    const familyName = canonicalAgentFamilyName(id, payload.name || id);
    const familyJson = JSON.stringify({ ...payload, name: familyName });
    return client.query(`INSERT INTO cloud_agent_families_v3(
      id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,
      default_for_new_user,quota_cost,payload_json,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,now()) ON CONFLICT(id) DO UPDATE SET
      department_id=excluded.department_id,name=excluded.name,role=excluded.role,
      routable=cloud_agent_families_v3.routable OR excluded.routable,
      current_version_id=CASE WHEN excluded.current_version_id<>'' THEN excluded.current_version_id
        ELSE cloud_agent_families_v3.current_version_id END,
      instance_kind=CASE
        WHEN cloud_agent_families_v3.instance_kind='employee' OR excluded.instance_kind='employee' THEN 'employee'
        WHEN cloud_agent_families_v3.instance_kind='unavailable' THEN excluded.instance_kind
        ELSE cloud_agent_families_v3.instance_kind END,
      recruitable=cloud_agent_families_v3.recruitable OR excluded.recruitable,
      default_for_new_user=cloud_agent_families_v3.default_for_new_user OR excluded.default_for_new_user,
      quota_cost=GREATEST(cloud_agent_families_v3.quota_cost,excluded.quota_cost),
      payload_json=excluded.payload_json,updated_at=now()`, [
      id, field(payload, 'department_id', 'departmentId'), familyName, payload.role || 'agent', payload.status || 'active',
      bool(payload.routable), field(payload, 'current_version_id', 'currentVersionId'),
      field(payload, 'instance_kind', 'instanceKind') || 'unavailable', bool(payload.recruitable),
      bool(payload.default_for_new_user ?? payload.defaultForNewUser), Math.max(0, Number(payload.quota_cost ?? payload.quotaCost ?? 0)),
      familyJson,
    ]);
  }
  if (type === 'agent_version') {
    const familyId = canonicalEmployeeAgentFamilyId(field(payload, 'agent_family_id', 'agentFamilyId'));
    return client.query(`INSERT INTO cloud_agent_versions_v3(id,agent_family_id,content_hash,payload_json,created_at)
      VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(id) DO NOTHING`, [
      id, familyId, field(payload, 'content_hash', 'contentHash'), JSON.stringify({ ...payload, agent_family_id: familyId, agentFamilyId: familyId }), entityTimestamp(payload),
    ]);
  }
  if (type === 'user_agent_instance') return materializeInstance(client, userId, id, payload);
  if (type === 'agent_instance_alias') {
    return materializeAgentInstanceAlias(client, userId, id, payload);
  }
  if (type === 'memory_document') return materializeMemoryDocument(client, userId, id, payload);
  if (type === 'agent_context_space') {
    return client.query(`INSERT INTO cloud_agent_context_spaces (
      user_id,id,user_agent_instance_id,context_kind,memory_document_id,project_id,task_run_id,delegation_id,group_id,
      relationship_user_id,lifecycle_state,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(user_id,id) DO UPDATE SET lifecycle_state=excluded.lifecycle_state,updated_at=excluded.updated_at`, [
      userId,id,field(payload,'user_agent_instance_id','userAgentInstanceId'),payload.context_kind || payload.contextKind || 'general_memory',
      field(payload,'memory_document_id','memoryDocumentId') || null,field(payload,'project_id','projectId'),field(payload,'task_run_id','taskRunId'),
      field(payload,'delegation_id','delegationId'),field(payload,'group_id','groupId'),field(payload,'relationship_user_id','relationshipUserId'),
      field(payload,'lifecycle_state','lifecycleState') || 'active',entityTimestamp(payload),entityTimestamp(payload),
    ]);
  }
  if (type === 'agent_context_state') {
    const instanceId = field(payload, 'user_agent_instance_id', 'userAgentInstanceId') || id;
    const ownedInstance=(await client.query('SELECT 1 FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2',[userId,instanceId])).rows[0];
    if(!ownedInstance)return null;
    const memoryDocumentId = field(payload, 'active_memory_document_id', 'activeMemoryDocumentId');
    if (memoryDocumentId) {
      await client.query(`UPDATE cloud_memory_documents_v3 SET lifecycle_state=CASE WHEN id=$1 THEN 'active' ELSE 'inactive' END,
        updated_at=CASE WHEN id=$1 THEN now() ELSE updated_at END
        WHERE user_id=$2 AND user_agent_instance_id=$3 AND scope='general' AND lifecycle_state<>'archived'`,
      [memoryDocumentId, userId, instanceId]);
      await client.query(`UPDATE cloud_agent_context_spaces SET lifecycle_state=CASE WHEN memory_document_id=$1 THEN 'active' ELSE 'inactive' END,
        updated_at=CASE WHEN memory_document_id=$1 THEN now() ELSE updated_at END
        WHERE user_id=$2 AND user_agent_instance_id=$3 AND context_kind='general_memory' AND lifecycle_state<>'archived'`,
      [memoryDocumentId, userId, instanceId]);
    }
    return client.query(`INSERT INTO cloud_agent_context_states(
      owner_user_id,user_agent_instance_id,primary_conversation_id,active_context_space_id,active_memory_document_id,
      state_revision,last_command_id,source_device_id,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner_user_id,user_agent_instance_id) DO UPDATE SET
      primary_conversation_id=excluded.primary_conversation_id,active_context_space_id=excluded.active_context_space_id,
      active_memory_document_id=excluded.active_memory_document_id,state_revision=excluded.state_revision,
      last_command_id=excluded.last_command_id,source_device_id=excluded.source_device_id,updated_at=excluded.updated_at`, [
      userId, instanceId, field(payload, 'primary_conversation_id', 'primaryConversationId'),
      field(payload, 'active_context_space_id', 'activeContextSpaceId'), memoryDocumentId,
      Number(payload.state_revision ?? payload.stateRevision ?? 1), field(payload, 'last_command_id', 'lastCommandId'),
      field(payload, 'source_device_id', 'sourceDeviceId'), entityTimestamp(payload), entityTimestamp(payload),
    ]);
  }
  if (type === 'chat_context_state') return client.query(`INSERT INTO cloud_chat_context_states(
    id,owner_user_id,session_id,context_space_id,context_epoch,reset_after_message_id,reset_after_created_at,
    last_execution_id,last_input_tokens,context_window_tokens,provider_compaction_detected,state_revision,
    last_command_id,source_device_id,created_at,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,$13,$14,$15,$16)
  ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,context_space_id=excluded.context_space_id,
    context_epoch=excluded.context_epoch,reset_after_message_id=excluded.reset_after_message_id,
    reset_after_created_at=excluded.reset_after_created_at,last_execution_id=excluded.last_execution_id,
    last_input_tokens=excluded.last_input_tokens,context_window_tokens=excluded.context_window_tokens,
    provider_compaction_detected=excluded.provider_compaction_detected,state_revision=excluded.state_revision,
    last_command_id=excluded.last_command_id,source_device_id=excluded.source_device_id,updated_at=excluded.updated_at`, [
    id,userId,field(payload,'session_id','sessionId'),field(payload,'context_space_id','contextSpaceId'),
    Math.max(1,Number(payload.context_epoch ?? payload.contextEpoch ?? 1)),field(payload,'reset_after_message_id','resetAfterMessageId'),
    field(payload,'reset_after_created_at','resetAfterCreatedAt') || null,field(payload,'last_execution_id','lastExecutionId'),
    Math.max(0,Number(payload.last_input_tokens ?? payload.lastInputTokens ?? 0)),
    Math.max(0,Number(payload.context_window_tokens ?? payload.contextWindowTokens ?? 0)),
    bool(payload.provider_compaction_detected ?? payload.providerCompactionDetected),
    Math.max(1,Number(payload.state_revision ?? payload.stateRevision ?? 1)),field(payload,'last_command_id','lastCommandId'),
    field(payload,'source_device_id','sourceDeviceId'),entityTimestamp(payload),entityTimestamp(payload),
  ]);
  if (type === 'memory_sync_mapping') {
    return client.query(`INSERT INTO cloud_memory_sync_mappings(
      owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(owner_user_id,user_agent_instance_id,cloud_key) DO UPDATE SET
      memory_document_id=excluded.memory_document_id,status=excluded.status,updated_at=excluded.updated_at`, [
      userId,field(payload,'user_agent_instance_id','userAgentInstanceId'),field(payload,'cloud_key','cloudKey') || id,
      field(payload,'memory_document_id','memoryDocumentId'),payload.status || 'active',entityTimestamp(payload),entityTimestamp(payload),
    ]);
  }
  if (type === 'memory_document_alias') {
    return client.query(`INSERT INTO cloud_memory_document_aliases_v3(user_id,alias_document_id,canonical_document_id,reason)
      VALUES($1,$2,$3,$4) ON CONFLICT(user_id,alias_document_id) DO UPDATE SET canonical_document_id=excluded.canonical_document_id,
      reason=excluded.reason`, [userId, field(payload, 'alias_document_id', 'aliasDocumentId') || id,
      field(payload, 'canonical_document_id', 'canonicalDocumentId'), payload.reason || 'client_alias']);
  }
  if (type === 'memory_document_version') {
    await client.query(`INSERT INTO cloud_memory_document_versions_v3(user_id,id,memory_document_id,version_no,content_hash,
      base_version_id,parent_version_id,branch_id,conflict_state,payload_json,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT(user_id,id) DO NOTHING`, [
      userId, id, field(payload, 'memory_document_id', 'memoryDocumentId'), Number(payload.version_no ?? payload.versionNo ?? 1),
      field(payload, 'content_hash', 'contentHash'),field(payload,'base_version_id','baseVersionId'),field(payload,'parent_version_id','parentVersionId'),
      field(payload,'branch_id','branchId') || 'main',field(payload,'conflict_state','conflictState') || 'none',json,entityTimestamp(payload),
    ]);
    if ((field(payload,'conflict_state','conflictState') || 'none') !== 'unresolved') {
      await client.query(`UPDATE cloud_memory_documents_v3 SET current_version_id=$1,updated_at=now()
        WHERE user_id=$2 AND id=$3`, [id,userId,field(payload,'memory_document_id','memoryDocumentId')]);
    }
    return;
  }
  if (type === 'task_security_context') return materializeTaskSecurity(client, userId, payload);
  if (type === 'task_run') {
    const workspaceId = field(payload, 'account_workspace_id', 'accountWorkspaceId')
      || field(payload, 'workspace_id', 'workspaceId') || 'workspace_personal';
    const result = await client.query(`INSERT INTO cloud_task_runs(id,account_workspace_id,owner_user_id,payload_json,updated_at)
      SELECT $1,$2,$3,$4::jsonb,now() WHERE EXISTS (
        SELECT 1 FROM account_workspace_memberships WHERE workspace_id=$2 AND user_id=$3 AND status='active'
      ) ON CONFLICT(id) DO UPDATE SET account_workspace_id=excluded.account_workspace_id,
        owner_user_id=excluded.owner_user_id,payload_json=excluded.payload_json,updated_at=now()`, [id, workspaceId, userId, json]);
    if (Number(result.rowCount || 0) !== 1) {
      const error = new Error('工作空间不存在或你已不在该工作空间中。');
      error.code = 'account_workspace_forbidden';
      error.status = 403;
      throw error;
    }
    return result;
  }
  if (type === 'task_node') {
    return client.query(`INSERT INTO cloud_task_nodes(id,task_run_id,user_agent_instance_id,payload_json,updated_at)
      VALUES($1,$2,$3,$4::jsonb,now()) ON CONFLICT(id) DO UPDATE SET task_run_id=excluded.task_run_id,
      user_agent_instance_id=excluded.user_agent_instance_id,payload_json=excluded.payload_json,updated_at=now()`, [
      id, field(payload, 'task_run_id', 'taskRunId'), field(payload, 'agent_instance_id', 'agentInstanceId'), json,
    ]);
  }
  if (type === 'task_event') {
    return client.query(`INSERT INTO cloud_task_events(
      id,task_run_id,task_node_id,event_type,owner_user_id,user_agent_instance_id,payload_json,created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(id) DO NOTHING`, [
      id, field(payload, 'task_run_id', 'taskRunId'), field(payload, 'task_node_id', 'taskNodeId'),
      field(payload, 'event_type', 'eventType'), userId, field(payload, 'user_agent_instance_id', 'userAgentInstanceId')
        || field(payload, 'agent_instance_id', 'agentInstanceId'), json, entityTimestamp(payload),
    ]);
  }
}

function materializeSimple(client, table, userId, id, revision, json) {
  return client.query(`INSERT INTO ${table}(user_id,id,revision,payload_json,updated_at) VALUES($1,$2,$3,$4::jsonb,now())
    ON CONFLICT(user_id,id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json,updated_at=now()`,
  [userId, id, revision, json]);
}

async function refreshFileReferenceCount(client, userId, sha256) {
  const rows = (await client.query('SELECT payload_json FROM cloud_file_refs_v6 WHERE user_id=$1', [userId])).rows;
  const count = rows.filter((row) => String(row.payload_json?.sha256 || '') === sha256).length;
  await client.query(`UPDATE cloud_file_objects_v6 SET reference_count=$1::bigint,
    unreferenced_at=CASE WHEN $1::bigint>0 THEN NULL ELSE COALESCE(unreferenced_at,now()) END,updated_at=now()
    WHERE user_id=$2 AND sha256=$3`, [count, userId, sha256]);
}

async function materializeInstance(client, userId, id, payload) {
  const rawFamilyId = field(payload, 'agent_family_id', 'agentFamilyId');
  const familyId = canonicalEmployeeAgentFamilyId(rawFamilyId);
  const syncEnabled = bool(payload.sync_enabled ?? payload.syncEnabled, true);
  const status = payload.status || 'active';
  const family = (await client.query('SELECT name,current_version_id FROM cloud_agent_families_v3 WHERE id=$1', [familyId])).rows[0] || {};
  const baseAgentVersionId = isLegacyGeneralAgentId(rawFamilyId)
    ? family.current_version_id || field(payload, 'base_agent_version_id', 'baseAgentVersionId')
    : field(payload, 'base_agent_version_id', 'baseAgentVersionId');
  const existingInstance = (await client.query(`SELECT family_instance_seq,display_name,note FROM cloud_user_agent_instances_v3
    WHERE user_id=$1 AND id=$2`, [userId, id])).rows[0] || null;
  const requestedFamilyInstanceSeq = Math.max(0, Math.floor(Number(
    field(payload, 'family_instance_seq', 'familyInstanceSeq'),
  ) || 0));
  const familyInstanceSeq = await resolveMaterializedFamilySequence(client, {
    userId,
    familyId,
    instanceId: id,
    requestedSequence: requestedFamilyInstanceSeq,
    existingSequence: existingInstance?.family_instance_seq,
  });
  const rawDisplayName = field(payload, 'display_name', 'displayName') || existingInstance?.display_name || '';
  const displayName = rawDisplayName && !isDefaultAgentInstanceDisplayName(
    rawDisplayName, family.name || familyId, familyId, requestedFamilyInstanceSeq || Number(existingInstance?.family_instance_seq || 1),
  )
    ? rawDisplayName
    : defaultAgentInstanceDisplayName(family.name || familyId, familyInstanceSeq, familyId);
  const note = field(payload, 'note') || existingInstance?.note || '';
  const normalizedPayload = {
    ...payload,
    agent_family_id: familyId,
    agentFamilyId: familyId,
    base_agent_version_id: baseAgentVersionId,
    baseAgentVersionId,
    family_instance_seq: familyInstanceSeq,
    familyInstanceSeq,
    display_name: displayName,
    displayName,
    note,
  };
  const canonical = isLegacyPptAgentId(rawFamilyId) ? (await client.query(`SELECT id FROM cloud_user_agent_instances_v3
    WHERE user_id=$1 AND agent_family_id=$2 ORDER BY created_at,id LIMIT 1`, [userId, familyId])).rows[0] : null;
  if (canonical && canonical.id !== id) {
    await client.query(`INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id,reason)
      VALUES($1,$2,$3,'ppt_family_canonicalization') ON CONFLICT(user_id,alias_instance_id) DO UPDATE SET
      canonical_instance_id=excluded.canonical_instance_id,reason=excluded.reason`, [userId, id, canonical.id]);
    return client.query(`UPDATE cloud_user_agent_instances_v3 SET
      base_agent_version_id=CASE WHEN $1<>'' THEN $1 ELSE base_agent_version_id END,
      sync_enabled=$2,personal_evolution_consent=$3,cluster_contribution_consent=$4,
      personal_skill_auto_activate=$5,payload_json=$6::jsonb,updated_at=$7
      WHERE user_id=$8 AND id=$9`, [
      field(payload, 'base_agent_version_id', 'baseAgentVersionId'), syncEnabled,
      bool(payload.personal_evolution_consent ?? payload.personalEvolutionConsent, syncEnabled && status === 'active'),
      syncEnabled && status === 'active', bool(payload.personal_skill_auto_activate ?? payload.personalSkillAutoActivate),
      JSON.stringify(normalizedPayload), entityTimestamp(payload), userId, canonical.id,
    ]);
  }
  return client.query(`INSERT INTO cloud_user_agent_instances_v3 (
    user_id,id,agent_family_id,base_agent_version_id,active_personal_skill_version_id,status,instance_kind,employment_state,sync_enabled,
    personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,source_device_id,
    family_instance_seq,display_name,note,payload_json,created_at,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
  ON CONFLICT(user_id,id) DO UPDATE SET agent_family_id=excluded.agent_family_id,base_agent_version_id=excluded.base_agent_version_id,
    sync_enabled=excluded.sync_enabled,personal_evolution_consent=excluded.personal_evolution_consent,
    cluster_contribution_consent=excluded.cluster_contribution_consent,
    personal_skill_auto_activate=excluded.personal_skill_auto_activate,
    family_instance_seq=excluded.family_instance_seq,display_name=excluded.display_name,note=excluded.note,
    payload_json=excluded.payload_json,updated_at=excluded.updated_at`, [
    userId, id, familyId, baseAgentVersionId,
    field(payload, 'active_personal_skill_version_id', 'activePersonalSkillVersionId'), status,
    field(payload,'instance_kind','instanceKind') || 'employee',syncEnabled,
    bool(payload.personal_evolution_consent ?? payload.personalEvolutionConsent, syncEnabled && status === 'active'), syncEnabled && status === 'active',
    bool(payload.personal_skill_auto_activate ?? payload.personalSkillAutoActivate), field(payload, 'source_device_id', 'sourceDeviceId'),
    familyInstanceSeq, displayName, note, JSON.stringify(normalizedPayload), entityTimestamp(payload), entityTimestamp(payload),
  ]);
}

async function resolveMaterializedFamilySequence(client, {
  userId = '', familyId = '', instanceId = '', requestedSequence = 0, existingSequence = 0,
} = {}) {
  const requested = Math.max(0, Math.floor(Number(requestedSequence) || 0));
  if (requested > 0) {
    const conflict = (await client.query(`SELECT 1 FROM cloud_user_agent_instances_v3
      WHERE user_id=$1 AND agent_family_id=$2 AND family_instance_seq=$3 AND id<>$4 LIMIT 1`, [
      userId, familyId, requested, instanceId,
    ])).rows[0];
    if (!conflict) return requested;
  }
  if (Number(existingSequence || 0) > 0) return Number(existingSequence);
  const row = (await client.query(`SELECT COALESCE(MAX(family_instance_seq),0)::int+1 AS sequence
    FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND agent_family_id=$2`, [userId, familyId])).rows[0];
  return Math.max(1, Number(row?.sequence || 1));
}

function authoritativeInstancePayload(payload, row) {
  return {
    ...payload,
    id: row.id,
    agent_family_id: row.agent_family_id,
    agentFamilyId: row.agent_family_id,
    status: row.status,
    instance_kind: row.instance_kind,
    instanceKind: row.instance_kind,
    employment_state: row.employment_state,
    employmentState: row.employment_state,
    quota_exempt: row.quota_exempt,
    quotaExempt: row.quota_exempt,
    recruited_at: row.recruited_at,
    recruitedAt: row.recruited_at,
    deactivated_at: row.deactivated_at,
    deactivatedAt: row.deactivated_at,
    last_state_changed_at: row.last_state_changed_at,
    lastStateChangedAt: row.last_state_changed_at,
    state_revision: row.state_revision,
    stateRevision: row.state_revision,
    recruitment_source: row.recruitment_source,
    recruitmentSource: row.recruitment_source,
    policy_version: row.policy_version,
    policyVersion: row.policy_version,
    source_device_id: row.source_device_id,
    sourceDeviceId: row.source_device_id,
    active_personal_skill_version_id: row.active_personal_skill_version_id,
    activePersonalSkillVersionId: row.active_personal_skill_version_id,
  };
}

async function materializeMemoryDocument(client, userId, id, payload) {
  const instanceId = field(payload,'user_agent_instance_id','userAgentInstanceId');
  const lifecycleState = field(payload, 'lifecycle_state', 'lifecycleState') || 'active';
  if ((payload.scope || 'general') === 'general' && lifecycleState === 'active') {
    await client.query(`UPDATE cloud_memory_documents_v3 SET lifecycle_state='inactive'
      WHERE user_id=$1 AND user_agent_instance_id=$2 AND scope='general' AND lifecycle_state='active' AND id<>$3`, [
      userId, instanceId, id,
    ]);
  }
  return client.query(`INSERT INTO cloud_memory_documents_v3 (
    user_id,id,user_agent_instance_id,agent_family_id,cloud_key,scope,slot_no,display_name,task_run_id,project_id,relationship_id,
    delegation_id,group_id,relationship_user_id,context_space_id,
    visibility,source_conversation_cursor,encryption_key_id,consent_scope_json,current_version_id,lifecycle_state,sync_enabled,
    allow_personal_evolution,allow_cluster_evolution,payload_json,created_at,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25::jsonb,$26,$27)
  ON CONFLICT(user_id,id) DO UPDATE SET agent_family_id=excluded.agent_family_id,lifecycle_state=excluded.lifecycle_state,
    sync_enabled=excluded.sync_enabled,allow_personal_evolution=excluded.allow_personal_evolution,
    allow_cluster_evolution=excluded.allow_cluster_evolution,consent_scope_json=excluded.consent_scope_json,
    payload_json=excluded.payload_json,updated_at=excluded.updated_at`, [
    userId,id,instanceId,canonicalEmployeeAgentFamilyId(field(payload,'agent_family_id','agentFamilyId')),
    field(payload,'cloud_key','cloudKey') || id,payload.scope || 'general',Number(payload.slot_no ?? payload.slotNo ?? 0),
    field(payload, 'display_name', 'displayName') || 'memory0.md',
    field(payload, 'task_run_id', 'taskRunId'), field(payload, 'project_id', 'projectId'), field(payload, 'relationship_id', 'relationshipId'),
    field(payload,'delegation_id','delegationId'),field(payload,'group_id','groupId'),field(payload,'relationship_user_id','relationshipUserId'),
    field(payload, 'context_space_id', 'contextSpaceId'), normalizeCloudMemoryVisibility(payload.visibility),
    field(payload, 'source_conversation_cursor', 'sourceConversationCursor'), field(payload, 'encryption_key_id', 'encryptionKeyId'),
    JSON.stringify(payload.consent_scope_json ?? payload.consentScope ?? {}), '',
    lifecycleState, bool(payload.sync_enabled ?? payload.syncEnabled, true),
    bool(payload.allow_personal_evolution ?? payload.allowPersonalEvolution), bool(payload.allow_cluster_evolution ?? payload.allowClusterEvolution),
    JSON.stringify(payload), entityTimestamp(payload), entityTimestamp(payload),
  ]);
}

function materializeTaskSecurity(client, userId, payload) {
  return client.query(`INSERT INTO cloud_task_security_contexts_v5 (
    user_id,task_run_id,owner_user_id,local_key_id,cloud_key_id,key_version,cloud_evolution_allowed,
    cloud_collaboration_allowed,cloud_sync_recovery_allowed,local_envelope_state,cloud_envelope_state,status,payload_json,created_at,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
  ON CONFLICT(user_id,task_run_id) DO UPDATE SET key_version=excluded.key_version,
    cloud_evolution_allowed=excluded.cloud_evolution_allowed,cloud_collaboration_allowed=excluded.cloud_collaboration_allowed,
    cloud_sync_recovery_allowed=excluded.cloud_sync_recovery_allowed,cloud_envelope_state=excluded.cloud_envelope_state,
    status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at`, [
    userId, field(payload, 'task_run_id', 'taskRunId'), field(payload, 'owner_user_id', 'ownerUserId') || userId,
    field(payload, 'local_key_id', 'localKeyId'), field(payload, 'cloud_key_id', 'cloudKeyId'), Number(payload.key_version ?? payload.keyVersion ?? 1),
    bool(payload.cloud_evolution_allowed ?? payload.cloudEvolutionAllowed), bool(payload.cloud_collaboration_allowed ?? payload.cloudCollaborationAllowed),
    bool(payload.cloud_sync_recovery_allowed ?? payload.cloudSyncRecoveryAllowed, true),
    field(payload, 'local_envelope_state', 'localEnvelopeState') || 'device_local_only',
    field(payload, 'cloud_envelope_state', 'cloudEnvelopeState') || 'disabled', payload.status || 'active', JSON.stringify(payload),
    entityTimestamp(payload), entityTimestamp(payload),
  ]);
}

async function renumberMemoryVersion(client, userId, id, payload) {
  const documentId = field(payload, 'memory_document_id', 'memoryDocumentId');
  const versionNo = Number(payload.version_no ?? payload.versionNo ?? 1);
  const collision = (await client.query(`SELECT id FROM cloud_memory_document_versions_v3
    WHERE user_id=$1 AND memory_document_id=$2 AND version_no=$3 AND id!=$4`, [userId, documentId, versionNo, id])).rows[0];
  if (!collision) return payload;
  const next = Number((await client.query(`SELECT COALESCE(MAX(version_no),0)+1 AS value
    FROM cloud_memory_document_versions_v3 WHERE user_id=$1 AND memory_document_id=$2`, [userId, documentId])).rows[0]?.value || 1);
  return { ...payload, version_no: next, versionNo: next, server_renumbered_from: versionNo };
}

async function resolveCloudConversationAliasTarget(client, userId, value, { forbiddenAliasId = '', apiError } = {}) {
  let currentId = String(value || '').trim();
  const visited = new Set(forbiddenAliasId ? [String(forbiddenAliasId)] : []);
  for (let depth = 0; currentId && depth < 128; depth += 1) {
    if (visited.has(currentId)) throw apiError('conversation_alias_cycle', 'Conversation alias cycle detected.', 409);
    visited.add(currentId);
    const row = (await client.query(`SELECT canonical_conversation_id FROM cloud_conversation_aliases_v7
      WHERE user_id=$1 AND alias_conversation_id=$2`, [userId, currentId])).rows[0];
    const nextId = String(row?.canonical_conversation_id || '').trim();
    if (!nextId) return currentId;
    currentId = nextId;
  }
  if (currentId) throw apiError('conversation_alias_depth_exceeded', 'Conversation alias chain is too deep.', 409);
  return '';
}

async function canonicalInstanceId(client, userId, value) {
  return (await client.query(`SELECT canonical_instance_id FROM cloud_user_agent_instance_aliases_v3
    WHERE user_id=$1 AND alias_instance_id=$2`, [userId, value])).rows[0]?.canonical_instance_id || value;
}

async function materializeAgentInstanceAlias(client, userId, id, payload = {}) {
  const aliasId = String(field(payload, 'alias_instance_id', 'aliasInstanceId') || id || '').trim();
  let canonicalId = String(field(payload, 'canonical_instance_id', 'canonicalInstanceId') || '').trim();
  if (!aliasId || !canonicalId || aliasId === canonicalId) throw syncAliasError(
    'agent_instance_alias_invalid', 'Agent instance alias mapping is invalid.',
  );
  const visited = new Set([aliasId]);
  for (let depth = 0; canonicalId && depth < 128; depth += 1) {
    if (visited.has(canonicalId)) throw syncAliasError('agent_instance_alias_cycle', 'Agent instance alias cycle detected.');
    visited.add(canonicalId);
    const next = String((await client.query(`SELECT canonical_instance_id FROM cloud_user_agent_instance_aliases_v3
      WHERE user_id=$1 AND alias_instance_id=$2`, [userId, canonicalId])).rows[0]?.canonical_instance_id || '').trim();
    if (!next) break;
    canonicalId = next;
  }
  if (visited.size >= 128) throw syncAliasError('agent_instance_alias_depth_exceeded', 'Agent instance alias chain is too deep.');
  const aliasInstance = (await client.query(`SELECT agent_family_id FROM cloud_user_agent_instances_v3
    WHERE user_id=$1 AND id=$2`, [userId, aliasId])).rows[0];
  const canonicalInstance = (await client.query(`SELECT agent_family_id FROM cloud_user_agent_instances_v3
    WHERE user_id=$1 AND id=$2`, [userId, canonicalId])).rows[0];
  if (aliasInstance && canonicalInstance
    && canonicalEmployeeAgentFamilyId(aliasInstance.agent_family_id) !== canonicalEmployeeAgentFamilyId(canonicalInstance.agent_family_id)) {
    throw syncAliasError('agent_instance_alias_boundary', 'Agent instance alias crosses Agent family boundaries.');
  }
  return client.query(`INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id,reason)
    VALUES($1,$2,$3,$4) ON CONFLICT(user_id,alias_instance_id) DO UPDATE SET canonical_instance_id=excluded.canonical_instance_id,
    reason=excluded.reason`, [userId, aliasId, canonicalId, payload.reason || 'client_alias']);
}

function syncAliasError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}
async function canonicalDocumentId(client, userId, value) {
  return (await client.query(`SELECT canonical_document_id FROM cloud_memory_document_aliases_v3
    WHERE user_id=$1 AND alias_document_id=$2`, [userId, value])).rows[0]?.canonical_document_id || value;
}
async function documentIdForCloudKey(client, userId, value) {
  if (!value) return '';
  return (await client.query(`SELECT memory_document_id FROM cloud_memory_sync_mappings
    WHERE owner_user_id=$1 AND cloud_key=$2 ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1`, [userId,value])).rows[0]?.memory_document_id || '';
}

function contextIdentity(payload = {}) {
  return [
    field(payload,'user_agent_instance_id','userAgentInstanceId'),field(payload,'context_kind','contextKind'),
    field(payload,'memory_document_id','memoryDocumentId'),field(payload,'project_id','projectId'),
    field(payload,'task_run_id','taskRunId'),field(payload,'delegation_id','delegationId'),
    field(payload,'group_id','groupId'),field(payload,'relationship_user_id','relationshipUserId'),
  ];
}

async function reconcileServerSkillActivation(client, userId, payload) {
  const instanceId = field(payload, 'user_agent_instance_id', 'userAgentInstanceId');
  if (!instanceId) return;
  const rows = (await client.query(`SELECT entity_id,payload_json FROM cloud_sync_entities_v6
    WHERE user_id=$1 AND entity_type='user_agent_skill_version' AND deleted=false`, [userId])).rows
    .filter((row) => field(row.payload_json, 'user_agent_instance_id', 'userAgentInstanceId') === instanceId)
    .filter((row) => field(row.payload_json, 'activated_at', 'activatedAt'))
    .sort((left, right) => {
      const activation = field(right.payload_json, 'activated_at', 'activatedAt').localeCompare(field(left.payload_json, 'activated_at', 'activatedAt'));
      if (activation) return activation;
      const updated = entityTimestamp(right.payload_json).localeCompare(entityTimestamp(left.payload_json));
      return updated || String(right.entity_id).localeCompare(String(left.entity_id));
    });
  if (rows[0]) await client.query(`UPDATE cloud_user_agent_instances_v3 SET active_personal_skill_version_id=$1,updated_at=now()
    WHERE user_id=$2 AND id=$3`, [rows[0].entity_id, userId, instanceId]);
}

function normalizeChange(input, { batchId, index, legacyCompat, apiError }) {
  const entityType = text(input?.entityType || input?.entity_type, 100);
  const entityId = text(input?.entityId || input?.entity_id, 255);
  const operation = String(input?.operation || 'upsert');
  const payload = input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
  if (!entityType || !entityId) throw apiError('sync_change_identity_required', 'Sync changes require entityType and entityId.', 400);
  if (!Object.values(V5_COLLECTIONS).includes(entityType) && entityType !== 'file_object') {
    throw apiError('sync_entity_type_unsupported', `Unsupported Sync V6 entity type: ${entityType}`, 400);
  }
  if (!['upsert', 'delete'].includes(operation)) throw apiError('sync_operation_invalid', 'Sync operation must be upsert or delete.', 400);
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_CHANGE_BYTES) throw apiError('sync_change_too_large', 'Sync change payload is too large.', 413);
  const occurredAt = validDate(input.occurredAt || input.occurred_at) || new Date().toISOString();
  return {
    changeId: text(input.changeId || input.change_id || `${legacyCompat ? 'legacy' : 'change'}_${sha256(`${batchId}:${index}:${entityType}:${entityId}`).slice(0, 40)}`, 255),
    entityType, entityId, operation, baseRevision: Math.max(0, Number(input.baseRevision ?? input.base_revision ?? 0) || 0),
    occurredAt, payload, contentHash: text(input.contentHash || input.content_hash, 128),
  };
}

function changePayload(row = {}) {
  const requiredCapabilities = requiredCapabilitiesForEntity(row.entity_type);
  return { changeId: row.change_id, sequenceId: String(row.sequence_id), entityType: row.entity_type, entityId: row.entity_id,
    operation: row.operation, baseRevision: Number(row.base_revision || 0), revision: Number(row.revision || 0),
    contentHash: row.content_hash || '', occurredAt: row.occurred_at, acceptedAt: row.accepted_at,
    minimumProtocolVersion: minimumProtocolForEntity(row.entity_type), requiredCapabilities, payload: row.payload_json || {} };
}
function requiredCapabilitiesForEntity(entityType = '') {
  const required = new Set(DATABASE_SYNC_CAPABILITIES);
  if (ACCOUNT_WORKSPACE_SCOPED_TYPES.has(entityType)) required.add('account-workspace-v2');
  if (['conversation', 'conversation_alias', 'message', 'chat_context_state'].includes(entityType)) required.add('conversation-identity-phase6');
  if (['user_agent_instance', 'agent_instance_alias', 'agent_context_space', 'agent_context_state', 'memory_document'].includes(entityType)) {
    required.add('canonical-agent-identity-v1');
  }
  if (entityType === 'conversation_alias') required.add('agent-single-window-continuity-v1');
  return [...required].sort();
}
function minimumProtocolForEntity(entityType = '') {
  return DATABASE_SYNC_PROTOCOL_VERSION;
}
function changeSupportedByClient(row = {}, client = {}) {
  const entityType = String(row.entityType || row.entity_type || '');
  const minimumProtocolVersion = Number(row.minimumProtocolVersion || row.minimum_protocol_version || minimumProtocolForEntity(entityType));
  if (Number(client.syncProtocolVersion || 0) < minimumProtocolVersion) return false;
  const capabilities = new Set(Array.isArray(client.capabilities) ? client.capabilities : []);
  const required = Array.isArray(row.requiredCapabilities) ? row.requiredCapabilities
    : Array.isArray(row.required_capabilities) ? row.required_capabilities
      : requiredCapabilitiesForEntity(entityType);
  return required.every((capability) => capabilities.has(capability));
}
function compatibleClientContract(client = {}) {
  if (client.contractVersion) return client;
  return {
    ...client,
    syncProtocolVersion: DATABASE_SYNC_PROTOCOL_VERSION,
    capabilities: [...DATABASE_SYNC_CAPABILITIES],
  };
}
function batchResponse(row = {}, conflicts = [], duplicate = false) {
  return { status: row.status, schemaVersion: 6, batchId: row.id, cursor: String(row.accepted_cursor || ''),
    itemCount: Number(row.item_count || 0), conflictCount: Number(row.conflict_count || 0), conflicts, duplicate };
}
function conflictResult(conflict) { return { accepted: null, conflict }; }
function assertBatchDevice(grant, input, apiError) {
  const claimedUser = String(input.device?.userId || input.device?.user_id || '').trim();
  const claimedDevice = String(input.device?.deviceId || input.device?.device_id || '').trim();
  if (claimedUser && claimedUser !== grant.userId) throw apiError('sync_user_spoofed', 'Sync batch user does not match the Device Grant.', 403);
  if (claimedDevice && claimedDevice !== grant.deviceId) throw apiError('sync_device_spoofed', 'Sync batch device does not match the Device Grant.', 403);
}
function ownedPayload(type, payload, userId) {
  if (!USER_SCOPED_TYPES.has(type)) return { ...payload };
  return { ...payload, user_id: userId, userId };
}
function entityIdFor(type, row = {}) {
  if (type === 'task_security_context') return field(row, 'task_run_id', 'taskRunId');
  if (type === 'agent_instance_alias') return field(row, 'alias_instance_id', 'aliasInstanceId');
  if (type === 'memory_document_alias') return field(row, 'alias_document_id', 'aliasDocumentId');
  if (type === 'memory_sync_mapping') return field(row, 'cloud_key', 'cloudKey');
  if (type === 'agent_context_state') return field(row, 'user_agent_instance_id', 'userAgentInstanceId') || String(row.id || '').trim();
  if (type === 'chat_context_state') return String(row.id || '').trim();
  return String(row.id || row.sha256 || '').trim();
}
function deletedOperation(type, payload) { return ['conversation', 'project'].includes(type) && payload.status === 'deleted' ? 'delete' : 'upsert'; }
function entityTimestamp(row = {}, fallback = '') { return validDate(row.updated_at || row.updatedAt || row.created_at || row.createdAt || fallback) || new Date().toISOString(); }
function validDate(value) { const time = Date.parse(String(value || '')); return Number.isFinite(time) ? new Date(time).toISOString() : ''; }
function field(row, snake, camel) { return String(row?.[snake] ?? row?.[camel] ?? '').trim(); }
function setField(row, snake, value) { return { ...row, [snake]: value, [snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]: value }; }
function bool(value, fallback = false) { return value === undefined || value === null ? fallback : Boolean(Number(value) || value === true); }
function text(value, max = 255) { return String(value || '').trim().slice(0, max); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function parseCursor(value, apiError) { const parsed = Number(value || 0); if (!Number.isSafeInteger(parsed) || parsed < 0) throw apiError('sync_cursor_invalid', 'Sync cursor is invalid.', 400); return parsed; }
function stableJson(value) { return JSON.stringify(sortValue(value)); }
function entityContentHash(entityType, change, payload) {
  const declared = change.contentHash || field(payload, 'content_hash', 'contentHash');
  if (declared) return declared;
  if (entityType === 'user_agent_skill_version') {
    const skillHash = field(payload, 'overlay_hash', 'overlayHash') || field(payload, 'effective_skill_hash', 'effectiveSkillHash');
    if (skillHash) return skillHash;
  }
  return sha256(stableJson(payload));
}
function sortValue(value) { if (Array.isArray(value)) return value.map(sortValue); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])); }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
async function acquireAdvisoryLock(client, key) {
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  } catch (error) {
    if (!/hashtextextended|pg_advisory_xact_lock/i.test(String(error?.message || ''))) throw error;
  }
}
async function inTransaction(pool, callback) { const client = await pool.connect(); try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
