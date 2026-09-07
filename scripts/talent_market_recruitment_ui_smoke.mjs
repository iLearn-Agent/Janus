import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { state } from '../src/renderer/app/state.js';
import { renderEmployees } from '../src/renderer/app/views/employeesView.js';

const previous = {
  org: state.org,
  employeeOverview: state.employeeOverview,
  employeeMarketQuery: state.employeeMarketQuery,
  employeeMarketDepartmentFilter: state.employeeMarketDepartmentFilter,
  employeeMarketStatusFilter: state.employeeMarketStatusFilter,
  employeeMarketCandidateId: state.employeeMarketCandidateId,
  employeeMarketActionErrors: state.employeeMarketActionErrors,
  employeeContextMenu: state.employeeContextMenu,
  employeeSelectedInstanceId: state.employeeSelectedInstanceId,
  employeeDetailTab: state.employeeDetailTab,
  employeeMemoryDrawer: state.employeeMemoryDrawer,
  employeeMarketDrawer: state.employeeMarketDrawer,
  employeeGrowthDrawer: state.employeeGrowthDrawer,
  pluginCatalog: state.pluginCatalog,
};

try {
  state.org = {
    ...(state.org || {}),
    departments: [
      { id: 'general', name: '通用' },
      { id: 'research', name: '研究部' },
      { id: 'design', name: '设计部' },
      { id: 'data', name: '数据部' },
      { id: 'ppt_department', name: 'PPT 部门' },
    ],
  };
  state.employeeMarketQuery = '';
  state.employeeMarketDepartmentFilter = 'all';
  state.employeeMarketStatusFilter = 'all';
  state.employeeMarketCandidateId = '';
  state.employeeMarketActionErrors = {};
  state.employeeContextMenu = null;
  state.employeeSelectedInstanceId = '';
  state.employeeDetailTab = 'overview';
  state.pluginCatalog = [];
  state.employeeOverview = {
    authority: 'local',
    quota: { used: 2, active: 2, reserved: 0, limit: 10, remaining: 8 },
    capabilities: { recruitment: { enabled: true, code: 'employee_cloud_ready', message: '' } },
    roster: [
      {
        id: 'active-research-instance', agentFamilyId: 'research-agent', employmentState: 'active', routeEligible: true, stateRevision: 4,
        family: { name: '在职研究员', departmentId: 'research', metadata: { summary: 'Already recruited.' } },
      },
      {
        id: 'inactive-message-instance', agentFamilyId: 'inactive-message-agent', employmentState: 'inactive', routeEligible: false, stateRevision: 6,
        family: { name: '已停用员工', departmentId: 'design', metadata: { summary: 'Inactive employee history.' } },
      },
      {
        id: 'general-instance-a', agentFamilyId: 'general_agent', displayName: 'Generalist A', note: '主要执行综合任务',
        familyInstanceSeq: 1, employmentState: 'active', routeEligible: true, stateRevision: 2,
        family: { name: 'Generalist', departmentId: 'general', metadata: { summary: '通用执行员工。' } },
        currentMemory: { id: 'memdoc-general', scope: 'general', slotNo: 0, displayName: 'memory0.md', lifecycleState: 'active', content: '# Stable Learnings\n\n- 先给结论，再说明关键依据。' },
        currentContext: { activeMemoryDocumentId: 'memdoc-general' },
        availableMarketVersions: [
          { id: 'market-v2-internal', parentVersionId: 'market-v1-internal', createdAt: '2026-07-29T00:00:00.000Z', sections: [{ sectionId: 'recovery', title: '错误恢复', contentHash: 'hash-2' }] },
          { id: 'market-v1-internal', parentVersionId: '', createdAt: '2026-07-20T00:00:00.000Z', sections: [] },
        ],
        marketEffectiveSkill: { marketVersionId: 'market-v2-internal', adoptedSections: ['recovery'], conflicts: [], effectiveSkillHash: 'effective-hash' },
      },
      {
        id: 'general-instance-b', agentFamilyId: 'general_agent', displayName: '备用研究助手', note: '备用实例备注',
        familyInstanceSeq: 2, employmentState: 'inactive', routeEligible: false, stateRevision: 3,
        family: { name: 'Generalist', departmentId: 'general', metadata: { summary: '通用执行员工。' } },
      },
    ],
    recruitableFamilies: [
      {
        id: 'writer-agent', name: '写作 Agent', departmentId: 'research', canRecruit: true,
        employmentState: 'not_recruited', metadata: { summary: '整理证据并形成报告。', capabilityTags: ['检索', '写作'] },
      },
      {
        id: 'design-agent', name: '设计 Agent', departmentId: 'design', canRecruit: true, employmentState: 'inactive',
        instances: [{ id: 'inactive-design-instance', employmentState: 'inactive', stateRevision: 9 }],
        metadata: { summary: '制作视觉方案。', capabilityTags: ['视觉', '排版'] },
      },
      {
        id: 'general_agent', name: 'Generalist', departmentId: 'general', canRecruit: true, recruitable: true,
        employmentState: 'recruitable', activeInstanceCount: 1, instanceCount: 2,
        instances: [
          { id: 'general-instance-a', employmentState: 'active', familyInstanceSeq: 1, displayName: 'Generalist A' },
          { id: 'general-instance-b', employmentState: 'inactive', familyInstanceSeq: 2, displayName: '备用研究助手' },
        ],
        metadata: { summary: '可重复招募的通用执行 Agent。', capabilityTags: ['通用问答与分析', '文件和代码任务处理'] },
      },
      {
        id: 'general_agent_4', name: 'General Agent 4', departmentId: 'general', canRecruit: true, recruitable: true,
        employmentState: 'recruitable', metadata: { summary: '后续新增的通用类型 Agent。' },
      },
      {
        id: 'research-agent', name: '在职研究员', departmentId: 'research', canRecruit: true, employmentState: 'recruitable',
        instances: [{ id: 'active-research-instance', employmentState: 'active', stateRevision: 3 }], activeInstanceCount: 1,
      },
      {
        id: 'quota-blocked-agent', name: '当前不可招募', departmentId: 'data', canRecruit: false,
        recruitmentCode: 'employee_quota_exceeded', employmentState: 'not_recruited',
      },
      { id: 'secretary_agent', name: 'uBuddy', canRecruit: true, employmentState: 'not_recruited' },
    ],
  };

  const market = renderEmployees();
  assert.doesNotMatch(market, /公司集群进化/);
  assert.doesNotMatch(market, /员工团队/);
  assert.match(market, /title="在职研究员 · 左键对话，右键管理"/);
  assert.match(market, /data-employee-installed-context="active-research-instance"/);
  assert.doesNotMatch(market, /data-employee-installed-context="writer-agent"/);
  assert.match(market, />在职员工</);
  assert.match(market, />已停用员工</);
  assert.match(market, /data-employee-installed-context="inactive-message-instance"[^>]*data-employee-market-reactivate/);
  assert.match(market, /title="Generalist A · 左键对话，右键管理"/);
  assert.doesNotMatch(market, /General Agent 4/);
  assert.match(market, /<strong>Generalist A<\/strong>/);
  assert.doesNotMatch(market, /<strong>Generalist B<\/strong>/);
  assert.match(market, /talent-directory-card-title"><strong>Generalist<\/strong>/);
  assert.match(market, /title="备用研究助手 · 左键重新启用，右键管理"/);
  assert.doesNotMatch(market, />重新启用 备用研究助手</);
  assert.match(market, /当前不可招募/);
  assert.match(market, /data-employee-recruit="quota-blocked-agent" disabled/);
  assert.doesNotMatch(market, /uBuddy/);
  assert.doesNotMatch(market, /云端同步|同步状态/);
  assert.match(market, /talent-directory-quota/);
  assert.match(market, /<strong>2 \/ 10<\/strong>/);
  assert.match(market, /role="progressbar"[^>]*aria-valuenow="2"/);
  assert.match(market, /style="width:20%"/);
  assert.match(market, /剩余 8 名/);
  assert.doesNotMatch(market, /talent-directory-title-icon|data-employees-refresh/);
  assert.match(market, /placeholder="搜索人才"/);
  assert.match(market, />我的员工</);
  assert.doesNotMatch(market, />公开<|>个人</);
  assert.match(market, />精选人才</);
  assert.match(market, /talent-directory-section-head"><h2>精选人才<\/h2><details class="talent-directory-filter-menu"/);
  assert.match(market, /id="employee-market-search"/);
  assert.match(market, /data-employee-market-department-option="all"/);
  assert.match(market, /role="menuitemradio"/);
  assert.doesNotMatch(market, /整理证据并形成报告/);
  assert.match(market, /研究部/);
  assert.match(market, /data-employee-market-candidate-open="writer-agent"/);
  assert.match(market, /talent-directory-compact-tags/);
  assert.match(market, /data-employee-recruit="writer-agent"/);
  assert.match(market, /data-employee-market-candidate-open="general_agent"/);
  assert.match(market, /data-employee-recruit="general_agent"[^>]*>再招募</);
  assert.doesNotMatch(market, /general_agent_[123]/);
  assert.match(market, /data-employee-recruit="design-agent"/);
  assert.match(market, /已招募 1 名 · 可继续招募/);

  state.employeeMarketCandidateId = 'writer-agent';
  const candidateDetail = renderEmployees();
  assert.match(candidateDetail, /talent-candidate-drawer/);
  assert.match(candidateDetail, /人才介绍/);
  assert.match(candidateDetail, /整理证据并形成报告/);
  assert.match(candidateDetail, /Skill 与实例/);
  state.employeeMarketCandidateId = '';

  state.employeeMarketCandidateId = 'general_agent';
  const generalCandidateDetail = renderEmployees();
  assert.match(generalCandidateDetail, /Generalist A/);
  assert.match(generalCandidateDetail, /可重复招募的通用执行 Agent/);
  assert.match(generalCandidateDetail, /Agent 类型<\/small><strong>general_agent/);
  assert.match(generalCandidateDetail, /A\/B\/C/);
  state.employeeMarketCandidateId = '';

  state.employeeMarketQuery = '备用实例备注';
  const noteSearch = renderEmployees();
  assert.match(noteSearch, /title="备用研究助手 · 左键重新启用，右键管理"/);
  state.employeeMarketQuery = '';

  state.employeeBusyCommandId = 'busy-recruit';
  state.employeeBusyTargetId = 'writer-agent';
  const busyMarket = renderEmployees();
  assert.match(busyMarket, /data-employee-recruit="writer-agent" disabled>处理中…/);
  state.employeeBusyCommandId = '';
  state.employeeBusyTargetId = '';

  state.employeeMarketActionErrors = { 'writer-agent': '招募失败，请重试。' };
  const failedMarket = renderEmployees();
  assert.match(failedMarket, /招募失败，请重试/);
  assert.match(failedMarket, /data-employee-recruit="writer-agent"[^>]*>重试/);
  state.employeeMarketActionErrors = {};

  state.employeeMarketQuery = '排版';
  const searched = renderEmployees();
  assert.match(searched, /设计 Agent/);
  assert.doesNotMatch(searched, /写作 Agent/);

  state.employeeMarketQuery = '不存在的人才';
  const emptySearch = renderEmployees();
  assert.doesNotMatch(emptySearch, /talent-directory-empty|没有匹配的人才|当前没有可招募人才/);

  state.employeeMarketQuery = '';
  state.employeeMarketDepartmentFilter = 'research';
  const departmentFiltered = renderEmployees();
  assert.match(departmentFiltered, /写作 Agent/);
  assert.doesNotMatch(departmentFiltered, /设计 Agent/);

  state.employeeMarketDepartmentFilter = 'all';
  state.employeeOverview = {
    ...state.employeeOverview,
    roster: [
      ...state.employeeOverview.roster,
      {
        id: 'recruited-writer-instance', agentFamilyId: 'writer-agent', employmentState: 'active', routeEligible: true,
        family: { name: '写作 Agent', departmentId: 'research', metadata: { summary: '整理证据并形成报告。' } },
      },
    ],
    recruitableFamilies: state.employeeOverview.recruitableFamilies.map((item) => item.id === 'writer-agent'
      ? { ...item, canRecruit: true, employmentState: 'recruitable', activeInstanceCount: 1,
        instances: [{ id: 'recruited-writer-instance', employmentState: 'active', stateRevision: 1 }] }
      : item),
  };
  const marketAfterRecruitment = renderEmployees();
  assert.match(marketAfterRecruitment, /data-employee-recruit="writer-agent"/);
  assert.match(marketAfterRecruitment, /已招募 1 名 · 可继续招募/);
  assert.match(marketAfterRecruitment, /data-employee-open-chat="recruited-writer-instance"/);
  assert.match(marketAfterRecruitment, /data-employee-installed-context="recruited-writer-instance"/);

  state.pluginCatalog = [{
    id: 'ppt_creation', name: 'PPT 制作技能', providesAgentIds: ['ppt'], status: { installed: false, available: true },
  }];
  state.employeeOverview = {
    ...state.employeeOverview,
    recruitableFamilies: [
      ...state.employeeOverview.recruitableFamilies,
      {
        id: 'ppt', name: 'PPT Designer', departmentId: 'ppt_department', canRecruit: false,
        recruitmentCode: 'agent_skill_install_required', metadata: { summary: '制作可编辑演示文稿。' },
      },
    ],
    roster: [
      ...state.employeeOverview.roster,
      {
        id: 'recruited-ppt-instance', agentFamilyId: 'ppt', employmentState: 'active', routeEligible: false,
        family: { name: 'PPT Designer', departmentId: 'ppt_department' },
      },
    ],
  };
  const setupRequiredMarket = renderEmployees();
  assert.match(setupRequiredMarket, /data-plugin-install="ppt_creation"[^>]*data-plugin-agent-family="ppt"/);
  assert.match(setupRequiredMarket, /需先安装 PPT 制作技能，安装后才可招募/);
  assert.doesNotMatch(setupRequiredMarket, /data-employee-recruit="ppt"/);
  assert.match(setupRequiredMarket, /data-employee-installed-context="recruited-ppt-instance"[^>]*data-open-plugin-settings/);
  assert.match(setupRequiredMarket, /data-plugin-agent-family="ppt"/);
  state.employeeMarketCandidateId = 'ppt';
  const setupRequiredCandidate = renderEmployees();
  assert.match(setupRequiredCandidate, /必须先安装该 Skill，安装完成后才可招募此 Agent/);
  assert.match(setupRequiredCandidate, /data-open-plugin-settings[^>]*data-plugin-id="ppt_creation"/);
  assert.match(setupRequiredCandidate, /talent-candidate-actions[^]*?data-plugin-install="ppt_creation"/);
  assert.doesNotMatch(setupRequiredCandidate, /talent-candidate-actions[^]*?data-employee-recruit="ppt"/);
  state.employeeMarketCandidateId = '';
  state.employeeSelectedInstanceId = 'recruited-ppt-instance';
  state.employeeDetailTab = 'overview';
  const setupRequiredDetail = renderEmployees();
  assert.match(setupRequiredDetail, /该员工来自旧版招募记录；安装完成前不能进入聊天和任务候选池/);
  assert.match(setupRequiredDetail, /安装技能后对话/);

  state.pluginCatalog = [{
    id: 'ppt_creation', name: 'PPT 制作技能', providesAgentIds: ['ppt'], status: { installed: true, available: true },
  }];
  state.employeeSelectedInstanceId = '';
  const routePendingMarket = renderEmployees();
  assert.match(routePendingMarket, /data-employee-recruit="ppt" disabled[^>]*>正在刷新 Skill 状态…</);
  assert.match(routePendingMarket, /Skill 已安装，正在刷新招募状态/);
  assert.doesNotMatch(routePendingMarket, /data-employee-recruit="ppt"[^>]*>员工额度已满</);
  assert.match(routePendingMarket, /data-employee-installed-context="recruited-ppt-instance"[^>]*data-employee-open-chat="recruited-ppt-instance"/);
  assert.match(routePendingMarket, /is-route-pending/);
  assert.doesNotMatch(routePendingMarket, /talent-directory-installed-item[^>]*is-disabled/);
  state.employeeOverview = {
    ...state.employeeOverview,
    recruitableFamilies: state.employeeOverview.recruitableFamilies.map((item) => item.id === 'ppt'
      ? { ...item, canRecruit: true, recruitmentCode: 'recruit' }
      : item),
  };
  const installedRecruitableMarket = renderEmployees();
  assert.match(installedRecruitableMarket, /data-employee-recruit="ppt" [^>]*>招募</);
  assert.doesNotMatch(installedRecruitableMarket, /data-employee-recruit="ppt" disabled/);
  state.employeeSelectedInstanceId = 'recruited-ppt-instance';
  const routePendingDetail = renderEmployees();
  assert.match(routePendingDetail, /data-employee-open-chat="recruited-ppt-instance"[^>]*>刷新状态并对话</);
  state.employeeSelectedInstanceId = '';
  state.pluginCatalog = [];

  state.employeeContextMenu = { agentInstanceId: 'active-research-instance', x: 260, y: 180 };
  const installedContextMenu = renderEmployees();
  assert.match(installedContextMenu, /class="employee-context-menu"/);
  assert.match(installedContextMenu, /data-employee-context-action="profile"/);
  assert.match(installedContextMenu, /data-employee-context-action="memory"/);
  assert.match(installedContextMenu, />记忆与进化</);
  assert.match(installedContextMenu, /data-employee-context-action="versions"/);
  assert.match(installedContextMenu, />版本管理</);
  assert.match(installedContextMenu, /data-employee-context-action="deactivate"/);
  assert.match(installedContextMenu, />停用员工</);
  state.employeeContextMenu = null;

  state.employeeContextMenu = { agentInstanceId: 'writer-agent', x: 260, y: 180 };
  assert.doesNotMatch(renderEmployees(), /class="employee-context-menu"/);
  state.employeeContextMenu = { agentInstanceId: 'inactive-message-instance', x: 260, y: 180 };
  const inactiveContextMenu = renderEmployees();
  assert.match(inactiveContextMenu, /class="employee-context-menu"/);
  assert.match(inactiveContextMenu, /data-employee-context-action="reactivate"/);
  state.employeeContextMenu = null;

  state.employeeSelectedInstanceId = 'active-research-instance';
  state.employeeDetailTab = 'overview';
  const activeDetail = renderEmployees();
  assert.match(activeDetail, /data-employee-deactivate="active-research-instance"/);
  assert.match(activeDetail, />停用员工</);
  assert.match(activeDetail, /Agent 启用状态已由云端确认；专业与领导等级数据正在完成首次同步/);
  assert.match(activeDetail, /待评估 · L0 · 待同步/);

  state.employeeSelectedInstanceId = 'general-instance-a';
  const generalInstanceDetail = renderEmployees();
  assert.match(generalInstanceDetail, /data-employee-profile-form="general-instance-a"/);
  assert.match(generalInstanceDetail, /value="Generalist A"/);
  assert.match(generalInstanceDetail, /主要执行综合任务/);
  assert.match(generalInstanceDetail, /data-employee-profile-reset/);
  assert.match(generalInstanceDetail, /正在使用的 Skill[\s\S]*v2/);
  assert.match(generalInstanceDetail, /新增「错误恢复」/);
  assert.match(generalInstanceDetail, /<details class="employee-profile-editor">/);

  state.employeeOverview = {
    ...state.employeeOverview,
    capabilities: { ...state.employeeOverview.capabilities, multiMemory: { enabled: true, readOnly: false, code: 'ok' } },
  };
  state.employeeDetailTab = 'memory';
  state.employeeMemoryDrawer = {
    agentInstanceId: 'general-instance-a',
    loading: false,
    error: '',
    selectedDocumentId: 'memdoc-task-random-id',
    documents: [
      { id: 'memdoc-general', scope: 'general', slotNo: 0, displayName: 'memory0.md', lifecycleState: 'active', syncEnabled: true, allowPersonalEvolution: true,
        content: '# Stable Learnings\n\n- 先给结论，再说明关键依据。', updatedAt: '2026-07-29T08:00:00.000Z' },
      { id: 'memdoc-task-random-id', scope: 'task', displayName: 'work-progress.md', taskRunId: 'task_72c2016e-random', lifecycleState: 'active', syncEnabled: true,
        content: '# work-progress\n\n## Task Updates\n\n- 已完成登录页重构，下一步补充回归测试。', updatedAt: '2026-07-30T08:00:00.000Z' },
    ],
    contexts: { current: { activeContextSpaceId: 'context-task' }, items: [
      { id: 'context-general', contextKind: 'general_memory', memoryDocumentId: 'memdoc-general' },
      { id: 'context-task', contextKind: 'task', taskRunId: 'task_72c2016e-random' },
    ] },
    sessionHistory: [{ id: 'session-old', title: '登录页早期讨论', updatedAt: '2026-07-28T08:00:00.000Z' }],
    versions: [
      { id: 'memory-version-2', memoryDocumentId: 'memdoc-task-random-id', versionNo: 2, reviewStatus: 'approved', createdAt: '2026-07-30T08:00:00.000Z', content: '# work-progress\n\n## Task Updates\n\n- 已完成登录页重构，下一步补充回归测试。' },
      { id: 'memory-version-1', memoryDocumentId: 'memdoc-task-random-id', versionNo: 1, reviewStatus: 'seeded', createdAt: '2026-07-29T08:00:00.000Z', content: '# work-progress\n\n## Task Updates\n\n- 已开始登录页重构。' },
    ],
    details: {
      document: { id: 'memdoc-task-random-id', scope: 'task', displayName: '任务进展', lifecycleState: 'active', messageCount: 1 },
      messages: [{ id: 'memory-message-1', role: 'assistant', content: '已完成登录页重构，下一步补充回归测试。', createdAt: '2026-07-30T08:00:00.000Z' }],
      attachments: [],
      contextStates: [{ contextEpoch: 2, resetAfterCreatedAt: '2026-07-30T07:00:00.000Z' }],
    },
  };
  const memoryDetail = renderEmployees();
  assert.match(memoryDetail, /Generalist A 的对话上下文/);
  assert.match(memoryDetail, /<details class="employee-memory-runtime-note">/);
  assert.match(memoryDetail, /Memory 内容预览[\s\S]*任务进展[\s\S]*已完成登录页重构，下一步补充回归测试/);
  assert.match(memoryDetail, /上下文边界：epoch 2/);
  assert.doesNotMatch(memoryDetail, /<details class="employee-context-panel">/);
  assert.doesNotMatch(memoryDetail, /employee-memory-tags|employee-memory-document-body|文档 ID：memdoc-task-random-id/);

  state.employeeSelectedInstanceId = 'general-instance-a';
  state.employeeDetailTab = 'skill';
  state.employeeMemoryDrawer = null;
  state.employeeMarketDrawer = {
    agentInstanceId: 'general-instance-a', agentFamilyId: 'general_agent', familyName: 'Generalist', recruited: true,
    source: 'employees', loading: false, busy: false, error: '', personalError: '', conflictPreview: null, canary: null,
    effectiveSkill: { marketVersionId: 'market-v2-internal', fullMarketVersionId: 'market-v2-internal', adoptedSections: ['recovery'], conflicts: [], effectiveSkillHash: 'effective-hash', effectiveSkill: '最终 Skill 内容' },
    personalVersions: { items: [
      { id: 'personal-v2', status: 'active', stabilityStatus: 'stable', createdAt: '2026-07-30T00:00:00.000Z', overlayText: '优先给出可执行的恢复步骤。' },
      { id: 'personal-v1', status: 'archived', stabilityStatus: 'stable', createdAt: '2026-07-25T00:00:00.000Z', overlayText: '先解释失败原因。' },
    ] },
    items: [
      { id: 'market-v2-internal', parentVersionId: 'market-v1-internal', createdAt: '2026-07-29T00:00:00.000Z', status: 'released', adoption: { full: 'adopted', sections: {} }, sections: [{ sectionId: 'recovery', title: '错误恢复', content: '遇到失败时保留证据并给出恢复路径。', contentHash: 'hash-2' }] },
      { id: 'market-v1-internal', parentVersionId: '', createdAt: '2026-07-20T00:00:00.000Z', status: 'released', adoption: { full: '', sections: {} }, sections: [] },
    ],
  };
  const skillVersions = renderEmployees();
  assert.match(skillVersions, /<h2>Skill 版本<\/h2>/);
  assert.match(skillVersions, /data-employee-detail-tab="skill"[^>]*>Skill<\/button>/);
  assert.match(skillVersions, /市场版本[\s\S]*同类 Agent 共享的能力基础/);
  assert.match(skillVersions, /我的版本[\s\S]*只属于这个 Agent 实例/);
  assert.match(skillVersions, /v2[\s\S]*新增「错误恢复」[\s\S]*当前使用/);
  assert.match(skillVersions, /个人版 2[\s\S]*优先给出可执行的恢复步骤[\s\S]*当前使用/);
  assert.doesNotMatch(skillVersions, /技术信息|版本 ID：|编译算法|最终 Skill 内容|Canary|employee-market-health/);
  assert.doesNotMatch(skillVersions, /data-market-adopt="|data-market-section-id=/);
  assert.equal((skillVersions.match(/data-market-adopt-full/g) || []).length, 1);
  state.employeeMarketDrawer = null;
  state.employeeSelectedInstanceId = 'active-research-instance';
  state.employeeDetailTab = 'overview';

  state.employeeOverview = {
    ...state.employeeOverview,
    roster: state.employeeOverview.roster.map((item) => item.id === 'active-research-instance'
      ? { ...item, progressionSync: { status: 'synchronized', refreshedAt: '2026-07-28T00:00:00.000Z', lastError: '' } }
      : item),
  };
  state.employeeSelectedInstanceId = 'active-research-instance';
  const evaluatedEmptyDetail = renderEmployees();
  assert.match(evaluatedEmptyDetail, /Agent 与等级服务均已同步；当前尚无足够的有效任务样本/);
  assert.match(evaluatedEmptyDetail, /待评估 · L0 · 待评估/);

  state.employeeSelectedInstanceId = 'inactive-message-instance';
  const inactiveDetail = renderEmployees();
  assert.match(inactiveDetail, /data-employee-reactivate-open-chat="inactive-message-instance"/);
  assert.match(inactiveDetail, /重新启用并对话/);

  state.employeeSelectedInstanceId = 'active-research-instance';
  state.employeeOverview = {
    ...state.employeeOverview,
    capabilities: { recruitment: { enabled: false, code: 'cloud_auth_required', message: '请先登录并绑定云端账号。' } },
  };
  const cloudAuthRequired = renderEmployees();
  assert.match(cloudAuthRequired, /data-employee-cloud-auth-settings/);
  assert.match(cloudAuthRequired, /请先登录并绑定云端账号/);
  assert.match(cloudAuthRequired, /data-employee-deactivate="active-research-instance"[^>]*disabled/);
  assert.match(cloudAuthRequired, /data-employee-recruit="design-agent"[^>]*disabled/);
  state.employeeMarketActionErrors = {
    'design-agent': '招募失败，请重试。',
    'inactive-message-instance': '重新启用失败，请重试。',
  };
  state.employeeContextMenu = { agentInstanceId: 'active-research-instance', x: 12, y: 12 };
  const cloudAuthBlockedActions = renderEmployees();
  assert.match(cloudAuthBlockedActions, /data-employee-context-action="deactivate"[^>]*disabled/);
  assert.match(cloudAuthBlockedActions, /data-employee-recruit="design-agent"[^>]*disabled>重试/);
  assert.match(cloudAuthBlockedActions, /已停用员工[\s\S]*重新启用失败，请重试/);

  const rendererSource = await readFile(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
  assert.match(rendererSource, /async function runEmployeeCommand[\s\S]*if \(state\.employeeBusyCommandId\) return null/);
  assert.match(rendererSource, /async function recruitEmployeeFromMarket[\s\S]*runEmployeeCommand\('recruit',[\s\S]*state\.employeeMarketCandidateId = ''/);
  const marketRecruitSource = rendererSource.slice(rendererSource.indexOf('async function recruitEmployeeFromMarket'), rendererSource.indexOf('async function reactivateEmployeeFromMarket'));
  assert.doesNotMatch(marketRecruitSource, /openEmployeeChatAfterCommand/);
  assert.match(rendererSource, /async function reactivateEmployeeAndOpenChat[\s\S]*runEmployeeCommand\('reactivate',[\s\S]*openEmployeeChatAfterCommand\(reactivated\.id/);
  assert.match(rendererSource, /captureEmployeeMarketScrollState[\s\S]*restoreEmployeeMarketScrollState/);
  assert.match(rendererSource, /async function openEmployeeChatAfterCommand[\s\S]*await openEmployeeChat\(agentInstanceId\)/);
  assert.match(rendererSource, /确认停用这名员工/);
  assert.match(rendererSource, /data-employee-installed-context[\s\S]*contextmenu/);
  assert.match(rendererSource, /data-employee-context-action[\s\S]*openEmployeeMemory/);
  assert.match(rendererSource, /data-employee-context-action[\s\S]*openEmployeeMarket/);
  assert.match(rendererSource, /deactivateEmployeeWithConfirmation/);
  assert.match(rendererSource, /data-employee-reactivate-open-chat/);
  assert.match(rendererSource, /data-employee-profile-form[\s\S]*updateEmployeeProfile/);
  assert.match(rendererSource, /state\.employeeMarketQuery = event\.target\.value/);
  assert.match(rendererSource, /async function openEmployeeChat[\s\S]*await refreshEmployeeOverview\(\)[\s\S]*本机路由状态仍未同步完成/);
  assert.match(rendererSource, /const employeeRefresh = \['friends', 'messages'\]\.includes\(view\)[\s\S]*refreshEmployeeOverview\(\{ refreshCloud: false \}\)[\s\S]*const opening = openNetworkPanel\(view\)[\s\S]*await opening/);
  assert.match(rendererSource, /const localOnly = options\?\.refreshCloud === false;[\s\S]*if \(employeeOverviewRefreshPromise\)[\s\S]*employeeOverviewRefreshMode === 'local'[\s\S]*return refreshEmployeeOverview\(options\)/);
  assert.match(rendererSource, /employeeOverviewRefreshPromise = refreshPromise;[\s\S]*return refreshPromise/);
  assert.match(rendererSource, /const refreshSequence = \+\+employeeOverviewRefreshSequence;[\s\S]*if \(refreshSequence !== employeeOverviewRefreshSequence\) return state\.employeeOverview/);
  assert.match(rendererSource, /\[data-plugin-chat\][\s\S]*await refreshEmployeeOverview\(\)/);
  const workspaceUiSource = await readFile(new URL('../src/renderer/app/core/workspace-ui.css', import.meta.url), 'utf8');
  assert.match(workspaceUiSource, /\.employees-view > \.employee-drawer-layer\s*\{[\s\S]*?width:\s*auto;[\s\S]*?margin:\s*0;/);
  const employeeStyles = await readFile(new URL('../src/renderer/app/features/employees/styles.css', import.meta.url), 'utf8');
  const installedListStyles = employeeStyles.slice(
    employeeStyles.indexOf('.talent-directory-installed-list {'),
    employeeStyles.indexOf('.talent-directory-installed-group {'),
  );
  assert.match(installedListStyles, /display:\s*grid/);
  assert.match(installedListStyles, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(280px,\s*1fr\)\)/);
  assert.match(installedListStyles, /overflow:\s*visible/);
  assert.doesNotMatch(installedListStyles, /overflow-x:\s*auto/);
  assert.match(employeeStyles, /@media \(max-width: 760px\)[\s\S]*?\.talent-directory-installed-list,[\s\S]*?grid-template-columns:\s*1fr/);
  const workStatusStyles = await readFile(new URL('../src/renderer/app/features/ubuddy/styles.css', import.meta.url), 'utf8');
  const installedCardStyles = workStatusStyles.slice(
    workStatusStyles.indexOf('.talent-directory-installed-item {'),
    workStatusStyles.indexOf('.talent-directory-installed-item:hover'),
  );
  assert.match(installedCardStyles, /width:\s*100%/);
  assert.match(installedCardStyles, /min-width:\s*0/);
  assert.doesNotMatch(installedCardStyles, /min-width:\s*286px/);

  console.log('talent market recruitment UI smoke passed');
} finally {
  Object.assign(state, previous);
}
