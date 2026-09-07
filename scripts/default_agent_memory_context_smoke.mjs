import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-default-agent-memory-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const fakeCodex = path.join(tempRoot, 'fake-codex.mjs');
const previousCodexBin = process.env.JANUS_CODEX_BIN;

await writeFile(fakeCodex, `#!/usr/bin/env node
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli default-memory-smoke'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]\\n  --listen <URL>'); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id == null || !message.method) continue;
    if (message.method === 'initialize') { send({ id: message.id, result: { userAgent: 'default-memory-smoke' } }); continue; }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: 'default-memory-thread' } } }); continue;
    }
    if (message.method === 'thread/memoryMode/set' || message.method === 'thread/goal/get') {
      send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } }); continue;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'default-memory-turn' } } });
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'DEFAULT_MEMORY_OK' } } });
      send({ method: 'turn/completed', params: { usage: { input_tokens: 20, output_tokens: 5 }, turn: { id: 'default-memory-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'DEFAULT_MEMORY_OK' }] } } });
      continue;
    }
    send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
  }
}
`, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;

const runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });
try {
  const user = runtime.currentUser();
  const instance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || runtime.store.recruitUserAgent({
      userId: user.id,
      agentFamilyId: 'general_agent',
      commandId: 'default-agent-memory:recruit-general',
    }).instance;
  runtime.saveCodexConfig({ apiKey: 'sk-default-memory-smoke', model: 'gpt-5.6-sol', reasoningEffort: 'medium' });

  const personalMemoryIds = runtime.store.listMemoryDocuments({
    agentInstanceId: instance.id,
    workspaceId: 'workspace_personal',
  }).map((document) => document.id);
  assert.equal(personalMemoryIds.length, 1, 'recruitment should retain its personal Workspace default Memory');
  assert.equal(runtime.store.getMemoryDocument(personalMemoryIds[0]).displayName, 'memory0.md');

  runtime.db.prepare(`INSERT INTO contact_organizations(
    id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id
  ) VALUES('org_default_memory','DEFAULT-MEMORY','Default Memory Workspace','salt','hash',?)`).run(user.id);
  runtime.db.prepare(`INSERT INTO contact_organization_members(organization_id,user_id,role)
    VALUES('org_default_memory',?,'owner')`).run(user.id);
  runtime.store.ensureAccountWorkspaces({ user });
  const pickerWorkspaceId = 'workspace_org_org_default_memory';
  runtime.store.switchAccountWorkspace({ userId: user.id, workspaceId: pickerWorkspaceId });
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS count FROM memory_documents
    WHERE account_workspace_id=? AND user_agent_instance_id=?`).get(pickerWorkspaceId, instance.id).count, 0,
  'a newly joined Workspace should begin without copied personal Memory');

  runtime.db.prepare(`INSERT INTO agent_context_state(
    user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,
    active_memory_document_id,state_revision,base_state_revision,last_command_id,source_device_id,sync_status
  ) VALUES(?,?,?,'','','',1,0,'legacy_empty_context','local','pending')`).run(user.id, pickerWorkspaceId, instance.id);
  runtime.db.prepare(`INSERT INTO agent_device_context_state(
    device_id,user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id
  ) VALUES('local',?,?,?,'','','')`).run(user.id, pickerWorkspaceId, instance.id);
  const inventoryBefore = inventory(runtime.db);

  const initialDocuments = runtime.employeeMemoryDocuments({ agentInstanceId: instance.id });
  assert.equal(initialDocuments.length, 1, 'opening the Memory picker should create exactly one default Memory');
  const defaultMemory = initialDocuments[0];
  assert.equal(defaultMemory.workspaceId, pickerWorkspaceId);
  assert.equal(defaultMemory.scope, 'general');
  assert.equal(defaultMemory.displayName, 'memory0.md');
  assert.equal(defaultMemory.lifecycleState, 'active');
  assert.ok(defaultMemory.contextSpaceId);

  const repairedAccountState = runtime.store.getAgentContextState({
    userId: user.id, agentInstanceId: instance.id, workspaceId: pickerWorkspaceId,
  });
  const repairedDeviceState = runtime.store.getDeviceContextState({
    deviceId: 'local', userId: user.id, agentInstanceId: instance.id, workspaceId: pickerWorkspaceId,
  });
  for (const state of [repairedAccountState, repairedDeviceState]) {
    assert.equal(state.activeMemoryDocumentId, defaultMemory.id, 'empty context state should bind to the default Memory');
    assert.equal(state.activeContextSpaceId, defaultMemory.contextSpaceId, 'empty context state should bind to the default context space');
  }

  runtime.db.prepare(`INSERT INTO contact_organizations(
    id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id
  ) VALUES('org_direct_chat_memory','DIRECT-CHAT-MEMORY','Direct Chat Memory Workspace','salt','hash',?)`).run(user.id);
  runtime.db.prepare(`INSERT INTO contact_organization_members(organization_id,user_id,role)
    VALUES('org_direct_chat_memory',?,'owner')`).run(user.id);
  runtime.store.ensureAccountWorkspaces({ user });
  const chatWorkspaceId = 'workspace_org_org_direct_chat_memory';
  runtime.store.switchAccountWorkspace({ userId: user.id, workspaceId: chatWorkspaceId });
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS count FROM memory_documents
    WHERE account_workspace_id=? AND user_agent_instance_id=?`).get(chatWorkspaceId, instance.id).count, 0,
  'direct chat Workspace should not depend on the Memory picker to seed a document');
  runtime.db.prepare(`INSERT INTO agent_context_state(
    user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,
    active_memory_document_id,state_revision,base_state_revision,last_command_id,source_device_id,sync_status
  ) VALUES(?,?,?,'','','',1,0,'legacy_empty_direct_chat_context','local','pending')`).run(user.id, chatWorkspaceId, instance.id);
  runtime.db.prepare(`INSERT INTO agent_device_context_state(
    device_id,user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id
  ) VALUES('local',?,?,?,'','','')`).run(user.id, chatWorkspaceId, instance.id);

  const chat = await runtime.sendChat({
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    chatMode: 'agent',
    routePreference: 'explicit',
    message: '这条首轮消息必须直接存入默认 Memory。',
  });
  assert.equal(chat.answer, 'DEFAULT_MEMORY_OK');
  assert.equal(chat.session.workspaceId, chatWorkspaceId);
  const chatDocuments = runtime.store.listMemoryDocuments({ agentInstanceId: instance.id, workspaceId: chatWorkspaceId });
  assert.equal(chatDocuments.length, 1, 'sending the first message should create exactly one default Memory');
  const chatDefaultMemory = chatDocuments[0];
  assert.equal(chatDefaultMemory.displayName, 'memory0.md');
  const messages = runtime.db.prepare(`SELECT role,memory_id,context_space_id,account_workspace_id
    FROM messages WHERE session_id=? ORDER BY created_at,id`).all(chat.session.id);
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.equal(message.account_workspace_id, chatWorkspaceId);
    assert.equal(message.memory_id, chatDefaultMemory.id, `${message.role} message should be stored in the default Memory`);
    assert.equal(message.context_space_id, chatDefaultMemory.contextSpaceId, `${message.role} message should use the default context space`);
  }
  const directChatState = runtime.store.getDeviceContextState({
    deviceId: 'local', userId: user.id, agentInstanceId: instance.id, workspaceId: chatWorkspaceId,
  });
  assert.equal(directChatState.activeMemoryDocumentId, chatDefaultMemory.id);
  assert.equal(directChatState.activeContextSpaceId, chatDefaultMemory.contextSpaceId);

  const repeatedDocuments = runtime.employeeMemoryDocuments({ agentInstanceId: instance.id });
  assert.deepEqual(repeatedDocuments.map((document) => document.id), [chatDefaultMemory.id], 'default Memory creation must be idempotent');
  assert.deepEqual(runtime.store.listMemoryDocuments({
    agentInstanceId: instance.id,
    workspaceId: pickerWorkspaceId,
  }).map((document) => document.id), [defaultMemory.id], 'opening the picker repeatedly must not duplicate its default Memory');
  assert.deepEqual(runtime.store.listMemoryDocuments({
    agentInstanceId: instance.id,
    workspaceId: 'workspace_personal',
  }).map((document) => document.id), personalMemoryIds, 'the personal Workspace Memory must remain isolated');
  const inventoryAfter = inventory(runtime.db);
  for (const [table, count] of Object.entries(inventoryBefore)) {
    assert.ok(inventoryAfter[table] >= count, `${table} inventory must not decrease`);
  }
  assert.equal(runtime.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(runtime.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  process.stdout.write('Default Agent Memory context smoke passed.\n');
} finally {
  runtime.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (previousCodexBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousCodexBin;
}

function inventory(db) {
  return Object.fromEntries([
    'sessions', 'messages', 'memory_documents', 'memory_document_versions', 'message_attachments',
    'task_runs', 'task_nodes', 'model_executions',
  ].map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get().value || 0)]));
}
