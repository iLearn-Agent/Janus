import { state } from '../state.js';
import { iconSvg } from '../ui/icons.js';
import { clipInline, escapeAttr, escapeHtml, renderStatusBadge, userVisibleErrorMessage } from '../utils/format.js';

const FALLBACK_PLUGIN_CATALOG = [
  {
    id: 'ppt_creation',
    name: 'PPT 制作技能',
    icon: 'presentation',
    category: 'content',
    categoryLabel: '内容创作',
    description: '生成通用、学术汇报和重大项目等可编辑 PPT。',
    descriptionEn: 'Create editable presentations for general, academic, and major-project scenarios.',
    longDescription: '为统一的 PPT Designer 安装三种正式风格、可编辑 PPTX 渲染能力、模板支持和预览导出流程。',
    longDescriptionEn: 'Adds three formal styles, editable PPTX rendering, template support, and preview/export workflows to the unified PPT Designer.',
    tags: ['PPTX', '演示设计', '3 种风格'],
    capabilities: ['通用 PPT', '学术汇报', '重大项目汇报', '可编辑 PPTX', '模板与预览'],
    providesAgentIds: ['ppt'],
    permissions: ['读取用户明确提供的演示素材', '在当前工作区生成 PPTX 与预览文件'],
    recommendedOrder: 10,
    chatTarget: 'pptx',
  },
];
const OFFICIAL_CODEX_MARKETPLACE_NAMES = new Set(['openai-curated', 'openai-api-curated']);
const PLUGIN_PAGE_SIZE = 20;
const PLUGIN_NAME_COLLATOR = new Intl.Collator(['zh-CN', 'en'], {
  sensitivity: 'base',
  numeric: true,
});

let viewDeps = {};

export function renderPlugins(deps = {}) {
  viewDeps = deps;
  const managedPlugins = pluginCatalog();
  const attachedSkills = Array.isArray(state.attachedSkillCatalog?.skills) ? state.attachedSkillCatalog.skills : [];
  const codexPlugins = codexPluginCatalog();
  return `<div class="view plugins-view" data-preserve-scroll data-scroll-key="plugins"><header class="plugins-hero"><section class="plugins-head"><h1>技能与插件</h1>${renderPluginPageControls()}</section>${renderPluginSummary({ managedPlugins, attachedSkills, codexPlugins })}</header>${renderPluginContent()}</div>`;
}

// Backward-compatible export for renderer smoke tests and integrations that
// still address the former Settings-specific renderer. It intentionally
// returns the same page as the main Plugins entry.
export function renderPluginSettings(deps = {}) {
  return renderPlugins(deps);
}

function renderPluginContent() {
  const managedPlugins = pluginCatalog();
  const attachedCatalog = state.attachedSkillCatalog || {};
  const attachedSkills = Array.isArray(attachedCatalog.skills) ? attachedCatalog.skills : [];
  const codexPlugins = codexPluginCatalog();
  return [
    renderPluginDirectory(managedPlugins),
    renderCodexPluginDirectory(codexPlugins),
    renderAttachedSkillManagement(attachedCatalog, attachedSkills),
    renderPluginDetail(managedPlugins),
  ].join('');
}

function renderPluginSummary({ managedPlugins = [], attachedSkills = [], codexPlugins = [] } = {}) {
  const installedCount = attachedSkills.length
    + managedPlugins.filter((plugin) => Boolean(plugin.status?.installed)).length
    + codexPlugins.filter((plugin) => plugin.installed === true).length;
  const availableCount = managedPlugins.filter((plugin) => !plugin.status?.installed && plugin.status?.available !== false).length
    + codexPlugins.filter((plugin) => plugin.installed !== true).length;
  const totalCount = managedPlugins.length + attachedSkills.length + codexPlugins.length;
  return `<div class="plugins-summary-card" aria-label="扩展情况">
    <div class="plugins-summary-head"><span>扩展情况</span><strong>${installedCount} / ${totalCount}</strong></div>
    <div class="plugins-summary-progress"><i style="width:${totalCount ? Math.round((installedCount / totalCount) * 100) : 0}%"></i></div>
    <small>已安装 ${installedCount} 项 · 可安装 ${availableCount} 项</small>
  </div>`;
}

function renderPluginPageControls() {
  return `<section class="plugins-page-controls">
    <div class="plugins-toolbar">
      <label class="plugins-search" aria-label="搜索技能与插件">${iconSvg('search')}<input id="plugin-search-input" type="search" value="${escapeAttr(state.pluginSearchQuery)}" placeholder="搜索技能或插件" autocomplete="off" /></label>
    </div>
  </section>`;
}

