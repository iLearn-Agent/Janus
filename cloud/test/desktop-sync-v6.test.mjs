import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { CloudSyncService } from '../../src/main/cloudSync.js';
import { openDatabase } from '../../src/main/db.js';
import { migrateDatabase } from '../../src/main/modules/persistence/index.js';
import { Store } from '../../src/main/store.js';
import { wrapTaskKeyForDevice } from '../../src/shared/taskMemoryCrypto.js';

test('desktop Sync V6 bootstraps a Device Grant, applies remote records, and restores a task key locally', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-sync-v6-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_user','sync-v6@example.test','Sync V6','sync_v6','remote_user',?,1)`).run(new Date().toISOString());

  let registeredPublicKey = '';
  let taskDataKey = null;
  const submittedBatches = [];
  const client = {
    async registerDevice(_state, payload) { registeredPublicKey = payload.publicKey; return { deviceId: payload.deviceId, status: 'approved' }; },
    async issueDeviceGrant(_state, deviceId, payload) { return { token: 'device_grant_token', deviceId, scopes: payload.scopes }; },
    async rewrapTaskKey(_state, payload) {
      return { taskRunId: payload.taskRunId, keyVersion: payload.keyVersion, deviceId: 'device_1',
        ...wrapTaskKeyForDevice(taskDataKey, { publicKey: registeredPublicKey }) };
    },
    async syncV6Capabilities() { return { schemaVersion: 6, files: { available: true },
      multiMemory: { enabled: true, contractVersion: 2, contextSpaces: true, cloudKeyMappings: true, accountContextState: true, offlineLocalWrites: true },
      employees: { enabled: true, authority: 'cloud', authorityLocked: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' } }; },
    async employeeCapabilities() { return { enabled: true, authority: 'cloud', authorityLocked: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' }; },
    async employeeOverview() { return { authority: 'cloud', bootstrap: { required: false, status: 'completed' }, roster: [], systemRoster: [], quota: { used: 0, limit: 10 }, recruitableFamilies: [] }; },
    async submitV6Batch(_state, payload) { submittedBatches.push(payload); return { status: 'accepted', schemaVersion: 6, cursor: '10' }; },
    async syncV6Changes() { return { schemaVersion: 6, cursor: '10', hasMore: false, resetRequired: true,
      snapshot: { cursor: '10', entities: [change('project', 'project_from_snapshot', {
        id: 'project_from_snapshot', title: 'Restored from snapshot', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })] }, changes: [] }; },
  };
  const sync = new CloudSyncService({
    root, db, store, client, defaultConfig: {},
    authStateProvider: () => ({ access_token: 'access_token', remote_user_id: 'remote_user' }),
  });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_user', deviceId: 'device_1', autoSync: false });
  assert.equal(sync.status().multiMemory.code, 'cloud_sync_pending');
  assert.equal(await sync.ensureDeviceGrant(sync.state()), 'device_grant_token');
  assert.equal(sync.state().device_grant, 'device_grant_token');
  assert.equal(sync.state().evolution_grant, 'device_grant_token');
  assert.match(registeredPublicKey, /BEGIN PUBLIC KEY/);

  const now = new Date().toISOString();
  const changes = [
    change('agent_family', 'family_1', { id: 'family_1', name: 'Cloud Family', department_id: 'general', role: 'agent', routable: true, instance_kind: 'employee', recruitable: true, updated_at: now }),
    change('agent_version', 'version_1', { id: 'version_1', agent_family_id: 'family_1', content_hash: 'version_hash', base_skill_content: '# Skill', created_at: now }),
    change('user_agent_instance', 'instance_1', { id: 'instance_1', agent_family_id: 'family_1', base_agent_version_id: 'version_1', status: 'active', instance_kind: 'employee', employment_state: 'active', updated_at: now }),
    change('memory_document', 'memory_cloud_1', { id: 'memory_cloud_1', cloud_key: 'memory_cloud_key_1', user_agent_instance_id: 'instance_1',
      agent_family_id: 'family_1', scope: 'general', slot_no: 0, display_name: 'memory0.md', current_version_id: 'memory_version_1', lifecycle_state: 'active', updated_at: now }),
    change('memory_document_version', 'memory_version_1', { id: 'memory_version_1', memory_document_id: 'memory_cloud_1', version_no: 1,
      content: '# Cloud memory0', content_hash: 'memory_hash_1', branch_id: 'main', conflict_state: 'none', created_at: now }),
    change('memory_sync_mapping', 'memory_cloud_key_1', { id: 'memory_cloud_key_1', cloud_key: 'memory_cloud_key_1',
      memory_document_id: 'memory_cloud_1', user_agent_instance_id: 'instance_1', status: 'active', updated_at: now }),
    change('agent_context_space', 'context_cloud_1', { id: 'context_cloud_1', user_agent_instance_id: 'instance_1',
      context_kind: 'general_memory', memory_document_id: 'memory_cloud_1', lifecycle_state: 'active', updated_at: now }),
    change('agent_context_state', 'instance_1', { id: 'instance_1', user_agent_instance_id: 'instance_1', primary_conversation_id: 'conversation_1',
      active_context_space_id: 'context_cloud_1', active_memory_document_id: 'memory_cloud_1', state_revision: 1, updated_at: now }),
    change('project', 'project_1', { id: 'project_1', title: 'Remote project', status: 'active', createdAt: now, updatedAt: now }),
    change('conversation', 'conversation_1', { id: 'conversation_1', title: 'Remote chat', projectId: 'project_1', agentId: 'family_1', agentInstanceId: 'instance_1', createdAt: now, updatedAt: now }),
    change('conversation', 'conversation_2', { id: 'conversation_2', title: 'Remote historical chat', agentId: 'family_1', agentInstanceId: 'instance_1', createdAt: now, updatedAt: now }),
    change('message', 'message_1', { id: 'message_1', conversationId: 'conversation_1', role: 'user', content: 'remote message',
      contextSpaceId: 'stale_context_from_another_device', createdAt: now }),
    change('model_execution', 'execution_1', { id: 'execution_1', conversationId: 'conversation_1', status: 'completed', updatedAt: now }),
    change('file_ref', 'file_ref_1', { id: 'file_ref_1', conversationId: 'conversation_1', messageId: 'message_1', updatedAt: now }),
    change('chat_context_state', 'chatctx_remote_1', { id: 'chatctx_remote_1', session_id: 'conversation_1', context_space_id: 'context_cloud_1',
      context_epoch: 2, reset_after_message_id: 'message_1', reset_after_created_at: now, state_revision: 1, updated_at: now }),
  ];
  assert.equal(sync.applyV6Changes(changes, { remoteUserId: 'remote_user' }).status, 'applied');
  assert.equal(db.prepare("SELECT title FROM projects WHERE id='project_1'").get().title, 'Remote project');
  assert.equal(db.prepare("SELECT agent_instance_id FROM sessions WHERE id='conversation_1'").get().agent_instance_id, 'instance_1');
  const historicalConversation = db.prepare("SELECT conversation_role,write_state,superseded_by_session_id FROM sessions WHERE id='conversation_2'").get();
  assert.equal(historicalConversation.conversation_role, 'history');
  assert.equal(historicalConversation.write_state, 'read_only');
  assert.equal(historicalConversation.superseded_by_session_id, 'conversation_1');
  const promotedAt = new Date(Date.parse(now) + 1000).toISOString();
  assert.equal(sync.applyV6Changes([
    change('conversation', 'conversation_1', { id: 'conversation_1', title: 'Remote historical chat', agentId: 'family_1',
      agentInstanceId: 'instance_1', conversationRole: 'history', writeState: 'read_only',
      supersededBySessionId: 'conversation_2', createdAt: now, updatedAt: promotedAt }),
    change('conversation', 'conversation_2', { id: 'conversation_2', title: 'Remote promoted chat', agentId: 'family_1',
      agentInstanceId: 'instance_1', conversationRole: 'primary', writeState: 'writable',
      createdAt: now, updatedAt: promotedAt }),
    change('agent_context_state', 'instance_1', { id: 'instance_1', user_agent_instance_id: 'instance_1',
      primary_conversation_id: 'conversation_1', active_context_space_id: 'context_cloud_1',
      active_memory_document_id: 'memory_cloud_1', state_revision: 2, updated_at: promotedAt }),
  ], { remoteUserId: 'remote_user' }).status, 'applied');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM conversation_aliases WHERE alias_id='conversation_2'").get().count, 0,
    'promoting a writable primary conversation must clear its stale alias');
  const repairedContextState = db.prepare("SELECT * FROM agent_context_state WHERE user_id='local_user' AND user_agent_instance_id='instance_1'").get();
  const conversationState = db.prepare(`SELECT id,conversation_role,write_state,superseded_by_session_id,status
    FROM sessions WHERE id IN ('conversation_1','conversation_2') ORDER BY id`).all();
  assert.equal(repairedContextState.primary_session_id, 'conversation_2', JSON.stringify(conversationState));
  assert.equal(repairedContextState.sync_status, 'pending');
  assert.equal(Number(repairedContextState.base_state_revision), 2);
  assert.equal(Number(repairedContextState.state_revision), 3);
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='message_1'").get().content, 'remote message');
  assert.equal(db.prepare("SELECT context_space_id FROM messages WHERE id='message_1'").get().context_space_id, '');
  assert.equal(sync.applyV6Changes([
    change('message', 'message_1', { id: 'message_1', conversationId: 'conversation_2', role: 'user', content: 'remote message',
      contextSpaceId: 'context_cloud_1', createdAt: now }),
    change('model_execution', 'execution_1', { id: 'execution_1', conversationId: 'conversation_2', status: 'completed', updatedAt: now }),
    change('file_ref', 'file_ref_1', { id: 'file_ref_1', conversationId: 'conversation_2', messageId: 'message_1', updatedAt: now }),
  ], { remoteUserId: 'remote_user' }).status, 'applied');
  assert.equal(db.prepare("SELECT session_id FROM messages WHERE id='message_1'").get().session_id, 'conversation_2');
  assert.equal(db.prepare("SELECT conversation_id FROM model_executions WHERE id='execution_1'").get().conversation_id, 'conversation_2');
  assert.equal(db.prepare("SELECT session_id FROM cloud_file_refs WHERE id='file_ref_1'").get().session_id, 'conversation_2');
  assert.equal(db.prepare("SELECT context_epoch FROM chat_context_states WHERE id='chatctx_remote_1'").get().context_epoch, 2);
  db.prepare("UPDATE memory_sync_mappings SET device_id='other_device' WHERE cloud_key='memory_cloud_key_1'").run();
  assert.equal(sync.applyV6Changes([
    change('memory_sync_mapping', 'memory_cloud_key_duplicate', { id: 'memory_cloud_key_duplicate', cloud_key: 'memory_cloud_key_1',
      memory_document_id: 'memory_cloud_1', user_agent_instance_id: 'instance_1', status: 'active', updated_at: now }),
  ], { remoteUserId: 'remote_user' }).status, 'applied');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_sync_mappings WHERE cloud_key='memory_cloud_key_1'").get().count, 1);
  assert.equal(sync.applyV6Changes([
    change('chat_context_state', 'chatctx_other_device', { id: 'chatctx_other_device', session_id: 'conversation_1', context_space_id: 'context_cloud_1',
      context_epoch: 3, reset_after_message_id: 'message_1', reset_after_created_at: now, state_revision: 2, updated_at: now }),
  ], { remoteUserId: 'remote_user' }).status, 'applied');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM chat_context_states WHERE owner_user_id='local_user' AND session_id='conversation_1' AND context_space_id='context_cloud_1'").get().count, 1);
  assert.equal(db.prepare("SELECT context_epoch FROM chat_context_states WHERE id='chatctx_remote_1'").get().context_epoch, 3);
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,email_verified)
    VALUES('other_local_user','other-local@example.test','Other Local','other_local',1)`).run();
  store.ensureUserAgentInstance({
    id: 'other_local_instance', userId: 'other_local_user', agentFamilyId: 'family_1', baseAgentVersionId: 'version_1',
    creationMode: 'explicit_recruitment', recruitmentSource: 'test',
  });
  const foreignResult = sync.applyV6Changes([
    change('conversation', 'foreign_conversation', { id: 'foreign_conversation', userId: 'other_local_user',
      title: 'Must remain isolated', agentId: 'family_1', agentInstanceId: 'other_local_instance', createdAt: now, updatedAt: now }),
  ], { remoteUserId: 'remote_user' });
  assert.equal(foreignResult.skipped, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id='foreign_conversation'").get().count, 0);
  const cloudMemory = store.listMemoryDocuments({ agentInstanceId: 'instance_1' })[0];
  assert.equal(cloudMemory.cloudKey, 'memory_cloud_key_1');
  assert.equal(store.getAgentContextState({ userId: 'local_user', agentInstanceId: 'instance_1' }).activeMemoryDocumentId, cloudMemory.id);
  const localFirstMemory = store.createAndActivateGeneralMemory({ agentInstanceId: 'instance_1', deviceId: 'device_1' });
  assert.equal(store.getAgentContextState({ userId: 'local_user', agentInstanceId: 'instance_1' }).syncStatus, 'pending');
  assert.equal(store.getDeviceContextState({ deviceId: 'second_device', userId: 'local_user', agentInstanceId: 'instance_1' }).activeMemoryDocumentId, localFirstMemory.id);
  const localChatState = store.getChatContextState({ ownerUserId: 'local_user', sessionId: 'conversation_1', contextSpaceId: 'context_cloud_1' });
  store.resetChatContext({ ownerUserId: 'local_user', sessionId: 'conversation_1', contextSpaceId: 'context_cloud_1',
    commandId: 'desktop_sync_chat_context_reset', expectedStateRevision: localChatState.stateRevision, sourceDeviceId: 'device_1' });
  const privateSession = store.createSession({ id: 'private_context_session', title: 'Private context', departmentId: 'private_assistant', userId: 'local_user' });
  store.recordChatContextUsage({ ownerUserId: 'local_user', sessionId: privateSession.id, executionId: 'private_execution',
    inputTokens: 1000, contextWindowTokens: 128000, sourceDeviceId: 'device_1' });

  const task = store.createTaskRun({
    title: 'Encrypted task', prompt: 'Recover me', departmentId: 'general', leadAgentId: 'family_1',
    leadAgentInstanceId: 'instance_1', ownerUserId: 'local_user',
  });
  const taskMemory = store.ensureTaskMemoryDocument({ agentInstanceId: 'instance_1', taskRunId: task.id, taskTitle: task.title });
  const taskNode = store.createTaskNode({ taskRunId: task.id, title: 'Synchronized terminal event', objective: 'Sync the event.',
    departmentId: 'general', agentId: 'family_1', agentInstanceId: 'instance_1', status: 'running' });
  store.updateTaskNode(taskNode.id, { status: 'completed', resultText: 'Synchronized result', completedAt: now });
  const security = db.prepare('SELECT * FROM task_security_contexts WHERE task_run_id=?').get(task.id);
  taskDataKey = store.taskMemoryKeyring.unwrapTaskKey({
    algorithm: security.local_wrap_algorithm, wrappingKeyId: security.local_wrapping_key_id,
    ciphertext: security.local_wrapped_key, nonce: security.local_wrap_nonce, tag: security.local_wrap_tag,
  }, { taskRunId: task.id, keyVersion: security.key_version });
  assert.ok(db.prepare('SELECT content_ciphertext FROM memory_document_versions WHERE memory_document_id=?').get(taskMemory.id).content_ciphertext);
  db.prepare(`UPDATE task_security_contexts SET local_envelope_state='reference_only',local_wrap_algorithm='',
    local_wrapping_key_id='',local_wrapped_key='',local_wrap_nonce='',local_wrap_tag='',cloud_envelope_state='active',
    cloud_sync_recovery_allowed=1 WHERE task_run_id=?`).run(task.id);
  const recovered = await sync.recoverTaskMemoryKeys(sync.state());
  assert.equal(recovered.recovered, 1);
  assert.equal(db.prepare('SELECT local_envelope_state FROM task_security_contexts WHERE task_run_id=?').get(task.id).local_envelope_state, 'active');
  assert.equal(store.getMemoryDocument(taskMemory.id).content.includes('Encrypted task'), true);
  for (let index = 0; index < 10; index += 1) sync.enqueueV6Outbox(sync.state(), {
    schemaVersion: 6, batch: { id: `older_batch_${index}`, cursorTo: `older_cursor_${index}`, itemCount: 0 },
    device: { userId: 'remote_user', deviceId: 'device_1' }, changes: [{ changeId: `older_change_${index}` }],
  });
  let evolutionSyncCalls = 0;
  sync.syncEvolutionAuthority = async () => { evolutionSyncCalls += 1; return { status: 'synchronized', authority: 'cloud' }; };
  const waitingForSource = await sync.syncNow({ reason: 'desktop_v6_smoke' });
  assert.equal(waitingForSource.status, 'queued');
  assert.equal(waitingForSource.sourceBatchStatus, 'pending');
  assert.equal(waitingForSource.evolution.reason, 'source_sync_pending');
  assert.equal(evolutionSyncCalls, 0, 'Evidence drain must wait for the exact V6 source batch');
  const synchronized = await sync.syncNow({ reason: 'desktop_v6_smoke_retry' });
  assert.equal(synchronized.status, 'completed');
  assert.equal(synchronized.sourceBatchStatus, 'completed');
  assert.equal(evolutionSyncCalls, 1);
  assert.equal(synchronized.schemaVersion, 6);
  assert.equal(sync.state().last_v6_cursor, '10');
  assert.equal(synchronized.snapshotEntityCount, 1);
  assert.equal(db.prepare("SELECT title FROM projects WHERE id='project_from_snapshot'").get().title, 'Restored from snapshot');
  assert.deepEqual(sync.status().multiMemory, { enabled: true, readOnly: false, contractVersion: 2, code: 'cloud_context_space_ready' });
  const sourceBatch = submittedBatches.find((item) => item.changes.some((changeItem) => changeItem.entityType === 'memory_document_version'));
  assert.ok(sourceBatch);
  assert.equal(sourceBatch.schemaVersion, 8);
  assert.ok(sourceBatch.changes.some((item) => item.entityType === 'agent_context_space'));
  assert.ok(sourceBatch.changes.some((item) => item.entityType === 'agent_context_state'));
  assert.ok(sourceBatch.changes.some((item) => item.entityType === 'chat_context_state'));
  assert.equal(sourceBatch.changes.some((item) => item.entityId === privateSession.id
    || item.payload?.session_id === privateSession.id || item.payload?.sessionId === privateSession.id), false,
  'private assistant conversations and context state must stay local');
  const taskEventChange = sourceBatch.changes.find((item) => item.entityType === 'task_event'
    && (item.payload.event_type || item.payload.eventType) === 'node_completed');
  assert.ok(taskEventChange);
  assert.equal(taskEventChange.payload.task_node_id || taskEventChange.payload.taskNodeId, taskNode.id);
  assert.equal(taskEventChange.payload.event_type || taskEventChange.payload.eventType, 'node_completed');
  const mapping = sourceBatch.changes.find((item) => item.entityType === 'memory_sync_mapping');
  assert.ok(mapping);
  assert.equal(Object.hasOwn(mapping.payload, 'private_key'), false);
  assert.equal(Object.hasOwn(mapping.payload, 'device_id'), false);
});

test('desktop Sync V6 applies the cloud employee roster before dependent Memory changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-sync-v6-employee-order-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_employee_user','employee-order@example.test','Employee Order','employee_order','remote_employee_user',?,1)`).run(new Date().toISOString());
  store.upsertAgentFamily({
    id: 'employee_family', name: 'Employee Family', departmentId: 'general', role: 'agent', routable: true,
  });
  const version = store.upsertAgentVersion({
    agent: { id: 'employee_family', name: 'Employee Family', departmentId: 'general', role: 'agent', routable: true,
      baseSkill: '# Employee Skill\n' },
    memoryTemplate: '# Employee Memory\n\n## Stable Learnings\n- None yet.\n',
  });

  const now = new Date().toISOString();
  const calls = [];
  const roster = {
    authority: 'cloud', bootstrap: { required: false, status: 'completed' }, quota: { used: 1, limit: 10 },
    recruitableFamilies: [], systemRoster: [], roster: [{
      id: 'cloud_employee_instance', agentFamilyId: 'employee_family', baseAgentVersionId: version.id,
      status: 'active', instanceKind: 'employee', employmentState: 'active', quotaExempt: false,
      stateRevision: 1, policyVersion: 'employee_cloud_authority_v1', syncEnabled: true,
      personalEvolutionConsent: false, clusterContributionConsent: true, createdAt: now, updatedAt: now,
    }],
  };
  const remoteChanges = [
    change('memory_document', 'cloud_employee_memory', {
      id: 'cloud_employee_memory', cloud_key: 'cloud_employee_memory_key', user_agent_instance_id: 'cloud_employee_instance',
      agent_family_id: 'employee_family', scope: 'general', slot_no: 0, display_name: 'memory0.md',
      current_version_id: 'cloud_employee_memory_v1', lifecycle_state: 'active', updated_at: now,
    }),
    change('memory_document_version', 'cloud_employee_memory_v1', {
      id: 'cloud_employee_memory_v1', memory_document_id: 'cloud_employee_memory', version_no: 1,
      content: '# Cloud Employee Memory', content_hash: 'cloud_employee_memory_hash', branch_id: 'main',
      conflict_state: 'none', created_at: now,
    }),
    change('memory_sync_mapping', 'cloud_employee_memory_key', {
      id: 'cloud_employee_memory_key', cloud_key: 'cloud_employee_memory_key',
      memory_document_id: 'cloud_employee_memory', user_agent_instance_id: 'cloud_employee_instance', status: 'active', updated_at: now,
    }),
    change('agent_context_space', 'cloud_employee_context', {
      id: 'cloud_employee_context', user_agent_instance_id: 'cloud_employee_instance', context_kind: 'general_memory',
      memory_document_id: 'cloud_employee_memory', lifecycle_state: 'active', updated_at: now,
    }),
    change('agent_context_state', 'cloud_employee_instance', {
      id: 'cloud_employee_instance', user_agent_instance_id: 'cloud_employee_instance',
      active_context_space_id: 'cloud_employee_context', active_memory_document_id: 'cloud_employee_memory',
      state_revision: 1, updated_at: now,
    }),
  ];
  const client = {
    async registerDevice() { return { deviceId: 'employee_order_device', status: 'approved' }; },
    async issueDeviceGrant() { return { token: 'employee_order_grant' }; },
    async employeeCapabilities() {
      return { enabled: true, authority: 'cloud', authorityLocked: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' };
    },
    async employeeOverview() { calls.push('employeeOverview'); return roster; },
    async syncV6Capabilities() { return { schemaVersion: 6, files: { available: true } }; },
    async submitV6Batch() { return { status: 'accepted', schemaVersion: 6, cursor: 'employee-order-upload' }; },
    async syncV6Changes() {
      calls.push('syncV6Changes');
      return { schemaVersion: 6, cursor: 'employee-order-cursor', hasMore: false, resetRequired: false, changes: remoteChanges };
    },
  };
  const sync = new CloudSyncService({
    root, db, store, client, defaultConfig: {},
    authStateProvider: () => ({ access_token: 'employee_order_access', remote_user_id: 'remote_employee_user' }),
  });
  sync.syncEvolutionAuthority = async () => ({ status: 'synchronized', authority: 'cloud' });
  sync.saveConfig({
    serverUrl: 'https://cloud.example.test', userId: 'remote_employee_user', deviceId: 'employee_order_device', autoSync: false,
  });

  const result = await sync.syncNow({ reason: 'employee_roster_before_memory' });
  assert.equal(result.status, 'completed', result.error || JSON.stringify(result));
  assert.ok(calls.indexOf('employeeOverview') >= 0);
  assert.ok(calls.indexOf('employeeOverview') < calls.indexOf('syncV6Changes'));
  const instance = store.getUserAgentInstance('cloud_employee_instance');
  assert.equal(instance?.employmentState, 'active');
  const memories = store.listMemoryDocuments({ agentInstanceId: 'cloud_employee_instance' })
    .filter((item) => item.scope === 'general' && item.lifecycleState === 'active');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].cloudKey, 'cloud_employee_memory_key');
  assert.equal(store.getMemoryDocument(memories[0].id).content, '# Cloud Employee Memory');
  const context = store.getAgentContextState({ userId: 'local_employee_user', agentInstanceId: 'cloud_employee_instance' });
  assert.equal(context.activeMemoryDocumentId, memories[0].id);
  assert.equal(context.activeContextSpaceId, 'cloud_employee_context');
  assert.equal(sync.state().last_v6_cursor, 'employee-order-cursor');
  sync.close();
});

