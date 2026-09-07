import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { migrateDatabase } from '../src/main/modules/persistence/index.js';
import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-agent-workspace-continuity-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const projectARoot = path.join(tempRoot, 'project-a');
const projectBRoot = path.join(tempRoot, 'project-b');
const fakeCodex = path.join(tempRoot, 'fake-codex.mjs');
const previousCodexBin = process.env.JANUS_CODEX_BIN;

fs.mkdirSync(projectARoot, { recursive: true });
fs.mkdirSync(projectBRoot, { recursive: true });
await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli workspace-continuity-smoke'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]\\n  --listen <URL>'); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id == null || !message.method) continue;
    if (message.method === 'initialize') { send({ id: message.id, result: { userAgent: 'workspace-continuity-smoke' } }); continue; }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: 'workspace-continuity-thread' } } }); continue;
    }
    if (message.method === 'thread/memoryMode/set' || message.method === 'thread/goal/get') {
      send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } }); continue;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'workspace-continuity-turn' } } });
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'WORKSPACE_CONTINUITY_OK' } } });
      send({ method: 'turn/completed', params: { usage: { input_tokens: 20, output_tokens: 5 }, turn: { id: 'workspace-continuity-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'WORKSPACE_CONTINUITY_OK' }] } } });
      continue;
    }
    send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
  }
  process.exit(0);
}
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], 'WORKSPACE_CONTINUITY_OK', 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'workspace-continuity-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'WORKSPACE_CONTINUITY_OK' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } }));
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
      commandId: 'workspace-continuity:recruit-general',
    }).instance;
  runtime.saveCodexConfig({ apiKey: 'sk-workspace-continuity-smoke', model: 'gpt-5.6-sol', reasoningEffort: 'medium' });

  const memoryA = runtime.store.listMemoryDocuments({ agentInstanceId: instance.id })
    .find((item) => item.scope === 'general' && item.lifecycleState === 'active');
  const session = runtime.store.createSession({
    title: 'Stable Agent conversation',
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    userId: user.id,
  });
  const conversationContextA = runtime.store.getAgentConversationContextSpace({
    userId: user.id,
    agentInstanceId: instance.id,
  });
  const attachment = runtime.uploadFile({
    filename: 'continuity-note.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('ATTACHMENT_CONTINUITY_OK').toString('base64'),
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'MESSAGE_BEFORE_WORKSPACE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    metadata: { attachments: [attachment] },
  });
  runtime.store.db.prepare(`UPDATE agent_conversation_branch_state SET rebuild_required=1
    WHERE user_id=? AND account_workspace_id='workspace_personal' AND agent_instance_id=?`).run(user.id, instance.id);

  const projectA = runtime.createProject({ title: 'Project A', workspaceRoot: projectARoot });
  const inProjectA = await runtime.sendChat({
    sessionId: session.id,
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    projectId: projectA.id,
    workspaceRoot: projectARoot,
    chatMode: 'agent',
    routePreference: 'explicit',
    message: 'MESSAGE_IN_PROJECT_A',
  });
  assert.equal(inProjectA.session.id, session.id, 'selecting a workspace must reuse the stable Agent session');
  assert.equal(runtime.store.getAgentConversationBranch({
    userId: user.id, workspaceId: 'workspace_personal', agentInstanceId: instance.id,
  }).rebuildRequired, false, 'the rebuilt Workspace thread must become ready only after the answer is persisted');
  assert.equal(runtime.store.getAgentContextState({ userId: user.id, agentInstanceId: instance.id }).activeMemoryDocumentId, memoryA.id);
  assert.equal(runtime.store.getAgentConversationContextSpace({ userId: user.id, agentInstanceId: instance.id }).id, conversationContextA.id);

  const projectB = runtime.createProject({ title: 'Project B', workspaceRoot: projectBRoot });
  const inProjectB = await runtime.sendChat({
    sessionId: session.id,
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    projectId: projectB.id,
    workspaceRoot: projectBRoot,
    chatMode: 'agent',
    routePreference: 'explicit',
    message: 'MESSAGE_IN_PROJECT_B',
  });
  assert.equal(inProjectB.session.id, session.id, 'changing workspaces must not create a new session');

  const detached = await runtime.sendChat({
    sessionId: session.id,
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    workspaceDetached: true,
    chatMode: 'agent',
    routePreference: 'explicit',
    message: 'MESSAGE_WITHOUT_WORKSPACE',
  });
  assert.equal(detached.session.id, session.id, 'clearing the workspace must keep the same session');
  assert.equal(detached.session.projectId, '');
  assert.equal(detached.session.workspaceRoot, '');

  const memoryAMessages = runtime.listMessages(session.id);
  for (const expected of ['MESSAGE_BEFORE_WORKSPACE', 'MESSAGE_IN_PROJECT_A', 'MESSAGE_IN_PROJECT_B', 'MESSAGE_WITHOUT_WORKSPACE']) {
    assert.ok(memoryAMessages.some((item) => item.content.includes(expected)), `${expected} must remain visible in Memory A`);
  }
  const originalAttachmentMessage = memoryAMessages.find((item) => item.content === 'MESSAGE_BEFORE_WORKSPACE');
  assert.equal(originalAttachmentMessage.metadata.attachments[0].name, attachment.name);

  const memoryB = runtime.store.createNextGeneralMemoryDocument({
    agentInstanceId: instance.id,
    displayName: 'memory-b.md',
    content: '# Memory B',
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'MEMORY_B_ONLY_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
  });
  assert.equal(runtime.listMessages(session.id).some((item) => item.content === 'MEMORY_B_ONLY_MESSAGE'), true);
  assert.equal(runtime.listMessages(session.id).some((item) => item.content === 'MESSAGE_BEFORE_WORKSPACE'), true,
    'switching Memory must not hide the earlier messages from the single visual conversation');
  runtime.store.switchCurrentMemory({ agentInstanceId: instance.id, memoryDocumentId: memoryA.id, workspaceId: memoryA.workspaceId });
  assert.equal(runtime.listMessages(session.id).some((item) => item.content === 'MEMORY_B_ONLY_MESSAGE'), true,
    'switching back to an older Memory must keep the unified visual timeline intact');
  assert.ok(runtime.listMessages(session.id).some((item) => item.content === 'MESSAGE_BEFORE_WORKSPACE'));
  assert.equal(runtime.store.getMemoryDocument(memoryB.id).lifecycleState, 'inactive');

  const legacyProjectContext = runtime.store.ensureAgentContextSpace({
    userId: user.id,
    agentInstanceId: instance.id,
    contextKind: 'project',
    projectId: projectA.id,
  });
  const splitSession = runtime.store.createSession({
    title: 'Legacy workspace split',
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    projectId: projectA.id,
    workspaceRoot: projectARoot,
    userId: user.id,
    reusePrimary: false,
  });
  const splitMessage = runtime.store.addMessage({
    sessionId: splitSession.id,
    role: 'assistant',
    content: 'LEGACY_SPLIT_ATTACHMENT_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    contextSpaceId: legacyProjectContext.id,
    metadata: { attachments: [attachment], generatedFiles: [{ name: 'legacy-output.md' }] },
  });
  runtime.store.db.prepare(`UPDATE sessions SET conversation_role='history',write_state='read_only',
    superseded_by_session_id=? WHERE id=?`).run(session.id, splitSession.id);
  runtime.store.touchSession(session.id);
  runtime.store.db.exec(`DROP TRIGGER trg_messages_agent_identity_insert;
    DROP TRIGGER trg_messages_agent_identity_update`);
  runtime.store.db.prepare("UPDATE messages SET agent_id='',agent_instance_id='',department_id='' WHERE id=?").run(splitMessage.id);
  runtime.store.db.prepare("DELETE FROM schema_migrations WHERE id='message_session_agent_consistency_repair_v2'").run();
  runtime.store.db.prepare("DELETE FROM schema_migrations WHERE id='legacy_message_session_agent_backfill_v1'").run();
  runtime.store.db.prepare("DELETE FROM schema_migrations WHERE id='workspace_context_conversation_continuity_v1'").run();
  migrateDatabase(runtime.store.db);

  const migratedSplit = runtime.store.getMessage(splitMessage.id);
  assert.equal(migratedSplit.sessionId, session.id, 'legacy workspace-split messages must be rebound to the primary conversation');
  assert.equal(migratedSplit.agentId, 'general_agent', 'legacy messages must recover the Agent family from their session');
  assert.equal(migratedSplit.agentInstanceId, instance.id, 'legacy messages must recover the Agent instance before strict triggers run');
  assert.equal(migratedSplit.departmentId, 'general');
  assert.equal(migratedSplit.contextSpaceId, conversationContextA.id, 'legacy project scope must be rebound to the active Memory scope');
  assert.equal(runtime.store.getSession(splitSession.id).status, 'deleted');
  assert.ok(runtime.listMessages(session.id).some((item) => item.content === 'LEGACY_SPLIT_ATTACHMENT_MESSAGE'));
  assert.equal(migratedSplit.metadata.attachments[0].name, attachment.name);
  assert.equal(migratedSplit.metadata.generatedFiles[0].name, 'legacy-output.md');

  process.stdout.write('Agent workspace chat continuity smoke passed.\n');
} finally {
  runtime.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (previousCodexBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousCodexBin;
}
