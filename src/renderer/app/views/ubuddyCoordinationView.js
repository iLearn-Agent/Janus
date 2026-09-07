import { renderAgentWorkStatus, workStateLabel } from '../components/agentWorkStatus.js';
import { agentWorkStatusFor, normalizeCoordinationSnapshot, normalizeFailureReport, normalizeWakeReason } from '../features/ubuddy/coordinationState.js';
import { escapeAttr, escapeHtml, formatDateTime } from '../utils/format.js';
import { filePayloadAttr, normalizeFilePayload } from '../utils/filePayload.js';
import { agentInstanceDisplayNameForUi } from '../utils/agentIdentity.js';
import {
  numberAgentInstanceLabels,
  renderAgentWorkProjectionSummary,
  workProjectionEnvelope,
  workProjectionForAgent,
} from '../components/agentWorkProjection.js';
import { normalizeFinalDeliveryPolicy } from '../../../shared/contracts/uBuddyDeliveryReview.js';

function latestDelegationRecord(rendererState = {}, delegationId = '') {
  const id = String(delegationId || '').trim();
  if (!id) return null;
  return [
    ...(rendererState?.agentDelegations || []),
    ...(rendererState?.collaborationOverview?.tasks || []),
    ...(rendererState?.collaborationGroupDetail?.tasks || []),
  ].filter((item) => String(item?.id || '') === id).reduce((current, item) => {
    if (!current) return item;
    const currentTime = Date.parse(current.updatedAt || current.updated_at || '');
    const itemTime = Date.parse(item.updatedAt || item.updated_at || '');
    if (Number.isFinite(itemTime) && (!Number.isFinite(currentTime) || itemTime > currentTime)) return item;
    if (Number.isFinite(currentTime) && (!Number.isFinite(itemTime) || currentTime > itemTime)) return current;
    return item;
  }, null);
}

export function renderUBuddyCoordinationPanels({
  state,
  taskRunId = '',
  coordination = null,
  task = null,
  nodes = [],
  blocker = null,
} = {}) {
  if (!coordination || !taskRunId) return '';
  const coordinationSnapshot = normalizeCoordinationSnapshot(coordination);
  if (!coordinationSnapshot) return '';
  const roster = Array.isArray(state?.employeeOverview?.roster) ? state.employeeOverview.roster : [];
  const participantViews = coordinationSnapshot.participants.map((participant) => {
    const employee = roster.find((item) => item.id === participant.agentInstanceId) || {};
    return { employee, status: agentWorkStatusFor(state, employee, participant) };
  });
  const leader = resolveLeader(coordinationSnapshot.leader, participantViews, roster);
  const assignments = assignedAgentGroups({ state, roster, participantViews, leader, nodes: Array.isArray(nodes) && nodes.length ? nodes : task?.nodes });
  const workProjection = state?.uBuddyFeatureFlags?.agentWorkDetailProjection === true
    ? task?.agentWorkStatusProjection || null
    : null;
  const allocation = renderAllocationCard({
    state, taskRunId, coordination: coordinationSnapshot, task, roster, assignments, leader, nodes, workProjection,
  });
  const progress = renderTeamProgressCard({ state, taskRunId, coordination: coordinationSnapshot, nodes, blocker, task });
  return `${allocation}${progress}`;
}

