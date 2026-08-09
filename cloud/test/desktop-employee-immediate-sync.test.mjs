import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { CloudSyncService } from '../../src/main/cloudSync.js';
import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { migrateDatabase } from '../../src/main/modules/persistence/infrastructure/sqliteMigrations.js';
import { createEmployeeRuntimeApi } from '../../src/main/modules/identity/application/createEmployeeRuntimeApi.js';
import { CloudSyncClient } from '../../network/clients/cloudSyncClient.js';

test('cloud requests abort instead of keeping employee operations pending forever', async () => {
  const client = new CloudSyncClient({
    timeoutMs: 25,
    fetchImpl: async (_url, { signal } = {}) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  assert.equal(client.employeeRequestTimeoutMs, 25);
  await assert.rejects(
    client.employeeCapabilities({ server_url: 'https://cloud.example.test', evolution_grant: 'test-grant' }),
    /Request timed out after 25ms/,
  );
});

test('employee lifecycle rejects an unbound local user before changing local state or creating an outbox command', async () => {
  let stageCount = 0;
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_only_user', role: 'member', remoteBound: false, remoteId: '' }) },
    store: {
      stagePendingEmployeeCommand() { stageCount += 1; throw new Error('must not stage'); },
    },
    cloudSync: {
      status: () => ({ configured: false, serverUrl: 'https://cloud.example.test', userId: '' }),
    },
  });
  await assert.rejects(
    api.recruitEmployee({ agentFamilyId: 'family_local_only', commandId: 'command_local_only' }),
    (error) => error?.code === 'cloud_auth_required',
  );
  assert.equal(stageCount, 0);
});

test('employee overview classifies legacy silent pending commands as blocked authentication', async () => {
  let blocked = null;
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_pending_user', role: 'member', remoteBound: false, remoteId: '' }) },
    store: {
      blockEmployeeCommandsForCloudAuth(input) { blocked = input; return 1; },
      getEmployeeQuota: () => ({ used: 0, limit: 10 }),
      ensureSystemAgentInstances: () => [],
      listEmployeeRoster: () => [],
      listRecruitableAgentFamilies: () => [],
      listRecruitmentEvents: () => [],
    },
    cloudSync: {
      status: () => ({ configured: false, serverUrl: 'https://cloud.example.test', userId: '' }),
    },
  });
  const overview = await api.employeeOverview({ refreshCloud: false });
  assert.equal(overview.capabilities.recruitment.enabled, false);
  assert.equal(overview.capabilities.recruitment.code, 'cloud_auth_required');
  assert.equal(blocked.userId, 'local_pending_user');
  assert.match(blocked.error, /cloud_auth_required/);
});

test('employee overview recomputes cloud readiness after a successful capability refresh', async () => {
  let capabilities = {};
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_ready_user', role: 'member', remoteBound: true, remoteId: 'remote_ready_user' }) },
    store: {
      blockEmployeeCommandsForCloudAuth() { throw new Error('ready capability must not be blocked'); },
      getEmployeeQuota: () => ({ used: 0, limit: 10 }),
      ensureSystemAgentInstances: () => [],
      listEmployeeRoster: () => [],
      listRecruitableAgentFamilies: () => [],
      listRecruitmentEvents: () => [],
    },
    cloudSync: {
      status: () => ({
        configured: true, serverUrl: 'https://cloud.example.test', userId: 'remote_ready_user',
        employeeCapabilities: capabilities,
      }),
      async employeeOverview() {
        capabilities = { enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' };
        return { policyVersion: 'employee_cloud_authority_v1', quota: { used: 0, limit: 10 }, recruitableFamilies: [] };
      },
    },
  });
  const overview = await api.employeeOverview();
  assert.equal(overview.capabilities.recruitment.enabled, true);
  assert.equal(overview.capabilities.recruitment.code, 'employee_cloud_ready');
});

test('employee overview runs the complete authority repair before returning the startup roster', async () => {
  let syncCalls = 0;
  let progressionCalls = 0;
  let capabilities = {};
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_startup_repair', role: 'member', remoteBound: true, remoteId: 'remote_startup_repair' }) },
    store: {
      blockEmployeeCommandsForCloudAuth() { throw new Error('completed startup repair must not be blocked'); },
      getEmployeeQuota: () => ({ used: 1, limit: 10 }),
      ensureSystemAgentInstances: () => [],
      listEmployeeRoster: () => [{
        id: 'startup_repaired_employee', userId: 'local_startup_repair', agentFamilyId: 'general_agent',
        instanceKind: 'employee', employmentState: 'active', authorityState: 'cloud_confirmed', status: 'active',
      }],
      getAgentFamily: () => ({ id: 'general_agent', name: 'Generalist' }),
      listMemoryDocuments: () => [],
      listRecruitableAgentFamilies: () => [],
      listRecruitmentEvents: () => [],
      getEmployeeLifecycleSyncState: () => null,
      settingGet: () => '',
    },
    cloudSync: {
      status: () => ({
        configured: true, serverUrl: 'https://cloud.example.test', userId: 'remote_startup_repair',
        employeeCapabilities: capabilities,
      }),
      async syncEmployeeAuthority() {
        syncCalls += 1;
        capabilities = { enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' };
        return {
          status: 'synchronized',
          overview: { policyVersion: 'employee_cloud_authority_v1', quota: { active: 1, used: 1, limit: 10 }, recruitableFamilies: [] },
        };
      },
      async refreshEmployeeProgressionProjections() { progressionCalls += 1; return { status: 'synchronized' }; },
    },
  });

  const overview = await api.employeeOverview();
  assert.equal(syncCalls, 1);
  assert.equal(progressionCalls, 1);
  assert.equal(overview.roster[0].id, 'startup_repaired_employee');
  assert.equal(overview.capabilities.recruitment.code, 'employee_cloud_ready');
});

test('employee overview exposes an authentication recovery failure instead of generic capability pending', async () => {
  let blocked = null;
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_expired_repair', role: 'member', remoteBound: true, remoteId: 'remote_expired_repair' }) },
    store: {
      blockEmployeeCommandsForCloudAuth(input) { blocked = input; return 0; },
      getEmployeeQuota: () => ({ used: 0, limit: 10 }),
      ensureSystemAgentInstances: () => [],
      listEmployeeRoster: () => [],
      listRecruitableAgentFamilies: () => [],
      listRecruitmentEvents: () => [],
    },
    cloudSync: {
      status: () => ({
        configured: true, serverUrl: 'https://cloud.example.test', userId: 'remote_expired_repair', employeeCapabilities: {},
      }),
      async syncEmployeeAuthority() {
        throw Object.assign(new Error('Authenticated cloud identity is required.'), { status: 401, code: 'cloud_auth_required' });
      },
    },
  });

  const overview = await api.employeeOverview();
  assert.equal(overview.lastSyncError, 'cloud_auth_required');
  assert.equal(overview.capabilities.recruitment.code, 'cloud_auth_required');
  assert.match(overview.capabilities.recruitment.message, /重新登录/);
  assert.match(blocked.error, /cloud_auth_required/);
});

