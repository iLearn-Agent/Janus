import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const codexBin = process.env.JANUS_E2E_CODEX_BIN || '/usr/bin/codex';
const codexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-real-coordination-'));
const previousBin = process.env.JANUS_CODEX_BIN;
const previousModelRefresh = process.env.JANUS_MODEL_REFRESH_ENABLED;
let runtime = null;

try {
  assert.ok(existsSync(codexBin), `Real Codex binary not found: ${codexBin}`);
  assert.ok(existsSync(path.join(codexHome, 'config.toml')), `Real Codex config not found: ${codexHome}`);
  assert.ok(existsSync(path.join(codexHome, 'auth.json')), `Real Codex auth not found: ${codexHome}`);
  const configTarget = path.join(root, 'config', 'codex');
  await mkdir(configTarget, { recursive: true });
  await copyFile(path.join(codexHome, 'config.toml'), path.join(configTarget, 'config.toml'));
  await copyFile(path.join(codexHome, 'auth.json'), path.join(configTarget, 'auth.json'));

  process.env.JANUS_CODEX_BIN = codexBin;
  process.env.JANUS_MODEL_REFRESH_ENABLED = '0';
  runtime = await createRuntime({ root, isDev: true });

  const events = [];
  const result = await runtime.sendChat({
    chatMode: 'collaboration',
    routePreference: 'explicit',
    message: '这是一次真实 Codex 协调测试。请由 uBuddy 读取当前在职员工 Agent 的 Skill，只选择最适合的一名 Agent，输出三条环境治理 App 的核心功能。不要创建文件，不要请求外部资料，不要拆分额外步骤。',
    workspaceRoot: root,
    reasoningEffort: 'low',
    onEvent: (event) => events.push(event),
  });

  assert.ok(result.task?.id, 'uBuddy did not create a task run.');
  const task = runtime.store.getTaskRun(result.task.id);
  assert.equal(task.status, 'completed', `Real Codex task ended with status ${task.status}.`);
  assert.equal(task.metadata?.ubuddyPlannerMode, 'model', 'uBuddy task graph planner fell back instead of using real Codex.');
  const candidates = Array.isArray(task.metadata?.candidateSnapshots) ? task.metadata.candidateSnapshots : [];
  assert.ok(candidates.length >= 1, 'uBuddy did not load active employee candidates.');
  assert.ok(candidates.some((candidate) => String(candidate.effectiveSkill || '').trim()), 'uBuddy candidates did not include effective Skill content.');
  const participantIds = [...new Set((task.nodes || []).map((node) => node.agentId).filter(Boolean))];
  assert.ok(participantIds.length >= 1, 'uBuddy did not assign an employee Agent.');
  assert.ok(participantIds.every((agentId) => candidates.some((candidate) => candidate.agentId === agentId)), 'uBuddy assigned an Agent outside the active Skill candidate pool.');
  assert.ok((task.nodes || []).every((node) => node.status === 'completed'), 'Not all real Codex task nodes completed.');
  const executions = runtime.store.listModelExecutionsForTask(task.id);
  assert.ok(executions.length >= 1, 'No real employee Agent model execution was recorded.');
  assert.ok(executions.every((execution) => execution.status === 'completed'), 'A real employee Agent execution did not complete.');
  assert.ok(events.some((event) => event.kind === 'progress' && /任务图谱/.test(String(event.message || ''))), 'The public task-graph progress event was not emitted.');
  assert.ok(events.some((event) => event.kind === 'progress' && ((event.activeAgents || []).length || (event.assignedAgents || []).length)), 'The public Agent assignment progress event was not emitted.');

  console.log(JSON.stringify({
    ok: true,
    codexMode: 'real',
    taskRunId: task.id,
    plannerMode: task.metadata.ubuddyPlannerMode,
    candidateCount: candidates.length,
    skillCandidateIds: candidates.filter((candidate) => String(candidate.effectiveSkill || '').trim()).map((candidate) => candidate.agentId),
    assignedAgentIds: participantIds,
    nodeCount: task.nodes.length,
    completedExecutions: executions.length,
    effectiveModels: [...new Set(executions.map((execution) => execution.effectiveModel).filter(Boolean))],
    visibleProgress: events.filter((event) => event.kind === 'progress').map((event) => String(event.message || '')).filter(Boolean),
  }));
} finally {
  runtime?.close();
  await rm(root, { recursive: true, force: true });
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN; else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousModelRefresh === undefined) delete process.env.JANUS_MODEL_REFRESH_ENABLED; else process.env.JANUS_MODEL_REFRESH_ENABLED = previousModelRefresh;
}
