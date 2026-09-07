import {
  deterministicDelegationWorkspaceIntent,
  displayAuthUserName,
  latestDelegationPublishCandidate,
  parseDelegationWorkspaceIntentAnswer,
  sanitizeDelegationIntentContext,
} from '../domain/delegationWorkspaceRules.js';

export function createDelegationWorkspaceIntentClassifier({ executeModel, createId, hashText }) {
  if (typeof executeModel !== 'function' || typeof createId !== 'function' || typeof hashText !== 'function') {
    throw new TypeError('Delegation intent classifier requires model, id, and hashing ports.');
  }
  return async function classifyDelegationWorkspaceIntent({
    content = '',
    messages = [],
    delegation = {},
    currentUser = {},
    runtimeRoot = '',
    store = null,
    org = null,
    model = '',
    reasoningEffort = '',
    signal = null,
    timeoutMs = Number(process.env.JANUS_UBUDDY_WORKSPACE_INTENT_TIMEOUT_MS || 30_000),
    action = 'submit',
  } = {}) {
    const text = String(content || '').trim();
    if (!text) return 'message';
    const deterministic = deterministicDelegationWorkspaceIntent(text, messages);
    if (deterministic) return deterministic;
    const candidate = latestDelegationPublishCandidate(messages, { action, delegation });
    const context = [...messages].slice(-16).map((message, index) => {
      const metadata = message.metadata || {};
      const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? 'uBuddy' : '系统';
      const state = metadata.resultState ? `；结果状态=${metadata.resultState}` : '';
      const published = metadata.publishedToGroup ? '；已发布' : '';
      return `${index + 1}. ${role}${state}${published}：${sanitizeDelegationIntentContext(message.content)}`;
    }).join('\n');
    const prompt = [
      '【UBUDDY_WORKSPACE_INTENT_V1】',
      '你是当前用户的私人秘书 uBuddy。这里只判断用户这句话希望系统采取什么操作，不执行任务本身。',
      '请结合完整上下文理解省略、指代和口语表达，不要只匹配固定关键词。',
      '',
      '可选 intent：',
      '- submit：用户要把已经完成的某一版结果发送、同步或提交到任务群；这是发布控制指令，不是让 Agent 重新生成内容。',
      '- execute：用户要继续完成、修改、重做、补充或重新生成任务结果。',
      '- organize：发布方用户要让秘书整理、改写或补充任务要求，但没有要求生成专业交付物。',
      '- message：用户在询问、说明、补充背景，当前不应执行或发布。',
      '- clarify：无法可靠判断是继续处理还是发布，需要向用户问一个简短问题。',
      '',
      '重要规则：',
      '1. “把正确的/最新的/刚才完成的结果发到群里”属于 submit，应引用已有完成版本，绝不能重新执行任务。',
      '2. “继续完成/按这个修改/重新生成”属于 execute。',
      '3. 失败、超时、占位、说明性回复和发布确认都不是可提交结果。',
      '4. 如果用户要求发布但当前没有有效完成版本，仍返回 submit，由系统负责提示没有可提交版本。',
      '5. 发布方的普通需求调整优先选择 organize；接收方对产物的修改要求选择 execute。',
      '6. 仅输出 JSON：{"intent":"submit|execute|organize|message|clarify","reason":"一句话理由"}。',
      '',
      `当前任务：${delegation.title || ''}`,
      `当前角色：${currentUser.id === delegation.requesterUserId ? '任务发布方' : '任务接收方'}`,
      `当前是否存在有效可提交版本：${candidate ? '是' : '否'}`,
      `当前用户：${displayAuthUserName(currentUser)}`,
      context ? `最近私人工作区上下文：\n${context}` : '',
      `用户本次输入：${text}`,
    ].filter(Boolean).join('\n');
    try {
      const agent = org?.agent?.('secretary_agent');
      const relationshipId = `user:${delegation.requesterUserId === currentUser.id ? delegation.recipientUserId : delegation.requesterUserId}`;
      const userAgentContext = store?.resolveUserAgent?.({ userId: currentUser.id || '', agentFamilyId: 'secretary_agent', relationshipId });
      const effectiveMemory = userAgentContext?.memoryContent || '';
      const answer = await executeModel({
        prompt,
        agentId: 'secretary_agent',
        role: 'ubuddy_workspace_intent',
        root: runtimeRoot,
        cwd: runtimeRoot,
        sandbox: 'read-only',
        timeoutMs,
        signal,
        model,
        reasoningEffort,
        executionContext: {
          id: createId('model_exec'),
          store,
          userId: currentUser.id || '',
          conversationId: delegation.sessionId || '',
          departmentId: 'secretary_department',
          agentId: 'secretary_agent',
          agentInstanceId: userAgentContext?.instance?.id || '',
          agentVersionId: userAgentContext?.baseVersion?.id || '',
          personalSkillVersionId: userAgentContext?.personalSkillVersion?.id || '',
          agentRole: 'agent',
          executionKind: 'ubuddy_workspace_intent',
          skillHash: userAgentContext?.effectiveSkillHash || (agent ? hashText(org.readSkill(agent)) : ''),
          memoryHash: hashText(effectiveMemory),
          memoryManifestHash: userAgentContext?.memoryManifestHash || '',
          metadata: { delegationId: delegation.id || '', readOnlyIntentClassifier: true },
        },
      });
      const parsed = parseDelegationWorkspaceIntentAnswer(answer);
      if (parsed) return parsed;
    } catch (error) {
      if (signal?.aborted) throw error;
      // Fall through to the conservative non-publishing behavior below.
    }
    return currentUser.id === delegation.requesterUserId ? 'organize' : 'execute';
  }

}
