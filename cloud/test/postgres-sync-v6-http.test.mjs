import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { signAccessToken } from '../src/security.mjs';
import { createMemoryObjectStore } from '../src/modules/sync/objectStore.mjs';
import { deviceGrantProofMessage, rsaPublicKeyFingerprint } from '../../src/shared/taskMemoryCrypto.js';
import { DATABASE_MIGRATION_IDS } from '../../src/main/modules/persistence/infrastructure/databaseMigrationRegistry.js';
import {
  DATABASE_SYNC_BASE_CAPABILITIES,
  DATABASE_SYNC_BASE_PROTOCOL_VERSION,
  DATABASE_SYNC_MINIMUM_APP_VERSION,
  DATABASE_SYNC_PROTOCOL_VERSION,
  createDatabaseClientContract,
  databaseContractQuery,
} from '../../src/shared/databaseEvolutionContract.js';

test('production Sync V6 HTTP routes automatically authorize two authenticated devices and isolate their changes', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await migrate(pool);
  const jwtSecret = 'sync-v6-http-test-secret-with-at-least-32-chars';
  const config = { jwtSecret, accessTokenTtlSeconds: 900, refreshTokenTtlDays: 30, emailCodeTtlMinutes: 10, emailCodeSecret: jwtSecret,
    env: { JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY: '1', JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '1' } };
  const objectStore = createMemoryObjectStore();
  const app = createApp({ pool, config, objectStore, mailer: { async sendEmailCode() {} } });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await pool.query(`INSERT INTO account_workspaces(id,workspace_kind,name,status)
    VALUES('workspace_personal','personal','Personal','active')`);
  for (const userId of ['user_a', 'user_b']) {
    await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash,email_verified)
      VALUES($1,$2,$3,$4,'hash',true)`, [userId, `${userId}@example.test`, userId, userId]);
  }
  await pool.query(`INSERT INTO cloud_agent_families_v3(
    id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,default_for_new_user,quota_cost
  ) VALUES('orphan_family','general','Orphan Family','agent','active',false,'orphan_v1','unavailable',false,false,0)`);
  const accessA = signAccessToken({ userId: 'user_a', secret: jwtSecret });
  const accessB = signAccessToken({ userId: 'user_b', secret: jwtSecret });
  const first = deviceIdentity();
  const second = deviceIdentity();

  assert.equal((await json(base, '/api/device-grants/register', {
    method: 'POST', token: accessA, body: { deviceId: 'device_1', publicKey: first.publicKey },
  })).status, 'approved');
  assert.equal((await json(base, '/api/device-grants/register', {
    method: 'POST', token: accessA, body: { deviceId: 'device_2', publicKey: second.publicKey },
  })).status, 'approved');
  const firstScopes = ['sync:read', 'sync:write', 'sync:files', 'sync:keys', 'devices:approve', 'employees:read', 'employees:write',
    'evolution:read', 'evolution:write'];
  const firstGrant = await json(base, '/api/device-grants/device_1/token', {
    method: 'POST', token: accessA,
    body: { scopes: firstScopes, proof: signProof(first, 'user_a', 'device_1', firstScopes) },
  });
  assert.ok(firstGrant.token);
  const employeeCapabilities = await json(base, '/v1/employees/capabilities', { token: firstGrant.token });
  assert.equal(employeeCapabilities.lifecycleMutation, 'command_only');
  const employeeBootstrap = await json(base, '/v1/employees/bootstrap', {
    method: 'POST', token: firstGrant.token, body: { bootstrapId: 'http_employee_bootstrap', instances: [] },
  });
  assert.equal(employeeBootstrap.roster.length, 1);
  assert.equal(employeeBootstrap.systemRoster.length, 1);
  const secondScopes = ['sync:read', 'sync:write', 'sync:files', 'sync:keys'];
  const secondGrant = await json(base, '/api/device-grants/device_2/token', {
    method: 'POST', token: accessA,
    body: { scopes: secondScopes, proof: signProof(second, 'user_a', 'device_2', secondScopes) },
  });
  assert.ok(secondGrant.token);
  const clientContract = createDatabaseClientContract({ appVersion: DATABASE_SYNC_MINIMUM_APP_VERSION, migrationIds: DATABASE_MIGRATION_IDS });
  const contractQuery = new URLSearchParams(databaseContractQuery(clientContract)).toString();
  const legacyV6ContractQuery = new URLSearchParams(databaseContractQuery({
    ...clientContract,
    syncProtocolVersion: DATABASE_SYNC_BASE_PROTOCOL_VERSION,
    capabilities: [...DATABASE_SYNC_BASE_CAPABILITIES],
  })).toString();
  assert.equal((await json(base, '/v1/sync/v6/capabilities', { token: firstGrant.token }))
    .databaseCompatibility.compatible, false);
  const currentCapabilities = await json(base, `/v1/sync/v6/capabilities?${contractQuery}`, { token: firstGrant.token });
  assert.equal(currentCapabilities.databaseCompatibility.compatible, true);
  assert.deepEqual(currentCapabilities.supportedAccountKinds, ['personal']);
  assert.equal(currentCapabilities.organizationCoreSync, false);
  assert.equal((await json(base, `/v1/sync/v6/capabilities?${legacyV6ContractQuery}`, { token: firstGrant.token }))
    .databaseCompatibility.compatible, false);
  const rejectedChanges = await jsonResponse(base, '/v1/sync/v6/changes?cursor=0&limit=100', { token: firstGrant.token });
  assert.equal(rejectedChanges.status, 409);
  assert.equal(rejectedChanges.payload.error.code, 'sync_client_contract_required');
  assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_sync_device_cursors_v8 WHERE user_id='user_a' AND device_id='device_1'")).rows[0].count), 0,
    'an incompatible pull must not advance or create the device cursor');

  await pool.query(`INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status)
    VALUES('account_org_http_test','organization','user_a','http_test','HTTP Organization','active')`);
  await pool.query(`INSERT INTO account_memberships_v8(account_id,user_id,role,status)
    VALUES('account_org_http_test','user_a','owner','active')`);
  const unsupportedOrganizationBatch = await jsonResponse(base, '/v1/sync/v6/batches', {
    method: 'POST', token: secondGrant.token, body: {
      clientContract, accountId: 'account_org_http_test', schemaVersion: 8, batchId: 'http_organization_batch', changes: [],
    },
  });
  assert.equal(unsupportedOrganizationBatch.status, 409);
  assert.equal(unsupportedOrganizationBatch.payload.error.code, 'sync_account_kind_unsupported');
  const unsupportedOrganizationPull = await jsonResponse(base,
    `/v1/sync/v6/changes?cursor=0&limit=100&accountId=account_org_http_test&${contractQuery}`, { token: firstGrant.token });
  assert.equal(unsupportedOrganizationPull.status, 409);
  assert.equal(unsupportedOrganizationPull.payload.error.code, 'sync_account_kind_unsupported');
  assert.equal(Number((await pool.query("SELECT COUNT(*) count FROM cloud_sync_batches_v8 WHERE id='http_organization_batch'")).rows[0].count), 0);
  assert.equal(Number((await pool.query(`SELECT COUNT(*) count FROM cloud_sync_device_cursors_v8
    WHERE account_id='account_org_http_test'`)).rows[0].count), 0,
  'an unsupported organization request must not accept a batch or advance a cursor');

  const missingDependencyBatch = await json(base, '/v1/sync/v6/batches', {
    method: 'POST', token: secondGrant.token, body: {
      clientContract,
      schemaVersion: 6, batchId: 'http_missing_employee_dependency',
      changes: [
        { changeId: 'promote_orphan_family', entityType: 'agent_family', entityId: 'orphan_family', operation: 'upsert',
          baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
            id: 'orphan_family', departmentId: 'general', name: 'Orphan Family', role: 'agent', status: 'active',
            routable: 1, instanceKind: 'employee', recruitable: 1, quotaCost: 1, currentVersionId: 'orphan_v1',
          } },
        { changeId: 'missing_employee_instance', entityType: 'user_agent_instance', entityId: 'local_pending_employee', operation: 'upsert',
          baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
            id: 'local_pending_employee', agentFamilyId: 'orphan_family', instanceKind: 'employee', status: 'active',
          } },
        { changeId: 'missing_employee_memory', entityType: 'memory_document', entityId: 'local_pending_memory', operation: 'upsert',
          baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
            id: 'local_pending_memory', userAgentInstanceId: 'local_pending_employee', agentFamilyId: 'orphan_family', scope: 'general', slotNo: 0,
          } },
        { changeId: 'missing_employee_memory_version', entityType: 'memory_document_version', entityId: 'local_pending_memory_v1', operation: 'upsert',
          baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
            id: 'local_pending_memory_v1', memoryDocumentId: 'local_pending_memory', versionNo: 1, contentHash: 'pending-memory-hash',
          } },
      ],
    },
  });
  assert.equal(missingDependencyBatch.status, 'accepted_with_conflicts');
  assert.deepEqual(missingDependencyBatch.conflicts.map((item) => item.kind), [
    'employee_bootstrap_required', 'memory_instance_dependency_missing', 'memory_document_dependency_missing',
  ]);
  const promotedFamily = (await pool.query("SELECT instance_kind,recruitable,routable,quota_cost FROM cloud_agent_families_v3 WHERE id='orphan_family'")).rows[0];
  assert.deepEqual(promotedFamily, { instance_kind: 'employee', recruitable: true, routable: true, quota_cost: 1 });

  const legacyGeneralBatch = await json(base, '/v1/sync/v6/batches', {
    method: 'POST', token: secondGrant.token, body: {
      clientContract,
      schemaVersion: 6, batchId: 'http_legacy_general_catalog_revival',
      changes: [{
        changeId: 'legacy_general_family_revival', entityType: 'agent_family', entityId: 'general_agent_1', operation: 'upsert',
        baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
          id: 'general_agent_1', departmentId: 'general', name: '通用 Agent 1', role: 'agent', status: 'active',
          routable: true, instanceKind: 'employee', recruitable: true, defaultForNewUser: true, quotaCost: 1,
        },
      }],
    },
  });
  assert.equal(legacyGeneralBatch.conflictCount, 0);
  assert.deepEqual((await pool.query(`SELECT name,status,routable,instance_kind,recruitable,default_for_new_user,quota_cost
    FROM cloud_agent_families_v3 WHERE id='general_agent_1'`)).rows[0], {
    name: 'Generalist', status: 'retired', routable: false, instance_kind: 'unavailable', recruitable: false,
    default_for_new_user: false, quota_cost: 0,
  });

  const largeEnvelope = await json(base, '/v1/sync/v6/batches', {
    method: 'POST', token: secondGrant.token, body: {
      clientContract,
      schemaVersion: 6, batchId: 'http_large_json_envelope', padding: 'x'.repeat(80 * 1024), changes: [],
    },
  });
  assert.equal(largeEnvelope.conflictCount, 0);

  const batch = await json(base, '/v1/sync/v6/batches', {
    method: 'POST', token: secondGrant.token, body: {
      clientContract,
      schemaVersion: 6, batchId: 'http_batch',
      changes: [{ changeId: 'http_project_change', entityType: 'project', entityId: 'project_http', operation: 'upsert',
        baseRevision: 0, occurredAt: new Date().toISOString(), payload: { id: 'project_http', title: 'HTTP project' } }],
    },
  });
  assert.equal(batch.conflictCount, 0);
  const changes = await json(base, `/v1/sync/v6/changes?cursor=0&limit=100&${contractQuery}`, { token: firstGrant.token });
  const projectChange = changes.changes.find((item) => item.entityId === 'project_http');
  assert.ok(projectChange);
  assert.equal(projectChange.minimumProtocolVersion, DATABASE_SYNC_PROTOCOL_VERSION);
  assert.ok(projectChange.requiredCapabilities.includes('account-workspace-v2'));
  assert.ok(projectChange.requiredCapabilities.includes('staged-sync-v6'));
  assert.ok(projectChange.requiredCapabilities.includes('account-principal-isolation-v1'));
  assert.ok(projectChange.requiredCapabilities.includes('account-scoped-cursor-v1'));

  const evidenceInstanceId = (await pool.query(`SELECT id FROM cloud_user_agent_instances_v3
    WHERE user_id='user_a' AND agent_family_id='general_agent'`)).rows[0].id;
  const conversationCollision = await json(base, '/v1/sync/v6/batches', {
    method: 'POST', token: secondGrant.token, body: {
      clientContract, schemaVersion: 6, batchId: 'http_conversation_projected_collision',
      changes: [
        { changeId: 'http_conversation_snake_primary', entityType: 'conversation', entityId: 'conversation_snake_primary',
          operation: 'upsert', baseRevision: 0, occurredAt: '2026-01-01T00:00:00.000Z', payload: {
            id: 'conversation_snake_primary', agent_instance_id: evidenceInstanceId, account_workspace_id: 'workspace_personal',
            conversation_role: 'primary', write_state: 'writable', status: 'active',
          } },
        { changeId: 'http_conversation_second_primary', entityType: 'conversation', entityId: 'conversation_second_primary',
          operation: 'upsert', baseRevision: 0, occurredAt: '2026-02-01T00:00:00.000Z', payload: {
            id: 'conversation_second_primary', agentInstanceId: evidenceInstanceId, accountWorkspaceId: 'workspace_personal',
            conversationRole: 'primary', writeState: 'writable', status: 'active',
          } },
        { changeId: 'http_conversation_delete_snake', entityType: 'conversation', entityId: 'conversation_snake_primary',
          operation: 'delete', baseRevision: 1, occurredAt: '2026-03-01T00:00:00.000Z', payload: {
            id: 'conversation_snake_primary', agent_instance_id: evidenceInstanceId, account_workspace_id: 'workspace_personal',
            conversation_role: 'primary', write_state: 'writable', status: 'deleted',
          } },
        { changeId: 'http_conversation_replacement_primary', entityType: 'conversation', entityId: 'conversation_replacement_primary',
          operation: 'upsert', baseRevision: 0, occurredAt: '2026-04-01T00:00:00.000Z', payload: {
            id: 'conversation_replacement_primary', agentInstanceId: evidenceInstanceId, accountWorkspaceId: 'workspace_personal',
            conversationRole: 'primary', writeState: 'writable', status: 'active',
          } },
      ],
    },
  });
  assert.equal(conversationCollision.conflictCount, 0);
  assert.deepEqual((await pool.query(`SELECT id,conversation_role,write_state FROM cloud_conversations_v6
    WHERE user_id='user_a' AND id IN ('conversation_second_primary','conversation_replacement_primary') ORDER BY id`)).rows, [
    { id: 'conversation_replacement_primary', conversation_role: 'primary', write_state: 'writable' },
    { id: 'conversation_second_primary', conversation_role: 'history', write_state: 'read_only' },
  ]);
  assert.deepEqual((await pool.query(`SELECT alias_conversation_id,canonical_conversation_id
    FROM cloud_conversation_aliases_v7 WHERE user_id='user_a' ORDER BY alias_conversation_id`)).rows, [
    { alias_conversation_id: 'conversation_second_primary', canonical_conversation_id: 'conversation_snake_primary' },
    { alias_conversation_id: 'conversation_snake_primary', canonical_conversation_id: 'conversation_replacement_primary' },
  ]);
  const generatedAliases = conversationCollision.acceptedChanges.filter((change) => change.entityType === 'conversation_alias');
  assert.equal(generatedAliases.length, 2);
  assert.ok(generatedAliases.every((change) => change.minimumProtocolVersion === DATABASE_SYNC_PROTOCOL_VERSION
    && change.requiredCapabilities.includes('agent-single-window-continuity-v1')));
  const blockedLegacyPull = await jsonResponse(base, `/v1/sync/v6/changes?cursor=0&limit=100&${legacyV6ContractQuery}`, {
    token: secondGrant.token,
  });
  assert.equal(blockedLegacyPull.status, 409);
  assert.equal(blockedLegacyPull.payload.error.code, 'sync_client_incompatible');
  assert.equal(Number((await pool.query(`SELECT COUNT(*) count FROM cloud_sync_device_cursors_v8
    WHERE user_id='user_a' AND device_id='device_2'`)).rows[0].count), 0,
  'a V6 client blocked by a V7-only alias must not advance its device cursor');
  const aliasCycle = await jsonResponse(base, '/v1/sync/v6/batches', {
    method: 'POST', token: secondGrant.token, body: {
      clientContract, schemaVersion: 6, batchId: 'http_conversation_alias_cycle',
      changes: [{
        changeId: 'http_conversation_alias_cycle_change', entityType: 'conversation_alias',
        entityId: 'conversation_replacement_primary', operation: 'upsert', baseRevision: 0,
        occurredAt: '2026-05-01T00:00:00.000Z', payload: {
          id: 'conversation_replacement_primary', aliasConversationId: 'conversation_replacement_primary',
          canonicalConversationId: 'conversation_second_primary', accountWorkspaceId: 'workspace_personal',
          conversationKind: 'direct', agentInstanceId: evidenceInstanceId,
        },
      }],
    },
  });
  assert.equal(aliasCycle.status, 409);
  assert.equal(aliasCycle.payload.error.code, 'conversation_alias_cycle');
  assert.equal(Number((await pool.query(`SELECT COUNT(*) count FROM cloud_conversation_aliases_v7
    WHERE user_id='user_a' AND alias_conversation_id='conversation_replacement_primary'`)).rows[0].count), 0);

  await pool.query(`UPDATE cloud_user_agent_instances_v3 SET status='active',sync_enabled=true,personal_evolution_consent=true
    WHERE user_id='user_a' AND id=$1`, [evidenceInstanceId]);
  const evidenceInput = {
    clientRecordId: 'pg_outbox_message', userAgentInstanceId: evidenceInstanceId, sourceKind: 'message',
    sourceId: 'pg_message', content: 'PostgreSQL authoritative message Evidence.', allowedEvolutionScopes: ['personal'],
  };
  const deferredEvidence = await json(base, '/v1/evolution/evidence/batch', {
    method: 'POST', token: firstGrant.token, body: { items: [evidenceInput] },
  });
  assert.equal(deferredEvidence.results[0].status, 'deferred');
  assert.equal(deferredEvidence.results[0].code, 'evidence_source_not_ready');
  await pool.query(`INSERT INTO cloud_messages_v6(user_id,id,payload_json)
    VALUES('user_a','pg_message',$1::jsonb)`, [JSON.stringify({ agentInstanceId: evidenceInstanceId })]);
  const acceptedEvidence = await json(base, '/v1/evolution/evidence/batch', {
    method: 'POST', token: firstGrant.token, body: { items: [evidenceInput] },
  });
  assert.equal(acceptedEvidence.results[0].status, 'accepted');
  const duplicateEvidence = await json(base, '/v1/evolution/evidence/batch', {
    method: 'POST', token: firstGrant.token, body: { items: [evidenceInput] },
  });
  assert.equal(duplicateEvidence.results[0].status, 'duplicate');

  const authoritativeMemory = 'PostgreSQL authoritative Memory.';
  await pool.query(`INSERT INTO cloud_memory_documents_v3
    (user_id,id,user_agent_instance_id,current_version_id,sync_enabled,allow_personal_evolution,allow_cluster_evolution,
     scope,slot_no,task_run_id,payload_json)
    VALUES('user_a','pg_memory',$1,'pg_memory_v1',true,true,true,'task',0,'pg_memory_task','{}'::jsonb)`, [evidenceInstanceId]);
  await pool.query(`INSERT INTO cloud_memory_document_versions_v3
    (user_id,id,memory_document_id,content_hash,payload_json)
    VALUES('user_a','pg_memory_v1','pg_memory',$1,'{}'::jsonb)`, [crypto.createHash('sha256').update(authoritativeMemory).digest('hex')]);
  const mismatchedMemory = await json(base, '/v1/evolution/evidence/batch', {
    method: 'POST', token: firstGrant.token, body: { items: [{
      clientRecordId: 'pg_outbox_memory', userAgentInstanceId: evidenceInstanceId, sourceKind: 'memory_version',
      sourceId: 'pg_memory', sourceVersionId: 'pg_memory_v1', content: 'tampered PostgreSQL Memory',
      allowedEvolutionScopes: ['personal'],
    }] },
  });
  assert.equal(mismatchedMemory.results[0].status, 'rejected');
  assert.equal(mismatchedMemory.results[0].code, 'evidence_source_hash_mismatch');

  await pool.query("INSERT INTO cloud_task_runs(id,owner_user_id,payload_json) VALUES('pg_task','user_a','{}'::jsonb)");
  await pool.query(`INSERT INTO cloud_task_nodes(id,task_run_id,user_agent_instance_id,payload_json)
    VALUES('pg_node','pg_task',$1,'{}'::jsonb)`, [evidenceInstanceId]);
  const taskInput = { clientRecordId: 'pg_outbox_task', userAgentInstanceId: evidenceInstanceId, sourceKind: 'task_result',
    sourceId: 'pg_node', taskId: 'pg_task', content: 'PostgreSQL task result Evidence.', allowedEvolutionScopes: ['personal'] };
  const taskWithoutEvent = await json(base, '/v1/evolution/evidence/batch', {
    method: 'POST', token: firstGrant.token, body: { items: [taskInput] },
  });
  assert.equal(taskWithoutEvent.results[0].status, 'rejected');
  assert.equal(taskWithoutEvent.results[0].code, 'evidence_source_version_required');
  await pool.query(`INSERT INTO cloud_task_events(id,task_run_id,task_node_id,event_type,owner_user_id,user_agent_instance_id,payload_json)
    VALUES('pg_event','pg_task','pg_node','node_completed','user_a',$1,'{}'::jsonb)`, [evidenceInstanceId]);
  const acceptedTask = await json(base, '/v1/evolution/evidence/batch', {
    method: 'POST', token: firstGrant.token, body: { items: [{ ...taskInput, sourceVersionId: 'pg_event' }] },
  });
  assert.equal(acceptedTask.results[0].status, 'accepted');
  const usage = await json(base, `/v1/evolution/evidence/usage?agentInstanceId=${encodeURIComponent(evidenceInstanceId)}&scope=personal&limit=10`, { token: firstGrant.token });
  assert.equal(usage.items.length, 2);
  assert.ok(usage.items.every((item) => !Object.hasOwn(item, 'content') && !Object.hasOwn(item, 'contentCiphertext')));

  const fileBody = Buffer.from('http object route');
  const fileHash = crypto.createHash('sha256').update(fileBody).digest('hex');
  const initiated = await json(base, '/v1/sync/v6/files/initiate', {
    method: 'POST', token: secondGrant.token, body: { sha256: fileHash, sizeBytes: fileBody.length, contentType: 'text/plain' },
  });
  objectStore.put({ objectKey: initiated.objectKey, body: fileBody, contentType: 'text/plain' });
  assert.equal((await json(base, '/v1/sync/v6/files/complete', {
    method: 'POST', token: secondGrant.token, body: { sha256: fileHash },
  })).status, 'verified');
  const metrics = await json(base, '/v1/sync/v6/metrics', { token: firstGrant.token });
  assert.equal(metrics.changeCount, 9,
    'the accepted catalog promotion, rejected legacy Generalist revival, project change, four conversation changes, and two aliases should be counted');
  assert.equal(metrics.storage.verifiedBytes, fileBody.length);
  assert.equal(metrics.activeDeviceCount, 2);

  const other = deviceIdentity();
  await json(base, '/api/device-grants/register', { method: 'POST', token: accessB, body: { deviceId: 'device_b', publicKey: other.publicKey } });
  const otherScopes = ['sync:read'];
  const otherGrant = await json(base, '/api/device-grants/device_b/token', {
    method: 'POST', token: accessB, body: { scopes: otherScopes, proof: signProof(other, 'user_b', 'device_b', otherScopes) },
  });
  assert.equal((await json(base, `/v1/sync/v6/changes?cursor=0&limit=100&${contractQuery}`, { token: otherGrant.token })).changes.length, 0);
  const otherMetrics = await json(base, '/v1/sync/v6/metrics', { token: otherGrant.token });
  assert.equal(otherMetrics.changeCount, 0);
  assert.deepEqual(otherMetrics.storage, { verifiedBytes: 0, pendingBytes: 0 });
});

async function json(base, route, { method = 'GET', token = '', body } = {}) {
  const { response, payload } = await jsonResponse(base, route, { method, token, body });
  assert.ok(response.ok, `${method} ${route} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

async function jsonResponse(base, route, { method = 'GET', token = '', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, status: response.status, payload };
}

function deviceIdentity() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  return { publicKey, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint: rsaPublicKeyFingerprint(publicKey) };
}
function signProof(identity, userId, deviceId, scopes) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const message = deviceGrantProofMessage({ userId, deviceId, scopes, timestamp, nonce });
  return { timestamp, nonce, publicKeyFingerprint: identity.fingerprint,
    signature: crypto.sign('sha256', Buffer.from(message), identity.privateKey).toString('base64') };
}
