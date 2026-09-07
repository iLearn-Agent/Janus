import { state } from '../state.js';
import { iconSvg } from '../ui/icons.js';
import { clampNumber, clipInline, escapeAttr, escapeHtml, formatDateTime, formatNumber, formatPercent, renderStatusBadge, statusLabel } from '../utils/format.js';

let viewDeps = {};

export function renderEvolution(deps = {}) {
  viewDeps = deps;
  return renderEvolutionView();
}

function agentNameById(...args) {
  return viewDeps.agentNameById?.(...args) || '';
}

function departmentName(...args) {
  return viewDeps.departmentName?.(...args) || '';
}

function shortAgentLabel(...args) {
  return viewDeps.shortAgentLabel?.(...args) || '';
}

function renderEvolutionView() {
  const overview = state.evolution || {};
  const summary = evolutionSummary(overview);
  const health = evolutionHealth(overview);
  const scope = state.evolutionScope === 'lab' ? 'lab' : 'agents';
  if (state.evolutionDetail) return renderEvolutionDetail(overview, state.evolutionDetail);
  return `
    <div class="view evolution-view" data-preserve-scroll data-scroll-key="evolution">
      <header class="evolution-simple-head">
        <div class="evolution-scope-tabs" role="tablist" aria-label="自进化级别">
          <button class="${scope === 'agents' ? 'active' : ''}" type="button" data-evolution-scope="agents">Agents</button>
          <button class="${scope === 'lab' ? 'active' : ''}" type="button" data-evolution-scope="lab">Lab</button>
        </div>
        <div class="evolution-head-actions">
          <label class="evolution-dry-run">
            <input id="dry-run-evolution" type="checkbox" ${state.dryRunEvolution ? 'checked' : ''} />
            <span>Dry run</span>
          </label>
          <button class="mini-btn" id="run-evolution-btn" ${state.busy ? 'disabled' : ''}>运行维护</button>
          <button class="mini-btn" id="calibrate-gate-btn" ${state.busy ? 'disabled' : ''}>校准 Gate</button>
          <button class="mini-btn" id="apply-memory-policy-btn" ${state.busy ? 'disabled' : ''}>记忆策略</button>
        </div>
      </header>

      <section class="evolution-page-title">
        <h1>${scope === 'agents' ? 'Agents 自进化' : 'Lab 自进化'}</h1>
        <p>${scope === 'agents' ? '从真实对话轨迹到 Memory / Skill 提案与应用，展示每个 agent 的可审计演化结果。' : '展示 HR 如何根据证据推动候选、晋升、退休和结构治理。'}</p>
        <span class="evolution-state tone-${escapeAttr(health.tone)}">${escapeHtml(health.label)}</span>
      </section>

      ${renderEvolutionProcessGuide(overview, scope)}

      <label class="evolution-search" aria-label="搜索自进化记录">
        ${iconSvg('search')}
        <input id="evolution-search-input" value="${escapeAttr(state.evolutionSearchQuery)}" placeholder="${scope === 'agents' ? '搜索 agents 自进化记录' : '搜索 lab 变动记录'}" />
      </label>

      <section class="evolution-simple-metrics" aria-label="自进化关键指标">
        <article><strong>${formatNumber(summary.evolvedAgentCount)}</strong><span>有演化记录 agents</span></article>
        <article><strong>${formatNumber(summary.memoryChangeCount)}</strong><span>Memory 变化</span></article>
        <article><strong>${formatNumber(summary.skillChangeCount)}</strong><span>Skill 变化</span></article>
        <article><strong>${formatNumber(summary.labChangeCount)}</strong><span>Lab 变动</span></article>
      </section>

      ${scope === 'agents' ? `${renderUBuddyOrganizationEvolution()}${renderAgentEvolutionLevel(overview)}` : renderLabEvolutionLevel(overview)}
    </div>
  `;
 }