test('employee outbox store persists cloud authentication blocks for retryable lifecycle commands', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-employee-auth-block-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,email_verified)
    VALUES('local_auth_block','auth-block@example.test','Auth Block User','auth_block_user',1)`).run();
  store.upsertAgentFamily({ id: 'auth_block_family', name: 'Auth Block Family', departmentId: 'general', role: 'agent', routable: true });
  store.upsertAgentVersion({
    agent: { id: 'auth_block_family', name: 'Auth Block Family', departmentId: 'general', role: 'agent', baseSkill: '# Skill\n' },
    memoryTemplate: '# Memory\n',
  });
  const active = store.recruitUserAgent({
    userId: 'local_auth_block', agentFamilyId: 'auth_block_family', commandId: 'auth_block_seed',
  }).instance;
  store.stagePendingEmployeeCommand({
    userId: 'local_auth_block', remoteUserId: 'remote_auth_block', action: 'deactivate',
    agentFamilyId: active.agentFamilyId, agentInstanceId: active.id, commandId: 'auth_block_deactivate',
    expectedStateRevision: active.stateRevision, sourceDeviceId: 'auth_block_device',
  });
  store.markEmployeeCommandAttempt({ commandId: 'auth_block_deactivate', status: 'failed', error: 'temporary network failure' });
  assert.equal(store.blockEmployeeCommandsForCloudAuth({
    userId: 'local_auth_block', error: 'cloud_auth_required: Please sign in again.',
  }), 1);
  const blocked = store.getEmployeeCommandOutbox({ userId: 'local_auth_block', commandId: 'auth_block_deactivate' });
  assert.equal(blocked.status, 'blocked_auth');
  assert.equal(blocked.lastError, 'cloud_auth_required: Please sign in again.');
});

test('employee lifecycle returns the local pending state without waiting for cloud confirmation', async () => {
  const syncRequests = [];
  let submitCount = 0;
  let cloudOverviewCount = 0;
  let instance = null;
  let resolveCloudCommand;
  const cloudCommand = new Promise((resolve) => { resolveCloudCommand = resolve; });
  const family = { id: 'family_fast', name: 'Fast Agent', instanceKind: 'employee', recruitable: true };
  const store = {
    stagePendingEmployeeCommand({ userId, agentFamilyId, commandId }) {
      instance = {
        id: 'local_fast', userId, agentFamilyId, family, status: 'inactive', instanceKind: 'employee',
        employmentState: 'pending_cloud_confirmation', pendingTargetState: 'active', authorityState: 'pending', quotaExempt: false,
      };
      return { status: 'pending_cloud_confirmation', instance, command: { commandId, payload: { action: 'recruit', commandId, agentFamilyId, proposedInstanceId: instance.id } } };
    },
    getEmployeeQuota: () => ({ used: 0, limit: 10 }),
    ensureSystemAgentInstances: () => [],
    listEmployeeRoster: () => instance ? [instance] : [],
    listRecruitableAgentFamilies: () => [{ ...family, instance }],
    listRecruitmentEvents: () => [],
    listMemoryDocuments: () => [],
    getAgentFamily: () => family,
    markEmployeeCommandAttempt() { throw new Error('the immediate command must not be marked as failed'); },
  };
  const cloudSync = {
    status: () => ({
      configured: true, serverUrl: 'https://cloud.example.test', userId: 'remote_fast', deviceId: 'device_fast', lastSuccessAt: '',
      employeeCapabilities: { contractVersion: 2, profileSequenceAuthority: 'server' },
      multiMemory: { enabled: true, readOnly: false },
    }),
    async employeeOverview() {
      cloudOverviewCount += 1;
      return { policyVersion: 'employee_cloud_authority_v1', quota: { limit: 10 }, recruitableFamilies: [] };
    },
    async submitEmployeeCommand(command) {
      submitCount += 1;
      await cloudCommand;
      instance = { ...instance, status: 'active', employmentState: 'active', pendingTargetState: '', authorityState: 'cloud_confirmed' };
      return { status: 'confirmed', commandId: command.commandId, instance };
    },
  };
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_fast_user', role: 'member', remoteBound: true, remoteId: 'remote_fast' }) },
    store,
    cloudSync,
    triggerAutoSync(reason, options) { syncRequests.push({ reason, ...options }); return Promise.resolve({ status: 'completed' }); },
  });

  const result = await api.recruitEmployee({ agentFamilyId: family.id, commandId: 'command_fast' });
  assert.equal(result.status, 'pending_cloud_confirmation');
  assert.equal(result.instance.employmentState, 'pending_cloud_confirmation');
  assert.equal(submitCount, 1, 'cloud submission should start immediately in the background');
  assert.equal(cloudOverviewCount, 0, 'the local result should not wait for another cloud overview');
  assert.deepEqual(syncRequests, [], 'full sync should wait until the background command settles');
  resolveCloudCommand();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(syncRequests, [{ reason: 'employee_recruit_confirmed', delayMs: 0 }]);
});

test('concurrent duplicate recruit requests share one local lifecycle request', async () => {
  let stageCount = 0;
  let instance = null;
  const family = { id: 'ppt', name: 'PPT Agent', instanceKind: 'employee', recruitable: true };
  const store = {
    stagePendingEmployeeCommand({ userId, agentFamilyId, commandId }) {
      stageCount += 1;
      instance = {
        id: `local-ppt-${stageCount}`, userId, agentFamilyId, family, status: 'inactive', instanceKind: 'employee',
        employmentState: 'pending_cloud_confirmation', pendingTargetState: 'active', authorityState: 'pending', quotaExempt: false,
      };
      return {
        status: 'pending_cloud_confirmation', commandId, instance,
        command: { commandId, payload: { action: 'recruit', commandId, agentFamilyId, proposedInstanceId: instance.id } },
      };
    },
    getEmployeeQuota: () => ({ used: instance ? 1 : 0, limit: 10 }),
    ensureSystemAgentInstances: () => [],
    listEmployeeRoster: () => instance ? [instance] : [],
    listRecruitableAgentFamilies: () => [{ ...family, instance }],
    listRecruitmentEvents: () => [],
    listMemoryDocuments: () => [],
    getAgentFamily: () => family,
  };
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_concurrent_user', role: 'member', remoteBound: true, remoteId: 'remote_concurrent' }) },
    store,
    cloudSync: {
      status: () => ({ configured: true, serverUrl: 'https://cloud.example.test', userId: 'remote_concurrent', deviceId: 'device_concurrent',
        employeeCapabilities: { contractVersion: 2, profileSequenceAuthority: 'server' } }),
      submitEmployeeCommand: async () => new Promise(() => {}),
    },
  });

  const results = await Promise.all([
    api.recruitEmployee({ agentFamilyId: 'ppt', commandId: 'concurrent-recruit-1' }),
    api.recruitEmployee({ agentFamilyId: 'ppt', commandId: 'concurrent-recruit-2' }),
    api.recruitEmployee({ agentFamilyId: 'ppt', commandId: 'concurrent-recruit-3' }),
  ]);
  assert.equal(stageCount, 1);
  assert.deepEqual(results.map((item) => item.instance.id), ['local-ppt-1', 'local-ppt-1', 'local-ppt-1']);
  assert.deepEqual(results.map((item) => item.commandId), ['concurrent-recruit-1', 'concurrent-recruit-1', 'concurrent-recruit-1']);
});

test('a pending recruit can be immediately followed by a dependent deactivation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-recruit-deactivate-chain-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,email_verified)
    VALUES('local_recruit_deactivate','recruit-deactivate@example.test','Recruit Deactivate','recruit_deactivate',1)`).run();
  store.upsertAgentFamily({ id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department', role: 'agent', routable: true });
  store.upsertAgentVersion({
    agent: { id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department', role: 'agent', baseSkill: '# PPT Skill\n' },
    memoryTemplate: '# PPT Memory\n',
  });

  const recruitment = store.stagePendingEmployeeCommand({
    userId: 'local_recruit_deactivate', remoteUserId: 'remote_recruit_deactivate', action: 'recruit',
    agentFamilyId: 'ppt', commandId: 'recruit_then_stop', sourceDeviceId: 'device_recruit_deactivate',
  });
  const deactivation = store.stagePendingEmployeeCommand({
    userId: 'local_recruit_deactivate', remoteUserId: 'remote_recruit_deactivate', action: 'deactivate',
    agentFamilyId: 'ppt', agentInstanceId: recruitment.instance.id, commandId: 'stop_after_recruit',
    expectedStateRevision: recruitment.instance.stateRevision, sourceDeviceId: 'device_recruit_deactivate',
  });

  assert.equal(deactivation.deferredByCommandId, recruitment.commandId);
  assert.equal(deactivation.command.dependsOnCommandId, recruitment.commandId);
  assert.equal(deactivation.command.expectedStateRevisionMode, 'cloud_after_dependency');
  assert.equal(deactivation.command.previousEmploymentState, 'active');
  assert.equal(deactivation.instance.employmentState, 'inactive');
  assert.equal(deactivation.instance.pendingTargetState, 'inactive');
  assert.equal(deactivation.instance.lastEmployeeCommandId, deactivation.commandId);

  store.applyCloudEmployeeCommandResult({
    userId: 'local_recruit_deactivate', commandId: recruitment.commandId,
    result: {
      status: 'confirmed', commandId: recruitment.commandId,
      instance: {
        ...recruitment.instance, status: 'active', employmentState: 'active', pendingTargetState: '',
        authorityState: 'cloud_confirmed', stateRevision: 1, policyVersion: 'employee_cloud_authority_v1',
      },
      event: {
        id: 'recruit_then_stop_confirmed', agentFamilyId: 'ppt', agentInstanceId: recruitment.instance.id,
        eventType: 'recruited', previousState: 'not_recruited', nextState: 'active', commandId: recruitment.commandId,
      },
    },
  });
  const pendingStop = store.getUserAgentInstance(recruitment.instance.id);
  assert.equal(store.getEmployeeCommandOutbox({
    userId: 'local_recruit_deactivate', commandId: recruitment.commandId,
  }).status, 'confirmed');
  assert.equal(pendingStop.employmentState, 'inactive');
  assert.equal(pendingStop.pendingTargetState, 'inactive');
  assert.equal(pendingStop.authorityState, 'pending');
  assert.equal(pendingStop.lastEmployeeCommandId, deactivation.commandId);
});

test('device approval failures are retained as blocked authentication with their error code', async () => {
  let marked = null;
  const family = { id: 'family_blocked', name: 'Blocked Agent', instanceKind: 'employee', recruitable: true };
  const instance = {
    id: 'local_blocked', userId: 'local_blocked_user', agentFamilyId: family.id, family,
    status: 'inactive', instanceKind: 'employee', employmentState: 'pending_cloud_confirmation',
    pendingTargetState: 'active', authorityState: 'pending', quotaExempt: false,
  };
  const store = {
    stagePendingEmployeeCommand: ({ commandId }) => ({
      status: 'pending_cloud_confirmation', instance,
      command: { commandId, payload: { action: 'recruit', commandId, agentFamilyId: family.id, proposedInstanceId: instance.id } },
    }),
    getEmployeeQuota: () => ({ used: 0, limit: 10 }),
    ensureSystemAgentInstances: () => [],
    listEmployeeRoster: () => [instance],
    listRecruitableAgentFamilies: () => [{ ...family, instance }],
    listRecruitmentEvents: () => [],
    listMemoryDocuments: () => [],
    getAgentFamily: () => family,
    markEmployeeCommandAttempt(input) { marked = input; },
  };
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_blocked_user', role: 'member', remoteBound: true, remoteId: 'remote_blocked' }) },
    store,
    cloudSync: {
      status: () => ({ configured: true, serverUrl: 'https://cloud.example.test', userId: 'remote_blocked', deviceId: 'device_blocked',
        employeeCapabilities: { contractVersion: 2, profileSequenceAuthority: 'server' } }),
      async submitEmployeeCommand() {
        const error = new Error('This device is pending approval.');
        error.code = 'device_approval_pending';
        throw error;
      },
    },
    triggerAutoSync: () => Promise.resolve({ status: 'partial' }),
  });
  const result = await api.recruitEmployee({ agentFamilyId: family.id, commandId: 'command_blocked' });
  assert.equal(result.status, 'pending_cloud_confirmation');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(marked.status, 'blocked_auth');
  assert.match(marked.error, /^device_approval_pending:/);
});

