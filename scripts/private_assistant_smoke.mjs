import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { recordPrivateAssistantUsage } from '../src/main/privateAssistant.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-private-assistant-smoke-'));
let runtime = null;

try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  runtime.db.prepare('UPDATE auth_users SET remote_id=? WHERE id=?').run(user.remoteId, user.id);
  runtime.cloudSync.saveConfig({ userId: user.remoteId, deviceId: 'private-assistant-smoke-device', autoSync: false });
  const quotaBefore = runtime.store.getEmployeeQuota({ userId: user.id });
  const privateStatus = runtime.privateAssistantStatus();
  assert.equal(privateStatus.quotaExempt, true);
  assert.equal(privateStatus.localOnly, true);
  assert.equal(privateStatus.weeklyTokensUsed, 0);

  const privateSession = runtime.ensurePrivateAssistantSession();
  assert.equal(privateSession.departmentId, 'private_assistant');
  assert.equal(privateSession.agentId, 'private_assistant');
  assert.equal(privateSession.agentInstanceId, '');
  assert.deepEqual(runtime.store.getEmployeeQuota({ userId: user.id }), quotaBefore);

  const privateMessage = runtime.store.addMessage({
    sessionId: privateSession.id,
    role: 'user',
    content: 'private assistant sync exclusion fixture',
    agentId: 'private_assistant',
    departmentId: 'private_assistant',
    metadata: { privateAssistant: true, localOnly: true },
  });
  runtime.store.updateSessionThread(privateSession.id, 'thread_private_before_reset');
  const contextBeforeReset = runtime.chatContextStatus({ sessionId: privateSession.id });
  const resetCommandId = 'private_assistant_reset_smoke';
  const contextAfterReset = runtime.resetPrivateAssistantContext({
    sessionId: privateSession.id,
    commandId: resetCommandId,
    expectedStateRevision: contextBeforeReset.stateRevision,
  });
  assert.equal(contextAfterReset.contextEpoch, contextBeforeReset.contextEpoch + 1);
  assert.equal(contextAfterReset.threadId, '');
  assert.equal(runtime.store.getSession(privateSession.id).codexThreadId, '');
  assert.equal(runtime.store.listMessages(privateSession.id).some((item) => item.id === privateMessage.id), true, 'visible history must remain after reset');
  assert.equal(runtime.store.listMessagesForPrompt(privateSession.id, {
    ownerUserId: user.id, contextSpaceId: '', includeAllContexts: true,
  }).some((item) => item.id === privateMessage.id), false, 'reset history must not remain in the next private prompt');
  const repeatedReset = runtime.resetPrivateAssistantContext({
    sessionId: privateSession.id,
    commandId: resetCommandId,
    expectedStateRevision: contextAfterReset.stateRevision,
  });
  assert.equal(repeatedReset.contextEpoch, contextAfterReset.contextEpoch, 'private context reset must be idempotent');
  runtime.store.beginModelExecution({
    id: 'private_assistant_smoke_execution',
    userId: user.id,
    conversationId: privateSession.id,
    requestMessageId: privateMessage.id,
    departmentId: 'private_assistant',
    agentRole: 'private_assistant',
    executionKind: 'private_assistant_chat',
    metadata: { localOnly: true },
  });
  runtime.store.completeModelExecution('private_assistant_smoke_execution');

  const ordinarySession = runtime.store.createSession({
    title: 'ordinary sync control',
    departmentId: 'general',
    userId: user.id,
  });
  assert.throws(
    () => runtime.resetPrivateAssistantContext({ sessionId: ordinarySession.id }),
    /只能重置私人助理/,
  );
  const ordinaryMessage = runtime.store.addMessage({
    sessionId: ordinarySession.id,
    role: 'user',
    content: 'ordinary sync control fixture',
    departmentId: 'general',
  });

  const payload = await runtime.cloudSync.buildBatchPayload({
    ...runtime.cloudSync.state(),
    last_sync_cursor: '',
  });
  assert.equal(payload.data.conversations.some((item) => item.id === ordinarySession.id), true);
  assert.equal(payload.data.messages.some((item) => item.id === ordinaryMessage.id), true);
  assert.equal(payload.data.conversations.some((item) => item.id === privateSession.id), false);
  assert.equal(payload.data.messages.some((item) => item.id === privateMessage.id), false);
  assert.equal(payload.data.modelExecutions.some((item) => item.id === 'private_assistant_smoke_execution'), false);

  const exhausted = recordPrivateAssistantUsage(runtime.store, user.id, {
    inputTokens: privateStatus.weeklyTokenLimit,
    outputTokens: 0,
    totalTokens: privateStatus.weeklyTokenLimit,
  }, { root, eventKey: 'private-assistant-smoke-exhaustion' });
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.weeklyTokensRemaining, 0);

  process.stdout.write('private assistant smoke passed\n');
} finally {
  runtime?.close();
  await rm(root, { recursive: true, force: true });
}
