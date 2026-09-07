import { state } from '../state.js';
import { renderAccountAvatar } from '../utils/avatar.js';
import { iconSvg, navIcon } from '../ui/icons.js';
import { escapeAttr, escapeHtml, isInternalTaskRecord } from '../utils/format.js';
import { agentAvatarTone, agentInstanceDisplayNameForUi, employeeRouteEligibleForChat, renderAgentAvatarContent } from '../utils/agentIdentity.js';
import { uBuddyPendingTaskCount } from '../features/ubuddy/taskDisplayState.js';
import { agentRunNoticeCount, navigationMessageUnreadCount } from '../features/navigation/notificationState.js';
import { translateUiText } from '../i18n.js';

let viewDeps = {};

function setNavigationDeps(deps = {}) {
  viewDeps = { ...viewDeps, ...deps };
}

export function renderSidebar(deps = {}) {
  setNavigationDeps(deps);
  return renderSidebarView();
}

export function renderSettingsSidebar(deps = {}) {
  setNavigationDeps(deps);
  return renderSettingsSidebarView();
}

export function renderChatSearchModal(deps = {}) {
  setNavigationDeps(deps);
  return renderChatSearchModalView();
}

export function renderTopbar(deps = {}) {
  setNavigationDeps(deps);
  return renderTopbarView();
}

export function renderAgentPicker(deps = {}) {
  setNavigationDeps(deps);
  return renderAgentPickerView();
}

function pathBasename(...args) {
  return viewDeps.pathBasename?.(...args) || '';
}

function sessionIsArchived(...args) {
  return viewDeps.sessionIsArchived?.(...args) || false;
}

function compareSessionsForDisplay(...args) {
  return viewDeps.compareSessionsForDisplay?.(...args) || 0;
}

function agentsForDepartment(...args) {
  return viewDeps.agentsForDepartment?.(...args) || [];
}

function agentLabel(...args) {
  return viewDeps.agentLabel?.(...args) || '';
}

function shortAgentLabel(...args) {
  return viewDeps.shortAgentLabel?.(...args) || '';
}

function groupSessionsByMonth(...args) {
  return viewDeps.groupSessionsByMonth?.(...args) || [];
}

function filteredSessions(...args) {
  return viewDeps.filteredSessions?.(...args) || [];
}

function normalizeSearch(value) {
  return viewDeps.normalizeSearch?.(value) || String(value || '').trim().toLowerCase();
}

function sessionSubtitle(...args) {
  return viewDeps.sessionSubtitle?.(...args) || '';
}

function sessionIsPinned(...args) {
  return viewDeps.sessionIsPinned?.(...args) || false;
}