test('cloud recruitable families hide stale local-only market entries', async () => {
  const localFamilies = [
    { id: 'cloud_allowed', name: 'Cloud Allowed', instanceKind: 'employee', recruitable: true },
    { id: 'stale_local_only', name: 'Stale Local Only', instanceKind: 'employee', recruitable: true },
  ];
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_user', role: 'member' }) },
    store: {
      getEmployeeQuota: () => ({ used: 0, limit: 10 }), ensureSystemAgentInstances: () => [], listEmployeeRoster: () => [],
      listRecruitableAgentFamilies: () => localFamilies, listRecruitmentEvents: () => [],
    },
    cloudSync: {
      status: () => ({ configured: true, multiMemory: { enabled: true, readOnly: false } }),
      employeeOverview: async () => ({
        policyVersion: 'employee_cloud_authority_v1', quota: { limit: 10 },
        recruitableFamilies: [{ id: 'cloud_allowed', name: 'Cloud Allowed' }],
      }),
    },
  });
  assert.deepEqual((await api.employeeOverview()).recruitableFamilies.map((item) => item.id), ['cloud_allowed']);
});

test('a stale cloud roster cannot overwrite a pending local employee lifecycle command', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-pending-employee-roster-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_pending','pending@example.test','Pending User','pending_user','remote_pending',?,1)`).run(new Date().toISOString());
  store.upsertAgentFamily({ id: 'pending_family', name: 'Pending Family', departmentId: 'general', role: 'agent', routable: true });
  const version = store.upsertAgentVersion({
    agent: { id: 'pending_family', name: 'Pending Family', departmentId: 'general', role: 'agent', baseSkill: '# Skill\n' },
    memoryTemplate: '# Memory\n',
  });
  const active = store.recruitUserAgent({
    userId: 'local_pending', agentFamilyId: 'pending_family', commandId: 'pending_seed',
  }).instance;
  const memoryIds = store.listMemoryDocuments({ agentInstanceId: active.id }).map((item) => item.id);
  const staged = store.stagePendingEmployeeCommand({
    userId: 'local_pending', remoteUserId: 'remote_pending', action: 'deactivate',
    agentFamilyId: 'pending_family', agentInstanceId: active.id, commandId: 'pending_deactivate',
    expectedStateRevision: active.stateRevision, sourceDeviceId: 'pending_device',
  });
  store.applyCloudEmployeeInstance({
    userId: 'local_pending', instance: {
      id: active.id, agentFamilyId: 'pending_family', baseAgentVersionId: version.id,
      status: 'active', employmentState: 'active', stateRevision: active.stateRevision,
      policyVersion: 'employee_cloud_authority_v1', syncEnabled: true,
    },
  });
  const preserved = store.getUserAgentInstance(active.id);
  assert.equal(preserved.employmentState, 'inactive');
  assert.equal(preserved.status, 'inactive');
  assert.equal(preserved.authorityState, 'pending');
  assert.equal(preserved.pendingTargetState, 'inactive');
  assert.equal(preserved.lastEmployeeCommandId, staged.commandId);
  assert.deepEqual(store.listMemoryDocuments({ agentInstanceId: active.id }).map((item) => item.id), memoryIds);
  store.applyCloudEmployeeInstance({
    userId: 'local_pending', instance: {
      id: active.id, agentFamilyId: 'pending_family', baseAgentVersionId: version.id,
      status: 'active', employmentState: 'active', stateRevision: active.stateRevision + 2,
      policyVersion: 'employee_cloud_authority_v1', syncEnabled: true,
    },
  });
  const superseded = store.getUserAgentInstance(active.id);
  assert.equal(superseded.employmentState, 'active', 'a newer cloud revision must supersede a stale local pending deactivation');
  assert.equal(superseded.authorityState, 'cloud_confirmed');
  assert.equal(superseded.pendingTargetState, '');
  assert.equal(store.getEmployeeCommandOutbox({ userId: 'local_pending', commandId: staged.commandId }).status, 'conflict');
  assert.equal(store.getEmployeeCommandOutbox({ userId: 'local_pending', commandId: staged.commandId }).lastError, 'superseded_by_newer_cloud_snapshot');

  const restaged = store.stagePendingEmployeeCommand({
    userId: 'local_pending', remoteUserId: 'remote_pending', action: 'deactivate',
    agentFamilyId: 'pending_family', agentInstanceId: active.id, commandId: 'pending_deactivate_confirmed_by_snapshot',
    expectedStateRevision: superseded.stateRevision, sourceDeviceId: 'pending_device',
  });
  store.applyCloudEmployeeInstance({
    userId: 'local_pending', instance: {
      id: active.id, agentFamilyId: 'pending_family', baseAgentVersionId: version.id,
      status: 'inactive', employmentState: 'inactive', stateRevision: superseded.stateRevision,
      policyVersion: 'employee_cloud_authority_v1', syncEnabled: true,
    },
  });
  const confirmed = store.getUserAgentInstance(active.id);
  assert.equal(confirmed.employmentState, 'inactive');
  assert.equal(confirmed.authorityState, 'cloud_confirmed');
  assert.equal(store.getEmployeeCommandOutbox({ userId: 'local_pending', commandId: restaged.commandId }).status, 'confirmed');
  assert.deepEqual(store.listMemoryDocuments({ agentInstanceId: active.id }).map((item) => item.id), memoryIds);
});

