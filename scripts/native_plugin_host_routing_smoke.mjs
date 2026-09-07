import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { parseNativePluginControlIntent, resolveNativePluginControlTarget } from '../src/main/nativePluginIntent.js';
import { nativePluginAccountState } from '../src/main/nativePluginState.js';
import { createPickerMentionEntity } from '../src/shared/contracts/mentions.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-native-plugin-host-'));
const fakeCli = path.join(root, 'fake-codex.mjs');
const commandLog = path.join(root, 'codex-commands.jsonl');
const pluginRoot = path.join(root, 'fixture-market', 'plugins', 'zotero');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousPrimary = process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;
let runtime;
const catalogChangeEvents = [];

try {
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'zotero', version: '0.1.2', description: 'Zotero literature tools',
    interface: { displayName: 'Zotero', shortDescription: 'Search and cite Zotero libraries' },
  }));
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('codex-cli 0.145.0'); process.exit(0); }
if (args[0] === 'plugin' && args[1] === '--help') {
  console.log('Commands:\\n  add  Install\\n  list  List\\n  remove  Remove'); process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') { console.log('[]'); process.exit(0); }
if (args[0] !== 'plugin') process.exit(91);
const home = process.env.CODEX_HOME;
fs.mkdirSync(home, { recursive: true });
const statePath = path.join(home, 'zotero-state.json');
let state = { installed: false, marketplaceReady: false };
try { state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; } catch {}
const plugin = {
  pluginId: 'zotero@openai-api-curated', name: 'zotero', marketplaceName: 'openai-api-curated',
  version: '0.1.2', installed: state.installed, enabled: state.installed,
  source: { source: 'fixture', path: ${JSON.stringify(pluginRoot)} }, installPolicy: 'AVAILABLE', authPolicy: 'ON_USE',
};
const save = () => {
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.writeFileSync(path.join(home, 'config.toml'), state.marketplaceReady
    ? '[marketplaces."openai-api-curated"]\\nsource_type = "git"\\nsource = "openai/plugins"\\n'
      + (state.installed ? '\\n[plugins."zotero@openai-api-curated"]\\nenabled = true\\n' : '')
    : '');
};
let result = null;
if (args[1] === 'list') result = state.marketplaceReady
  ? { installed: state.installed ? [plugin] : [], available: state.installed ? [] : [plugin] }
  : { installed: [], available: [] };
else if (args[1] === 'marketplace' && args[2] === 'list') result = {
  marketplaces: state.marketplaceReady ? [{ name: 'openai-api-curated', root: 'fixture' }] : [],
};
else if (args[1] === 'marketplace' && args[2] === 'add' && args[3] === 'openai/plugins') {
  state.marketplaceReady = true; save(); result = { marketplaceName: 'openai-api-curated' };
}
else if (args[1] === 'add' && args[2] === plugin.pluginId) { state.installed = true; save(); result = { pluginId: plugin.pluginId }; }
else if (args[1] === 'remove' && args[2] === plugin.pluginId) { state.installed = false; save(); result = { pluginId: plugin.pluginId }; }
else process.exit(92);
console.log(JSON.stringify(result));
`);
  fs.chmodSync(fakeCli, 0o755);

  assert.deepEqual(parseNativePluginControlIntent('安装Zotero插件'), {
    action: 'install', query: 'Zotero', source: 'explicit_plugin_command',
  });
  assert.deepEqual(parseNativePluginControlIntent('请帮我安装一个Zotero插件'), {
    action: 'install', query: 'Zotero', source: 'explicit_plugin_command',
  });
  assert.equal(parseNativePluginControlIntent('写一个 Zotero 插件安装方案'), null);
  assert.equal(parseNativePluginControlIntent('安装项目依赖'), null);
  const officialResolution = resolveNativePluginControlTarget(
    parseNativePluginControlIntent('安装 Zotero 插件'),
    {
      capability: { supported: true }, installed: [],
      available: [
        { pluginId: 'zotero@github-local', name: 'zotero', marketplaceName: 'github-local' },
        { pluginId: 'zotero@openai-api-curated', name: 'zotero', marketplaceName: 'openai-api-curated' },
      ],
    },
  );
  assert.equal(officialResolution.status, 'matched');
  assert.equal(officialResolution.plugin.pluginId, 'zotero@openai-api-curated');
  const embeddedOfficialResolution = resolveNativePluginControlTarget(
    parseNativePluginControlIntent('安装 Zotero 插件'),
    {
      capability: { supported: true }, installed: [],
      available: [
        { pluginId: 'zotero@github-local', name: 'zotero', marketplaceName: 'github-local' },
        { pluginId: 'zotero@openai-curated', name: 'zotero', marketplaceName: 'openai-curated' },
      ],
    },
  );
  assert.equal(embeddedOfficialResolution.status, 'matched');
  assert.equal(embeddedOfficialResolution.plugin.pluginId, 'zotero@openai-curated');

  process.env.JANUS_CODEX_BIN = fakeCli;
  process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1 = 'on';
  runtime = await createRuntime({
    root,
    isDev: true,
    serverAuthoritativeSkills: true,
    onNativePluginCatalogChanged: (event) => catalogChangeEvents.push(event),
  });
  const session = runtime.ensureSecretarySession();
  const user = runtime.currentUser();
  const generalInstance = runtime.store.findUserAgentInstance({
    userId: user.id,
    agentFamilyId: 'general_agent',
  }) || runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'general_agent',
    commandId: 'native-plugin-host:recruit-general',
  }).instance;
  let approvalCount = 0;
  const installedResult = await runtime.sendChat({
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: generalInstance.id,
    chatMode: 'agent',
    routePreference: 'explicit',
    message: '安装Zotero插件',
    sandboxPermission: 'request-approval',
    onEvent(event) {
      if (event.kind !== 'approval-request') return;
      approvalCount += 1;
      queueMicrotask(() => runtime.resolveChatApproval({
        runId: event.runId, approvalId: event.approvalId, approved: true,
      }));
    },
  });
  assert.equal(approvalCount, 1);
  assert.equal(installedResult.uBuddyMode, 'native_plugin_control');
  assert.equal(installedResult.nativePluginControl.status, 'installed');
  assert.equal(installedResult.nativePluginControl.pluginId, 'zotero@openai-api-curated');
  assert.equal(installedResult.nativePluginControl.catalogVerified, true);
  assert.match(installedResult.answer, /设置 - 技能与插件/);
  assert.equal(installedResult.session.agentId, 'general_agent');
  assert.equal(installedResult.session.agentInstanceId, generalInstance.id);
  assert.equal(installedResult.session.departmentId, 'general');
  const generalMessages = runtime.store.listMessages(installedResult.session.id);
  assert.equal(generalMessages.length, 2);
  assert.deepEqual(generalMessages.map((item) => item.agentId), ['general_agent', 'general_agent']);
  assert.deepEqual(generalMessages.map((item) => item.agentInstanceId), [generalInstance.id, generalInstance.id]);
  assert.deepEqual(generalMessages.map((item) => item.departmentId), ['general', 'general']);
  const userId = user.id;
  assert.deepEqual(nativePluginAccountState(root, userId).pluginIds, ['zotero@openai-api-curated']);
  const settingsCatalog = await runtime.nativePluginCatalog();
  assert.equal(settingsCatalog.installed[0]?.pluginId, 'zotero@openai-api-curated');
  assert.equal(settingsCatalog.installed[0]?.enabled, true);
  assert.equal(catalogChangeEvents.length, 1);
  assert.equal(catalogChangeEvents[0].userId, userId);
  assert.equal(catalogChangeEvents[0].reason, 'chat_install');
  assert.equal(catalogChangeEvents[0].catalog.installed[0]?.pluginId, 'zotero@openai-api-curated');

  const normalResult = await runtime.sendChat({
    chatMode: 'normal',
    message: '安装 Zotero 插件',
    sandboxPermission: 'request-approval',
  });
  assert.equal(normalResult.nativePluginControl.status, 'installed');
  assert.equal(normalResult.session.departmentId, 'general');
  assert.equal(normalResult.session.agentId, '');

  const privateAssistantResult = await runtime.sendChat({
    chatMode: 'private_assistant',
    departmentId: 'private_assistant',
    agentId: 'private_assistant',
    message: '安装 Zotero 插件',
    sandboxPermission: 'request-approval',
  });
  assert.equal(privateAssistantResult.nativePluginControl.status, 'installed');
  assert.equal(privateAssistantResult.session.departmentId, 'private_assistant');
  assert.equal(privateAssistantResult.session.agentId, 'private_assistant');

  const missingResult = await runtime.secretaryChat({
    sessionId: session.id, message: '安装不存在插件', sandboxPermission: 'request-approval',
  });
  assert.equal(missingResult.nativePluginControl.status, 'not_found');
  assert.match(missingResult.answer, /未运行 Shell/);

  let removalApprovalCount = 0;
  const removedResult = await runtime.secretaryChat({
    sessionId: session.id, message: '卸载 Zotero 插件', sandboxPermission: 'request-approval',
    onEvent(event) {
      if (event.kind !== 'approval-request') return;
      removalApprovalCount += 1;
      queueMicrotask(() => runtime.resolveChatApproval({
        runId: event.runId, approvalId: event.approvalId, approved: true,
      }));
    },
  });
  assert.equal(removalApprovalCount, 1);
  assert.equal(removedResult.nativePluginControl.status, 'removed');
  assert.deepEqual(nativePluginAccountState(root, userId).pluginIds, []);

  const removedPluginMention = createPickerMentionEntity({
    principalType: 'plugin',
    pluginId: 'zotero@openai-api-curated',
    displayText: '@Zotero',
  });
  await assert.rejects(runtime.sendChat({
    chatMode: 'normal',
    message: '@Zotero 查找最近的论文',
    mentions: [removedPluginMention],
    sandboxPermission: 'request-approval',
  }), (error) => error.code === 'codex_plugin_mention_unavailable');

  const cancelledResult = await runtime.secretaryChat({
    sessionId: session.id, message: '安装一个Zotero插件', sandboxPermission: 'request-approval',
    onEvent(event) {
      if (event.kind !== 'approval-request') return;
      queueMicrotask(() => runtime.resolveChatApproval({
        runId: event.runId, approvalId: event.approvalId, approved: false,
      }));
    },
  });
  assert.equal(cancelledResult.nativePluginControl.status, 'cancelled');
  assert.deepEqual(nativePluginAccountState(root, userId).pluginIds, []);

  const planResult = await runtime.sendChat({
    sessionId: installedResult.session.id,
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: generalInstance.id,
    chatMode: 'agent',
    routePreference: 'explicit',
    interactionMode: 'plan',
    message: '安装 Zotero 插件',
    sandboxPermission: 'request-approval',
  });
  assert.equal(planResult.nativePluginControl.status, 'read_only');
  assert.equal(planResult.nativePluginControl.errorCode, 'plan_mode_read_only');
  assert.equal(planResult.session.id, installedResult.session.id);

  const commands = fs.readFileSync(commandLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(commands.some((args) => ['app-server', 'exec'].includes(args[0])), false);
  assert.equal(commands.filter((args) => args[0] === 'plugin' && args[1] === 'marketplace'
    && args[2] === 'add' && args[3] === 'openai/plugins').length, 1);
  assert.equal(commands.filter((args) => args[0] === 'plugin' && args[1] === 'add'
    && args[2] === 'zotero@openai-api-curated').length, 1);
  assert.equal(commands.some((args) => args[0] === 'plugin' && args[1] === 'remove' && args[2] === 'zotero@openai-api-curated'), true);
  assert.equal(fs.existsSync(path.join(root, 'outputs')), false);
  assert.equal(runtime.activeRuns.size, 0);

  console.log('native plugin host routing smoke passed');
} finally {
  await runtime?.close?.();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousPrimary === undefined) delete process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;
  else process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1 = previousPrimary;
  fs.rmSync(root, { recursive: true, force: true });
}
