import crypto from 'node:crypto';

import { newId } from '../../../utils.js';
import {
  delegationTransitionAllowed as localDelegationTransitionAllowed,
  nextDelegationStatus as localNextDelegationStatus,
  publicDelegationMetadata as publicAgentDelegationMetadata,
  publicDelegationSubmissionText,
} from '../../../../shared/contracts/delegation.js';
import { publicDelegationAttachment } from '../domain/delegationWorkspaceRules.js';
import { mentionPrincipalId, normalizeMentionEntities } from '../../../../shared/contracts/mentions.js';

function isSecretaryIdentityQuestion(message = '') {
  const text = String(message || '').trim();
  return /^(who are you|what are you|do you know ubuddy|你是谁|你是做什么的|你认识\s*u?buddy\s*吗|什么是\s*u?buddy)[？?。.！!\s]*$/i.test(text);
}

function isSecretaryGreetingMessage(message = '') {
  const text = String(message || '').trim();
  return /^(?:hi|hello|hey|ni\s*hao|你好|您好|嗨|哈[喽啰]|在吗|早上好|上午好|下午好|晚上好)(?:\s*u?buddy)?[？?。.！!,，\s]*$/i.test(text);
}

function isSecretaryContextCollectionMessage(message = '') {
  const text = String(message || '').trim();
  if (isSecretaryPublishConfirmation(text)) return false;
  return /(先记住|先记录|先保存|我继续补充|补充(?:一下)?(?:任务)?背景|暂时不要发布|先不要发布|先别发布|还没说完|稍后再发布)/.test(text);
}

function isSecretaryPublishConfirmation(message = '') {
  const text = String(message || '').trim();
  if (/(?:不要|别|暂不|暂时不|先不|无需|不需要).{0,12}(?:创建|新建|建立|发布|派发|提交|分配|执行)/.test(text)) return false;
  return /(?:确认|现在|可以|请|立即|马上|就按这个|按以上内容|按这些内容)?\s*(?:发布|派发|提交|分配)(?:这个|这项|以上|这些)?\s*(?:任务|委托)?[吧。！!]*$/.test(text)
    || /(?:现在|请|立即|马上|确认)?\s*(?:创建|新建|建立).{0,24}(?:任务群|新任务|任务)/.test(text)
    || /(?:现在|立即|马上|开始).{0,8}(?:执行|推进)(?:这个|这项|以上|这些)?\s*(?:任务|委托)?/.test(text)
    || /(?:交给|让).{1,80}(?:完成|处理|负责|执行)/.test(text);
}

function secretaryExplicitDelegationContext(messages = []) {
  const selected = [];
  for (let index = (Array.isArray(messages) ? messages : []).length - 1; index >= 0; index -= 1) {
    const message = messages[index] || {};
    if (message.role !== 'user') continue;
    if (message.metadata?.identityControl || message.metadata?.taskQueryIntent) continue;
    if (message.metadata?.contextCollection !== true) break;
    selected.unshift(message);
  }
  return selected;
}

function secretaryDelegationTargetsFromMentions(mentions = [], friendships = [], { additionalUserIds = [] } = {}) {
  const requestedIds = new Set(normalizeMentionEntities(mentions, { requirePicker: true })
    .filter((mention) => mention.principalType !== 'organization')
    .map(mentionPrincipalId)
    .filter(Boolean));
  for (const userId of Array.isArray(additionalUserIds) ? additionalUserIds : []) {
    if (String(userId || '').trim()) requestedIds.add(String(userId).trim());
  }
  if (!requestedIds.size) return [];
  return (friendships || []).map((relationship) => {
    const friend = relationship.friend || relationship.user || relationship;
    return { relationship, friend };
  }).filter((item) => requestedIds.has(String(item.friend?.id || '')));
}

function hasSecretaryAccountReference(message = '') {
  const text = String(message || '').trim();
  return /(?:^|[^A-Za-z0-9_.+-])@[^\s@，,。；;：:！？!?]{1,64}/u.test(text);
}

function ensureSecretaryConversationSeed(store, session = {}, language = 'zh-CN') {
  void store;
  void session;
  void language;
  return null;
}

