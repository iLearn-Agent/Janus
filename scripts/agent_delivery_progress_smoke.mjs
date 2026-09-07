import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-delivery-progress-'));
let db = null;
try {
  db = openDatabase(root, { skipMigrationBackup: true });
  let store = new Store(db, { root });
  const sourceSession = store.createSession({
    title: 'Delivery source', departmentId: 'general', userId: 'local_admin', reusePrimary: false,
  });
  const targetSession = store.createSession({
    title: 'Delivery target', departmentId: 'general', userId: 'local_admin', reusePrimary: false,
  });
  store.createAgentDeliveryReceipt({
    userId: 'local_admin', sourceSessionId: sourceSession.id, targetSessionId: targetSession.id,
    targetAgentInstanceId: 'target-instance', requestMessageId: 'request-message', workId: 'delivery-work',
    metadata: { targetAgentId: 'general_agent', targetAgentName: 'General Agent' },
  });
  store.recordAgentDeliveryEvent({ workId: 'delivery-work', status: 'queued', event: { kind: 'progress', stage: 'queued', message: '等待执行' } });
  store.recordAgentDeliveryEvent({ workId: 'delivery-work', status: 'running', event: { kind: 'activity', stage: 'working', message: '正在调用工具', activityType: 'tool', title: '工具调用' } });
  let runs = store.listAgentDeliveryRuns({ userId: 'local_admin', sessionId: sourceSession.id, statuses: ['running'] });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].deliveryStatus, 'running');
  assert.deepEqual(runs[0].events.map((event) => event.message), ['等待执行', '正在调用工具']);
  assert.equal(store.listAgentDeliveryRuns({ userId: 'local_admin', statuses: ['unknown'] }).length, 0,
    'invalid status filters must not be normalized to queued or broaden the query');
  assert.equal(store.listAgentDeliveryRuns({ userId: 'local_admin', statuses: ['unknown', 'running'] }).length, 1,
    'valid status filters must continue to work when invalid values are also supplied');
  db.close();
  db = openDatabase(root, { skipMigrationBackup: true });
  store = new Store(db, { root });
  runs = store.listAgentDeliveryRuns({ userId: 'local_admin', sessionId: targetSession.id, statuses: ['running'] });
  assert.equal(runs.length, 1, 'delivery progress must survive a database reopen');
  assert.equal(runs[0].events[1].payload.title, '工具调用');
  process.stdout.write('Agent delivery progress persistence smoke passed.\n');
} finally {
  try { db?.close(); } catch {}
  await rm(root, { recursive: true, force: true });
}
