import { state } from '../state.js';
import { escapeAttr, escapeHtml, formatDateTime } from '../utils/format.js';
import { talentFamilyVisible, visibleTalentFamilyIds } from '../utils/talentCatalog.js';

export function renderPersonalEvolution() {
  const status = state.personalEvolutionStatus || {};
  const visibleFamilyIds = visibleTalentFamilyIds(state.employeeOverview);
  const settings = (state.userAgentSettings || [])
    .filter((item) => talentFamilyVisible(item.agentFamilyId, visibleFamilyIds));
  const selectedInstanceId = state.employeeSelectedInstanceId || '';
  const orderedSettings = selectedInstanceId
    ? [...settings].sort((a, b) => Number(b.id === selectedInstanceId) - Number(a.id === selectedInstanceId))
    : settings;
  const proposals = (state.personalEvolutionProposals || [])
    .filter((item) => talentFamilyVisible(item.agentFamilyId, visibleFamilyIds));
  const detail = talentFamilyVisible(state.personalEvolutionProposalDetail?.agentFamilyId, visibleFamilyIds)
    ? state.personalEvolutionProposalDetail
    : null;
  const instanceStatus = new Map((status.instances || []).map((item) => [item.agentInstanceId, item]));
  const runCounts = proposals.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] || 0) + 1 }), {});
  return `<div class="view personal-evolution-view" aria-busy="${state.personalEvolutionBusy ? 'true' : 'false'}" data-preserve-scroll data-scroll-key="personal-evolution">
    <header class="personal-evolution-head"><div><span>Agent 成长记录</span><h1>我的 Agent 自进化</h1><p>云端根据工作证据生成稳定候选；Skill 版本由你在设置中选择启用或回退，Memory 变更继续独立确认。</p></div><div class="personal-provider-boundary"><strong>云端唯一权威</strong><div class="personal-readiness-list">${renderReadinessChip('设备授权', status.grantReady)}${renderReadinessChip('数据库', status.readiness?.database)}${renderReadinessChip('模型', status.readiness?.model)}${renderReadinessChip('加密', status.readiness?.encryption)}${renderReadinessChip('进化服务', status.executionAvailable, status.executionAvailable ? '' : statusCodeLabel(status.code))}</div></div></header>
    <section class="personal-proposal-metrics"><span class="is-queued">排队 <b>${Number(runCounts.queued || 0)}</b></span><span class="is-running">运行 <b>${sumCounts(runCounts, 'running', 'claimed')}</b></span><span class="is-pending">等待选择 <b>${sumCounts(runCounts, 'available', 'proposed', 'ready', 'partially_applied')}</b></span><span class="is-success">已应用 <b>${Number(runCounts.applied || 0)}</b></span><span class="is-danger">失败 <b>${sumCounts(runCounts, 'failed_terminal', 'failed_retryable', 'failed')}</b></span></section>
    ${renderEvidenceUploadStatus(status.evidenceUpload || {})}
    ${renderAvailabilityNotice(status)}
    ${renderGrantPanel(status)}
    <section class="personal-evolution-instance-grid">${orderedSettings.map((item) => renderInstanceCard(item, instanceStatus.get(item.id) || {}, status, item.id === selectedInstanceId)).join('') || renderPersonalEmpty('尚未创建 Agent', '请先在人才市场招募专业 Agent，再为其配置个人进化权限。')}</section>
    <section class="personal-evolution-content"><div class="personal-proposal-list"><h2>进化记录</h2>${proposals.map(renderProposalRow).join('') || renderPersonalEmpty('暂无进化记录', 'Agent 积累足够工作证据并完成云端评估后，记录会显示在这里。')}</div><div class="personal-proposal-detail">${detail ? renderProposalDetail(detail) : renderPersonalEmpty('请选择一条进化记录', '这里会展示 Skill 变化、评测结果和需要你决定的 Memory 操作。')}</div></section>
  </div>`;
}

