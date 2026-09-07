import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { app, BrowserWindow } = globalThis.__janusElectron;
await app.whenReady();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-recovery-renderer-'));
const appUrl = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'recovery', 'app.js')).href;
const styleUrl = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'recovery', 'style.css')).href;
const html = path.join(root, 'index.html');
fs.writeFileSync(html, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${styleUrl}"></head><body>
<main class="shell"><header class="recovery-header"><div class="brand">O</div><div><h1>本地数据恢复</h1><p>Janus 启动时检测到本地数据需要处理。</p></div><div class="header-actions"><button id="languageToggleButton" class="language-toggle"><span id="languageToggleLabel">EN</span></button><button id="quitButton" class="quit-button">退出 Janus</button></div></header>
<section class="card status-card"><div><span id="statusBadge" class="badge">检查</span><h2 id="statusTitle"></h2><p id="statusDetail"></p></div><button id="scanButton">重新检查</button></section>
<section class="card recommendation"><span class="eyebrow">推荐操作</span><h2 id="recommendedTitle"></h2><p id="recommendedDetail"></p><div class="actions"><button id="recommendedButton" class="primary"></button></div><div id="repairProgress" class="progress-panel" hidden><div class="progress-heading"><strong id="progressStage"></strong><span id="progressPercent"></span></div><div class="progress-track"><span id="progressBar"></span></div></div><pre id="operationResult" hidden></pre></section>
<details id="advancedRecovery" class="advanced"><summary>高级恢复选项</summary><section><button id="repairButton">自动备份并修复</button><button id="backupButton">仅创建紧急备份</button></section>
<section><div id="backupList" class="backup-list"></div></section><section><div id="quarantineList" class="backup-list"></div></section><section><p id="freshRiskSummary"></p><button id="freshButton">隔离旧库并使用新数据库</button></section><section><button id="diagnosticsButton">导出脱敏诊断</button><button id="directoryButton">打开数据目录</button><button id="restartButton">重新启动</button></section></details></main>
<script>window.__restartCount=0;window.__quitCount=0;window.__setLanguageCalls=[];window.__progressListener=null;window.janusRecovery={scan:async()=>({status:'recovery_available',repairable:false,database:{exists:true,integrity:'ok'},pendingMigrationIds:[],health:{violationCount:0},data:{messages:20,cloudCoverageKnown:true,cloudConfirmedMessages:12,localOnlyMessages:8,privateAssistantMessages:3,nonPersonalWorkspaceMessages:2,attachments:4,pendingFileUploads:1},lastError:{message:'UNIQUE constraint failed'},backups:[{id:'backup-1',createdAt:'2026-07-30T00:00:00.000Z',sizeBytes:1048576,integrity:'ok',pinned:true}],quarantines:[{id:'quarantine-1',createdAt:'2026-07-30T01:00:00.000Z',sizeBytes:2097152,integrity:'ok',data:{sessions:3,messages:12,memoryDocuments:2}}]}),repair:async()=>new Promise((resolve)=>{window.__progressListener?.({stage:'backup',percent:15,message:'正在创建修复前安全备份'});setTimeout(()=>window.__progressListener?.({stage:'migrate',percent:50,message:'正在修复旧结构和历史数据'}),35);setTimeout(()=>{window.__progressListener?.({stage:'complete',percent:100,message:'修复完成，正在重新启动 Janus'});resolve({status:'repaired'});},400);}),createBackup:async()=>({status:'created'}),restore:async()=>({status:'restored'}),startFresh:async()=>({status:'fresh_database_created'}),restoreQuarantine:async()=>({status:'quarantine_restored'}),exportDiagnostics:async()=>({status:'exported'}),openDataDirectory:async()=>({status:'opened'}),restart:async()=>{window.__restartCount+=1;return {status:'restarting'};},quit:async()=>{window.__quitCount+=1;return {status:'quitting'};},setLanguage:async(language)=>{window.__setLanguageCalls.push(language);return {language};},onProgress:(listener)=>{window.__progressListener=listener;return()=>{window.__progressListener=null;};}};</script>
<script type="module" src="${appUrl}"></script></body></html>`, 'utf8');
const window = new BrowserWindow({ width: 760, height: 640, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false } });
try {
  await window.loadFile(html);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const state = await window.webContents.executeJavaScript(`({
    badge:document.getElementById('statusBadge').textContent,
    title:document.getElementById('statusTitle').textContent,
    repairDisabled:document.getElementById('repairButton').disabled,
    freshDisabled:document.getElementById('freshButton').disabled,
    backups:document.querySelectorAll('.backup').length,
    quarantineText:document.getElementById('quarantineList').textContent,
    freshRisk:document.getElementById('freshRiskSummary').textContent,
    recommendedTitle:document.getElementById('recommendedTitle').textContent,
    recommendedButton:document.getElementById('recommendedButton').textContent,
    advancedOpen:document.getElementById('advancedRecovery').open,
    body:document.body.textContent
  })`);
  assert.equal(state.badge, '旧数据可恢复');
  assert.equal(state.title, '当前新数据库健康，隔离旧数据仍可恢复');
  assert.equal(state.repairDisabled, true);
  assert.equal(state.freshDisabled, false);
  assert.equal(state.backups, 2);
  assert.equal(state.recommendedTitle, '旧聊天数据可以恢复');
  assert.equal(state.recommendedButton, '恢复旧聊天并重新启动');
  assert.equal(state.advancedOpen, false);
  assert.match(state.quarantineText, /12 条消息/);
  assert.match(state.quarantineText, /修复并恢复旧数据/);
  assert.match(state.freshRisk, /仅存在本地/);
  assert.match(state.freshRisk, /附件 4 个/);
  assert.match(state.body, /最近成功恢复点/);
  assert.match(state.body, /退出 Janus/);
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('languageToggleLabel').textContent"), '中');
  await window.webContents.executeJavaScript("document.getElementById('quitButton').click()");
  assert.equal(await window.webContents.executeJavaScript('window.__quitCount'), 1);
  await window.webContents.executeJavaScript(`(() => {
    window.janusRecovery.scan=async()=>({status:'healthy',repairable:false,database:{exists:true,integrity:'ok'},pendingMigrationIds:[],health:{violationCount:0},lastError:{message:'UNIQUE constraint failed'},backups:[],quarantines:[]});
    document.getElementById('scanButton').click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const healthyState = await window.webContents.executeJavaScript(`({
    badge:document.getElementById('statusBadge').textContent,
    detail:document.getElementById('statusDetail').textContent,
    recommendedTitle:document.getElementById('recommendedTitle').textContent,
    recommendedButton:document.getElementById('recommendedButton').textContent,
    advancedOpen:document.getElementById('advancedRecovery').open
  })`);
  assert.equal(healthyState.badge, '数据库健康');
  assert.match(healthyState.detail, /当前数据库已通过完整性和一致性检查/);
  assert.match(healthyState.detail, /启动异常已经解除/);
  assert.doesNotMatch(healthyState.detail, /UNIQUE constraint failed/);
  assert.equal(healthyState.recommendedTitle, '数据库已经可以正常使用');
  assert.equal(healthyState.recommendedButton, '重新进入 Janus');
  assert.equal(healthyState.advancedOpen, false);
  await window.webContents.executeJavaScript("document.getElementById('recommendedButton').click()");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await window.webContents.executeJavaScript('window.__restartCount'), 1);
  await window.webContents.executeJavaScript(`(() => {
    window.janusRecovery.scan=async()=>({status:'repairable',repairable:true,database:{exists:true,integrity:'ok'},pendingMigrationIds:['sessions_canonical_primary_uniqueness_v1'],health:{violationCount:2},lastError:{message:'UNIQUE constraint failed'},backups:[],quarantines:[]});
    document.getElementById('scanButton').click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('recommendedButton').textContent"), '快速修复并重新启动');
  await window.webContents.executeJavaScript("document.getElementById('recommendedButton').click()");
  await new Promise((resolve) => setTimeout(resolve, 70));
  const progressState = await window.webContents.executeJavaScript(`({
    hidden:document.getElementById('repairProgress').hidden,
    stage:document.getElementById('progressStage').textContent,
    percent:document.getElementById('progressPercent').textContent,
    width:document.getElementById('progressBar').style.width
  })`);
  assert.equal(progressState.hidden, false);
  assert.equal(progressState.stage, '正在修复旧结构和历史数据');
  assert.equal(progressState.percent, '50%');
  assert.equal(progressState.width, '50%');
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (process.env.JANUS_RECOVERY_SCREENSHOT) await window.webContents.capturePage().then((image) => fs.writeFileSync(process.env.JANUS_RECOVERY_SCREENSHOT, image.toPNG()));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await window.webContents.executeJavaScript('window.__restartCount'), 2);
  await window.loadFile(html, { query: { language: 'en' } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const englishState = await window.webContents.executeJavaScript(`({
    language:document.documentElement.lang,
    title:document.getElementById('statusTitle').textContent,
    recommendedTitle:document.getElementById('recommendedTitle').textContent,
    untranslated:[...document.querySelectorAll('body *')]
      .filter((item)=>item.offsetParent!==null && !item.closest('pre,[data-no-localize]'))
      .flatMap((item)=>[...item.childNodes].filter((node)=>node.nodeType===Node.TEXT_NODE).map((node)=>node.nodeValue.trim()))
      .filter((text)=>/[\\u3400-\\u9fff]/.test(text)).slice(0,40)
  })`);
  assert.equal(englishState.language, 'en');
  assert.equal(englishState.title, 'The New Database Is Healthy and Quarantined Data Can Be Restored');
  assert.equal(englishState.recommendedTitle, 'Old Chat Data Can Be Restored');
  assert.deepEqual(englishState.untranslated, []);
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('languageToggleLabel').textContent"), 'EN');
  await window.webContents.executeJavaScript("document.getElementById('languageToggleButton').click()");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await window.webContents.executeJavaScript("new URLSearchParams(location.search).get('language')"), 'zh-CN');
  if (process.env.JANUS_RECOVERY_ENGLISH_SCREENSHOT) {
    await window.webContents.capturePage().then((image) => fs.writeFileSync(process.env.JANUS_RECOVERY_ENGLISH_SCREENSHOT, image.toPNG()));
  }
  process.stdout.write('Recovery renderer smoke passed.\n');
} finally {
  window.destroy();
  fs.rmSync(root, { recursive: true, force: true });
}