test('existing pending deactivations migrate to locally inactive while retaining the upload outbox', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-local-deactivation-migration-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,email_verified)
    VALUES('local_migration','migration@example.test','Migration User','migration_user',1)`).run();
  store.upsertAgentFamily({ id: 'migration_family', name: 'Migration Family', departmentId: 'general', role: 'agent', routable: true });
  const active = store.recruitUserAgent({
    userId: 'local_migration', agentFamilyId: 'migration_family', commandId: 'migration_seed',
  }).instance;
  const staged = store.stagePendingEmployeeCommand({
    userId: 'local_migration', action: 'deactivate', agentFamilyId: active.agentFamilyId,
    agentInstanceId: active.id, commandId: 'migration_deactivate', expectedStateRevision: active.stateRevision,
  });
  db.prepare("UPDATE user_agent_instances SET employment_state='pending_cloud_confirmation' WHERE id=?").run(active.id);
  db.prepare("DELETE FROM schema_migrations WHERE id='employee_local_deactivation_outbox_v1'").run();

  migrateDatabase(db);

  const migrated = store.getUserAgentInstance(active.id);
  assert.equal(migrated.employmentState, 'inactive');
  assert.equal(migrated.authorityState, 'pending');
  assert.equal(migrated.pendingTargetState, 'inactive');
  assert.equal(store.listEmployeeCommandOutbox({ userId: 'local_migration', statuses: ['pending'] })
    .some((item) => item.commandId === staged.commandId), true);
});

test('a pending local deactivation can be reversed immediately without an older cloud result overwriting the new intent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-local-employee-reactivation-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_reverse','reverse@example.test','Reverse User','reverse_user','remote_reverse',?,1)`).run(new Date().toISOString());
  store.upsertAgentFamily({ id: 'reverse_family', name: 'Reverse Family', departmentId: 'general', role: 'agent', routable: true });
  const version = store.upsertAgentVersion({
    agent: { id: 'reverse_family', name: 'Reverse Family', departmentId: 'general', role: 'agent', baseSkill: '# Skill\n' },
    memoryTemplate: '# Memory\n',
  });
  const active = store.recruitUserAgent({
    userId: 'local_reverse', agentFamilyId: 'reverse_family', commandId: 'reverse_seed',
  }).instance;
  const deactivation = store.stagePendingEmployeeCommand({
    userId: 'local_reverse', remoteUserId: 'remote_reverse', action: 'deactivate',
    agentFamilyId: 'reverse_family', agentInstanceId: active.id, commandId: 'reverse_deactivate',
    expectedStateRevision: active.stateRevision,
  });
  assert.equal(store.listRecruitableAgentFamilies({ userId: 'local_reverse' })[0].canRecruit, true);

  const reactivation = store.stagePendingEmployeeCommand({
    userId: 'local_reverse', remoteUserId: 'remote_reverse', action: 'reactivate',
    agentFamilyId: 'reverse_family', agentInstanceId: active.id, commandId: 'reverse_reactivate',
    expectedStateRevision: active.stateRevision,
  });
  assert.equal(reactivation.deferredByCommandId, deactivation.commandId);
  assert.equal(reactivation.command.dependsOnCommandId, deactivation.commandId);
  let local = store.listEmployeeRoster({ userId: 'local_reverse', includeInactive: true })[0];
  assert.equal(local.employmentState, 'pending_cloud_confirmation');
  assert.equal(local.pendingTargetState, 'active');
  assert.equal(local.authorityState, 'pending');
  assert.equal(local.routeEligible, true);

  store.applyCloudEmployeeCommandResult({
    userId: 'local_reverse', commandId: deactivation.commandId,
    result: { status: 'rejected', code: 'employee_state_conflict', commandId: deactivation.commandId },
  });
  local = store.getUserAgentInstance(active.id);
  assert.equal(local.employmentState, 'pending_cloud_confirmation');
  assert.equal(local.pendingTargetState, 'active');
  assert.equal(local.lastEmployeeCommandId, reactivation.commandId);

  store.applyCloudEmployeeCommandResult({
    userId: 'local_reverse', commandId: reactivation.commandId,
    result: { status: 'confirmed', commandId: reactivation.commandId, instance: {
      id: active.id, agentFamilyId: 'reverse_family', baseAgentVersionId: version.id,
      status: 'active', employmentState: 'active', stateRevision: active.stateRevision + 1,
      policyVersion: 'employee_cloud_authority_v1', syncEnabled: true,
    } },
  });
  local = store.getUserAgentInstance(active.id);
  assert.equal(local.employmentState, 'active');
  assert.equal(local.authorityState, 'cloud_confirmed');
  assert.equal(local.pendingTargetState, '');
});

