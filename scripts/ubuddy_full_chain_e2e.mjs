import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DataType, newDb } from 'pg-mem';

import { migrate } from '../cloud/src/db.mjs';
import { createMemoryObjectStore } from '../cloud/src/modules/sync/objectStore.mjs';
import { createApp } from '../cloud/src/server.mjs';
import { createRuntime } from '../src/main/runtime.js';
import { setSkillPackageInstalled } from '../src/shared/skillPackages.js';
import {
  collectUBuddyFullChainSnapshot,
  createUBuddyFullChainDiagnostics,
} from './lib/ubuddyFullChainDiagnostics.mjs';

const memoryDb = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
memoryDb.public.registerFunction({ name: 'hashtextextended', args: [DataType.text, DataType.integer], returns: DataType.bigint, implementation: () => 1 });
memoryDb.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.bigint], returns: DataType.integer, implementation: () => 1 });
memoryDb.public.registerFunction({ name: 'decode', args: [DataType.text, DataType.text], returns: DataType.bytea,
  implementation: (value, format) => Buffer.from(String(value || ''), String(format || 'base64')) });
const { Pool } = memoryDb.adapters.createPg();
const pool = new Pool();
const codes = new Map();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-full-chain-'));
const fakeCodex = path.join(tempRoot, 'fake-codex.mjs');
const fakeCodexLog = path.join(tempRoot, 'fake-codex-calls.jsonl');
const useRealCodex = process.env.JANUS_REAL_CODEX_E2E === '1';
const realE2EScope = String(process.env.JANUS_UBUDDY_REAL_E2E_SCOPE || 'full').trim().toLowerCase();
const realCoreOnly = useRealCodex && realE2EScope === 'core';
const fullChainDiagnostics = createUBuddyFullChainDiagnostics({ mode: useRealCodex ? 'real' : 'fake' });
const realCodexBin = process.env.JANUS_E2E_CODEX_BIN || '/usr/bin/codex';
const realCodexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const previousAuthUrl = process.env.JANUS_AUTH_URL;
const previousCodexBin = process.env.JANUS_CODEX_BIN;
const previousModelRefresh = process.env.JANUS_MODEL_REFRESH_ENABLED;
const previousProcessingMode = process.env.JANUS_UBUDDY_PROCESSING_MODE;
const previousTaskPptRender = process.env.JANUS_DISABLE_TASK_PPT_RENDER;
const previousIntakeFlag = process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
const previousStructuredReferenceFlag = process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
const previousAutoRoutingFlag = process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
const previousBoundedReviewFlag = process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
const fakeChainTimeoutMs = Number(process.env.JANUS_UBUDDY_FAKE_E2E_TIMEOUT_MS || 120_000);
const processingOnly = process.env.JANUS_UBUDDY_PROCESSING_ONLY_E2E === '1';
const stage0ContextOnly = process.env.JANUS_UBUDDY_STAGE0_CONTEXT_ONLY === '1';
let cloudServer = null;
let providerServer = null;
let alice = null;
let bob = null;
let carol = null;
let chainError = null;
const diagnosticSummary = {
  checks: [],
  finalStatus: '',
  taskCount: 0,
  revisionCount: 0,
  recovery: { completedTakeover: false, terminalFailureObserved: false },
  fileTransfer: { submitted: 0, uploaded: 0, downloadVerified: false },
};
if (!useRealCodex) await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const fakeLogPath = ${JSON.stringify(fakeCodexLog)};
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli ubuddy-full-chain'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]\\n  --listen <URL>'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass', codexVersion: 'ubuddy-full-chain' })); process.exit(0); }
function answerFor(stdin, requestedCwd = '') {
  const workspaceRoot = String(requestedCwd || '').trim() || process.cwd();
  fs.appendFileSync(fakeLogPath, JSON.stringify({
    event: 'answer',
    cwd: workspaceRoot,
    taskGraph: stdin.includes('executing one node in an Janus complex task graph'),
    ppt: /(?:季度汇报|制作.*PPT|PPT.{0,2}storytelling|Cross-department synthesis)/i.test(stdin),
    delegation: stdin.includes('【好友秘书 Agent 委托任务】'),
    publicContextReply: stdin.includes('请仅依据任务群公开上下文回答这次提及'),
    privateTaskContextLeak: stdin.includes('PRIVATE_TASK_CONTEXT_MUST_NOT_REACH_REMOTE_UBUDDY'),
  }) + '\\n');
  const currentUserInput = stdin.split('Current user message:\\n').at(-1) || '';
  if (stdin.includes('【UBUDDY_TASK_READINESS_AUDIT_V1】')) {
    return JSON.stringify({
      version: 'UBUDDY_TASK_READINESS_AUDIT_V1',
      dispatchReady: true,
      reason: '完整链路测试任务已具备派发条件。',
      executionPlan: { summary: '按已确认的目标和交付要求执行。', steps: ['完成任务并提交结果'], requiredInputs: [] },
      knownFacts: [], safeAssumptions: [], criticalUnknowns: [], clarifications: [], intake: {},
    });
  }
  if (stdin.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
    const currentOwnerInput = (stdin.split('Current owner message:\\n').at(-1) || '').split('\\n\\nSchema:')[0];
    const mentionedUsers = JSON.parse(stdin.match(/Structured users mentioned in this intake:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const previousIntake = JSON.parse(stdin.match(/Previous intake to continue:\\n(\\{[^\\n]+\\})/)?.[1] || 'null');
    const dispatchNow = /创建任务|任务群|确认发布|确认派发/.test(currentOwnerInput);
    const taskSubject = previousIntake?.objective || currentOwnerInput;
    const markdownChecklist = /Markdown|检查清单/.test(taskSubject);
    return JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2',
      taskIntent: true,
      action: dispatchNow ? 'dispatch_task' : 'collect_context',
      continuation: true,
      intake: {
        version: 'ubuddy_task_intake_v1',
        state: 'ready',
        objective: dispatchNow
          ? markdownChecklist
            ? '创建任务群并整理一份不超过十条的 Markdown 复习检查清单'
            : '创建任务群，汇报近期工作并制作流程图，在周五前完成'
          : markdownChecklist
            ? '整理一份不超过十条的 Markdown 复习检查清单'
            : '汇报近期工作并制作流程图，在周五前完成',
        deliverables: markdownChecklist ? ['Markdown 复习检查清单'] : ['工作汇报', '可编辑流程图'],
        acceptanceCriteria: [],
        constraints: markdownChecklist ? ['不要搜索网络', '不要制作 PPT 或其他文件'] : [],
        deadline: markdownChecklist ? '' : '周五前',
        candidateUsers: mentionedUsers,
        requiredUsers: dispatchNow ? mentionedUsers : [],
        attachments: [],
        privacyScope: dispatchNow ? 'task_group_public' : 'owner_private',
        riskLevel: 'low',
        missingFields: [],
        clarification: { reasonCode: '', question: '', options: [] },
      },
    });
  }
  if (stdin.includes('【UBUDDY_TURN_DECISION_V2】')) {
    const candidates = JSON.parse(stdin.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const currentOwnerInput = (stdin.split('Current owner message:\\n').at(-1) || '').split('\\n\\nSchema:')[0];
    const wantsPresentation = /PPT|演示文稿/i.test(currentOwnerInput);
    const selected = candidates.find((item) => item.agentId === (wantsPresentation ? 'ppt' : 'general_agent'))
      || candidates.find((item) => item.agentId === 'general_agent')
      || candidates[0];
    return JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2',
      decision: 'task_plan',
      confidence: 0.96,
      answer: '',
      clarification: null,
      nodes: [{
        localId: 'final',
        title: wantsPresentation ? '制作可编辑演示文稿' : '完成委托任务',
        objective: currentOwnerInput || '完成已发布的外部委托并提供可验收结果。',
        agentId: selected?.agentId,
        agentInstanceId: selected?.agentInstanceId,
        dependencies: [],
        outputFormat: wantsPresentation ? 'editable PPTX' : 'structured result',
        isFinal: true,
        blocking: true,
        fallback: '如专业执行受阻，保留上下文并交由通用 Agent 完整接管。',
      }],
      deliverables: [{
        id: 'primary',
        role: 'primary',
        type: wantsPresentation ? 'presentation' : 'document',
        title: wantsPresentation ? '可编辑演示文稿' : '委托任务结果',
        ownerLocalId: 'final',
        deliveryMode: wantsPresentation ? 'file' : 'inline',
        requiredExtensions: wantsPresentation ? ['.pptx'] : [],
        constraints: {},
      }],
      agentSelectionRationale: wantsPresentation
        ? '选择具备演示文稿制作能力的在职 Agent 完成交付。'
        : '选择通用 Agent 完成当前委托并返回可核验结果。',
      mentionedAgentsNotSelected: [],
    });
  }
  if (stdin.includes('FORCE_UBUDDY_RECOVERY_FAILURE')) {
    console.error('simulated specialized and recovery failure');
    process.exit(2);
  }
  if (stdin.includes('FORCE_UBUDDY_EXECUTION_FAILURE')
      && stdin.includes('Execute the declared fallback plan for a failed task node.')) {
    return '<!-- janus-content-type: deliverable -->\\nUBUDDY_RECOVERED_COMPLETE_OK：通用 Agent 已接管并完成原任务要求及交付物。';
  }
  if (currentUserInput.includes('FORCE_UBUDDY_WORKSPACE_FAILURE')
      && !stdin.includes('继续完成风险页')
      && !stdin.includes('【UBUDDY_WORKSPACE_INTENT_V1】')) {
    console.error('simulated private workspace revision failure');
    process.exit(2);
  }
  if (stdin.includes('【好友秘书 Agent 委托任务】')) {
    fs.writeFileSync(path.join(workspaceRoot, 'ubuddy-private-draft.md'), '# uBuddy private draft\\n\\nThis file was generated inside the isolated task workspace.\\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'ubuddy-execution-meta.json'), JSON.stringify({ args, cwd: workspaceRoot }), 'utf8');
  }
  if (/Markdown/i.test(currentUserInput) && /(?:需求说明|私有参考材料|私有文件)/.test(currentUserInput)) {
    fs.writeFileSync(path.join(workspaceRoot, 'private-requirements.md'), '# 私有需求说明\\n\\n- 目标：保留一份仅在当前私人工作区可见的需求说明。\\n- 范围：不发布到公共任务群。\\n', 'utf8');
  }
  if (stdin.includes('FORCE_UBUDDY_EXECUTION_FAILURE') && !stdin.includes('【uBuddy 专业执行接管】')) {
    console.error('simulated specialized execution failure');
    process.exit(2);
  }
  let answer = 'UBUDDY_INITIAL_DRAFT_OK：已根据任务上下文生成可编辑初稿。';
  if (stdin.includes('【UBUDDY_WORKSPACE_INTENT_V1】')) {
    const workspaceIntentInput = (stdin.split('用户本次输入：').at(-1) || '').split('\\n')[0];
    answer = JSON.stringify({
      intent: workspaceIntentInput.includes('就采用你刚刚完成的正确版本，分享给大家') ? 'submit' : 'execute',
      reason: '根据私人工作区上下文判断主人的操作意图。',
    });
  } else if (stdin.includes('【uBuddy 专业执行接管】')) {
    answer = 'UBUDDY_RECOVERED_COMPLETE_OK：通用 Agent 已接管并完成原任务要求及交付物。';
  } else if (stdin.includes('【UBUDDY_DELEGATION_PROCESSING_V1】') && stdin.includes('第二条正式更新')) {
    answer = JSON.stringify({ title: '第二条正式更新', content: '第二条正式更新：结论页必须补充验收标准和风险缓解措施。' });
  } else if (stdin.includes('【UBUDDY_DELEGATION_PROCESSING_V1】') && stdin.includes('正式更新：流程图必须可编辑')) {
    answer = JSON.stringify({ title: '正式任务更新', content: '正式更新：流程图必须可编辑，并在结论页列出负责人、截止时间和风险。' });
  } else if (stdin.includes('【UBUDDY_DELEGATION_PROCESSING_V1】') && stdin.includes('暂时不要同步给 Bob')) {
    answer = JSON.stringify({ title: '发布方私有要求', content: '已整理为三点任务要求；尚未同步给对方 uBuddy 或任务群。' });
  } else if (stdin.includes('【UBUDDY_DELEGATION_PROCESSING_V1】') && stdin.includes('让2840213075绘制一份关于408的考纲给我')) {
    answer = JSON.stringify({ title: '绘制 408 考纲', content: '请根据计算机考研 408 的范围绘制一份结构清晰、便于复习的考纲，覆盖数据结构、计算机组成原理、操作系统和计算机网络。' });
  } else if (stdin.includes('【UBUDDY_DELEGATION_PROCESSING_V1】')) {
    answer = JSON.stringify({ title: 'uBuddy 完整链路任务', content: '请向接收方的 uBuddy 发布并确认以下委托。\\n任务目标：根据已确认的上下文完成分工。\\n交付要求：提供可验收结果、依据和后续建议。\\n已知要求：Alice 此前要求暂不发布该委托，现已明确确认发布并发送给接收方。\\n发布确认：该确认不代表授权公开发布最终成果；未经进一步确认，请勿发布最终成果。' });
  } else if (stdin.includes('修改方向') || stdin.includes('第二版')) {
    answer = 'UBUDDY_REVISION_DRAFT_OK：已根据修改方向生成第二版初稿。';
  } else if (/Markdown/i.test(currentUserInput) && /(?:需求说明|私有参考材料|私有文件)/.test(currentUserInput)) {
    answer = '<!-- janus-content-type: deliverable -->\\n私有需求说明已生成。\\n\\n交付文件：private-requirements.md';
  } else if (/(?:季度汇报|制作.*PPT|可编辑演示文稿|editable PPTX|PPT.{0,2}storytelling|Cross-department synthesis)/i.test(stdin)) {
    answer = '<!-- janus-content-type: deliverable -->\\n季度汇报 PPT 已完成，包含关键数据、风险说明和结论。\\n\\n交付文件：quarterly-report.pptx';
  }
  return answer;
}
if (!args.includes('app-server')) {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const answer = answerFor(stdin, process.cwd());
  const outputIndex = args.indexOf('--output-last-message');
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
  if (outputPath) fs.writeFileSync(outputPath, answer, 'utf8');
  if (args.includes('--json')) {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ubuddy-full-chain-thread' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', phase: 'final_answer', text: answer } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
  }
  process.exit(0);
}
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  let activeCwd = process.cwd();
  let pendingArtifactTurn = null;
  let turnSequence = 0;
  const completeTurn = ({ turnId, answer }) => {
    send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
  };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method && pendingArtifactTurn && String(message.id) === pendingArtifactTurn.requestId) {
      const toolResult = message.result || {};
      fs.appendFileSync(fakeLogPath, JSON.stringify({
        event: 'task-artifact-result',
        cwd: activeCwd,
        success: toolResult.success === true,
        result: toolResult.contentItems?.[0]?.text || '',
      }) + '\\n');
      const current = pendingArtifactTurn;
      pendingArtifactTurn = null;
      completeTurn({
        turnId: current.turnId,
        answer: toolResult.success === true
          ? current.answer
          : '<!-- janus-content-type: diagnostic -->\\nPPTX 交付文件生成失败。',
      });
      continue;
    }
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'ubuddy-full-chain' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      activeCwd = String(message.params?.cwd || activeCwd);
      fs.appendFileSync(fakeLogPath, JSON.stringify({ event: message.method, cwd: activeCwd }) + '\\n');
      send({ id: message.id, result: { thread: { id: 'ubuddy-full-chain-thread' } } });
    }
    else if (message.method === 'thread/memoryMode/set' || message.method?.startsWith('thread/goal/')) {
      if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
      else send({ id: message.id, result: {} });
    } else if (message.method === 'turn/start') {
      const stdin = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
      const answer = answerFor(stdin, activeCwd);
      const turnId = 'ubuddy-full-chain-turn-' + (++turnSequence);
      send({ id: message.id, result: { turn: { id: turnId } } });
      const requiresPptArtifact = stdin.includes('executing one node in an Janus complex task graph')
        && /(?:季度汇报|制作.*PPT|可编辑演示文稿|editable PPTX|PPT.{0,2}storytelling|Cross-department synthesis)/i.test(stdin)
        && /^- output format:.*[.]pptx/im.test(stdin);
      if (requiresPptArtifact) {
        const requestId = 'task-artifact-call-' + turnSequence;
        pendingArtifactTurn = { requestId, turnId, answer };
        fs.appendFileSync(fakeLogPath, JSON.stringify({ event: 'task-artifact-request', cwd: activeCwd }) + '\\n');
        send({
          id: requestId,
          method: 'item/tool/call',
          params: {
            threadId: String(message.params?.threadId || 'ubuddy-full-chain-thread'),
            turnId,
            callId: 'task-artifact-' + turnSequence,
            namespace: 'janus',
            tool: 'create_task_artifact',
            arguments: {
              deliverable_id: 'primary',
              format: 'pptx',
              relative_path: 'quarterly-report.pptx',
              payload: {
                title: '季度管理汇报',
                slides: [{
                  layout_id: 'basic_content',
                  title: '季度工作总结',
                  message: '关键进展、同比数据与风险说明',
                  proof_object: '完整链路测试交付物',
                  speaker_note: '用于验证可编辑 PPTX 的生成、登记和交付。',
                }],
              },
            },
          },
        });
      } else {
        completeTurn({ turnId, answer });
      }
    } else send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  }
}
`);
if (!useRealCodex) {
  await chmod(fakeCodex, 0o755);
  execFileSync(process.execPath, ['--check', fakeCodex], { stdio: 'pipe' });
}

fullChainDiagnostics.beginScenario('environment_setup');
processingE2E: try {
  process.env.JANUS_CODEX_BIN = useRealCodex ? realCodexBin : fakeCodex;
  process.env.JANUS_MODEL_REFRESH_ENABLED = '0';
  if (!useRealCodex) process.env.JANUS_DISABLE_TASK_PPT_RENDER = '1';
  process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'off';
  process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = 'off';
  process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'off';
  process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = 'off';
  delete process.env.JANUS_UBUDDY_PROCESSING_MODE;
  if (processingOnly) {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query("INSERT INTO schema_migrations(filename) VALUES('049_repair_core_ppt_agent_catalog.sql') ON CONFLICT(filename) DO NOTHING");
  }
  const migrationCeiling = String(process.env.JANUS_UBUDDY_E2E_MIGRATION_MAX || '').trim();
  if (migrationCeiling) {
    const sourceMigrations = path.resolve('cloud/migrations');
    const boundedMigrations = path.join(tempRoot, 'bounded-cloud-migrations');
    await mkdir(boundedMigrations, { recursive: true });
    for (const filename of (await readdir(sourceMigrations)).filter((item) => item.endsWith('.sql') && item <= migrationCeiling).sort()) {
      await copyFile(path.join(sourceMigrations, filename), path.join(boundedMigrations, filename));
    }
    await migrate(pool, boundedMigrations);
    if (migrationCeiling < '078_employee_instance_profile_uniqueness.sql') {
      await pool.query(`ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS family_instance_seq integer NOT NULL DEFAULT 0`);
      await pool.query(`ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT ''`);
      await pool.query(`ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT ''`);
    }
  } else {
    await migrate(pool);
  }
  await pool.query(`INSERT INTO cloud_agent_families_v3(
    id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,default_for_new_user,quota_cost
  ) VALUES
    ('general_agent','general','General Agent','agent','active',true,'general_agent_v1','employee',true,true,1),
    ('ppt','ppt_department','PPT Agent','agent','active',true,'ppt_v1','employee',true,false,1),
    ('secretary_agent','secretary_department','uBuddy','agent','active',true,'secretary_agent_v1','system',false,false,0)
    ON CONFLICT(id) DO NOTHING`);
  await pool.query(`INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json) VALUES
    ('general_agent_v1','general_agent','{}'::jsonb),
    ('ppt_v1','ppt','{}'::jsonb),
    ('secretary_agent_v1','secretary_agent','{}'::jsonb)
    ON CONFLICT(id) DO NOTHING`);
  const app = createApp({
    pool,
    objectStore: createMemoryObjectStore(),
    config: {
      jwtSecret: 'ubuddy-full-chain-jwt-secret-long-enough',
      emailCodeSecret: 'ubuddy-full-chain-code-secret-long-enough',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
      emailCodeTtlMinutes: 10,
      env: { JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY: '1' },
    },
    mailer: {
      async sendEmailCode({ email, code, purpose }) {
        codes.set(`${email}:${purpose}`, code);
      },
    },
  });
  cloudServer = await listen(app);
  process.env.JANUS_AUTH_URL = `http://127.0.0.1:${cloudServer.address().port}`;

  const roots = {
    alice: path.join(tempRoot, 'alice'),
    bob: path.join(tempRoot, 'bob'),
    carol: path.join(tempRoot, 'carol'),
  };
  setSkillPackageInstalled(roots.bob, 'ppt_creation', true, { source: 'test_fixture', version: '0.2.3-test.8' });
  if (useRealCodex) {
    for (const root of Object.values(roots)) await seedRealCodexConfig(root);
  } else {
    providerServer = createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"data":[]}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await listen(providerServer);
  }
  alice = await createRuntime({ root: roots.alice, isDev: true });
  bob = await createRuntime({ root: roots.bob, isDev: true });
  carol = await createRuntime({ root: roots.carol, isDev: true });
  if (!useRealCodex) {
    const providerUrl = `http://127.0.0.1:${providerServer.address().port}/v1`;
    for (const runtime of [alice, bob, carol]) {
      runtime.saveCodexConfig({ baseUrl: providerUrl, apiKey: 'sk-ubuddy-full-chain', model: 'gpt-5.6-sol', reviewModel: 'gpt-5.6-sol', reasoningEffort: 'medium' });
    }
  }

  await register(alice, 'alice-ubuddy@example.com', 'Alice');
  await register(bob, 'bob-ubuddy@example.com', 'Bob');
  await register(carol, 'carol-ubuddy@example.com', 'Carol');
  await bob.authUpdateProfile({ displayName: 'Bob', username: '2840213075' });
  const aliceId = alice.currentUser().id;
  const bobId = bob.currentUser().id;
  const carolId = carol.currentUser().id;
  let bobPpt = bob.store.activeEmployeeAgentsForUser({ userId: bobId }).find((item) => item.agentFamilyId === 'ppt');
  let bobPptRecruitment = null;
  if (!bobPpt) {
    bobPptRecruitment = bob.store.recruitUserAgent({
      userId: bobId,
      agentFamilyId: 'ppt',
      commandId: 'ubuddy-full-chain:recruit-bob-ppt',
    });
    bobPpt = bobPptRecruitment.instance || bob.store.findUserAgentInstance({ userId: bobId, agentFamilyId: 'ppt' });
  }
  assert.ok(bobPpt, `Bob PPT employee fixture was not recruited locally: ${JSON.stringify({
    recruitment: bobPptRecruitment,
    family: bob.store.getAgentFamily('ppt'),
  })}`);
  const remoteBobPpt = (await pool.query(`SELECT id FROM cloud_user_agent_instances_v3
    WHERE user_id=$1 AND agent_family_id='ppt'`, [bobId])).rows[0];
  if (!remoteBobPpt) await pool.query(`INSERT INTO cloud_user_agent_instances_v3(
      user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,
      recruited_at,last_state_changed_at,state_revision,recruitment_source,policy_version,source_device_id,
      sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,payload_json
    ) VALUES($1,$2,'ppt','ppt_v1','active','employee','active',false,now(),now(),1,'test_fixture',
      'employee_recruitment_phase_a_v1','fixture',true,true,true,false,'{}'::jsonb)`, [bobId, bobPpt.id]);
  assert.ok(bob.store.activeEmployeeAgentsForUser({ userId: bobId }).some((item) => item.agentFamilyId === 'ppt'));

  await addFriend(alice, bob, '2840213075');
  await addFriend(alice, carol, 'carol-ubuddy@example.com');
  fullChainDiagnostics.finishScenario('passed', { actorCount: 3, friendshipCount: 2 });
  fullChainDiagnostics.beginScenario('direct_chat_isolation');

  await alice.socialSendMessage({ recipientId: bobId, content: '先讨论背景，不应创建任务群。', kind: 'friend', metadata: { type: 'direct_message' } });
  await bob.pollSocialNetwork({ autoProcess: false });
  assert.equal(bob.socialConversation({ peerId: aliceId }).some((item) => item.content === '先讨论背景，不应创建任务群。'), true);
  await bob.socialSendMessage({ recipientId: aliceId, content: '收到，先正常讨论，不发布任务。', kind: 'friend', metadata: { type: 'direct_message' } });
  await alice.pollSocialNetwork({ autoProcess: false });
  assert.equal(alice.socialConversation({ peerId: bobId }).some((item) => item.content === '收到，先正常讨论，不发布任务。'), true);
  assert.equal((await alice.collaborationOverview()).groups.length, 0, 'direct chat must not create a group');

  const directMention = await bob.socialSendMessage({
    recipientId: aliceId,
    content: '@Alice的uBuddy 请根据我们这段共享私聊说明当前沟通边界。',
    kind: 'friend',
    metadata: { type: 'direct_message', mentions: [{ principalType: 'ubuddy', ownerUserId: aliceId, displayText: '@Alice的uBuddy', mentionId: 'mention_alice_ubuddy_direct', source: 'picker' }] },
  });
  await alice.pollSocialNetwork({ autoProcess: false });
  const directUBuddyReply = alice.socialConversation({ peerId: bobId }).find((item) => item.metadata?.inReplyTo === directMention.message.id);
  assert.ok(directUBuddyReply, 'direct-chat uBuddy mention did not receive a contextual reply');
  assert.equal(directUBuddyReply.metadata.publicContextOnly, true);
  assert.match(directUBuddyReply.content, /正式任务和承诺仍需用户确认/);
  const naturalGroup = await alice.createChatGroup({
    title: '普通多人群 uBuddy 提及验证',
    memberIds: [bobId, carolId],
    clientRequestId: 'ubuddy-natural-group-mention-e2e',
  });
  await bob.pollSocialNetwork({ autoProcess: false });
  const ordinaryMessage = await bob.sendChatGroupMessage({
    groupId: naturalGroup.group.id,
    clientMessageId: 'natural_group_plain_message_e2e',
    content: '这是一条没有提及 uBuddy 的普通群消息。',
    metadata: { mentions: [] },
  });
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM social_realtime_events
    WHERE aggregate_id=$1`, [ordinaryMessage.messages.at(-1).id])).rows[0].count), 0,
  'ordinary group messages must not create uBuddy realtime events');
  const realtimeEvents = [];
  const realtimeStatuses = [];
  const realtimeStream = alice.startSocialRealtime({
    onEvent: (event) => realtimeEvents.push(event),
    onStatus: (status) => realtimeStatuses.push(status),
  });
  await waitFor(() => realtimeStatuses.some((item) => item.status === 'connecting'), 5_000);
  const naturalMention = await bob.sendChatGroupMessage({
    groupId: naturalGroup.group.id,
    clientMessageId: 'natural_group_ubuddy_mention_e2e',
    content: '@Alice的uBuddy 请根据本群公开内容说明你是否已收到消息。',
    metadata: { mentions: [{
      principalType: 'ubuddy', ownerUserId: aliceId, displayText: '@Alice的uBuddy',
      mentionId: 'mention_alice_ubuddy_natural_group', source: 'picker',
    }] },
  });
  const naturalMentionId = naturalMention.messages.at(-1).id;
  await waitFor(() => realtimeEvents.some((event) => (
    event.type === 'chat_group.ubuddy_mentioned' && event.aggregateId === naturalMentionId
  )), 5_000);
  alice.stopSocialRealtime();
  await realtimeStream;
  await alice.pollSocialNetwork({ autoProcess: false });
  const naturalAfterReply = await bob.chatGroup({ groupId: naturalGroup.group.id });
  const naturalUBuddyReply = naturalAfterReply.messages.find((item) => item.metadata?.inReplyTo === naturalMentionId);
  assert.ok(naturalUBuddyReply, 'ordinary multi-person chat uBuddy mention did not receive a public-context reply');
  assert.equal(naturalUBuddyReply.metadata.publicContextOnly, true);
  const naturalMentionEvents = await pool.query(`SELECT count(*) AS count FROM social_realtime_events
    WHERE recipient_user_id=$1 AND event_type='chat_group.ubuddy_mentioned' AND aggregate_id=$2`, [aliceId, naturalMentionId]);
  assert.equal(Number(naturalMentionEvents.rows[0].count), 1, 'ordinary group mention must produce exactly one realtime wake event');
  await alice.pollSocialNetwork({ autoProcess: false });
  const naturalAfterRepeatedPoll = await bob.chatGroup({ groupId: naturalGroup.group.id });
  assert.equal(naturalAfterRepeatedPoll.messages.filter((item) => item.metadata?.inReplyTo === naturalMentionId).length, 1,
    'repeated social polls must not duplicate the uBuddy group reply');
  const adHocGroupId = 'collab_group_mention_assignment_e2e';
  await pool.query(`INSERT INTO collaboration_groups(id,account_workspace_id,owner_user_id,title,metadata_json)
    VALUES($1,'workspace_personal',$2,'群内直接派发验证','{}'::jsonb)`, [adHocGroupId, aliceId]);
  await pool.query(`INSERT INTO collaboration_group_workspaces(group_id,workspace_epoch,revision,status)
    VALUES($1,$2,0,'active')`, [adHocGroupId, `workspace_${adHocGroupId}`]);
  await pool.query(`INSERT INTO collaboration_group_members(group_id,user_id,role,status)
    VALUES($1,$2,'owner','active'),($1,$3,'member','active')`, [adHocGroupId, aliceId, bobId]);
  const nonTaskMention = await alice.sendCollaborationMessage({
    groupId: adHocGroupId,
    clientMessageId: 'ad_hoc_group_non_task_mention_e2e',
    content: '@Bob 当前任务状态如何？',
    metadata: { mentions: [{
      principalType: 'user', userId: bobId, displayText: '@Bob', mentionId: 'mention_bob_non_task', source: 'picker',
    }] },
  });
  assert.equal(nonTaskMention.routing?.createdDelegations?.length || 0, 0,
    'a status question must not be misclassified as a new task assignment');
  const nonMemberMention = await alice.sendCollaborationMessage({
    groupId: adHocGroupId,
    clientMessageId: 'ad_hoc_group_non_member_assignment_e2e',
    content: '@Carol 请完成一份不应创建的任务。',
    metadata: { mentions: [{
      principalType: 'user', userId: carolId, displayText: '@Carol', mentionId: 'mention_carol_non_member', source: 'picker',
    }] },
  });
  assert.equal(nonMemberMention.routing?.createdDelegations?.length || 0, 0,
    'mentioning a non-member must not create a collaboration delegation');
  const adHocAssignment = await alice.sendCollaborationMessage({
    groupId: adHocGroupId,
    clientMessageId: 'ad_hoc_group_assignment_message_e2e',
    content: '@Bob 请完成一份群内直接派发验证报告并提交结果。',
    metadata: { mentions: [{
      principalType: 'user', userId: bobId, displayText: '@Bob', mentionId: 'mention_bob_ad_hoc_assignment', source: 'picker',
    }] },
  });
  assert.equal(adHocAssignment.routing?.createdDelegations?.length, 1,
    'a task-like @user message with no existing assignment must create a formal delegation');
  const adHocDelegationId = adHocAssignment.routing.createdDelegations[0].delegationId;
  const repeatedAdHocAssignment = await alice.sendCollaborationMessage({
    groupId: adHocGroupId,
    clientMessageId: 'ad_hoc_group_assignment_message_e2e',
    content: '@Bob 请完成一份群内直接派发验证报告并提交结果。',
    metadata: { mentions: [{
      principalType: 'user', userId: bobId, displayText: '@Bob', mentionId: 'mention_bob_ad_hoc_assignment', source: 'picker',
    }] },
  });
  const repeatedAdHocDelegationId = repeatedAdHocAssignment.routing?.createdDelegations?.[0]?.delegationId
    || repeatedAdHocAssignment.routing?.routed?.find((item) => item.targetUserId === bobId)?.delegationId;
  assert.equal(repeatedAdHocDelegationId, adHocDelegationId,
    'replaying the same group assignment message must resolve to the original delegation');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM agent_delegations
    WHERE client_request_id=$1`, [`group-mention:ad_hoc_group_assignment_message_e2e:${bobId}`])).rows[0].count), 1,
  'group mention assignment idempotency must prevent duplicate delegations');
  await bob.pollSocialNetwork({ autoProcess: true });
  assert.ok(bob.auth.agentDelegationById(adHocDelegationId), 'the mentioned user did not receive the newly created group delegation');
  if (!useRealCodex) {
    const executedAdHocDelegation = await waitFor(async () => {
      const task = (await bob.collaborationOverview()).tasks.find((item) => item.id === adHocDelegationId);
      return task?.status === 'draft_ready' ? task : null;
    }, 30_000);
    assert.ok(executedAdHocDelegation.taskRunId, 'the group-created delegation did not start an Agent task run');
  }
  await alice.updateCollaborationGroup({ groupId: adHocGroupId, action: 'close' });
  fullChainDiagnostics.finishScenario('passed', {
    publicContextReply: true, naturalGroupReply: true, adHocGroupAssignment: true, collaborationGroupsCreated: 0,
  });

  if (stage0ContextOnly) {
    const bobMention = {
      principalType: 'user', userId: bobId, displayText: '@Bob', mentionId: 'stage0_bob_dispatch', source: 'picker',
    };
    const stage0Dispatch = await alice.dispatchCollaborationCommand({
      content: '@Bob 请整理一份阶段 0 公开上下文验证说明。',
      sourcePeerId: bobId,
      sourceConversationId: `direct:${aliceId}:${bobId}`,
      sourceMessageId: 'stage0-public-context-dispatch',
      mentions: [bobMention],
    });
    assert.equal(stage0Dispatch.dispatched, true);
    const stage0GroupId = stage0Dispatch.group.id;
    await pool.query(`INSERT INTO collaboration_group_messages (
      id,account_workspace_id,group_id,sender_user_id,sender_agent_id,kind,content,metadata_json
    ) SELECT $1,account_workspace_id,id,$2,'','friend',$3,$4::jsonb
      FROM collaboration_groups WHERE id=$5`, [
      'stage0_legacy_private_context_sentinel',
      aliceId,
      'PRIVATE_TASK_CONTEXT_MUST_NOT_REACH_REMOTE_UBUDDY',
      JSON.stringify({ type: 'stage0_private_context_sentinel', privateTaskWorkspace: true }),
      stage0GroupId,
    ]);
    const stage0Mention = await alice.sendCollaborationMessage({
      groupId: stage0GroupId,
      content: '@Bob的uBuddy 请根据公开群聊说明当前任务状态。',
      metadata: { mentions: [{
        principalType: 'ubuddy', ownerUserId: bobId, displayText: '@Bob的uBuddy', mentionId: 'stage0_bob_ubuddy', source: 'picker',
      }] },
    });
    const stage0MentionId = stage0Mention.messages.at(-1).id;
    await bob.pollSocialNetwork({ autoProcess: false });
    const stage0Detail = await alice.collaborationGroup({ groupId: stage0GroupId });
    const stage0PrivateSentinel = stage0Detail.messages.find((item) => item.content === 'PRIVATE_TASK_CONTEXT_MUST_NOT_REACH_REMOTE_UBUDDY');
    assert.equal(stage0PrivateSentinel, undefined,
      'legacy private task-workspace messages must be excluded from the public group projection');
    const persistedPrivateSentinel = await pool.query(
      'SELECT metadata_json FROM collaboration_group_messages WHERE id=$1',
      ['stage0_legacy_private_context_sentinel'],
    );
    assert.equal(persistedPrivateSentinel.rows[0]?.metadata_json?.privateTaskWorkspace, true,
      'the defensive public filter must be characterized against persisted legacy private metadata');
    const stage0Reply = stage0Detail.messages.find((item) => item.metadata?.inReplyTo === stage0MentionId);
    assert.ok(stage0Reply, 'remote uBuddy did not reply from public task-group context');
    assert.equal(stage0Reply.metadata.publicContextOnly, true);
    const publicContextCall = String(await readFile(fakeCodexLog, 'utf8')).trim().split(/\r?\n/)
      .map((line) => JSON.parse(line)).reverse().find((item) => item.publicContextReply);
    assert.ok(publicContextCall, 'remote uBuddy public-context model input was not observed');
    assert.equal(publicContextCall.privateTaskContextLeak, false,
      'remote uBuddy model input must exclude private task-workspace context');
    console.log('uBuddy stage 0 public-context characterization passed');
    break processingE2E;
  }
  fullChainDiagnostics.beginScenario('numeric_account_dispatch');

  if (!realCoreOnly) {
    const groupsBeforeUsernameDelegation = (await alice.collaborationOverview()).groups
      .map((item) => item.id).sort();
    const usernameDelegation = await alice.secretaryChat({
      message: '@2840213075 让2840213075绘制一份关于408的考纲给我',
      mentions: [{ principalType: 'user', userId: bobId, displayText: '@2840213075', mentionId: 'mention_bob_username', source: 'picker' }],
    });
    assert.equal(usernameDelegation.uBuddyMode, 'dispatched');
    assert.equal(usernameDelegation.workerSession, undefined, 'username delegation must not be routed to a general Agent');
    assert.equal(usernameDelegation.dispatchType, 'external_delegation');
    assert.equal(usernameDelegation.delegation?.recipientUserId, bobId);
    assert.match(usernameDelegation.delegation?.instruction || '', /408/);
    assert.deepEqual((await alice.collaborationOverview()).groups.map((item) => item.id).sort(),
      groupsBeforeUsernameDelegation, 'single-recipient delegation must not create a task group');
  }

  const unknownUsernameDelegation = await alice.secretaryChat({
    message: '@9999999999 让9999999999绘制一份关于408的考纲给我',
  });
  assert.equal(unknownUsernameDelegation.uBuddyMode, 'target_not_found');
  assert.equal(unknownUsernameDelegation.workerSession, null, 'unknown account must not fall through to a general Agent');
  assert.match(unknownUsernameDelegation.answer, /@ 菜单选择已接受联系人/);

  process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'on';
  const overviewBeforeStagedContext = await alice.collaborationOverview();
  const groupsBeforeStagedContext = overviewBeforeStagedContext.groups.map((item) => item.id).sort();
  const tasksBeforeStagedContext = overviewBeforeStagedContext.tasks.map((item) => item.id).sort();
  const localTaskRunsBeforeStagedContext = alice.store.listTaskRuns({ userId: aliceId, limit: 500 }).map((item) => item.id).sort();
  const stagedContext = await alice.secretaryChat({
    message: realCoreOnly
      ? '先记住：这次委托只需要整理一份不超过十条的 Markdown 复习检查清单；不要搜索网络，不要制作 PPT 或其他文件，暂时不要发布。'
      : '先记住：这次委托需要汇报近期工作、制作流程图，并在周五前完成，暂时不要发布。',
  });
  assert.equal(stagedContext.uBuddyMode, 'context_collected');
  assert.equal(stagedContext.message.metadata?.uBuddyDispatchAuthorization?.authorized, false);
  assert.equal(stagedContext.message.metadata?.uBuddyDispatchAuthorization?.reasonCode, 'explicit_context_collection');
  assert.deepEqual((await alice.collaborationOverview()).groups.map((item) => item.id).sort(), groupsBeforeStagedContext,
    'collecting private delegation context must not create a task group');
  const backgroundSupplement = await alice.secretaryChat({
    sessionId: stagedContext.session.id,
    message: realCoreOnly
      ? '补充信息：检查清单主要用于考前自查，按重要性排序；以上仍只是背景说明。'
      : '补充信息：流程图需要覆盖输入、审批和归档三个环节；以上仍只是背景说明。',
  });
  assert.equal(backgroundSupplement.uBuddyMode, 'context_collected');
  assert.equal(backgroundSupplement.message.metadata?.uBuddyDispatchAuthorization?.authorized, false);
  assert.equal(backgroundSupplement.message.metadata?.uBuddyDispatchAuthorization?.reasonCode, 'intake_collect_context');
  const overviewAfterBackgroundSupplement = await alice.collaborationOverview();
  assert.deepEqual(overviewAfterBackgroundSupplement.groups.map((item) => item.id).sort(), groupsBeforeStagedContext,
    'supplementing staged background must not create a task group');
  assert.deepEqual(overviewAfterBackgroundSupplement.tasks.map((item) => item.id).sort(), tasksBeforeStagedContext,
    'supplementing staged background must not create a delegation');
  assert.deepEqual(alice.store.listTaskRuns({ userId: aliceId, limit: 500 }).map((item) => item.id).sort(), localTaskRunsBeforeStagedContext,
    'supplementing staged background must not create a local task run');
  const numericPreparation = await alice.secretaryChat({
    sessionId: stagedContext.session.id,
    message: '@2840213075 现在请创建任务群并向2840213075确认发布这个委托。',
    mentions: [{ principalType: 'user', userId: bobId, displayText: '@2840213075', mentionId: 'mention_bob_confirm', source: 'picker' }],
    sandboxPermission: 'request-approval',
  });
  process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'off';
  assert.equal(numericPreparation.uBuddyMode, 'dispatched');
  assert.equal(numericPreparation.dispatchType, 'task_group');
  const numericDispatch = numericPreparation.group;
  assert.ok(numericDispatch.group?.id, 'numeric account dispatch did not create a real task group');
  assert.equal(numericDispatch.tasks.length, 1);
  assert.equal(numericDispatch.tasks[0].recipientUserId, bobId);
  if (realCoreOnly) {
    assert.match(numericDispatch.tasks[0].instruction || '', /Markdown|检查清单/);
  } else {
    assert.match(numericDispatch.tasks[0].instruction || '', /流程图/);
    assert.match(numericDispatch.tasks[0].instruction || '', /周五/);
  }
  assert.equal(numericDispatch.group.metadata.ubuddyProcessingMode, 'deterministic');
  const numericGroupId = numericDispatch.group.id;
  const numericTask = numericDispatch.tasks[0];
  const aliceNumericOverview = await alice.collaborationOverview();
  assert.ok(aliceNumericOverview.groups.some((item) => item.id === numericGroupId), 'initiator cannot see the task group immediately');
  assert.ok(aliceNumericOverview.tasks.some((item) => item.id === numericTask.id && item.requesterUserId === aliceId), 'initiator cannot see outgoing task immediately');
  await bob.pollSocialNetwork({ autoProcess: false });
  assert.ok((await bob.collaborationOverview()).tasks.some((item) => item.id === numericTask.id && item.recipientUserId === bobId), 'recipient cannot see assigned task');
  await bob.pollSocialNetwork({ autoProcess: true });
  const numericReady = await waitForTaskStatus(bob, numericTask.id, 'draft_ready', useRealCodex ? 900_000 : fakeChainTimeoutMs);
  assertDraftWasProcessed(numericReady, { useRealCodex });
  await bob.pollSocialNetwork({ autoProcess: false });
  assert.equal(bob.socialStatus().connected, true, 'recipient lost the authoritative collaboration connection before result submission');
  let numericSubmission;
  try {
    numericSubmission = await bob.respondAgentDelegation({ delegationId: numericTask.id, action: 'submit', message: numericReady.metadata.preliminaryResult });
  } catch (error) {
    if (error?.code !== 'delegation_status_conflict') throw error;
    await bob.pollSocialNetwork({ autoProcess: false });
    numericSubmission = await bob.respondAgentDelegation({ delegationId: numericTask.id, action: 'submit', message: numericReady.metadata.preliminaryResult });
  }
  assert.equal(numericSubmission?.delegation?.status, 'submitted', `recipient submission did not converge to the authoritative submitted state: ${JSON.stringify(numericSubmission?.delegation || null)}`);
  const numericSubmitRevision = await pool.query(`SELECT metadata_json FROM agent_delegation_revisions
    WHERE delegation_id = $1 AND action = 'submit' ORDER BY revision_no DESC LIMIT 1`, [numericTask.id]);
  assert.match(String(numericSubmitRevision.rows[0]?.metadata_json?.sourceWorkspaceMessageId || ''), /^owner-submit:/,
    'direct owner submission must carry a deterministic idempotency key for safe network retry');
  await alice.collaborationTaskAction({ delegationId: numericTask.id, action: 'accept_result', content: '数字账号委托验收通过。' });
  const numericClosed = await alice.updateCollaborationGroup({ groupId: numericGroupId, action: 'close' });
  fullChainDiagnostics.finishScenario('passed', { finalTaskStatus: 'result_accepted', finalGroupStatus: 'closed' });
  if (realCoreOnly) {
    const task = bob.store.getTaskRun(numericReady.taskRunId);
    const finalNode = task?.nodes?.find((node) => node.id === task.metadata?.finalTaskNodeId)
      || task?.nodes?.find((node) => node.parallelGroup === 'final')
      || task?.nodes?.at(-1);
    const executions = modelExecutions(bob);
    assert.equal(task?.status, 'completed', JSON.stringify(task));
    assert.equal(task?.metadata?.coordinationMode, 'appointed_agent_leader');
    assert.ok(task?.leadAgentId && task?.leadAgentInstanceId, 'real core task did not persist its leader identity');
    assert.ok(task.nodes.length > 0 && task.nodes.every((node) => node.status === 'completed'));
    assert.equal(finalNode?.agentId, task.leadAgentId, 'real core final delivery was not owned by the leader');
    assert.ok(executions.some((item) => item.status === 'completed' && item.provider_id && item.effective_model));
    assert.ok(executions.some((item) => item.execution_kind === 'task_node'));
    assert.ok(executions.some((item) => item.execution_kind === 'ubuddy_delegation_processing'));
    assert.equal(executions.some((item) => ['failed', 'running'].includes(item.status)), false, JSON.stringify(executions));
    assert.equal(numericClosed.group.status, 'closed');
    assert.ok(numericClosed.tasks.every((item) => item.status === 'closed'));
    diagnosticSummary.checks = [
      'numeric_account_dispatch', 'real_model_execution_trace', 'task_graph_completed',
      'leader_final_delivery', 'result_submission', 'owner_acceptance', 'group_close',
    ];
    diagnosticSummary.finalStatus = numericClosed.group.status;
    diagnosticSummary.taskCount = 1;
    fullChainDiagnostics.checkpoint('real_core_chain_complete', {
      finalStatus: diagnosticSummary.finalStatus,
      taskRunId: task.id,
      modelExecutionCount: executions.length,
    });
    console.log(JSON.stringify({
      ok: true,
      mode: 'real_core_full_chain',
      finalStatus: diagnosticSummary.finalStatus,
      taskRunId: task.id,
      modelExecutions: executions.length,
      checks: diagnosticSummary.checks,
    }));
    break processingE2E;
  }
  fullChainDiagnostics.beginScenario('execution_takeover_and_terminal_failure');

  let completedRecovery = null;
  let failedRecovery = null;
  if (!useRealCodex) {
    const recoveryGroup = await createAuthorizedGroup(alice, {
      title: '专业执行接管完成验证',
      clientRequestId: 'ubuddy-degraded-recovery-e2e',
      assignments: [{
        recipientId: bobId,
        title: '专业执行接管完成验证',
        instruction: 'FORCE_UBUDDY_EXECUTION_FAILURE：模拟专业 Agent 明确失败，验证通用 Agent 接管并完成全部任务。',
      }],
    });
    const recoveryTask = recoveryGroup.tasks[0];
    await bob.pollSocialNetwork({ autoProcess: true });
    const recoveryOutcome = await waitFor(async () => {
      const task = (await bob.collaborationOverview()).tasks.find((item) => item.id === recoveryTask.id);
      return ['draft_ready', 'failed'].includes(String(task?.status || '')) ? task : null;
    }, 30_000);
    if (recoveryOutcome.status === 'failed') {
      failedRecovery = recoveryOutcome;
      assert.equal(Boolean(recoveryOutcome.metadata?.draftReadyAt), false);
      assert.equal(Boolean(recoveryOutcome.metadata?.preliminaryResult), false);
      assert.equal(Boolean(recoveryOutcome.metadata?.generatedTaskFiles?.length), false);
      assert.ok(recoveryOutcome.metadata?.publicFailure || recoveryOutcome.metadata?.executionProgress?.terminal,
        'terminal execution failure did not preserve a public failure signal');
      assert.doesNotMatch(recoveryOutcome.lastError || '', /Process timed out|codex|\/home\/|\/usr\//i);
    } else {
      completedRecovery = recoveryOutcome;
      const requesterRecoveryTask = (await alice.collaborationOverview()).tasks.find((item) => item.id === recoveryTask.id);
      assert.equal(Boolean(requesterRecoveryTask?.metadata?.preliminaryResult), false, 'recovered private result leaked to initiator');
      assert.equal(Boolean(requesterRecoveryTask?.metadata?.specializedExecutionError), false, 'specialized execution error leaked to initiator');
    }
    if (completedRecovery && Object.hasOwn(completedRecovery.metadata || {}, 'executionRecovered')) {
      assert.equal(completedRecovery.metadata.executionRecovered, true);
      assert.equal(Boolean(completedRecovery.metadata.executionDegraded), false);
      assert.match(completedRecovery.metadata.specializedExecutionError, /simulated specialized execution failure/);
      assert.match(completedRecovery.metadata.preliminaryResult, /UBUDDY_RECOVERED_COMPLETE_OK/);
      const recoveryCloudMetadata = await pool.query('SELECT metadata_json FROM agent_delegations WHERE id = $1', [recoveryTask.id]);
      assert.equal(Boolean(recoveryCloudMetadata.rows[0]?.metadata_json?.specializedExecutionError), false, 'specialized execution error was persisted in shared cloud metadata');

      const deterministicGroup = await createAuthorizedGroup(alice, {
        title: '双执行链明确失败验证',
        clientRequestId: 'ubuddy-deterministic-recovery-e2e',
        assignments: [{
          recipientId: bobId,
          title: '双执行链明确失败验证',
          instruction: 'FORCE_UBUDDY_RECOVERY_FAILURE：模拟专业 Agent 和通用 Agent 接管都明确失败，验证任务不会被伪装成初稿就绪。',
        }],
      });
      const deterministicTask = deterministicGroup.tasks[0];
      await bob.pollSocialNetwork({ autoProcess: true });
      failedRecovery = await waitForTaskStatus(bob, deterministicTask.id, 'failed', 30_000);
      assert.equal(Boolean(failedRecovery.metadata?.draftReadyAt), false);
      assert.equal(Boolean(failedRecovery.metadata?.preliminaryResult), false);
      assert.equal(Boolean(failedRecovery.metadata?.generatedTaskFiles?.length), false);
      assert.match(failedRecovery.lastError, /任务尚未完成/);
      assert.doesNotMatch(failedRecovery.lastError, /Process timed out|codex|\/home\/|\/usr\//i);
      await alice.updateCollaborationGroup({ groupId: deterministicGroup.group.id, action: 'close' });
    } else if (completedRecovery) {
      assert.match(completedRecovery.metadata.preliminaryResult, /已创建部门协作任务/,
        'current multi-agent intake should expose its private department-task summary');
    }
    await alice.updateCollaborationGroup({ groupId: recoveryGroup.group.id, action: 'close' });
  }
  diagnosticSummary.recovery = {
    completedTakeover: Boolean(completedRecovery),
    terminalFailureObserved: Boolean(failedRecovery),
  };
  fullChainDiagnostics.finishScenario('passed', {
    completedTakeover: Boolean(completedRecovery),
    terminalFailureObserved: Boolean(failedRecovery),
    skippedInRealMode: useRealCodex,
  });
  fullChainDiagnostics.beginScenario('multi_assignee_routing_and_privacy');

  const dispatchText = '@Bob @Carol 请创建任务群；Bob 负责制作季度汇报 PPT，并面向管理层周五前交付；Carol 负责整理同比数据和关键风险说明，周五前交付。';
  const dispatchedGroup = await alice.secretaryChat({
    message: dispatchText,
    mentions: [
      { principalType: 'user', userId: bobId, displayText: '@Bob', mentionId: 'mention_bob_dispatch', source: 'picker' },
      { principalType: 'user', userId: carolId, displayText: '@Carol', mentionId: 'mention_carol_dispatch', source: 'picker' },
    ],
  });
  assert.equal(dispatchedGroup.uBuddyMode, 'dispatched');
  assert.equal(dispatchedGroup.dispatchType, 'task_group');
  const created = dispatchedGroup.group;
  assert.equal(created.members.length, 3);
  assert.equal(created.tasks.length, 2);
  const groupId = created.group.id;
  const bobTask = created.tasks.find((item) => item.recipientUserId === bobId);
  const carolTask = created.tasks.find((item) => item.recipientUserId === carolId);
  assert.ok(bobTask && carolTask);
  assert.match(bobTask.instruction || '', /Bob|PPT/i);
  assert.match(carolTask.instruction || '', /Carol|同比|风险/);
  assert.doesNotMatch(carolTask.instruction || '', /Bob 负责|PPT/i);
  const ambiguousWorkspaceReply = await alice.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: '可以' });
  assert.equal(ambiguousWorkspaceReply.action, 'clarification');
  assert.ok(ambiguousWorkspaceReply.messages.some((item) => item.content.includes('继续修改，还是提交到任务群')));
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM agent_delegation_revisions WHERE delegation_id = $1', [bobTask.id])).rows[0].count), 0);

  await bob.pollSocialNetwork({ autoProcess: true });
  await carol.pollSocialNetwork({ autoProcess: true });
  const modelTimeout = useRealCodex ? 900_000 : fakeChainTimeoutMs;
  const bobReady = await waitForTaskStatus(bob, bobTask.id, 'draft_ready', modelTimeout);
  const carolReady = await waitForTaskStatus(carol, carolTask.id, 'draft_ready', modelTimeout);
  assertDraftWasProcessed(bobReady, { useRealCodex });
  assertDraftWasProcessed(carolReady, { useRealCodex });
  if (processingOnly) {
    assert.ok(bobReady.taskRunId && carolReady.taskRunId, 'cross-user delegations were not bound to task graphs');
    const bobTaskRunCount = Number(bob.db.prepare(`SELECT COUNT(*) AS count FROM task_runs
      WHERE COALESCE(json_extract(metadata_json,'$.delegationId'),json_extract(metadata_json,'$.delegation_id'))=?`).get(bobTask.id).count);
    const carolTaskRunCount = Number(carol.db.prepare(`SELECT COUNT(*) AS count FROM task_runs
      WHERE COALESCE(json_extract(metadata_json,'$.delegationId'),json_extract(metadata_json,'$.delegation_id'))=?`).get(carolTask.id).count);
    assert.equal(bobTaskRunCount, 1, 'Bob delegation created duplicate task graphs');
    assert.equal(carolTaskRunCount, 1, 'Carol delegation created duplicate task graphs');
    const cloudRows = await waitFor(async () => {
      const rows = (await pool.query(
        'SELECT id,status,task_run_id FROM agent_delegations WHERE id IN ($1,$2)',
        [bobTask.id, carolTask.id],
      )).rows;
      return rows.length === 2 && rows.every((item) => item.status === 'draft_ready' && item.task_run_id)
        ? rows
        : null;
    }, modelTimeout);
    assert.equal(cloudRows.length, 2);
    assert.ok(cloudRows.every((item) => item.status === 'draft_ready' && item.task_run_id));
    await alice.pollSocialNetwork({ autoProcess: false });
    const requesterTasks = (await alice.collaborationOverview()).tasks.filter((item) => [bobTask.id, carolTask.id].includes(item.id));
    assert.equal(requesterTasks.length, 2);
    assert.ok(requesterTasks.every((item) => item.status === 'draft_ready'));
    diagnosticSummary.checks = ['cloud_dispatch_received', 'recipient_ubuddy_processed', 'task_graph_bound', 'no_duplicate_task_graph', 'draft_ready_synced_to_requester'];
    diagnosticSummary.finalStatus = 'draft_ready';
    diagnosticSummary.taskCount = 2;
    fullChainDiagnostics.finishScenario('passed', { assigneeCount: 2, finalTaskStatus: 'draft_ready', processingOnly: true });
    fullChainDiagnostics.checkpoint('cross_user_processing_complete', { taskCount: 2, taskRunCount: bobTaskRunCount + carolTaskRunCount });
    console.log(JSON.stringify({
      ok: true,
      mode: 'cross_user_processing_only',
      tasks: [
        { recipient: 'bob', status: bobReady.status, taskBound: Boolean(bobReady.taskRunId), taskRunCount: bobTaskRunCount },
        { recipient: 'carol', status: carolReady.status, taskBound: Boolean(carolReady.taskRunId), taskRunCount: carolTaskRunCount },
      ],
      checks: diagnosticSummary.checks,
    }));
    break processingE2E;
  }
  if (!useRealCodex) {
    assert.ok(bobReady.metadata.generatedTaskFiles?.some((item) => /\.pptx$/i.test(item.name || '')));
    const privateFiles = (await bob.collaborationWorkspaceMessages({ delegationId: bobTask.id }))
      .flatMap((message) => message.metadata?.attachments || []);
    assert.ok(privateFiles.some((item) => /\.pptx$/i.test(item.name || '')));
  }
  const bobTaskMemoryOverview = await bob.delegationTaskMemory({ delegationId: bobTask.id });
  assert.equal(bobTaskMemoryOverview.coordinator?.taskRunId, bobReady.taskRunId, 'uBuddy coordinator Memory must use the canonical task run ID');
  const bobActiveTaskMemories = bob.db.prepare(`SELECT user_agent_instance_id,task_run_id,delegation_id FROM memory_documents
    WHERE scope='task' AND delegation_id=? AND lifecycle_state!='archived'`).all(bobTask.id);
  assert.ok(bobActiveTaskMemories.length >= 2, 'uBuddy and executor task Memories were not both created');
  assert.ok(bobActiveTaskMemories.every((item) => item.task_run_id === bobReady.taskRunId), 'active Agent task Memories must share one canonical task run ID');
  const provisionalTaskEvidence = bob.db.prepare(`SELECT outbox_id,source_kind,source_id,source_version_id,task_run_id,status,snapshot_json
    FROM evolution_evidence_outbox WHERE delegation_id=? AND task_run_id<>?
    AND status IN ('pending','claimed','deferred','failed_retryable')`).all(bobTask.id, bobReady.taskRunId);
  assert.equal(provisionalTaskEvidence.length, 0,
    `provisional task Memory Evidence must not remain eligible after canonicalization: ${JSON.stringify(provisionalTaskEvidence)}`);
  assert.match(String(bobReady.metadata.taskWorkspaceRoot || '').replace(/\\/g, '/'), /\/data\/task-(?:group-)?workspaces\//);
  assert.equal(String(bobReady.metadata.taskWorkspaceRoot || '').startsWith(roots.bob), true);
  const carolDepartments = carol.db.prepare('SELECT department_id FROM model_executions ORDER BY started_at').all().map((item) => item.department_id);
  assert.equal(carolDepartments.includes('ppt_department'), false, 'Carol data-and-risk assignment was polluted by PPT text from the shared group title');
  const initiatorTaskBeforeSubmit = (await alice.collaborationOverview()).tasks.find((item) => item.id === bobTask.id);
  assert.equal(Boolean(initiatorTaskBeforeSubmit?.metadata?.preliminaryResult), false, 'recipient preliminary result leaked to initiator metadata');
  assert.equal(Boolean(initiatorTaskBeforeSubmit?.metadata?.intakeSummary), false, 'recipient private intake summary leaked to initiator metadata');
  assert.equal(String(initiatorTaskBeforeSubmit?.metadata?.taskWorkspaceRoot || '').startsWith(roots.alice), true, 'requester did not receive its own isolated private workspace');
  assert.equal(String(initiatorTaskBeforeSubmit?.metadata?.taskWorkspaceRoot || '').startsWith(roots.bob), false, 'recipient task workspace path leaked to initiator metadata');
  assert.equal(Boolean(initiatorTaskBeforeSubmit?.metadata?.generatedTaskFiles), false, 'recipient generated files leaked before submission');
  const cloudPrivateMetadata = await pool.query("SELECT metadata_json FROM agent_delegations WHERE id = $1", [bobTask.id]);
  assert.equal(Boolean(cloudPrivateMetadata.rows[0]?.metadata_json?.preliminaryResult), false, 'preliminary result was persisted in shared cloud metadata');
  assert.equal(Boolean(cloudPrivateMetadata.rows[0]?.metadata_json?.taskWorkspaceRoot), false, 'task workspace path was persisted in shared cloud metadata');
  assert.equal(Boolean(cloudPrivateMetadata.rows[0]?.metadata_json?.generatedTaskFiles), false, 'private generated file list was persisted in shared cloud metadata');
  fullChainDiagnostics.finishScenario('passed', { assigneeCount: 2, pptRoutingIsolated: true, cloudPrivateMetadataClean: true });
  fullChainDiagnostics.beginScenario('private_workspace_revision_and_recovery');

  const queuedWorkspaceTurn = await bob.collaborationWorkspaceMessage({
    delegationId: bobTask.id,
    content: '记录一条后台工作区队列验证消息。',
    processedContent: '后台工作区队列已完成。',
    processWithUBuddy: false,
    background: true,
    clientMessageId: 'workspace-background-queue-e2e',
  });
  assert.equal(queuedWorkspaceTurn.queued, true);
  assert.ok(queuedWorkspaceTurn.workId);
  assert.equal(queuedWorkspaceTurn.receipt?.metadata?.delegationId, bobTask.id);
  const completedWorkspaceReceipt = await waitFor(() => {
    const receipt = bob.store.getAgentDeliveryReceiptByWorkId(queuedWorkspaceTurn.workId);
    return receipt && receipt.deliveryStatus === 'completed' ? receipt : null;
  }, 30_000);
  const workspaceDeliveryEvents = bob.store.listAgentDeliveryEvents({ workId: queuedWorkspaceTurn.workId });
  assert.ok(workspaceDeliveryEvents.some((event) => event.kind === 'start'));
  assert.equal(completedWorkspaceReceipt.metadata?.delegationId, bobTask.id);
  const restoredWorkspaceRuns = (await bob.delegationTaskMemory({ delegationId: bobTask.id })).runs;
  assert.equal(restoredWorkspaceRuns.some((run) => run.workId === queuedWorkspaceTurn.workId), false, 'completed workspace runs must not be restored as active');

  const workspace = await bob.collaborationWorkspaceMessage({
    delegationId: bobTask.id,
    content: '请把初稿调整为十页，并增加结论摘要。',
    processedContent: '已将初稿调整为十页结构，并补充结论摘要。',
  });
  assert.equal(workspace.messages.some((item) => item.content.includes('十页')), true);
  let currentMultiAgentFlow = false;
  if (!useRealCodex) {
    const revisedWorkspace = await bob.collaborationWorkspaceMessage({
      delegationId: bobTask.id,
      content: '修改方向：把结论摘要压缩成三点，继续在私有工作区处理。',
      processWithUBuddy: true,
    });
    assert.equal(revisedWorkspace.messages.some((item) => item.role === 'assistant' && String(item.content || '').trim()), true,
      'private workspace revision did not produce an assistant result');
    const teamCoordination = revisedWorkspace.delegation.metadata?.ubuddyTeamCoordination;
    if (teamCoordination) {
      assert.equal(teamCoordination.taskRunId, bobReady.taskRunId);
      assert.ok((teamCoordination.assignedAgentIds || []).length >= 1);
      assert.ok(revisedWorkspace.messages.some((item) => item.metadata?.ubuddyTeamCoordination && item.metadata?.taskRunId === bobReady.taskRunId),
        'private workspace uBuddy did not persist its Skill-based team coordination decision');
    } else {
      currentMultiAgentFlow = true;
      assert.equal(revisedWorkspace.delegation.taskRunId, bobReady.taskRunId,
        'current multi-agent revision must remain bound to the original private task graph');
    }
    const requesterAfterCoordination = (await alice.collaborationOverview()).tasks.find((item) => item.id === bobTask.id);
    assert.equal(Boolean(requesterAfterCoordination?.metadata?.ubuddyTeamCoordination), false,
      'recipient internal Agent coordination leaked to requester delegation metadata');
    const cloudAfterCoordination = await pool.query('SELECT metadata_json FROM agent_delegations WHERE id = $1', [bobTask.id]);
    assert.equal(Boolean(cloudAfterCoordination.rows[0]?.metadata_json?.ubuddyTeamCoordination), false,
      'recipient internal Agent coordination leaked to shared cloud metadata');
    if (teamCoordination) {
      const failedWorkspace = await bob.collaborationWorkspaceMessage({
        delegationId: bobTask.id,
        content: 'FORCE_UBUDDY_WORKSPACE_FAILURE：将风险页改成负责人、截止时间和缓解措施三列。',
        processWithUBuddy: true,
      });
      assert.equal(failedWorkspace.ok, false);
      assert.equal(failedWorkspace.action, 'blocked');
      assert.match(failedWorkspace.error, /任务尚未完成/);
      const blockedWorkspaceTask = (await bob.collaborationOverview()).tasks.find((item) => item.id === bobTask.id);
      assert.equal(blockedWorkspaceTask.status, 'blocked');
      const blockedWorkspaceMessages = await bob.collaborationWorkspaceMessages({ delegationId: bobTask.id });
      assert.equal(blockedWorkspaceMessages.some((item) => item.metadata?.executionFailed), true);
      assert.equal(blockedWorkspaceMessages.some((item) => /Process timed out|\/home\/|codex/i.test(item.content || '')), false);
      const requesterRecoveredTask = (await alice.collaborationOverview()).tasks.find((item) => item.id === bobTask.id);
      assert.equal(Boolean(requesterRecoveredTask?.metadata?.workspaceExecutionError), false);
      const recoveredCloudMetadata = await pool.query('SELECT metadata_json FROM agent_delegations WHERE id = $1', [bobTask.id]);
      assert.equal(Boolean(recoveredCloudMetadata.rows[0]?.metadata_json?.workspaceExecutionError), false);
      const resumedWorkspace = await bob.collaborationWorkspaceMessage({
        delegationId: bobTask.id,
        content: '修改方向：继续完成风险页，按负责人、截止时间和缓解措施三列交付。',
        processWithUBuddy: true,
      });
      assert.equal(resumedWorkspace.delegation.status, 'draft_ready', JSON.stringify({
        ok: resumedWorkspace.ok,
        action: resumedWorkspace.action,
        error: resumedWorkspace.error,
        delegation: resumedWorkspace.delegation,
        task: resumedWorkspace.task,
        modelExecutions: modelExecutions(bob).slice(-5),
      }));
      assert.equal(resumedWorkspace.messages.some((item) => item.content.includes('UBUDDY_REVISION_DRAFT_OK')), true);
    }
  }
  const requesterWorkspace = await alice.collaborationWorkspaceMessages({ delegationId: bobTask.id });
  assert.equal(requesterWorkspace.some((item) => item.content.includes('十页')), false, 'recipient private workspace leaked to requester workspace');
  const sharedBeforeSubmit = await alice.collaborationGroup({ groupId });
  assert.equal(sharedBeforeSubmit.messages.some((item) => item.content.includes('十页')), false, 'private workspace content leaked into group');
  assert.equal(sharedBeforeSubmit.messages.some((item) => item.content.includes('UBUDDY_REVISION_DRAFT_OK')), false, 'private uBuddy revision leaked into group');
  assert.equal(sharedBeforeSubmit.messages.some((item) => item.content.includes('FORCE_UBUDDY_WORKSPACE_FAILURE')), false, 'private recovered revision leaked into group');

  const requesterGeneratedFilesBefore = (await alice.collaborationOverview()).tasks.find((item) => item.id === bobTask.id)?.metadata?.generatedTaskFiles || [];
  const requesterPrivateRevision = await alice.collaborationWorkspaceMessage({
    delegationId: bobTask.id,
    content: '先在我的私有任务会话里把要求整理成三点，暂时不要同步给 Bob。',
    processWithUBuddy: true,
  });
  assert.ok(requesterPrivateRevision.messages.some((item) => item.content.includes('暂时不要同步给 Bob')));
  assert.equal(requesterPrivateRevision.messages.some((item) => item.metadata?.generatedTaskFiles), false, 'ordinary requester requirement organization generated a file');
  assert.deepEqual(requesterPrivateRevision.delegation.metadata?.generatedTaskFiles || [], requesterGeneratedFilesBefore);
  const bobBeforeRequirementPublish = await bob.collaborationWorkspaceMessages({ delegationId: bobTask.id });
  assert.equal(bobBeforeRequirementPublish.some((item) => item.content.includes('暂时不要同步给 Bob')), false, 'requester private workspace leaked before explicit publish');
  assert.equal((await alice.collaborationGroup({ groupId })).messages.some((item) => item.content.includes('暂时不要同步给 Bob')), false, 'requester private draft leaked into group');

  const requesterFileRevision = await alice.collaborationWorkspaceMessage({
    delegationId: bobTask.id,
    content: '请生成一份 Markdown 需求说明文件，作为我自己的私有参考材料。',
    processWithUBuddy: true,
  });
  assert.equal(requesterFileRevision.ok, true, JSON.stringify({
    action: requesterFileRevision.action,
    error: requesterFileRevision.error,
    executionError: requesterFileRevision.delegation?.metadata?.workspaceExecutionError,
    modelExecutions: modelExecutions(alice).slice(-3),
  }));
  const requesterFileGenerated = requesterFileRevision.messages.some((item) => (
    item.metadata?.generatedTaskFiles && item.metadata?.attachments?.some((file) => /\.md$/i.test(file.name || ''))
  ));
  if (!requesterFileGenerated) assert.ok(requesterFileRevision.messages.some((item) => item.role === 'assistant' && String(item.content || '').trim()),
    'explicit requester file request did not produce a private assistant result');
  assert.equal((await alice.collaborationGroup({ groupId })).messages.some((item) => item.content.includes('私有参考材料')), false, 'requester-generated private file leaked before confirmation');

  if (requesterFileGenerated) {
    const requesterStatusBeforeFailure = (await alice.collaborationOverview()).tasks.find((item) => item.id === bobTask.id)?.status;
    const requesterPrivateFailure = await alice.collaborationWorkspaceMessage({
      delegationId: bobTask.id,
      content: 'FORCE_UBUDDY_WORKSPACE_FAILURE：生成一份 Markdown 私有文件，不要改变公共任务状态。',
      processWithUBuddy: true,
    });
    assert.equal(requesterPrivateFailure.ok, false);
    assert.equal(requesterPrivateFailure.action, 'blocked');
    assert.equal(requesterPrivateFailure.delegation.status, requesterStatusBeforeFailure, 'requester private execution failure changed local public task status');
    assert.equal((await bob.collaborationOverview()).tasks.find((item) => item.id === bobTask.id)?.status, requesterStatusBeforeFailure, 'requester private execution failure changed recipient public task status');
    const requesterFailureCloudRow = await pool.query('SELECT status, metadata_json FROM agent_delegations WHERE id = $1', [bobTask.id]);
    assert.equal(requesterFailureCloudRow.rows[0]?.status, requesterStatusBeforeFailure, 'requester private execution failure changed cloud public task status');
    assert.equal(Boolean(requesterFailureCloudRow.rows[0]?.metadata_json?.workspaceExecutionError), false, 'requester private execution error leaked into cloud public metadata');
  }
  fullChainDiagnostics.finishScenario('passed', { recipientRevisionRecovered: true, requesterFailureStayedPrivate: requesterFileGenerated });
  if (currentMultiAgentFlow) {
    await bob.respondAgentDelegation({ delegationId: bobTask.id, action: 'submit', message: bobReady.metadata.preliminaryResult });
    await carol.respondAgentDelegation({ delegationId: carolTask.id, action: 'submit', message: carolReady.metadata.preliminaryResult });
    await alice.collaborationTaskAction({ delegationId: bobTask.id, action: 'accept_result', content: 'Bob 任务验收通过。' });
    await alice.collaborationTaskAction({ delegationId: carolTask.id, action: 'accept_result', content: 'Carol 任务验收通过。' });
    await alice.updateCollaborationGroup({ groupId, action: 'close' });
    diagnosticSummary.checks = ['multi_assignee_group', 'per_assignee_routing_isolation', 'private_workspace', 'result_submission', 'owner_acceptance', 'group_close'];
    diagnosticSummary.finalStatus = 'closed';
    diagnosticSummary.taskCount = created.tasks.length + 1 + (completedRecovery ? 1 : 0);
    diagnosticSummary.revisionCount = 4;
    fullChainDiagnostics.checkpoint('current_multi_agent_chain_complete', {
      finalStatus: diagnosticSummary.finalStatus,
      taskCount: diagnosticSummary.taskCount,
      revisionCount: diagnosticSummary.revisionCount,
    });
    console.log(JSON.stringify({ ok: true, mode: 'current_multi_agent_full_chain', checks: diagnosticSummary.checks }));
    break processingE2E;
  }
  fullChainDiagnostics.beginScenario('requirements_update_and_stale_result_guard');

  const publishedRequirement = '正式更新：流程图必须可编辑，并在结论页列出负责人、截止时间和风险。';
  const filesBeforePublicUpdate = (await bob.collaborationOverview()).tasks.find((item) => item.id === bobTask.id)?.metadata?.generatedTaskFiles || [];
  await alice.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: publishedRequirement, processWithUBuddy: true });
  const publishedByConversation = await alice.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: '提交到任务群' });
  assert.equal(publishedByConversation.action, 'update_requirements');
  const secondPublishedRequirement = '第二条正式更新：结论页必须补充验收标准和风险缓解措施。';
  await alice.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: secondPublishedRequirement, processWithUBuddy: true });
  assert.equal((await alice.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: '确认提交' })).action, 'update_requirements');
  await bob.pollSocialNetwork({ autoProcess: true });
  const updatedTask = await waitFor(async () => (await bob.collaborationOverview()).tasks.find((item) => item.id === bobTask.id && item.status === 'draft_ready'), modelTimeout);
  assert.ok(updatedTask.taskRunId, 'recipient delegation was not bound to its local task graph');
  assert.ok(bob.db.prepare('SELECT id FROM task_graph_revisions WHERE task_run_id = ? AND revision_type = ?').get(updatedTask.taskRunId, 'ubuddy_model_revision'), 'requirements update did not create a task graph revision');
  assert.deepEqual(updatedTask.metadata.generatedTaskFiles || [], filesBeforePublicUpdate, 'public requirement update regenerated recipient files automatically');
  const bobAfterRequirementPublish = await bob.collaborationWorkspaceMessages({ delegationId: bobTask.id });
  assert.ok(bobAfterRequirementPublish.some((item) => item.content.includes(publishedRequirement)), 'explicit requirement update did not reach recipient private workspace');
  assert.ok(bobAfterRequirementPublish.some((item) => item.content.includes(secondPublishedRequirement)), 'second requirement update did not reach recipient private workspace');
  assert.equal(bobAfterRequirementPublish.filter((item) => item.metadata?.type === 'ubuddy_ingress_response' && item.metadata?.responseToSourceEventIds?.length === 2).length, 1, 'recipient uBuddy did not consolidate two public requirement updates into one response');
  assert.ok((await alice.collaborationGroup({ groupId })).messages.some((item) => item.metadata?.action === 'update_requirements' && item.content.includes(publishedRequirement)), 'explicit requirement update did not reach task group');
  fullChainDiagnostics.finishScenario('passed', { requirementUpdates: 2, consolidatedIngressResponses: 1 });
  fullChainDiagnostics.beginScenario('result_submission_and_attachment_roundtrip');

  const staleSubmitAttempt = await bob.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: '提交到任务群' });
  assert.equal(staleSubmitAttempt.action, 'clarification', 'an old result was submitted after public requirements changed');
  const completedAfterRequirements = await bob.collaborationWorkspaceMessage({
    delegationId: bobTask.id,
    content: '修改方向：按任务群里的两条最新要求完成结果，生成可提交版本。',
    processWithUBuddy: true,
  });
  assert.ok(completedAfterRequirements.messages.some((item) => item.role === 'assistant' && String(item.content || '').trim()));
  assert.equal(completedAfterRequirements.delegation.status, 'draft_ready', JSON.stringify({ status: completedAfterRequirements.delegation.status, metadata: completedAfterRequirements.delegation.metadata }));
  await waitFor(async () => (await bob.collaborationOverview()).tasks.find((item) => item.id === bobTask.id && item.status === 'draft_ready'), modelTimeout);
  const submittedByConversation = await bob.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: '就采用你刚刚完成的正确版本，分享给大家' });
  assert.equal(submittedByConversation.action, 'submit');
  const firstSubmitRevision = await pool.query(`SELECT content, metadata_json FROM agent_delegation_revisions WHERE delegation_id = $1 AND action = 'submit' ORDER BY revision_no DESC LIMIT 1`, [bobTask.id]);
  assert.match(firstSubmitRevision.rows[0].content, /UBUDDY_REVISION_DRAFT_OK/);
  assert.doesNotMatch(firstSubmitRevision.rows[0].content, /任务尚未完成|安全草稿|合并草稿|Process timed out/);
  const repeatedSubmit = await bob.collaborationTaskAction({
    delegationId: bobTask.id,
    action: 'submit',
    content: firstSubmitRevision.rows[0].content,
    metadata: firstSubmitRevision.rows[0].metadata_json,
  });
  assert.equal(repeatedSubmit.idempotent, true);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM agent_delegation_revisions WHERE delegation_id = $1 AND action = 'submit'`, [bobTask.id])).rows[0].count), 1);
  const submittedPollExecutionCount = modelExecutions(bob).length;
  await bob.pollSocialNetwork({ autoProcess: true });
  assert.equal(modelExecutions(bob).length, submittedPollExecutionCount, 'submitted task incorrectly triggered another private intake execution');
  await alice.pollSocialNetwork({ autoProcess: false });
  assert.equal((await alice.collaborationOverview()).tasks.find((item) => item.id === bobTask.id).status, 'submitted');
  const submittedGroup = await alice.collaborationGroup({ groupId });
  const submittedFiles = submittedGroup.messages
    .filter((message) => message.metadata?.delegationId === bobTask.id && message.metadata?.action === 'submit')
    .flatMap((message) => message.metadata?.attachments || []);
  diagnosticSummary.fileTransfer.submitted = submittedFiles.length;
  diagnosticSummary.fileTransfer.uploaded = submittedFiles.filter((item) => item.remote_file_id && item.sha256).length;
  assert.ok(submittedFiles.length > 0, 'submitted task result did not carry its generated files');
  assert.equal(submittedFiles.some((item) => item.path || item.source_path || item.sourcePath), false, 'recipient local file path leaked to the task group');
  assert.equal(submittedFiles.every((item) => item.remote_file_id && item.sha256), true, 'submitted task files were not uploaded for cross-user access');
  const submittedFile = submittedFiles.find((item) => /\.md$/i.test(item.filename || item.name || '')) || submittedFiles[0];
  const downloadedByRequester = await alice.collaborationDownloadFile({
    fileId: submittedFile.remote_file_id,
    name: submittedFile.name,
    filename: submittedFile.filename,
    contentType: submittedFile.content_type,
    type: submittedFile.type,
    size: submittedFile.size,
    sha256: submittedFile.sha256,
  });
  assert.ok(downloadedByRequester.path, 'requester did not receive a local copy of the submitted task file');
  assert.ok((await readFile(downloadedByRequester.path)).length > 0, 'downloaded task file is empty');
  diagnosticSummary.fileTransfer.downloadVerified = true;
  fullChainDiagnostics.finishScenario('passed', diagnosticSummary.fileTransfer);
  fullChainDiagnostics.beginScenario('revision_resubmit_and_acceptance');
  await alice.collaborationTaskAction({ delegationId: bobTask.id, action: 'request_revision', content: '修改方向：增加同比数据，并输出第二版。' });
  const overlappingRevisionRefresh = bob.pollSocialNetwork({ autoProcess: false });
  const revisionAutoProcess = bob.pollSocialNetwork({ autoProcess: true });
  const [, revisionPollResult] = await Promise.all([overlappingRevisionRefresh, revisionAutoProcess]);
  assert.notEqual(revisionPollResult?.reason, 'already_running', 'an auto-processing poll must replay after an overlapping refresh');
  await waitFor(async () => (await bob.collaborationOverview()).tasks.find((item) => item.id === bobTask.id && item.status === 'draft_ready'), modelTimeout);
  await bob.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: '请根据修改方向增加同比数据，并输出第二版。', processWithUBuddy: true });
  const bobRevisionReady = await waitFor(async () => (await bob.collaborationOverview()).tasks.find((item) => item.id === bobTask.id && item.status === 'draft_ready'), modelTimeout);
  assert.ok(bobRevisionReady.metadata.preliminaryResult?.trim());
  if (!useRealCodex) assert.match(bobRevisionReady.metadata.preliminaryResult, /UBUDDY_REVISION_DRAFT_OK/);
  assert.equal((await bob.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: '确认提交' })).action, 'submit');
  await alice.collaborationTaskAction({ delegationId: bobTask.id, action: 'accept_result', content: '验收通过。' });
  assert.equal((await alice.collaborationOverview()).tasks.find((item) => item.id === bobTask.id).status, 'result_accepted');
  fullChainDiagnostics.finishScenario('passed', { revisionRequested: true, resubmitted: true, accepted: true });
  fullChainDiagnostics.beginScenario('public_mentions_and_summary');

  const mentionMessage = await alice.sendCollaborationMessage({
    groupId,
    content: '@Bob的uBuddy 当前任务进展如何？',
    metadata: { mentions: [{ principalType: 'ubuddy', ownerUserId: bobId, displayText: '@Bob的uBuddy', mentionId: 'mention_bob_group', source: 'picker' }] },
  });
  const mentionId = mentionMessage.messages.at(-1).id;
  await bob.pollSocialNetwork({ autoProcess: false });
  const afterMention = await alice.collaborationGroup({ groupId });
  const publicReply = afterMention.messages.find((item) => item.metadata?.inReplyTo === mentionId);
  assert.ok(publicReply, 'mentioned uBuddy did not provide a public-context status reply');
  assert.equal(publicReply.metadata.publicContextOnly, true);
  assert.match(publicReply.content, /正式结果或承诺仍会由用户确认/);

  const ownMentionMessage = await alice.sendCollaborationMessage({
    groupId,
    content: '@我的uBuddy 请根据当前群聊总结尚未完成的事项。',
    metadata: { mentions: [{ principalType: 'ubuddy', ownerUserId: aliceId, displayText: '@我的uBuddy', mentionId: 'mention_alice_group', source: 'picker' }] },
  });
  const ownMentionId = ownMentionMessage.messages.at(-1).id;
  await alice.pollSocialNetwork({ autoProcess: false });
  const afterOwnMention = await alice.collaborationGroup({ groupId });
  const ownPublicReply = afterOwnMention.messages.find((item) => item.metadata?.inReplyTo === ownMentionId && item.senderAgentId === 'secretary_agent');
  assert.ok(ownPublicReply, 'own uBuddy did not reply to its owner in the group');
  assert.equal(ownPublicReply.metadata.publicContextOnly, true);
  assert.match(ownPublicReply.content, /正式结果或承诺仍会由用户确认/);
  fullChainDiagnostics.finishScenario('passed', { publicReplies: 2, publicContextOnly: true });
  fullChainDiagnostics.beginScenario('membership_cutoff_and_group_close');

  const beforeRemoval = await carol.collaborationGroup({ groupId });
  await alice.updateCollaborationGroup({ groupId, action: 'remove_member', userId: carolId });
  const privateGroupSummary = await alice.prepareCollaborationGroupSummary({ groupId });
  assert.equal(privateGroupSummary.summaryType, 'final');
  assert.equal(privateGroupSummary.readyToPublish, true);
  assert.equal((await alice.collaborationGroup({ groupId })).messages.some((item) => item.metadata?.candidateMessageId === privateGroupSummary.candidateMessageId), false, 'private cross-team summary leaked before owner confirmation');
  await alice.publishCollaborationGroupSummary({ groupId, candidateMessageId: privateGroupSummary.candidateMessageId });
  await alice.publishCollaborationGroupSummary({ groupId, candidateMessageId: privateGroupSummary.candidateMessageId });
  assert.equal((await alice.collaborationGroup({ groupId })).messages.filter((item) => item.metadata?.type === 'collaboration_group_summary').length, 1, 'cross-team summary publication was not idempotent');
  await alice.sendCollaborationMessage({ groupId, content: 'CAROL_REMOVAL_SECRET：移除后新增的消息。' });
  const carolHistorical = await carol.collaborationGroup({ groupId });
  assert.ok(carolHistorical.messages.length >= beforeRemoval.messages.length);
  assert.equal(carolHistorical.messages.some((item) => item.content.includes('CAROL_REMOVAL_SECRET')), false, 'removed member read future messages');
  await assert.rejects(() => carol.sendCollaborationMessage({ groupId, content: '不应发送成功' }), /不在群内|not found|已不在群内/i);
  await assert.rejects(
    () => carol.collaborationDownloadFile({ fileId: submittedFile.remote_file_id, filename: submittedFile.filename, sha256: submittedFile.sha256 }),
    /下载失败|forbidden|无权/i,
  );

  await assert.rejects(() => bob.updateCollaborationGroup({ groupId, action: 'close' }), /发起人|owner/i);
  await alice.updateCollaborationGroup({ groupId, action: 'close' });
  const closed = await alice.collaborationGroup({ groupId });
  assert.equal(closed.group.status, 'closed');
  assert.equal(closed.tasks.every((item) => item.status === 'closed'), true);
  await assert.rejects(
    () => alice.sendCollaborationMessage({ groupId, content: '关闭后不应发送' }),
    /已解散|closed|不存在|不在群内/i,
  );
  await assert.rejects(() => bob.collaborationWorkspaceMessage({ delegationId: bobTask.id, content: '关闭后不应继续修改' }), /只读|已经结束/i);
  await assert.rejects(() => bob.startAgentDelegation({ delegationId: bobTask.id, execute: true }), /不允许继续启动处理/i);

  const directConversation = alice.socialConversation({ peerId: bobId });
  assert.equal(directConversation.some((item) => item.content.includes('BOB_RESULT_V2')), false, 'group result leaked into direct conversation');
  const revisionRows = await pool.query('SELECT action, content FROM agent_delegation_revisions WHERE delegation_id = $1 ORDER BY revision_no', [bobTask.id]);
  assert.deepEqual(revisionRows.rows.map((row) => row.action), ['update_requirements', 'update_requirements', 'submit', 'request_revision', 'submit', 'accept_result']);
  fullChainDiagnostics.finishScenario('passed', { removedMemberCutoff: true, finalGroupStatus: closed.group.status, revisionCount: revisionRows.rowCount });
  fullChainDiagnostics.beginScenario('restart_persistence');

  const persistedWorkspace = await bob.collaborationWorkspaceMessages({ delegationId: bobTask.id });
  assert.equal(persistedWorkspace.some((item) => item.content.includes('十页')), true);

  bob.close();
  bob = await createRuntime({ root: roots.bob, isDev: true });
  assert.equal(bob.currentUser()?.id, bobId, 'recipient login/session did not restore after restart');
  const restartedWorkspace = await bob.collaborationWorkspaceMessages({ delegationId: bobTask.id });
  assert.equal(restartedWorkspace.some((item) => item.content.includes('十页')), true, 'private task workspace did not persist across restart');
  fullChainDiagnostics.finishScenario('passed', { sessionRestored: true, privateWorkspaceRestored: true });

  const executions = {
    alice: modelExecutions(alice),
    bob: modelExecutions(bob),
    carol: modelExecutions(carol),
  };
  if (useRealCodex) {
    for (const [name, rows] of Object.entries(executions)) {
      assert.ok(rows.length > 0, `${name} has no real model execution record`);
      assert.equal(rows.some((item) => item.status === 'failed'), false, `${name} has failed model executions`);
      assert.ok(rows.some((item) => item.status === 'completed' && item.provider_id && item.effective_model),
        `${name} has no completed model execution with provider and model evidence`);
    }
  }

  const finalChecks = [
    'bidirectional_direct_chat_isolated', 'numeric_account_dispatch', 'initiator_outgoing_visible', 'recipient_incoming_visible',
    'private_direct_dispatch', 'multi_assignee_group', 'automatic_preliminary_result',
    'per_assignee_routing_isolation',
    'private_workspace', 'submit_revision_resubmit_accept', 'mentioned_ubuddy_public_reply',
    'cross_user_task_attachment_download', 'removed_member_attachment_cutoff',
    'removed_member_cutoff', 'owner_only_close', 'persistent_workspace', 'real_model_execution_trace',
    'private_cross_team_summary_confirmation',
    ...(!useRealCodex ? ['private_workspace_failure_not_marked_complete'] : []),
    ...(completedRecovery ? ['specialized_execution_full_takeover'] : []),
    ...(failedRecovery ? ['double_failure_not_marked_draft_ready'] : []),
  ];
  diagnosticSummary.checks = finalChecks;
  diagnosticSummary.finalStatus = closed.group.status;
  diagnosticSummary.taskCount = created.tasks.length + 1 + (completedRecovery ? 1 : 0) + (failedRecovery ? 1 : 0);
  diagnosticSummary.revisionCount = revisionRows.rowCount;
  fullChainDiagnostics.checkpoint('full_chain_complete', {
    finalStatus: diagnosticSummary.finalStatus,
    taskCount: diagnosticSummary.taskCount,
    revisionCount: diagnosticSummary.revisionCount,
  });

  console.log(JSON.stringify({
    ok: true,
    codexMode: useRealCodex ? 'real' : 'fake',
    codexVersion: useRealCodex ? String(execFileSync(realCodexBin, ['--version'], { encoding: 'utf8' })).trim() : 'codex-cli ubuddy-full-chain',
    actors: ['alice', 'bob', 'carol'],
    tasks: diagnosticSummary.taskCount,
    revisions: diagnosticSummary.revisionCount,
    finalStatus: diagnosticSummary.finalStatus,
    modelExecutions: Object.fromEntries(Object.entries(executions).map(([name, rows]) => [name, {
      total: rows.length,
      statusCounts: rows.reduce((counts, item) => ({ ...counts, [item.status]: Number(counts[item.status] || 0) + 1 }), {}),
      models: [...new Set(rows.map((item) => item.effective_model).filter(Boolean))],
    }])),
    checks: finalChecks,
  }));
} catch (error) {
  chainError = error;
  throw error;
} finally {
  let reportError = null;
  try {
    const snapshot = await collectUBuddyFullChainSnapshot({ runtimes: { alice, bob, carol }, pool });
    await fullChainDiagnostics.writeReport({
      status: chainError ? 'failed' : 'passed',
      error: chainError,
      summary: { ...diagnosticSummary, snapshot },
    });
  } catch (error) {
    reportError = error;
    console.error(`Unable to write uBuddy full-chain diagnostics: ${error?.message || error}`);
  } finally {
    fullChainDiagnostics.close();
  }
  await alice?.close();
  await bob?.close();
  await carol?.close();
  if (cloudServer) await new Promise((resolve) => cloudServer.close(resolve));
  if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
  await pool.end();
  if (process.env.JANUS_KEEP_UBUDDY_E2E_TEMP !== '1') await rm(tempRoot, { recursive: true, force: true });
  if (previousAuthUrl === undefined) delete process.env.JANUS_AUTH_URL; else process.env.JANUS_AUTH_URL = previousAuthUrl;
  if (previousCodexBin === undefined) delete process.env.JANUS_CODEX_BIN; else process.env.JANUS_CODEX_BIN = previousCodexBin;
  if (previousModelRefresh === undefined) delete process.env.JANUS_MODEL_REFRESH_ENABLED; else process.env.JANUS_MODEL_REFRESH_ENABLED = previousModelRefresh;
  if (previousProcessingMode === undefined) delete process.env.JANUS_UBUDDY_PROCESSING_MODE; else process.env.JANUS_UBUDDY_PROCESSING_MODE = previousProcessingMode;
  if (previousTaskPptRender === undefined) delete process.env.JANUS_DISABLE_TASK_PPT_RENDER; else process.env.JANUS_DISABLE_TASK_PPT_RENDER = previousTaskPptRender;
  if (previousIntakeFlag === undefined) delete process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
  else process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = previousIntakeFlag;
  if (previousStructuredReferenceFlag === undefined) delete process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
  else process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = previousStructuredReferenceFlag;
  if (previousAutoRoutingFlag === undefined) delete process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
  else process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = previousAutoRoutingFlag;
  if (previousBoundedReviewFlag === undefined) delete process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
  else process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = previousBoundedReviewFlag;
  if (!chainError && reportError) throw reportError;
}

async function seedRealCodexConfig(runtimeRoot) {
  const target = path.join(runtimeRoot, 'config', 'codex');
  await mkdir(target, { recursive: true });
  await copyFile(path.join(realCodexHome, 'config.toml'), path.join(target, 'config.toml'));
  await copyFile(path.join(realCodexHome, 'auth.json'), path.join(target, 'auth.json'));
}

async function createAuthorizedGroup(runtime,{title='',assignments=[]}={}){
  const mentions=assignments.map((item,index)=>({
    principalType:'user',userId:item.recipientId,displayText:`@recipient${index+1}`,
    mentionId:`ubuddy-full-chain-recipient-${index+1}`,source:'picker',
  }));
  const content=assignments.map((item,index)=>`${mentions[index].displayText} ${item.instruction}`).join('\n');
  const dispatched=await runtime.dispatchCollaborationCommand({
    content:title?`${title}\n${content}`:content,
    sourcePeerId:assignments[0]?.recipientId||'',
    sourceConversationId:`direct:${runtime.currentUser().id}:${assignments[0]?.recipientId||''}`,
    sourceMessageId:`ubuddy-full-chain:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    mentions,
  });
  assert.equal(dispatched.dispatched,true);
  return dispatched.result;
}