function renderEvidenceUploadStatus(upload = {}) {
  const current = upload.currentAccount || {};
  const waiting = sumCounts(current, 'pending', 'claimed', 'deferred', 'failed_retryable');
  const deferred = Number(current.deferred || 0) + Number(current.failed_retryable || 0);
  const otherAccounts = Number(upload.otherAccountsPending || 0);
  const blocked = Number(upload.permanentlyBlocked || 0);
  return `<section class="personal-proposal-metrics personal-evidence-upload-status" aria-label="证据同步状态"><span class="is-queued">本账户待上传 <b>${waiting}</b></span><span class="is-pending">退避等待 <b>${deferred}</b></span><span>其他账户待处理 <b>${otherAccounts}</b></span><span class="${blocked ? 'is-danger' : 'is-success'}">永久阻塞 <b>${blocked}</b></span><span>下次重试 <b>${escapeHtml(formatDateTime(upload.nextRetryAt) || '无需等待')}</b></span></section>`;
}

function renderGrantPanel(status = {}) {
  const grants = state.evolutionGrants || [];
  const pendingCount = grants.filter((grant) => grant.status === 'pending').length;
  return `<details class="personal-provider-boundary personal-grant-panel" ${pendingCount ? 'open' : ''}><summary><span><strong>设备授权</strong><small>${pendingCount ? `${pendingCount} 台设备等待处理` : `${grants.length} 台已登记设备`}</small></span><em>管理</em></summary><div class="personal-grant-content"><header><span>设备授权控制同步、密钥恢复和云端接口访问，不代表你已同意 Memory 变更。</span><button class="btn secondary" type="button" data-evolution-grants-refresh>刷新</button></header>${grants.length ? grants.map((grant) => `<div class="personal-grant-row"><span><strong>${escapeHtml(grant.deviceId || '未知设备')}</strong><small>${escapeHtml((grant.scopes || []).map(grantScopeLabel).join('、') || '未声明权限')}</small></span><div class="personal-grant-actions"><em class="personal-status-pill is-${statusTone(grant.status)}">${statusLabel(grant.status)}</em>${grant.status === 'pending' ? `<button class="mini-btn" type="button" data-evolution-grant-approve="${escapeAttr(grant.deviceId || '')}">批准</button>` : ''}<button class="mini-btn" type="button" data-evolution-grant-revoke="${escapeAttr(grant.deviceId || '')}" ${grant.status === 'revoked' ? 'disabled' : ''}>撤销${grant.deviceId === status.deviceId ? '当前设备' : ''}</button></div></div>`).join('') : renderPersonalEmpty('暂无设备授权记录', '点击刷新可重新读取已登记设备。')}</div></details>`;
}

function renderInstanceCard(item = {}, subject = {}, status = {}, selected = false) {
  const name = item.family?.name || item.agentFamilyId || 'Agent';
  const available = Number(subject.availableEvidence || 0);
  const schedule = subject.schedule || {};
  return `<article class="personal-instance-card ${selected ? 'is-selected' : ''}"><header><div><strong>${escapeHtml(name)}</strong><code>${escapeHtml(item.agentFamilyId || '')}</code></div><span class="status-badge active">云端自进化</span></header>${selected ? '<div class="personal-selected-hint">从人才市场进入，已定位到此 Agent</div>' : ''}<div class="permission-note">云端会按调度生成候选，但不会自动替换当前 Skill；版本选择与回退统一在设置中完成。</div><div class="personal-evidence-counts"><span>可用证据 ${available}</span><span>评估中 ${Number(subject.evidenceCounts?.reserved || 0)}</span><span>已使用 ${Number(subject.evidenceCounts?.consumed || 0)}</span></div><div class="personal-evidence-counts"><span>上次评估 ${escapeHtml(formatDateTime(schedule.lastEvaluatedAt) || '尚未评估')}</span><span>下次评估 ${escapeHtml(formatDateTime(schedule.nextEligibleAt) || '等待云端同步')}</span><em class="personal-status-pill is-${statusTone(schedule.lastStatus || 'never_evaluated')}">${statusLabel(schedule.lastStatus || 'never_evaluated')}</em></div><div class="personal-instance-actions"><button class="btn secondary" type="button" data-personal-evolution-settings="${escapeAttr(item.id)}">前往设置选择 Skill 版本</button></div></article>`;
}

