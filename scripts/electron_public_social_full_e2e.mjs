import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-electron-public-social-'));
const electronBinary = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const fakeCodex = path.join(tempRoot, 'fake-codex.mjs');
const useRealCodex = process.env.JANUS_E2E_REAL_CODEX === '1';
const realCodexBin = process.env.JANUS_E2E_CODEX_BIN || '/usr/bin/codex';
const realCodexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const screenshotDir = String(process.env.JANUS_E2E_SCREENSHOT_DIR || '').trim();
const serverDb = new DatabaseSync('/path/to/janus-cloud/cloud.db');
const marker = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
const alice = userFixture('alice', marker);
const bob = userFixture('bob', marker);
const users = [alice, bob];
let appA;
let appB;

writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli electron-public-social-e2e'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]\\n  --listen <URL>'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass', codexVersion: 'electron-public-social-e2e' })); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
const answer = 'UBUDDY_FULL_CHAIN_OK：接收方 uBuddy 已完成任务并自动回传结果。';
if (outputPath) fs.writeFileSync(outputPath, answer, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'session_meta', payload: { session_id: 'electron-public-social-thread' } }));
  console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: answer } }));
  console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: answer } }));
}
`);
chmodSync(fakeCodex, 0o755);

try {
  insertUser(alice);
  insertUser(bob);
  appA = await launchElectron('alice', 9511, alice);
  appB = await launchElectron('bob', 9512, bob);
  await loginThroughUi(appA.cdp, alice);
  await loginThroughUi(appB.cdp, bob);

  const greeting = '你好，我是 Alice Electron，负责完整链路验证，希望与你和 uBuddy 协作。';
  await evaluate(appA.cdp, `document.querySelector('[data-network-view="friends"]').click()`);
  await evaluate(appA.cdp, `document.querySelector('[data-contact-add-open="contact"]')?.click()`);
  await waitFor(appA.cdp, `document.querySelector('#contact-add-search-form')`);
  await evaluate(appA.cdp, `(() => {
    const input = document.querySelector('#friend-add-search-query');
    input.value = ${JSON.stringify(bob.email)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#contact-add-search-form').requestSubmit();
  })()`);
  await waitFor(appA.cdp, `document.querySelector('[data-friend-request="${bob.id}"]')`);
  await evaluate(appA.cdp, `document.querySelector('[data-friend-request="${bob.id}"]').click()`);
  await waitFor(appA.cdp, `document.querySelector('#friend-request-message')`);
  await evaluate(appA.cdp, `(() => {
    const input = document.querySelector('#friend-request-message');
    input.value = ${JSON.stringify(greeting)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#friend-request-form').requestSubmit();
  })()`);
  await waitForDb(() => serverDb.prepare("SELECT message FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'").get(alice.id, bob.id)?.message === greeting);

  await evaluate(appB.cdp, `document.querySelector('[data-network-view="friends"]').click()`);
  await waitFor(appB.cdp, `document.querySelector('[data-friend-accept]')`, 20_000);
  const receivedGreeting = await evaluate(appB.cdp, `document.querySelector('.network-friend-row .network-friend-main span')?.textContent || ''`);
  assert.equal(receivedGreeting, greeting);
  await evaluate(appB.cdp, `document.querySelector('[data-friend-accept]').click()`);
  await waitForDb(() => Boolean(serverDb.prepare("SELECT id FROM friendships WHERE ((user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?)) AND status = 'accepted'").get(alice.id, bob.id, bob.id, alice.id)));
  await waitFor(appB.cdp, `document.querySelector('.network-friend-row .network-friend-menu > summary')`, 20_000);
  const friendRowUi = await evaluate(appB.cdp, `(() => {
    const row = document.querySelector('.network-friend-row');
    const summary = row?.querySelector('.network-friend-menu > summary');
    summary?.click();
    return {
      summary: summary?.textContent?.trim() || '',
      directChat: Boolean(row?.querySelector('[data-network-mode="person"]')),
      ubuddyAction: Array.from(row?.querySelectorAll('[data-network-mode="person"]') || []).some((item) => item.textContent.includes('@uBuddy')),
      removeAction: Boolean(row?.querySelector('[data-friend-remove]')),
      blockAction: Boolean(row?.querySelector('[data-friend-block]')),
      identityWidth: row?.querySelector('.network-friend-main')?.getBoundingClientRect().width || 0,
    };
  })()`);
  assert.equal(friendRowUi.summary, '...');
  assert.ok(friendRowUi.directChat && friendRowUi.ubuddyAction && friendRowUi.removeAction && friendRowUi.blockAction);
  assert.ok(friendRowUi.identityWidth >= 80);

  await evaluate(appA.cdp, `document.querySelector('[data-network-view="friends"]').click()`);
  await waitFor(appA.cdp, `document.querySelector('.network-friend-row [data-network-peer="${bob.id}"]')`, 20_000);
  await evaluate(appA.cdp, `document.querySelector('.network-friend-row [data-network-peer="${bob.id}"]').click()`);
  await waitFor(appA.cdp, `document.querySelector('.social-group-panel #chat-form')`);
  const channelUi = await evaluate(appA.cdp, `({
    participants: document.querySelectorAll('.social-group-participants .social-participant').length,
    mention: Boolean(document.querySelector('.social-group-composer [data-social-mention-toggle]')),
    directPanel: Boolean(document.querySelector('.direct-social-panel')),
    taskGroupPanel: Boolean(document.querySelector('.collaboration-group-chat-view')),
    standardComposer: Boolean(document.querySelector('.social-group-composer #chat-input')),
  })`);
  assert.equal(channelUi.participants, 0);
  assert.equal(channelUi.mention, true);
  assert.equal(channelUi.directPanel, true);
  assert.equal(channelUi.taskGroupPanel, false);
  assert.equal(channelUi.standardComposer, true);
  await captureScreenshot(appA.cdp, '01-person-chat.png');
  await evaluate(appA.cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input.value = '轮询期间必须保留的好友消息草稿';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(await evaluate(appA.cdp, `document.querySelector('#chat-input')?.value || ''`), '轮询期间必须保留的好友消息草稿');
  await submitMainChat(appA.cdp, 'Electron 真人聊天完整链路消息');
  await waitForDb(() => Boolean(serverDb.prepare("SELECT id FROM social_messages WHERE sender_user_id = ? AND recipient_user_id = ? AND content = ?").get(alice.id, bob.id, 'Electron 真人聊天完整链路消息')));
  await evaluate(appB.cdp, `document.querySelector('[data-network-view="messages"]').click()`);
  await waitFor(appB.cdp, `document.querySelector('[data-network-peer="${alice.id}"]')`, 20_000);
  await evaluate(appB.cdp, `document.querySelector('[data-network-peer="${alice.id}"]').click()`);
  await waitFor(appB.cdp, `document.querySelector('.social-group-panel #chat-form')`);
  await submitMainChat(appB.cdp, 'Electron 反向真人消息完整链路');
  await waitForDb(() => Boolean(serverDb.prepare("SELECT id FROM social_messages WHERE sender_user_id = ? AND recipient_user_id = ? AND content = ?").get(bob.id, alice.id, 'Electron 反向真人消息完整链路')));

  await waitFor(appA.cdp, `document.querySelector('.social-group-panel #chat-form')`);
  const ownUBuddyUi = await evaluate(appA.cdp, `({
    directPanel: Boolean(document.querySelector('.direct-social-panel')),
    participants: document.querySelectorAll('.social-group-participants .social-participant').length,
    mention: Boolean(document.querySelector('[data-social-mention-toggle]')),
  })`);
  assert.equal(ownUBuddyUi.directPanel, true);
  assert.equal(ownUBuddyUi.participants, 0);
  assert.equal(ownUBuddyUi.mention, true);
  await captureScreenshot(appA.cdp, '02-own-ubuddy-task-compose.png');
  await submitMainChat(appA.cdp, '@我的uBuddy 请委托 Bob 汇报近期工作，制作一份可编辑 PPT，并在其中加入工作汇报流程图、风险和下一步计划。发布前先让我确认整理后的草稿。');
  await waitFor(appA.cdp, `document.querySelector('.private-dispatch-draft')`, 600_000);
  assert.equal(serverDb.prepare('SELECT count(*) AS count FROM collaboration_groups WHERE owner_user_id = ?').get(alice.id).count, 0);
  assert.equal(serverDb.prepare('SELECT count(*) AS count FROM agent_delegations WHERE requester_user_id = ?').get(alice.id).count, 0);
  const draftUi = await evaluate(appA.cdp, `(() => {
    const draft = document.querySelector('.private-dispatch-draft');
    const instruction = draft?.querySelector('#collaboration-draft-instruction');
    return {
      visible: Boolean(draft),
      hasConfirm: Boolean(draft?.querySelector('[data-collaboration-draft-confirm]')),
      hasCancel: Boolean(draft?.querySelector('[data-collaboration-draft-cancel]')),
      hasRevise: Boolean(draft?.querySelector('[data-collaboration-draft-revise]')),
      hasOversizedCheckmark: Boolean(draft?.querySelector('.private-dispatch-check, .draft-confirm-checkmark')),
      instructionHeight: instruction?.getBoundingClientRect().height || 0,
      participantCount: draft?.querySelectorAll('[data-collaboration-draft-participant]:checked').length || 0,
    };
  })()`);
  assert.ok(draftUi.visible && draftUi.hasConfirm && draftUi.hasCancel && draftUi.hasRevise);
  assert.equal(draftUi.hasOversizedCheckmark, false);
  assert.ok(draftUi.instructionHeight > 50 && draftUi.instructionHeight < 420);
  assert.equal(draftUi.participantCount, 1);
  await captureScreenshot(appA.cdp, '03-private-dispatch-draft.png');

  await submitMainChat(appA.cdp, '请把整份草稿压缩为三部分，并明确流程图必须可编辑。');
  await waitFor(appA.cdp, `document.querySelector('[data-collaboration-draft-revise]')?.textContent.includes('正在重新整理')`, 20_000);
  await waitFor(appA.cdp, `document.querySelector('[data-collaboration-draft-confirm]:not([disabled])')`, 600_000);
  assert.equal(serverDb.prepare('SELECT count(*) AS count FROM collaboration_groups WHERE owner_user_id = ?').get(alice.id).count, 0);
  await captureScreenshot(appA.cdp, '04-private-dispatch-draft-revised.png');
  await evaluate(appA.cdp, `document.querySelector('[data-collaboration-draft-confirm]').click()`);

  const group = await waitForDb(() => serverDb.prepare('SELECT * FROM collaboration_groups WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 1').get(alice.id), 30_000);
  const delegation = await waitForDb(() => serverDb.prepare('SELECT * FROM agent_delegations WHERE group_id = ? AND requester_user_id = ? AND recipient_user_id = ?').get(group.id, alice.id, bob.id), 30_000);
  assert.equal(group.status, 'active');
  assert.ok(['assigned', 'preparing', 'accepted', 'running', 'working', 'draft_ready'].includes(delegation.status));
  assert.equal(await evaluate(appA.cdp, `Boolean(document.querySelector('[data-network-view="tasks"]'))`), false);
  await evaluate(appA.cdp, `document.querySelector('[data-network-view="messages"]').click()`);
  await waitFor(appA.cdp, `document.querySelector('.network-panel .network-messages')`, 30_000);
  await waitFor(appA.cdp, `document.querySelector('.network-panel [data-collaboration-group="${group.id}"]')`, 20_000);

  const ready = await waitForDb(() => {
    const row = serverDb.prepare('SELECT * FROM agent_delegations WHERE id = ?').get(delegation.id);
    if (row?.status === 'failed') throw new Error(`uBuddy delegation failed: ${row.last_error || 'unknown error'}\n${appB?.stderr?.() || ''}`);
    return row?.status === 'draft_ready' ? row : null;
  }, 900_000);
  const publicMetadata = JSON.parse(ready.metadata_json || '{}');
  assert.equal(Object.hasOwn(publicMetadata, 'preliminaryResult'), false);
  assert.equal(Object.hasOwn(publicMetadata, 'intakeSummary'), false);
  assert.doesNotMatch(ready.metadata_json || '', /task-workspaces|\/home\/|\\Users\\/i);

  assert.equal(await evaluate(appB.cdp, `Boolean(document.querySelector('[data-network-view="tasks"]'))`), false);
  await openTaskDetail(appB.cdp, group.id, delegation.id);
  await waitFor(appB.cdp, `document.querySelector('.network-delegation-detail [data-agent-delegation-submit]')`, 30_000);
  const readyLayout = await evaluate(appB.cdp, `(() => {
    const detail = document.querySelector('.network-delegation-detail');
    const rect = detail?.getBoundingClientRect();
    return {
      detailVisible: Boolean(detail),
      withinViewport: Boolean(rect && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1),
      hasAccept: Boolean(detail?.querySelector('[data-agent-delegation-respond="accept"]')),
      hasPrivateWorkspace: Boolean(detail?.querySelector('.network-delegation-private-workspace')),
      hasPreliminaryResult: Boolean(detail?.querySelector('.network-delegation-draft-result')),
      hasSubmit: Boolean(detail?.querySelector('[data-agent-delegation-submit]')),
      hasWorkflow: detail?.querySelectorAll('.network-delegation-workflow > span').length || 0,
    };
  })()`);
  assert.ok(readyLayout.detailVisible && readyLayout.withinViewport);
  assert.equal(readyLayout.hasAccept, false);
  assert.ok(readyLayout.hasPrivateWorkspace && readyLayout.hasPreliminaryResult && readyLayout.hasSubmit);
  assert.equal(readyLayout.hasWorkflow, 4);
  const bobTaskDb = new DatabaseSync(path.join(tempRoot, 'bob', 'runtime', 'data', 'janus.db'));
  const bobLocalDelegation = bobTaskDb.prepare('SELECT * FROM agent_delegations WHERE id = ?').get(delegation.id);
  const bobPrivateMetadata = JSON.parse(bobLocalDelegation.metadata_json || '{}');
  assert.match(String(bobPrivateMetadata.taskWorkspaceRoot || '').replace(/\\/g, '/'), /\/data\/task-workspaces\//);
  assert.ok(Array.isArray(bobPrivateMetadata.generatedTaskFiles) && bobPrivateMetadata.generatedTaskFiles.some((item) => /\.pptx$/i.test(item.name || '')));
  const sessionCountBeforeRevision = bobTaskDb.prepare('SELECT count(*) AS count FROM sessions').get().count;
  bobTaskDb.close();
  await captureScreenshot(appB.cdp, '05-incoming-private-workspace-ready.png');

  await evaluate(appB.cdp, `(() => {
    const input = document.querySelector('#network-delegation-comment-input');
    input.value = '请在初稿中增加一页时间线，并保持 PPT 和流程图可编辑。';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#network-delegation-comment-form').requestSubmit();
  })()`);
  await waitFor(appB.cdp, `Boolean(document.querySelector('[data-agent-delegation-submit][disabled]'))`, 20_000);
  await waitFor(appB.cdp, `document.querySelector('[data-agent-delegation-submit]:not([disabled])')`, 600_000);
  const bobTaskDbAfterRevision = new DatabaseSync(path.join(tempRoot, 'bob', 'runtime', 'data', 'janus.db'));
  const revisedLocal = bobTaskDbAfterRevision.prepare('SELECT * FROM agent_delegations WHERE id = ?').get(delegation.id);
  const revisedMetadata = JSON.parse(revisedLocal.metadata_json || '{}');
  assert.ok(String(revisedMetadata.preliminaryResult || '').trim());
  assert.ok(String(revisedMetadata.workspaceUpdatedAt || '').trim());
  assert.equal(bobTaskDbAfterRevision.prepare('SELECT count(*) AS count FROM sessions').get().count, sessionCountBeforeRevision);
  bobTaskDbAfterRevision.close();
  const revisedWorkspaceMessages = await evaluate(appB.cdp, `window.janus.collaborationWorkspaceMessages({ delegationId: ${JSON.stringify(delegation.id)} })`);
  assert.ok(revisedWorkspaceMessages.some((item) => item.role === 'assistant' && String(item.content || '').includes('时间线')));
  assert.equal(serverDb.prepare("SELECT count(*) AS count FROM collaboration_group_messages WHERE group_id = ? AND content LIKE '%时间线%'").get(group.id).count, 0);
  const sharedMetadataAfterPrivateRevision = JSON.parse(serverDb.prepare('SELECT metadata_json FROM agent_delegations WHERE id = ?').get(delegation.id).metadata_json || '{}');
  assert.equal(Object.hasOwn(sharedMetadataAfterPrivateRevision, 'workspaceUpdatedAt'), false);
  assert.equal(Object.hasOwn(sharedMetadataAfterPrivateRevision, 'workspaceExecutionError'), false);
  assert.equal(Object.hasOwn(sharedMetadataAfterPrivateRevision, 'workspaceRevisionRecovered'), false);

  await evaluate(appB.cdp, `document.querySelector('[data-agent-delegation-submit]').click()`);
  await waitForDb(() => serverDb.prepare('SELECT status FROM agent_delegations WHERE id = ?').get(delegation.id)?.status === 'submitted', 30_000);
  await openTaskDetail(appA.cdp, group.id, delegation.id);
  await waitFor(appA.cdp, `document.querySelector('[data-collaboration-task-action="request_revision"]')`, 30_000);
  await evaluate(appA.cdp, `window.prompt = () => '请补充本周风险负责人和预计完成日期。'; true`);
  await evaluate(appA.cdp, `document.querySelector('[data-collaboration-task-action="request_revision"]').click()`);
  await waitForDb(() => serverDb.prepare("SELECT id FROM collaboration_group_messages WHERE group_id = ? AND metadata_json LIKE '%request_revision%' AND metadata_json LIKE ? ORDER BY created_at DESC LIMIT 1").get(group.id, `%${delegation.id}%`), 30_000);
  await waitForDb(() => serverDb.prepare('SELECT status FROM agent_delegations WHERE id = ?').get(delegation.id)?.status === 'draft_ready', 900_000);

  await openTaskDetail(appB.cdp, group.id, delegation.id);
  await waitFor(appB.cdp, `document.querySelector('[data-agent-delegation-submit]')`, 30_000);
  await evaluate(appB.cdp, `document.querySelector('[data-agent-delegation-submit]').click()`);
  await waitForDb(() => serverDb.prepare('SELECT status FROM agent_delegations WHERE id = ?').get(delegation.id)?.status === 'submitted', 30_000);

  await openTaskDetail(appA.cdp, group.id, delegation.id);
  await waitFor(appA.cdp, `document.querySelector('[data-collaboration-task-action="accept_result"]')`, 30_000);
  await evaluate(appA.cdp, `document.querySelector('[data-collaboration-task-action="accept_result"]').click()`);
  await waitForDb(() => serverDb.prepare('SELECT status FROM agent_delegations WHERE id = ?').get(delegation.id)?.status === 'result_accepted', 30_000);

  await evaluate(appA.cdp, `document.querySelector('[data-network-view="messages"]').click()`);
  await waitFor(appA.cdp, `document.querySelector('.network-panel .network-messages')`, 30_000);
  await waitFor(appA.cdp, `document.querySelector('.network-panel [data-collaboration-group="${group.id}"]')`, 30_000);
  await evaluate(appA.cdp, `document.querySelector('.network-panel [data-collaboration-group="${group.id}"]').click()`);
  await waitFor(appA.cdp, `document.querySelector('[data-collaboration-group-close]')`, 30_000);
  const groupTaskStripLayout = await evaluate(appA.cdp, `(() => {
    const strip = document.querySelector('.collaboration-task-strip');
    return { visible: Boolean(strip), noHorizontalOverflow: Boolean(strip && strip.scrollWidth <= strip.clientWidth + 1) };
  })()`);
  assert.ok(groupTaskStripLayout.visible && groupTaskStripLayout.noHorizontalOverflow, JSON.stringify(groupTaskStripLayout));
  await evaluate(appA.cdp, `window.confirm = () => true; document.querySelector('[data-collaboration-group-close]').click()`);
  await waitForDb(() => serverDb.prepare('SELECT status FROM collaboration_groups WHERE id = ?').get(group.id)?.status === 'closed', 30_000);
  await evaluate(appA.cdp, `document.querySelector('[data-network-view="friends"]').click()`);
  await waitFor(appA.cdp, `document.querySelector('.network-panel .network-friends')`, 30_000);
  await waitFor(appA.cdp, `document.querySelector('.archived-friend-groups [data-social-group-section="archived"]')`, 30_000);
  await evaluate(appA.cdp, `document.querySelector('.archived-friend-groups [data-social-group-section="archived"]').click()`);
  await waitFor(appA.cdp, `document.querySelector('.archived-friend-groups [data-collaboration-group="${group.id}"]')`, 30_000);
  await captureScreenshot(appA.cdp, '06-closed-group-archived-under-friends.png');

  const leakedPrivateMessages = serverDb.prepare("SELECT count(*) AS count FROM collaboration_group_messages WHERE group_id = ? AND (metadata_json LIKE '%privateTaskWorkspace%' OR content LIKE '%task-workspaces%' OR content LIKE '%/home/%' OR content LIKE '%/usr/bin/codex%' OR content LIKE '%Process timed out%' OR content LIKE '%### 执行记录%')").get(group.id).count;
  assert.equal(leakedPrivateMessages, 0);

  await stopElectron(appA);
  appA = await launchElectron('alice', 9513, alice);
  await waitFor(appA.cdp, `document.querySelector('.account-avatar') && !document.querySelector('#login-form')`, 20_000);
  const restoredIdentity = await evaluate(appA.cdp, `document.querySelector('.account-copy strong')?.childNodes[0]?.textContent?.trim() || ''`);
  assert.ok(restoredIdentity);

  await stopElectron(appA);
  appA = null;
  const localDb = new DatabaseSync(path.join(tempRoot, 'alice', 'runtime', 'data', 'janus.db'));
  localDb.prepare("UPDATE cloud_auth_state SET updated_at = ? WHERE id = 'default'").run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());
  localDb.close();
  appA = await launchElectron('alice', 9514, alice);
  await waitFor(appA.cdp, `document.querySelector('#login-form')`, 20_000);
  const expiredLogin = await evaluate(appA.cdp, `({
    identifier: document.querySelector('#login-identifier')?.value || '',
    password: document.querySelector('#login-password')?.value || '',
  })`);
  assert.equal(expiredLogin.identifier, alice.email);
  assert.equal(expiredLogin.password, '');

  console.log(JSON.stringify({
    electronInstances: 2,
    realRendererAndIpc: true,
    productionCloud: true,
    publicFriendRequestGreeting: true,
    publicAcceptance: true,
    publicDirectChat: true,
    publicBidirectionalDirectChat: true,
    friendActionsUseOverflowMenu: true,
    socialPollingPreservesDraft: true,
    directChatDoesNotCreateGroup: true,
    privateDispatchDraftRequiresConfirmation: true,
    privateDispatchDraftConversationalRevision: true,
    outgoingTaskImmediatelyVisible: true,
    incomingTaskAutomaticallyPrepared: true,
    privateTaskWorkspacePersists: true,
    editablePptxGenerated: true,
    privateWorkspaceNotSharedToGroup: true,
    revisionResubmitAcceptClose: true,
    closedGroupArchivedUnderFriends: true,
    uBuddyExecutedCodex: true,
    realCodexModelRequest: useRealCodex,
    restartRestoredLogin: true,
    eightDayExpiryRememberedAccount: true,
    passwordBlankAfterExpiry: true,
  }));
} finally {
  await stopElectron(appA);
  await stopElectron(appB);
  cleanupUsers(users.map((item) => item.id));
  rmSync(tempRoot, { recursive: true, force: true });
}

function userFixture(label, suffix) {
  return {
    id: `user_electron_${label}_${suffix}`,
    email: `electron.${label}.${suffix}@janus.test`,
    username: `electron_${label}_${suffix}`.slice(0, 48),
    name: `Electron ${label[0].toUpperCase()}${label.slice(1)}`,
    password: `Electron-${label}-Password1!`,
  };
}

function insertUser(user) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(user.password, salt, 310000, 32, 'sha256').toString('base64url');
  const now = new Date().toISOString();
  serverDb.prepare(`INSERT INTO users (id, email, display_name, username, avatar_url, email_verified, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, '', 1, 'member', ?, ?, ?)`)
    .run(user.id, user.email, user.name, user.username, `pbkdf2$sha256$310000$${salt}$${hash}`, now, now);
}

async function launchElectron(label, debugPort, user) {
  const runtimeRoot = path.join(tempRoot, label, 'runtime');
  const profileRoot = path.join(tempRoot, label, 'profile');
  if (useRealCodex) seedRealCodexConfig(runtimeRoot);
  const env = {
    ...process.env,
    JANUS_HOME: runtimeRoot,
    JANUS_AUTH_URL: 'http://your-janus.example',
    JANUS_CODEX_BIN: useRealCodex ? realCodexBin : fakeCodex,
    JANUS_SOCIAL_POLL_INTERVAL_MS: '1000',
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
  const target = await waitForPageTarget(debugPort, 20_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  if (!useRealCodex) {
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('janus-sandbox-permission', 'full-access'); location.reload();`,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { child, cdp, stderr: () => stderr, user, debugPort };
}

function seedRealCodexConfig(runtimeRoot) {
  const configSource = path.join(realCodexHome, 'config.toml');
  const authSource = path.join(realCodexHome, 'auth.json');
  assert.ok(existsSync(realCodexBin), `Real Codex binary not found: ${realCodexBin}`);
  assert.ok(existsSync(configSource), `Real Codex config not found: ${configSource}`);
  assert.ok(existsSync(authSource), `Real Codex auth not found: ${authSource}`);
  const target = path.join(runtimeRoot, 'config', 'codex');
  mkdirSync(target, { recursive: true });
  copyFileSync(configSource, path.join(target, 'config.toml'));
  copyFileSync(authSource, path.join(target, 'auth.json'));
}

async function stopElectron(instance) {
  if (!instance) return;
  try { await instance.cdp?.close(); } catch {}
  const child = instance.child;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill();
    else process.kill(-child.pid, 'SIGTERM');
  } catch { try { child.kill(); } catch {} }
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 3_000);
  });
}

