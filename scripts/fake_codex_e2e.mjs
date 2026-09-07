import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runCodexExec } from '../src/main/codex.js';
import { createEvolutionAuthority } from '../src/cloud/modules/evolution/index.js';
import { openCloudDatabase } from '../src/cloud/server.js';
import { createRuntime, enrichPptChatContext } from '../src/main/runtime.js';
import {
  closeApplicationLogging,
  flushApplicationLogs,
  initializeApplicationLogging,
} from '../src/shared/logging/index.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'janus-fake-codex-'));
const binTmp = await mkdtemp(path.join(os.tmpdir(), 'janus-fake-codex-bin-'));
const fakeCodex = path.join(binTmp, 'fake-codex.mjs');
const fakeCodexCmd = path.join(binTmp, 'fake-codex.cmd');
const fakeLog = path.join(binTmp, 'fake-codex.log');
const applicationLogDir = path.join(tmp, 'application-logs');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousLog = process.env.FAKE_CODEX_LOG;
const previousUBuddyProcessingMode = process.env.JANUS_UBUDDY_PROCESSING_MODE;
const previousIntakeFlag = process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
const previousStructuredReferenceFlag = process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
const previousAutoRoutingFlag = process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
const previousBoundedReviewFlag = process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
const previousCodexPrimaryFlag = process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;

initializeApplicationLogging({
  directory: applicationLogDir,
  appVersion: 'fake-e2e',
  releaseChannel: 'test',
  processType: 'fake-codex-e2e',
  level: 'debug',
});

const explicitScutContext = enrichPptChatContext(
  { type: 'ppt', templateId: 'scut', templateLabel: '华工模板', templateSelection: 'explicit' },
  { template: 'hitsz', template_label: '哈工深模板' },
);
assert.equal(explicitScutContext.templateId, 'scut', 'the current explicit template must override the previous deck template');
assert.equal(explicitScutContext.templateInherited, false);
const inheritedHitszContext = enrichPptChatContext(
  { type: 'ppt' },
  { template: 'hitsz', template_label: '哈工深模板' },
);
assert.equal(inheritedHitszContext.templateId, 'hitsz', 'previous template inheritance should remain available when the turn has no selection');
assert.equal(inheritedHitszContext.templateInherited, true);

await writeFile(fakeCodex, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const codeXHome = process.env.CODEX_HOME || '';
const logInvocation = (stdin, response, request = {}) => {
  if (!process.env.FAKE_CODEX_LOG) return;
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
    args,
    requestedModel: request.model || '',
    requestedReasoningEffort: request.effort || '',
    codeXHome,
    homeHasAuth: Boolean(codeXHome && fs.existsSync(codeXHome + '/auth.json')),
    homeHasConfig: Boolean(codeXHome && fs.existsSync(codeXHome + '/config.toml')),
    homeAgentFiles: codeXHome && fs.existsSync(codeXHome + '/agents') ? fs.readdirSync(codeXHome + '/agents').sort() : [],
    cwd: process.cwd(),
    isAttachmentRetrieval: stdin.includes('selecting only the attachments relevant to your assigned task node'),
    hasSelectedResearchAttachment: stdin.includes('Attachments selected for this node:') && stdin.includes('research_notes.txt'),
    hasUnrelatedBudgetAttachment: stdin.includes('Attachments selected for this node:') && stdin.includes('unrelated_budget.csv'),
    hasCompressedTerminalResults: stdin.includes('Compressed terminal results for final synthesis:\\n###'),
    hasSelectedGeneralDepartment: stdin.includes('Selected department:\\ngeneral'),
    hasManagedArtifactOutput: stdin.includes('Janus-managed artifact delivery directory for this conversation: outputs/'),
    usesOfficialHarness: stdin.includes('official Codex subagent workflow'),
    isDirectAgentChat: stdin.includes('<janus_direct_agent_chat>'),
    isSelfEvolutionProposer: stdin.includes('self-evolution proposer'),
    isTaskNodeExecution: stdin.includes('executing one node in an Janus complex task graph'),
    hasUBuddyWorkspaceFixture: stdin.includes('中国清朝皇帝名单'),
    hasResumeFixture: stdin.includes('resume fake codex'),
    hasCollaborationFixture: stdin.includes('collaboration fake fixture'),
    isHrDebate: stdin.includes('participating in an HR governance review for') && stdin.includes('ppt_department'),
    hasExternalFileBoundary: stdin.includes('If the user explicitly requests an external file'),
    isPrivateAssistant: stdin.includes("You are the user's isolated private assistant inside Janus."),
    privateMultiAgentDisabled: Boolean(codeXHome && fs.existsSync(codeXHome + '/config.toml') && fs.readFileSync(codeXHome + '/config.toml', 'utf8').includes('multi_agent = false')),
    privateWebSearchDisabled: Boolean(codeXHome && fs.existsSync(codeXHome + '/config.toml') && fs.readFileSync(codeXHome + '/config.toml', 'utf8').includes('web_search = false')),
    privateSandboxNetworkDisabled: Boolean(codeXHome && fs.existsSync(codeXHome + '/config.toml') && fs.readFileSync(codeXHome + '/config.toml', 'utf8').includes('network_access = false')),
    isBuddyEvaluator: stdin.includes("independent evaluator for the uBuddy agent's ordinary Skill and Memory self-evolution proposal"),
    isCloudEvolution: stdin.includes('Algorithm: personal_cloud_authority_v1') || stdin.includes('Review this private personal Agent evolution Proposal.'),
    responseSnippet: response.slice(0, 120).replace(/\\s+/g, ' '),
    stdinIncludesPrompt: stdin.length > 0,
    stdinSnippet: stdin.slice(0, 900).replace(/\\s+/g, ' '),
  }) + '\\n');
};
const continuousPlanningResponse = (prompt) => {
  const candidates = JSON.parse(prompt.match(/Authorized local Agent candidates: (\\[[^\\n]+\\])/)?.[1] || '[]');
  const allowedAgentInstanceIds = JSON.parse(prompt.match(/Allowed Agent instance IDs: (\\[[^\\n]+\\])/)?.[1] || '[]');
  const requestedAgentId = prompt.includes('PPTAgent') ? 'ppt' : 'general_agent';
  const candidate = candidates.find((item) => item.agentId === requestedAgentId)
    || candidates[0]
    || (allowedAgentInstanceIds[0] ? { agentId: requestedAgentId, agentInstanceId: allowedAgentInstanceIds[0] } : null);
  const objective = requestedAgentId === 'ppt'
    ? '让 PPTAgent 返回用户要求的问候语'
    : '让通用 Agent 整理并核对中国清朝皇帝名单';
  return JSON.stringify({
    version: 'UBUDDY_PLANNING_DECISION_V1', decision: 'ready_for_dispatch', confidence: 0.96, answer: '',
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready', taskKind: 'general', workReportSpec: null,
      objective, deliverables: ['直接回答'], acceptanceCriteria: [], constraints: [], deadline: '',
      candidateUsers: [], requiredUsers: [], attachments: [], privacyScope: 'owner_private', riskLevel: 'low',
      missingFields: [], clarifications: [],
      executionPlan: { summary: objective, steps: [objective], requiredInputs: [] },
      knownFacts: [], safeAssumptions: [], criticalUnknowns: [], readiness: { status: 'ready', reason: '' },
    },
    target: {
      kind: 'local_agent', candidateUserIds: [], requiredUserIds: [], selectedUserIds: [],
      selectedAgentInstanceIds: candidate?.agentInstanceId ? [candidate.agentInstanceId] : [],
    },
    collaboration: {
      mode: 'manager_delegation', initiatorParticipation: 'coordinator_only',
      participantSelectionIntent: 'all', assignmentIntent: 'auto',
    },
    assignments: candidate?.agentInstanceId ? [{
      assignmentId: 'final', assigneeKind: 'agent', userId: '', agentInstanceId: candidate.agentInstanceId,
      title: requestedAgentId === 'ppt' ? 'PPT Agent 消息交付' : '清朝皇帝名单',
      objective, deliverables: ['直接回答'], dependencies: [],
    }] : [],
    clarifications: [],
    readiness: { status: 'ready', reason: '', knownFacts: [], safeAssumptions: [], criticalUnknowns: [] },
    riskLevel: 'low', rationale: '根据用户目标选择已授权的本地 Agent。',
  });
};
if (args.includes('--version')) {
  console.log('codex-cli fake-e2e');
  process.exit(0);
}
if (args[0] === 'app-server' && args.includes('--help')) {
  console.log('Usage: codex app-server [OPTIONS]\\n\\nOptions:\\n  --listen <URL>');
  process.exit(0);
}
if (args[0] === 'doctor') {
  console.log(JSON.stringify({ overallStatus: 'pass', codexVersion: 'fake-e2e', checks: { installation: { status: 'pass', summary: 'fake' } } }));
  process.exit(0);
}

