import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const outputDirectory = '/path/to/ui-pictures/codex-review-optimized';
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-real-codex-process-ui-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const workspaceRoot = path.join(tempRoot, 'workspace');
const profileRoot = path.join(tempRoot, 'profile');
const codexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const codexBin = process.env.JANUS_E2E_CODEX_BIN || path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const debugPort = Number(process.env.JANUS_REAL_CODEX_PROCESS_UI_PORT || 9488);
const marker = 'VISIBLE_RAW_MARKER_2840213075';
const completionMarker = 'LONG_CHAIN_COMPLETE_2840213075';
const quickMode = process.env.JANUS_REAL_CODEX_PROCESS_QUICK === '1';
const screenshots = [];
let child = null;
let cdp = null;
let electronStderr = '';
let sessionId = '';
let agentInstanceId = '';
let projectId = '';

mkdirSync(outputDirectory, { recursive: true });
for (const name of readdirSync(outputDirectory)) {
  if (name.startsWith('codex-process-')) rmSync(path.join(outputDirectory, name), { recursive: true, force: true });
}

try {
  assert.ok(existsSync(electronExe), `Electron binary not found: ${electronExe}`);
  assert.ok(existsSync(codexBin), `Real Codex binary not found: ${codexBin}`);
  assert.ok(existsSync(path.join(codexHome, 'config.toml')), 'Real Codex config.toml is missing.');
  assert.ok(existsSync(path.join(codexHome, 'auth.json')), 'Real Codex auth.json is missing.');
  const codexVersion = execFileSync(codexBin, ['--version'], { cwd: root, encoding: 'utf8' }).trim();

  seedWorkspace();
  const runtime = await createRuntime({ root: runtimeRoot, isDev: true });
  await runtime.authUpdateProfile({ displayName: '2840213075', username: '2840213075' });
  const user = runtime.currentUser();
  const general = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' });
  assert.ok(general?.id, 'Default general Agent instance is required.');
  agentInstanceId = general.id;
  const project = runtime.createProject({ title: '真实 Codex 全过程展示测试', workspaceRoot });
  projectId = project.id;
  const session = runtime.store.createSession({
    title: '真实 Codex 长链路全过程测试',
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId,
    projectId,
    workspaceRoot,
    userId: user.id,
  });
  sessionId = session.id;
  runtime.close();
  seedCodexConfig();

  child = launchElectron();
  const target = await waitForPageTarget(debugPort, 30_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1180, deviceScaleFactor: 1, mobile: false });
  await waitFor(`document.querySelector('#account-card')`, 30_000);
  await evaluate(`localStorage.setItem('janus-sandbox-permission', 'full-access'); location.reload();`);
  await waitFor(`document.querySelector('[data-tab="employees"]')`, 30_000);

  await click('#account-card');
  await click('[data-account-menu-action="settings"]');
  await waitFor(`document.querySelector('.account-settings-panel')?.innerText.includes('2840213075')`, 20_000);
  await capture('codex-process-00-account-2840213075.png', '.account-settings-panel');

  await click('#settings-back-btn');
  await waitFor(`document.querySelector('[data-tab="employees"]')`, 20_000);
  await click('[data-tab="employees"]');
  await waitFor(`document.querySelector('[data-employee-open-chat="${agentInstanceId}"]')`, 30_000);
  await capture('codex-process-01-general-agent-ready.png', `[data-employee-open-chat="${agentInstanceId}"]`);
  await click(`[data-employee-open-chat="${agentInstanceId}"]`);
  await waitFor(`document.querySelector('#chat-form') && document.querySelector('#chat-input')`, 30_000);
  const ready = await evaluate(`(async () => { const { state } = await import('./app/state.js'); return {
    username: state.currentUser?.username || '', displayName: state.currentUser?.displayName || state.currentUser?.display_name || '',
    sessionId: state.currentSessionId || '', agentInstanceId: state.currentAgentInstanceId || state.sessions?.find((item) => item.id === state.currentSessionId)?.agentInstanceId || '',
    workspaceRoot: state.sessions?.find((item) => item.id === state.currentSessionId)?.workspaceRoot || '',
  }; })()`);
  assert.equal(ready.username, '2840213075');
  assert.equal(ready.sessionId, sessionId);
  assert.equal(ready.agentInstanceId, agentInstanceId);
  assert.equal(path.resolve(ready.workspaceRoot), path.resolve(workspaceRoot));
  assert.equal(await evaluate(`!document.querySelector('.employee-conversation-work, [data-employee-active-work]')`), true,
    'The ordinary conversation must not show a current-work/current-idle banner.');

  const prompt = buildPrompt();
  await evaluate(`(() => {
    const input = document.querySelector('#chat-input');
    input.value = ${JSON.stringify(prompt)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chat-form').requestSubmit();
  })()`);
  await waitFor(`Array.from(document.querySelectorAll('.message.user')).some((item) => item.innerText.includes('${marker}'))`, 30_000);
  const userMessageLayout = await evaluate(`(() => {
    const message = Array.from(document.querySelectorAll('.message.user')).find((item) => item.innerText.includes('${marker}'));
    const list = message?.closest('.message-list');
    const body = message?.querySelector('.message-body');
    const avatar = message?.querySelector('.chat-message-avatar.is-self');
    if (!message || !list || !body || !avatar) return { found: false };
    const listRect = list.getBoundingClientRect();
    const messageRect = message.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const avatarRect = avatar.getBoundingClientRect();
    return {
      found: true,
      currentWorkAbsent: !document.querySelector('.employee-conversation-work, [data-employee-active-work]'),
      messageInside: messageRect.left >= listRect.left - 1 && messageRect.right <= listRect.right + 1,
      bodyInside: bodyRect.left >= listRect.left - 1 && bodyRect.right <= listRect.right + 1,
      avatarVisible: avatarRect.width >= 30 && avatarRect.height >= 30 && avatarRect.left >= listRect.left - 1 && avatarRect.right <= listRect.right + 1,
      wrapped: body.scrollWidth <= body.clientWidth + 1,
      bodyTextLength: body.innerText.length,
    };
  })()`);
  assert.equal(userMessageLayout.found, true, 'The user message and avatar were not rendered.');
  assert.equal(userMessageLayout.currentWorkAbsent, true, 'The current-work banner reappeared in the ordinary conversation.');
  assert.equal(userMessageLayout.messageInside, true, `The user message row overflowed the visible conversation: ${JSON.stringify(userMessageLayout)}`);
  assert.equal(userMessageLayout.bodyInside, true, `The user message bubble overflowed the visible conversation: ${JSON.stringify(userMessageLayout)}`);
  assert.equal(userMessageLayout.avatarVisible, true, `The user avatar is clipped or hidden: ${JSON.stringify(userMessageLayout)}`);
  assert.equal(userMessageLayout.wrapped, true, `The user message did not wrap inside its bubble: ${JSON.stringify(userMessageLayout)}`);
  await capture('codex-process-02-request-sent.png', '.message.user:last-of-type');

  const liveEvidence = {
    reasoning: false, commentary: false, command: false, file: false, richTimeline: false, humanDetailsExpandable: false,
    technicalMetadataHidden: false, usageCardHidden: false, protocolStatusHidden: false,
  };
  const startedAt = Date.now();
  let lastProgressLog = 0;
  while (Date.now() - startedAt < 15 * 60_000) {
    const probe = await evaluate(`(() => {
      const live = document.querySelector('.codex-transcript.is-streaming');
      const settled = document.querySelector('.codex-transcript:not(.is-streaming)');
      const finalMessages = Array.from(document.querySelectorAll('.message.assistant:not(.process-message) .message-body, .streaming-message:not(.is-streaming) .message-body'));
      return {
        live: Boolean(live), settled: Boolean(settled), running: Boolean(document.querySelector('#cancel-chat-btn')),
        reasoning: Boolean(live?.querySelector('.type-reasoning')),
        commentary: Boolean(live?.querySelector('.type-commentary')),
        command: Boolean(live?.querySelector('.codex-command-group')),
        file: Boolean(live?.querySelector('.codex-operation-item.type-file')),
        humanDetailsExpandable: Boolean(live?.querySelector('.codex-command-group, .codex-operation-item')),
        activityCount: live?.querySelectorAll('.codex-transcript-narrative, .codex-command-group, .codex-operation-item, .codex-system-status').length || 0,
        technicalOpenCount: live?.querySelectorAll('.codex-technical-stream[open], .codex-technical-activity[open], .codex-raw-protocol[open]').length || 0,
        visibleRuntimeMetadata: /Thread ID|Turn ID|Item ID|Process ID|解析后的命令动作|threadId|turnId|processId|commandActions/.test(live?.innerText || ''),
        usageCardVisible: Boolean(live?.querySelector(':scope > .type-usage')),
        protocolStatusVisible: /Codex 线程状态更新|Codex 本轮执行完成|\\[object Object\\]/.test(Array.from(live?.querySelectorAll(':scope > .codex-system-status, :scope > .codex-operation-item > summary, :scope > .codex-transcript-narrative, :scope > .codex-command-group > summary') || []).map((node) => node.innerText).join('\\n')),
        finalText: finalMessages.at(-1)?.innerText || '',
      };
    })()`);
    if (probe.reasoning && !liveEvidence.reasoning) {
      await capture('codex-process-03-live-reasoning.png', '.codex-transcript.is-streaming .type-reasoning');
      liveEvidence.reasoning = true;
    }
    if (probe.commentary) liveEvidence.commentary = true;
    if (probe.command && !liveEvidence.command) {
      await capture('codex-process-04-live-command.png', '.codex-transcript.is-streaming .codex-command-group');
      liveEvidence.command = true;
    }
    if (probe.file && !liveEvidence.file) {
      await capture('codex-process-05-live-file-change.png', '.codex-transcript.is-streaming .codex-operation-item.type-file');
      liveEvidence.file = true;
    }
    if (probe.live && probe.activityCount >= 7 && !liveEvidence.richTimeline) {
      await capture('codex-process-06-live-rich-timeline.png', '.codex-transcript.is-streaming');
      liveEvidence.richTimeline = true;
    }
    if (probe.humanDetailsExpandable) liveEvidence.humanDetailsExpandable = true;
    if (probe.live && probe.activityCount >= 4 && probe.technicalOpenCount === 0 && !probe.visibleRuntimeMetadata) {
      liveEvidence.technicalMetadataHidden = true;
    }
    if (probe.live && probe.activityCount >= 4 && !probe.usageCardVisible) liveEvidence.usageCardHidden = true;
    if (probe.live && probe.activityCount >= 4 && !probe.protocolStatusVisible) liveEvidence.protocolStatusHidden = true;
    if (!probe.running && probe.settled && probe.finalText.trim()) break;
    if (Date.now() - lastProgressLog > 15_000) {
      console.log(JSON.stringify({ phase: 'real_codex_running', elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), ...probe, finalText: probe.finalText.slice(0, 80) }));
      lastProgressLog = Date.now();
    }
    await delay(350);
  }

  const completed = await evaluate(`(() => ({
    running: Boolean(document.querySelector('#cancel-chat-btn')),
    settled: Boolean(document.querySelector('.codex-transcript:not(.is-streaming)')),
    finalText: Array.from(document.querySelectorAll('.message.assistant:not(.process-message) .message-body, .streaming-message:not(.is-streaming) .message-body')).at(-1)?.innerText || '',
  }))()`);
  assert.equal(completed.running, false, 'Real Codex UI run did not finish.');
  assert.equal(completed.settled, true, 'Settled process timeline is missing.');
  assert.ok(completed.finalText.trim(), 'Final Codex answer is missing.');
  const defaultDetailProbe = await evaluate(`(() => ({
    technicalStreams: document.querySelectorAll('.codex-technical-stream').length,
    openTechnicalStreams: document.querySelectorAll('.codex-technical-stream[open]').length,
    rawProtocolPanels: document.querySelectorAll('.codex-raw-protocol').length,
  }))()`);
  assert.equal(defaultDetailProbe.technicalStreams, 0, 'Raw technical activity must stay out of the user-facing transcript.');
  assert.equal(defaultDetailProbe.rawProtocolPanels, 0, 'Raw protocol envelopes must stay out of the user-facing transcript.');
  assert.equal(defaultDetailProbe.openTechnicalStreams, 0, 'Pure protocol activity must be collapsed by default.');
  await capture('codex-process-07-completed-overview.png', '.codex-transcript:not(.is-streaming)');

  await evaluate(`(() => {
    const transcript = document.querySelector('.codex-transcript:not(.is-streaming)');
    transcript?.querySelectorAll('.codex-command-group, .codex-command-item, .codex-operation-item, .codex-file-change').forEach((item) => { item.open = true; });
  })()`);
  await waitFor(`document.querySelector('.codex-transcript:not(.is-streaming) .codex-command-group[open], .codex-transcript:not(.is-streaming) .codex-operation-item[open]')`, 20_000);
  await delay(400);
  await capture('codex-process-08-expanded-all.png', '.codex-transcript:not(.is-streaming)');

  const finalAnswerFound = await evaluate(`(() => {
    const messages = Array.from(document.querySelectorAll('.message.assistant'));
    const message = [...messages].reverse().find((node) => node.innerText.includes('${completionMarker}'));
    if (!message) return false;
    const answer = Array.from(message.querySelectorAll('.assistant-result, .message-body'))
      .find((node) => node.innerText.includes('${completionMarker}')) || message;
    answer.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  assert.equal(finalAnswerFound, true, 'Final answer could not be focused for screenshot.');
  await delay(300);
  await captureRaw('codex-process-11-final-answer.png');

  await waitFor(`document.querySelector('.codex-change-summary .codex-change-review-button')`, 20_000);
  const changeSummaryProbe = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('.codex-change-summary'));
    const card = cards.at(-1);
    card?.scrollIntoView({ block: 'center' });
    return {
      cardCount: cards.length,
      fileCount: card?.querySelectorAll('.codex-change-summary-row').length || 0,
      text: card?.innerText || '',
      reviewButton: Boolean(card?.querySelector('.codex-change-review-button')),
      hoverPreviewCount: card?.querySelectorAll('.codex-change-hover-preview').length || 0,
      hoverAddedLines: card?.querySelectorAll('.codex-change-hover-preview .codex-review-diff-line.is-add').length || 0,
      hoverDeletedLines: card?.querySelectorAll('.codex-change-hover-preview .codex-review-diff-line.is-delete').length || 0,
    };
  })()`);
  assert.equal(changeSummaryProbe.cardCount, 1, `The final file summary must appear exactly once: ${JSON.stringify(changeSummaryProbe)}`);
  assert.ok(changeSummaryProbe.fileCount >= 3, `The real Codex turn did not expose enough changed files: ${JSON.stringify(changeSummaryProbe)}`);
  assert.match(changeSummaryProbe.text, /已编辑\s+\d+\s+个文件/);
  assert.match(changeSummaryProbe.text, /\+\d+/);
  assert.equal(changeSummaryProbe.reviewButton, true, 'The final change summary review button is missing.');
  assert.equal(changeSummaryProbe.hoverPreviewCount, changeSummaryProbe.fileCount, 'Every changed file must provide a hover preview.');
  assert.ok(changeSummaryProbe.hoverAddedLines > 0, 'Hover previews must mark added lines.');
  assert.ok(changeSummaryProbe.hoverDeletedLines > 0, 'Hover previews must mark deleted lines.');
  await evaluate(`(() => {
    document.activeElement?.blur?.();
    document.documentElement.classList.add('codex-hover-suppressed');
    document.querySelectorAll('.codex-change-summary-row').forEach((row) => row.classList.remove('is-preview-open'));
  })()`);
  await delay(300);
  await captureRaw('codex-process-12-final-change-summary.png');

  const hoverPreviewReady = await evaluate(`(() => {
    const row = document.querySelector('.codex-change-summary-files .codex-change-summary-row') || document.querySelector('.codex-change-summary-row');
    if (!row) return false;
    row.scrollIntoView({ block: 'center' });
    document.documentElement.classList.remove('codex-hover-suppressed');
    row.classList.add('is-preview-open');
    return true;
  })()`);
  assert.equal(hoverPreviewReady, true, 'No changed-file row was available for hover verification.');
  await waitFor(`(() => { const node = document.querySelector('.codex-change-summary-files .codex-change-hover-preview') || document.querySelector('.codex-change-hover-preview'); return Boolean(node && getComputedStyle(node).display !== 'none'); })()`, 20_000);
  await delay(300);
  await captureRaw('codex-process-13-change-hover-preview.png');

  await evaluate(`document.querySelectorAll('.codex-change-summary-row').forEach((row) => row.classList.remove('is-preview-open'))`);
  await click('.codex-change-summary .codex-change-review-button');
  await waitFor(`document.querySelector('[data-codex-review-dialog][open]')`, 20_000);
  const reviewProbe = await evaluate(`(() => {
    const dialog = document.querySelector('[data-codex-review-dialog][open]');
    return {
      open: Boolean(dialog?.open),
      files: dialog?.querySelectorAll('[data-codex-review-select]').length || 0,
      panels: dialog?.querySelectorAll('[data-codex-review-panel]').length || 0,
      activePanels: dialog?.querySelectorAll('[data-codex-review-panel].is-active').length || 0,
      addedLines: dialog?.querySelectorAll('.codex-review-diff-line.is-add').length || 0,
      deletedLines: dialog?.querySelectorAll('.codex-review-diff-line.is-delete').length || 0,
      composerInteractive: Boolean(document.querySelector('#chat-input') && !document.querySelector('#chat-input').disabled && !document.querySelector('.conversation-panel')?.inert),
      nonModal: !document.querySelector('dialog:modal'),
      text: dialog?.innerText || '',
    };
  })()`);
  assert.equal(reviewProbe.open, true, 'The review dialog did not open.');
  assert.equal(reviewProbe.files, changeSummaryProbe.fileCount, 'The review dialog file list does not match the final summary.');
  assert.equal(reviewProbe.panels, reviewProbe.files, 'Each review file must have a corresponding diff panel.');
  assert.equal(reviewProbe.activePanels, 1, 'Exactly one review file panel must be active.');
  assert.ok(reviewProbe.addedLines + reviewProbe.deletedLines > 0, 'The review dialog did not render line-level changes.');
  assert.equal(reviewProbe.composerInteractive, true, 'The conversation composer must remain interactive while review is open.');
  assert.equal(reviewProbe.nonModal, true, 'The review surface must be a non-modal right-side panel.');
  assert.match(reviewProbe.text, /上一轮/);
  await delay(300);
  await captureRaw('codex-process-14-review-dialog.png');

  const composerFocusWhileReviewOpen = await evaluate(`(() => { const input = document.querySelector('#chat-input'); input?.focus(); return document.activeElement === input && Boolean(document.querySelector('[data-codex-review-dialog][open]')); })()`);
  assert.equal(composerFocusWhileReviewOpen, true, 'The user must be able to focus and continue the conversation while review remains open.');

  if (reviewProbe.files > 1) {
    await evaluate(`document.querySelectorAll('[data-codex-review-dialog][open] [data-codex-review-select]')[1]?.click()`);
    await waitFor(`document.querySelectorAll('[data-codex-review-dialog][open] [data-codex-review-panel]')[1]?.classList.contains('is-active')`, 20_000);
    await delay(250);
    await captureRaw('codex-process-15-review-second-file.png');
  }
  await click('[data-codex-review-dialog][open] [data-codex-review-close]');
  await waitFor(`!document.querySelector('[data-codex-review-dialog][open]')`, 20_000);

  const uiEvidence = await evaluate(`(async () => {
    const { state } = await import('./app/state.js');
    const messages = state.messages.filter((item) => item.id && !item.metadata?.transient);
    const assistant = [...messages].reverse().find((item) => (
      item.role === 'assistant' && Array.isArray(item.metadata?.processEvents) && item.metadata.processEvents.length
    )) || [...messages].reverse().find((item) => item.role === 'assistant') || null;
    const events = assistant?.metadata?.processEvents || [];
    return {
      currentUser: state.currentUser,
      currentSessionId: state.currentSessionId,
      currentAgentInstanceId: state.currentAgentInstanceId,
      assistant: assistant ? { id: assistant.id, content: assistant.content, metadata: assistant.metadata } : null,
      processEvents: events,
      activityTypes: [...new Set(events.map((item) => item.activityType).filter(Boolean))],
      protocolEventCount: events.reduce((sum, item) => sum + (Array.isArray(item.protocolEvents) ? item.protocolEvents.length : 0), 0),
      protocolMethods: [...new Set(events.flatMap((item) => (item.protocolEvents || []).map((event) => event.method)).filter(Boolean))],
      expandableCount: document.querySelectorAll('.codex-command-group, .codex-command-item, .codex-operation-item, .codex-technical-stream').length,
    };
  })()`);
  assert.equal(uiEvidence.currentUser?.username, '2840213075');
  assert.equal(uiEvidence.currentSessionId, sessionId);
  assert.ok(uiEvidence.processEvents.length >= 7, `Too few process events: ${uiEvidence.processEvents.length}`);
  assert.ok(uiEvidence.activityTypes.includes('reasoning'), 'Reasoning activity is missing.');
  assert.ok(uiEvidence.activityTypes.includes('command'), 'Command activity is missing.');
  assert.ok(uiEvidence.activityTypes.includes('file'), 'File-change activity is missing.');
  assert.ok(uiEvidence.protocolEventCount > 0, 'Raw protocol events are missing.');
  assert.equal(liveEvidence.commentary, true, 'Codex commentary was not promoted into the human-readable transcript.');
  assert.equal(liveEvidence.humanDetailsExpandable, true, 'Human-readable command and operation details were not expandable.');
  assert.equal(liveEvidence.technicalMetadataHidden, true, 'Runtime IDs leaked into the default human-readable timeline.');
  assert.equal(liveEvidence.usageCardHidden, true, 'Token usage was rendered as a default timeline card.');
  assert.equal(liveEvidence.protocolStatusHidden, true, 'Thread/turn protocol status leaked into the human-readable timeline.');

  writeFileSync(path.join(outputDirectory, 'codex-process-events.json'), `${JSON.stringify(uiEvidence, null, 2)}\n`);
  await stopElectron();

  const persisted = readPersistedEvidence();
  assert.ok(persisted.processEventCount >= uiEvidence.processEvents.length, 'Persisted process event count regressed after restart boundary.');
  assert.ok(persisted.protocolEventCount > 0, 'Persisted raw protocol events are missing.');
  assert.ok(persisted.completeEnvelopeCount > 0, 'Complete JSON-RPC envelopes were not persisted.');
  const artifactDirectory = path.join(outputDirectory, 'codex-process-workspace');
  mkdirSync(artifactDirectory, { recursive: true });
  for (const relative of ['src/analyze.mjs', 'test/analyze.test.mjs', 'src/calc.mjs', 'test/calc.test.mjs', 'README.md', 'report.json']) {
    const source = path.join(workspaceRoot, relative);
    if (existsSync(source)) {
      const target = path.join(artifactDirectory, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target);
    }
  }
  const result = {
    passed: true,
    testedAt: new Date().toISOString(),
    account: { username: '2840213075', displayName: '2840213075' },
    codex: { binary: codexBin, version: codexVersion, interface: 'app-server' },
    agent: { familyId: 'general_agent', instanceId: agentInstanceId, displayName: '通用 Agent A' },
    projectId,
    sessionId,
    finalAnswer: completed.finalText,
    completionMarkerPresent: completed.finalText.includes(completionMarker),
    quickMode,
    defaultDetailProbe,
    liveEvidence,
    userMessageLayout,
    changeSummaryProbe,
    reviewProbe,
    persisted,
    screenshots,
    artifactDirectory,
  };
  writeFileSync(path.join(outputDirectory, 'codex-process-real-ui-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  throw new Error(`${error.stack || error.message}\nElectron stderr:\n${electronStderr.slice(-8000)}`);
} finally {
  await stopElectron();
  rmSync(tempRoot, { recursive: true, force: true });
}

function seedWorkspace() {
  mkdirSync(path.join(workspaceRoot, 'logs'), { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'marker.txt'), `${marker}\n`);
  writeFileSync(path.join(workspaceRoot, 'logs', 'api.log'), [
    '2026-07-31T08:00:00Z INFO request route=/health duration_ms=12',
    '2026-07-31T08:00:01Z WARN request route=/search duration_ms=480',
    '2026-07-31T08:00:02Z ERROR request route=/checkout duration_ms=920 code=E_TIMEOUT',
    '2026-07-31T08:00:03Z INFO request route=/health duration_ms=9',
  ].join('\n') + '\n');
  writeFileSync(path.join(workspaceRoot, 'logs', 'worker.log'), [
    '2026-07-31T08:01:00Z INFO job=sync duration_ms=110',
    '2026-07-31T08:01:01Z ERROR job=invoice duration_ms=1500 code=E_RETRY',
    '2026-07-31T08:01:02Z WARN job=cleanup duration_ms=610',
    '2026-07-31T08:01:03Z INFO job=sync duration_ms=95',
  ].join('\n') + '\n');
  writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), '# Test workspace\n\nKeep all edits inside this workspace. Use apply_patch for file changes. Run commands separately.\n');
  writeFileSync(path.join(workspaceRoot, 'README.md'), '# Calculator utilities\n\nTODO: document the calculator helpers.\n');
  execFileSync('git', ['init', '-q'], { cwd: workspaceRoot });
  execFileSync('git', ['config', 'user.name', 'Janus UI Test'], { cwd: workspaceRoot });
  execFileSync('git', ['config', 'user.email', 'ui-test@janus.local'], { cwd: workspaceRoot });
  execFileSync('git', ['add', 'README.md'], { cwd: workspaceRoot });
  execFileSync('git', ['commit', '-q', '-m', 'seed review baseline'], { cwd: workspaceRoot });
}

