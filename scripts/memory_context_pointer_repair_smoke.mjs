import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectDatabaseRecoveryStatus, repairDatabase } from '../src/main/databaseRecovery.js';
import { createRuntime } from '../src/main/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-memory-context-pointer-repair-'));
const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-memory-context-pointer-recovery-'));
let runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });

try {
  const user = runtime.currentUser();
  const instance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || runtime.store.recruitUserAgent({
      userId: user.id,
      agentFamilyId: 'general_agent',
      commandId: 'memory-context-pointer-repair:recruit',
    }).instance;
  const session = runtime.store.createSession({
    title: 'Memory pointer repair',
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    userId: user.id,
  });
  const memory0 = runtime.store.listMemoryDocuments({ agentInstanceId: instance.id })
    .find((item) => item.scope === 'general' && item.lifecycleState === 'active');
  const exactContext = runtime.store.getAgentConversationContextSpace({ userId: user.id, agentInstanceId: instance.id });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'MEMORY_ZERO_EXACT_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: memory0.id,
    contextSpaceId: exactContext.id,
  });
  const memory1 = runtime.store.createNextGeneralMemoryDocument({
    agentInstanceId: instance.id,
    displayName: 'New conversation',
  });
  const memory1Context = runtime.store.getAgentConversationContextSpace({ userId: user.id, agentInstanceId: instance.id });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'MEMORY_ONE_ONLY_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: memory1.id,
    contextSpaceId: memory1Context.id,
  });
  const turnRequest = runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'TURN_BOUND_TO_MEMORY_ZERO',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: memory0.id,
    contextSpaceId: exactContext.id,
  });
  const misroutedResponse = runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: 'TURN_RESPONSE_MUST_RETURN_TO_MEMORY_ZERO',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: memory1.id,
    contextSpaceId: memory1Context.id,
  });
  runtime.store.beginModelExecution({
    id: 'model_exec_memory_turn_binding_repair',
    userId: user.id,
    conversationId: session.id,
    requestMessageId: turnRequest.id,
    responseMessageId: misroutedResponse.id,
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    status: 'completed',
  });

  const staleContextId = 'context_legacy_empty_memory_pointer';
  runtime.store.db.prepare(`INSERT INTO agent_context_spaces(
    id,account_workspace_id,user_id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state
  ) VALUES(?, 'workspace_personal', ?, ?, 'general_memory', '', 'active')`).run(
    staleContextId, user.id, instance.id,
  );
  runtime.store.db.prepare('UPDATE memory_documents SET context_space_id=? WHERE id=?').run(staleContextId, memory0.id);
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: 'MEMORY_ZERO_STALE_CONTEXT_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: memory0.id,
    contextSpaceId: staleContextId,
  });
  runtime.store.db.prepare("UPDATE messages SET context_space_id=? WHERE content='MEMORY_ONE_ONLY_MESSAGE'")
    .run(staleContextId);
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'ORPHANED_MEMORY_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: memory0.id,
    contextSpaceId: exactContext.id,
  });
  const orphanedMessage = runtime.store.db.prepare("SELECT id,created_at FROM messages WHERE content='ORPHANED_MEMORY_MESSAGE'").get();
  const missingMemoryId = 'memory_document_missing_from_legacy_database';
  runtime.store.db.prepare("UPDATE messages SET memory_id=? WHERE id=?").run(missingMemoryId, orphanedMessage.id);
  const memoryWithoutContext = runtime.store.createNextGeneralMemoryDocument({
    agentInstanceId: instance.id,
    displayName: 'Missing context conversation',
  });
  const removedContextId = memoryWithoutContext.contextSpaceId;
  runtime.store.db.prepare('DELETE FROM agent_context_spaces WHERE id=?').run(removedContextId);
  runtime.store.db.prepare("DELETE FROM schema_migrations WHERE id='memory_context_pointer_repair_v1'").run();
  runtime.store.db.prepare("DELETE FROM schema_migrations WHERE id='message_memory_turn_binding_repair_v2'").run();

  const inventoryBefore = {
    memories: runtime.store.db.prepare('SELECT COUNT(*) count FROM memory_documents').get().count,
    versions: runtime.store.db.prepare('SELECT COUNT(*) count FROM memory_document_versions').get().count,
    messages: runtime.store.db.prepare('SELECT COUNT(*) count FROM messages').get().count,
    attachments: runtime.store.db.prepare('SELECT COUNT(*) count FROM message_attachments').get().count,
    executions: runtime.store.db.prepare('SELECT COUNT(*) count FROM model_executions').get().count,
    messageFingerprint: runtime.store.db.prepare(`SELECT group_concat(id || ':' || role || ':' || content || ':' || created_at, '|') value
      FROM (SELECT id,role,content,created_at FROM messages ORDER BY id)`).get().value,
  };
  runtime.close();
  runtime = null;
  fs.cpSync(root, recoveryRoot, { recursive: true });

  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const repairedMemory = runtime.store.getMemoryDocument(memory0.id);
  assert.equal(repairedMemory.contextSpaceId, exactContext.id);
  const repairedMissingContextMemory = runtime.store.getMemoryDocument(memoryWithoutContext.id);
  assert.equal(repairedMissingContextMemory.contextSpaceId, `ctx_memory_${memoryWithoutContext.id}`);
  assert.deepEqual({ ...runtime.store.db.prepare(`SELECT user_id,account_workspace_id,user_agent_instance_id,
    context_kind,memory_document_id,lifecycle_state,created_at FROM agent_context_spaces WHERE id=?`)
    .get(repairedMissingContextMemory.contextSpaceId) }, {
    user_id: user.id,
    account_workspace_id: 'workspace_personal',
    user_agent_instance_id: instance.id,
    context_kind: 'general_memory',
    memory_document_id: memoryWithoutContext.id,
    lifecycle_state: memoryWithoutContext.lifecycleState,
    created_at: memoryWithoutContext.createdAt,
  });
  assert.equal(runtime.store.db.prepare('SELECT COUNT(*) count FROM messages WHERE context_space_id=?').get(staleContextId).count, 0);
  assert.equal(runtime.store.db.prepare(`SELECT COUNT(*) count FROM agent_context_state
    WHERE active_context_space_id=?`).get(staleContextId).count, 0);
  assert.equal(runtime.store.db.prepare(`SELECT COUNT(*) count FROM agent_device_context_state
    WHERE active_context_space_id=?`).get(staleContextId).count, 0);
  assert.deepEqual({ ...runtime.store.db.prepare(`SELECT context_space_id,memory_id FROM messages
    WHERE content='MEMORY_ZERO_STALE_CONTEXT_MESSAGE'`).get() }, {
    context_space_id: exactContext.id,
    memory_id: memory0.id,
  });
  assert.deepEqual({ ...runtime.store.db.prepare(`SELECT context_space_id,memory_id FROM messages
    WHERE content='MEMORY_ONE_ONLY_MESSAGE'`).get() }, {
    context_space_id: memory1Context.id,
    memory_id: memory1.id,
  });
  const repairedTurnResponse = runtime.store.db.prepare(`SELECT context_space_id,memory_id,metadata_json
    FROM messages WHERE id=?`).get(misroutedResponse.id);
  assert.equal(repairedTurnResponse.context_space_id, exactContext.id);
  assert.equal(repairedTurnResponse.memory_id, memory0.id);
  assert.deepEqual(JSON.parse(repairedTurnResponse.metadata_json).databaseRecovery, {
    previousMemoryId: memory1.id,
    previousContextSpaceId: memory1Context.id,
    sourceRequestMessageId: turnRequest.id,
    modelExecutionId: 'model_exec_memory_turn_binding_repair',
    migration: 'message_memory_turn_binding_repair_v2',
    reason: 'turn_local_memory_binding',
  });
  const repairedOrphan = runtime.store.db.prepare(`SELECT id,content,created_at,context_space_id,memory_id,metadata_json
    FROM messages WHERE id=?`).get(orphanedMessage.id);
  assert.equal(repairedOrphan.id, orphanedMessage.id);
  assert.equal(repairedOrphan.content, 'ORPHANED_MEMORY_MESSAGE');
  assert.equal(repairedOrphan.created_at, orphanedMessage.created_at);
  assert.equal(repairedOrphan.context_space_id, exactContext.id);
  assert.equal(repairedOrphan.memory_id, memory0.id);
  assert.deepEqual(JSON.parse(repairedOrphan.metadata_json).databaseRecovery, {
    orphanedMemoryId: missingMemoryId,
    reason: 'missing_memory_document',
    migration: 'memory_context_pointer_repair_v1',
  });

  const switched = runtime.switchEmployeeMemory({
    agentInstanceId: instance.id,
    memoryDocumentId: memory0.id,
  });
  assert.equal(switched.applicationState, 'applied');
  assert.equal(switched.activeMemoryDocumentId, memory0.id);
  assert.equal(switched.activeContextSpaceId, exactContext.id);
  const timeline = runtime.agentConversationTimeline({ agentInstanceId: instance.id, limit: 100 });
  const timelineContents = timeline.items.map((item) => item.content);
  assert.equal(timelineContents.includes('MEMORY_ZERO_EXACT_MESSAGE'), true);
  assert.equal(timelineContents.includes('MEMORY_ZERO_STALE_CONTEXT_MESSAGE'), true);
  assert.equal(timelineContents.includes('MEMORY_ONE_ONLY_MESSAGE'), false);

  const inventoryAfter = {
    memories: runtime.store.db.prepare('SELECT COUNT(*) count FROM memory_documents').get().count,
    versions: runtime.store.db.prepare('SELECT COUNT(*) count FROM memory_document_versions').get().count,
    messages: runtime.store.db.prepare('SELECT COUNT(*) count FROM messages').get().count,
    attachments: runtime.store.db.prepare('SELECT COUNT(*) count FROM message_attachments').get().count,
    executions: runtime.store.db.prepare('SELECT COUNT(*) count FROM model_executions').get().count,
    messageFingerprint: runtime.store.db.prepare(`SELECT group_concat(id || ':' || role || ':' || content || ':' || created_at, '|') value
      FROM (SELECT id,role,content,created_at FROM messages ORDER BY id)`).get().value,
  };
  assert.deepEqual(inventoryAfter, inventoryBefore);
  assert.equal(String(runtime.store.db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
  assert.deepEqual(runtime.store.db.prepare('PRAGMA foreign_key_check').all(), []);

  runtime.close();
  runtime = null;
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  assert.equal(runtime.store.getMemoryDocument(memory0.id).contextSpaceId, exactContext.id);
  assert.deepEqual({
    memories: runtime.store.db.prepare('SELECT COUNT(*) count FROM memory_documents').get().count,
    versions: runtime.store.db.prepare('SELECT COUNT(*) count FROM memory_document_versions').get().count,
    messages: runtime.store.db.prepare('SELECT COUNT(*) count FROM messages').get().count,
    attachments: runtime.store.db.prepare('SELECT COUNT(*) count FROM message_attachments').get().count,
    executions: runtime.store.db.prepare('SELECT COUNT(*) count FROM model_executions').get().count,
    messageFingerprint: runtime.store.db.prepare(`SELECT group_concat(id || ':' || role || ':' || content || ':' || created_at, '|') value
      FROM (SELECT id,role,content,created_at FROM messages ORDER BY id)`).get().value,
  }, inventoryBefore);
  runtime.store.db.prepare('UPDATE memory_documents SET context_space_id=? WHERE id=?').run(staleContextId, memory0.id);
  runtime.close();
  runtime = null;
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  assert.equal(runtime.store.getMemoryDocument(memory0.id).contextSpaceId, exactContext.id);
  assert.ok(runtime.store.db.prepare("SELECT 1 FROM schema_migrations WHERE id='memory_context_pointer_repair_v1'").get());
  assert.ok(runtime.store.db.prepare("SELECT 1 FROM schema_migrations WHERE id='message_memory_turn_binding_repair_v2'").get());

  const recoveryInspection = inspectDatabaseRecoveryStatus(recoveryRoot, { appVersion: '1.0.0' });
  assert.equal(recoveryInspection.status, 'repairable');
  assert.ok(recoveryInspection.pendingMigrationIds.includes('memory_context_pointer_repair_v1'));
  const recovery = repairDatabase(recoveryRoot, { appVersion: '1.0.0' });
  assert.equal(recovery.status, 'repaired');
  const recoveredRuntime = await createRuntime({ root: recoveryRoot, isDev: true, serverAuthoritativeSkills: true });
  try {
    assert.deepEqual({ ...recoveredRuntime.store.db.prepare(`SELECT context_space_id,memory_id FROM messages
      WHERE content='MEMORY_ONE_ONLY_MESSAGE'`).get() }, {
      context_space_id: memory1Context.id,
      memory_id: memory1.id,
    });
    assert.deepEqual({
      memories: recoveredRuntime.store.db.prepare('SELECT COUNT(*) count FROM memory_documents').get().count,
      versions: recoveredRuntime.store.db.prepare('SELECT COUNT(*) count FROM memory_document_versions').get().count,
      messages: recoveredRuntime.store.db.prepare('SELECT COUNT(*) count FROM messages').get().count,
      attachments: recoveredRuntime.store.db.prepare('SELECT COUNT(*) count FROM message_attachments').get().count,
      executions: recoveredRuntime.store.db.prepare('SELECT COUNT(*) count FROM model_executions').get().count,
      messageFingerprint: recoveredRuntime.store.db.prepare(`SELECT group_concat(id || ':' || role || ':' || content || ':' || created_at, '|') value
        FROM (SELECT id,role,content,created_at FROM messages ORDER BY id)`).get().value,
    }, inventoryBefore);
  } finally {
    recoveredRuntime.close();
  }
  process.stdout.write('Memory context pointer repair smoke passed.\n');
} finally {
  runtime?.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(recoveryRoot, { recursive: true, force: true });
}