if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let slowTurnActive = false;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method || message.id == null) continue;
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'fake-e2e-app-server' } });
    } else if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'fake-e2e-thread' } } });
    } else if (message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: message.params?.threadId || 'fake-e2e-thread' } } });
    } else if (message.method === 'turn/interrupt') {
      send({ id: message.id, result: {} });
      if (slowTurnActive) {
        slowTurnActive = false;
        send({ method: 'turn/completed', params: { turn: { id: 'fake-e2e-turn', status: 'interrupted', items: [] } } });
      }
    } else if (message.method === 'turn/start') {
      const prompt = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
      const response = prompt.includes('【UBUDDY_CONTINUOUS_PLANNING_V1】') || prompt.includes('【UBUDDY_CONTINUOUS_PLANNING_REPAIR_V1】')
        ? continuousPlanningResponse(prompt)
        : prompt.includes('uBuddy FIFO hello fixture')
          ? '你好'
          : prompt.includes('【UBUDDY_DELEGATION_PROCESSING_V1】')
            ? JSON.stringify({ title: '完善后的测试委托', content: '任务目标：整理本周进展。\\n交付要求：输出关键成果、风险和下一步计划。' })
            : 'JANUS_FAKE_OK';
      let generatedImagePath = '';
      if (prompt.includes('image generation artifact fixture') && codeXHome) {
        const generatedImageDir = codeXHome + '/generated_images';
        fs.mkdirSync(generatedImageDir, { recursive: true });
        generatedImagePath = generatedImageDir + '/fake-agent-image.png';
        fs.writeFileSync(generatedImagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4VQAAAAASUVORK5CYII=', 'base64'));
      }
      logInvocation(prompt, response, message.params || {});
      send({ id: message.id, result: { turn: { id: 'fake-e2e-turn' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-e2e-thread', turn: { id: 'fake-e2e-turn', status: 'inProgress' } } });
      if (prompt.includes('slow cancellation fixture')) {
        send({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'fake-e2e-slow-reasoning', summaryIndex: 0, delta: '已进入可取消的长时间处理。' } });
        process.on('SIGTERM', () => {});
        const stubbornChild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),15000);setInterval(()=>{},1000)"], { stdio: 'ignore' });
        stubbornChild.unref();
        continue;
      }
      if (prompt.includes('PPT FIFO blocker fixture')) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      send({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'fake-e2e-reasoning', summaryIndex: 0, delta: '已检查请求上下文，正在确认执行路径。' } });
      send({ method: 'item/reasoning/textDelta', params: { itemId: 'fake-e2e-reasoning', contentIndex: 0, delta: '正在逐项核对真实协议事件。' } });
      send({ method: 'item/completed', params: { item: { id: 'fake-e2e-reasoning', type: 'reasoning', summary: ['已检查请求上下文，正在确认执行路径。'], content: ['正在逐项核对真实协议事件。'] } } });
      if (prompt.includes('slow cancellation fixture')) {
        slowTurnActive = true;
        continue;
      }
      send({ method: 'item/completed', params: { item: { id: 'fake-e2e-commentary', type: 'agentMessage', phase: 'commentary', text: '正在运行必要的本地检查。' } } });
      send({ method: 'item/started', params: { startedAtMs: 1000, item: { id: 'fake-e2e-command', type: 'commandExecution', command: 'rg -n fake fixture', cwd: '/home/private/Janus-main', status: 'inProgress' } } });
      send({ method: 'item/commandExecution/outputDelta', params: { itemId: 'fake-e2e-command', delta: 'API_KEY=secret\\n' } });
      send({ method: 'item/commandExecution/outputDelta', params: { itemId: 'fake-e2e-command', delta: 'fake fixture found\\n' } });
      send({ method: 'item/completed', params: { completedAtMs: 1125, item: { id: 'fake-e2e-command', type: 'commandExecution', command: 'rg -n fake fixture', cwd: '/home/private/Janus-main', processId: 'pty-1', source: 'agent', commandActions: [{ type: 'search', command: 'rg -n fake fixture', query: 'fake fixture', path: '.' }], aggregatedOutput: 'API_KEY=secret\\nfake fixture found\\n', exitCode: 0, durationMs: 125, status: 'completed' } } });
      send({ method: 'item/fileChange/patchUpdated', params: { itemId: 'fake-e2e-file', changes: [{ path: '/home/private/Janus-main/src/demo.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\\n-old\\n+new' }] } });
      send({ method: 'item/completed', params: { item: { id: 'fake-e2e-file', type: 'fileChange', status: 'completed', changes: [{ path: '/home/private/Janus-main/src/demo.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\\n-old\\n+new' }] } } });
      send({ method: 'item/started', params: { item: { id: 'fake-e2e-tool', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'inProgress', arguments: { query: 'Codex details' } } } });
      send({ method: 'item/mcpToolCall/progress', params: { itemId: 'fake-e2e-tool', message: '正在检索原生 Codex 资料。' } });
      send({ method: 'item/completed', params: { item: { id: 'fake-e2e-tool', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { query: 'Codex details' }, result: { content: [{ type: 'text', text: 'native transcript' }], structuredContent: { hits: 1 }, _meta: { source: 'fixture' } }, durationMs: 80 } } });
      send({ method: 'item/completed', params: { item: { id: 'fake-e2e-agent', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'fake-e2e-thread', receiverThreadIds: ['child-thread'], prompt: '核对 UI 细节', model: 'fake-model', reasoningEffort: 'high', agentsStates: { 'child-thread': { status: 'completed', message: '完成' } } } } });
      if (generatedImagePath) send({ method: 'item/completed', params: { item: { id: 'fake-e2e-image', type: 'imageGeneration', savedPath: generatedImagePath, status: 'completed' } } });
      send({ method: 'warning', params: { threadId: 'fake-e2e-thread', message: 'fixture warning detail' } });
      send({ method: 'item/started', params: { item: { id: 'fake-e2e-answer', type: 'agentMessage', phase: 'final_answer' } } });
      send({ method: 'item/completed', params: { item: { id: 'fake-e2e-answer', type: 'agentMessage', phase: 'final_answer', text: response } } });
      send({ method: 'turn/completed', params: {
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        turn: { id: 'fake-e2e-turn', status: 'completed', items: [{ id: 'fake-e2e-answer', type: 'agentMessage', phase: 'final_answer', text: response }] },
      } });
    } else {
      send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
    }
  }
  process.exit(0);
}

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';