function codexPluginCatalog() {
  const catalog = state.codexPlugins || {};
  const installed = Array.isArray(catalog.installed) ? catalog.installed : [];
  const available = Array.isArray(catalog.available) ? catalog.available : [];
  return [...installed, ...available]
    .filter((plugin, index, source) => source.findIndex((item) => item.pluginId === plugin.pluginId) === index);
}

function renderCodexPluginDirectory(allPlugins = codexPluginCatalog()) {
  const catalog = state.codexPlugins || {};
  const installed = Array.isArray(catalog.installed) ? catalog.installed : [];
  const available = Array.isArray(catalog.available) ? catalog.available : [];
  const marketplaces = Array.isArray(catalog.marketplaces) ? catalog.marketplaces : [];
  const conflicts = Array.isArray(catalog.legacyMcpConflicts) ? catalog.legacyMcpConflicts : [];
  const capability = catalog.capability || {};
  const query = normalizeSearch(state.pluginSearchQuery);
  const plugins = [...allPlugins]
    .filter((plugin) => matchesPluginQuery(plugin, query, pluginSearchValues(plugin, [plugin.pluginId, plugin.marketplaceName])))
    .sort((left, right) => comparePluginNames(pluginDisplayName(left), pluginDisplayName(right), left.pluginId, right.pluginId));
  const supported = capability.supported !== false;
  const searchForcedOpen = Boolean(query && plugins.length);
  const open = pluginSectionIsOpen('codex', allPlugins.length, searchForcedOpen);
  const pageInfo = pluginPageInfo('codex', plugins.length);
  const visiblePlugins = paginatedPluginItems('codex', plugins);
  return `<section class="codex-native-plugins plugins-collapsible-section ${open ? 'is-open' : 'is-collapsed'}" aria-label="Codex 插件">
    ${renderPluginSectionToggle({ key: 'codex', title: 'Codex 插件', count: plugins.length, open, searchForcedOpen, summary: `${installed.length} 已安装 · ${available.length} 可安装` })}
    ${open ? `<div class="plugins-collapsible-body">
      ${capability.error ? `<div class="plugins-empty is-error">${escapeHtml(capability.error)}</div>` : ''}
      ${conflicts.length ? `<div class="codex-plugin-conflict"><strong>检测到旧 GitHub MCP 配置</strong><span>它不是 Codex Plugin，不会显示在插件目录或 @ 列表中。现有 MCP 配置已保留，请安装下方推荐的 GitHub Plugin。</span></div>` : ''}
      ${supported ? `<div class="codex-marketplace-add">
      <label><span>插件来源</span><input id="codex-marketplace-source" value="${escapeAttr(state.codexMarketplaceSource || '')}" placeholder="粘贴文件夹路径或 GitHub 地址" autocomplete="off" /></label>
      <button class="plugin-compact-btn secondary" type="button" data-codex-marketplace-pick ${state.codexPluginBusy ? 'disabled' : ''}>${iconSvg('folder')}<span>选择目录</span></button>
      <button class="plugin-compact-btn" type="button" data-codex-marketplace-add ${state.codexPluginBusy || !String(state.codexMarketplaceSource || '').trim() ? 'disabled' : ''}>${iconSvg('plus')}<span>添加市场</span></button>
    </div>
    <div class="codex-marketplace-list">${marketplaces.map((marketplace) => {
      const name = String(marketplace.name || '');
      const official = OFFICIAL_CODEX_MARKETPLACE_NAMES.has(name);
      return `<div><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(marketplace.root || marketplace.source || 'Codex marketplace')}</small></span><span>${official ? '<small>内置官方目录</small>' : `<button type="button" title="更新 marketplace" data-codex-marketplace-upgrade="${escapeAttr(name)}">${iconSvg('refresh')}</button><button type="button" title="移除 marketplace" data-codex-marketplace-remove="${escapeAttr(name)}">${iconSvg('trash')}</button>`}</span></div>`;
    }).join('') || '<small>正在初始化 Codex 官方 marketplace。</small>'}</div>
      <div class="codex-plugin-grid">${visiblePlugins.map(renderCodexPluginCard).join('') || '<div class="plugins-empty">当前 marketplace 中没有匹配的插件。</div>'}</div>
      ${renderPluginPagination('codex', pageInfo)}` : ''}
    </div>` : ''}
  </section>`;
}

