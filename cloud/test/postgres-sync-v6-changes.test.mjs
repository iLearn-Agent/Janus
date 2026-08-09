import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DataType, newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createSyncV6Service } from '../src/modules/sync/syncV6.mjs';

test('Sync V6 converts complete V5 batches, preserves same-Family instances and Memory, and preserves conflicts', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  memory.public.registerFunction({ name: 'hashtextextended', args: [DataType.text,DataType.integer], returns: DataType.bigint, implementation: () => 1 });
  memory.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.bigint], returns: DataType.integer, implementation: () => 1 });
  memory.public.registerFunction({ name: 'nullif', args: [DataType.text,DataType.text], returns: DataType.text, implementation: (left, right) => left === right ? null : left });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await pool.query(`INSERT INTO account_workspaces(id,workspace_kind,name,status)
    VALUES('workspace_personal','personal','个人空间','active') ON CONFLICT(id) DO NOTHING`);
  await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash) VALUES
    ('user_a','user_a@example.test','User A','user_a','test-hash'),
    ('user_b','user_b@example.test','User B','user_b','test-hash')`);
  await pool.query(`INSERT INTO cloud_agent_families_v3(
    id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,quota_cost
  ) VALUES('family_1','general','Family','agent','active',true,'version_1','employee',true,1)`);
  await pool.query(`INSERT INTO cloud_user_agent_instances_v3(
    user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,state_revision,policy_version,
    personal_evolution_consent,cluster_contribution_consent
  ) VALUES('user_a','instance_cloud','family_1','version_1','active','employee','active',false,1,'employee_cloud_authority_v1',true,true)`);
  const service = createSyncV6Service({ pool, apiError, env: { JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '0' } });
  const grantA = { userId: 'user_a', deviceId: 'device_a', scopes: ['sync:*'] };

  const first = await service.submitBatch(grantA, v5Batch({
    batchId: 'batch_1', deviceId: 'device_a', instanceId: 'instance_cloud', documentId: 'memory_cloud',
    memoryVersionId: 'memory_version_1', memoryVersionNo: 1,
  }));
  assert.equal(first.status, 'accepted');
  assert.equal(first.conflictCount, 0);
  assert.ok(Number(first.cursor) > 0);

  await pool.query(`INSERT INTO cloud_user_agent_instances_v3(
    user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,state_revision,policy_version,payload_json,
    personal_evolution_consent,cluster_contribution_consent
  ) VALUES('user_a','instance_other','family_1','version_1','active','employee','active',false,1,'employee_cloud_authority_v1',$1::jsonb,true,true)`, [
    JSON.stringify({ familyInstanceSeq: 2, displayName: 'Family B' }),
  ]);
  const second = await service.submitBatch(grantA, v5Batch({
    batchId: 'batch_2', deviceId: 'device_a', instanceId: 'instance_other', documentId: 'memory_other',
    memoryVersionId: 'memory_version_2', memoryVersionNo: 1,
  }));
  assert.equal(second.conflictCount, 0);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM cloud_user_agent_instance_aliases_v3 WHERE user_id='user_a' AND alias_instance_id='instance_other'")).rows[0].count), 0);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM cloud_memory_document_aliases_v3 WHERE user_id='user_a' AND alias_document_id='memory_other'")).rows[0].count), 0);
  const memoryVersions = (await pool.query("SELECT id,memory_document_id,version_no FROM cloud_memory_document_versions_v3 WHERE user_id='user_a' ORDER BY id")).rows;
  assert.deepEqual(memoryVersions.map((row) => [row.id, row.memory_document_id, Number(row.version_no)]), [
    ['memory_version_1', 'memory_cloud', 1], ['memory_version_2', 'memory_other', 1],
  ]);
  const taskEvent = (await pool.query("SELECT * FROM cloud_task_events WHERE id='event_batch_1'")).rows[0];
  assert.equal(taskEvent.task_node_id, 'node_batch_1');
  assert.equal(taskEvent.event_type, 'node_completed');
  assert.equal(taskEvent.user_agent_instance_id, 'instance_cloud');
  const contextState = (await pool.query(`SELECT * FROM cloud_agent_context_states
    WHERE owner_user_id='user_a' AND user_agent_instance_id='instance_cloud'`)).rows[0];
  assert.equal(contextState.active_memory_document_id, 'memory_cloud');
  assert.equal(Number(contextState.state_revision), 1);
  await pool.query(`INSERT INTO cloud_conversations_v6(
    user_id,id,revision,conversation_role,write_state,superseded_by_session_id,payload_json
  ) VALUES
    ('user_a','agent_history',1,'history','read_only','agent_primary',$1::jsonb),
    ('user_a','agent_primary',1,'primary','writable','',$2::jsonb)`, [
    JSON.stringify({ id: 'agent_history', agentInstanceId: 'instance_cloud', status: 'active', updatedAt: '2026-01-02T00:00:00.000Z' }),
    JSON.stringify({ id: 'agent_primary', agentInstanceId: 'instance_cloud', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' }),
  ]);
  const contextEntityRevision = Number((await pool.query(`SELECT revision FROM cloud_sync_entities_v6
    WHERE user_id='user_a' AND entity_type='agent_context_state' AND entity_id='instance_cloud'`)).rows[0].revision);
  const canonicalContext = await service.submitBatch(grantA, {
    batchId: 'batch_context_primary_canonical', changes: [{
      changeId: 'change_context_primary_canonical', entityType: 'agent_context_state', entityId: 'instance_cloud',
      operation: 'upsert', baseRevision: contextEntityRevision, occurredAt: new Date().toISOString(), payload: {
        id: 'instance_cloud', user_agent_instance_id: 'instance_cloud', primary_conversation_id: 'agent_history',
        active_context_space_id: contextState.active_context_space_id,
        active_memory_document_id: contextState.active_memory_document_id,
        base_state_revision: Number(contextState.state_revision),
      },
    }],
  });
  assert.equal(canonicalContext.conflictCount, 0);
  assert.equal((await pool.query(`SELECT primary_conversation_id FROM cloud_agent_context_states
    WHERE owner_user_id='user_a' AND user_agent_instance_id='instance_cloud'`)).rows[0].primary_conversation_id, 'agent_primary');
  const redirected = await service.submitBatch(grantA, {
    batchId: 'batch_stale_primary_write', changes: [
      {
        changeId: 'change_stale_primary_conversation', entityType: 'conversation', entityId: 'agent_history',
        operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
          id: 'agent_history', agentInstanceId: 'instance_cloud', conversationRole: 'primary', writeState: 'writable',
          status: 'active', updatedAt: new Date().toISOString(),
        },
      },
      {
        changeId: 'change_stale_primary_message', entityType: 'message', entityId: 'stale_primary_message',
        operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
          id: 'stale_primary_message', conversationId: 'agent_history', agentInstanceId: 'instance_cloud',
          role: 'user', content: 'must follow the canonical primary', createdAt: new Date().toISOString(),
        },
      },
      {
        changeId: 'change_stale_primary_execution', entityType: 'model_execution', entityId: 'stale_primary_execution',
        operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
          id: 'stale_primary_execution', conversationId: 'agent_history', status: 'completed', updatedAt: new Date().toISOString(),
        },
      },
      {
        changeId: 'change_stale_primary_file', entityType: 'file_ref', entityId: 'stale_primary_file',
        operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
          id: 'stale_primary_file', conversationId: 'agent_history', messageId: 'stale_primary_message', updatedAt: new Date().toISOString(),
        },
      },
      {
        changeId: 'change_stale_primary_chat_context', entityType: 'chat_context_state', entityId: 'stale_primary_chat_context',
        operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
          id: 'stale_primary_chat_context', session_id: 'agent_history', context_space_id: '', context_epoch: 1,
          base_state_revision: 0, updated_at: new Date().toISOString(),
        },
      },
    ],
  });
  assert.equal(redirected.conflictCount, 0, JSON.stringify(redirected.conflicts));
  for (const type of ['message', 'model_execution', 'file_ref']) {
    const item = redirected.acceptedChanges.find((change) => change.entityType === type);
    assert.equal(item.payload.conversationId, 'agent_primary');
  }
  assert.equal(redirected.acceptedChanges.find((change) => change.entityType === 'chat_context_state').payload.sessionId, 'agent_primary');
  assert.ok(redirected.acceptedChanges.some((change) => change.entityType === 'conversation'
    && change.entityId === 'agent_primary' && change.payload.updatedAt));
  assert.equal((await pool.query("SELECT payload_json->>'conversationId' conversation_id FROM cloud_messages_v6 WHERE user_id='user_a' AND id='stale_primary_message'")).rows[0].conversation_id, 'agent_primary');
  assert.equal((await pool.query("SELECT payload_json->>'conversationId' conversation_id FROM cloud_model_executions_v6 WHERE user_id='user_a' AND id='stale_primary_execution'")).rows[0].conversation_id, 'agent_primary');
  assert.equal((await pool.query("SELECT payload_json->>'conversationId' conversation_id FROM cloud_file_refs_v6 WHERE user_id='user_a' AND id='stale_primary_file'")).rows[0].conversation_id, 'agent_primary');
  assert.equal((await pool.query("SELECT session_id FROM cloud_chat_context_states WHERE owner_user_id='user_a' AND id='stale_primary_chat_context'")).rows[0].session_id, 'agent_primary');
  const chatContextState = (await pool.query("SELECT * FROM cloud_chat_context_states WHERE owner_user_id='user_a' AND id='chatctx_1'")).rows[0];
  assert.equal(Number(chatContextState.context_epoch), 2);
  assert.equal(Number(chatContextState.state_revision), 2);

  const canonicalChatContext = await service.submitBatch(grantA, {
    batchId: 'batch_chat_context_canonical', changes: [{
      changeId: 'change_chat_context_canonical', entityType: 'chat_context_state', entityId: 'chatctx_other_device',
      operation: 'upsert', baseRevision: 2, occurredAt: new Date().toISOString(), payload: {
        id: 'chatctx_other_device', session_id: 'conversation_1', context_space_id: '', context_epoch: 3,
        reset_after_message_id: 'message_batch_2', reset_after_created_at: new Date().toISOString(),
        base_state_revision: 2,
      },
    }],
  });
  assert.equal(canonicalChatContext.conflictCount, 0);
  const canonicalChatContextRows = (await pool.query(`SELECT id,context_epoch,state_revision FROM cloud_chat_context_states
    WHERE owner_user_id='user_a' AND session_id='conversation_1' AND context_space_id=''`)).rows;
  assert.deepEqual(canonicalChatContextRows.map((row) => [row.id, Number(row.context_epoch), Number(row.state_revision)]), [
    ['chatctx_1', 3, 3],
  ]);

  const pulled = await service.changes(grantA, { cursor: first.cursor, limit: 100 });
  assert.ok(pulled.changes.some((item) => item.entityType === 'user_agent_instance' && item.entityId === 'instance_other'));
  assert.ok(pulled.changes.some((item) => item.entityType === 'memory_document' && item.entityId === 'memory_other'));
  assert.ok(pulled.changes.some((item) => item.entityType === 'memory_document_version'
    && item.entityId === 'memory_version_2' && item.payload.version_no === 1));

  const project = (await pool.query("SELECT revision FROM cloud_sync_entities_v6 WHERE user_id='user_a' AND entity_type='project' AND entity_id='project_1'")).rows[0];
  const conflict = await service.submitBatch(grantA, {
    batchId: 'batch_conflict', changes: [{ changeId: 'change_conflict', entityType: 'project', entityId: 'project_1',
      operation: 'upsert', baseRevision: Number(project.revision) - 1, occurredAt: new Date().toISOString(), payload: { id: 'project_1', title: 'stale' } }],
  });
  assert.equal(conflict.conflictCount, 1);
  assert.equal(conflict.conflicts[0].kind, 'base_revision_mismatch');

  const immutable = await service.submitBatch(grantA, {
    batchId: 'batch_immutable', changes: [{ changeId: 'change_immutable', entityType: 'agent_version', entityId: 'version_1',
      operation: 'upsert', baseRevision: 1, occurredAt: new Date().toISOString(), payload: { id: 'version_1', agent_family_id: 'family_1', content_hash: 'different' } }],
  });
  assert.equal(immutable.conflicts[0].kind, 'immutable_id_hash_mismatch');

  const instanceRevision = (await pool.query(`SELECT revision FROM cloud_sync_entities_v6
    WHERE user_id='user_a' AND entity_type='user_agent_instance' AND entity_id='instance_cloud'`)).rows[0];
  const lifecycle = await service.submitBatch(grantA, {
    batchId: 'batch_lifecycle', changes: [{ changeId: 'change_lifecycle', entityType: 'user_agent_instance', entityId: 'instance_cloud',
      operation: 'upsert', baseRevision: Number(instanceRevision.revision), occurredAt: new Date().toISOString(), payload: {
        id: 'instance_cloud', agent_family_id: 'family_1', status: 'inactive', employment_state: 'inactive',
        instance_kind: 'governance', state_revision: 99,
      } }],
  });
  assert.equal(lifecycle.conflictCount, 0);
  const protectedInstance = (await pool.query("SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id='user_a' AND id='instance_cloud'")).rows[0];
  assert.equal(protectedInstance.status, 'active');
  assert.equal(protectedInstance.employment_state, 'active');
  assert.equal(protectedInstance.instance_kind, 'employee');
  assert.equal(Number(protectedInstance.state_revision), 1);

  await pool.query(`INSERT INTO cloud_agent_families_v3(
    id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,quota_cost
  ) VALUES('ppt_research_scout','ppt_department','Legacy PPT Scout','agent','retired',false,'','unavailable',false,0)`);
  await pool.query(`INSERT INTO cloud_user_agent_instances_v3(
    user_id,id,agent_family_id,status,instance_kind,employment_state,quota_exempt,state_revision,policy_version,
    personal_evolution_consent,cluster_contribution_consent
  ) VALUES('user_a','legacy_ppt_instance','ppt','active','employee','active',false,4,'employee_cloud_authority_v1',true,true)`);
  const legacyPptUpload = await service.submitBatch(grantA, {
    batchId: 'batch_legacy_ppt_upload',
    changes: [
      {
        changeId: 'change_legacy_ppt_family', entityType: 'agent_family', entityId: 'ppt_research_scout',
        operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(),
        payload: {
          id: 'ppt_research_scout', department_id: 'ppt_department', name: 'Legacy PPT Scout',
          role: 'agent', status: 'active', routable: true, instance_kind: 'employee', recruitable: true,
        },
      },
      {
        changeId: 'change_legacy_ppt_version', entityType: 'agent_version', entityId: 'legacy_ppt_version',
        operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(),
        payload: { id: 'legacy_ppt_version', agent_family_id: 'ppt_research_scout', content_hash: 'legacy_ppt_hash' },
      },
      {
        changeId: 'change_legacy_ppt_instance', entityType: 'user_agent_instance', entityId: 'legacy_ppt_instance',
        operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(),
        payload: {
          id: 'legacy_ppt_instance', agent_family_id: 'ppt_research_scout',
          base_agent_version_id: 'legacy_ppt_version', status: 'active', instance_kind: 'employee', sync_enabled: true,
        },
      },
    ],
  });
  assert.equal(legacyPptUpload.conflictCount, 0, JSON.stringify(legacyPptUpload.conflicts));
  const legacyPptFamily = (await pool.query("SELECT status,routable,recruitable FROM cloud_agent_families_v3 WHERE id='ppt_research_scout'")).rows[0];
  assert.deepEqual(legacyPptFamily, { status: 'retired', routable: false, recruitable: false });
  assert.equal((await pool.query("SELECT agent_family_id FROM cloud_agent_versions_v3 WHERE id='legacy_ppt_version'")).rows[0].agent_family_id, 'ppt');
  assert.equal((await pool.query("SELECT agent_family_id FROM cloud_user_agent_instances_v3 WHERE user_id='user_a' AND id='legacy_ppt_instance'")).rows[0].agent_family_id, 'ppt');

  const duplicateLegacyPptUpload = await service.submitBatch(grantA, {
    batchId: 'batch_duplicate_legacy_ppt_upload',
    changes: [{
      changeId: 'change_duplicate_legacy_ppt_instance', entityType: 'user_agent_instance', entityId: 'legacy_ppt_instance_other',
      operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(),
      payload: {
        id: 'legacy_ppt_instance_other', agent_family_id: 'ppt_research_scout',
        base_agent_version_id: 'legacy_ppt_version', status: 'active', instance_kind: 'employee', sync_enabled: true,
      },
    }],
  });
  assert.equal(duplicateLegacyPptUpload.conflictCount, 0);
  assert.equal((await pool.query(`SELECT canonical_instance_id FROM cloud_user_agent_instance_aliases_v3
    WHERE user_id='user_a' AND alias_instance_id='legacy_ppt_instance_other'`)).rows[0].canonical_instance_id, 'legacy_ppt_instance');
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM cloud_user_agent_instances_v3 WHERE user_id='user_a' AND agent_family_id='ppt_research_scout'")).rows[0].count), 0);

  await assert.rejects(service.submitBatch(grantA, {
    batchId: 'batch_agent_alias_cycle',
    changes: [{
      changeId: 'change_agent_alias_cycle', entityType: 'agent_instance_alias', entityId: 'legacy_ppt_instance',
      operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
        alias_instance_id: 'legacy_ppt_instance', canonical_instance_id: 'legacy_ppt_instance_other', reason: 'cycle_fixture',
      },
    }],
  }), (error) => error.code === 'agent_instance_alias_cycle');
  assert.equal(Number((await pool.query(`SELECT COUNT(*) count FROM cloud_user_agent_instance_aliases_v3
    WHERE user_id='user_a' AND alias_instance_id='legacy_ppt_instance'`)).rows[0].count), 0,
  'a rejected reverse Agent alias must not be materialized');

  const grantB = { userId: 'user_b', deviceId: 'device_b', scopes: ['sync:*'] };
  assert.equal((await service.changes(grantB, { cursor: '', limit: 100 })).changes.length, 0);
  await assert.rejects(service.submitBatch(grantA, { ...v5Batch({ batchId: 'spoof', deviceId: 'device_b' }),
    device: { userId: 'user_b', deviceId: 'device_b' } }), (error) => error.code === 'sync_user_spoofed');
});

function v5Batch({ batchId, deviceId, instanceId = 'instance_cloud', documentId = 'memory_cloud', memoryVersionId = 'memory_version_1', memoryVersionNo = 1 }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 5,
    batch: { id: batchId, generatedAt: now, cursorFrom: '', cursorTo: now },
    device: { userId: 'user_a', deviceId },
    data: {
      projects: [{ id: 'project_1', title: `Project ${batchId}`, updatedAt: now }],
      conversations: [{ id: 'conversation_1', projectId: 'project_1', status: 'active', updatedAt: now }],
      messages: [{ id: `message_${batchId}`, conversationId: 'conversation_1', role: 'user', content: batchId, createdAt: now }],
      codexTranscripts: [{ id: `transcript_${batchId}`, conversationId: 'conversation_1', role: 'assistant', content: batchId, createdAt: now }],
      modelExecutions: [{ id: `execution_${batchId}`, conversationId: 'conversation_1', status: 'completed', updatedAt: now }],
      fileRefs: [{ id: `file_ref_${batchId}`, sha256: 'a'.repeat(64), conversationId: 'conversation_1', updatedAt: now }],
      agentFamilies: [{ id: 'family_1', department_id: 'general', name: 'Family', role: 'agent', updated_at: now }],
      agentVersions: [{ id: 'version_1', agent_family_id: 'family_1', content_hash: 'base_hash', created_at: now }],
      userAgentInstances: [{ id: instanceId, agent_family_id: 'family_1', base_agent_version_id: 'version_1', sync_enabled: 1, updated_at: now }],
      userAgentSkillVersions: [{ id: `skill_${batchId}`, user_agent_instance_id: instanceId, overlay_hash: batchId, created_at: now }],
      memoryDocuments: [{ id: documentId, user_agent_instance_id: instanceId, scope: 'general', slot_no: 0, display_name: 'memory0.md', updated_at: now }],
      memoryDocumentVersions: [{ id: memoryVersionId, memory_document_id: documentId, version_no: memoryVersionNo, content_hash: batchId, content: batchId, created_at: now }],
      agentContextSpaces: [{ id: `context_${batchId}`, user_agent_instance_id: instanceId, context_kind: 'general_memory', memory_document_id: documentId, updated_at: now }],
      agentContextStates: [{ id: instanceId, user_agent_instance_id: instanceId, active_context_space_id: `context_${batchId}`,
        active_memory_document_id: documentId, base_state_revision: batchId === 'batch_1' ? 0 : 1, updated_at: now }],
      chatContextStates: [{ id: 'chatctx_1', session_id: 'conversation_1', context_space_id: '',
        context_epoch: batchId === 'batch_1' ? 1 : 2, reset_after_message_id: `message_${batchId}`,
        reset_after_created_at: now, base_state_revision: batchId === 'batch_1' ? 0 : 1, updated_at: now }],
      taskSecurityContexts: [{ task_run_id: 'task_1', owner_user_id: 'user_a', local_key_id: 'local', cloud_key_id: 'cloud', key_version: 1, cloud_sync_recovery_allowed: true, updated_at: now }],
      personalEvolutionProposals: [{ id: `proposal_${batchId}`, user_agent_instance_id: instanceId, agent_family_id: 'family_1', updated_at: now }],
      personalEvolutionMemoryOperations: [{ id: `operation_${batchId}`, proposal_id: `proposal_${batchId}`, memory_document_id: documentId, updated_at: now }],
      taskRuns: [{ id: 'task_1', owner_user_id: 'user_a', updated_at: now }],
      taskNodes: [{ id: `node_${batchId}`, task_run_id: 'task_1', agent_instance_id: instanceId, updated_at: now }],
      taskEvents: [{ id: `event_${batchId}`, task_run_id: 'task_1', task_node_id: `node_${batchId}`,
        event_type: 'node_completed', user_agent_instance_id: instanceId, created_at: now }],
      communications: [{ id: `communication_${batchId}`, task_run_id: 'task_1', created_at: now }],
    },
    files: [{ sha256: 'a'.repeat(64), sizeBytes: 12, localPath: 'outputs/result.txt' }],
  };
}

function apiError(code, message, status) { const error = new Error(message); error.code = code; error.status = status; return error; }
