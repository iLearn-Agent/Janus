import assert from 'node:assert/strict';

import { state } from '../src/renderer/app/state.js';
import { createMessageSendController } from '../src/renderer/app/features/chat/messageSendController.js';
import { renderSidebar } from '../src/renderer/app/views/navigationView.js';
import { renderNetworkPanel } from '../src/renderer/app/views/networkView.js';

state.currentUser = { id: 'disabled-employee-user', username: 'Disabled Employee User', role: 'user' };
state.currentTab = 'chat';
state.networkPanelOpen = true;
state.networkPanelView = 'messages';
state.networkMessageHomeOpen = true;
state.currentSessionId = '';
state.org = {
  departments: [{ id: 'general', name: '通用部门' }],
  agents: [{ id: 'general_agent', name: '通用 Agent', departmentId: 'general', routable: true }],
  hrs: [],
};
state.sessions = [{
  id: 'disabled-employee-session',
  title: '已停用 Agent 会话',
  lastMessage: '这是最近一条回复',
  lastMessageRole: 'assistant',
  departmentId: 'general',
  agentId: 'general_agent',
  agentInstanceId: 'disabled-employee-instance',
  unreadDeliveryCount: 3,
  unreadCount: 3,
  updatedAt: new Date().toISOString(),
}];
state.friendOverview = { friends: [], requests: { incoming: [], outgoing: [] } };
state.socialInbox = [];
state.collaborationOverview = { groups: [], tasks: [] };
state.agentDelegations = [];

state.employeeOverview = {
  roster: [{
    id: 'disabled-employee-instance',
    agentFamilyId: 'general_agent',
    employmentState: 'active',
    routeEligible: true,
  }],
};
const activeEmployeeMarkup = renderNetworkPanel();
assert.match(activeEmployeeMarkup, /data-network-session="disabled-employee-session"/);
assert.match(activeEmployeeMarkup, /这是最近一条回复/);
assert.doesNotMatch(activeEmployeeMarkup, />已停用 Agent 会话</);
assert.match(renderSidebar(), /sidebar-nav-unread[^>]*>3</);

state.employeeOverview.roster[0] = {
  ...state.employeeOverview.roster[0],
  employmentState: 'inactive',
  authorityState: 'pending',
  pendingTargetState: 'inactive',
  routeEligible: false,
};
assert.doesNotMatch(renderNetworkPanel(), /disabled-employee-session|data-agent-message-row="general_agent"/);
assert.doesNotMatch(renderSidebar(), /sidebar-nav-unread/);

state.employeeOverview.roster[0] = {
  ...state.employeeOverview.roster[0],
  employmentState: 'pending_cloud_confirmation',
  pendingTargetState: 'active',
  routeEligible: true,
};
assert.match(renderNetworkPanel(), /data-network-session="disabled-employee-session"/);
assert.match(renderSidebar(), /sidebar-nav-unread[^>]*>3</);

state.employeeOverview.roster[0] = {
  ...state.employeeOverview.roster[0],
  employmentState: 'inactive',
  authorityState: 'pending',
  pendingTargetState: 'active',
  routeEligible: true,
};
assert.match(renderNetworkPanel(), /data-network-session="disabled-employee-session"/);
assert.match(renderSidebar(), /sidebar-nav-unread[^>]*>3</);

state.employeeOverview.roster[0] = {
  ...state.employeeOverview.roster[0],
  employmentState: 'inactive',
  authorityState: 'cloud_confirmed',
  pendingTargetState: '',
  routeEligible: false,
};
state.currentSessionId = 'disabled-employee-session';
state.currentDepartmentId = 'general';
state.currentAgentId = 'general_agent';
state.homeMode = 'department';
state.messages = [];
state.busy = false;
let sendCount = 0;
let warning = '';
const { sendChat } = createMessageSendController({
  api: { async sendChat() { sendCount += 1; } },
  documentRef: { getElementById: () => ({ value: '不应发送的消息', dataset: {} }) },
  state,
  render() {},
  notify(message) { warning = message; },
  currentChatRun: () => null,
  resolveSelectedAgentId: () => 'general_agent',
  activeAgentInstanceId: () => 'disabled-employee-instance',
});
await sendChat({ preventDefault() {} });
assert.equal(sendCount, 0);
assert.equal(state.messages.length, 0);
assert.match(warning, /已停用，无法继续对话/);

console.log('disabled employee message visibility smoke passed');
