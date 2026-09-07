import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const projectRoot = process.cwd();
const outputRoot = path.join(projectRoot, 'docs', 'ubuddy-manual', 'screenshots');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-manual-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const profileRoot = path.join(tempRoot, 'profile');
const workspaceRoot = path.join(tempRoot, 'workspace');
const electronBinary = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const debugPort = Number(process.env.JANUS_UBUDDY_MANUAL_PORT || 9617);
const account = { email: 'ubuddy-manual@example.test', password: 'uBuddy-Manual-Password1!' };
const captures = [];
let child = null;
let cdp = null;
let stderr = '';

mkdirSync(outputRoot, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });

try {
  assert.ok(existsSync(electronBinary), `Electron binary not found: ${electronBinary}`);
  const runtime = await createRuntime({
    root: runtimeRoot,
    isDev: true,
    requireExplicitAuthentication: true,
    serverAuthoritativeSkills: true,
  });
  runtime.authRegister({ email: account.email, password: account.password, displayName: 'uBuddy 手册演示用户' });
  await runtime.authUpdateProfile({ displayName: 'uBuddy 手册演示用户', username: 'ubuddy_manual' });
  const user = runtime.currentUser();
  const workspaceId = runtime.store.activeAccountWorkspace({ userId: user.id })?.id || 'workspace_personal';
  const session = runtime.ensureSecretarySession({ accountWorkspaceId: workspaceId });
  seedLocalRuntime(runtime, { user, workspaceId, session });
  await runtime.close();

  const env = {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    JANUS_HOME: runtimeRoot,
    JANUS_AUTH_URL: '',
    JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
    JANUS_MODEL_REFRESH_ENABLED: '0',
    JANUS_LOCAL_EVOLUTION_ENABLED: '0',
    JANUS_UPDATES_ENABLED: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, [
    '--no-sandbox', '--disable-gpu', `--user-data-dir=${profileRoot}`,
    `--remote-debugging-port=${debugPort}`, '.',
  ], { cwd: projectRoot, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const target = await waitForPageTarget(debugPort, 30_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await setViewport(1600, 1000);
  await evaluate(`localStorage.setItem('janus-language-mode', 'zh-CN'); localStorage.setItem('janus-theme-mode', 'light'); location.reload()`);
  await waitFor(`document.querySelector('[data-network-view="messages"]')`, 30_000);
  await sleep(900);

  const captureFrom = Number(process.env.JANUS_UBUDDY_CAPTURE_FROM || 1);
  if (captureFrom <= 1) await captureMessageHome();
  if (captureFrom <= 2) await captureTalentMarket();
  if (captureFrom <= 3) await captureContactProfile();
  if (captureFrom <= 24) {
    await openUBuddyConversation();
    if (captureFrom <= 4) await captureComposerStates(session.id);
    if (captureFrom <= 13) await capturePlanningCards(session.id);
    if (captureFrom <= 20) await captureRunInteractionStates(session.id);
  }
  if (captureFrom <= 25) await captureTaskWorkspaces(session.id);
  if (captureFrom <= 31) await captureCollaborationGroup();
  if (captureFrom <= 37) await captureDelegationWorkspace();
  if (captureFrom <= 41) await captureSettingsAndEvolution();
  if (captureFrom <= 45) await captureResponsiveAndDark(session.id);

  writeFileSync(path.join(outputRoot, 'capture-index.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    viewport: { width: 1600, height: 1000 },
    captures,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, outputRoot, count: captures.length, captures }, null, 2));
} catch (error) {
  console.error(error?.stack || error);
  if (stderr.trim()) console.error(stderr.slice(-6000));
  process.exitCode = 1;
} finally {
  try { await cdp?.close?.(); } catch {}
  await stopChild(child);
  if (!process.env.JANUS_E2E_KEEP_TEMP) rmSync(tempRoot, { recursive: true, force: true });
}

function seedLocalRuntime(runtime, { user, workspaceId, session }) {
  const sourceMessages = [
    ['manual-welcome-user', '请帮我整理新品发布计划，并明确交付标准。', 'user'],
    ['manual-welcome-assistant', '我会先确认目标，再选择合适的 Agent 执行并统一交付。', 'assistant'],
  ];
  for (const [id, content, role] of sourceMessages) runtime.store.addMessage({
    id, sessionId: session.id, role, content,
    agentId: 'secretary_agent', departmentId: 'secretary_department',
  });
  for (const [id, title, status, summary] of [
    ['manual-task-active', '新品发布计划与风险清单', 'running', '正在整合里程碑、负责人和风险。'],
    ['manual-task-waiting', '客户访谈结论', 'waiting', '等待联系人补充最后一轮访谈记录。'],
    ['manual-task-failed', '行业研究报告', 'failed', '报告文件生成失败，等待处理。'],
    ['manual-task-closed', '竞品能力对比表', 'completed', '已完成主要竞品能力与定价对比。'],
  ]) {
    const task = runtime.store.createTaskRun({
      id, ownerUserId: user.id, workspaceId, title, prompt: summary, initialStatus: status,
      metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id, sourceSecretaryMessageId: 'manual-welcome-user' },
    });
    runtime.store.updateTaskRunStatus(task.id, status, summary);
  }
}

async function captureMessageHome() {
  await click('[data-network-view="messages"]');
  await waitFor(`document.querySelector('.im-message-shortcut.is-ubuddy')`);
  await capture('01-entry-message-home.png', '.message-default-page, .network-panel');
}

async function captureTalentMarket() {
  await click('[data-tab="employees"]');
  await waitFor(`document.querySelector('.talent-directory-view')`);
  await setState(`
    state.employeeOverview = {
      ...(state.employeeOverview || {}), quota: { used: 1, active: 1, limit: 10, remaining: 9 },
      roster: [{ id: 'manual-ubuddy', agentFamilyId: 'secretary_agent', displayName: 'uBuddy', employmentState: 'active', routeEligible: true,
        family: { name: 'uBuddy', departmentId: 'secretary_department' } }], recruitableFamilies: []
    };
  `);
  await forceRender();
  await capture('02-entry-talent-market.png', '.talent-directory-view');
}

async function captureContactProfile() {
  await click('[data-network-view="friends"]');
  await setState(`
    const peer = { id: 'manual-peer', displayName: '林然', display_name: '林然', username: 'linran', email: 'linran@example.test' };
    state.friendOverview = { ...(state.friendOverview || {}), friends: [{ id: 'friend-manual', status: 'accepted', friend: peer, online: true }], organizations: [] };
    state.networkSelectedContactId = peer.id; state.networkContactProfileOpen = true;
    state.uBuddyFeatureFlags = { ...(state.uBuddyFeatureFlags || {}), profilePublication: true };
    state.uBuddyCapabilityProfilesByUserId = { [peer.id]: { fetchedAt: '2026-08-16T08:00:00.000Z', profile: {
      introduction: '擅长市场研究、发布方案和结构化文档交付。', capabilityTags: ['市场研究', '方案设计', '文档交付'],
      supportedTaskTypes: ['竞品分析', '发布计划'], deliverableTypes: ['报告', '演示文稿'] } } };
  `);
  await forceRender();
  await waitFor(`document.querySelector('[data-contact-profile-dialog]')`);
  await capture('03-entry-contact-profile.png', '[data-contact-profile-dialog]');
}

async function openUBuddyConversation() {
  await click('[data-network-view="messages"]');
  await click('[data-network-peer="self-secretary"]');
  await waitFor(`document.querySelector('.chat-utility-conversation.is-ubuddy, .chat-utility-avatar.is-ubuddy')`, 30_000);
}

async function captureComposerStates(sessionId) {
  await setState(baseUBuddyState(sessionId));
  await forceRender();
  await waitFor(`document.querySelector('#chat-form.is-ubuddy-mode')`);
  await capture('04-chat-main.png', '.conversation-panel');

  await click('[data-composer-tool-menu-toggle]');
  await capture('05-chat-add-menu.png', '.composer-tool-menu');
  await click('[data-composer-tool-menu-toggle]');

  await click('[data-ubuddy-message-mode-toggle]');
  await capture('06-chat-message-mode-menu.png', '.ubuddy-message-mode-menu');
  await click('[data-ubuddy-message-mode-toggle]');

  await setState(`
    state.composerMentions = [
      { principalType: 'user', userId: 'manual-peer', token: '@林然', label: '林然' },
      { principalType: 'user', userId: 'manual-peer-2', token: '@周宁', label: '周宁' }
    ];
    state.secretaryMentions = [...state.composerMentions];
    state.chatDraft = '@林然 @周宁 请共同整理发布方案';
  `);
  await forceRender();
  await capture('07-chat-participant-scope.png', '.ubuddy-participant-policy-switch');

  await click('[data-social-mention-toggle]');
  await capture('08-chat-mention-picker.png', '.project-mention-menu, .social-mention-menu');
  await click('[data-social-mention-toggle]');

  await setState(`state.workspaceMenuOpen = true; state.workspaceCreateMenuOpen = false; state.projects = [
    { id: 'project-launch', title: '新品发布项目', workspaceRoot: ${JSON.stringify(workspaceRoot)}, status: 'active' },
    { id: 'project-research', title: '市场研究资料', workspaceRoot: ${JSON.stringify(path.join(workspaceRoot, 'research'))}, status: 'active' }
  ]; state.activeProjectId = 'project-launch';`);
  await forceRender();
  await waitFor(`document.querySelector('.workspace-picker-menu')`);
  await capture('09-chat-project-menu.png', '.workspace-picker-menu');

  await setState(`state.workspaceMenuOpen = false; state.composerMemoryMenuOpen = true; state.composerMemoryAgentInstanceId = 'manual-ubuddy';
    state.employeeOverview = { ...(state.employeeOverview || {}), capabilities: { multiMemory: { enabled: true, readOnly: false, code: 'ok' } }, roster: [
      { id: 'manual-ubuddy', agentFamilyId: 'secretary_agent', displayName: 'uBuddy', currentMemory: { id: 'memory-main', displayName: 'memory0.md' } }
    ]};
    state.composerMemoryDocuments = [
      { id: 'memory-main', scope: 'general', displayName: 'memory0.md', lifecycleState: 'active', messageCount: 18, updatedAt: '2026-08-16T08:00:00.000Z' },
      { id: 'memory-launch', scope: 'general', displayName: '新品发布协作', lifecycleState: 'active', messageCount: 7, updatedAt: '2026-08-15T08:00:00.000Z' }
    ]; state.composerMemoryContext = { activeMemoryDocumentId: 'memory-main' };`);
  await forceRender();
  await waitFor(`document.querySelector('.composer-memory-menu')`);
  await capture('10-chat-memory-menu.png', '.composer-memory-menu');

  await setState(`state.composerMemoryMenuOpen = false; state.sandboxMenuOpen = true; state.sandboxPermission = 'auto-approve';`);
  await forceRender();
  await waitFor(`document.querySelector('.sandbox-permission-menu')`);
  await capture('11-chat-permission-menu.png', '.sandbox-permission-menu');

  await setState(`state.sandboxMenuOpen = false; state.modelMenuOpen = true; state.modelSubmenuOpen = true;`);
  await forceRender();
  await waitFor(`document.querySelector('.model-picker.is-open > .model-menu')`);
  await capture('12-chat-model-menu.png', '.model-picker.is-open > .model-menu');
}

function baseUBuddyState(sessionId) {
  return `
    state.currentTab = 'chat'; state.networkPanelOpen = true; state.networkPanelView = 'messages'; state.networkMessageHomeOpen = false;
    state.currentSessionId = ${JSON.stringify(sessionId)}; state.currentDepartmentId = 'secretary_department'; state.currentAgentId = 'secretary_agent'; state.homeMode = 'secretary';
    state.activeTaskWorkspaceKind = ''; state.activeTaskWorkspaceId = ''; state.collaborationGroupId = ''; state.networkDelegationId = '';
    state.uBuddyFeatureFlags = { ...(state.uBuddyFeatureFlags || {}), messageModeV1: true, structuredTaskReference: true, newTaskWorkspaceUi: true, newProcessEventStream: true, profilePreviewV1: true, profileHistory: true, profilePublication: true, agentWorkDetailProjection: true };
    state.uBuddyMessageMode = 'task'; state.uBuddyMessageModeMenuOpen = false; state.composerToolMenuOpen = false; state.taskReferenceMenuOpen = false;
    state.workspaceMenuOpen = false; state.composerMemoryMenuOpen = false; state.sandboxMenuOpen = false; state.socialMentionMenuOpen = false;
    state.modelMenuOpen = false; state.modelSubmenuOpen = false; state.chatRuns = []; state.activeChatRun = null; state.messageContextMenu = null; state.messageForwardDialog = null;
    state.composerMentions = []; state.secretaryMentions = []; state.attachments = []; state.chatDraft = '';
    state.messages = [
      { id: 'manual-user-base', sessionId: ${JSON.stringify(sessionId)}, role: 'user', content: '请帮我整理新品发布计划，并明确交付标准。', createdAt: '2026-08-16T08:00:00.000Z', metadata: {} },
      { id: 'manual-assistant-base', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '我会先确认目标，再选择合适的 Agent 执行并统一交付。', createdAt: '2026-08-16T08:00:05.000Z', metadata: { secretaryControl: true } }
    ];
  `;
}

async function capturePlanningCards(sessionId) {
  await setState(`${baseUBuddyState(sessionId)}
    state.messages = [
      { id: 'manual-plan-user', sessionId: ${JSON.stringify(sessionId)}, role: 'user', content: '请整理产品发布方案，可以直接做，也可以安排多个 Agent。', createdAt: '2026-08-16T08:10:00.000Z', metadata: {} },
      { id: 'manual-execution-choice', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '', createdAt: '2026-08-16T08:10:02.000Z', metadata: { secretaryControl: true,
        uBuddyExecutionModeChoice: { choiceId: 'choice-manual', status: 'pending', recommendedMode: 'scheduler', routingRationale: '任务包含研究、撰写和复核，既可以直接完成，也适合多人协作。', directModeSummary: '更快生成一版综合方案。', schedulerModeSummary: '拆分研究、文案和质量复核并统一交付。' } } },
      { id: 'manual-execution-target', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '', createdAt: '2026-08-16T08:10:03.000Z', metadata: { secretaryControl: true, dispatchClarification: true,
        uBuddyPlanningCheckpoint: { id: 'checkpoint-target' }, clarifications: [{ id: 'target', question: '这项任务希望由本机 Agent 完成，还是交给联系人？', answerType: 'execution_target', required: true }] } }
    ];
  `);
  await forceRender();
  await scrollToSelector('.ubuddy-execution-mode-card');
  await capture('13-planning-execution-choice.png', '.ubuddy-execution-mode-card');
  await scrollToSelector('.ubuddy-execution-target-card');
  await capture('14-planning-execution-target.png', '.ubuddy-execution-target-card');

  await setState(`${baseUBuddyState(sessionId)}
    state.messages = [{ id: 'manual-clarification', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '', createdAt: '2026-08-16T08:20:00.000Z', metadata: {
      secretaryControl: true, dispatchClarification: true, uBuddyPlanningCheckpoint: { id: 'checkpoint-clarify' },
      uBuddyPreDispatchPlan: { executionPlan: { summary: '先完成市场资料梳理，再生成发布方案并复核。', steps: ['梳理目标用户与竞品', '生成发布方案', '检查风险与交付格式'] }, safeAssumptions: ['默认使用中文'], knownFacts: ['需要发布方案'], criticalUnknowns: [{ name: '截止时间' }] },
      clarifications: [
        { id: 'deadline', header: '时间要求', question: '希望什么时候完成？', reason: '截止时间会影响并行程度。', required: true, options: [{ value: 'today', label: '今天完成', description: '优先快速交付' }, { value: 'week', label: '本周完成', description: '允许更充分复核' }] },
        { id: 'format', header: '交付格式', question: '主要交付格式是什么？', required: true, options: [{ value: 'docx', label: 'Word 文档' }, { value: 'pptx', label: 'PPT' }] }
      ] } }];
  `);
  await forceRender();
  await scrollToSelector('.ubuddy-clarification-card');
  await capture('15-planning-clarification.png', '.ubuddy-clarification-card');

  await setState(`${baseUBuddyState(sessionId)}
    state.friendOverview = { ...(state.friendOverview || {}), friends: [
      { friend: { id: 'manual-peer', displayName: '林然', username: 'linran' }, online: true },
      { friend: { id: 'manual-peer-2', displayName: '周宁', username: 'zhouning' }, online: false }
    ] };
    state.messages = [
      { id: 'manual-plan-failure', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '', createdAt: '2026-08-16T08:30:00.000Z', metadata: { secretaryControl: true, uBuddyPlanningCheckpoint: { id: 'checkpoint-failure' },
        uBuddyCollaborationPlanningFailure: { status: 'retryable', code: 'collaboration_assignment_timeout' } } },
      { id: 'manual-plan-card', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '', createdAt: '2026-08-16T08:30:05.000Z', metadata: { secretaryControl: true, uBuddyPlanningCheckpoint: { id: 'checkpoint-plan' },
        uBuddySelection: { candidateUserIds: ['manual-peer', 'manual-peer-2'], selectedUserIds: ['manual-peer'], requiredUserIds: ['manual-peer'], selectionMode: 'candidate_pool', selectionDecision: { confidence: .91, rationale: '市场研究由林然覆盖即可，周宁暂不需要参与。', rejectedCandidates: [{ userId: 'manual-peer-2', reason: '当前任务无需额外文案角色' }], strategyVersion: 'participant_selection_v1' } },
        uBuddyCollaborationPlan: { status: 'awaiting_confirmation', collaborationMode: 'peer_collaboration', assignments: [
          { assignmentId: 'self', assigneeKind: 'self', title: '整合发布目标与验收标准', objective: '整理统一框架。', dependencies: [] },
          { assignmentId: 'peer', assigneeKind: 'user', userId: 'manual-peer', title: '市场和竞品研究', objective: '形成可核验研究摘要。', dependencies: ['self'] }
        ] } } }
    ];
  `);
  await forceRender();
  await scrollToSelector('.ubuddy-collaboration-planning-failure');
  await capture('16-planning-failure.png', '.ubuddy-collaboration-planning-failure');
  await scrollToSelector('.ubuddy-collaboration-plan-card');
  await capture('17-planning-collaboration-plan.png', '.ubuddy-collaboration-plan-card');
  await click('.ubuddy-selection-card > summary');
  await scrollToSelector('.ubuddy-selection-card');
  await capture('18-planning-participant-selection.png', '.ubuddy-selection-card');

  await setState(`${baseUBuddyState(sessionId)}
    state.messages = [{ id: 'manual-expired-plan', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '', createdAt: '2026-08-16T08:40:00.000Z', metadata: { secretaryControl: true, sourceMessageId: 'manual-plan-source', dispatchClarification: true,
      clarifications: [{ id: 'old', question: '旧版规划问题', required: true }], uBuddyCollaborationPlan: { status: 'awaiting_confirmation', assignments: [] } } }];
  `);
  await forceRender();
  await scrollToSelector('.ubuddy-clarification-card');
  await capture('19-planning-expired.png', '.ubuddy-clarification-card');
}

async function captureRunInteractionStates(sessionId) {
  await setState(`${baseUBuddyState(sessionId)}
    state.messages = [{ id: 'manual-process', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '正在准备发布方案。', createdAt: '2026-08-16T09:00:00.000Z', metadata: { secretaryControl: true,
      processDurationMs: 9400, expanded: true, processEvents: [
        { activityId: 'reasoning-1', activityType: 'reasoning', status: 'completed', title: '分析任务', detail: '确认目标、交付物和验收标准。', durationMs: 1200 },
        { activityId: 'command-1', activityType: 'command', status: 'completed', command: 'node scripts/check-release-plan.mjs', output: '检查通过：3 个里程碑，6 项风险。', exitCode: 0, durationMs: 2400 },
        { activityId: 'file-1', activityType: 'file', status: 'completed', title: '生成交付文件', detail: '已生成发布计划与风险清单。', changes: [{ kind: 'create', path: '发布计划.md', diff: '+ # 新品发布计划\\n+ 风险与负责人' }] }
      ] } }];
  `);
  await forceRender();
  await scrollToSelector('.codex-process-disclosure');
  await capture('20-run-process-details.png', '.codex-process-disclosure');

  await setState(`${baseUBuddyState(sessionId)}
    state.chatRuns = [{ runId: 'manual-approval-run', sessionId: ${JSON.stringify(sessionId)}, targetKind: 'agent', terminal: false, channelId: 'manual-channel', permissionMode: 'auto-approve',
      approvalRequest: { approvalId: 'manual-approval', command: 'curl https://example.com/research', reason: '需要访问互联网补充公开市场资料。', cwd: ${JSON.stringify(workspaceRoot)} } }];
    state.activeChatRun = state.chatRuns[0];
  `);
  await forceRender();
  await waitFor(`document.querySelector('.chat-approval-prompt')`);
  await capture('21-run-approval.png', '.chat-approval-prompt');

  await setState(`${baseUBuddyState(sessionId)}
    state.chatRuns = [{ runId: 'manual-input-run', sessionId: ${JSON.stringify(sessionId)}, targetKind: 'agent', terminal: false, channelId: 'manual-input-channel', permissionMode: 'auto-approve', userInputQuestionIndex: 0, userInputDraftAnswers: {},
      userInputRequest: { requestId: 'manual-input-request', questions: [{ id: 'audience', question: '发布方案主要面向哪类受众？', options: [{ label: '企业客户', description: '强调价值、可靠性和实施路径' }, { label: '个人用户', description: '强调体验、价格和上手速度' }], isOther: true }] } }];
    state.activeChatRun = state.chatRuns[0];
  `);
  await forceRender();
  await waitFor(`document.querySelector('.chat-user-input-panel')`);
  await capture('22-run-user-input.png', '.chat-user-input-panel');

  await setState(`${baseUBuddyState(sessionId)}
    state.messageContextMenu = { messageId: 'manual-user-base', inline: true, editable: true, forwardable: true, withdrawable: false, x: 1050, y: 430 };
  `);
  await forceRender();
  await waitFor(`document.querySelector('.message-context-menu')`);
  await capture('23-message-more-menu.png', '.message-context-menu');

  await setState(`${baseUBuddyState(sessionId)}
    state.messageForwardDialog = { messageId: 'manual-user-base', authorLabel: '我', content: '请帮我整理新品发布计划，并明确交付标准。' };
    state.friendOverview = { ...(state.friendOverview || {}), friends: [{ friend: { id: 'manual-peer', displayName: '林然', username: 'linran' } }] };
    state.chatGroupsOverview = { groups: [{ id: 'manual-chat-group', title: '产品发布讨论群', memberCount: 4, status: 'active' }] };
  `);
  await forceRender();
  await waitFor(`document.querySelector('.message-forward-dialog')`);
  await capture('24-message-forward-dialog.png', '.message-forward-dialog');
}

async function captureTaskWorkspaces(sessionId) {
  const task = `{
    id: 'manual-workspace-task', title: '新品发布方案与风险清单', status: 'running', summary: '研究与方案撰写已经完成，正在进行最终质量复核。',
    createdAt: '2026-08-16T09:00:00.000Z', updatedAt: '2026-08-16T09:36:00.000Z',
    metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: ${JSON.stringify(sessionId)},
      deliverableContract: { deliverables: [{ role: 'primary', title: '新品发布方案.docx' }] },
      deliverableResult: { title: '新品发布方案.docx', summary: '包含发布目标、里程碑、负责人、风险和验收标准。', body: ${JSON.stringify('# 新品发布方案\n\n已完成市场研究、渠道计划与风险复核。')}, files: [
        { name: '新品发布方案.docx', filename: '新品发布方案.docx', path: ${JSON.stringify(path.join(workspaceRoot, '新品发布方案.docx'))}, size: 48236 },
        { name: '发布风险清单.xlsx', filename: '发布风险清单.xlsx', path: ${JSON.stringify(path.join(workspaceRoot, '发布风险清单.xlsx'))}, size: 19620 }
      ], resultState: { ownerAccepted: false, qualityWarnings: [{ code: 'source_recency', summary: '建议上线前再次核对一项渠道价格。' }] } } },
    nodes: [
      { id: 'scope', title: '确认目标与验收标准', status: 'completed', agentId: 'secretary_agent', updatedAt: '2026-08-16T09:05:00.000Z' },
      { id: 'research', title: '市场与竞品研究', status: 'completed', agentId: 'general_agent', updatedAt: '2026-08-16T09:18:00.000Z' },
      { id: 'draft', title: '撰写发布方案', status: 'completed', agentId: 'writer_agent', updatedAt: '2026-08-16T09:28:00.000Z' },
      { id: 'review', title: '质量复核与风险检查', status: 'running', agentId: 'review_agent', updatedAt: '2026-08-16T09:36:00.000Z' }
    ],
    communications: [{ id: 'comm-1', fromAgentId: 'review_agent', toAgentId: 'secretary_agent', status: 'open', question: '是否需要把渠道预算按地区拆分？', createdAt: '2026-08-16T09:34:00.000Z' }],
    events: [
      { id: 'ev-1', type: 'task_started', status: 'completed', title: '任务开始执行', detail: '已确认任务范围。', createdAt: '2026-08-16T09:00:00.000Z' },
      { id: 'ev-2', type: 'node_completed', status: 'completed', taskNodeId: 'research', title: '市场研究完成', detail: '完成三家竞品与 12 份访谈材料核对。', createdAt: '2026-08-16T09:18:00.000Z' },
      { id: 'ev-3', type: 'command', status: 'completed', taskNodeId: 'draft', command: 'node scripts/validate-deliverable.mjs', output: '结构与文件检查通过', createdAt: '2026-08-16T09:29:00.000Z' }
    ]
  }`;
  await setState(`state.currentTab = 'collaboration'; state.networkPanelOpen = false; state.activeTaskWorkspaceKind = 'task_run'; state.activeTaskWorkspaceId = 'manual-workspace-task';
    state.messageForwardDialog = null; state.messageContextMenu = null; state.chatAvatarProfile = null; state.networkContactProfileOpen = false;
    state.activeTaskSourceContext = { source_conversation_id: ${JSON.stringify(sessionId)}, returnSurface: 'session' };
    state.tasks = [${task}]; state.taskDetail = ${task}; state.taskWorkspaceViewById = { 'manual-workspace-task': 'activity' };
    state.taskRunWorkspaceMessagesById = { 'manual-workspace-task': [{ id: 'task-msg-1', role: 'user', content: '请把风险负责人补充完整。', metadata: {} }, { id: 'task-msg-2', role: 'assistant', content: '已收到，正在补充负责人和处理时限。', metadata: {} }] };
    state.taskRunWorkspaceDrafts = { 'manual-workspace-task': '请同时补充上线后的监控指标' }; state.attachments = [];`);
  await forceRender();
  if (!await exists('[data-task-run-workspace="manual-workspace-task"]')) {
    await setState(`state.messageForwardDialog = null; state.messageContextMenu = null; state.currentTab = 'collaboration'; state.networkPanelOpen = false; state.activeTaskWorkspaceKind = 'task_run'; state.activeTaskWorkspaceId = 'manual-workspace-task';`);
    await forceRender();
    if (!await exists('[data-task-run-workspace="manual-workspace-task"]')) {
      const diagnostic = await evaluate(`(async () => { const { state } = await import('./app/state.js'); return { currentTab: state.currentTab, activeTaskWorkspaceKind: state.activeTaskWorkspaceKind, activeTaskWorkspaceId: state.activeTaskWorkspaceId, taskId: state.taskDetail?.id || '', body: (document.body?.innerText || '').slice(0, 1200) }; })()`);
      throw new Error(`Task workspace did not render: ${JSON.stringify(diagnostic)}`);
    }
  }
  await capture('25-task-workspace-activity.png', '.local-task-workspace');

  await setState(`state.taskWorkspaceViewById = { 'manual-workspace-task': 'result' };`);
  await forceRender();
  await capture('26-task-workspace-result.png', '.local-task-workspace');
  if (await exists('.final-deliverable-warnings > summary')) await click('.final-deliverable-warnings > summary');
  if (await exists('.final-deliverable-body > summary')) await click('.final-deliverable-body > summary');
  await capture('27-task-workspace-result-expanded.png', '.local-task-workspace-body');

  await setState(`state.taskWorkspaceViewById = { 'manual-workspace-task': 'flow' };`);
  await forceRender();
  await capture('28-task-workspace-flow.png', '.local-task-workspace');

  await setState(`state.taskWorkspaceViewById = { 'manual-workspace-task': 'activity' };`);
  await forceRender();
  if (await exists('.local-task-technical-details > summary')) await click('.local-task-technical-details > summary');
  await scrollToSelector('.local-task-technical-details');
  await capture('29-task-workspace-technical.png', '.local-task-technical-details');

  await setState(`state.taskDetail = { ...state.taskDetail, status: 'failed', summary: '生成交付文件时发生错误。', nodes: state.taskDetail.nodes.map((node) => node.id === 'review' ? { ...node, status: 'failed', lastError: '文档渲染器返回非零状态' } : node), metadata: { ...state.taskDetail.metadata, failureReport: { nodeId: 'review', code: 'renderer_failed', message: '文档渲染器返回非零状态', retryable: true }, publicFailure: { nodeId: 'review', code: 'renderer_failed', message: '文档渲染器返回非零状态' } }, events: [...state.taskDetail.events, { id: 'ev-fail', type: 'command', status: 'failed', taskNodeId: 'review', command: 'libreoffice --headless --convert-to pdf 新品发布方案.docx', output: 'Error: source file could not be loaded', payload: { error: 'source file could not be loaded', exitCode: 1 }, createdAt: '2026-08-16T09:38:00.000Z' }] }; state.tasks = [state.taskDetail];`);
  await forceRender();
  await scrollToSelector('.task-failure-diagnostics, .local-task-activity');
  await capture('30-task-workspace-failure.png', '.task-failure-diagnostics, .local-task-activity');
}

async function captureCollaborationGroup() {
  await setState(`
    state.currentTab = 'chat'; state.networkPanelOpen = true; state.networkPanelView = 'messages'; state.networkMessageHomeOpen = false;
    state.activeTaskWorkspaceKind = ''; state.networkDelegationId = ''; state.collaborationGroupId = 'manual-shared-group';
    state.messageForwardDialog = null; state.messageContextMenu = null; state.chatAvatarProfile = null; state.networkContactProfileOpen = false;
    const me = state.currentUser || { id: 'manual-owner', displayName: '演示用户' };
    state.collaborationGroupDetail = {
      group: { id: 'manual-shared-group', ownerUserId: me.id, title: '新品发布方案协作组', status: 'active', metadata: {
        taskSummary: { version: 1, objective: '形成可用于发布决策的完整方案', deliverables: ['发布方案.docx', '风险清单.xlsx'], acceptanceCriteria: ['关键结论可核验', '风险有明确负责人'], constraints: ['统一使用中文'], deadline: '2026-08-20' },
        virtualParticipants: [{ agentInstanceId: 'manual-analysis-agent', agentFamilyId: 'analysis_agent', displayName: '分析 Agent', status: 'running' }]
      } },
      workspace: { id: 'manual-shared-group', scope: 'collaboration_group', revision: 4, readOnly: false },
      members: [
        { userId: me.id, role: 'owner', status: 'active', user: me },
        { userId: 'manual-peer', role: 'member', status: 'active', user: { id: 'manual-peer', displayName: '林然' } },
        { userId: 'manual-peer-2', role: 'member', status: 'active', user: { id: 'manual-peer-2', displayName: '周宁' } }
      ],
      messages: [
        { id: 'group-msg-1', senderUserId: me.id, content: '请各位按分工推进，关键风险及时同步。', sender: me, createdAt: '2026-08-16T10:00:00.000Z' },
        { id: 'group-msg-2', senderUserId: 'manual-peer', content: '市场研究已经启动。', sender: { id: 'manual-peer', displayName: '林然' }, createdAt: '2026-08-16T10:05:00.000Z' },
        { id: 'group-msg-3', senderUserId: 'manual-peer', senderAgentId: 'secretary_agent', content: '竞品研究已完成，正在整理结论。', sender: { id: 'manual-peer', displayName: '林然' }, createdAt: '2026-08-16T10:12:00.000Z', metadata: { type: 'ubuddy_task_summary', taskId: 'group-task-1', stage: 'started', conclusion: '研究范围已确认，三家竞品材料已核对。', highlights: ['访谈资料已归档', '价格信息已核对'], nextStep: '形成差异化结论。' } }
      ],
      tasks: [
        { id: 'group-task-1', title: '市场与竞品研究', instruction: '形成可核验研究摘要。', status: 'working', requesterUserId: me.id, recipientUserId: 'manual-peer', metadata: { executionProgress: { message: '正在整理竞品差异结论', completed: 3, total: 5, milestones: [{ key: 'scope', title: '范围已确认', status: 'completed' }, { key: 'research', title: '资料已收集', status: 'completed' }, { key: 'draft', title: '正在整理结论', status: 'running' }] } } },
        { id: 'group-task-2', title: '发布文案', instruction: '输出渠道文案。', status: 'waiting', requesterUserId: me.id, recipientUserId: 'manual-peer-2', metadata: { executionProgress: { message: '等待市场结论', completed: 1, total: 3 } } }
      ]
    };
    state.collaborationGroupWorkspace = state.collaborationGroupDetail.workspace; state.collaborationMembersOpen = false; state.collaborationSearchOpen = false; state.collaborationDetailsOpenByGroupId = {}; state.collaborationPaneByGroupId = {};
    state.chatDraft = ''; state.attachments = [];`);
  await forceRender();
  await waitFor(`document.querySelector('.collaboration-group-chat-view')`);
  await capture('31-collaboration-group-main.png', '.collaboration-group-chat-view');
  if (await exists('.collaboration-shared-goal > summary')) await click('.collaboration-shared-goal > summary');
  await capture('32-collaboration-shared-goal.png', '.collaboration-shared-goal');

  await setState(`state.collaborationMembersOpen = true;`); await forceRender();
  await capture('33-collaboration-members.png', '#collaboration-member-popover, .collaboration-members-menu');
  await setState(`state.collaborationMembersOpen = false;`); await forceRender();
  if (await exists('.collaboration-more-menu > summary')) await click('.collaboration-more-menu > summary');
  await capture('34-collaboration-more-menu.png', '.collaboration-more-menu');
  if (await exists('.collaboration-more-menu > summary')) await click('.collaboration-more-menu > summary');

  await setState(`state.collaborationSearchOpen = true; state.collaborationSearchQuery = '竞品';`); await forceRender();
  await capture('35-collaboration-search.png', '.collaboration-search-panel, .collaboration-search');
  await setState(`state.collaborationSearchOpen = false; state.collaborationSearchQuery = ''; state.collaborationDetailsOpenByGroupId = { 'manual-shared-group': true };`); await forceRender();
  await capture('36-collaboration-progress-details.png', '.collaboration-side-pane');
}

async function captureDelegationWorkspace() {
  await setState(`
    state.currentTab = 'chat'; state.networkPanelOpen = true; state.networkPanelView = 'tasks'; state.collaborationGroupId = '';
    const me = state.currentUser || { id: 'manual-recipient', displayName: '演示用户' };
    state.networkDelegationId = 'manual-delegation';
    state.agentDelegations = [{ id: 'manual-delegation', requesterUserId: 'manual-peer', recipientUserId: me.id, title: '制作新品发布汇报 PPT', instruction: '生成一份 12 页以内的可编辑 PPT，并附风险清单。', status: 'draft_ready', groupId: 'manual-shared-group', requester: { id: 'manual-peer', displayName: '林然' }, recipient: me, metadata: { intakeSummary: '面向管理层，要求中文，并在本周五前完成。', ownerConfirmationRequired: true, executionProgress: { phase: 'delivering', completed: 4, total: 4 } } }];
    state.networkConversationMessages = [
      { id: 'delegation-user', role: 'user', content: '请把第二页改成市场规模摘要。', metadata: { privateTaskWorkspace: true, delegationId: 'manual-delegation' } },
      { id: 'delegation-answer', role: 'assistant', content: '已完成调整，并生成新版可编辑文件。', metadata: { privateTaskWorkspace: true, delegationId: 'manual-delegation', publishCandidate: true, revisionId: 'manual-revision', attachments: [{ id: 'ppt-file', name: '新品发布汇报-v2.pptx', path: ${JSON.stringify(path.join(workspaceRoot, '新品发布汇报-v2.pptx'))} }] } }
    ];
    state.networkDelegationRunsById = {}; state.networkDelegationCommentDrafts = { 'manual-delegation': '请再核对一次所有数字来源' }; state.networkDelegationUBuddyEnabled = { 'manual-delegation': true }; state.networkDelegationMemoryMenuOpen = false;
    state.networkDelegationMemory = { workspaceRoot: ${JSON.stringify(workspaceRoot)}, coordinator: { id: 'memory-coordinator', displayName: '制作新品发布汇报 PPT.md', content: ${JSON.stringify('# 任务更新\n- 已完成第二版')}, decryptionState: 'available', agentName: 'uBuddy' }, executionDocuments: [{ id: 'memory-ppt', displayName: 'PPT 执行记录.md', content: '# 执行记录', decryptionState: 'available', agentName: 'PPT Agent' }] };
    state.attachments = []; state.pptxPluginStatus = { installed: true, available: true };`);
  await forceRender();
  await setState(`
    state.networkDelegationId = 'manual-delegation';
    state.agentDelegations = [{ id: 'manual-delegation', requesterUserId: 'manual-peer', recipientUserId: state.currentUser.id, title: '制作新品发布汇报 PPT', instruction: '生成一份 12 页以内的可编辑 PPT，并附风险清单。', status: 'draft_ready', groupId: 'manual-shared-group', requester: { id: 'manual-peer', displayName: '林然' }, recipient: state.currentUser, metadata: { intakeSummary: '面向管理层，要求中文，并在本周五前完成。', ownerConfirmationRequired: true, executionProgress: { phase: 'delivering', completed: 4, total: 4 } } }];
    state.networkConversationMessages = [{ id: 'delegation-user', role: 'user', content: '请把第二页改成市场规模摘要。', metadata: { privateTaskWorkspace: true, delegationId: 'manual-delegation' } }, { id: 'delegation-answer', role: 'assistant', content: '已完成调整，并生成新版可编辑文件。', metadata: { privateTaskWorkspace: true, delegationId: 'manual-delegation', publishCandidate: true, revisionId: 'manual-revision', attachments: [{ id: 'ppt-file', name: '新品发布汇报-v2.pptx', path: ${JSON.stringify(path.join(workspaceRoot, '新品发布汇报-v2.pptx'))} }] } }];
    state.networkDelegationCommentDrafts = { 'manual-delegation': '请再核对一次所有数字来源' }; state.networkDelegationUBuddyEnabled = { 'manual-delegation': true };
    state.networkDelegationMemory = { workspaceRoot: ${JSON.stringify(workspaceRoot)}, coordinator: { id: 'memory-coordinator', displayName: '制作新品发布汇报 PPT.md', content: ${JSON.stringify('# 任务更新\n- 已完成第二版')}, decryptionState: 'available', agentName: 'uBuddy' }, executionDocuments: [{ id: 'memory-ppt', displayName: 'PPT 执行记录.md', content: '# 执行记录', decryptionState: 'available', agentName: 'PPT Agent' }] };
  `);
  await forceRender(); await waitFor(`document.querySelector('.network-delegation-detail')`);
  await capture('37-delegation-workspace.png', '.network-delegation-private-workspace, .network-delegation-detail');
  await setState(`state.networkDelegationMemoryMenuOpen = true;`); await forceRender();
  await capture('38-delegation-task-memory.png', '.network-delegation-task-memory-menu');

  await setState(`state.agentDelegations = [{ id: 'manual-delegation', title: '制作新品发布汇报 PPT', instruction: '生成一份 12 页以内的可编辑 PPT，并附风险清单。', status: 'submitted', requesterUserId: state.currentUser?.id, recipientUserId: 'manual-peer', requester: state.currentUser, recipient: { id: 'manual-peer', displayName: '林然' }, metadata: { latestResult: '已交付新版 PPT 与风险清单。', resultAttachments: [{ remote_file_id: 'manual-result-file', filename: '新品发布汇报-v2.pptx', size: 48236 }] } }]; state.networkDelegationId = 'manual-delegation'; state.networkDelegationMemoryMenuOpen = false; state.taskWorkspaceViewById = { 'manual-delegation': 'result' };`);
  await forceRender();
  await capture('39-delegation-result-review.png', '.network-delegation-private-workspace, .network-delegation-detail');

  await setState(`state.agentDelegations = [{ id: 'manual-delegation', title: '制作新品发布汇报 PPT', instruction: '生成一份 12 页以内的可编辑 PPT，并附风险清单。', requesterUserId: 'manual-peer', recipientUserId: state.currentUser.id, status: 'blocked', requester: { id: 'manual-peer', displayName: '林然' }, recipient: state.currentUser, metadata: { failureCode: 'ppt_skill_install_required', publicFailure: { code: 'ppt_skill_install_required', stage: 'preflight', message: '当前设备尚未安装 PPT 制作 Skill，PPT Agent 无法执行任务。' } } }]; state.networkDelegationId = 'manual-delegation'; state.pptxPluginStatus = { installed: false, available: true }; state.taskWorkspaceViewById = {};`);
  await forceRender();
  await capture('40-delegation-failure-skill.png', '.network-delegation-private-workspace, .network-delegation-detail');
}

async function captureSettingsAndEvolution() {
  await setState(`state.networkPanelOpen = false; state.currentTab = 'settings'; state.currentSettingsSection = 'ubuddy-profile';
    state.uBuddyFeatureFlags = { ...(state.uBuddyFeatureFlags || {}), profilePreviewV1: true, profileHistory: true, profilePublication: true, organizationEvolutionApplyV1: true };
    state.uBuddyCapabilityProfilePreviewLoading = false; state.uBuddyCapabilityProfilePreview = { source: 'generated', profile: { version: 'profile-v1', introduction: '擅长研究、规划、协作调度与结构化交付', supportedTaskTypes: ['市场研究', '项目规划', '多人协作'], deliverableTypes: ['report', 'document', 'presentation', 'spreadsheet'], capabilityTags: ['研究分析', '任务拆解', '质量复核', '文档交付'], preferredTasks: ['目标和验收标准清晰的复杂任务'], unsupportedTasks: ['需要代替用户做高风险决策的任务'], improvementDirections: ['持续积累行业证据'], collaborationModes: ['直接执行', '多 Agent 调度', '联系人协作'], privacyConstraints: ['不读取未授权私聊、Memory 或附件'], evidenceSummary: '根据当前生效 Skill 的能力声明生成。', sourceEffectiveSkillHash: '0123456789abcdef', generatedAt: '2026-08-16T11:00:00.000Z' } };
    state.uBuddyCapabilityProfileHistoryLoading = false; state.uBuddyCapabilityProfileHistory = { preference: { enabled: true, visibility: 'friends' }, profiles: [{ profileRevision: 3, publicationState: 'active', generationStatus: 'completed', requiresUserConfirmation: true, confirmationReason: '新增演示文稿交付能力。', sourceEffectiveSkillHash: '0123456789abcdef', generatedAt: '2026-08-16T11:00:00.000Z', profile: { introduction: '擅长研究、规划和多 Agent 协作。', capabilityTags: ['研究分析', '任务拆解', '演示文稿'] } }, { profileRevision: 2, publicationState: 'archived', generationStatus: 'completed', sourceEffectiveSkillHash: 'fedcba9876543210', generatedAt: '2026-08-10T11:00:00.000Z', profile: { introduction: '擅长研究和结构化文档。', capabilityTags: ['研究分析', '文档交付'] } }] };`);
  await forceRender(); await waitFor(`document.querySelector('.settings-ubuddy-profile-view')`);
  await capture('41-settings-ubuddy-profile.png', '.settings-ubuddy-profile-view');
  await scrollToSelector('.ubuddy-profile-history-panel');
  await capture('42-settings-profile-history.png', '.ubuddy-profile-history-panel');

  await setState(`state.currentSettingsSection = 'organization-research'; state.activeAccountWorkspace = { id: 'org-workspace', workspaceKind: 'organization', organizationId: 'manual-org' }; state.friendOverview = { ...(state.friendOverview || {}), organizations: [{ id: 'manual-org', name: '演示组织', role: 'owner' }] }; state.organizationResearchPolicy = { policy: { organizationId: 'manual-org', status: 'enabled', enabledAt: '2026-08-01T08:00:00.000Z' } }; state.organizationResearchAudits = { audits: [{ mode: 'online', createdAt: '2026-08-15T10:00:00.000Z', resultCount: 6, queryingUserId: '演示用户', queryHash: 'a1b2c3d4e5f67890' }, { mode: 'offline', createdAt: '2026-08-12T10:00:00.000Z', resultCount: 3, queryingUserId: '演示用户', queryHash: '1122334455667788' }] }; state.organizationResearchLoading = false;`);
  await forceRender();
  await capture('43-settings-organization-research.png', '.settings-organization-research-view');

  await setState(`state.currentTab = 'evolution'; state.evolutionScope = 'agents'; state.evolutionSearchQuery = ''; state.evolution = { agents: [], runs: [], reviews: [], archives: [], skillVersions: [] }; state.uBuddyOrganizationEvolution = { traceCount: 38, activePolicyVersionId: 'policy-v2', policies: [{ policyVersionId: 'policy-v2', stage: 'assignment', summary: '当研究与撰写并行时，优先安排独立复核角色。', evidenceCount: 12, createdAt: '2026-08-15T08:00:00.000Z' }, { policyVersionId: 'policy-v3', stage: 'decomposition', summary: '对包含多个交付格式的任务增加格式级验收节点。', evidenceCount: 9, createdAt: '2026-08-16T08:00:00.000Z' }] };`);
  await forceRender(); await waitFor(`document.querySelector('.ubuddy-organization-evolution')`);
  await capture('44-evolution-organization-policy.png', '.evolution-view');
}

async function captureResponsiveAndDark(sessionId) {
  await setState(`${baseUBuddyState(sessionId)} localStorage.setItem('janus-theme-mode', 'light'); state.currentTab = 'chat';`);
  await setViewport(430, 900); await forceRender();
  await capture('45-mobile-chat-main.png', '.app-shell, body');

  await setState(`state.currentTab = 'chat'; state.collaborationGroupId = 'manual-shared-group'; state.networkPanelOpen = true; state.collaborationPaneByGroupId = { 'manual-shared-group': 'progress' };`);
  await forceRender();
  if (await exists('.collaboration-group-chat-view')) await capture('46-mobile-collaboration.png', '.collaboration-group-chat-view');

  await setViewport(1600, 1000);
  await setState(`${baseUBuddyState(sessionId)} localStorage.setItem('janus-theme-mode', 'dark'); document.documentElement.dataset.theme = 'dark'; state.currentTab = 'chat';`);
  await forceRender();
  await capture('47-dark-chat-main.png', '.conversation-panel');
  await setState(`localStorage.setItem('janus-theme-mode', 'light'); document.documentElement.dataset.theme = 'light';`);
}

async function setState(source) {
  await evaluate(`(async () => { const { state } = await import('./app/state.js'); ${source} })()`);
}

async function forceRender() {
  const viewport = await evaluate(`({ width: innerWidth, height: innerHeight })`);
  const temporaryWidth = viewport.width > 720 ? 700 : 900;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: temporaryWidth, height: viewport.height, deviceScaleFactor: 1, mobile: temporaryWidth <= 600 });
  await sleep(160);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width <= 600 });
  await sleep(360);
}

