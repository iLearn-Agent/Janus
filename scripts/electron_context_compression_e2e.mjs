import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRuntime } from '../src/main/runtime.js';

const repoRoot = process.cwd();
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-context-compression-ui-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-context-compression-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const fakeProtocolLog = path.join(binRoot, 'protocol.log');
const electronExe = path.join(repoRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const port = Number(process.env.JANUS_CONTEXT_COMPRESSION_UI_PORT || 9486);
let child = null;
let cdp = null;

try {
  await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args=process.argv.slice(2);
if(process.env.JANUS_CONTEXT_COMPACTION_FAKE_LOG)fs.appendFileSync(process.env.JANUS_CONTEXT_COMPACTION_FAKE_LOG,JSON.stringify({args})+'\\n');
if(args.includes('--version')){console.log('codex-cli context-ui-smoke');process.exit(0);}
if(args.includes('app-server')&&args.includes('--help')){console.log('Usage: codex app-server [OPTIONS]');process.exit(0);}
if(args.includes('app-server')){
 const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
 const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines){
   if(!line.trim())continue;
   const message=JSON.parse(line);
   if(process.env.JANUS_CONTEXT_COMPACTION_FAKE_LOG)fs.appendFileSync(process.env.JANUS_CONTEXT_COMPACTION_FAKE_LOG,JSON.stringify({message})+'\\n');
  if(message.method==='initialize')send({id:message.id,result:{userAgent:'context-ui-smoke'}});
  else if(message.method==='thread/resume')send({id:message.id,result:{thread:{id:message.params?.threadId||'thread_context_ui_old'}}});
  else if(message.method==='thread/memoryMode/set')send({id:message.id,result:{}});
  else if(message.method==='thread/compact/start'){
   send({id:message.id,result:{}});
   await new Promise((resolve)=>setTimeout(resolve,1200));
   send({method:'item/started',params:{threadId:message.params?.threadId||'',turnId:'compact-turn',item:{id:'compact-item',type:'contextCompaction'}}});
   send({method:'item/completed',params:{threadId:message.params?.threadId||'',turnId:'compact-turn',item:{id:'compact-item',type:'contextCompaction'}}});
  }else send({id:message.id,error:{code:-32601,message:'unsupported'}});
 }
 process.exit(0);
}
let stdin='';for await(const chunk of process.stdin)stdin+=chunk;
const outputIndex=args.indexOf('--output-last-message');
if(outputIndex>=0)fs.writeFileSync(args[outputIndex+1],'## UI 压缩摘要\\n- 保留用户的测试目标。\\n- 原始记录不删除。','utf8');
if(args.includes('--json')){
 console.log(JSON.stringify({type:'thread.started',thread_id:'thread_context_ui'}));
 console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'UI context compression complete'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,output_tokens:20}}));
}
`);
  await chmod(fakeCodex, 0o755);

  const runtime = await createRuntime({ root: runtimeRoot, isDev: true });
  const user = runtime.currentUser();
  const instance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' });
  assert.ok(instance, 'default general Agent instance is required');
  const session = runtime.store.createSession({
    title: '真实 UI 上下文压缩测试',
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    userId: user.id,
  });
  const deviceState = runtime.store.getDeviceContextState({
    deviceId: runtime.store.contextDeviceId(), userId: user.id, agentInstanceId: instance.id,
  });
  runtime.store.addMessage({ sessionId: session.id, role: 'user', content: '这是必须保留的原始用户记录。', agentId: 'general_agent' });
  runtime.store.addMessage({ sessionId: session.id, role: 'assistant', content: '这是必须保留的原始 Agent 记录。', agentId: 'general_agent' });
  runtime.store.updateSessionThread(session.id, 'thread_context_ui_old');
  runtime.store.beginModelExecution({
    id: 'context_ui_usage',
    userId: user.id,
    conversationId: session.id,
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    effectiveModel: 'gpt-5.6-sol',
    status: 'completed',
    metadata: { usage: {
      inputTokens: 118_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 118_000,
      contextInputTokens: 118_000,
      contextMeasurementState: 'available',
      modelContextWindow: 128_000,
    } },
  });
  runtime.store.recordChatContextUsage({
    ownerUserId: user.id,
    sessionId: session.id,
    contextSpaceId: deviceState.activeContextSpaceId,
    executionId: 'context_ui_usage',
    inputTokens: 118_000,
    contextWindowTokens: 128_000,
    sourceDeviceId: runtime.store.contextDeviceId(),
  });
  runtime.close();

  const env = {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    JANUS_HOME: runtimeRoot,
    JANUS_CODEX_BIN: fakeCodex,
    JANUS_MODEL_REFRESH_ENABLED: '0',
    JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
    JANUS_UBUDDY_PROCESSING_MODE: 'fallback',
    JANUS_CONTEXT_COMPACTION_FAKE_LOG: fakeProtocolLog,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronExe, [
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${path.join(runtimeRoot, 'profile')}`,
    `--remote-debugging-port=${port}`,
    '.',
  ], { cwd: repoRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const target = await waitForPageTarget(port, 20_000, () => stderr);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await waitFor(cdp, `document.querySelector('#sidebar-chat-search-trigger')`, 20_000);
  await evaluate(cdp, `document.querySelector('#sidebar-chat-search-trigger')?.click()`);
  await waitFor(cdp, `document.querySelector('[data-session="${session.id}"]')`, 20_000);
  await evaluate(cdp, `document.querySelector('[data-session="${session.id}"]')?.click()`);
  await waitFor(cdp, `document.querySelector('.context-usage-control')?.textContent?.includes('剩余 9%')`, 20_000);

  const before = await evaluate(cdp, `(() => ({
    context: document.querySelector('.context-usage-control')?.textContent?.trim() || '',
    history: document.querySelector('#message-list')?.textContent || '',
    memory: document.querySelector('.composer-memory-trigger')?.textContent?.trim() || '',
  }))()`);
  assert.match(before.context, /上下文剩余 9%/);
  assert.match(before.history, /必须保留的原始用户记录/);
  assert.match(before.history, /必须保留的原始 Agent 记录/);

  await evaluate(cdp, `document.querySelector('.context-usage-control')?.click()`);
  await waitFor(cdp, `document.querySelector('.context-usage-control.is-busy')?.textContent?.includes('压缩中')`, 5_000);
  const during = await evaluate(cdp, `(() => {
    const button=document.querySelector('.context-usage-control');
    return {text:button?.textContent?.trim()||'',disabled:Boolean(button?.disabled),busy:button?.getAttribute('aria-busy')||'',notice:document.body.innerText};
  })()`);
  assert.match(during.text, /压缩中/);
  assert.equal(during.disabled, true);
  assert.equal(during.busy, 'true');
  assert.match(during.notice, /原始聊天历史和 Memory 不会删除/);

  await waitFor(cdp, `!document.querySelector('.context-usage-control.is-busy') && document.body.innerText.includes('上下文已压缩')`, 30_000);
  const after = await evaluate(cdp, `(() => ({
    context: document.querySelector('.context-usage-control')?.textContent?.trim() || '',
    history: document.querySelector('#message-list')?.textContent || '',
    memory: document.querySelector('.composer-memory-trigger')?.textContent?.trim() || '',
    notice: document.body.innerText,
  }))()`);
  assert.equal(after.context, '上下文');
  assert.match(after.history, /必须保留的原始用户记录/);
  assert.match(after.history, /必须保留的原始 Agent 记录/);
  assert.equal(after.memory, before.memory);
  assert.match(after.notice, /上下文已压缩/);

  const db = new DatabaseSync(path.join(runtimeRoot, 'data', 'janus.db'));
  const counts = db.prepare(`SELECT
    SUM(CASE WHEN visible=1 THEN 1 ELSE 0 END) AS visible_count,
    SUM(CASE WHEN visible=0 AND metadata_json LIKE '%contextCompressionSummary%' THEN 1 ELSE 0 END) AS summary_count
    FROM messages WHERE session_id=?`).get(session.id);
  const persistedSession = db.prepare('SELECT codex_thread_id FROM sessions WHERE id=?').get(session.id);
  db.close();
  assert.equal(Number(counts.visible_count || 0), 2);
  assert.equal(Number(counts.summary_count || 0), 0);
  assert.equal(persistedSession.codex_thread_id, 'thread_context_ui_old');
  process.stdout.write('Electron real context compression button e2e passed.\n');
} catch (error) {
  const protocol = await readFile(fakeProtocolLog, 'utf8').catch(() => '');
  error.message = `${error.message}\nFake Codex protocol:\n${protocol.slice(-8000)}`;
  throw error;
} finally {
  try { cdp?.close(); } catch {}
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(binRoot, { recursive: true, force: true });
}

async function waitForPageTarget(debugPort, timeoutMs, stderrText) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Electron renderer did not start: ${String(stderrText?.() || '').slice(-1600)}`);
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || 'CDP error'));
    else resolve(message.result || {});
  });
  return {
    send(method, params = {}) {
      const id = ++sequence;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdpClient, expression) {
  const result = await cdpClient.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitFor(cdpClient, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdpClient, `Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const snapshot = await evaluate(cdpClient, `({text:document.body?.innerText?.slice(-3000)||'',busy:Boolean(document.querySelector('.context-usage-control.is-busy')),context:document.querySelector('.context-usage-control')?.textContent?.trim()||''})`).catch(() => ({}));
  throw new Error(`Timed out waiting for renderer condition: ${expression}\n${JSON.stringify(snapshot)}`);
}