function renderSidebarView() {
  const user = state.currentUser;
  const rawDisplayName = user?.display_name || user?.displayName || '';
  const internalKeyDisplay = rawDisplayName && rawDisplayName === user?.id && /^(?:user|local|remote)_[a-z0-9_-]+$/i.test(rawDisplayName);
  const safeUsername = user?.username && user.username !== user?.id ? user.username : '';
  const safeEmailLabel = user?.email && !/@cloud\.janus\.local$/i.test(user.email) ? String(user.email).split('@')[0] : '';
  const displayName = internalKeyDisplay
    ? safeUsername || safeEmailLabel || '账户'
    : rawDisplayName || safeUsername || user?.email || '设置';
  const displayUser = user ? { ...user, display_name: displayName, displayName } : user;
  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="sidebar-profile-area ${state.accountMenuOpen ? 'is-account-open' : ''}">
          ${renderAccountMenu(displayUser)}
          ${renderSidebarAccountButton(displayUser, displayName)}
        </div>
        <div class="brand-actions">
          <button class="icon-btn" id="collapse-sidebar-btn" title="收起侧栏" type="button">${iconSvg('sidebar')}</button>
        </div>
      </div>
      <div class="sidebar-nav-stack">
        <nav class="sidebar-actions sidebar-primary-actions app-primary-nav" aria-label="应用导航" data-app-navigation>
          ${networkButton('messages', `${navIcon('message')}<span>消息</span>`)}
          ${networkButton('friends', `${navIcon('users')}<span>通讯录</span>`)}
          ${tabButton('employees', `${navIcon('spark')}<span>人才市场</span>`)}
          ${tabButton('plugins', `${navIcon('plugin')}<span>插件与技能</span>`)}
          ${tabButton('janus-app', `${navIcon('smartphone')}<span>Janus App</span>`)}
        </nav>
      </div>
      ${renderSidebarHistory()}
      <div class="sidebar-account-divider" aria-hidden="true"></div>
      <div class="account-area ${state.accountMenuWorkspaceOpen ? 'is-workspace-open' : ''}">
        ${renderAccountWorkspaceMenu()}
        ${renderAccountWorkspaceDock()}
      </div>
    </aside>
    ${state.currentTab === 'chat' && state.networkPanelOpen && state.networkPanelView === 'messages' && state.messageGroupSidebarOpen ? renderMessageGroupSidebar() : ''}
  `;
}

function renderMessageGroupSidebar() {
  const filter = state.networkMessageListFilter || 'all';
  const primaryItems = [
    ['all', 'message', '消息'],
    ['unread', 'clock', '未读'],
    ['pinned', 'pin', '标记'],
    ['mentions', 'users', '@我'],
  ];
  const typeItems = [
    ['direct', 'users', '单聊'],
    ['group', 'network', '群聊'],
    ['agent', 'spark', 'Agent'],
    ['task', 'tasks', '工作群'],
    ['archived', 'archive', '已归档'],
    ['completed', 'check', '已完成'],
  ];
  const renderFilter = ([id, icon, label]) => `<button class="message-group-nav-item ${filter === id ? 'active' : ''}" type="button" data-message-filter="${escapeAttr(id)}" aria-pressed="${filter === id ? 'true' : 'false'}">
    <span>${iconSvg(icon)}</span><strong>${escapeHtml(label)}</strong>
  </button>`;
  return `<aside class="sidebar message-group-sidebar" aria-label="消息分组">
    <header class="message-group-sidebar-head">
      <button class="message-group-collapse" type="button" data-message-groups-toggle title="返回主导航" aria-label="返回主导航">${iconSvg('menu')}${iconSvg('chevronLeft')}</button>
      <h2>分组</h2>
      <button class="message-group-settings" type="button" data-message-group-settings title="打开设置" aria-label="打开设置">${iconSvg('settings')}</button>
    </header>
    <nav class="message-group-nav" aria-label="消息筛选">
      ${primaryItems.map(renderFilter).join('')}
      <div class="message-group-nav-label">类型</div>
      ${typeItems.map(renderFilter).join('')}
    </nav>
  </aside>`;
}

export function activeSidebarMode() {
  return state.sidebarMode || 'root';
}

function renderProjectAccordionSection() {
  const open = Boolean(state.sidebarSectionsOpen?.projects);
  const projects = visibleProjects();
  const menuOpen = state.projectMenuOpenId === 'project-root';
  return `
    <section class="sidebar-accordion-section ${open ? 'open' : ''}">
      <div class="sidebar-section-row ${menuOpen ? 'menu-open' : ''}">
        <button class="sidebar-section-main" type="button" data-sidebar-section="projects" aria-expanded="${open ? 'true' : 'false'}">
          <span>${iconSvg('folder')}</span>
          <strong>项目</strong>
          <em>${iconSvg(open ? 'chevronDown' : 'chevronRight')}</em>
        </button>
        <button class="sidebar-section-more" type="button" data-project-menu="project-root" data-project-menu-kind="project-root" title="项目操作" aria-label="项目操作" aria-expanded="${menuOpen ? 'true' : 'false'}">
          ${iconSvg('more')}
        </button>
        ${menuOpen ? renderProjectMenu('project-root', 'project-root') : ''}
      </div>
      ${open ? `<div class="sidebar-accordion-body sidebar-project-list">
        ${projects.map(renderProjectAccordionRow).join('') || '<div class="empty">暂无项目</div>'}
      </div>` : ''}
    </section>
  `;
}

function renderProjectAccordionRow(project) {
  const projectId = project.id || '';
  const expanded = isProjectExpanded(projectId);
  const menuOpen = state.projectMenuOpenId === projectId;
  const sessions = projectSessions(projectId).slice(0, 60);
  return `
    <div class="sidebar-project-group ${expanded ? 'expanded' : ''}">
      <div class="sidebar-project-row ${state.activeProjectId === projectId ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}">
        <button class="sidebar-project-main project-leaf-main" type="button" data-toggle-project="${escapeAttr(projectId)}" title="${escapeAttr(project.workspaceRoot || project.workspace_root || '')}" aria-expanded="${expanded ? 'true' : 'false'}">
          <span>${iconSvg('folder')}</span>
          <strong>${escapeHtml(projectName(project))}</strong>
          <em>${iconSvg(expanded ? 'chevronDown' : 'chevronRight')}</em>
        </button>
        <button class="sidebar-project-more" type="button" data-project-menu="${escapeAttr(projectId)}" data-project-menu-kind="project" title="项目操作" aria-label="项目操作" aria-expanded="${menuOpen ? 'true' : 'false'}">
          ${iconSvg('more')}
        </button>
        <button class="sidebar-project-create" type="button" data-new-project-chat="${escapeAttr(projectId)}" title="新的项目对话" aria-label="新的项目对话">
          ${iconSvg('edit')}
        </button>
        ${menuOpen ? renderProjectMenu('project', projectId) : ''}
      </div>
      ${expanded ? `<div class="side-list sidebar-session-list project-session-list">
        ${sessions.map((session) => renderSessionItem(session)).join('') || '<div class="empty">暂无会话</div>'}
      </div>` : ''}
    </div>
  `;
}

function renderChatAccordionSection() {
  const open = Boolean(state.sidebarSectionsOpen?.chats);
  const sessions = normalSidebarSessions().slice(0, 80);
  const menuOpen = state.projectMenuOpenId === 'chat-root';
  return `
    <section class="sidebar-accordion-section ${open ? 'open' : ''}">
      <div class="sidebar-section-row ${menuOpen ? 'menu-open' : ''}">
        <button class="sidebar-section-main" type="button" data-sidebar-section="chats" aria-expanded="${open ? 'true' : 'false'}">
          <span>${iconSvg('message')}</span>
          <strong>对话</strong>
          <em>${iconSvg(open ? 'chevronDown' : 'chevronRight')}</em>
        </button>
        <button class="sidebar-section-more" type="button" data-project-menu="chat-root" data-project-menu-kind="chat-root" title="对话操作" aria-label="对话操作" aria-expanded="${menuOpen ? 'true' : 'false'}">
          ${iconSvg('more')}
        </button>
        ${menuOpen ? renderProjectMenu('chat-root', 'chat-root') : ''}
      </div>
      ${open ? `<div class="side-list sidebar-session-list sidebar-accordion-body">
        ${sessions.map((session) => renderSessionItem(session)).join('') || '<div class="empty">暂无会话</div>'}
      </div>` : ''}
    </section>
  `;
}

function renderProjectMenu(kind, id) {
  const position = state.projectMenuPosition || {};
  const style = Number.isFinite(position.x) && Number.isFinite(position.y)
    ? ` style="left:${Math.round(position.x)}px;top:${Math.round(position.y)}px"`
    : '';
  if (kind === 'project-root') {
    return `<div class="project-menu" role="menu" data-project-menu-panel="${escapeAttr(id)}"${style}>
      <button type="button" data-project-action="create-project" role="menuitem">${iconSvg('folderPlus')}<span>创建新项目</span></button>
    </div>`;
  }
  if (kind === 'chat-root') {
    return `<div class="project-menu" role="menu" data-project-menu-panel="${escapeAttr(id)}"${style}>
      <button type="button" data-project-action="new-chat" role="menuitem">${iconSvg('plus')}<span>创建新的对话</span></button>
    </div>`;
  }
  if (kind === 'task-root') {
    return `<div class="project-menu" role="menu" data-project-menu-panel="${escapeAttr(id)}"${style}>
      <button type="button" data-project-action="open-ubuddy-chat" role="menuitem">${iconSvg('message')}<span>打开 uBuddy 对话</span></button>
    </div>`;
  }
  const project = projectById(id);
  return `<div class="project-menu" role="menu" data-project-menu-panel="${escapeAttr(id)}"${style}>
    <button type="button" data-project-action="rename-project" data-project-id="${escapeAttr(id)}" role="menuitem">${iconSvg('edit')}<span>重命名项目</span></button>
    <button class="danger" type="button" data-project-action="archive-project" data-project-id="${escapeAttr(id)}" role="menuitem">${iconSvg('archive')}<span>归档项目</span></button>
    ${project?.archived ? `<button type="button" data-project-action="unarchive-project" data-project-id="${escapeAttr(id)}" role="menuitem">${iconSvg('archive')}<span>取消归档项目</span></button>` : ''}
  </div>`;
}

function renderSidebarHistory() {
  return '';
}

export function visibleProjects() {
  return (state.projects || []).filter((project) => !project.archived && project.status !== 'archived' && project.status !== 'deleted');
}

export function projectById(projectId) {
  return (state.projects || []).find((project) => project.id === projectId) || null;
}

export function activeProject() {
  return projectById(state.activeProjectId) || null;
}

export function projectName(project = {}) {
  return project.title || pathBasename(project.workspaceRoot || project.workspace_root || '') || 'Untitled project';
}

export function isProjectExpanded(projectId) {
  return (state.expandedProjectIds || []).includes(projectId);
}

export function projectSessions(projectId) {
  const project = projectById(projectId);
  const projectWorkspace = normalizePathKey(project?.workspaceRoot || project?.workspace_root || '');
  return state.sessions
    .filter((session) => !sessionIsArchived(session) && sessionBelongsToProject(session, projectId, projectWorkspace))
    .sort(compareSessionsForDisplay);
}

export function normalSidebarSessions() {
  return state.sessions
    .filter((session) => !sessionIsArchived(session) && !['secretary_department', 'private_assistant'].includes(session.departmentId) && !isInternalDelegationSession(session) && !(session.projectId || session.project_id || '') && !sessionMatchesAnyProjectWorkspace(session))
    .sort(compareSessionsForDisplay);
}

export function secretarySidebarSessions() {
  return state.sessions
    .filter((session) => !sessionIsArchived(session) && session.status !== 'deleted' && session.departmentId === 'secretary_department')
    .sort(compareSessionsForDisplay);
}

export function collaborationSourceSessions() {
  return state.sessions
    .filter((session) => !sessionIsArchived(session) && session.status !== 'deleted' && !['collaboration', 'private_assistant'].includes(session.departmentId) && !isInternalDelegationSession(session))
    .sort(compareSessionsForDisplay);
}

export function isInternalDelegationSession(session = {}) {
  return (session.departmentId || session.department_id || '') === 'agent_delegation';
}

export function collaborationSidebarTasks() {
  return (state.tasks || [])
    .filter((task) => !isInternalTaskRecord(task))
    .filter((task) => task.departmentId === 'collaboration' || task.department_id === 'collaboration' || task.metadata?.crossDepartment)
    .sort((left, right) => String(right.updatedAt || right.updated_at || right.createdAt || '').localeCompare(String(left.updatedAt || left.updated_at || left.createdAt || '')));
}

function sessionBelongsToProject(session = {}, projectId = '', projectWorkspace = '') {
  const sessionProjectId = session.projectId || session.project_id || '';
  if (sessionProjectId) return sessionProjectId === projectId;
  const sessionWorkspace = normalizePathKey(session.workspaceRoot || session.workspace_root || '');
  return Boolean(projectWorkspace && sessionWorkspace && sessionWorkspace === projectWorkspace);
}

function sessionMatchesAnyProjectWorkspace(session = {}) {
  const sessionWorkspace = normalizePathKey(session.workspaceRoot || session.workspace_root || '');
  if (!sessionWorkspace) return false;
  return visibleProjects().some((project) => normalizePathKey(project.workspaceRoot || project.workspace_root || '') === sessionWorkspace);
}

function normalizePathKey(value = '') {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function sidebarSessionsForMode(mode = activeSidebarMode()) {
  if (mode === 'project') return projectSessions(state.activeProjectId);
  if (mode === 'chats') return normalSidebarSessions();
  return [];
}

function renderSettingsSidebarView() {
  const section = activeSettingsSection();
  return `
    <aside class="settings-sidebar" aria-label="设置导航">
      <button class="settings-back-btn" id="settings-back-btn" type="button">
        ${iconSvg('chevronLeft')}<span>返回应用</span>
      </button>
      <div class="settings-search-wrap">
        <div class="settings-search-box">
          <span>${iconSvg('search')}</span>
          <input id="settings-search-input" value="${escapeAttr(state.settingsSearchQuery || '')}" placeholder="搜索设置..." autocomplete="off" />
        </div>
        ${renderSettingsSearchResults()}
      </div>
      ${renderSettingsNavGroup('个人', [
        ['account', 'user', '账户与权限', SETTINGS_SEARCH_TERMS.account],
        ['preferences', 'settings', '偏好', SETTINGS_SEARCH_TERMS.preferences],
      ], section, 'Personal')}
      ${renderSettingsNavGroup('能力', [
        ...((state.uBuddyFeatureFlags?.profileHistory === true || state.uBuddyFeatureFlags?.profilePreviewV1 === true)
          ? [['ubuddy-profile', 'users', 'uBuddy', SETTINGS_SEARCH_TERMS['ubuddy-profile']]] : []),
        ['evolution-sync', 'network', '自进化与同步', SETTINGS_SEARCH_TERMS['evolution-sync']],
        ['skills', 'spark', '技能与插件', SETTINGS_SEARCH_TERMS.skills],
        ['organization-research', 'search', '组织消息调查', SETTINGS_SEARCH_TERMS['organization-research']],
      ], section, 'Capabilities')}
      ${renderSettingsNavGroup('连接', [
        ['connections', 'message', '飞书连接', SETTINGS_SEARCH_TERMS.connections],
      ], section, 'Connections')}
      ${renderSettingsNavGroup('支持', [
        ['diagnostics', 'settings', '诊断与日志', SETTINGS_SEARCH_TERMS.diagnostics],
      ], section, 'Support')}
      ${renderSettingsNavGroup('已归档', [
        ['archived', 'archive', '已归档对话', SETTINGS_SEARCH_TERMS.archived],
      ], section, 'Archived')}
    </aside>
  `;
}

const SETTINGS_SEARCH_RESULTS = Object.freeze([
  { section: 'account', anchor: '#account-section-organization', label: '组织与通讯录', group: '账户与权限', terms: '组织 组织管理 通讯录 Workspace Organization Contacts' },
  { section: 'account', anchor: '#update-center', label: '更新中心', group: '账户与权限', terms: '更新 自动更新 版本 Update Center Updates' },
  { section: 'account', anchor: '#account-section-model-service', label: '模型服务', group: '账户与权限', terms: '模型 Provider Token 默认模型 自定义 Model Service Provider' },
  { section: 'account', anchor: '#account-section-profile', label: '个人资料', group: '账户与权限', terms: '头像 昵称 邮箱 Profile Avatar Display Name Email' },
  { section: 'account', anchor: '#account-section-security', label: '安全设置', group: '账户与权限', terms: '密码 安全 Security Password' },
  { section: 'preferences', anchor: '.settings-preferences-view .settings-panel:first-child', label: '主题', group: '偏好', terms: '外观 浅色 深色 日间 夜间 Theme Appearance Light Dark' },
  { section: 'preferences', anchor: '.settings-language-panel', label: '语言', group: '偏好', terms: '中文 英文 Language Chinese English' },
  { section: 'preferences', anchor: '.desktop-lifecycle-settings', label: '关闭最后一个窗口时', group: '偏好', terms: '后台运行 退出 Janus 通知区域 菜单栏 系统托盘 close window background quit tray' },
  { section: 'ubuddy-profile', anchor: '.settings-ubuddy-profile-view .ubuddy-profile-preview-panel', label: '能力简介预览', group: 'uBuddy', terms: 'uBuddy 能力 边界 Skill 简介 Capability profile' },
  { section: 'skills', anchor: '.plugins-view', label: '技能与插件', group: '技能与插件', terms: '安装 更新 管理 扩展能力 Skills Plugins install update manage' },
  { section: 'evolution-sync', anchor: '.evolution-settings-card', label: '自进化与更新', group: '自进化与同步', terms: 'Skill Agent 云端同步 更新 Evolution Sync Skill updates' },
  { section: 'evolution-sync', anchor: '.upload-compliance-title', label: '上传合规风控', group: '自进化与同步', terms: '拒传 检测 账号停用 空同步 Upload Compliance Controls' },
  { section: 'organization-research', anchor: '.organization-research-policy-panel', label: '调查政策', group: '组织消息调查', terms: '组织调查 审计 组织消息 investigation policy audit' },
  { section: 'connections', anchor: '.feishu-settings-panel', label: '飞书连接', group: '飞书连接', terms: '机器人 App ID App Secret Lark Feishu' },
  { section: 'connections', anchor: '.feishu-binding-panel', label: '账号绑定', group: '飞书连接', terms: '绑定 绑定码 解除绑定 account binding unbind' },
  { section: 'diagnostics', anchor: '.diagnostics-settings-panel', label: '本机应用日志', group: '诊断与日志', terms: '日志 诊断 导出 清理 Diagnostics Logs' },
  { section: 'archived', anchor: '.archived-conversations-panel', label: '已归档对话', group: '已归档对话', terms: '归档 恢复 聊天 Archived conversations' },
]);

function renderSettingsSearchResults() {
  const query = normalizeSearch(state.settingsSearchQuery);
  if (!query) return '';
  const results = SETTINGS_SEARCH_RESULTS.filter((item) => {
    if (item.section === 'ubuddy-profile'
      && state.uBuddyFeatureFlags?.profileHistory !== true
      && state.uBuddyFeatureFlags?.profilePreviewV1 !== true) return false;
    if (item.anchor === '.upload-compliance-title' && state.currentUser?.role !== 'admin') return false;
    return normalizeSearch(item.label).includes(query)
      || normalizeSearch(item.group).includes(query)
      || normalizeSearch(item.terms).includes(query);
  }).slice(0, 8);
  if (!results.length) {
    return '<div class="settings-search-results is-empty" role="status">未找到相关设置</div>';
  }
  return `<div class="settings-search-results" role="listbox" aria-label="相关设置">${results.map((item) => `
    <button class="settings-search-result" type="button" role="option" data-settings-search-result data-settings-search-section="${escapeAttr(item.section)}" data-settings-search-anchor="${escapeAttr(item.anchor)}">
      <span><strong>${escapeHtml(translateUiText(item.label, state.languageMode))}</strong><small>${escapeHtml(translateUiText(item.group, state.languageMode))}</small></span>${iconSvg('chevronRight')}
    </button>`).join('')}</div>`;
}

const SETTINGS_SEARCH_TERMS = Object.freeze({
  account: '账户与权限 组织管理 更新中心 模型服务 默认模型 自定义 Provider Token 用量 个人资料 头像 昵称 邮箱 安全设置 修改密码 退出登录 Account Permissions Organization Updates Model Service Default Model Custom Provider Token Usage Profile Avatar Display Name Email Security Change Password Sign Out',
  preferences: '偏好 管理当前设备上的 Janus 偏好 常规 外观 主题 浅色 深色 日间 夜间 暗光 语言 英文 中文 关闭最后一个窗口时 后台运行 退出 Janus 通知区域 菜单栏 系统托盘 Preferences device General Appearance Theme Light Dark daytime nighttime Language English Chinese When closing the last window Close last window Run in background Quit Janus notification area menu bar system tray',
  'ubuddy-profile': 'uBuddy 能力 边界 Skill 历史版本 公开授权 隐私风险 可交付成果 Capability boundaries Skill history versions public access privacy risk deliverables',
  'evolution-sync': '自进化与同步 Skill 更新 Agent 云端同步 自动更新 上传合规风控 拒传检测 账号停用 空同步 长期无有效上传 Evolution Sync Skill updates Agent cloud sync automatic updates upload compliance risk control rejected upload detection account suspension empty sync no valid uploads',
  skills: '技能与插件 安装 更新 管理 扩展能力 已安装 可安装 类别 状态 Janus 自研技能 独立 Skills 本地目录 GitHub 导入 分配 部门 Agent 员工 Codex 插件 Marketplace Skills Plugins install update manage extensions installed available category status Janus skills standalone skills local directory import assign department employees Codex plugins marketplace',
  'organization-research': '组织消息调查 调查政策 审计记录 组织 Workspace 固定边界 私聊 内部群 任务群 个人空间 私人助理 外部群 跨组织 调查记录 Organization message research investigation policy audit records organization workspace fixed boundaries private chats internal groups task groups personal space private assistant external groups cross-organization',
  connections: '飞书连接 机器人连接 App ID App Secret 服务区域 飞书中国 Lark 国际 长连接 测试凭证 保存配置 账号绑定 绑定码 解除绑定 Feishu connection bot connection service region China international long connection test credentials save configuration account binding binding code unbind',
  diagnostics: '诊断与日志 本机应用日志 日志等级 保留期限 文件数量 占用空间 最近写入 丢弃事件 最近写入错误 打开日志目录 导出诊断日志 清理旧日志 默认不记录对话 Prompt 模型回答 文件内容 不会自动上传 Diagnostics Logs local application logs log level retention file count disk usage recent write dropped events write error open log directory export diagnostic logs clear old logs conversations model responses file contents never automatically uploaded',
  archived: '已归档对话 查看 恢复 已归档聊天 删除 联系人群聊 uBuddy 工作群 Archived conversations view restore archived chats delete contact group chats uBuddy work groups',
});

function renderSettingsNavGroup(title, items, active, groupKeywords = '') {
  const query = normalizeSearch(state.settingsSearchQuery);
  const visibleItems = query
    ? items.filter(([id, _icon, label, keywords = '']) => (
        normalizeSearch(id).includes(query) ||
        normalizeSearch(label).includes(query) ||
        normalizeSearch(keywords).includes(query) ||
        normalizeSearch(title).includes(query) ||
        normalizeSearch(groupKeywords).includes(query)
      ))
    : items;
  if (!visibleItems.length) return '';
  return `
    <section class="settings-nav-group">
      <h3>${escapeHtml(title)}</h3>
      <div class="settings-nav-list">
        ${visibleItems.map(([id, icon, label]) => `
          <button class="settings-nav-item ${active === id ? 'active' : ''}" type="button" data-settings-section="${escapeAttr(id)}">
            <span>${iconSvg(icon)}</span>
            <strong>${escapeHtml(label)}</strong>
          </button>
        `).join('')}
      </div>
    </section>
  `;
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

function renderAccountMenu(user = state.currentUser) {
  if (!state.accountMenuOpen) return '';
  return `
    <div class="account-menu" role="menu">
      <a class="account-menu-item" href="#settings" data-account-menu-action="settings" role="menuitem">
        <span>${iconSvg('settings')}</span>
        <strong>设置</strong>
      </a>
      ${user ? `
        <button class="account-menu-item" type="button" data-account-menu-action="logout" role="menuitem">
          <span>${iconSvg('logOut')}</span>
          <strong>退出登录</strong>
        </button>
      ` : ''}
    </div>
  `;
}

function orderedAccountWorkspaces() {
  const workspaces = Array.isArray(state.accountWorkspaces) ? state.accountWorkspaces.filter((workspace) => workspace?.id) : [];
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const ordered = [];
  const preferredIds = [state.activeAccountWorkspace?.id, ...(state.recentAccountWorkspaceIds || [])];
  new Set(preferredIds).forEach((workspaceId) => {
    const workspace = workspacesById.get(workspaceId);
    if (!workspace) return;
    ordered.push(workspace);
    workspacesById.delete(workspaceId);
  });
  ordered.push(...workspacesById.values());
  return ordered;
}

function renderAccountWorkspaceMenu() {
  if (!state.accountMenuWorkspaceOpen) return '';
  const activeId = state.activeAccountWorkspace?.id;
  const workspaces = orderedAccountWorkspaces();
  return `<div class="account-menu account-workspace-dock-menu" role="menu" aria-label="选择工作空间">
    <div class="account-menu-workspace-more-title">选择工作空间</div>
    <div class="account-menu-workspace-list">
      ${workspaces.map((workspace) => `<button class="account-menu-workspace-option ${workspace.id === activeId ? 'is-active' : ''}"
        type="button" role="menuitem" data-account-workspace-id="${escapeAttr(workspace.id)}" data-account-workspace-source="account-dock-more"
        ${state.workspaceSwitchBusy ? 'disabled' : ''}>
        <span class="account-workspace-avatar">${accountWorkspaceMark(workspace)}</span>
        <span><strong>${escapeHtml(workspace.kind === 'personal' ? '个人空间' : workspace.name || '组织')}</strong><small>${workspace.kind === 'organization' ? '组织' : '个人'}</small></span>
        ${workspace.id === activeId ? iconSvg('check') : ''}
      </button>`).join('')}
    </div>
  </div>`;
}

function renderSidebarAccountButton(user, displayName) {
  const updateAvailable = Boolean(
    state.updates?.available
    || state.updates?.downloaded
    || state.agentUpdates?.available
    || state.agentUpdates?.downloaded,
  );
  const updateLabel = translateUiText('可更新', state.languageMode);
  return `<button class="account-card sidebar-account-button" id="account-card" type="button" title="${escapeAttr(displayName)}"
    aria-label="账户菜单" aria-haspopup="menu" aria-expanded="${state.accountMenuOpen ? 'true' : 'false'}">
    ${renderAccountAvatar(user, { title: displayName })}
    ${updateAvailable ? `<span class="account-update-badge" data-account-update role="button" tabindex="0" title="${escapeAttr(translateUiText('打开更新中心', state.languageMode))}">${escapeHtml(updateLabel)}</span>` : ''}
  </button>`;
}

function renderAccountWorkspaceDock() {
  const workspaces = orderedAccountWorkspaces();
  const organizations = workspaces.filter((workspace) => workspace.kind === 'organization');
  const recentOrganization = (state.activeAccountWorkspace?.kind === 'organization' ? state.activeAccountWorkspace : null)
    || organizations.find((workspace) => (state.recentAccountWorkspaceIds || []).includes(workspace.id))
    || (organizations.length === 1 ? organizations[0] : null);
  const personalWorkspace = workspaces.find((workspace) => workspace.kind === 'personal');
  const workspaceButton = (workspace, kind) => {
    if (!workspace) return '';
    const tooltip = accountWorkspaceDockTooltip(workspace, organizations);
    const tooltipId = `account-workspace-tooltip-${kind}`;
    return `<button class="account-dock-button account-dock-workspace ${workspace.id === state.activeAccountWorkspace?.id ? 'is-active' : ''}"
    type="button" data-account-workspace-id="${escapeAttr(workspace.id)}" data-account-workspace-shortcut data-account-workspace-source="account-dock-${escapeAttr(kind)}"
    aria-label="${escapeAttr(tooltip)}" aria-describedby="${escapeAttr(tooltipId)}"
    ${state.workspaceSwitchBusy ? 'disabled' : ''}><span class="account-dock-workspace-mark">${accountWorkspaceMark(workspace)}</span><span class="account-dock-workspace-tooltip" id="${escapeAttr(tooltipId)}" role="tooltip">${escapeHtml(tooltip)}</span></button>`;
  };
  return `<div class="account-dock" role="group" aria-label="账户与工作空间">
    ${workspaceButton(recentOrganization, 'recent')}
    ${workspaceButton(personalWorkspace, 'personal')}
    ${workspaces.length > 2 ? `<button class="account-dock-button account-dock-more ${state.accountMenuWorkspaceOpen ? 'is-active' : ''}" type="button"
      data-account-workspace-account-toggle aria-label="更多工作空间" aria-describedby="account-workspace-tooltip-more" aria-haspopup="menu"
      aria-expanded="${state.accountMenuWorkspaceOpen ? 'true' : 'false'}" ${state.workspaceSwitchBusy ? 'disabled' : ''}>${iconSvg('plus')}<span class="account-dock-workspace-tooltip" id="account-workspace-tooltip-more" role="tooltip">更多工作空间</span></button>` : ''}
  </div>`;
}

function accountWorkspaceDockTooltip(workspace = {}, organizations = []) {
  const english = state.languageMode === 'en';
  const active = workspace.id === state.activeAccountWorkspace?.id;
  if (workspace.kind !== 'organization') {
    if (active) return english ? 'Current workspace: Personal' : '当前工作空间：个人空间';
    return english ? 'Switch to Personal workspace' : '切换为个人空间';
  }
  const name = String(workspace.name || (english ? 'Organization' : '组织')).trim();
  const onlyOrganization = organizations.length <= 1;
  if (active && onlyOrganization) {
    return english
      ? `Current organization: ${name}; no other organizations available`
      : `当前组织：${name}；暂无其他可切换组织`;
  }
  if (active) {
    return english
      ? `Current organization: ${name}; use More Workspaces to switch organizations`
      : `当前组织：${name}；可通过更多工作空间切换组织`;
  }
  return onlyOrganization
    ? english
      ? `Switch to organization ${name}; no other organizations available`
      : `切换为组织 ${name}；暂无其他可切换组织`
    : english ? `Switch to organization ${name}` : `切换为组织 ${name}`;
}

function accountWorkspaceInitial(workspace = {}) {
  return String(workspace.name || (workspace.kind === 'organization' ? '组' : '我')).trim().slice(0, 1).toUpperCase() || 'W';
}

function accountWorkspaceMark(workspace = {}) {
  return workspace.kind === 'personal' ? iconSvg('user') : escapeHtml(accountWorkspaceInitial(workspace));
}

function renderChatSearchModalView() {
  if (!state.chatSearchOpen) return '';
  const query = normalizeSearch(state.chatSearchQuery);
  const sessions = (query ? filteredSessions() : state.sessions).filter((session) => !isInternalDelegationSession(session)).slice(0, 50);
  return `
    <div class="chat-search-overlay" id="chat-search-overlay" role="presentation">
      <div class="chat-search-modal" role="dialog" aria-modal="true" aria-label="搜索聊天">
        <div class="chat-search-modal-header">
          <input id="chat-search-modal-input" class="chat-search-modal-input" value="${escapeAttr(state.chatSearchQuery)}" placeholder="搜索聊天..." autocomplete="off" />
          <button class="chat-search-modal-close" id="close-chat-search-btn" type="button" title="关闭">${iconSvg('x')}</button>
        </div>
        <div class="chat-search-modal-results" id="chat-search-modal-results">
          ${renderSearchModalResults(sessions, Boolean(query))}
        </div>
      </div>
    </div>
  `;
}

function renderSearchModalResults(sessions, isSearching) {
  if (state.chatSearchError && isSearching) {
    return `<div class="search-empty-panel">
      <div class="search-empty-title">搜索失败</div>
      <span>${escapeHtml(state.chatSearchError)}</span>
    </div>`;
  }
  if (state.chatSearchLoading && isSearching && !sessions.length) {
    return '<div class="search-empty-panel"><div class="search-empty-title">正在搜索聊天...</div><span>会同时匹配标题、消息正文和附件信息。</span></div>';
  }
  if (!sessions.length) {
    return `<div class="search-empty-panel">
      <div class="search-empty-title">${isSearching ? '没有找到相关聊天' : '暂无历史聊天'}</div>
      ${isSearching ? `<button class="search-new-chat-item" type="button" data-search-new-chat>
        <span class="search-new-chat-icon">${iconSvg('edit')}</span>
        <span>新聊天</span>
      </button>` : ''}
    </div>`;
  }
  return groupSessionsByMonth(sessions).map((group) => `
    <div class="search-group">
      <div class="search-group-label">${escapeHtml(group.label)}</div>
      ${group.items.map((session) => renderSearchSessionItem(session, { isSearching })).join('')}
    </div>
  `).join('');
}

function renderSearchSessionItem(session, { isSearching = false } = {}) {
  const matchExcerpt = session.matchExcerpt || session.match_excerpt || '';
  const matchRole = session.matchRole || session.match_role || '';
  const excerpt = isSearching && matchExcerpt
    ? `${searchMatchRoleLabel(matchRole)}${matchExcerpt}`
    : '';
  return `
    <button class="search-session-item" data-session="${escapeAttr(session.id)}" type="button">
      <span class="search-session-main">
        <span class="search-session-title">${escapeHtml(sessionTitleForDisplay(session, '未命名聊天'))}</span>
        ${excerpt ? `<span class="search-session-excerpt">${escapeHtml(excerpt)}</span>` : ''}
        <span class="search-session-meta">${escapeHtml(sessionSubtitleForDisplay(session))}</span>
      </span>
    </button>
  `;
}

function renderSessionItem(session, { isSearching = false } = {}) {
  const matchExcerpt = session.matchExcerpt || session.match_excerpt || '';
  const matchRole = session.matchRole || session.match_role || '';
  const subtitle = isSearching && matchExcerpt
    ? `${searchMatchRoleLabel(matchRole)}${matchExcerpt}`
    : '';
  const meta = isSearching && matchExcerpt ? sessionSubtitleForDisplay(session) : '';
  const isPinned = sessionIsPinned(session);
  const isArchived = sessionIsArchived(session);
  const menuOpen = state.sessionMenuOpenId === session.id;
  const active = session.id === state.currentSessionId;
  return `
    <div class="session-row ${active ? 'active' : ''} ${isSearching ? 'in-search' : ''} ${menuOpen ? 'menu-open' : ''}">
      <button class="session-item ${active ? 'active' : ''}" data-session="${escapeAttr(session.id)}" type="button">
        <span class="session-title-line">
          <span class="session-title">${escapeHtml(sessionTitleForDisplay(session, 'Untitled'))}</span>
          ${isPinned ? `<span class="session-pin-mark" title="已置顶">${iconSvg('pin')}</span>` : ''}
        </span>
        ${subtitle || isArchived ? `<small class="session-subtitle">
          ${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}
          ${isArchived ? '<span class="session-status-badge">已归档</span>' : ''}
        </small>` : ''}
        ${meta ? `<small class="session-match-meta">${escapeHtml(meta)}</small>` : ''}
      </button>
      <button class="session-more-btn" type="button" data-session-menu="${escapeAttr(session.id)}" title="会话操作" aria-label="会话操作" aria-expanded="${menuOpen ? 'true' : 'false'}">
        ${iconSvg('more')}
      </button>
      ${menuOpen ? renderSessionMenu(session) : ''}
    </div>
  `;
}

function renderSessionMenu(session) {
  const pinned = sessionIsPinned(session);
  const archived = sessionIsArchived(session);
  const sessionId = escapeAttr(session.id);
  const position = state.sessionMenuPosition || {};
  const style = Number.isFinite(position.x) && Number.isFinite(position.y)
    ? ` style="left:${Math.round(position.x)}px;top:${Math.round(position.y)}px"`
    : '';
  return `
    <div class="session-menu" role="menu" data-session-menu-panel="${sessionId}"${style}>
      <button type="button" data-session-action="${pinned ? 'unpin' : 'pin'}" data-session-id="${sessionId}" role="menuitem">
        ${iconSvg('pin')}<span>${pinned ? '取消置顶' : '置顶'}</span>
      </button>
      <button type="button" data-session-action="rename" data-session-id="${sessionId}" role="menuitem">
        ${iconSvg('edit')}<span>重命名</span>
      </button>
      <button type="button" data-session-action="${archived ? 'unarchive' : 'archive'}" data-session-id="${sessionId}" role="menuitem">
        ${iconSvg('archive')}<span>${archived ? '取消归档' : '归档'}</span>
      </button>
      <button class="danger" type="button" data-session-action="delete" data-session-id="${sessionId}" role="menuitem">
        ${iconSvg('trash')}<span>删除</span>
      </button>
    </div>
  `;
}

function searchMatchRoleLabel(role) {
  if (role === 'user') return '你：';
  if (role === 'assistant') return 'Janus：';
  if (role === 'title') return '标题：';
  return '';
}

function tabButton(id, label) {
  const active = state.currentTab === id && !(id === 'chat' && state.networkPanelOpen);
  return `<button class="tab-btn ${active ? 'active' : ''}" type="button" data-tab="${id}" data-app-nav="${escapeAttr(id)}" ${active ? 'aria-current="page"' : ''}>${label}</button>`;
}

function networkButton(id, label) {
  const active = ['chat', 'collaboration'].includes(state.currentTab) && state.networkPanelOpen && (state.networkPanelView || 'messages') === id;
  const notice = primaryNavigationNotice(id);
  const unreadMarker = notice.badgeCount
    ? `<b class="sidebar-nav-unread ${id === 'messages' ? 'is-dot' : ''}" aria-hidden="true">${id === 'messages' ? '' : escapeHtml(notice.badgeLabel)}</b>`
    : '';
  return `<button class="tab-btn sidebar-network-btn ${active ? 'active' : ''} ${notice.badgeCount ? 'has-unread' : ''} ${notice.pendingCount ? 'has-pending' : ''} ${notice.privateAssistantRunning ? 'has-active-run' : ''} ${notice.privateAssistantResultUnread ? 'has-private-result' : ''}" type="button" data-network-view="${escapeAttr(id)}" data-app-nav="${escapeAttr(id)}" data-unread-count="${escapeAttr(notice.unreadCount)}" data-pending-count="${escapeAttr(notice.pendingCount)}" data-notification-count="${escapeAttr(notice.badgeCount)}" ${active ? 'aria-current="page"' : ''}${notice.ariaLabel ? ` aria-label="${escapeAttr(notice.ariaLabel)}"` : ''}>${label}${notice.privateAssistantRunning || notice.privateAssistantResultUnread ? `<i class="sidebar-nav-run-status" aria-hidden="true"></i>` : ''}${unreadMarker}</button>`;
}

export function primaryNavigationNotice(id = '') {
  const privateAssistantRunning = id === 'messages' && (state.chatRuns || []).some((run) => (
    (run.targetKind === 'private_assistant' || run.departmentId === 'private_assistant') && !run.terminal
  ));
  const privateAssistantResultUnread = id === 'messages' && Boolean(state.privateAssistantResultUnread);
  if (id === 'friends') {
    const incomingCount = Array.isArray(state.friendOverview?.requests?.incoming)
      ? state.friendOverview.requests.incoming.length
      : 0;
    return {
      unreadCount: 0,
      pendingCount: incomingCount,
      badgeCount: incomingCount,
      badgeLabel: formatSidebarUnreadCount(incomingCount),
      privateAssistantRunning: false,
      privateAssistantResultUnread: false,
      ariaLabel: incomingCount ? `通讯录，${incomingCount} 条联系人申请待处理` : '',
    };
  }
  if (id !== 'messages') return {
    unreadCount: 0, pendingCount: 0, badgeCount: 0, badgeLabel: '',
    privateAssistantRunning: false, privateAssistantResultUnread: false, ariaLabel: '',
  };
  const unreadCount = navigationMessageUnreadCount(state);
  const agentNoticeCount = agentRunNoticeCount(state);
  const uBuddyPendingCount = uBuddyPendingTaskCount({ tasks: state.tasks, taskViewsById: state.uBuddyTaskViewsById });
  const agentActionCount = (state.chatRuns || []).filter((run) => (
    !run?.terminal && (run.approvalRequest?.approvalId || run.userInputRequest?.requestId)
  )).length;
  const pendingCount = uBuddyPendingCount + agentActionCount;
  const badgeCount = unreadCount + agentNoticeCount;
  const statusLabel = [
    unreadCount ? `${unreadCount} 条未读消息` : '',
    agentNoticeCount ? `${agentNoticeCount} 条 Agent 新通知` : '',
    uBuddyPendingCount ? `${uBuddyPendingCount} 项 uBuddy 待处理` : '',
    agentActionCount ? `${agentActionCount} 项 Agent 确认待处理` : '',
    privateAssistantRunning ? '私人助理正在运行' : privateAssistantResultUnread ? '私人助理有待查看结果' : '',
  ].filter(Boolean).join('，');
  return {
    unreadCount,
    agentNoticeCount,
    pendingCount,
    badgeCount,
    badgeLabel: formatSidebarUnreadCount(badgeCount),
    privateAssistantRunning,
    privateAssistantResultUnread,
    ariaLabel: statusLabel ? `消息，${statusLabel}` : '',
  };
}

function sessionTitleForDisplay(session = {}, fallback = '') {
  const raw = String(session.title || fallback || '').trim();
  const employeeId = session.agentInstanceId || session.agent_instance_id || '';
  const employee = (state.employeeOverview?.roster || []).find((item) => item.id === employeeId) || null;
  if (!employee) return raw;
  return agentInstanceDisplayNameForUi({ ...employee, displayName: raw, display_name: raw }, raw);
}

function sessionSubtitleForDisplay(session = {}) {
  const raw = String(sessionSubtitle(session) || '').trim();
  const employeeId = session.agentInstanceId || session.agent_instance_id || '';
  const employee = (state.employeeOverview?.roster || []).find((item) => item.id === employeeId) || null;
  if (!employee) return raw;
  return agentInstanceDisplayNameForUi({ ...employee, displayName: raw, display_name: raw }, raw);
}

function formatSidebarUnreadCount(value = 0) {
  const count = Math.max(0, Number(value || 0));
  return count > 99 ? '99+' : String(count);
}

function currentChatUtilityIdentity() {
  if (state.networkPanelView !== 'messages' || state.networkMessageHomeOpen || state.networkConversationPeerId || state.collaborationGroupId) return null;
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  const agentId = session?.agentId || session?.agent_id || state.currentAgentId || '';
  const departmentId = session?.departmentId || session?.department_id || state.currentDepartmentId || '';
  const employeeId = session?.agentInstanceId || session?.agent_instance_id || state.currentAgentInstanceId || '';
  const employee = (state.employeeOverview?.roster || []).find((item) => item.id === employeeId) || null;
  const chatRun = state.activeChatRun || null;
  const activeRun = chatRun && !chatRun.terminal ? chatRun : null;
  const agent = (state.org?.agents || []).find((item) => item.id === agentId) || null;
  const department = (state.org?.departments || []).find((item) => item.id === departmentId) || null;
  const secretary = agentId === 'secretary_agent' || departmentId === 'secretary_department' || state.homeMode === 'secretary';
  const privateAssistant = departmentId === 'private_assistant' || state.homeMode === 'private_assistant';
  if (!session && !agent && !employee && !secretary && !privateAssistant) return null;
  const title = secretary
    ? 'uBuddy'
    : privateAssistant
      ? '私人助理'
      : employee
        ? agentInstanceDisplayNameForUi(employee, employee.family?.name || agent?.displayName || agent?.display_name || agent?.name || session?.title || '对话')
        : agent?.displayName || agent?.display_name || agent?.name || session?.title || '对话';
  const status = chatRun?.failed
    ? { label: '执行异常', tone: 'warning' }
    : activeRun
      ? { label: '执行中', tone: 'busy' }
    : employee?.employmentState === 'conflict'
      ? { label: '状态异常', tone: 'warning' }
      : employee?.employmentState === 'inactive'
        ? { label: '已停用', tone: 'offline' }
        : employee?.currentWork?.title
          ? { label: '执行中', tone: 'busy' }
          : Number(employee?.queueDepth || 0) > 0
            ? { label: `排队 ${Number(employee.queueDepth)} 项`, tone: 'busy' }
            : { label: '在线', tone: 'online' };
  const subtitle = secretary
    ? '任务整理与协作调度 · Beta'
    : privateAssistant
      ? '本地隔离 · 仅你可见'
      : department?.name || session?.title || '消息会话';
  return {
    title,
    subtitle,
    avatarContent: renderAgentAvatarContent(agentId || employee?.agentFamilyId || (secretary ? 'secretary_agent' : privateAssistant ? 'private_assistant' : ''), title),
    avatarIcon: privateAssistant ? 'shield' : secretary ? 'spark' : '',
    avatarTitle: privateAssistant ? '本地隔离空间：不与其他 Agent 通信，不同步到 Janus 云端，也不占员工额度；当前请求仍会发送给你选择的模型服务。' : '',
    avatarTone: agentAvatarTone(agentId || employee?.agentFamilyId || (secretary ? 'secretary_agent' : privateAssistant ? 'private_assistant' : ''), title),
    tone: secretary ? 'is-ubuddy' : privateAssistant ? 'is-private' : 'is-employee',
    employeeId: employee?.id || '',
    statusLabel: status.label,
    statusTone: status.tone,
  };
}

function renderMessageResponsiveTabs() {
  const activePane = state.messageActivePane === 'conversation' ? 'conversation' : 'list';
  return `<nav class="responsive-page-tabs message-responsive-tabs" aria-label="消息页面切换">
    <button type="button" data-message-pane="list" class="${activePane === 'list' ? 'active' : ''}" aria-pressed="${activePane === 'list' ? 'true' : 'false'}">消息</button>
    <button type="button" data-message-pane="conversation" class="${activePane === 'conversation' ? 'active' : ''}" aria-pressed="${activePane === 'conversation' ? 'true' : 'false'}">会话</button>
  </nav>`;
}

function renderTopbarView() {
  if (state.activeTaskWorkspaceKind === 'task_run') return '';
  if (state.currentTab === 'chat') {
    if (state.collaborationGroupId) return '';
    if (state.networkPanelOpen && state.networkPanelView === 'friends') return '';
    const singleMessageLayout = state.responsiveLayoutMode === 'single'
      && state.networkPanelOpen
      && state.networkPanelView === 'messages';
    const messageResponsiveTabs = singleMessageLayout
      ? renderMessageResponsiveTabs()
      : '';
    if (state.networkPanelOpen && state.networkPanelView === 'messages' && state.networkMessageHomeOpen) {
      return singleMessageLayout
        ? `<header class="chat-utility message-responsive-utility">${messageResponsiveTabs}</header>`
        : '';
    }
    const showMessageHomeBack = state.networkPanelOpen
      && state.networkPanelView === 'messages'
      && !state.networkMessageHomeOpen;
    if (showMessageHomeBack && (state.chatGroupId || state.collaborationGroupId)) return '';
    const identity = currentChatUtilityIdentity();
    const showUBuddyCenters = identity?.tone === 'is-ubuddy' && state.currentSessionId;
    const deliveryCount = Math.max(0, Number(state.uBuddyDeliveryCenterPage?.counts?.pending || 0));
    if (showMessageHomeBack && !identity && (state.networkConversationPeerId || state.collaborationGroupId)) {
      return '<header class="chat-utility social-chat-utility-placeholder" aria-hidden="true"></header>';
    }
    return `
      <header class="chat-utility ${showMessageHomeBack ? 'has-message-home-back' : ''} ${identity ? 'has-conversation-info' : ''}">
        ${messageResponsiveTabs}
        ${showMessageHomeBack ? `<button class="message-home-back" type="button" data-message-home-back title="${state.responsiveLayoutMode === 'single' ? '返回消息列表' : '关闭当前会话'}" aria-label="${state.responsiveLayoutMode === 'single' ? '返回消息列表' : '关闭当前会话'}">${iconSvg(state.responsiveLayoutMode === 'single' ? 'chevronLeft' : 'x')}</button>` : ''}
        ${identity ? `<div class="chat-utility-conversation" data-chat-top-info><span class="chat-utility-avatar ${identity.tone} tone-${identity.avatarTone}"${identity.avatarTitle ? ` title="${escapeAttr(identity.avatarTitle)}" aria-label="${escapeAttr(identity.avatarTitle)}"` : ''}>${identity.avatarIcon ? iconSvg(identity.avatarIcon) : identity.avatarContent}</span><span class="chat-utility-copy"><span class="chat-utility-title-line"><strong>${escapeHtml(identity.title)}</strong><em class="chat-agent-status is-${escapeAttr(identity.statusTone)}"><i></i>${escapeHtml(identity.statusLabel)}</em></span>${identity.subtitle ? `<small>${escapeHtml(identity.subtitle)}</small>` : ''}</span></div>` : ''}
        <div class="chat-utility-actions">
          ${showUBuddyCenters ? `<button class="ubuddy-center-trigger ${state.uBuddyCenterOpen === 'tasks' ? 'is-active' : ''}" type="button" data-ubuddy-center-open="tasks" aria-label="全部任务" title="全部任务" aria-expanded="${state.uBuddyCenterOpen === 'tasks'}">${iconSvg('tasks')}<span>全部任务</span></button><button class="ubuddy-center-trigger is-delivery ${state.uBuddyCenterOpen === 'deliveries' ? 'is-active' : ''}" type="button" data-ubuddy-center-open="deliveries" aria-label="交付中心${deliveryCount ? `，${deliveryCount} 个待审核` : ''}" title="交付中心" aria-expanded="${state.uBuddyCenterOpen === 'deliveries'}">${iconSvg('clipboard')}<span>交付中心</span>${deliveryCount ? `<b>${deliveryCount > 99 ? '99+' : deliveryCount}</b>` : ''}</button>` : ''}
          ${identity?.employeeId ? `<button class="icon-btn" type="button" data-employee-detail="${escapeAttr(identity.employeeId)}" title="打开 Agent 详情" aria-label="打开 Agent 能力、配置与管理详情">${iconSvg('panelRightOpen')}</button>` : ''}
        </div>
      </header>
    `;
  }
  if (state.currentTab === 'plugins' || state.currentTab === 'evolution' || state.currentTab === 'personal-evolution' || state.currentTab === 'employees' || state.currentTab === 'janus-app') return '';
  const dept = state.org.departments.find((item) => item.id === state.currentDepartmentId);
  const agent = state.org.agents.find((item) => item.id === state.currentAgentId);
  return `
    <header class="topbar">
      <div>
        <h1>${escapeHtml(topTitle())}</h1>
        <p>${escapeHtml(dept?.name || '')}${agent ? ` / ${escapeHtml(shortAgentLabel(agent))}` : ''}</p>
      </div>
      <div class="top-actions">
        <button class="btn secondary" id="refresh-btn">Refresh</button>
        <button class="btn secondary" id="doctor-btn">Janus 诊断</button>
      </div>
    </header>
  `;
}

function topTitle() {
  if (state.currentTab === 'chat') return 'Agent Workspace';
  if (state.currentTab === 'plugins') return '技能';
  if (state.currentTab === 'evolution') return '自进化';
  if (state.currentTab === 'personal-evolution') return '个人演化';
  if (state.currentTab === 'employees') return '人才市场';
  if (state.currentTab === 'janus-app') return 'Janus App';
  return '运行设置';
}

function renderAgentPickerView() {
  const agents = agentsForDepartment(state.currentDepartmentId);
  return `
    <div class="control-row">
      <label>
        <span>Department</span>
        <select id="department-select">
          ${state.org.departments.map((dept) => `<option value="${escapeAttr(dept.id)}" ${dept.id === state.currentDepartmentId ? 'selected' : ''}>${escapeHtml(dept.name)}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>Agent</span>
        <select id="agent-select">
          ${agents.map((agent) => `<option value="${escapeAttr(agent.id)}" ${agent.id === state.currentAgentId ? 'selected' : ''}>${escapeHtml(agentLabel(agent))}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>Model override</span>
        <input id="model-input" value="${escapeAttr(state.model)}" placeholder="config default" />
      </label>
      <label>
        <span>Reasoning</span>
        <select id="reasoning-select">
          ${['', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((item) => `<option value="${item}" ${item === state.reasoningEffort ? 'selected' : ''}>${item || 'config default'}</option>`).join('')}
        </select>
      </label>
    </div>
  `;
}
