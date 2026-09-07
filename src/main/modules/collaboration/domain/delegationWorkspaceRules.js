import { sha256Text } from '../../../utils.js';

function displayAuthUserName(user = {}) {
  return user.displayName || user.display_name || user.username || user.email || user.id || '\u597d\u53cb';
}

const GROUP_DELEGATION_DECISION_PROMPT = '你可以继续告诉我需要修改的地方，或回复“提交到任务群”。';
const DIRECT_DELEGATION_DECISION_PROMPT = '你可以继续告诉我需要修改的地方，或回复“确认提交”。';

function appendDelegationDecisionPrompt(content = '', delegation = {}) {
  const clean = String(content || '').trim();
  const prompt = delegation.groupId || delegation.group_id || delegation.metadata?.groupId
    ? GROUP_DELEGATION_DECISION_PROMPT
    : DIRECT_DELEGATION_DECISION_PROMPT;
  if (!clean) return prompt;
  if (clean.includes('确认提交') || clean.includes('提交到任务群')) return clean;
  return `${clean}\n\n${prompt}`;
}

function hasExplicitDelegationFileRequest(content = '') {
  const text = String(content || '').trim();
  if (!text) return false;
  const fileKind = '(?:文件|文档|表格|清单|报告|说明书|需求说明|word|docx|pdf|ppt|pptx|excel|xlsx|csv|markdown|md|流程图|drawio|图片|海报)';
  const createVerb = '(?:生成|创建|制作|输出|导出|整理成|转换成|写成|保存为|做一份|做成)';
  return new RegExp(`${createVerb}.{0,24}${fileKind}|${fileKind}.{0,24}${createVerb}`, 'i').test(text);
}

function isDelegationInformationOnlyRequest(content = '') {
  const text = String(content || '').trim();
  if (!text) return false;
  return /(?:告诉|说明|解释|总结|概括|查看|列出|梳理|确认).{0,20}(?:当前|现在|最新|更新后|现有)?(?:任务|要求|需求|状态|进度)|(?:当前|现在|最新|更新后|现有)(?:任务|要求|需求|状态|进度).{0,20}(?:是什么|有哪些|如何|吗|呢)|(?:任务|要求|需求|状态|进度).{0,12}(?:是什么|有哪些|如何|吗|呢)$/i.test(text);
}


function deterministicDelegationWorkspaceIntent(content = '', messages = []) {
  const text = String(content || '').trim();
  const publishingNegated = /(?:不要|先别|暂不|不用|无需|不得|禁止|尚未|未确认|没有确认|别).{0,16}(?:提交|发布|发送|同步|转发|发).{0,12}(?:任务群|群里|群聊|群中)?|(?:提交|发布|发送|同步|转发|发).{0,12}(?:前|之前).{0,12}(?:不得|不要|先别|暂不|禁止|未确认)/i.test(text);
  // Keep the fast path only for an unambiguous publish command. Merely having
  // both words in one sentence is not enough: “按任务群要求生成可提交版本”
  // is an execution request and must be understood from context by uBuddy.
  const explicitGroupShare = /(?:提交|发布).{0,8}(?:到|至|给)?\s*(?:任务群|群聊|群里|群中|群内)|(?:发送|同步|转发|发).{0,12}(?:到|至|给|进)\s*(?:任务群|群聊|群里|群中|群内)/i.test(text);
  const keepCurrentAndSubmit = /(?:不要|无需|不用|别).{0,12}(?:修改|调整|重做|重新生成).{0,16}(?:直接|现在|就)?(?:提交|发布|发送|同步)/i.test(text);
  if (keepCurrentAndSubmit || (!publishingNegated && (explicitGroupShare || /(?:确认提交|直接提交|提交吧|可以提交(?:了|吧)?|可以发布(?:了|吧)?)/i.test(text)))) return 'submit';
  const explicitExecution = /^(?:修改方向|修改要求|正式更新|第[\d一二三四五六七八九十]+条正式更新|需求更新|要求更新|继续完成|继续处理|重新生成|重新制作|重做|请修改|请调整|请补充|请完善|请生成|请制作|请创建|请输出|请导出)[：:\s]|(?:修改|调整|补充|完善|重做|重新生成|继续完成|生成|制作|创建|输出|导出).{0,32}(?:初稿|结果|交付物|文件|文档|报告|页|版|流程图|PPT|PPTX|Excel|Markdown)/i.test(text)
    || /(?:先|暂时).{0,16}(?:私有|私人).{0,24}(?:(?:整理|改写|梳理).{0,20}(?:要求|需求|任务)|(?:要求|需求|任务).{0,16}(?:整理|改写|梳理))/i.test(text);
  if (explicitExecution) return 'execute';
  const explicitInformationRequest = /(?:告诉|说明|解释|总结|概括|查看|列出|梳理|确认).{0,20}(?:当前|现在|最新|更新后|现有)?(?:任务|要求|需求|状态|进度)|(?:当前|现在|最新|更新后|现有)(?:任务|要求|需求|状态|进度).{0,20}(?:是什么|有哪些|如何|吗|呢)|(?:任务|要求|需求|状态|进度).{0,12}(?:是什么|有哪些|如何|吗|呢)$/i.test(text);
  if (explicitInformationRequest) return 'message';
  const shortConfirmation = /^(?:好|好的|可以|行|确认|就这样|没问题|同意|发吧|提交)$/i.test(text.replace(/[，。！？!?.\s]+/g, ''));
  if (!shortConfirmation) return '';
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  return lastAssistant?.metadata?.awaitingOwnerDecision || /确认提交|提交到任务群/.test(String(lastAssistant?.content || '')) ? 'submit' : 'clarify';
}