function renderAllocationCard({ state, taskRunId, coordination, task, roster, assignments, leader, nodes = [], workProjection = null }) {
  const coordinationState = coordination.coordinationState || 'planning';
  const continuedByTaskRunId = String(task?.metadata?.continuedByTaskRunId || '');
  const requirements = requiredAgentTypes(coordination, task);
  const candidates = matchingCandidates(coordination, task, roster, state, requirements);
  const matching = ['planning', 'waiting_for_agents'].includes(coordinationState);
  const waiting = coordinationState === 'waiting_for_agents';
  const sleeping = coordinationState === 'sleeping';
  const reviewing = String(task?.metadata?.deliveryReviewState || task?.deliveryReview?.state || '') === 'verifying';
  const permission = taskPermissionDisplay(task);
  const phaseTitle = ({
    planning: 'uBuddy 正在读取员工状态',
    waiting_for_agents: '正在等待员工空闲',
    sleeping: '员工已分配，uBuddy sleeping',
    awakened: reviewing ? '结果已交付，uBuddy 正在质量检查' : 'leader 已唤醒 uBuddy',
    delivering: 'uBuddy 正在交付结果',
    completed: '任务结果已交付',
    failed: '任务执行未完成',
    cancelled: continuedByTaskRunId ? '任务已续接' : '任务已取消',
  })[coordinationState] || 'uBuddy 正在协调员工';
  const description = waiting
    ? '当前没有满足要求的空闲员工；能力需求已保存，员工空闲后自动开始。'
    : sleeping
      ? assignments.length
        ? 'leader 正在带领参与 Agent 执行任务，uBuddy 等待 leader 唤醒。'
        : '已进入分配阶段，正在同步最终 Agent 信息。'
      : coordinationState === 'planning'
        ? '正在按 Agent 类型和当前工作状态检查可用员工。'
        : coordinationState === 'completed'
          ? assignments.length
            ? 'leader 已完成任务，uBuddy 已交付最终结果。'
            : '任务已结束，但最终分配信息暂不可用。'
          : coordinationState === 'failed'
            ? assignments.length
              ? 'leader 已结束执行，失败信息和建议已交付。'
              : '任务未能完成 Agent 分配，失败信息已经记录。'
            : coordinationState === 'cancelled'
              ? continuedByTaskRunId
                ? '用户补充的信息已转入后续任务轮次，当前轮次仅作为历史记录保留。'
                : '任务已停止，当前状态已经持久化。'
              : reviewing
                ? 'Agent 已提交当前版本；质量结论由 uBuddy 大模型独立作出，程序事实仅作为证据。'
                : '任务团队与负责节点已确认。';
  return `<section class="ubuddy-allocation-card is-${escapeAttr(coordinationState)}" data-ubuddy-allocation-card="${escapeAttr(taskRunId)}">
    <header><span class="ubuddy-coordination-mark">U</span><div><strong>任务分配情况</strong><small>${escapeHtml(`${phaseTitle} · ${description}`)}</small></div><span class="ubuddy-task-permission-badge is-${escapeAttr(permission.mode)}" title="${escapeAttr(permission.title)}">${escapeHtml(permission.label)}</span><em>${escapeHtml(coordinationStateLabel(coordinationState, continuedByTaskRunId))}</em></header>
    ${matching
      ? `<div class="ubuddy-allocation-requirements"><strong>所需能力</strong><div>${requirements.length
        ? requirements.map((item) => `<span>${escapeHtml(item.label)}${item.count > 1 ? ` × ${item.count}` : ''}</span>`).join('')
        : '<span>识别中</span>'}</div></div>
        ${waiting ? renderWaitingRequirements(coordination.waitingRequirements) : ''}
        ${candidates.length ? `<div class="ubuddy-allocation-candidates"><strong>候选 Agent</strong>${candidates.map((candidate) => `<div><span>${escapeHtml(candidate.name || candidate.agentFamilyId || 'Agent')}</span>${renderAgentWorkStatus(candidate, { compact: true })}</div>`).join('')}</div>` : ''}`
      : renderAssignedAgents(assignments, leader, { nodes, workProjection, coordinationState })}
  </section>`;
}

