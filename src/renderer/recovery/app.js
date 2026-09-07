import { localizeDom, normalizeLanguage, translateUserVisibleError } from '../app/i18n.js';

const api = window.janusRecovery;
let language = normalizeLanguage(new URLSearchParams(location.search).get('language') || document.documentElement.lang || 'en');
const elements = Object.fromEntries(['statusBadge','statusTitle','statusDetail','scanButton','recommendedTitle','recommendedDetail','recommendedButton',
  'repairProgress','progressStage','progressPercent','progressBar','advancedRecovery','repairButton','backupButton','freshButton','backupList','quarantineList',
  'freshRiskSummary','operationResult','diagnosticsButton','directoryButton','restartButton','quitButton','languageToggleButton','languageToggleLabel']
  .map((id) => [id, document.getElementById(id)]));
let recommendedAction = null;
api.onProgress?.((progress) => renderProgress(progress));

function updateLanguageToggle() {
  const english = language === 'en';
  const targetLabel = english ? '切换至中文' : 'Switch to English';
  elements.languageToggleLabel.textContent = english ? 'EN' : '中';
  elements.languageToggleButton.setAttribute('aria-label', targetLabel);
  elements.languageToggleButton.title = targetLabel;
}

async function toggleLanguage() {
  const next = language === 'en' ? 'zh-CN' : 'en';
  language = next;
  updateLanguageToggle();
  try { window.localStorage?.setItem('janus-language-mode', next); } catch {}
  try { await api.setLanguage?.(next); } catch {}
  const url = new URL(location.href);
  url.searchParams.set('language', next);
  location.replace(url.href);
}

async function refresh() {
  busy(true); showResult();
  try { const status = await api.scan(); busy(false); render(status); } catch (error) { busy(false); renderError(error); }
}

function render(status) {
  const labels = { healthy: ['数据库健康', 'healthy'], recovery_available: ['旧数据可恢复', 'warning'], repairable: ['可以自动修复', 'warning'], incompatible: ['版本不兼容', 'error'], manual: ['需要从备份恢复', 'error'] };
  const [label, type] = labels[status.status] || ['状态未知', 'error'];
  elements.statusBadge.textContent = label; elements.statusBadge.className = `badge ${type}`;
  elements.statusTitle.textContent = status.status === 'healthy' ? '本地数据库可以正常使用'
    : status.status === 'recovery_available' ? '当前新数据库健康，隔离旧数据仍可恢复'
      : status.status === 'repairable' ? '检测到可修复的历史结构或脏数据'
        : status.status === 'incompatible' ? '需要更新 Janus 才能打开此数据库' : '数据库无法通过安全检查';
  const pending = status.pendingMigrationIds?.length || 0; const violations = status.health?.violationCount || 0;
  elements.statusDetail.textContent = status.status === 'recovery_available'
    ? `当前数据库完整性：${status.database?.integrity || '未知'}；检测到 ${status.quarantines?.length || 0} 个可恢复的隔离旧库。`
    : status.status === 'incompatible'
      ? `此数据库需要 Janus ${status.compatibility?.minimumWriterVersion || '未知'} 或更高版本；当前版本为 ${status.compatibility?.currentAppVersion || status.appVersion || '未知'}。为保护本地数据，快速修复已禁用。`
    : status.status === 'healthy' && status.lastError
      ? '当前数据库已通过完整性和一致性检查，之前的启动异常已经解除。'
      : status.status === 'repairable'
        ? `检测到 ${pending} 项待迁移结构和 ${violations} 项一致性问题，可以安全自动修复。`
        : status.lastError?.message || `完整性：${status.database?.integrity || '未知'}；待迁移：${pending}；一致性异常：${violations}。`;
  elements.repairButton.disabled = status.status === 'healthy' || !status.repairable;
  elements.freshButton.disabled = !status.database?.exists;
  renderFreshRisk(status.data || {});
  renderBackups(status.backups || []);
  renderQuarantines(status.quarantines || []);
  renderRecommendation(status);
  localizeDom(document.body, language);
}