function renderProposalRow(item = {}) {
  const active = state.personalEvolutionProposalDetail?.id === item.id;
  return `<button class="personal-proposal-row ${active ? 'active' : ''}" type="button" data-personal-proposal="${escapeAttr(item.id)}"><span><strong>${escapeHtml(item.summary || item.agentFamilyId || 'Agent 进化记录')}</strong><small>${escapeHtml(formatDateTime(item.updatedAt || item.createdAt))}</small></span><em class="personal-status-pill is-${statusTone(item.status)}">${statusLabel(item.status)}</em></button>`;
}

function renderProposalDetail(proposal = {}) {
  const evaluations = proposal.evaluationSummary || {};
  const memoryMutable = !proposal.readOnly;
  const skillStatus = proposal.skillActionStatus && proposal.skillActionStatus !== 'none'
    ? proposal.skillActionStatus
    : proposal.status === 'available' ? 'available' : 'not_applied';
  return `<article class="personal-proposal-card"><header><div><span>${escapeHtml(proposal.agentFamilyId || '')}</span><h2>${escapeHtml(proposal.summary || 'Agent 进化记录')}</h2></div><strong class="personal-status-pill is-${statusTone(proposal.status)}">${statusLabel(proposal.status)}</strong></header>${proposal.readOnly ? '<div class="permission-note">这是只读的本地历史记录；任何变更都必须由云端权威服务执行。</div>' : ''}${proposal.expiresReason ? `<div class="permission-note danger">已过期：${reasonLabel(proposal.expiresReason)}</div>` : ''}<div class="personal-proposal-metrics"><span>证据 <b>${Number(proposal.evidenceCount || 0)}</b></span><span>工作场景 <b>${Number(proposal.distinctContextCount || 0)}</b></span><span>安全与质量检查 <b>${Number(proposal.gate?.score || 0).toFixed(2)}</b></span><span class="${Number(evaluations.regressionCount || 0) ? 'is-danger' : 'is-success'}">回归项 <b>${Number(evaluations.regressionCount || 0)}</b></span></div><section><h3>Skill 变化</h3><pre>${escapeHtml(proposal.proposedOverlayText || '无变更')}</pre><p>版本状态：<em class="personal-status-pill is-${statusTone(skillStatus)}">${statusLabel(skillStatus)}</em></p>${proposal.status === 'available' ? '<button class="btn secondary" type="button" data-personal-evolution-settings>前往设置选择此 Agent 的版本</button>' : ''}</section><section><h3>评测结果</h3><div class="personal-eval-summary"><span>原版本 ${Number(evaluations.baselineAverage || 0).toFixed(2)}</span><span>候选版本 ${Number(evaluations.candidateAverage || 0).toFixed(2)}</span><span>提升 ${Number(evaluations.averageImprovement || 0).toFixed(2)}</span></div></section><section><h3>Memory 操作</h3>${(proposal.memoryOperations || []).map((item) => `<div class="personal-memory-operation"><div><strong>${operationLabel(item.operationType)} · ${escapeHtml(item.sectionName)}</strong><p>${escapeHtml(item.proposedText || item.targetItemHash || '')}</p><small>${escapeHtml(item.rationale || '')}</small></div>${renderMemoryOperationActions(proposal, item, memoryMutable)}</div>`).join('') || '<div class="empty">没有 Memory 变更。</div>'}</section><details><summary>查看完整脱敏进化记录</summary><pre>${escapeHtml(proposal.proposalMarkdown || '')}</pre></details></article>`;
}

function renderMemoryOperationActions(proposal = {}, item = {}, mutable = false) {
  if (mutable && item.status === 'pending' && ['available', 'ready', 'proposed', 'partially_applied', 'applied'].includes(proposal.status)) {
    return `<div><button class="mini-btn" data-personal-memory-decision="accept" data-operation-id="${escapeAttr(item.id)}" data-proposal-id="${escapeAttr(proposal.id)}">接受</button><button class="mini-btn" data-personal-memory-decision="reject" data-operation-id="${escapeAttr(item.id)}" data-proposal-id="${escapeAttr(proposal.id)}">拒绝</button></div>`;
  }
  if (mutable && item.status === 'applied' && item.memoryDocumentId && item.baselineVersionId) {
    return `<div><em class="personal-status-pill is-${statusTone(item.status)}">${statusLabel(item.status)}</em><button class="mini-btn" type="button" data-personal-memory-rollback data-memory-document-id="${escapeAttr(item.memoryDocumentId)}" data-target-version-id="${escapeAttr(item.baselineVersionId)}" data-proposal-id="${escapeAttr(proposal.id)}">回滚到变更前</button></div>`;
  }
  return `<em class="personal-status-pill is-${statusTone(item.status)}">${statusLabel(item.status)}</em>`;
}