function seedCodexConfig() {
  const target = path.join(runtimeRoot, 'config', 'codex');
  mkdirSync(target, { recursive: true });
  copyFileSync(path.join(codexHome, 'config.toml'), path.join(target, 'config.toml'));
  copyFileSync(path.join(codexHome, 'auth.json'), path.join(target, 'auth.json'));
}

function buildPrompt() {
  if (quickMode) return `请完成一个用于验证 Codex 可读过程展示的真实代码任务。每阶段先发一句简短进度说明；不访问网络、不使用子 Agent；命令分开执行；文件修改只用 apply_patch。\n\n1. 分别运行 pwd 和 cat marker.txt，确认 ${marker}。\n2. 用一次 apply_patch 创建 src/calc.mjs、test/calc.test.mjs，并修改已存在的 README.md：实现 sum(values)，写两项 node:test 测试和用法，删除 README 里的 TODO 占位行。\n3. 单独运行 node --test test/calc.test.mjs。\n4. 第二次用 apply_patch 增加 average(values)，同步补测试和 README。\n5. 再次单独运行 node --test test/calc.test.mjs。最终简洁总结三个文件、两轮修改和测试结果，以 ${completionMarker} 结尾。`;
  return `请执行一个真实的长链路代码任务，用于验证 Janus 对 Codex 中间过程的完整展示。\n\n硬性要求：\n1. 每个阶段开始前先发送一句简短进度说明。\n2. 所有工作只能在当前工作区内完成，不访问网络，不使用子 Agent。\n3. 命令要分开执行，不要把所有检查合并成一条。\n4. 文件修改必须使用 apply_patch。\n\n阶段一：分别运行 pwd、cat marker.txt、find logs -maxdepth 1 -type f -print、sed 查看两个日志文件，并明确观察到 ${marker}。\n阶段二：创建 src/analyze.mjs、test/analyze.test.mjs、README.md。分析器读取日志，统计 INFO/WARN/ERROR、平均与最大 duration_ms、错误码，并支持 JSON 报告。\n阶段三：分别运行分析器、运行 node --test test/analyze.test.mjs、查看生成的 report.json。\n阶段四：做第二轮 apply_patch，增加 --level 过滤参数，补充测试和 README；随后再次分别运行测试、过滤分析和完整分析。\n阶段五：分别检查最终文件内容和 report.json，确认没有修改工作区外的内容。\n\n最终回答请总结创建的文件、两轮修改、测试结果、报告统计，并以 ${completionMarker} 结尾。`;
}