let response = 'JANUS_FAKE_OK';
if (stdin.includes('【UBUDDY_CONTINUOUS_PLANNING_V1】') || stdin.includes('【UBUDDY_CONTINUOUS_PLANNING_REPAIR_V1】')) {
  response = continuousPlanningResponse(stdin);
} else if (stdin.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
  const objective = stdin.includes('PPTAgent') ? '让 PPTAgent 返回用户要求的问候语' : '让通用 Agent 整理并核对中国清朝皇帝名单';
  response = JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: false,
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready', objective, deliverables: ['直接回答'],
      acceptanceCriteria: [], constraints: [], deadline: '', candidateUsers: [], requiredUsers: [], attachments: [],
      privacyScope: 'owner_private', riskLevel: 'low', missingFields: [],
      clarification: { reasonCode: '', question: '', options: [] },
    },
  });
} else if (stdin.includes('【UBUDDY_TURN_DECISION_V2】')) {
  const candidates = JSON.parse(stdin.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
  const requestedAgentId = stdin.includes('PPTAgent') ? 'ppt' : 'general_agent';
  const candidate = candidates.find((item) => item.agentId === requestedAgentId);
  response = JSON.stringify({
    version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.96,
    nodes: [{
      localId: 'final', title: requestedAgentId === 'ppt' ? 'PPT Agent 消息交付' : '清朝皇帝名单',
      objective: requestedAgentId === 'ppt' ? '返回用户要求的问候语' : '整理并核对中国清朝皇帝名单',
      agentId: requestedAgentId, agentInstanceId: candidate?.agentInstanceId,
      dependencies: [], outputFormat: 'text', isFinal: true, blocking: true,
      fallback: '说明无法完成的原因和下一步。',
    }],
    deliverables: [{ id: 'primary', role: 'primary', type: 'answer', title: '任务结果', ownerLocalId: 'final', deliveryMode: 'inline' }],
    agentSelectionRationale: '根据用户目标和有效 Skill 选择对应 Agent。', mentionedAgentsNotSelected: [],
  });
} else if (stdin.includes('uBuddy FIFO hello fixture')) {
  response = '你好';
} else if (stdin.includes('selecting only the attachments relevant to your assigned task node')) {
  const selected = stdin.match(/Attachment id: ([^\\n]+)\\nFilename: research_notes\\.txt/)?.[1] || '';
  response = JSON.stringify({ selected_ids: selected ? [selected] : [], rationale: 'research notes match the task evidence needs' });
} else if (stdin.includes('Return JSON only with summary, overlay_text, memory_operations, eval_cases, and risks.')) {
  response = JSON.stringify({
    summary: 'Improve runtime reliability.',
    overlay_text: 'Add runtime guardrails, explicit failure handling, and verification before delivery.',
    memory_operations: [],
    eval_cases: [{ input: 'Complete a failed task.', expected: 'Verify the result before delivery.' }],
    risks: ['Avoid overfitting to one failure.']
  });
} else if (stdin.includes('Review this private personal Agent evolution Proposal.')) {
  response = JSON.stringify({ decision: 'full', rationale: 'The change is narrow and evidence-backed.', risks: [] });
} else if (stdin.includes('Use only the supplied Skill and Memory to answer the evaluation.')) {
  response = 'Verify the result before delivery.';
} else if (stdin.includes('Compare outputs for the same hidden evaluation.')) {
  response = JSON.stringify({ winner: 'tie', before_score: 1, after_score: 1, rationale: 'No regression.' });
} else if (stdin.includes('【UBUDDY_DELEGATION_PROCESSING_V1】')
  && !stdin.includes('self-evolution')
  && !stdin.includes('HR governance review')
  && !stdin.includes('department HR reviewing')
  && !stdin.includes('You are the HR agent')) {
  response = JSON.stringify({ title: '完善后的测试委托', content: '任务目标：整理本周进展。\\n交付要求：输出关键成果、风险和下一步计划。' });
} else if (stdin.includes('Selected agent:\\nuBuddy (secretary_agent)') || stdin.includes('Do you know uBuddy')) {
  response = '我是你的 uBuddy，是你在 Janus 中的私人任务助手。';
} else if (stdin.includes('Compare two outputs for the same hidden regression task')) {
  response = JSON.stringify({ winner: 'after', before_score: 0.6, after_score: 0.8, rationale: 'after variant preserves the artifact contract' });
} else if (stdin.includes('blocking communication fixture')) {
  response = [
    'Partial result: I need research confirmation before this node can finish.',
    '',
    '## Agent communication request',
    '- request_to: secretary_agent',
    '- purpose: Confirm the missing source evidence for the blocking communication fixture.',
    '- required_information: Return a concise evidence confirmation that can unblock the task node.',
    '- priority: high',
    '- blocking: true',
    '- expected_format: two bullet points with source confidence',
    '- context_summary: The current task node cannot complete until the secretary confirms the evidence.'
  ].join('\\n');
} else if (stdin.includes('department HR reviewing an Janus agent self-evolution proposal')) {
  if (stdin.includes('reject HR gate fixture')) {
    response = JSON.stringify({
      decision: 'reject',
      rationale: 'The proposal overfits a single marked fixture and should not alter durable skill or memory.',
      required_revision: 'Wait for repeated real evidence and remove fixture-specific assumptions.',
      risks: ['overfitting', 'memory pollution']
    });
  } else if (stdin.includes('partial HR gate fixture')) {
    response = JSON.stringify({
      decision: 'partial',
      rationale: 'Artifact QA is reasonable, but the proposal needs revision before any durable write.',
      required_revision: 'Keep only the artifact verification step and remove unsupported broad workflow claims.',
      risks: ['scope creep']
    });
  } else {
  response = JSON.stringify({
    decision: 'full',
    rationale: 'The proposal is narrow, diagnosis-aligned, keeps ownership inside the current agent, and avoids private memory pollution.',
    required_revision: '',
    risks: ['small QA overhead']
  });
  }
} else if (stdin.includes('Revise an Janus agent self-evolution proposal after') && stdin.includes('marked it partially applicable')) {
  response = [
    '## Summary',
    'Revised proposal keeps only the artifact verification step. Unsupported broad workflow claims removed after HR revision.',
    '## Proposed memory replacement',
    'no-op',
    '## Proposed memory patch',
    '- Workflow Notes: Verify exported PPTX artifact exists before the final response after HR revision.',
    '## Proposed skill patch',
    'Add to **Output Standards**:',
    '- Verify generated PPTX artifacts exist after HR revision before final delivery.',
    '## Eval cases',
    '- Input: User asks for a PPTX artifact. Expected: The agent verifies the exported PPTX exists after HR revision before final delivery.',
    '## HR notes',
    'No structural change; HR revision narrowed this to existing artifact QA responsibility.',
    '## Risks',
    'Small QA overhead; avoids broad or unsupported process changes.'
  ].join('\\n');
} else if (stdin.includes('self-evolution proposer')) {
  const marker = stdin.includes('reject HR gate fixture')
    ? 'reject HR gate fixture'
    : stdin.includes('partial HR gate fixture')
      ? 'partial HR gate fixture'
      : '';
  response = [
    '## Summary',
    'Recent evidence shows a repeated PPT artifact delivery gap' + (marker ? ' for ' + marker : '') + ', so the agent should add a narrow artifact verification step.',
    '## Proposed memory replacement',
    'no-op',
    '## Proposed memory patch',
    '- Workflow Notes: Verify exported PPTX artifact exists before the final response.',
    '## Proposed skill patch',
    'Add to **Output Standards**:',
    '- Verify generated PPTX artifacts exist and can be opened before final delivery.',
    '## Eval cases',
    '- Input: User asks for a PPTX artifact. Expected: The agent verifies the exported PPTX exists before final delivery.',
    '## HR notes',
    'No structural change; this is a narrow artifact contract improvement.',
    '## Risks',
    'Adds a small QA step but avoids claiming missing files were delivered.'
  ].join('\\n');
} else if (stdin.includes('Return a markdown HR review')) {
  response = [
    '## Department summary',
    'The PPT department should keep the current roster and reinforce artifact QA in the existing leader agent.',
    '## Debate transcript',
    '- HR: Current evidence supports skill and memory QA only.',
    '- ppt agent: The artifact verification update stays inside the existing role.',
    '- project manager: No split, merge, retirement, or recruitment is justified yet.',
    '## Agent roster recommendation',
    'Keep current agents; no split, merge, retirement, or recruitment.',
    '## Structural change decisions',
    '{"actions":[{"type":"no_change","status":"approved","evidence_count":5,"confidence":0.8,"evidence_summary":"Current evidence supports skill/memory QA only.","votes":[],"memory_migration_plan":"No migration needed."}]}',
    '## Proposed new agents',
    'None.',
    '## Proposed merges or retirements',
    'None.',
    '## Skill and memory review',
    'The leader agent artifact contract update is appropriate and narrow.',
    '## Eval cases',
    '- Input: PPT artifact delivery gap. Expected: keep change inside existing PPT leader QA.',
    '## HR memory replacement',
    'no-op',
    '## HR memory patch',
    'no-op',
    '## Memory migration plan',
    'No migration required.',
    '## Risks',
    'Avoid overreacting to limited evidence by creating new agents.'
  ].join('\\n');
} else if (stdin.includes('participating in an HR governance review')) {
  response = 'No structural change. Keep the update inside existing skill and memory governance until more evidence accumulates.';
}

let generatedImagePath = '';
if (stdin.includes('image generation artifact fixture') && codeXHome) {
  const generatedImageDir = codeXHome + '/generated_images';
  fs.mkdirSync(generatedImageDir, { recursive: true });
  generatedImagePath = generatedImageDir + '/fake-agent-image.png';
  fs.writeFileSync(generatedImagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4VQAAAAASUVORK5CYII=', 'base64'));
}

if (outputPath) fs.writeFileSync(outputPath, response, 'utf8');
logInvocation(stdin, response);

if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread-123' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'fake-commentary', type: 'agent_message', phase: 'commentary', text: '正在运行必要的本地检查。' } }));
  console.log(JSON.stringify({ type: 'item.started', item: { id: 'fake-command', type: 'command_execution', command: 'rg -n fake fixture', status: 'in_progress' } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'fake-command', type: 'command_execution', command: 'rg -n fake fixture', cwd: '/home/private/Janus-main', aggregated_output: 'API_KEY=secret\\nfake fixture found\\n', exit_code: 0, duration_ms: 125, status: 'completed' } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'fake-reasoning', type: 'reasoning', text: '已检查请求上下文并准备最终回答。' } }));
  if (generatedImagePath) console.log(JSON.stringify({ type: 'item.completed', item: { id: 'fake-image', type: 'image_generation', savedPath: generatedImagePath, status: 'completed' } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'fake-answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
process.exit(0);
`);
chmodSync(fakeCodex, 0o755);
if (process.platform === 'win32') {
  await writeFile(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "${fakeCodex}" %*\r\n`);
}

process.env.JANUS_CODEX_BIN = process.platform === 'win32' ? fakeCodexCmd : fakeCodex;
process.env.FAKE_CODEX_LOG = fakeLog;
delete process.env.JANUS_UBUDDY_PROCESSING_MODE;
process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'off';
process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = 'off';
process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'off';
process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = 'off';
process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1 = 'off';
const fakeProvider = createServer((request, response) => {
  if (request.url === '/v1/models' && request.headers.authorization === 'Bearer sk-fake-e2e') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"data":[{"id":"gpt-5.6-sol"}]}');
    return;
  }
  if (request.url === '/v1/responses' && request.method === 'POST'
    && request.headers.authorization === 'Bearer sk-fake-e2e') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"id":"fake-provider-health-response","status":"completed","output":[]}');
    return;
  }
  response.writeHead(401, { 'content-type': 'application/json' });
  response.end('{"error":"unauthorized"}');
});
await new Promise((resolve, reject) => {
  fakeProvider.once('error', reject);
  fakeProvider.listen(0, '127.0.0.1', resolve);
});
const fakeProviderPort = fakeProvider.address().port;