function assignedAgentGroups({ state, roster = [], participantViews = [], leader = {}, nodes = [] } = {}) {
  const groups = new Map();
  const addStatus = (status = {}, employee = {}) => {
    const key = status.agentInstanceId || (status.agentFamilyId ? `family:${status.agentFamilyId}` : `name:${status.name || 'Agent'}`);
    if (!groups.has(key)) groups.set(key, {
      key,
      status,
      employee,
      agentInstanceId: status.agentInstanceId || '',
      agentFamilyId: status.agentFamilyId || employee.agentFamilyId || '',
      familyName: employee.family?.name || '',
      name: agentInstanceDisplayNameForUi(employee, status.name || ''),
      nodes: [],
    });
  };
  participantViews.forEach(({ status, employee }) => addStatus(status, employee));
  if (leader.agentInstanceId && !groups.has(leader.agentInstanceId)) {
    const employee = roster.find((item) => item.id === leader.agentInstanceId) || {};
    addStatus(agentWorkStatusFor(state, employee, {
      agentInstanceId: leader.agentInstanceId,
      name: leader.name,
    }), employee);
  }
  for (const [nodeIndex, node] of (Array.isArray(nodes) ? nodes : []).entries()) {
    const instanceId = String(node.agentInstanceId || node.agent_instance_id || '').trim();
    const familyId = String(node.agentId || node.agent_id || '').trim();
    if (instanceId && !groups.has(instanceId)) {
      const employee = roster.find((item) => item.id === instanceId) || {};
      addStatus(agentWorkStatusFor(state, employee, {
        agentInstanceId: instanceId,
        agentFamilyId: familyId,
        name: agentInstanceDisplayNameForUi(employee, employee.family?.name || ''),
        availability: ['ready', 'queued', 'running', 'waiting', 'retry_wait', 'blocked'].includes(String(node.status || '')) ? 'working' : 'idle',
        workState: node.status,
        currentWork: node.title || '',
        updatedAt: node.updatedAt || '',
      }), employee);
    }
    const group = instanceId ? groups.get(instanceId) : null;
    if (!group) continue;
    if (familyId && !group.agentFamilyId) {
      group.agentFamilyId = familyId;
      group.status = { ...group.status, agentFamilyId: familyId };
    }
    const nodeKey = String(node.id || node.localId || node.local_id || node.title || `node:${nodeIndex}`).trim();
    if (!group.nodes.some((item) => item.key === nodeKey)) {
      group.nodes.push({
        key: nodeKey,
        id: String(node.id || node.localId || node.local_id || '').trim(),
        title: String(node.title || '任务节点').trim(),
        status: String(node.status || 'pending').trim(),
      });
    }
  }
  const labeled = numberAgentInstanceLabels([...groups.values()], {
    baseName: (item) => item.name || item.familyName || item.agentFamilyId || 'Agent',
  });
  return labeled.sort((left, right) => Number(right.agentInstanceId === leader.agentInstanceId) - Number(left.agentInstanceId === leader.agentInstanceId)
    || left.displayName.localeCompare(right.displayName, 'zh-CN')
    || left.agentInstanceId.localeCompare(right.agentInstanceId));
}

function renderAssignedAgents(assignments = [], leader = {}, { nodes = [], workProjection = null, coordinationState = '' } = {}) {
  const projectionEnvelope = workProjectionEnvelope(workProjection);
  const assignmentViews = numberAgentInstanceLabels(assignments.map((assignment) => {
    const projection = workProjectionForAgent(projectionEnvelope, {
      agentInstanceId: assignment.status.agentInstanceId,
      agentId: assignment.status.agentFamilyId,
    });
    return {
      ...assignment,
      projection,
      name: preferredAssignmentName(assignment, projection),
    };
  }), {
    baseName: (item) => item.name || item.familyName || item.agentFamilyId || 'Agent',
  });
  const emptyTerminal = !assignments.length && ['failed', 'cancelled'].includes(coordinationState);
  const emptyMessage = coordinationState === 'failed'
    ? '未能完成 Agent 分配'
    : coordinationState === 'cancelled'
      ? '任务已取消，未产生最终分配'
      : coordinationState === 'completed'
        ? '最终分配信息暂不可用'
        : '最终分配信息更新中';
  return `<div class="ubuddy-assigned-agents"><strong>${emptyTerminal ? '分配结果' : '最终 Agent'}</strong>${assignmentViews.length ? assignmentViews.map(({ status, nodes: responsibleNodes, displayName, projection }) => {
    if (projection) {
      return renderAgentWorkProjectionSummary(projection, {
        leader: status.agentInstanceId === leader.agentInstanceId,
        displayName: displayName || status.name || status.agentFamilyId || 'Agent',
        nodes: responsibleNodes.length ? responsibleNodes : nodes,
        showTimeline: true,
      });
    }
    return `<article>
      <header><span><b>${escapeHtml(displayName || status.name || status.agentFamilyId || 'Agent')}</b>${status.agentInstanceId === leader.agentInstanceId ? `<em>leader</em><i>${escapeHtml(leader.leadershipLevel || 'L0')}</i>` : ''}</span>${renderAgentWorkStatus(status, { compact: true })}</header>
      <div class="ubuddy-assigned-nodes"><small>负责节点</small>${responsibleNodes.length ? `<ul>${responsibleNodes.map((node) => `<li>${escapeHtml(node.title)}</li>`).join('')}</ul>` : '<span>节点信息更新中</span>'}</div>
    </article>`;
  }).join('') : `<p class="ubuddy-assignment-pending">${escapeHtml(emptyMessage)}</p>`}</div>`;
}

