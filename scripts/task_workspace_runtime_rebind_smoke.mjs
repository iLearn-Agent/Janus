import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-task-workspace-runtime-rebind-'));
const db = openDatabase(root, { skipMigrationBackup: true });

try {
  const store = new Store(db, { root });
  const first = store.createSession({
    title: 'Canonical task workspace', departmentId: 'agent_delegation', agentId: 'secretary_agent',
    userId: 'local_admin', reusePrimary: false,
  });
  const firstMessage = store.addMessage({
    sessionId: first.id, role: 'assistant', content: 'CANONICAL_PROCESS', departmentId: 'agent_delegation',
    sourceEventId: 'shared_workspace_event', metadata: { attachments: [{ id: 'canonical-file', name: 'canonical.txt' }] },
  });
  const firstWorkspace = store.ensureTaskWorkspaceConversation({
    delegationId: 'runtime_rebind_delegation', ownerUserId: 'local_admin', sessionId: first.id,
    taskRunId: 'runtime_rebind_task', workspaceRoot: '/tmp/runtime-rebind', workspaceEpoch: 'epoch-runtime',
  });
  db.prepare(`INSERT INTO account_workspaces(
    id,workspace_kind,organization_id,owner_user_id,name,status
  ) VALUES('workspace_org_runtime_rebind','organization','org_runtime_rebind','local_admin','Runtime organization','active')`).run();
  for (const [tableName, columnName, value] of [
    ['task_workspaces', 'id', firstWorkspace.id],
    ['conversations', 'id', firstWorkspace.conversationId],
    ['sessions', 'id', first.id],
    ['messages', 'id', firstMessage.id],
    ['message_attachments', 'message_id', firstMessage.id],
  ]) {
    db.prepare(`UPDATE "${tableName}" SET account_workspace_id='workspace_org_runtime_rebind' WHERE "${columnName}"=?`).run(value);
  }

  const repaired = store.createSession({
    title: 'Repaired task workspace', departmentId: 'agent_delegation', agentId: 'secretary_agent',
    userId: 'local_admin', reusePrimary: false,
  });
  const repairedMessage = store.addMessage({
    sessionId: repaired.id, role: 'assistant', content: 'REPAIRED_PROCESS', departmentId: 'agent_delegation',
    sourceEventId: 'shared_workspace_event', metadata: { attachments: [{ id: 'repaired-file', name: 'repaired.txt' }] },
  });
  store.beginModelExecution({
    id: 'runtime_rebind_execution', userId: 'local_admin', conversationId: repaired.conversationId,
    requestMessageId: repairedMessage.id, taskRunId: 'runtime_rebind_task', departmentId: 'agent_delegation',
  });

  const rebound = store.ensureTaskWorkspaceConversation({
    delegationId: 'runtime_rebind_delegation', ownerUserId: 'local_admin', sessionId: repaired.id,
    taskRunId: 'runtime_rebind_task', workspaceRoot: '/tmp/runtime-rebind', workspaceEpoch: 'epoch-runtime',
  });
  assert.equal(rebound.conversationId, firstWorkspace.conversationId);
  assert.equal(store.getSession(repaired.id).conversationId, firstWorkspace.conversationId);
  assert.equal(store.getSession(repaired.id).accountWorkspaceId, 'workspace_org_runtime_rebind');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM conversations WHERE task_workspace_id=?')
    .get(firstWorkspace.id).count, 1);
  assert.deepEqual(store.listMessages(repaired.id, { includeAllContexts: true }).map((message) => message.content).sort(),
    ['CANONICAL_PROCESS', 'REPAIRED_PROCESS']);
  assert.equal(store.listMessageAttachments(firstMessage.id)[0].name, 'canonical.txt');
  assert.equal(store.listMessageAttachments(repairedMessage.id)[0].name, 'repaired.txt');
  assert.equal(store.getModelExecution('runtime_rebind_execution').conversationId, firstWorkspace.conversationId);
  assert.equal(store.getModelExecution('runtime_rebind_execution').accountWorkspaceId, 'workspace_org_runtime_rebind');
  assert.equal(store.getMessage(repairedMessage.id).accountWorkspaceId, 'workspace_org_runtime_rebind');
  assert.equal(db.prepare('SELECT account_workspace_id FROM message_attachments WHERE message_id=?')
    .get(repairedMessage.id).account_workspace_id, 'workspace_org_runtime_rebind');
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM messages
    WHERE conversation_id=? AND source_event_id='shared_workspace_event'`).get(firstWorkspace.conversationId).count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM messages
    WHERE conversation_id=? AND content IN ('CANONICAL_PROCESS','REPAIRED_PROCESS')`).get(firstWorkspace.conversationId).count, 2);

  const secondOpen = store.ensureTaskWorkspaceConversation({
    delegationId: 'runtime_rebind_delegation', ownerUserId: 'local_admin', sessionId: repaired.id,
    taskRunId: 'runtime_rebind_task', workspaceRoot: '/tmp/runtime-rebind', workspaceEpoch: 'epoch-runtime',
  });
  assert.equal(secondOpen.conversationId, firstWorkspace.conversationId);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  process.stdout.write('Task workspace runtime rebind smoke passed.\n');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
