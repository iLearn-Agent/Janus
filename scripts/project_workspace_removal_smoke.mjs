import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-project-workspace-removal-'));
const projectRoot = path.join(root, 'project-to-remove');
fs.mkdirSync(projectRoot, { recursive: true });
const retainedFile = path.join(projectRoot, 'retained.txt');
fs.writeFileSync(retainedFile, 'project files must stay on disk', 'utf8');

let runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
let sessionId = '';
let projectId = '';
let messageFingerprint = [];
let inventoryBefore = {};

try {
  const user = runtime.currentUser();
  const instance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || runtime.store.recruitUserAgent({ userId: user.id, agentFamilyId: 'general_agent', commandId: 'project-removal-smoke:recruit' }).instance;
  const project = runtime.createProject({ title: '待移出项目', workspaceRoot: projectRoot });
  projectId = project.id;
  const session = runtime.store.createSession({
    title: '项目内对话',
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    userId: user.id,
  });
  sessionId = session.id;
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: '移出项目后保留这条消息。',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    metadata: { attachments: [{ id: 'retained-attachment', name: 'retained.txt', contentType: 'text/plain', sizeBytes: 31, sha256: 'retained-sha' }] },
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '聊天记录应当保留。',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
  });
  messageFingerprint = runtime.store.listMessages(session.id).map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt }));
  inventoryBefore = inventory(runtime.store.db);

  const removed = runtime.updateProject({ projectId: project.id, action: 'remove' });
  assert.equal(removed.project.status, 'deleted');
  assert.equal(removed.detachedSessionCount, 1);
  assert.equal(runtime.listProjects().some((item) => item.id === project.id), false);
  const detachedSession = runtime.store.getSession(session.id);
  assert.equal(detachedSession.status, 'active');
  assert.equal(detachedSession.projectId, '');
  assert.equal(detachedSession.workspaceRoot, '');
  assert.deepEqual(
    runtime.store.listMessages(session.id).map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt })),
    messageFingerprint,
  );
  assert.deepEqual(inventory(runtime.store.db), inventoryBefore);
  assert.equal(fs.readFileSync(retainedFile, 'utf8'), 'project files must stay on disk');

  const repeated = runtime.updateProject({ projectId: project.id, action: 'remove' });
  assert.equal(repeated.project.status, 'deleted');
  assert.equal(repeated.detachedSessionCount, 0);
  assert.deepEqual(inventory(runtime.store.db), inventoryBefore);
  assert.equal(runtime.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(runtime.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
} finally {
  runtime.close();
}

runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
try {
  assert.equal(runtime.store.getProject(projectId).status, 'deleted');
  const reopenedSession = runtime.store.getSession(sessionId);
  assert.equal(reopenedSession.status, 'active');
  assert.equal(reopenedSession.projectId, '');
  assert.equal(reopenedSession.workspaceRoot, '');
  assert.deepEqual(
    runtime.store.listMessages(sessionId).map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt })),
    messageFingerprint,
  );
  assert.deepEqual(inventory(runtime.store.db), inventoryBefore);
  assert.equal(fs.existsSync(retainedFile), true);
  assert.equal(runtime.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(runtime.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  process.stdout.write('Project workspace removal smoke passed.\n');
} finally {
  runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function inventory(db) {
  return Object.fromEntries([
    'sessions', 'messages', 'memory_documents', 'memory_document_versions', 'message_attachments',
    'task_runs', 'task_nodes', 'model_executions',
  ].map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get().value || 0)]));
}