function renderFreshRisk(data) {
  if (!elements.freshRiskSummary) return;
  const coverage = data.cloudCoverageKnown
    ? `云端已确认 ${data.cloudConfirmedMessages || 0} 条，约 ${data.localOnlyMessages || 0} 条仅存在本地。`
    : `云端覆盖尚未确认，当前 ${data.messages || 0} 条消息都必须按仅本地数据保护。`;
  elements.freshRiskSummary.textContent = `${coverage} 私人助手 ${data.privateAssistantMessages || 0} 条，非个人 Workspace ${data.nonPersonalWorkspaceMessages || 0} 条，附件 ${data.attachments || 0} 个，待上传文件 ${data.pendingFileUploads || 0} 个。`;
}

function renderRecommendation(status) {
  recommendedAction = null;
  elements.recommendedButton.disabled = false;
  if (status.status === 'healthy') {
    elements.recommendedTitle.textContent = '数据库已经可以正常使用';
    elements.recommendedDetail.textContent = '之前的错误已经不再阻止启动，重新进入 Janus 即可。';
    elements.recommendedButton.textContent = '重新进入 Janus';
    recommendedAction = () => api.restart();
    return;
  }
  if (status.status === 'incompatible') {
    elements.recommendedTitle.textContent = '安装兼容版本后重新启动';
    elements.recommendedDetail.textContent = `请安装 Janus ${status.compatibility?.minimumWriterVersion || '未知'} 或更高版本。当前数据库不会被修改。`;
    elements.recommendedButton.textContent = '快速修复不可用';
    elements.recommendedButton.disabled = true;
    return;
  }
  if (status.status === 'repairable') {
    elements.recommendedTitle.textContent = '安全修复并继续使用';
    elements.recommendedDetail.textContent = '会先备份，再在副本中修复；聊天内容校验通过后才替换。';
    elements.recommendedButton.textContent = '快速修复并重新启动';
    recommendedAction = () => operateAndRestart(() => api.repair());
    return;
  }
  if (status.status === 'recovery_available') {
    const candidates = (status.quarantines || []).filter((item) => item.integrity === 'ok');
    elements.recommendedTitle.textContent = '旧聊天数据可以恢复';
    elements.recommendedDetail.textContent = candidates.length === 1
      ? `检测到 ${candidates[0].data?.messages || 0} 条旧消息，恢复前会备份当前数据库。`
      : '检测到多个隔离旧库，请在高级恢复选项中选择。';
    elements.recommendedButton.textContent = candidates.length === 1 ? '恢复旧聊天并重新启动' : '选择旧数据库';
    recommendedAction = candidates.length === 1
      ? () => operateAndRestart(() => api.restoreQuarantine(candidates[0].id))
      : () => openAdvancedRecovery();
    return;
  }
  const backups = status.backups || [];
  elements.recommendedTitle.textContent = backups.length ? '从最近备份恢复' : '需要手动处理数据库';
  elements.recommendedDetail.textContent = backups.length ? '将使用最近的完整备份，当前数据库仍会保留紧急副本。' : '请打开高级恢复选项导出诊断或使用最后兜底。';
  elements.recommendedButton.textContent = backups.length ? '恢复最近备份并重新启动' : '打开高级恢复选项';
  recommendedAction = backups.length
    ? () => operateAndRestart(() => api.restore(backups[0].id))
    : () => openAdvancedRecovery();
}

function renderBackups(backups) {
  elements.backupList.replaceChildren();
  if (!backups.length) { elements.backupList.textContent = '当前没有可用的验证备份。'; return; }
  for (const backup of backups) {
    const row = document.createElement('div'); row.className = 'backup';
    const info = document.createElement('div'); const title = document.createElement('strong'); const detail = document.createElement('small');
    title.textContent = `${new Date(backup.createdAt).toLocaleString()}${backup.pinned ? ' · 最近成功恢复点' : ''}`;
    detail.textContent = `${formatBytes(backup.sizeBytes)} · 完整性 ${backup.integrity}`; info.append(title, detail);
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '恢复此备份';
    button.addEventListener('click', () => operateAndRestart(() => api.restore(backup.id))); row.append(info, button); elements.backupList.append(row);
  }
}

