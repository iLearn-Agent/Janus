import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-notification-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const store = new Store(db, { root });
  const context = { ownerUserId: 'follower_notification_user', workspaceId: 'workspace_personal' };
  const access = store.updateFollowerAccess({ ...context, disclosureConfirmed: true, grants: { task_activity: true } });
  const run = store.createFollowerRun({ ...context, kind: 'daily_brief', clientRequestId: 'notification_run',
    window: { startAt: '2026-08-12T00:00:00.000Z', endAt: '2026-08-12T10:00:00.000Z', timezone: 'Asia/Shanghai' }, authorization: access });
  const payload = { runId: run.id, report: { schemaVersion: 'follower_report_v2', kind: 'daily_brief', window: run.window,
    coverage: [], claims: [], suggestions: [], summary: 'Ready' }, renderedBody: 'Ready', syncBody: 'Ready', sources: [],
    privacy: { state: 'passed', validatorVersion: 'follower_privacy_v1', validatedHash: 'notification_hash' } };
  store.commitFollowerReport(payload); store.commitFollowerReport(payload);
  const intents = store.listWorkNotificationIntents({ ownerUserId: context.ownerUserId, statuses: ['pending'], limit: 10 });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].correlationId, run.id);
  assert.equal(intents[0].targetType, 'follower_report');
  const mainSource = fs.readFileSync(path.join(process.cwd(), 'src/main/main.js'), 'utf8');
  assert.match(mainSource, /system:open-follower/);
  assert.notEqual(intents[0].bodyKey, 'Ready');
  assert.equal(intents[0].bodyKey, 'follower.notification.reportReady.body');
  console.log('Follower notification correlation and deep-link smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