async function loginThroughUi(cdp, user) {
  await waitFor(cdp, `document.querySelector('#login-form')`, 20_000);
  await evaluate(cdp, `(() => {
    document.querySelector('#login-identifier').value = ${JSON.stringify(user.email)};
    document.querySelector('#login-password').value = ${JSON.stringify(user.password)};
    document.querySelector('#login-form').requestSubmit();
  })()`);
  await waitFor(cdp, `document.querySelector('.account-avatar') && !document.querySelector('#login-form')`, 20_000);
}

async function submitMainChat(cdp, content) {
  await waitFor(cdp, `document.querySelector('#chat-form')`);
  await waitFor(cdp, `document.querySelector('#chat-form .send-btn:not([disabled])')`);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input.value = ${JSON.stringify(content)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chat-form').requestSubmit();
  })()`);
}

async function openTaskDetail(cdp, groupId, delegationId) {
  await evaluate(cdp, `document.querySelector('[data-network-view="messages"]')?.click()`);
  await waitFor(cdp, `document.querySelector('.network-panel [data-collaboration-group="${groupId}"]')`, 30_000);
  await evaluate(cdp, `document.querySelector('.network-panel [data-collaboration-group="${groupId}"]').click()`);
  await waitFor(cdp, `document.querySelector('.collaboration-group-chat-view [data-network-delegation="${delegationId}"]')`, 30_000);
  await evaluate(cdp, `document.querySelector('.collaboration-group-chat-view [data-network-delegation="${delegationId}"]').click()`);
  await waitFor(cdp, `document.querySelector('.network-panel .network-delegation-detail')`, 30_000);
}

async function waitFor(cdp, expression, timeoutMs = 12_000) {
  const result = await evaluate(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + ${timeoutMs};
    const poll = () => {
      try { if (${expression}) return resolve(true); } catch {}
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for: ${expression.replaceAll("'", "\\'")}'));
      setTimeout(poll, 100);
    };
    poll();
  })`);
  return result;
}

