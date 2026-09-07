import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerDatabaseRecoveryIpc } from '../src/main/ipc/registerDatabaseRecoveryIpc.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-recovery-surface-'));
try {
  const handlers = new Map();
  let quitCount = 0;
  let language = 'zh-CN';
  registerDatabaseRecoveryIpc({
    ipcMain: { handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); } },
    app: { getVersion: () => '0.2.14', getPath: () => root, quit: () => { quitCount += 1; } },
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showMessageBox: async () => ({ response: 0 }), showSaveDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => '' },
    getRoot: () => root,
    getStartupError: () => Object.assign(new Error('/private/project/janus.db failed'), { code: 'DB_MIGRATION_FAILED' }),
    getUiLanguage: () => language,
    setUiLanguage: (value) => { language = value === 'en' ? 'en' : 'zh-CN'; return language; },
    restart: () => ({ status: 'restarting' }),
  });
  const expected = ['recovery:get-status','recovery:scan','recovery:create-backup','recovery:repair','recovery:list-backups',
    'recovery:list-quarantines','recovery:restore','recovery:start-fresh','recovery:restore-quarantine',
    'recovery:export-diagnostics','recovery:open-data-directory','recovery:restart','recovery:set-language','recovery:quit'];
  assert.deepEqual([...handlers.keys()], expected);
  assert.deepEqual(await handlers.get('recovery:set-language')(null, { language: 'en' }), { language: 'en' });
  assert.equal(language, 'en');
  assert.deepEqual(await handlers.get('recovery:set-language')(null, { language: 'zh-CN' }), { language: 'zh-CN' });
  assert.deepEqual(await handlers.get('recovery:quit')(), { status: 'quitting' });
  assert.equal(quitCount, 1);
  const status = await handlers.get('recovery:get-status')();
  assert.equal(status.database.integrity, 'missing');
  assert.ok(!JSON.stringify(status).includes('/private/project'));
  const progress = [];
  const repairResult = await handlers.get('recovery:repair')({ sender: { isDestroyed: () => false, send: (channel, payload) => progress.push({ channel, payload }) } });
  assert.equal(repairResult.status, 'not_needed');
  assert.deepEqual(progress.map((item) => item.channel), ['recovery:progress', 'recovery:progress', 'recovery:progress']);
  assert.deepEqual(progress.map((item) => item.payload.stage), ['queued', 'inspect', 'complete']);

  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'janus.db'), 'not-a-sqlite-database', 'utf8');
  const failureProgress = [];
  await assert.rejects(
    handlers.get('recovery:repair')({ sender: { isDestroyed: () => false, send: (channel, payload) => failureProgress.push({ channel, payload }) } }),
    (error) => error?.code === 'DB_INTEGRITY_FAILED',
  );
  assert.equal(failureProgress[0]?.payload?.stage, 'queued');
  assert.equal(failureProgress.at(-1)?.payload?.stage, 'failed');
  assert.equal(failureProgress.at(-1)?.payload?.status, 'error');
  assert.equal(failureProgress.at(-1)?.payload?.percent, 0);
  assert.match(failureProgress.at(-1)?.payload?.message || '', /正式数据库未被替换/);

  const preload = fs.readFileSync(new URL('../src/preload/recoveryPreload.js', import.meta.url), 'utf8');
  assert.match(preload, /janusRecovery/);
  assert.match(preload, /startFresh/);
  assert.match(preload, /restoreQuarantine/);
  assert.match(preload, /onProgress/);
  assert.match(preload, /setLanguage/);
  assert.match(preload, /quit/);
  assert.doesNotMatch(preload, /auth:|chat:send|cloud:sync/);
  const html = fs.readFileSync(new URL('../src/renderer/recovery/index.html', import.meta.url), 'utf8');
  assert.match(html, /自动备份并修复/);
  assert.match(html, /推荐操作/);
  assert.match(html, /高级恢复选项/);
  assert.match(html, /导出诊断/);
  assert.match(html, /隔离旧库并使用新数据库/);
  assert.match(html, /id="freshRiskSummary"/);
  assert.match(html, /修复旧库并恢复聊天与 Agent Memory/);
  assert.match(html, /id="quitButton"/);
  assert.match(html, /id="languageToggleButton"/);
  assert.match(html, /退出 Janus/);
  const recoveryApp = fs.readFileSync(new URL('../src/renderer/recovery/app.js', import.meta.url), 'utf8');
  assert.match(recoveryApp, /status\.status === 'incompatible'/);
  assert.match(recoveryApp, /快速修复已禁用/);
  assert.match(recoveryApp, /recommendedButton\.disabled = true/);
  assert.match(recoveryApp, /repairButton\.disabled = status\.status === 'healthy' \|\| !status\.repairable/);
  process.stdout.write('Database recovery surface smoke passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