test('desktop employee overview preserves the cloud PPT instance ID and canonicalizes legacy outbox commands', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-ppt-employee-canonicalize-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_ppt_user','ppt-canonicalize@example.test','PPT Canonicalize','ppt_canonicalize','remote_ppt_user',?,1)`).run(now);
  store.upsertAgentFamily({
    id: 'ppt', name: 'PPT', departmentId: 'ppt_department', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  store.upsertAgentFamily({
    id: 'ppt_research_scout', name: 'Legacy PPT Scout', departmentId: 'ppt_department', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  db.prepare(`INSERT INTO user_agent_instances(
    id,user_id,agent_family_id,status,instance_kind,employment_state,quota_exempt,state_revision,authority_state
  ) VALUES
    ('local_ppt_instance','local_ppt_user','ppt','active','employee','active',0,1,'migration_grandfathered'),
    ('cloud_ppt_instance','local_ppt_user','ppt_research_scout','inactive','employee','inactive',0,1,'pending')`).run();
  db.prepare(`INSERT INTO employee_command_outbox(
    command_id,user_id,remote_user_id,action,agent_family_id,local_agent_instance_id,proposed_instance_id,
    expected_state_revision,previous_employment_state,payload_json,status,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?, 'pending',?,?)`).run(
    'legacy_ppt_reactivate', 'local_ppt_user', 'remote_ppt_user', 'reactivate', 'ppt_research_scout',
    'cloud_ppt_instance', 'cloud_ppt_instance', 1, 'inactive',
    JSON.stringify({
      commandId: 'legacy_ppt_reactivate', action: 'reactivate', agentFamilyId: 'ppt_research_scout',
      agentInstanceId: 'cloud_ppt_instance', proposedInstanceId: 'cloud_ppt_instance', expectedStateRevision: 1,
    }),
    now, now,
  );
  const sync = new CloudSyncService({
    root, db, store, client: {}, defaultConfig: {},
    authStateProvider: () => ({ access_token: 'ppt_access', remote_user_id: 'remote_ppt_user' }),
  });
  sync.saveConfig({
    serverUrl: 'https://cloud.example.test', userId: 'remote_ppt_user', deviceId: 'ppt_device', autoSync: false,
  });

  sync.applyEmployeeOverview({
    authority: 'cloud', bootstrap: { required: false, status: 'completed' },
    systemRoster: [], recruitableFamilies: [], quota: { used: 1, limit: 10 },
    roster: [{
      id: 'cloud_ppt_instance', agentFamilyId: 'ppt', status: 'active', instanceKind: 'employee',
      employmentState: 'active', stateRevision: 6, policyVersion: 'employee_cloud_authority_v1',
      syncEnabled: true, updatedAt: now,
    }],
  });

  const instances = db.prepare(`SELECT id,agent_family_id FROM user_agent_instances
    WHERE user_id='local_ppt_user' AND agent_family_id IN ('ppt','ppt_research_scout') ORDER BY id`).all();
  assert.deepEqual(instances.map((row) => ({ ...row })), [{ id: 'cloud_ppt_instance', agent_family_id: 'ppt' }]);
  assert.equal(db.prepare(`SELECT canonical_instance_id FROM user_agent_instance_aliases
    WHERE alias_instance_id='local_ppt_instance'`).get().canonical_instance_id, 'cloud_ppt_instance');
  const command = store.getEmployeeCommandOutbox({ userId: 'local_ppt_user', commandId: 'legacy_ppt_reactivate' });
  assert.equal(command.agentFamilyId, 'ppt');
  assert.equal(command.localAgentInstanceId, 'cloud_ppt_instance');
  assert.equal(command.proposedInstanceId, 'cloud_ppt_instance');
  assert.equal(command.expectedStateRevision, 6);
  assert.equal(command.payload.agentFamilyId, 'ppt');
  assert.equal(command.payload.agentInstanceId, 'cloud_ppt_instance');
  sync.close();
});

test('a newer identity snapshot supersedes a stale pending PPT deactivation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-ppt-snapshot-authority-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('user_6968dc2d-bce9-49d0-afac-010f4a3d0b9f','2840213075@example.test','2840213075','2840213075',
      'user_6968dc2d-bce9-49d0-afac-010f4a3d0b9f',?,1)`).run(now);
  store.upsertAgentFamily({
    id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  const version = store.upsertAgentVersion({
    agent: { id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department', role: 'agent', routable: true,
      instanceKind: 'employee', recruitable: true, baseSkill: '# PPT Agent' },
    memoryTemplate: '# PPT memory',
  });
  const instance = store.ensureUserAgentInstance({
    id: 'uagent_b61739a8-fb0d-4714-b41c-ad26875557bd',
    userId: 'user_6968dc2d-bce9-49d0-afac-010f4a3d0b9f', agentFamilyId: 'ppt',
    baseAgentVersionId: version.id, creationMode: 'explicit_recruitment', recruitmentSource: 'test',
  });
  const staged = store.stagePendingEmployeeCommand({
    userId: 'user_6968dc2d-bce9-49d0-afac-010f4a3d0b9f',
    remoteUserId: 'user_6968dc2d-bce9-49d0-afac-010f4a3d0b9f', action: 'deactivate',
    agentFamilyId: 'ppt', agentInstanceId: instance.id, commandId: 'stale_ppt_deactivation',
    expectedStateRevision: instance.stateRevision, sourceDeviceId: 'stale_client',
  });
  const sync = new CloudSyncService({
    root, db, store, client: {}, defaultConfig: {},
    authStateProvider: () => ({
      access_token: 'ppt_access', remote_user_id: 'user_6968dc2d-bce9-49d0-afac-010f4a3d0b9f',
    }),
  });

  const result = sync.applyIdentitySnapshot({ data: { userAgentInstances: [{
    id: instance.id, agentFamilyId: 'ppt', baseAgentVersionId: version.id,
    status: 'active', instanceKind: 'employee', employmentState: 'active', quotaExempt: false,
    stateRevision: 6, policyVersion: 'employee_cloud_authority_v1', syncEnabled: true, updatedAt: now,
  }] } }, { remoteUserId: 'user_6968dc2d-bce9-49d0-afac-010f4a3d0b9f' });

  assert.equal(result.status, 'applied');
  const converged = store.getUserAgentInstance(instance.id);
  assert.equal(converged.employmentState, 'active');
  assert.equal(converged.stateRevision, 6);
  assert.equal(converged.authorityState, 'cloud_confirmed');
  assert.equal(converged.pendingTargetState, '');
  assert.equal(converged.lastEmployeeCommandId, '');
  const outbox = store.getEmployeeCommandOutbox({
    userId: 'user_6968dc2d-bce9-49d0-afac-010f4a3d0b9f', commandId: staged.commandId,
  });
  assert.equal(outbox.status, 'conflict');
  assert.equal(outbox.lastError, 'superseded_by_newer_cloud_snapshot');
  sync.close();
});

test('desktop identity snapshots compact late zero-sequence employee profiles into A/B/C order', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-employee-sequence-compaction-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_compaction','compact@example.test','Compact User','compact_user','remote_compaction',?,1)`).run(now);
  store.upsertAgentFamily({
    id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  const version = store.upsertAgentVersion({
    agent: { id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
      instanceKind: 'employee', recruitable: true, baseSkill: '# Generalist' },
    memoryTemplate: '# Generalist memory',
  });
  const sync = new CloudSyncService({
    root, db, store, client: {}, defaultConfig: {},
    authStateProvider: () => ({ access_token: 'compact_access', remote_user_id: 'remote_compaction' }),
  });

  const instances = ['a', 'b', 'c', 'custom'].map((suffix, index) => ({
    id: `compact_${suffix}`,
    agentFamilyId: 'general_agent',
    baseAgentVersionId: version.id,
    status: 'active',
    instanceKind: 'employee',
    employmentState: 'active',
    familyInstanceSeq: 0,
    displayName: suffix === 'custom' ? 'Operations Lead' : 'Generalist A',
    note: suffix === 'custom' ? 'custom' : '',
    stateRevision: 1,
    policyVersion: 'employee_cloud_authority_v1',
    syncEnabled: true,
    recruitedAt: `2026-02-0${index + 1}T00:00:00.000Z`,
    createdAt: `2026-02-0${index + 1}T00:00:00.000Z`,
    updatedAt: now,
  }));
  const result = sync.applyIdentitySnapshot({ data: { userAgentInstances: instances } }, { remoteUserId: 'remote_compaction' });

  assert.equal(result.status, 'applied');
  assert.deepEqual(db.prepare(`SELECT id,family_instance_seq,display_name,note FROM user_agent_instances
    WHERE user_id='local_compaction' ORDER BY family_instance_seq,id`).all().map((row) => ({ ...row })), [
    { id: 'compact_a', family_instance_seq: 1, display_name: 'Generalist A', note: '' },
    { id: 'compact_b', family_instance_seq: 2, display_name: 'Generalist B', note: '' },
    { id: 'compact_c', family_instance_seq: 3, display_name: 'Generalist C', note: '' },
    { id: 'compact_custom', family_instance_seq: 4, display_name: 'Operations Lead', note: 'custom' },
  ]);
  sync.close();
});

test('desktop Sync V6 defers a Memory version until its owner arrives on a later page', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-sync-v6-deferred-memory-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_deferred','deferred@example.test','Deferred User','deferred_user','remote_deferred',?,1)`).run(now);
  store.upsertAgentFamily({ id: 'deferred_family', name: 'Deferred Family', departmentId: 'general', role: 'agent', routable: true });
  const version = store.upsertAgentVersion({
    agent: { id: 'deferred_family', name: 'Deferred Family', departmentId: 'general', role: 'agent', routable: true, baseSkill: '# Skill' },
    memoryTemplate: '# Memory',
  });
  const instance = store.ensureUserAgentInstance({
    id: 'deferred_instance', userId: 'local_deferred', agentFamilyId: 'deferred_family', baseAgentVersionId: version.id,
    creationMode: 'explicit_recruitment', recruitmentSource: 'test',
  });
  let changePage = 0;
  const client = {
    async registerDevice() { return { status: 'approved' }; },
    async issueDeviceGrant() { return { token: 'deferred_device_grant' }; },
    async employeeCapabilities() { return { enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' }; },
    async employeeOverview() {
      return { bootstrap: { required: false }, systemRoster: [], recruitableFamilies: [], roster: [{
        id: instance.id, agentFamilyId: instance.agentFamilyId, baseAgentVersionId: instance.baseAgentVersionId,
        status: 'active', employmentState: 'active', stateRevision: 1, policyVersion: 'employee_cloud_authority_v1', syncEnabled: true,
      }] };
    },
    async syncV6Capabilities() { return { schemaVersion: 6, files: { available: true } }; },
    async submitV6Batch() { return { status: 'accepted', schemaVersion: 6, cursor: 'deferred-upload' }; },
    async syncV6Changes() {
      changePage += 1;
      if (changePage === 1) return {
        schemaVersion: 6, cursor: 'deferred-page-1', hasMore: true, resetRequired: false,
        changes: [change('memory_document_version', 'deferred_memory_v1', {
          id: 'deferred_memory_v1', memory_document_id: 'deferred_memory', version_no: 1,
          content: '# Deferred cloud memory', content_hash: 'deferred_memory_hash', created_at: now,
        })],
      };
      return {
        schemaVersion: 6, cursor: 'deferred-page-2', hasMore: false, resetRequired: false,
        changes: [change('memory_document', 'deferred_memory', {
          id: 'deferred_memory', cloud_key: 'deferred_memory', user_agent_instance_id: instance.id,
          agent_family_id: instance.agentFamilyId, scope: 'general', slot_no: 3, display_name: 'memory3.md',
          current_version_id: 'deferred_memory_v1', lifecycle_state: 'active', updated_at: now,
        })],
      };
    },
  };
  const sync = new CloudSyncService({
    root, db, store, client, defaultConfig: {},
    authStateProvider: () => ({ access_token: 'deferred_access', remote_user_id: 'remote_deferred' }),
  });
  sync.syncEvolutionAuthority = async () => ({ status: 'synchronized', authority: 'cloud' });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_deferred', deviceId: 'deferred_device', autoSync: false });

  const result = await sync.syncNow({ reason: 'deferred_memory_owner' });
  assert.equal(result.status, 'completed', result.error || JSON.stringify(result));
  assert.equal(result.deferredIdentityChangeCount, 1);
  assert.ok(result.recoveredIdentityChangeCount >= 1);
  assert.equal(result.unresolvedIdentityChangeCount, 0);
  assert.equal(sync.state().last_v6_cursor, 'deferred-page-2');
  assert.equal(db.prepare("SELECT content FROM memory_document_versions WHERE id='deferred_memory_v1'").get().content, '# Deferred cloud memory');
  assert.equal(db.prepare("SELECT status FROM cloud_sync_v6_deferred_changes WHERE entity_id='deferred_memory_v1'").get().status, 'applied');
  assert.equal(sync.status().deferredIdentityChangeCount, 0);
  const aliasDeferred = sync.applyV6Changes([
    change('memory_document_alias', 'deferred_memory_alias', {
      alias_document_id: 'deferred_memory_alias', canonical_document_id: 'deferred_memory_canonical', reason: 'cloud_alias',
    }),
    change('memory_document_version', 'deferred_alias_v1', {
      id: 'deferred_alias_v1', memory_document_id: 'deferred_memory_alias', version_no: 1,
      content: '# Deferred alias memory', content_hash: 'deferred_alias_hash', created_at: now,
    }),
  ], { remoteUserId: 'remote_deferred' });
  assert.equal(aliasDeferred.status, 'partial');
  assert.equal(aliasDeferred.deferred, 1);
  const aliasRecovered = sync.applyV6Changes([change('memory_document', 'deferred_memory_canonical', {
    id: 'deferred_memory_canonical', cloud_key: 'deferred_memory_canonical', user_agent_instance_id: instance.id,
    agent_family_id: instance.agentFamilyId, scope: 'general', slot_no: 4, display_name: 'memory4.md',
    current_version_id: 'deferred_alias_v1', lifecycle_state: 'inactive', updated_at: now,
  })], { remoteUserId: 'remote_deferred' });
  assert.ok(aliasRecovered.recovered >= 1);
  assert.equal(db.prepare("SELECT content FROM memory_document_versions WHERE id='deferred_alias_v1'").get().content, '# Deferred alias memory');
  sync.close();
});

test('desktop migration rebinds stale duplicate history content to the canonical primary conversation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-stale-history-rebind-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const userId = 'stale_history_user';
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,email_verified)
    VALUES(?,?,?,?,1)`).run(userId, 'stale-history@example.test', 'Stale History', 'stale_history');
  store.upsertAgentFamily({ id: 'stale_family', name: 'Stale Family', departmentId: 'general', role: 'agent', routable: true });
  const version = store.upsertAgentVersion({
    agent: { id: 'stale_family', name: 'Stale Family', departmentId: 'general', role: 'agent', routable: true, baseSkill: '# Skill' },
  });
  const instance = store.ensureUserAgentInstance({
    userId, agentFamilyId: 'stale_family', baseAgentVersionId: version.id,
    creationMode: 'explicit_recruitment', recruitmentSource: 'test',
  });
  const primary = store.createSession({
    id: 'stale_primary', userId, title: 'Primary', departmentId: 'general', agentId: 'stale_family',
    agentInstanceId: instance.id,
  });
  db.prepare(`INSERT INTO sessions(id,user_id,title,department_id,agent_id,agent_instance_id,conversation_role,
    write_state,superseded_by_session_id,status,created_at,updated_at)
    VALUES('stale_history',?,?,?,?,?,'history','read_only',?,'active','2026-07-29T01:00:00.000Z','2026-07-29T01:05:00.000Z')`).run(
    userId, 'History', 'general', 'stale_family', instance.id, primary.id,
  );
  db.prepare(`UPDATE sessions SET conversation_role='primary',write_state='writable',superseded_by_session_id='',
    created_at='2026-07-29T00:00:00.000Z',updated_at='2026-07-29T00:30:00.000Z' WHERE id=?`).run(primary.id);
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id,department_id)
    VALUES('stale_message','stale_history','user','still visible','stale_family',?,'general')`).run(instance.id);
  db.prepare(`INSERT INTO model_executions(id,user_id,conversation_id,status)
    VALUES('stale_execution',?,'stale_history','completed')`).run(userId);
  db.prepare(`INSERT INTO cloud_file_refs(id,user_id,session_id,message_id)
    VALUES('stale_file_ref',?,'stale_history','stale_message')`).run(userId);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM sessions h JOIN sessions p ON p.id=h.superseded_by_session_id
    WHERE h.id='stale_history' AND h.conversation_role='history' AND h.write_state='read_only'
      AND h.agent_instance_id=p.agent_instance_id AND h.created_at>p.created_at
      AND p.conversation_role='primary' AND p.write_state='writable'`).get().count, 1);
  db.prepare("DELETE FROM schema_migrations WHERE id='redirected_primary_conversation_rebind_v1'").run();

  migrateDatabase(db);

  assert.equal(db.prepare("SELECT session_id FROM messages WHERE id='stale_message'").get().session_id, primary.id);
  assert.equal(db.prepare("SELECT conversation_id FROM model_executions WHERE id='stale_execution'").get().conversation_id, primary.id);
  assert.equal(db.prepare("SELECT session_id FROM cloud_file_refs WHERE id='stale_file_ref'").get().session_id, primary.id);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='redirected_primary_conversation_rebind_v1'").get().count, 1);
});

test('employee progression projections refresh independently and record synchronization state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-employee-progression-refresh-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_progression','progression@example.test','Progression User','progression_user','remote_progression',?,1)`).run(now);
  store.upsertAgentFamily({ id: 'progression_family', name: 'Progression Family', departmentId: 'general', role: 'agent', routable: true });
  const base = store.upsertAgentVersion({
    agent: { id: 'progression_family', name: 'Progression Family', departmentId: 'general', role: 'agent', routable: true, baseSkill: '# Skill' },
  });
  const instance = store.ensureUserAgentInstance({
    id: 'progression_instance', userId: 'local_progression', agentFamilyId: 'progression_family', baseAgentVersionId: base.id,
    creationMode: 'explicit_recruitment', recruitmentSource: 'test',
  });
  const client = {
    async performanceLevel(_state, agentInstanceId) {
      return { item: { agentInstanceId, level: 'P2', score: 82, provisional: false } };
    },
    async leadershipLevel(_state, agentInstanceId) {
      return { item: { agentInstanceId, level: 'L1', score: 75, status: 'active', provisional: false } };
    },
    async leadershipActions() { return { items: [] }; },
    async leadershipAppeals() { return { items: [] }; },
  };
  const sync = new CloudSyncService({ root, db, store, client, defaultConfig: {} });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_progression', deviceId: 'progression_device', autoSync: false });
  const result = await sync.refreshEmployeeProgressionProjections(sync.state(), {
    capabilities: { performance: { enabled: true }, leadership: { enabled: true } },
    instances: [db.prepare('SELECT * FROM user_agent_instances WHERE id=?').get(instance.id)],
    localUser: db.prepare('SELECT * FROM auth_users WHERE id=?').get('local_progression'),
  });
  assert.equal(result.status, 'synchronized');
  assert.equal(sync.stage8Projection(`performance:${instance.id}`).payload.level, 'P2');
  assert.equal(sync.stage8Projection(`leadership:${instance.id}`).payload.level, 'L1');
  assert.ok(sync.status().employeeProgression.refreshedAt);
  assert.equal(sync.status().employeeProgression.lastError, '');
  sync.close();
});

