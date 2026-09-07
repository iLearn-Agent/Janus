import { reasoningOptionsForModel, textModelOptions } from '../constants.js';
import { roleLabel, state } from '../state.js';
import { renderAccountAvatar, renderUserAvatar } from '../utils/avatar.js';
import { iconSvg } from '../ui/icons.js';
import { escapeAttr, escapeHtml, formatDateTime, formatQuotaPercent, quotaUsagePercent } from '../utils/format.js';
import { talentFamilyVisible, visibleTalentFamilyIds } from '../utils/talentCatalog.js';
import { renderPlugins } from './pluginsView.js';
import { releaseAnnouncementForVersion } from '../../../shared/releaseAnnouncements.js';
import { translateUiText } from '../i18n.js';

let viewDeps = {};

export function renderSettings(deps = {}) {
  viewDeps = deps;
  return renderSettingsView();
}

function sessionIsArchived(...args) {
  return viewDeps.sessionIsArchived?.(...args) || false;
}

function sessionSubtitle(...args) {
  return viewDeps.sessionSubtitle?.(...args) || '';
}

function activeSettingsSection() {
  const valid = new Set(['preferences', 'account', 'evolution-sync', 'skills', 'organization-research', 'connections', 'diagnostics', 'archived']);
  if (state.uBuddyFeatureFlags?.profileHistory === true || state.uBuddyFeatureFlags?.profilePreviewV1 === true) valid.add('ubuddy-profile');
  let section = state.currentSettingsSection || 'account';
  if (section === 'general' || section === 'appearance') section = 'preferences';
  if (!valid.has(section)) section = 'account';
  state.currentSettingsSection = section;
  return section;
}

function renderSettingsView() {
  const section = activeSettingsSection();
  if (section === 'diagnostics') {
    if (state.applicationLoggingStatus === null && !state.applicationLoggingLoading && viewDeps.loadApplicationLoggingStatus) {
      setTimeout(() => viewDeps.loadApplicationLoggingStatus(), 0);
    }
    return renderSettingsFrame(
      '诊断与日志',
      '查看本机日志状态，或导出脱敏诊断日志用于问题排查。',
      renderApplicationLoggingSettings(),
      'settings-diagnostics-view',
    );
  }
  if (!state.currentUser) {
    return `<div class="view settings-view">${renderAuthPanel()}</div>`;
  }
  if (section === 'archived' && state.archivedSessions === null && !state.archivedSessionsLoading) {
    setTimeout(() => loadArchivedSessions(), 0);
  }
  if (section === 'preferences') return renderSettingsFrame(
    '偏好',
    '管理当前设备上的 Janus 偏好。',
    renderPreferencesSettings(),
    'settings-preferences-view',
  );
  if (section === 'connections') {
    if (state.feishuStatus === null && !state.feishuLoading && viewDeps.loadFeishuStatus) {
      setTimeout(() => viewDeps.loadFeishuStatus(), 0);
    }
    return renderSettingsFrame(
      '飞书连接',
      '管理当前设备上的飞书机器人连接。',
      renderFeishuConnectionSettings(),
      'settings-connections-view',
    );
  }
  if (section === 'ubuddy-profile') {
    const previewEnabled = state.uBuddyFeatureFlags?.profilePreviewV1 === true;
    const historyEnabled = state.uBuddyFeatureFlags?.profileHistory === true;
    if (previewEnabled || historyEnabled) {
      if (previewEnabled
        && state.uBuddyCapabilityProfilePreview === null
        && !state.uBuddyCapabilityProfilePreviewLoading
        && viewDeps.loadUBuddyCapabilityProfilePreview) {
        setTimeout(() => viewDeps.loadUBuddyCapabilityProfilePreview(), 0);
      }
      if (historyEnabled
        && state.uBuddyCapabilityProfileHistory === null
        && !state.uBuddyCapabilityProfileHistoryLoading
        && viewDeps.loadUBuddyCapabilityProfileHistory) {
        setTimeout(() => viewDeps.loadUBuddyCapabilityProfileHistory(), 0);
      }
      const content = [
        previewEnabled ? renderUBuddyCapabilityProfilePreview() : '',
        historyEnabled ? renderUBuddyCapabilityProfileHistory() : '',
      ].filter(Boolean).join('');
      return renderSettingsFrame(
        'uBuddy',
        previewEnabled && historyEnabled
          ? '预览当前有效 Skill 归纳出的能力，并管理随 Skill 演进的本机版本与公开授权。'
          : previewEnabled
            ? '本地预览当前有效 Skill 所表达的能力与边界；不会保存或发布。'
            : '查看随有效 Skill 演进的历史版本，并审核公开范围与隐私风险。',
        content,
        'settings-ubuddy-profile-view',
      );
    }
  }
  // Keep the Settings entry identical to the Plugins main-navigation page.
  // This avoids maintaining a second layout (and the old three-stat summary
  // cards) for the same Skills & Plugins surface.
  if (section === 'skills') return renderPlugins(viewDeps);
  if (section === 'organization-research') {
    const activeOrganizationId = String(state.activeAccountWorkspace?.organizationId || '');
    if (!state.organizationResearchLoading && viewDeps.loadOrganizationResearchGovernance
      && (state.organizationResearchPolicy?.policy?.organizationId || state.organizationResearchPolicy?.organizationId || '') !== activeOrganizationId) {
      setTimeout(() => viewDeps.loadOrganizationResearchGovernance(), 0);
    }
    return renderSettingsFrame(
      '组织消息调查',
      '管理当前组织的调查政策并查看受权限约束的审计记录。',
      renderOrganizationResearchGovernance(),
      'settings-organization-research-view',
    );
  }
  if (section === 'archived') return renderSettingsFrame('已归档对话', '查看或恢复已归档的聊天。', renderArchivedConversations());
  if (section === 'evolution-sync') {
    if (state.evolutionPreference === null && !state.evolutionPreferenceLoading
      && !state.evolutionPreferenceError && viewDeps.loadEvolutionPreference) {
      setTimeout(() => viewDeps.loadEvolutionPreference(), 0);
    }
    return renderSettingsFrame(
      '自进化与同步',
      '检测个人与公司 Skill 更新，并管理各 Agent 的云端同步。',
      renderEvolutionAndSyncSettings(),
      'settings-evolution-sync-view',
    );
  }
  return renderSettingsFrame(
    '账户与权限',
    '管理账号、个人资料、模型服务和安全设置。',
    renderAccountPanel(),
    'settings-account-view',
    renderAccountSectionNavigator(),
  );
}

function renderOrganizationResearchGovernance() {
  const workspace = state.activeAccountWorkspace || {};
  const organizationId = String(workspace.organizationId || '');
  const organization = (state.friendOverview?.organizations || []).find((item) => String(item.id || '') === organizationId) || null;
  if (workspace.workspaceKind !== 'organization' || !organizationId) {
    return '<section class="panel settings-panel"><div class="empty">切换到组织 Workspace 后可查看组织消息调查设置。</div></section>';
  }
  const policy = state.organizationResearchPolicy?.policy || null;
  const audits = Array.isArray(state.organizationResearchAudits?.audits) ? state.organizationResearchAudits.audits : [];
  const manager = ['owner', 'admin'].includes(organization?.role);
  return `
    <section class="panel settings-panel organization-research-policy-panel">
      <div class="ubuddy-profile-preview-head">
        <div><span class="ubuddy-profile-eyebrow">${escapeHtml(organization?.name || '当前组织')}</span><h2>${policy?.status === 'enabled' ? '组织调查已启用' : '组织调查未启用'}</h2><p>${policy?.status === 'enabled' ? `仅索引 ${escapeHtml(formatDateTime(policy.enabledAt))} 之后的新组织消息，不回填历史。` : '只有组织 Owner 可在确认全员政策后启用。'}</p></div>
        <span class="diagnostics-status-pill ${policy?.status === 'enabled' ? 'is-ready' : ''}">${policy?.status === 'enabled' ? '已启用' : '关闭'}</span>
      </div>
      ${state.organizationResearchError ? `<div class="permission-note is-warning">${escapeHtml(state.organizationResearchError)}</div>` : ''}
      <div class="permission-note"><strong>固定边界</strong><span>覆盖组织内私聊、内部群、任务群和组织 Workspace Agent 对话；永久排除个人空间、私人助理、外部群及跨组织内容。成员不能单独退出索引。</span></div>
      ${organization?.role === 'owner' && !policy ? `<div class="diagnostics-actions"><button class="btn primary" type="button" data-organization-research-enable ${state.organizationResearchBusy ? 'disabled' : ''}>${state.organizationResearchBusy ? '正在启用…' : '确认政策并启用'}</button></div>` : ''}
    </section>
    <section class="panel settings-panel organization-research-audit-panel">
      <div class="ubuddy-profile-preview-head"><div><h2>${manager ? '组织调查记录' : '我的调查记录'}</h2><p>${manager ? '显示全组织最近 180 天记录。' : '仅显示你自己的最近 180 天记录。'}</p></div></div>
      ${state.organizationResearchLoading && !audits.length ? '<div class="empty">正在读取调查记录...</div>' : audits.length ? `<div class="organization-research-audit-list">${audits.map((item) => `<article><div><strong>${escapeHtml(item.mode === 'offline' ? '离线调查' : item.mode === 'fallback' ? '本地结果' : '在线调查')}</strong><small>${escapeHtml(formatDateTime(item.createdAt))} · ${Number(item.resultCount || 0)} 个来源</small></div>${manager ? `<span>${escapeHtml(item.queryingUserId || '')}</span>` : ''}<code>${escapeHtml(String(item.queryHash || '').slice(0, 12))}</code></article>`).join('')}</div>` : '<div class="empty">最近 180 天没有调查记录。</div>'}
    </section>`;
}

function renderUBuddyCapabilityProfileHistory() {
  const result = state.uBuddyCapabilityProfileHistory || {};
  const profiles = Array.isArray(result.profiles) ? result.profiles : [];
  const preference = result.preference || {};
  if (state.uBuddyCapabilityProfileHistoryLoading && !profiles.length) {
    return '<section class="panel settings-panel ubuddy-profile-preview-panel"><div class="empty">正在读取 uBuddy 简介历史...</div></section>';
  }
  return `
    <section class="panel settings-panel ubuddy-profile-preview-panel">
      <div class="ubuddy-profile-preview-head">
        <div><span class="ubuddy-profile-eyebrow">本机版本历史</span><h2>简介随 Skill 异步更新</h2><p>Skill 激活不等待简介；生成或验证失败时继续使用上一版。</p></div>
        <span class="diagnostics-status-pill ${profiles.some((item) => item.publicationState === 'active') ? 'is-ready' : ''}">${profiles.some((item) => item.publicationState === 'active') ? '已有生效版本' : '等待生成'}</span>
      </div>
      ${state.uBuddyCapabilityProfileHistoryError ? `<div class="permission-note is-warning">${escapeHtml(state.uBuddyCapabilityProfileHistoryError)}</div>` : ''}
      <div class="permission-note"><strong>公开设置</strong><span>${preference.enabled ? `已授权公开给${preference.visibility === 'organization' ? '组织成员' : '好友'}` : '尚未授权公开；所有版本仅保存在本机'}</span></div>
      <div class="diagnostics-actions">
        <button class="btn secondary" type="button" data-ubuddy-profile-history-regenerate ${state.uBuddyCapabilityProfileHistoryBusy ? 'disabled' : ''}>${state.uBuddyCapabilityProfileHistoryBusy === 'regenerate' ? '生成中…' : '根据当前 Skill 重新生成'}</button>
        ${preference.enabled ? `<button class="btn secondary" type="button" data-ubuddy-profile-publication-disable ${state.uBuddyCapabilityProfileHistoryBusy ? 'disabled' : ''}>停止公开</button>` : ''}
      </div>
    </section>
    <section class="panel settings-panel ubuddy-profile-history-panel">
      <h2>版本历史</h2>
      ${profiles.length ? profiles.map((item) => renderUBuddyCapabilityProfileRevision(item, preference)).join('') : '<div class="empty">尚无简介版本。打开本页后会按当前有效 Skill 异步生成第一版。</div>'}
    </section>
  `;
}

function renderUBuddyCapabilityProfileRevision(item = {}, preference = {}) {
  const profile = item.profile || {};
  const statusLabels = { draft: '草稿', validated: '已验证', active: '当前生效', archived: '历史归档', rejected: '已拒绝' };
  const pending = ['pending', 'generating'].includes(item.generationStatus);
  const needsReview = item.requiresUserConfirmation && ['validated', 'active'].includes(item.publicationState);
  const risk = Array.isArray(item.privacyRisks) && item.privacyRisks.length > 0;
  return `<article class="ubuddy-profile-history-item is-${escapeAttr(item.publicationState || 'draft')}">
    <header><div><strong>修订 ${Number(item.profileRevision || 0)}</strong><small>${escapeHtml(statusLabels[item.publicationState] || item.publicationState || '草稿')} · ${escapeHtml(item.generationStatus || 'pending')}</small></div><span>${escapeHtml(shortHash(item.sourceEffectiveSkillHash))}</span></header>
    ${profile.introduction ? `<p>${escapeHtml(profileUiText(profile.introduction))}</p>` : ''}
    ${pending ? '<div class="permission-note">简介正在后台生成，Skill 已正常生效。</div>' : ''}
    ${item.generationError ? `<div class="permission-note is-warning">生成失败：${escapeHtml(item.generationError)}；上一生效版本保持不变。</div>` : ''}
    ${risk ? `<div class="permission-note is-warning"><strong>检测到隐私风险</strong><span>${escapeHtml(item.privacyRisks.map((entry) => entry.code).filter(Boolean).join('、'))}</span></div>` : ''}
    ${needsReview ? `<div class="permission-note is-warning"><strong>需要人工确认</strong><span>${escapeHtml(item.confirmationReason || '能力范围或公开边界发生变化。')}</span></div>` : ''}
    ${profile.capabilityTags?.length ? `<div class="ubuddy-profile-chip-list"><ul>${profile.capabilityTags.slice(0, 10).map((tag) => `<li>${escapeHtml(profileUiText(tag))}</li>`).join('')}</ul></div>` : ''}
    <footer>
      <span>${escapeHtml(formatDateTime(item.generatedAt || item.createdAt || ''))}</span>
      ${needsReview ? `<div class="diagnostics-actions"><button class="btn primary" type="button" data-ubuddy-profile-review="approve" data-profile-revision="${Number(item.profileRevision || 0)}" data-profile-visibility="${escapeAttr(preference.visibility === 'organization' ? 'organization' : 'friends')}" ${state.uBuddyCapabilityProfileHistoryBusy ? 'disabled' : ''}>确认并${item.publicationState === 'active' ? '公开' : '启用'}</button><button class="btn secondary" type="button" data-ubuddy-profile-review="reject" data-profile-revision="${Number(item.profileRevision || 0)}" ${state.uBuddyCapabilityProfileHistoryBusy ? 'disabled' : ''}>拒绝</button></div>` : ''}
    </footer>
  </article>`;
}