test('a dependent reactivation rebases its expected revision from the authoritative cloud roster', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-employee-revision-rebase-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_rebase','rebase@example.test','Rebase User','rebase_user','remote_rebase',?,1)`).run(new Date().toISOString());
  store.upsertAgentFamily({ id: 'rebase_family', name: 'Rebase Family', departmentId: 'general', role: 'agent', routable: true });
  const version = store.upsertAgentVersion({
    agent: { id: 'rebase_family', name: 'Rebase Family', departmentId: 'general', role: 'agent', baseSkill: '# Skill\n' },
    memoryTemplate: '# Memory\n',
  });
  const active = store.recruitUserAgent({ userId: 'local_rebase', agentFamilyId: 'rebase_family', commandId: 'rebase_seed' }).instance;
  const deactivation = store.stagePendingEmployeeCommand({
    userId: 'local_rebase', remoteUserId: 'remote_rebase', action: 'deactivate', agentFamilyId: 'rebase_family',
    agentInstanceId: active.id, commandId: 'rebase_deactivate', expectedStateRevision: active.stateRevision,
  });
  const reactivation = store.stagePendingEmployeeCommand({
    userId: 'local_rebase', remoteUserId: 'remote_rebase', action: 'reactivate', agentFamilyId: 'rebase_family',
    agentInstanceId: active.id, commandId: 'rebase_reactivate', expectedStateRevision: active.stateRevision,
  });
  store.reconcileEmployeeInstanceClassifications();
  const classifiedPending = store.listEmployeeRoster({ userId: 'local_rebase', includeInactive: true })
    .find((item) => item.id === active.id);
  assert.equal(classifiedPending.employmentState, 'pending_cloud_confirmation');
  assert.equal(classifiedPending.pendingTargetState, 'active');
  assert.equal(classifiedPending.routeEligible, true, 'catalog reconciliation must preserve cloud-authority pending reactivation');
  const cloudInactive = {
    id: active.id, agentFamilyId: 'rebase_family', baseAgentVersionId: version.id,
    status: 'inactive', employmentState: 'inactive', stateRevision: active.stateRevision + 1,
    policyVersion: 'employee_cloud_authority_v1', syncEnabled: true,
  };
  store.applyCloudEmployeeCommandResult({
    userId: 'local_rebase', commandId: deactivation.commandId,
    result: { status: 'confirmed', commandId: deactivation.commandId, instance: cloudInactive },
  });
  let local = store.listEmployeeRoster({ userId: 'local_rebase', includeInactive: true })
    .find((item) => item.id === active.id);
  assert.equal(local.employmentState, 'pending_cloud_confirmation');
  assert.equal(local.pendingTargetState, 'active');
  assert.equal(local.authorityState, 'pending');
  assert.equal(local.routeEligible, true, 'a confirmed predecessor must not undo the dependent local reactivation intent');
  let submittedPayload = null;
  let employeeCommandCalls = 0;
  let overviewRoster = [{
    ...cloudInactive, id: 'same_family_sibling', stateRevision: 99,
  }];
  const client = {
    async employeeCapabilities() {
      return { enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' };
    },
    async employeeOverview() {
      return { bootstrap: { required: false }, systemRoster: [], roster: overviewRoster, recruitableFamilies: [] };
    },
    async employeeCommand(_state, payload) {
      employeeCommandCalls += 1;
      submittedPayload = payload;
      return { status: 'confirmed', commandId: payload.commandId, instance: {
        ...cloudInactive, status: 'active', employmentState: 'active', stateRevision: cloudInactive.stateRevision + 1,
      } };
    },
  };
  const sync = new CloudSyncService({ root, db, store, client, defaultConfig: {} });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_rebase', deviceId: 'rebase_device' });
  db.prepare("UPDATE cloud_sync_state SET device_grant='rebase_grant',evolution_grant='rebase_grant' WHERE id='default'").run();
  await assert.rejects(sync.submitEmployeeCommand(reactivation.command), (error) => error?.code === 'employee_state_revision_unavailable');
  assert.equal(employeeCommandCalls, 0, 'a same-Family sibling must not supply the target instance revision');
  overviewRoster = [cloudInactive];
  await sync.submitEmployeeCommand(reactivation.command);
  assert.equal(submittedPayload.expectedStateRevision, cloudInactive.stateRevision);
  assert.equal(store.getEmployeeCommandOutbox({ userId: 'local_rebase', commandId: reactivation.commandId }).expectedStateRevision, cloudInactive.stateRevision);
  const confirmed = store.getUserAgentInstance(active.id);
  assert.equal(confirmed.employmentState, 'active');
  assert.equal(confirmed.authorityState, 'cloud_confirmed');
  sync.close();
});

test('employee outbox drains dependencies before dependents even when timestamps tie', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-employee-outbox-order-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_order','order@example.test','Order User','order_user','remote_order',?,1)`).run(new Date().toISOString());
  store.upsertAgentFamily({ id: 'order_family', name: 'Order Family', departmentId: 'general', role: 'agent', routable: true });
  const version = store.upsertAgentVersion({
    agent: { id: 'order_family', name: 'Order Family', departmentId: 'general', role: 'agent', baseSkill: '# Skill\n' },
    memoryTemplate: '# Memory\n',
  });
  const active = store.recruitUserAgent({ userId: 'local_order', agentFamilyId: 'order_family', commandId: 'order_seed' }).instance;
  store.stagePendingEmployeeCommand({
    userId: 'local_order', remoteUserId: 'remote_order', action: 'deactivate', agentFamilyId: 'order_family',
    agentInstanceId: active.id, commandId: 'z_deactivate', expectedStateRevision: active.stateRevision,
  });
  store.stagePendingEmployeeCommand({
    userId: 'local_order', remoteUserId: 'remote_order', action: 'reactivate', agentFamilyId: 'order_family',
    agentInstanceId: active.id, commandId: 'a_reactivate', expectedStateRevision: active.stateRevision,
  });
  db.prepare("UPDATE employee_command_outbox SET created_at='2026-01-01T00:00:00.000Z'").run();
  let remote = {
    id: active.id, agentFamilyId: 'order_family', baseAgentVersionId: version.id,
    status: 'active', employmentState: 'active', stateRevision: active.stateRevision,
    policyVersion: 'employee_cloud_authority_v1', syncEnabled: true,
  };
  const actions = [];
  const client = {
    employeeRequestTimeoutMs: 15_000,
    async employeeCapabilities() { return { enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' }; },
    async employeeOverview() { return { bootstrap: { required: false }, systemRoster: [], roster: [remote], recruitableFamilies: [] }; },
    async employeeCommand(_state, payload) {
      actions.push(payload.action);
      assert.equal(payload.expectedStateRevision, remote.stateRevision);
      const state = payload.action === 'deactivate' ? 'inactive' : 'active';
      remote = { ...remote, status: state, employmentState: state, stateRevision: remote.stateRevision + 1 };
      return { status: 'confirmed', commandId: payload.commandId, instance: remote };
    },
  };
  const sync = new CloudSyncService({ root, db, store, client, defaultConfig: {} });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_order', deviceId: 'order_device' });
  db.prepare("UPDATE cloud_sync_state SET device_grant='order_grant',evolution_grant='order_grant' WHERE id='default'").run();
  const result = await sync.drainEmployeeCommandOutbox();
  assert.deepEqual(actions, ['deactivate', 'reactivate']);
  assert.equal(result.status, 'completed');
  assert.equal(result.remaining, 0);
  assert.equal(store.getUserAgentInstance(active.id).employmentState, 'active');
  sync.close();
});

test('remote-bound users wait for the cloud roster instead of creating an orphan default employee', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-remote-default-authority-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_remote_default','remote-default@example.test','Remote Default','remote_default','remote_default_user',?,1)`).run(now);
  store.upsertAgentFamily({
    id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true, defaultForNewUser: true,
  });
  store.upsertAgentVersion({
    agent: { id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
      instanceKind: 'employee', recruitable: true, defaultForNewUser: true, baseSkill: '# Generalist\n' },
    memoryTemplate: '# Memory\n',
  });
  store.upsertAgentFamily({
    id: 'secretary_agent', name: 'uBuddy', departmentId: 'secretary', role: 'agent', routable: true,
    instanceKind: 'system', recruitable: false,
  });
  store.upsertAgentVersion({
    agent: { id: 'secretary_agent', name: 'uBuddy', departmentId: 'secretary', role: 'agent', routable: true,
      instanceKind: 'system', recruitable: false, baseSkill: '# uBuddy\n' },
    memoryTemplate: '# Memory\n',
  });

  const provisioned = store.provisionNewUserAgentDefaults({ userId: 'local_remote_default' });
  assert.equal(provisioned.employeeAuthority, 'cloud');
  assert.equal(store.findUserAgentInstance({ userId: 'local_remote_default', agentFamilyId: 'general_agent' }), null);
  assert.ok(store.findUserAgentInstance({ userId: 'local_remote_default', agentFamilyId: 'secretary_agent' }));
});