function renderCodexPluginCard(plugin = {}) {
  const busy = state.codexPluginBusy === plugin.pluginId;
  const installed = plugin.installed === true;
  const official = OFFICIAL_CODEX_MARKETPLACE_NAMES.has(String(plugin.marketplaceName || ''));
  const recommended = plugin.name === 'github' && official;
  const name = localizedPluginName(plugin);
  const description = localizedPluginDescription(plugin);
  return `<article class="codex-plugin-row ${installed ? 'is-installed' : ''}">
    <span class="codex-plugin-mark">${escapeHtml(String(name || 'P').slice(0, 1).toUpperCase())}</span>
    <div><header><strong>${escapeHtml(name)}</strong>${recommended ? '<b class="codex-plugin-recommended">推荐</b>' : ''}<span>${official ? '官方' : '第三方'} · ${escapeHtml(plugin.marketplaceName || '未知来源')}</span></header><p>${escapeHtml(description || (state.languageMode === 'en' ? 'Codex extension capability' : 'Codex 扩展能力'))}</p><small>v${escapeHtml(plugin.version || '-')} · ${plugin.authPolicy === 'ON_INSTALL' ? '安装时认证' : plugin.authPolicy === 'ON_USE' ? '使用时认证' : '无需额外认证'}</small></div>
    ${installed
      ? `<button class="plugin-try-btn secondary" type="button" data-codex-plugin-remove="${escapeAttr(plugin.pluginId)}" ${busy ? 'disabled' : ''}>${iconSvg('trash')}<span>${busy ? '处理中...' : '卸载'}</span></button>`
      : `<button class="plugin-try-btn plugin-download-btn" type="button" data-codex-plugin-install="${escapeAttr(plugin.pluginId)}" ${busy ? 'disabled' : ''}>${iconSvg('download')}<span>${busy ? '安装中...' : '安装'}</span></button>`}
  </article>`;
}

function renderAttachedSkillManagement(catalog = state.attachedSkillCatalog || {}, allSkills = []) {
  const query = normalizeSearch(state.pluginSearchQuery);
  const skills = [...allSkills]
    .filter((skill) => matchesPluginQuery(skill, query, pluginSearchValues(skill, [skill.skillKey])))
    .sort((left, right) => comparePluginNames(localizedPluginName(left), localizedPluginName(right), left.id, right.id));
  const assignments = Array.isArray(catalog.assignments) ? catalog.assignments : [];
  const assignedSkillIds = new Set(assignments.filter((assignment) => assignment.enabled).map((assignment) => assignment.skillId));
  const busy = Boolean(state.attachedSkillBusy);
  const searchForcedOpen = Boolean(query && skills.length);
  const open = pluginSectionIsOpen('attached', allSkills.length, searchForcedOpen);
  const pageInfo = pluginPageInfo('attached', skills.length);
  const visibleSkills = paginatedPluginItems('attached', skills);
  const inboxPath = catalog?.inbox?.path || '';
  return `<section class="attached-skills plugins-collapsible-section ${open ? 'is-open' : 'is-collapsed'}" aria-label="独立 Skill 管理">
    ${renderPluginSectionToggle({ key: 'attached', title: '独立 Skills', count: skills.length, open, searchForcedOpen, summary: `${assignedSkillIds.size} 已分配` })}
    ${open ? `<div class="plugins-collapsible-body">
      <div class="attached-skill-import">
      ${inboxPath ? `<small class="attached-skill-inbox-hint">${state.languageMode === 'en' ? `Drop Skill folders into <code>${escapeHtml(inboxPath)}</code> to add them automatically.` : `把 Skill 文件夹放入 <code>${escapeHtml(inboxPath)}</code> 可自动添加。`}</small>` : ''}
      ${catalog?.inbox?.lastError ? `<small class="plugin-error">${escapeHtml(clipInline(catalog.inbox.lastError, 240))}</small>` : ''}
      <label><span>Skill 来源</span><input id="attached-skill-source" value="${escapeAttr(state.attachedSkillImportSource || '')}" placeholder="粘贴本地目录或 GitHub 地址" autocomplete="off" /></label>
      <button class="plugin-compact-btn secondary" type="button" data-attached-skill-pick-source ${busy ? 'disabled' : ''}>${iconSvg('folder')}<span>选择目录</span></button>
      <button class="plugin-compact-btn" type="button" data-attached-skill-import ${busy || !String(state.attachedSkillImportSource || '').trim() ? 'disabled' : ''}>${iconSvg('download')}<span>${state.attachedSkillBusy === 'import' ? '安装中...' : '导入 Skill'}</span></button>
      </div>
      ${renderAttachedSkillBatchControls(catalog, skills, busy)}
      ${state.attachedSkillError ? `<small class="plugin-error">${escapeHtml(clipInline(state.attachedSkillError, 240))}</small>` : ''}
      <div class="attached-skill-list">${visibleSkills.map((skill) => renderAttachedSkill(skill, catalog, assignments)).join('') || `<div class="plugins-empty">${query ? '没有匹配的技能或插件。' : '尚未导入独立 Skill。'}</div>`}</div>
      ${renderPluginPagination('attached', pageInfo)}
    </div>` : ''}
  </section>`;
}