function recordSecretaryDelegationFeedback(store, delegation = {}, content = '') {
  const sessionId = delegation.metadata?.sourceSecretarySessionId || '';
  if (!sessionId || !store.getSession(sessionId)) return null;
  const existing = store.listMessages(sessionId).find((message) => (
    message.metadata?.delegationFeedbackId === delegation.id && message.metadata?.delegationStatus === delegation.status
  ));
  if (existing) return existing;
  return store.addMessage({
    sessionId,
    role: 'assistant',
    content: String(content || '').trim() || `\u59d4\u6258\u4efb\u52a1\u72b6\u6001\u5df2\u66f4\u65b0\uff1a${delegation.status || ''}`,
    agentId: 'secretary_agent',
    departmentId: 'secretary_department',
    metadata: {
      secretaryControl: true,
      delegationFeedbackId: delegation.id,
      delegationStatus: delegation.status,
      peerUserId: delegation.recipientUserId || '',
    },
  });
}

function delegationRequiresHumanApproval(delegation = {}) {
  const text = `${delegation.title || ''}\n${delegation.instruction || ''}`
    .toLowerCase()
    .split('\n')
    .filter((line) => {
      if (/(公开|官网|网站|平台|社媒|上线|external|public)/i.test(line)) return true;
      const internalDelegationDispatch = /(?:任务|委托)/.test(line)
        && /(?:发布|发送|派发)/.test(line)
        && /(?:ubuddy|接收方|对方|你方|确认|发起|状态|此前|现已|已经)/i.test(line);
      return !(internalDelegationDispatch
        || /发布(?:状态|确认)/.test(line)
        || /(?:任务|委托).{0,30}(?:发布给|派发给|发送给)/.test(line)
        || /(?:暂不|不要|先不|请勿|不得|无需|未经.{0,24}确认|未获.{0,24}许可).{0,36}发布/i.test(line)
        || /(?:确认|现已|已经).{0,30}发布.{0,30}(?:任务|委托|你方|接收方|ubuddy)/i.test(line));
    })
    .join('\n')
    .replace(/发布(?:状态|确认)[^\n]*/g, '')
    .replace(/(?:不代表|不等于|不得|不要|请勿|无需|未经[^\n]{0,24}确认|未获[^\n]{0,24}(?:许可|授权|同意|不得))[^\n。；;]{0,80}发布[^\n。；;]*/g, '')
    .replace(/(?:将|把)?(?:此|该|这个|这项)?(?:任务|委托).{0,12}发布给/g, '')
    .replace(/发布\s*(?:一个|一项|这个|这项)?\s*(?:任务|委托)/g, '');
  return /(\u5220\u9664|\u6e05\u7a7a|\u91cd\u7f6e|\u4ed8\u6b3e|\u8d2d\u4e70|\u8f6c\u8d26|\u53d1\u5e03|\u4e0a\u7ebf|\u63d0\u4ea4\u5ba1\u6279|\u5bc6\u7801|\u5bc6\u94a5|\u51ed\u636e|credential|password|api\s*key|private\s*key|rm\s+-rf)/i.test(text);
}


function publicDelegationExecutionFailure(error = null) {
  return delegationExecutionFailureDetails(error).publicMessage;
}