function renderUBuddyOrganizationEvolution() {
  const overview = state.uBuddyOrganizationEvolution || {};
  const policies = Array.isArray(overview.policies) ? overview.policies : [];
  const activePolicyVersionId = String(overview.activePolicyVersionId || '');
  const busy = Boolean(state.uBuddyOrganizationEvolutionBusy);
  const runtimeEnabled = state.uBuddyFeatureFlags?.organizationEvolutionApplyV1 === true;
  const status = activePolicyVersionId
    ? runtimeEnabled ? '已应用' : '已激活，运行时 Gate 关闭'
    : policies.length ? '候选待启用' : overview.status === 'unavailable' ? '云端不可用' : '采集中';
  return `
    <section class="evolution-record-group ubuddy-organization-evolution" aria-label="uBuddy 组织策略">
      <div class="evolution-group-head">
        <div>
          <h2>uBuddy 组织策略</h2>
          <p>${escapeHtml(status)} · ${formatNumber(overview.traceCount || 0)} 条组织轨迹</p>
        </div>
        <div class="evolution-row-actions">
          <button class="mini-btn" type="button" data-ubuddy-org-evolution-refresh ${busy ? 'disabled' : ''} title="刷新组织策略">${iconSvg('refresh')}</button>
          ${activePolicyVersionId ? `<button class="mini-btn" type="button" data-ubuddy-org-evolution-disable ${busy ? 'disabled' : ''}>停用</button>` : ''}
        </div>
      </div>
      <div class="evolution-list compact">
        ${policies.map((policy) => `
          <article class="evolution-record-row ${policy.policyVersionId === activePolicyVersionId ? 'has-evolved' : ''}">
            <div class="evolution-row-icon">${iconSvg('evolution')}</div>
            <div class="evolution-row-main">
              <div class="evolution-row-title">
                <strong>${escapeHtml(policy.stage === 'decomposition' ? '拆解与分配策略' : 'Agent 分配策略')}</strong>
                <span>${policy.policyVersionId === activePolicyVersionId ? '当前版本' : '候选版本'}</span>
              </div>
              <p>${escapeHtml(policy.summary || '基于重复组织失效形成的最小策略补丁。')}</p>
              <div class="evolution-row-meta">
                <span>${formatNumber(policy.evidenceCount || 0)} 条证据</span>
                <span>${escapeHtml(formatDateTime(policy.createdAt))}</span>
              </div>
            </div>
            <div class="evolution-row-actions">
              ${policy.policyVersionId !== activePolicyVersionId
                ? `<button class="mini-btn" type="button" data-ubuddy-org-evolution-activate="${escapeAttr(policy.policyVersionId)}" ${busy ? 'disabled' : ''}>启用</button>`
                : '<span class="evolution-state tone-green">Active</span>'}
            </div>
          </article>
        `).join('') || '<div class="evolution-empty small">暂无组织策略候选。</div>'}
      </div>
    </section>
  `;
}