function renderAttachedSkillBatchControls(catalog, skills, busy) {
  const targets = catalog.targets || {};
  const options = (label, type, items = []) => items.map((item) => `<option value="${escapeAttr(`${type}:${item.id}`)}">${escapeHtml(item.name || item.id)}</option>`).join('');
  return `<div class="attached-skill-batch" aria-label="批量分配 Skill">
    <strong>批量分配</strong><small>一次选择多个 Skill 和多个目标，统一写入分配。</small>
    <div class="attached-skill-batch-grid">
      <select id="attached-skill-batch-skills" multiple size="4" aria-label="选择多个 Skill">${skills.map((skill) => `<option value="${escapeAttr(skill.id)}">${escapeHtml(localizedPluginName(skill))}</option>`).join('')}</select>
      <select id="attached-skill-batch-targets" multiple size="4" aria-label="选择多个分配目标">${options('部门', 'department', targets.departments)}${options('Agent 类型', 'agent_family', targets.agentFamilies)}${options('员工', 'agent_instance', targets.agentInstances)}</select>
      <select id="attached-skill-batch-enabled" aria-label="批量分配状态"><option value="true">启用</option><option value="false">禁用继承</option></select>
      <button class="plugin-try-btn" type="button" data-attached-skill-batch ${busy ? 'disabled' : ''}>批量应用</button>
    </div>
  </div>`;
}

function renderAttachedSkill(skill, catalog, assignments) {
  const current = assignments.filter((assignment) => assignment.skillId === skill.id);
  const pkg = (catalog.packages || []).find((item) => item.id === skill.packageId);
  const packageId = pkg?.id || skill.packageId || '';
  const name = localizedPluginName(skill);
  const description = localizedPluginDescription(skill);
  const enabledAssignment = current.some((assignment) => assignment.enabled);
  const assignmentStatus = current.length
    ? enabledAssignment ? (state.languageMode === 'en' ? 'Assigned' : '已分配') : (state.languageMode === 'en' ? 'Installed · disabled' : '已安装 · 已禁用')
    : state.languageMode === 'en' ? 'Installed · unassigned' : '已安装 · 未分配';
  return `<article class="attached-skill-row" data-attached-skill-row>
    <header><div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(description)}</p></div><div class="attached-skill-row-actions"><span class="status-badge ${enabledAssignment ? 'status-active' : 'status-idle'}">${escapeHtml(assignmentStatus)}</span><button type="button" title="停用 Skill 包" data-attached-skill-disable-package="${escapeAttr(packageId)}" ${!packageId || state.attachedSkillBusy ? 'disabled' : ''}>${iconSvg('trash')}</button></div></header>
    <div class="attached-skill-assignment-controls">
      <select data-attached-skill-target aria-label="分配目标">${renderAttachedSkillTargets(catalog.targets || {})}</select>
      <select data-attached-skill-enabled aria-label="分配状态"><option value="true">启用</option><option value="false">禁用继承</option></select>
      <button class="plugin-try-btn attached-skill-apply" type="button" data-attached-skill-assign="${escapeAttr(skill.id)}" disabled>应用</button>
    </div>
    <div class="attached-skill-assignments">${current.map((assignment) => `<span>${escapeHtml(attachedSkillScopeLabel(assignment, catalog.targets || {}))}<b>${assignment.enabled ? '启用' : '禁用'}</b><button type="button" aria-label="移除分配" data-attached-skill-unassign data-skill-id="${escapeAttr(skill.id)}" data-scope-type="${escapeAttr(assignment.scopeType)}" data-scope-id="${escapeAttr(assignment.scopeId)}">×</button></span>`).join('') || '<small>尚未分配</small>'}</div>
  </article>`;
}

function renderAttachedSkillTargets(targets) {
  const group = (label, scopeType, items) => (items || []).length
    ? `<optgroup label="${escapeAttr(label)}">${items.map((item) => `<option value="${escapeAttr(`${scopeType}:${item.id}`)}">${escapeHtml(item.name || item.id)}</option>`).join('')}</optgroup>`
    : '';
  return [
    '<option value="">选择目标</option>',
    group('部门', 'department', targets.departments),
    group('Agent 类型', 'agent_family', targets.agentFamilies),
    group('员工', 'agent_instance', targets.agentInstances),
  ].join('');
}

function attachedSkillScopeLabel(assignment, targets) {
  const collection = assignment.scopeType === 'department' ? targets.departments
    : assignment.scopeType === 'agent_family' ? targets.agentFamilies : targets.agentInstances;
  const target = (collection || []).find((item) => item.id === assignment.scopeId);
  const prefix = assignment.scopeType === 'department' ? '部门' : assignment.scopeType === 'agent_family' ? 'Agent 类型' : '员工';
  return `${prefix}：${target?.name || assignment.scopeId}`;
}

