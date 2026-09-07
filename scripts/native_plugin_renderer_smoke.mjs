import assert from 'node:assert/strict';
import fs from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { renderPluginSettings } from '../src/renderer/app/views/pluginsView.js';

const pluginsView = fs.readFileSync(new URL('../src/renderer/app/views/pluginsView.js', import.meta.url), 'utf8');
const chatView = fs.readFileSync(new URL('../src/renderer/app/views/chatView.js', import.meta.url), 'utf8');
const renderer = fs.readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const messageSendController = fs.readFileSync(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
const runtimeSource = fs.readFileSync(new URL('../src/main/runtime.js', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../src/preload/preload.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
const ipc = fs.readFileSync(new URL('../src/main/ipc/registerIpcHandlers.js', import.meta.url), 'utf8');

assert.match(pluginsView, /Codex 插件/);
assert.match(pluginsView, /data-codex-plugin-install/);
assert.match(pluginsView, /data-codex-plugin-remove/);
assert.match(pluginsView, /data-codex-marketplace-add/);
assert.match(pluginsView, /第三方/);
assert.match(chatView, /data-project-mention-group="plugins"/);
assert.match(chatView, /data-ubuddy-mention-plugin/);
assert.match(renderer, /insertUBuddyMention\([\s\S]*pluginId/);
assert.match(messageSendController, /result\.nativePluginControl/);
assert.match(messageSendController, /state\.codexPlugins = nativePluginCatalog/);
assert.match(messageSendController, /mentions: outgoingMentions/);
assert.match(runtimeSource, /mentions = \[\]/);
assert.match(runtimeSource, /withNativePluginMentionContext/);
assert.match(preload, /codex-plugins:list/);
assert.match(preload, /codex-plugins:changed/);
assert.match(preload, /codex-plugin-marketplaces:add/);
assert.match(renderer, /onCodexPluginsChanged/);
assert.match(renderer, /state\.codexPlugins = payload\.catalog/);
assert.match(main, /onNativePluginCatalogChanged/);
assert.match(main, /codex-plugins:changed/);
assert.match(ipc, /codex-plugins:install/);
assert.match(ipc, /codex-plugin-marketplaces:pick-source/);

state.codexPlugins = {
  capability: { supported: true, version: '0.145.0', source: 'bundled', minimumVersion: '0.144.3', error: '', code: '' },
  marketplaces: [{ name: 'openai-curated', root: '/market' }],
  installed: [{ pluginId: 'zotero@openai-curated', name: 'zotero', displayName: 'Zotero', displayNameZhCn: '文献库',
    description: 'Find papers', descriptionEn: 'Find papers', descriptionZhCn: '查找并引用论文', marketplaceName: 'openai-curated', version: '0.1.2', installed: true, enabled: true, authPolicy: 'ON_INSTALL' }],
  available: [
    { pluginId: 'github@openai-curated', name: 'github', displayName: 'GitHub', description: 'GitHub plugin', marketplaceName: 'openai-curated', version: '0.1.6', installed: false, enabled: false, authPolicy: 'ON_USE' },
    { pluginId: 'demo@third-party', name: 'demo', displayName: 'Demo', description: 'Demo plugin', marketplaceName: 'third-party', version: '1.0.0', installed: false, enabled: false, authPolicy: 'ON_USE' },
  ],
  legacyMcpConflicts: [{ name: 'github', kind: 'mcp', source: 'plugin_account' }],
};
state.pluginCatalog = [];
state.pptxPluginStatus = { installed: false, available: true };
state.languageMode = 'en';
const markup = renderPluginSettings();
assert.match(markup, /Zotero/);
assert.match(markup, /Find papers/);
assert.match(markup, /zotero@openai-curated/);
assert.match(markup, /内置官方目录/);
assert.match(markup, /data-codex-plugin-remove/);
assert.match(markup, /data-codex-plugin-install/);
assert.match(markup, /第三方/);
assert.match(markup, /实际 Codex CLI/);
assert.match(markup, /v0\.145\.0/);
assert.match(markup, /Janus 内置/);
assert.match(markup, /GitHub/);
assert.match(markup, /推荐/);
assert.match(markup, /检测到旧 GitHub MCP 配置/);
state.languageMode = 'zh-CN';
const chineseMarkup = renderPluginSettings();
assert.match(chineseMarkup, /文献库/);
assert.match(chineseMarkup, /查找并引用论文/);

state.codexPlugins = {
  capability: {
    supported: false, version: '0.129.0', source: 'system', minimumVersion: '0.144.3',
    error: '当前 Codex CLI v0.129.0 过旧，请升级或重新安装 Janus。', code: 'codex_plugin_runtime_upgrade_required',
  },
  installed: [], available: [], marketplaces: [], legacyMcpConflicts: [],
};
const unsupportedMarkup = renderPluginSettings();
assert.match(unsupportedMarkup, /v0\.129\.0/);
assert.match(unsupportedMarkup, /系统环境/);
assert.match(unsupportedMarkup, /升级或重新安装 Janus/);
assert.doesNotMatch(unsupportedMarkup, /data-codex-plugin-install/);

const installedPlugin = {
  pluginId: 'zotero@openai-api-curated', name: 'zotero', displayName: 'Zotero',
  marketplaceName: 'openai-api-curated', version: '1.0.0', installed: true, enabled: true,
};
Object.assign(state, {
  currentUser: { id: 'mention-user', name: 'Mention User' },
  currentTab: 'chat', currentSessionId: '', currentAgentId: '', currentAgentInstanceId: '', currentDepartmentId: '',
  sessions: [], messages: [], projects: [], activeProjectId: '', workspaceRoot: '', workspaceDetached: false,
  codexPlugins: { capability: { supported: true }, installed: [installedPlugin], available: [], marketplaces: [], legacyMcpConflicts: [] },
  socialMentionMenuOpen: true, composerMentionQuery: '', chatDraft: '@', composerMentions: [], secretaryMentions: [],
  friendOverview: { organizations: [] }, employeeOverview: { roster: [] }, activeAccountWorkspace: { kind: 'personal' },
});
for (const homeMode of ['normal', 'secretary', 'private_assistant']) {
  state.homeMode = homeMode;
  const chatMarkup = renderChat({ renderMessageList: () => '' });
  assert.match(chatMarkup, /data-project-mention-group="plugins"/, `${homeMode} chat should expose plugin mentions`);
  assert.match(chatMarkup, /zotero@openai-api-curated/, `${homeMode} chat should include installed plugin ID`);
}
state.homeMode = 'department';
state.currentSessionId = 'agent-session';
state.currentAgentId = 'research';
state.currentAgentInstanceId = 'research-instance';
state.currentDepartmentId = 'research_department';
state.sessions = [{ id: 'agent-session', departmentId: 'research_department', agentId: 'research', agentInstanceId: 'research-instance', title: 'Research' }];
const agentChatMarkup = renderChat({ renderMessageList: () => '' });
assert.match(agentChatMarkup, /data-project-mention-group="plugins"/, 'Agent chat should expose plugin mentions');
assert.match(agentChatMarkup, /zotero@openai-api-curated/, 'Agent chat should include installed plugin ID');

console.log('native plugin renderer smoke passed');