function preferredAssignmentName(assignment = {}, projection = null) {
  const familyId = String(assignment.agentFamilyId || assignment.status?.agentFamilyId || '').trim();
  const current = String(assignment.displayName || assignment.name || assignment.status?.name || '').trim();
  const generic = !current || current === 'Agent' || current === familyId || current === projection?.agentId
    || /^[a-z0-9_.-]+(?:\s+#\d+)?$/i.test(current);
  return generic && projection?.actorLabel
    ? projection.actorLabel
    : current || projection?.actorLabel || familyId || 'Agent';
}

function renderTeamProgressCard({ state, taskRunId, coordination, nodes, blocker, task = null }) {
  const coordinationState = coordination.coordinationState || 'planning';
  if (['planning', 'waiting_for_agents'].includes(coordinationState)) return '';
  const wakeReason = normalizeWakeReason(coordination.wakeReason);
  const failureReport = normalizeFailureReport(coordination.failureReport) || failureFromBlocker(blocker);
  const visibleNodes = Array.isArray(nodes) ? nodes.slice(0, 12) : [];
  const deliveryReview = renderDeliveryReview(task, state);
  if (!wakeReason && !failureReport && !visibleNodes.length && !deliveryReview) return '';
  return `<section class="ubuddy-team-progress-card" data-ubuddy-task-progress-card="${escapeAttr(taskRunId)}">
    <header><div><small>执行详情</small><strong>节点状态与交付</strong></div><span>${escapeHtml(visibleNodes.length ? `${visibleNodes.length} 节点` : coordinationStateLabel(coordinationState))}</span></header>
    ${visibleNodes.length ? `<details class="ubuddy-team-nodes"><summary>节点、阻塞与自动重试</summary>${visibleNodes.map(renderCoordinationNode).join('')}</details>` : ''}
    ${deliveryReview}
    ${wakeReason ? renderWakeReason(wakeReason) : ''}
    ${failureReport ? renderFailureReport(failureReport) : ''}
  </section>`;
}

function renderDeliveryReview(task = null, rendererState = {}) {
  const review = task?.deliveryReview || task?.metadata?.deliveryReview || null;
  if (!review) return '';
  const reviewState = String(review.state || task?.metadata?.deliveryReviewState || 'submitted');
  const revisionNumber = Math.max(0, Number(review.qualityRevisionCount ?? review.revisionNumber ?? 0));
  const revisionLimit = Math.max(1, Number(review.maxQualityRevisions ?? review.qualityRevisionLimit ?? review.revisionLimit ?? 2));
  const submissions = Array.isArray(task?.deliverySubmissions) ? task.deliverySubmissions.slice().reverse() : [];
  const failedChecks = Array.isArray(review.failedChecks) ? review.failedChecks : [];
  const requiredChanges = Array.isArray(review.requiredChanges) ? review.requiredChanges : [];
  const preservedRequirements = Array.isArray(review.preservedRequirements) ? review.preservedRequirements : [];
  const acceptanceSource = String(review.acceptanceSource || task?.metadata?.deliveryReviewOutcome || '');
  const externalDelegationId = task?.metadata?.taskOrigin === 'external_delegation'
    ? String(task?.metadata?.delegationId || '').trim()
    : '';
  const externalDelegationStatus = externalDelegationId
    ? latestDelegationRecord(rendererState, externalDelegationId)?.status || ''
    : '';
  const finalDelivery = normalizeFinalDeliveryPolicy(task?.metadata?.finalDelivery, task?.metadata || {});
  const revisionPending = finalDelivery.state === 'not_delivered' && Boolean(task?.metadata?.deliveryRevisionRequestedAt);
  const selectedSubmissionId = String(review.selectedSubmissionId || task?.metadata?.selectedDeliverySubmissionId || '');
  const stateText = ({
    submitted: finalDelivery.state === 'delivered' ? '结果已交付 · 质量检查排队中' : '已提交',
    verifying: finalDelivery.state === 'delivered' ? '结果已交付 · 质量检查中' : '质量检查中',
    revision_requested: '发现质量问题 · 等待用户决定',
    reworking: '用户已要求修改 · Agent 修改中',
    accepted: externalDelegationId && ['result_accepted', 'closed'].includes(externalDelegationStatus) ? '发出方已确认任务结束'
      : externalDelegationId && ['submitted', 'completed'].includes(externalDelegationStatus) ? '已交付 · 等待发出方验收'
        : externalDelegationId && externalDelegationStatus === 'revision_requested' ? '发出方已打回 · 等待修改'
          : externalDelegationId ? '结果已就绪 · 等待接收方交付'
      : finalDelivery.state === 'closed' ? '用户已确认 · 任务已关闭'
      : revisionPending ? '用户已要求修改 · 等待新版本'
        : acceptanceSource === 'revision_limit_best_effort' ? '已交付当前版本 · 等待用户确认' : '质量检查通过 · 等待用户确认',
    action_required: finalDelivery.state === 'delivered' ? '质量检查暂不可用 · 结果仍可确认' : '需要用户处理',
    revision_exhausted: '质量检查有提示 · 结果仍可确认',
    failed: finalDelivery.state === 'delivered' ? '质量检查失败 · 结果仍可确认' : '审核终止',
  })[reviewState] || reviewState;
  const taskKey = String(task?.id || 'task').trim();
  return `<details class="ubuddy-delivery-review"${taskDisclosureAttributes(rendererState, `${taskKey}:delivery-review`, true)}><summary><span>交付与质量检查</span><strong>${escapeHtml(stateText)}</strong><em>质量提示</em></summary>
    <div class="ubuddy-delivery-review-body">
      <p>${escapeHtml(review.summary || (reviewState === 'verifying' ? 'uBuddy 正在根据原始要求审阅正文与文件证据。' : '交付审核状态已更新。'))}</p>
      <div class="ubuddy-delivery-review-counts"><span>质量提示 <b>${revisionNumber}/${revisionLimit}</b></span><span>检查执行尝试 <b>${Math.max(0, Number(review.executionAttemptCount || 0))}</b></span></div>
      ${failedChecks.length ? `<section><strong>未通过检查</strong><ul>${failedChecks.map((item) => `<li><b>${escapeHtml(item.summary || item.code || '检查未通过')}</b>${item.requirement ? `<small>要求：${escapeHtml(item.requirement)}</small>` : ''}${item.evidence ? `<small>证据：${escapeHtml(item.evidence)}</small>` : ''}</li>`).join('')}</ul></section>` : ''}
      ${requiredChanges.length ? `<section><strong>建议修改</strong><ol>${requiredChanges.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol></section>` : ''}
      ${preservedRequirements.length ? `<section><strong>修改时必须保留</strong><ul>${preservedRequirements.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>` : ''}
      ${review.qualityWarning || task?.metadata?.deliverableResult?.qualityWarning ? `<div class="ubuddy-delivery-quality-warning"><strong>质量提示</strong><span>${revisionPending ? '上一版保留质量提示；你已要求修改，当前等待新的交付版本。' : '当前版本已交付，uBuddy 的质量检查只作为建议展示。'}</span></div>` : ''}
      ${submissions.length ? `<details class="ubuddy-delivery-versions"${taskDisclosureAttributes(rendererState, `${taskKey}:delivery-versions`)}><summary>查看全部交付版本（${submissions.length}）</summary>${submissions.map((submission, index) => renderDeliverySubmission(submission, { selectedSubmissionId, finalDeliveryState: finalDelivery.state, rendererState, taskKey, externalDelegationId, externalDelegationStatus, latest: index === 0 })).join('')}</details>` : ''}
    </div>
  </details>`;
}

function taskPermissionDisplay(task = {}) {
  const options = task?.metadata?.executionOptions || {};
  if (options.permissionPolicyVersion !== 'ubuddy_task_permission_v2') {
    return { mode: 'task-workspace', label: '兼容隔离', title: '旧任务继续使用任务工作区隔离权限' };
  }
  if (options.permissionMode === 'full-access') {
    return { mode: 'full-access', label: '完全开放', title: '允许本机员工 Agent 使用终端、网络和电脑文件；不包含桌面 GUI 自动化' };
  }
  return { mode: 'auto-approve', label: 'AI 自动审查', title: '由 AI 审查风险操作，本任务的本机员工 Agent 继承该模式' };
}

function renderDeliverySubmission(submission = {}, { selectedSubmissionId = '', finalDeliveryState = 'not_delivered', rendererState = {}, taskKey = 'task', externalDelegationId = '', externalDelegationStatus = '', latest = false } = {}) {
  const files = Array.isArray(submission.artifactManifest) ? submission.artifactManifest : [];
  const body = String(submission.bodySnapshot || '').trim();
  const selected = selectedSubmissionId === submission.id;
  const closed = finalDeliveryState === 'closed';
  const externalFooter = ['result_accepted', 'closed'].includes(externalDelegationStatus)
    ? '<span>发出方已确认结束</span>'
    : ['submitted', 'completed'].includes(externalDelegationStatus)
      ? '<span>已交付 · 等待发出方验收</span>'
      : externalDelegationStatus === 'revision_requested'
        ? `<button class="mini-btn" type="button" data-network-delegation="${escapeAttr(externalDelegationId)}">查看打回要求</button>`
        : selected || (!selectedSubmissionId && latest)
          ? `<button class="mini-btn" type="button" data-network-delegation="${escapeAttr(externalDelegationId)}">去委托任务确认交付</button>`
          : '<span>历史版本 · 仅供查看</span>';
  return `<article class="${selected ? 'is-selected' : ''}" data-delivery-submission-id="${escapeAttr(submission.id || '')}"><header><strong>版本 ${Math.max(1, Number(submission.submissionNo || 1))}${selected ? ' · 当前交付' : ''}</strong><small>${escapeHtml(formatDateTime(submission.createdAt || ''))}</small></header>${files.length ? `<div class="ubuddy-delivery-version-files">${files.map(renderDeliveryVersionFile).join('')}</div>` : ''}${body ? `<details${taskDisclosureAttributes(rendererState, `${taskKey}:delivery:${submission.id || submission.submissionNo || 'latest'}`)}><summary>查看该版本正文</summary><pre>${escapeHtml(body.slice(0, 12000))}${body.length > 12000 ? '\n…内容已截断显示，完整快照仍已保留。' : ''}</pre></details>` : '<p>该版本仅包含文件交付。</p>'}<footer>${externalDelegationId
    ? externalFooter
    : `<button class="mini-btn" type="button" data-accept-delivery-submission="${escapeAttr(submission.id || '')}" data-delivery-submission-no="${Math.max(1, Number(submission.submissionNo || 1))}" ${closed && selected ? 'disabled' : ''}>${closed && selected ? '用户已确认' : selected ? '接受当前交付' : '采用并接受此版本'}</button>`}</footer></article>`;
}

function taskDisclosureAttributes(rendererState = {}, key = '', defaultOpen = false) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return defaultOpen ? ' open' : '';
  const hasState = Object.prototype.hasOwnProperty.call(rendererState.taskDisclosureOpenByKey || {}, cleanKey);
  const open = hasState ? Boolean(rendererState.taskDisclosureOpenByKey[cleanKey]) : Boolean(defaultOpen);
  return ` data-task-disclosure-key="${escapeAttr(cleanKey)}"${open ? ' open' : ''}`;
}

function renderDeliveryVersionFile(rawFile = {}) {
  const file = normalizeFilePayload({ ...rawFile, path: rawFile.path || rawFile.snapshotPath || '' });
  const payload = filePayloadAttr(file);
  return `<article><span><strong>${escapeHtml(file.name || '交付文件')}</strong><small>${file.size ? `${Math.max(1, Math.round(file.size / 1024))} KB` : '版本快照'}</small></span><div><button type="button" data-preview-file="${payload}">预览</button><button type="button" data-open-file="${payload}">打开</button><button type="button" data-save-file="${payload}">下载</button><button type="button" data-show-file="${payload}">定位</button></div></article>`;
}

function renderCoordinationNode(node = {}) {
  const status = String(node.status || 'pending');
  const attempts = Number(node.maxAttempts || 0) > 1
    ? `${Number(node.attemptCount || 0)}/${Number(node.maxAttempts || 0)} 次`
    : '';
  const retry = node.nextRetryAt ? `下次自动重试：${formatDateTime(node.nextRetryAt)}` : '';
  return `<div class="is-${escapeAttr(status)}"><span><strong>${escapeHtml(node.title || '任务节点')}</strong><small>${escapeHtml(node.agentName || node.agentId || 'Agent')} · ${escapeHtml(nodeStateLabel(status))}</small></span><em>${escapeHtml([attempts, retry].filter(Boolean).join(' · ') || '—')}</em></div>`;
}

function renderWaitingRequirements(items = []) {
  const requirements = Array.isArray(items) ? items : [];
  if (!requirements.length) return '<div class="ubuddy-waiting-requirements"><strong>等待员工空闲</strong><span>所需能力已保存，暂不绑定员工实例。</span></div>';
  return `<div class="ubuddy-waiting-requirements"><strong>等待员工空闲</strong>${requirements.map((item) => `<span>${escapeHtml(requirementLabel(item))} · 暂不绑定实例</span>`).join('')}</div>`;
}

function renderWakeReason(wakeReason = {}) {
  const qualityRevisionExhausted = /revision_exhausted|自动修改次数|质量修改/.test(`${wakeReason.code || ''} ${wakeReason.summary || ''}`);
  const label = ({
    completion: '团队任务已完成',
    recovery_exhausted: qualityRevisionExhausted ? '交付质量修改次数已耗尽' : '自动恢复和重试已耗尽',
    user_action_required: '需要用户补充信息或权限',
    cancelled: '任务已取消',
    planning_failed: '任务拆解或分配失败',
  })[wakeReason.code] || wakeReason.summary || wakeReason.code || 'Leader 已唤醒 uBuddy';
  return `<div class="ubuddy-wake-reason"><strong>Leader 唤醒原因</strong><span>${escapeHtml(label)}</span>${wakeReason.summary && wakeReason.summary !== label ? `<small>${escapeHtml(wakeReason.summary)}</small>` : ''}</div>`;
}

function renderFailureReport(report = {}) {
  const summary = friendlyFailureSummary(report);
  const attempts = report.maxAttempts
    ? `执行尝试：${Number(report.attemptCount || 0)}/${Number(report.maxAttempts || 0)}`
    : '';
  return `<details class="ubuddy-failure-report" open><summary>结构化失败报告</summary><div><strong>${escapeHtml(summary)}</strong>${report.errorCode ? `<span>错误类型：${escapeHtml(report.errorCode)}</span>` : ''}${report.cause ? `<span>原因：${escapeHtml(report.cause)}</span>` : ''}${attempts ? `<span>${escapeHtml(attempts)}</span>` : ''}${report.attemptedActions?.length ? `<span>已尝试：${escapeHtml(report.attemptedActions.join('；'))}</span>` : ''}<span>建议：${escapeHtml(report.suggestedNextStep || '检查任务详情并处理阻塞后继续。')}</span></div></details>`;
}

function requiredAgentTypes(coordination = {}, task = null) {
  const waitingRequirements = Array.isArray(coordination.waitingRequirements)
    ? coordination.waitingRequirements
    : Array.isArray(coordination.waiting_requirements) ? coordination.waiting_requirements : [];
  const fromRequirements = waitingRequirements.map((item) => ({
    id: String(item?.agentFamilyId || item?.agent_family_id || item?.agentType || item?.agent_type || item?.type || item?.capability || item || '').trim(),
    label: requirementLabel(item),
    count: Math.max(1, Number(item?.count || item?.requiredCount || item?.required_count || 1)),
  })).filter((item) => item.id || item.label);
  const nodes = Array.isArray(task?.nodes) ? task.nodes : [];
  const fromNodes = nodes.map((node) => {
    const id = String(node.agentId || node.agent_id || '').trim();
    return { id, label: node.agentName || node.agent_name || id || 'Agent', count: 1 };
  }).filter((item) => item.id);
  const items = fromRequirements.length ? fromRequirements : fromNodes;
  const grouped = new Map();
  for (const item of items) {
    const key = item.id || item.label;
    const previous = grouped.get(key);
    grouped.set(key, previous ? { ...previous, count: previous.count + item.count } : item);
  }
  return [...grouped.values()];
}

function matchingCandidates(coordination, task, roster, state, requirements) {
  const source = [coordination.matches, coordination.candidates, task?.metadata?.candidateSnapshots]
    .flatMap((items) => Array.isArray(items) ? items : []);
  const requirementIds = new Set(requirements.map((item) => item.id).filter(Boolean));
  const candidates = source.filter((candidate) => candidate && typeof candidate === 'object').filter((candidate) => {
    const familyId = candidate.agentFamilyId || candidate.agent_family_id || candidate.agentId || candidate.agent_id || candidate.type;
    return !requirementIds.size || requirementIds.has(familyId);
  })
    .map((candidate, index) => {
      const id = candidate.agentInstanceId || candidate.agent_instance_id || '';
      const employee = roster.find((item) => item.id === id) || {};
      const currentWork = candidate.currentWork || candidate.current_work || candidate.runningWork || candidate.running_work || '';
      const status = agentWorkStatusFor(state, employee, {
        ...candidate,
        agentFamilyId: candidate.agentFamilyId || candidate.agent_family_id || candidate.agentId || candidate.agent_id,
        availability: candidate.availability || (candidate.status === 'busy' ? 'working' : candidate.status === 'available' ? 'idle' : ''),
        ...(currentWork ? { currentWork } : {}),
      });
      return { status, key: status.agentInstanceId || `${status.agentFamilyId}:${status.name || index}` };
    });
  const unique = new Map();
  for (const candidate of candidates) {
    const previous = unique.get(candidate.key);
    if (!previous || (Date.parse(candidate.status.updatedAt || '') || 0) > (Date.parse(previous.status.updatedAt || '') || 0)) {
      unique.set(candidate.key, candidate);
    }
  }
  return [...unique.values()].slice(0, 8).map((candidate) => candidate.status);
}

function resolveLeader(source = {}, participantViews = [], roster = []) {
  const id = String(source?.agentInstanceId || source?.agent_instance_id || '').trim();
  const participant = participantViews.find(({ status }) => status.agentInstanceId === id)?.status || null;
  const employee = roster.find((item) => item.id === id) || {};
  return {
    agentInstanceId: id,
    name: agentInstanceDisplayNameForUi(employee, source?.name || source?.displayName || source?.display_name || participant?.name || employee.family?.name || ''),
    leadershipLevel: source?.leadershipLevel || source?.leadership_level || employee.leadership?.level || 'L0',
  };
}

function failureFromBlocker(blocker = null) {
  if (!blocker) return null;
  return normalizeFailureReport({
    errorCode: blocker.errorCode,
    summary: blocker.summary,
    attemptCount: blocker.attemptCount,
    maxAttempts: blocker.maxAttempts,
    attemptedActions: blocker.attemptedActions,
    suggestedNextStep: blocker.suggestedNextStep,
  });
}

function friendlyFailureSummary(report = {}) {
  const text = `${report.errorCode || ''} ${report.summary || ''} ${report.cause || ''}`.toLowerCase();
  if (/network|connection|econn|enotfound|eai_again|socket|fetch failed/.test(text)) {
    return '网络连接暂时异常，系统已完成自动重试；请检查网络后继续。';
  }
  return report.summary || '任务执行失败，需要处理后继续。';
}

function requirementLabel(item = {}) {
  if (typeof item === 'string') return item;
  return String(item.label || item.name || item.agentType || item.agent_type || item.agentFamilyId || item.agent_family_id || item.type || item.capability || '目标 Agent').trim();
}

function coordinationStateLabel(value = '', continuedByTaskRunId = '') {
  if (value === 'cancelled' && continuedByTaskRunId) return '已续接';
  return ({
    planning: '读取状态', waiting_for_agents: '等待空闲', sleeping: 'sleeping', awakened: 'awakened',
    delivering: '交付中', completed: '已交付', failed: '未完成', cancelled: '已取消',
  })[value] || value;
}

function nodeStateLabel(value = '') {
  return ({ pending: '等待依赖', ready: '已预留', queued: '排队中', running: '执行中', waiting: '等待信息', retry_wait: '等待自动重试', blocked: '受阻', failed: '失败', completed: '已完成', cancelled: '已取消' })[value]
    || workStateLabel(value) || value || '状态更新中';
}
