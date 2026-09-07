import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-agent-isolation-'));
const runtimeRoot = path.join(tempRoot, 'workspace');
const fakeCodex = path.join(tempRoot, 'fake-codex.mjs');
const previousCodexBin = process.env.JANUS_CODEX_BIN;
await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli agent-isolation-smoke'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]\\n  --listen <URL>'); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id == null || !message.method) continue;
    if (message.method === 'initialize') { send({ id: message.id, result: { userAgent: 'agent-isolation-smoke' } }); continue; }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: 'agent-isolation-thread' } } }); continue;
    }
    if (message.method === 'thread/memoryMode/set' || message.method === 'thread/goal/get') {
      send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } }); continue;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'agent-isolation-turn' } } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'AGENT_RUNTIME_ISOLATION_OK' } } });
      send({ method: 'turn/completed', params: { usage: { input_tokens: 10, output_tokens: 5 }, turn: { id: 'agent-isolation-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'AGENT_RUNTIME_ISOLATION_OK' }] } } });
      continue;
    }
    send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
  }
  process.exit(0);
}
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], 'AGENT_RUNTIME_ISOLATION_OK', 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'agent-isolation-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'AGENT_RUNTIME_ISOLATION_OK' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
let runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });

try {
  const user = runtime.currentUser();
  const agentA = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || runtime.store.recruitUserAgent({
      userId: user.id,
      agentFamilyId: 'general_agent',
      commandId: 'agent-isolation:recruit-a',
    }).instance;
  const agentB = runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'general_agent',
    commandId: 'agent-isolation:recruit-b',
  }).instance;
  assert.notEqual(agentA.id, agentB.id, 'same-family employees must remain distinct people');

  const sessionA = runtime.store.createSession({
    title: 'Agent A primary', departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: agentA.id, userId: user.id,
  });
  const sessionB = runtime.store.createSession({
    title: 'Agent B primary', departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: agentB.id, userId: user.id,
  });
  assert.notEqual(sessionA.id, sessionB.id, 'different Agent instances must have different primary sessions');
  const staleHistoryB = runtime.store.createSession({
    title: 'Agent B stale history', departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: agentB.id, userId: user.id, reusePrimary: false,
  });
  runtime.store.db.prepare(`UPDATE sessions SET conversation_role='history',write_state='read_only',
    superseded_by_session_id=? WHERE id=?`).run(sessionB.id, staleHistoryB.id);
  runtime.store.db.prepare(`UPDATE agent_context_state SET primary_session_id=?,sync_status='synced',
    state_revision=2,base_state_revision=2 WHERE user_id=? AND user_agent_instance_id=?`).run(staleHistoryB.id, user.id, agentB.id);
  runtime.store.db.prepare(`UPDATE agent_device_context_state SET primary_session_id=?
    WHERE device_id='local' AND user_agent_instance_id=?`).run(staleHistoryB.id, agentB.id);
  const repairedContextB = runtime.store.getDeviceContextState({ deviceId: 'local', userId: user.id, agentInstanceId: agentB.id });
  assert.equal(repairedContextB.primarySessionId, sessionB.id, 'stale historical context pointers must heal to the writable primary session');
  const repairedAccountB = runtime.store.getAgentContextState({ userId: user.id, agentInstanceId: agentB.id, deviceId: 'local' });
  assert.equal(repairedAccountB.primarySessionId, sessionB.id);
  assert.equal(repairedAccountB.syncStatus, 'pending');
  assert.equal(repairedAccountB.baseStateRevision, 2);

  const messageA = runtime.store.addMessage({
    sessionId: sessionA.id, role: 'user', content: 'A_ONLY_MESSAGE',
    agentId: 'general_agent', agentInstanceId: agentA.id, departmentId: 'general',
  });
  const messageB = runtime.store.addMessage({
    sessionId: sessionB.id, role: 'user', content: 'B_ONLY_MESSAGE',
    agentId: 'general_agent', agentInstanceId: agentB.id, departmentId: 'general',
  });
  const messageBWithErasedIdentity = runtime.store.addMessage({
    sessionId: sessionB.id, role: 'user', content: 'B_ERASED_IDENTITY_MESSAGE',
    agentId: 'general_agent', agentInstanceId: agentB.id, departmentId: 'general',
  });
  assert.deepEqual(runtime.store.listMessages(sessionA.id).map((item) => item.content), ['A_ONLY_MESSAGE']);
  assert.deepEqual(runtime.store.listMessages(sessionB.id).map((item) => item.content), ['B_ONLY_MESSAGE', 'B_ERASED_IDENTITY_MESSAGE']);
  assert.throws(() => runtime.store.addMessage({
    sessionId: sessionA.id, role: 'user', content: 'MUST_BE_REJECTED',
    agentId: 'general_agent', agentInstanceId: agentB.id, departmentId: 'general',
  }), /does not match the session Agent instance|message_session_agent_mismatch/);
  runtime.saveCodexConfig({ apiKey: 'sk-agent-isolation-smoke', model: 'gpt-5.6-sol', reasoningEffort: 'medium' });
  const runtimeA = await runtime.sendChat({
    sessionId: sessionA.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: agentA.id,
    routePreference: 'explicit', chatMode: 'agent', message: 'A_RUNTIME_ONLY',
  });
  assert.equal(runtime.store.getUserAgentInstance(agentB.id)?.agentFamilyId, 'general_agent', 'Agent B identity changed while Agent A was running');
  const runtimeB = await runtime.sendChat({
    sessionId: sessionA.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: agentB.id,
    routePreference: 'explicit', chatMode: 'agent', message: 'B_RUNTIME_ONLY',
  });
  const greetingEvents = [];
  const runtimeBGreeting = await runtime.sendChat({
    sessionId: '', departmentId: 'general', agentId: 'general_agent', agentInstanceId: agentB.id,
    routePreference: 'explicit', chatMode: 'agent', message: '你好',
    onEvent: (event) => greetingEvents.push(event),
  });
  runtime.store.db.prepare(`INSERT INTO user_agent_instance_aliases
    (alias_instance_id,canonical_instance_id,user_id,reason) VALUES (?,?,?,?)`)
    .run('agent-a-provisional-alias', agentA.id, user.id, 'route-alignment-smoke');
  const runtimeAFromExplicitAlias = await runtime.sendChat({
    sessionId: sessionA.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: 'agent-a-provisional-alias',
    routePreference: 'explicit', chatMode: 'agent', message: 'A_RUNTIME_ALIAS',
  });
  assert.equal(runtimeA.session.id, sessionA.id);
  assert.equal(runtimeB.session.id, sessionB.id, 'explicit Agent B selection must discard Agent A session id');
  assert.equal(runtimeBGreeting.session.id, sessionB.id, 'a greeting sent to Agent B must stay on Agent B instead of becoming plain chat');
  assert.equal(runtimeBGreeting.session.agentInstanceId, agentB.id);
  assert.equal(runtimeBGreeting.session.agentId, 'general_agent');
  assert.equal(greetingEvents.find((event) => event.kind === 'start')?.agentInstanceId, agentB.id);
  assert.equal(greetingEvents.find((event) => event.kind === 'done')?.agentInstanceId, agentB.id);
  assert.equal(runtimeAFromExplicitAlias.session.id, sessionA.id,
    'an explicit instance alias must resolve to that exact person instead of another same-family employee');
  assert.equal(runtime.store.listMessages(sessionA.id).some((item) => item.content === 'B_RUNTIME_ONLY'), false);
  assert.equal(runtime.store.listMessages(sessionB.id).some((item) => item.content === 'A_RUNTIME_ONLY'), false);

  const mergeCanonical = runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'general_agent',
    commandId: 'agent-isolation:merge-canonical',
  }).instance;
  const mergeAlias = runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'general_agent',
    commandId: 'agent-isolation:merge-alias',
  }).instance;
  const mergeAliasSession = runtime.store.createSession({
    title: 'Alias identity active session', departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: mergeAlias.id, userId: user.id,
  });
  let identityMergedDuringAnswer = false;
  const mergedDuringChat = await runtime.sendChat({
    sessionId: mergeAliasSession.id,
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: mergeAlias.id,
    routePreference: 'explicit',
    chatMode: 'agent',
    message: 'IDENTITY_MERGE_DURING_ANSWER',
    onEvent: (event) => {
      if (identityMergedDuringAnswer || event.kind !== 'answer') return;
      runtime.store.bindCanonicalAgentInstance({
        userId: user.id,
        aliasInstanceId: mergeAlias.id,
        canonicalInstanceId: mergeCanonical.id,
        reason: 'active_chat_identity_merge_smoke',
      });
      identityMergedDuringAnswer = true;
    },
  });
  assert.equal(identityMergedDuringAnswer, true, 'identity merge hook must run after generation starts and before answer persistence');
  assert.equal(mergedDuringChat.session.id, mergeAliasSession.id,
    'the active session must remain the writable winner during an identity merge');
  assert.equal(mergedDuringChat.session.agentInstanceId, mergeCanonical.id);
  assert.equal(mergedDuringChat.message.agentInstanceId, mergeCanonical.id);
  assert.deepEqual(
    runtime.store.listMessages(mergeAliasSession.id)
      .filter((item) => ['user', 'assistant'].includes(item.role))
      .slice(-2)
      .map((item) => ({ content: item.content, agentInstanceId: item.agentInstanceId })),
    [
      { content: 'IDENTITY_MERGE_DURING_ANSWER', agentInstanceId: mergeCanonical.id },
      { content: 'AGENT_RUNTIME_ISOLATION_OK', agentInstanceId: mergeCanonical.id },
    ],
  );

  const initialA = runtime.store.listMemoryDocuments({ agentInstanceId: agentA.id }).find((item) => item.scope === 'general');
  const initialB = runtime.store.listMemoryDocuments({ agentInstanceId: agentB.id }).find((item) => item.scope === 'general');
  const nextA = runtime.store.createNextGeneralMemoryDocument({ agentInstanceId: agentA.id, displayName: 'a-memory-2', content: 'A_MEMORY_2' });
  const nextB = runtime.store.createNextGeneralMemoryDocument({ agentInstanceId: agentB.id, displayName: 'b-memory-2', content: 'B_MEMORY_2' });
  const documentsA = runtime.store.listMemoryDocuments({ agentInstanceId: agentA.id });
  const documentsB = runtime.store.listMemoryDocuments({ agentInstanceId: agentB.id });
  assert.ok(documentsA.length >= 2 && documentsB.length >= 2, 'each Agent must support multiple Memory documents');
  assert.equal(documentsA.filter((item) => item.lifecycleState === 'active').length, 1);
  assert.equal(documentsB.filter((item) => item.lifecycleState === 'active').length, 1);
  assert.equal(documentsA.some((item) => documentsB.some((other) => other.id === item.id)), false);

  runtime.store.switchCurrentMemory({ agentInstanceId: agentA.id, memoryDocumentId: initialA.id });
  assert.equal(runtime.store.getMemoryDocument(initialA.id).lifecycleState, 'active');
  assert.equal(runtime.store.getMemoryDocument(nextA.id).lifecycleState, 'inactive');
  assert.equal(runtime.store.getMemoryDocument(nextB.id).lifecycleState, 'active', 'switching Agent A Memory must not change Agent B Memory');
  assert.equal(runtime.store.getMemoryDocument(initialB.id).lifecycleState, 'inactive');
  assert.throws(() => runtime.store.db.prepare(`INSERT INTO agent_context_spaces(
    id,user_id,user_agent_instance_id,context_kind,memory_document_id
  ) VALUES('ctx_cross_agent_test',?,?,?,?)`).run(user.id, agentA.id, 'general_memory', nextB.id), /context_space_memory_agent_mismatch/);

  runtime.store.db.exec(`DROP TRIGGER trg_messages_agent_identity_insert;
    DROP TRIGGER trg_messages_agent_identity_update`);
  runtime.store.db.prepare("UPDATE messages SET session_id=?,agent_instance_id='',agent_id='general_agent' WHERE id=?")
    .run(sessionA.id, messageB.id);
  runtime.store.db.prepare("UPDATE messages SET session_id=?,agent_instance_id='',agent_id='general_agent' WHERE id=?")
    .run(sessionA.id, messageBWithErasedIdentity.id);
  runtime.store.db.prepare("DELETE FROM schema_migrations WHERE id IN ('agent_conversation_memory_isolation_v1','message_session_agent_consistency_repair_v2')").run();
  runtime.close();
  runtime = null;

  const migratedDb = openDatabase(runtimeRoot, { skipMigrationBackup: true });
  try {
    const repaired = migratedDb.prepare('SELECT session_id,agent_instance_id,agent_id FROM messages WHERE id=?').get(messageB.id);
    assert.equal(repaired.session_id, sessionB.id, 'historically mixed message must move back to the matching Agent primary session');
    assert.equal(repaired.agent_instance_id, agentB.id);
    assert.equal(repaired.agent_id, 'general_agent');
    const evidenceRepaired = migratedDb.prepare('SELECT session_id,agent_instance_id,agent_id FROM messages WHERE id=?').get(messageBWithErasedIdentity.id);
    assert.equal(evidenceRepaired.session_id, sessionB.id, 'durable message evidence must recover an erased same-family Agent instance');
    assert.equal(evidenceRepaired.agent_instance_id, agentB.id);
    assert.equal(evidenceRepaired.agent_id, 'general_agent');
    assert.equal(migratedDb.prepare('SELECT COUNT(*) AS value FROM messages WHERE session_id=? AND id=?').get(sessionA.id, messageB.id).value, 0);
    assert.ok(migratedDb.prepare("SELECT 1 FROM schema_migrations WHERE id='agent_conversation_memory_isolation_v1'").get());
  } finally {
    migratedDb.close();
  }

  process.stdout.write('Agent conversation and Memory isolation smoke passed.\n');
} finally {
  runtime?.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (previousCodexBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousCodexBin;
}