async function capture(filename, focusSelector = '') {
  await sleep(180);
  const metadata = await evaluate(`(() => {
    const visible = (element) => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0; };
    const roots = ${JSON.stringify(focusSelector)} ? [...document.querySelectorAll(${JSON.stringify(focusSelector)})] : [document];
    const candidates = [...new Set(roots.flatMap((root) => [...root.querySelectorAll('button, summary, [role="button"], [role="menuitem"], input:not([type="hidden"]), textarea, select, a[href]')]))].filter(visible);
    const controls = candidates.slice(0, 80).map((element, index) => { const r = element.getBoundingClientRect(); const label = (element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.getAttribute('placeholder') || element.value || element.tagName).replace(/\\s+/g, ' ').trim().slice(0, 120); return { number: index + 1, label: label || element.tagName, tag: element.tagName.toLowerCase(), disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'), x: Math.max(0, Math.min(100, ((r.left + r.width / 2) / innerWidth) * 100)), y: Math.max(0, Math.min(100, ((r.top + r.height / 2) / innerHeight) * 100)), width: r.width, height: r.height, attributes: Object.fromEntries([...element.attributes].filter((a) => a.name.startsWith('data-') || ['id','type','role'].includes(a.name)).slice(0, 8).map((a) => [a.name, a.value])) }; });
    return { title: document.title, viewport: { width: innerWidth, height: innerHeight }, focusSelector: ${JSON.stringify(focusSelector)}, controls, bodyText: (document.body?.innerText || '').slice(0, 500) };
  })()`);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const filePath = path.join(outputRoot, filename);
  writeFileSync(filePath, Buffer.from(result.data, 'base64'));
  captures.push({ filename, ...metadata });
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed.');
  return result.result?.value;
}