test('cloud employee sync adopts a local-only employee under the same ID and preserves its history', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-local-employee-adoption-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_adoption','adoption@example.test','Adoption User','adoption_user','remote_adoption',?,1)`).run(now);
  store.upsertAgentFamily({
    id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  const version = store.upsertAgentVersion({
    agent: { id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
      instanceKind: 'employee', recruitable: true, baseSkill: '# Generalist\n' },
    memoryTemplate: '# Memory\n',
  });
  const localOnly = store.ensureUserAgentInstance({
    userId: 'local_adoption', agentFamilyId: 'general_agent', baseAgentVersionId: version.id,
    recruitmentSource: 'default', creationMode: 'explicit_recruitment',
  });
  const session = store.createSession({
    id: 'local_adoption_session', title: 'Preserved history', userId: 'local_adoption', departmentId: 'general',
    agentId: 'general_agent', agentInstanceId: localOnly.id,
  });
  store.addMessage({ sessionId: session.id, role: 'user', content: 'preserve me', agentId: 'general_agent', agentInstanceId: localOnly.id });
  const before = {
    sessionIds: db.prepare('SELECT id FROM sessions WHERE agent_instance_id=? ORDER BY id').all(localOnly.id).map((row) => row.id),
    messageIds: db.prepare(`SELECT id FROM messages WHERE session_id IN
      (SELECT id FROM sessions WHERE agent_instance_id=?) ORDER BY id`).all(localOnly.id).map((row) => row.id),
    memoryIds: db.prepare('SELECT id FROM memory_documents WHERE user_agent_instance_id=? ORDER BY id').all(localOnly.id).map((row) => row.id),
  };
  let roster = [];
  const submitted = [];
  const client = {
    employeeRequestTimeoutMs: 15_000,
    async employeeCapabilities() {
      return {
        enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server',
        instanceAliasProjection: 'overview_v1', localInstanceAdoption: 'recruit_preserve_state_v1',
      };
    },
    async employeeOverview() {
      return {
        authority: 'cloud', bootstrap: { required: false, status: 'completed' }, aliases: [], systemRoster: [], roster,
        quota: { active: roster.filter((item) => item.employmentState === 'active').length, used: roster.length, limit: 10, remaining: 10 - roster.length },
        recruitableFamilies: [],
      };
    },
    async employeeCommand(_state, payload) {
      submitted.push(payload);
      const instance = {
        id: payload.proposedInstanceId, agentFamilyId: payload.agentFamilyId, baseAgentVersionId: version.id,
        status: payload.employmentState || 'active', employmentState: payload.employmentState || 'active',
        stateRevision: 1, policyVersion: 'employee_cloud_authority_v1', recruitmentSource: 'local_instance_adoption',
        syncEnabled: true, familyInstanceSeq: 1, displayName: localOnly.displayName,
      };
      roster = [instance];
      return { status: 'confirmed', commandId: payload.commandId, action: payload.action, instance };
    },
  };
  const sync = new CloudSyncService({ root, db, store, client, defaultConfig: {} });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_adoption', deviceId: 'adoption_device', autoSync: false });
  db.prepare("UPDATE cloud_sync_state SET device_grant='adoption_grant',evolution_grant='adoption_grant' WHERE id='default'").run();

  const result = await sync.syncEmployeeAuthority();
  assert.equal(result.adoption.staged, 1);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].action, 'recruit');
  assert.equal(submitted[0].proposedInstanceId, localOnly.id);
  assert.equal(submitted[0].adoptLocalInstance, true);
  assert.equal(submitted[0].employmentState, 'active');
  assert.equal(store.getUserAgentInstance(localOnly.id).authorityState, 'cloud_confirmed');
  assert.deepEqual(db.prepare('SELECT id FROM sessions WHERE agent_instance_id=? ORDER BY id').all(localOnly.id).map((row) => row.id), before.sessionIds);
  assert.deepEqual(db.prepare(`SELECT id FROM messages WHERE session_id IN
    (SELECT id FROM sessions WHERE agent_instance_id=?) ORDER BY id`).all(localOnly.id).map((row) => row.id), before.messageIds);
  assert.deepEqual(db.prepare('SELECT id FROM memory_documents WHERE user_agent_instance_id=? ORDER BY id').all(localOnly.id).map((row) => row.id), before.memoryIds);
  sync.close();
});

test('startup employee repair refreshes expired auth, replaces an invalid Grant, and adopts local history once', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-startup-employee-repair-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_startup_history','startup-history@example.test','Startup History','startup_history','remote_startup_history',?,1)`).run(now);
  store.upsertAgentFamily({
    id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  const version = store.upsertAgentVersion({
    agent: { id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
      instanceKind: 'employee', recruitable: true, baseSkill: '# Generalist\n' },
    memoryTemplate: '# Memory\n',
  });
  const localOnly = store.ensureUserAgentInstance({
    userId: 'local_startup_history', agentFamilyId: 'general_agent', baseAgentVersionId: version.id,
    recruitmentSource: 'default', creationMode: 'explicit_recruitment',
  });
  const session = store.createSession({
    id: 'startup_history_session', title: 'Startup preserved history', userId: 'local_startup_history',
    departmentId: 'general', agentId: 'general_agent', agentInstanceId: localOnly.id,
  });
  const message = store.addMessage({
    sessionId: session.id, role: 'user', content: 'preserve startup history',
    agentId: 'general_agent', agentInstanceId: localOnly.id,
  });
  let accessToken = 'expired_access';
  let roster = [];
  let refreshCount = 0;
  let registerCount = 0;
  let commandCount = 0;
  const client = {
    async registerDevice(_state, payload, { accessToken: token }) {
      registerCount += 1;
      if (token === 'expired_access') {
        throw Object.assign(new Error('Access token expired.'), {
          status: 401, code: 'unauthorized', route: '/api/device-grants/register',
        });
      }
      assert.equal(token, 'fresh_access');
      return { deviceId: payload.deviceId, status: 'approved' };
    },
    async issueDeviceGrant() { return { token: 'fresh_startup_grant' }; },
    async employeeCapabilities(state) {
      if (state.device_grant === 'stale_startup_grant') {
        throw Object.assign(new Error('Device Grant is invalid.'), { status: 401, code: 'device_grant_invalid' });
      }
      return {
        enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server',
        instanceAliasProjection: 'overview_v1', localInstanceAdoption: 'recruit_preserve_state_v1',
      };
    },
    async employeeOverview() {
      const active = roster.filter((item) => item.employmentState === 'active').length;
      return {
        authority: 'cloud', bootstrap: { required: false, status: 'completed' }, aliases: [], systemRoster: [], roster,
        quota: { active, used: active, limit: 10, remaining: 10 - active }, recruitableFamilies: [],
      };
    },
    async employeeCommand(_state, payload) {
      commandCount += 1;
      const instance = {
        id: payload.proposedInstanceId, agentFamilyId: payload.agentFamilyId, baseAgentVersionId: version.id,
        status: 'active', employmentState: 'active', stateRevision: 1,
        policyVersion: 'employee_cloud_authority_v1', recruitmentSource: 'local_instance_adoption',
        syncEnabled: true, familyInstanceSeq: 1, displayName: localOnly.displayName,
      };
      roster = [instance];
      return { status: 'confirmed', commandId: payload.commandId, action: payload.action, instance };
    },
    async evolutionCapabilities() {
      return { enabled: true, performance: { enabled: false }, leadership: { enabled: false }, market: { enabled: false } };
    },
  };
  const sync = new CloudSyncService({
    root, db, store, client, defaultConfig: {},
    authStateProvider: () => ({
      access_token: accessToken, refresh_token: 'saved_refresh', remote_user_id: 'remote_startup_history',
    }),
    authRefreshProvider: async () => { refreshCount += 1; accessToken = 'fresh_access'; },
  });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_startup_history', deviceId: 'startup_history_device', autoSync: false });
  db.prepare("UPDATE cloud_sync_state SET device_grant='stale_startup_grant',evolution_grant='stale_startup_grant' WHERE id='default'").run();
  const api = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_startup_history', role: 'member', remoteBound: true, remoteId: 'remote_startup_history' }) },
    store,
    cloudSync: sync,
  });

  const [first, concurrent] = await Promise.all([api.employeeOverview(), api.employeeOverview()]);
  assert.equal(first.lastSyncError, '');
  assert.equal(concurrent.lastSyncError, '');
  assert.equal(first.capabilities.recruitment.code, 'employee_cloud_ready');
  assert.equal(store.getUserAgentInstance(localOnly.id).authorityState, 'cloud_confirmed');
  assert.equal(refreshCount, 1);
  assert.equal(registerCount, 2);
  assert.equal(commandCount, 1);
  assert.equal(store.getSession(session.id).agentInstanceId, localOnly.id);
  assert.equal(store.getMessage(message.id).content, 'preserve startup history');
  await api.employeeOverview();
  assert.equal(commandCount, 1);
  sync.close();
});

