function emitChatEvent(onEvent, event = {}) {
  if (!onEvent) return;
  const kind = event.kind || event.type || 'progress';
  onEvent({ ...event, kind, type: event.type || kind });
}

function messageIdentity(session = {}, identity = {}) {
  return {
    agentId: String(identity.agentId ?? session.agentId ?? ''),
    agentInstanceId: String(identity.agentInstanceId ?? session.agentInstanceId ?? ''),
    departmentId: String(identity.departmentId ?? session.departmentId ?? ''),
  };
}

function displaySkill(skill = {}, language = 'zh-CN') {
  const metadata = skill.metadata || {};
  const localized = language === 'en'
    ? metadata.displayNameEn || metadata.display_name_en || metadata.displayName?.en
    : metadata.displayNameZhCn || metadata.displayNameZh || metadata.display_name_zh_cn || metadata.displayName?.zhCN;
  return String(localized || skill.name || skill.skillKey || skill.id || '').trim();
}

function describeSkill(skill = {}, language = 'zh-CN') {
  const metadata = skill.metadata || {};
  const localized = language === 'en'
    ? metadata.descriptionEn || metadata.description_en || metadata.description?.en
    : metadata.descriptionZhCn || metadata.descriptionZh || metadata.description_zh_cn || metadata.description?.zhCN;
  return String(localized || skill.description || '').trim();
}

export async function executeAttachedSkillControlTurn({
  store,
  attachedSkillService,
  session,
  user,
  message,
  intent,
  activeRunId,
  requestApproval,
  onEvent,
  identity = {},
  interactionMode = '',
  inquiryMode = false,
  language = 'zh-CN',
  attachments = [],
  mentions = [],
  fileReferences = [],
  memoryReferences = [],
  normalizedQuote = null,
  secretaryControl = false,
  onCatalogChanged = () => {},
  onCompleted = () => {},
} = {}) {
  const persistedIdentity = messageIdentity(session, identity);
  const requestMessage = store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: message,
    ...persistedIdentity,
    metadata: {
      ...(secretaryControl ? { secretaryControl: true } : {}),
      attachedSkillControl: { version: 1, source: 'janus_host', action: 'install', sourceUri: intent.source, status: 'received' },
      ...(attachments.length ? { attachments } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(fileReferences.length ? { fileReferences } : {}),
      ...(memoryReferences.length ? { memoryReferences } : {}),
      ...(normalizedQuote ? { quote: normalizedQuote } : {}),
    },
  });
  emitChatEvent(onEvent, { kind: 'message-persisted', phase: 'request', runId: activeRunId, sessionId: session.id, displaySessionId: session.id, messageId: requestMessage.id, role: 'user' });
  emitChatEvent(onEvent, { kind: 'progress', stage: 'attached_skill_control', planStep: 'attached_skill_control', message: '正在核对 Janus Skill 目录与导入来源' });

  let status = 'failed';
  let imported = null;
  let errorCode = '';
  let answer = '';
  try {
    if (interactionMode === 'plan' || inquiryMode) {
      status = 'read_only';
      errorCode = interactionMode === 'plan' ? 'plan_mode_read_only' : 'ubuddy_inquiry_mode_read_only';
      answer = interactionMode === 'plan'
        ? '当前为 Plan 模式，未执行 Skill 安装。切换到执行模式后重新发送明确的安装请求。'
        : '当前为询问模式，未执行 Skill 安装。切换到任务模式后重新发送明确的安装请求。';
    } else {
      const approvalId = `attached-skill:${requestMessage.id}:install:${intent.source}`;
      store.updateMessage(requestMessage.id, { metadata: { ...(requestMessage.metadata || {}), attachedSkillControl: { version: 1, source: 'janus_host', action: 'install', sourceUri: intent.source, status: 'awaiting_confirmation' } } });
      const approved = await requestApproval({
        approvalId, itemId: approvalId, type: 'attached-skill-install',
        reason: `确认导入 Skill 来源 ${intent.source}？导入后仍需单独分配给部门、Agent 类型或员工。`,
      });
      if (!approved) {
        status = 'cancelled';
        answer = `已取消导入 Skill：${intent.source}，Skill 目录未修改。`;
      } else {
        imported = await attachedSkillService.importPackage({ source: intent.source, sourceRevision: intent.sourceRevision || intent.revision || '' });
        status = 'installed';
        onCatalogChanged({ user, catalog: imported.catalog, reason: 'chat_install', packageId: imported.package?.id || '', source: intent.source });
        const skills = (imported.package?.skills || []).filter((skill) => skill.status === 'ready');
        const detail = skills.map((skill) => `${displaySkill(skill, language)}${describeSkill(skill, language) ? `：${describeSkill(skill, language)}` : ''}`).join(language === 'en' ? '; ' : '；');
        answer = language === 'en'
          ? `Skill package installed: ${imported.package?.id || intent.source}. Skills: ${detail || 'none'}. Status: installed but not assigned. Assign it in Skills & Plugins, or issue an explicit assignment command.`
          : `Skill 包已安装：${imported.package?.id || intent.source}。包含：${detail || '无可用 Skill'}。状态：已安装，但尚未分配。请在“技能与插件”界面分配，或单独发送明确的分配请求。`;
      }
    }
  } catch (error) {
    errorCode = error?.code || 'attached_skill_install_failed';
    answer = `${language === 'en' ? 'Skill installation failed' : 'Skill 安装失败'}：${error?.message || String(error)}`;
  }
  const finalControl = { version: 1, source: 'janus_host', action: 'install', sourceUri: intent.source, status, packageId: imported?.package?.id || '', catalogVerified: Boolean(imported?.catalog), ...(errorCode ? { errorCode } : {}) };
  store.updateMessage(requestMessage.id, { metadata: { ...(store.getMessage(requestMessage.id)?.metadata || requestMessage.metadata || {}), attachedSkillControl: finalControl } });
  const saved = store.addMessage({ sessionId: session.id, role: 'assistant', content: answer, ...persistedIdentity, metadata: { ...(secretaryControl ? { secretaryControl: true } : {}), sourceMessageId: requestMessage.id, attachedSkillControl: finalControl } });
  if (session.codexThreadId) store.updateSessionThread(session.id, '');
  onCompleted({ status, package: imported?.package || null, catalog: imported?.catalog || null });
  return { session: store.getSession(session.id), workerSession: null, message: saved, answer, uBuddyMode: 'attached_skill_control', attachedSkillControl: finalControl, attachedSkillCatalog: imported?.catalog || null, artifacts: [] };
}