function renderEvolutionProcessGuide(overview, scope) {
  const summary = evolutionSummary(overview);
  const steps = evolutionProcessSteps(summary, scope);
  const progress = state.evolutionProgress;
  const boundaryItems = [
    ['Janus 模型负责', '归纳证据、生成 proposal、给出 HR 意见'],
    ['后端裁决', '证据门槛、隐私过滤、Gate、回归和结构校验'],
    ['数据边界', summary.evidenceTotal > 0
      ? '当前展示真实对话证据；只有明确应用后才写入 Skill / Memory'
      : '当前无对话数据时只走演示流程，不写入真实 Skill / Memory'],
  ];
  return `
    <section class="evolution-process" aria-label="自进化流程总览">
      <div class="evolution-process-head">
        <div>
          <span>${progress?.demo ? 'Demo Loop' : 'Governed Loop'}</span>
          <h2>自进化流程</h2>
        </div>
        <p>${scope === 'agents'
          ? '从对话证据进入诊断、proposal、deterministic gate、应用和回归验证；没有真实数据时会先走一遍演示流程。'
          : 'Lab 层面承接 HR review 和结构校验；没有真实数据时先展示候选、晋升、退休等治理环节如何流转。'}</p>
      </div>
      ${renderEvolutionProcessProgressNote(progress)}
      <div class="evolution-process-steps">
        ${steps.map((step, index) => renderEvolutionProcessStep(step, index, progress)).join('')}
      </div>
      <div class="evolution-boundary-strip" aria-label="自进化责任边界">
        ${boundaryItems.map(([label, detail]) => `
          <div>
            <strong>${escapeHtml(label)}</strong>
            <span>${escapeHtml(detail)}</span>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function evolutionProcessSteps(summary, scope) {
  const labMode = scope === 'lab';
  return [
    {
      id: 'evidence',
      label: '证据读取',
      value: formatNumber(summary.evidenceTotal),
      detail: `${formatNumber(summary.runCount)} 轮维护记录`,
      tone: summary.evidenceTotal ? 'blue' : 'neutral',
    },
    {
      id: 'diagnosis',
      label: '轨迹诊断',
      value: formatNumber(summary.workflowCreditCount),
      detail: 'lightweight classifier + 可选 LLM 校正',
      tone: summary.workflowCreditCount ? 'blue' : 'neutral',
    },
    {
      id: 'proposal',
      label: 'Proposal',
      value: formatNumber(summary.archiveCount),
      detail: 'Janus 模型生成 Memory / Skill 改动草案',
      tone: summary.archiveCount ? 'violet' : 'neutral',
    },
    {
      id: 'gate',
      label: 'Gate 裁决',
      value: formatPercent(summary.gatePassed, summary.archiveCount),
      detail: `${formatNumber(summary.gateFailed)} 个未通过`,
      tone: summary.gateFailed ? 'amber' : summary.gatePassed ? 'green' : 'neutral',
    },
    {
      id: labMode ? 'organization' : 'apply',
      label: labMode ? '组织校验' : '应用与回归',
      value: labMode ? formatNumber(summary.governanceCount) : formatNumber(summary.appliedArchives),
      detail: labMode ? '投票、成熟度和迁移计划' : `${formatNumber(summary.evalPassed)} / ${formatNumber(summary.evalTotal)} eval passed`,
      tone: labMode ? (summary.governanceCount ? 'green' : 'neutral') : (summary.appliedArchives ? 'green' : 'neutral'),
    },
    {
      id: 'hr',
      label: 'HR 复核',
      value: formatNumber(summary.reviewCount),
      detail: `${formatNumber(summary.hrApproved)} full / ${formatNumber(summary.hrPartial)} partial`,
      tone: summary.hrRejected ? 'red' : summary.reviewCount ? 'green' : 'neutral',
    },
  ];
}

function renderEvolutionProcessProgressNote(progress) {
  if (!progress?.events?.length) return '';
  const latest = progress.events[0];
  const tone = latest.status === 'failed' ? 'failed' : progress.running ? 'running' : 'success';
  const label = progress.demo ? '演示流程' : '维护运行';
  return `
    <div class="evolution-process-live progress-${escapeAttr(tone)}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(`${latest.label || latest.stage || ''}${latest.detail ? `：${latest.detail}` : ''}`)}</span>
    </div>
  `;
}

function progressAliasesForStep(id) {
  const aliases = {
    evidence: ['evidence'],
    diagnosis: ['diagnosis'],
    proposal: ['proposal'],
    gate: ['gate'],
    apply: ['apply', 'regression'],
    organization: ['organization', 'apply'],
    hr: ['hr'],
  };
  return aliases[id] || [id];
}

function evolutionProgressForStep(step, progress = null) {
  if (!progress) return null;
  const aliases = progressAliasesForStep(step.id);
  const latestEvent = (progress.events || []).find((event) => aliases.includes(event.stage));
  if (latestEvent) return latestEvent;
  return aliases.map((alias) => progress.stages?.[alias]).find(Boolean) || null;
}

function evolutionProgressLabel(status) {
  const labels = {
    running: '运行中',
    success: '完成',
    failed: '失败',
    skipped: '跳过',
  };
  return labels[status] || '待运行';
}

function renderEvolutionProcessStep(step, index, progress = null) {
  const live = evolutionProgressForStep(step, progress);
  const liveStatus = String(live?.status || '').trim();
  const statusClass = liveStatus ? `progress-${escapeAttr(liveStatus)}` : '';
  const activeClass = liveStatus === 'running' ? 'is-active' : '';
  const detail = live?.detail || step.detail;
  const value = live ? evolutionProgressLabel(liveStatus) : step.value;
  return `
    <article class="evolution-process-step tone-${escapeAttr(step.tone)} ${statusClass} ${activeClass}" data-process-step="${escapeAttr(step.id)}">
      <i>${String(index + 1).padStart(2, '0')}</i>
      <div>
        <strong>${escapeHtml(step.label)}</strong>
        <span>${escapeHtml(detail)}</span>
        ${liveStatus ? `<small>${escapeHtml(live?.label || evolutionProgressLabel(liveStatus))}</small>` : ''}
      </div>
      <em>${escapeHtml(value)}</em>
    </article>
  `;
}

function renderAgentEvolutionLevel(overview) {
  const rows = filterEvolutionRows(buildAgentEvolutionRows(overview), state.evolutionSearchQuery);
  const grouped = groupRowsByDepartment(rows);
  return `
    <section class="evolution-records" aria-label="Agents 自进化记录">
      ${grouped.map(({ departmentId, rows: departmentRows }) => `
        <section class="evolution-record-group">
          <div class="evolution-group-head">
            <h2>${escapeHtml(departmentName(departmentId))}</h2>
            <span>${formatNumber(departmentRows.filter((item) => item.evolved).length)} / ${formatNumber(departmentRows.length)} records</span>
          </div>
          <div class="evolution-list">
            ${departmentRows.map(renderAgentEvolutionRow).join('')}
          </div>
        </section>
      `).join('') || '<div class="evolution-empty">暂无匹配的 agent 自进化记录。</div>'}
    </section>
  `;
}

function renderAgentEvolutionRow(item) {
  const memoryLabel = item.memoryChanged
    ? `Memory 已应用${item.memoryCount ? ` · ${formatNumber(item.memoryCount)} 条` : ''}`
    : item.proposalReady
      ? 'Memory 草案待应用'
      : item.hasMemoryRecord
        ? `Memory 记录${item.memoryCount ? ` · ${formatNumber(item.memoryCount)} 条` : ''}`
        : 'Memory 无已应用变化';
  const skillLabel = item.skillChanged
    ? `Skill 已应用${item.skillVersionId ? ` · ${shortHash(item.skillHash)}` : ''}`
    : item.proposalReady
      ? 'Skill 草案待应用'
      : item.hasSkillRecord
        ? 'Skill 有历史版本'
        : 'Skill 无已应用变化';
  const evolutionLabel = item.applied ? '已应用' : item.proposalReady ? '提案待应用' : item.evolved ? '有演化记录' : '未自进化';
  const rollback = item.skillVersionId
    ? `<button class="mini-btn muted" data-skill-rollback="${escapeAttr(item.skillVersionId)}" ${state.busy ? 'disabled' : ''}>Rollback</button>`
    : '';
  return `
    <article class="evolution-record-row ${item.evolved ? 'has-evolved' : 'idle'}" data-evolution-detail-scope="agents" data-evolution-detail-id="${escapeAttr(item.id)}">
      <div class="evolution-row-icon">${item.evolved ? iconSvg('evolution') : iconSvg('play')}</div>
      <div class="evolution-row-main">
        <div class="evolution-row-title">
          <strong>${escapeHtml(item.agentName)}</strong>
          <span>${escapeHtml(evolutionLabel)}</span>
          ${renderStatusBadge(item.status)}
        </div>
        <p>${escapeHtml(item.summary)}</p>
        <div class="evolution-row-meta">
          <span>${escapeHtml(memoryLabel)}</span>
          <span>${escapeHtml(skillLabel)}</span>
          <span>${escapeHtml(formatDateTime(item.updatedAt))}</span>
        </div>
      </div>
      <div class="evolution-row-actions">
        ${item.archive ? renderArchiveLabelActions(item.archive) : ''}
        ${rollback}
      </div>
    </article>
  `;
}

function renderLabEvolutionLevel(overview) {
  const rowsByKind = buildLabEvolutionRows(overview);
  const query = state.evolutionSearchQuery;
  const sections = [
    ['hiring', '招聘', '新增、拆分和候选 Agent 准入考核'],
    ['dismissal', '开除', '退休、合并和拒绝的 agent'],
    ['promotion', '晋升', '通过准入考核进入正式序列的 Agent'],
    ['assessment', '考核', 'HR 与绩效考核记录'],
  ];
  return `
    <section class="evolution-lab-grid" aria-label="Lab 自进化记录">
      ${sections.map(([kind, title, subtitle]) => {
        const rows = filterEvolutionRows(rowsByKind[kind] || [], query).slice(0, 24);
        return `
          <section class="evolution-lab-section">
            <div class="evolution-group-head">
              <div>
                <h2>${escapeHtml(title)}</h2>
                <p>${escapeHtml(subtitle)}</p>
              </div>
              <span>${formatNumber(rows.length)} records</span>
            </div>
            <div class="evolution-list compact">
              ${rows.map(renderLabEvolutionRow).join('') || '<div class="evolution-empty small">暂无记录。</div>'}
            </div>
          </section>
        `;
      }).join('')}
    </section>
  `;
}

function renderLabEvolutionRow(item) {
  return `
    <article class="evolution-record-row lab-row" data-evolution-detail-scope="lab" data-evolution-detail-id="${escapeAttr(item.id)}" data-evolution-detail-kind="${escapeAttr(item.kind || '')}">
      <div class="evolution-row-icon">${iconSvg(item.icon || 'evolution')}</div>
      <div class="evolution-row-main">
        <div class="evolution-row-title">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(departmentName(item.departmentId))}</span>
          ${renderStatusBadge(item.status)}
        </div>
        <p>${escapeHtml(item.summary)}</p>
        <div class="evolution-row-meta">
          <span>${escapeHtml(item.agentLabel || '-')}</span>
          <span>${escapeHtml(formatDateTime(item.createdAt || item.updatedAt))}</span>
        </div>
      </div>
      <div class="evolution-row-actions">${item.actions || ''}</div>
    </article>
  `;
}

function renderEvolutionDetail(overview, detail) {
  const scope = detail.scope === 'lab' ? 'lab' : 'agents';
  const item = scope === 'agents'
    ? buildAgentEvolutionRows(overview).find((row) => row.id === detail.id)
    : (buildLabEvolutionRows(overview)[detail.kind] || []).find((row) => row.id === detail.id);
  if (!item) {
    return `
      <div class="view evolution-view" data-preserve-scroll data-scroll-key="evolution">
        <section class="evolution-detail-page">
          <button class="evolution-back-btn" type="button" data-evolution-back>${iconSvg('chevronLeft')}<span>返回</span></button>
          <div class="evolution-empty">这条自进化记录已不存在。</div>
        </section>
      </div>
    `;
  }
  const title = scope === 'agents' ? item.agentName : item.title;
  const subtitle = scope === 'agents'
    ? `${departmentName(item.departmentId)} / ${item.applied ? '已应用' : item.proposalReady ? '提案待应用' : item.evolved ? '有演化记录' : '未自进化'}`
    : `${departmentName(item.departmentId)} / ${item.agentLabel || '-'}`;
  const fields = scope === 'agents'
    ? [
        ['Agent', item.agentName],
        ['部门', departmentName(item.departmentId)],
        ['状态', statusLabel(item.status)],
        ['Memory', item.memoryChanged ? `已应用${item.memoryCount ? ` · ${formatNumber(item.memoryCount)} 条` : ''}` : item.proposalReady ? '草案待应用' : item.hasMemoryRecord ? `历史记录${item.memoryCount ? ` · ${formatNumber(item.memoryCount)} 条` : ''}` : '无已应用变化'],
        ['Skill', item.skillChanged ? `已应用${item.skillHash ? ` · ${shortHash(item.skillHash)}` : ''}` : item.proposalReady ? '草案待应用' : item.hasSkillRecord ? '有历史版本' : '无已应用变化'],
        ['最近更新', formatDateTime(item.updatedAt)],
      ]
    : [
        ['类型', labKindLabel(item.kind)],
        ['部门', departmentName(item.departmentId)],
        ['Agent', item.agentLabel || '-'],
        ['状态', statusLabel(item.status)],
        ['记录时间', formatDateTime(item.createdAt || item.updatedAt)],
      ];
  return `
    <div class="view evolution-view" data-preserve-scroll data-scroll-key="evolution">
      <section class="evolution-detail-page">
        <button class="evolution-back-btn" type="button" data-evolution-back>${iconSvg('chevronLeft')}<span>返回</span></button>
        <div class="evolution-detail-head">
          <div>
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(subtitle)}</p>
          </div>
          ${renderStatusBadge(item.status)}
        </div>
        <section class="evolution-detail-summary">
          <h2>${scope === 'agents' ? '自进化总结' : '变动总结'}</h2>
          <p>${escapeHtml(item.summary || '暂无总结。')}</p>
        </section>
        <section class="evolution-detail-fields">
          ${fields.map(([label, value]) => `
            <div>
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value || '-')}</strong>
            </div>
          `).join('')}
        </section>
        ${scope === 'agents' ? renderAgentEvolutionDetailActions(item) : renderLabEvolutionDetailActions(item)}
      </section>
    </div>
  `;
}

