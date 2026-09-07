import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { createEmergencyDatabaseSnapshot, exportDatabaseDiagnostics, inspectDatabaseRecoveryStatus, restoreDatabaseBackup,
  restoreQuarantinedDatabase, startFreshDatabase } from '../databaseRecovery.js';
import { dataDir } from '../paths.js';
import { uiText } from '../../shared/uiLanguage.js';

export function registerDatabaseRecoveryIpc({ ipcMain, app, BrowserWindow, dialog, shell, getRoot, getStartupError, getUiLanguage = () => 'zh-CN', setUiLanguage = (language) => language, restart }) {
  const t = (zh, en) => uiText(zh, en, getUiLanguage());
  const status = () => inspectDatabaseRecoveryStatus(getRoot(), { appVersion: app.getVersion(), lastError: getStartupError() });
  ipcMain.handle('recovery:get-status', async () => status());
  ipcMain.handle('recovery:scan', async () => status());
  ipcMain.handle('recovery:create-backup', async () => createEmergencyDatabaseSnapshot(getRoot(), 'user_requested_recovery'));
  ipcMain.handle('recovery:repair', async (event) => {
    const publish = (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('recovery:progress', progress);
    };
    publish({ stage: 'queued', percent: 0, message: t('正在准备快速修复', 'Preparing quick repair') });
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await runDatabaseRepairWorker(getRoot(), {
        appVersion: app.getVersion(),
        onProgress: publish,
        progressDelayMs: process.env.JANUS_TEST_RECOVERY_PROGRESS_DELAY_MS,
      });
    } catch (error) {
      publish({ stage: 'failed', percent: 0, status: 'error', message: getUiLanguage() === 'en'
        ? `Repair failed. The active database was not replaced: ${error?.message || String(error)}`
        : `修复失败，正式数据库未被替换：${error?.message || String(error)}` });
      throw error;
    }
  });
  ipcMain.handle('recovery:list-backups', async () => status().backups);
  ipcMain.handle('recovery:list-quarantines', async () => status().quarantines);
  ipcMain.handle('recovery:restore', async (event, payload = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const confirmation = await dialog.showMessageBox(parent, {
      type: 'warning', title: t('恢复数据库备份', 'Restore Database Backup'), message: t('确定使用所选备份替换当前数据库吗？', 'Replace the current database with the selected backup?'),
      detail: t('当前数据库会先保留为紧急副本。恢复后需要重新启动 Janus。', 'The current database will be kept as an emergency copy. Janus must restart after recovery.'), buttons: [t('取消', 'Cancel'), t('恢复', 'Restore')], defaultId: 0, cancelId: 0,
    });
    if (confirmation.response !== 1) return { status: 'cancelled' };
    return restoreDatabaseBackup(getRoot(), String(payload.backupId || ''));
  });
  ipcMain.handle('recovery:start-fresh', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const audit = status().data || {};
    const coverage = getUiLanguage() === 'en'
      ? (audit.cloudCoverageKnown
        ? `Cloud coverage is confirmed for ${audit.cloudConfirmedMessages || 0} messages; about ${audit.localOnlyMessages || 0} are local only.`
        : `Cloud coverage cannot be confirmed; all ${audit.messages || 0} messages must be treated as local-only data at risk.`)
      : (audit.cloudCoverageKnown
        ? `云端已确认 ${audit.cloudConfirmedMessages || 0} 条；仅本地约 ${audit.localOnlyMessages || 0} 条。`
        : `当前无法确认云端覆盖；${audit.messages || 0} 条消息都必须视为仅本地风险数据。`);
    const confirmation = await dialog.showMessageBox(parent, {
      type: 'warning', title: t('使用全新数据库启动', 'Start with a New Database'),
      message: t('只有自动修复和备份恢复都无法解决问题时，才应使用此选项。', 'Use this option only if automatic repair and backup recovery both fail.'),
      detail: getUiLanguage() === 'en'
        ? `The old database, WAL, SHM, and Memory keys will remain intact in recovery-quarantine and will not be deleted. The new database will not initially contain local chats or Memory.\n\n${coverage}\nPrivate-assistant messages: ${audit.privateAssistantMessages || 0}; non-personal Workspace messages: ${audit.nonPersonalWorkspaceMessages || 0}; attachments: ${audit.attachments || 0}; pending uploads: ${audit.pendingFileUploads || 0}.\n\nThe new database performs a pull-first sync before uploads resume. Local-only data must later be restored from quarantine.`
        : `旧数据库、WAL、SHM 和 Memory 密钥会完整保存在 recovery-quarantine 中，不会被删除。新数据库不会直接包含本地聊天和 Memory。\n\n${coverage}\n私人助手消息 ${audit.privateAssistantMessages || 0} 条；非个人 Workspace 消息 ${audit.nonPersonalWorkspaceMessages || 0} 条；附件 ${audit.attachments || 0} 个；待上传文件 ${audit.pendingFileUploads || 0} 个。\n\n新数据库首次同步会先拉取、后恢复上传；仅本地数据需要之后从隔离库恢复。`,
      buttons: [t('取消', 'Cancel'), t('隔离旧库并创建新库', 'Quarantine Old Data & Create New Database')], defaultId: 0, cancelId: 0,
    });
    if (confirmation.response !== 1) return { status: 'cancelled' };
    return startFreshDatabase(getRoot(), { appVersion: app.getVersion() });
  });
  ipcMain.handle('recovery:restore-quarantine', async (event, payload = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const confirmation = await dialog.showMessageBox(parent, {
      type: 'warning', title: t('修复并恢复隔离旧数据库', 'Repair & Restore a Quarantined Database'),
      message: t('确定修复所选旧数据库并恢复聊天历史吗？', 'Repair the selected old database and restore its chat history?'),
      detail: t('当前新数据库会先创建验证备份。旧数据库只会在副本上迁移，确认聊天消息和 Memory 数量没有减少后才替换当前数据库。当前新库中后来产生的数据不会自动合并，但会完整保留在备份中；完成后需要重新启动 Janus。', 'A verified backup of the current database is created first. The old database is migrated only on a copy and replaces the current database only after chat and Memory counts are preserved. Newer data in the current database is not merged automatically, but remains intact in the backup. Janus must restart afterward.'),
      buttons: [t('取消', 'Cancel'), t('修复并恢复旧数据', 'Repair & Restore Old Data')], defaultId: 0, cancelId: 0,
    });
    if (confirmation.response !== 1) return { status: 'cancelled' };
    return restoreQuarantinedDatabase(getRoot(), String(payload.quarantineId || ''), { appVersion: app.getVersion() });
  });
  ipcMain.handle('recovery:export-diagnostics', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const result = await dialog.showSaveDialog(parent, {
      title: t('导出数据库诊断', 'Export Database Diagnostics'), defaultPath: path.join(app.getPath('downloads'), `Janus-Database-Diagnostics-${stamp}.json`),
      buttonLabel: t('导出', 'Export'), filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { status: 'cancelled' };
    return { status: 'exported', ...exportDatabaseDiagnostics(getRoot(), { destination: result.filePath, appVersion: app.getVersion(), lastError: getStartupError() }) };
  });
  ipcMain.handle('recovery:open-data-directory', async () => {
    const error = await shell.openPath(dataDir(getRoot()));
    if (error) throw new Error(error);
    return { status: 'opened' };
  });
  ipcMain.handle('recovery:restart', async () => restart());
  ipcMain.handle('recovery:set-language', async (_event, payload = {}) => ({ language: setUiLanguage(payload.language) }));
  ipcMain.handle('recovery:quit', async () => {
    app.quit();
    return { status: 'quitting' };
  });
}

