import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-schedule-recovery-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const store = new Store(db, { root });
  const context = { ownerUserId: 'follower_schedule_user', workspaceId: 'workspace_personal' };
  const access = store.updateFollowerAccess({ ...context, disclosureConfirmed: true, grants: { task_activity: true } });
  const schedule = store.upsertFollowerSchedule({ ...context, schedule: { kind: 'daily_brief', enabled: true, timezone: 'Asia/Shanghai',
    frequency: 'daily', daysOfWeek: [1,2,3,4,5], localTime: '18:00' }, nextOccurrenceAt: '2026-08-13T10:00:00.000Z' });
  const run = store.createFollowerRun({ ...context, scheduleId: schedule.id, kind: 'daily_brief', trigger: 'scheduled', occurrenceKey: `${schedule.id}:2026-08-12T10:00:00.000Z`,
    window: { startAt: '2026-08-12T00:00:00.000Z', endAt: '2026-08-12T10:00:00.000Z', timezone: 'Asia/Shanghai' }, authorization: access });
  store.updateFollowerRun(run.id, { status: 'generating', leaseOwner: 'dead_process', leaseExpiresAt: '2026-08-12T09:00:00.000Z' });
  const recovered = store.recoverFollowerRuns({ ownerUserId: context.ownerUserId, now: '2026-08-12T10:00:00.000Z' });
  assert.deepEqual(recovered.map((item) => item.id), [run.id]);
  assert.equal(store.getFollowerRun(run.id).status, 'queued');
  assert.equal(store.createFollowerRun({ ...context, scheduleId: schedule.id, kind: 'daily_brief', trigger: 'scheduled', occurrenceKey: run.occurrenceKey,
    window: run.window, authorization: access }).id, run.id, 'occurrence identity must remain idempotent after recovery');
  assert.equal(store.getFollowerSchedule({ id: schedule.id }).nextOccurrenceAt, '2026-08-13T10:00:00.000Z');
  console.log('Follower schedule persistence and recovery smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
