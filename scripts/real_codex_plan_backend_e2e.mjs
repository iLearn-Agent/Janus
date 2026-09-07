import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCodexSession } from '../src/main/codex.js';

const repositoryRoot = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-real-plan-backend-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const workspaceRoot = path.join(tempRoot, 'workspace');
const codexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const codexBin = process.env.JANUS_E2E_CODEX_BIN || path.join(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex');
const outputPath = process.env.JANUS_REAL_PLAN_BACKEND_RESULT || '/path/to/ui-pictures/real-codex-plan-backend-result.json';
const marker = 'REAL_CODEX_PLAN_BACKEND_OK_20260805';
const previousCodexBin = process.env.JANUS_CODEX_BIN;

try {
  assert.ok(existsSync(codexBin), `Codex binary not found: ${codexBin}`);
  assert.ok(existsSync(path.join(codexHome, 'config.toml')), 'Real Codex config.toml is missing.');
  assert.ok(existsSync(path.join(codexHome, 'auth.json')), 'Real Codex auth.json is missing.');
  process.env.JANUS_CODEX_BIN = codexBin;
  seedRuntimeConfig();
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'marker.txt'), `${marker}\n`);

  const planEvents = [];
  const inputRequests = [];
  const planResult = await runCodexSession({
    root: runtimeRoot,
    cwd: workspaceRoot,
    sessionId: 'real-plan-backend-session',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    permissionMode: 'full-access',
    interactionMode: 'plan',
    memoryUseEnabled: false,
    memoryGenerateEnabled: false,
    timeoutMs: 300_000,
    prompt: [
      '这是后端 Plan 模式契约验证。不要读取或修改文件。',
      '必须先调用 request_user_input，一次提出恰好两个单选问题，每题两个选项：',
      '1. 询问方向选择“聚焦修复”还是“扩展重构”，推荐聚焦修复。',
      '2. 询问验证选择“窄回归”还是“完整回归”，推荐窄回归。',
      '收到答案前不得输出最终计划。收到答案后输出一个 decision-complete 的 <proposed_plan>，计划中必须包含标记 REAL_PLAN_FINALIZED。',
    ].join('\n'),
    onEvent: (event) => planEvents.push(event),
    onUserInput: async (request) => {
      inputRequests.push(request);
      return {
        answers: Object.fromEntries(request.questions.map((question) => [
          question.id,
          { answers: [question.options?.[0]?.label || '推荐选项'] },
        ])),
      };
    },
  });

  assert.equal(inputRequests.length, 1, 'Real Codex must request Plan direction exactly once.');
  assert.equal(inputRequests[0].questions.length, 2, 'The real Plan request must carry both requested decisions.');
  for (const question of inputRequests[0].questions) {
    assert.equal(question.options?.length, 2, 'Every real Plan question must expose two selectable options.');
    assert.ok(question.options[0]?.label, 'The recommended first option is missing.');
  }
  assert.ok(planEvents.some((event) => event.kind === 'user-input-request' || (event.activityType === 'input' && event.status === 'waiting')),
    'The real Plan user-input event did not reach the host event stream.');
  assert.ok(planResult.threadId, 'The real Plan turn did not persist a Codex thread.');
  assert.match(planResult.answer, /REAL_PLAN_FINALIZED/);
  assert.equal(planResult.plan?.content, planResult.answer, 'The completed native Plan item must become the authoritative final answer.');

  const normalEvents = [];
  const normalResult = await runCodexSession({
    root: runtimeRoot,
    cwd: workspaceRoot,
    sessionId: 'real-plan-backend-session',
    threadId: planResult.threadId,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    permissionMode: 'full-access',
    memoryUseEnabled: false,
    memoryGenerateEnabled: false,
    timeoutMs: 300_000,
    prompt: '这是已确认计划的普通实施验证。不要调用工具，只回复 NORMAL_PLAN_IMPLEMENTED。',
    onEvent: (event) => normalEvents.push(event),
  });
  assert.equal(normalResult.threadId, planResult.threadId, 'Normal implementation must continue the existing Codex thread.');
  assert.match(normalResult.answer, /NORMAL_PLAN_IMPLEMENTED/);

  const clearedEvents = [];
  const clearedResult = await runCodexSession({
    root: runtimeRoot,
    cwd: workspaceRoot,
    sessionId: 'real-plan-backend-cleared-session',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    permissionMode: 'full-access',
    memoryUseEnabled: false,
    memoryGenerateEnabled: false,
    timeoutMs: 300_000,
    prompt: '这是清空当前上下文后的实施验证。不要调用工具，只回复 CLEARED_CONTEXT_PLAN_IMPLEMENTED。',
    onEvent: (event) => clearedEvents.push(event),
  });
  assert.ok(clearedResult.threadId, 'Cleared-context implementation did not create a fresh Codex thread.');
  assert.notEqual(clearedResult.threadId, planResult.threadId, 'Cleared-context implementation reused the old Codex thread.');
  assert.match(clearedResult.answer, /CLEARED_CONTEXT_PLAN_IMPLEMENTED/);

  const result = {
    passed: true,
    testedAt: new Date().toISOString(),
    codex: { binary: codexBin, model: 'gpt-5.6-sol', interface: 'app-server' },
    plan: {
      questionCount: inputRequests[0].questions.length,
      questions: inputRequests[0].questions,
      answer: planResult.answer,
      threadId: planResult.threadId,
      hostReceivedInputRequest: true,
      finalPlanAuthoritative: planResult.plan?.content === planResult.answer,
    },
    normalImplementation: {
      answer: normalResult.answer,
      continuedThread: normalResult.threadId === planResult.threadId,
      eventCount: normalEvents.length,
    },
    clearedContextImplementation: {
      answer: clearedResult.answer,
      freshThread: clearedResult.threadId !== planResult.threadId,
      eventCount: clearedEvents.length,
    },
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (previousCodexBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousCodexBin;
  rmSync(tempRoot, { recursive: true, force: true });
}

function seedRuntimeConfig() {
  const target = path.join(runtimeRoot, 'config', 'codex');
  mkdirSync(target, { recursive: true });
  const config = readFileSync(path.join(codexHome, 'config.toml'), 'utf8')
    .replace(/^model\s*=.*$/m, 'model = "gpt-5.6-sol"')
    .replace(/^review_model\s*=.*$/m, 'review_model = "gpt-5.6-sol"');
  writeFileSync(path.join(target, 'config.toml'), config);
  copyFileSync(path.join(codexHome, 'auth.json'), path.join(target, 'auth.json'));
}
