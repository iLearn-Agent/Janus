import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { FollowerService } from '../../src/main/modules/follower/application/FollowerService.js';
import { FollowerContextBroker } from '../../src/main/modules/follower/infrastructure/context/FollowerContextBroker.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-service-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const store = new Store(db, { root });
  const user = { id: 'follower_service_user' };
  const service = new FollowerService({ root, store, auth: { requireUser: () => user },
    org: { agent: () => ({ id: 'follower_agent' }), readSkill: () => '# Follower' }, executeModel: async () => { throw new Error('offline'); },
    contextBroker: new FollowerContextBroker({ store }) });
  service.updateAccess({ disclosureConfirmed: true, grants: { task_activity: true } });
  const queued = service.runNow({ kind: 'daily_brief', clientRequestId: 'service_smoke_1', timezone: 'Asia/Shanghai' });
  let settled = store.getFollowerRun(queued.id);
  for (let attempt = 0; attempt < 50 && !['completed', 'failed'].includes(settled.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    settled = store.getFollowerRun(queued.id);
  }
  assert.equal(settled.status, 'completed');
  assert.ok(settled.reportId);
  assert.equal(store.listFollowerReports({ ownerUserId: user.id, workspaceId: 'workspace_personal' }).length, 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM sessions').get().count), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM messages').get().count), 0);
  service.close();

  const syncedUser = { id: 'follower_synced_user' };
  let syncCompleted = false;
  const synchronizedService = new FollowerService({ root, store, auth: { requireUser: () => syncedUser },
    org: { agent: () => ({ id: 'follower_agent' }), readSkill: () => '# Follower' },
    cloudService: { effectiveAssets: () => ({}), ensureDefaultCloud: async () => ({}),
      refreshWorkSources: async () => { syncCompleted = true; } },
    contextBroker: {
      collect: () => ({ sources: syncCompleted ? [{ refId: 'message:cloud:1', sourceKind: 'agent_message', status: 'assistant_reply',
        title: 'Generalist A', text: 'Synced Agent work', occurredAt: new Date().toISOString() }] : [],
      coverage: [{ category: 'agent_conversations', itemCount: syncCompleted ? 1 : 0, truncated: false, warningCode: '' }] }),
      resolveSources: () => [],
    },
    executeModel: async (options) => {
      store.beginModelExecution({ id: options.executionContext.id, userId: syncedUser.id, accountWorkspaceId: 'workspace_personal',
        agentId: 'follower_agent', executionKind: 'follower_report' });
      await options.onDynamicToolCall({ namespace: 'janus_follower', tool: 'list_activity', arguments: {} });
      options.onEvent?.({ kind: 'activity', activityId: 'reasoning-1', activityType: 'reasoning', status: 'completed',
        title: '思考摘要', detail: '检查已同步的 Agent 对话；本地索引位于 /path/to/private/index.json ，随后继续整理。',
        reasoningText: '我会先核对来源覆盖范围，再区分已完成、进行中和待确认的工作。' });
      const kind = /Report kind: ([^\n]+)/.exec(options.prompt)?.[1]?.trim() || 'daily_brief';
      const window = JSON.parse(/Window: (\{[^\n]+\})/.exec(options.prompt)?.[1] || '{}');
      return JSON.stringify({ schemaVersion: 'follower_report_v2', kind, window,
        coverage: [{ category: 'agent_conversations', itemCount: 1, truncated: false, warningCode: '' }],
        claims: [{ id: 'claim_1', status: 'in_progress', text: 'Generalist A 的工作正在推进。', sourceRefs: ['message:cloud:1'] }],
        suggestions: [], summary: '已同步并整理最新 Agent 工作。' });
    } });
  synchronizedService.updateAccess({ disclosureConfirmed: true, grants: { agent_conversations: true } });
  const synchronized = synchronizedService.runNow({ kind: 'daily_brief', clientRequestId: 'service_sync_before_collect', timezone: 'Asia/Shanghai' });
  let synchronizedRun = store.getFollowerRun(synchronized.id);
  for (let attempt = 0; attempt < 100 && !['completed', 'failed'].includes(synchronizedRun.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    synchronizedRun = store.getFollowerRun(synchronized.id);
  }
  assert.equal(syncCompleted, true, 'Follower must await Cloud Sync before collecting its local context snapshot');
  assert.equal(synchronizedRun.status, 'completed');
  const visibleRun = synchronizedService.runs({ limit: 10 }).find((item) => item.id === synchronized.id);
  assert.match(visibleRun.processEvents[0]?.detail || '', /已同步的 Agent 对话/);
  assert.match(visibleRun.processEvents[0]?.detail || '', /\[Local path hidden\]/);
  assert.match(visibleRun.processEvents[0]?.detail || '', /随后继续整理/);
  assert.doesNotMatch(visibleRun.processEvents[0]?.detail || '', /\/home\/ubuntu/);
  assert.match(visibleRun.processEvents[0]?.reasoningText || '', /先核对来源覆盖范围/);
  assert.doesNotMatch(visibleRun.processEvents[0]?.detail || '', /Sensitive details were hidden/);
  synchronizedService.close();
  console.log('Follower local service smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
