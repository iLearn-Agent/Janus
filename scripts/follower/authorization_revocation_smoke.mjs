import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { FollowerService } from '../../src/main/modules/follower/application/FollowerService.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-revoke-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const store = new Store(db, { root });
  const user = { id: 'follower_revoke_user' };
  const auth = { requireUser: () => user, currentUser: () => user };
  const access = store.updateFollowerAccess({ ownerUserId: user.id, workspaceId: 'workspace_personal', disclosureConfirmed: true,
    grants: { task_activity: true } });
  const run = store.createFollowerRun({ ownerUserId: user.id, workspaceId: 'workspace_personal', kind: 'daily_brief', clientRequestId: 'revoke_run',
    window: { startAt: '2026-08-12T00:00:00.000Z', endAt: '2026-08-12T10:00:00.000Z', timezone: 'Asia/Shanghai' }, authorization: access });
  let service;
  service = new FollowerService({ root, store, auth, org: { agent: () => ({ id: 'follower_agent' }), readSkill: () => '# Follower' },
    contextBroker: { collect: () => ({ coverage: [{ category: 'task_activity', itemCount: 1, truncated: false, warningCode: '' }], sources: [{
      refId: 'source_1', sourceKind: 'task_run', sourceId: 'task_1', sourceVersion: '1', contentHash: 'hash', occurredAt: '2026-08-12T09:00:00.000Z',
      availabilityState: 'available', title: 'Safe task', status: 'completed', text: 'Completed safely', blocker: '', localReference: {},
    }] }) },
    executeModel: async (options) => {
      await options.onDynamicToolCall({ namespace: 'janus_follower', tool: 'list_activity', arguments: {} });
      db.prepare(`UPDATE follower_workspace_state SET authorization_epoch=authorization_epoch+1
        WHERE owner_user_id=? AND account_workspace_id='workspace_personal'`).run(user.id);
      return JSON.stringify({ schemaVersion: 'follower_report_v2', kind: 'daily_brief', window: run.window, coverage: [],
        claims: [{ id: 'claim_1', status: 'completed', text: 'Completed safely', sourceRefs: ['source_1'] }], suggestions: [], summary: 'Done' });
    } });
  await service.executeRun(run.id);
  const finalRun = store.getFollowerRun(run.id);
  assert.equal(finalRun.status, 'cancelled_authorization_changed');
  assert.equal(store.listFollowerReports({ ownerUserId: user.id, workspaceId: 'workspace_personal' }).length, 0);
  service.close();
  console.log('Follower authorization revocation smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
