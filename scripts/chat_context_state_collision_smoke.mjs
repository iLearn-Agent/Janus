import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  rebindAgentContextSpaceReferences,
  reconcileLocalGeneralMemoryContextPointers,
  upsertLocalAgentContextState,
  upsertLocalChatContextState,
} from '../src/main/cloudSync.js';
import { openDatabase } from '../src/main/db.js';
import { inspectDatabaseHealth } from '../src/main/modules/persistence/index.js';
import { stableChatContextStateId } from '../src/main/modules/persistence/infrastructure/chatContextStateStoreMethods.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-chat-context-collision-'));
let db;
try {
  db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });

  const desiredIdentity = {
    ownerUserId: 'context_owner', sessionId: 'context_session', contextSpaceId: 'context_space',
  };
  const occupiedStableId = stableChatContextStateId(
    desiredIdentity.ownerUserId, desiredIdentity.sessionId, desiredIdentity.contextSpaceId,
  );
  db.prepare(`INSERT INTO chat_context_states(
    id,owner_user_id,session_id,context_space_id,context_epoch,last_input_tokens,state_revision,sync_status
  ) VALUES(?,?,?,?,?,?,?,'synced')`).run(
    occupiedStableId, 'historical_owner', 'historical_session', 'historical_context', 4, 91, 7,
  );

  const created = store.ensureChatContextState(desiredIdentity);
  assert.notEqual(created.id, occupiedStableId, 'a stale deterministic ID occupant must not block a new identity');
  assert.equal(created.ownerUserId, desiredIdentity.ownerUserId);
  assert.equal(created.sessionId, desiredIdentity.sessionId);
  assert.equal(created.contextSpaceId, desiredIdentity.contextSpaceId);
  assert.deepEqual({ ...db.prepare('SELECT owner_user_id,session_id,context_space_id,context_epoch,last_input_tokens,state_revision FROM chat_context_states WHERE id=?').get(occupiedStableId) }, {
    owner_user_id: 'historical_owner', session_id: 'historical_session', context_space_id: 'historical_context',
    context_epoch: 4, last_input_tokens: 91, state_revision: 7,
  }, 'the historical ID occupant must remain unchanged');
  assert.equal(store.ensureChatContextState(desiredIdentity).id, created.id, 'runtime collision recovery must be idempotent');
  const recorded = store.recordChatContextUsage({
    ...desiredIdentity, executionId: 'context_execution', inputTokens: 1234, contextWindowTokens: 128000,
  });
  assert.equal(recorded.id, created.id);
  assert.equal(recorded.lastInputTokens, 1234);

  db.prepare(`INSERT INTO chat_context_states(
    id,owner_user_id,session_id,context_space_id,context_epoch,last_input_tokens,state_revision,sync_status
  ) VALUES('local_target','sync_owner','sync_session','sync_context',2,22,2,'pending')`).run();
  upsertLocalChatContextState(db, 'sync_owner', {
    id: 'remote_different_id', session_id: 'sync_session', context_space_id: 'sync_context',
    context_epoch: 3, last_input_tokens: 33, state_revision: 3, updated_at: '2026-08-08T00:00:00.000Z',
  });
  const updatedTarget = db.prepare(`SELECT id,context_epoch,last_input_tokens,state_revision FROM chat_context_states
    WHERE owner_user_id='sync_owner' AND session_id='sync_session' AND context_space_id='sync_context'`).get();
  assert.deepEqual({ ...updatedTarget }, { id: 'local_target', context_epoch: 3, last_input_tokens: 33, state_revision: 3 },
    'the local row matching the unique identity must remain canonical');
  upsertLocalChatContextState(db, 'sync_owner', {
    id: 'remote_different_id', session_id: 'sync_session', context_space_id: 'sync_context',
    context_epoch: 3, last_input_tokens: 33, state_revision: 3, updated_at: '2026-08-08T00:00:00.000Z',
  });
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM chat_context_states
    WHERE owner_user_id='sync_owner' AND session_id='sync_session' AND context_space_id='sync_context'`).get().count, 1,
  'duplicate cloud delivery must not create a duplicate unique identity');

  db.prepare(`INSERT INTO sessions(id,user_id,title,codex_thread_id)
    VALUES('pending_usage_session','pending_usage_owner','Pending usage','thread_must_survive_reload')`).run();
  db.prepare(`INSERT INTO chat_context_states(
    id,owner_user_id,session_id,context_space_id,context_epoch,last_execution_id,last_input_tokens,
    context_window_tokens,state_revision,base_state_revision,last_command_id,source_device_id,sync_status
  ) VALUES('pending_usage_state','pending_usage_owner','pending_usage_session','pending_usage_context',1,
    'local_execution',17463,258400,4,1,'local_usage','local_device','pending')`).run();
  const staleRemoteUsage = {
    id: 'pending_usage_state', session_id: 'pending_usage_session', context_space_id: 'pending_usage_context',
    context_epoch: 1, last_execution_id: '', last_input_tokens: 0, context_window_tokens: 0,
    provider_compaction_detected: false, state_revision: 2, updated_at: '2026-08-13T11:18:40.000Z',
  };
  upsertLocalChatContextState(db, 'pending_usage_owner', staleRemoteUsage);
  const rebasedUsage = db.prepare(`SELECT last_execution_id,last_input_tokens,context_window_tokens,
    state_revision,base_state_revision,sync_status FROM chat_context_states WHERE id='pending_usage_state'`).get();
  assert.deepEqual({ ...rebasedUsage }, {
    last_execution_id: 'local_execution', last_input_tokens: 17463, context_window_tokens: 258400,
    state_revision: 5, base_state_revision: 2, sync_status: 'pending',
  }, 'same-boundary cloud replay must rebase instead of erasing pending local usage');
  assert.equal(db.prepare("SELECT codex_thread_id FROM sessions WHERE id='pending_usage_session'").get().codex_thread_id,
    'thread_must_survive_reload');
  upsertLocalChatContextState(db, 'pending_usage_owner', staleRemoteUsage);
  assert.equal(db.prepare("SELECT state_revision FROM chat_context_states WHERE id='pending_usage_state'").get().state_revision, 5,
    'duplicate same-boundary replay must be idempotent');
  upsertLocalChatContextState(db, 'pending_usage_owner', {
    ...staleRemoteUsage,
    context_epoch: 2,
    reset_after_message_id: 'remote_reset_boundary',
    reset_after_created_at: '2026-08-13T12:00:00.000Z',
    state_revision: 3,
  });
  assert.deepEqual({ ...db.prepare(`SELECT context_epoch,reset_after_message_id,last_execution_id,last_input_tokens,
    state_revision,base_state_revision,sync_status FROM chat_context_states WHERE id='pending_usage_state'`).get() }, {
    context_epoch: 2, reset_after_message_id: 'remote_reset_boundary', last_execution_id: '', last_input_tokens: 0,
    state_revision: 3, base_state_revision: 3, sync_status: 'synced',
  }, 'a real remote reset boundary must replace the prior context measurement');
  assert.equal(db.prepare("SELECT codex_thread_id FROM sessions WHERE id='pending_usage_session'").get().codex_thread_id, '',
    'a real remote reset must still clear the provider thread');

  db.prepare(`INSERT INTO auth_users(id,email,display_name)
    VALUES('pointer_owner','pointer-owner@example.test','Pointer owner')`).run();
  store.ensureAccountWorkspaces({ user: { id: 'pointer_owner', displayName: 'Pointer owner' } });
  db.prepare(`INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable)
    VALUES('pointer_family','Pointer family','active',1,'employee',1)`).run();
  db.prepare(`INSERT INTO user_agent_instances(id,user_id,agent_family_id,status)
    VALUES('pointer_agent','pointer_owner','pointer_family','active')`).run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,codex_thread_id,conversation_role)
    VALUES('pointer_session','pointer_owner','Pointer repair','pointer_family','pointer_agent','pointer_thread','primary')`).run();
  db.prepare(`INSERT INTO memory_documents(
    id,user_id,user_agent_instance_id,scope,slot_no,context_space_id
  ) VALUES('pointer_memory','pointer_owner','pointer_agent','general',0,'pointer_context_stale')`).run();
  db.prepare(`INSERT INTO agent_context_spaces(
    id,user_id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state
  ) VALUES('pointer_context_canonical','pointer_owner','pointer_agent','general_memory','pointer_memory','active')`).run();
  db.prepare(`INSERT INTO agent_context_spaces(
    id,user_id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state
  ) VALUES('pointer_context_stale','pointer_owner','pointer_agent','general_memory','','active')`).run();
  db.prepare(`INSERT INTO agent_context_state(
    user_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,
    state_revision,base_state_revision,sync_status
  ) VALUES('pointer_owner','pointer_agent','pointer_session','pointer_context_stale','pointer_memory',3,3,'synced')`).run();
  reconcileLocalGeneralMemoryContextPointers(db, 'pointer_owner');
  assert.equal(db.prepare("SELECT context_space_id FROM memory_documents WHERE id='pointer_memory'").get().context_space_id,
    'pointer_context_canonical');
  assert.equal(db.prepare(`SELECT active_context_space_id FROM agent_context_state
    WHERE user_id='pointer_owner' AND user_agent_instance_id='pointer_agent'`).get().active_context_space_id,
    'pointer_context_canonical');
  assert.equal(db.prepare("SELECT codex_thread_id FROM sessions WHERE id='pointer_session'").get().codex_thread_id,
    'pointer_thread', 'canonicalizing the ID of the same Memory context must preserve the provider thread');
  db.prepare("UPDATE sessions SET codex_thread_id='pointer_thread_after_pull' WHERE id='pointer_session'").run();
  db.prepare(`UPDATE agent_context_state SET active_context_space_id='pointer_context_stale',
    active_memory_document_id='pointer_memory',sync_status='synced' WHERE user_id='pointer_owner'
      AND user_agent_instance_id='pointer_agent'`).run();
  upsertLocalAgentContextState(db, store, 'pointer_owner', {
    user_agent_instance_id: 'pointer_agent', primary_conversation_id: 'pointer_session',
    active_context_space_id: 'pointer_context_canonical', active_memory_document_id: 'pointer_memory',
    state_revision: 5, updated_at: '2026-08-13T13:00:00.000Z',
  });
  assert.equal(db.prepare("SELECT codex_thread_id FROM sessions WHERE id='pointer_session'").get().codex_thread_id,
    'pointer_thread_after_pull', 'same-Memory Agent context replay must preserve the provider thread');
  db.prepare(`INSERT INTO memory_documents(
    id,user_id,user_agent_instance_id,scope,slot_no,context_space_id,lifecycle_state
  ) VALUES('pointer_memory_next','pointer_owner','pointer_agent','general',1,'pointer_context_next','inactive')`).run();
  db.prepare(`INSERT INTO agent_context_spaces(
    id,user_id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state
  ) VALUES('pointer_context_next','pointer_owner','pointer_agent','general_memory','pointer_memory_next','inactive')`).run();
  upsertLocalAgentContextState(db, store, 'pointer_owner', {
    user_agent_instance_id: 'pointer_agent', primary_conversation_id: 'pointer_session',
    active_context_space_id: 'pointer_context_next', active_memory_document_id: 'pointer_memory_next',
    state_revision: 6, updated_at: '2026-08-13T13:01:00.000Z',
  });
  assert.equal(db.prepare("SELECT codex_thread_id FROM sessions WHERE id='pointer_session'").get().codex_thread_id, '',
    'a real Memory change from another device must still clear the provider thread');

  db.prepare(`INSERT INTO chat_context_states(
    id,owner_user_id,session_id,context_space_id,context_epoch,last_input_tokens,state_revision,sync_status
  ) VALUES('remote_id_collision','preserved_owner','preserved_session','preserved_context',5,55,5,'synced')`).run();
  const collisionChange = {
    id: 'remote_id_collision', session_id: 'new_sync_session', context_space_id: 'new_sync_context',
    context_epoch: 6, last_input_tokens: 66, state_revision: 6, updated_at: '2026-08-08T01:00:00.000Z',
  };
  upsertLocalChatContextState(db, 'new_sync_owner', collisionChange);
  const preservedOccupant = db.prepare('SELECT * FROM chat_context_states WHERE id=?').get('remote_id_collision');
  assert.equal(preservedOccupant.owner_user_id, 'preserved_owner');
  assert.equal(preservedOccupant.session_id, 'preserved_session');
  const importedCollision = db.prepare(`SELECT * FROM chat_context_states
    WHERE owner_user_id='new_sync_owner' AND session_id='new_sync_session' AND context_space_id='new_sync_context'`).get();
  assert.ok(importedCollision);
  assert.notEqual(importedCollision.id, 'remote_id_collision');
  upsertLocalChatContextState(db, 'new_sync_owner', collisionChange);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM chat_context_states
    WHERE owner_user_id='new_sync_owner' AND session_id='new_sync_session' AND context_space_id='new_sync_context'`).get().count, 1);

  db.prepare(`INSERT INTO chat_context_states(
    id,owner_user_id,session_id,context_space_id,context_epoch,reset_after_message_id,reset_after_created_at,
    last_execution_id,last_input_tokens,context_window_tokens,provider_compaction_detected,state_revision,
    base_state_revision,last_command_id,source_device_id,sync_status,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'rebind_source_state', 'rebind_owner', 'rebind_session', 'rebind_source_context', 8,
    'source_reset_message', '2026-08-12T08:00:00.000Z', 'source_execution', 8192, 128000, 1, 9,
    8, 'source_command', 'source_device', 'pending', '2026-08-11T00:00:00.000Z', '2026-08-12T09:00:00.000Z',
  );
  db.prepare(`INSERT INTO chat_context_states(
    id,owner_user_id,session_id,context_space_id,context_epoch,reset_after_message_id,reset_after_created_at,
    last_execution_id,last_input_tokens,context_window_tokens,provider_compaction_detected,state_revision,
    base_state_revision,last_command_id,source_device_id,sync_status,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'rebind_target_state', 'rebind_owner', 'rebind_session', 'rebind_target_context', 3,
    'target_reset_message', '2026-08-10T08:00:00.000Z', 'target_execution', 1024, 64000, 0, 4,
    4, 'target_command', 'target_device', 'synced', '2026-08-10T00:00:00.000Z', '2026-08-13T09:00:00.000Z',
  );
  rebindAgentContextSpaceReferences(db, 'rebind_source_context', 'rebind_target_context');
  const reboundState = db.prepare(`SELECT * FROM chat_context_states
    WHERE owner_user_id='rebind_owner' AND session_id='rebind_session' AND context_space_id='rebind_target_context'`).get();
  assert.deepEqual({
    id: reboundState.id, context_epoch: reboundState.context_epoch,
    reset_after_message_id: reboundState.reset_after_message_id,
    last_execution_id: reboundState.last_execution_id, last_input_tokens: reboundState.last_input_tokens,
    context_window_tokens: reboundState.context_window_tokens,
    provider_compaction_detected: reboundState.provider_compaction_detected,
    state_revision: reboundState.state_revision, base_state_revision: reboundState.base_state_revision,
    last_command_id: reboundState.last_command_id, source_device_id: reboundState.source_device_id,
    sync_status: reboundState.sync_status, created_at: reboundState.created_at, updated_at: reboundState.updated_at,
  }, {
    id: 'rebind_target_state', context_epoch: 8, reset_after_message_id: 'source_reset_message',
    last_execution_id: 'source_execution', last_input_tokens: 8192, context_window_tokens: 128000,
    provider_compaction_detected: 1, state_revision: 9, base_state_revision: 8,
    last_command_id: 'source_command', source_device_id: 'source_device', sync_status: 'pending',
    created_at: '2026-08-10T00:00:00.000Z', updated_at: '2026-08-12T09:00:00.000Z',
  }, 'context-space rebind must retain the higher-revision state and its metrics');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM chat_context_states WHERE id='rebind_source_state'").get().count, 0,
    'the redundant source identity must be removed after its state is merged');
  rebindAgentContextSpaceReferences(db, 'rebind_source_context', 'rebind_target_context');
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM chat_context_states
    WHERE owner_user_id='rebind_owner' AND session_id='rebind_session' AND context_space_id='rebind_target_context'`).get().count, 1,
  'context-space rebind must be idempotent');

  assert.equal(String(db.prepare('PRAGMA integrity_check').get()?.integrity_check), 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  process.stdout.write('Chat context state collision smoke passed.\n');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
