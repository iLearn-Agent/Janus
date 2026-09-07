import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerIpcHandlers } from '../src/main/ipc/registerIpcHandlers.js';

const { app, BrowserWindow } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-plan-aux-windows-'));
const questionScript = pathToFileURL(path.join(process.cwd(), 'src/renderer/planQuestionWindow.js')).href;
let questionWindow = null;

try {
  await app.whenReady();
  await verifyAuxiliaryWindowIpcContract();
  questionWindow = await verifySequentialQuestionWindow();
  console.log('Plan question auxiliary window smoke passed.');
} finally {
  if (questionWindow && !questionWindow.isDestroyed()) questionWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}

function verifyAuxiliaryWindowIpcContract() {
  const handlers = new Map();
  let nextId = 10;
  const created = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.id = nextId++;
      this.options = options;
      this.webContents = { id: nextId++, isDestroyed: () => false };
      this.listeners = new Map();
      this.destroyed = false;
      this.focused = false;
      created.push(this);
    }
    loadFile(file, options) { this.loaded = { file, options }; }
    on(name, callback) { this.listeners.set(name, callback); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() {}
    focus() { this.focused = true; }
    close() { this.destroyed = true; this.listeners.get('closed')?.(); }
    static fromWebContents() { return null; }
  }
  const sourceEvents = [];
  const source = { id: 2, isDestroyed: () => false, send: (channel, payload) => sourceEvents.push({ channel, payload }) };
  registerIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    app: { getAppPath: () => process.cwd(), quit() {} },
    BrowserWindow: FakeBrowserWindow,
    dialog: {}, shell: {}, clipboard: {},
    getRuntime: () => null,
    getMainWindow: () => null,
    getUpdateService: () => null,
    getAgentBundleService: () => null,
    createAppWindow() {},
    refreshCodexSystemProxy: async () => {},
    refreshModelCatalog: async () => {},
    getUiLanguage: () => 'en',
    setUiLanguage: () => 'en',
  });
  return Promise.resolve().then(async () => {
    const questionResult = await handlers.get('plan-question-window:open')({ sender: source }, {
      channelId: 'channel-1', runId: 'run-1', requestId: 'request-1', planMode: true,
      questions: [{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }],
    });
    assert.equal(created[0].options.frame, true, 'the Plan question flow must be a normal switchable OS window');
    assert.equal(created[0].options.title, 'Confirm Plan Options');
    assert.match(created[0].loaded.file, /planQuestionWindow\.html$/);
    assert.equal(created[0].loaded.options.query.language, 'en');
    const questionPayload = await handlers.get('aux-window:payload')({ sender: created[0].webContents }, { token: questionResult.token });
    assert.equal(questionPayload.questions.length, 1);
    await handlers.get('aux-window:close')({ sender: created[0].webContents }, { token: questionResult.token, submitted: false });
    assert.deepEqual(sourceEvents.at(-1), {
      channel: 'chat:user-input-window-closed', payload: { requestId: 'request-1', submitted: false },
    });
  });
}

async function verifySequentialQuestionWindow() {
  const htmlPath = path.join(tempRoot, 'question.html');
  const payload = {
    channelId: 'channel', runId: 'run', requestId: 'request', planMode: true,
    questions: [
      { id: 'direction', header: '方向', question: '选择研究方向？', isOther: true, options: [{ label: '聚焦方案', description: '保持范围集中。' }, { label: '扩展方案', description: '扩大研究范围。' }] },
      { id: 'delivery', header: '交付', question: '选择交付方式？', isOther: false, options: [{ label: '报告', description: '形成书面报告。' }, { label: '原型', description: '形成验证原型。' }] },
    ],
  };
  writeFileSync(htmlPath, `<!doctype html><html><body><main id="plan-question-window"></main><script>
    window.__aux={resolved:[],closed:[],focused:0};
    window.janus={auxiliaryWindowPayload:async()=>(${JSON.stringify(payload)}),resolveChatUserInput:async(payload)=>{window.__aux.resolved.push(payload);return{ok:true};},closeAuxiliaryWindow:async(payload)=>{window.__aux.closed.push(payload);return true;},focusMainWindow:async()=>{window.__aux.focused+=1;return true;}};
  </script><script type="module" src="${questionScript}"></script></body></html>`, 'utf8');
  const window = new BrowserWindow({ show: Boolean(process.env.JANUS_PLAN_ENGLISH_SCREENSHOT), width: 820, height: 720, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await window.loadFile(htmlPath, { query: { token: 'question-token' } });
  await waitFor(window, `document.querySelector('[data-question-next]')`);
  const englishChrome = await window.webContents.executeJavaScript(`({
    title:document.querySelector('.question-window-header strong')?.textContent||'',
    untranslated:[...document.querySelectorAll('body *')]
      .filter((item)=>!item.closest('[data-no-localize],script,style'))
      .flatMap((item)=>[...item.childNodes].filter((node)=>node.nodeType===Node.TEXT_NODE).map((node)=>node.nodeValue.trim()))
      .filter((value)=>/[\\u3400-\\u9fff]/.test(value))
  })`);
  assert.equal(englishChrome.title, 'Confirm Plan Options');
  assert.deepEqual(englishChrome.untranslated, []);
  if (process.env.JANUS_PLAN_ENGLISH_SCREENSHOT) {
    await window.webContents.executeJavaScript(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(process.env.JANUS_PLAN_ENGLISH_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  }
  let text = await window.webContents.executeJavaScript(`document.body.innerText`);
  assert.match(text, /选择研究方向/);
  assert.doesNotMatch(text, /选择交付方式/);
  await window.webContents.executeJavaScript(`document.querySelector('input[value="聚焦方案"]').checked=true;document.querySelector('[data-question-next]').click()`);
  await waitFor(window, `document.body.innerText.includes('选择交付方式')`);
  text = await window.webContents.executeJavaScript(`document.body.innerText`);
  assert.doesNotMatch(text, /选择研究方向/);
  await window.webContents.executeJavaScript(`document.querySelector('[data-question-back]').click()`);
  await waitFor(window, `document.body.innerText.includes('选择研究方向')`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('input[value="聚焦方案"]').checked`), true, 'back navigation must preserve the previous answer');
  await window.webContents.executeJavaScript(`document.querySelector('[data-question-next]').click()`);
  await waitFor(window, `document.body.innerText.includes('选择交付方式')`);
  await window.webContents.executeJavaScript(`document.querySelector('input[value="报告"]').checked=true;document.querySelector('[data-question-next]').click()`);
  await waitFor(window, `window.__aux.resolved.length===1 && window.__aux.closed.length===1`);
  const submission = await window.webContents.executeJavaScript(`window.__aux`);
  assert.deepEqual(submission.resolved[0].answers, { direction: { answers: ['聚焦方案'] }, delivery: { answers: ['报告'] } });
  assert.equal(submission.closed[0].submitted, true);
  return window;
}

async function waitFor(window, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}
