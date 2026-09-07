import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const outputDirectory = '/path/to/ui-pictures';
const testHome = mkdtempSync(path.join(os.tmpdir(), 'janus-memory-reference-real-ui-'));
const projectRoot = path.join(testHome, 'reference-project');
const port = Number(process.env.JANUS_MEMORY_REFERENCE_UI_PORT || 9488);
const useRealCodex = process.env.JANUS_PROJECT_REFERENCE_REAL_CODEX === '1';
const codexBin = process.env.JANUS_E2E_CODEX_BIN || '/usr/bin/codex';
const codexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const fileReadMarker = 'PROJECT_REFERENCE_READ_MARKER_731904';
const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);
mkdirSync(outputDirectory, { recursive: true });
mkdirSync(path.join(projectRoot, 'src', 'renderer'), { recursive: true });
mkdirSync(path.join(testHome, 'removable-project'), { recursive: true });
writeFileSync(path.join(projectRoot, 'README.md'), '# Janus @ 引用测试\n', 'utf8');
writeFileSync(path.join(projectRoot, 'design-preview.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
writeFileSync(path.join(projectRoot, 'requirements.docx'), 'Word fixture', 'utf8');
writeFileSync(path.join(projectRoot, 'metrics.xlsx'), 'Spreadsheet fixture', 'utf8');
writeFileSync(path.join(projectRoot, 'architecture.pdf'), 'PDF fixture', 'utf8');
writeFileSync(path.join(projectRoot, 'release.zip'), 'Archive fixture', 'utf8');
writeFileSync(path.join(projectRoot, 'src', 'app.js'), `export const projectReference = '${fileReadMarker}';\n`, 'utf8');
writeFileSync(path.join(projectRoot, 'src', 'renderer', 'panel.js'), 'export const panel = "memory";\n', 'utf8');
for (const name of ['memory-context-manager.png', 'memory-create-agent-dialog.png', 'chat-memory-button-menu.png', 'memory-create-chat-dialog.png',
  'project-picker-delete-button.png', 'project-at-browser.png', 'project-at-reference.png', 'project-at-real-codex-read.png',
  'memory-project-reference-ui-result.json']) {
  rmSync(path.join(outputDirectory, name), { force: true });
}

const seedRuntime = await createRuntime({ root: testHome, isDev: true, serverAuthoritativeSkills: true });
let agentInstanceId = '';
let projectId = '';
let removableProjectId = '';
try {
  const user = seedRuntime.currentUser();
  const instance = seedRuntime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || seedRuntime.store.recruitUserAgent({ userId: user.id, agentFamilyId: 'general_agent', commandId: 'memory-reference-ui:recruit' }).instance;
  agentInstanceId = instance.id;
  const session = seedRuntime.store.createSession({
    title: 'Memory 与 @ UI 验证', departmentId: 'general', agentId: 'general_agent', agentInstanceId: instance.id, userId: user.id,
  });
  const memoryA = seedRuntime.store.listMemoryDocuments({ agentInstanceId: instance.id }).find((item) => item.scope === 'general');
  seedRuntime.store.renameMemoryDocument({ memoryDocumentId: memoryA.id, displayName: '数据库迁移设计' });
  seedRuntime.store.addMessage({
    sessionId: session.id, role: 'user', content: '请保留迁移前后的消息、附件和执行记录。',
    agentId: 'general_agent', agentInstanceId: instance.id, departmentId: 'general',
    metadata: { attachments: [{ id: 'migration-plan', name: 'migration-plan.md', contentType: 'text/markdown', sizeBytes: 128, sha256: 'ui-fixture' }] },
  });
  const memoryB = seedRuntime.store.createNextGeneralMemoryDocument({ agentInstanceId: instance.id, displayName: '产品发布计划' });
  seedRuntime.store.addMessage({
    sessionId: session.id, role: 'user', content: '整理发布节奏、风险清单和回滚方案。',
    agentId: 'general_agent', agentInstanceId: instance.id, departmentId: 'general',
  });
  seedRuntime.store.switchCurrentMemory({ agentInstanceId: instance.id, memoryDocumentId: memoryA.id });
  seedRuntime.store.archiveMemoryDocument({ memoryDocumentId: memoryB.id });
  const project = seedRuntime.createProject({ title: 'Janus 引用演示项目', workspaceRoot: projectRoot });
  projectId = project.id;
  removableProjectId = seedRuntime.createProject({ title: '可移除项目', workspaceRoot: path.join(testHome, 'removable-project') }).id;
} finally {
  seedRuntime.close();
}

const childEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  JANUS_LOCAL_EVOLUTION_ENABLED: '0',
  JANUS_MODEL_REFRESH_ENABLED: '0',
  JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
  JANUS_HOME: testHome,
  JANUS_AUTH_URL: '',
  JANUS_UPDATES_ENABLED: '0',
  JANUS_ENABLE_TEST_HOOKS: '1',
  JANUS_TEST_ALLOW_MULTIPLE_INSTANCES: '1',
  JANUS_TEST_WORKSPACE_SELECTION_ROOT: projectRoot,
};
if (useRealCodex) {
  assert.ok(existsSync(codexBin), `Real Codex binary is missing: ${codexBin}`);
  assert.ok(existsSync(path.join(codexHome, 'config.toml')), 'Real Codex config.toml is missing.');
  assert.ok(existsSync(path.join(codexHome, 'auth.json')), 'Real Codex auth.json is missing.');
  const target = path.join(testHome, 'config', 'codex');
  mkdirSync(target, { recursive: true });
  copyFileSync(path.join(codexHome, 'config.toml'), path.join(target, 'config.toml'));
  copyFileSync(path.join(codexHome, 'auth.json'), path.join(target, 'auth.json'));
  childEnv.JANUS_CODEX_BIN = codexBin;
}
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electronExe, ['--no-sandbox', `--user-data-dir=${path.join(testHome, 'profile')}`, `--remote-debugging-port=${port}`, '.'], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const target = await waitForPageTarget(port, 25_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('[data-tab="employees"]')`, 25_000);

  await click(cdp, '[data-tab="employees"]');
  await waitForRenderer(cdp, `document.querySelector('[data-employee-installed-context="${agentInstanceId}"]')`, 20_000);
  await evaluate(cdp, `(() => {
    const item = document.querySelector('[data-employee-installed-context="${agentInstanceId}"]');
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 18, clientY: rect.bottom + 8 }));
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-employee-context-action="memory"]')`, 10_000);
  await click(cdp, '[data-employee-context-action="memory"]');
  await waitForRenderer(cdp, `document.querySelector('.employee-memory-archived-section') && document.querySelector('.employee-memory-context-detail')`, 20_000);
  await click(cdp, '.employee-memory-context-detail > summary');
  assert.equal(await evaluate(cdp, `document.querySelector('.employee-memory-context-detail')?.open`), false, 'Memory preview must support collapsing');
  await click(cdp, '.employee-memory-context-detail > summary');
  assert.equal(await evaluate(cdp, `document.querySelector('.employee-memory-context-detail')?.open`), true, 'Memory preview must reopen after collapsing');
  const memoryProbe = await evaluate(cdp, `(() => {
    const drawer = document.querySelector('.employee-memory-drawer');
    const text = drawer?.innerText || '';
    return {
      title: drawer?.querySelector('h2')?.textContent || '',
      hasActive: text.includes('活跃 Memory') && text.includes('数据库迁移设计'),
      hasArchived: text.includes('已归档 Memory') && text.includes('产品发布计划'),
      hidesVersions: !/所选记忆的版本|\\bv-?\\d+\\b|历史会话/.test(text),
      hasCounts: text.includes('条消息') && text.includes('个文件'),
      hasReadOnlyContent: text.includes('请保留迁移前后的消息'),
      labelsPreview: text.includes('Memory 内容预览') && text.includes('点击折叠'),
      filePathOnly: text.includes('附件/migration-plan.md') && !text.includes('附件\\n'),
    };
  })()`);
  assert.ok(memoryProbe.title.includes('对话上下文'));
  assert.ok(memoryProbe.hasActive && memoryProbe.hasArchived && memoryProbe.hidesVersions && memoryProbe.hasCounts && memoryProbe.hasReadOnlyContent
    && memoryProbe.labelsPreview && memoryProbe.filePathOnly,
    `Memory UI probe failed: ${JSON.stringify(memoryProbe)}`);
  await captureScreenshot(cdp, 'memory-context-manager.png');

  await click(cdp, '[data-employee-memory-create]');
  await waitForRenderer(cdp, `document.querySelector('#memory-name-form') && document.querySelector('#memory-name-input')`, 10_000);
  await captureScreenshot(cdp, 'memory-create-agent-dialog.png');
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#memory-name-input');
    input.value = 'Agent 详情新建验证';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#memory-name-form').requestSubmit();
  })()`);
  await waitForRenderer(cdp, `!document.querySelector('#memory-name-form') && document.querySelector('.employee-memory-drawer')?.innerText.includes('Agent 详情新建验证')`, 20_000);

  await click(cdp, '[data-employee-detail-close]');
  await click(cdp, `[data-employee-installed-context="${agentInstanceId}"]`);
  await waitForRenderer(cdp, `document.querySelector('#chat-input') && document.querySelector('[data-workspace-menu-toggle]') && document.querySelector('[data-composer-memory-toggle]')`, 20_000);
  assert.equal(await evaluate(cdp, `Boolean(document.querySelector('.project-mention-picker'))`), false,
    'The project @ picker must stay hidden until a valid project is selected.');
  await click(cdp, '[data-composer-memory-toggle]');
  await waitForRenderer(cdp, `document.querySelector('.composer-memory-menu') && document.querySelector('[data-composer-memory-switch]')`, 15_000);
  const memoryButtonProbe = await evaluate(cdp, `(() => {
    const trigger = document.querySelector('[data-composer-memory-toggle]');
    const menu = document.querySelector('.composer-memory-menu');
    const text = menu?.innerText || '';
    return {
      trigger: trigger?.innerText || '',
      hasCurrentMemory: text.includes('Agent 详情新建验证') && text.includes('当前对话上下文'),
      hasCreate: text.includes('新建 Memory'),
      hidesArchived: !text.includes('产品发布计划'),
    };
  })()`);
  assert.ok(memoryButtonProbe.trigger.includes('Agent 详情新建验证') && memoryButtonProbe.hasCurrentMemory && memoryButtonProbe.hasCreate && memoryButtonProbe.hidesArchived,
    `composer Memory button probe failed: ${JSON.stringify(memoryButtonProbe)}`);
  await captureScreenshot(cdp, 'chat-memory-button-menu.png');
  await click(cdp, '[data-composer-memory-create]');
  await waitForRenderer(cdp, `document.querySelector('#memory-name-form') && document.querySelector('#memory-name-input')`, 10_000);
  await captureScreenshot(cdp, 'memory-create-chat-dialog.png');
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#memory-name-input');
    input.value = '对话框新建验证';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#memory-name-form').requestSubmit();
  })()`);
  await waitForRenderer(cdp, `!document.querySelector('#memory-name-form') && document.querySelector('[data-composer-memory-toggle]')?.innerText.includes('对话框新建验证')`, 20_000);
  await click(cdp, '[data-workspace-menu-toggle]');
  await waitForRenderer(cdp, `document.querySelector('[data-workspace-project="${projectId}"]')`, 10_000);
  assert.equal(await evaluate(cdp, `Boolean(document.querySelector('[data-workspace-project-remove="${removableProjectId}"]'))`), true,
    'Project picker must expose a remove button for each project.');
  await captureScreenshot(cdp, 'project-picker-delete-button.png');
  await click(cdp, `[data-workspace-project="${projectId}"]`);
  await waitForRenderer(cdp, `document.querySelector('.project-mention-picker [data-social-mention-toggle]')`, 10_000);
  await click(cdp, '.project-mention-picker [data-social-mention-toggle]');
  await waitForRenderer(cdp, `document.querySelector('[data-project-reference-directory="src"]') && document.querySelector('[data-project-reference-select="README.md"]')`, 15_000);
  const mentionVisualProbe = await evaluate(cdp, `(() => {
    const menu = document.querySelector('.project-mention-menu');
    const search = document.querySelector('.project-mention-search');
    const searchInput = document.querySelector('[data-project-reference-query]');
    const rect = menu?.getBoundingClientRect();
    return {
      menuBackground: menu ? getComputedStyle(menu).backgroundColor : '',
      searchBackground: search ? getComputedStyle(search).backgroundColor : '',
      inputBackground: searchInput ? getComputedStyle(searchInput).backgroundColor : '',
      fitsViewport: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth),
    };
  })()`);
  assert.deepEqual(mentionVisualProbe, {
    menuBackground: 'rgb(255, 255, 255)',
    searchBackground: 'rgb(255, 255, 255)',
    inputBackground: 'rgb(255, 255, 255)',
    fitsViewport: true,
  });
  const rootBrowserProbe = await evaluate(cdp, `(() => {
    const menu = document.querySelector('.project-mention-menu');
    const text = menu?.innerText || '';
    return {
      hasProject: text.includes('Janus 引用演示项目'),
      hasRootFile: text.includes('README.md'),
      hasFolder: text.includes('src'),
      hasKeyboardHelp: text.includes('可连续多选') && text.includes('Enter / Tab'),
      hasExplorerIcons: Boolean(menu?.querySelector('[data-project-reference-icon="directory"]')
        && menu?.querySelector('[data-project-reference-icon="image"]')
        && menu?.querySelector('[data-project-reference-icon="word"]')
        && menu?.querySelector('[data-project-reference-icon="sheet"]')
        && menu?.querySelector('[data-project-reference-icon="pdf"]')
        && menu?.querySelector('[data-project-reference-icon="archive"]')),
      noRecursiveDeepFileWithoutQuery: !text.includes('panel.js'),
      noAbsolutePath: !text.includes(${JSON.stringify(projectRoot)}),
    };
  })()`);
  assert.ok(Object.values(rootBrowserProbe).every(Boolean), `root @ browser probe failed: ${JSON.stringify(rootBrowserProbe)}`);
  await captureScreenshot(cdp, 'project-at-browser.png');
  await evaluate(cdp, `document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitForRenderer(cdp, `!document.querySelector('.project-mention-menu')`, 10_000);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input.focus();
    input.value = '@pan';
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-project-reference-select="src/renderer/panel.js"]') && document.activeElement?.id === 'chat-input'`, 15_000);
  await evaluate(cdp, `document.querySelector('#chat-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await waitForRenderer(cdp, `document.querySelector('#chat-input')?.value.includes('@src/renderer/panel.js') && document.querySelector('.project-mention-menu') && document.activeElement?.matches('[data-project-reference-query]')`, 15_000);
  await evaluate(cdp, `(() => {
    const search = document.querySelector('[data-project-reference-query]');
    search.value = 'app';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-project-reference-select="src/app.js"]')`, 15_000);
  await evaluate(cdp, `document.querySelector('[data-project-reference-query]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await waitForRenderer(cdp, `document.querySelectorAll('.composer-reference-card.is-file').length === 2 && document.querySelector('#chat-input')?.value.includes('@src/app.js') && document.querySelector('.project-mention-menu')`, 15_000);
  const referenceProbe = await evaluate(cdp, `(() => ({
    cards: Array.from(document.querySelectorAll('.composer-reference-card.is-file')).map((item) => item.innerText || ''),
    draft: document.querySelector('#chat-input')?.value || '',
    menuOpen: Boolean(document.querySelector('.project-mention-menu')),
    searchFocused: document.activeElement?.matches('[data-project-reference-query]') || false,
  }))()`);
  assert.ok(referenceProbe.cards.some((text) => text.includes('src/app.js'))
      && referenceProbe.cards.some((text) => text.includes('src/renderer/panel.js'))
      && referenceProbe.draft.includes('@src/app.js')
      && referenceProbe.draft.includes('@src/renderer/panel.js')
      && referenceProbe.menuOpen
      && referenceProbe.searchFocused,
    `selected @ reference probe failed: ${JSON.stringify(referenceProbe)}`);
  await captureScreenshot(cdp, 'project-at-reference.png');
  await evaluate(cdp, `document.querySelector('[data-project-reference-query]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitForRenderer(cdp, `!document.querySelector('.project-mention-menu') && document.activeElement?.id === 'chat-input'`, 10_000);

  let realCodexProbe = null;
  if (useRealCodex) {
    await evaluate(cdp, `(() => {
      const input = document.querySelector('#chat-input');
      input.value = input.value + '\\n请读取我刚刚明确选择的项目文件，只回复 projectReference 常量的字符串值，不要解释。';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#chat-form').requestSubmit();
    })()`);
    await waitForRenderer(cdp, `Boolean(document.querySelector('#cancel-chat-btn'))`, 60_000);
    await waitForRenderer(cdp, `(() => {
      if (document.querySelector('#cancel-chat-btn')) return false;
      return Array.from(document.querySelectorAll('.message.assistant .message-body, .streaming-message:not(.is-streaming) .message-body'))
        .some((item) => (item.innerText || '').includes('${fileReadMarker}'));
    })()`, 5 * 60_000);
    realCodexProbe = await evaluate(cdp, `(() => {
      const answers = Array.from(document.querySelectorAll('.message.assistant .message-body, .streaming-message:not(.is-streaming) .message-body'));
      const answer = answers.map((item) => item.innerText || '').find((text) => text.includes('${fileReadMarker}')) || '';
      return { answer, markerFound: answer.includes('${fileReadMarker}'), pickerStillVisible: Boolean(document.querySelector('.project-mention-picker')) };
    })()`);
    assert.equal(realCodexProbe.markerFound, true, `Real Codex did not read the selected file: ${JSON.stringify(realCodexProbe)}`);
    await captureScreenshot(cdp, 'project-at-real-codex-read.png');
  }

  await click(cdp, '[data-workspace-menu-toggle]');
  await waitForRenderer(cdp, `document.querySelector('[data-workspace-project-remove="${removableProjectId}"]')`, 10_000);
  await evaluate(cdp, `window.confirm = () => true`);
  await click(cdp, `[data-workspace-project-remove="${removableProjectId}"]`);
  await waitForRenderer(cdp, `!document.querySelector('[data-workspace-project="${removableProjectId}"]')`, 15_000);

  writeFileSync(path.join(outputDirectory, 'memory-project-reference-ui-result.json'), `${JSON.stringify({
    agentInstanceId,
    projectId,
    screenshots: ['memory-context-manager.png', 'memory-create-agent-dialog.png', 'chat-memory-button-menu.png', 'memory-create-chat-dialog.png',
      'project-picker-delete-button.png', 'project-at-browser.png', 'project-at-reference.png'],
    probes: { memory: memoryProbe, memoryButton: memoryButtonProbe, rootBrowser: rootBrowserProbe, selectedReference: referenceProbe, realCodex: realCodexProbe },
  }, null, 2)}\n`);
  cdp.close();
  console.log(`Memory and project @ real UI test passed; screenshots: ${outputDirectory}`);
} catch (error) {
  throw new Error(`${error.message}\nElectron stderr:\n${stderr.slice(-6000)}`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 2_000);
    });
  }
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
}

async function captureScreenshot(cdp, name) {
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(outputDirectory, name), Buffer.from(screenshot.data, 'base64'));
}

async function click(cdp, selector) {
  const point = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
  if (!point || point.width <= 0 || point.height <= 0) throw new Error(`Unable to click selector: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 220));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitForRenderer(cdp, expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}

async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for Electron renderer.');
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