export function runDatabaseRepairWorker(root, { appVersion = '', onProgress = null, progressDelayMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../databaseRecoveryWorker.js', import.meta.url), {
      workerData: {
        root: String(root || ''),
        appVersion: String(appVersion || ''),
        progressDelayMs: Math.max(0, Math.min(1_000, Number(progressDelayMs || 0))),
      },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    worker.on('message', (message = {}) => {
      if (message.type === 'progress') {
        if (typeof onProgress === 'function') onProgress(message.progress || {});
        return;
      }
      if (message.type === 'result') {
        finish(resolve, message.result);
        return;
      }
      if (message.type === 'error') finish(reject, restoreWorkerError(message.error));
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, Object.assign(new Error(`Database recovery worker exited with code ${code}.`), {
        code: 'DB_REPAIR_WORKER_EXIT',
      }));
      else if (!settled) finish(reject, Object.assign(new Error('Database recovery worker exited without a result.'), {
        code: 'DB_REPAIR_WORKER_EMPTY_RESULT',
      }));
    });
  });
}

function restoreWorkerError(payload = {}) {
  const error = new Error(String(payload.message || 'Database repair failed.'));
  error.name = String(payload.name || 'Error');
  if (payload.stack) error.stack = String(payload.stack);
  for (const key of ['code', 'phase', 'migrationId', 'backupId']) {
    if (payload[key]) error[key] = String(payload[key]);
  }
  error.recoveryEligible = Boolean(payload.recoveryEligible);
  return error;
}
