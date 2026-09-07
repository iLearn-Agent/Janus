import assert from 'node:assert/strict';
import { chmodSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseArtifactMessage } from '../src/main/artifacts.js';
import { installPlugin, pluginStatus } from '../src/main/pluginRegistry.js';
import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-ppt-runtime-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-ppt-bin-'));
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-ppt-workspace-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previous = {
  codexBin: process.env.JANUS_CODEX_BIN,
  imagegen: process.env.JANUS_PPT_ENABLE_IMAGEGEN,
  comPreview: process.env.JANUS_PPT_PREVIEW_COM,
  comExport: process.env.JANUS_PPT_COM_EXPORT,
  boundedDeliveryRework: process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1,
};

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
const response = [
  '| layout_id | title | message | proof_object | visual | speaker_note | time |',
  '|---|---|---|---|---|---|---|',
  '| motivation_compare | 生成式推荐系统 | • 从预测偏好走向生成决策 • 强调可交互与可约束 • 建立汇报主线 | 范式对比 | 可编辑现状目标对比图 | 说明主题与汇报目标。 | 45s |',
  '| method_pipeline | 系统流程 | • 理解用户意图 • 生成候选方案 • 约束与评估 • 反馈迭代 | 四步流程 | 可编辑方法流程图 | 讲清系统闭环。 | 60s |',
  '| summary_takeaways | 总结 | • 生成扩展任务边界 • 约束保障可信可控 • 反馈推动持续优化 | 三点总结 | 可编辑总结卡片 | 收束汇报。 | 40s |',
].join('\\n');
if (outputPath) fs.writeFileSync(outputPath, response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ubuddy-ppt-smoke' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_PPT_ENABLE_IMAGEGEN = '0';
process.env.JANUS_PPT_PREVIEW_COM = '0';
process.env.JANUS_PPT_COM_EXPORT = '0';
process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = 'off';

let runtime;
try {
  const taskUpdates = [];
  runtime = await createRuntime({
    root,
    isDev: true,
    serverAuthoritativeSkills: false,
    onTaskUpdated: (payload) => taskUpdates.push(payload),
  });
  const user = runtime.currentUser();
  assert.equal(pluginStatus(root, 'ppt_creation').status.installed, false,
    'the full-chain fixture must start with the PPT Skill uninstalled');
  const installation = await installPlugin(root, 'ppt_creation');
  assert.equal(installation.status.installed, true, JSON.stringify(installation.status));
  runtime.refreshAgentIdentityCatalog();
  assert.equal(runtime.store.getAgentFamily('ppt').routable, true,
    'installing the PPT Skill must make the PPT employee family routable');
  const secretarySession = runtime.ensureSecretarySession();
  const recruited = runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'ppt',
    commandId: 'ubuddy-ppt-artifact-smoke',
  });
  const task = runtime.scheduler.createTaskRun({
    title: 'uBuddy PPT artifact runtime verification',
    prompt: '生成一份介绍生成式推荐系统的可编辑 PPT。',
    departmentId: 'ppt_department',
    userId: user.id,
    metadata: {
      workspaceRoot,
      conversationId: '',
      source: 'ubuddy_dispatch',
      sourceSecretarySessionId: secretarySession.id,
      routingPrompt: '请生成一份介绍生成式推荐系统的学术汇报 PPT。',
      pptContext: { type: 'ppt', styleId: 'academic_report', templateId: 'none' },
      candidateSnapshots: [
        { agentId: 'ppt', agentInstanceId: recruited.instance.id, departmentId: 'ppt_department', leadershipLevel: 'L0' },
      ],
      taskGraphProposal: { nodes: [
        {
          localId: 'final',
          title: '生成可编辑 PPTX',
          objective: '输出严格页面表，并由 Janus 宿主渲染、校验和交付可编辑 PPTX。',
          agentId: 'ppt',
          dependencies: [],
          outputFormat: 'editable pptx artifact',
          isFinal: true,
        },
      ] },
    },
  });

  await runtime.scheduler.runReadyNodes(task.id, { maxParallel: 1 });
  const completed = runtime.store.getTaskRun(task.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const pptFiles = filesWithExtension(workspaceRoot, '.pptx');
  assert.equal(pptFiles.length, 1, `Expected one host-rendered PPTX: ${JSON.stringify(pptFiles)}`);
  const artifact = runtime.store.listMessages('')
    .filter((message) => message.taskRunId === task.id)
    .map((message) => parseArtifactMessage(message.content))
    .find((item) => item?.kind === 'ppt');
  assert.ok(artifact, 'Task graph did not persist a PPT artifact message.');
  assert.equal(artifact.data.deck, pptFiles[0]);
  assert.equal(artifact.data.style_id, 'academic_report');
  assert.equal(artifact.data.template, 'none');
  assert.equal(artifact.data.slide_count, 3);
  assert.ok(completed.nodes[0].evidenceRefs.some((item) => item.type === 'artifact' && /\.pptx$/i.test(item.value)));
  assert.ok(taskUpdates.some((payload) => payload.change?.pptProgress));
  assert.ok(runtime.store.listTaskEvents(task.id).some((event) => event.eventType === 'ppt_artifact_rendered'));
  await waitFor(() => runtime.store.listMessages(secretarySession.id).some((message) => message.metadata?.uBuddyTaskTerminalTaskRunId === task.id));
  const terminalMessage = runtime.store.listMessages(secretarySession.id)
    .find((message) => message.metadata?.uBuddyTaskTerminalTaskRunId === task.id);
  const targetSessionId = String(terminalMessage?.metadata?.targetSessionId || '');
  assert.ok(targetSessionId, 'uBuddy did not create or select the final PPT Agent conversation.');
  const deliveredArtifact = runtime.store.listMessages(targetSessionId)
    .map((message) => parseArtifactMessage(message.content))
    .find((item) => item?.kind === 'ppt');
  assert.equal(deliveredArtifact?.data?.deck, pptFiles[0], 'Host-rendered PPT artifact was not copied into the final Agent conversation.');
  console.log(JSON.stringify({
    status: 'passed',
    skillInstalled: installation.status.installed,
    employeeActive: runtime.store.activeEmployeeAgentsForUser({ userId: user.id })
      .some((item) => item.id === recruited.instance.id && item.agentFamilyId === 'ppt'),
    taskStatus: completed.status,
    slideCount: artifact.data.slide_count,
    pptxBytes: statSync(pptFiles[0]).size,
    artifactDelivered: deliveredArtifact?.data?.deck === pptFiles[0],
  }));
} finally {
  runtime?.close();
  restoreEnv('JANUS_CODEX_BIN', previous.codexBin);
  restoreEnv('JANUS_PPT_ENABLE_IMAGEGEN', previous.imagegen);
  restoreEnv('JANUS_PPT_PREVIEW_COM', previous.comPreview);
  restoreEnv('JANUS_PPT_COM_EXPORT', previous.comExport);
  restoreEnv('JANUS_BOUNDED_DELIVERY_REWORK_V1', previous.boundedDeliveryRework);
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}

function filesWithExtension(rootPath, extension) {
  const matches = [];
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const candidate = path.join(rootPath, entry.name);
    if (entry.isDirectory()) matches.push(...filesWithExtension(candidate, extension));
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === extension) matches.push(candidate);
  }
  return matches.sort();
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for uBuddy PPT finalization.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
