export const TASK_REFERENCE_PRINCIPAL_TYPE = 'task';
export const TASK_REFERENCE_NEW_TASK = 'new_task';
export const STRUCTURED_TASK_REFERENCE_VERSION = 'structured_task_reference_v1';

export function normalizeTaskReference(value = null) {
  if (!value || typeof value !== 'object' || value.principalType !== TASK_REFERENCE_PRINCIPAL_TYPE) return null;
  const taskRunId = String(value.taskRunId || '').trim();
  const createNewTask = !taskRunId
    && (value.createNewTask === true || String(value.action || '').trim() === TASK_REFERENCE_NEW_TASK);
  if (!taskRunId && !createNewTask) return null;
  const displayText = String(value.displayText || '').trim()
    || (createNewTask ? '@新任务' : '@任务');
  return {
    principalType: TASK_REFERENCE_PRINCIPAL_TYPE,
    taskRunId,
    displayText: displayText.slice(0, 160),
    ...(createNewTask ? { createNewTask: true, action: TASK_REFERENCE_NEW_TASK } : {}),
  };
}

export function createNewTaskReference() {
  return normalizeTaskReference({
    principalType: TASK_REFERENCE_PRINCIPAL_TYPE,
    taskRunId: '',
    displayText: '@新任务',
    createNewTask: true,
  });
}

export function isObviousTaskSupplement(message = '') {
  const text = String(message || '').trim();
  if (!text) return false;
  if (/(?:新任务|另一个任务|另外(?:做|创建|开始)|新建任务|重新开(?:始|一个)|不(?:要|用)接着)/i.test(text)) return false;
  return /^(?:补充|追加|修改|调整|更改|继续|接着|再加|再补|把(?:它|这个|刚才的)|在(?:这个|刚才的|当前)任务|还有一点|另外补充|要求改为|改成|加上|删掉|去掉)/i.test(text)
    || /(?:补充要求|继续处理|继续执行|基于刚才|沿用刚才|在原任务|这个任务再|刚才的任务)/i.test(text);
}