function delegationExecutionFailureDetails(error = null) {
  const raw = String(error?.message || error || '').trim();
  const explicitCode = String(error?.code || '').trim().toLowerCase();
  if (['ubuddy_planning_recovery_exhausted', 'delegation_planning_recovery_exhausted'].includes(explicitCode)) {
    return {
      code: 'ubuddy_planning_recovery_exhausted',
      retryable: false,
      stage: 'planning',
      publicMessage: '任务规划连续多次未能完成，系统已停止自动重试，避免任务反复从准备阶段重新开始。请检查模型服务后手动重试。',
      privateMessage: raw || 'External delegation planning recovery limit was exhausted.',
    };
  }
  if (/cancelled|canceled|aborted|用户取消|已取消/i.test(raw) || ['agent_work_cancelled', 'task_node_cancelled'].includes(explicitCode)) {
    return {
      code: 'execution_cancelled',
      retryable: true,
      stage: 'execution',
      publicMessage: '任务执行已取消，当前结果未被标记为完成或初稿就绪。',
      privateMessage: raw || 'Task execution was cancelled.',
    };
  }
  if (explicitCode === 'leadership_capacity_unavailable' || /No eligible .*lead|leadership_capacity_unavailable/i.test(raw)) {
    return {
      code: 'leadership_capacity_unavailable',
      retryable: true,
      stage: 'dispatch',
      publicMessage: '当前没有可任命的 Agent Leader；uBuddy 将改用平面协调后重试。',
      privateMessage: raw,
    };
  }
  if (explicitCode === 'ppt_skill_install_required') {
    return {
      code: 'ppt_skill_install_required',
      retryable: true,
      stage: 'preflight',
      publicMessage: '接收方当前设备尚未安装 PPT 制作 Skill，PPT Agent 因此无法执行任务。请接收方先安装 Skill，并确认 PPT Agent 已招募启用后重新调度；任务上下文已保留。',
      privateMessage: raw,
    };
  }
  if (explicitCode === 'ppt_employee_not_active') {
    return {
      code: 'ppt_employee_not_active',
      retryable: true,
      stage: 'preflight',
      publicMessage: '接收方当前没有已招募并启用的 PPT Agent。请接收方完成招募或重新启用后再调度；任务上下文已保留。',
      privateMessage: raw,
    };
  }
  if (/employee_not_active|no active employee|没有可用的 .*员工 Agent|没有可由 uBuddy 调度的在职员工 Agent/i.test(raw)) {
    return {
      code: 'no_active_employee',
      retryable: true,
      stage: 'preflight',
      publicMessage: '接收方当前没有可执行该任务的在职 Agent。任务上下文已保留，启用合适的 Agent 后可继续。',
      privateMessage: raw,
    };
  }
  if (/没有生成 PPTX|仍未生成 PPTX|缺少.*(?:文件|产物)|artifact|deliverable/i.test(raw)) {
    return {
      code: 'deliverable_missing',
      retryable: true,
      stage: 'validation',
      publicMessage: 'Agent 执行已经结束，但必要交付物未通过校验。uBuddy 已保留上下文，可重新生成缺失产物。',
      privateMessage: raw,
    };
  }
  if (/permission|sandbox|EACCES|EPERM|权限|工作区/i.test(raw)) {
    return {
      code: 'workspace_permission_denied',
      retryable: true,
      stage: 'execution',
      publicMessage: '任务工作区权限不足，uBuddy 已保留任务上下文；授权后可继续执行。',
      privateMessage: raw,
    };
  }
  if (/timeout|timed out/i.test(raw)) {
    return {
      code: 'execution_timeout',
      retryable: true,
      stage: 'execution',
      publicMessage: '本次任务执行超过允许时长，uBuddy 已保留任务上下文；可以继续重试或调整任务方案。',
      privateMessage: raw,
    };
  }
  if (/\bECONN(?:RESET|REFUSED)?\b|\bENOTFOUND\b|\bEAI_AGAIN\b|fetch failed|network error|socket hang up|service unavailable|temporarily unavailable|bad gateway|gateway timeout|model.{0,24}unavailable|at capacity|capacity.{0,48}(?:try|different model)|rate.?limit|too many requests|\b(?:429|502|503|504)\b|Codex CLI (?:was not found|could not be launched)/i.test(raw)) {
    return {
      code: 'model_unavailable',
      retryable: true,
      stage: 'execution',
      publicMessage: '模型服务暂时不可用，uBuddy 已保留任务上下文；服务恢复后可继续执行。',
      privateMessage: raw,
    };
  }
  return {
    code: explicitCode || 'execution_failed',
    retryable: false,
    stage: 'execution',
    publicMessage: '专业执行和接管执行都遇到明确错误，任务尚未完成，也没有被标记为初稿就绪。uBuddy 已保留错误和任务上下文，可在调整方案后重新执行。',
    privateMessage: raw || 'Unknown delegation execution failure.',
  };
}


