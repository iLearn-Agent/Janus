import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { AgentExecutionCoordinator } from '../src/main/modules/orchestration/application/agentExecutionCoordinator.js';
import { canAccessTaskRun } from '../src/main/ipc/registerIpcHandlers.js';
import { Store } from '../src/main/store.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'janus-agent-fifo-'));
try {
  let db = openDatabase(root);
  let store = new Store(db, { root });
  const first = store.enqueueAgentWork({
    userId: 'fifo-user', agentInstanceId: 'fifo-agent', workKind: 'ubuddy_agent_message', workId: 'fifo-1', payload: { value: 1 },
  });
  store.enqueueAgentWork({
    userId: 'fifo-user', agentInstanceId: 'fifo-agent', workKind: 'ubuddy_agent_message', workId: 'fifo-2', payload: { value: 2 },
  });
  const restartWorkspaceWork = store.enqueueAgentWork({
    userId: 'fifo-user', agentInstanceId: 'restart-workspace-agent', workKind: 'ubuddy_workspace_message', workId: 'workspace-restart', payload: {},
  });
  assert.equal(store.claimAgentWork({ id: first.id, agentInstanceId: 'fifo-agent' })?.status, 'running');
  assert.equal(store.claimAgentWork({ id: restartWorkspaceWork.id, agentInstanceId: 'restart-workspace-agent' })?.status, 'running');
  db.close();

  db = openDatabase(root);
  store = new Store(db, { root });
  const ownerTask = store.createTaskRun({ title: 'Owner task', prompt: 'owner', ownerUserId: 'owner-a' });
  store.createTaskRun({ title: 'Other task', prompt: 'other', ownerUserId: 'owner-b' });
  assert.deepEqual(store.listTaskRuns({ userId: 'owner-a' }).map((item) => item.id), [ownerTask.id]);
  assert.equal(canAccessTaskRun({ id: 'owner-a', role: 'member' }, ownerTask), true);
  assert.equal(canAccessTaskRun({ id: 'owner-b', role: 'member' }, ownerTask), false);
  assert.equal(canAccessTaskRun({ id: 'admin', role: 'admin' }, ownerTask), false);
  const coordinator = new AgentExecutionCoordinator({ store });
  const recovery = coordinator.recover();
  assert.equal(recovery.requeuedDurable, 3);
  assert.deepEqual(store.listAgentWorkQueue({ statuses: ['queued'] }).map((item) => item.workId), ['fifo-1', 'fifo-2', 'workspace-restart']);
  assert.equal(coordinator.cancel({ workKind: 'ubuddy_workspace_message', workId: 'workspace-restart', reason: 'recovery-tested' })?.status, 'cancelled');

  const executionOrder = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  coordinator.registerHandler('ubuddy_agent_message', async (work) => {
    executionOrder.push(work.workId);
    if (work.workId === 'fifo-1') await firstGate;
    return work.payload.value;
  });
  coordinator.start();
  await waitFor(() => store.findAgentWork({ workKind: 'ubuddy_agent_message', workId: 'fifo-1' })?.status === 'running');
  assert.equal(store.findAgentWork({ workKind: 'ubuddy_agent_message', workId: 'fifo-2' })?.status, 'queued');
  releaseFirst();
  await waitFor(() => store.findAgentWork({ workKind: 'ubuddy_agent_message', workId: 'fifo-2' })?.status === 'completed');
  assert.deepEqual(executionOrder, ['fifo-1', 'fifo-2']);

  coordinator.registerHandler('nested_child', async () => 'nested-result');
  coordinator.registerHandler('nested_parent', async (work) => {
    const child = coordinator.enqueue({
      userId: work.userId,
      agentInstanceId: 'nested-child-agent',
      workKind: 'nested_child',
      workId: 'nested-child-1',
      payload: {},
    });
    await coordinator.waitForWork(child.id);
    return 'parent-result';
  });
  const nestedParent = coordinator.enqueue({
    userId: 'fifo-user',
    agentInstanceId: 'nested-parent-agent',
    workKind: 'nested_parent',
    workId: 'nested-parent-1',
    payload: {},
  });
  await waitFor(() => store.getAgentWork(nestedParent.id)?.status === 'completed');
  assert.equal(store.findAgentWork({ workKind: 'nested_child', workId: 'nested-child-1' })?.status, 'completed');

  let observedRunningAbort = false;
  coordinator.registerHandler('ubuddy_workspace_message', async (_work, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      observedRunningAbort = true;
      reject(signal.reason || new Error('cancelled'));
    }, { once: true });
  }));
  const runningCancellation = coordinator.enqueue({
    userId: 'fifo-user', agentInstanceId: 'fifo-workspace-agent', workKind: 'ubuddy_workspace_message', workId: 'cancel-running', payload: {},
  });
  await waitFor(() => store.getAgentWork(runningCancellation.id)?.status === 'running');
  coordinator.cancel({ id: runningCancellation.id });
  await waitFor(() => store.getAgentWork(runningCancellation.id)?.status === 'cancelled');
  assert.equal(observedRunningAbort, true);

  const queuedCancellation = coordinator.enqueue({
    userId: 'fifo-user', agentInstanceId: 'fifo-queued-agent', workKind: 'missing-handler', workId: 'cancel-queued', payload: {},
  });
  assert.equal(coordinator.cancel({ id: queuedCancellation.id })?.status, 'cancelled');
  assert.equal(store.getAgentWork(queuedCancellation.id)?.errorText, 'cancelled_by_user');

  let shutdownAbortCode = '';
  coordinator.registerHandler('task_node', async (_work, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      shutdownAbortCode = String(signal.reason?.code || '');
      reject(signal.reason || new Error('shutdown'));
    }, { once: true });
  }));
  const durableShutdownWork = coordinator.enqueue({
    userId: 'fifo-user', agentInstanceId: 'fifo-shutdown-agent', workKind: 'task_node', workId: 'shutdown-resume', payload: {},
  });
  await waitFor(() => store.getAgentWork(durableShutdownWork.id)?.status === 'running');
  await coordinator.stop({ reason: 'runtime_shutdown', preserveDurable: true });
  assert.equal(shutdownAbortCode, 'runtime_shutdown');
  assert.equal(store.getAgentWork(durableShutdownWork.id)?.status, 'queued');
  assert.equal(store.getAgentWork(durableShutdownWork.id)?.errorText, 'runtime_shutdown_resume');

  coordinator.registerHandler('task_node', async () => 'resumed-result');
  coordinator.start();
  await waitFor(() => store.getAgentWork(durableShutdownWork.id)?.status === 'completed');
  await coordinator.stop();
  db.close();
  console.log('agent execution FIFO smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}