function renderAgentEvolutionDetailActions(item) {
  const rollback = item.skillVersionId
    ? `<button class="btn secondary" data-skill-rollback="${escapeAttr(item.skillVersionId)}" ${state.busy ? 'disabled' : ''}>Rollback Skill</button>`
    : '';
  const labels = item.archive ? renderArchiveLabelActions(item.archive) : '';
  if (!rollback && !labels) return '';
  return `<section class="evolution-detail-actions">${labels}${rollback}</section>`;
}

function renderLabEvolutionDetailActions(item) {
  return item.actions ? `<section class="evolution-detail-actions">${item.actions}</section>` : '';
}

function labKindLabel(kind = '') {
  const labels = {
    hiring: '招聘',
    dismissal: '开除',
    promotion: '晋升',
    assessment: '考核',
  };
  return labels[kind] || kind || '-';
}

function buildAgentEvolutionRows(overview) {
  const latestRuns = latestBy((overview.latestRuns || []), (item) => item.agentId, evolutionTime);
  const latestReviews = latestBy((overview.agentEvolutionReviews || []), (item) => item.agentId, evolutionTime);
  const latestArchives = latestBy((overview.archives || []), (item) => item.agentId, evolutionTime);
  const latestSkillVersions = latestBy((overview.skillVersions || []), (item) => item.agentId, evolutionTime);
  const memoryCounts = countBy([...(overview.memories || []), ...(overview.memoryEntries || [])], (item) => item.ownerId || item.agentId);
  const agents = (state.org.agents || []).filter((agent) => agent.role !== 'hr');
  return agents.map((agent) => {
    const run = latestRuns.get(agent.id);
    const review = latestReviews.get(agent.id);
    const archive = latestArchives.get(agent.id);
    const skillVersion = latestSkillVersions.get(agent.id);
    const fileEvolution = agent.evolutionSummary || {};
    const applied = Boolean(archive?.applied);
    const proposalReady = !applied && run?.status === 'proposed' && archive?.gateStatus === 'passed';
    const memoryChanged = applied && Boolean(
      archive.preMemoryHash && archive.postMemoryHash && archive.preMemoryHash !== archive.postMemoryHash,
    );
    const skillChanged = applied && Boolean(
      archive.preSkillHash && archive.postSkillHash && archive.preSkillHash !== archive.postSkillHash,
    );
    const hasMemoryRecord = memoryCounts.get(agent.id) > 0 || Boolean(fileEvolution.memoryChanged);
    const hasSkillRecord = Boolean(skillVersion) || Boolean(fileEvolution.skillChanged);
    const evolved = Boolean(run || archive || review || memoryChanged || skillChanged || fileEvolution.proposalCount);
    const status = applied ? 'applied' : run?.status || review?.decision || agent.lifecycleStatus || 'idle';
    return {
      id: agent.id,
      departmentId: agent.departmentId,
      agentName: shortAgentLabel(agent),
      status,
      evolved,
      applied,
      proposalReady,
      memoryChanged,
      skillChanged,
      hasMemoryRecord,
      hasSkillRecord,
      memoryCount: memoryCounts.get(agent.id) || fileEvolution.memorySnapshotCount || 0,
      skillVersionId: skillVersion?.id || '',
      skillHash: skillVersion?.skillHash || archive?.postSkillHash || fileEvolution.latestProposalName || '',
      archive,
      summary: clipInline(
        run?.summary ||
        review?.rationale ||
        archive?.gate?.rationale ||
        fileEvolution.latestSummary ||
        agent.selfEvolutionPrompt ||
        (evolved ? '已有自进化记录，等待补充更明确的总结。' : '暂无自进化记录。'),
        180,
      ),
      updatedAt: run?.completedAt || run?.updatedAt || archive?.createdAt || review?.createdAt || skillVersion?.createdAt || fileEvolution.latestEvolutionAt || '',
      searchable: [
        agent.id,
        agent.name,
        departmentName(agent.departmentId),
        run?.summary,
        review?.rationale,
        fileEvolution.latestSummary,
        archive?.gateStatus,
      ].filter(Boolean).join(' '),
    };
  }).sort((left, right) => departmentName(left.departmentId).localeCompare(departmentName(right.departmentId)) || Number(right.evolved) - Number(left.evolved) || left.agentName.localeCompare(right.agentName));
}

