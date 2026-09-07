import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { setSkillPackageInstalled, skillPackageInstallRoot } from '../src/shared/skillPackages.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'janus-ppt-send-chat-'));
const fakeCodex = path.join(root, 'fake-codex.mjs');
const previousEnvironment = Object.fromEntries([
  'JANUS_CODEX_BIN',
  'JANUS_PPT_IMAGEGEN_MAX',
  'JANUS_PPT_ENABLE_IMAGEGEN',
  'JANUS_PPT_PREVIEW_COM',
  'JANUS_PPT_COM_EXPORT',
].map((name) => [name, process.env[name]]));
let runtime = null;

try {
  await fsp.writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli ppt-workspace-smoke'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
const answer = [
  '| layout_id | title | message | proof_object | visual | speaker_note | time |',
  '|---|---|---|---|---|---|---|',
  '| basic_content | 工作区参数 | PPT 交付使用当前会话的账户工作区 | 参数检查 | 可编辑文本框 | 验证工作区参数 | 30s |',
  '| summary_takeaways | 交付完成 | PPTX 已生成并写入当前工作区 | 结果检查 | 可编辑结论卡片 | 确认文件可用 | 30s |',
].join('\\n');
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method || message.id == null) continue;
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'ppt-workspace-smoke' } });
    else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'ppt-workspace-thread' } } });
    else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params?.threadId || 'ppt-workspace-thread' } } });
    else if (message.method === 'thread/memoryMode/set' || message.method.startsWith('thread/goal/')) send({ id: message.id, result: {} });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'ppt-workspace-turn' } } });
      send({ method: 'turn/started', params: { threadId: 'ppt-workspace-thread', turn: { id: 'ppt-workspace-turn', status: 'inProgress' } } });
      send({ method: 'item/completed', params: { item: { id: 'ppt-answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, turn: { id: 'ppt-workspace-turn', status: 'completed', items: [{ id: 'ppt-answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
    } else send({ id: message.id, error: { code: -32601, message: 'unsupported: ' + message.method } });
  }
  process.exit(0);
}
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], answer, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ppt-workspace-smoke-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'ppt-answer', type: 'agent_message', text: answer } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`, 'utf8');
  await fsp.chmod(fakeCodex, 0o755);
  fs.cpSync(
    path.join(process.cwd(), 'assets', 'skills', 'ppt_creation'),
    skillPackageInstallRoot(root, 'ppt_creation'),
    { recursive: true },
  );
  setSkillPackageInstalled(root, 'ppt_creation', true, { source: 'smoke', version: 'workspace-regression' });
  process.env.JANUS_CODEX_BIN = fakeCodex;
  process.env.JANUS_PPT_IMAGEGEN_MAX = '0';
  process.env.JANUS_PPT_ENABLE_IMAGEGEN = '0';
  process.env.JANUS_PPT_PREVIEW_COM = '0';
  process.env.JANUS_PPT_COM_EXPORT = '0';

  runtime = await createRuntime({ root, isDev: true });
  const user = runtime.currentUser();
  const workspaceId = runtime.store.activeAccountWorkspace({
    userId: user.id,
    deviceId: runtime.store.contextDeviceId(),
  }).id;
  let pptInstance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'ppt' });
  if (!pptInstance) {
    pptInstance = runtime.store.recruitUserAgent({
      userId: user.id,
      agentFamilyId: 'ppt',
      commandId: 'ppt-send-chat-workspace-smoke:recruit',
    }).instance;
  }

  const events = [];
  const result = await runtime.sendChat({
    departmentId: 'ppt_department',
    agentId: 'ppt',
    agentInstanceId: pptInstance.id,
    message: '制作两页工作区参数测试 PPT，并导出为 pptx',
    chatContext: { type: 'ppt', styleId: 'general', templateId: 'none' },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.session.accountWorkspaceId || result.session.workspaceId, workspaceId);
  assert.ok(result.ppt?.deck && fs.existsSync(result.ppt.deck), 'PPT sendChat must return an existing deck.');
  assert.ok(completeZipPackage(result.ppt.deck), 'PPT sendChat must return a complete PPTX package.');
  assert.equal(result.ppt.slide_count, 2);
  assert.equal(events.some((event) => event.artifactError), false, 'PPT sendChat emitted an artifact failure.');
  assert.equal(
    runtime.store.listMessages(result.session.id).some((message) => message.metadata?.pptRenderFailed === true),
    false,
    'PPT sendChat persisted a render failure.',
  );
  process.stdout.write('ppt sendChat workspace smoke passed\n');
} finally {
  await runtime?.close?.();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fsp.rm(root, { recursive: true, force: true });
}

function completeZipPackage(file) {
  const size = fs.statSync(file).size;
  if (size < 1_024) return false;
  const descriptor = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(descriptor, head, 0, head.length, 0);
    if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false;
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(descriptor, tail, 0, tailLength, size - tailLength);
    return tail.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  } finally {
    fs.closeSync(descriptor);
  }
}
