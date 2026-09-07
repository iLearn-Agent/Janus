const ACTIVE_TASK_STATUSES = new Set(['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'cancelling']);
const SECRETARY_WORK_VERBS = '生成|制作|创建|新建|编写|写入|写|修改|修复|实现|开发|重做|执行|运行|构建|部署|安装|整理|撰写|导出|补充|追加|调整|更改|完善|更新|删除|移除|重命名|转换|测试|检查|审查|做|完成';
const SECRETARY_WORK_PREFIX = /^(?:请(?:你)?|帮我|麻烦(?:你)?|给我|我(?:需要|想让|希望)(?:你)?|能否|可否|可以(?:请你)?|请问能否)/i;
const SECRETARY_WORK_TRANSITION = /^(?:另外|接下来|然后|下一步|这次|现在|同时|顺便|再来(?:一个)?|再)\s*/i;

export function classifySecretaryTaskQuery(message = '') {
  const text = String(message || '').trim();
  if (!text || isSecretaryWorkRequest(text)) return null;
  if (isSecretaryArtifactQuery(text)) {
    return 'artifact';
  }
  if (/(?:第\s*(?:\d+|[一二三四五六七八九十两]+)\s*个?|前几个任务中的第\s*(?:\d+|[一二三四五六七八九十两]+)\s*个?|上一个|最近一个|刚才那个).{0,12}(?:任务)?(?:现在)?(?:是什么)?(?:状态|情况|进度|怎么样)|(?:进行|做到|处理|执行).{0,8}(?:哪(?:里|一步)?|什么阶段)|(?:当前|现在|任务)?进度|(?:完成|做好|结束)了?吗|还要多久|(?:当前|任务)(?:状态|情况)|现在怎么样了?/i.test(text)) {
    return 'progress';
  }
  if (/(?:审核|复核|验收).{0,8}(?:状态|进度|结果|通过了吗?)|(?:当前|现在|还有|有什么|哪些).{0,12}(?:待办|待处理|待确认|等待确认|未完成)|(?:任务|工作).{0,12}(?:为什么|为何).{0,8}(?:失败|受阻|阻塞)|\b(?:task|work).{0,20}(?:progress|status|review|pending|blocked|failed)\b/i.test(text)) {
    return 'progress';
  }
  if (/(?:结果|结论|最终结果)(?:呢|怎么样|是什么|出来了吗)?[？?。.！!\s]*$/i.test(text)) {
    return 'result';
  }
  return null;
}

export function isSecretaryWorkRequest(message = '') {
  const text = String(message || '').trim();
  if (!text) return false;
  if (/(?:^|[,.!;:\s])(?:please\s+)?(?:create|write|edit|update|fix|implement|run|build|deploy|install|export|generate)\b/i.test(text)) {
    return true;
  }
  return text
    .split(/[，,。；;：:\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => secretarySegmentCreatesWork(segment));
}

export function selectSecretaryTaskQueryCandidates({ message = '', intent = '', tasks = [], taskOrderIds = [] } = {}) {
  return resolveSecretaryTaskQueryCandidates({ message, intent, tasks, taskOrderIds }).tasks;
}

export function resolveSecretaryTaskQueryCandidates({ message = '', intent = '', tasks = [], taskOrderIds = [] } = {}) {
  const naturallyOrdered = [...(tasks || [])].filter(Boolean).sort((left, right) => taskCreatedTime(right) - taskCreatedTime(left));
  const byId = new Map(naturallyOrdered.map((task) => [String(task.id || ''), task]));
  const snapshotOrdered = [...new Set((Array.isArray(taskOrderIds) ? taskOrderIds : []).map(String).filter(Boolean))]
    .map((taskId) => byId.get(taskId)).filter(Boolean);
  const ordered = snapshotOrdered.length
    ? [...snapshotOrdered, ...naturallyOrdered.filter((task) => !snapshotOrdered.includes(task))]
    : naturallyOrdered;
  if (!ordered.length) return { tasks: [], issue: '', ordered: [] };
  const explicit = explicitTaskMatches(ordered, message);
  if (explicit.length) return { tasks: explicit.slice(0, 8), issue: '', ordered };
  const ordinal = ordinalTaskReference(message);
  if (ordinal) {
    const ordinalPool = snapshotOrdered.length ? snapshotOrdered : ordered.slice(0, 5);
    if (ordinal.index >= 0 && ordinal.index < ordinalPool.length) {
      return { tasks: [ordinalPool[ordinal.index]], issue: '', ordered: ordinalPool, reference: ordinal };
    }
    return {
      tasks: [],
      issue: `当前可见任务列表只有 ${ordinalPool.length} 个任务，找不到第 ${ordinal.index + 1} 个。\n${recentTaskList(ordinalPool)}`,
      ordered: ordinalPool,
      reference: ordinal,
    };
  }
  if (intent === 'progress') {
    const active = ordered.filter((task) => ACTIVE_TASK_STATUSES.has(String(task.status || '')));
    return { tasks: (active.length ? active : ordered.slice(0, 1)).slice(0, 8), issue: '', ordered };
  }
  if (intent === 'artifact') {
    return { tasks: [ordered.find((task) => taskOutputArtifacts(task).length || task.metadata?.taskType === 'file_generation') || ordered[0]], issue: '', ordered };
  }
  return { tasks: ordered.slice(0, 1), issue: '', ordered };
}

export function buildSecretaryTaskQueryReply({ intent = '', tasks = [] } = {}) {
  const items = (tasks || []).filter(Boolean);
  if (!items.length) {
    if (intent === 'artifact') return '当前 uBuddy 会话里没有可查询的任务产物。';
    if (intent === 'result') return '当前 uBuddy 会话里没有可查询的任务结果。';
    return '当前 uBuddy 会话里没有正在执行或最近完成的任务。';
  }
  if (intent === 'progress') return progressReply(items);
  return resultReply(items[0], { artifactOnly: intent === 'artifact' });
}

export function taskOutputArtifacts(task = {}) {
  const values = [];
  for (const file of task.metadata?.deliverableResult?.files || []) {
    const label = String(file?.relative_path || file?.relativePath || file?.path || file?.name || file?.filename || '').trim();
    if (label && !values.includes(label)) values.push(label);
  }
  for (const submission of task.deliverySubmissions || []) {
    for (const file of submission.artifactManifest || []) {
      const label = String(file?.relativePath || file?.relative_path || file?.name || file?.filename || '').trim();
      if (label && !values.includes(label)) values.push(label);
    }
  }
  for (const node of task.nodes || []) {
    for (const ref of node.evidenceRefs || []) {
      if (!ref || typeof ref !== 'object') continue;
      if (!['file', 'artifact', 'output'].includes(String(ref.type || '').toLowerCase())) continue;
      const label = String(ref.path || ref.label || ref.name || '').trim();
      if (label && !values.includes(label)) values.push(label);
    }
  }
  return values.slice(0, 12);
}

function isSecretaryArtifactQuery(message = '') {
  const text = String(message || '').trim();
  const artifact = '(?:生成的|制作的|导出的|输出的|刚才的|上个任务的|上一个任务的)?(?:文件|文档|报告|表格|ppt|演示文稿|产物)';
  const locationQuestion = new RegExp(`${artifact}.{0,16}(?:在哪(?:里)?|哪里|什么位置|保存到哪(?:里)?|放到哪(?:里)?|输出到哪(?:里)?|怎么下载)`, 'i');
  const pathQuestion = new RegExp(`${artifact}(?:的)?(?:路径|位置)(?:是|在)?(?:哪(?:里)?|哪里|什么|什么位置)|${artifact}(?:的)?(?:路径|位置)(?:呢|[？?])`, 'i');
  const concisePathQuestion = new RegExp(`^(?:请)?(?:告诉我|查一下|看一下)?${artifact}(?:的)?(?:路径|位置)(?:呢|[？?])?$`, 'i');
  return locationQuestion.test(text)
    || pathQuestion.test(text)
    || concisePathQuestion.test(text)
    || /(?:保存|放|输出)到(?:哪|哪里)/i.test(text);
}

function secretarySegmentCreatesWork(segment = '') {
  const source = String(segment || '').trim().replace(SECRETARY_WORK_TRANSITION, '').trim();
  if (!source) return false;
  const direct = new RegExp(`^(?:重新|再|继续|开始|立即)?\\s*(${SECRETARY_WORK_VERBS})(.*)$`, 'i').exec(source);
  if (workVerbCreatesWork(direct)) return true;
  const hasDirectiveContext = SECRETARY_WORK_PREFIX.test(source)
    || /(?:^|\s)(?:请(?:你)?|帮我|麻烦(?:你)?|给我|需要你|想让你|希望你|能否|可否)\s*/i.test(source)
    || /^(?:把|在|于|到)\s*/i.test(source)
    || /(?:新任务|另一个任务|另外一个任务|下一项任务)/i.test(source);
  if (!hasDirectiveContext) return false;
  const command = new RegExp(`(${SECRETARY_WORK_VERBS})(.*)$`, 'i').exec(source);
  return workVerbCreatesWork(command);
}

function workVerbCreatesWork(command = null) {
  if (!command) return false;
  const remainder = String(command[2] || '').trim();
  if (/^(?:的|过的|后(?:的)?)/i.test(remainder)) return false;
  if (/^(?:到|至)(?:哪|哪里|什么阶段|什么位置|哪一步)/i.test(remainder)) return false;
  if (/^(?:了?吗|了吗|了没|没有|没有呢)/i.test(remainder)) return false;
  if (/^(?:结果|进度|状态|情况)(?:呢|怎么样|如何|是什么|出来了吗|在哪|在哪里|到哪|有了吗|[？?]|$)/i.test(remainder)) return false;
  return true;
}

function explicitTaskMatches(tasks = [], message = '') {
  const source = normalizeReference(message);
  return tasks.filter((task) => {
    const id = String(task.id || '').trim();
    const title = normalizeReference(task.title || '');
    return Boolean((id && String(message || '').includes(id)) || (title.length >= 4 && source.includes(title)));
  });
}

function progressReply(tasks = []) {
  const multiple = tasks.length > 1;
  const lines = [multiple ? `当前有 ${tasks.length} 个相关任务：` : `任务“${tasks[0].title}”当前状态：`];
  for (const task of tasks) {
    const nodes = task.nodes || [];
    const completed = nodes.filter((node) => node.status === 'completed').length;
    const active = nodes.filter((node) => ['ready', 'queued', 'running'].includes(String(node.status || '')));
    const blocked = nodes.filter((node) => ['waiting', 'blocked', 'failed'].includes(String(node.status || '')));
    const prefix = multiple ? `- ${task.title}：` : '- ';
    lines.push(`${prefix}${taskStatusLabel(task.status)}，已完成 ${completed}/${nodes.length} 个节点。`);
    if (active.length) lines.push(`  正在处理：${active.slice(0, 4).map((node) => node.title).join('、')}。`);
    if (blocked.length) lines.push(`  阻塞/异常：${blocked.slice(0, 4).map((node) => `${node.title}（${node.waitReason || node.errorText || taskNodeStatusLabel(node.status)}）`).join('；')}。`);
    if (!active.length && !blocked.length && ACTIVE_TASK_STATUSES.has(String(task.status || ''))) lines.push('  正在等待可执行节点进入队列。');
  }
  if (multiple) lines.push('如需查看某一个任务的详细进度，请回复任务名称。');
  return lines.join('\n');
}

function resultReply(task = {}, { artifactOnly = false } = {}) {
  const nodes = task.nodes || [];
  const finalNode = finalTaskNode(nodes);
  const artifacts = taskOutputArtifacts(task);
  const result = clipText(finalNode?.resultSummary || finalNode?.resultText || task.summary || '', 900);
  const lines = [`任务“${task.title}”当前状态：${taskStatusLabel(task.status)}。`];
  if (!artifactOnly && result) lines.push(`结果摘要：${result}`);
  lines.push('产物位置：');
  lines.push(...(artifacts.length ? artifacts.map((item) => `- ${item}`) : ['- 当前任务没有记录可定位的结构化文件或产物。']));
  if (artifactOnly && result && !artifacts.length) lines.push(`任务结果摘要：${result}`);
  if (ACTIVE_TASK_STATUSES.has(String(task.status || ''))) lines.push('任务仍在执行，后续节点可能继续生成或更新产物。');
  return lines.join('\n');
}

function finalTaskNode(nodes = []) {
  const completed = nodes.filter((node) => node.status === 'completed');
  const dependedOn = new Set(nodes.flatMap((node) => node.dependencies || []));
  return completed.find((node) => !dependedOn.has(node.id)) || completed.at(-1) || nodes.at(-1) || null;
}

function taskStatusLabel(status = '') {
  return ({
    pending: '等待规划', ready: '等待执行', queued: '已进入队列', running: '执行中', retry_wait: '等待自动重试', waiting: '等待信息', blocked: '依赖失败阻塞',
    cancelling: '正在停止', completed: '已完成', failed: '执行失败', cancelled: '已取消',
  })[String(status || '')] || String(status || '状态未知');
}

function taskNodeStatusLabel(status = '') {
  return ({ retry_wait: '等待自动重试', waiting: '等待信息', blocked: '受阻', failed: '执行失败' })[String(status || '')] || '状态异常';
}

function taskCreatedTime(task = {}) {
  const value = new Date(task.createdAt || task.created_at || task.updatedAt || task.updated_at || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function ordinalTaskReference(message = '') {
  const text = String(message || '').normalize('NFKC');
  if (/(?:最近一个|刚才那个)(?:任务)?/i.test(text)) return { kind: 'recent', index: 0 };
  if (/上一个(?:任务)?/i.test(text)) return { kind: 'previous', index: 1 };
  const match = /(?:前几个任务中的)?第\s*(\d+|[一二三四五六七八九十两]+)\s*个?(?:任务)?/i.exec(text);
  if (!match) return null;
  const number = chineseOrdinalNumber(match[1]);
  return Number.isInteger(number) && number > 0 ? { kind: 'ordinal', index: number - 1 } : null;
}

function chineseOrdinalNumber(value = '') {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (digits[text.slice(1)] || 0);
  if (text.endsWith('十')) return (digits[text[0]] || 0) * 10;
  if (text.includes('十')) {
    const [left, right] = text.split('十');
    return (digits[left] || 0) * 10 + (digits[right] || 0);
  }
  return digits[text] || 0;
}

function recentTaskList(tasks = []) {
  const visible = tasks.slice(0, 5);
  return ['最近任务：', ...visible.map((task, index) => `${index + 1}. ${task.title || task.id}（${taskStatusLabel(task.status)}）`)].join('\n');
}

function normalizeReference(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s，,。；;：:！？!?“”"'（）()\-_]+/g, '');
}

function clipText(value = '', max = 900) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