try {
  const agentDeliveryUpdates = [];
  const runtime = await createRuntime({
    root: path.join(tmp, 'workspace'),
    isDev: true,
    serverAuthoritativeSkills: true,
    onAgentDeliveryUpdated: (payload) => agentDeliveryUpdates.push(payload),
  });
  runtime.store.recruitUserAgent({
    userId: runtime.currentUser().id,
    agentFamilyId: 'ppt',
    commandId: 'fake-codex-e2e:recruit-ppt',
  });
  runtime.saveCodexConfig({
    baseUrl: `http://127.0.0.1:${fakeProviderPort}/v1`,
    apiKey: 'sk-fake-e2e',
    model: 'gpt-5.6-sol',
    reviewModel: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
  });
  const doctor = await runtime.doctor();
  assert.equal(doctor.available, true, JSON.stringify(doctor));
  assert.equal(doctor.overallStatus, 'pass', JSON.stringify(doctor));

  const privateUserId = runtime.currentUser().id;
  const employeeQuotaBeforePrivate = runtime.store.getEmployeeQuota({ userId: privateUserId });
  const privateStatusBefore = runtime.privateAssistantStatus();
  assert.equal(privateStatusBefore.quotaExempt, true);
  assert.equal(privateStatusBefore.weeklyTokensUsed, 0);
  const privateSession = runtime.ensurePrivateAssistantSession();
  assert.equal(privateSession.departmentId, 'private_assistant');
  assert.equal(privateSession.agentId, 'private_assistant');
  assert.equal(privateSession.agentInstanceId, '');
  const privateChat = await runtime.sendChat({
    sessionId: privateSession.id,
    chatMode: 'private_assistant',
    message: '这是只属于私人助理的测试消息。',
  });
  assert.equal(privateChat.answer, 'JANUS_FAKE_OK');
  assert.equal(privateChat.session.id, privateSession.id);
  assert.equal(privateChat.privateAssistantUsage.lastTurnTokens, 15);
  assert.equal(privateChat.privateAssistantUsage.weeklyTokensUsed, 15);
  assert.deepEqual(runtime.store.getEmployeeQuota({ userId: privateUserId }), employeeQuotaBeforePrivate, 'private assistant must not consume employee quota');
  assert.equal(runtime.store.listMessages(privateSession.id).length, 2);
  const privateExecution = runtime.store.listModelExecutionsForConversation(privateSession.id)[0];
  assert.equal(privateExecution.departmentId, 'private_assistant');
  assert.equal(privateExecution.agentInstanceId, '');
  assert.equal(privateExecution.metadata.localOnly, true);
  const privateCodexLog = readFileSync(fakeLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).findLast((item) => item.isPrivateAssistant);
  assert.ok(privateCodexLog, 'private assistant Codex execution was not observed');
  assert.equal(privateCodexLog.usesOfficialHarness, false, 'private assistant must not spawn an Agent harness');
  assert.equal(privateCodexLog.privateMultiAgentDisabled, true);
  assert.equal(privateCodexLog.privateWebSearchDisabled, true);
  assert.equal(privateCodexLog.privateSandboxNetworkDisabled, true);
  assert.ok(String(privateCodexLog.cwd).includes(path.join('data', 'private_assistant')), privateCodexLog.cwd);

  const processedDelegation = await runtime.processAgentDelegationContent({
    phase: 'create',
    content: '帮我整理本周进展',
  });
  assert.equal(processedDelegation.mode, 'model', JSON.stringify(processedDelegation.diagnostics || processedDelegation.warning || processedDelegation));
  assert.equal(processedDelegation.title, '完善后的测试委托');
  assert.match(processedDelegation.content, /关键成果、风险和下一步计划/);
  assert.equal(runtime.db.prepare("SELECT count(*) count FROM messages WHERE content LIKE '%UBUDDY_DELEGATION_PROCESSING_V1%'").get().count, 0);

  const uBuddyWorkspaceRoot = path.join(tmp, 'ubuddy-project-workspace');
  await mkdir(uBuddyWorkspaceRoot, { recursive: true });
  const uBuddyProject = runtime.createProject({
    title: 'uBuddy project workspace',
    workspaceRoot: uBuddyWorkspaceRoot,
  });
  const uBuddySession = runtime.ensureSecretarySession();
  assert.equal(runtime.store.listMessages(uBuddySession.id).length, 0, 'uBuddy session should start empty without a persisted welcome message');
  const reopenedUBuddySession = runtime.ensureSecretarySession({ title: '旧设计中的新委托标题' });
  assert.equal(reopenedUBuddySession.id, uBuddySession.id, 'uBuddy must reopen its single writable primary conversation');
  assert.equal(reopenedUBuddySession.title, 'uBuddy');
  assert.equal(runtime.store.listSessions({ user: runtime.auth.currentUser() }).filter((item) => item.departmentId === 'secretary_department' && item.writeState !== 'read_only').length, 1);
  const legacyUBuddyWorkspace = path.join(tmp, 'data', 'task-workspaces', 'legacy-ubuddy-history');
  runtime.db.prepare(`INSERT INTO sessions (
    id,user_id,title,department_id,agent_id,agent_instance_id,workspace_root,conversation_role,write_state,superseded_by_session_id
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'legacy_ubuddy_history', runtime.auth.currentUser().id, '旧版 uBuddy 会话', 'secretary_department', 'secretary_agent',
    uBuddySession.agentInstanceId || '', legacyUBuddyWorkspace, 'history', 'read_only', uBuddySession.id,
  );
  const bootWithLegacyUBuddy = await runtime.bootstrap();
  const bootLegacyUBuddy = bootWithLegacyUBuddy.sessions.find((item) => item.id === 'legacy_ubuddy_history');
  assert.equal(bootLegacyUBuddy, undefined, 'bootstrap must hide internal uBuddy history from the primary conversation list');
  const storedLegacyUBuddy = runtime.store.getSession('legacy_ubuddy_history');
  assert.equal(storedLegacyUBuddy?.readOnly, true, 'the internal uBuddy history row must remain preserved as read-only');
  assert.equal(storedLegacyUBuddy?.workspaceRoot, legacyUBuddyWorkspace, 'bootstrap must not rewrite a historical uBuddy workspace');
  assert.equal(runtime.store.listMessages('legacy_ubuddy_history').length, 0, 'bootstrap must not seed messages into historical uBuddy sessions');
  const redirectedLegacyUBuddy = runtime.ensureSecretarySession({ sessionId: 'legacy_ubuddy_history' });
  assert.equal(redirectedLegacyUBuddy.id, uBuddySession.id, 'opening a read-only uBuddy history must redirect to the writable primary conversation');
  const legacyUBuddySearch = runtime.searchSessions({ query: '旧版 uBuddy 会话' });
  assert.equal(legacyUBuddySearch.find((item) => item.id === 'legacy_ubuddy_history')?.readOnly, true, 'read-only uBuddy history must remain searchable');
  const uBuddyIdentity = await runtime.secretaryChat({
    sessionId: 'legacy_ubuddy_history',
    message: 'who are you',
  });
  assert.equal(uBuddyIdentity.uBuddyMode, 'control');
  assert.equal(uBuddyIdentity.session.id, uBuddySession.id);
  assert.equal(uBuddyIdentity.workerSession, null);
  assert.match(uBuddyIdentity.answer, /uBuddy/);
  assert.equal(runtime.store.listMessages(uBuddySession.id).length, 2, 'direct uBuddy chat must not duplicate user or assistant messages');
  const uBuddyFollowUp = await runtime.secretaryChat({
    sessionId: uBuddySession.id,
    message: 'Do you know uBuddy',
  });
  assert.equal(uBuddyFollowUp.uBuddyMode, 'control');
  assert.match(uBuddyFollowUp.answer, /uBuddy/);
  assert.equal(runtime.store.listMessages(uBuddySession.id).length, 4, 'uBuddy follow-up should stay in the same conversation');
  const uBuddyEnglishGreeting = await runtime.secretaryChat({
    sessionId: uBuddySession.id,
    message: 'hello',
  });
  assert.equal(uBuddyEnglishGreeting.uBuddyMode, 'control');
  assert.equal(uBuddyEnglishGreeting.workerSession, null);
  assert.match(uBuddyEnglishGreeting.answer, /^Hi!/);
  assert.equal(uBuddyEnglishGreeting.message.metadata.controlLanguage, 'en');
  const uBuddyChineseGreeting = await runtime.secretaryChat({
    sessionId: uBuddySession.id,
    message: '你好',
  });
  assert.equal(uBuddyChineseGreeting.uBuddyMode, 'control');
  assert.equal(uBuddyChineseGreeting.workerSession, null);
  assert.match(uBuddyChineseGreeting.answer, /^你好/);
  assert.equal(uBuddyChineseGreeting.message.metadata.controlLanguage, 'zh-CN');
  assert.equal(runtime.store.listTaskRuns({ userId: runtime.auth.currentUser().id, limit: 100 }).length, 0, 'a lightweight uBuddy greeting must not create a task graph');
  assert.equal(runtime.store.listMessages(uBuddySession.id).length, 8, 'each lightweight uBuddy greeting should add only one user and one assistant message');
  const uBuddyGeneralTask = await runtime.secretaryChat({
    sessionId: uBuddySession.id,
    projectId: uBuddyProject.id,
    workspaceRoot: uBuddyProject.workspaceRoot,
    message: '告诉通用Agent，让它整理一份中国清朝皇帝名单，然后交给我。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(uBuddyGeneralTask.uBuddyMode), JSON.stringify({
    uBuddyMode: uBuddyGeneralTask.uBuddyMode,
    errorCode: uBuddyGeneralTask.errorCode || '',
    answer: uBuddyGeneralTask.answer || '',
    metadata: uBuddyGeneralTask.message?.metadata || {},
  }));
  const uBuddyGeneralPublished = uBuddyGeneralTask;
  assert.ok(uBuddyGeneralPublished.taskRunId);
  assert.equal(runtime.store.getSession(uBuddySession.id).projectId, uBuddyProject.id);
  assert.equal(runtime.store.getSession(uBuddySession.id).workspaceRoot, uBuddyProject.workspaceRoot);
  try {
    await waitForCondition(() => ['completed', 'failed', 'cancelled'].includes(runtime.store.getTaskRun(uBuddyGeneralPublished.taskRunId)?.status || ''));
  } catch (error) {
    throw new Error(`${error.message} ${JSON.stringify({
      task: runtime.store.getTaskRun(uBuddyGeneralPublished.taskRunId),
      queue: runtime.store.listAgentWorkQueue({ statuses: ['queued', 'running', 'completed', 'failed'] }),
    })}`);
  }
  assert.equal(runtime.store.getTaskRun(uBuddyGeneralPublished.taskRunId)?.status, 'completed');
  assert.ok(runtime.store.listTaskRuns({ userId: runtime.currentUser().id }).length >= 1, 'formal single-Agent delivery must create a task graph');
  assert.equal(runtime.store.listMessages(uBuddySession.id).length, 11, 'uBuddy should add the request, dispatch acknowledgement, and completion notification');

  const pptContext = runtime.store.requireRoutableUserAgent({ userId: runtime.currentUser().id, agentFamilyId: 'ppt' });
  const pptBlocker = runtime.sendChat({
    departmentId: 'ppt_department',
    agentId: 'ppt',
    agentInstanceId: pptContext.instance.id,
    routePreference: 'explicit',
    message: 'PPT FIFO blocker fixture',
  });
  await waitForCondition(() => runtime.store.listAgentWorkQueue({ agentInstanceId: pptContext.instance.id, statuses: ['running'] }).length === 1);
  const taskCountBeforePptDelivery = runtime.store.listTaskRuns({ userId: runtime.currentUser().id }).length;
  const uBuddyRoutedTask = await runtime.secretaryChat({
    sessionId: uBuddySession.id,
    message: '告诉我的PPTAgent，让它跟我说“uBuddy FIFO hello fixture”。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(uBuddyRoutedTask.uBuddyMode));
  const uBuddyRoutedPublished = uBuddyRoutedTask;
  assert.ok(uBuddyRoutedPublished.taskRunId);
  assert.equal(uBuddyRoutedTask.session.id, uBuddySession.id);
  assert.equal(runtime.store.getUBuddyCoordinationState(uBuddyRoutedPublished.taskRunId)?.state, 'waiting_for_agents');
  assert.equal(runtime.store.listTaskRuns({ userId: runtime.currentUser().id }).length, taskCountBeforePptDelivery + 1,
    'a busy PPT Agent must create a persisted waiting task instead of a FIFO delivery');
  await pptBlocker;
  await waitForCondition(() => runtime.store.getUBuddyCoordinationState(uBuddyRoutedPublished.taskRunId)?.state === 'sleeping');
  assert.equal(runtime.cancelTaskRun({ taskRunId: uBuddyRoutedPublished.taskRunId })?.status, 'cancelled');
  assert.equal(runtime.store.listAgentWorkReservations({ taskRunId: uBuddyRoutedPublished.taskRunId, statuses: ['active'] }).length, 0);
  const pptPrimarySession = runtime.store.getPrimaryAgentSession({ userId: runtime.currentUser().id, agentInstanceId: pptContext.instance.id });
  assert.ok(pptPrimarySession);
  assert.equal(runtime.store.getSession(uBuddySession.id).codexThreadId, '', 'out-of-band routed results should reset the direct uBuddy backend thread');
  const pptPrimaryMessageCount = runtime.store.listMessages(pptPrimarySession.id).length;
  const chat = await runtime.sendChat({
    departmentId: 'ppt_department',
    agentId: 'ppt',
    message: 'ping fake codex',
  });
  assert.equal(chat.answer, 'JANUS_FAKE_OK');
  assert.equal(chat.threadId, 'fake-e2e-thread');
  assert.equal(runtime.listMessages(chat.session.id).length, pptPrimaryMessageCount + 2, 'direct chat must create the writable employee session independently from uBuddy internal task nodes');
  assert.ok(chat.message.metadata.processEvents.some((event) => event.activityType === 'reasoning' && event.detail.includes('检查请求上下文')));
  assert.ok(chat.message.metadata.processEvents.some((event) => event.activityType === 'commentary' && event.detail.includes('本地检查')),
    JSON.stringify(chat.message.metadata.processEvents));
  const completedCommandEvent = chat.message.metadata.processEvents.find((event) => event.activityType === 'command' && event.status === 'completed');
  assert.ok(completedCommandEvent);
  assert.equal(completedCommandEvent.command, 'rg -n fake fixture');
  assert.equal(completedCommandEvent.cwd, '/home/private/Janus-main');
  assert.match(completedCommandEvent.output, /API_KEY=secret/);
  assert.match(completedCommandEvent.output, /fake fixture found/);
  assert.equal(completedCommandEvent.exitCode, 0);
  assert.equal(completedCommandEvent.durationMs, 125);
  assert.equal(completedCommandEvent.processId, 'pty-1');
  assert.equal(completedCommandEvent.commandActions[0].type, 'search');
  assert.ok(completedCommandEvent.protocolEvents.some((event) => event.method === 'item/commandExecution/outputDelta'));
  const reasoningEvent = chat.message.metadata.processEvents.find((event) => event.activityId === 'fake-e2e-reasoning');
  assert.match(reasoningEvent.reasoningText, /真实协议事件/);
  assert.ok(reasoningEvent.protocolEvents.some((event) => event.method === 'item/reasoning/textDelta'));
  const fileEvent = chat.message.metadata.processEvents.find((event) => event.activityType === 'file');
  assert.match(fileEvent.changes[0].path, /src\/demo\.js$/);
  assert.match(fileEvent.diff, /\+new/);
  const toolEvent = chat.message.metadata.processEvents.find((event) => event.activityType === 'tool');
  assert.deepEqual(toolEvent.arguments, { query: 'Codex details' });
  assert.equal(toolEvent.result.structuredContent.hits, 1);
  const agentEvent = chat.message.metadata.processEvents.find((event) => event.activityType === 'agent');
  assert.equal(agentEvent.prompt, '核对 UI 细节');
  assert.deepEqual(agentEvent.receiverThreadIds, ['child-thread']);
  assert.ok(chat.message.metadata.processEvents.some((event) => event.activityType === 'warning' && /fixture warning/.test(event.detail)));

  const resumedChat = await runtime.sendChat({
    sessionId: chat.session.id,
    departmentId: 'ppt_department',
    agentId: 'ppt',
    message: 'resume fake codex',
  });
  assert.equal(resumedChat.answer, 'JANUS_FAKE_OK');
  assert.equal(resumedChat.threadId, 'fake-e2e-thread');
  assert.equal(runtime.listMessages(chat.session.id).length, pptPrimaryMessageCount + 4);

  const routedProject = runtime.store.createProject({
    title: 'Cross-route project context',
    workspaceRoot: path.join(tmp, 'project-workspace'),
    userId: runtime.currentUser().id,
  });
  await mkdir(routedProject.workspaceRoot, { recursive: true });
  const plainChat = await runtime.sendChat({
    chatMode: 'normal',
    message: 'plain fake codex chat',
    projectId: routedProject.id,
    workspaceRoot: routedProject.workspaceRoot,
    model: 'gpt-5.6-terra',
    reasoningEffort: 'ultra',
  });
  assert.equal(plainChat.answer, 'JANUS_FAKE_OK');
  assert.equal(plainChat.session.departmentId, 'general');
  assert.equal(plainChat.session.projectId, routedProject.id);
  assert.equal(plainChat.session.agentId, 'general_agent');
  const plainExecutions = runtime.store.listModelExecutionsForConversation(plainChat.session.id);
  const plainExecution = plainExecutions.at(-1);
  assert.ok(plainExecutions.length >= 1, 'the general Agent primary session may contain earlier uBuddy-routed executions');
  assert.equal(plainExecution.effectiveModel, 'gpt-5.6-terra');
  assert.equal(plainExecution.reasoningEffort, 'ultra');
  assert.equal(plainExecution.projectId, routedProject.id);
  assert.equal(plainExecution.responseMessageId, plainChat.message.id);

  const imageArtifactChat = await runtime.sendChat({
    chatMode: 'normal',
    message: 'image generation artifact fixture',
    projectId: routedProject.id,
    workspaceRoot: routedProject.workspaceRoot,
  });
  assert.equal(imageArtifactChat.artifacts.length, 1);
  assert.equal(imageArtifactChat.artifacts[0].kind, 'image');
  assert.ok(existsSync(imageArtifactChat.artifacts[0].path));
  const imageArtifactOutput = path.join(routedProject.workspaceRoot, 'outputs', imageArtifactChat.session.id);
  assert.equal(path.dirname(realpathSync(imageArtifactChat.artifacts[0].path)), realpathSync(imageArtifactOutput));
  assert.equal(imageArtifactChat.artifacts[0].workspace_relative_path, `outputs/${imageArtifactChat.session.id}/fake-agent-image.png`);
  assert.equal(imageArtifactChat.artifacts[0].relative_path, `${imageArtifactChat.session.id}/fake-agent-image.png`);
  assert.ok(runtime.store.listMessages(imageArtifactChat.session.id).some((item) => item.metadata?.codexImageGeneration === true));

  const autoAgentEvents = [];
  const autoAgentChat = await runtime.sendChat({
    chatMode: 'normal',
    routePreference: 'auto',
    message: '帮我写一篇多智能体系统论文的摘要和提纲。',
    onEvent: (event) => autoAgentEvents.push(event),
  });
  assert.equal(autoAgentChat.session.departmentId, 'general');
  assert.equal(autoAgentChat.session.agentId, 'general_agent');
  assert.ok(autoAgentEvents.some((event) => event.kind === 'plan' && event.plan?.mode === 'agent'));
  assert.ok(autoAgentEvents.some((event) => event.kind === 'progress' && event.planStep === 'execute'));
  assert.ok(autoAgentEvents.some((event) => event.kind === 'activity' && event.activityType === 'reasoning'));

  const researchAttachment = runtime.uploadFile({
    filename: 'research_notes.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('SELECTIVE_RESEARCH_EVIDENCE: multi-agent context sharing should use direct dependencies and evidence references.').toString('base64'),
  });
  const unrelatedAttachment = runtime.uploadFile({
    filename: 'unrelated_budget.csv',
    contentType: 'text/csv',
    dataBase64: Buffer.from('item,cost\ncoffee,10\n').toString('base64'),
  });
  const collaborationEvents = [];
  const collaborationChat = await runtime.sendChat({
    chatMode: 'collaboration',
    message: 'collaboration fake fixture: 请跨部门完成论文写作和 PPT 汇报计划。',
    projectId: routedProject.id,
    workspaceRoot: routedProject.workspaceRoot,
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
    attachments: [researchAttachment, unrelatedAttachment],
    onEvent: (event) => collaborationEvents.push(event),
  });
  assert.equal(collaborationChat.session.departmentId, 'collaboration');
  assert.equal(collaborationChat.session.projectId, routedProject.id);
  assert.ok(collaborationChat.task?.id);
  assert.equal(collaborationChat.task.status, 'completed');
  assert.ok(collaborationChat.task.participants.length >= 1);
  const fullCollaborationTask = runtime.store.getTaskRun(collaborationChat.task.id);
  assert.equal(fullCollaborationTask.metadata.attachmentCatalog.length, 2);
  assert.ok(fullCollaborationTask.metadata.globalTaskSummary.includes('collaboration fake fixture'));
  assert.ok(!fullCollaborationTask.prompt.includes('SELECTIVE_RESEARCH_EVIDENCE'), 'attachment body must not be concatenated into the global task prompt');
  assert.ok(fullCollaborationTask.nodes.filter((node) => node.status === 'completed').every((node) => node.resultSummary));
  assert.ok(fullCollaborationTask.nodes.some((node) => node.evidenceRefs.some((ref) => ref.type === 'attachment' && ref.label.includes('research_notes.txt'))));
  assert.ok(collaborationChat.answer.includes('部门协作任务已完成'));
  assert.ok(collaborationEvents.some((event) => event.kind === 'plan' && event.plan?.mode === 'collaboration'));
  assert.ok(collaborationEvents.some((event) => event.kind === 'progress' && /任务图谱/.test(String(event.message || ''))));
  assert.ok(collaborationEvents.some((event) => event.kind === 'progress' && event.taskProgress?.total >= 1));
  const liveTaskEvents = collaborationEvents.filter((event) => event.kind === 'task-progress');
  assert.ok(liveTaskEvents.some((event) => event.taskRunId === collaborationChat.task.id && event.objective?.summary), 'live collaboration progress must expose its task id and confirmed objective');
  assert.ok(liveTaskEvents.some((event) => event.changedNodes?.some((node) => node.status === 'running')), 'live collaboration progress must report running nodes');
  assert.ok(liveTaskEvents.some((event) => event.changedNodes?.some((node) => node.status === 'completed')), 'live collaboration progress must report completed nodes');
  assert.ok(liveTaskEvents.every((event) => !JSON.stringify(event).includes('resultText')), 'public collaboration progress must not expose raw node results');
  assert.ok(runtime.store.listMessages(collaborationChat.session.id).some((message) => message.metadata?.collaboration?.taskRunId === collaborationChat.task.id));
  const collaborationExecutions = runtime.store.listModelExecutionsForTask(collaborationChat.task.id);
  assert.ok(collaborationExecutions.length > 0);
  assert.ok(collaborationExecutions.every((item) => item.conversationId === collaborationChat.session.id));
  assert.ok(collaborationExecutions.every((item) => item.projectId === routedProject.id));
  assert.ok(collaborationExecutions.every((item) => item.effectiveModel === 'gpt-5.6-luna'));
  assert.ok(collaborationExecutions.every((item) => item.reasoningEffort === 'max'));
  assert.ok(collaborationExecutions.every((item) => item.agentId && item.departmentId && item.taskNodeId));
  assert.ok(collaborationExecutions.every((item) => item.metadata?.codexRuntime?.executionBackend));
  assert.ok(collaborationExecutions.every((item) => item.metadata?.codexRuntime?.platform === process.platform));
  assert.ok(collaborationExecutions.every((item) => item.metadata?.codexRuntime?.sandbox));
  const collaborationDelivery = runtime.store.listMessages(collaborationChat.session.id)
    .find((message) => message.metadata?.collaboration?.taskRunId === collaborationChat.task.id);
  assert.deepEqual(collaborationDelivery.metadata.collaboration.contributingExecutionIds.sort(), collaborationExecutions.map((item) => item.id).sort());

  const cancelEvents = [];
  const slowChat = runtime.sendChat({
    sessionId: chat.session.id,
    departmentId: 'ppt_department',
    agentId: 'ppt',
    message: 'slow cancellation fixture',
    onEvent: (event) => cancelEvents.push(event),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const startEvent = cancelEvents.find((event) => event.kind === 'start');
  assert.ok(startEvent?.runId, 'cancel fixture should emit a start event with runId');
  const cancelStartedAt = Date.now();
  const cancelResult = await runtime.cancelChat({ runId: startEvent.runId });
  assert.equal(cancelResult.ok, true);
  assert.equal(cancelResult.settled, true);
  const cancelledChat = await slowChat;
  assert.ok(Date.now() - cancelStartedAt < 5_000, 'stubborn Codex cancellation must settle within five seconds');
  assert.equal(cancelledChat.cancelled, true);
  assert.ok(cancelledChat.message?.metadata?.processEvents?.some((event) => event.activityType === 'reasoning'),
    'cancelled turns must persist the planning/reasoning history');
  assert.equal(cancelledChat.message?.metadata?.processEvents?.at(-1)?.status, 'cancelled');
  assert.equal(cancelledChat.message?.contextSpaceId, chat.message.contextSpaceId,
    'cancelled process history must remain in the conversation context space');
  assert.ok(cancelEvents.some((event) => event.kind === 'cancelled'));
  assert.equal(runtime.activeRuns.size, 0);
  const postCancelChat = await runtime.sendChat({
    sessionId: cancelledChat.session.id,
    departmentId: 'ppt_department',
    agentId: 'ppt',
    message: 'post cancellation fixture',
  });
  assert.equal(postCancelChat.answer, 'JANUS_FAKE_OK', 'the same conversation must accept a new message after cancellation');

  const blockingTask = runtime.scheduler.createTaskRun({
    title: 'blocking communication fixture',
    prompt: 'Run an academic blocking communication fixture task.',
    departmentId: 'general',
    userId: runtime.currentUser().id,
    metadata: { accountWorkspaceId: 'workspace_personal' },
  });
  const waitingTask = await runtime.scheduler.runReadyNodes(blockingTask.id, { maxParallel: 1 });
  const waitingNode = waitingTask.nodes.find((node) => node.status === 'waiting');
  assert.equal(waitingNode.status, 'waiting');
  assert.ok(waitingNode.waitReason.includes('evidence confirmation'));
  const blockingComm = waitingTask.communications.find((item) => item.blocking && item.fromAgentId === waitingNode.agentId && item.toAgentId === 'secretary_agent');
  assert.ok(blockingComm);
  assert.equal(blockingComm.references[0].taskNodeId, waitingNode.id);
  assert.ok(!waitingTask.communications.some((item) => item.status === 'notified'));
  const resumedTaskComm = runtime.scheduler.resolveCommunication(blockingComm.id, {
    responseText: 'Evidence confirmation ready.',
    responderId: 'secretary_agent',
  });
  assert.equal(resumedTaskComm.status, 'resolved');
  const resumedNode = runtime.store.getTaskNode(waitingNode.id);
  assert.equal(resumedNode.status, 'ready');
  assert.equal(resumedNode.waitReason, '');

  const retryTask = runtime.scheduler.createTaskRun({
    title: 'failed node retry fixture',
    prompt: 'Execute a general task and produce a retrospective.',
    departmentId: 'general',
    userId: runtime.currentUser().id,
    metadata: { accountWorkspaceId: 'workspace_personal' },
  });
  const retryNode = retryTask.nodes.find((node) => node.status === 'ready');
  const retryDownstream = retryTask.nodes.find((node) => node.id !== retryNode.id);
  runtime.store.updateTaskNode(retryNode.id, {
    status: 'failed',
    errorText: 'simulated temporary cleanup failure',
    completedAt: new Date().toISOString(),
  });
  runtime.scheduler.reconcileTaskStatus(retryTask.id);
  assert.equal(runtime.store.getTaskRun(retryTask.id).status, 'waiting');
  const retriedTask = await runtime.retryTaskNode({
    taskRunId: retryTask.id,
    taskNodeId: retryNode.id,
    options: { dryRun: true, permissionMode: 'task-workspace' },
  });
  assert.equal(retriedTask.nodes.find((node) => node.id === retryNode.id).status, 'completed');
  assert.equal(retriedTask.nodes.find((node) => node.id === retryDownstream.id).status, 'completed', 'successful retry must continue downstream work');
  assert.equal(retriedTask.status, 'completed');
  assert.ok(retriedTask.events.some((event) => event.eventType === 'node_retry_requested' && event.taskNodeId === retryNode.id));
  await assert.rejects(
    () => runtime.retryTaskNode({ taskRunId: retryTask.id, taskNodeId: retryNode.id, options: { dryRun: true } }),
    /Completed or cancelled task runs cannot retry/,
  );
  runtime.store.updateTaskNode(retryDownstream.id, { status: 'failed', errorText: 'terminal fixture' });
  runtime.store.updateTaskRunStatus(retryTask.id, 'failed', 'terminal retry fixture');
  const terminalRetriedTask = await runtime.retryTaskNode({ taskRunId: retryTask.id, taskNodeId: retryDownstream.id, options: { dryRun: true } });
  assert.equal(terminalRetriedTask.status, 'completed');
  assert.equal(terminalRetriedTask.nodes.find((node) => node.id === retryDownstream.id).status, 'completed');
  assert.equal(runtime.activeRuns.size, 0, 'task node retry must always release the active run marker');

  const pptInstance = runtime.store.resolveUserAgent({ userId: runtime.currentUser().id, agentFamilyId: 'ppt' }).instance;
  runtime.store.updateUserAgentConsents({ agentInstanceId: pptInstance.id, syncEnabled: true, personalEvolutionConsent: true });
  const localVersion = runtime.store.createPersonalSkillVersion({
    agentInstanceId: pptInstance.id,
    overlayText: 'Legacy local mutation fixture.',
  });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: pptInstance.id, skillVersionId: localVersion.id });
  await assert.rejects(() => runtime.rollbackPersonalSkill({ agentInstanceId: pptInstance.id, targetSkillVersionId: '' }),
    (error) => error.code === 'cloud_authority_required');
  const desktopRun = await runtime.runPersonalEvolution({ agentInstanceId: pptInstance.id, trigger: 'manual' });
  assert.equal(desktopRun.status, 'unavailable');
  assert.equal(desktopRun.code, 'cloud_not_configured');

  const cloudDb = openCloudDatabase(path.join(tmp, 'fake-codex-cloud-authority'));
  try {
    const now = new Date().toISOString();
    cloudDb.prepare("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json,updated_at) VALUES('ppt','ppt_department','PPT','{}',?)").run(now);
    cloudDb.prepare("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json,created_at) VALUES('ppt_base','ppt',?,?)").run(
      JSON.stringify({ baseSkillContent: 'Create presentation artifacts and verify delivery.' }), now,
    );
    cloudDb.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
      user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,cluster_contribution_consent,payload_json,created_at,updated_at
    ) VALUES ('fake_user','fake_ppt','ppt','ppt_base','active',1,1,1,'{}',?,?)`).run(now, now);
    const authority = createEvolutionAuthority({
      db: cloudDb,
      keyring: { activeKeyId: 'fake', keys: { fake: crypto.randomBytes(32).toString('base64') } },
      modelExecutor: ({ prompt, modelRole }) => runCodexExec({
        prompt,
        agentId: 'general_agent',
        root: runtime.root,
        cwd: runtime.root,
        role: `cloud-evolution-${modelRole}`,
        sandbox: 'read-only',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
      }),
    });
    const token = authority.issueGrant({ userId: 'fake_user', deviceId: 'fake_device' }).token;
    const grant = authority.requireGrant(token, 'evolution:write');
    for (const index of [1, 3]) {
      cloudDb.prepare('INSERT INTO cloud_task_runs(id,payload_json,updated_at) VALUES(?,?,?)').run(
        `fake_cloud_task_${index}`, JSON.stringify({ ownerUserId: 'fake_user' }), now,
      );
      cloudDb.prepare('INSERT INTO cloud_task_nodes(id,task_run_id,payload_json,updated_at) VALUES(?,?,?,?)').run(
        `fake_cloud_evidence_${index}`, `fake_cloud_task_${index}`, JSON.stringify({ agentInstanceId: 'fake_ppt' }), now,
      );
    }
    for (const index of [0, 2, 4]) {
      const content = `failed task ${index}: the presentation artifact must be verified before delivery.`;
      cloudDb.prepare(`INSERT INTO cloud_messages_v2(
        user_id,device_id,id,conversation_id,role,content,payload_json,created_at
      ) VALUES('fake_user','fake_device',?,'fake_conversation','user',?,?,?)`).run(
        `fake_cloud_evidence_${index}`, content, JSON.stringify({ agentInstanceId: 'fake_ppt', content }), now,
      );
    }
    const evidence = authority.ingestEvidence(grant, Array.from({ length: 5 }, (_, index) => ({
      userAgentInstanceId: 'fake_ppt',
      sourceKind: index % 2 ? 'task_result' : 'message',
      sourceId: `fake_cloud_evidence_${index}`,
      content: `failed task ${index}: the presentation artifact must be verified before delivery.`,
      allowedEvolutionScopes: ['personal'],
      occurredAt: new Date(Date.now() + index).toISOString(),
    })));
    assert.equal(evidence.accepted.length, 5, JSON.stringify(evidence));
    const queued = authority.requestPersonalRun(grant, { agentInstanceId: 'fake_ppt', triggerKind: 'manual' });
    assert.equal(queued.status, 'queued');
    const worker = await authority.tickWorker({ limit: 1 });
    assert.equal(worker.completed[0].status, 'available', JSON.stringify(worker.completed[0]));
    assert.equal(worker.completed[0].autoActivated, false);
    const cloudRun = authority.getRun(grant, queued.run.id);
    assert.equal(cloudRun.status, 'available');
    assert.equal(cloudRun.candidateVersion.status, 'candidate');
    assert.equal(cloudRun.proposal.status, 'ready');
    assert.equal(cloudRun.actions.find((item) => item.targetKind === 'skill'), undefined);
    const activated = authority.activatePersonalVersion(grant, {
      agentInstanceId: 'fake_ppt', targetVersionId: cloudRun.candidatePersonalSkillVersionId,
      commandId: 'fake_codex_activate_version', expectedActiveVersionId: '',
    });
    assert.equal(activated.status, 'activated');
    const activatedRun = authority.getRun(grant, queued.run.id);
    assert.equal(activatedRun.candidateVersion.status, 'active');
    assert.equal(activatedRun.actions.find((item) => item.targetKind === 'skill')?.automatic, false);
    assert.equal(authority.evidenceCounts(grant, { agentInstanceId: 'fake_ppt' }).counts.consumed, 5);
  } finally {
    cloudDb.close();
  }

  const logs = readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(logs.some((entry) => entry.args.includes('exec') && entry.args.includes('--json') && entry.args.includes('--output-last-message')));
  assert.ok(logs.some((entry) => entry.args[0] === 'app-server'
    && entry.codeXHome.includes('codex_backend_sessions')
    && entry.hasResumeFixture),
  'resumed dialogue must use the persistent app-server session home');
  assert.ok(logs.some((entry) => entry.args.includes('--ephemeral') && entry.args.includes('--output-last-message')));
  assert.ok(logs.some((entry) => entry.isCloudEvolution
    && entry.args[entry.args.indexOf('--sandbox') + 1] === 'read-only'),
  'cloud evolution Proposal/Gate/replay must run through the shared core in a read-only Codex sandbox');
  assert.ok(logs.some((entry) => entry.stdinIncludesPrompt));
  assert.ok(logs.some((entry) => entry.codeXHome.includes('codex_backend_sessions')));
  assert.ok(logs.every((entry) => entry.homeHasAuth), 'Codex child CODEX_HOME should contain auth.json');
  assert.ok(logs.every((entry) => entry.homeHasConfig), 'Codex child CODEX_HOME should contain config.toml');
  assert.ok(logs.some((entry) => entry.homeAgentFiles.includes('general_agent.toml')), 'Codex child CODEX_HOME should contain official custom-agent TOML files');
  assert.ok(logs.some((entry) => entry.usesOfficialHarness), 'named Janus agents must run through the Codex subagent harness');
  assert.ok(logs.some((entry) => entry.isDirectAgentChat && !entry.usesOfficialHarness), 'direct employee chat must not spawn a duplicate custom Agent');
  assert.ok(logs.some((entry) => entry.hasSelectedGeneralDepartment));
  assert.ok(logs.some((entry) => entry.hasSelectedGeneralDepartment && entry.hasManagedArtifactOutput),
    'direct Agent prompts must declare the session-scoped managed artifact output directory');
  assert.ok(logs.some((entry) => entry.isAttachmentRetrieval), 'multi-attachment tasks must run Agent attachment relevance selection');
  assert.ok(logs.some((entry) => entry.hasSelectedResearchAttachment), 'selected attachment excerpt must reach the relevant task node');
  assert.ok(!logs.some((entry) => entry.hasUnrelatedBudgetAttachment), 'unselected attachment content must not reach task-node execution');
  assert.ok(logs.some((entry) => entry.hasCompressedTerminalResults), 'final synthesis must receive compressed terminal results');
  const uBuddyWorkspaceLogs = logs.filter((entry) => entry.isTaskNodeExecution && entry.hasUBuddyWorkspaceFixture);
  assert.ok(uBuddyWorkspaceLogs.length > 0, 'uBuddy formal task-node project execution was not observed');
  assert.ok(uBuddyWorkspaceLogs.some((entry) => entry.cwd === uBuddyProject.workspaceRoot),
    'the uBuddy task graph must execute inside the selected project workspace');
  const plainModelLog = logs.find((entry) => entry.hasSelectedGeneralDepartment
    && (entry.requestedModel === 'gpt-5.6-terra' || entry.args.includes('gpt-5.6-terra')));
  assert.ok(plainModelLog, 'the selected general Agent model invocation must be recorded');
  assert.equal(plainModelLog.requestedModel || plainModelLog.args[plainModelLog.args.indexOf('--model') + 1], 'gpt-5.6-terra');
  assert.ok(plainModelLog.requestedReasoningEffort === 'ultra' || plainModelLog.args.includes('model_reasoning_effort="ultra"'));
  assert.equal(plainModelLog.cwd, routedProject.workspaceRoot, 'project chats must execute inside the selected workspace');
  assert.equal(existsSync(path.join(routedProject.workspaceRoot, 'departments')), false, 'runtime assets must not be copied into the selected workspace');
  const collaborationModelLogs = logs.filter((entry) => (
    entry.isTaskNodeExecution && entry.hasCollaborationFixture
  ));
  assert.ok(collaborationModelLogs.length > 0);
  assert.ok(collaborationModelLogs.every((entry) => (
    entry.requestedModel || entry.args[entry.args.indexOf('--model') + 1]
  ) === 'gpt-5.6-luna'));
  assert.ok(collaborationModelLogs.every((entry) => (
    entry.requestedReasoningEffort === 'max' || entry.args.includes('model_reasoning_effort="max"')
  )));
  assert.ok(collaborationModelLogs.every((entry) => entry.cwd === routedProject.workspaceRoot));
  assert.ok(collaborationModelLogs.every((entry) => entry.hasExternalFileBoundary));
  assert.ok(existsSync(path.join(tmp, 'workspace', 'departments', 'ppt_department', 'agents', 'ppt', 'MEMORY.md')));

  await flushApplicationLogs();
  const applicationLogText = readFileSync(path.join(applicationLogDir, 'janus.log'), 'utf8');
  const applicationLogEvents = applicationLogText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(applicationLogEvents.some((event) => event.source === 'codex' && ['app-server-start', 'process-start'].includes(event.event)), 'Codex production logging must record process lifecycle metadata');
  assert.ok(applicationLogEvents.some((event) => event.source === 'codex' && ['app-server-complete', 'process-complete'].includes(event.event)), 'Codex production logging must record process completion metadata');
  for (const privateText of ['uBuddy FIFO hello fixture', 'JANUS_FAKE_OK', 'Return JSON only with summary', 'raw stderr']) {
    const leakingEvents = applicationLogEvents
      .filter((event) => JSON.stringify(event).includes(privateText))
      .map((event) => `${event.source}:${event.event}:${event.error?.code || ''}`);
    assert.equal(leakingEvents.length, 0,
      `Codex production logging leaked private process content: ${privateText}; events=${leakingEvents.join(',')}`);
  }

  runtime.close();
  console.log('fake codex e2e passed');
} finally {
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousLog === undefined) delete process.env.FAKE_CODEX_LOG;
  else process.env.FAKE_CODEX_LOG = previousLog;
  if (previousUBuddyProcessingMode === undefined) delete process.env.JANUS_UBUDDY_PROCESSING_MODE;
  else process.env.JANUS_UBUDDY_PROCESSING_MODE = previousUBuddyProcessingMode;
  if (previousIntakeFlag === undefined) delete process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
  else process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = previousIntakeFlag;
  if (previousStructuredReferenceFlag === undefined) delete process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
  else process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = previousStructuredReferenceFlag;
  if (previousAutoRoutingFlag === undefined) delete process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
  else process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = previousAutoRoutingFlag;
  if (previousBoundedReviewFlag === undefined) delete process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
  else process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = previousBoundedReviewFlag;
  if (previousCodexPrimaryFlag === undefined) delete process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;
  else process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1 = previousCodexPrimaryFlag;
  await closeApplicationLogging().catch(() => {});
  await new Promise((resolve) => fakeProvider.close(resolve));
  await cleanupTempDir(tmp);
  await cleanupTempDir(binTmp);
}

async function waitForCondition(predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms.`);
}

async function cleanupTempDir(dir) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) {
        console.warn(`warning: unable to remove temp dir ${dir}: ${error.message || error}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 100));
    }
  }
}