function launchElectron() {
  const env = {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    JANUS_HOME: runtimeRoot,
    JANUS_AUTH_URL: '',
    JANUS_CODEX_BIN: codexBin,
    JANUS_MODEL_REFRESH_ENABLED: '0',
    JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
    JANUS_LOCAL_EVOLUTION_ENABLED: '0',
    JANUS_UPDATES_ENABLED: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = spawn(electronExe, ['--no-sandbox', `--user-data-dir=${profileRoot}`, `--remote-debugging-port=${debugPort}`, '.'], {
    cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  instance.stderr.on('data', (chunk) => { electronStderr += chunk.toString(); });
  instance.stdout.on('data', (chunk) => { process.stdout.write(chunk); });
  return instance;
}

async function stopElectron() {
  try { cdp?.close(); } catch {}
  cdp = null;
  if (!child || child.exitCode !== null) return;
  try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch {} }
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3500); });
}

function readPersistedEvidence() {
  const db = new DatabaseSync(path.join(runtimeRoot, 'data', 'janus.db'), { readOnly: true });
  try {
    const rows = db.prepare(`SELECT content, metadata_json FROM messages WHERE session_id=? AND role='assistant' ORDER BY created_at DESC`).all(sessionId);
    const row = rows.find((item) => {
      try { return JSON.parse(item.metadata_json || '{}')?.processEvents?.length > 0; } catch { return false; }
    }) || rows[0];
    assert.ok(row, 'Persisted assistant message is missing.');
    const metadata = JSON.parse(row.metadata_json || '{}');
    const processEvents = Array.isArray(metadata.processEvents) ? metadata.processEvents : [];
    const protocols = processEvents.flatMap((item) => Array.isArray(item.protocolEvents) ? item.protocolEvents : []);
    const execution = db.prepare('SELECT status,codex_thread_id,codex_turn_id,effective_model,metadata_json FROM model_executions WHERE conversation_id=? ORDER BY started_at DESC LIMIT 1').get(sessionId);
    return {
      messageContentLength: String(row.content || '').length,
      processEventCount: processEvents.length,
      protocolEventCount: protocols.length,
      completeEnvelopeCount: protocols.filter((event) => event.envelope && typeof event.envelope === 'object').length,
      protocolMethods: [...new Set(protocols.map((event) => event.method).filter(Boolean))],
      execution,
    };
  } finally { db.close(); }
}

async function capture(name, selector = '') {
  if (selector) await evaluate(`(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); const node = nodes[nodes.length - 1]; if (node) node.scrollIntoView({ block: 'center' }); return Boolean(node); })()`);
  await delay(250);
  await captureRaw(name);
}

async function captureRaw(name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(outputDirectory, name), Buffer.from(result.data, 'base64'));
  if (!screenshots.includes(name)) screenshots.push(name);
}

async function click(selector) {
  await waitFor(`document.querySelector(${JSON.stringify(selector)})`, 20_000);
  const clicked = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.scrollIntoView({ block: 'center' }); node.click(); return true; })()`);
  assert.equal(clicked, true, `Unable to click ${selector}`);
  await delay(250);
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
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
    await delay(200);
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

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
