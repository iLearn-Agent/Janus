import { state } from '../state.js';
import { iconSvg } from '../ui/icons.js';
import { escapeAttr, escapeHtml, formatDateTime } from '../utils/format.js';
import { agentAvatarTone, agentInstanceDisplayNameForUi, renderAgentAvatarContent } from '../utils/agentIdentity.js';
import { renderAgentWorkStatus } from '../components/agentWorkStatus.js';
import { agentWorkStatusFor } from '../features/ubuddy/coordinationState.js';
import { agentInstanceSequenceLabel, canonicalAgentFamilyName } from '../../../shared/agentInstanceNaming.js';
import { isLegacyGeneralAgentId } from '../../../shared/generalAgents.js';

export function renderEmployees() {
  const overview = state.employeeOverview || {};
  const candidates = marketCandidates(overview.recruitableFamilies || []);
  const departments = marketDepartments(candidates);
  const recruitable = filterMarketCandidates(candidates);
  const groups = groupMarketCandidates(recruitable);
  const installed = marketEmployeeGroups(overview.roster || []);

  return `<div class="view employees-view talent-directory-view" data-page-kind="employees" role="region" aria-labelledby="employees-page-title">
    <header class="talent-directory-hero">
      <div class="talent-directory-title">
        <div><h1 id="employees-page-title">人才市场</h1><p>人才模板常驻展示，可按需重复招募；每名员工都有独立聊天、Memory 与成长档案。</p></div>
      </div>
      <div class="talent-directory-tools">${renderEmployeeQuota(overview.quota)}</div>
    </header>
    ${renderEmployeeConflict()}
    ${renderEmployeeCloudReadinessNotice()}
    ${renderMarketBrowser({ installed })}
    <section class="talent-directory-section ${state.employeeMarketSpotlight ? 'is-message-home-spotlight' : ''}">
      <header class="talent-directory-section-head"><h2>精选人才</h2>${renderMarketFilterMenu(departments)}</header>
      <div class="talent-directory-groups">${groups.map(renderMarketGroup).join('')}</div>
    </section>
    ${renderEmployeeContextMenu()}
    ${renderMarketCandidateDrawer()}
    ${renderEmployeeOverviewDrawer()}
    ${renderMemoryDrawer()}
    ${renderMarketDrawer()}
    ${renderGrowthDrawer()}
    ${renderLeadershipDecisionDialog()}
  </div>`;
}

export function renderEmployeeQuota(quota = {}) {
  const limit = Math.max(1, Number(quota.limit) || 10);
  const used = Math.max(0, Number(quota.used) || 0);
  const remaining = Math.max(0, Number.isFinite(Number(quota.remaining)) ? Number(quota.remaining) : limit - used);
  const reserved = Math.max(0, Number(quota.reserved) || 0);
  const percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  const tone = used >= limit ? ' is-full' : percent >= 80 ? ' is-near-limit' : '';
  const detail = quota.grandfatheredOverLimit
    ? `已超出当前额度 ${Math.max(0, used - limit)} 名，现有员工不受影响`
    : `剩余 ${remaining} 名${reserved ? ` · ${reserved} 名确认中` : ''}`;
  return `<div class="talent-directory-quota${tone}" aria-label="员工额度 ${used} / ${limit}，${detail}">
    <div class="talent-directory-quota-head"><span>员工额度</span><strong>${used} / ${limit}</strong></div>
    <div class="talent-directory-quota-progress" role="progressbar" aria-label="员工额度使用进度" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${Math.min(used, limit)}"><i style="width:${percent}%"></i></div>
    <small>${escapeHtml(detail)}</small>
  </div>`;
}

function marketEmployeeGroups(items = []) {
  const employees = items.filter((item) => item.agentFamilyId !== 'secretary_agent');
  return {
    active: employees.filter((item) => !employeeLocallyInactive(item)),
    inactive: employees.filter(employeeLocallyInactive),
  };
}

function marketCandidates(items = []) {
  const normalized = items.filter((item) => {
    if (item.id === 'secretary_agent' || item.agentFamilyId === 'secretary_agent') return false;
    if (isLegacyGeneralAgentId(item.id || item.agentFamilyId)) return false;
    return item.recruitable !== false && !['retired', 'archived', 'disabled'].includes(String(item.status || '').toLowerCase());
  }).map(normalizeMarketCandidate);
  const categoryCounts = new Map();
  for (const item of normalized) {
    const key = marketCandidateCategoryKey(item);
    categoryCounts.set(key, Number(categoryCounts.get(key) || 0) + 1);
  }
  const categoryOrdinals = new Map();
  return normalized.map((item) => {
    const key = marketCandidateCategoryKey(item);
    if (Number(categoryCounts.get(key) || 0) <= 1) return item;
    const ordinal = Number(categoryOrdinals.get(key) || 0) + 1;
    categoryOrdinals.set(key, ordinal);
    return { ...item, name: `${item.name} ${agentInstanceSequenceLabel(ordinal)}` };
  });
}

function normalizeMarketCandidate(item = {}) {
  const id = item.id || item.agentFamilyId || '';
  return { ...item, name: canonicalAgentFamilyName(id, item.name || id) };
}

function marketCandidateCategoryKey(item = {}) {
  return `${item.departmentId || item.department_id || 'general'}\u001f${item.name || ''}`;
}

function marketDepartments(items = []) {
  const labels = new Map();
  items.forEach((item) => {
    const id = item.departmentId || item.department_id || '';
    if (id) labels.set(id, talentDepartmentLabel(id));
  });
  return [...labels.entries()].sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'));
}

