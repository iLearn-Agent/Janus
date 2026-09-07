import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-memory-incremental-sync-'));
let runtime;

try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  runtime.db.prepare('UPDATE auth_users SET remote_id=? WHERE id=?').run('remote-memory-sync-user', user.id);
  const instance = runtime.store.activeEmployeeAgentsForUser({ userId: user.id })
    .find((item) => item.agentFamilyId === 'general_agent');
  const memory = runtime.store.listMemoryDocuments({ agentInstanceId: instance.id })[0];
  const updated = runtime.store.appendMemoryDocumentVersion({
    memoryDocumentId: memory.id,
    content: '# Incremental Memory update',
  });
  const unchangedParentMemory = runtime.store.createNextGeneralMemoryDocument({ agentInstanceId: instance.id });
  runtime.store.appendMemoryDocumentVersion({
    memoryDocumentId: unchangedParentMemory.id,
    content: '# Non-activated branch',
    activate: false,
  });
  const detachedVersion = runtime.store.listMemoryDocumentVersions({ memoryDocumentId: unchangedParentMemory.id })
    .find((item) => item.content === '# Non-activated branch');

  runtime.db.prepare('UPDATE user_agent_instances SET updated_at=? WHERE user_id=?')
    .run('2026-01-01T00:00:00.000Z', user.id);
  runtime.db.prepare('UPDATE memory_documents SET updated_at=? WHERE user_id=?')
    .run('2026-01-01T00:00:00.000Z', user.id);
  runtime.db.prepare(`UPDATE memory_document_versions SET created_at=?
    WHERE memory_document_id IN (SELECT id FROM memory_documents WHERE user_id=?)`)
    .run('2026-01-01T00:00:00.000Z', user.id);
  runtime.db.prepare('UPDATE memory_documents SET updated_at=? WHERE id=?')
    .run('2026-02-01T00:00:00.000Z', memory.id);
  runtime.db.prepare('UPDATE memory_document_versions SET created_at=? WHERE id=?')
    .run('2026-02-01T00:00:00.000Z', updated.currentVersionId);
  runtime.db.prepare('UPDATE memory_document_versions SET created_at=? WHERE id=?')
    .run('2026-02-02T00:00:00.000Z', detachedVersion.id);

  const payload = await runtime.cloudSync.buildBatchPayload({
    user_id: 'remote-memory-sync-user',
    last_sync_cursor: '2026-01-15T00:00:00.000Z',
  });

  assert.equal(payload.data.userAgentInstances.some((item) => item.id === instance.id), false,
    'the unchanged parent Agent instance must remain incremental');
  assert.equal(payload.data.memoryDocuments.some((item) => item.id === memory.cloudKey), true,
    'a changed Memory document must sync even when its Agent instance did not change');
  assert.equal(payload.data.memoryDocumentVersions.some((item) => item.id === updated.currentVersionId), true,
    'a changed Memory version must sync even when its Agent instance did not change');
  assert.equal(payload.data.memoryDocuments.some((item) => item.id === unchangedParentMemory.cloudKey), false,
    'an unchanged Memory parent must remain incremental');
  assert.equal(payload.data.memoryDocumentVersions.some((item) => item.id === detachedVersion.id), true,
    'a new non-activated Memory branch must sync even when its parent document did not change');
  console.log('cloud Memory incremental sync smoke passed');
} finally {
  await runtime?.close?.();
  fs.rmSync(root, { recursive: true, force: true });
}