function renderUBuddyCapabilityProfilePreview() {
  const result = state.uBuddyCapabilityProfilePreview || {};
  const profile = result.profile || null;
  if (state.uBuddyCapabilityProfilePreviewLoading && !profile) {
    return '<section class="panel settings-panel ubuddy-profile-preview-panel"><div class="empty">正在根据当前有效 Skill 生成简介...</div></section>';
  }
  if (!profile) {
    return `<section class="panel settings-panel ubuddy-profile-preview-panel">
      <div class="empty">${escapeHtml(state.uBuddyCapabilityProfilePreviewError || '暂时无法读取简介预览。')}</div>
      <button class="btn secondary" type="button" data-ubuddy-profile-refresh>重新生成</button>
    </section>`;
  }
  const fallback = result.source === 'fallback';
  return `
    <section class="panel settings-panel ubuddy-profile-preview-panel">
      <div class="ubuddy-profile-preview-head">
        <div>
          <span class="ubuddy-profile-eyebrow">仅本机预览</span>
          <h2>${escapeHtml(profileUiText(profile.introduction))}</h2>
          <p>${fallback ? '完整生成暂时不可用，已显示基础介绍；uBuddy 的任务处理不受影响。' : '内容由当前有效 Skill 自动归纳，未读取 Memory、私聊或附件。'}</p>
        </div>
        <span class="diagnostics-status-pill ${fallback ? '' : 'is-ready'}">${fallback ? '基础介绍' : '生成成功'}</span>
      </div>
      ${state.uBuddyCapabilityProfilePreviewError ? `<div class="permission-note is-warning">${escapeHtml(state.uBuddyCapabilityProfilePreviewError)}</div>` : ''}
      ${renderProfileList('擅长的任务类型', profile.supportedTaskTypes)}
      ${renderProfileDeliverables(profile.deliverableTypes)}
      ${renderProfileList('能力标签', profile.capabilityTags, 'ubuddy-profile-chip-list')}
      <div class="ubuddy-profile-two-column">
        ${renderProfileList('偏好的任务', profile.preferredTasks)}
        ${renderProfileList('不适合或不支持', profile.unsupportedTasks)}
      </div>
      ${renderProfileList('需要改进的方向', profile.improvementDirections)}
      ${renderProfileList('支持的协作方式', profile.collaborationModes)}
      ${renderProfileList('隐私及对外承诺限制', profile.privacyConstraints)}
      <section class="ubuddy-profile-evidence">
        <h3>能力证据摘要</h3>
        <p>${escapeHtml(profileUiText(profile.evidenceSummary || '—'))}</p>
      </section>
      <div class="ubuddy-profile-metadata">
        <span>Profile：${escapeHtml(profile.version || '—')}</span>
        <span>Skill hash：${escapeHtml(shortHash(profile.sourceEffectiveSkillHash))}</span>
        <span>生成时间：${escapeHtml(profile.generatedAt ? formatDateTime(profile.generatedAt) : '—')}</span>
        <span>状态：不持久化 · 不发布</span>
      </div>
      <div class="diagnostics-actions">
        <button class="btn secondary" type="button" data-ubuddy-profile-refresh ${state.uBuddyCapabilityProfilePreviewLoading ? 'disabled' : ''}>${state.uBuddyCapabilityProfilePreviewLoading ? '正在生成…' : '重新生成'}</button>
      </div>
    </section>
  `;
}

function renderProfileList(title, items = [], className = '') {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  return `<section class="ubuddy-profile-section ${escapeAttr(className)}">
    <h3>${escapeHtml(profileUiText(title))}</h3>
    <ul>${values.map((item) => `<li>${escapeHtml(profileUiText(item))}</li>`).join('') || `<li>${escapeHtml(profileUiText('暂无'))}</li>`}</ul>
  </section>`;
}

function profileUiText(value = '') {
  return translateUiText(String(value || ''), state.languageMode);
}

function renderProfileDeliverables(items = []) {
  const labels = { answer: '直接答复', report: '报告', document: '文档', presentation: '演示文稿', spreadsheet: '表格', image: '图像', code_change: '代码修改' };
  return renderProfileList('可交付成果类型', (Array.isArray(items) ? items : []).map((item) => labels[item] || item), 'ubuddy-profile-chip-list');
}

function shortHash(value = '') {
  const text = String(value || '').trim();
  return text ? `${text.slice(0, 12)}…` : '—';
}

function renderApplicationLoggingSettings() {
  const status = state.applicationLoggingStatus || {};
  const busy = Boolean(state.applicationLoggingBusy);
  if (state.applicationLoggingLoading && !state.applicationLoggingStatus) {
    return '<section class="panel settings-panel diagnostics-settings-panel"><div class="empty">正在读取日志状态...</div></section>';
  }
  return `
    <section class="panel settings-panel diagnostics-settings-panel">
      <div class="diagnostics-status-head">
        <div>
          <h2>本机应用日志</h2>
          <p>日志仅保存在本机，默认不记录对话、Prompt、模型回答或文件内容，也不会自动上传。</p>
        </div>
        <span class="diagnostics-status-pill ${status.enabled ? 'is-ready' : 'is-error'}">${status.enabled ? '正常运行' : '不可用'}</span>
      </div>
      ${state.applicationLoggingError ? `<div class="permission-note is-warning">${escapeHtml(state.applicationLoggingError)}</div>` : ''}
      <div class="diagnostics-metric-grid">
        ${renderDiagnosticMetric('日志等级', status.level || '—')}
        ${renderDiagnosticMetric('保留期限', status.retentionDays ? `${status.retentionDays} 天` : '—')}
        ${renderDiagnosticMetric('文件数量', Number.isFinite(status.fileCount) ? `${status.fileCount} 个` : '—')}
        ${renderDiagnosticMetric('占用空间', formatDiagnosticBytes(status.totalBytes))}
        ${renderDiagnosticMetric('最近写入', status.lastWriteAt ? formatDateTime(status.lastWriteAt) : '尚无记录')}
        ${renderDiagnosticMetric('丢弃事件', Number.isFinite(status.droppedCount) ? String(status.droppedCount) : '0')}
      </div>
      ${status.lastError ? `<div class="permission-note is-warning"><strong>最近写入错误</strong><span>${escapeHtml(status.lastError)}</span></div>` : ''}
      <div class="diagnostics-actions">
        <button class="btn secondary" type="button" data-logging-open-directory ${busy || !status.enabled ? 'disabled' : ''}>打开日志目录</button>
        <button class="btn primary" type="button" data-logging-export ${busy || !status.enabled ? 'disabled' : ''}>${state.applicationLoggingBusy === 'export' ? '正在导出…' : '导出诊断日志'}</button>
        <button class="btn secondary" type="button" data-logging-clear ${busy || !status.enabled ? 'disabled' : ''}>${state.applicationLoggingBusy === 'clear' ? '正在清理…' : '清理旧日志'}</button>
      </div>
      <p class="diagnostics-export-note">导出文件默认为 <code>Janus-Diagnostics-时间.log</code>，保存位置可在系统下载目录中选择。</p>
    </section>
  `;
}