test('cloud employee alias projection rebinds local history without recruiting a duplicate employee', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-employee-alias-projection-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_alias_user','alias@example.test','Alias User','alias_user','remote_alias_user',?,1)`).run(now);
  store.upsertAgentFamily({
    id: 'ppt', name: 'PPT', departmentId: 'ppt_department', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  const version = store.upsertAgentVersion({
    agent: { id: 'ppt', name: 'PPT', departmentId: 'ppt_department', role: 'agent', routable: true,
      instanceKind: 'employee', recruitable: true, baseSkill: '# PPT\n' },
    memoryTemplate: '# Memory\n',
  });
  const localAlias = store.ensureUserAgentInstance({
    userId: 'local_alias_user', agentFamilyId: 'ppt', baseAgentVersionId: version.id,
    recruitmentSource: 'migration', creationMode: 'legacy_backfill',
  });
  const session = store.createSession({
    id: 'alias_history_session', title: 'Alias history', userId: 'local_alias_user', departmentId: 'ppt_department',
    agentId: 'ppt', agentInstanceId: localAlias.id,
  });
  const canonical = {
    id: 'cloud_canonical_ppt', agentFamilyId: 'ppt', baseAgentVersionId: version.id,
    status: 'active', employmentState: 'active', stateRevision: 4,
    policyVersion: 'employee_cloud_authority_v1', syncEnabled: true, familyInstanceSeq: 1, displayName: 'PPT A',
  };
  const client = {
    async employeeCapabilities() {
      return {
        enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server',
        instanceAliasProjection: 'overview_v1', localInstanceAdoption: 'recruit_preserve_state_v1',
      };
    },
    async employeeOverview() {
      return {
        bootstrap: { required: false, status: 'completed' }, roster: [canonical], systemRoster: [],
        aliases: [{ aliasInstanceId: localAlias.id, canonicalInstanceId: canonical.id, reason: 'ppt_family_canonicalization' }],
        quota: { active: 1, used: 1, limit: 10, remaining: 9 }, recruitableFamilies: [],
      };
    },
    async employeeCommand() { throw new Error('alias projection must not recruit a duplicate'); },
  };
  const sync = new CloudSyncService({ root, db, store, client, defaultConfig: {} });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_alias_user', deviceId: 'alias_device', autoSync: false });
  db.prepare("UPDATE cloud_sync_state SET device_grant='alias_grant',evolution_grant='alias_grant' WHERE id='default'").run();

  const result = await sync.syncEmployeeAuthority();
  assert.equal(result.adoption.staged, 0);
  assert.equal(store.resolveUserAgent({ agentInstanceId: localAlias.id }).instance.id, canonical.id);
  assert.equal(store.getSession(session.id).agentInstanceId, canonical.id);
  assert.deepEqual(store.listUserAgentInstancesByFamily({ userId: 'local_alias_user', agentFamilyId: 'ppt' }).map((item) => item.id), [canonical.id]);
  sync.close();
});

test('Skill ownership 404 triggers one bounded employee adoption sync for a local-only instance', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-skill-ownership-adoption-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_skill_adoption','skill-adoption@example.test','Skill Adoption','skill_adoption','remote_skill_adoption',?,1)`).run(now);
  store.upsertAgentFamily({
    id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  const version = store.upsertAgentVersion({
    agent: { id: 'general_agent', name: 'Generalist', departmentId: 'general', role: 'agent', routable: true,
      instanceKind: 'employee', recruitable: true, baseSkill: '# Generalist\n' },
    memoryTemplate: '# Memory\n',
  });
  const localOnly = store.ensureUserAgentInstance({
    userId: 'local_skill_adoption', agentFamilyId: 'general_agent', baseAgentVersionId: version.id,
    recruitmentSource: 'default', creationMode: 'explicit_recruitment',
  });
  let roster = [];
  let marketCalls = 0;
  let commandCalls = 0;
  const ownershipError = () => {
    const error = new Error('Agent instance does not belong to this user.');
    error.code = 'agent_instance_not_found';
    error.status = 404;
    return error;
  };
  const client = {
    async registerDevice(_state, payload) { return { deviceId: payload.deviceId, status: 'approved' }; },
    async issueDeviceGrant() { return { token: 'fresh_skill_adoption_grant' }; },
    async employeeCapabilities() {
      return {
        enabled: true, contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server',
        instanceAliasProjection: 'overview_v1', localInstanceAdoption: 'recruit_preserve_state_v1',
      };
    },
    async employeeOverview() {
      return {
        bootstrap: { required: false, status: 'completed' }, roster, systemRoster: [], aliases: [],
        quota: { active: roster.length, used: roster.length, limit: 10, remaining: 10 - roster.length }, recruitableFamilies: [],
      };
    },
    async employeeCommand(_state, payload) {
      commandCalls += 1;
      const instance = {
        id: payload.proposedInstanceId, agentFamilyId: payload.agentFamilyId, baseAgentVersionId: version.id,
        status: 'active', employmentState: 'active', stateRevision: 1,
        policyVersion: 'employee_cloud_authority_v1', syncEnabled: true, familyInstanceSeq: 1, displayName: localOnly.displayName,
      };
      roster = [instance];
      return { status: 'confirmed', commandId: payload.commandId, instance };
    },
    async marketVersions(_state, payload) {
      marketCalls += 1;
      if (!roster.some((item) => item.id === payload.agentInstanceId)) throw ownershipError();
      return { items: [{ id: 'market_v1' }] };
    },
    async effectiveMarketSkill(_state, agentInstanceId) {
      if (!roster.some((item) => item.id === agentInstanceId)) throw ownershipError();
      return { item: { agentInstanceId, effectiveSkillHash: 'effective_hash' } };
    },
    async marketCanaryStatus(_state, { agentInstanceId }) {
      if (!roster.some((item) => item.id === agentInstanceId)) throw ownershipError();
      return { agentInstanceId, optedIn: false, assignments: [] };
    },
  };
  const sync = new CloudSyncService({
    root, db, store, client, defaultConfig: {},
    authStateProvider: () => ({ access_token: 'skill_adoption_access', remote_user_id: 'remote_skill_adoption' }),
  });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_skill_adoption', deviceId: 'skill_adoption_device', autoSync: false });
  db.prepare("UPDATE cloud_sync_state SET device_grant='stale_skill_grant',evolution_grant='stale_skill_grant' WHERE id='default'").run();
  sync.syncNow = async () => ({ status: 'completed', employees: await sync.syncEmployeeAuthority() });

  const result = await sync.marketVersions({ familyId: 'general_agent', agentInstanceId: localOnly.id });
  assert.equal(result.items[0].id, 'market_v1');
  assert.equal(result.effectiveSkill.effectiveSkillHash, 'effective_hash');
  assert.equal(commandCalls, 1);
  assert.equal(marketCalls, 3, 'ownership is tried before grant refresh, after grant refresh, and after adoption');
  assert.equal(store.getUserAgentInstance(localOnly.id).authorityState, 'cloud_confirmed');
  sync.close();
});

test('a cloud overview racing a recruit result reconciles the provisional instance instead of showing duplicate employees', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-recruit-overview-race-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_race','race@example.test','Race User','race_user','remote_race',?,1)`).run(new Date().toISOString());
  store.upsertAgentFamily({
    id: 'race_family', name: 'Race Family', departmentId: 'general', role: 'agent', routable: true,
    instanceKind: 'employee', recruitable: true,
  });
  const version = store.upsertAgentVersion({
    agent: { id: 'race_family', name: 'Race Family', departmentId: 'general', role: 'agent', baseSkill: '# Skill\n' },
    memoryTemplate: '# Memory\n',
  });
  const commandId = 'race_recruit';
  const staged = store.stagePendingEmployeeCommand({
    userId: 'local_race', remoteUserId: 'remote_race', action: 'recruit', agentFamilyId: 'race_family',
    commandId, sourceDeviceId: 'race_device',
  });
  const canonical = {
    id: 'cloud_race_instance', agentFamilyId: 'race_family', baseAgentVersionId: version.id,
    status: 'active', employmentState: 'active', stateRevision: 1,
    policyVersion: 'employee_cloud_authority_v1', syncEnabled: true,
  };

  store.applyCloudEmployeeInstance({ userId: 'local_race', instance: canonical });
  assert.equal(store.listUserAgentInstancesByFamily({ userId: 'local_race', agentFamilyId: 'race_family' }).length, 2,
    'the fixture must reproduce the overview/result race before reconciliation');
  store.applyCloudEmployeeCommandResult({
    userId: 'local_race', commandId,
    result: {
      status: 'confirmed', commandId, action: 'recruit', instance: canonical,
      event: {
        id: 'race_recruit_event', agentFamilyId: 'race_family', agentInstanceId: canonical.id,
        eventType: 'recruited', previousState: 'not_recruited', nextState: 'active', commandId,
      },
    },
  });

  const instances = store.listUserAgentInstancesByFamily({ userId: 'local_race', agentFamilyId: 'race_family' });
  assert.deepEqual(instances.map((item) => item.id), [canonical.id]);
  assert.equal(store.resolveUserAgent({ agentInstanceId: staged.instance.id }).instance.id, canonical.id);
  assert.equal(store.getEmployeeCommandOutbox({ userId: 'local_race', commandId }).localAgentInstanceId, canonical.id);

  const historicalCommandId = 'race_recruit_historical';
  const historicalStaged = store.stagePendingEmployeeCommand({
    userId: 'local_race', remoteUserId: 'remote_race', action: 'recruit', agentFamilyId: 'race_family',
    commandId: historicalCommandId, sourceDeviceId: 'race_device',
  });
  const historicalCanonical = { ...canonical, id: 'cloud_race_instance_b', stateRevision: 1 };
  store.applyCloudEmployeeInstance({ userId: 'local_race', instance: historicalCanonical });
  db.prepare("UPDATE employee_command_outbox SET status='confirmed' WHERE command_id=?").run(historicalCommandId);
  store.recordRecruitmentEvent({
    id: 'race_recruit_historical_event', userId: 'local_race', agentInstanceId: historicalCanonical.id,
    agentFamilyId: 'race_family', eventType: 'recruited', previousState: 'not_recruited', nextState: 'active',
    quotaBefore: 1, quotaAfter: 2, commandId: historicalCommandId, reason: 'cloud_confirmed',
  });
  const historicalRepair = store.reconcileProvisionalEmployeeInstances({ userId: 'local_race' });
  assert.equal(historicalRepair.merged, 1);
  assert.deepEqual(store.listUserAgentInstancesByFamily({ userId: 'local_race', agentFamilyId: 'race_family' })
    .map((item) => item.id).sort(), [canonical.id, historicalCanonical.id].sort(),
  'repairing a provisional duplicate must preserve separately recruited same-family employees');
  assert.equal(store.resolveUserAgent({ agentInstanceId: historicalStaged.instance.id }).instance.id, historicalCanonical.id);
});

test('a rejected provisional recruitment is disabled for sync and cannot poison the next V6 batch', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-rejected-employee-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,remote_id,remote_bound_at,email_verified)
    VALUES('local_rejected','rejected@example.test','Rejected User','rejected_user','remote_rejected',?,1)`).run(new Date().toISOString());
  store.upsertAgentFamily({ id: 'rejected_family', name: 'Rejected Family', departmentId: 'general', role: 'agent', routable: true });
  const version = store.upsertAgentVersion({
    agent: { id: 'rejected_family', name: 'Rejected Family', departmentId: 'general', role: 'agent', baseSkill: '# Skill\n' },
    memoryTemplate: '# Memory\n',
  });
  const staged = store.stagePendingEmployeeCommand({
    userId: 'local_rejected', remoteUserId: 'remote_rejected', action: 'recruit', agentFamilyId: 'rejected_family',
    commandId: 'rejected_command', sourceDeviceId: 'rejected_device',
  });
  store.applyCloudEmployeeCommandResult({
    userId: 'local_rejected', commandId: 'rejected_command',
    result: { status: 'rejected', code: 'agent_not_recruitable', commandId: 'rejected_command', event: {
      id: 'rejected_event', agentFamilyId: 'rejected_family', eventType: 'rejected', previousState: 'not_recruited',
      nextState: 'not_recruited', commandId: 'rejected_command', reason: 'agent_not_recruitable',
    } },
  });
  const rejected = store.getUserAgentInstance(staged.instance.id);
  assert.equal(rejected.authorityState, 'rejected');
  assert.equal(rejected.syncEnabled, false);
  assert.equal(rejected.baseAgentVersionId, version.id);
  const sync = new CloudSyncService({ root, db, store, client: {}, defaultConfig: {} });
  sync.saveConfig({ serverUrl: 'https://cloud.example.test', userId: 'remote_rejected', deviceId: 'rejected_device' });
  const payload = await sync.buildBatchPayload(sync.state());
  assert.equal(payload.data.userAgentInstances.some((item) => item.id === rejected.id), false);
  assert.equal(payload.data.memoryDocuments.some((item) => item.user_agent_instance_id === rejected.id), false);
  sync.close();
});