function buildLabEvolutionRows(overview) {
  const rows = { hiring: [], dismissal: [], promotion: [], assessment: [] };
  const seen = new Set();
  const push = (kind, item) => {
    const key = `${kind}:${item.id || item.title}:${item.agentLabel}:${item.createdAt || item.updatedAt || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows[kind].push({
      ...item,
      kind,
      searchable: [
        item.title,
        item.summary,
        item.agentLabel,
        item.status,
        departmentName(item.departmentId),
      ].filter(Boolean).join(' '),
    });
  };

  for (const event of overview.governanceEvents || []) {
    const kind = labKindForEvent(event.eventType);
    if (!kind) continue;
    push(kind, {
      id: event.id,
      departmentId: event.departmentId,
      agentLabel: agentNameById(event.agentId) || event.agentId || '-',
      title: labEventLabel(event.eventType),
      status: event.status || 'recorded',
      summary: clipInline(event.rationale || event.migrationPlan || '治理事件已记录。', 180),
      createdAt: event.createdAt,
      icon: kind === 'dismissal' ? 'archive' : kind === 'promotion' ? 'spark' : 'evolution',
    });
  }

  for (const experiment of overview.specialistExperiments || []) {
    const stateValue = String(experiment.state || experiment.status || '');
    const common = {
      id: experiment.id,
      departmentId: experiment.departmentId,
      agentLabel: agentNameById(experiment.candidateAgentId),
      summary: clipInline(experiment.decisionNotes || experiment.evaluation?.summary || '候选 Agent 准入考核记录。', 180),
      status: stateValue || 'assessment_pending',
      createdAt: experiment.createdAt,
      updatedAt: experiment.updatedAt,
      actions: renderSpecialistExperimentActions(experiment),
    };
    if (['assessment_pending', 'running', 'promote_candidate', 'reject_candidate'].includes(stateValue)) {
      push('hiring', { ...common, title: '候选 Agent 准入考核', icon: 'evolution' });
    }
    if (stateValue === 'promoted') {
      push('promotion', { ...common, title: '专家 agent 晋升', icon: 'spark' });
    }
    if (stateValue === 'rejected') {
      push('dismissal', { ...common, title: '候选 agent 拒绝', icon: 'archive' });
    }
  }

  for (const agent of state.org.agents || []) {
    const lifecycle = agent.lifecycleStatus || agent.routingState || '';
    if (lifecycle === 'assessment_pending') {
      push('hiring', {
        id: `${agent.id}:lifecycle`,
        departmentId: agent.departmentId,
        agentLabel: shortAgentLabel(agent),
        title: '生命周期候选',
        status: lifecycle,
        summary: agent.description || '当前正在完成准入考核。',
        createdAt: agent.lifecycle?.createdAt || '',
        icon: 'evolution',
      });
    }
    if (['retired', 'merged', 'rejected', 'disabled'].includes(lifecycle)) {
      push('dismissal', {
        id: `${agent.id}:lifecycle`,
        departmentId: agent.departmentId,
        agentLabel: shortAgentLabel(agent),
        title: '生命周期移出',
        status: lifecycle,
        summary: agent.description || '当前不参与正式路由。',
        createdAt: agent.lifecycle?.updatedAt || '',
        icon: 'archive',
      });
    }
  }

  for (const review of overview.performanceReviews || []) {
    push('assessment', {
      id: review.id,
      departmentId: review.departmentId,
      agentLabel: agentNameById(review.agentId),
      title: '绩效考核',
      status: review.rating || 'observe',
      summary: clipInline(review.recommendation || `${formatNumber(review.taskCount)} tasks / ${formatNumber(review.successCount)} success / ${formatNumber(review.failureCount)} failed`, 180),
      createdAt: review.createdAt,
      icon: 'sliders',
    });
  }

  for (const review of overview.hrReviews || []) {
    push('assessment', {
      id: review.id,
      departmentId: review.departmentId,
      agentLabel: departmentName(review.departmentId),
      title: '部门 HR 审核',
      status: review.status,
      summary: clipInline(review.summary || '部门结构审核记录。', 180),
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      icon: 'sliders',
    });
  }

  for (const review of overview.agentEvolutionReviews || []) {
    push('assessment', {
      id: review.id,
      departmentId: review.departmentId,
      agentLabel: agentNameById(review.agentId),
      title: 'Agent 自进化审核',
      status: review.decision,
      summary: clipInline(review.rationale || review.requiredRevision || 'HR 已审核 agent 自进化 proposal。', 180),
      createdAt: review.createdAt,
      icon: 'sliders',
    });
  }

  for (const key of Object.keys(rows)) {
    rows[key].sort((left, right) => new Date(right.createdAt || right.updatedAt || 0) - new Date(left.createdAt || left.updatedAt || 0));
  }
  return rows;
}

function labKindForEvent(eventType = '') {
  const value = String(eventType || '');
  if (['new_agent', 'split_agent', 'specialist_assessment_started', 'specialist_canary_started', 'specialist_replay_created'].includes(value)) return 'hiring';
  if (['retire_agent', 'merge_agents', 'specialist_rejected'].includes(value)) return 'dismissal';
  if (['specialist_promoted'].includes(value)) return 'promotion';
  if (['agent_evolution_hr_review', 'agent_evolution_revision', 'skill_rollback', 'specialist_assessment_evaluated', 'specialist_canary_evaluated'].includes(value)) return 'assessment';
  return '';
}

function labEventLabel(eventType = '') {
  const labels = {
    new_agent: '招聘新 agent',
    split_agent: '拆分新 agent',
    merge_agents: '合并 agent',
    retire_agent: '开除/退休 agent',
    specialist_assessment_started: '候选 Agent 准入考核',
    specialist_assessment_evaluated: '候选 Agent 考核完成',
    specialist_canary_started: '历史候选 Agent 准入考核',
    specialist_canary_evaluated: '历史候选 Agent 考核完成',
    specialist_promoted: '候选 agent 晋升',
    specialist_rejected: '候选 agent 拒绝',
    skill_rollback: 'Skill 回滚',
    agent_evolution_hr_review: '自进化审核',
    agent_evolution_revision: '自进化修订',
    specialist_replay_created: '候选对照任务创建',
  };
  return labels[eventType] || eventType || '治理事件';
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function filterEvolutionRows(rows, query = '') {
  const needle = normalizeSearch(query);
  if (!needle) return rows;
  return rows.filter((item) => normalizeSearch(item.searchable || JSON.stringify(item)).includes(needle));
}

function groupRowsByDepartment(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = row.departmentId || '';
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return [...map.entries()]
    .map(([departmentId, groupRows]) => ({ departmentId, rows: groupRows }))
    .sort((left, right) => departmentName(left.departmentId).localeCompare(departmentName(right.departmentId)));
}

function latestBy(items, keyFn, timeFn) {
  const map = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key) continue;
    const previous = map.get(key);
    if (!previous || timeFn(item) >= timeFn(previous)) map.set(key, item);
  }
  return map;
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function evolutionTime(item) {
  return new Date(item?.completedAt || item?.updatedAt || item?.createdAt || 0).getTime() || 0;
}

function evolutionSummary(overview) {
  const latestRuns = overview.latestRuns || [];
  const archives = overview.archives || [];
  const reviews = overview.agentEvolutionReviews || [];
  const memories = overview.memories || [];
  const memoryEntries = overview.memoryEntries || [];
  const evals = overview.evals || [];
  const specialistExperiments = overview.specialistExperiments || [];
  const governanceEvents = overview.governanceEvents || [];
  const workflowCredits = overview.workflowCredits || [];
  const agentRows = buildAgentEvolutionRows(overview);
  const labRows = buildLabEvolutionRows(overview);
  const labChangeCount = Object.values(labRows).reduce((sum, rows) => sum + rows.length, 0);
  const gatePassed = archives.filter((item) => item.gateStatus === 'passed').length;
  const labeledArchives = archives.filter((item) => item.latestLabel).length;
  const activeMemoryCount = memoryEntries.filter((item) => item.lifecycleState === 'active').length || memories.length;
  return {
    evolvedAgentCount: agentRows.filter((item) => item.evolved).length,
    memoryChangeCount: agentRows.filter((item) => item.memoryChanged).length,
    skillChangeCount: agentRows.filter((item) => item.skillChanged).length,
    labChangeCount,
    runCount: latestRuns.length,
    evidenceTotal: latestRuns.reduce((sum, run) => sum + Number(run.evidenceMessageCount || 0), 0),
    workflowCreditCount: workflowCredits.length,
    governanceCount: governanceEvents.length,
    failedRuns: latestRuns.filter((item) => ['failed', 'error'].includes(String(item.status || ''))).length,
    archiveCount: archives.length,
    gatePassed,
    gateFailed: archives.filter((item) => item.gateStatus && item.gateStatus !== 'passed').length,
    avgGateScore: archives.length ? archives.reduce((sum, item) => sum + Number(item.gateScore || 0), 0) / archives.length : 0,
    appliedArchives: archives.filter((item) => item.applied).length,
    labeledArchives,
    positiveLabels: archives.filter((item) => item.latestLabel?.label).length,
    negativeLabels: archives.filter((item) => item.latestLabel && !item.latestLabel.label).length,
    reviewCount: reviews.length,
    hrApproved: reviews.filter((item) => item.decision === 'full').length,
    hrPartial: reviews.filter((item) => item.decision === 'partial').length,
    hrRejected: reviews.filter((item) => ['reject', 'rejected'].includes(String(item.decision || ''))).length,
    memoryCount: memories.length,
    memoryEntryCount: memoryEntries.length,
    activeMemoryCount,
    blockedMemoryCount: memoryEntries.filter((item) => item.lifecycleState === 'blocked').length,
    evalTotal: evals.reduce((sum, item) => sum + Number(item.count || 0), 0),
    evalPassed: evals.filter((item) => item.status === 'passed').reduce((sum, item) => sum + Number(item.count || 0), 0),
    assessmentCount: specialistExperiments.filter((item) => ['assessment_pending', 'running', 'promote_candidate', 'reject_candidate'].includes(String(item.state || item.status || ''))).length,
  };
}

function evolutionHealth(overview) {
  const summary = evolutionSummary(overview);
  const gate = summary.archiveCount ? summary.gatePassed / summary.archiveCount : 0.5;
  const hr = summary.reviewCount ? summary.hrApproved / summary.reviewCount : 0.5;
  const regression = summary.evalTotal ? summary.evalPassed / summary.evalTotal : 0.5;
  const memoryBase = summary.memoryEntryCount || summary.memoryCount;
  const memory = memoryBase ? summary.activeMemoryCount / memoryBase : 0.5;
  const feedback = summary.labeledArchives ? summary.positiveLabels / summary.labeledArchives : 0.5;
  const riskPenalty = clampNumber(
    summary.failedRuns * 8 +
    summary.gateFailed * 4 +
    summary.hrRejected * 8 +
    summary.negativeLabels * 6 +
    summary.blockedMemoryCount * 3,
    0,
    28,
  );
  const score = clampNumber(Math.round(((gate * 0.3) + (hr * 0.22) + (regression * 0.2) + (memory * 0.16) + (feedback * 0.12)) * 100 - riskPenalty), 0, 100);
  if (!summary.runCount && !summary.archiveCount && !summary.memoryCount) {
    return { score: 0, label: '等待真实轨迹', tone: 'neutral', detail: 'no evidence yet' };
  }
  if (score >= 78) return { score, label: '稳态可推进', tone: 'green', detail: 'high confidence loop' };
  if (score >= 52) return { score, label: '谨慎观察', tone: 'amber', detail: 'review recommended' };
  return { score, label: '需要介入', tone: 'red', detail: 'operator attention' };
}

function renderSpecialistExperimentActions(item) {
  const id = escapeAttr(item.id);
  const stateValue = String(item.state || item.status || '');
  const hasReplay = Boolean(item.baselineTaskRunId && item.candidateTaskRunId);
  const actions = [];
  if (!hasReplay && ['assessment_pending', 'running', ''].includes(stateValue)) {
    actions.push(`<button class="mini-btn" data-specialist-start="${id}">Start</button>`);
  }
  if (hasReplay && !['promoted', 'rejected'].includes(stateValue)) {
    actions.push(`<button class="mini-btn" data-specialist-evaluate="${id}">Evaluate</button>`);
  }
  if (stateValue === 'promote_candidate') {
    actions.push(`<button class="mini-btn" data-specialist-finalize="${id}" data-decision="promote">Promote</button>`);
  }
  if (stateValue === 'reject_candidate') {
    actions.push(`<button class="mini-btn" data-specialist-finalize="${id}" data-decision="reject">Reject</button>`);
  }
  return actions.join(' ') || '-';
}

function renderArchiveLabelActions(item) {
  const runId = escapeAttr(item.runId);
  const archiveId = escapeAttr(item.id);
  const disabled = state.busy ? 'disabled' : '';
  return [
    `<button class="mini-btn" data-archive-label="${runId}" data-archive-id="${archiveId}" data-label="positive" ${disabled}>Good</button>`,
    `<button class="mini-btn" data-archive-label="${runId}" data-archive-id="${archiveId}" data-label="negative" ${disabled}>Bad</button>`,
  ].join(' ');
}