test('desktop Sync V6 outbox persists an exact failed batch and honors retry backoff', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-sync-v6-outbox-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });

  const attempts = [];
  const firstClient = {
    async submitV6Batch(_state, payload) {
      attempts.push(payload);
      throw new Error('cloud temporarily offline');
    },
  };
  const firstService = new CloudSyncService({ root, db, store, client: firstClient, defaultConfig: {} });
  firstService.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_user', deviceId: 'device_1', autoSync: false });
  const payload = {
    schemaVersion: 6,
    batch: { id: 'sync_batch_retry_1', cursorTo: 'cursor_1', generatedAt: '2026-07-24T00:00:00.000Z', itemCount: 1 },
    device: { userId: 'remote_user', deviceId: 'device_1' },
    changes: [{ changeId: 'change_retry_1', entityType: 'project', entityId: 'project_1', operation: 'upsert', baseRevision: 0,
      occurredAt: '2026-07-24T00:00:00.000Z', contentHash: 'hash_1', payload: { id: 'project_1', optional: undefined } }],
  };
  const queued = firstService.enqueueV6Outbox(firstService.state(), payload);
  assert.equal(queued.batchId, 'sync_batch_retry_1');
  await assert.rejects(firstService.drainV6Outbox(firstService.state()), /temporarily offline/);

  const failed = db.prepare("SELECT * FROM cloud_sync_v6_outbox WHERE batch_id='sync_batch_retry_1'").get();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempt_count, 1);
  assert.ok(failed.next_attempt_at > new Date().toISOString());
  assert.match(failed.last_error, /temporarily offline/);
  assert.equal(firstService.status().pendingV6OutboxCount, 1);

  const deferred = await firstService.drainV6Outbox(firstService.state());
  assert.equal(deferred.status, 'deferred');
  assert.equal(attempts.length, 1);
  firstService.close();

  const secondClient = {
    async submitV6Batch(_state, submitted) {
      attempts.push(submitted);
      return { status: 'accepted', schemaVersion: 6, cursor: 'cursor_1' };
    },
  };
  const secondService = new CloudSyncService({ root, db, store, client: secondClient, defaultConfig: {} });
  const retried = await secondService.drainV6Outbox(secondService.state(), { force: true });
  assert.equal(retried.status, 'completed');
  assert.equal(retried.cursorTo, 'cursor_1');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(attempts[1].batch.id, 'sync_batch_retry_1');
  const completed = db.prepare("SELECT * FROM cloud_sync_v6_outbox WHERE batch_id='sync_batch_retry_1'").get();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempt_count, 2);
  assert.ok(completed.completed_at);
  assert.equal(secondService.status().pendingV6OutboxCount, 0);
});