async function waitForDb(probe, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for public database state.');
}

async function waitForRendererResult(cdp, expression, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await evaluate(cdp, expression);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for renderer result: ${JSON.stringify(latest)}`);
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

function cleanupUsers(ids) {
  serverDb.exec('BEGIN IMMEDIATE');
  try {
    const placeholders = ids.map(() => '?').join(',');
    if (placeholders) {
      serverDb.prepare(`DELETE FROM collaboration_groups WHERE owner_user_id IN (${placeholders})`).run(...ids);
    }
    for (const id of ids) {
      serverDb.prepare('DELETE FROM auth_access_tokens WHERE user_id = ?').run(id);
      serverDb.prepare('DELETE FROM auth_refresh_tokens WHERE user_id = ?').run(id);
      serverDb.prepare('DELETE FROM user_presence WHERE user_id = ?').run(id);
      serverDb.prepare('DELETE FROM social_messages WHERE sender_user_id = ? OR recipient_user_id = ?').run(id, id);
      serverDb.prepare('DELETE FROM agent_delegations WHERE requester_user_id = ? OR recipient_user_id = ?').run(id, id);
      serverDb.prepare('DELETE FROM friend_requests WHERE requester_id = ? OR recipient_id = ?').run(id, id);
      serverDb.prepare('DELETE FROM friendships WHERE user_a_id = ? OR user_b_id = ?').run(id, id);
      serverDb.prepare('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').run(id, id);
      serverDb.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    serverDb.exec('COMMIT');
  } catch (error) {
    serverDb.exec('ROLLBACK');
    throw error;
  }
}
