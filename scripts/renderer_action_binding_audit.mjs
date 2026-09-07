import assert from 'node:assert/strict';
import fs from 'node:fs';

import { TASK_CARD_ACTIONS } from '../src/shared/contracts/taskCard.js';

const rendererApp = fs.readFileSync('src/renderer/app/core/rendererApp.js', 'utf8');
const chatView = fs.readFileSync('src/renderer/app/views/chatView.js', 'utf8');
const taskProgressView = fs.readFileSync('src/renderer/app/views/taskProgressView.js', 'utf8');
const networkView = fs.readFileSync('src/renderer/app/views/networkView.js', 'utf8');
const collaborationView = fs.readFileSync('src/renderer/app/views/collaborationView.js', 'utf8');
const renderSources = `${chatView}\n${taskProgressView}\n${networkView}\n${collaborationView}`;

assert.ok(rendererApp.includes('[data-task-card-action]'));
assert.match(rendererApp, /handleTaskCardAction\(button\)/);
for (const [name, action] of Object.entries(TASK_CARD_ACTIONS)) {
  assert.ok(renderSources.includes(`TASK_CARD_ACTIONS.${name}`) || renderSources.includes(`data-task-card-action="${action}"`),
    `task action ${action} is never rendered`);
  assert.ok(rendererApp.includes(`TASK_CARD_ACTIONS.${name}`), `task action ${action} has no renderer handler`);
}

for (const selector of [
  'data-task-workspace-view',
  'data-delegation-workspace-open',
  'data-delegation-run-cancel',
  'data-cancel-ubuddy-task',
  'data-retry-task-node',
]) {
  assert.ok(renderSources.includes(selector), `${selector} is not rendered`);
  assert.ok(rendererApp.includes(selector), `${selector} has no registered handler`);
}

assert.match(rendererApp, /旧版任务视图/);
assert.match(rendererApp, /newTaskWorkspaceUiEnabled/);
console.log('renderer action binding audit passed');
