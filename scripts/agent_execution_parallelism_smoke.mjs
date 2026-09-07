import assert from 'node:assert/strict';

import { AgentExecutionCoordinator } from '../src/main/modules/orchestration/application/agentExecutionCoordinator.js';

const work = [];
let nextId = 0;
const store = {
  recoverAgentWorkQueue: () => ({}),
  enqueueAgentWork({ userId, agentInstanceId, workKind, workId, payload, workspaceId }) {
    const row = {
      id: `work-${++nextId}`, userId, agentInstanceId, workKind, workId, payload,
      workspaceId, accountWorkspaceId: workspaceId, status: 'queued', sequenceNo: nextId,
    };
    work.push(row);
    return { ...row };
  },
  getAgentWork(id) { const row = work.find((item) => item.id === id); return row ? { ...row } : null; },
  findAgentWork({ workKind, workId }) { const row = work.find((item) => item.workKind === workKind && item.workId === workId); return row ? { ...row } : null; },
  listAgentWorkQueue() { return work.filter((item) => item.status === 'queued').map((item) => ({ ...item })); },
  claimAgentWork({ id }) {
    const row = work.find((item) => item.id === id);
    if (!row || row.status !== 'queued' || work.some((item) => item.agentInstanceId === row.agentInstanceId && item.status === 'running')) return null;
    row.status = 'running';
    return { ...row };
  },
  finishAgentWork({ id, status, errorText = '' }) {
    const row = work.find((item) => item.id === id);
    row.status = status;
    row.errorText = errorText;
    return { ...row };
  },
  getAgentAvailability({ agentInstanceId }) {
    const row = work.find((item) => item.agentInstanceId === agentInstanceId && ['queued', 'running'].includes(item.status));
    return { agentInstanceId, availability: row ? 'working' : 'idle', workState: row?.status || '' };
  },
};

const coordinator = new AgentExecutionCoordinator({ store });
let active = 0;
let maxActive = 0;
let started = 0;
let release;
const gate = new Promise((resolve) => { release = resolve; });
coordinator.registerHandler('parallel-test', async () => {
  active += 1;
  started += 1;
  maxActive = Math.max(maxActive, active);
  await gate;
  active -= 1;
  return 'done';
});
coordinator.start();
const queued = ['agent-a', 'agent-b', 'agent-c'].map((agentInstanceId, index) => coordinator.enqueue({
  userId: 'parallel-user', agentInstanceId, workKind: 'parallel-test', workId: `parallel-${index}`,
}));

const deadline = Date.now() + 2_000;
while (started < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(started, 3, 'three distinct Agent instances must start without a global concurrency cap');
assert.equal(maxActive, 3, 'existing three-Agent parallel execution behavior must remain intact');
release();
const completionDeadline = Date.now() + 2_000;
while (queued.some((item) => !['completed', 'failed', 'cancelled'].includes(store.getAgentWork(item.id)?.status))
  && Date.now() < completionDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(queued.every((item) => store.getAgentWork(item.id)?.status === 'completed'), true);
await coordinator.stop();
console.log('Agent execution parallelism smoke passed.');