test('desktop Sync V6 target changes orphan unfinished outbox batches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-sync-v6-target-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const sync = new CloudSyncService({ root, db, store, client: {}, defaultConfig: {} });
  sync.saveConfig({ serverUrl: 'https://old-cloud.example.test', userId: 'old_user', deviceId: 'old_device', autoSync: false });
  sync.enqueueV6Outbox(sync.state(), {
    schemaVersion: 6,
    batch: { id: 'sync_batch_old_target', cursorTo: 'cursor_old' },
    device: { userId: 'old_user', deviceId: 'old_device' },
    changes: [],
  });
  sync.saveConfig({ serverUrl: 'https://new-cloud.example.test', userId: 'new_user', deviceId: 'new_device', autoSync: false });
  const orphaned = db.prepare("SELECT status,last_error FROM cloud_sync_v6_outbox WHERE batch_id='sync_batch_old_target'").get();
  assert.equal(orphaned.status, 'orphaned');
  assert.equal(orphaned.last_error, 'sync target changed');
  assert.equal(sync.status().pendingV6OutboxCount, 0);
});

test('desktop cloud auth refreshes once and replaces a rejected Device Grant bootstrap token', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-auth-refresh-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  let accessToken = 'expired_access';
  let registerAttempts = 0;
  const client = {
    async registerDevice(_state, _payload, { accessToken: token }) {
      registerAttempts += 1;
      if (token === 'expired_access') throw Object.assign(new Error('unauthorized'), { status: 401, code: 'unauthorized' });
      return { status: 'approved' };
    },
    async issueDeviceGrant() { return { token: 'fresh_device_grant' }; },
  };
  const sync = new CloudSyncService({
    root, db, store, client, defaultConfig: {},
    authStateProvider: () => ({ access_token: accessToken, remote_user_id: 'remote_refresh_user' }),
    authRefreshProvider: async () => { accessToken = 'fresh_access'; },
  });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_refresh_user', deviceId: 'refresh_device' });
  assert.equal(await sync.ensureDeviceGrant(sync.state()), 'fresh_device_grant');
  assert.equal(registerAttempts, 2);
  assert.equal(sync.status().deviceGrantReady, true);
});