function renderReadinessChip(label, ready, extra = '') {
  return `<span class="personal-readiness-chip ${ready ? 'is-ready' : 'is-unavailable'}"><i aria-hidden="true"></i>${escapeHtml(label)}：${ready ? '就绪' : extra || '不可用'}</span>`;
}

function renderAvailabilityNotice(status = {}) {
  if (!status.configured) {
    return `<div class="personal-state-notice is-warning" role="status"><span><strong>尚未连接云端进化服务</strong><small>连接云端后才能查看评估记录与可用版本。诊断代码：<code>${escapeHtml(status.code || 'cloud_not_configured')}</code></small></span></div>`;
  }
  if (status.executionAvailable === false) {
    return `<div class="personal-state-notice is-warning" role="status"><span><strong>云端进化服务暂不可执行</strong><small>${statusCodeLabel(status.code)}</small></span></div>`;
  }
  if (!status.grantReady) {
    return '<div class="personal-state-notice is-warning" role="status"><span><strong>当前设备尚未获得进化授权</strong><small>请展开设备授权区域检查待处理设备。</small></span></div>';
  }
  return '';
}

function renderPersonalEmpty(title, detail) {
  return `<div class="personal-empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
}

function sumCounts(counts, ...statuses) {
  return statuses.reduce((total, status) => total + Number(counts?.[status] || 0), 0);
}

function statusTone(value) {
  if (['running', 'claimed'].includes(value)) return 'running';
  if (['queued', 'pending', 'available', 'proposed', 'ready', 'partially_applied', 'not_applied'].includes(value)) return 'pending';
  if (['applied', 'active', 'activated', 'completed'].includes(value)) return 'success';
  if (['failed', 'failed_retryable', 'failed_terminal', 'rejected', 'revoked', 'expired', 'unavailable'].includes(value)) return 'danger';
  return 'muted';
}

function statusCodeLabel(value) {
  const labels = {
    cloud_not_configured: '尚未连接云端进化服务',
    cloud_grant_pending: '设备授权等待服务端验证',
    cloud_capability_pending: '云端进化能力准备中',
    unavailable: '当前不可用',
  };
  return escapeHtml(labels[value] || value || '不可用');
}

function statusLabel(value) {
  const labels = {
    queued: '排队中', running: '运行中', claimed: '已领取', available: '等待选择版本', ready: '待决定', proposed: '待决定',
    partially_applied: '部分应用', applied: '已应用', activated: '已启用', rejected: '已拒绝',
    failed: '失败', failed_retryable: '失败，可重试', failed_terminal: '失败，已终止', expired: '已过期',
    pending: '等待处理', active: '有效', revoked: '已撤销', completed: '已完成', unavailable: '不可用',
    never_evaluated: '尚未评估', none: '尚未应用', not_applied: '等待用户选择',
  };
  return escapeHtml(labels[value] || value || '未知');
}

function reasonLabel(value) {
  const labels = {
    memory_baseline_changed: 'Memory 基准已发生变化',
    proposal_expired: '进化记录超过有效期',
  };
  return escapeHtml(labels[value] || value || '未知原因');
}

function operationLabel(value) {
  const labels = { add: '追加', append: '追加', replace: '替换', remove: '删除', delete: '删除', upsert: '写入或更新' };
  return escapeHtml(labels[value] || value || '变更');
}

function grantScopeLabel(value) {
  const labels = {
    sync: '数据同步', 'sync:read': '读取同步数据', 'sync:write': '写入同步数据', 'sync:files': '同步文件',
    'sync:keys': '密钥恢复', 'sync:*': '完整同步权限', 'devices:approve': '批准新设备',
    evolution: '云端进化', 'evolution:read': '查看进化记录', 'evolution:write': '执行进化操作',
    'evolution:*': '完整进化权限', key_recovery: '密钥恢复', api: '云端接口',
  };
  return labels[value] || value;
}