function renderQuarantines(quarantines) {
  elements.quarantineList.replaceChildren();
  if (!quarantines.length) { elements.quarantineList.textContent = '当前没有隔离旧数据库。'; return; }
  for (const quarantine of quarantines) {
    const row = document.createElement('div'); row.className = 'backup';
    const info = document.createElement('div'); const title = document.createElement('strong'); const detail = document.createElement('small');
    title.textContent = `${new Date(quarantine.createdAt).toLocaleString()}${quarantine.restoredAt ? ' · 已恢复过' : ''}`;
    const data = quarantine.data || {};
    detail.textContent = `${formatBytes(quarantine.sizeBytes)} · 完整性 ${quarantine.integrity} · ${data.sessions || 0} 个会话 · ${data.messages || 0} 条消息 · ${data.memoryDocuments || 0} 个 Memory`;
    info.append(title, detail);
    const button = document.createElement('button'); button.className = 'primary'; button.textContent = '修复并恢复旧数据';
    button.disabled = quarantine.integrity !== 'ok';
    button.addEventListener('click', () => operateAndRestart(() => api.restoreQuarantine(quarantine.id))); row.append(info, button); elements.quarantineList.append(row);
  }
}

async function operate(callback) { busy(true); try { const result = await callback(); showResult(result); await refresh(); } catch (error) { busy(false); renderError(error); } }
async function operateAndRestart(callback) {
  busy(true);
  renderProgress({ stage: 'queued', percent: 0, message: '正在准备安全操作' });
  try {
    const result = await callback();
    if (result?.status === 'cancelled') { await refresh(); return; }
    showResult(result);
    await api.restart();
  } catch (error) { busy(false); renderError(error); }
}
function renderProgress(progress = {}) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  elements.repairProgress.hidden = false;
  elements.progressStage.textContent = progress.message || '正在处理';
  elements.progressPercent.textContent = `${Math.round(percent)}%`;
  elements.progressBar.style.width = `${percent}%`;
  elements.repairProgress.classList.toggle('error', progress.status === 'error' || progress.stage === 'failed');
  localizeDom(document.body, language);
}
function openAdvancedRecovery() { elements.advancedRecovery.open = true; elements.advancedRecovery.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function busy(value) { for (const button of document.querySelectorAll('button')) button.disabled = value; }
function showResult(value) { elements.operationResult.hidden = !value; elements.operationResult.textContent = value ? JSON.stringify(value, null, 2) : ''; }
function renderError(error) {
  elements.statusBadge.textContent = '操作失败';
  elements.statusBadge.className = 'badge error';
  showResult({ code: error?.code || 'DB_OPERATION_FAILED', message: translateUserVisibleError(error?.message || String(error), language, error) });
  localizeDom(document.body, language);
}
function formatBytes(value) { const bytes = Number(value || 0); if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`; return `${(bytes / 1024 ** 2).toFixed(1)} MiB`; }

elements.scanButton.addEventListener('click', refresh);
elements.recommendedButton.addEventListener('click', () => recommendedAction?.());
elements.repairButton.addEventListener('click', () => operateAndRestart(() => api.repair()));
elements.backupButton.addEventListener('click', () => operate(() => api.createBackup()));
elements.freshButton.addEventListener('click', () => operateAndRestart(() => api.startFresh()));
elements.diagnosticsButton.addEventListener('click', () => operate(() => api.exportDiagnostics()));
elements.directoryButton.addEventListener('click', () => operate(() => api.openDataDirectory()));
elements.restartButton.addEventListener('click', () => api.restart());
elements.quitButton.addEventListener('click', () => api.quit());
elements.languageToggleButton.addEventListener('click', toggleLanguage);
updateLanguageToggle();
refresh();
