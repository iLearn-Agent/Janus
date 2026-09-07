import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-atomic-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const store = new Store(db, { root });
  const context = { ownerUserId: 'follower_atomic_user', workspaceId: 'workspace_personal' };
  const access = store.updateFollowerAccess({ ...context, disclosureConfirmed: true, grants: { task_activity: true } });
  const run = store.createFollowerRun({ ...context, kind: 'daily_brief', clientRequestId: 'atomic_run',
    window: { startAt: '2026-08-12T00:00:00.000Z', endAt: '2026-08-12T10:00:00.000Z', timezone: 'Asia/Shanghai' }, authorization: access });
  const payload = { runId: run.id, report: { schemaVersion: 'follower_report_v2', kind: 'daily_brief', window: run.window,
    coverage: [], claims: [{ id: 'claim_1', status: 'completed', text: 'Atomic result', sourceRefs: ['source_1'] }], suggestions: [], summary: 'Atomic result' },
    renderedBody: 'Atomic result', syncBody: 'Atomic result', sources: [{ sourceKind: 'task_run', sourceId: 'task_1', sourceVersion: '1',
      contentHash: 'hash', occurredAt: '2026-08-12T09:00:00.000Z', observedAt: '2026-08-12T10:00:00.000Z', localReference: {}, availabilityState: 'available' }],
    privacy: { state: 'passed', validatorVersion: 'follower_privacy_v1', validatedHash: 'atomic_hash' } };
  db.exec(`CREATE TRIGGER follower_atomic_failure BEFORE INSERT ON work_notification_intents BEGIN SELECT RAISE(ABORT,'injected atomic failure'); END;`);
  assert.throws(() => store.commitFollowerReport(payload), /injected atomic failure/);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM follower_reports').get().count), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM follower_report_sources').get().count), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM work_notification_intents').get().count), 0);
  assert.equal(store.getFollowerRun(run.id).status, 'queued');
  db.exec('DROP TRIGGER follower_atomic_failure');
  const saved = store.commitFollowerReport(payload);
  assert.equal(saved.id, `follower_report_${run.id}`);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM follower_reports').get().count), 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM follower_report_sources').get().count), 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM work_notification_intents').get().count), 1);
  assert.equal(store.commitFollowerReport(payload).id, saved.id);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM follower_reports').get().count), 1);
  console.log('Follower atomic commit recovery smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