test('desktop cloud auth refreshes a saved session before Device Grant recovery when the access token is absent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-auth-missing-access-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  let accessToken = '';
  let refreshCount = 0;
  const client = {
    async registerDevice(_state, _payload, { accessToken: token }) {
      assert.equal(token, 'fresh_access');
      return { status: 'approved' };
    },
    async issueDeviceGrant() { return { token: 'fresh_device_grant' }; },
  };
  const sync = new CloudSyncService({
    root, db, store, client, defaultConfig: {},
    authStateProvider: () => ({ access_token: accessToken, refresh_token: 'saved_refresh', remote_user_id: 'remote_missing_access' }),
    authRefreshProvider: async () => { refreshCount += 1; accessToken = 'fresh_access'; },
  });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_missing_access', deviceId: 'missing_access_device' });

  assert.equal(await sync.ensureDeviceGrant(sync.state()), 'fresh_device_grant');
  assert.equal(refreshCount, 1);
  assert.equal(sync.status().deviceGrantReady, true);
});

test('desktop employee authority clears a stale Grant and retries once', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-grant-recovery-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  let registerCount = 0;
  const client = {
    async registerDevice() { registerCount += 1; return { status: 'approved' }; },
    async issueDeviceGrant() { return { token: 'fresh_device_grant' }; },
    async employeeCapabilities(state) {
      if (state.device_grant === 'stale_device_grant') {
        throw Object.assign(new Error('Device Grant is invalid.'), { status: 401, code: 'device_grant_invalid' });
      }
      return { enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' };
    },
  };
  const sync = new CloudSyncService({
    root, db, store, client, defaultConfig: {},
    authStateProvider: () => ({ access_token: 'valid_access', remote_user_id: 'remote_grant_user' }),
  });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_grant_user', deviceId: 'grant_device' });
  db.prepare("UPDATE cloud_sync_state SET device_grant='stale_device_grant',evolution_grant='stale_device_grant' WHERE id='default'").run();
  assert.equal((await sync.employeeCapabilities()).contractVersion, 2);
  assert.equal(registerCount, 1);
  assert.equal(sync.state().device_grant, 'fresh_device_grant');
  assert.equal(sync.state().evolution_grant, 'fresh_device_grant');
  assert.equal(sync.status().deviceGrantReady, true);
  assert.equal(sync.status().evolutionGrantReady, true);
});

