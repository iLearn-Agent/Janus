import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-centers-'));
let runtime = null;

try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.auth.currentUser();
  const workspaceId = runtime.store.activeAccountWorkspace({ userId: user.id })?.id || 'workspace_personal';

  for (let index = 0; index < 525; index += 1) {
    runtime.store.createTaskRun({
      id: `center-task-${String(index).padStart(3, '0')}`,
      ownerUserId: user.id,
      title: `Center task ${index}`,
      prompt: `Center task prompt ${index}`,
      workspaceId,
      metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: 'center-session' },
      initialStatus: index % 3 === 0 ? 'running' : 'completed',
    });
  }
  runtime.store.createTaskRun({
    id: 'center-internal-task', ownerUserId: user.id, title: 'Internal fixture', prompt: 'hidden', workspaceId,
    metadata: { source: 'ubuddy_dispatch', internalTest: true },
  });
  runtime.store.createTaskRun({
    id: 'center-other-source', ownerUserId: user.id, title: 'Non uBuddy fixture', prompt: 'hidden', workspaceId,
    metadata: { source: 'direct' },
  });

  const pages = [];
  let cursor = '';
  do {
    const page = await runtime.runInCurrentAccountWorkspace(() => runtime.uBuddyTaskCenter({ cursor, limit: 100 }));
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  const allTaskItems = pages.flatMap((page) => page.items);
  assert.equal(pages[0].total, 525);
  assert.equal(pages.length, 6);
  assert.equal(new Set(allTaskItems.map((item) => item.id)).size, 525);
  assert.equal(allTaskItems.some((item) => item.id === 'center-task-524'), true,
    'the center must not silently stop at the legacy 500-task limit');
  assert.equal(allTaskItems.some((item) => item.id === 'center-internal-task'), false);
  const search = await runtime.runInCurrentAccountWorkspace(() => runtime.uBuddyTaskCenter({ query: 'Center task 524', limit: 30 }));
  assert.deepEqual(search.items.map((item) => item.id), ['center-task-524']);

  const reviewTask = runtime.store.createTaskRun({
    id: 'center-delivery-task', ownerUserId: user.id, title: 'Local delivery history', prompt: 'Deliver versions.', workspaceId,
    metadata: { source: 'ubuddy_dispatch' }, initialStatus: 'completed',
  });
  const submissionOne = runtime.store.recordTaskDeliverySubmission({
    taskRunId: reviewTask.id, submissionKey: 'center-delivery-v1', bodySnapshot: 'Local version one.',
    artifactManifest: [{ name: 'local-v1.md' }],
  });
  runtime.store.recordOwnerDeliveryRevisionRequest({
    taskRunId: reviewTask.id, submissionId: submissionOne.id, eventId: 'center-owner-revision-v1',
    summary: 'Revise version one.', actorId: user.id, occurredAt: '2026-08-13T08:00:00.000Z',
  });
  const submissionTwo = runtime.store.recordTaskDeliverySubmission({
    taskRunId: reviewTask.id, submissionKey: 'center-delivery-v2', bodySnapshot: 'Local version two.',
    artifactManifest: [{ name: 'local-v2.docx' }, { name: 'local-v2.md' }],
  });
  runtime.store.updateTaskRunMetadata(reviewTask.id, {
    selectedDeliverySubmissionId: submissionTwo.id,
    selectedDeliverySubmissionNo: submissionTwo.submissionNo,
    finalDelivery: { state: 'delivered', deliveredAt: '2026-08-13T09:00:00.000Z' },
  });

  runtime.db.prepare(`INSERT INTO auth_users(id,email,display_name,username,email_verified)
    VALUES('center-peer','center-peer@example.com','Center Peer','center-peer',1)`).run();
  runtime.store.ensureAccountWorkspaces({ user: runtime.auth.getUser('center-peer') });
  const delegation = { id: 'center-delegation', title: 'Delegated delivery history' };
  runtime.db.prepare(`INSERT INTO agent_delegations(
    id,account_workspace_id,requester_user_id,recipient_user_id,title,instruction,status,updated_at
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    delegation.id, workspaceId, user.id, 'center-peer', delegation.title, 'Return a report.', 'submitted',
    '2026-08-13T10:00:00.000Z',
  );
  runtime.db.prepare(`INSERT INTO agent_delegation_revisions(
    id,delegation_id,author_user_id,revision_no,action,content,metadata_json,created_at
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    'center-delegation-submit', delegation.id, 'center-peer', 1, 'submit', 'Delegated result.',
    JSON.stringify({ attachments: [{ name: 'delegated.pdf' }] }), '2026-08-13T10:00:00.000Z',
  );

  const pending = await runtime.runInCurrentAccountWorkspace(() => runtime.uBuddyDeliveryCenter({ filter: 'pending', limit: 30 }));
  const rejected = await runtime.runInCurrentAccountWorkspace(() => runtime.uBuddyDeliveryCenter({ filter: 'revision_requested', limit: 30 }));
  assert.equal(pending.counts.pending, 2);
  assert.equal(pending.items.some((item) => item.kind === 'task_run' && item.submissionId === submissionTwo.id), true);
  assert.equal(pending.items.some((item) => item.kind === 'delegation' && item.delegationId === delegation.id), true);
  assert.equal(rejected.items.some((item) => item.submissionId === submissionOne.id), true);
  assert.equal(rejected.items.find((item) => item.submissionId === submissionOne.id)?.versionNo, 1);
  assert.equal(rejected.items.find((item) => item.submissionId === submissionOne.id)?.status, 'revision_requested');

  console.log('uBuddy task and delivery center smoke passed');
} finally {
  try { await runtime?.close?.(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
