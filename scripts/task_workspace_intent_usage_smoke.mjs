import assert from 'node:assert/strict';

import { classifyTaskWorkspaceIntent } from '../src/main/modules/collaboration/application/taskWorkspaceIntent.js';

const executionContext = {
  userId: 'user_1',
  taskRunId: 'task_1',
  executionKind: 'ubuddy_task_workspace_intent',
};
let observedContext = null;
const result = await classifyTaskWorkspaceIntent({
  content: '照这个来吧',
  root: '/tmp/janus-task-workspace-intent',
  execute: async (options) => {
    observedContext = options.executionContext;
    return JSON.stringify({
      version: 'TASK_WORKSPACE_INTENT_V1',
      intent: 'supplement',
      requestedSubmissionNo: 0,
      reason: '主人要求继续处理现有任务。',
    });
  },
  executionContext,
});

assert.equal(result.intent, 'supplement');
assert.equal(observedContext, executionContext, 'task-workspace model classification must use the quota ledger execution context');

console.log('Task workspace intent usage smoke passed.');