test('desktop evolution preference falls back once when an older cloud has no evolution route', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-evolution-route-fallback-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  let requestCount = 0;
  const client = {
    async evolutionPreference() {
      requestCount += 1;
      throw Object.assign(new Error('Evolution route was not found.'), {
        status: 404,
        code: 'evolution_route_not_found',
      });
    },
  };
  const sync = new CloudSyncService({ root, db, store, client, defaultConfig: {} });
  sync.saveConfig({ serverUrl: 'https://older-cloud.example.test', userId: 'remote_user', deviceId: 'device_1', autoSync: false });
  db.prepare("UPDATE cloud_sync_state SET evolution_grant='evolution_grant',evolution_enabled=0,evolution_state_revision=4 WHERE id='default'").run();

  const preference = await sync.evolutionPreference();
  const cachedPreference = await sync.evolutionPreference();
  const backgroundSync = await sync.syncEvolutionAuthority();
  assert.equal(requestCount, 1);
  assert.equal(preference.authority, 'local-cache');
  assert.equal(preference.available, false);
  assert.equal(preference.code, 'evolution_route_not_found');
  assert.equal(preference.enabled, true);
  assert.equal(preference.policyVersion, 'evolution_mandatory_upload_v1');
  assert.equal(preference.stateRevision, 4);
  assert.equal(cachedPreference.available, false);
  assert.equal(cachedPreference.stateRevision, 4);
  assert.equal(backgroundSync.status, 'deferred');
  assert.equal(backgroundSync.reason, 'evolution_route_unavailable');
});

