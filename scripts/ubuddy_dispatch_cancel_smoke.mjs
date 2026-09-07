import { strict as assert } from 'node:assert';

import { AgentExecutionCoordinator } from '../src/main/modules/orchestration/application/agentExecutionCoordinator.js';
import { planUBuddyDispatch, resolveUBuddyAgentConstraints } from '../src/main/modules/orchestration/application/uBuddyDispatchPlanner.js';

const candidates = [
  { agentId: 'general_agent', agentInstanceId: 'general_1', departmentId: 'general', name: '通用 Agent', effectiveSkill: 'analysis writing coding', performanceLevel: 'P3', queueDepth: 0 },
  { agentId: 'ppt', agentInstanceId: 'ppt_1', departmentId: 'ppt_department', name: 'PPT Agent', effectiveSkill: 'presentation slides visual storytelling', performanceLevel: 'P4', queueDepth: 0 },
];
const organization = { agents: [
  { id: 'general_agent', name: '通用 Agent', departmentId: 'general' },
  { id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department' },
] };

const planningExecutionContext = { userId: 'user_1', executionKind: 'ubuddy_background_task_graph_planner' };
let forwardedExecutionContext = null;
const single = await planUBuddyDispatch({
  prompt: '解释一下向量数据库的基本原理。',
  candidates,
  organization,
  executionContext: planningExecutionContext,
  propose: async (options) => {
    forwardedExecutionContext = options.executionContext;
    return ({
    nodes: [{ localId: 'final', title: '解释原理', objective: '解释向量数据库', agentId: 'general_agent', dependencies: [], outputFormat: '清晰说明', isFinal: true }],
    finalNodeId: 'final',
    });
  },
});
assert.equal(single.nodes.length, 1);
assert.equal(single.nodes[0].agentId, 'general_agent');
assert.equal(forwardedExecutionContext, planningExecutionContext);

const multi = await planUBuddyDispatch({
  prompt: '先分析材料，再制作一份答辩 PPT。',
  candidates,
  organization,
  propose: async () => ({
    nodes: [
      { localId: 'analysis', title: '材料分析', objective: '分析材料', agentId: 'general_agent', dependencies: [], outputFormat: '分析摘要', isFinal: false },
      { localId: 'deck', title: '制作 PPT', objective: '制作答辩 PPT', agentId: 'ppt', dependencies: ['analysis'], outputFormat: 'PPTX', isFinal: true },
    ],
    finalNodeId: 'deck',
  }),
});
assert.deepEqual(multi.nodes.map((node) => node.agentId), ['general_agent', 'ppt']);
assert.deepEqual(multi.nodes[1].dependencies, ['analysis']);

const required = resolveUBuddyAgentConstraints({ prompt: '请让 PPTAgent 完成这份演示。', candidates, organization });
assert.deepEqual(required.requiredAgentIds, ['ppt']);

await assert.rejects(() => planUBuddyDispatch({
  prompt: '整理一份普通分析报告。',
  candidates,
  organization,
  propose: async () => { throw new Error('planner unavailable'); },
}), /no unrelated single-Agent fallback/i);

const fakeStore = createFakeQueueStore();
const coordinator = new AgentExecutionCoordinator({ store: fakeStore });
coordinator.start();
coordinator.registerHandler('task_node', async (_work, { signal }) => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
}));
const queued = coordinator.enqueue({ userId: 'user_1', agentInstanceId: 'general_1', workKind: 'task_node', workId: 'node_1' });
await waitFor(() => fakeStore.getAgentWork(queued.id)?.status === 'running');
coordinator.cancel({ workKind: 'task_node', workId: 'node_1' });
await waitFor(() => fakeStore.getAgentWork(queued.id)?.status === 'cancelled');
assert.equal(fakeStore.getAgentWork(queued.id).status, 'cancelled');
coordinator.stop();

console.log('uBuddy dispatch and cancellation smoke passed');

function createFakeQueueStore() {
  const rows = new Map();
  let sequence = 0;
  return {
    enqueueAgentWork(input) {
      const row = { id: `work_${++sequence}`, sequenceNo: sequence, status: 'queued', ...input };
      rows.set(row.id, row);
      return { ...row };
    },
    getAgentWork(id) { const row = rows.get(id); return row ? { ...row } : null; },
    findAgentWork({ workKind, workId }) { return [...rows.values()].find((row) => row.workKind === workKind && row.workId === workId) || null; },
    listAgentWorkQueue({ statuses = [] } = {}) { return [...rows.values()].filter((row) => !statuses.length || statuses.includes(row.status)).map((row) => ({ ...row })); },
    claimAgentWork({ id }) {
      const row = rows.get(id);
      if (!row || row.status !== 'queued') return null;
      row.status = 'running';
      return { ...row };
    },
    finishAgentWork({ id, status, errorText = '' }) {
      const row = rows.get(id);
      if (!row) return null;
      row.status = status;
      row.errorText = errorText;
      return { ...row };
    },
    cancelAgentWork({ id, reason = '' }) {
      const row = rows.get(id);
      if (row?.status === 'queued') {
        row.status = 'cancelled';
        row.errorText = reason;
      }
      return row ? { ...row } : null;
    },
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for smoke condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
