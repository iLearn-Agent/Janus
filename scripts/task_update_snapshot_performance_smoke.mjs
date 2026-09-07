import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-task-update-snapshot-'));
const previousBin = process.env.JANUS_CODEX_BIN;
let runtime;

try {
  process.env.JANUS_CODEX_BIN = '/tmp/fake-codex.mjs';
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const task = runtime.store.createTaskRun({
    id: 'snapshot-task', ownerUserId: runtime.currentUser().id, title: 'Snapshot benchmark',
    prompt: 'Benchmark bounded task updates.', initialStatus: 'running', deferAgentInstanceBinding: true,
  });
  const node = runtime.store.createTaskNode({
    taskRunId: task.id, title: 'Snapshot node', objective: 'Generate many events.',
    agentId: 'general_agent', departmentId: 'general', status: 'running', deferAgentInstanceBinding: true,
  });
  for (let index = 0; index < 5_000; index += 1) {
    runtime.store.recordTaskEvent({
      eventId: `snapshot-event-${String(index).padStart(5, '0')}`,
      taskRunId: task.id,
      taskNodeId: node.id,
      eventType: 'node_activity',
      actorId: 'general_agent',
      status: 'running',
      summary: `Event ${index}`,
      payload: { activityId: `activity-${index}`, activityType: 'reasoning', detail: 'bounded diagnostic payload' },
    });
  }

  const snapshot = runtime.store.getTaskRunUpdateSnapshot(task.id, { eventLimit: 50 });
  assert.equal(snapshot.events.length, 50);
  assert.equal(snapshot.eventCount, 5_001, 'task creation contributes one lifecycle event');
  assert.equal(snapshot.eventHistoryPartial, true);
  assert.equal(snapshot.events[0].id, 'snapshot-event-04950');
  assert.equal(runtime.store.getTaskRun(task.id).events.length, 5_001,
    'the complete internal task reader must preserve full event history');

  const samples = [];
  for (let index = 0; index < 40; index += 1) {
    const startedAt = performance.now();
    runtime.store.getTaskRunUpdateSnapshot(task.id, { eventLimit: 50 });
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const p95Ms = samples[Math.floor(samples.length * 0.95)];
  assert.ok(p95Ms <= 20, `task update snapshot P95 ${p95Ms.toFixed(2)}ms exceeded the 20ms gate`);
  console.log(`Task update snapshot performance smoke passed (P95 ${p95Ms.toFixed(2)}ms)`);
} finally {
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  await rm(root, { recursive: true, force: true });
}