function localCollaborationTaskAction(auth, { delegationId = '', action = '', content = '', metadata = {}, expectedStatus = '' } = {}) {
  const user = auth.requireUser();
  const delegation = auth.agentDelegationById(delegationId, { allowGroupOwner: action === 'withdraw' });
  if (!delegation) throw new Error('任务不存在。');
  let group = null;
  if (delegation.groupId) {
    const membership = auth.db.prepare("SELECT status FROM collaboration_group_members WHERE group_id = ? AND user_id = ?").get(delegation.groupId, user.id);
    group = auth.db.prepare('SELECT status,owner_user_id FROM collaboration_groups WHERE id = ?').get(delegation.groupId);
    if (!membership || membership.status !== 'active' || group?.status === 'closed') throw new Error('任务群已结束或你已不在群内。');
  }
  const recipientActions = ['working', 'submit', 'decline', 'blocked'];
  const requesterActions = ['accept_result', 'request_revision', 'publish', 'update_requirements', 'withdraw'];
  if (recipientActions.includes(action) && delegation.recipientUserId !== user.id) throw new Error('只有接收人可以执行此操作。');
  const groupOwnerCanWithdraw = action === 'withdraw' && group?.owner_user_id === user.id;
  if (requesterActions.includes(action) && delegation.requesterUserId !== user.id && !groupOwnerCanWithdraw) throw new Error('只有发起人可以执行此操作。');
  if (action === 'accept_result' && delegation.status === 'result_accepted') {
    return { ok: true, idempotent: true, delegation, overview: auth.collaborationOverview() };
  }
  if (action === 'withdraw' && delegation.status === 'withdrawn') {
    return { ok: true, idempotent: true, delegation, overview: auth.collaborationOverview() };
  }
  if (expectedStatus && expectedStatus !== delegation.status) throw new Error('任务状态已经更新，请刷新后重试。');
  const sourceWorkspaceMessageId = String(metadata?.sourceWorkspaceMessageId || '').trim();
  if (sourceWorkspaceMessageId && ['submit', 'publish', 'update_requirements'].includes(action)) {
    const duplicate = auth.db.prepare('SELECT metadata_json FROM agent_delegation_revisions WHERE delegation_id = ? AND action = ? ORDER BY revision_no DESC').all(delegationId, action)
      .find((row) => {
        try { return JSON.parse(row.metadata_json || '{}')?.sourceWorkspaceMessageId === sourceWorkspaceMessageId; } catch { return false; }
      });
    if (duplicate) return { ok: true, idempotent: true, delegation, overview: auth.collaborationOverview() };
  }
  const status = localNextDelegationStatus(delegation.status, action);
  if (!status) throw new Error('不支持的任务操作。');
  if (!localDelegationTransitionAllowed(delegation.status, action)) throw new Error(`当前状态 ${delegation.status} 不能执行 ${action}。`);
  const rawContent = String(content || '').trim().slice(0, 16000);
  const cleanContent = ['submit', 'publish', 'update_requirements'].includes(action) ? publicDelegationSubmissionText(rawContent) : rawContent;
  if (['submit', 'request_revision', 'publish', 'update_requirements'].includes(action) && !cleanContent) throw new Error('请填写需要同步的任务内容。');
  const incomingActionMetadata = publicLocalTaskActionMetadata(metadata && typeof metadata === 'object' ? metadata : {}, action);
  const mergedActionMetadata = publicAgentDelegationMetadata({
    ...(delegation.metadata || {}),
    ...incomingActionMetadata,
    ...(action === 'submit' ? { latestResult: cleanContent, resultSubmittedAt: new Date().toISOString() } : {}),
  });
  const nextMetadata = action === 'submit' ? publicLocalTaskActionMetadata(mergedActionMetadata, action) : mergedActionMetadata;
  let updated;
  const ownsTransaction=!auth.db.isTransaction;
  if(ownsTransaction)auth.db.exec('BEGIN IMMEDIATE');
  try {
    updated = auth.updateAgentDelegation({ delegationId, status, metadata: nextMetadata, allowGroupOwner: groupOwnerCanWithdraw });
    if (['publish', 'update_requirements'].includes(action)) {
      auth.db.prepare('UPDATE agent_delegations SET instruction = ?, updated_at = ? WHERE id = ?').run(cleanContent, new Date().toISOString(), delegationId);
    }
    const revisionNo = Number(auth.db.prepare('SELECT COALESCE(MAX(revision_no), 0) AS revision_no FROM agent_delegation_revisions WHERE delegation_id = ?').get(delegationId)?.revision_no || 0) + 1;
    const revisionId=newId('task_revision');
    auth.db.prepare(`INSERT INTO agent_delegation_revisions (id, delegation_id, author_user_id, revision_no, action, content, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(revisionId,delegationId,user.id,revisionNo,action,cleanContent,JSON.stringify(metadata || {}));
    recordDelegationEvidenceOutbox(auth,{userId:user.id,delegationId,revisionId,action,status,revisionNo,content:cleanContent,groupId:updated.groupId || ''});
    if (updated.groupId) {
      const labels = { submit: '提交了任务结果', accept_result: '接受了任务结果', request_revision: '提出了修改要求', publish: '确认并发布了任务要求', update_requirements: '更新了任务要求', withdraw: '撤回了任务', decline: '拒绝了任务', blocked: '将任务标记为受阻', working: '开始处理任务' };
      auth.sendCollaborationMessage({
        groupId: updated.groupId,
        content: cleanContent || labels[action],
        senderAgentId: ['submit', 'publish', 'update_requirements', 'withdraw'].includes(action) ? 'secretary_agent' : '',
        kind: 'agent',
        sourceEventId: `delegation-milestone:${delegationId}:${revisionNo}:${action}`,
        metadata: { type: 'task_action', action, delegationId, status, revisionNo, attachments: nextMetadata.attachments || [] },
      });
    } else if (['publish', 'update_requirements', 'withdraw'].includes(action)) {
      auth.socialSendMessage({
        recipientId: delegation.recipientUserId,
        senderAgentId: 'secretary_agent',
        recipientAgentId: 'secretary_agent',
        kind: 'agent',
        title: action === 'publish'
          ? `uBuddy 已发布委托：${delegation.title}`
          : action === 'withdraw'
            ? `uBuddy 已撤回委托：${delegation.title}`
            : `uBuddy 已更新委托要求：${delegation.title}`,
        content: cleanContent || '发起人已撤回这项任务。',
        metadata: { type: 'agent_delegation', action, delegationId, status, revisionNo },
      });
    }
    if(ownsTransaction)auth.db.exec('COMMIT');
  } catch(error) {
    if(ownsTransaction)auth.db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, delegation: auth.agentDelegationById(delegationId, { allowGroupOwner: groupOwnerCanWithdraw }), overview: auth.collaborationOverview() };
}

function recordDelegationEvidenceOutbox(store,{userId,delegationId,revisionId,action,status,revisionNo,content,groupId}={}) {
  if(typeof store.recordEvolutionEvidenceOutbox!=='function')return null;
  const instance=store.findUserAgentInstance?.({userId,agentFamilyId:'secretary_agent'});
  if(!instance||instance.employmentState!=='active')return null;
  const snapshot={content:content || JSON.stringify({action,status,revisionNo}),action,status,revisionNo,delegationId,groupId,occurredAt:new Date().toISOString()};
  return store.recordEvolutionEvidenceOutbox({localUserId:userId,userAgentInstanceId:instance.id,agentFamilyId:instance.agentFamilyId,
    sourceKind:'delegation_event',sourceId:delegationId,sourceVersionId:revisionId,
    contentHash:crypto.createHash('sha256').update(snapshot.content).digest('hex'),delegationId,confidence:0.8,
    privacyLevel:'owner_private',createdAt:snapshot.occurredAt,snapshot},{withinTransaction:true});
}


function publicLocalTaskActionMetadata(metadata = {}, action = '') {
  const clean = publicAgentDelegationMetadata(metadata);
  if (['submit', 'publish', 'update_requirements'].includes(action)) {
    clean.attachments = (Array.isArray(clean.attachments) ? clean.attachments : []).slice(0, 20).map(publicDelegationAttachment);
    if (action === 'submit') clean.resultAttachments = (Array.isArray(clean.resultAttachments) ? clean.resultAttachments : clean.attachments).slice(0, 20).map(publicDelegationAttachment);
    else delete clean.resultAttachments;
  } else {
    delete clean.attachments;
    delete clean.resultAttachments;
  }
  return clean;
}

function collaborationTaskStatusReply(status = '') {
  return ({
    assigned: '已进入任务箱，uBuddy 正在整理要求',
    preparing: '正在生成初步结果',
    awaiting_approval: '正在等待用户批准后执行',
    accepted: '已整理完成，等待用户处理',
    running: '正在处理',
    working: '正在由用户和 uBuddy 共同调整',
    draft_ready: '初稿已经就绪，等待用户确认',
    submitted: '已经提交，等待发起人验收',
    revision_requested: '已收到修改要求并继续处理',
    result_accepted: '结果已被接受，等待群聊最终关闭',
    blocked: '目前受阻，需要补充信息',
    declined: '已被用户拒绝',
    withdrawn: '已被发起人撤回',
    closed: '已经关闭',
  })[String(status || '')] || '正在同步';
}

function collaborationInstructionForFriend(source = '', friend = {}, fallback = '') {
  const names = [friend.remark, friend.displayName, friend.display_name, friend.username, friend.email]
    .map((item) => String(item || '').trim()).filter(Boolean);
  const segments = String(source || '').split(/[。；;\n]+/).map((item) => item.trim()).filter(Boolean);
  const matched = segments.filter((segment) => names.some((name) => segment.toLowerCase().includes(name.toLowerCase())));
  return matched.length ? matched.join('；') : String(fallback || source || '').trim();
}


export {
  isSecretaryIdentityQuestion,
  isSecretaryGreetingMessage,
  isSecretaryContextCollectionMessage,
  isSecretaryPublishConfirmation,
  secretaryExplicitDelegationContext,
  secretaryDelegationTargetsFromMentions,
  hasSecretaryAccountReference,
  ensureSecretaryConversationSeed,
  recordSecretaryDelegationFeedback,
  delegationRequiresHumanApproval,
  delegationExecutionFailureDetails,
  publicDelegationExecutionFailure,
  localCollaborationTaskAction,
  publicLocalTaskActionMetadata,
  collaborationTaskStatusReply,
  collaborationInstructionForFriend,
};