function assertDraftWasProcessed(task, { useRealCodex: real = false } = {}) {
  assert.ok(task?.metadata?.preliminaryResult?.trim(), 'uBuddy preliminary result is empty');
  assert.ok(['model', 'trusted_dispatch'].includes(task.metadata.intakeProcessingMode),
    `uBuddy intake used an unexpected mode: ${task.metadata.intakeProcessingMode}`);
  if (real) {
    assert.doesNotMatch(task.metadata.preliminaryResult, /UBUDDY_(?:INITIAL|REVISION)_DRAFT_OK/);
    assert.doesNotMatch(task.metadata.preliminaryResult, /这是由 uBuddy 根据当前委托自动整理的初步结果/);
  } else {
    assert.match(task.metadata.preliminaryResult,
      /UBUDDY_(?:(?:INITIAL|REVISION)_DRAFT_OK|RECOVERED_COMPLETE_OK)|已创建部门协作任务|交付文件：[^\n]*\.pptx|季度汇报 PPT 已完成/);
  }
}

function modelExecutions(runtime) {
  return runtime.db.prepare(`SELECT id,status,execution_kind,provider_id,codex_thread_id,effective_model,error_text
    FROM model_executions ORDER BY started_at`).all();
}

async function register(runtime, email, displayName) {
  await runtime.authSendEmailCode({ email, purpose: 'register', method: 'email' });
  const code = codes.get(`${email.toLowerCase()}:register`);
  assert.match(code, /^\d{6}$/);
  return runtime.authRegister({ email, displayName, password: 'ubuddy-test-password', code });
}

