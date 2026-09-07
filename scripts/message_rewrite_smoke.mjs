import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuthService } from '../src/main/auth.js';
import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-message-rewrite-'));
let db;
try {
  db = openDatabase(root, { skipMigrationBackup: true });
  const auth = new AuthService(db);
  const user = auth.currentUser();
  const store = new Store(db, { root });
  store.ensureAccountWorkspaces({ user });
  const session = store.createSession({ userId: user.id, title: 'Rewrite smoke' });
  store.updateSessionThread(session.id, 'thread_before_rewrite');
  const firstUser = store.addMessage({ sessionId: session.id, role: 'user', content: 'keep user' });
  const firstAssistant = store.addMessage({ sessionId: session.id, role: 'assistant', content: 'keep assistant' });
  const editedSource = store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'old question',
    metadata: { attachments: [{ id: 'upload-rewrite', name: 'context.txt', path: '/tmp/context.txt' }] },
  });
  const oldAssistant = store.addMessage({ sessionId: session.id, role: 'assistant', content: 'old answer' });
  const contextBefore = store.getChatContextState({ ownerUserId: user.id, sessionId: session.id });
  const execution = store.beginModelExecution({
    userId: user.id,
    conversationId: session.id,
    requestMessageId: editedSource.id,
    responseMessageId: oldAssistant.id,
    status: 'running',
  });

  const result = store.supersedeLatestUserTurn({
    sessionId: session.id,
    messageId: editedSource.id,
    commandId: 'rewrite-smoke-command',
  });
  assert.deepEqual(result.supersededMessageIds, [editedSource.id, oldAssistant.id]);
  assert.deepEqual(store.listMessages(session.id).map((message) => message.id), [firstUser.id, firstAssistant.id]);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 4, 'rewriting must preserve all message rows');
  assert.equal(store.getMessage(editedSource.id).metadata.supersededByRewrite.commandId, 'rewrite-smoke-command');
  assert.equal(store.getMessage(editedSource.id).metadata.attachments[0].name, 'context.txt');
  assert.equal(store.getSession(session.id).codexThreadId, '');
  assert.equal(store.getModelExecution(execution.id).status, 'cancelled');
  assert.equal(store.getModelExecution(execution.id).metadata.supersededByRewrite.sourceMessageId, editedSource.id);
  const contextAfter = store.getChatContextState({ ownerUserId: user.id, sessionId: session.id });
  assert.equal(contextAfter.contextEpoch, contextBefore.contextEpoch + 1);

  const replacement = store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'edited question',
    metadata: editedSource.metadata,
  });
  assert.deepEqual(store.listMessagesForPrompt(session.id, { ownerUserId: user.id }).map((message) => message.content), [
    'keep user',
    'keep assistant',
    'edited question',
  ]);
  assert.equal(store.listMessageAttachments(replacement.id)[0].name, 'context.txt');

  const reopened = new Store(db, { root });
  assert.deepEqual(reopened.listMessages(session.id).map((message) => message.content), ['keep user', 'keep assistant', 'edited question']);
  assert.throws(
    () => reopened.supersedeLatestUserTurn({ sessionId: session.id, messageId: editedSource.id, commandId: 'repeat' }),
    /不可用/,
  );
  process.stdout.write('Message rewrite smoke passed.\n');
} finally {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
