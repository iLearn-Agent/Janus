import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DataType, newDb } from 'pg-mem';

import { migrate } from '../cloud/src/db.mjs';
import { createApp } from '../cloud/src/server.mjs';
import { createRuntime } from '../src/main/runtime.js';

const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
memoryDb.public.registerFunction({ name: 'decode', args: [DataType.text, DataType.text], returns: DataType.bytea,
  implementation: (value, format) => Buffer.from(String(value || ''), String(format || 'base64')) });
const { Pool } = memoryDb.adapters.createPg();
const pool = new Pool();
const codes = new Map();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-real-targeted-'));
const codexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const previous = {
  authUrl: process.env.JANUS_AUTH_URL,
  codexBin: process.env.JANUS_CODEX_BIN,
  modelRefresh: process.env.JANUS_MODEL_REFRESH_ENABLED,
  processingMode: process.env.JANUS_UBUDDY_PROCESSING_MODE,
};
let server = null;
let alice = null;
let bob = null;
let carol = null;

try {
  process.env.JANUS_CODEX_BIN = process.env.JANUS_E2E_CODEX_BIN || '/usr/bin/codex';
  process.env.JANUS_MODEL_REFRESH_ENABLED = '0';
  delete process.env.JANUS_UBUDDY_PROCESSING_MODE;
  await migrate(pool);
  const app = createApp({
    pool,
    config: {
      jwtSecret: 'ubuddy-real-targeted-jwt-secret-long-enough',
      emailCodeSecret: 'ubuddy-real-targeted-code-secret-long-enough',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
      emailCodeTtlMinutes: 10,
    },
    mailer: {
      async sendEmailCode({ email, code, purpose }) {
        codes.set(email + ':' + purpose, code);
      },
    },
  });
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  process.env.JANUS_AUTH_URL = 'http://127.0.0.1:' + server.address().port;

  const roots = {
    alice: path.join(tempRoot, 'alice'),
    bob: path.join(tempRoot, 'bob'),
    carol: path.join(tempRoot, 'carol'),
  };
  for (const root of Object.values(roots)) {
    const target = path.join(root, 'config', 'codex');
    await mkdir(target, { recursive: true });
    await copyFile(path.join(codexHome, 'config.toml'), path.join(target, 'config.toml'));
    await copyFile(path.join(codexHome, 'auth.json'), path.join(target, 'auth.json'));
  }
  alice = await createRuntime({ root: roots.alice, isDev: true });
  bob = await createRuntime({ root: roots.bob, isDev: true });
  carol = await createRuntime({ root: roots.carol, isDev: true });
  await register(alice, 'alice-real-targeted@example.com', 'Alice Real');
  await register(bob, 'bob-real-targeted@example.com', 'Bob Real');
  await register(carol, 'carol-real-targeted@example.com', 'Carol Real');
  await bob.authUpdateProfile({ displayName: 'Bob Real', username: '2840213075' });
  await addFriend(alice, bob, '2840213075');
  await addFriend(alice, carol, 'carol-real-targeted@example.com');

  const created = await alice.dispatchCollaborationCommand({
    content: '@Bob 生成一份可编辑的近期工作汇报 PPT，包含完成事项、风险、下一步和 Mermaid 流程图。@Carol 复核工作汇报流程并整理三条改进建议。',
    sourcePeerId: bob.currentUser().id,
    sourceConversationId: `direct:${alice.currentUser().id}:${bob.currentUser().id}`,
    sourceMessageId: 'real-codex-targeted-command',
    mentions: [
      {principalType:'user',userId:bob.currentUser().id,displayText:'@Bob',mentionId:'real_target_bob',source:'picker'},
      {principalType:'user',userId:carol.currentUser().id,displayText:'@Carol',mentionId:'real_target_carol',source:'picker'},
    ],
  });
  assert.equal(created.dispatched, true);
  assert.equal(created.tasks.length, 2);
  assert.equal(created.result.members.length, 3);
  const bobTask = created.tasks.find((task) => task.recipientUserId === bob.currentUser().id);
  const carolTask = created.tasks.find((task) => task.recipientUserId === carol.currentUser().id);
  assert.ok(bobTask?.id && carolTask?.id);

  await Promise.all([
    bob.pollSocialNetwork({ autoProcess: true }),
    carol.pollSocialNetwork({ autoProcess: true }),
  ]);
  const [bobReady, carolReady] = await Promise.all([
    waitForTask(bob, bobTask.id, 'draft_ready', 900_000),
    waitForTask(carol, carolTask.id, 'draft_ready', 900_000),
  ]);
  for (const ready of [bobReady, carolReady]) {
    assert.ok(['model', 'trusted_dispatch'].includes(ready.metadata.intakeProcessingMode));
    assert.ok(String(ready.metadata.preliminaryResult || '').trim());
    assert.notEqual(ready.status, 'awaiting_approval');
    assert.match(String(ready.metadata.taskWorkspaceRoot || '').replace(/\\/g, '/'), /\/data\/task-workspaces\//);
    assert.ok(Array.isArray(ready.metadata.generatedTaskFiles) && ready.metadata.generatedTaskFiles.length > 0, 'real uBuddy did not create an editable task-workspace deliverable');
  }
  assert.ok(bobReady.metadata.generatedTaskFiles.some((item) => /\.pptx$/i.test(item.name || '')), 'PPT task did not produce an editable PPTX draft');
  const requesterTasks = (await alice.collaborationOverview()).tasks;
  assert.equal(requesterTasks.some((task) => task.metadata?.preliminaryResult), false);
  assert.equal(requesterTasks.some((task) => task.metadata?.intakeSummary), false);

  await bob.respondAgentDelegation({ delegationId: bobTask.id, action: 'submit', message: bobReady.metadata.preliminaryResult });
  await carol.respondAgentDelegation({ delegationId: carolTask.id, action: 'submit', message: carolReady.metadata.preliminaryResult });
  await alice.collaborationTaskAction({ delegationId: bobTask.id, action: 'accept_result', content: 'Bob 结果验收通过。' });
  await alice.collaborationTaskAction({ delegationId: carolTask.id, action: 'accept_result', content: 'Carol 结果验收通过。' });
  await alice.updateCollaborationGroup({ groupId: created.group.id, action: 'close' });
  const closed = await alice.collaborationGroup({ groupId: created.group.id });
  assert.equal(closed.group.status, 'closed');
  assert.equal(closed.tasks.every((task) => task.status === 'closed'), true);

  const executions = {
    bob: modelExecutions(bob),
    carol: modelExecutions(carol),
  };
  for (const [name, rows] of Object.entries(executions)) {
    assert.ok(rows.length >= 2, name + ' did not execute both intake and task work');
    assert.ok(rows.some((row) => row.status === 'completed'), name + ' has no completed real Codex execution');
  }
  console.log(JSON.stringify({
    ok: true,
    mode: 'real_codex',
    users: 3,
    groupId: created.group.id,
    taskIds: [bobTask.id, carolTask.id],
    finalStatus: closed.group.status,
    executions: Object.fromEntries(Object.entries(executions).map(([name, rows]) => [name, rows.map((row) => ({ status: row.status, threadId: row.codex_thread_id }))])),
    checks: ['multi_assignee_routing', 'negated_publish_permission', 'isolated_workspace_write', 'private_preliminary_result', 'real_codex_intake', 'bounded_task_recovery', 'editable_pptx_draft', 'submit_accept_close'],
  }));
} finally {
  alice?.close();
  bob?.close();
  carol?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await rm(tempRoot, { recursive: true, force: true });
  restore('JANUS_AUTH_URL', previous.authUrl);
  restore('JANUS_CODEX_BIN', previous.codexBin);
  restore('JANUS_MODEL_REFRESH_ENABLED', previous.modelRefresh);
  restore('JANUS_UBUDDY_PROCESSING_MODE', previous.processingMode);
}

async function register(runtime, email, displayName) {
  await runtime.authSendEmailCode({ email, purpose: 'register', method: 'email' });
  const code = codes.get(email + ':register');
  assert.match(code, /^\d{6}$/);
  await runtime.authRegister({ email, displayName, password: 'ubuddy-real-targeted-password', code });
}

async function addFriend(requester, recipient, query) {
  const target = (await requester.friendSearch({ query }))[0];
  assert.ok(target?.id);
  await requester.friendSendRequest({ userId: target.id, message: 'real targeted uBuddy test' });
  await recipient.pollSocialNetwork({ autoProcess: false });
  const incomingItems = (await recipient.friendsOverview()).requests.incoming;
  const incoming = incomingItems.find((item) => item.user.id === requester.currentUser().id) || incomingItems[0];
  assert.ok(incoming?.id);
  await recipient.friendAcceptRequest({ requestId: incoming.id });
  await requester.friendsOverview();
}

async function waitForTask(runtime, taskId, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = (await runtime.collaborationOverview()).tasks.find((task) => task.id === taskId) || null;
    if (latest?.status === status) return latest;
    if (['failed', 'declined', 'blocked'].includes(String(latest?.status || ''))) {
      throw new Error('Task ' + taskId + ' entered ' + latest.status + ': ' + JSON.stringify(latest));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for ' + taskId + ' to become ' + status + '; latest=' + JSON.stringify(latest));
}

function modelExecutions(runtime) {
  return runtime.db.prepare('SELECT status, codex_thread_id, error_text FROM model_executions ORDER BY started_at').all();
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
