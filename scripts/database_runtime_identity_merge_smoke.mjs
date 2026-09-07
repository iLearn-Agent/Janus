import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { createEmployeeRuntimeApi } from '../src/main/modules/identity/application/createEmployeeRuntimeApi.js';
import { inspectDatabaseHealth } from '../src/main/modules/persistence/index.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-runtime-identity-merge-'));
let db;
try {
  db = openDatabase(root, { appVersion: '0.2.18', skipMigrationBackup: true });
  const store = new Store(db, { root });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('merge_user','merge@example.com','Merge')").run();
  store.ensureAccountWorkspaces({ user: { id: 'merge_user', displayName: 'Merge' } });
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('merge_family','Merge','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('merge_alias','merge_user','merge_family','active')").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('merge_canonical','merge_user','merge_family','active')").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('merge_other','merge_user','merge_family','active')").run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status,updated_at)
    VALUES('merge_alias_session','merge_user','Alias','merge_family','merge_alias','primary','writable','active','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status,updated_at)
    VALUES('merge_canonical_session','merge_user','Canonical','merge_family','merge_canonical','primary','writable','active','2026-02-01T00:00:00.000Z')`).run();
  for (const [id, instanceId, title] of [
    ['merge_alias_session', 'merge_alias', 'Alias'],
    ['merge_canonical_session', 'merge_canonical', 'Canonical'],
  ]) db.prepare(`INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status)
    VALUES(?,'workspace_personal','direct','merge_user',?,'merge_family',?,'active')`).run(id, title, instanceId);
  db.prepare(`INSERT INTO agent_conversation_branch_state(
    user_id,account_workspace_id,agent_instance_id,conversation_id,primary_session_id,rebuild_required
  ) VALUES('merge_user','workspace_personal','merge_alias','merge_alias_session','merge_alias_session',0)`).run();
  db.prepare(`INSERT INTO agent_conversation_branch_state(
    user_id,account_workspace_id,agent_instance_id,conversation_id,primary_session_id,rebuild_required
  ) VALUES('merge_user','workspace_personal','merge_canonical','merge_canonical_session','merge_canonical_session',0)`).run();
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('merge_alias_message','merge_alias_session','user','preserve runtime alias','merge_family','merge_alias')`).run();
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('merge_canonical_message','merge_canonical_session','assistant','preserve runtime canonical','merge_family','merge_canonical')`).run();
  db.prepare(`INSERT INTO agent_conversation_timeline_refs(
    ref_id,user_id,account_workspace_id,agent_instance_id,source_kind,source_id,source_conversation_id,source_message_id,occurred_at
  ) VALUES('direct:merge_alias_message:merge_alias','merge_user','workspace_personal','merge_alias','direct',
    'merge_alias_message','merge_alias_session','merge_alias_message','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO agent_conversation_timeline_refs(
    ref_id,user_id,account_workspace_id,agent_instance_id,source_kind,source_id,source_conversation_id,source_message_id,occurred_at
  ) VALUES('direct:merge_canonical_message:merge_canonical','merge_user','workspace_personal','merge_canonical','direct',
    'merge_canonical_message','merge_canonical_session','merge_canonical_message','2026-02-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO agent_context_spaces(id,user_id,user_agent_instance_id,context_kind)
    VALUES('merge_alias_context','merge_user','merge_alias','general_memory')`).run();
  db.prepare(`INSERT INTO agent_context_spaces(id,user_id,user_agent_instance_id,context_kind)
    VALUES('merge_canonical_context','merge_user','merge_canonical','general_memory')`).run();
  db.prepare(`INSERT INTO chat_context_states(id,owner_user_id,session_id,context_space_id,state_revision,updated_at)
    VALUES('merge_alias_chat_state','merge_user','merge_canonical_session','merge_alias_context',2,'2026-02-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO chat_context_states(id,owner_user_id,session_id,context_space_id,state_revision,updated_at)
    VALUES('merge_canonical_chat_state','merge_user','merge_canonical_session','merge_canonical_context',1,'2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,
    current_version_id,content_hash,created_at,updated_at) VALUES
    ('merge_alias_memory','merge_user','workspace_personal','merge_alias','merge_family',
      'merge_alias_memory_version','merge_alias_hash','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z'),
    ('merge_canonical_memory','merge_user','workspace_personal','merge_canonical','merge_family',
      'merge_canonical_memory_version','merge_canonical_hash','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO memory_document_versions(id,memory_document_id,version_no,content,content_hash,created_at) VALUES
    ('merge_canonical_memory_version','merge_canonical_memory',1,'RUNTIME_CANONICAL_MEMORY_PRESERVED','merge_canonical_hash','2026-01-01T00:00:00.000Z'),
    ('merge_canonical_memory_local_only','merge_canonical_memory',-1,'RUNTIME_LOCAL_ONLY_MEMORY_PRESERVED','merge_local_only_hash','2026-01-02T00:00:00.000Z'),
    ('merge_alias_memory_version','merge_alias_memory',1,'RUNTIME_ALIAS_MEMORY_PRESERVED','merge_alias_hash','2026-02-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workspace_agent_bindings(
      workspace_id,agent_instance_id,owner_user_id,visibility,can_receive_mentions,can_receive_delegations,status,updated_at
    ) VALUES('workspace_personal','merge_alias','merge_user','represented',1,0,'active','2026-02-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workspace_agent_bindings(
      workspace_id,agent_instance_id,owner_user_id,visibility,can_receive_mentions,can_receive_delegations,status,updated_at
    ) VALUES('workspace_personal','merge_canonical','merge_user','private',0,1,'disabled','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO agent_work_queue(id,user_id,agent_instance_id,work_kind,work_id,status,enqueued_at,started_at,updated_at)
    VALUES('merge_alias_work','merge_user','merge_alias','task_node','merge_alias_work_id','running',
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO agent_work_queue(id,user_id,agent_instance_id,work_kind,work_id,status,enqueued_at,started_at,updated_at)
    VALUES('merge_canonical_work','merge_user','merge_canonical','task_node','merge_canonical_work_id','running',
      '2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`).run();

  store.bindCanonicalAgentInstance({
    userId: 'merge_user', aliasInstanceId: 'merge_alias', canonicalInstanceId: 'merge_canonical', reason: 'cloud_runtime_merge',
  });

  assert.deepEqual(db.prepare(`SELECT id,agent_instance_id,conversation_role,write_state,superseded_by_session_id FROM sessions
    WHERE user_id='merge_user' ORDER BY id`).all().map((row) => ({ ...row })), [{
    id: 'merge_alias_session', agent_instance_id: 'merge_canonical', conversation_role: 'history',
    write_state: 'read_only', superseded_by_session_id: 'merge_canonical_session',
  }, {
    id: 'merge_canonical_session', agent_instance_id: 'merge_canonical', conversation_role: 'primary',
    write_state: 'writable', superseded_by_session_id: '',
  }]);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE id IN ('merge_alias_message','merge_canonical_message')").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM agent_context_spaces WHERE user_agent_instance_id='merge_canonical' AND context_kind='general_memory'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM chat_context_states WHERE owner_user_id='merge_user' AND session_id='merge_canonical_session'").get().count, 1);
  assert.equal(db.prepare("SELECT state_revision FROM chat_context_states WHERE owner_user_id='merge_user' AND session_id='merge_canonical_session'").get().state_revision, 2);
  assert.deepEqual({ ...db.prepare(`SELECT agent_instance_id,visibility,can_receive_mentions,can_receive_delegations,status
    FROM workspace_agent_bindings WHERE workspace_id='workspace_personal' AND agent_instance_id='merge_canonical'`).get() }, {
    agent_instance_id: 'merge_canonical', visibility: 'represented', can_receive_mentions: 1, can_receive_delegations: 1, status: 'active',
  });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM workspace_agent_bindings WHERE agent_instance_id='merge_alias'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM agent_work_queue WHERE agent_instance_id='merge_canonical'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM agent_work_queue WHERE agent_instance_id='merge_canonical' AND status='running'").get().count, 1);
  assert.equal(db.prepare("SELECT status FROM agent_work_queue WHERE id='merge_canonical_work'").get().status, 'queued');
  assert.deepEqual(db.prepare(`SELECT id,version_no,content FROM memory_document_versions
    WHERE memory_document_id='merge_canonical_memory' ORDER BY version_no`).all().map((row) => ({ ...row })), [
    { id: 'merge_canonical_memory_version', version_no: 1, content: 'RUNTIME_CANONICAL_MEMORY_PRESERVED' },
    { id: 'merge_canonical_memory_local_only', version_no: 2, content: 'RUNTIME_LOCAL_ONLY_MEMORY_PRESERVED' },
    { id: 'merge_alias_memory_version', version_no: 3, content: 'RUNTIME_ALIAS_MEMORY_PRESERVED' },
  ]);
  assert.deepEqual({ ...db.prepare(`SELECT agent_instance_id,conversation_id,primary_session_id,rebuild_required
    FROM agent_conversation_branch_state WHERE user_id='merge_user' AND account_workspace_id='workspace_personal'`).get() }, {
    agent_instance_id: 'merge_canonical', conversation_id: 'merge_canonical_session',
    primary_session_id: 'merge_canonical_session', rebuild_required: 1,
  });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM agent_conversation_timeline_refs WHERE agent_instance_id='merge_alias'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM agent_conversation_timeline_refs WHERE agent_instance_id='merge_canonical'").get().count, 2);
  const postMergeAnswer = store.addMessage({
    sessionId: 'merge_canonical_session', role: 'assistant', content: 'answer captured before identity merge',
    agentId: 'merge_family', agentInstanceId: 'merge_alias', departmentId: 'general',
  });
  assert.equal(postMergeAnswer.agentInstanceId, 'merge_canonical',
    'a message carrying an explicit alias must be persisted under the session canonical identity');
  assert.throws(() => store.addMessage({
    sessionId: 'merge_canonical_session', role: 'assistant', content: 'must not cross to another employee',
    agentId: 'merge_family', agentInstanceId: 'merge_other', departmentId: 'general',
  }), /does not match the session Agent instance|message_session_agent_mismatch/);
  const employeeApi = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'merge_user', role: 'member' }) },
    store,
  });
  const conversationOverview = employeeApi.employeeConversationOverview({ agentInstanceId: 'merge_alias' });
  assert.equal(conversationOverview.requestedAgentInstanceId, 'merge_alias');
  assert.equal(conversationOverview.resolvedAgentInstanceId, 'merge_canonical');
  assert.equal(conversationOverview.identityChanged, true);
  assert.equal(conversationOverview.primarySession?.id, 'merge_canonical_session');
  assert.equal(conversationOverview.primarySession?.agentInstanceId, 'merge_canonical');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE conversation_id='merge_canonical_session' AND id IN ('merge_alias_message','merge_canonical_message')").get().count, 2);
  assert.equal(store.listMessagesForPrompt('merge_canonical_session', { ownerUserId: 'merge_user' })
    .some((message) => message.content === 'preserve runtime alias'), true,
  'runtime identity merge must keep alias-session history in the canonical Agent prompt timeline');
  db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
    VALUES('merge_legacy_head','merge_alias','merge_user','multi_device_alias_chain')`).run();
  assert.equal(store.getUserAgentInstance('merge_legacy_head')?.id, 'merge_canonical');
  const chainedConversationOverview = employeeApi.employeeConversationOverview({ agentInstanceId: 'merge_legacy_head' });
  assert.equal(chainedConversationOverview.resolvedAgentInstanceId, 'merge_canonical');
  assert.equal(chainedConversationOverview.identityChanged, true);
  assert.equal(store.requireRoutableUserAgent({
    userId: 'merge_user', agentInstanceId: 'merge_legacy_head', agentFamilyId: 'merge_family',
  }).instance.id, 'merge_canonical');
  store.ensureDefaultMemoryDocument({ agentInstanceId: 'merge_canonical' });
  const chainedMemoryDocuments = employeeApi.employeeMemoryDocuments({ agentInstanceId: 'merge_legacy_head' });
  assert.ok(chainedMemoryDocuments.length > 0);
  assert.equal(chainedMemoryDocuments[0].userAgentInstanceId, 'merge_canonical');
  db.prepare("DELETE FROM user_agent_instance_aliases WHERE alias_instance_id='merge_legacy_head'").run();
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sessions_one_primary_agent'").get());
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  process.stdout.write('Database runtime identity merge smoke passed.\n');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