function parseDelegationWorkspaceIntentAnswer(answer = '') {
  const source = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const match = source.match(/\{[\s\S]*\}/);
  if (!match) return '';
  try {
    const parsed = JSON.parse(match[0]);
    const intent = String(parsed.intent || '').trim().toLowerCase();
    return ['submit', 'execute', 'organize', 'message', 'clarify'].includes(intent) ? intent : '';
  } catch {
    return '';
  }
}

function sanitizeDelegationIntentContext(value = '') {
  return String(value || '')
    .replace(/\n*#{1,6}\s*执行记录\s*\n[\s\S]*?(?=\n#{1,6}\s|$)/gi, '')
    .replace(/\/(?:home|Users|tmp|opt|private\/var|var\/folders)\/[^\s<>"'`，。；;）)]+/g, '[本地路径已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

function latestDelegationPublishCandidate(messages = [], { action = '', delegation = {} } = {}) {
  const ordered = [...messages].sort((left, right) => String(left.createdAt || left.created_at || '').localeCompare(String(right.createdAt || right.created_at || '')));
  const publishedMessageIds = new Set([
    delegation.metadata?.sourceWorkspaceMessageId,
    delegation.metadata?.publishedWorkspaceMessageId,
    delegation.metadata?.submittedWorkspaceMessageId,
    ...ordered.filter((message) => message.metadata?.publishedToGroup).map((message) => message.metadata?.sourceWorkspaceMessageId),
  ].map((value) => String(value || '').trim()).filter(Boolean));
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];
    const metadata = message.metadata || {};
    if (message.role !== 'assistant' || metadata.withdrawn || metadata.workspaceIntent === 'clarification') continue;
    if (metadata.type === 'ubuddy_ingress_response' || metadata.publishCandidate !== true) continue;
    if (metadata.publishAction && action && metadata.publishAction !== action) continue;
    if (metadata.publishedToGroup || publishedMessageIds.has(String(message.id || ''))) continue;
    if (['failed', 'informational', 'incomplete'].includes(String(metadata.resultState || ''))) continue;
    if (metadata.executionFailed || metadata.deterministicRecovery || metadata.workspaceRevisionRecovered || metadata.executionDegraded) continue;
    if (/(?:任务尚未完成|未在限定时间内完成|安全草稿|合并草稿|Process timed out|###\s*执行记录)/i.test(String(message.content || ''))) continue;
    const tail = ordered.slice(index + 1);
    const superseded = tail.some((item) => (
      (item.role === 'user' && item.metadata?.supersedesResultCandidate && !item.metadata?.withdrawn)
      || (item.role === 'system' && ['requirements_update', 'revision_requested', 'group_message_ingress'].includes(String(item.metadata?.type || '')))
    ));
    if (superseded) continue;
    const attachments = uniqueDelegationAttachments([
      ...(Array.isArray(metadata.attachments) ? metadata.attachments : []),
      ...tail
        .filter((item) => item.role === 'system' && item.metadata?.generatedTaskFiles && String(item.metadata?.candidateMessageId || '') === String(message.id || ''))
        .flatMap((item) => Array.isArray(item.metadata?.attachments) ? item.metadata.attachments : []),
      ...(action === 'submit' && Array.isArray(delegation.metadata?.generatedTaskFiles)
        ? delegation.metadata.generatedTaskFiles
        : []),
    ]).slice(0, 20);
    return {
      messageId: message.id || '',
      revisionId: metadata.revisionId || metadata.revision_id || metadata.revisionNo || metadata.revision_no || message.id || '',
      content: String(message.content || '')
        .replace(`\n\n${GROUP_DELEGATION_DECISION_PROMPT}`, '')
        .replace(`\n\n${DIRECT_DELEGATION_DECISION_PROMPT}`, '')
        .trim(),
      attachments,
    };
  }
  return null;
}

function buildPrivateDelegationWorkspaceRouteMessage(delegation = {}, userMessage = '', { isRequester = false, explicitFileRequest = false } = {}) {
  const sharedGroupWorkspace = Boolean(delegation.groupId || delegation.group_id || delegation.metadata?.groupId);
  return [
    'uBuddy 已经判断这是一项需要执行的内容任务，而不是提交、发布或同步控制指令。',
    '你是被 uBuddy 协调的专业执行 Agent。请完成本轮要求并返回一份明确、完整、可作为新版本候选的结果；不要替用户发布到任务群。',
    sharedGroupWorkspace ? '本任务的文件目录是任务群共享工作区：文件会被活跃群成员看到；个人 uBuddy 对话和 Task Memory 仍然私有。不要把私聊、凭据或个人 Memory 写入文件。' : '',
    delegation.title || '',
    delegation.instruction || '',
    delegation.metadata?.intakeSummary || '',
    String(userMessage || ''),
    isRequester
      ? explicitFileRequest
        ? `Act as the requester’s private secretary. The requester explicitly asked for a file, so create only the requested ${sharedGroupWorkspace ? 'group-workspace support file' : 'private support file'}. Do not claim it is the recipient’s completed task result. Do not publish or submit anything externally.`
        : 'Act as the requester’s private secretary. Organize requirement changes without creating files unless the requester explicitly asks for one. Do not publish or submit anything externally.'
      : sharedGroupWorkspace
        ? 'Continue the recipient task using the task-group shared file workspace. Complete the requested result and generate or revise the required files there. Do not publish or submit anything externally.'
        : 'Continue the recipient task inside the private task workspace. Complete the requested result and generate or revise the required files. Do not publish or submit anything externally.',
  ].filter(Boolean).join('\n');
}

function buildPrivateIngressProcessingRequest(delegation = {}, ingress = {}) {
  const type = String(ingress.metadata?.type || 'group_message_ingress');
  const intent = type === 'task_assigned'
    ? '这是刚发布给用户的正式委托。请先整理目标、交付物、已知材料、待确认信息和可立即开始的初步方案；如果要求包含 PPT、申报书、流程图等产物，请明确初稿计划。'
    : type === 'result_submitted'
      ? '这是对方刚在任务群公开提交的结果。请为用户整理本次提交、验收重点、缺失项和建议反馈。'
      : type === 'revision_requested'
        ? '这是任务群中的公开修改意见。请结合私有上下文整理需要调整的内容和下一步，但不要自动发布。'
        : type === 'result_accepted'
          ? '这是公开验收更新。请记录当前状态，并提醒用户群聊解散前任务私聊仍可继续。'
          : '这是来自任务群的公开要求更新。请结合当前私有任务上下文说明变化、影响和建议下一步；未经用户明确确认，不得发布任何私有修改。';
  return [
    intent,
    `任务：${delegation.title || ''}`,
    `当前公开要求：${delegation.instruction || ''}`,
    `本次公开更新：${ingress.content || ''}`,
    '只以当前用户自己的 uBuddy 身份回复，不要冒充对方或对方的 uBuddy。',
  ].filter(Boolean).join('\n\n');
}

function deterministicPrivateIngressReply(ingress = {}) {
  const type = String(ingress.metadata?.type || 'group_message_ingress');
  if (type === 'task_assigned') return `我已收到这项正式委托并整理进你的私有任务会话。群任务文件会写入共享工作区，活跃群成员都能看到。\n\n当前要求：${ingress.content || '请查看任务公开要求。'}\n\n我会先准备可编辑初稿并标出待补充资料；任何对外发布或正式承诺仍只会在你明确确认后执行。`;
  if (type === 'result_submitted') return '对方已提交新的公开结果。我已纳入当前任务上下文；你可以让我整理变化、检查缺失项或拟定验收反馈。群聊解散前，这个私有任务会话会继续保留。';
  if (type === 'revision_requested') return '我已收到新的公开修改意见，并已纳入当前私有任务上下文。你可以继续告诉我如何调整；修改完成后我会询问是否提交到任务群。';
  if (type === 'result_accepted') return '对方已确认当前结果。我已记录这次公开状态更新；在任务群正式解散前，我们仍可在这里继续修改和处理后续要求。';
  return `我已收到来自任务群的公开更新：${ingress.content || ''}\n\n我会据此继续整理当前任务；未经你明确确认，我不会把私有修改发布到群聊。`;
}


function uniqueDelegationAttachments(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item?.id || item?.source_path || item?.sourcePath || item?.path || `${item?.name || item?.filename || ''}:${item?.size || 0}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicDelegationAttachment(item = {}) {
  const publicUrl = (value) => /^https?:\/\//i.test(String(value || '')) ? String(value) : '';
  return {
    id: item.id || '',
    remote_file_id: item.remote_file_id || item.remoteFileId || '',
    name: item.name || item.filename || 'file',
    filename: item.filename || item.name || 'file',
    type: item.type || item.content_type || '',
    content_type: item.content_type || item.type || '',
    size: Number(item.size || 0),
    sha256: item.sha256 || '',
    remote_file_kind: item.remote_file_kind || item.remoteFileKind || '',
    group_id: item.group_id || item.groupId || '',
    delegation_id: item.delegation_id || item.delegationId || '',
    relative_path: item.relative_path || item.relativePath || item.workspace_relative_path || item.workspaceRelativePath || '',
    file_url: publicUrl(item.file_url || item.fileUrl),
    download_url: publicUrl(item.download_url),
  };
}


function buildAgentDelegationPrompt(delegation = {}, currentUser = {}, comments = []) {
  const requesterName = displayAuthUserName(delegation.requester);
  const recipientName = displayAuthUserName(delegation.recipient || currentUser);
  const discussion = comments.length
    ? [
      '',
      '\u59d4\u6258\u8865\u5145\u8bf4\u660e\uff08\u6309\u65f6\u95f4\u987a\u5e8f\uff09\uff1a',
      ...comments.map((message) => {
        const sender = (message.senderUserId || message.sender_user_id) === delegation.requesterUserId ? requesterName : recipientName;
        return `- ${sender}\uff1a${message.content || ''}`;
      }),
    ]
    : [];
  return [
    '\u3010\u597d\u53cb\u79d8\u4e66 Agent \u59d4\u6258\u4efb\u52a1\u3011',
    `\u53d1\u8d77\u4eba\uff1a${requesterName}`,
    `\u63a5\u6536\u4eba\uff1a${recipientName}`,
    `\u59d4\u6258\u6807\u9898\uff1a${delegation.title || '\u79d8\u4e66\u59d4\u6258\u4efb\u52a1'}`,
    '',
    '\u4efb\u52a1\u5185\u5bb9\uff1a',
    delegation.instruction || '',
    ...discussion,
    '',
    '\u8bf7\u4f5c\u4e3a\u63a5\u6536\u65b9 uBuddy \u534f\u8c03\u7684\u6267\u884c Agent\uff0c\u5728\u79c1\u6709\u4efb\u52a1\u5de5\u4f5c\u533a\u5185\u5b8c\u6210\u4efb\u52a1\u8981\u6c42\u4e2d\u6240\u6709\u5f53\u524d\u53ef\u6267\u884c\u7684\u5185\u5bb9\uff0c\u5e76\u4ea7\u51fa\u9996\u4e2a\u5b8c\u6574\u7ed3\u679c\uff1a',
    '- \u5148\u786e\u8ba4\u76ee\u6807\u3001\u4ea4\u4ed8\u7269\u548c\u5df2\u77e5\u6750\u6599\uff0c\u518d\u8c03\u7528\u5408\u9002\u7684\u4e13\u4e1a Agent \u6216\u5206\u6790\u6d41\u7a0b\u3002',
    '- \u5982\u679c\u8981\u6c42 PPT\uff0c\u8bf7\u751f\u6210\u771f\u5b9e\u53ef\u7f16\u8f91\u7684 PPT \u521d\u7a3f\uff1b\u4fe1\u606f\u4e0d\u8db3\u65f6\u4f7f\u7528\u660e\u786e\u5360\u4f4d\u7b26\u5e76\u5217\u51fa\u5f85\u8865\u5145\u9879\u3002',
    '- \u5982\u679c\u8981\u6c42\u7533\u62a5\u4e66\u3001\u62a5\u544a\u3001\u65b9\u6848\u6216\u6d41\u7a0b\u56fe\uff0c\u8bf7\u5728\u4efb\u52a1\u5de5\u4f5c\u533a\u5185\u751f\u6210\u53ef\u7f16\u8f91\u7684 Markdown\u3001CSV \u6216\u5176\u4ed6\u5408\u9002\u521d\u7a3f\u6587\u4ef6\u3002',
    '- \u5982\u679c\u5b58\u5728\u4fe1\u606f\u7f3a\u53e3\uff0c\u4ecd\u5148\u5b8c\u6210\u53ef\u5b89\u5168\u751f\u6210\u7684\u6846\u67b6\u548c\u521d\u7a3f\uff0c\u518d\u660e\u786e\u5217\u51fa\u9700\u8981\u4e3b\u4eba\u8865\u5145\u6216\u786e\u8ba4\u7684\u5185\u5bb9\uff0c\u4e0d\u5f97\u7f16\u9020\u4e8b\u5b9e\u3002',
    '- \u4e0d\u8981\u8bfb\u53d6\u4efb\u52a1\u5de5\u4f5c\u533a\u548c\u7528\u6237\u660e\u786e\u4e0a\u4f20\u7684\u9644\u4ef6\u4e4b\u5916\u7684\u79c1\u4eba\u6587\u4ef6\u3002',
    '- \u4e0d\u8981\u5411\u5916\u90e8\u7f51\u7ad9\u3001\u90ae\u7bb1\u3001\u5e73\u53f0\u6216\u4efb\u52a1\u7fa4\u53d1\u5e03\u4efb\u4f55\u5185\u5bb9\uff1b\u5982\u4efb\u52a1\u8981\u6c42\u8fd9\u4e9b\u52a8\u4f5c\uff0c\u53ea\u51c6\u5907\u8349\u7a3f\u5e76\u6807\u8bb0\u9700\u4e3b\u4eba\u786e\u8ba4\u3002',
    '- \u521d\u7a3f\u3001\u63a8\u7406\u8fc7\u7a0b\u3001\u7f3a\u5931\u4fe1\u606f\u548c\u751f\u6210\u6587\u4ef6\u90fd\u5c5e\u4e8e\u63a5\u6536\u65b9\u79c1\u6709\u5185\u5bb9\uff0c\u53ea\u6709\u4e3b\u4eba\u70b9\u51fb\u201c\u63d0\u4ea4\u5230\u4efb\u52a1\u7fa4\u201d\u540e\u624d\u80fd\u5171\u4eab\u3002',
  ].join('\n');
}

function buildAgentDelegationRouteMessage(delegation = {}, comments = []) {
  const discussion = comments
    .map((message) => String(message.content || '').trim())
    .filter(Boolean);
  return [
    String(delegation.instruction || '').trim(),
    ...discussion,
  ].filter(Boolean).join('\n');
}

function buildDelegationIntakeSummary(delegation = {}, comments = []) {
  const instruction = String(delegation.instruction || '').trim();
  const hasDeadline = /(\u622a\u6b62|\u4e4b\u524d|\u4eca\u5929|\u660e\u5929|\u672c\u5468|\u4e0b\u5468|deadline|due\s+date|\d{1,2}[\/-]\d{1,2})/i.test(instruction);
  const hasDeliverable = /(\u4ea4\u4ed8|\u7ed3\u679c|\u6587\u6863|\u62a5\u544a|ppt|\u8868\u683c|\u4ee3\u7801|\u56fe\u7247|\u56de\u590d|\u6e05\u5355|deliverable)/i.test(instruction);
  const commentLines = comments
    .filter((message) => !message.metadata?.withdrawn)
    .map((message) => String(message.content || '').trim())
    .filter(Boolean);
  const statusLine = String(delegation.status || '') === 'running'
    ? '\u4efb\u52a1\u5df2\u8fdb\u5165\u5904\u7406\u9636\u6bb5\uff0cuBuddy \u4f1a\u7ee7\u7eed\u5408\u5e76\u540e\u7eed\u8865\u5145\u3002'
    : String(delegation.status || '') === 'accepted'
      ? '\u5f53\u524d\u7b49\u5f85\u4f60\u51b3\u5b9a\u662f\u5426\u63a5\u6536\u5e76\u5904\u7406\u3002'
      : 'uBuddy \u5df2\u5b8c\u6210\u9996\u6b21\u63a5\u6536\u548c\u6574\u7406\u3002';
  return [
    `uBuddy \u5df2\u63a5\u6536\u5e76\u6574\u7406\u8be5\u4efb\u52a1\uff1a${delegation.title || '\u672a\u547d\u540d\u4efb\u52a1'}`,
    instruction ? `\u539f\u59cb\u8981\u6c42\uff1a${instruction}` : '',
    ...commentLines.map((line, index) => `\u8865\u5145 ${index + 1}\uff1a${line}`),
    hasDeliverable ? '\u5df2\u8bc6\u522b\u4ea4\u4ed8\u8981\u6c42\u3002' : '\u5efa\u8bae\u5728\u5904\u7406\u524d\u786e\u8ba4\u5177\u4f53\u4ea4\u4ed8\u7269\u3002',
    hasDeadline ? '\u5df2\u8bc6\u522b\u65f6\u95f4\u8981\u6c42\u3002' : '\u4efb\u52a1\u672a\u660e\u786e\u622a\u6b62\u65f6\u95f4\uff0c\u53ef\u5411\u53d1\u8d77\u65b9\u8865\u5145\u786e\u8ba4\u3002',
    statusLine,
  ].filter(Boolean).join('\n');
}

function delegationIntakeRevisionKey(delegation = {}, messages = []) {
  return sha256Text(JSON.stringify({
    title: delegation.title || '',
    instruction: delegation.instruction || '',
    attachments: Array.isArray(delegation.metadata?.attachments) ? delegation.metadata.attachments : [],
    messages: messages.map((message) => ({
      id: message.id || '',
      content: message.content || '',
      updatedAt: message.updatedAt || message.updated_at || message.createdAt || '',
      withdrawn: Boolean(message.metadata?.withdrawn),
      attachments: Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [],
    })),
  }));
}

function buildUBuddyDelegationProcessingPrompt({ phase = 'reply', content = '', attachments = [], delegation = null, contextMessages = [], currentUser = {} } = {}) {
  const attachmentNames = attachments.map((item) => item?.name || item?.filename || '').filter(Boolean);
  const context = contextMessages
    .filter((message) => !message.metadata?.withdrawn)
    .map((message, index) => `${index + 1}. ${message.content || ''}`)
    .join('\n');
  const phaseInstruction = phase === 'create'
    ? '\u5c06\u7528\u6237\u7684\u539f\u59cb\u63cf\u8ff0\u5b8c\u5584\u4e3a\u53ef\u76f4\u63a5\u53d1\u7ed9\u5bf9\u65b9 uBuddy \u7684\u59d4\u6258\u8981\u6c42\u3002\u8865\u9f50\u76ee\u6807\u3001\u5df2\u77e5\u6750\u6599\u3001\u671f\u671b\u7ed3\u679c\u548c\u5f85\u786e\u8ba4\u9879\uff0c\u4f46\u4e0d\u5f97\u865a\u6784\u4e8b\u5b9e\u3002'
    : phase === 'intake'
      ? '\u4f5c\u4e3a\u63a5\u6536\u65b9 uBuddy\uff0c\u7ed3\u5408\u539f\u59cb\u8981\u6c42\u548c\u6240\u6709\u672a\u64a4\u56de\u7684\u8865\u5145\u5185\u5bb9\uff0c\u751f\u6210\u4e00\u4efd\u968f\u65f6\u66f4\u65b0\u7684\u4efb\u52a1\u6458\u8981\uff0c\u660e\u786e\u5f53\u524d\u9700\u6c42\u3001\u6587\u4ef6\u3001\u4ea4\u4ed8\u7269\u3001\u7ea6\u675f\u548c\u5f85\u786e\u8ba4\u9879\u3002'
      : '\u5c06\u7528\u6237\u5bf9\u59d4\u6258\u7684\u56de\u590d\u6216\u8865\u5145\u6574\u7406\u4e3a\u6e05\u6670\u3001\u53ef\u6267\u884c\u3001\u53ef\u76f4\u63a5\u63d0\u4ea4\u7684\u5185\u5bb9\u3002\u4fdd\u7559\u7528\u6237\u539f\u610f\uff0c\u4e0d\u5f97\u4ee3\u66ff\u7528\u6237\u865a\u6784\u5df2\u5b8c\u6210\u7684\u5de5\u4f5c\u3002';
  return [
    '\u3010UBUDDY_DELEGATION_PROCESSING_V1\u3011',
    '\u4f60\u662f\u7528\u6237\u7684 uBuddy\uff0c\u6b63\u5728\u5904\u7406\u8de8\u7528\u6237\u59d4\u6258\u3002',
    phaseInstruction,
    '\u4ec5\u8f93\u51fa JSON\uff0c\u683c\u5f0f\u4e3a {"title":"\u7b80\u6d01\u6807\u9898","content":"\u6574\u7406\u540e\u7684\u5b8c\u6574\u5185\u5bb9"}\u3002',
    '\u4e0d\u8981\u8f93\u51fa Markdown \u4ee3\u7801\u5757\u6216\u989d\u5916\u89e3\u91ca\u3002',
    '',
    `\u5f53\u524d\u7528\u6237\uff1a${displayAuthUserName(currentUser)}`,
    delegation ? `\u59d4\u6258\u6807\u9898\uff1a${delegation.title || ''}` : '',
    delegation ? `\u539f\u59cb\u59d4\u6258\uff1a${delegation.instruction || ''}` : '',
    `\u672c\u6b21\u7528\u6237\u8f93\u5165\uff1a${content || '\uff08\u65e0\u65b0\u6587\u672c\uff09'}`,
    attachmentNames.length ? `\u76f8\u5173\u6587\u4ef6\uff1a${attachmentNames.join('\u3001')}` : '',
    context ? `\u5386\u53f2\u8865\u5145\uff1a\n${context}` : '',
  ].filter(Boolean).join('\n');
}

function fallbackUBuddyDelegationProcessing({ phase = 'reply', content = '', attachments = [], delegation = null, contextMessages = [] } = {}) {
  const cleanContent = String(content || '').trim();
  const attachmentNames = attachments.map((item) => item?.name || item?.filename || '').filter(Boolean);
  let processed = '';
  if (phase === 'intake') {
    processed = buildDelegationIntakeSummary(delegation || {}, contextMessages);
    if (attachmentNames.length) processed += `\n\u76f8\u5173\u6587\u4ef6\uff1a${[...new Set(attachmentNames)].join('\u3001')}`;
  } else if (phase === 'create') {
    processed = [
      cleanContent ? `\u4efb\u52a1\u76ee\u6807\uff1a${cleanContent}` : '',
      attachmentNames.length ? `\u76f8\u5173\u6750\u6599\uff1a${[...new Set(attachmentNames)].join('\u3001')}` : '',
      '\u5904\u7406\u8981\u6c42\uff1a\u8bf7\u7ed3\u5408\u4e0a\u8ff0\u5185\u5bb9\u786e\u8ba4\u4ea4\u4ed8\u7269\u5e76\u5b8c\u6210\u5904\u7406\uff1b\u5982\u5173\u952e\u4fe1\u606f\u4e0d\u8db3\uff0c\u8bf7\u5148\u5217\u51fa\u9700\u8865\u5145\u7684\u5185\u5bb9\u3002',
    ].filter(Boolean).join('\n');
  } else {
    processed = [
      cleanContent ? `\u8865\u5145\u6216\u56de\u590d\uff1a${cleanContent}` : '',
      attachmentNames.length ? `\u76f8\u5173\u6587\u4ef6\uff1a${[...new Set(attachmentNames)].join('\u3001')}` : '',
    ].filter(Boolean).join('\n');
  }
  const titleSource = delegation?.title || cleanContent || '\u59d4\u6258\u8865\u5145';
  return {
    title: String(titleSource).replace(/\s+/g, ' ').slice(0, 48),
    content: processed || cleanContent,
    mode: 'fallback',
    processedByOwnUBuddy: phase !== 'intake',
    organizedByRecipientUBuddy: phase === 'intake',
  };
}

function parseUBuddyDelegationProcessingAnswer(answer = '', fallback = {}) {
  const raw = String(answer || '').trim();
  const candidate = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(candidate);
    const content = String(parsed?.content || '').trim();
    if (!content) return fallback;
    return {
      title: String(parsed?.title || fallback.title || content).replace(/\s+/g, ' ').slice(0, 80),
      content: content.slice(0, 8000),
    };
  } catch {
    return raw ? { title: fallback.title || raw.slice(0, 48), content: raw.slice(0, 8000) } : fallback;
  }
}

function previewUBuddyDelegationProcessingAnswer(answer = '') {
  const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '');
  const title = partialJsonStringField(raw, 'title');
  const content = partialJsonStringField(raw, 'content');
  if (!title.value && !content.value) return null;
  return { title: title.value, content: content.value, complete: title.complete && content.complete };
}

function partialJsonStringField(source = '', field = '') {
  const match = new RegExp(`"${field}"\\s*:\\s*"`, 'i').exec(source);
  if (!match) return { value: '', complete: false };
  let value = '';
  let escaped = false;
  let unicode = '';
  for (let index = match.index + match[0].length; index < source.length; index += 1) {
    const char = source[index];
    if (unicode) {
      unicode += char;
      if (unicode.length === 5) {
        const code = Number.parseInt(unicode.slice(1), 16);
        value += Number.isFinite(code) ? String.fromCharCode(code) : unicode;
        unicode = '';
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      if (char === 'u') unicode = 'u';
      else value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[char] ?? char;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') return { value, complete: true };
    value += char;
  }
  if (unicode) value += unicode;
  if (escaped) value += '\\';
  return { value, complete: false };
}


export {
  appendDelegationDecisionPrompt,
  buildAgentDelegationPrompt,
  buildAgentDelegationRouteMessage,
  buildDelegationIntakeSummary,
  buildPrivateDelegationWorkspaceRouteMessage,
  buildPrivateIngressProcessingRequest,
  buildUBuddyDelegationProcessingPrompt,
  delegationIntakeRevisionKey,
  deterministicDelegationWorkspaceIntent,
  deterministicPrivateIngressReply,
  displayAuthUserName,
  fallbackUBuddyDelegationProcessing,
  hasExplicitDelegationFileRequest,
  isDelegationInformationOnlyRequest,
  latestDelegationPublishCandidate,
  parseDelegationWorkspaceIntentAnswer,
  parseUBuddyDelegationProcessingAnswer,
  previewUBuddyDelegationProcessingAnswer,
  publicDelegationAttachment,
  sanitizeDelegationIntentContext,
  uniqueDelegationAttachments,
};
