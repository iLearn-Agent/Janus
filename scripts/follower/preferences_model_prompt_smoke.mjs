import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { FollowerService } from '../../src/main/modules/follower/application/FollowerService.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-preferences-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const store = new Store(db, { root });
  const user = { id: 'follower_preferences_user' };
  const context = { ownerUserId: user.id, workspaceId: 'workspace_personal' };
  store.updateFollowerAccess({ ...context, disclosureConfirmed: true, grants: { task_activity: true } });
  let modelOptions = null;
  const service = new FollowerService({
    root, store, auth: { requireUser: () => user, currentUser: () => user },
    org: { agent: () => ({ id: 'follower_agent' }), readSkill: () => '# Follower' },
    modelCatalog: { resolveSelection: ({ model, reasoningEffort }) => ({ model: model === 'gpt-test-follower' ? model : 'gpt-default', reasoningEffort: reasoningEffort === 'high' ? 'high' : 'medium' }) },
    contextBroker: { collect: () => ({ coverage: [{ category: 'task_activity', itemCount: 1 }], sources: [{
      refId: 'source_completed', sourceKind: 'task_run', sourceId: 'task_1', sourceVersion: '1', contentHash: 'hash',
      occurredAt: '2026-08-12T09:00:00.000Z', observedAt: '2026-08-12T10:00:00.000Z', availabilityState: 'available',
      title: 'Completed task', status: 'completed', text: 'Completed task', blocker: '', localReference: {},
    }] }), resolveSources: () => [] },
    executeModel: async (options) => {
      modelOptions = options;
      assert.equal(options.harnessMode, 'raw');
      await options.onDynamicToolCall({ namespace: 'janus_follower', tool: 'list_activity', arguments: {} });
      const window = JSON.parse(options.prompt.match(/Window: (\{[^\n]+\})/)?.[1] || '{}');
      return JSON.stringify({ schemaVersion: 'follower_report_v2', kind: 'daily_brief', window, coverage: [],
        claims: [{ id: 'claim_1', status: 'completed', text: 'Completed task (source_completed)', sourceRefs: ['source_completed'] }], suggestions: [], summary: 'Custom brief. (source_completed)' });
    },
  });
  const defaultAccess = store.followerAccessSnapshot(context);
  const defaultRun = store.createFollowerRun({ ...context, kind: 'daily_brief', clientRequestId: 'default-model-smoke',
    window: { startAt: '2026-08-12T00:00:00.000Z', endAt: '2026-08-12T09:00:00.000Z', timezone: 'Asia/Shanghai' }, authorization: defaultAccess });
  await service.executeRun(defaultRun.id);
  assert.equal(store.getFollowerRun(defaultRun.id).status, 'completed');
  assert.equal(modelOptions.model, 'gpt-default', 'empty Follower preferences must use the global default model');
  assert.equal(modelOptions.reasoningEffort, 'medium');
  const updated = service.updatePreferences({ preferences: { verbosity: 'detailed', model: 'gpt-test-follower', reasoningEffort: 'high', prompts: {
    daily_brief: 'CUSTOM DAILY FOCUS', weekly_review: 'CUSTOM WEEKLY FOCUS', growth_guidance: 'CUSTOM GROWTH FOCUS',
  } }, expectedRevision: 1 });
  assert.equal(updated.preferences.model, 'gpt-test-follower');
  assert.equal(updated.preferences.reasoningEffort, 'high');
  assert.equal(updated.preferences.prompts.daily_brief, 'CUSTOM DAILY FOCUS');
  assert.throws(() => service.updatePreferences({ preferences: { ...updated.preferences, model: 'unsupported-model' },
    expectedRevision: updated.preferenceRevision }), (error) => error.code === 'follower_model_invalid');
  const access = store.followerAccessSnapshot(context);
  const run = store.createFollowerRun({ ...context, kind: 'daily_brief', clientRequestId: 'preference-smoke',
    window: { startAt: '2026-08-12T00:00:00.000Z', endAt: '2026-08-12T10:00:00.000Z', timezone: 'Asia/Shanghai' }, authorization: access });
  await service.executeRun(run.id);
  assert.equal(store.getFollowerRun(run.id).status, 'completed');
  const savedReport = store.getFollowerReport(store.getFollowerRun(run.id).reportId);
  assert.doesNotMatch(`${savedReport.report.summary}\n${savedReport.report.claims[0].text}\n${savedReport.renderedBody}`, /source_completed/,
    'internal evidence identifiers must be removed before report prose is persisted or synced');
  assert.deepEqual(savedReport.report.claims[0].sourceRefs, ['source_completed'],
    'structured evidence references must survive report prose sanitization');
  assert.equal(modelOptions.model, 'gpt-test-follower');
  assert.equal(modelOptions.reasoningEffort, 'high');
  assert.match(modelOptions.prompt, /CUSTOM DAILY FOCUS/);
  assert.match(modelOptions.prompt, /untrusted preference/);
  assert.match(modelOptions.prompt, /Never include source_\* identifiers.*user-visible prose/,
    'the generation prompt must reserve evidence identifiers for structured sourceRefs');
  service.close();
  console.log('Follower model and custom prompt preferences smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