test('desktop evolution upload stays mandatory, update checks stay read-only, and activated cloud versions project locally', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-evolution-controls-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_user','evolution@example.test','Evolution User','evolution_user','remote_user',?,1)`).run(now);
  store.upsertAgentFamily({ id: 'family_1', name: 'Family 1', role: 'agent', routable: true });
  const base = store.upsertAgentVersion({ agent: { id: 'family_1', name: 'Family 1', role: 'agent', routable: true, baseSkill: '# Base Skill' } });
  const instance = store.ensureUserAgentInstance({
    userId: 'local_user', agentFamilyId: 'family_1', baseAgentVersionId: base.id,
    creationMode: 'explicit_recruitment', recruitmentSource: 'test',
  });
  let preference = { authority: 'cloud', enabled: true, policyVersion: 'evolution_default_on_account_pause_v1', stateRevision: 1 };
  let activeVersionId = '';
  let updateChecks = 0;
  let lastPersonalVersionInstanceId = '';
  let lastMarketInstanceId = '';
  const version = {
    id: 'personal_version_1', userAgentInstanceId: instance.id, agentFamilyId: 'family_1', baseAgentVersionId: base.id,
    parentVersionId: '', sourceEvolutionRunId: 'run_1', authority: 'cloud', stabilityStatus: 'stable',
    overlayText: 'Always verify before delivery.', status: 'candidate', createdAt: now, updatedAt: now,
  };
  const client = {
    async evolutionPreference() { return preference; },
    async setEvolutionPreference(_state, payload) {
      preference = { ...preference, enabled: payload.enabled, stateRevision: preference.stateRevision + 1,
        lastCommandId: payload.commandId, status: 'confirmed' };
      return preference;
    },
    async evolutionUpdates() {
      updateChecks += 1;
      return { authority: 'cloud', checkedAt: now, preference, personal: [{ agentInstanceId: instance.id,
        currentVersionId: activeVersionId, availableCount: activeVersionId ? 0 : 1 }], market: [] };
    },
    async activatePersonalEvolutionVersion(_state, versionId, payload) {
      assert.equal(versionId, version.id);
      assert.equal(payload.expectedActiveVersionId, '');
      activeVersionId = versionId;
      return { authority: 'cloud', status: 'activated', agentInstanceId: instance.id, activeVersionId: versionId };
    },
    async personalEvolutionVersions(_state, payload) {
      lastPersonalVersionInstanceId = payload.agentInstanceId;
      return { authority: 'cloud', items: [{ ...version, status: activeVersionId ? 'active' : 'candidate',
        activatedAt: activeVersionId ? now : '' }] };
    },
    async marketVersions(_state, payload) {
      lastMarketInstanceId = payload.agentInstanceId || '';
      return { authority: 'cloud', items: [{ id: 'market_family_1_v1', agentFamilyId: payload.familyId, status: 'released',
        versionKind: 'market_base', sections: [{ sectionId: 'verification', title: 'Verification' }] }] };
    },
    async effectiveMarketSkill(_state, agentInstanceId) {
      return { authority: 'cloud', item: { agentInstanceId, marketVersionId: '', effectiveSkillHash: 'market_hash_base' } };
    },
    async marketCanaryStatus(_state, { agentInstanceId }) {
      return { authority: 'cloud', agentInstanceId, optedIn: true, eligible: true,
        defaultEnrolled: true, explicitlyOptedOut: false, canOptOut: true, assignments: [] };
    },
  };
  const sync = new CloudSyncService({ root, db, store, client, defaultConfig: {} });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_user', deviceId: 'device_1', autoSync: false });
  db.prepare("UPDATE cloud_sync_state SET evolution_grant='evolution_grant' WHERE id='default'").run();
  db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason,created_at)
    VALUES('legacy_instance_mid',?,'local_user','test_alias_mid',?)`).run(instance.id, now);
  db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason,created_at)
    VALUES('legacy_instance','legacy_instance_mid','local_user','test_alias_head',?)`).run(now);

  await assert.rejects(() => sync.setEvolutionPreference({ enabled: false, commandId: 'pause_local' }),
    (error) => error.code === 'evolution_preference_managed' && error.status === 409);
  assert.equal(sync.status().evolutionEnabled, true);
  assert.equal(store.getUserAgentInstance(instance.id).personalEvolutionConsent, true);
  assert.equal(store.listMemoryDocuments({ agentInstanceId: instance.id })[0].allowPersonalEvolution, true);
  migrateDatabase(db);
  assert.equal(sync.status().evolutionEnabled, true, 're-running migrations must preserve mandatory upload');
  assert.equal(store.getUserAgentInstance(instance.id).personalEvolutionConsent, true);
  const updates = await sync.checkEvolutionUpdates();
  assert.equal(updates.personal[0].availableCount, 1);
  assert.equal(updateChecks, 1);
  assert.equal(sync.status().evolutionLastCheckedAt, now);

  await sync.setEvolutionPreference({ enabled: true, commandId: 'confirm_managed' });
  const activated = await sync.activatePersonalVersion({ agentInstanceId: instance.id, versionId: version.id });
  assert.equal(activated.status, 'activated');
  assert.equal(activated.projectedVersionCount, 1);
  assert.equal(store.getUserAgentInstance(instance.id).activePersonalSkillVersionId, version.id);
  assert.equal(store.resolveEffectiveSkill({ agentInstanceId: instance.id }).personalSkillVersion.id, version.id);
  const recruitedMarket = await sync.marketVersions({ familyId: 'family_1', agentInstanceId: instance.id });
  assert.equal(recruitedMarket.items[0].id, 'market_family_1_v1');
  assert.equal(recruitedMarket.effectiveSkill.effectiveSkillHash, 'market_hash_base');
  assert.equal(recruitedMarket.canary.optedIn, true);
  await sync.personalEvolutionVersions({ agentInstanceId: 'legacy_instance' });
  assert.equal(lastPersonalVersionInstanceId, instance.id);
  const aliasedMarket = await sync.marketVersions({ familyId: 'family_1', agentInstanceId: 'legacy_instance' });
  assert.equal(lastMarketInstanceId, instance.id);
  assert.equal(aliasedMarket.agentInstanceId, instance.id);
  const unrecruitedMarket = await sync.marketVersions({ familyId: 'family_unrecruited' });
  assert.equal(unrecruitedMarket.items[0].agentFamilyId, 'family_unrecruited');
  assert.equal(unrecruitedMarket.effectiveSkill, null);
  assert.equal(unrecruitedMarket.canary, null);
});

