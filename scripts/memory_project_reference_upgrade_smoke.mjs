import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-memory-reference-upgrade-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const projectRoot = path.join(tempRoot, 'project');
const outsideFile = path.join(tempRoot, 'outside-secret.txt');
const fakeCodex = path.join(tempRoot, 'fake-codex.mjs');
const promptLog = path.join(tempRoot, 'prompts.log');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousLog = process.env.JANUS_REFERENCE_PROMPT_LOG;

fs.mkdirSync(path.join(projectRoot, 'src', 'nested'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'README.md'), 'ROOT_REFERENCE_CONTENT', 'utf8');
fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), 'PROJECT_REFERENCE_APP_CONTENT', 'utf8');
fs.writeFileSync(path.join(projectRoot, 'src', 'nested', 'deep.txt'), 'DEEP_REFERENCE_CONTENT', 'utf8');
fs.writeFileSync(path.join(projectRoot, '.env'), 'TOKEN_MUST_NOT_APPEAR', 'utf8');
fs.writeFileSync(outsideFile, 'OUTSIDE_SECRET_MUST_NOT_APPEAR', 'utf8');
try { fs.symlinkSync(outsideFile, path.join(projectRoot, 'outside-link.txt')); } catch {}

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli memory-reference-upgrade'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server'); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'memory-reference-upgrade' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'memory-reference-thread-' + Date.now() } } });
    else if (message.method === 'thread/memoryMode/set' || message.method?.startsWith('thread/goal/')) {
      if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
      else send({ id: message.id, result: {} });
    } else if (message.method === 'turn/start') {
      const prompt = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
      fs.appendFileSync(process.env.JANUS_REFERENCE_PROMPT_LOG, '\\n---TURN---\\n' + prompt, 'utf8');
      send({ id: message.id, result: { turn: { id: 'memory-reference-turn' } } });
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'REFERENCE_UPGRADE_OK' } } });
      send({ method: 'turn/completed', params: { turn: { id: 'memory-reference-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'REFERENCE_UPGRADE_OK' }] } } });
    } else send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  }
}
`, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_REFERENCE_PROMPT_LOG = promptLog;

const runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });
try {
  const user = runtime.currentUser();
  const instance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || runtime.store.recruitUserAgent({ userId: user.id, agentFamilyId: 'general_agent', commandId: 'memory-reference-upgrade:recruit' }).instance;
  runtime.saveCodexConfig({ apiKey: 'sk-memory-reference-upgrade', model: 'gpt-5.6-sol', reasoningEffort: 'medium' });

  const memoryA = runtime.store.listMemoryDocuments({ agentInstanceId: instance.id }).find((item) => item.scope === 'general');
  const originalVersionCount = runtime.store.listMemoryDocumentVersions({ memoryDocumentId: memoryA.id }).length;
  const renamed = runtime.store.renameMemoryDocument({ memoryDocumentId: memoryA.id, displayName: '  数据库迁移讨论  ' });
  assert.equal(renamed.displayName, '数据库迁移讨论');
  assert.equal(renamed.id, memoryA.id);
  assert.equal(runtime.store.listMemoryDocumentVersions({ memoryDocumentId: memoryA.id }).length, originalVersionCount,
    'rename must not create a user-visible Memory version');

  const session = runtime.store.createSession({
    title: 'Memory product upgrade', departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: instance.id, userId: user.id,
  });
  runtime.store.addMessage({
    sessionId: session.id, role: 'user', content: 'MEMORY_A_ONLY_MESSAGE',
    agentId: 'general_agent', agentInstanceId: instance.id, departmentId: 'general',
  });
  const memoryB = runtime.store.createNextGeneralMemoryDocument({ agentInstanceId: instance.id, displayName: '发布计划' });
  runtime.store.addMessage({
    sessionId: session.id, role: 'user', content: 'MEMORY_B_ONLY_MESSAGE',
    agentId: 'general_agent', agentInstanceId: instance.id, departmentId: 'general',
  });
  assert.throws(() => runtime.store.archiveMemoryDocument({ memoryDocumentId: memoryB.id }), /当前 Memory 不能直接归档/);

  const revisionBeforeSwitch = runtime.store.getAgentContextState({ userId: user.id, agentInstanceId: instance.id }).stateRevision;
  runtime.store.switchCurrentMemory({ agentInstanceId: instance.id, memoryDocumentId: memoryA.id, expectedStateRevision: revisionBeforeSwitch });
  assert.throws(() => runtime.store.switchCurrentMemory({
    agentInstanceId: instance.id, memoryDocumentId: memoryB.id, expectedStateRevision: revisionBeforeSwitch,
  }), /其他设备发生变化/);
  assert.equal(runtime.store.getDeviceContextState({ userId: user.id, agentInstanceId: instance.id }).activeMemoryDocumentId, memoryA.id,
    'stale switch must roll back without changing the active Memory');

  const sameSelectionAccountState = runtime.store.getAgentContextState({ userId: user.id, agentInstanceId: instance.id });
  const sameSelectionDeviceState = runtime.store.getDeviceContextState({ userId: user.id, agentInstanceId: instance.id });
  runtime.store.db.prepare(`UPDATE agent_context_state SET state_revision=state_revision+1,updated_at=datetime('now')
    WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`).run(
    user.id, sameSelectionAccountState.workspaceId, instance.id,
  );
  runtime.switchEmployeeMemory({
    agentInstanceId: instance.id,
    memoryDocumentId: memoryB.id,
    expectedStateRevision: sameSelectionAccountState.stateRevision,
    expectedActiveContextSpaceId: sameSelectionDeviceState.activeContextSpaceId,
    expectedActiveMemoryDocumentId: sameSelectionDeviceState.activeMemoryDocumentId,
  });
  assert.equal(runtime.store.getDeviceContextState({ userId: user.id, agentInstanceId: instance.id }).activeMemoryDocumentId, memoryB.id,
    'an unrelated local revision update must not block a switch when the observed Memory selection is still current');

  const changedSelectionAccountState = runtime.store.getAgentContextState({ userId: user.id, agentInstanceId: instance.id });
  const changedSelectionDeviceState = runtime.store.getDeviceContextState({ userId: user.id, agentInstanceId: instance.id });
  runtime.store.switchCurrentMemory({ agentInstanceId: instance.id, memoryDocumentId: memoryA.id });
  assert.throws(() => runtime.switchEmployeeMemory({
    agentInstanceId: instance.id,
    memoryDocumentId: memoryB.id,
    expectedStateRevision: changedSelectionAccountState.stateRevision,
    expectedActiveContextSpaceId: changedSelectionDeviceState.activeContextSpaceId,
    expectedActiveMemoryDocumentId: changedSelectionDeviceState.activeMemoryDocumentId,
  }), (error) => error.code === 'memory_context_state_conflict'
    && error.details.currentActiveMemoryDocumentId === memoryA.id);
  assert.equal(runtime.store.getDeviceContextState({ userId: user.id, agentInstanceId: instance.id }).activeMemoryDocumentId, memoryA.id,
    'a genuine active Memory change must still reject and roll back a stale switch');

  runtime.store.archiveMemoryDocument({ memoryDocumentId: memoryB.id });
  const restored = runtime.store.restoreMemoryDocument({ memoryDocumentId: memoryB.id });
  assert.equal(restored.lifecycleState, 'inactive');
  assert.equal(runtime.store.getDeviceContextState({ userId: user.id, agentInstanceId: instance.id }).activeMemoryDocumentId, memoryA.id,
    'restore must not switch the active Memory');
  runtime.store.archiveMemoryDocument({ memoryDocumentId: memoryB.id });
  runtime.store.updateSessionThread(session.id, 'thread-before-restore-switch');
  const restoreRevision = runtime.store.getAgentContextState({ userId: user.id, agentInstanceId: instance.id }).stateRevision;
  runtime.store.restoreAndSwitchCurrentMemory({ agentInstanceId: instance.id, memoryDocumentId: memoryB.id, expectedStateRevision: restoreRevision });
  assert.equal(runtime.store.getDeviceContextState({ userId: user.id, agentInstanceId: instance.id }).activeMemoryDocumentId, memoryB.id);
  assert.equal(runtime.store.getSession(session.id).codexThreadId, '');
  const detailsB = runtime.store.getMemoryContextDetails({ memoryDocumentId: memoryB.id });
  assert.equal(detailsB.document.messageCount, 1);
  assert.match(detailsB.document.summary, /MEMORY_B_ONLY_MESSAGE/);
  runtime.store.addMessage({
    sessionId: session.id, role: 'user',
    content: `ARCHIVED_REFERENCE_SUMMARY ${'x'.repeat(160)} FULL_ARCHIVE_TAIL_MUST_NOT_APPEAR`,
    agentId: 'general_agent', agentInstanceId: instance.id, departmentId: 'general', contextSpaceId: memoryA.contextSpaceId,
  });
  runtime.store.archiveMemoryDocument({ memoryDocumentId: memoryA.id });

  const project = runtime.createProject({ title: 'Reference fixture', workspaceRoot: projectRoot });
  const rootListing = runtime.browseProjectFiles({ projectId: project.id });
  assert.ok(rootListing.entries.some((item) => item.relativePath === 'src' && item.kind === 'directory'));
  assert.ok(rootListing.entries.some((item) => item.relativePath === 'README.md'));
  assert.equal(rootListing.entries.some((item) => item.relativePath === 'src/app.js'), false, 'root browse must not recursively expose the project tree');
  assert.equal(rootListing.entries.some((item) => item.name === '.env' || item.name === 'outside-link.txt'), false,
    'sensitive files and symlinks must be filtered from the picker');
  const srcListing = runtime.browseProjectFiles({ projectId: project.id, directory: 'src', query: 'app' });
  assert.deepEqual(srcListing.entries.map((item) => item.relativePath), ['src/app.js']);
  const pathQueryListing = runtime.browseProjectFiles({ projectId: project.id, query: 'src/nest' });
  assert.equal(pathQueryListing.directory, 'src');
  assert.deepEqual(pathQueryListing.entries.map((item) => item.relativePath), ['src/nested', 'src/nested/deep.txt']);

  const projectSession = runtime.store.updateSession(session.id, { projectId: project.id, workspaceRoot: projectRoot });
  const originalUpload = path.join(tempRoot, 'original-upload.txt');
  fs.writeFileSync(originalUpload, 'MANAGED_UPLOAD_SURVIVES_ORIGINAL_DELETE', 'utf8');
  const managedUpload = runtime.uploadFileFromPath({ sourcePath: originalUpload, filename: 'managed-upload.txt', contentType: 'text/plain' });
  fs.rmSync(originalUpload, { force: true });
  runtime.store.addMessage({
    sessionId: projectSession.id, role: 'user', content: '这是当前 Memory 的普通上传附件。',
    agentId: 'general_agent', agentInstanceId: instance.id, departmentId: 'general', metadata: { attachments: [managedUpload] },
  });
  const reference = {
    referenceId: 'project-reference-app', referenceKind: 'file', projectId: project.id,
    relativePath: 'src/app.js', name: 'app.js', source: 'picker',
  };
  const result = await runtime.sendChat({
    sessionId: projectSession.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: instance.id,
    routePreference: 'explicit', chatMode: 'agent', projectId: project.id, workspaceRoot: projectRoot,
    message: '请读取明确引用的项目文件和只读历史摘要。', fileReferences: [reference],
    memoryReferences: [{ referenceId: 'archived-memory-reference', sourceMemoryId: memoryA.id, source: 'picker' }],
  });
  assert.equal(result.answer, 'REFERENCE_UPGRADE_OK');
  const firstPrompt = fs.readFileSync(promptLog, 'utf8');
  assert.match(firstPrompt, /PROJECT_REFERENCE_APP_CONTENT/);
  assert.match(firstPrompt, /MANAGED_UPLOAD_SURVIVES_ORIGINAL_DELETE/);
  assert.match(firstPrompt, /只读项目文件引用：src\/app\.js/);
  assert.match(firstPrompt, /只读历史 Memory 引用：数据库迁移讨论/);
  assert.match(firstPrompt, /ARCHIVED_REFERENCE_SUMMARY/);
  assert.doesNotMatch(firstPrompt, /FULL_ARCHIVE_TAIL_MUST_NOT_APPEAR/);
  assert.doesNotMatch(firstPrompt, /OUTSIDE_SECRET_MUST_NOT_APPEAR|TOKEN_MUST_NOT_APPEAR/);
  const storedRequest = runtime.store.listMessages(projectSession.id).find((item) => item.metadata?.fileReferences?.length);
  assert.equal(storedRequest.metadata.fileReferences[0].relativePath, 'src/app.js');
  assert.equal(JSON.stringify(storedRequest.metadata.fileReferences).includes(projectRoot), false, 'message metadata must not expose local absolute paths');
  const persistedReference = runtime.store.db.prepare("SELECT * FROM message_attachments WHERE message_id=? AND relation_type='project_reference'").get(storedRequest.id);
  assert.ok(persistedReference);
  assert.equal(persistedReference.local_path, '');
  assert.equal(JSON.parse(persistedReference.metadata_json).relativePath, 'src/app.js');
  assert.equal(storedRequest.metadata.memoryReferences[0].sourceMemoryId, memoryA.id);
  assert.equal(storedRequest.metadata.memoryReferences[0].readOnly, true);
  runtime.store.syncMessageAttachments(storedRequest.id, storedRequest.metadata);
  assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS value FROM message_attachments WHERE message_id=? AND relation_type='project_reference'").get(storedRequest.id).value, 1,
    'reapplying the same message metadata must not duplicate project references');

  await runtime.sendChat({
    sessionId: projectSession.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: instance.id,
    routePreference: 'explicit', chatMode: 'agent', projectId: project.id, workspaceRoot: projectRoot,
    message: '继续当前 Memory，不重新选择文件。',
  });
  assert.match(lastPromptTurn(promptLog), /PROJECT_REFERENCE_APP_CONTENT/,
    'an unchanged project reference must remain readable when continuing the same Memory');
  fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), 'PROJECT_REFERENCE_CHANGED_CONTENT', 'utf8');
  await runtime.sendChat({
    sessionId: projectSession.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: instance.id,
    routePreference: 'explicit', chatMode: 'agent', projectId: project.id, workspaceRoot: projectRoot,
    message: '文件变化后继续当前 Memory。',
  });
  const changedPrompt = lastPromptTurn(promptLog);
  assert.match(changedPrompt, /file changed after it was referenced/);
  assert.doesNotMatch(changedPrompt, /PROJECT_REFERENCE_CHANGED_CONTENT/,
    'a changed project file must not silently replace the historical referenced content');

  const rendererSource = fs.readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
  assert.match(rendererSource, /\.\.\.memoryContextSwitchExpectation\(state\.employeeMemoryDrawer\?\.contexts\)/,
    'the Employee Memory drawer must submit its observed Memory selection with the revision');
  assert.match(rendererSource, /\.\.\.memoryContextSwitchExpectation\(state\.composerMemoryContext\)/,
    'the composer Memory menu must submit its observed Memory selection with the revision');
  assert.match(rendererSource, /memory_context_state_conflict[^]*openEmployeeMemory\(agentInstanceId\)/,
    'the Employee Memory drawer must refresh after a genuine context conflict');
  fs.rmSync(path.join(projectRoot, 'src', 'app.js'), { force: true });
  await runtime.sendChat({
    sessionId: projectSession.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: instance.id,
    routePreference: 'explicit', chatMode: 'agent', projectId: project.id, workspaceRoot: projectRoot,
    message: '文件删除后继续当前 Memory。',
  });
  assert.match(lastPromptTurn(promptLog), /file is missing or inaccessible/);

  await assert.rejects(() => runtime.sendChat({
    sessionId: projectSession.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: instance.id,
    routePreference: 'explicit', chatMode: 'agent', projectId: project.id, workspaceRoot: projectRoot,
    message: '伪造引用', fileReferences: [{ ...reference, referenceId: 'manual-reference', source: 'manual' }],
  }), /请从 @ 菜单重新选择/);
  await assert.rejects(() => runtime.sendChat({
    sessionId: projectSession.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: instance.id,
    routePreference: 'explicit', chatMode: 'agent', projectId: project.id, workspaceRoot: projectRoot,
    message: '越界引用', fileReferences: [{ ...reference, referenceId: 'escape-reference', relativePath: '../outside-secret.txt' }],
  }), /请从 @ 菜单重新选择/);

  process.stdout.write('Memory context and project @ reference upgrade smoke passed.\n');
} finally {
  runtime.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousLog === undefined) delete process.env.JANUS_REFERENCE_PROMPT_LOG;
  else process.env.JANUS_REFERENCE_PROMPT_LOG = previousLog;
}

function lastPromptTurn(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n---TURN---\n').at(-1) || '';
}