function groupMarketCandidates(items = []) {
  const groups = new Map();
  items.forEach((item) => {
    const departmentId = item.departmentId || item.department_id || 'general';
    const group = groups.get(departmentId) || {
      id: departmentId,
      label: talentDepartmentLabel(departmentId),
      items: [],
    };
    group.items.push(item);
    groups.set(departmentId, group);
  });
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

function renderMarketGroup(group = {}, groupIndex = 0) {
  if (!group.items?.length) return '';
  return `<section class="talent-directory-group ${group.items.length === 1 ? 'is-singleton' : 'is-multi'}" aria-labelledby="talent-group-${escapeAttr(group.id || groupIndex)}">
    <h3 id="talent-group-${escapeAttr(group.id || groupIndex)}">${escapeHtml(group.label || '专业人才')}</h3>
    <div class="talent-directory-grid">${group.items.map((item, index) => renderRecruitableCard(item, groupIndex * 6 + index)).join('')}</div>
  </section>`;
}

function filterMarketCandidates(items = []) {
  const query = normalizeMarketSearch(state.employeeMarketQuery);
  const requestedDepartment = state.employeeMarketDepartmentFilter || 'all';
  const department = requestedDepartment === 'all'
    || items.some((item) => (item.departmentId || item.department_id || '') === requestedDepartment)
    ? requestedDepartment
    : 'all';
  return items.filter((item) => {
    const itemDepartment = item.departmentId || item.department_id || '';
    if (department !== 'all' && itemDepartment !== department) return false;
    if (!query) return true;
    const departmentLabel = talentDepartmentLabel(itemDepartment);
    const searchable = [
      item.id,
      item.agentFamilyId,
      item.name,
      departmentLabel,
      item.metadata?.summary,
      item.metadata?.description,
      ...talentSkillTags(item, departmentLabel),
    ].map(normalizeMarketSearch).join(' ');
    return searchable.includes(query);
  });
}

function renderMarketBrowser({ installed = { active: [], inactive: [] } } = {}) {
  const query = normalizeMarketSearch(state.employeeMarketQuery);
  const filterEmployees = (items = []) => items.filter((item) => {
    if (!query) return true;
    return [employeeDisplayName(item), item.note, item.family?.name, item.agentFamilyId]
      .map(normalizeMarketSearch).join(' ').includes(query);
  });
  const active = filterEmployees(installed.active || []);
  const inactive = filterEmployees(installed.inactive || []);
  return `<section class="talent-directory-browser" aria-label="搜索人才">
    <label class="talent-directory-search">${iconSvg('search')}<input id="employee-market-search" type="search" value="${escapeAttr(state.employeeMarketQuery || '')}" placeholder="搜索人才" autocomplete="off" /></label>
    <div class="talent-directory-installed ${state.employeeMarketSpotlight ? 'is-message-home-spotlight' : ''}">
      <header><h2>我的员工</h2></header>
      ${renderInstalledEmployeeGroup('在职员工', active, 'active')}
      ${renderInstalledEmployeeGroup('已停用员工', inactive, 'inactive')}
    </div>
  </section>`;
}

function renderInstalledEmployeeGroup(label, items = [], kind = 'active') {
  const actionErrors = items.map((item) => ({
    name: employeeDisplayName(item),
    message: state.employeeMarketActionErrors?.[item.id] || '',
  })).filter((item) => item.message);
  return `<section class="talent-directory-installed-group is-${escapeAttr(kind)}"><header><strong>${escapeHtml(label)}</strong><span>${items.length}</span></header><div class="talent-directory-installed-list">${items.length
    ? items.map((item, index) => renderInstalledTalent(item, index)).join('')
    : `<span class="talent-directory-installed-empty">${kind === 'inactive' ? '暂无已停用员工' : '暂无在职员工'}</span>`}</div>${actionErrors.length
      ? `<div class="talent-directory-installed-errors" role="alert">${actionErrors.map((item) => `<span><strong>${escapeHtml(item.name)}</strong>${escapeHtml(item.message)}</span>`).join('')}</div>`
      : ''}</section>`;
}

function renderMarketFilterMenu(departments = []) {
  const departmentIds = new Set(departments.map(([id]) => id));
  const selectedDepartment = departmentIds.has(state.employeeMarketDepartmentFilter)
    ? state.employeeMarketDepartmentFilter
    : 'all';
  return `<details class="talent-directory-filter-menu">
    <summary aria-label="筛选人才">${iconSvg('sliders')}</summary>
    <div class="talent-directory-filters" role="menu" aria-label="按部门筛选人才">
      ${renderMarketFilterOption('all', '全部', selectedDepartment)}
      ${departments.map(([id, label]) => renderMarketFilterOption(id, label, selectedDepartment)).join('')}
    </div>
  </details>`;
}

function renderMarketFilterOption(id = 'all', label = '全部', selectedDepartment = 'all') {
  const selected = id === selectedDepartment;
  return `<button type="button" role="menuitemradio" aria-checked="${selected ? 'true' : 'false'}" class="${selected ? 'is-selected' : ''}" data-employee-market-department-option="${escapeAttr(id)}"><span>${escapeHtml(label)}</span>${selected ? iconSvg('check') : ''}</button>`;
}

function renderInstalledTalent(item = {}, index = 0) {
  const name = employeeDisplayName(item);
  const inactive = employeeLocallyInactive(item);
  const starred = employeeIsStarred(item.id);
  const plugin = requiredPluginForAgent(item.agentFamilyId);
  const setupRequired = Boolean(plugin && plugin.status?.installed === false);
  const chatAction = inactive
    ? `data-employee-market-reactivate="${escapeAttr(item.id || '')}" data-state-revision="${Number(item.stateRevision || 0)}"`
    : item.routeEligible
    ? `data-employee-open-chat="${escapeAttr(item.id || '')}"`
    : setupRequired
      ? `data-open-plugin-settings data-plugin-id="${escapeAttr(plugin.id)}" data-plugin-agent-family="${escapeAttr(item.agentFamilyId || '')}"`
      : `data-employee-open-chat="${escapeAttr(item.id || '')}"`;
  const hint = inactive ? '左键重新启用，右键管理' : item.routeEligible ? '左键对话，右键管理' : setupRequired ? `左键安装${plugin.name || '所需技能'}，右键管理` : '左键刷新状态并对话，右键管理';
  const workStatus = agentWorkStatusFor(state, item);
  return `<button type="button" class="talent-directory-installed-item ${inactive ? 'is-inactive' : ''} ${setupRequired ? 'is-setup-required' : ''} ${!inactive && !item.routeEligible && !setupRequired ? 'is-route-pending' : ''} ${starred ? 'is-starred' : ''}" data-employee-installed-context="${escapeAttr(item.id || '')}" ${chatAction} title="${escapeAttr(`${name} · ${hint}${starred ? ' · 已星标' : ''}`)}" aria-label="${escapeAttr(`${name}，${workStatus.availability === 'working' ? '工作中' : '空闲'}，${hint}${starred ? '，已星标' : ''}`)}"><span class="talent-directory-avatar tone-${agentAvatarTone(item.agentFamilyId, name)}">${renderAgentAvatarContent(item.agentFamilyId, name)}</span><span class="talent-directory-installed-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(talentDepartmentLabel(item.family?.departmentId || ''))}</small>${renderAgentWorkStatus(workStatus, { lifecycleLabel: inactive ? '已停用' : '' })}</span>${starred ? `<span class="talent-directory-installed-star" aria-label="已设为星标员工">${iconSvg('star')}</span>` : ''}</button>`;
}

function renderEmployeeContextMenu() {
  const menu = state.employeeContextMenu;
  const employee = employeeById(menu?.agentInstanceId || '');
  if (!menu || !employee) return '';
  const inactive = employeeLocallyInactive(employee);
  const starred = employeeIsStarred(employee.id);
  const left = Math.max(8, Number(menu.x) || 8);
  const top = Math.max(8, Number(menu.y) || 8);
  return `<div class="employee-context-menu-layer" data-employee-context-menu-dismiss>
    <div class="employee-context-menu" role="menu" aria-label="${escapeAttr(employeeDisplayName(employee))} 管理" style="left:${left}px;top:${top}px" data-employee-context-agent="${escapeAttr(employee.id || '')}">
      <button type="button" role="menuitem" data-employee-context-action="profile">${iconSvg('edit')}<span>编辑名称与备注</span></button>
      <button type="button" role="menuitemcheckbox" aria-checked="${starred ? 'true' : 'false'}" data-employee-context-action="toggle-star">${iconSvg('star')}<span>${starred ? '取消星标员工' : '设为星标员工'}</span></button>
      <button type="button" role="menuitem" data-employee-context-action="memory">${iconSvg('memory')}<span>记忆与进化</span></button>
      <button type="button" role="menuitem" data-employee-context-action="versions">${iconSvg('evolution')}<span>版本管理</span></button>
      ${inactive
        ? `<button type="button" role="menuitem" data-employee-context-action="reactivate" ${employeeLifecycleMutationEnabled() ? '' : 'disabled title="请先登录并连接云端账号"'}>${iconSvg('refresh')}<span>重新启用</span></button>`
        : `<button class="danger" type="button" role="menuitem" data-employee-context-action="deactivate" ${employeeLifecycleMutationEnabled() ? '' : 'disabled title="请先登录并连接云端账号"'}>${iconSvg('trash')}<span>停用员工</span></button>`}
    </div>
  </div>`;
}

function normalizeMarketSearch(value = '') {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

export function renderEmployeeOverlays() {
  return `${renderEmployeeContextMenu()}
    ${renderEmployeeOverviewDrawer()}
    ${renderMemoryDrawer()}
    ${renderMarketDrawer()}
    ${renderGrowthDrawer()}
    ${renderLeadershipDecisionDialog()}`;
}

function renderClusterEvolutionOverview() {
  const overview = state.clusterEvolutionOverview || {};
  const capability = state.stage8EvolutionStatus?.cluster || {};
  const market = state.stage8EvolutionStatus?.market || {};
  const cohorts = Array.isArray(overview.cohorts) ? overview.cohorts : [];
  const runs = Array.isArray(overview.runs) ? overview.runs : [];
  const candidates = Array.isArray(overview.candidates) ? overview.candidates : [];
  const activeRuns = runs.filter((item) => ['queued', 'claimed', 'running', 'proposed'].includes(item.status));
  const activeCandidates = candidates.filter((item) => !['released', 'archived', 'rolled_back'].includes(item.status));
  const latest = [...candidates].sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0];
  const marketUnavailable = market.enabled === false && market.queryAvailable !== true;
  const generationPaused = !marketUnavailable && (capability.executionAvailable === false || market.candidateGenerationAvailable === false);
  const latestStatus = latest?.status || (marketUnavailable ? '市场不可用' : generationPaused ? '等待云端定时任务' : '等待数据');
  const summary = marketUnavailable
    ? employeeStatusMessage(market.code || capability.code, '市场版本检测暂不可用，本地聊天和已采用 Skill 不受影响。')
    : generationPaused
      ? '云端定时集群进化暂未产出新候选；已发布市场 Skill 仍可检测、下载、采用和回滚。'
      : '策略 cluster_active_synced_mandatory_v1 · 单用户权重不超过 15% · 发布章节至少需要 3 位用户证据支持。';
  return `<section class="talent-cluster-overview ${marketUnavailable ? 'is-unavailable' : generationPaused ? 'is-generation-paused' : ''}" aria-label="公司集群进化状态"><header><div><span>${iconSvg('network')}</span><div><strong>公司集群进化</strong><small>云端按计划生成候选；你只需检测、下载并决定是否采用市场 Skill。</small></div></div><button class="mini-btn muted" type="button" data-cluster-evolution-refresh ${state.clusterEvolutionRefreshBusy ? 'disabled' : ''}>${state.clusterEvolutionRefreshBusy ? '刷新中' : '刷新'}</button></header><div class="talent-cluster-metrics"><span><small>Cohort</small><strong>${cohorts.length}</strong></span><span><small>运行中</small><strong>${activeRuns.length}</strong></span><span><small>候选</small><strong>${activeCandidates.length}</strong></span><span><small>最近状态</small><strong>${escapeHtml(latestStatus)}</strong></span></div><p>${escapeHtml(summary)}</p></section>`;
}

function renderEmployeeConflict() {
  const conflict = state.employeeConflict;
  if (!conflict) return '';
  const currentRevision = conflict.details?.currentRevision ?? conflict.details?.current_revision;
  return `<div class="employee-warning employee-conflict" role="alert"><div><strong>员工状态已在其他设备更新</strong><span>${escapeHtml(currentRevision === undefined ? '已刷新最新状态，请确认后重试。' : `云端当前 revision：${currentRevision}。请确认最新状态后重试。`)}</span></div><button type="button" data-employee-conflict-dismiss>知道了</button></div>`;
}

function renderEmployeeOverviewDrawer() {
  if (!state.employeeSelectedInstanceId || state.employeeDetailTab !== 'overview') return '';
  const employee = employeeById(state.employeeSelectedInstanceId);
  if (!employee) return '';
  const family = employee.family || {};
  const performance = normalizePerformance(employee.performance, employee.progressionSync);
  const leadership = normalizeLeadership(employee.leadership, employee.progressionSync);
  const currentMemoryId = employee.currentContext?.activeMemoryDocumentId || '';
  const currentMemoryApplied = Boolean(employee.currentMemory?.id && currentMemoryId === employee.currentMemory.id);
  const currentMarketVersion = employee.marketEffectiveSkill?.marketVersionId || '';
  const currentSkill = skillVersionPresentation(currentMarketVersion, employee.availableMarketVersions || []);
  const currentMemory = employee.currentMemory
    ? memoryDocumentPresentation(employee.currentMemory)
    : { title: '暂无记忆', summary: '新建记忆后可保存长期偏好和复用经验' };
  const displayName = employeeDisplayName(employee);
  const starred = employeeIsStarred(employee.id);
  const workStatus = agentWorkStatusFor(state, employee);
  return `<div class="employee-drawer-layer"><button class="employee-drawer-backdrop" type="button" data-employee-detail-close aria-label="关闭 Agent 详情"></button><aside class="employee-memory-drawer employee-overview-drawer" role="dialog" aria-modal="true" aria-label="Agent 详情"><header><div><span class="employee-drawer-kicker">${escapeHtml(family.name || employee.agentFamilyId || 'Agent')}</span><h2>${escapeHtml(displayName)}</h2><p>${escapeHtml(talentDepartmentLabel(family.departmentId || ''))} · ${escapeHtml(employeeLifecycleDisplayState(employee))}</p></div><button class="employee-drawer-close" type="button" data-employee-detail-close aria-label="关闭">×</button></header>
    ${renderEmployeeDetailTabs(employee.id, 'overview')}
    <section class="employee-overview-hero"><span class="talent-directory-avatar tone-${agentAvatarTone(employee.agentFamilyId, family.name)}">${renderAgentAvatarContent(employee.agentFamilyId, family.name || employee.agentFamilyId)}</span><div><h3>${escapeHtml(family.name || employee.agentFamilyId)}</h3><p>${escapeHtml(employee.note || family.metadata?.summary || '可直接对话，也可接收符合能力范围的任务。')}</p></div><em>${escapeHtml(employeeLifecycleDisplayState(employee))}</em></section>
    <section class="employee-overview-work-status"><header><strong>工作状态</strong><small>事件更新</small></header>${renderAgentWorkStatus(workStatus)}</section>
    <section class="employee-overview-grid">
      <article class="is-primary"><small>现在在做什么</small><strong>${escapeHtml(currentWorkLabel(employee.currentWork))}</strong><span>${employee.currentWork ? `还有 ${Number(employee.queueDepth || 0)} 项排队` : '可以立即开始新对话或任务'}</span></article>
      <article><small>正在使用的记忆</small><strong>${escapeHtml(currentMemory.title)}</strong><span>${escapeHtml(currentMemoryApplied ? currentMemory.summary : '已选择，下一次新线程生效')}</span></article>
      <article><small>正在使用的 Skill</small><strong>${escapeHtml(currentSkill.label)}</strong><span>${escapeHtml(currentMarketVersion ? currentSkill.version ? skillVersionChangeSummary(currentSkill.version, employee.availableMarketVersions || []) : '当前版本已生效，改动说明等待同步' : '基础能力与该 Agent 的个人进化规则')}</span></article>
      <article><small>成长状态</small><strong>${escapeHtml(performance.label)} · ${escapeHtml(leadership.label)}</strong><span>${escapeHtml(evolutionSummary(employee.recentEvolution))}</span></article>
    </section>
    <details class="employee-profile-editor"><summary><span><strong>名称与备注</strong><small>${escapeHtml(employee.note ? plainTextSummary(employee.note, 68) : '按需修改显示名称、职责或使用偏好')}</small></span><em>编辑</em></summary><form class="employee-profile-form" data-employee-profile-form="${escapeAttr(employee.id)}">
      <label><span>显示名称</span><input name="displayName" maxlength="80" value="${escapeAttr(displayName)}" placeholder="${escapeAttr(family.name || employee.agentFamilyId || 'Agent')}" /></label>
      <label><span>备注</span><textarea name="note" maxlength="500" rows="3" placeholder="记录职责、分工或使用偏好">${escapeHtml(employee.note || '')}</textarea></label>
      <div><small>名称与备注只影响这个 Agent 实例；同类型 Agent 仍共享基础与市场 Skill。</small><span><button class="btn secondary" type="button" data-employee-profile-reset>恢复默认</button><button class="btn primary" type="submit">保存</button></span></div>
    </form></details>
    <details class="employee-permission-note"><summary>P/L 与权限有什么关系？</summary><p>P 表示专业执行表现，L 表示领导任命资格；实际管理范围和协作 Memory 权限只来自具体工作的领导任命。</p></details>
    ${renderPluginDependency(employee.agentFamilyId)}
    ${renderEmployeeCloudReadinessNotice()}
    ${renderEmployeeLifecycleSyncNotice(employee)}
    ${renderEmployeeProgressionSyncNotice(employee)}
    <footer class="employee-overview-actions">${renderEmployeeOverviewPrimaryAction(employee)}<button class="btn secondary employee-star-action ${starred ? 'is-starred' : ''}" type="button" aria-pressed="${starred ? 'true' : 'false'}" data-employee-star-toggle="${escapeAttr(employee.id)}">${iconSvg('star')}<span>${starred ? '取消星标员工' : '设为星标员工'}</span></button><button class="btn secondary" type="button" data-employee-detail="${escapeAttr(employee.id)}" data-employee-detail-tab="memory">查看记忆</button><button class="btn secondary" type="button" data-employee-market="${escapeAttr(employee.id)}">查看 Skill 版本</button>${employee.employmentState === 'active' ? `<button class="btn danger" type="button" data-employee-deactivate="${escapeAttr(employee.id)}" data-state-revision="${Number(employee.stateRevision || 0)}" data-current-work="${employee.currentWork ? 'true' : 'false'}" ${employeeLifecycleMutationEnabled() ? '' : 'disabled title="请先登录并连接云端账号"'}>停用员工</button>` : ''}</footer>
  </aside></div>`;
}

function employeeIsStarred(agentInstanceId = '') {
  const id = String(agentInstanceId || '').trim();
  return Boolean(id && (Array.isArray(state.directoryStars?.employees) ? state.directoryStars.employees : []).includes(id));
}

function renderEmployeeOverviewPrimaryAction(employee = {}) {
  if (employeeLocallyInactive(employee)) {
    return `<button class="btn primary" type="button" data-employee-reactivate-open-chat="${escapeAttr(employee.id)}" data-state-revision="${Number(employee.stateRevision || 0)}" ${employeeLifecycleMutationEnabled() ? '' : 'disabled title="请先登录并连接云端账号"'}>重新启用并对话</button>`;
  }
  const plugin = requiredPluginForAgent(employee.agentFamilyId);
  if (!employee.routeEligible && plugin && plugin.status?.installed === false) {
    return `<button class="btn primary" type="button" data-open-plugin-settings data-plugin-id="${escapeAttr(plugin.id)}" data-plugin-agent-family="${escapeAttr(employee.agentFamilyId || '')}">安装技能后对话</button>`;
  }
  if (!employee.routeEligible && employee.employmentState !== 'conflict') {
    return `<button class="btn primary" type="button" data-employee-open-chat="${escapeAttr(employee.id)}">刷新状态并对话</button>`;
  }
  const label = employee.employmentState === 'conflict' ? '等待状态处理' : '开始对话';
  return `<button class="btn primary" type="button" data-employee-open-chat="${escapeAttr(employee.id)}" ${employee.routeEligible && employee.employmentState !== 'conflict' ? '' : 'disabled'}>${label}</button>`;
}

function renderEmployeeDetailTabs(agentInstanceId = '', active = 'overview') {
  const tabs = [
    ['overview', '概览'],
    ['memory', '记忆'],
    ['skill', 'Skill'],
    ['growth', '成长'],
  ];
  return `<nav class="employee-detail-tabs" role="tablist" aria-label="员工详情分页">${tabs.map(([id, label]) => `<button type="button" role="tab" aria-selected="${active === id ? 'true' : 'false'}" class="${active === id ? 'is-active' : ''}" data-employee-detail="${escapeAttr(agentInstanceId)}" data-employee-detail-tab="${id}">${escapeHtml(label)}</button>`).join('')}</nav>`;
}

function renderGrowthDrawer() {
  const drawer = state.employeeGrowthDrawer;
  if (!drawer) return '';
  const employee = employeeById(drawer.agentInstanceId);
  const performance = employee?.performance || {};
  const leadership = normalizeLeadership(employee?.leadership, employee?.progressionSync);
  const promotion = leadership.promotion || {};
  const history = drawer.history || [];
  const appeals = Array.isArray(employee?.leadershipAppeals) ? employee.leadershipAppeals : [];
  return `<div class="employee-drawer-layer"><button class="employee-drawer-backdrop" type="button" data-employee-detail-close aria-label="关闭员工详情"></button><aside class="employee-memory-drawer employee-growth-drawer" role="dialog" aria-modal="true" aria-label="成长与职级详情"><header><div><span class="employee-drawer-kicker">${escapeHtml(employee?.family?.name || employee?.agentFamilyId || 'Agent')}</span><h2>员工详情</h2><p>P 衡量专业表现，L 衡量领导任命资格。</p></div><button class="employee-drawer-close" type="button" data-employee-detail-close aria-label="关闭">×</button></header>
    ${renderEmployeeDetailTabs(drawer.agentInstanceId, 'growth')}
    <div class="employee-permission-note">P/L 职级都不会自动授予任务管理或 Memory 读取权限；实际权限始终来自具体工作的领导任命。</div>
    ${renderLeadershipActionPanel(employee, leadership)}
    <section class="employee-growth-section"><header><div><span>Performance</span><h3>${escapeHtml(performance.level || 'P1')} · ${Number(performance.score || 0).toFixed(1)}</h3></div><em>${performance.provisional ? '暂定' : '已确认'}</em></header>
      <div class="employee-growth-metrics">${performanceMetric('交付质量', performance.quality)}${performanceMetric('可靠性', performance.reliability)}${performanceMetric('首次通过', performance.firstPass)}${performanceMetric('执行效率', performance.efficiency)}${performanceMetric('协作安全', performance.collaborationSafety)}</div>
      <div class="employee-growth-facts"><span><small>完成任务</small><strong>${Number(performance.completedTaskCount || 0)}</strong></span><span><small>终态尝试</small><strong>${Number(performance.terminalAttemptCount || 0)}</strong></span><span><small>基线</small><strong>${escapeHtml(performance.peerBaselineKind || 'unavailable')}</strong></span><span><small>贡献权重</small><strong>${Number(performance.contributionWeight || 0).toFixed(2)}</strong></span></div>
      <p>${performance.provisional ? `暂定原因：${escapeHtml(performanceReasonLabel(performance.provisionalReason))}。` : '当前表现等级已达到有效任务样本要求。'} 统计窗口 ${escapeHtml(formatDateTime(performance.windowStartedAt) || '—')} 至 ${escapeHtml(formatDateTime(performance.windowEndedAt) || '—')}。</p>
    </section>
    <section class="employee-growth-section"><header><div><span>Leadership</span><h3>${escapeHtml(leadership.label || 'L0')}</h3></div><em>${escapeHtml(leadershipStatusLabel(leadership.status))}</em></header>
      <div class="employee-growth-metrics leadership">${leadershipMetric('交付质量', leadership.metrics?.deliveryQuality)}${leadershipMetric('拆解匹配', leadership.metrics?.decompositionMatching)}${leadershipMetric('验收返工', leadership.metrics?.reviewReworkControl)}${leadershipMetric('依赖协调', leadership.metrics?.dependencyCoordination)}${leadershipMetric('团队提升', leadership.metrics?.teamEfficiencyUplift)}${leadershipMetric('权限安全', leadership.metrics?.safety)}</div>
      <div class="employee-growth-facts"><span><small>有效领导任务</small><strong>${Number(leadership.leadershipTaskCount || 0)}</strong></span><span><small>跨部门任务</small><strong>${Number(leadership.crossDepartmentTaskCount || 0)}</strong></span><span><small>团队试岗</small><strong>${Number(leadership.teamLeadTrialCount || 0)}</strong></span><span><small>跨团队试岗</small><strong>${Number(leadership.crossTeamTrialCount || 0)}</strong></span></div>
      ${renderLeadershipCaps(leadership.level)}
      ${leadership.nextLevel ? `<div class="employee-promotion-readiness"><strong>下一等级 ${escapeHtml(leadership.nextLevel)}</strong><span>${promotion.ready ? '当前指标已满足，等待对应自动或治理流程。' : escapeHtml((promotion.reasons || []).map(leadershipReasonLabel).join('、') || '继续积累有效领导任务。')}</span></div>` : '<div class="employee-promotion-readiness"><strong>已达到最高 Leadership 等级</strong><span>后续继续依据滚动窗口保持资格。</span></div>'}
    </section>
    <section class="employee-growth-section"><header><div><span>Appeals</span><h3>申诉与治理结果</h3></div><em>${appeals.length}</em></header>${appeals.map(renderLeadershipAppealRow).join('') || '<div class="employee-drawer-empty compact">尚无申诉记录。</div>'}</section>
    <section class="employee-growth-section"><header><div><span>History</span><h3>Leadership 评估历史</h3></div><button class="mini-btn muted" type="button" data-employee-growth-refresh="${escapeAttr(drawer.agentInstanceId)}" ${drawer.loading ? 'disabled' : ''}>刷新</button></header>
      ${drawer.loading ? '<div class="employee-drawer-loading compact" role="status"><i aria-hidden="true"></i><span>正在读取评估历史…</span></div>' : ''}
      ${drawer.error ? `<div class="employee-drawer-error compact" role="alert"><strong>无法读取评估历史</strong><span>${escapeHtml(drawer.error)}</span></div>` : ''}
      ${!drawer.loading && !drawer.error ? history.map(renderLeadershipHistoryRow).join('') || '<div class="employee-drawer-empty compact">暂无 Leadership 评估历史。</div>' : ''}
    </section>
  </aside></div>`;
}

function renderLeadershipDecisionDialog() {
  const dialog = state.leadershipDecisionDialog;
  if (!dialog) return '';
  return `<div class="employee-dialog-layer"><button class="employee-drawer-backdrop" type="button" data-leadership-dialog-close aria-label="取消"></button><form class="employee-decision-dialog" data-leadership-dialog-form role="dialog" aria-modal="true" aria-labelledby="leadership-dialog-title"><header><span>Leadership Governance</span><h2 id="leadership-dialog-title">${escapeHtml(dialog.title || '提交治理意见')}</h2><p>${escapeHtml(dialog.description || '请填写可审计的理由。')}</p></header><label><span>理由</span><textarea name="reason" maxlength="2000" required placeholder="说明依据、风险或希望复核的内容">${escapeHtml(dialog.defaultReason || '')}</textarea></label>${dialog.error ? `<div class="employee-dialog-error" role="alert">${escapeHtml(dialog.error)}</div>` : ''}<footer><button class="btn secondary" type="button" data-leadership-dialog-close ${dialog.busy ? 'disabled' : ''}>取消</button><button class="btn primary" type="submit" ${dialog.busy ? 'disabled' : ''}>${dialog.busy ? '提交中…' : escapeHtml(dialog.submitLabel || '提交')}</button></footer></form></div>`;
}

function employeeGrowthLabel(agentInstanceId = '') {
  return employeeById(agentInstanceId)?.family?.name || employeeById(agentInstanceId)?.agentFamilyId || agentInstanceId || 'Agent';
}

function employeeUserLabel(userId = '') {
  if (userId && userId === state.currentUser?.id) return state.currentUser.displayName || state.currentUser.display_name || state.currentUser.username || '当前用户';
  const user = (state.adminUsers || []).find((item) => item.id === userId);
  return user?.displayName || user?.display_name || user?.username || userId || '未知用户';
}

function governanceActionLabel(value = '') {
  return ({ promote: '晋升', trial_requested: '试岗申请', restore: '资格恢复', demote: '降级', freeze: '冻结' })[value] || value || '治理操作';
}

function renderGovernanceEvidence(evidence = {}) {
  const parts = [
    evidence.requiredReviewer ? `复核角色：${evidence.requiredReviewer}` : '',
    evidence.score !== undefined ? `评分：${Number(evidence.score || 0).toFixed(1)}` : '',
    evidence.leadershipTaskCount !== undefined ? `有效任务：${Number(evidence.leadershipTaskCount || 0)}` : '',
    evidence.stateRevision !== undefined ? `revision ${Number(evidence.stateRevision || 0)}` : '',
  ].filter(Boolean);
  return parts.join(' · ') || '等待治理复核';
}

function performanceMetric(label, value) {
  const score = Math.max(0, Math.min(100, Number(value || 0)));
  return `<span><small>${escapeHtml(label)}</small><strong>${score.toFixed(0)}</strong><i style="--leadership-score:${score}%"></i></span>`;
}

function renderLeadershipCaps(level = 'L0') {
  const caps = {
    L0: { agents: 0, nodes: 0, groups: 0, label: '仅可在受控试岗中承担 task lead' },
    L1: { agents: 3, nodes: 6, groups: 1, label: 'task lead' },
    L2: { agents: 6, nodes: 12, groups: 1, label: 'task lead / team lead' },
    L3: { agents: 20, nodes: 20, groups: 4, label: '支持跨部门与 cross-team lead' },
  }[level] || {};
  return `<div class="employee-leadership-caps"><span><small>角色</small><strong>${escapeHtml(caps.label || '独立执行者')}</strong></span><span><small>Agent</small><strong>${Number(caps.agents || 0)}</strong></span><span><small>节点</small><strong>${Number(caps.nodes || 0)}</strong></span><span><small>任务组</small><strong>${Number(caps.groups || 0)}</strong></span></div>`;
}

function renderLeadershipAppealRow(appeal = {}) {
  const outcome = appeal.decisionReason || appeal.decision_reason || appeal.resolutionReason || appeal.resolution_reason || appeal.reviewReason || '';
  return `<article class="employee-history-row"><header><strong>${escapeHtml(appealKindLabel(appeal.appealKind))}</strong><em class="is-${escapeAttr(statusTone(appeal.status))}">${escapeHtml(leadershipAppealStatusLabel(appeal.status))}</em></header><p>${escapeHtml(appeal.submittedReason || appeal.reason || '未填写申诉理由')}</p>${outcome ? `<small>治理意见：${escapeHtml(outcome)}</small>` : ''}<small>${escapeHtml(formatDateTime(appeal.decidedAt || appeal.updatedAt || appeal.createdAt) || '')}</small></article>`;
}

function renderLeadershipHistoryRow(item = {}) {
  const metrics = item.metrics || {};
  return `<article class="employee-history-row"><header><strong>${escapeHtml(item.level || 'L0')} · ${Number(item.score || 0).toFixed(1)}</strong><em>${escapeHtml(leadershipStatusLabel(item.status))}</em></header><small>${escapeHtml(formatDateTime(item.windowEndedAt || item.createdAt) || '时间未知')} · 有效任务 ${Number(item.leadershipTaskCount || item.taskCount || 0)}</small><div class="employee-history-metrics"><span>交付 ${Number(metrics.deliveryQuality || 0).toFixed(0)}</span><span>拆解 ${Number(metrics.decompositionMatching || 0).toFixed(0)}</span><span>返工 ${Number(metrics.reviewReworkControl || 0).toFixed(0)}</span><span>协调 ${Number(metrics.dependencyCoordination || 0).toFixed(0)}</span><span>提升 ${Number(metrics.teamEfficiencyUplift || 0).toFixed(0)}</span><span>安全 ${Number(metrics.safety || 0).toFixed(0)}</span></div></article>`;
}

function performanceReasonLabel(value = '') {
  return ({ fewer_than_10_completed_tasks: '完成任务少于 10 个', insufficient_evidence: '有效证据不足' })[value] || value || '有效任务样本不足';
}

function leadershipReasonLabel(value = '') {
  const labels = {
    score_below_threshold: '评分未达到门槛', leadership_tasks_insufficient: '有效领导任务不足', safety_frozen: '存在安全冻结',
    professional_p3_required: '需要已确认 P3', professional_p5_required: '需要已确认 P5', professional_p7_required: '需要已确认 P7',
    team_lead_trials_insufficient: 'team lead 试岗不足', cross_team_trials_insufficient: '跨团队试岗不足',
    cross_department_tasks_insufficient: '跨部门任务不足', baseline_uplift_required: '团队效率提升证据不足',
    five_percent_uplift_required: '团队效率提升低于 5%', governance_approval_required: '需要治理批准',
  };
  return labels[value] || value;
}

function leadershipStatusLabel(value = '') {
  return ({ active: '有效', frozen: '已冻结', draining: '降级交接中', demoted: '已降级' })[value] || value || '有效';
}

function appealKindLabel(value = '') {
  return ({ assessment: '评估申诉', promotion: '晋升申诉', freeze: '冻结申诉', demotion: '降级申诉' })[value] || value || 'Leadership 申诉';
}

function leadershipAppealStatusLabel(value = '') {
  return ({ pending: '处理中', approved: '申诉成立', rejected: '申诉驳回', withdrawn: '已撤回' })[value] || value || '未知';
}

function statusTone(value = '') {
  return ({ approved: 'success', rejected: 'danger', pending: 'warning', frozen: 'danger' })[value] || 'muted';
}

function renderLeadershipGovernance(governance = null) {
  const actions = Array.isArray(governance?.actions) ? governance.actions : [];
  const appeals = Array.isArray(governance?.appeals) ? governance.appeals : [];
  if (!actions.length && !appeals.length) return '';
  return `<section class="talent-directory-section">
    <header class="talent-directory-section-head"><div><h2>Leadership 治理队列</h2><p>晋升、试岗、恢复和申诉必须由治理人员审计决定</p></div><span>${actions.length + appeals.length}</span></header>
    <div class="talent-directory-grid">
      ${actions.map((action) => `<article class="talent-directory-card leadership-governance-card"><strong>${escapeHtml(governanceActionLabel(action.action))} · ${escapeHtml(action.fromLevel || '—')} → ${escapeHtml(action.toLevel || '—')}</strong>
        <small>${escapeHtml(employeeUserLabel(action.ownerUserId))} · ${escapeHtml(employeeGrowthLabel(action.agentInstanceId))}</small>
        <p>${escapeHtml(action.reason || '等待治理复核')}</p><div class="leadership-governance-evidence">${escapeHtml(renderGovernanceEvidence(action.evidence || {}))}</div>
        <div class="talent-directory-card-actions"><button class="talent-directory-primary" type="button" data-leadership-governance-action="${escapeAttr(action.id)}" data-decision="approve" data-state-revision="${Number(action.evidence?.stateRevision || 0)}">批准</button><button type="button" data-leadership-governance-action="${escapeAttr(action.id)}" data-decision="reject" data-state-revision="${Number(action.evidence?.stateRevision || 0)}">拒绝</button></div>
      </article>`).join('')}
      ${appeals.map((appeal) => `<article class="talent-directory-card leadership-governance-card"><strong>${escapeHtml(appealKindLabel(appeal.appealKind))}</strong>
        <small>${escapeHtml(employeeUserLabel(appeal.ownerUserId))} · ${escapeHtml(employeeGrowthLabel(appeal.agentInstanceId))}</small>
        <p>${escapeHtml(appeal.submittedReason || '')}</p>
        <div class="talent-directory-card-actions"><button class="talent-directory-primary" type="button" data-leadership-governance-appeal="${escapeAttr(appeal.id)}" data-decision="approve">支持申诉</button><button type="button" data-leadership-governance-appeal="${escapeAttr(appeal.id)}" data-decision="reject">驳回</button></div>
      </article>`).join('')}
    </div>
  </section>`;
}

function renderUBuddyCard(item = {}) {
  const pending = ['pending_cloud_confirmation', 'conflict'].includes(item.employmentState);
  return `<article class="talent-directory-ubuddy-card talent-directory-card is-roster ${item.routeEligible ? 'is-clickable' : ''}" ${item.routeEligible ? `data-employee-card-chat="${escapeAttr(item.id)}" role="button" tabindex="0" aria-label="打开 uBuddy"` : ''}>
    <div class="talent-directory-ubuddy-identity">
      <span class="talent-directory-avatar ubuddy-avatar">U</span>
      <div><span class="talent-directory-eyebrow">系统助理 · 默认招募</span><h3>uBuddy</h3><p>理解你的目标，选择合适的 Agent，跟踪任务进度，并在跨用户协作中整理与确认交付。</p></div>
    </div>
    <div class="talent-directory-ubuddy-capabilities" aria-label="uBuddy 能力">
      <span>${iconSvg('spark')}需求整理</span>
      <span>${iconSvg('tasks')}员工调度</span>
      <span>${iconSvg('message')}协作跟进</span>
    </div>
    ${pending ? `<div class="employee-warning">${item.employmentState === 'conflict' ? 'uBuddy 状态存在云端冲突，请刷新后重试。' : '正在等待云端确认。'}</div>` : ''}
    <div class="talent-directory-ubuddy-actions">
      <small>固定系统角色，不计入 ${Number((state.employeeOverview?.quota || {}).limit || 10)} 名员工配额</small>
      <button class="talent-directory-primary" type="button" data-employee-open-chat="${escapeAttr(item.id)}" ${item.routeEligible ? '' : 'disabled'}>${item.routeEligible ? '打开 uBuddy' : '暂不可用'}</button>
    </div>
  </article>`;
}

function renderRosterCard(item = {}, index = 0) {
  const commandBusy = Boolean(state.employeeBusyCommandId);
  const itemBusy = commandBusy && state.employeeBusyTargetId === item.id;
  const family = item.family || {};
  const stateLabel = employeeLifecycleSyncPending(item, 'active')
    ? item.routeEligible ? '本地可用 · 待同步' : '启用中 · 待同步'
    : employeeLocallyInactive(item) ? '已停用' : ({
    active: item.currentWork ? '执行中' : Number(item.queueDepth || 0) ? '排队中' : '空闲',
    pending_cloud_confirmation: item.pendingTargetState === 'active' ? '本地可用 · 待同步' : '等待云端确认',
    conflict: '需要处理冲突',
  })[item.employmentState] || item.employmentState || '未知';
  const pending = employeeLifecycleSyncPending(item) || item.employmentState === 'conflict';
  const marketCount = Array.isArray(item.availableMarketVersions) ? item.availableMarketVersions.length : 0;
  const name = employeeDisplayName(item);
  const department = talentDepartmentLabel(family.departmentId || family.department_id || '');
  const description = family.metadata?.summary || family.summary || talentAgentDescription(item.agentFamilyId, department);
  const performance = normalizePerformance(item.performance, item.progressionSync);
  const leadership = normalizeLeadership(item.leadership, item.progressionSync);
  const workLabel = currentWorkLabel(item.currentWork);
  const currentSkill = skillVersionPresentation(item.marketEffectiveSkill?.marketVersionId || '', item.availableMarketVersions || []);
  const currentMemory = item.currentMemory ? memoryDocumentPresentation(item.currentMemory) : { title: '暂无记忆', summary: '' };
  const evolution = evolutionSummary(item.recentEvolution);
  const skillTags = talentSkillTags(item, department);
  const memoryCapability = state.employeeOverview?.capabilities?.multiMemory || {};
  const memoryDisabled = memoryCapability.enabled && !memoryCapability.readOnly ? '' : `disabled title="${escapeAttr(employeeStatusMessage(memoryCapability.code, 'Memory 写入能力暂不可用'))}"`;

  return `<article class="talent-directory-card is-roster ${item.routeEligible && !commandBusy ? 'is-clickable' : ''} ${itemBusy ? 'is-busy' : ''}" aria-busy="${itemBusy ? 'true' : 'false'}" ${item.routeEligible && !commandBusy ? `data-employee-card-chat="${escapeAttr(item.id)}" role="button" tabindex="0" aria-label="与 ${escapeAttr(name)} 开始对话"` : ''}>
    <header class="talent-directory-card-head">
      <span class="talent-directory-avatar tone-${agentAvatarTone(item.agentFamilyId, name)}">${renderAgentAvatarContent(item.agentFamilyId, name)}</span>
      <div class="talent-directory-card-title"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(department)} · 专业员工</small></div>
      <span class="talent-directory-state ${escapeAttr(item.employmentState || '')} ${item.currentWork ? 'is-busy' : ''}">${escapeHtml(stateLabel)}</span>
    </header>
    <p class="talent-directory-description">${escapeHtml(description)}</p>
    ${renderPluginDependency(item.agentFamilyId)}
    <div class="talent-directory-skill-tags">${skillTags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
    <div class="talent-directory-workline ${item.currentWork ? 'is-active' : ''}">
      <span>${iconSvg('tasks')}</span><div><small>当前工作</small><strong>${escapeHtml(workLabel)}</strong></div>
    </div>
    <div class="talent-directory-facts">
      <span><small>表现等级</small><strong>${escapeHtml(performance.label)}</strong></span>
      <span><small>领导职级</small><strong>${escapeHtml(leadership.label)}</strong></span>
      <span><small>排队任务</small><strong>${Number(item.queueDepth || 0)}</strong></span>
      <span><small>当前记忆</small><strong>${escapeHtml(currentMemory.title)}</strong></span>
      <span><small>当前 Skill</small><strong>${escapeHtml(currentSkill.label)}</strong></span>
    </div>
    <div class="talent-directory-evolution"><span>${iconSvg('spark')}最近进化</span><strong>${escapeHtml(evolution)}</strong></div>
    <button class="employee-progression-summary" type="button" data-employee-detail="${escapeAttr(item.id)}" data-employee-detail-tab="growth"><span>查看完整职级与履历</span><strong>${escapeHtml(performance.label)} · ${escapeHtml(leadership.label)}</strong></button>
    ${pending ? renderEmployeeLifecycleSyncNotice(item) : ''}
    <footer class="talent-directory-card-actions">
      ${renderRosterPrimaryAction(item, { commandBusy, itemBusy })}
      <details class="talent-directory-manage">
        <summary>管理 ${iconSvg('chevronDown')}</summary>
        <div class="talent-directory-manage-panel">
          <button type="button" data-employee-detail="${escapeAttr(item.id)}" data-employee-detail-tab="overview">员工概览</button>
          <button type="button" data-employee-memory="${escapeAttr(item.id)}">查看记忆</button>
          <button type="button" data-employee-memory-create="${escapeAttr(item.id)}" ${memoryDisabled}>新建记忆</button>
          <button type="button" data-employee-evolution="${escapeAttr(item.id)}">个人进化</button>
          <button type="button" data-employee-growth="${escapeAttr(item.id)}">成长记录</button>
          <button type="button" data-employee-market="${escapeAttr(item.id)}">Skill 版本 (${marketCount})</button>
          ${item.employmentState === 'active' ? `<button class="danger" type="button" data-employee-deactivate="${escapeAttr(item.id)}" data-state-revision="${Number(item.stateRevision || 0)}" ${commandBusy || !employeeLifecycleMutationEnabled() ? 'disabled' : ''} ${employeeLifecycleMutationEnabled() ? '' : 'title="请先登录并连接云端账号"'}>停用</button>` : ''}
        </div>
      </details>
    </footer>
  </article>`;
}

function renderRosterPrimaryAction(item = {}, { commandBusy = false, itemBusy = false } = {}) {
  if (employeeLocallyInactive(item)) {
    return `<button class="talent-directory-primary" type="button" data-employee-reactivate="${escapeAttr(item.id)}" data-state-revision="${Number(item.stateRevision || 0)}" ${commandBusy || !employeeLifecycleMutationEnabled() ? 'disabled' : ''} ${employeeLifecycleMutationEnabled() ? '' : 'title="请先登录并连接云端账号"'}>${itemBusy ? '处理中…' : '重新启用'}</button>`;
  }
  return `<button class="talent-directory-primary" type="button" data-employee-open-chat="${escapeAttr(item.id)}" ${item.routeEligible && !commandBusy ? '' : 'disabled'}>${itemBusy ? '处理中…' : item.routeEligible ? '开始对话' : '暂不可用'}</button>`;
}

function renderRecruitableCard(item = {}, index = 0) {
  const commandBusy = Boolean(state.employeeBusyCommandId);
  const commandTargetId = item.id;
  const itemBusy = commandBusy && state.employeeBusyTargetId === commandTargetId;
  const requiredPlugin = requiredPluginForAgent(item.id);
  const skillInstallRequired = Boolean(requiredPlugin && requiredPlugin.status?.installed === false);
  const recruitmentAction = recruitableActionPresentation(item, { commandBusy, itemBusy });
  const canRecruit = !skillInstallRequired && recruitmentAction.enabled;
  const name = item.name || item.id || '专业 Agent';
  const department = talentDepartmentLabel(item.departmentId || item.department_id || '');
  const skillTags = talentSkillTags(item, department).slice(0, 2);
  const actionError = state.employeeMarketActionErrors?.[commandTargetId] || '';
  const hiredCount = Number(item.activeInstanceCount || 0);
  const primaryAction = skillInstallRequired
    ? renderRequiredPluginInstallAction(requiredPlugin, item.id)
    : `<button class="talent-directory-primary" type="button" data-employee-recruit="${escapeAttr(item.id || '')}" ${canRecruit ? '' : 'disabled'}${recruitmentAction.title ? ` title="${escapeAttr(recruitmentAction.title)}"` : ''}>${escapeHtml(recruitmentAction.label)}</button>`;
  const availabilityText = skillInstallRequired
    ? `需先安装 ${requiredPlugin.name || '所需 Skill'}，安装后才可招募`
    : recruitmentAction.meta || (hiredCount ? `已招募 ${hiredCount} 名 · 可继续招募` : '招募后创建独立实例、Memory 与个人进化档案');
  return `<article class="talent-directory-card is-recruitable is-clickable" data-employee-market-candidate-open="${escapeAttr(item.id || '')}" role="button" tabindex="0" aria-label="查看 ${escapeAttr(name)} 详情">
    <header class="talent-directory-card-head">
      <span class="talent-directory-avatar tone-${agentAvatarTone(item.id, name)}">${renderAgentAvatarContent(item.id, name)}</span>
      <div class="talent-directory-card-title"><strong>${escapeHtml(name)}</strong><div class="talent-directory-compact-tags">${skillTags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div></div>
      <div class="talent-directory-card-actions">
        ${primaryAction}
        <details class="talent-directory-card-menu"><summary aria-label="更多操作">${iconSvg('more')}</summary><div><button type="button" data-employee-market-candidate-open="${escapeAttr(item.id || '')}">查看详情</button></div></details>
      </div>
    </header>
    <div class="talent-directory-card-meta">${escapeHtml(availabilityText)}</div>
    ${actionError ? `<div class="talent-directory-action-error" role="alert"><span>${escapeHtml(actionError)}</span><button type="button" data-employee-recruit="${escapeAttr(item.id || '')}" ${canRecruit ? '' : 'disabled'}>重试</button></div>` : ''}
  </article>`;
}

function renderMarketCandidateDrawer() {
  const candidateId = state.employeeMarketCandidateId || '';
  if (!candidateId) return '';
  const item = marketCandidates(state.employeeOverview?.recruitableFamilies || [])
    .find((candidate) => candidate.id === candidateId);
  if (!item) return '';
  const commandTargetId = item.id;
  const itemBusy = Boolean(state.employeeBusyCommandId) && state.employeeBusyTargetId === commandTargetId;
  const commandBusy = Boolean(state.employeeBusyCommandId);
  const requiredPlugin = requiredPluginForAgent(item.id);
  const skillInstallRequired = Boolean(requiredPlugin && requiredPlugin.status?.installed === false);
  const recruitmentAction = recruitableActionPresentation(item, { commandBusy, itemBusy, detailed: true });
  const canRecruit = !skillInstallRequired && recruitmentAction.enabled;
  const name = item.name || item.id || '专业 Agent';
  const department = talentDepartmentLabel(item.departmentId || item.department_id || '');
  const description = item.metadata?.description || item.metadata?.summary || talentAgentDescription(item.id, department);
  const skillTags = talentSkillTags(item, department);
  const actionError = state.employeeMarketActionErrors?.[commandTargetId] || '';
  const primaryAction = skillInstallRequired
    ? renderRequiredPluginInstallAction(requiredPlugin, item.id)
    : `<button class="talent-directory-primary" type="button" data-employee-recruit="${escapeAttr(item.id || '')}" ${canRecruit ? '' : 'disabled'}${recruitmentAction.title ? ` title="${escapeAttr(recruitmentAction.title)}"` : ''}>${escapeHtml(recruitmentAction.label)}</button>`;
  return `<div class="employee-drawer-layer talent-candidate-drawer-layer"><button class="employee-drawer-backdrop" type="button" data-employee-market-candidate-close aria-label="关闭人才详情"></button><aside class="employee-memory-drawer talent-candidate-drawer" role="dialog" aria-modal="true" aria-label="${escapeAttr(name)} 详情">
    <header><div><span class="employee-drawer-kicker">${escapeHtml(department)}</span><h2>${escapeHtml(name)}</h2><p>查看人才介绍、核心能力与 Skill 信息。</p></div><button class="employee-drawer-close" type="button" data-employee-market-candidate-close aria-label="关闭">×</button></header>
    <section class="talent-candidate-hero"><span class="talent-directory-avatar tone-${agentAvatarTone(item.id, name)}">${renderAgentAvatarContent(item.id, name)}</span><div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(department)}</small></div></section>
    <section class="talent-candidate-section"><h3>人才介绍</h3><p>${escapeHtml(description)}</p></section>
    <section class="talent-candidate-section"><h3>核心能力</h3><div class="talent-candidate-tags">${skillTags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('') || '<span>专业执行</span>'}</div></section>
    <section class="talent-candidate-section"><h3>Skill 与实例</h3><div class="talent-candidate-skill"><span><small>Agent 类型</small><strong>${escapeHtml(item.id || '—')}</strong></span><span><small>当前实例</small><strong>${Number(item.activeInstanceCount || 0)} 名</strong></span></div><p>每次招募都会创建新的独立实例，并按 A/B/C… 初始化名称。基础与市场 Skill 按类型共享；Memory、会话、备注、个人进化与成长记录按实例隔离。</p>${renderPluginDependency(item.id, { recruited: false })}</section>
    ${actionError ? `<div class="talent-directory-action-error" role="alert"><span>${escapeHtml(actionError)}</span></div>` : ''}
    <footer class="talent-candidate-actions">${primaryAction}</footer>
  </aside></div>`;
}

function employeeLifecycleSyncPending(item = {}, targetState = '') {
  const pending = item.authorityState === 'pending' || item.employmentState === 'pending_cloud_confirmation';
  return pending && (!targetState || item.pendingTargetState === targetState);
}

function employeeLifecycleSyncMessage(item = {}) {
  if (item.employmentState === 'conflict') return '本地命令与云端 revision 冲突，请刷新后重试。';
  const syncStatus = item.lifecycleSync?.status || '';
  const lastError = String(item.lifecycleSync?.lastError || '');
  if (syncStatus === 'blocked_auth' && /device_approval_pending/i.test(lastError)) {
    return '本机状态已经更新；当前设备正在等待另一台已授权设备批准，批准后会继续同步。';
  }
  if (syncStatus === 'blocked_auth' && /cloud_auth_required/i.test(lastError)) {
    return '本机状态已经更新；请重新登录并绑定云端账号，登录后会继续同步。';
  }
  if (syncStatus === 'blocked_auth') return '本机状态已经更新；云端设备授权失效，重新登录或授权后会继续同步。';
  if (syncStatus === 'blocked_incompatible_cloud') return '本机状态已经更新；当前云端版本暂不支持员工状态同步。';
  if (item.lifecycleSync?.lastError) return '本机状态已经更新；云端同步暂时失败，系统将自动重试。';
  if (employeeLifecycleSyncPending(item, 'active')) return '已可在本机直接对话并进入任务候选池；云端状态正在后台同步。';
  return '已在本机停用；云端同步已加入后台队列，可随时重新启用。';
}

function employeeLifecycleMutationEnabled() {
  return state.employeeOverview?.capabilities?.recruitment?.enabled !== false;
}

function renderEmployeeCloudReadinessNotice() {
  const capability = state.employeeOverview?.capabilities?.recruitment || {};
  if (capability.enabled !== false) return '';
  const message = capability.message || employeeStatusMessage(capability.code, '请先登录并连接云端账号，再修改员工启用状态。');
  return `<div class="employee-warning employee-lifecycle-sync-notice" role="status"><span>${escapeHtml(message)}</span><button class="btn secondary" type="button" data-employee-cloud-auth-settings>前往账户设置</button></div>`;
}

function renderEmployeeLifecycleSyncNotice(item = {}) {
  const pending = employeeLifecycleSyncPending(item);
  if (!pending && item.employmentState !== 'conflict') return '';
  const blockedAuth = item.lifecycleSync?.status === 'blocked_auth';
  const action = blockedAuth
    ? '<button class="btn secondary" type="button" data-employee-cloud-auth-settings>前往账户设置</button>'
    : pending && item.lifecycleSync?.retryable
      ? `<button class="btn secondary" type="button" data-employee-sync-retry="${escapeAttr(item.id || '')}">立即重试</button>`
      : '';
  return `<div class="employee-warning employee-lifecycle-sync-notice"><span>${escapeHtml(employeeLifecycleSyncMessage(item))}</span>${action}</div>`;
}

function renderEmployeeProgressionSyncNotice(item = {}) {
  if (item.performance || item.leadership || employeeLifecycleSyncPending(item) || item.employmentState !== 'active') return '';
  const sync = item.progressionSync || {};
  if (sync.lastError) {
    if (/(?:cloud_auth_required|social_session_expired|access_token_expired|refresh_token_expired)/i.test(sync.lastError)) {
      return '<div class="employee-warning employee-lifecycle-sync-notice"><span>Agent 启用状态已由云端确认；专业与领导等级刷新需要重新登录，登录后会自动继续同步。</span></div>';
    }
    if (/device_approval_pending/i.test(sync.lastError)) {
      return '<div class="employee-warning employee-lifecycle-sync-notice"><span>Agent 启用状态已由云端确认；当前设备获批后会自动刷新专业与领导等级。</span></div>';
    }
    return '<div class="employee-warning employee-lifecycle-sync-notice"><span>Agent 启用状态已由云端确认；专业与领导等级刷新失败，后台同步会继续重试。</span></div>';
  }
  if (sync.refreshedAt) {
    return '<div class="employee-permission-note">Agent 与等级服务均已同步；当前尚无足够的有效任务样本，因此保持待评估状态。</div>';
  }
  return '<div class="employee-warning employee-lifecycle-sync-notice"><span>Agent 启用状态已由云端确认；专业与领导等级数据正在完成首次同步。</span></div>';
}

function employeeLifecycleDisplayState(item = {}) {
  if (item.employmentState === 'active') return '在职';
  if (employeeLifecycleSyncPending(item, 'active') && item.routeEligible) return '本机已启用 · 云端待同步';
  if (employeeLifecycleSyncPending(item, 'inactive')) return '已停用 · 云端待同步';
  if (item.employmentState === 'conflict') return '状态异常';
  if (employeeLocallyInactive(item)) return '已停用';
  return '暂不可用';
}

function employeeLocallyInactive(item = {}) {
  if (employeeLifecycleSyncPending(item, 'active')) return false;
  return item.employmentState === 'inactive' || employeeLifecycleSyncPending(item, 'inactive');
}

function talentDepartmentLabel(departmentId = '') {
  if (!departmentId) return '专业 Agent';
  return (state.org?.departments || []).find((department) => department.id === departmentId)?.name || departmentId;
}

function talentAgentDescription(agentFamilyId = '', department = '') {
  const descriptions = {
    literature_review: '检索、筛选并整理学术资料与研究脉络。',
    data_science_scout: '分析数据问题，设计可执行的数据处理路径。',
    paper_writer: '协助论文结构、论证与成稿表达。',
    horizontal_proposal: '规划横向项目方案、交付与协作节奏。',
    ppt: '将内容整理为清晰、可编辑的演示文稿。',
  };
  return descriptions[agentFamilyId] || `${department || '专业领域'}专项能力，可直接加入团队协作。`;
}

function renderPluginDependency(agentFamilyId = '', { recruited = true } = {}) {
  const plugin = requiredPluginForAgent(agentFamilyId);
  if (!plugin || plugin.status?.ready || (plugin.status?.installed && plugin.status?.ready !== false)) return '';
  const installed = Boolean(plugin.status?.installed);
  const detail = installed
    ? (plugin.status?.missing || '本机运行依赖尚未就绪。')
    : recruited
      ? '该员工来自旧版招募记录；安装完成前不能进入聊天和任务候选池。'
      : '必须先安装该 Skill，安装完成后才可招募此 Agent。';
  return `<div class="talent-plugin-dependency"><span>${iconSvg(installed ? 'shield' : 'download')}</span><div><strong>${installed ? 'PPT 运行环境未就绪' : `需要安装 ${escapeHtml(plugin.name || '扩展技能')}`}</strong><small>${escapeHtml(detail)}</small></div><button type="button" data-open-plugin-settings data-plugin-id="${escapeAttr(plugin.id)}" data-plugin-agent-family="${escapeAttr(agentFamilyId)}">查看 Skill</button></div>`;
}

function renderRequiredPluginInstallAction(plugin = {}, agentFamilyId = '') {
  const operation = state.pluginOperations?.[plugin.id] || {};
  const unavailable = plugin.status?.available === false;
  const disabled = operation.busy || unavailable;
  const label = operation.busy ? '安装中…' : unavailable ? 'Skill 暂不可安装' : '安装 Skill';
  return `<button class="talent-directory-primary" type="button" data-plugin-install="${escapeAttr(plugin.id || '')}" data-plugin-agent-family="${escapeAttr(agentFamilyId)}" ${disabled ? 'disabled' : ''}>${iconSvg('download')}<span>${escapeHtml(label)}</span></button>`;
}

function recruitableActionPresentation(item = {}, { commandBusy = false, itemBusy = false, detailed = false } = {}) {
  const hiredCount = Number(item.activeInstanceCount || 0);
  if (itemBusy) return { enabled: false, label: '处理中…', meta: '正在处理当前员工操作' };
  if (commandBusy) return { enabled: false, label: '请稍候…', meta: '正在处理其他员工操作' };

  const recruitmentCode = String(item.recruitmentCode || '').trim();
  if (recruitmentCode === 'employee_quota_exceeded') {
    return { enabled: false, label: '员工额度已满', meta: '当前员工额度已满' };
  }
  if (recruitmentCode === 'agent_skill_install_required') {
    return {
      enabled: false,
      label: '正在刷新 Skill 状态…',
      meta: 'Skill 已安装，正在刷新招募状态',
    };
  }
  if (['employee_command_pending', 'employee_state_conflict'].includes(recruitmentCode)) {
    return { enabled: false, label: '状态同步中…', meta: '员工状态正在同步' };
  }
  if (recruitmentCode === 'agent_not_recruitable') {
    return { enabled: false, label: '暂不可招募', meta: '该 Agent 当前暂不可招募' };
  }

  const capability = state.employeeOverview?.capabilities?.recruitment || {};
  if (capability.enabled === false) {
    const needsLogin = ['cloud_auth_required', 'social_session_expired', 'access_token_expired', 'refresh_token_expired']
      .includes(String(capability.code || ''));
    return {
      enabled: false,
      label: needsLogin ? '登录后招募' : '招募服务同步中…',
      meta: needsLogin ? '登录并连接云端后可招募' : '招募服务状态正在同步',
      title: capability.message || '',
    };
  }

  if (item.canRecruit) {
    return {
      enabled: true,
      label: hiredCount ? (detailed ? '再招募一名' : '再招募') : (detailed ? '招募人才' : '招募'),
      meta: hiredCount ? `已招募 ${hiredCount} 名 · 可继续招募` : '',
    };
  }

  const quota = state.employeeOverview?.quota || {};
  if (Number(quota.used || 0) >= Number(quota.limit || 10)) {
    return { enabled: false, label: '员工额度已满', meta: '当前员工额度已满' };
  }
  return { enabled: false, label: '暂不可招募', meta: '招募状态尚未就绪' };
}

function requiredPluginForAgent(agentFamilyId = '') {
  const catalog = Array.isArray(state.pluginCatalog) ? state.pluginCatalog : [];
  const matched = catalog.find((plugin) => (plugin.providesAgentIds || []).includes(agentFamilyId));
  if (matched) return matched;
  if (agentFamilyId === 'ppt' && state.pptxPluginStatus) {
    return { id: 'ppt_creation', name: 'PPT 制作技能', status: state.pptxPluginStatus };
  }
  return null;
}

function renderMarketDrawer() {
  const drawer = state.employeeMarketDrawer;
  if (!drawer) return '';
  const versions = drawer.items || [];
  const conflicts = drawer.conflictPreview?.conflicts || [];
  const employee = employeeById(drawer.agentInstanceId);
  const familyName = drawer.familyName || employee?.family?.name || employee?.agentFamilyId || drawer.agentFamilyId || 'Agent';
  const readOnly = drawer.recruited === false || !drawer.agentInstanceId;
  const returnsToEmployeeDetail = drawer.source === 'employees' && Boolean(drawer.agentInstanceId);
  const paused = false;
  const personalVersions = Array.isArray(drawer.personalVersions?.items) ? drawer.personalVersions.items : [];
  return `<div class="employee-drawer-layer"><button class="employee-drawer-backdrop" type="button" data-employee-market-close aria-label="关闭 Skill 版本"></button><aside class="employee-memory-drawer employee-market-drawer" role="dialog" aria-modal="true" aria-label="Skill 版本"><header><div><span class="employee-drawer-kicker">${escapeHtml(familyName)}</span><h2>Skill 版本</h2><p>${readOnly ? '查看共享市场版本之间的主要差异；招募后可以选择使用。' : '选择共享市场基础，并按需叠加只属于这个 Agent 的个人版本。'}</p></div>${returnsToEmployeeDetail ? `<button class="employee-drawer-close employee-market-back" type="button" data-employee-market-back="${escapeAttr(drawer.agentInstanceId)}" title="返回 Agent 概览" aria-label="返回员工详情">${iconSvg('chevronLeft')}</button>` : '<button class="employee-drawer-close" type="button" data-employee-market-close aria-label="关闭">×</button>'}</header>
    ${returnsToEmployeeDetail ? renderEmployeeDetailTabs(drawer.agentInstanceId, 'skill') : ''}
    ${drawer.loading ? '<div class="employee-drawer-loading" role="status"><i aria-hidden="true"></i><span>正在读取 Skill 版本…</span></div>' : ''}
    ${drawer.error ? `<div class="employee-drawer-error" role="alert"><strong>市场 Skill 暂不可用</strong><span>${escapeHtml(drawer.error)}</span><button class="btn secondary" type="button" data-employee-market-retry="${escapeAttr(drawer.agentInstanceId)}">重试</button></div>` : ''}
    ${drawer.loading || drawer.error ? '' : `
    ${readOnly ? '<div class="employee-permission-note">市场版本是同类 Agent 共享的能力基础；招募后可以为自己的实例选择。</div>' : renderSkillCombinationSummary(drawer, versions, personalVersions)}
    ${!readOnly && paused ? '<div class="employee-warning">账户自进化已暂停：可以回到已有版本，但暂时不能启用新的候选个人版本。</div>' : ''}
    ${readOnly ? '' : conflicts.map((conflict) => renderMarketConflict(drawer, conflict, paused)).join('')}
    <section class="employee-skill-selector-section" aria-label="市场 Skill 版本"><header><div><strong>市场版本</strong><small>同类 Agent 共享的能力基础</small></div></header><div class="employee-skill-version-list">${renderMarketBaseCard(drawer, { readOnly })}${versions.map((version) => renderMarketVersionCard(drawer, version, { readOnly, paused, versions })).join('') || '<div class="employee-drawer-empty compact">当前没有其他市场版本。</div>'}</div></section>
    ${readOnly ? '' : `<section class="employee-skill-selector-section" aria-label="个人 Skill 版本"><header><div><strong>我的版本</strong><small>只属于这个 Agent 实例，不会影响其他同类 Agent</small></div></header>${drawer.personalError ? `<div class="employee-warning">个人版本暂不可用：${escapeHtml(drawer.personalError)}</div>` : `<div class="employee-skill-version-list">${personalVersions.map((version) => renderPersonalSkillVersionCard(drawer, version, personalVersions)).join('')}${renderPersonalSkillBaseCard(drawer, personalVersions)}</div>`}</section>`}`}
  </aside></div>`;
}

function renderSkillCombinationSummary(drawer = {}, marketVersions = [], personalVersions = []) {
  const market = skillVersionPresentation(drawer.effectiveSkill?.marketVersionId || '', marketVersions);
  const personalVersionId = currentPersonalSkillVersionId(drawer, personalVersions);
  const personal = personalVersions.find((item) => item.id === personalVersionId) || null;
  return `<article class="employee-skill-combination"><header><strong>当前组合</strong><span>已生效</span></header><div><span><small>市场基础</small><strong>${escapeHtml(market.label)}</strong></span><i>+</i><span><small>个人叠加</small><strong>${escapeHtml(personal ? personalSkillVersionLabel(personal, personalVersions) : '未使用')}</strong></span></div><p>市场版本提供共享基础；个人版本仅调整这个 Agent 的专属工作方式。</p></article>`;
}

function renderMarketBaseCard(drawer = {}, { readOnly = false } = {}) {
  const currentVersionId = drawer.effectiveSkill?.marketVersionId || drawer.effectiveSkill?.fullMarketVersionId || '';
  const current = !currentVersionId;
  const disabled = drawer.busy || Boolean(drawer.conflictPreview) || readOnly;
  return `<article class="employee-skill-choice ${current ? 'is-current' : ''}"><div><span>基础版</span><strong>Agent 自带的稳定能力</strong><small>不叠加市场更新；个人版本仍可独立使用。</small></div><div>${current ? '<em>当前使用</em>' : readOnly ? '<em>招募后可选</em>' : `<button class="btn secondary" type="button" data-market-rollback-full data-market-mode="full" data-market-version-id="${escapeAttr(currentVersionId)}" ${disabled ? 'disabled' : ''}>使用基础版</button>`}</div></article>`;
}

function renderMarketCanary(drawer = {}, paused = false) {
  const canary = drawer.canary || {};
  const activeCanary = (canary.assignments || []).find((item) => ['enrolled', 'completed'].includes(item.status));
  const participating = canary.optedIn === true;
  const joining = !participating;
  const disabled = drawer.busy || Boolean(drawer.conflictPreview) || (paused && joining);
  const status = paused ? '账户已暂停' : participating ? '默认参与' : '已退出';
  const description = activeCanary
    ? `候选 ${escapeHtml(activeCanary.candidateId || '')} · ${escapeHtml(activeCanary.candidateStatus || activeCanary.status)}`
    : paused
      ? `账户自进化暂停期间不会分配新的 Canary 任务；恢复后该 Agent ${participating ? '会继续按默认策略参与' : '仍保持退出状态'}。`
      : participating
        ? '该 Agent 默认参与真实任务 Canary；通过 Shadow 的候选 Skill 只会临时运行并进入匿名评估，你可以随时退出。'
        : '你已退出该 Agent 的 Canary。重新加入后，系统才会在真实任务中临时试用候选 Skill。';
  return `<article class="employee-market-canary"><header><div><strong>真实任务 Canary</strong><small>候选版本会在受控真实任务中临时试用</small></div><span>${status}</span></header><p>${description}</p><div class="employee-card-actions"><button class="btn ${participating ? 'secondary' : 'primary'}" type="button" data-market-canary-toggle data-market-canary-enabled="${participating ? 'false' : 'true'}" ${disabled ? 'disabled' : ''} title="${paused && joining ? '恢复账户自进化后可重新加入 Canary' : ''}">${drawer.busy ? '处理中…' : participating ? '退出 Canary' : '重新加入 Canary'}</button></div></article>`;
}

function renderMarketCanarySettings(drawer = {}, paused = false) {
  return `<details class="employee-skill-advanced"><summary><span><strong>高级测试设置</strong><small>真实任务 Canary，不影响当前正式 Skill</small></span><em>按需展开</em></summary><div>${renderMarketCanary(drawer, paused)}</div></details>`;
}

function renderMarketConflict(drawer = {}, conflict = {}, paused = false) {
  return `<article class="employee-market-conflict"><strong>${escapeHtml(conflict.title || '一项能力规则')}与个人版本有重叠</strong><p>请选择这项能力继续沿用个人调整，还是改用市场版本。</p><div class="employee-card-actions"><button class="btn secondary" type="button" data-market-resolve="personal" data-market-mode="${escapeAttr(drawer.pendingMode || 'sections')}" data-market-version-id="${escapeAttr(drawer.conflictPreview?.marketVersionId || '')}" data-market-section-id="${escapeAttr(conflict.sectionId)}" ${paused || drawer.busy ? 'disabled' : ''}>保留个人调整</button><button class="btn primary" type="button" data-market-resolve="market" data-market-mode="${escapeAttr(drawer.pendingMode || 'sections')}" data-market-version-id="${escapeAttr(drawer.conflictPreview?.marketVersionId || '')}" data-market-section-id="${escapeAttr(conflict.sectionId)}" ${paused || drawer.busy ? 'disabled' : ''}>采用市场版本</button></div></article>`;
}

function renderMarketVersionCard(drawer = {}, version = {}, { readOnly = false, paused = false, versions = [] } = {}) {
  const actionLocked = drawer.busy || Boolean(drawer.conflictPreview);
  const presentation = skillVersionPresentation(version.id, versions);
  const current = drawer.effectiveSkill?.marketVersionId === version.id || drawer.effectiveSkill?.fullMarketVersionId === version.id;
  const adoptDisabled = actionLocked || readOnly || paused || version.status === 'suspended' || current;
  const changeSummary = skillVersionChangeSummary(version, versions);
  const action = current
    ? '<em>当前使用</em>'
    : readOnly
      ? '<em>招募后可选</em>'
      : version.status === 'suspended'
        ? '<em>暂不可用</em>'
        : `<button class="btn primary" type="button" data-market-adopt-full data-market-mode="full" data-market-version-id="${escapeAttr(version.id)}" ${adoptDisabled ? 'disabled' : ''}>使用此版本</button>`;
  return `<article class="employee-skill-choice ${version.status === 'suspended' ? 'is-suspended' : ''} ${current ? 'is-current' : ''}"><div><span>${escapeHtml(presentation.label)}</span><strong>${escapeHtml(changeSummary)}</strong><small>${escapeHtml(formatDateTime(version.createdAt) || '发布时间未知')}</small></div><div>${action}</div></article>`;
}

function renderPersonalSkillVersionCard(drawer = {}, version = {}, versions = []) {
  const currentVersionId = currentPersonalSkillVersionId(drawer, versions);
  const current = version.id === currentVersionId || version.status === 'active';
  const stable = version.stabilityStatus === 'stable' || version.stability_status === 'stable';
  const canActivate = stable && (version.available || version.status === 'candidate');
  const canRollback = stable && version.status === 'archived';
  const paused = false;
  const busyAction = state.evolutionActionBusyKey === `activate:${drawer.agentInstanceId}:${version.id}`
    || state.evolutionActionBusyKey === `rollback:${drawer.agentInstanceId}:${version.id}`;
  let action = '<em>暂不可用</em>';
  if (current) action = '<em>当前使用</em>';
  else if (canActivate) action = `<button class="btn primary" type="button" data-personal-version-activate="${escapeAttr(drawer.agentInstanceId)}" data-version-id="${escapeAttr(version.id)}" data-expected-active-version-id="${escapeAttr(currentVersionId)}" ${busyAction || paused ? 'disabled' : ''}>使用此版本</button>`;
  else if (canRollback) action = `<button class="btn secondary" type="button" data-personal-version-rollback="${escapeAttr(drawer.agentInstanceId)}" data-target-version-id="${escapeAttr(version.id)}" data-expected-active-version-id="${escapeAttr(currentVersionId)}" ${busyAction ? 'disabled' : ''}>使用此版本</button>`;
  return `<article class="employee-skill-choice ${current ? 'is-current' : ''}"><div><span>${escapeHtml(personalSkillVersionLabel(version, versions))}</span><strong>${escapeHtml(personalSkillDifference(version))}</strong><small>${escapeHtml(formatDateTime(version.createdAt || version.updatedAt) || '生成时间未知')} · 仅此 Agent</small></div><div>${action}</div></article>`;
}

function renderPersonalSkillBaseCard(drawer = {}, versions = []) {
  const currentVersionId = currentPersonalSkillVersionId(drawer, versions);
  const current = !currentVersionId;
  const busy = state.evolutionActionBusyKey === `rollback:${drawer.agentInstanceId}:base`;
  return `<article class="employee-skill-choice ${current ? 'is-current' : ''}"><div><span>不使用个人版本</span><strong>只使用所选市场基础</strong><small>不会删除个人版本，之后可以随时重新选择。</small></div><div>${current ? '<em>当前使用</em>' : `<button class="btn secondary" type="button" data-personal-version-rollback="${escapeAttr(drawer.agentInstanceId)}" data-target-version-id="" data-expected-active-version-id="${escapeAttr(currentVersionId)}" ${busy ? 'disabled' : ''}>取消个人叠加</button>`}</div></article>`;
}

function currentPersonalSkillVersionId(drawer = {}, versions = []) {
  const active = versions.find((item) => item.status === 'active');
  if (active?.id) return active.id;
  const employee = employeeById(drawer.agentInstanceId) || {};
  const setting = (state.userAgentSettings || []).find((item) => item.id === drawer.agentInstanceId) || {};
  return employee.activePersonalSkillVersionId || setting.activePersonalSkillVersionId || '';
}

function personalSkillVersionLabel(version = {}, versions = []) {
  const ordered = [...versions].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  const index = ordered.findIndex((item) => item.id === version.id);
  return version.name || version.summary || `个人版 ${index >= 0 ? index + 1 : ''}`.trim();
}

function personalSkillDifference(version = {}) {
  const provided = version.changeSummary || version.change_summary || version.summary || version.description;
  if (provided) return plainTextSummary(provided, 96);
  const overlay = plainTextSummary(version.overlayText || version.overlay_text || '', 96);
  return overlay || '根据这个 Agent 的工作经验调整专属规则';
}

function renderSkillChangeItem(section = {}) {
  return `<article><strong>${escapeHtml(skillSectionTitle(section))}</strong><p>${escapeHtml(plainTextSummary(section.content || '能力规则已更新。', 120))}</p></article>`;
}

function renderEffectiveSkillSummary(effectiveSkill = null, versions = []) {
  if (!effectiveSkill) return `<article class="employee-effective-skill">
    ${renderEffectiveSkillHeader('基础版')}
    <p class="employee-effective-skill-empty">当前使用 Agent 自带的基础能力；个人进化规则仍会继续叠加。</p>
  </article>`;
  const activeVersion = versions.find((item) => item.id === effectiveSkill.marketVersionId);
  const presentation = skillVersionPresentation(effectiveSkill.marketVersionId, versions);
  const effectiveHash = effectiveSkill.effectiveSkillHash || '';
  return `<article class="employee-effective-skill">
    ${renderEffectiveSkillHeader(presentation.label)}
    <p class="employee-effective-skill-current">${escapeHtml(activeVersion ? skillVersionChangeSummary(activeVersion, versions) : '当前版本已生效，改动说明等待同步。')}</p>
    <div class="employee-effective-skill-metrics" role="list" aria-label="当前 Skill 状态">
      ${renderEffectiveSkillMetric('当前来源', effectiveSkill.fullMarketVersionId ? '完整版本' : '兼容旧版组合')}
      ${renderEffectiveSkillMetric('本版改动', Number((activeVersion?.sections || []).length))}
      ${renderEffectiveSkillMetric('兼容问题', Number((effectiveSkill.conflicts || []).length))}
    </div>
    <details class="employee-effective-skill-details"><summary>查看最终编译内容与技术信息</summary><p>版本 ID：${escapeHtml(effectiveSkill.marketVersionId || '基础版')}</p><p>有效 Hash：${escapeHtml(effectiveHash || '—')}</p><pre>${escapeHtml(effectiveSkill.effectiveSkill || '当前投影未返回 Skill 正文。')}</pre></details>
  </article>`;
}

function renderEffectiveSkillHeader(versionLabel = '基础版本') {
  return `<header class="employee-effective-skill-header"><div><span>当前生效</span><strong>当前有效 Skill</strong></div><em title="${escapeAttr(versionLabel)}">${escapeHtml(versionLabel)}</em></header>`;
}

function renderEffectiveSkillMetric(label = '', value = '', title = '') {
  const text = String(value ?? '');
  return `<span role="listitem"><small>${escapeHtml(label)}</small><strong${title ? ` title="${escapeAttr(title)}"` : ''}>${escapeHtml(text)}</strong></span>`;
}

function renderMarketHealth(health = null) {
  if (!health) return '';
  return `<div class="employee-market-health"><span>健康 ${escapeHtml(health.status || 'collecting')}</span><span>基线 ${Number(health.baselineScore || 0).toFixed(1)}</span><span>当前 ${Number(health.latestScore || 0).toFixed(1)}</span><span>失败率 ${formatPercentValue(health.latestFailureRate)}</span><span>任务 ${Number(health.observedTaskCount || 0)}</span></div>`;
}

function shortHash(value = '') {
  const text = String(value || '');
  return text ? `${text.slice(0, 10)}${text.length > 10 ? '…' : ''}` : '—';
}

function formatPercentValue(value) {
  const number = Number(value || 0);
  return `${(Math.abs(number) <= 1 ? number * 100 : number).toFixed(1)}%`;
}

function renderMemoryDrawer() {
  const drawer = state.employeeMemoryDrawer;
  if (!drawer) return '';
  const documents = drawer.documents || [];
  const activeDocuments = documents.filter((item) => item.scope === 'general' && item.lifecycleState !== 'archived')
    .sort((left, right) => String(right.lastUsedAt || right.updatedAt || '').localeCompare(String(left.lastUsedAt || left.updatedAt || '')));
  const archivedDocuments = documents.filter((item) => item.scope === 'general' && item.lifecycleState === 'archived')
    .sort((left, right) => String(right.lastUsedAt || right.updatedAt || '').localeCompare(String(left.lastUsedAt || left.updatedAt || '')));
  const employee = employeeById(drawer.agentInstanceId);
  const memoryCapability = state.employeeOverview?.capabilities?.multiMemory || {};
  const memoryWritable = memoryCapability.enabled && !memoryCapability.readOnly;
  const memoryDisabled = memoryWritable ? '' : `disabled title="${escapeAttr(employeeStatusMessage(memoryCapability.code, 'Memory 写入能力暂不可用'))}"`;
  return `<div class="employee-drawer-layer"><button class="employee-drawer-backdrop" type="button" data-employee-detail-close aria-label="关闭 Agent 详情"></button><aside class="employee-memory-drawer" role="dialog" aria-modal="true" aria-label="Agent 对话上下文"><header><div><span class="employee-drawer-kicker">${escapeHtml(employee?.family?.name || employee?.agentFamilyId || 'Agent')}</span><h2>${escapeHtml(employeeDisplayName(employee || {}))} 的对话上下文</h2><p>每个 Memory 是一条可独立切换、归档和恢复的 Agent 对话分支。</p></div><button class="employee-drawer-close" type="button" data-employee-detail-close aria-label="关闭">×</button></header>
    ${renderEmployeeDetailTabs(drawer.agentInstanceId, 'memory')}
    <details class="employee-memory-runtime-note"><summary>Memory 如何工作？</summary><p>切换 Memory 会恢复它自己的消息、文件和压缩边界，并开启新的模型线程。归档只会暂停使用，不会删除内容。</p></details>
    ${drawer.loading ? '<div class="employee-drawer-loading" role="status"><i aria-hidden="true"></i><span>正在读取对话上下文…</span></div>' : ''}
    ${drawer.error ? `<div class="employee-drawer-error" role="alert"><strong>Memory 暂不可用</strong><span>${escapeHtml(drawer.error)}</span><button class="btn secondary" type="button" data-employee-memory-retry="${escapeAttr(drawer.agentInstanceId)}">重试</button></div>` : ''}
    ${drawer.loading || drawer.error ? '' : `
    <div class="employee-drawer-toolbar"><span>${activeDocuments.length} 个活跃 · ${archivedDocuments.length} 个归档</span><div><button class="btn primary" type="button" data-employee-memory-create="${escapeAttr(drawer.agentInstanceId)}" ${memoryDisabled}>新建 Memory</button></div></div>
    <section class="employee-memory-document-section"><header><div><strong>活跃 Memory</strong><small>按最近使用排序；切换后下一条消息会使用对应上下文。</small></div></header><div class="employee-memory-document-list">${activeDocuments.map((document) => renderMemoryDocument(document, drawer, { archived: false })).join('') || '<div class="employee-drawer-empty">还没有活跃 Memory。</div>'}</div></section>
    <section class="employee-memory-document-section employee-memory-archived-section"><header><div><strong>已归档 Memory</strong><small>可只读查看、恢复，或作为历史资料引用。</small></div></header><div class="employee-memory-document-list">${archivedDocuments.map((document) => renderMemoryDocument(document, drawer, { archived: true })).join('') || '<div class="employee-drawer-empty compact">没有已归档 Memory。</div>'}</div></section>
    ${renderMemoryContextDetails(drawer.details, drawer.agentInstanceId)}`}
  </aside></div>`;
}

function renderMemoryDocument(document = {}, drawer = {}, { archived = false } = {}) {
  const selected = drawer.selectedDocumentId === document.id;
  const isCurrent = document.scope === 'general' && document.lifecycleState === 'active'
    && employeeById(drawer.agentInstanceId)?.currentMemory?.id === document.id;
  const memoryCapability = state.employeeOverview?.capabilities?.multiMemory || {};
  const memoryWritable = memoryCapability.enabled && !memoryCapability.readOnly;
  const action = !memoryWritable ? '' : archived
    ? `<div class="employee-memory-row-actions"><button class="employee-memory-switch" type="button" data-employee-memory-restore="${escapeAttr(document.id)}" data-agent-instance-id="${escapeAttr(drawer.agentInstanceId)}">恢复</button><button class="employee-memory-switch" type="button" data-employee-memory-restore-switch="${escapeAttr(document.id)}" data-agent-instance-id="${escapeAttr(drawer.agentInstanceId)}">恢复并切换</button><button class="employee-memory-archive" type="button" data-employee-memory-reference="${escapeAttr(document.id)}" data-agent-instance-id="${escapeAttr(drawer.agentInstanceId)}">引用</button></div>`
    : `<div class="employee-memory-row-actions">${isCurrent ? '' : `<button class="employee-memory-switch" type="button" data-employee-memory-switch="${escapeAttr(document.id)}" data-agent-instance-id="${escapeAttr(drawer.agentInstanceId)}">切换</button>`}<button class="employee-memory-switch" type="button" data-employee-memory-rename="${escapeAttr(document.id)}" data-agent-instance-id="${escapeAttr(drawer.agentInstanceId)}" data-memory-name="${escapeAttr(document.displayName || '')}">重命名</button>${isCurrent ? '' : `<button class="employee-memory-archive" type="button" data-employee-memory-archive="${escapeAttr(document.id)}" data-agent-instance-id="${escapeAttr(drawer.agentInstanceId)}">归档</button>`}</div>`;
  const presentation = memoryDocumentPresentation(document);
  return `<div class="employee-memory-document-row ${selected ? 'is-selected' : ''}"><button type="button" data-employee-memory-document="${escapeAttr(document.id)}" data-agent-instance-id="${escapeAttr(drawer.agentInstanceId)}"><span class="employee-memory-document-icon">${iconSvg('memory')}</span><span><strong>${escapeHtml(presentation.title)}</strong><small>${escapeHtml(document.summary || presentation.summary)}</small><small>${Number(document.messageCount || 0)} 条消息 · ${Number(document.fileCount || 0)} 个文件 · ${escapeHtml(formatDateTime(document.lastUsedAt || document.updatedAt) || '尚未使用')}</small></span><em>${isCurrent ? '当前使用' : archived ? '已归档' : '可切换'}</em></button>${action}</div>`;
}

function renderMemoryContextDetails(details = null, agentInstanceId = '') {
  if (!details?.document) return '<section class="employee-memory-version-panel"><div class="employee-drawer-empty compact">选择一个 Memory 查看内容预览。</div></section>';
  const document = details.document;
  const archived = document.lifecycleState === 'archived';
  const paths = (details.attachments || []).map(memoryAttachmentDisplayPath).filter(Boolean);
  return `<details class="employee-memory-version-panel employee-memory-context-detail" open><summary><span><strong>Memory 内容预览</strong><small>所选：${escapeHtml(document.displayName || 'Memory')} · ${archived ? '只读归档' : '活跃上下文'} · ${Number(document.messageCount || 0)} 条消息</small></span><em>点击折叠</em></summary><div class="employee-memory-context-detail-body">
      ${details.contextStates?.length ? `<div class="employee-memory-boundary">上下文边界：epoch ${Number(details.contextStates[0].contextEpoch || 1)}${details.contextStates[0].resetAfterCreatedAt ? ` · 最近压缩 ${escapeHtml(formatDateTime(details.contextStates[0].resetAfterCreatedAt))}` : ''}</div>` : ''}
      <div class="employee-memory-readonly-messages">${(details.messages || []).map((message) => `<article><strong>${message.role === 'user' ? '你' : 'Agent'}</strong><time>${escapeHtml(formatDateTime(message.createdAt) || '')}</time><p>${escapeHtml(plainTextSummary(message.content || '', 320))}</p></article>`).join('') || '<div class="employee-drawer-empty compact">这条 Memory 还没有消息。</div>'}</div>
      ${paths.length ? `<div class="employee-memory-readonly-files"><strong>相关文件路径</strong>${paths.map((filePath) => `<code>${escapeHtml(filePath)}</code>`).join('')}</div>` : ''}
      ${archived ? `<footer><button class="btn secondary" type="button" data-employee-memory-reference="${escapeAttr(document.id)}" data-agent-instance-id="${escapeAttr(agentInstanceId)}">引用到当前对话</button><button class="btn primary" type="button" data-employee-memory-branch="${escapeAttr(document.id)}" data-agent-instance-id="${escapeAttr(agentInstanceId)}">基于此 Memory 开始新对话</button></footer>` : ''}
    </div></details>`;
}

function memoryAttachmentDisplayPath(file = {}) {
  const metadata = file.metadata || {};
  const candidate = String(
    metadata.relativePath || metadata.relative_path || metadata.workspaceRelativePath || metadata.workspace_relative_path || '',
  ).trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (candidate && !candidate.startsWith('/') && !/^[A-Za-z]:\//.test(candidate)
    && !candidate.split('/').includes('..')) return candidate;
  const name = String(file.name || '').trim().replaceAll('\\', '/').split('/').at(-1) || '';
  return name ? `附件/${name}` : '';
}

function renderContextSpacePanel(contexts = [], documents = [], currentContextId = '', agentInstanceId = '', memoryWritable = false) {
  const items = contexts.filter((item) => item.contextKind !== 'legacy_history');
  const current = items.find((item) => item.id === currentContextId) || items[0] || null;
  const currentPresentation = contextSpacePresentation(current, documents);
  return `<details class="employee-context-panel"><summary><span><strong>运行上下文</strong><small>${escapeHtml(current ? `当前：${currentPresentation.title}` : '暂无可用上下文')}</small></span><em>${items.length} 个</em></summary><div class="employee-context-list">${items.map((item) => {
    const presentation = contextSpacePresentation(item, documents);
    const isCurrent = item.id === currentContextId;
    return `<button type="button" data-employee-context-switch="${escapeAttr(item.id)}" data-agent-instance-id="${escapeAttr(agentInstanceId)}" ${isCurrent || !memoryWritable ? 'disabled' : ''}><span><strong>${escapeHtml(presentation.title)}</strong><small>${escapeHtml(presentation.summary)}</small></span><em>${isCurrent ? '当前' : '切换'}</em></button>`;
  }).join('') || '<div class="employee-drawer-empty compact">暂无可切换的运行上下文。</div>'}<p>切换上下文会开始一个新模型线程，但不会删除原有记忆和会话。</p></div></details>`;
}

function renderSessionHistoryPanel(sessionHistory = []) {
  return `<details class="employee-context-panel"><summary><span><strong>历史会话</strong><small>只读查看，不会带入当前对话</small></span><em>${sessionHistory.length} 个</em></summary><div class="employee-context-list">${sessionHistory.map((session) => `<button type="button" data-employee-history-session="${escapeAttr(session.id)}"><span><strong>${escapeHtml(session.title || '历史会话')}</strong><small>${escapeHtml(formatDateTime(session.updatedAt) || '时间未知')}</small></span><em>查看</em></button>`).join('') || '<div class="employee-drawer-empty compact">没有旧会话。</div>'}</div></details>`;
}

function contextSpacePresentation(item = null, documents = []) {
  if (!item) return { title: '暂无运行上下文', summary: '开始对话后会自动建立' };
  const document = documents.find((candidate) => candidate.id === item.memoryDocumentId)
    || documents.find((candidate) => item.taskRunId && candidate.taskRunId === item.taskRunId)
    || documents.find((candidate) => item.projectId && candidate.projectId === item.projectId)
    || documents.find((candidate) => item.relationshipUserId && candidate.relationshipUserId === item.relationshipUserId);
  if (document) {
    const presentation = memoryDocumentPresentation(document);
    return { title: `${memoryScopeShortLabel(document.scope)} · ${presentation.title}`, summary: presentation.summary };
  }
  if (item.contextKind === 'task') return { title: '任务上下文', summary: '只在对应任务中加载任务进展和决定' };
  if (item.contextKind === 'project') return { title: '项目上下文', summary: '只在对应项目中加载项目记忆' };
  if (item.contextKind === 'relationship') return { title: '协作上下文', summary: '只在对应协作中加载关系记忆' };
  return { title: '常驻上下文', summary: '用于日常对话和通用工作' };
}

function renderMemoryVersion(version = {}, olderVersion = null, agentInstanceId = '') {
  const changeSummary = memoryVersionChangeSummary(version, olderVersion);
  return `<details class="employee-memory-row ${version.conflictState === 'unresolved' ? 'is-conflict' : ''}"><summary><span><strong>v${Number(version.versionNo || 0)} · ${escapeHtml(changeSummary)}</strong><small>${escapeHtml(formatDateTime(version.createdAt) || '时间未知')}</small></span><em>${version.conflictState === 'unresolved' ? '并发冲突' : escapeHtml(memoryReviewLabel(version.reviewStatus || version.sourceKind || ''))}</em></summary><pre>${escapeHtml(version.content || '')}</pre>${version.conflictState === 'unresolved' ? `<button class="btn primary" type="button" data-memory-conflict-resolve="${escapeAttr(version.id)}" data-memory-document-id="${escapeAttr(version.memoryDocumentId)}" data-agent-instance-id="${escapeAttr(agentInstanceId)}">采用此分支</button>` : ''}</details>`;
}

function memoryDocumentPresentation(document = {}) {
  const scope = document.scope || 'general';
  const rawName = String(document.displayName || '').trim();
  const heading = String(document.content || '').split(/\r?\n/).map((line) => line.match(/^#{1,3}\s+(.+)$/)?.[1]?.trim()).find((line) => isUsefulMemoryTitle(line)) || '';
  const fallbackTitle = ({ general: Number(document.slotNo || 0) === 0 ? '主要记忆' : `常驻记忆 ${Number(document.slotNo || 0) + 1}`, task: '任务进展', project: '项目记录', relationship: '协作记录' })[scope] || '记忆';
  const title = plainTextSummary(rawName || heading || fallbackTitle, 56);
  const lines = meaningfulMemoryLines(document.content).filter((line) => normalizeComparableText(line) !== normalizeComparableText(title));
  const summary = plainTextSummary(document.summary || lines[0] || memorySummaryFallback(scope), 96);
  return { title, summary };
}

function memoryVersionChangeSummary(version = {}, olderVersion = null) {
  const currentLines = meaningfulMemoryLines(version.content);
  if (!olderVersion) return currentLines[0] ? `初始记录：${plainTextSummary(currentLines[0], 42)}` : '建立初始记忆结构';
  const older = new Set(meaningfulMemoryLines(olderVersion.content).map(normalizeComparableText));
  const added = currentLines.find((line) => !older.has(normalizeComparableText(line)));
  if (added) return `新增：${plainTextSummary(added, 48)}`;
  const current = new Set(currentLines.map(normalizeComparableText));
  const removed = meaningfulMemoryLines(olderVersion.content).find((line) => !current.has(normalizeComparableText(line)));
  if (removed) return `整理并移除：${plainTextSummary(removed, 42)}`;
  return '内容整理，无明显新增';
}

function meaningfulMemoryLines(content = '') {
  const sectionNames = /^(stable learnings|reusable preferences|failure modes|workflow notes|task context|decisions|collaboration notes|reusable candidates|task updates|do not store|topic files|上下文|决定|协作记录|失败模式|工作流)$/i;
  return String(content || '').split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('<!--'))
    .map((line) => line.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((line) => line && !sectionNames.test(line) && !isGenericMemoryLabel(line) && !looksTechnicalLine(line));
}

function isUsefulMemoryTitle(value = '') {
  const text = String(value || '').trim();
  if (!text || text.length < 2 || looksTechnicalLine(text)) return false;
  if (/^(stable learnings|reusable preferences|failure modes|workflow notes|task context|decisions|collaboration notes|reusable candidates|task updates|do not store|topic files)$/i.test(text)) return false;
  return !isGenericMemoryLabel(text);
}

function isGenericMemoryLabel(value = '') {
  return /^(memory\d*|task[-_].*|project[-_].*|relationship[-_].*|work[-_ ]?progress|你好|对话|untitled|未命名)$/i.test(String(value || '').trim());
}

function looksTechnicalLine(value = '') {
  const text = String(value || '').trim();
  return /^(task_run_id|context_space_id|memory_document_id|project_id|relationship_id|scope)\s*[:：]/i.test(text)
    || /^(memdoc|memory|task|project|relationship|context)[_-][a-z0-9-]{12,}$/i.test(text)
    || /^[a-f0-9]{8}-[a-f0-9-]{20,}$/i.test(text);
}

function memorySummaryFallback(scope = '') {
  return ({ general: '记录这个 Agent 可长期复用的偏好、方法和注意事项。', task: '记录这项任务的进展、决定和下一步。', project: '记录项目中的关键背景、决定和复用经验。', relationship: '记录协作方式、约定和需要持续关注的事项。' })[scope] || '记录可在后续工作中复用的信息。';
}

function memoryScopeShortLabel(scope = '') {
  return ({ general: '常驻', task: '任务', project: '项目', relationship: '协作' })[scope] || '记忆';
}

function skillVersionPresentation(versionId = '', versions = []) {
  if (!versionId) return { label: '基础版', version: null };
  const ordered = [...versions].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  const index = ordered.findIndex((item) => item.id === versionId);
  const version = versions.find((item) => item.id === versionId) || null;
  return { label: index >= 0 ? `v${index + 1}` : '自定义版本', version };
}

function skillVersionChangeSummary(version = null, versions = []) {
  if (!version) return '使用 Agent 自带的基础能力与个人进化规则';
  const provided = version.changeSummary || version.change_summary || version.releaseNotes || version.release_notes || version.summary || version.description;
  if (provided) return plainTextSummary(provided, 96);
  const ordered = [...versions].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  const parent = versions.find((item) => item.id === version.parentVersionId) || ordered[Math.max(0, ordered.findIndex((item) => item.id === version.id) - 1)] || null;
  const currentSections = version.sections || [];
  if (!parent || parent.id === version.id) {
    const titles = currentSections.map(skillSectionTitle).filter(Boolean);
    return titles.length ? `初始版本，包含 ${titles.slice(0, 2).map((item) => `「${item}」`).join('、')}${titles.length > 2 ? `等 ${titles.length} 项能力` : ''}` : '初始能力版本';
  }
  const parentById = new Map((parent.sections || []).map((section) => [section.sectionId, section]));
  const currentIds = new Set(currentSections.map((section) => section.sectionId));
  const added = currentSections.filter((section) => !parentById.has(section.sectionId));
  const changed = currentSections.filter((section) => parentById.has(section.sectionId) && parentById.get(section.sectionId)?.contentHash !== section.contentHash);
  const removed = (parent.sections || []).filter((section) => !currentIds.has(section.sectionId));
  const parts = [];
  if (added.length) parts.push(`新增${skillChangeTitles(added)}`);
  if (changed.length) parts.push(`调整${skillChangeTitles(changed)}`);
  if (removed.length) parts.push(`移除${skillChangeTitles(removed)}`);
  return parts.join('；') || (currentSections.length ? `更新 ${currentSections.length} 项能力规则` : '能力规则整理与兼容性更新');
}

function skillChangeTitles(sections = []) {
  const titles = sections.map(skillSectionTitle).filter(Boolean);
  if (!titles.length) return `${sections.length} 项能力`;
  return `${titles.slice(0, 2).map((item) => `「${item}」`).join('、')}${titles.length > 2 ? `等 ${titles.length} 项` : ''}`;
}

function skillSectionTitle(section = {}) {
  const title = plainTextSummary(section.title || '', 24);
  return title && !looksTechnicalLine(title) ? title : '能力规则';
}

function plainTextSummary(value = '', maxLength = 96) {
  const text = String(value || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').replace(/[*_>#]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1)).trim()}…` : text;
}

function normalizeComparableText(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function employeeById(agentInstanceId = '') {
  return (state.employeeOverview?.roster || []).find((item) => item.id === agentInstanceId && item.agentFamilyId !== 'secretary_agent') || null;
}

function employeeDisplayName(item = {}) {
  return agentInstanceDisplayNameForUi(item, item.family?.name || item.agentFamilyId || '专业 Agent');
}

function normalizePerformance(performance = null, progressionSync = {}) {
  if (!performance) return { label: '待评估' };
  const level = performance.level || 'P1';
  return { label: `${level}${performance.provisional ? ' · 暂定' : ''}` };
}

function normalizeLeadership(leadership = null, progressionSync = {}) {
  if (!leadership) return {
    label: progressionSync.refreshedAt && !progressionSync.lastError ? 'L0 · 待评估' : 'L0 · 待同步',
    level: 'L0',
    score: 0,
    status: 'active',
    provisional: true,
  };
  const level = /^L[0-3]$/.test(String(leadership.level || '')) ? leadership.level : 'L0';
  const suffix = leadership.status === 'frozen' ? ' · 已冻结' : leadership.provisional ? ' · 暂定' : '';
  return { ...leadership, level, score: Number(leadership.score || 0), label: `${level} · ${Number(leadership.score || 0).toFixed(1)}${suffix}` };
}

function renderLeadershipSummary(item = {}, performance = {}, leadership = {}) {
  const actions = Array.isArray(item.leadershipActions) ? item.leadershipActions : [];
  const appeals = Array.isArray(item.leadershipAppeals) ? item.leadershipAppeals : [];
  const pending = actions.find((action) => action.action === 'promote' && action.status === 'pending');
  const pendingTrial = actions.find((action) => action.action === 'trial_requested' && action.status === 'pending');
  const pendingRestore = actions.find((action) => action.action === 'restore' && action.status === 'pending');
  const pendingAppeal = appeals.find((appeal) => appeal.status === 'pending');
  const metrics = leadership.metrics || {};
  const trial = leadershipTrialOffer(item, leadership);
  return `<details class="talent-directory-leadership" ${leadership.status === 'frozen' || pending ? 'open' : ''}>
    <summary><span>Leadership</span><strong>${escapeHtml(leadership.label || 'L0')}</strong></summary>
    <div class="talent-directory-leadership-panel">
      <p>${leadership.level === 'L0' ? '独立执行者；正式带队前需要受控试岗。' : leadership.level === 'L1' ? '可担任 task lead，最多协调 3 个 Agent、6 个节点。' : leadership.level === 'L2' ? '可负责单部门复杂任务图，最多 6 个 Agent、12 个节点。' : '可负责跨部门任务，最多 20 个 Agent、20 个节点和 4 个任务组。'}</p>
      <div class="talent-directory-leadership-metrics">
        ${leadershipMetric('交付质量', metrics.deliveryQuality)}
        ${leadershipMetric('拆解匹配', metrics.decompositionMatching)}
        ${leadershipMetric('验收返工', metrics.reviewReworkControl)}
        ${leadershipMetric('依赖协调', metrics.dependencyCoordination)}
        ${leadershipMetric('团队提升', metrics.teamEfficiencyUplift)}
        ${leadershipMetric('权限安全', metrics.safety)}
      </div>
      <small>最近 90 天有效领导任务 ${Number(leadership.leadershipTaskCount || 0)}/100；下一等级 ${escapeHtml(leadership.nextLevel || '已到顶级')}；状态 ${escapeHtml(leadership.reviewState || 'stable')}</small>
      <div class="talent-directory-leadership-actions">
        ${trial && !pendingTrial ? `<button type="button" data-employee-leadership-trial="${escapeAttr(item.id)}" data-role="${escapeAttr(trial.role)}" data-participant-count="${trial.participantCount}" data-node-count="${trial.nodeCount}" data-department-count="${trial.departmentCount}" data-state-revision="${Number(leadership.stateRevision || 0)}">${escapeHtml(trial.label)}</button>` : ''}
        ${pendingTrial ? '<span>试岗申请等待 HR/治理审批</span>' : ''}
        ${pending ? `<span>晋升 ${escapeHtml(pending.toLevel)} 等待 HR/治理审批</span>` : ''}
        ${leadership.status === 'frozen' && !pendingRestore ? `<button type="button" data-employee-leadership-restore="${escapeAttr(item.id)}" data-state-revision="${Number(leadership.stateRevision || 0)}">申请治理复核</button>` : ''}
        ${pendingRestore ? '<span>恢复申请等待治理审批</span>' : ''}
        ${pendingAppeal ? '<span>申诉处理中</span>' : `<button type="button" data-employee-leadership-appeal="${escapeAttr(item.id)}" data-kind="${leadership.status === 'frozen' ? 'freeze' : pending ? 'promotion' : 'assessment'}">提交申诉</button>`}
        <button type="button" data-employee-growth="${escapeAttr(item.id)}">成长与评估</button>
      </div>
    </div>
  </details>`;
}

function renderLeadershipActionPanel(item = {}, leadership = {}) {
  const actions = Array.isArray(item.leadershipActions) ? item.leadershipActions : [];
  const appeals = Array.isArray(item.leadershipAppeals) ? item.leadershipAppeals : [];
  const pending = actions.find((action) => action.action === 'promote' && action.status === 'pending');
  const pendingTrial = actions.find((action) => action.action === 'trial_requested' && action.status === 'pending');
  const pendingRestore = actions.find((action) => action.action === 'restore' && action.status === 'pending');
  const pendingAppeal = appeals.find((appeal) => appeal.status === 'pending');
  const trial = leadershipTrialOffer(item, leadership);
  return `<section class="employee-leadership-action-panel"><header><div><small>Leadership actions</small><strong>试岗与治理操作</strong></div><span>${escapeHtml(leadership.reviewState || 'stable')}</span></header><div>
    ${trial && !pendingTrial ? `<button class="btn primary" type="button" data-employee-leadership-trial="${escapeAttr(item.id)}" data-role="${escapeAttr(trial.role)}" data-participant-count="${trial.participantCount}" data-node-count="${trial.nodeCount}" data-department-count="${trial.departmentCount}" data-state-revision="${Number(leadership.stateRevision || 0)}">${escapeHtml(trial.label)}</button>` : ''}
    ${pendingTrial ? '<span>试岗申请等待 HR/治理审批</span>' : ''}
    ${pending ? `<span>晋升 ${escapeHtml(pending.toLevel)} 等待 HR/治理审批</span>` : ''}
    ${leadership.status === 'frozen' && !pendingRestore ? `<button class="btn secondary" type="button" data-employee-leadership-restore="${escapeAttr(item.id)}" data-state-revision="${Number(leadership.stateRevision || 0)}">申请治理复核</button>` : ''}
    ${pendingRestore ? '<span>恢复申请等待治理审批</span>' : ''}
    ${pendingAppeal ? '<span>申诉处理中</span>' : `<button class="btn secondary" type="button" data-employee-leadership-appeal="${escapeAttr(item.id)}" data-kind="${leadership.status === 'frozen' ? 'freeze' : pending ? 'promotion' : 'assessment'}">提交申诉</button>`}
  </div></section>`;
}

function leadershipTrialOffer(item = {}, leadership = {}) {
  if (item.employmentState !== 'active' || leadership.status !== 'active') return null;
  const existing = (item.leadershipActions || []).some((action) => action.action === 'trial_approved' && action.status === 'approved');
  if (existing) return null;
  if (leadership.level === 'L0' && !item.performance?.provisional && Number(String(item.performance?.level || 'P0').replace(/^P/i, '')) >= 3) {
    return { role: 'task_lead', participantCount: 3, nodeCount: 6, departmentCount: 1, label: '申请 L1 受控试岗' };
  }
  if (leadership.level === 'L1' && !item.performance?.provisional && Number(String(item.performance?.level || 'P0').replace(/^P/i, '')) >= 5) {
    return { role: 'team_lead', participantCount: 6, nodeCount: 12, departmentCount: 1, label: '申请 L2 team lead 试岗' };
  }
  if (leadership.level === 'L2' && !item.performance?.provisional && Number(String(item.performance?.level || 'P0').replace(/^P/i, '')) >= 7) {
    return { role: 'cross_team_lead', participantCount: 20, nodeCount: 20, departmentCount: 2, label: '申请 L3 跨部门试岗' };
  }
  return null;
}

function leadershipMetric(label, value) {
  const score = Math.max(0, Math.min(100, Number(value || 0)));
  return `<span><small>${escapeHtml(label)}</small><strong>${score.toFixed(0)}</strong><i style="--leadership-score:${score}%"></i></span>`;
}

function currentWorkLabel(work = null) {
  if (!work) return '当前空闲';
  if (typeof work === 'string') return work.trim() || '正在执行工作';
  const payload = work.payload || {};
  return work.currentAction || work.summary || work.title
    || payload.currentAction || payload.summary || payload.title || payload.taskTitle || payload.objective
    || (work.workKind === 'chat' ? '正在处理对话' : work.workKind === 'task_node' ? '正在执行任务节点' : '正在执行工作');
}

function evolutionSummary(proposal = null) {
  if (!proposal) return '尚无进化记录';
  const status = ({ applied: '已应用', ready: '待确认', proposed: '待确认', running: '进行中', queued: '排队中', evaluated_rejected: '未通过', failed: '失败', failed_terminal: '失败' })[proposal.status] || proposal.status || '已有记录';
  return proposal.summary ? `${status} · ${String(proposal.summary).slice(0, 34)}` : status;
}

function talentSkillTags(item = {}, department = '') {
  const metadata = item.metadata || item.family?.metadata || {};
  const raw = metadata.capabilityTags || metadata.capability_tags || metadata.skills || [];
  const tags = Array.isArray(raw) ? raw : [];
  return [...new Set([...tags.map(String), department].filter(Boolean))].slice(0, 3);
}

function memoryReviewLabel(value = '') {
  return ({ seeded: '初始版本', approved: '已审核', pending: '待审核', task_local: '任务记录', unreviewed: '未审核' })[value] || value || '历史版本';
}

function employeeStatusMessage(value = '', fallback = '') {
  const text = String(value || '').trim();
  const labels = {
    cloud_not_configured: '尚未连接云端，当前继续使用本地员工和 Memory 数据。',
    cloud_sync_pending: '员工数据正在与云端建立首次同步，请稍后刷新。',
    cloud_auth_required: '云端登录身份不可用，请重新登录后重试。',
    device_approval_pending: '当前设备正在等待另一台已授权设备批准。',
    device_not_approved: '当前设备尚未获得云端同步授权，请重新登录或稍后重试。',
    device_grant_invalid: '设备授权已失效，正在等待重新授权。',
    device_grant_expired: '设备授权已过期，正在等待重新授权。',
    device_grant_revoked: '设备授权已撤销，请重新授权当前设备。',
    cloud_sync_contract_unsupported: '云端服务版本较旧，暂不支持当前同步协议。',
    context_space_contract_unsupported: '云端服务版本较旧，暂不支持多 Memory 同步。',
    leadership_contract_unsupported: '云端服务版本较旧，暂不能同步领导职级。',
    leadership_cloud_unavailable: '领导职级服务暂不可用，请稍后重试。',
    market_pending_cloud: '市场版本正在等待云端数据。',
    market_generation_paused: '市场候选生成暂时暂停，已采用 Skill 不受影响。',
    performance_pending_cloud: '表现等级正在等待云端任务证据。',
    evolution_database_unavailable: '云端进化数据库暂不可用，本地聊天不受影响。',
    employee_cloud_unavailable: '云端员工服务暂时不可用，本地员工仍可使用；请稍后刷新。',
    employee_state_conflict: '该员工状态已被其他设备修改，请刷新后重试。',
    memory_runtime_context_not_applied: 'Memory 已选择，但运行上下文尚未确认应用。',
  };
  if (labels[text]) return labels[text];
  const matched = Object.entries(labels).find(([code]) => text.includes(code));
  if (matched) return matched[1];
  if (fallback && /^[a-z][a-z0-9_.:-]{0,79}$/i.test(text)) return `${fallback}（错误码：${text}）`;
  return fallback || text || '当前服务暂不可用，请稍后重试。';
}
