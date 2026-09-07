import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { DataType, newDb } from 'pg-mem';

import { migrate } from '../cloud/src/db.mjs';
import { createApp } from '../cloud/src/server.mjs';
import { createRuntime } from '../src/main/runtime.js';

const projectRoot = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-electron-isolated-ubuddy-'));
const electronBinary = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const fakeCodex = path.join(tempRoot, 'fake-codex.mjs');
const fakeCodexLog = path.join(tempRoot, 'fake-codex-invocations.log');
const useRealCodex = process.env.JANUS_E2E_REAL_CODEX === '1';
const attachmentOnly = process.env.JANUS_E2E_ATTACHMENT_ONLY === '1';
const realCodexBin = process.env.JANUS_E2E_CODEX_BIN || '/usr/bin/codex';
const realCodexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const screenshotDir = String(process.env.JANUS_E2E_SCREENSHOT_DIR || '').trim();
const password = 'Electron-Isolated-uBuddy-Password1!';
const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
memoryDb.public.registerFunction({ name: 'decode', args: [DataType.text, DataType.text], returns: DataType.bytea,
  implementation: (value, format) => Buffer.from(String(value || ''), String(format || 'base64')) });
const { Pool } = memoryDb.adapters.createPg();
const pool = new Pool();
const codes = new Map();
let cloudServer;
let providerServer;
let appA;
let appB;
let carolRuntime;

const fixtures = {
  alice: { email: 'isolated.alice@janus.test', name: 'Alice' },
  bob: { email: 'isolated.bob@janus.test', name: 'Bob' },
  carol: { email: 'isolated.carol@janus.test', name: 'Carol' },
};

writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli electron-isolated-ubuddy-ui-e2e'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]\\n  --listen <URL>'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass', codexVersion: 'electron-isolated-ubuddy-ui-e2e' })); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
const currentUserInput = input.split('Current user message:\\n').at(-1) || '';
fs.appendFileSync(${JSON.stringify(fakeCodexLog)}, JSON.stringify({ cwd: process.cwd(), args, input: input.slice(0, 2000) }) + '\\n');
if (currentUserInput.includes('FORCE_UBUDDY_UI_WORKSPACE_FAILURE') && !input.includes('【UBUDDY_WORKSPACE_INTENT_V1】')) {
  console.error('simulated private workspace execution failure at /path/to/private/codex');
  process.exit(2);
}
if (input.includes('【好友秘书 Agent 委托任务】')) {
  fs.writeFileSync('ubuddy-private-draft.md', '# uBuddy private draft\\n\\n隔离 UI E2E 自动生成的可编辑初稿。\\n', 'utf8');
}
let answer = 'UBUDDY_UI_PRIVATE_DRAFT_OK：已整理初稿、待补充材料和待确认细节。';
if (input.includes('【UBUDDY_WORKSPACE_INTENT_V1】')) {
  const workspaceIntentInput = (input.split('用户本次输入：').at(-1) || '').split('\\n')[0];
  answer = JSON.stringify({
    intent: workspaceIntentInput.includes('就采用你刚刚完成的正确版本，分享给大家') ? 'submit' : 'execute',
    reason: '根据私人任务上下文判断操作意图。',
  });
} else if (input.includes('【UBUDDY_DELEGATION_PROCESSING_V1】') && input.includes('第二次任务更新')) {
  answer = JSON.stringify({ title: '第二次任务更新', content: '第二次任务更新：流程图需要增加风险、负责人和截止日期。' });
} else if (input.includes('【UBUDDY_DELEGATION_PROCESSING_V1】') && input.includes('发布方私有更新')) {
  answer = JSON.stringify({ title: '发布方私有更新', content: '发布方私有更新：请新增一页本周时间线；尚未确认同步前，不得让 Bob 或任务群看到。' });
} else if (input.includes('【UBUDDY_DELEGATION_PROCESSING_V1】') && input.includes('让2840213075绘制一份关于408的考纲给我')) {
  answer = JSON.stringify({
    title: '绘制 408 考纲',
    content: '请根据计算机考研 408 的范围绘制一份结构清晰、便于复习的考纲，覆盖数据结构、计算机组成原理、操作系统和计算机网络。',
  });
} else if (input.includes('【UBUDDY_DELEGATION_PROCESSING_V1】')) {
  answer = JSON.stringify({
    title: '近期工作汇报与流程图',
    content: '请 Bob 汇报近期工作，制作一份可编辑的工作流程图，并列出风险、待确认事项和下一步计划。',
  });
} else if (input.includes('时间线') || input.includes('修改')) {
  answer = 'UBUDDY_UI_REVISION_OK：已根据意见更新初稿，并保留可编辑结构。';
}
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
if (outputPath) fs.writeFileSync(outputPath, answer, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'session_meta', payload: { session_id: 'electron-isolated-ubuddy-thread' } }));
  console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: answer } }));
  console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: answer } }));
}
`);
chmodSync(fakeCodex, 0o755);

try {
  assert.ok(existsSync(electronBinary), `Electron binary not found: ${electronBinary}`);
  if (useRealCodex) assertRealCodexAvailable();
  await migrate(pool);
  const app = createApp({
    pool,
    config: {
      jwtSecret: 'electron-isolated-ubuddy-ui-jwt-secret-long-enough',
      emailCodeSecret: 'electron-isolated-ubuddy-ui-code-secret-long-enough',
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlDays: 30,
      emailCodeTtlMinutes: 10,
      env: { JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY: '1' },
    },
    mailer: {
      async sendEmailCode({ email, code, purpose }) {
        codes.set(`${email.toLowerCase()}:${purpose}`, code);
      },
    },
  });
  cloudServer = await listen(app);
  const authUrl = `http://127.0.0.1:${cloudServer.address().port}`;

  const accounts = {};
  for (const [key, fixture] of Object.entries(fixtures)) accounts[key] = await registerCloudAccount(authUrl, fixture);
  accounts.bob = await updateProfile(authUrl, accounts.bob, { username: '2840213075' });

  process.env.JANUS_AUTH_URL = authUrl;
  process.env.JANUS_CODEX_BIN = useRealCodex ? realCodexBin : fakeCodex;
  process.env.JANUS_MODEL_REFRESH_ENABLED = '0';
  process.env.JANUS_CLOUD_AUTO_SYNC_ENABLED = '0';
  process.env.JANUS_LOCAL_EVOLUTION_ENABLED = '0';
  process.env.JANUS_UPDATES_ENABLED = '0';
  const carolRoot = path.join(tempRoot, 'carol-runtime');
  if (useRealCodex) seedRealCodexConfig(carolRoot);
  carolRuntime = await createRuntime({ root: carolRoot, isDev: true });
  await carolRuntime.authLogin({ identifier: fixtures.carol.email, password });

  appA = await launchElectron('alice', 9611, authUrl);
  appB = await launchElectron('bob', 9612, authUrl);
  await loginThroughUi(appA.cdp, fixtures.alice);
  await loginThroughUi(appB.cdp, fixtures.bob);

  await addFriendThroughUi(appA.cdp, appB.cdp, accounts.bob.user, fixtures.bob.email, 'Alice 请求添加 Bob，用于隔离 UI 链路测试。');
  await addFriendToRuntimeThroughUi(appA.cdp, carolRuntime, accounts.carol, fixtures.carol.email, authUrl);

  await openFriendChat(appA.cdp, accounts.bob.user.id);
  const directUi = await evaluate(appA.cdp, `({
    direct: Boolean(document.querySelector('.direct-social-panel')),
    taskGroup: Boolean(document.querySelector('.collaboration-group-chat-view')),
    participants: document.querySelectorAll('.social-group-participants .social-participant').length,
    mention: Boolean(document.querySelector('[data-social-mention-toggle]')),
  })`);
  assert.deepEqual(directUi, { direct: true, taskGroup: false, participants: 0, mention: true });
  await submitMainChat(appA.cdp, 'Alice 与 Bob 的隔离云双人聊天消息，不应创建任务群。');
  await waitForSql(`SELECT id FROM social_messages WHERE sender_user_id = $1 AND recipient_user_id = $2 AND content = $3`, [accounts.alice.user.id, accounts.bob.user.id, 'Alice 与 Bob 的隔离云双人聊天消息，不应创建任务群。']);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM collaboration_groups')).rows[0].count), 0);
  const directAttachmentName = 'ui-direct-shared-attachment.txt';
  const directAttachmentBytes = Buffer.from('UI_DIRECT_SHARED_ATTACHMENT_OK\n', 'utf8');
  const directAttachmentMessage = 'Alice 通过真实 UI 分享私聊附件。';
  await dropFileIntoComposer(appA.cdp, { name: directAttachmentName, contentType: 'text/plain', data: directAttachmentBytes });
  await waitFor(appA.cdp, `Array.from(document.querySelectorAll('.attachment-chip strong')).some((item) => item.textContent === ${JSON.stringify(directAttachmentName)})`, 30_000);
  await submitMainChat(appA.cdp, directAttachmentMessage);
  const directAttachmentRow = await waitForSql(
    'SELECT * FROM social_messages WHERE sender_user_id = $1 AND recipient_user_id = $2 AND content = $3',
    [accounts.alice.user.id, accounts.bob.user.id, directAttachmentMessage],
  );
  const directAttachmentMetadata = typeof directAttachmentRow.metadata_json === 'string'
    ? JSON.parse(directAttachmentRow.metadata_json || '{}')
    : directAttachmentRow.metadata_json || {};
  const directAttachment = directAttachmentMetadata.attachments?.[0];
  assert.ok(directAttachment?.remote_file_id);
  assert.equal(directAttachment.remote_file_kind, 'social');
  assert.equal(Boolean(directAttachment.path || directAttachment.source_path || directAttachment.sourcePath), false);
  await clickSelector(appB.cdp, '[data-network-view="messages"]');
  await clickSelector(appB.cdp, `[data-network-peer="${accounts.alice.user.id}"]`, 30_000);
  await waitFor(appB.cdp, `document.querySelector('.direct-social-panel #chat-form')`);
  await waitFor(appB.cdp, `document.querySelector('#message-list')?.textContent.includes('隔离云双人聊天消息')`, 30_000);
  await waitFor(appB.cdp, `Array.from(document.querySelectorAll('.direct-social-panel .message-attachment-card')).some((item) => item.textContent.includes(${JSON.stringify(directAttachmentName)}))`, 30_000);
  await clickMessageAttachmentPreview(appB.cdp, directAttachmentName, '.direct-social-panel');
  const directDownloadedPath = path.join(
    tempRoot, 'bob', 'runtime', 'data', 'collaboration-downloads', accounts.bob.user.id,
    directAttachment.remote_file_id, directAttachmentName,
  );
  await waitForLocalFile(directDownloadedPath, 30_000);
  const directCloudFile = (await pool.query('SELECT data FROM social_message_files WHERE id = $1', [directAttachment.remote_file_id])).rows[0];
  assert.deepEqual(readFileSync(directDownloadedPath), Buffer.from(directCloudFile.data));
  await waitFor(appB.cdp, `document.querySelector('.preview-overlay')`, 30_000);
  await clickSelector(appB.cdp, '#close-preview-btn');
  await captureScreenshot(appA.cdp, '01-isolated-direct-chat.png');

  if (attachmentOnly) {
    const createdGroup = await jsonRequest(`${authUrl}/api/collaboration/groups`, {
      method: 'POST',
      token: accounts.alice.accessToken,
      body: {
        title: '真实 UI 附件共享验证群',
        clientRequestId: `attachment-ui-${Date.now()}`,
        assignments: [{ recipientId: accounts.bob.user.id, title: '附件共享验证', instruction: '仅用于验证群成员附件访问权限。' }],
      },
    });
    const group = createdGroup.group;
    await openCollaborationGroup(appA.cdp, group.id);
    const groupAttachmentName = 'ui-group-shared-attachment.txt';
    const groupAttachmentBytes = Buffer.from('UI_GROUP_SHARED_ATTACHMENT_OK\n', 'utf8');
    const groupAttachmentMessage = 'Alice 通过真实 UI 分享任务群附件。';
    await dropFileIntoComposer(appA.cdp, { name: groupAttachmentName, contentType: 'text/plain', data: groupAttachmentBytes });
    await waitFor(appA.cdp, `Array.from(document.querySelectorAll('.attachment-chip strong')).some((item) => item.textContent === ${JSON.stringify(groupAttachmentName)})`, 30_000);
    await submitMainChat(appA.cdp, groupAttachmentMessage);
    const groupAttachmentRow = await waitForSql(
      'SELECT * FROM collaboration_group_messages WHERE group_id = $1 AND sender_user_id = $2 AND content = $3',
      [group.id, accounts.alice.user.id, groupAttachmentMessage],
    );
    const groupAttachmentMetadata = typeof groupAttachmentRow.metadata_json === 'string'
      ? JSON.parse(groupAttachmentRow.metadata_json || '{}')
      : groupAttachmentRow.metadata_json || {};
    const groupAttachment = groupAttachmentMetadata.attachments?.[0];
    assert.ok(groupAttachment?.remote_file_id);
    assert.equal(groupAttachment.remote_file_kind, 'collaboration_group');
    assert.equal(groupAttachment.group_id, group.id);
    assert.equal(Boolean(groupAttachment.path || groupAttachment.source_path || groupAttachment.sourcePath), false);
    await assert.rejects(
      () => carolRuntime.collaborationDownloadFile({
        fileId: groupAttachment.remote_file_id,
        filename: groupAttachment.filename,
        sha256: groupAttachment.sha256,
        remoteFileKind: groupAttachment.remote_file_kind,
        groupId: group.id,
      }),
      (error) => Number(error?.status || 0) === 404,
    );
    await openCollaborationGroup(appB.cdp, group.id);
    await waitFor(appB.cdp, `Array.from(document.querySelectorAll('.collaboration-group-chat-view .message-attachment-card')).some((item) => item.textContent.includes(${JSON.stringify(groupAttachmentName)}))`, 30_000);
    await clickMessageAttachmentPreview(appB.cdp, groupAttachmentName, '.collaboration-group-chat-view');
    const bobGroupDownload = path.join(
      tempRoot, 'bob', 'runtime', 'data', 'collaboration-downloads', accounts.bob.user.id,
      groupAttachment.remote_file_id, groupAttachmentName,
    );
    await waitForLocalFile(bobGroupDownload, 30_000);
    const groupCloudFile = (await pool.query('SELECT data FROM social_message_files WHERE id = $1', [groupAttachment.remote_file_id])).rows[0];
    assert.deepEqual(readFileSync(bobGroupDownload), Buffer.from(groupCloudFile.data));
    await waitFor(appB.cdp, `document.querySelector('.preview-overlay')`, 30_000);
    await captureScreenshot(appB.cdp, '02-attachment-group-member-preview.png');
    await clickSelector(appB.cdp, '#close-preview-btn');
    await jsonRequest(`${authUrl}/api/collaboration/groups/${group.id}`, {
      method: 'PATCH',
      token: accounts.alice.accessToken,
      body: {
        action: 'add_member',
        userId: accounts.carol.user.id,
        assignment: { title: '附件历史访问验证', instruction: '验证新加入成员可以访问群内历史附件。' },
      },
    });
    await carolRuntime.pollSocialNetwork({ autoProcess: false });
    const carolGroupDownload = await carolRuntime.collaborationDownloadFile({
      fileId: groupAttachment.remote_file_id,
      filename: groupAttachment.filename,
      sha256: groupAttachment.sha256,
      remoteFileKind: groupAttachment.remote_file_kind,
      groupId: group.id,
    });
    assert.deepEqual(readFileSync(carolGroupDownload.path), groupAttachmentBytes);
    await captureScreenshot(appA.cdp, '03-attachment-group-sender.png');
    console.log(JSON.stringify({
      ok: true,
      attachmentOnly: true,
      realElectronUi: true,
      isolatedCloud: true,
      productionCloudTouched: false,
      electronInstances: 2,
      databaseAccounts: 3,
      groupId: group.id,
      checks: [
        'ui_direct_drag_upload', 'ui_direct_recipient_preview_download', 'direct_metadata_has_no_local_path',
        'ui_group_drag_upload', 'ui_group_existing_member_preview_download', 'group_metadata_has_no_local_path',
        'group_non_member_denied', 'group_new_member_historical_attachment_download',
      ],
    }));
  } else {
  await stopElectron(appB);
  appB = null;

  await clickSelector(appA.cdp, '[data-network-peer="self-secretary"]');
  await waitFor(appA.cdp, `document.querySelector('.composer.is-ubuddy-mode') && document.querySelector('[data-social-mention-toggle]')`, 30_000);
  await clickSelector(appA.cdp, '[data-social-mention-toggle]');
  await clickSelector(appA.cdp, `[data-ubuddy-mention-user="${accounts.bob.user.id}"]`);
  await submitMainChat(appA.cdp, '@Bob 让2840213075绘制一份关于408的考纲给我');
  await waitFor(appA.cdp, `document.querySelector('.private-dispatch-draft')`, useRealCodex ? 900_000 : 60_000);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM collaboration_groups')).rows[0].count), 0, 'draft must not publish before UI confirmation');
  const dispatchUi = await evaluate(appA.cdp, `(() => {
    const draft = document.querySelector('.private-dispatch-draft');
    return {
      title: draft?.querySelector('#collaboration-draft-title')?.value || '',
      instruction: draft?.querySelector('#collaboration-draft-instruction')?.value || '',
      participants: draft?.querySelectorAll('[data-collaboration-draft-participant]:checked').length || 0,
      confirm: Boolean(draft?.querySelector('[data-collaboration-draft-confirm]')),
      revise: Boolean(draft?.querySelector('[data-collaboration-draft-revise]')),
      noGeneralAgentRoute: !document.body.textContent.includes('通用 Agent'),
    };
  })()`);
  assert.ok(dispatchUi.title && dispatchUi.confirm && dispatchUi.revise);
  assert.match(dispatchUi.title, /408/);
  assert.match(dispatchUi.instruction, /408/);
  assert.equal(dispatchUi.participants, 1);
  assert.equal(dispatchUi.noGeneralAgentRoute, true);
  await appA.cdp.send('Page.enable');
  await appA.cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(appA.cdp, `document.querySelector('.account-avatar') && !document.querySelector('#login-form')`, 30_000);
  await clickSelector(appA.cdp, '[data-network-view="messages"]');
  await clickSelector(appA.cdp, '[data-network-peer="self-secretary"]');
  await waitFor(appA.cdp, `document.querySelector('.private-dispatch-draft')?.textContent.includes('408')`, 30_000);
  const uBuddySessionBeforeReturn = await evaluate(appA.cdp, `window.janus.listSessions().then((items) => items.find((item) => item.departmentId === 'secretary_department'))`);
  await clickSelector(appA.cdp, '[data-tab="employees"]');
  await waitFor(appA.cdp, `document.querySelector('.talent-directory-view')`, 30_000);
  await clickSelector(appA.cdp, '[data-network-view="messages"]');
  await clickSelector(appA.cdp, '[data-network-peer="self-secretary"]');
  await waitFor(appA.cdp, `document.querySelector('.private-dispatch-draft') && document.body.textContent.includes('408')`, 30_000);
  const uBuddySessionAfterReturn = await evaluate(appA.cdp, `window.janus.listSessions().then((items) => ({ current: items.find((item) => item.departmentId === 'secretary_department'), count: items.filter((item) => item.departmentId === 'secretary_department' && item.writeState !== 'read_only').length }))`);
  assert.equal(uBuddySessionAfterReturn.current?.id, uBuddySessionBeforeReturn?.id);
  assert.equal(uBuddySessionAfterReturn.count, 1);
  await clickSelector(appA.cdp, '[data-composer-memory-toggle]');
  await waitFor(appA.cdp, `document.querySelector('.composer-memory-menu')`, 30_000);
  const memoryUi = await evaluate(appA.cdp, `({
    checkpoint: Boolean(document.querySelector('[data-composer-memory-checkpoint]')),
    create: Boolean(document.querySelector('[data-composer-memory-create]')),
    current: document.querySelector('.composer-memory-trigger')?.textContent || '',
  })`);
  assert.ok(memoryUi.checkpoint && memoryUi.create && /memory\d+\.md|Memory/.test(memoryUi.current));
  await clickSelector(appA.cdp, '[data-composer-memory-toggle]');
  await captureScreenshot(appA.cdp, '02-isolated-private-dispatch-draft.png');
  await clickSelector(appA.cdp, '[data-collaboration-draft-confirm]', useRealCodex ? 900_000 : 60_000);
  await evaluate(appA.cdp, `new Promise((resolve) => setTimeout(resolve, 500))`);
  const publishStart = await evaluate(appA.cdp, `({
    confirmDisabled: Boolean(document.querySelector('[data-collaboration-draft-confirm]')?.disabled),
    draftVisible: Boolean(document.querySelector('.private-dispatch-draft')),
    notice: document.querySelector('.notice, [role="alert"]')?.textContent || '',
  })`);
  if (publishStart.notice.includes('发布任务失败')) {
    throw new Error(`uBuddy draft publish failed immediately: ${JSON.stringify(publishStart)}`);
  }

  let group;
  try {
    group = await waitForSql('SELECT * FROM collaboration_groups WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 1', [accounts.alice.user.id], 60_000);
  } catch (error) {
    const snapshot = await evaluate(appA.cdp, `({
      confirmDisabled: Boolean(document.querySelector('[data-collaboration-draft-confirm]')?.disabled),
      draftVisible: Boolean(document.querySelector('.private-dispatch-draft')),
      selectedParticipants: document.querySelectorAll('[data-collaboration-draft-participant]:checked').length,
      notice: document.querySelector('.notice, [role="alert"]')?.textContent || '',
      body: (document.body?.innerText || '').slice(-1600),
    })`);
    throw new Error(`Confirmed uBuddy draft did not create a collaboration group: ${JSON.stringify(snapshot)}`, { cause: error });
  }
  const bobTask = await waitForSql('SELECT * FROM agent_delegations WHERE group_id = $1 AND recipient_user_id = $2', [group.id, accounts.bob.user.id], 60_000);
  assert.equal(group.status, 'active');

  await openTaskDetail(appA.cdp, group.id, bobTask.id);
  const outgoingUi = await evaluate(appA.cdp, `(() => {
    const composerRect = document.querySelector('#network-delegation-comment-form')?.getBoundingClientRect();
    const panelRect = document.querySelector('.network-delegation-detail')?.getBoundingClientRect();
    return ({
    privateWorkspace: Boolean(document.querySelector('.network-delegation-private-workspace')),
    workspaceHeadingRemoved: !document.querySelector('.network-delegation-discussion-head'),
    originalRequest: document.querySelector('.network-delegation-ingress')?.textContent.includes('原始任务要求'),
    composer: Boolean(document.querySelector('#network-delegation-comment-form')),
    composerMatchesMain: Boolean(document.querySelector('#network-delegation-comment-form.compact-composer .model-trigger')),
    composerMeta: Boolean(document.querySelector('.network-delegation-meta-bar')),
    taskMemoryTrigger: document.querySelector('[data-delegation-memory-toggle]')?.textContent || '',
    taskWorkspaceAction: Boolean(document.querySelector('[data-delegation-workspace-open]')),
    composerWide: Boolean(composerRect && panelRect && composerRect.width >= Math.min(760, panelRect.width * 0.72)),
    panelPlusCount: document.querySelectorAll('.network-panel.is-conversation-open .composer-plus').length,
    publishButtonsRemoved: !document.querySelector('[data-delegation-publish-draft], [data-delegation-continue-editing]'),
    visibleMention: Array.from(document.querySelectorAll('[data-social-mention-toggle]')).some((item) => {
      const style = getComputedStyle(item); const rect = item.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }),
  }); })()`);
  assert.ok(outgoingUi.privateWorkspace && outgoingUi.workspaceHeadingRemoved && outgoingUi.originalRequest && outgoingUi.composer && outgoingUi.publishButtonsRemoved);
  assert.ok(outgoingUi.composerMatchesMain && outgoingUi.composerMeta && outgoingUi.taskWorkspaceAction && outgoingUi.composerWide);
  assert.match(outgoingUi.taskMemoryTrigger, /\.md/);
  assert.equal(outgoingUi.panelPlusCount, 1);
  assert.equal(outgoingUi.visibleMention, false);
  await clickSelector(appA.cdp, '[data-delegation-memory-toggle]');
  await waitFor(appA.cdp, `document.querySelector('.network-delegation-task-memory-menu')`, 30_000);
  const taskMemoryUi = await evaluate(appA.cdp, `({
    heading: document.querySelector('.network-delegation-task-memory-menu')?.textContent || '',
    coordinator: Boolean(document.querySelector('.network-delegation-memory-document')),
    api: null,
  })`);
  const taskMemoryApi = await evaluate(appA.cdp, `window.janus.delegationTaskMemory({ delegationId: ${JSON.stringify(bobTask.id)} })`);
  assert.match(taskMemoryUi.heading, /本任务独立 Memory/);
  assert.equal(taskMemoryUi.coordinator, true);
  assert.equal(taskMemoryApi.coordinator?.scope, 'task');
  assert.equal(taskMemoryApi.coordinator?.delegationId, bobTask.id);
  await captureScreenshot(appA.cdp, '02b-isolated-task-memory-composer.png');
  await clickSelector(appA.cdp, '[data-delegation-memory-toggle]');
  const privateUpdate = '发布方私有更新：请新增一页本周时间线；尚未确认同步前，不得让 Bob 或任务群看到。';
  await submitDelegationComment(appA.cdp, privateUpdate);
  await waitFor(appA.cdp, `Array.from(document.querySelectorAll('.network-delegation-update')).some((item) => item.textContent.includes(${JSON.stringify(privateUpdate)}))`, useRealCodex ? 900_000 : 90_000);
  await waitFor(appA.cdp, `Array.from(document.querySelectorAll('.network-delegation-update.agent')).some((item) => item.textContent.includes('提交到任务群'))`, useRealCodex ? 900_000 : 90_000);
  const privateTimelineUi = await evaluate(appA.cdp, `(() => {
    const workspace = document.querySelector('.network-delegation-private-workspace');
    const mine = workspace?.querySelector('.network-delegation-update.mine');
    const agent = workspace?.querySelector('.network-delegation-update.agent');
    const mineRect = mine?.getBoundingClientRect();
    const agentRect = agent?.getBoundingClientRect();
    const actors = Array.from(workspace?.querySelectorAll('.network-delegation-update-head strong') || []).map((item) => item.textContent.trim());
    const messageBodies = Array.from(workspace?.querySelectorAll('.network-delegation-message-bubble') || []).map((item) => item.textContent.trim()).filter(Boolean);
    return {
      sameLeftAxis: Boolean(mineRect && agentRect && Math.abs(mineRect.left - agentRect.left) < 4),
      actors,
      duplicateBodyCount: messageBodies.length - new Set(messageBodies).size,
      pseudoIntro: Boolean(workspace?.querySelector('.ubuddy-intro, .ubuddy-preliminary')),
      generatedFiles: Array.from(workspace?.querySelectorAll('.network-delegation-file-block') || []).length,
    };
  })()`);
  assert.equal(privateTimelineUi.sameLeftAxis, true);
  assert.equal(privateTimelineUi.actors.includes('我的 uBuddy'), true);
  assert.equal(privateTimelineUi.actors.includes('我'), false);
  assert.equal(privateTimelineUi.actors.some((actor) => actor !== '我的 uBuddy'), true);
  assert.equal(privateTimelineUi.duplicateBodyCount, 0);
  assert.equal(privateTimelineUi.pseudoIntro, false);
  assert.equal(privateTimelineUi.generatedFiles, 0, 'ordinary requester update generated a file');
  const privateUpdatePattern = `%${privateUpdate}%`;
  const groupLeakBeforeSync = await pool.query('SELECT count(*) AS count FROM collaboration_group_messages WHERE group_id = $1 AND content LIKE $2', [group.id, privateUpdatePattern]);
  const bobLeakBeforeSync = await pool.query('SELECT count(*) AS count FROM agent_delegation_workspace_messages WHERE delegation_id = $1 AND user_id = $2 AND content LIKE $3', [bobTask.id, accounts.bob.user.id, privateUpdatePattern]);
  assert.equal(Number(groupLeakBeforeSync.rows[0].count), 0);
  assert.equal(Number(bobLeakBeforeSync.rows[0].count), 0);
  await submitDelegationComment(appA.cdp, '提交到任务群');
  await waitForSql(`SELECT * FROM agent_delegation_revisions WHERE delegation_id = $1 AND action = 'update_requirements' AND revision_no = 1`, [bobTask.id], 60_000);

  if (!useRealCodex) {
    const requesterFileRequest = '请生成一份 Markdown 需求说明文件，作为我自己的私有参考材料。';
    await submitDelegationComment(appA.cdp, requesterFileRequest);
    await waitFor(appA.cdp, `Boolean(document.querySelector('.network-delegation-file-block .message-attachment-card'))`, 120_000);
    assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM collaboration_group_messages WHERE group_id = $1 AND content LIKE '%私有参考材料%'`, [group.id])).rows[0].count), 0);

    const secondPrivateUpdate = '第二次任务更新：流程图需要增加风险、负责人和截止日期。';
    const agentCountBeforeSecondUpdate = await evaluate(appA.cdp, `document.querySelectorAll('.network-delegation-update.agent').length`);
    await submitDelegationComment(appA.cdp, secondPrivateUpdate);
    await waitFor(appA.cdp, `document.querySelectorAll('.network-delegation-update.agent').length > ${agentCountBeforeSecondUpdate} && Array.from(document.querySelectorAll('.network-delegation-update.agent')).at(-1)?.textContent.includes('提交到任务群')`, 90_000);
    await submitDelegationComment(appA.cdp, '提交到任务群');
    await waitForSql(
      `SELECT * FROM agent_delegation_revisions
       WHERE delegation_id = $1 AND action = 'update_requirements' AND revision_no = 2`,
      [bobTask.id],
      60_000,
    );
  }
  const publishedGroupMessage = await waitForSql(
    `SELECT * FROM collaboration_group_messages
     WHERE group_id = $1
       AND metadata_json->>'action' = 'update_requirements'
       AND metadata_json->>'delegationId' = $2
     ORDER BY created_at DESC LIMIT 1`,
    [group.id, bobTask.id],
    60_000,
  );
  const sharedPublishedContent = String(publishedGroupMessage.content || '').trim();
  assert.ok(sharedPublishedContent, 'confirmed private draft produced an empty public requirement update');
  const updateRevisionCount = Number((await pool.query(`SELECT count(*) AS count FROM agent_delegation_revisions WHERE delegation_id = $1 AND action = 'update_requirements'`, [bobTask.id])).rows[0].count);
  assert.equal(updateRevisionCount, useRealCodex ? 1 : 2);
  await waitForSql(
    `SELECT * FROM agent_delegation_workspace_messages
     WHERE delegation_id = $1 AND user_id = $2
       AND metadata_json->>'action' = 'update_requirements'`,
    [bobTask.id, accounts.bob.user.id],
    60_000,
  );
  await clickSelector(appA.cdp, '[data-task-card-action="return_to_source_chat"]');
  await waitFor(appA.cdp, `document.querySelector('.collaboration-group-chat-view') && !document.querySelector('.network-tasks')`, 30_000);

  appB = await launchElectron('bob', 9612, authUrl);
  await waitFor(appB.cdp, `!document.querySelector('[data-network-view="tasks"]')`, 30_000);

  await openTaskDetail(appB.cdp, group.id, bobTask.id);
  await waitFor(appB.cdp, `document.querySelector('.network-delegation-private-workspace')?.textContent.includes(${JSON.stringify(sharedPublishedContent)})`, 60_000);
  await waitFor(appB.cdp, `document.querySelector('.network-delegation-private-workspace .network-delegation-update.agent')`, useRealCodex ? 900_000 : 120_000);
  const incomingUi = await evaluate(appB.cdp, `(() => {
    const workspace = document.querySelector('.network-delegation-private-workspace');
    const ingress = workspace?.querySelector('.network-delegation-ingress');
    const workspaceRect = workspace?.getBoundingClientRect();
    const ingressRect = ingress?.getBoundingClientRect();
    return {
      privateWorkspace: Boolean(workspace),
      workspaceHeadingRemoved: !document.querySelector('.network-delegation-discussion-head'),
      originalRequest: ingress?.textContent.includes('原始任务要求'),
      initialProduct: Boolean(workspace?.querySelector('.network-delegation-update.agent')),
      syncedUpdate: workspace?.textContent.includes(${JSON.stringify(sharedPublishedContent)}),
      ingress: Boolean(ingress),
      ingressCentered: Boolean(workspaceRect && ingressRect && Math.abs((workspaceRect.left + workspaceRect.width / 2) - (ingressRect.left + ingressRect.width / 2)) < 32),
      namedSelfActor: Array.from(workspace?.querySelectorAll('.network-delegation-update-head strong') || []).some((item) => !['我', '我的 uBuddy'].includes(item.textContent.trim())),
      genericSelfActor: Array.from(workspace?.querySelectorAll('.network-delegation-update-head strong') || []).some((item) => item.textContent.trim() === '我'),
      publishButtonsRemoved: !workspace?.querySelector('[data-delegation-publish-draft], [data-delegation-continue-editing]'),
      panelPlusCount: document.querySelectorAll('.network-panel.is-conversation-open .composer-plus').length,
      visibleMention: Array.from(document.querySelectorAll('[data-social-mention-toggle]')).some((item) => {
        const style = getComputedStyle(item); const rect = item.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }),
    };
  })()`);
  assert.ok(incomingUi.privateWorkspace && incomingUi.workspaceHeadingRemoved && incomingUi.originalRequest && incomingUi.initialProduct && incomingUi.syncedUpdate && incomingUi.ingress && incomingUi.ingressCentered && incomingUi.publishButtonsRemoved);
  assert.equal(incomingUi.namedSelfActor, true);
  assert.equal(incomingUi.genericSelfActor, false);
  assert.equal(incomingUi.panelPlusCount, 1);
  assert.equal(incomingUi.visibleMention, false);
  const coveredOfflineResponseCount = Number((await pool.query(`SELECT count(*) AS count FROM agent_delegation_workspace_messages WHERE delegation_id = $1 AND user_id = $2 AND metadata_json->>'type' = 'ubuddy_ingress_response'`, [bobTask.id, accounts.bob.user.id])).rows[0].count);
  assert.equal(coveredOfflineResponseCount, 0, 'offline updates covered by the initial draft generated duplicate uBuddy update summaries');
  await captureScreenshot(appB.cdp, '03-isolated-recipient-private-workspace.png');

  if (!useRealCodex) {
    await submitDelegationComment(appB.cdp, 'FORCE_UBUDDY_UI_WORKSPACE_FAILURE：继续完成当前任务。');
    await waitForSql(`SELECT * FROM agent_delegations WHERE id = $1 AND status = 'blocked'`, [bobTask.id], 60_000);
    await waitFor(appB.cdp, `document.querySelector('.network-delegation-private-workspace')?.textContent.includes('任务尚未完成')`, 60_000);
    const failureUi = await evaluate(appB.cdp, `(() => {
      const text = document.querySelector('.network-delegation-private-workspace')?.textContent || '';
      const pageText = document.body.textContent || '';
      return {
        blocked: /受阻|blocked/i.test(pageText),
        honestFailure: /任务尚未完成/.test(text) && /初稿就绪/.test(text),
        leakedRuntime: /Process timed out|执行记录|\\/home\\/|\\/usr\\/|codex-linux|node_modules/i.test(text),
        duplicateFailure: (text.match(/任务尚未完成/g) || []).length,
        excerpt: text.slice(-500),
      };
    })()`);
    assert.ok(failureUi.honestFailure, JSON.stringify(failureUi));
    assert.equal(failureUi.leakedRuntime, false);
    assert.equal(failureUi.duplicateFailure, 1);
    const rendererTasksAfterFailure = await evaluate(appB.cdp, `window.janus.listAgentDelegations({ direction: 'all' })`);
    assert.equal(rendererTasksAfterFailure.find((item) => item.id === bobTask.id)?.status, 'blocked');
    await openTaskDetail(appB.cdp, group.id, bobTask.id);
    await submitDelegationComment(appB.cdp, '修改方向：继续完成当前任务，并交付最终可提交结果。');
    await waitForSql(`SELECT * FROM agent_delegations WHERE id = $1 AND status = 'draft_ready'`, [bobTask.id], 60_000);
    await waitFor(appB.cdp, `document.querySelector('.network-delegation-private-workspace')?.textContent.includes('UBUDDY_UI_REVISION_OK')`, 60_000);
  }

  await submitDelegationComment(appB.cdp, useRealCodex ? '提交到任务群' : '就采用你刚刚完成的正确版本，分享给大家');
  const submittedGroupResult = await waitForSql(
    `SELECT * FROM collaboration_group_messages
     WHERE group_id = $1 AND metadata_json->>'action' = 'submit' AND metadata_json->>'delegationId' = $2`,
    [group.id, bobTask.id],
    60_000,
  );
  if (!useRealCodex) {
    assert.match(submittedGroupResult.content, /UBUDDY_UI_REVISION_OK/);
    assert.doesNotMatch(submittedGroupResult.content, /任务尚未完成|初稿就绪|Process timed out|执行记录/);
  }
  const submittedMetadata = typeof submittedGroupResult.metadata_json === 'string'
    ? JSON.parse(submittedGroupResult.metadata_json || '{}')
    : submittedGroupResult.metadata_json || {};
  const submittedAttachment = (submittedMetadata.attachments || []).find((item) => /\.md$/i.test(item.filename || item.name || ''))
    || (submittedMetadata.attachments || [])[0];
  assert.ok(submittedAttachment?.remote_file_id, 'submitted group result did not include a remotely downloadable file');
  assert.equal(Boolean(submittedAttachment.path || submittedAttachment.source_path || submittedAttachment.sourcePath), false);
  const submittedRevisionCount = Number((await pool.query(`SELECT count(*) AS count FROM agent_delegation_revisions WHERE delegation_id = $1 AND action = 'submit'`, [bobTask.id])).rows[0].count);
  assert.equal(submittedRevisionCount, 1);
  await captureScreenshot(appB.cdp, '03b-isolated-recipient-private-workspace-delivered.png');

  const peerPrivateFileName = 'bob-private-never-published.pptx';
  await pool.query(
    `INSERT INTO agent_delegation_workspace_messages (id, delegation_id, user_id, role, content, metadata_json)
     VALUES ($1, $2, $3, 'assistant', $4, $5::jsonb)`,
    ['workspace_peer_private_file', bobTask.id, accounts.bob.user.id, 'Bob 私有未发布产物', JSON.stringify({ privateTaskWorkspace: true, attachments: [{ id: 'peer_private_file', name: peerPrivateFileName }] })],
  );
  await openTaskDetail(appA.cdp, group.id, bobTask.id);
  assert.equal(await evaluate(appA.cdp, `document.querySelector('.network-delegation-private-workspace')?.textContent.includes(${JSON.stringify(peerPrivateFileName)})`), false);

  await openCollaborationGroup(appA.cdp, group.id);
  const stableGroupMessageCount = await evaluate(appA.cdp, `document.querySelectorAll('.collaboration-group-chat-view .social-group-message').length`);
  assert.ok(stableGroupMessageCount > 0, 'group conversation did not render its existing messages');
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  const stableGroupAfterRelayRefresh = await evaluate(appA.cdp, `({
    visible: Boolean(document.querySelector('.collaboration-group-chat-view')),
    messageCount: document.querySelectorAll('.collaboration-group-chat-view .social-group-message').length,
  })`);
  assert.equal(stableGroupAfterRelayRefresh.visible, true, 'group conversation disappeared after a social relay refresh');
  assert.ok(stableGroupAfterRelayRefresh.messageCount >= stableGroupMessageCount, 'group messages disappeared after a social relay refresh');
  const groupSharedAttachmentName = 'ui-group-shared-attachment.txt';
  const groupSharedAttachmentBytes = Buffer.from('UI_GROUP_SHARED_ATTACHMENT_OK\n', 'utf8');
  const groupSharedAttachmentMessage = 'Alice 通过真实 UI 分享任务群附件。';
  await dropFileIntoComposer(appA.cdp, { name: groupSharedAttachmentName, contentType: 'text/plain', data: groupSharedAttachmentBytes });
  await waitFor(appA.cdp, `Array.from(document.querySelectorAll('.attachment-chip strong')).some((item) => item.textContent === ${JSON.stringify(groupSharedAttachmentName)})`, 30_000);
  await submitMainChat(appA.cdp, groupSharedAttachmentMessage);
  const groupSharedAttachmentRow = await waitForSql(
    'SELECT * FROM collaboration_group_messages WHERE group_id = $1 AND sender_user_id = $2 AND content = $3',
    [group.id, accounts.alice.user.id, groupSharedAttachmentMessage],
  );
  const groupSharedAttachmentMetadata = typeof groupSharedAttachmentRow.metadata_json === 'string'
    ? JSON.parse(groupSharedAttachmentRow.metadata_json || '{}')
    : groupSharedAttachmentRow.metadata_json || {};
  const groupSharedAttachment = groupSharedAttachmentMetadata.attachments?.[0];
  assert.ok(groupSharedAttachment?.remote_file_id);
  assert.equal(groupSharedAttachment.remote_file_kind, 'collaboration_group');
  assert.equal(groupSharedAttachment.group_id, group.id);
  assert.equal(Boolean(groupSharedAttachment.path || groupSharedAttachment.source_path || groupSharedAttachment.sourcePath), false);
  await assert.rejects(
    () => carolRuntime.collaborationDownloadFile({
      fileId: groupSharedAttachment.remote_file_id,
      filename: groupSharedAttachment.filename,
      sha256: groupSharedAttachment.sha256,
      remoteFileKind: groupSharedAttachment.remote_file_kind,
      groupId: group.id,
    }),
    (error) => Number(error?.status || 0) === 404,
  );
  await openCollaborationGroup(appB.cdp, group.id);
  await waitFor(appB.cdp, `Array.from(document.querySelectorAll('.collaboration-group-chat-view .message-attachment-card')).some((item) => item.textContent.includes(${JSON.stringify(groupSharedAttachmentName)}))`, 30_000);
  await clickMessageAttachmentPreview(appB.cdp, groupSharedAttachmentName, '.collaboration-group-chat-view');
  const groupSharedDownloadedPath = path.join(
    tempRoot, 'bob', 'runtime', 'data', 'collaboration-downloads', accounts.bob.user.id,
    groupSharedAttachment.remote_file_id, groupSharedAttachmentName,
  );
  await waitForLocalFile(groupSharedDownloadedPath, 30_000);
  const groupSharedCloudFile = (await pool.query('SELECT data FROM social_message_files WHERE id = $1', [groupSharedAttachment.remote_file_id])).rows[0];
  assert.deepEqual(readFileSync(groupSharedDownloadedPath), Buffer.from(groupSharedCloudFile.data));
  await waitFor(appB.cdp, `document.querySelector('.preview-overlay')`, 30_000);
  await clickSelector(appB.cdp, '#close-preview-btn');
  await openCollaborationGroup(appA.cdp, group.id);
  const groupAttachmentUi = await evaluate(appA.cdp, `(() => {
    const cards = Array.from(document.querySelectorAll('.collaboration-group-chat-view .message-attachment-card'));
    const card = cards.find((item) => item.textContent.includes(${JSON.stringify(submittedAttachment.filename || submittedAttachment.name)}));
    return {
      found: Boolean(card),
      filename: card?.querySelector('strong')?.textContent || '',
      previewButton: Boolean(card?.querySelector('[data-preview-file]')),
    };
  })()`);
  assert.ok(groupAttachmentUi.found && groupAttachmentUi.previewButton, JSON.stringify(groupAttachmentUi));
  await evaluate(appA.cdp, `(() => {
    const card = Array.from(document.querySelectorAll('.collaboration-group-chat-view .message-attachment-card'))
      .find((item) => item.textContent.includes(${JSON.stringify(submittedAttachment.filename || submittedAttachment.name)}));
    card.querySelector('[data-preview-file]').click();
  })()`);
  const downloadedPath = path.join(
    tempRoot,
    'alice',
    'runtime',
    'data',
    'collaboration-downloads',
    accounts.alice.user.id,
    submittedAttachment.remote_file_id,
    submittedAttachment.filename || submittedAttachment.name,
  );
  await waitForLocalFile(downloadedPath, 30_000);
  const cloudFile = (await pool.query('SELECT data FROM collaboration_files WHERE id = $1', [submittedAttachment.remote_file_id])).rows[0];
  assert.ok(cloudFile?.data?.length > 0);
  assert.deepEqual(readFileSync(downloadedPath), Buffer.from(cloudFile.data));
  await waitFor(appA.cdp, `document.querySelector('.preview-overlay')`, 30_000);
  await clickSelector(appA.cdp, '#close-preview-btn');
  await openMentionMenu(appA.cdp);
  const groupMentionBeforeCarol = await mentionMenuSnapshot(appA.cdp);
  assert.equal(groupMentionBeforeCarol.some((item) => item === '任务群'), false);
  assert.ok(groupMentionBeforeCarol.some((item) => item.includes('Alice')));
  assert.ok(groupMentionBeforeCarol.some((item) => item.includes('Bob')));
  assert.ok(groupMentionBeforeCarol.filter((item) => item.includes('uBuddy')).length >= 2);

  let carolTask = null;
  if (!useRealCodex) {
    await clickSelector(appA.cdp, '[data-collaboration-group-add-member]');
  await waitFor(appA.cdp, `document.querySelector('.collaboration-add-member-panel')`);
  const addMemberUi = await evaluate(appA.cdp, `({
    carol: Boolean(document.querySelector('[data-collaboration-add-member-user][value="${accounts.carol.user.id}"]')),
    assignment: Boolean(document.querySelector('#collaboration-add-member-assignment')),
    confirm: Boolean(document.querySelector('[data-collaboration-add-member-confirm]')),
  })`);
  assert.ok(addMemberUi.carol && addMemberUi.assignment && addMemberUi.confirm);
  const carolAssignment = 'Carol 负责整理近期工作数据、风险清单，并给流程图补充责任人与截止日期。';
  await evaluate(appA.cdp, `(() => {
    const radio = document.querySelector('[data-collaboration-add-member-user][value="${accounts.carol.user.id}"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    const input = document.querySelector('#collaboration-add-member-assignment');
    input.value = ${JSON.stringify(carolAssignment)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-collaboration-add-member-confirm]').click();
  })()`);
  carolTask = await waitForSql('SELECT * FROM agent_delegations WHERE group_id = $1 AND recipient_user_id = $2', [group.id, accounts.carol.user.id], 60_000);
  await carolRuntime.pollSocialNetwork({ autoProcess: false });
  assert.ok((await carolRuntime.collaborationOverview()).tasks.some((task) => task.id === carolTask.id && task.instruction.includes('风险清单')));
  const carolDownloadedGroupAttachment = await carolRuntime.collaborationDownloadFile({
    fileId: groupSharedAttachment.remote_file_id,
    filename: groupSharedAttachment.filename,
    sha256: groupSharedAttachment.sha256,
    remoteFileKind: groupSharedAttachment.remote_file_kind,
    groupId: group.id,
  });
  assert.deepEqual(readFileSync(carolDownloadedGroupAttachment.path), groupSharedAttachmentBytes);
  await carolRuntime.pollSocialNetwork({ autoProcess: true });
  await waitForRuntimeTask(carolRuntime, carolTask.id, 'draft_ready', useRealCodex ? 900_000 : 120_000);

  await openCollaborationGroup(appA.cdp, group.id);
  const broadcastGroupMessage = '请把最新风险更新到对应流程图任务中。';
  const groupMessageCountBeforeBroadcast = Number((await pool.query('SELECT count(*) AS count FROM collaboration_group_messages WHERE group_id = $1', [group.id])).rows[0].count);
  await submitMainChat(appA.cdp, broadcastGroupMessage);
  await waitForSql('SELECT * FROM collaboration_group_messages WHERE group_id = $1 AND sender_user_id = $2 AND content = $3', [group.id, accounts.alice.user.id, broadcastGroupMessage], 60_000);
  const groupMessageCountAfterSend = Number((await pool.query('SELECT count(*) AS count FROM collaboration_group_messages WHERE group_id = $1', [group.id])).rows[0].count);
  assert.equal(groupMessageCountAfterSend, groupMessageCountBeforeBroadcast + 1);
  assert.equal(await evaluate(appA.cdp, `Boolean(document.querySelector('.collaboration-routing-confirmation'))`), false, 'no-mention group updates must broadcast without an ambiguity dialog');
  await waitForSql(`SELECT * FROM agent_delegation_workspace_messages WHERE delegation_id = $1 AND user_id = $2 AND content = $3`, [bobTask.id, accounts.bob.user.id, broadcastGroupMessage], 60_000);
  await waitForSql(`SELECT * FROM agent_delegation_workspace_messages WHERE delegation_id = $1 AND user_id = $2 AND content = $3`, [carolTask.id, accounts.carol.user.id, broadcastGroupMessage], 60_000);

  await openMentionMenu(appA.cdp);
  const groupMentionAfterCarol = await mentionMenuSnapshot(appA.cdp);
  assert.equal(groupMentionAfterCarol.some((item) => item === '任务群'), false);
  for (const name of ['Alice', 'Bob', 'Carol']) assert.ok(groupMentionAfterCarol.some((item) => item.includes(name)), `${name} absent from group @ menu`);
  assert.ok(groupMentionAfterCarol.filter((item) => item.includes('uBuddy')).length >= 3);
  assert.equal(await evaluate(appA.cdp, `document.querySelectorAll('.social-group-participants .social-participant').length`), 6);
  await captureScreenshot(appA.cdp, '04-isolated-group-members-and-mentions.png');
  } else {
    await captureScreenshot(appA.cdp, '04-isolated-group-members-and-mentions.png');
  }

  await evaluate(appA.cdp, `window.confirm = () => true; document.querySelector('[data-collaboration-group-close]').click()`);
  await waitForSql(`SELECT * FROM collaboration_groups WHERE id = $1 AND status = 'closed'`, [group.id], 60_000);
  await clickSelector(appA.cdp, '[data-network-view="messages"]');
  await waitFor(appA.cdp, `document.querySelector('[data-collaboration-group="${group.id}"].is-ended')`, 30_000);
  const closedGroupListedInMessages = await evaluate(appA.cdp, `document.querySelector('[data-collaboration-group="${group.id}"].is-ended')?.textContent.includes('已结束')`);
  assert.equal(closedGroupListedInMessages, true);
  await clickSelector(appA.cdp, `[data-collaboration-group="${group.id}"].is-ended`);
  await waitFor(appA.cdp, `document.querySelector('.collaboration-group-chat-view')`);
  const closedUi = await evaluate(appA.cdp, `({
    ended: document.querySelector('.social-group-ended')?.textContent || '',
    composer: Boolean(document.querySelector('.collaboration-group-chat-view #chat-form')),
    addMember: Boolean(document.querySelector('[data-collaboration-group-add-member]')),
    close: Boolean(document.querySelector('[data-collaboration-group-close]')),
  })`);
  assert.match(closedUi.ended, /已解散|只读/);
  assert.equal(closedUi.composer || closedUi.addMember || closedUi.close, false);
  await captureScreenshot(appA.cdp, '05-isolated-closed-group-readonly.png');

  const aliceDb = new DatabaseSync(path.join(tempRoot, 'alice', 'runtime', 'data', 'janus.db'));
  const bobDb = new DatabaseSync(path.join(tempRoot, 'bob', 'runtime', 'data', 'janus.db'));
  const executionRows = {
    alice: aliceDb.prepare('SELECT status, codex_thread_id FROM model_executions ORDER BY started_at').all(),
    bob: bobDb.prepare('SELECT status, codex_thread_id FROM model_executions ORDER BY started_at').all(),
    carol: carolRuntime.db.prepare('SELECT status, codex_thread_id FROM model_executions ORDER BY started_at').all(),
  };
  aliceDb.close();
  bobDb.close();
  const executionCompleted = (rows) => rows.some((row) => row.status === 'completed');
  assert.ok(executionCompleted(executionRows.alice), 'Alice UI did not complete a Codex-backed uBuddy turn');
  assert.ok(executionCompleted(executionRows.bob), 'Bob UI did not complete a Codex-backed uBuddy turn');
  if (!useRealCodex) assert.ok(existsSync(fakeCodexLog), 'fake Codex was not invoked');

  console.log(JSON.stringify({
    ok: true,
    isolatedCloud: true,
    productionCloudTouched: false,
    codexMode: useRealCodex ? 'real' : 'fake',
    electronInstances: 2,
    thirdAccountRuntime: true,
    users: { alice: accounts.alice.user.id, bob: accounts.bob.user.id, carol: accounts.carol.user.id },
    groupId: group.id,
    taskIds: { bob: bobTask.id, carol: carolTask?.id || '' },
    closedGroupListedInMessages,
    checks: [
      'ui_login', 'ui_friend_request_accept', 'ui_direct_chat_without_group', 'ui_own_ubuddy_direct_dispatch',
      'ui_ubuddy_single_main_conversation', 'ui_composer_memory_menu',
      'ui_direct_dispatch', 'ui_outgoing_private_ubuddy_workspace', 'private_update_not_leaked_before_sync',
      'ui_requester_default_no_file', 'ui_natural_language_requirement_publish',
      'ui_recipient_offline_backlog_initial_product_once', 'ui_task_composer_without_group_controls', 'ui_natural_language_result_submit',
      'ui_direct_attachment_cross_user_preview_download', 'ui_group_attachment_member_preview_download',
      'ui_group_attachment_non_member_denied', 'ui_group_attachment_new_member_historical_download',
      'ui_cross_user_task_attachment_download', 'group_mention_menu_members_and_ubuddies',
      ...(!useRealCodex ? ['ui_failed_execution_not_marked_complete', 'ui_runtime_error_sanitized_once', 'ui_retry_completes_after_block', 'ui_requester_explicit_private_file', 'ui_add_carol_with_assignment', 'carol_received_delegation', 'ui_no_mention_group_broadcast_without_duplicate_message'] : []),
      'ui_close_messages_list_readonly', 'codex_invoked_from_ui',
    ],
  }));
  }
} finally {
  await stopElectron(appA);
  await stopElectron(appB);
  carolRuntime?.close();
  if (cloudServer) await new Promise((resolve) => cloudServer.close(resolve));
  if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
  await pool.end();
  if (!process.env.JANUS_E2E_KEEP_TEMP) rmSync(tempRoot, { recursive: true, force: true });
}

async function registerCloudAccount(authUrl, fixture) {
  await jsonRequest(`${authUrl}/api/auth/email-code`, { method: 'POST', body: { email: fixture.email, purpose: 'register' } });
  const code = codes.get(`${fixture.email.toLowerCase()}:register`);
  assert.match(code || '', /^\d{6}$/);
  return jsonRequest(`${authUrl}/api/auth/register`, { method: 'POST', body: { email: fixture.email, displayName: fixture.name, password, code } });
}

async function updateProfile(authUrl, account, profile) {
  const result = await jsonRequest(`${authUrl}/api/auth/profile`, { method: 'PATCH', token: account.accessToken, body: profile });
  return { ...account, user: result.user };
}

async function jsonRequest(url, { method = 'GET', token = '', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${url} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForLocalFile(filePath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return filePath;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for local file: ${filePath}`);
}

async function launchElectron(label, debugPort, authUrl) {
  const runtimeRoot = path.join(tempRoot, label, 'runtime');
  const profileRoot = path.join(tempRoot, label, 'profile');
  if (useRealCodex) seedRealCodexConfig(runtimeRoot);
  const env = {
    ...process.env,
    JANUS_HOME: runtimeRoot,
    JANUS_AUTH_URL: authUrl,
    JANUS_CODEX_BIN: useRealCodex ? realCodexBin : fakeCodex,
    JANUS_SOCIAL_POLL_INTERVAL_MS: '500',
    JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
    JANUS_MODEL_REFRESH_ENABLED: '0',
    JANUS_LOCAL_EVOLUTION_ENABLED: '0',
    JANUS_UPDATES_ENABLED: '0',
    ELECTRON_DISABLE_SANDBOX: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, ['--no-sandbox', `--user-data-dir=${profileRoot}`, `--remote-debugging-port=${debugPort}`, '.'], {
    cwd: projectRoot,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const target = await waitForPageTarget(debugPort, 30_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('janus-sandbox-permission', 'full-access'); location.reload();` });
  await new Promise((resolve) => setTimeout(resolve, 700));
  return { child, cdp, stderr: () => stderr, debugPort };
}

function assertRealCodexAvailable() {
  assert.ok(existsSync(realCodexBin), `Real Codex binary not found: ${realCodexBin}`);
  assert.ok(existsSync(path.join(realCodexHome, 'config.toml')), `Real Codex config not found: ${realCodexHome}`);
  assert.ok(existsSync(path.join(realCodexHome, 'auth.json')), `Real Codex auth not found: ${realCodexHome}`);
}

function seedRealCodexConfig(runtimeRoot) {
  assertRealCodexAvailable();
  const target = path.join(runtimeRoot, 'config', 'codex');
  mkdirSync(target, { recursive: true });
  copyFileSync(path.join(realCodexHome, 'config.toml'), path.join(target, 'config.toml'));
  copyFileSync(path.join(realCodexHome, 'auth.json'), path.join(target, 'auth.json'));
}

async function stopElectron(instance) {
  if (!instance) return;
  try { await instance.cdp?.close(); } catch {}
  const child = instance.child;
  if (!child || child.exitCode !== null) return;
  try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch {} }
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3_000); });
}

async function loginThroughUi(cdp, fixture) {
  const alreadyAuthenticated = await evaluate(cdp, `Boolean(document.querySelector('.account-avatar') && !document.querySelector('#login-form'))`);
  if (alreadyAuthenticated) {
    await evaluate(cdp, `window.janus.logout().then(() => location.reload())`);
  }
  await waitFor(cdp, `document.querySelector('#login-form')`, 30_000);
  await evaluate(cdp, `(() => {
    document.querySelector('#login-identifier').value = ${JSON.stringify(fixture.email)};
    document.querySelector('#login-password').value = ${JSON.stringify(password)};
    document.querySelector('#login-form').requestSubmit();
  })()`);
  try {
    await waitFor(cdp, `document.querySelector('.account-avatar') && !document.querySelector('#login-form')`, 30_000);
  } catch (error) {
    const snapshot = await evaluate(cdp, `({
      loginVisible: Boolean(document.querySelector('#login-form')),
      accountAvatar: Boolean(document.querySelector('.account-avatar')),
      feedback: document.querySelector('.auth-feedback, [role="alert"], .notice')?.textContent || '',
      body: (document.body?.innerText || '').slice(0, 1200),
    })`);
    throw new Error(`Login UI did not complete: ${JSON.stringify(snapshot)}`, { cause: error });
  }
}

async function addFriendThroughUi(requesterCdp, recipientCdp, recipient, query, greeting) {
  await requestFriendThroughUi(requesterCdp, recipient, query, greeting);
  const requester = await currentUiUser(requesterCdp);
  await clickSelector(recipientCdp, '[data-network-view="friends"]');
  await clickSelector(recipientCdp, '[data-friend-directory-category="new"]');
  await clickSelector(recipientCdp, '[data-friend-accept]', 30_000);
  await waitForSql(`SELECT * FROM friendships WHERE status = 'accepted' AND (user_a_id = $1 OR user_b_id = $1) AND (user_a_id = $2 OR user_b_id = $2)`, [recipient.id, requester.id], 30_000);
}

async function addFriendToRuntimeThroughUi(requesterCdp, recipientRuntime, recipientAccount, query, authUrl) {
  const recipient = recipientAccount.user;
  const requester = await currentUiUser(requesterCdp);
  await requestFriendThroughUi(requesterCdp, recipient, query, 'Alice 请求添加 Carol，用于多人任务群 UI 测试。');
  const incoming = await waitForSql(`SELECT * FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2 AND status = 'pending'`, [requester.id, recipient.id], 30_000);
  await jsonRequest(`${authUrl}/api/friends/requests/${incoming.id}/accept`, { method: 'POST', token: recipientAccount.accessToken });
  await waitForSql(`SELECT * FROM friendships WHERE status = 'accepted' AND (user_a_id = $1 OR user_b_id = $1) AND (user_a_id = $2 OR user_b_id = $2)`, [recipient.id, requester.id], 30_000);
  await recipientRuntime.friendsOverview();
}

async function requestFriendThroughUi(cdp, recipient, query, greeting) {
  await clickSelector(cdp, '[data-network-view="friends"]');
  await clickSelector(cdp, '[data-contact-add-open="contact"]');
  await waitFor(cdp, `document.querySelector('#contact-add-search-form')`);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#friend-add-search-query');
    input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#contact-add-search-form').requestSubmit();
  })()`);
  await waitFor(cdp, `document.querySelector('[data-friend-request="${recipient.id}"]')`, 30_000);
  await clickSelector(cdp, `[data-friend-request="${recipient.id}"]`, 30_000);
  await waitFor(cdp, `document.querySelector('#friend-request-form')`);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#friend-request-message');
    input.value = ${JSON.stringify(greeting)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#friend-request-form').requestSubmit();
  })()`);
  await waitForSql('SELECT * FROM friend_requests WHERE recipient_id = $1 AND status = $2', [recipient.id, 'pending'], 30_000);
}

async function currentUiUser(cdp) {
  return evaluate(cdp, `window.janus.currentUser()`);
}

async function openFriendChat(cdp, peerId) {
  await clickSelector(cdp, '[data-network-view="friends"]');
  await clickSelector(cdp, `[data-contact-profile="${peerId}"]`, 30_000);
  await clickSelector(cdp, `[data-contact-profile-dialog] [data-network-peer="${peerId}"]`, 30_000);
  await waitFor(cdp, `document.querySelector('.direct-social-panel #chat-form')`, 30_000);
}

async function openTaskDetail(cdp, groupId, delegationId) {
  const timeoutMs = useRealCodex ? 180_000 : 30_000;
  await clickSelector(cdp, '[data-network-view="messages"]', timeoutMs);
  await waitFor(cdp, `document.querySelector('[data-collaboration-group="${groupId}"]')`, timeoutMs);
  await clickSelector(cdp, `[data-collaboration-group="${groupId}"]`, timeoutMs);
  await waitFor(cdp, `document.querySelector('.collaboration-group-chat-view [data-network-delegation="${delegationId}"]')`, timeoutMs);
  await clickSelector(cdp, `.collaboration-group-chat-view [data-network-delegation="${delegationId}"]`, timeoutMs);
  await waitFor(cdp, `document.querySelector('.network-delegation-detail')`, timeoutMs);
}

async function openCollaborationGroup(cdp, groupId) {
  await clickSelector(cdp, '[data-network-view="messages"]');
  await clickSelector(cdp, `[data-collaboration-group="${groupId}"]`, 30_000);
  await waitFor(cdp, `document.querySelector('.collaboration-group-chat-view')`, 30_000);
}

async function submitMainChat(cdp, content) {
  await waitFor(cdp, `document.querySelector('#chat-form .send-btn:not([disabled])')`, 30_000);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input.value = ${JSON.stringify(content)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chat-form').requestSubmit();
  })()`);
}

async function dropFileIntoComposer(cdp, { name = 'attachment.txt', contentType = 'text/plain', data = Buffer.alloc(0) } = {}) {
  const base64 = Buffer.from(data).toString('base64');
  await evaluate(cdp, `(() => {
    const binary = atob(${JSON.stringify(base64)});
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(contentType)} });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  })()`);
}

async function clickMessageAttachmentPreview(cdp, filename, containerSelector = '') {
  await evaluate(cdp, `(() => {
    const root = ${JSON.stringify(containerSelector)} ? document.querySelector(${JSON.stringify(containerSelector)}) : document;
    const card = Array.from(root?.querySelectorAll('.message-attachment-card') || [])
      .find((item) => item.textContent.includes(${JSON.stringify(filename)}));
    if (!card) throw new Error('attachment card not found');
    card.querySelector('[data-preview-file]')?.click();
  })()`);
}

async function submitDelegationComment(cdp, content) {
  await waitFor(cdp, `document.querySelector('#network-delegation-comment-form .send-btn:not([disabled])')`, 30_000);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#network-delegation-comment-input');
    input.value = ${JSON.stringify(content)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#network-delegation-comment-form').requestSubmit();
  })()`);
}

async function mentionMenuSnapshot(cdp) {
  return evaluate(cdp, `Array.from(document.querySelectorAll('[data-social-mention]')).map((item) => item.textContent.replace(/Beta/g, '').replace(/\\s+/g, ' ').trim())`);
}

async function openMentionMenu(cdp) {
  await waitFor(cdp, `document.querySelector('[data-social-mention-toggle]')`, 30_000);
  if (await evaluate(cdp, `document.querySelector('[data-social-mention-toggle]')?.getAttribute('aria-expanded') !== 'true'`)) {
    await clickSelector(cdp, '[data-social-mention-toggle]');
  }
  await waitFor(cdp, `document.querySelectorAll('[data-social-mention]').length > 0`, 30_000);
}

async function waitForRuntimeTask(runtime, taskId, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = (await runtime.collaborationOverview()).tasks.find((task) => task.id === taskId);
    if (latest?.status === status) return latest;
    if (latest?.status === 'failed') throw new Error(`Runtime task failed: ${JSON.stringify(latest)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for runtime task ${taskId} -> ${status}; latest=${JSON.stringify(latest)}`);
}

async function waitForSql(sql, params = [], timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await pool.query(sql, params);
      if (result.rows[0]) return result.rows[0];
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError || new Error(`Timed out waiting for SQL: ${sql}`);
}

async function waitFor(cdp, expression, timeoutMs = 15_000) {
  return evaluate(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + ${timeoutMs};
    const poll = () => {
      try { if (${expression}) return resolve(true); } catch {}
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for UI condition'));
      setTimeout(poll, 100);
    };
    poll();
  })`);
}

async function clickSelector(cdp, selector, timeoutMs = 30_000) {
  const encoded = JSON.stringify(String(selector || ''));
  return waitFor(cdp, `(() => {
    const element = document.querySelector(${encoded});
    if (!element) return false;
    element.click();
    return true;
  })()`, timeoutMs);
}

async function captureScreenshot(cdp, filename) {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await cdp.send('Page.enable');
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(screenshotDir, filename), Buffer.from(result.data, 'base64'));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Electron renderer on ${port}.`);
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) return;
    const request = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) request.reject(new Error(payload.error.message || 'CDP request failed'));
    else request.resolve(payload.result || {});
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        const response = new Promise((requestResolve, requestReject) => pending.set(id, { resolve: requestResolve, reject: requestReject }));
        socket.send(JSON.stringify({ id, method, params }));
        return response;
      },
      close() { socket.close(); },
    }), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
  });
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