async function addFriend(requester, recipient, email) {
  const target = (await requester.friendSearch({ query: email }))[0];
  await requester.friendSendRequest({ userId: target.id, message: 'uBuddy full-chain test' });
  await recipient.pollSocialNetwork({ autoProcess: false });
  const incomingItems = (await recipient.friendsOverview()).requests.incoming;
  const incoming = incomingItems.find((item) => item.user.id === requester.currentUser().id) || incomingItems[0];
  assert.ok(incoming, `friend request for ${email} did not arrive`);
  await recipient.friendAcceptRequest({ requestId: incoming.id });
  await requester.friendsOverview();
}

function listen(serverOrApp) {
  return new Promise((resolve, reject) => {
    if (typeof serverOrApp.address !== 'function') {
      const server = serverOrApp.listen(0, '127.0.0.1', () => resolve(server));
      server.once('error', reject);
      return;
    }
    const server = serverOrApp;
    server.once('error', reject);
    if (server.listening) resolve(server);
    else server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitFor(callback, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('Timed out waiting for uBuddy chain state.');
}

async function waitForTaskStatus(runtime, taskId, expectedStatus, timeoutMs) {
  let latest = null;
  try {
    return await waitFor(async () => {
      latest = (await runtime.collaborationOverview()).tasks.find((item) => item.id === taskId) || null;
      if (latest?.status === expectedStatus) return latest;
      if (expectedStatus === 'draft_ready'
        && String(latest?.metadata?.preliminaryResult || '').trim()
        && ['completed', 'awaiting_delivery'].includes(String(
          latest?.metadata?.agentWorkStatusProjection?.status
          || latest?.metadata?.executionProgress?.phase
          || '',
        ))) return latest;
      return null;
    }, timeoutMs);
  } catch (error) {
    const attempts = runtime.store.listTaskRuns({ limit: 100 })
      .map((item) => runtime.store.getTaskRun(item.id))
      .filter((item) => item?.metadata?.delegationId === taskId)
      .map((item) => ({
        id: item.id,
        status: item.status,
        deliveryValidationState: item.metadata?.deliveryValidationState || '',
        deliveryValidationCode: item.metadata?.deliveryValidationCode || '',
        deliveryValidationSummary: item.metadata?.deliveryValidationSummary || '',
        nodes: item.nodes.map((node) => ({ id: node.id, title: node.title, status: node.status, error: node.errorText || '' })),
      }));
    throw new Error(`Timed out waiting for task ${taskId} to become ${expectedStatus}; latest=${JSON.stringify(latest)}; attempts=${JSON.stringify(attempts)}`, { cause: error });
  }
}
