import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { buildUBuddyPlannerCandidates } from '../src/main/modules/orchestration/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-instance-task-routing-'));
let runtime;

try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  const instanceA = runtime.store.activeEmployeeAgentsForUser({ userId: user.id })
    .find((item) => item.agentFamilyId === 'general_agent');
  const instanceB = runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'general_agent',
    commandId: 'agent-instance-task-routing:recruit-b',
  }).instance;
  runtime.store.updateUserAgentProfile({
    userId: user.id, agentInstanceId: instanceB.id, displayName: '备用研究助手', note: 'local-only remark',
  });
  const personalSkill = runtime.store.createPersonalSkillVersion({
    agentInstanceId: instanceB.id,
    overlayText: '## Personal specialization\n- Prefer evidence-led research synthesis.',
  });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: instanceB.id, skillVersionId: personalSkill.id });
  const plannerCandidates = buildUBuddyPlannerCandidates({ store: runtime.store, org: runtime.org, userId: user.id });
  const plannerB = plannerCandidates.find((item) => item.agentInstanceId === instanceB.id);
  assert.equal(plannerB.name, '备用研究助手');
  assert.match(plannerB.effectiveSkill, /evidence-led research synthesis/);
  assert.equal(Object.hasOwn(plannerB, 'note'), false, 'private remarks must not be sent to the task planner');
  const candidates = [
    { agentId: 'general_agent', agentInstanceId: instanceA.id, departmentId: 'general', performanceLevel: 'P2', queueDepth: 3, leadershipLevel: 'L0' },
    { agentId: 'general_agent', agentInstanceId: instanceB.id, departmentId: 'general', performanceLevel: 'P4', queueDepth: 0, leadershipLevel: 'L0' },
  ];

  const explicit = runtime.scheduler.createTaskRun({
    title: 'Explicit B instance task',
    prompt: 'Use the selected General Agent instance.',
    departmentId: 'general',
    userId: user.id,
    metadata: {
      candidateSnapshots: candidates,
      taskGraphProposal: { nodes: [{
        localId: 'final', title: 'Execute', objective: 'Complete the task with B.',
        agentId: 'general_agent', agentInstanceId: instanceB.id,
        dependencies: [], outputFormat: 'markdown', isFinal: true,
      }] },
    },
  });
  assert.equal(explicit.leadAgentInstanceId, instanceB.id);
  assert.equal(explicit.nodes[0].agentInstanceId, instanceB.id);

  const generatedCandidates = runtime.scheduler.createTaskRun({
    title: 'Generated candidate snapshot task',
    prompt: 'Use the selected General Agent instance without supplied candidate snapshots.',
    departmentId: 'general',
    userId: user.id,
    metadata: {
      taskGraphProposal: { nodes: [{
        localId: 'final', title: 'Execute', objective: 'Complete the task with B.',
        agentId: 'general_agent', agentInstanceId: instanceB.id,
        dependencies: [], outputFormat: 'markdown', isFinal: true,
      }] },
    },
  });
  assert.equal(generatedCandidates.nodes[0].agentInstanceId, instanceB.id);
  assert.ok(generatedCandidates.metadata.candidateSnapshots.some((item) => item.agentInstanceId === instanceB.id));

  const compatible = runtime.scheduler.createTaskRun({
    title: 'Legacy family-only task',
    prompt: 'Choose the best General Agent instance.',
    departmentId: 'general',
    userId: user.id,
    metadata: {
      candidateSnapshots: candidates,
      taskGraphProposal: { nodes: [{
        localId: 'final', title: 'Execute', objective: 'Complete the task.', agentId: 'general_agent',
        dependencies: [], outputFormat: 'markdown', isFinal: true,
      }] },
    },
  });
  assert.equal(compatible.leadAgentInstanceId, instanceB.id);
  assert.equal(compatible.nodes[0].agentInstanceId, instanceB.id);
  console.log('Agent instance task routing smoke passed');
} finally {
  await runtime?.close?.();
  fs.rmSync(root, { recursive: true, force: true });
}