test('desktop market versions replace a stale cross-account Device Grant before reporting instance ownership', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-market-grant-recovery-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_market_user','market@example.test','Market User','market_user','remote_market_user',?,1)`).run(now);
  store.upsertAgentFamily({ id: 'market_family', name: 'Market Family', role: 'agent', routable: true });
  const base = store.upsertAgentVersion({ agent: { id: 'market_family', name: 'Market Family', role: 'agent', routable: true, baseSkill: '# Base' } });
  const instance = store.ensureUserAgentInstance({
    userId: 'local_market_user', agentFamilyId: 'market_family', baseAgentVersionId: base.id,
    creationMode: 'explicit_recruitment', recruitmentSource: 'test',
  });
  let marketCalls = 0;
  let effectiveCalls = 0;
  let canaryCalls = 0;
  let issuedGrants = 0;
  const client = {
    async marketVersions(state, payload) {
      marketCalls += 1;
      assert.equal(payload.agentInstanceId, instance.id);
      return { authority: 'cloud', items: [{ id: 'market_v1', agentFamilyId: payload.familyId, status: 'released', sections: [] }] };
    },
    async effectiveMarketSkill(state, agentInstanceId) {
      effectiveCalls += 1;
      if (state.device_grant === 'stale_other_user_grant') {
        const error = new Error('Agent instance does not belong to this user.');
        error.code = 'agent_instance_not_found';
        error.status = 404;
        throw error;
      }
      return { item: { agentInstanceId, effectiveSkillHash: 'fresh_hash' } };
    },
    async registerDevice(_state, payload) { return { deviceId: payload.deviceId, status: 'approved' }; },
    async issueDeviceGrant(_state, deviceId) {
      issuedGrants += 1;
      return { token: 'fresh_current_user_grant', deviceId };
    },
    async marketCanaryStatus(_state, { agentInstanceId }) {
      canaryCalls += 1;
      return { agentInstanceId, optedIn: true, assignments: [] };
    },
  };
  const sync = new CloudSyncService({
    root, db, store, client, defaultConfig: {},
    authStateProvider: () => ({ access_token: 'current_user_access', remote_user_id: 'remote_market_user' }),
  });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_market_user', deviceId: 'shared_device', autoSync: false });
  db.prepare("UPDATE cloud_sync_state SET device_grant='stale_other_user_grant',evolution_grant='stale_other_user_grant' WHERE id='default'").run();

  const result = await sync.marketVersions({ familyId: 'market_family', agentInstanceId: instance.id });
  assert.equal(result.items[0].id, 'market_v1');
  assert.equal(result.effectiveSkill.effectiveSkillHash, 'fresh_hash');
  assert.equal(marketCalls, 2);
  assert.equal(effectiveCalls, 2);
  assert.equal(canaryCalls, 2);
  assert.equal(issuedGrants, 1);
  assert.equal(sync.state().device_grant, 'fresh_current_user_grant');
  assert.equal(sync.state().evolution_grant, 'fresh_current_user_grant');
});

test('desktop Sync V6 keeps legacy Generalist catalog rows retired and imports their instances into the canonical family', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-desktop-general-catalog-repair-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_general_user','general-sync@example.test','General Sync','general_sync','remote_general_user',?,1)`).run(new Date().toISOString());
  store.upsertAgentFamily({
    id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  const generalVersion = store.upsertAgentVersion({
    agent: { id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
      instanceKind: 'employee', recruitable: true, baseSkill: '# Generalist' },
    memoryTemplate: '# Generalist memory',
  });
  store.ensureUserAgentInstance({
    id: 'canonical_general_sync_instance', userId: 'local_general_user', agentFamilyId: 'general_agent',
    baseAgentVersionId: generalVersion.id, creationMode: 'explicit_recruitment', recruitmentSource: 'test',
  });
  const sync = new CloudSyncService({ root, db, store, client: {}, defaultConfig: {} });
  const now = new Date().toISOString();

  const result = sync.applyV6Changes([
    change('agent_family', 'general_agent_1', {
      id: 'general_agent_1', name: '通用 Agent 1', department_id: 'general', role: 'agent', status: 'active',
      routable: true, instance_kind: 'employee', recruitable: true, default_for_new_user: false, quota_cost: 1, updated_at: now,
    }),
    change('agent_version', 'legacy_general_sync_v1', {
      id: 'legacy_general_sync_v1', agent_family_id: 'general_agent_1', base_skill_content: '# Legacy Generalist', created_at: now,
    }),
    change('user_agent_instance', 'legacy_general_sync_instance', {
      id: 'legacy_general_sync_instance', agent_family_id: 'general_agent_1', base_agent_version_id: 'legacy_general_sync_v1',
      status: 'active', instance_kind: 'employee', employment_state: 'active', family_instance_seq: 1,
      display_name: 'Generalist A', created_at: now, updated_at: now,
    }),
  ], { remoteUserId: 'remote_general_user' });

  assert.equal(result.status, 'applied');
  assert.deepEqual({ ...db.prepare(`SELECT status,routable,instance_kind,recruitable,default_for_new_user,quota_cost
    FROM agent_families WHERE id='general_agent_1'`).get() }, {
    status: 'retired', routable: 0, instance_kind: 'unavailable', recruitable: 0, default_for_new_user: 0, quota_cost: 0,
  });
  const instance = db.prepare(`SELECT agent_family_id,base_agent_version_id,family_instance_seq,display_name
    FROM user_agent_instances WHERE id='legacy_general_sync_instance'`).get();
  assert.equal(instance.agent_family_id, 'general_agent');
  assert.equal(instance.base_agent_version_id, db.prepare("SELECT current_version_id FROM agent_families WHERE id='general_agent'").get().current_version_id);
  assert.equal(instance.family_instance_seq, 2);
  assert.equal(instance.display_name, 'Generalist B');
  assert.deepEqual(store.listRecruitableAgentFamilies({ userId: 'local_general_user' })
    .filter((family) => /^general_agent_[123]$/.test(family.id)), []);
});

function change(entityType, entityId, payload) {
  return { changeId: `change_${entityType}_${entityId}`, entityType, entityId, operation: 'upsert', baseRevision: 0, revision: 1, payload };
}
