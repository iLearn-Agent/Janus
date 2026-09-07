import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { FollowerService } from '../../src/main/modules/follower/application/FollowerService.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-fail-closed-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const store = new Store(db, { root });
  const user = { id: 'follower_fail_closed_user' };
  const context = { ownerUserId: user.id, workspaceId: 'workspace_personal' };
  const access = store.updateFollowerAccess({ ...context, disclosureConfirmed: true, grants: { task_activity: true } });
  let collected = { coverage: [{ category: 'task_activity', itemCount: 1, truncated: false, warningCode: '' }], sources: [{
    refId: 'source_completed', sourceKind: 'task_run', sourceId: 'task_1', sourceVersion: '1', contentHash: 'hash',
    occurredAt: '2026-08-12T09:00:00.000Z', observedAt: '2026-08-12T10:00:00.000Z', availabilityState: 'available',
    title: 'Completed task', status: 'completed', text: 'Completed task', blocker: '', localReference: {},
  }] };
  let modelMode = 'unsupported';
  let modelCalls = 0;
  const service = new FollowerService({ root, store, auth: { requireUser: () => user, currentUser: () => user },
    org: { agent: () => ({ id: 'follower_agent' }), readSkill: () => '# Follower' },
    contextBroker: { collect: () => collected, resolveSources: () => [] },
    executeModel: async (options) => {
      modelCalls += 1;
      if (modelMode === 'unsupported') {
        const error = new Error('Dynamic tools are unsupported by this app-server contract.');
        error.code = 'follower_dynamic_tools_unsupported';
        throw error;
      }
      await options.onDynamicToolCall({ namespace: 'janus_follower', tool: 'list_activity', arguments: {} });
      return 'not-json';
    } });

  const first = store.createFollowerRun({ ...context, kind: 'daily_brief', clientRequestId: 'unsupported',
    window: { startAt: '2026-08-12T00:00:00.000Z', endAt: '2026-08-12T10:00:00.000Z', timezone: 'Asia/Shanghai' }, authorization: access });
  await service.executeRun(first.id);
  assert.equal(store.getFollowerRun(first.id).status, 'failed');
  assert.equal(store.listFollowerReports(context).length, 0, 'unsupported dynamic tools must not fall back to a successful report');

  modelMode = 'invalid_json';
  const second = store.createFollowerRun({ ...context, kind: 'daily_brief', clientRequestId: 'invalid-json', window: first.window, authorization: access });
  await service.executeRun(second.id);
  assert.equal(store.getFollowerRun(second.id).status, 'failed');
  assert.equal(store.listFollowerReports(context).length, 0, 'invalid model output must fail closed');

  collected = { coverage: [], sources: [] };
  const beforeNoActivity = modelCalls;
  const growth = store.createFollowerRun({ ...context, kind: 'growth_guidance', clientRequestId: 'growth-empty', window: first.window, authorization: access });
  await service.executeRun(growth.id);
  assert.equal(store.getFollowerRun(growth.id).status, 'skipped_no_activity');
  assert.equal(modelCalls, beforeNoActivity, 'empty growth windows must not call the model');
  assert.equal(store.listFollowerReports(context).length, 0);

  collected = { coverage: [{ category: 'agent_conversations', itemCount: 1, truncated: false, warningCode: '' }], sources: [{
    refId: 'source_growth', sourceKind: 'agent_message', sourceId: 'message_growth', sourceVersion: '1', contentHash: 'growth_hash',
    occurredAt: '2026-08-12T09:00:00.000Z', observedAt: '2026-08-12T10:00:00.000Z', availabilityState: 'available',
    title: 'Research discussion', status: 'assistant_reply', text: 'A recurring research topic', blocker: '', localReference: {},
  }] };
  modelMode = 'growth_without_extensions';
  service.executeModel = async (options) => {
    await options.onDynamicToolCall({ namespace: 'janus_follower', tool: 'list_activity', arguments: {} });
    return JSON.stringify({ schemaVersion: 'follower_report_v2', kind: 'growth_guidance', window: first.window,
      coverage: collected.coverage, claims: [], suggestions: [], summary: 'Generic summary without meaningful extensions.' });
  };
  const invalidGrowth = store.createFollowerRun({ ...context, kind: 'growth_guidance', clientRequestId: 'growth-missing-extensions', window: first.window, authorization: access });
  await service.executeRun(invalidGrowth.id);
  assert.equal(store.getFollowerRun(invalidGrowth.id).status, 'failed');
  assert.equal(store.getFollowerRun(invalidGrowth.id).errorCode, 'follower_report_validation_failed');
  service.close();
  console.log('Follower app-server, report validation, and no-activity fail-closed smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