function normalizeSearch(value) {
  return viewDeps.normalizeSearch?.(value) || String(value || '').trim().toLowerCase();
}

function loadPluginCatalog(...args) {
  return (viewDeps.loadPluginCatalog || viewDeps.loadPptxPluginStatus)?.(...args);
}

function pluginCatalog() {
  const remote = Array.isArray(state.pluginCatalog) ? state.pluginCatalog : [];
  const source = remote.length ? remote : FALLBACK_PLUGIN_CATALOG;
  return source.map((plugin) => {
    const fallback = FALLBACK_PLUGIN_CATALOG.find((item) => item.id === plugin.id) || {};
    const status = plugin.status || (plugin.id === 'ppt_creation' ? state.pptxPluginStatus : null) || {};
    return {
      ...fallback,
      ...plugin,
      status,
      tags: plugin.tags || fallback.tags || [],
      capabilities: plugin.capabilities || fallback.capabilities || [],
      providesAgentIds: plugin.providesAgentIds || fallback.providesAgentIds || [],
      permissions: plugin.permissions || fallback.permissions || [],
      chatTarget: plugin.chatTarget || fallback.chatTarget || '',
    };
  });
}

function renderPluginDirectory(plugins = pluginCatalog()) {
  const statusKnown = state.pluginCatalog?.length || state.pptxPluginStatus !== null;
  if (!statusKnown && !state.pptxPluginStatusLoading) setTimeout(() => loadPluginCatalog(), 0);
  const loading = !statusKnown || state.pptxPluginStatusLoading;
  const query = normalizeSearch(state.pluginSearchQuery);
  const filter = ['all', 'installed', 'available'].includes(state.pluginFilter) ? state.pluginFilter : 'all';
  const category = state.pluginCategory || 'all';
  const sort = state.pluginSort || 'name';
  const categories = [...new Map(plugins.map((plugin) => [plugin.category || 'other', plugin.categoryLabel || '其他'])).entries()];
  const installedCount = plugins.filter((plugin) => Boolean(plugin.status.installed)).length;
  const availableCount = plugins.filter((plugin) => !plugin.status.installed && plugin.status.available !== false).length;
  const visiblePlugins = plugins
    .filter((plugin) => {
      if (!matchesPluginQuery(plugin, query, pluginSearchValues(plugin, [plugin.id, plugin.categoryLabel, ...(plugin.tags || []), ...(plugin.capabilities || [])]))) return false;
      if (filter === 'installed' && !plugin.status.installed) return false;
      if (filter === 'available' && plugin.status.installed) return false;
      if (category !== 'all' && plugin.category !== category) return false;
      return true;
    })
    .sort((left, right) => comparePlugins(left, right, sort));
  const searchForcedOpen = Boolean(query && visiblePlugins.length);
  const open = pluginSectionIsOpen('managed', plugins.length, searchForcedOpen);
  const pageInfo = pluginPageInfo('managed', visiblePlugins.length);
  const paginatedPlugins = paginatedPluginItems('managed', visiblePlugins);

  return `<section class="plugins-catalog plugins-collapsible-section ${open ? 'is-open' : 'is-collapsed'}">
    ${renderPluginSectionToggle({ key: 'managed', title: 'Janus 自研技能', description: '每个技能独立安装，不占用人才配额。', count: visiblePlugins.length, open, searchForcedOpen })}
    ${open ? `<div class="plugins-collapsible-body">
      <div class="plugins-managed-controls">
        <div class="plugins-filter" aria-label="筛选技能">
        ${renderFilterButton('all', '全部', plugins.length)}
        ${renderFilterButton('installed', '已安装', installedCount)}
        ${renderFilterButton('available', '可安装', availableCount)}
        </div>
        <div class="plugins-catalog-controls">
          <label><span>类别</span><select id="plugin-category-select"><option value="all">全部类别</option>${categories.map(([value, label]) => `<option value="${escapeAttr(value)}" ${category === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>
          <label><span>排序</span><select id="plugin-sort-select"><option value="name" ${sort === 'name' ? 'selected' : ''}>名称</option><option value="recommended" ${sort === 'recommended' ? 'selected' : ''}>推荐顺序</option><option value="installed" ${sort === 'installed' ? 'selected' : ''}>已安装优先</option></select></label>
        </div>
      </div>
      <div class="plugins-grid">${paginatedPlugins.map((plugin) => renderPluginCard(plugin, { loading })).join('') || renderPluginEmpty(query, filter)}</div>
      ${renderPluginPagination('managed', pageInfo)}
    </div>` : ''}
  </section>`;
}

function comparePlugins(left, right, sort) {
  const byName = comparePluginNames(localizedPluginName(left), localizedPluginName(right), left.id, right.id);
  if (sort === 'name') return byName;
  if (sort === 'installed') return Number(Boolean(right.status.installed)) - Number(Boolean(left.status.installed)) || byName;
  return Number(left.recommendedOrder || 1000) - Number(right.recommendedOrder || 1000) || byName;
}

function pluginDisplayName(plugin = {}) {
  return localizedPluginName(plugin);
}

function localizedPluginName(item = {}) {
  const metadata = item.metadata || {};
  if (state.languageMode === 'en') {
    return item.displayNameEn || item.nameEn || metadata.displayNameEn || metadata.nameEn
      || item.displayName || item.name || item.pluginId || item.id || '';
  }
  return item.displayNameZhCn || item.displayNameZh || item.nameZhCn || item.nameZh
    || metadata.displayNameZhCn || metadata.displayNameZh || metadata.nameZhCn || metadata.nameZh
    || item.displayName || item.name || item.pluginId || item.id || '';
}

function localizedPluginDescription(item = {}, { long = false } = {}) {
  const metadata = item.metadata || {};
  if (state.languageMode === 'en') {
    if (long) return item.longDescriptionEn || metadata.longDescriptionEn || item.descriptionEn || metadata.descriptionEn
      || item.longDescription || item.description || '';
    return item.descriptionEn || metadata.descriptionEn || item.description || '';
  }
  if (long) return item.longDescriptionZhCn || item.longDescriptionZh || metadata.longDescriptionZhCn || metadata.longDescriptionZh
    || item.descriptionZhCn || item.descriptionZh || metadata.descriptionZhCn || metadata.descriptionZh
    || item.longDescription || item.description || '';
  return item.descriptionZhCn || item.descriptionZh || metadata.descriptionZhCn || metadata.descriptionZh
    || item.description || '';
}

function pluginSearchValues(item = {}, extra = []) {
  const metadata = item.metadata || {};
  return [
    item.displayName, item.name, item.displayNameEn, item.displayNameZhCn, item.displayNameZh,
    item.nameEn, item.nameZhCn, item.nameZh, item.description, item.descriptionEn,
    item.descriptionZhCn, item.descriptionZh, item.longDescription, item.longDescriptionEn,
    item.longDescriptionZhCn, item.longDescriptionZh, metadata.displayNameEn,
    metadata.displayNameZhCn, metadata.displayNameZh, metadata.descriptionEn,
    metadata.descriptionZhCn, metadata.descriptionZh, ...extra,
  ];
}

function comparePluginNames(leftName = '', rightName = '', leftId = '', rightId = '') {
  return PLUGIN_NAME_COLLATOR.compare(String(leftName || ''), String(rightName || ''))
    || PLUGIN_NAME_COLLATOR.compare(String(leftId || ''), String(rightId || ''));
}

function matchesPluginQuery(item, query, values = []) {
  if (!query) return true;
  return normalizeSearch(values.filter(Boolean).join(' ')).includes(query);
}

function pluginSectionIsOpen(key, itemCount, searchForcedOpen = false) {
  if (searchForcedOpen && key !== 'attached') return true;
  const explicit = state.pluginSectionsOpen?.[key];
  if (typeof explicit === 'boolean') return explicit;
  if (key === 'managed' || key === 'attached') return false;
  return Number(itemCount || 0) <= PLUGIN_PAGE_SIZE;
}

function paginatedPluginItems(key, items = []) {
  const page = pluginPageInfo(key, items.length).page;
  return items.slice(page * PLUGIN_PAGE_SIZE, (page + 1) * PLUGIN_PAGE_SIZE);
}

function pluginPageInfo(key, totalCount = 0) {
  const total = Math.max(0, Number(totalCount) || 0);
  const pageCount = Math.max(1, Math.ceil(total / PLUGIN_PAGE_SIZE));
  const requested = Math.max(0, Number(state.pluginPageIndexes?.[key]) || 0);
  const page = Math.min(requested, pageCount - 1);
  return { key, total, page, pageCount, hasPrevious: page > 0, hasNext: page < pageCount - 1 };
}

function renderPluginSectionToggle({ key = '', title = '', description = '', count = 0, open = true, searchForcedOpen = false, summary = '' } = {}) {
  return `<button class="plugins-section-toggle" type="button" data-plugin-section-toggle="${escapeAttr(key)}" aria-expanded="${open ? 'true' : 'false'}" ${searchForcedOpen && key !== 'attached' ? 'disabled title="搜索期间自动展开"' : ''}>
    <span class="plugins-section-toggle-copy"><strong>${escapeHtml(title)}</strong>${description ? `<small>${escapeHtml(description)}</small>` : ''}</span>
    <span class="plugins-section-toggle-meta">${summary ? `<small>${escapeHtml(summary)}</small>` : ''}<b>${Number(count || 0)} 项</b><i>${iconSvg(open ? 'chevronDown' : 'chevronRight')}</i></span>
  </button>`;
}

function renderPluginPagination(key, pageInfo = {}) {
  if (!pageInfo.total || pageInfo.pageCount <= 1) return '';
  const current = pageInfo.page + 1;
  return `<nav class="plugins-pagination" aria-label="${escapeAttr(state.languageMode === 'en' ? 'Plugin and Skill pages' : '技能与插件分页')}">
    <button type="button" data-plugin-page="${escapeAttr(key)}" data-page-direction="previous" ${pageInfo.hasPrevious ? '' : 'disabled'}>${state.languageMode === 'en' ? 'Previous' : '上一页'}</button>
    <span>${state.languageMode === 'en' ? `Page ${current} / ${pageInfo.pageCount} · ${pageInfo.total} items` : `第 ${current} / ${pageInfo.pageCount} 页 · 共 ${pageInfo.total} 项`}</span>
    <button type="button" data-plugin-page="${escapeAttr(key)}" data-page-direction="next" ${pageInfo.hasNext ? '' : 'disabled'}>${state.languageMode === 'en' ? 'Next' : '下一页'}</button>
  </nav>`;
}

function renderFilterButton(value, label, count) {
  const active = (state.pluginFilter || 'all') === value;
  return `<button class="${active ? 'active' : ''}" type="button" data-plugin-filter="${escapeAttr(value)}">${escapeHtml(label)}<span>${Number(count || 0)}</span></button>`;
}

function renderPluginEmpty(query, filter) {
  if (query) return '<div class="plugins-empty">没有匹配的技能或插件。</div>';
  if (filter === 'installed') return '<div class="plugins-empty">还没有安装任何扩展技能。</div>';
  if (filter === 'available') return '<div class="plugins-empty">当前没有新的可安装技能。</div>';
  return '<div class="plugins-empty">技能目录暂时为空。</div>';
}

function renderPluginCard(plugin, { loading = false } = {}) {
  const status = plugin.status || {};
  const operation = state.pluginOperations?.[plugin.id] || {};
  const installed = Boolean(status.installed);
  const ready = status.ready !== false;
  const busy = Boolean(operation.busy);
  const canDownload = status.available && !busy;
  const statusText = loading ? '正在检测安装状态' : installed && !ready ? '运行环境未就绪' : installed ? '技能已下载' : status.available ? '未下载' : status.error ? '不可用' : '等待检测';
  const statusSuffix = installed && plugin.id === 'ppt_creation' ? ' · 3 种风格' : '';
  const menuOpen = state.pluginMenuOpenId === plugin.id;
  const menuPosition = state.pluginMenuPosition || {};
  const menuStyle = Number.isFinite(menuPosition.x) && Number.isFinite(menuPosition.y) ? ` style="left:${Math.round(menuPosition.x)}px;top:${Math.round(menuPosition.y)}px"` : '';
  const name = localizedPluginName(plugin);
  const description = localizedPluginDescription(plugin);
  return `
    <article class="plugin-card ${installed ? 'is-installed' : ''}">
      <header class="plugin-card-head"><span class="plugin-card-icon">${iconSvg(plugin.icon || 'spark')}</span><div class="plugin-card-title"><small>${escapeHtml(plugin.categoryLabel || '扩展能力')}</small><strong>${escapeHtml(name)}</strong></div>${renderStatusBadge(loading || (installed && !ready) ? 'pending' : installed ? 'active' : 'idle')}</header>
      <p>${escapeHtml(description)}</p>
      <div class="plugin-card-tags">${(plugin.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="plugin-card-status"><span>${escapeHtml(`${statusText}${statusSuffix}`)}</span>${installed && status.version ? `<small>v${escapeHtml(status.version)}</small>` : ''}</div>
      ${renderPluginInstallProgress(plugin.id, operation)}
      ${(status.error || status.missing) && (!installed || !ready) ? `<small class="plugin-error">${escapeHtml(clipInline(userVisibleErrorMessage(status.missing || status.error), 160))}</small>` : ''}
      <footer class="plugin-card-actions">
        <button class="plugin-try-btn secondary" type="button" data-plugin-detail="${escapeAttr(plugin.id)}">查看详情</button>
        ${installed && ready && plugin.chatTarget ? `<button class="plugin-try-btn" type="button" data-plugin-chat="${escapeAttr(plugin.chatTarget)}" data-plugin-id="${escapeAttr(plugin.id)}">立即使用</button>` : ''}
        ${!loading && !installed ? `<button class="plugin-try-btn plugin-download-btn" type="button" data-plugin-install="${escapeAttr(plugin.id)}" ${canDownload ? '' : 'disabled'}>${iconSvg('download')}<span>${busy ? '安装中...' : '安装'}</span></button>` : ''}
        ${installed ? `<div class="plugin-more-wrap"><button class="plugin-more-btn" type="button" data-plugin-more="${escapeAttr(plugin.id)}" aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}">${iconSvg('more')}</button>${menuOpen ? `<div class="plugin-menu" role="menu"${menuStyle}><button type="button" data-plugin-open-files="${escapeAttr(plugin.id)}" role="menuitem">${iconSvg('folder')}<span>访问文件</span></button><button type="button" data-plugin-uninstall="${escapeAttr(plugin.id)}" role="menuitem" ${busy ? 'disabled' : ''}>${iconSvg('trash')}<span>卸载</span></button></div>` : ''}</div>` : ''}
      </footer>
    </article>`;
}

function renderPluginInstallProgress(pluginId, operation = {}) {
  const progress = operation.progress || (pluginId === 'ppt_creation' ? state.pluginInstallProgress : null);
  if (!operation.busy || !progress) return '';
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  return `<div class="plugin-install-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="plugin-install-progress-copy"><span>${escapeHtml(progress.message || '正在安装技能…')}</span><strong>${percent}%</strong></div><i><b style="width:${percent}%"></b></i></div>`;
}

function renderPluginDetail(plugins) {
  const plugin = plugins.find((item) => item.id === state.pluginDetailId);
  if (!plugin) return '';
  const status = plugin.status || {};
  const operation = state.pluginOperations?.[plugin.id] || {};
  const dependencies = Array.isArray(status.dependencies) ? status.dependencies : [];
  const name = localizedPluginName(plugin);
  const description = localizedPluginDescription(plugin, { long: true });
  return `<div class="plugin-detail-layer"><button class="plugin-detail-backdrop" type="button" data-plugin-detail-close aria-label="关闭插件详情"></button><aside class="plugin-detail-drawer" role="dialog" aria-modal="true" aria-label="${escapeAttr(name)}详情"><header><div><span>${escapeHtml(plugin.categoryLabel || '扩展能力')}</span><h2>${escapeHtml(name)}</h2><p>${escapeHtml(description)}</p></div><button class="plugin-detail-close" type="button" data-plugin-detail-close aria-label="关闭">×</button></header>
    <section><h3>提供能力</h3><div class="plugin-detail-tags">${(plugin.capabilities || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('') || '<small>暂无能力说明。</small>'}</div></section>
    <section><h3>提供的 Agent</h3><div class="plugin-detail-list">${(plugin.providesAgentIds || []).map((id) => `<span>${escapeHtml(agentDisplayName(id))}</span>`).join('') || '<small>不提供独立 Agent。</small>'}</div></section>
    <section><h3>运行权限</h3><ul>${(plugin.permissions || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>无需额外权限。</li>'}</ul></section>
    <section><h3>运行环境</h3>${status.installed && status.ready === false ? '<strong class="plugin-runtime-status">运行环境未就绪</strong>' : ''}<div class="plugin-detail-facts"><span><small>版本</small><strong>${escapeHtml(status.version || status.availableVersion || '-')}</strong></span><span><small>来源</small><strong>${escapeHtml(status.source || '-')}</strong></span><span><small>运行时</small><strong>${escapeHtml(status.runtimeMode === 'bundled' ? '内置 Python' : status.runtimeMode === 'system' ? '系统 Python' : '未检测到')}</strong></span><span><small>依赖</small><strong>${dependencies.length ? `${dependencies.filter((item) => item.installed).length}/${dependencies.length}` : '无'}</strong></span></div>${status.installed && status.ready === false ? `<small class="plugin-error">${escapeHtml(clipInline(userVisibleErrorMessage(status.missing || status.error), 220))}</small>` : ''}</section>
    <footer>${status.installed && status.ready !== false && plugin.chatTarget ? `<button class="plugin-try-btn" type="button" data-plugin-chat="${escapeAttr(plugin.chatTarget)}" data-plugin-id="${escapeAttr(plugin.id)}">立即使用</button>` : `<button class="plugin-try-btn plugin-download-btn" type="button" data-plugin-install="${escapeAttr(plugin.id)}" ${status.available && !operation.busy ? '' : 'disabled'}>${iconSvg('download')}<span>${operation.busy ? '安装中...' : status.installed ? '修复运行环境' : '安装'}</span></button>`}</footer>
  </aside></div>`;
}

function agentDisplayName(agentId) {
  return ({ ppt: 'PPT Designer' })[agentId] || agentId;
}