async function exists(selector) {
  return evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`);
}

async function click(selector) {
  const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return null; element.scrollIntoView({ block: 'center', inline: 'center' }); const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }; })()`);
  if (!point || point.width <= 0 || point.height <= 0) throw new Error(`Unable to click selector: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await sleep(250);
}

async function waitFor(expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await sleep(120); }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}

async function scrollToSelector(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', inline: 'nearest' })`);
  await sleep(250);
}

async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 600 });
  await sleep(300);
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/list`); const targets = await response.json(); const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl); if (page) return page; } catch {}
    await sleep(200);
  }
  throw new Error('Timed out waiting for Electron renderer target.');
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl); const pending = new Map(); let nextId = 1;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result || {}); });
  return { send(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }, close() { socket.close(); } };
}

async function stopChild(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  try { if (process.platform !== 'win32' && processHandle.pid) process.kill(-processHandle.pid, 'SIGTERM'); else processHandle.kill('SIGTERM'); } catch {}
  await Promise.race([new Promise((resolve) => processHandle.once('exit', resolve)), sleep(2500)]);
  if (processHandle.exitCode === null) { try { if (process.platform !== 'win32' && processHandle.pid) process.kill(-processHandle.pid, 'SIGKILL'); else processHandle.kill('SIGKILL'); } catch {} }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