function renderDiagnosticMetric(label, value) {
  return `<div class="diagnostics-metric"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

function formatDiagnosticBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderSettingsFrame(title, subtitle, body, extraClass = '', sectionNavigator = '') {
  return `
    <div class="view settings-view settings-section-view ${escapeAttr(extraClass)}">
      ${sectionNavigator}
      <header class="settings-section-head">
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
      </header>
      <div class="settings-section-body">${body}</div>
    </div>
  `;
}

const ACCOUNT_SECTIONS = Object.freeze([
  ['organization', '组织管理', 'Organization'],
  ['updates', '更新中心', 'Updates'],
  ['model-service', '模型服务', 'Models'],
  ['profile', '个人资料', 'Profile'],
  ['security', '安全设置', 'Security'],
  ['sign-out', '退出登录', 'Sign Out'],
]);

function renderAccountSectionNavigator() {
  const labelForLanguage = (chinese, english) => state.languageMode === 'en' ? english : chinese;
  const items = ACCOUNT_SECTIONS.map(([id, chinese, english], index) => `
    <button class="account-section-nav-item ${index === 0 ? 'active' : ''}" type="button" data-account-section-target="${escapeAttr(id)}" ${index === 0 ? 'aria-current="location"' : ''}>
      <span>${escapeHtml(labelForLanguage(chinese, english))}</span>
    </button>
  `).join('');
  const options = ACCOUNT_SECTIONS.map(([id, chinese, english]) => `<option value="${escapeAttr(id)}">${escapeHtml(labelForLanguage(chinese, english))}</option>`).join('');
  return `
    <nav class="account-section-nav" aria-label="账户页面章节">
      <div class="account-section-nav-list">${items}</div>
    </nav>
    <label class="account-section-menu">
      <select data-account-section-menu aria-label="跳转到章节">${options}</select>
    </label>
  `;
}

function renderPreferencesSettings() {
  return `
    <section class="panel settings-panel">
      <h2>主题</h2>
      <div class="settings-choice-grid">
        <button class="settings-choice ${state.themeMode === 'light' ? 'active' : ''}" type="button" data-theme-choice="light">
          <span>${iconSvg('sun')}</span>
          <strong>浅色</strong>
          <small>明亮、适合日间工作。</small>
        </button>
        <button class="settings-choice ${state.themeMode === 'dark' ? 'active' : ''}" type="button" data-theme-choice="dark">
          <span>${iconSvg('moon')}</span>
          <strong>深色</strong>
          <small>降低夜间和暗光环境的视觉刺激。</small>
        </button>
      </div>
    </section>
    <section class="panel settings-panel settings-language-panel">
      <h2>语言</h2>
      <div class="settings-choice-grid">
        <button class="settings-choice ${state.languageMode === 'en' ? 'active' : ''}" type="button" data-language-choice="en">
          <span class="settings-language-mark" data-no-localize>EN</span>
          <strong data-no-localize>English</strong>
          <small>默认语言，文案更紧凑。</small>
        </button>
        <button class="settings-choice ${state.languageMode === 'zh-CN' ? 'active' : ''}" type="button" data-language-choice="zh-CN">
          <span class="settings-language-mark" data-no-localize>中</span>
          <strong data-no-localize>中文</strong>
          <small>使用简体中文界面。</small>
        </button>
      </div>
    </section>
    ${renderDesktopLifecycleSettings()}
  `;
}

function renderDesktopLifecycleSettings() {
  const lifecycle = state.desktopLifecycle || {};
  const behavior = lifecycle.closeBehavior || lifecycle.defaultCloseBehavior || (window.janus?.platform === 'darwin' ? 'background' : 'quit');
  const platform = lifecycle.platform || window.janus?.platform || '';
  const backgroundAvailable = lifecycle.backgroundAvailable !== false;
  const backgroundDescription = platform === 'darwin' && !lifecycle.trayActive
    ? 'Janus 将继续运行，可从 Dock 重新打开'
    : backgroundAvailable
      ? `Janus 将继续运行并保留在${platform === 'win32' ? '通知区域' : platform === 'darwin' ? '菜单栏' : '系统托盘'}`
      : '后台运行当前不可用，关闭最后一个窗口时 Janus 将退出';
  const trayErrorLabel = platform === 'darwin'
    ? '菜单栏图标不可用'
    : platform === 'win32' ? '通知区域图标不可用' : '系统托盘不可用';
  return `
    <section class="panel settings-panel desktop-lifecycle-settings">
      <div class="settings-row desktop-lifecycle-row">
        <span>
          <strong>关闭最后一个窗口时</strong>
          <small>${behavior === 'background' ? backgroundDescription : 'Janus 将结束本机任务并退出'}</small>
        </span>
        <div class="desktop-lifecycle-segment" role="radiogroup" aria-label="关闭窗口时">
          <button type="button" role="radio" aria-checked="${behavior === 'background'}" class="${behavior === 'background' ? 'active' : ''}"
            data-desktop-close-behavior="background" ${state.desktopLifecycleBusy ? 'disabled' : ''}>后台运行</button>
          <button type="button" role="radio" aria-checked="${behavior === 'quit'}" class="${behavior === 'quit' ? 'active' : ''}"
            data-desktop-close-behavior="quit" ${state.desktopLifecycleBusy ? 'disabled' : ''}>退出 Janus</button>
        </div>
      </div>
      ${lifecycle.lastError ? `<div class="settings-inline-error">${trayErrorLabel}：${escapeHtml(lifecycle.lastError)}</div>` : ''}
    </section>
  `;
}

function renderFeishuConnectionSettings() {
  if (state.feishuLoading && !state.feishuStatus) {
    return '<section class="panel settings-panel"><div class="empty">正在读取飞书连接状态...</div></section>';
  }
  const status = state.feishuStatus || {};
  const draft = state.feishuDraft || {};
  const appId = draft.appId ?? status.appId ?? '';
  const domain = draft.domain ?? status.domain ?? 'feishu';
  const enabled = draft.enabled ?? status.enabled ?? false;
  const busy = Boolean(state.feishuBusy);
  const connectionLabels = {
    connected: '已连接', connecting: '正在连接', reconnecting: '正在重连', error: '连接错误', paused: '已暂停', disabled: '未启用',
  };
  const secureStorage = status.secureStorage || {};
  const test = state.feishuTestResult;
  return `
    <section class="panel settings-panel">
      <h2>手机连接（局域网测试版）</h2>
      <p>手机与电脑连接同一 Wi-Fi 后，可查看会话并发送指令。后端仍运行在这台电脑上。</p>
      <button class="btn primary" type="button" data-mobile-gateway-show>显示连接地址和配对码</button>
    </section>
    <section class="panel settings-panel feishu-settings-panel">
      <div class="feishu-status-row">
        <span><strong>机器人连接</strong><small>${escapeHtml(connectionLabels[status.connectionState] || '等待配置')}</small></span>
        <span class="feishu-status-badge is-${escapeAttr(status.connectionState || 'disabled')}">${escapeHtml(connectionLabels[status.connectionState] || '未配置')}</span>
      </div>
      ${status.lastError ? `<div class="settings-inline-error">${escapeHtml(status.lastError)}</div>` : ''}
      ${secureStorage.secure === false ? '<div class="settings-inline-error">系统安全凭证存储不可用，无法保存 App Secret。</div>' : ''}
      <form class="settings-form feishu-config-form" data-feishu-config-form>
        <label><span>App ID</span><input id="feishu-app-id" type="text" value="${escapeAttr(appId)}" autocomplete="off" required /></label>
        <label><span>App Secret</span><input id="feishu-app-secret" type="password" value="${escapeAttr(draft.appSecret || '')}" placeholder="${status.hasAppSecret ? '已安全保存，留空则不修改' : '请输入 App Secret'}" autocomplete="new-password" /></label>
        <label class="feishu-domain-field"><span>服务区域</span><select id="feishu-domain">
          <option value="feishu" ${domain === 'feishu' ? 'selected' : ''}>飞书（中国）</option>
          <option value="lark" ${domain === 'lark' ? 'selected' : ''}>Lark（国际）</option>
        </select></label>
        <label class="feishu-enabled-toggle">
          <span class="feishu-enabled-copy"><strong>启用飞书连接</strong><small>${enabled ? '机器人长连接已启用' : '机器人长连接未启用'}</small></span>
          <input id="feishu-enabled" type="checkbox" ${enabled ? 'checked' : ''} />
          <span class="feishu-switch-control" aria-hidden="true"></span>
        </label>
        <div class="settings-form-actions">
          <button class="mini-btn" type="button" data-feishu-test ${busy ? 'disabled' : ''}>${state.feishuBusy === 'test' ? '正在测试...' : '测试凭证'}</button>
          <button class="mini-btn primary" type="submit" ${busy || secureStorage.secure === false ? 'disabled' : ''}>${state.feishuBusy === 'save' ? '正在保存...' : '保存配置'}</button>
        </div>
      </form>
      ${test ? `<div class="settings-inline-${test.ok ? 'success' : 'error'}">${escapeHtml(test.message || '')}</div>` : ''}
    </section>
    ${status.configured ? `<section class="panel settings-panel feishu-binding-panel">
      <h2>账号绑定</h2>
      ${status.bound
        ? `<div class="feishu-binding-state"><strong>已绑定</strong><small>${status.boundAt ? escapeHtml(formatDateTime(status.boundAt)) : ''}</small></div>
          <button class="mini-btn danger" type="button" data-feishu-unbind ${busy ? 'disabled' : ''}>解除绑定</button>`
        : `<div class="feishu-binding-code">
            <span>绑定命令</span>
            <code>${status.bindingCode ? `绑定 ${escapeHtml(status.bindingCode)}` : '绑定码未显示'}</code>
            ${status.bindingCodeExpiresAt ? `<small>有效期至 ${escapeHtml(formatDateTime(status.bindingCodeExpiresAt))}</small>` : ''}
          </div>
          <button class="mini-btn" type="button" data-feishu-regenerate ${busy ? 'disabled' : ''}>${state.feishuBusy === 'regenerate' ? '正在生成...' : '生成新绑定码'}</button>`}
    </section>` : ''}
  `;
}

function renderArchivedConversations() {
  if (state.archivedSessionsLoading && state.archivedSessions === null) {
    return '<section class="panel settings-panel"><div class="empty">正在加载已归档对话...</div></section>';
  }
  if (state.archivedSessionsError) {
    return `<section class="panel settings-panel"><div class="empty">加载失败：${escapeHtml(state.archivedSessionsError)}</div></section>`;
  }
  const sessions = (state.archivedSessions || []).filter(sessionIsArchived);
  const archivedInbox = archivedInboxConversations();
  const groupConversations = [
    ...(state.chatGroupsOverview?.groups || []).filter((group) => group?.archived).map((group) => ({ ...group, archiveKind: 'chat-group' })),
    ...(state.collaborationOverview?.groups || []).filter((group) => group?.archived).map((group) => ({ ...group, archiveKind: 'task' })),
  ].sort((left, right) => new Date(right.updatedAt || right.updated_at || 0) - new Date(left.updatedAt || left.updated_at || 0));
  return `
    <section class="panel settings-panel archived-conversations-panel">
      ${[...groupConversations.map(renderArchivedGroupConversation), ...sessions.map(renderArchivedSession), ...archivedInbox.map(renderArchivedInboxConversation)].join('') || '<div class="empty archived-empty">暂无已归档的聊天。</div>'}
    </section>
  `;
}

function archivedInboxConversations() {
  const preferences = (state.conversationPreferences?.preferences || [])
    .filter((item) => item?.archived && ['social_direct', 'agent_session'].includes(item.conversationKind));
  const sessionsById = new Map([...(state.sessions || []), ...(state.archivedSessions || [])]
    .filter((session) => session?.id)
    .map((session) => [session.id, session]));
  const threads = state.socialThreads || [];
  const friends = state.friendOverview?.friends || [];
  const result = [];
  const seen = new Set();
  for (const preference of preferences) {
    const id = String(preference.conversationId || '').trim();
    const kind = preference.conversationKind;
    if (!id) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === 'agent_session') {
      const session = sessionsById.get(id);
      if (session && !sessionIsArchived(session)) result.push({ kind, id, session });
      continue;
    }
    const thread = threads.find((item) => (
      String(item?.conversationId || item?.conversation_id || '') === id
      || (item?.messages || []).some((message) => String(message?.conversationId || message?.conversation_id || '') === id)
    ));
    const peerId = thread?.friend?.id || thread?.friend?.userId || '';
    const relationship = friends.find((item) => String(item?.friend?.id || item?.user?.id || '') === String(peerId));
    const friend = thread?.friend || relationship?.friend || relationship?.user || { id: peerId };
    const last = [...(thread?.messages || [])].at(-1) || {};
    result.push({ kind, id, friend, last });
  }
  return result.sort((left, right) => {
    const leftTime = left.kind === 'agent_session'
      ? left.session?.updatedAt || left.session?.updated_at || left.session?.createdAt || left.session?.created_at
      : left.last?.updatedAt || left.last?.updated_at || left.last?.createdAt || left.last?.created_at;
    const rightTime = right.kind === 'agent_session'
      ? right.session?.updatedAt || right.session?.updated_at || right.session?.createdAt || right.session?.created_at
      : right.last?.updatedAt || right.last?.updated_at || right.last?.createdAt || right.last?.created_at;
    return new Date(rightTime || 0) - new Date(leftTime || 0);
  });
}

function renderArchivedInboxConversation(item = {}) {
  if (item.kind === 'agent_session') {
    const session = item.session || {};
    return `
      <article class="archived-session-row">
        <button class="archived-session-main" type="button" data-archived-session="${escapeAttr(session.id)}">
          <span class="archived-session-icon">${iconSvg('archive')}</span>
          <span><strong>${escapeHtml(session.title || '未命名 Agent 对话')}</strong><small>${escapeHtml(sessionSubtitle(session))} · ${escapeHtml(formatDateTime(session.updatedAt || session.updated_at || session.createdAt || session.created_at))}</small></span>
        </button>
        <div class="archived-session-actions"><button class="mini-btn" type="button" data-conversation-archive="agent:${escapeAttr(session.id)}">恢复</button></div>
      </article>
    `;
  }
  const friend = item.friend || {};
  const displayName = friend.remark || friend.displayName || friend.display_name || friend.username || friend.email || friend.id || '联系人会话';
  return `
    <article class="archived-session-row">
      <button class="archived-session-main" type="button" data-network-peer="${escapeAttr(friend.id || '')}" data-network-mode="person">
        <span class="archived-session-icon">${iconSvg('message')}</span>
        <span><strong>${escapeHtml(displayName)}</strong><small>联系人私聊 · ${escapeHtml(formatDateTime(item.last?.updatedAt || item.last?.createdAt || item.last?.created_at))}</small></span>
      </button>
      <div class="archived-session-actions"><button class="mini-btn" type="button" data-conversation-archive="direct:${escapeAttr(item.id)}">恢复</button></div>
    </article>
  `;
}

function renderArchivedGroupConversation(group = {}) {
  const natural = group.archiveKind === 'chat-group';
  const key = `${natural ? 'chat-group' : 'task'}:${group.id}`;
  const title = group.title || (natural ? '联系人群聊' : 'uBuddy 工作群');
  const status = natural ? (group.status === 'dissolved' ? '已解散群聊' : '联系人群聊') : 'uBuddy 工作群';
  const openAttribute = natural ? 'data-chat-group' : 'data-collaboration-group';
  return `
    <article class="archived-session-row archived-group-row">
      <button class="archived-session-main" type="button" ${openAttribute}="${escapeAttr(group.id)}">
        <span class="archived-session-icon">${iconSvg(natural ? 'message' : 'network')}</span>
        <span><strong data-no-localize>${escapeHtml(title)}</strong><small>${escapeHtml(translateUiText(status, state.languageMode))} · ${escapeHtml(formatDateTime(group.updatedAt || group.updated_at))}</small></span>
      </button>
      <div class="archived-session-actions">
        <button class="mini-btn" type="button" data-conversation-archive="${escapeAttr(key)}">恢复</button>
      </div>
    </article>
  `;
}

function renderArchivedSession(session) {
  return `
    <article class="archived-session-row">
      <button class="archived-session-main" type="button" data-archived-session="${escapeAttr(session.id)}">
        <span class="archived-session-icon">${iconSvg('archive')}</span>
        <span>
          <strong>${escapeHtml(session.title || '未命名聊天')}</strong>
          <small>${escapeHtml(sessionSubtitle(session))} · ${escapeHtml(formatDateTime(session.updatedAt || session.updated_at || session.createdAt || session.created_at))}</small>
        </span>
      </button>
      <div class="archived-session-actions">
        <button class="mini-btn" type="button" data-session-action="unarchive" data-session-id="${escapeAttr(session.id)}">恢复</button>
        <button class="mini-btn danger" type="button" data-session-action="delete" data-session-id="${escapeAttr(session.id)}">删除</button>
      </div>
    </article>
  `;
}

export function renderAuthPanel() {
  const notice = renderEmailCodeNotice();
  if (state.authScreen === 'reset') return renderEmailResetPanel(notice);
  if (state.authScreen === 'register') return renderRegisterPanel(notice);
  return renderPasswordLoginPanel();
}

function renderPasswordLoginPanel() {
  return `
    <section class="auth-card">
      <div class="auth-card-heading">
        <h2>Janus 用户登录</h2>
      </div>
      <form id="login-form" class="auth-form" autocomplete="off" novalidate>
        <label><span>账号</span><input id="login-identifier" name="janus-login-identifier" value="${escapeAttr(state.authDraft.loginIdentifier)}" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="邮箱 / 用户 ID" maxlength="254" required /></label>
        <label><span>密码</span><input id="login-password" name="janus-login-secret" value="${escapeAttr(state.authDraft.loginPassword)}" type="password" autocomplete="off" placeholder="请输入密码" maxlength="128" required /></label>
        <button class="auth-primary-btn" type="submit">登录</button>
      </form>
      ${renderAuthFeedback()}
      <div class="auth-card-footer">
        <button id="show-password-reset-btn" type="button">忘记密码</button>
        <button id="show-register-btn" type="button">注册</button>
        ${renderAuthLanguageToggle()}
      </div>
    </section>
  `;
}

function renderRegisterPanel(notice = renderEmailCodeNotice()) {
  const codeAction = emailCodeActionState('register', state.authDraft.registerEmail);
  return `
    <section class="auth-card auth-register-card">
      <button class="auth-back-btn" id="back-to-login-btn" type="button">${iconSvg('chevronLeft')} 返回登录</button>
      <div class="auth-card-heading">
        <h2>注册 Janus 账号</h2>
      </div>
      <p class="auth-card-subtitle">验证码将发送到你的邮箱，验证通过后才能完成注册。</p>
      <form id="register-form" class="auth-form compact" autocomplete="off" novalidate>
        <label><span>显示名称</span><input id="register-name" name="janus-register-display-name" value="${escapeAttr(state.authDraft.registerName)}" autocomplete="off" placeholder="可选" maxlength="80" /></label>
        <label><span>邮箱</span><input id="register-email" name="janus-register-email" value="${escapeAttr(state.authDraft.registerEmail)}" type="email" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="请输入邮箱" maxlength="254" required /></label>
        <div class="auth-code-row">
          <label><span>邮箱验证码</span><input id="register-code" name="janus-register-code" value="${escapeAttr(state.authDraft.registerCode)}" inputmode="numeric" autocomplete="off" placeholder="6 位验证码" maxlength="6" pattern="[0-9]{6}" required /></label>
          <button class="auth-ghost-btn" id="send-register-code-btn" type="button"${codeAction.disabled ? ' disabled' : ''}>${codeAction.label}</button>
        </div>
        <label><span>初始密码</span><input id="register-password" name="janus-register-secret" value="${escapeAttr(state.authDraft.registerPassword)}" type="password" autocomplete="off" placeholder="至少 8 位，包含字母和数字" minlength="8" maxlength="128" required /></label>
        <label><span>确认密码</span><input id="register-password-confirm" name="janus-register-secret-confirm" value="${escapeAttr(state.authDraft.registerPasswordConfirm)}" type="password" autocomplete="off" placeholder="再次输入密码" minlength="8" maxlength="128" required /></label>
        <button class="auth-primary-btn" type="submit">注册并登录</button>
      </form>
      ${renderAuthFeedback()}
      ${notice}
      <div class="auth-card-language-footer">${renderAuthLanguageToggle()}</div>
    </section>
  `;
}

function renderEmailResetPanel(notice = renderEmailCodeNotice()) {
  const codeAction = emailCodeActionState('password_reset', state.authDraft.resetEmail);
  return `
    <section class="auth-card auth-reset-card">
      <button class="auth-back-btn" id="back-to-login-btn" type="button">${iconSvg('chevronLeft')} 返回登录</button>
      <div class="auth-card-heading">
        <h2>重置密码</h2>
      </div>
      <p class="auth-card-subtitle">通过邮箱验证码确认身份，然后设置新密码。</p>
      <form id="password-reset-form" class="auth-form compact">
        <label><span>邮箱</span><input id="reset-email" value="${escapeAttr(state.authDraft.resetEmail)}" type="email" autocomplete="email" placeholder="请输入注册邮箱" /></label>
        <div class="auth-code-row">
          <label><span>验证码</span><input id="reset-code" value="${escapeAttr(state.authDraft.resetCode)}" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码" /></label>
          <button class="auth-ghost-btn" id="send-reset-code-btn" type="button"${codeAction.disabled ? ' disabled' : ''}>${codeAction.label}</button>
        </div>
        <label><span>新密码</span><input id="reset-new-password" value="${escapeAttr(state.authDraft.resetNewPassword)}" type="password" autocomplete="new-password" placeholder="至少 8 位，包含字母和数字" /></label>
        <button class="auth-secondary-btn" type="submit">重置密码</button>
      </form>
      ${renderAuthFeedback()}
      ${notice}
      <div class="auth-card-language-footer">${renderAuthLanguageToggle()}</div>
    </section>
  `;
}

function renderAuthLanguageToggle() {
  const english = state.languageMode === 'en';
  const targetLabel = english ? '切换至中文' : 'Switch to English';
  return `
    <button class="auth-language-toggle" id="auth-language-toggle" type="button" aria-label="${targetLabel}" title="${targetLabel}" data-no-localize>
      <span class="auth-language-icon" aria-hidden="true">${iconSvg('globe')}</span>
      <span class="auth-language-label">${english ? 'EN' : '中'}</span>
    </button>
  `;
}

function renderAuthFeedback() {
  const feedback = state.authFeedback;
  if (!feedback?.message) return '';
  const tone = feedback.tone === 'success' ? 'success' : 'error';
  const title = feedback.title || (tone === 'success' ? '操作成功' : '操作未完成');
  const localize = (value) => translateUiText(String(value || ''), state.languageMode);
  return `
    <div class="auth-feedback ${tone}" role="${tone === 'error' ? 'alert' : 'status'}" aria-live="${tone === 'error' ? 'assertive' : 'polite'}">
      <span class="auth-feedback-icon" aria-hidden="true">${iconSvg(tone === 'success' ? 'check' : 'helpCircle')}</span>
      <span class="auth-feedback-copy">
        <strong>${escapeHtml(localize(title))}</strong>
        <span>${escapeHtml(localize(feedback.message))}</span>
        ${feedback.hint ? `<small>${escapeHtml(localize(feedback.hint))}</small>` : ''}
      </span>
    </div>
  `;
}

function renderEmailCodeNotice() {
  const item = state.emailCodeNotice;
  if (!item) return '';
  const localize = (value) => translateUiText(value, state.languageMode);
  const target = String(item.target || item.email || item.phone || '').trim();
  const purpose = emailPurposeLabel(item.purpose || '');
  const title = localize(item.reused ? '\u9a8c\u8bc1\u7801\u4ecd\u7136\u6709\u6548' : '\u9a8c\u8bc1\u7801\u5df2\u53d1\u9001');
  const destinationLabel = localize(purpose ? `${purpose}\u9a8c\u8bc1\u7801\u5df2\u53d1\u9001\u81f3` : '\u5df2\u53d1\u9001\u81f3');
  const destination = target
    ? `${escapeHtml(destinationLabel)} <b data-no-localize>${escapeHtml(target)}</b>`
    : escapeHtml(localize('\u8bf7\u68c0\u67e5\u90ae\u7bb1\u83b7\u53d6\u9a8c\u8bc1\u7801\u3002'));
  const detail = localize(item.reused
    ? '\u8bf7\u4f7f\u7528\u6700\u540e\u4e00\u6b21\u6536\u5230\u7684\u90ae\u4ef6\uff0c\u9a8c\u8bc1\u7801 10 \u5206\u949f\u5185\u6709\u6548\uff0c\u4ec5\u53ef\u4f7f\u7528\u4e00\u6b21\u3002'
    : '10 \u5206\u949f\u5185\u6709\u6548\uff0c\u4ec5\u53ef\u4f7f\u7528\u4e00\u6b21\u3002\u6ca1\u6709\u6536\u5230\u65f6\u8bf7\u68c0\u67e5\u5783\u573e\u90ae\u4ef6\u3002');
  return `
    <div class="email-code-notice" role="status" aria-live="polite">
      <span class="email-code-notice-icon" aria-hidden="true">${iconSvg('check')}</span>
      <span class="email-code-notice-copy">
        <strong>${escapeHtml(title)}</strong>
        <span>${destination}</span>
        <small>${escapeHtml(detail)}</small>
      </span>
    </div>
  `;
}

function emailCodeActionState(purpose = '', target = '') {
  const cleanTarget = String(target || '').trim().toLowerCase();
  const sending = state.emailCodeSending;
  if (sending?.purpose === purpose && sending.target === cleanTarget) {
    return { disabled: true, label: '发送中…' };
  }
  const cooldown = state.emailCodeCooldowns?.[purpose];
  const remainingSeconds = cooldown?.target === cleanTarget
    ? Math.max(0, Math.ceil((Number(cooldown.until || 0) - Date.now()) / 1000))
    : 0;
  return remainingSeconds > 0
    ? { disabled: true, label: `${remainingSeconds} 秒后重发` }
    : { disabled: false, label: '获取验证码' };
}

function emailPurposeLabel(purpose) {
  if (purpose === 'password_reset') return '重置密码';
  if (purpose === 'password_change') return '修改密码';
  return '注册';
}

function renderAccountPanel() {
  const user = state.currentUser || {};
  const displayName = user.display_name || user.displayName || user.id || '';
  const email = user.email || '';
  const username = user.username || '';
  const avatarUrl = user.avatar_url || user.avatarUrl || '';
  const passwordCodeAction = emailCodeActionState('password_change', email);
  const organizationWorkspaces = (state.accountWorkspaces || []).filter((item) => item.kind === 'organization');
  const startupWorkspaceId = state.startupAccountWorkspace?.id || state.activeAccountWorkspace?.id || '';
  return `
    <section class="account-settings-panel account-modern-panel">
      <div class="account-hero-row">
        <div class="account-hero-main">
          ${renderUserAvatar(user, { className: 'avatar account-hero-avatar', title: displayName || 'Janus User' })}
          <div>
            <h2>${escapeHtml(displayName || 'Janus 用户')}</h2>
            <p>${escapeHtml(email || user.id || '')}</p>
          </div>
        </div>
        <span class="account-role-pill ${user.role === 'admin' ? 'admin' : ''}">${escapeHtml(roleLabel(user.role))}</span>
      </div>

      <h3 class="settings-subsection-title account-section-anchor" id="account-section-organization" data-account-section="organization">组织与通讯录</h3>
      <form id="startup-workspace-form" class="settings-group-card settings-row-form">
        <label class="settings-row editable">
          <span><strong>默认组织</strong><small>Janus 启动时自动进入该组织；临时切换不会改变此设置</small></span>
          ${renderSettingsCustomSelect(
            'startup-workspace-select',
            organizationWorkspaces.length
              ? organizationWorkspaces.map((workspace) => [workspace.id, workspace.name || '未命名组织'])
              : [['', '尚未加入组织']],
            startupWorkspaceId,
            '默认组织',
            { className: 'startup-workspace-select', icon: 'building', disabled: !organizationWorkspaces.length },
          )}
        </label>
        <div class="settings-row action-row"><span><strong>保存默认组织</strong><small>若退出该组织，将自动选择其他有效组织</small></span><button class="btn primary" type="submit" ${organizationWorkspaces.length ? '' : 'disabled'}>保存</button></div>
      </form>

      <section class="settings-group-card account-info-card">
        <div class="settings-row compact">
          <div>
            <strong>User ID</strong>
            <span>${escapeHtml(user.id || '')}</span>
          </div>
        </div>
        <div class="settings-row compact">
          <div>
            <strong>Email</strong>
            <span>${escapeHtml(email || '-')}</span>
          </div>
          ${user.emailVerified ? '<span class="verify-badge verified">已验证</span>' : '<span class="verify-badge">未验证</span>'}
        </div>
        <div class="settings-row compact">
          <div>
            <strong>用户名</strong>
            <span>${escapeHtml(username || '-')}</span>
          </div>
        </div>
      </section>

      ${renderDeviceUpdates()}

      ${(user.role === 'admin' || user.permissions?.canEditCodexConfig)
        ? renderModelServiceSettings()
        : renderManagedModelServiceSettings()}

      <h3 class="settings-subsection-title account-section-anchor" id="account-section-profile" data-account-section="profile">个人资料</h3>
      <form id="profile-form" class="settings-group-card settings-row-form">
        <div class="settings-row editable profile-avatar-row">
          <span>
            <strong>\u5934\u50cf</strong>
            <small>\u9009\u62e9\u4e00\u5f20\u56fe\u7247\u4f5c\u4e3a\u8d26\u53f7\u5934\u50cf\uff0c\u4fa7\u680f\u548c\u804a\u5929\u4e2d\u4f1a\u540c\u6b65\u663e\u793a</small>
          </span>
          <div class="profile-avatar-editor">
            <button class="profile-avatar-preview-button" type="button" data-profile-avatar-preview aria-label="查看头像">
              ${renderAccountAvatar(user, { className: 'profile-avatar-preview', title: displayName || 'Janus User' })}
            </button>
            <input id="profile-avatar-url" type="hidden" value="${escapeAttr(avatarUrl)}" />
            <input id="profile-avatar-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
            <div class="profile-avatar-actions">
              <button class="btn secondary" type="button" data-profile-avatar-select>\u9009\u62e9\u56fe\u7247</button>
              <button class="btn secondary" type="button" data-profile-avatar-remove ${avatarUrl ? '' : 'disabled'}>\u79fb\u9664\u5934\u50cf</button>
            </div>
          </div>
        </div>
        <label class="settings-row editable">
          <span>
            <strong>显示名称（对外展示）</strong>
            <small>好友、组织和聊天中看到的名字，支持中文，也可以与其他人重复</small>
          </span>
          <input id="profile-display-name" value="${escapeAttr(displayName)}" maxlength="80" autocomplete="name" lang="zh-CN" placeholder="例如：张三" />
        </label>
        <label class="settings-row editable">
          <span>
            <strong>邮箱</strong>
            <small>注册邮箱用于登录和安全验证，不支持直接修改</small>
          </span>
          <input id="profile-email" value="${escapeAttr(email)}" readonly />
        </label>
        <label class="settings-row editable">
          <span>
            <strong>账号名（唯一 @ 标识）</strong>
            <small>用于登录、搜索和添加联系人；仅支持小写字母、数字和下划线，对外展示使用昵称</small>
          </span>
          <input id="profile-username" value="${escapeAttr(username)}" maxlength="32" pattern="[a-z0-9_]{1,32}" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="例如：janus_user" aria-label="账号名（唯一 @ 标识）" />
        </label>
        <div class="settings-row action-row">
          <span>
            <strong>保存个人资料</strong>
            <small>更新后会立即写入本地账号信息</small>
          </span>
          <button class="btn primary" type="submit">保存</button>
        </div>
      </form>

      <h3 class="settings-subsection-title account-section-anchor" id="account-section-security" data-account-section="security">安全</h3>
      <form id="password-form" class="settings-group-card settings-row-form">
        <label class="settings-row editable">
          <span>
            <strong>当前密码</strong>
            <small>验证当前登录密码</small>
          </span>
          <input id="current-password" type="password" autocomplete="current-password" />
        </label>
        <label class="settings-row editable">
          <span>
            <strong>新密码</strong>
            <small>至少 8 位，包含字母和数字</small>
          </span>
          <input id="new-password" type="password" autocomplete="new-password" placeholder="至少 8 位，包含字母和数字" />
        </label>
        <div class="settings-row editable password-change-code-row">
          <span>
            <strong>邮箱验证码</strong>
            <small>发送至 ${escapeHtml(email || '当前账号邮箱')}</small>
          </span>
          <div class="settings-inline-code">
            <input id="password-change-code" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码" maxlength="6" />
            <button class="btn secondary" id="send-password-change-code-btn" type="button"${passwordCodeAction.disabled ? ' disabled' : ''}>${passwordCodeAction.label}</button>
          </div>
        </div>
        <div class="settings-row action-row">
          <span>
            <strong>修改密码</strong>
            <small>下次登录时使用新密码</small>
          </span>
          <button class="btn secondary" type="submit">修改</button>
        </div>
      </form>
      ${state.emailCodeNotice?.purpose === 'password_change' ? renderEmailCodeNotice() : ''}

      <section class="settings-group-card account-section-anchor" id="account-section-sign-out" data-account-section="sign-out">
        <div class="settings-row action-row">
          <span>
            <strong>退出登录</strong>
            <small>仅退出当前设备，不会删除本地工作区数据</small>
          </span>
          <button class="btn secondary danger" id="logout-btn" type="button">退出登录</button>
        </div>
      </section>
    </section>
  `;
}

function renderEvolutionAndSyncSettings() {
  const isAdmin = state.currentUser?.role === 'admin';
  const cloudConfigured = Boolean(state.cloudSync?.configured);
  if (isAdmin && cloudConfigured && state.uploadCompliance === null && !state.uploadComplianceLoading && !state.uploadComplianceError) {
    setTimeout(() => viewDeps.loadUploadCompliance?.(), 0);
  }
  return `<section class="account-settings-panel account-modern-panel settings-evolution-sync-panel">
    ${renderEvolutionSettings()}
    ${isAdmin ? renderUploadComplianceSettings() : ''}
  </section>`;
}

function renderUploadComplianceSettings() {
  const response = state.uploadCompliance || {};
  const items = Array.isArray(response.items) ? response.items : [];
  const loading = Boolean(state.uploadComplianceLoading);
  const configured = Boolean(state.cloudSync?.configured);
  const error = configured ? (state.uploadComplianceError || '') : '';
  const statusLabel = !configured
    ? '\u672a\u914d\u7f6e Cloud Sync'
    : loading
      ? '\u6b63\u5728\u8bfb\u53d6'
      : items.length
        ? `${items.length} \u4e2a\u8d26\u53f7\u8bb0\u5f55`
        : '\u6682\u65e0\u5f02\u5e38\u8bb0\u5f55';
  return `
    <h3 class="settings-subsection-title upload-compliance-title">\u4e0a\u4f20\u5408\u89c4\u98ce\u63a7</h3>
    <section class="settings-group-card upload-compliance-card ${configured ? '' : 'is-unconfigured'}">
      <header class="upload-compliance-head">
        <span>
          <strong>\u62d2\u4f20\u68c0\u6d4b\u4e0e\u8d26\u53f7\u505c\u7528</strong>
          <small>\u4e91\u7aef\u8bb0\u5f55\u8fde\u7eed\u7a7a\u540c\u6b65\u548c\u957f\u671f\u65e0\u6709\u6548\u4e0a\u4f20\uff0c\u8fbe\u5230\u9608\u503c\u540e\u53ef\u81ea\u52a8\u505c\u7528\u8d26\u53f7\u3002</small>
        </span>
        <button class="btn secondary" type="button" data-upload-compliance-refresh ${loading || !configured ? 'disabled' : ''}>${loading ? '\u6b63\u5728\u5237\u65b0\u2026' : '\u5237\u65b0\u5217\u8868'}</button>
      </header>
      <div class="upload-compliance-summary">
        <span class="upload-compliance-status ${configured ? 'is-ready' : 'is-muted'}">
          <small>\u5f53\u524d\u72b6\u6001</small>
          <strong>${escapeHtml(statusLabel)}</strong>
        </span>
        <span>
          <small>\u68c0\u6d4b\u89c4\u5219</small>
          <strong>\u7a7a\u540c\u6b65 / \u957f\u671f\u65e0\u6709\u6548\u4e0a\u4f20</strong>
        </span>
      </div>
      ${!configured ? `<div class="upload-compliance-note">\u5f53\u524d\u672a\u914d\u7f6e\u4e91\u7aef\u540c\u6b65\uff0c\u56e0\u6b64\u65e0\u6cd5\u8bfb\u53d6\u98ce\u63a7\u5217\u8868\u3002\u5728 Cloud Sync \u914d\u7f6e\u597d serverUrl \u548c\u7ba1\u7406\u5458 token \u540e\uff0c\u8fd9\u91cc\u4f1a\u663e\u793a\u53ef\u7591\u6216\u5df2\u505c\u7528\u7684\u8d26\u53f7\u3002</div>` : ''}
      ${error ? `<div class="upload-compliance-error" role="alert">${escapeHtml(uploadComplianceFriendlyError(error))}</div>` : ''}
      ${renderUploadComplianceRows(items, loading, configured)}
    </section>`;
}

function renderUploadComplianceRows(items = [], loading = false, configured = true) {
  if (!configured) return '<div class="upload-compliance-empty">\u914d\u7f6e\u4e91\u7aef\u540c\u6b65\u540e\u53ef\u67e5\u770b\u4e0a\u4f20\u5408\u89c4\u8bb0\u5f55\u3002</div>';
  if (loading && !items.length) return '<div class="upload-compliance-empty">\u6b63\u5728\u8bfb\u53d6\u4e0a\u4f20\u5408\u89c4\u8bb0\u5f55\u2026</div>';
  if (!items.length) return '<div class="upload-compliance-empty">\u6682\u65e0\u9700\u5904\u7406\u7684\u4e0a\u4f20\u5408\u89c4\u8bb0\u5f55\u3002</div>';
  return `<div class="upload-compliance-list">${items.map(renderUploadComplianceRow).join('')}</div>`;
}

function renderUploadComplianceRow(item = {}) {
  const userId = item.user_id || item.userId || '';
  const name = item.display_name || item.displayName || item.username || item.email || userId;
  const accountStatus = item.account_status || item.accountStatus || 'active';
  const suspended = accountStatus === 'suspended';
  const busy = state.uploadComplianceBusyUserId === userId;
  const status = item.status || 'ok';
  const reason = item.reason || item.suspension_reason || '';
  const lastEffective = item.last_effective_sync_at || item.lastEffectiveSyncAt || '';
  return `
    <article class="upload-compliance-row">
      <span class="upload-compliance-account">
        <strong>${escapeHtml(name || userId || '\u672a\u77e5\u8d26\u53f7')}</strong>
        <small>${escapeHtml(userId || '')}${item.email ? ` \u00b7 ${escapeHtml(item.email)}` : ''}</small>
      </span>
      <span class="upload-compliance-meta">
        <small>\u98ce\u63a7</small>
        <strong>${escapeHtml(uploadComplianceStatusLabel(status))}${reason ? ` \u00b7 ${escapeHtml(reason)}` : ''}</strong>
      </span>
      <span class="upload-compliance-meta">
        <small>\u7a7a\u540c\u6b65</small>
        <strong>${Number(item.empty_batch_streak || item.emptyBatchStreak || 0)} \u6b21</strong>
      </span>
      <span class="upload-compliance-meta">
        <small>\u6700\u8fd1\u6709\u6548\u4e0a\u4f20</small>
        <strong>${lastEffective ? escapeHtml(formatDateTime(lastEffective)) : '\u5c1a\u65e0'}</strong>
      </span>
      <button class="mini-btn ${suspended ? '' : 'danger'}" type="button" data-upload-compliance-action="${suspended ? 'reactivate' : 'suspend'}" data-user-id="${escapeAttr(userId)}" ${busy || !userId ? 'disabled' : ''}>${busy ? '\u5904\u7406\u4e2d\u2026' : suspended ? '\u6062\u590d' : '\u505c\u7528'}</button>
    </article>`;
}

function uploadComplianceStatusLabel(value = '') {
  return ({ ok: '\u6b63\u5e38', watching: '\u89c2\u5bdf\u4e2d', suspicious: '\u53ef\u7591', suspended: '\u5df2\u505c\u7528' })[value] || value || '\u672a\u77e5';
}

function uploadComplianceFriendlyError(message = '') {
  const text = String(message || '');
  if (/not configured/i.test(text)) return '\u4e91\u7aef\u540c\u6b65\u5c1a\u672a\u914d\u7f6e\uff0c\u8bf7\u5148\u586b\u5199 Cloud Sync \u670d\u52a1\u5730\u5740\u548c\u7ba1\u7406\u5458 token\u3002';
  if (/unauthorized|401|403/i.test(text)) return '\u5f53\u524d Cloud Sync token \u6ca1\u6709\u7ba1\u7406\u5458\u6743\u9650\uff0c\u65e0\u6cd5\u8bfb\u53d6\u6216\u64cd\u4f5c\u98ce\u63a7\u5217\u8868\u3002';
  return text;
}

function renderEvolutionSettings() {
  const preference = state.evolutionPreference;
  const preferenceUnavailable = preference?.available === false;
  const updates = state.evolutionUpdates;
  const visibleFamilyIds = visibleTalentFamilyIds(state.employeeOverview);
  const personal = (Array.isArray(updates?.personal) ? updates.personal : [])
    .filter((item) => talentFamilyVisible(item.agentFamilyId, visibleFamilyIds));
  const market = (Array.isArray(updates?.market) ? updates.market : [])
    .filter((item) => talentFamilyVisible(item.agentFamilyId, visibleFamilyIds));
  const checkedAt = updates?.checkedAt || '';
  const error = state.evolutionPreferenceError || state.evolutionUpdatesError;
  return `
    <h3 class="settings-subsection-title">自进化与更新</h3>
    <section class="settings-group-card evolution-settings-card">
      <div class="settings-row action-row evolution-check-row">
        <span>
          <strong>个人 Agent 版本</strong>
          <small>${checkedAt ? `最近检查：${escapeHtml(formatDateTime(checkedAt))}` : '仅在你点击后检查云端；检查不会发起进化任务，也不会自动更新。'}</small>
        </span>
        <button class="btn secondary" type="button" data-evolution-updates-check ${state.evolutionUpdatesLoading || preference === null || preferenceUnavailable ? 'disabled' : ''}>${state.evolutionUpdatesLoading ? '正在检查…' : '检测云端更新'}</button>
      </div>
      ${error ? `<div class="evolution-settings-error" role="alert">${escapeHtml(error)}</div>` : ''}
      ${renderPersonalEvolutionUpdates(personal, updates)}
      ${renderMarketEvolutionUpdates(market, updates)}
      <div class="evolution-settings-footer">
        <span>候选版本需由你明确选择后才会下载并启用；历史稳定版本和基础 Skill 可随时回退。</span>
        <button class="btn secondary" type="button" data-personal-evolution-detail>查看进化记录与 Memory</button>
      </div>
    </section>
  `;
}

function renderMarketEvolutionUpdates(items = [], updates = null) {
  const availableCount = items.filter((item) => item.recruited).reduce((total, item) => total + Number(item.availableVersionCount || 0), 0);
  const viewOnlyCount = items.filter((item) => !item.recruited && Number(item.availableVersionCount || 0) > 0).length;
  return `
    <section class="market-evolution-settings">
      <header class="market-evolution-settings-head">
        <span>
          <strong>公司集群 Skill</strong>
          <small>云端按 Agent Family 聚合匿名证据并发布市场版本；你可以查看全部人才，并为已招募 Agent 选择 Skill。</small>
        </span>
        ${updates ? `<em>${availableCount ? `${availableCount} 个可选择版本` : '当前无待选择版本'}${viewOnlyCount ? ` · ${viewOnlyCount} 个未招募 Agent 可查看` : ''}</em>` : '<em>等待检查</em>'}
      </header>
      ${renderMarketEvolutionItems(items, updates)}
    </section>
  `;
}

function renderMarketEvolutionItems(items = [], updates = null) {
  if (state.evolutionUpdatesLoading && !updates) return '<div class="evolution-update-empty">正在读取公司集群 Skill 更新…</div>';
  if (!updates) return `<div class="evolution-update-empty">${escapeHtml(translateUiText('检测云端更新后，这里会列出人才市场中的全部 Agent Skill。', state.languageMode))}</div>`;
  if (!items.length) return '<div class="evolution-update-empty">人才市场暂时没有可查看的 Agent Skill。</div>';
  return `<div class="market-evolution-agent-list">${items.map(renderMarketEvolutionItem).join('')}</div>`;
}

function renderMarketEvolutionItem(item = {}) {
  const latest = item.latestVersion || null;
  const health = latest?.health || null;
  const status = marketUpdateStatusLabel(item.updateStatus);
  const availableCount = Number(item.availableVersionCount || 0);
  return `
    <article class="market-evolution-agent-card ${item.recruited ? 'is-recruited' : 'is-view-only'}">
      <header>
        <div>
          <strong>${escapeHtml(item.name || item.agentFamilyId || 'Agent')}</strong>
          <small>${escapeHtml(item.departmentId || '专业 Agent')} · ${escapeHtml(item.agentFamilyId || '')}</small>
        </div>
        <span class="market-update-status is-${escapeAttr(item.updateStatus || 'unknown')}">${escapeHtml(status)}</span>
      </header>
      <div class="market-evolution-summary">
        <span><small>招募状态</small><strong>${item.recruited ? '已招募' : '未招募'}</strong></span>
        <span><small>当前市场版本</small><strong>${escapeHtml(item.currentMarketVersionId ? shortPersonalVersionId(item.currentMarketVersionId) : '基础 Skill')}</strong></span>
        <span><small>已发布</small><strong>${Number(item.releasedVersionCount || 0)}</strong></span>
        <span><small>可选择</small><strong>${availableCount}</strong></span>
      </div>
      ${latest ? `<div class="market-evolution-latest"><span><strong>${escapeHtml(shortPersonalVersionId(latest.id || ''))}</strong><small>${escapeHtml(formatDateTime(latest.createdAt) || '时间未知')} · ${Number(latest.sectionCount || latest.sections?.length || 0)} 个 Skill 章节</small></span>${health ? `<em class="is-${escapeAttr(health.status || 'collecting')}">健康 ${escapeHtml(health.status || 'collecting')}</em>` : ''}</div>` : '<div class="market-evolution-latest"><span><strong>暂无发布版本</strong><small>云端集群仍在积累和评估证据。</small></span></div>'}
      <div class="market-evolution-actions">
        <span>${item.recruited ? '个人 Overlay 会继续保留，发生冲突时由你逐项选择。' : '可查看公开 Skill；招募该 Agent 后才能采用。'}</span>
        <button class="btn secondary" type="button" data-settings-market-family="${escapeAttr(item.agentFamilyId || '')}" data-agent-instance-id="${escapeAttr(item.agentInstanceId || '')}" data-family-name="${escapeAttr(item.name || item.agentFamilyId || '')}" data-recruited="${item.recruited ? 'true' : 'false'}" ${latest ? '' : 'disabled'}>${item.recruited ? '查看并选择 Skill' : '查看 Skill'}</button>
      </div>
    </article>
  `;
}

function marketUpdateStatusLabel(value = '') {
  return ({
    available: '可选择更新', current: '已是最新', view_only_available: '可查看', suspended: '版本已暂停',
    no_published_version: '暂无发布',
  })[value] || value || '等待检查';
}

function renderPersonalEvolutionUpdates(items = [], updates = null) {
  if (state.evolutionUpdatesLoading && !updates) {
    return '<div class="evolution-update-empty">正在读取云端个人版本…</div>';
  }
  if (!updates) {
    return `<div class="evolution-update-empty">${escapeHtml(translateUiText('尚未检查云端更新。点击“检测云端更新”后，可在这里选择下载版本或回退。', state.languageMode))}</div>`;
  }
  if (!items.length) {
    return '<div class="evolution-update-empty">当前账号没有可更新的个人 Agent。</div>';
  }
  return `<div class="personal-version-agent-list">${items.map(renderPersonalEvolutionUpdateItem).join('')}</div>`;
}

function renderPersonalEvolutionUpdateItem(item = {}) {
  const agentInstanceId = item.agentInstanceId || '';
  const expanded = state.personalEvolutionExpandedAgentIds.includes(agentInstanceId);
  const cached = state.personalEvolutionVersionsByAgent[agentInstanceId] || null;
  const setting = (state.userAgentSettings || []).find((entry) => entry.id === agentInstanceId) || {};
  const name = item.agentName || setting.family?.name || item.agentFamilyId || setting.agentFamilyId || 'Agent';
  const currentVersionId = item.currentVersionId || setting.activePersonalSkillVersionId || '';
  const latest = item.latestAvailableVersion || null;
  const availableCount = Number(item.availableCount || 0);
  const loading = state.personalEvolutionVersionLoadingId === agentInstanceId;
  return `
    <article class="personal-version-agent-card" data-personal-version-agent="${escapeAttr(agentInstanceId)}">
      <header>
        <div>
          <strong>${escapeHtml(name)}</strong>
          <code>${escapeHtml(item.agentFamilyId || setting.agentFamilyId || '')}</code>
        </div>
        <span class="personal-version-count ${availableCount ? 'has-update' : ''}">${availableCount ? `${availableCount} 个可用版本` : '暂无新版本'}</span>
      </header>
      <div class="personal-version-summary">
        <span>当前：${currentVersionId ? escapeHtml(shortPersonalVersionId(currentVersionId)) : '基础 Skill'}</span>
        ${latest ? `<span>最新候选：${escapeHtml(shortPersonalVersionId(latest.id || ''))} · ${escapeHtml(formatDateTime(latest.createdAt || latest.updatedAt) || '时间未知')}</span>` : '<span>云端没有等待选择的稳定候选。</span>'}
      </div>
      ${latest && !expanded ? `<div class="personal-version-quick-action">${renderPersonalVersionAction(latest, agentInstanceId, currentVersionId)}</div>` : ''}
      <button class="personal-version-expand" type="button" data-personal-version-expand="${escapeAttr(agentInstanceId)}" aria-expanded="${expanded ? 'true' : 'false'}">
        ${loading ? '正在加载版本…' : expanded ? '收起版本记录' : '查看全部版本与回退'}
      </button>
      ${expanded ? renderPersonalVersionHistory(agentInstanceId, cached, currentVersionId, loading) : ''}
    </article>
  `;
}

function renderPersonalVersionHistory(agentInstanceId, response, currentVersionId, loading) {
  if (loading && !response) return '<div class="personal-version-history"><div class="evolution-update-empty">正在加载完整版本记录…</div></div>';
  if (!response) return '<div class="personal-version-history"><div class="evolution-update-empty">版本记录尚未加载。</div></div>';
  const items = Array.isArray(response.items) ? response.items : [];
  return `
    <div class="personal-version-history">
      ${items.map((version) => renderPersonalVersionRow(version, agentInstanceId, currentVersionId)).join('')}
      ${renderBasePersonalVersionRow(agentInstanceId, currentVersionId)}
    </div>
  `;
}

function renderPersonalVersionRow(version = {}, agentInstanceId = '', currentVersionId = '') {
  const active = version.id === currentVersionId || version.status === 'active';
  const label = version.summary || version.name || `Skill ${shortPersonalVersionId(version.id || '')}`;
  const status = active ? '当前版本' : version.available || version.status === 'candidate' ? '等待选择' : version.status === 'archived' ? '历史稳定版' : version.status || '版本记录';
  return `
    <div class="personal-version-row ${active ? 'is-active' : ''}">
      <span>
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(formatDateTime(version.createdAt || version.updatedAt) || '时间未知')} · ${escapeHtml(status)}</small>
      </span>
      ${renderPersonalVersionAction(version, agentInstanceId, currentVersionId)}
    </div>
  `;
}

function renderBasePersonalVersionRow(agentInstanceId = '', currentVersionId = '') {
  const active = !currentVersionId;
  return `
    <div class="personal-version-row personal-version-base ${active ? 'is-active' : ''}">
      <span><strong>基础 Skill</strong><small>Agent 初始内置版本 · 不包含个人 Skill Overlay</small></span>
      ${active
        ? '<span class="personal-version-current">当前版本</span>'
        : `<button class="mini-btn" type="button" data-personal-version-rollback="${escapeAttr(agentInstanceId)}" data-target-version-id="" data-expected-active-version-id="${escapeAttr(currentVersionId)}" ${versionActionBusy(agentInstanceId, 'base') ? 'disabled' : ''}>${versionActionBusy(agentInstanceId, 'base') ? '正在恢复…' : '恢复基础 Skill'}</button>`}
    </div>
  `;
}

function renderPersonalVersionAction(version = {}, agentInstanceId = '', currentVersionId = '') {
  const versionId = version.id || '';
  const active = versionId === currentVersionId || version.status === 'active';
  if (active) return '<span class="personal-version-current">当前版本</span>';
  const stable = version.stabilityStatus === 'stable' || version.stability_status === 'stable';
  const candidate = stable && (version.available || version.status === 'candidate');
  const archived = stable && version.status === 'archived';
  if (candidate) {
    const busy = versionActionBusy(agentInstanceId, versionId, 'activate');
    return `<button class="mini-btn primary" type="button" data-personal-version-activate="${escapeAttr(agentInstanceId)}" data-version-id="${escapeAttr(versionId)}" data-expected-active-version-id="${escapeAttr(currentVersionId)}" ${busy ? 'disabled' : ''}>${busy ? '正在更新…' : '更新到此版本'}</button>`;
  }
  if (archived) {
    const busy = versionActionBusy(agentInstanceId, versionId, 'rollback');
    return `<button class="mini-btn" type="button" data-personal-version-rollback="${escapeAttr(agentInstanceId)}" data-target-version-id="${escapeAttr(versionId)}" data-expected-active-version-id="${escapeAttr(currentVersionId)}" ${busy ? 'disabled' : ''}>${busy ? '正在回退…' : '回退到此版本'}</button>`;
  }
  return `<span class="personal-version-state">${escapeHtml(version.status || '不可用')}</span>`;
}

function versionActionBusy(agentInstanceId = '', versionId = '', action = 'rollback') {
  return state.evolutionActionBusyKey === `${action}:${agentInstanceId}:${versionId || 'base'}`;
}

function shortPersonalVersionId(value = '') {
  const text = String(value || '');
  return text.length > 18 ? `${text.slice(0, 15)}…` : text || '未知版本';
}

function renderModelServiceSettings() {
  const config = state.codexConfig || {};
  const localize = (value) => translateUiText(value, state.languageMode);
  const embeddedReady = config.configurationMode === 'embedded-with-user-override';
  const customActive = config.userProviderOverrideValidated === true;
  return `
    <h3 class="settings-subsection-title account-section-anchor" id="account-section-model-service" data-account-section="model-service">模型服务</h3>
    <div class="model-service-mode-bar ${embeddedReady ? 'is-ready' : ''}">
      <span><strong>${escapeHtml(localize(customActive ? '自定义 Provider' : embeddedReady ? '默认模型服务' : 'Janus 高级配置'))}</strong><small>${escapeHtml(localize(customActive
        ? '当前使用已通过连接测试的自定义 Provider，不受 Janus Token 限额。'
        : embeddedReady
          ? '当前使用 Janus 默认模型服务，Token 用量受软件额度限制。'
          : '直接编辑 Janus 使用的原始 config.toml 和 auth.json；配置仅保存在当前设备。'))}</small></span>
      <b class="model-service-mode-status">${escapeHtml(localize(customActive ? '已验证' : embeddedReady ? '默认服务' : '手动配置'))}</b>
    </div>
    ${renderDefaultModelUsageCard()}
    ${renderAdvancedModelServiceSettings(config)}
  `;
}

function renderDefaultModelUsageCard() {
  const usage = state.managedProviderUsage || {};
  const localize = (value) => translateUiText(value, state.languageMode);
  const used = Math.max(0, Number(usage.dailyTokensUsed) || 0);
  const managed = usage.managedProvider === true;
  const imageUsage = renderDefaultImageUsageMetric(usage, localize);
  if (!managed) {
    return `<section class="settings-group-card model-service-card default-model-usage-card is-unlimited">
      <div class="default-model-usage-metric default-model-token-usage">
        <div class="settings-row compact">
          <span><strong>${escapeHtml(localize('今日模型用量'))}</strong><small>${escapeHtml(localize('当前使用自定义模型服务，仅记录使用量，不设 Janus 每日额度。'))}</small></span>
          <span class="default-model-usage-value">${formatQuotaTokenCount(used)} tokens</span>
        </div>
      </div>
      ${imageUsage}
    </section>`;
  }
  const limit = Math.max(1, Number(usage.dailyTokenLimit) || 20_000_000);
  const remaining = Math.max(0, Number(usage.dailyTokensRemaining) || 0);
  const percent = quotaUsagePercent(used, limit);
  const percentLabel = formatQuotaPercent(percent);
  return `<section class="settings-group-card model-service-card default-model-usage-card ${usage.exhausted ? 'is-exhausted' : ''}">
    <div class="default-model-usage-metric default-model-token-usage">
      <div class="settings-row compact default-model-usage-head">
        <span><strong>${escapeHtml(localize('默认模型服务今日额度'))}</strong><small>${escapeHtml(localize('北京时间每日 00:00 恢复；输入与输出 Token 按每轮实际 usage 累加。'))}</small></span>
        <span class="default-model-usage-value">${formatQuotaTokenCount(used)} / ${formatQuotaTokenCount(limit)} tokens</span>
      </div>
      <div class="default-model-usage-progress" role="progressbar" aria-label="${escapeAttr(localize('默认模型服务今日额度'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i class="${percent > 0 ? 'has-usage' : ''}" style="width:${percent}%"></i></div>
      <div class="default-model-usage-foot"><span>${escapeHtml(localize(`剩余 ${formatQuotaTokenCount(remaining)} tokens`))}</span><span>${percentLabel}%</span></div>
    </div>
    ${imageUsage}
  </section>`;
}

function renderDefaultImageUsageMetric(usage = {}, localize = (value) => value) {
  const used = Math.max(0, Number(usage.dailyImagesUsed) || 0);
  const limited = usage.imageGenerationLimited === true
    || (usage.imageGenerationLimited == null && usage.managedProvider === true);
  const english = state.languageMode === 'en';
  if (!limited) {
    return `<div class="default-model-usage-metric default-model-image-usage is-unlimited">
      <div class="settings-row compact default-model-usage-head">
        <span><strong>${escapeHtml(localize('今日图片生成用量'))}</strong><small>${escapeHtml(localize('当前使用自定义图片服务，仅按当前 Provider 记录用量，不设 Janus 每日额度。'))}</small></span>
        <span class="default-model-usage-value">${used} ${english ? 'images · Unlimited' : '张 · 不限额'}</span>
      </div>
    </div>`;
  }
  const limit = Math.max(1, Number(usage.dailyImageLimit) || 5);
  const remaining = Math.max(0, Number(usage.dailyImagesRemaining) || Math.max(0, limit - used));
  const percent = quotaUsagePercent(used, limit);
  const percentLabel = formatQuotaPercent(percent);
  return `<div class="default-model-usage-metric default-model-image-usage ${usage.imageGenerationExhausted ? 'is-exhausted' : ''}">
    <div class="settings-row compact default-model-usage-head">
      <span><strong>${escapeHtml(localize('今日图片生成额度'))}</strong><small>${escapeHtml(localize('生成、编辑、私人助理与 PPT 配图共享；北京时间每日 00:00 恢复。'))}</small></span>
      <span class="default-model-usage-value">${used} / ${limit} ${english ? 'images' : '张'}</span>
    </div>
    <div class="default-model-usage-progress" role="progressbar" aria-label="${escapeAttr(localize('今日图片生成额度'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i class="${percent > 0 ? 'has-usage' : ''}" style="width:${percent}%"></i></div>
    <div class="default-model-usage-foot"><span>${english ? `${remaining} remaining` : `剩余 ${remaining} 张`}</span><span>${percentLabel}%</span></div>
  </div>`;
}

function formatQuotaTokenCount(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('zh-CN');
}

function renderProviderKeyApplication() {
  const user = state.currentUser || {};
  const draft = state.providerKeyApplicationDraft || {};
  const result = state.providerKeyApplicationResult;
  const access = state.providerKeyAccess || { own: [], review: [], distributionReady: false };
  const application = Array.isArray(access.own) ? access.own[0] || null : null;
  const activeApplication = application && ['pending', 'approved', 'claimed'].includes(application.status);
  const verified = Boolean(user.email && user.emailVerified);
  const cloudAccount = Boolean(user.remoteBound);
  const canSubmit = verified && cloudAccount && !state.providerKeyApplicationBusy && !activeApplication;
  const applicantPanel = activeApplication ? `
    <section id="provider-key-application-status" class="settings-group-card model-service-card provider-key-application-form">
      <div class="settings-row compact">
        <span>
          <strong>Janus Provider Key 申请</strong>
          <small>${escapeHtml(application.organization)} · ${escapeHtml(application.accountEmail || user.email || '')}</small>
        </span>
        <span class="verify-badge ${['approved', 'claimed'].includes(application.status) ? 'verified' : ''}">${escapeHtml(providerKeyApplicationStatusLabel(application.status))}</span>
      </div>
      <div class="settings-row compact">
        <span><strong>审核状态</strong><small>${escapeHtml(application.decisionNote || providerKeyApplicationStatusDescription(application.status))}</small></span>
        <button class="mini-btn" data-provider-key-refresh type="button" ${state.providerKeyAccessBusy ? 'disabled' : ''}>刷新状态</button>
      </div>
      ${application.status === 'approved' ? `
        <div class="settings-row action-row model-service-action">
          <span><strong>领取共享内测 Key</strong><small>领取后由 Janus 主进程自动写入 config.toml 和 auth.json，可在下方高级编辑器中查看和修改。</small></span>
          <button class="btn primary" data-provider-key-claim="${escapeAttr(application.id)}" type="button" ${state.providerKeyClaimBusy ? 'disabled' : ''}>${state.providerKeyClaimBusy ? '正在领取…' : '领取并写入配置'}</button>
        </div>` : ''}
      ${application.status === 'claimed' ? `
        <div class="settings-row compact">
          <span><strong>配置已写入</strong><small>你仍可在下方高级配置中检查或修改 Provider 设置。</small></span>
          <span class="verify-badge verified">已领取</span>
        </div>` : ''}
      ${result?.message ? `
        <div class="settings-row compact"><span><strong class="model-service-status ${escapeAttr(result.status || '')}">${escapeHtml(result.title || '')}</strong><small>${escapeHtml(result.message)}</small></span></div>` : ''}
    </section>` : `
    <form id="provider-key-application-form" class="settings-group-card model-service-card provider-key-application-form">
      <div class="settings-row compact">
        <span>
          <strong>申请 Janus Provider Key</strong>
          <small>使用已验证账号邮箱提交机构申请。管理员批准后，可在这里一键领取当前共享内测 Key。</small>
        </span>
        <span class="verify-badge ${verified && cloudAccount ? 'verified' : ''}">${verified && cloudAccount ? '邮箱已验证' : '需要云端验证邮箱'}</span>
      </div>
      <div class="settings-row compact">
        <span><strong>申请邮箱</strong><small>申请结果发送到当前账号邮箱</small></span>
        <span>${escapeHtml(user.email || '-')}</span>
      </div>
      ${!verified ? `
        <div class="settings-row editable">
          <span><strong>验证申请邮箱</strong><small>获取验证码并在当前页面完成验证后即可提交申请</small></span>
          <div class="settings-inline-code">
            <input id="provider-key-email-code" value="${escapeAttr(state.providerKeyEmailCode || '')}" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码" maxlength="6" />
            <button class="btn secondary" id="send-provider-key-email-code-btn" type="button" ${cloudAccount && user.email && !state.providerKeyEmailVerificationBusy ? '' : 'disabled'}>获取验证码</button>
            <button class="btn secondary" id="verify-provider-key-email-btn" type="button" ${cloudAccount && user.email && !state.providerKeyEmailVerificationBusy ? '' : 'disabled'}>完成验证</button>
          </div>
        </div>` : ''}
      <label class="settings-row editable">
        <span><strong>机构名称</strong><small>填写公司、学校、实验室或团队全称</small></span>
        <input id="provider-key-organization" value="${escapeAttr(draft.organization || '')}" maxlength="120" placeholder="例如：Janus Research Lab" required />
      </label>
      <label class="settings-row editable model-config-editor-row">
        <span><strong>申请用途</strong><small>简要说明预计用户数、使用场景和所需模型</small></span>
        <textarea class="config-code-input" id="provider-key-usage" rows="4" maxlength="2000" placeholder="例如：10 人研发团队内部测试，用于本地代码 Agent。">${escapeHtml(draft.usage || '')}</textarea>
      </label>
      ${result?.message ? `
        <div class="settings-row compact">
          <span><strong class="model-service-status ${escapeAttr(result.status || '')}">${escapeHtml(result.title || '')}</strong><small>${escapeHtml(result.message)}</small></span>
        </div>` : ''}
      <div class="settings-row action-row model-service-action">
        <span><strong>发放方式</strong><small>管理员批准后，回到本页点击领取；暂不限制模型、额度或有效期。</small></span>
        <button class="btn secondary" type="submit" ${canSubmit ? '' : 'disabled'}>${state.providerKeyApplicationBusy ? '正在提交…' : '提交机构申请'}</button>
      </div>
    </form>
  `;
  return `${applicantPanel}${user.role === 'admin' ? renderProviderKeyReview(access) : ''}`;
}

function providerKeyApplicationStatusLabel(status = '') {
  return ({ pending: '审核中', approved: '已批准待领取', claimed: '已领取', rejected: '未通过', revoked: '已停止再次领取' })[status] || status || '未知';
}

function providerKeyApplicationStatusDescription(status = '') {
  return ({
    pending: '申请已记录，等待云端管理员审核。',
    approved: '申请已批准，可以领取并自动写入本机配置。',
    claimed: '共享内测 Key 已写入当前设备。',
    rejected: '申请未通过，可以根据审核意见重新提交。',
    revoked: '再次领取资格已停止；如果此前已领取，旧 Key 仍需通过共享 Key 轮换才能真正失效。',
  })[status] || '请刷新申请状态。';
}

function renderProviderKeyReview(access = {}) {
  const applications = Array.isArray(access.review) ? access.review.slice(0, 50) : [];
  return `
    <section class="settings-group-card model-service-card provider-key-review-card">
      <div class="settings-row compact">
        <span><strong>Provider Key 申请审核</strong><small>当前使用一个共享内测 Key；批准只控制领取资格，不限制模型和额度。</small></span>
        <div class="settings-inline-code">
          <span class="verify-badge ${access.distributionReady ? 'verified' : ''}">${access.distributionReady ? '共享 Key 已配置' : '共享 Key 未配置'}</span>
          <button class="mini-btn" data-provider-key-refresh type="button" ${state.providerKeyAccessBusy ? 'disabled' : ''}>刷新</button>
        </div>
      </div>
      ${applications.length ? applications.map((application) => `
        <article class="settings-row provider-key-review-item" data-provider-key-review-id="${escapeAttr(application.id)}">
          <span>
            <strong>${escapeHtml(application.organization)} · ${escapeHtml(application.accountEmail)}</strong>
            <small>${escapeHtml(application.usage || '未填写用途')} · ${escapeHtml(providerKeyApplicationStatusLabel(application.status))}</small>
          </span>
          <div class="settings-inline-code">
            <input data-provider-key-review-note="${escapeAttr(application.id)}" value="${escapeAttr(application.decisionNote || '')}" maxlength="2000" placeholder="审核备注（可选）" />
            ${application.status === 'pending' ? `
              <button class="btn primary" data-provider-key-decision="approve" data-application-id="${escapeAttr(application.id)}" type="button" ${state.providerKeyDecisionBusyId ? 'disabled' : ''}>批准</button>
              <button class="btn secondary" data-provider-key-decision="reject" data-application-id="${escapeAttr(application.id)}" type="button" ${state.providerKeyDecisionBusyId ? 'disabled' : ''}>拒绝</button>` : ''}
            ${application.status === 'claimed' ? `
              <button class="btn secondary" data-provider-key-decision="reissue" data-application-id="${escapeAttr(application.id)}" type="button" ${state.providerKeyDecisionBusyId ? 'disabled' : ''}>重新开放领取</button>` : ''}
            ${['approved', 'claimed'].includes(application.status) ? `
              <button class="btn secondary" data-provider-key-decision="revoke" data-application-id="${escapeAttr(application.id)}" type="button" ${state.providerKeyDecisionBusyId ? 'disabled' : ''}>停止再次领取</button>` : ''}
          </div>
        </article>`).join('') : '<div class="settings-row compact"><span><strong>暂无申请</strong><small>用户提交机构申请后会显示在这里。</small></span></div>'}
    </section>
  `;
}

function renderManagedModelServiceSettings() {
  const config = state.codexConfig || {};
  const configured = Boolean(config.hasApiKey);
  return `
    <h3 class="settings-subsection-title account-section-anchor" id="account-section-model-service" data-account-section="model-service">模型服务</h3>
    <section class="settings-group-card model-service-card managed-model-service-card">
      <div class="settings-row compact">
        <span>
          <strong>${configured ? '试用模型服务已就绪' : '试用模型服务暂不可用'}</strong>
          <small>${configured
            ? 'API Key、API 地址和高级配置由 Janus 管理，普通用户无需填写。'
            : '当前安装包没有可用的内置模型凭据，请联系管理员。'}</small>
        </span>
        <span class="verify-badge ${configured ? 'verified' : ''}">${configured ? '已配置' : '未配置'}</span>
      </div>
      <div class="settings-row compact">
        <span><strong>默认模型</strong><small>试用版使用安装包预设的模型配置</small></span>
        <span>${escapeHtml(config.model || '-')} · ${escapeHtml(config.reasoningEffort || 'medium')}</span>
      </div>
    </section>
    ${renderDefaultModelUsageCard()}
  `;
}

function renderSettingsCustomSelect(id, options, selectedValue, label, { className = '', icon = '', disabled = false } = {}) {
  const selected = options.find(([value]) => value === selectedValue) || options[0] || [selectedValue, selectedValue];
  const selectOptions = options
    .map(([value, optionLabel]) => `<option value="${escapeAttr(value)}" ${value === selected?.[0] ? 'selected' : ''}>${escapeHtml(optionLabel)}</option>`)
    .join('');
  const menuOptions = options
    .map(([value, optionLabel]) => `
      <button class="settings-select-option ${value === selected?.[0] ? 'selected' : ''}" type="button" role="option" aria-selected="${value === selected?.[0] ? 'true' : 'false'}" data-settings-select-option="${escapeAttr(id)}" data-value="${escapeAttr(value)}" ${disabled ? 'disabled' : ''}>
        ${icon ? `<i aria-hidden="true">${iconSvg(icon)}</i>` : ''}<span>${escapeHtml(optionLabel)}</span>
      </button>
    `)
    .join('');
  return `
    <div class="settings-select ${escapeAttr(className)} ${disabled ? 'is-disabled' : ''}" data-settings-select="${escapeAttr(id)}">
      <select id="${escapeAttr(id)}" class="settings-native-select" aria-label="${escapeAttr(label)}" tabindex="-1" ${disabled ? 'disabled' : ''}>
        ${selectOptions}
      </select>
      <button class="settings-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" data-settings-select-trigger="${escapeAttr(id)}" ${disabled ? 'disabled' : ''}>
        ${icon ? `<i aria-hidden="true">${iconSvg(icon)}</i>` : ''}<span>${escapeHtml(selected?.[1] || selectedValue)}</span>
      </button>
      <div class="settings-select-menu" role="listbox" aria-label="${escapeAttr(label)}">
        ${menuOptions}
      </div>
    </div>
  `;
}

function renderQuickModelServiceSettings(config) {
  const modelOptions = [...textModelOptions(state.modelCatalog)];
  const configuredModel = config.model || 'gpt-5.6-sol';
  const selectedModel = modelOptions.some(([value]) => value === configuredModel)
    ? configuredModel
    : modelOptions[0]?.[0] || 'gpt-5.6-sol';
  const reasoningOptions = [...reasoningOptionsForModel(state.modelCatalog, selectedModel)];
  const configuredReasoning = config.reasoningEffort || 'medium';
  const selectedReasoning = reasoningOptions.some(([value]) => value === configuredReasoning)
    ? configuredReasoning
    : modelCatalogEntry(state.modelCatalog, selectedModel)?.defaultReasoningEffort || reasoningOptions[0]?.[0] || 'medium';
  const overrideEnabled = Boolean(config.adminProviderOverrideEnabled);
  const storedConfigured = Boolean(config.storedHasApiKey && config.storedBaseUrl);
  const connection = state.codexConnectionTest;
  const connectionTone = connection?.status || (config.hasApiKey ? 'configured' : 'missing');
  const connectionMessage = connection?.message
    || (config.credentialSource === 'embedded'
      ? '当前使用 Janus 默认模型服务；本机旧配置不会自动覆盖。'
      : config.credentialSource === 'development'
        ? '当前使用开发环境 Provider 配置。'
        : config.hasApiKey
          ? '当前使用管理员自定义 Provider。'
          : '尚未配置 API Key，配置后才能发起真实模型请求。');
  return `
    <form id="codex-config-form" class="settings-group-card settings-row-form model-service-card">
      ${renderAdminProviderMode(config)}
      <label class="settings-row editable">
        <span>
          <strong>API 地址</strong>
          <small>填写兼容 Responses API 的服务地址，通常以 /v1 结尾</small>
        </span>
        <input id="codex-base-url" type="url" value="${escapeAttr(config.storedBaseUrl || '')}" placeholder="https://api.example.com/v1" autocomplete="url" ${overrideEnabled ? 'required' : ''} />
      </label>
      <div class="settings-row editable">
        <span>
          <strong>API Key ${config.storedHasApiKey ? '<em class="model-key-badge">本机已保存</em>' : ''}</strong>
          <small>仅在启用管理员覆盖时使用，不会随对话数据上传到 Janus 云端</small>
        </span>
        <div class="model-secret-control">
          <input id="codex-api-key" type="password" value="" placeholder="${config.storedHasApiKey ? '留空以保留本机 Key' : '请输入 API Key'}" autocomplete="new-password" aria-label="API Key" ${(overrideEnabled && !config.storedHasApiKey) ? 'required' : ''} />
          <button class="mini-btn model-secret-toggle" id="toggle-codex-api-key-btn" type="button">显示</button>
        </div>
      </div>
      <div class="settings-row editable">
        <span>
          <strong>默认模型</strong>
          <small>新对话默认使用的文本模型</small>
        </span>
        ${renderSettingsCustomSelect('codex-model', modelOptions, selectedModel, '默认模型')}
      </div>
      <div class="settings-row editable">
        <span>
          <strong>推理强度</strong>
          <small>更高强度通常会增加响应时间和模型用量</small>
        </span>
        ${renderSettingsCustomSelect('codex-reasoning', reasoningOptions, selectedReasoning, '推理强度')}
      </div>
      <div class="settings-row action-row model-service-action">
        <span>
          <strong class="model-service-status ${escapeAttr(connectionTone)}">${escapeHtml(connection?.title || (storedConfigured || config.hasApiKey ? '等待连接测试' : '需要配置'))}</strong>
          <small>${escapeHtml(connectionMessage)}</small>
        </span>
        <button class="btn primary" type="submit" ${state.busy ? 'disabled' : ''}>保存并测试</button>
      </div>
    </form>
  `;
}

function renderAdvancedModelServiceSettings(config) {
  const files = state.codexConfigFiles;
  if (!files) {
    return `
      <section class="settings-group-card model-service-card">
        <div class="settings-row compact">
          <span><strong>正在读取高级配置</strong><small>配置文件仅在你打开高级模式后读取。</small></span>
        </div>
      </section>
    `;
  }
  const connection = state.codexConnectionTest;
  const connectionTone = connection?.status || (config.hasApiKey ? 'configured' : 'missing');
  const localize = (value) => translateUiText(value, state.languageMode);
  const customActive = config.userProviderOverrideValidated === true;
  const expanded = state.advancedModelServiceOpen == null ? customActive : Boolean(state.advancedModelServiceOpen);
  return `
    <details class="settings-group-card model-service-card advanced-model-service-disclosure" data-advanced-model-service-disclosure ${expanded ? 'open' : ''}>
      <summary class="advanced-model-service-summary">
        <span><strong>${escapeHtml(localize(customActive ? '自定义模型服务已启用' : '自定义 Provider 配置'))}</strong><small>${escapeHtml(localize(customActive
          ? '当前自定义配置已经通过连接测试；展开后可以检查或修改。'
          : '仅在使用自己的模型服务时展开；保存并通过连接测试后生效。'))}</small></span>
        <b>${escapeHtml(localize(customActive ? '已验证' : '可选'))}</b>
      </summary>
      <form id="codex-file-config-form" class="advanced-model-service-form">
      <div class="settings-row model-config-notice-row">
        <span>
          <strong>${config.userProviderOverrideValidated ? '当前使用自定义模型服务' : '自定义 Provider'}</strong>
          <small>${config.userProviderOverrideValidated
            ? '当前 config.toml 与 auth.json 已通过连接测试。任一文件再次变化后需重新保存并测试。'
            : '如需使用自己的模型服务，请在下方填写 config.toml 和 auth.json；保存并测试通过后生效。自定义 Provider 不受 Janus Token 限额。'}</small>
        </span>
      </div>
      <div class="settings-row model-config-editor-row">
        <div class="code-field">
          <div class="code-field-head">
            <span>config.toml</span>
            <button class="mini-btn" id="reload-codex-files-btn" type="button">重新读取</button>
          </div>
          <textarea class="config-code-input" id="codex-config-toml" rows="17" spellcheck="false" aria-label="config.toml">${escapeHtml(files.configToml || '')}</textarea>
        </div>
      </div>
      <div class="settings-row model-config-editor-row">
        <div class="code-field">
          <div class="code-field-head">
            <span>auth.json</span>
            <button class="mini-btn" id="format-auth-json-btn" type="button">${escapeHtml(translateUiText('格式化 JSON', state.languageMode))}</button>
          </div>
          <textarea class="config-code-input auth-json-input" id="codex-auth-json" rows="7" spellcheck="false" aria-label="auth.json">${escapeHtml(files.authJson || '')}</textarea>
        </div>
      </div>
      <div class="settings-row action-row model-service-action">
        <span>
          <strong class="model-service-status ${escapeAttr(connectionTone)}">${escapeHtml(connection?.title || `当前 Provider：${config.providerName || '未匹配'}`)}</strong>
          <small>${escapeHtml(connection?.message || (config.userProviderOverrideValidated
            ? `模型：${config.model || '-'} · 认证变量：${config.authEnvKey || 'OPENAI_API_KEY'} · API 地址：${config.baseUrl || '-'}`
            : `当前使用默认模型服务；config.toml 和 auth.json ${files.configToml?.trim() || files.authJson?.trim() ? '尚未通过测试' : '暂未配置'}。`))}</small>
        </span>
        <button class="btn primary" type="submit" ${state.busy ? 'disabled' : ''}>保存高级配置并测试</button>
      </div>
      </form>
    </details>
  `;
}

function renderAdminProviderMode(config = {}) {
  const enabled = Boolean(config.adminProviderOverrideEnabled);
  const source = String(config.credentialSource || 'missing');
  const description = enabled
    ? config.adminProviderOverrideUsable
      ? '已启用：当前使用本机自定义模型服务。'
      : '已启用但本机凭据不完整；保存前必须补齐 URL 和 Key。'
    : source === 'embedded'
      ? '当前使用 Janus 默认模型服务；历史 auth.json 不会自动覆盖。'
      : source === 'development'
        ? '当前使用开发环境凭据；本机配置暂不生效。'
        : source === 'stored'
          ? '当前使用本机配置的模型服务。'
          : '当前没有可用的模型凭据。';
  return `
    <label class="settings-row editable admin-provider-mode-row">
      <span><strong>管理员自定义 Provider</strong><small>${escapeHtml(description)}</small></span>
      <input id="codex-admin-provider-override" type="checkbox" ${enabled ? 'checked' : ''} />
    </label>
  `;
}

function renderDeviceUpdates() {
  const appUpdate = state.updates || {};
  const agentUpdate = state.agentUpdates || {};
  const candidate = agentUpdate.candidate?.artifact || {};
  const current = agentUpdate.current || {};
  const currentVersion = newerVersion(current.releaseVersion, state.appVersion || '0.1.0');
  const candidateVersion = agentUpdate.available || agentUpdate.downloaded || agentUpdate.candidate?.incompatible
    ? candidate.releaseVersion || agentUpdate.candidate?.manifest?.version || ''
    : '';
  const checkingUpdates = Boolean(appUpdate.checking || agentUpdate.checking);
  const updateTone = combinedUpdateTone(appUpdate, agentUpdate);
  const updateError = String(appUpdate.lastError || agentUpdate.lastError || '').slice(0, 240);
  const updateAction = appUpdate.downloaded && !appUpdate.installing
    ? `<button class="btn primary" id="install-update-btn" type="button" ${state.busy ? 'disabled' : ''}>安装并重启</button>`
    : appUpdate.available && !appUpdate.downloading && !appUpdate.installing
      ? `<button class="btn primary" id="download-update-btn" type="button" ${state.busy ? 'disabled' : ''}>下载最新版本</button>`
      : '';
  const latestCheckAt = latestUpdateCheckAt(appUpdate.lastCheckAt, agentUpdate.lastCheckAt);
  const announcedVersion = appUpdate.version || currentVersion;
  const announcement = releaseAnnouncementForVersion(announcedVersion);
  return `
    <h3 class="settings-subsection-title account-section-anchor" id="update-center" data-account-section="updates">更新中心</h3>
    <section class="settings-group-card update-center-card">
      <div class="settings-row action-row update-center-head">
        <span>
          <strong>Janus 最新版本</strong>
          <small>一次检查软件与 Agent 实验室；软件下载和安装重启分开进行，安装前会再次确认。</small>
        </span>
        <div class="control-row compact">
          <button class="btn secondary" type="button" data-update-changelog-open="${escapeAttr(announcedVersion)}">查看更新日志</button>
          <button class="btn secondary" id="check-all-updates-btn" type="button" ${state.busy ? 'disabled' : ''}>${checkingUpdates ? '正在检查…' : '检查最新版本'}</button>
          ${updateAction}
        </div>
      </div>
      <div class="update-center-body">
        <div class="update-center-status-line">
          <span class="update-state-pill ${escapeAttr(updateTone)}">${escapeHtml(combinedUpdateLabel(appUpdate, agentUpdate))}</span>
          <strong data-update-status-message>${escapeHtml(combinedUpdateMessage(appUpdate, agentUpdate))}</strong>
        </div>
        <small>软件与 Agent 实验室共用统一版本序列；实验室更新会在后台自动校验并应用。</small>
        <small>当前版本：${escapeHtml(currentVersion)} · 最近检查：${escapeHtml(formatDateTime(latestCheckAt))}${appUpdate.version ? ` · 软件包 ${escapeHtml(appUpdate.version)}` : ''}${candidateVersion ? ` · 可用版本 ${escapeHtml(candidateVersion)}` : ''}</small>
        ${updateError ? `<small class="update-error-detail">失败详情：${escapeHtml(updateError)}</small>` : ''}
      </div>
      <label class="settings-row editable update-announcement-preference">
        <span><strong>自动显示更新公告</strong><small>关闭后仍会检查更新，并在更新中心显示；只是不再主动弹窗。</small></span>
        <input id="update-announcement-auto-popup" type="checkbox" data-update-announcement-auto-popup ${state.updateAnnouncementAutoPopup ? 'checked' : ''} />
      </label>
      ${announcement ? `<div class="permission-note update-release-preview"><strong>${escapeHtml(`版本 ${announcement.version} · ${announcement.title}`)}</strong><span>${escapeHtml(announcement.summary)}</span><button type="button" data-update-changelog-open="${escapeAttr(announcement.version)}">查看详细内容</button></div>` : ''}
      ${agentUpdate.candidate?.manifest?.changeSummary && (agentUpdate.available || agentUpdate.downloading || agentUpdate.applying) ? `<div class="permission-note update-change-summary"><strong>Janus 更新摘要</strong><span>${escapeHtml(agentUpdate.candidate.manifest.changeSummary)}</span></div>` : ''}
    </section>
  `;
}

function combinedUpdateTone(appUpdate = {}, agentUpdate = {}) {
  if (appUpdate.checking || agentUpdate.checking || appUpdate.downloading || appUpdate.installing || agentUpdate.downloading || agentUpdate.applying) return 'working';
  if (appUpdate.downloaded || agentUpdate.downloaded) return 'ready';
  if (appUpdate.available || agentUpdate.available) return 'available';
  if (appUpdate.lastError || agentUpdate.lastError) return 'error';
  return 'current';
}

function combinedUpdateLabel(appUpdate = {}, agentUpdate = {}) {
  if (appUpdate.checking || agentUpdate.checking) return '检查中';
  if (appUpdate.downloading || agentUpdate.downloading) return '下载中';
  if (appUpdate.installing) return '安装中';
  if (agentUpdate.applying) return '应用中';
  if (appUpdate.downloaded || agentUpdate.downloaded) return '已就绪';
  if (appUpdate.available || agentUpdate.available) return '可更新';
  if (agentUpdate.failureStage === 'download') return '下载失败';
  if (agentUpdate.failureStage === 'apply') return '应用失败';
  if (agentUpdate.failureStage === 'rollback') return '回滚失败';
  if (appUpdate.lastError || agentUpdate.lastError) return '检查失败';
  if (appUpdate.enabled === false && agentUpdate.enabled === false) return '已停用';
  if (!appUpdate.lastCheckAt && !agentUpdate.lastCheckAt) return '待检查';
  return '已是最新';
}

export function combinedUpdateMessage(appUpdate = {}, agentUpdate = {}) {
  if (appUpdate.checking || agentUpdate.checking) return '正在检查最新版本…';
  if (appUpdate.downloading) return `正在下载最新软件${Number.isFinite(appUpdate.downloadProgress) ? `，进度 ${appUpdate.downloadProgress}%` : ''}；下载期间仍可继续使用。`;
  if (appUpdate.installing) return '正在启动安装，Janus 即将关闭并在完成后重启。';
  if (agentUpdate.downloading) return '正在后台下载并校验 Janus 更新。';
  if (agentUpdate.applying) return '正在后台应用 Janus 更新。';
  if (appUpdate.downloaded) return `最新软件${appUpdate.version ? ` ${appUpdate.version}` : ''}已下载，可以安装。`;
  if (appUpdate.available) {
    const version = appUpdate.version ? ` ${appUpdate.version}` : '';
    if (state.languageMode === 'en') {
      return agentUpdate.lastError
        ? `A newer software version${version} is available. You can update the app first; Agent Lab is temporarily unavailable.`
        : `A newer software version${version} is available. Please update the app first.`;
    }
    return agentUpdate.lastError
      ? `发现最新软件${version}，可先完成软件升级；Agent 实验室暂时不可用。`
      : `发现最新软件${version}，请先完成软件升级。`;
  }
  if (agentUpdate.downloaded) return 'Janus 更新已下载并通过校验，正在自动应用。';
  if (agentUpdate.candidate?.incompatible) return '发现 Janus 更新，需要先升级桌面程序。';
  if (agentUpdate.available) {
    const version = agentUpdate.candidate?.artifact?.releaseVersion || agentUpdate.candidate?.manifest?.version || '';
    if (agentUpdate.failureStage === 'download') return `Janus 更新${version ? ` ${version}` : ''}下载失败，下次检查时会自动重试。`;
    return appUpdate.lastError
      ? `发现 Agent 实验室更新${version ? ` ${version}` : ''}，可先完成实验室升级；软件检查暂时不可用。`
      : `发现 Janus 更新${version ? ` ${version}` : ''}。`;
  }
  if (appUpdate.lastError && agentUpdate.lastError) return '暂时无法检查最新版本，请稍后重试。';
  if (appUpdate.lastError) return 'Janus 后台组件已完成检查，桌面程序版本暂时检查失败。';
  if (agentUpdate.failureStage === 'download') return 'Janus 后台更新下载失败，下次检查时会自动重试。';
  if (agentUpdate.failureStage === 'apply') return 'Janus 后台更新应用失败，原有版本已保留。';
  if (agentUpdate.lastError) return '桌面程序已完成检查，Janus 后台更新暂时不可用。';
  if (!appUpdate.lastCheckAt && !agentUpdate.lastCheckAt) return '尚未检查，启动后会自动检查最新版本。';
  return '当前已是最新版本。';
}

function latestUpdateCheckAt(...values) {
  return values
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || '';
}

function newerVersion(left = '', right = '') {
  const a = String(left || '0').split(/[.+-]/).map((part) => Number(part) || 0);
  const b = String(right || '0').split(/[.+-]/).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) === (b[index] || 0)) continue;
    return (a[index] || 0) > (b[index] || 0) ? left : right;
  }
  return left || right || '0.1.0';
}

function renderCodexConfigModeTabs() {
  return `
    <div class="config-mode-tabs" role="tablist">
      <button class="mode-pill ${state.codexConfigMode === 'fields' ? 'active' : ''}" type="button" data-codex-config-mode="fields">快捷配置</button>
      <button class="mode-pill ${state.codexConfigMode === 'files' ? 'active' : ''}" type="button" data-codex-config-mode="files">高级配置</button>
    </div>
  `;
}
