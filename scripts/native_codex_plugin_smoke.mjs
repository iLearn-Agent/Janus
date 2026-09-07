import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareCodexHome } from '../src/main/codex.js';
import { createNativePluginService } from '../src/main/nativePluginService.js';
import { nativePluginAccountHome, nativePluginAccountState } from '../src/main/nativePluginState.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-native-plugin-'));
const marketRoot = path.join(root, 'fixture-market');
const pluginRoot = path.join(marketRoot, 'plugins', 'demo');
const officialMarketRoot = path.join(root, 'official-market');
const fakeCli = path.join(root, 'fake-codex.mjs');
const oldFakeCli = path.join(root, 'old-fake-codex.mjs');
const userId = 'native-plugin-user';

try {
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', description: 'Verified demo plugin',
    interface: {
      displayName: 'Demo Plugin', shortDescription: 'Fixture capability',
      displayNameEn: 'Demo Plugin', displayNameZhCn: '演示插件',
      descriptionEn: 'Fixture capability', descriptionZhCn: '测试扩展能力',
    },
  }));
  fs.mkdirSync(path.join(officialMarketRoot, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(officialMarketRoot, '.agents', 'plugins', 'api_marketplace.json'), JSON.stringify({
    name: 'openai-api-curated',
    plugins: [{ name: 'zotero', source: { source: 'local', path: './plugins/zotero' } }],
  }));
  const officialSha = '0123456789abcdef0123456789abcdef01234567';
  fs.writeFileSync(path.join(path.dirname(officialMarketRoot), 'plugins.sha'), `${officialSha}\n`);
  fs.writeFileSync(fakeCli, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 0.145.0\\n'); process.exit(0); }
if (args[0] === 'plugin' && args[1] === '--help') { process.stdout.write('Commands:\\n  add  Install\\n  list  List\\n  remove  Remove\\n'); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'list') { process.stdout.write(JSON.stringify([{ name: 'github', enabled: true }])); process.exit(0); }
const home = process.env.CODEX_HOME;
const statePath = path.join(home, 'fake-plugin-state.json');
fs.mkdirSync(home, { recursive: true });
let state = { installed: false, marketplaces: [{ name: 'test-market', root: ${JSON.stringify(marketRoot)} }] };
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
const linkedOfficial = fs.existsSync(path.join(home, '.tmp', 'plugins', '.agents', 'plugins', 'api_marketplace.json'));
const marketplaces = () => linkedOfficial
  ? [...state.marketplaces, { name: 'openai-api-curated', root: path.join(home, '.tmp', 'plugins') }]
  : state.marketplaces;
const plugin = { pluginId: 'demo@test-market', name: 'demo', marketplaceName: 'test-market', version: '1.0.0', installed: state.installed, enabled: state.installed, source: { source: 'local', path: ${JSON.stringify(pluginRoot)} }, installPolicy: 'AVAILABLE', authPolicy: 'ON_USE' };
const save = () => {
  fs.writeFileSync(statePath, JSON.stringify(state));
  const markets = state.marketplaces.map((item) => '[marketplaces."' + item.name + '"]\\nsource_type = "local"\\nsource = ' + JSON.stringify(item.root) + '\\n').join('\\n');
  fs.writeFileSync(path.join(home, 'config.toml'), markets + (state.installed ? '\\n[plugins."demo@test-market"]\\nenabled = true\\n' : ''));
};
let result = {};
if (args[0] !== 'plugin') process.exit(2);
if (args[1] === 'list') result = { installed: state.installed ? [plugin] : [], available: state.installed ? [] : [plugin] };
else if (args[1] === 'add') { state.installed = true; fs.mkdirSync(path.join(home, 'plugins', 'cache', 'test-market', 'demo', '1.0.0'), { recursive: true }); save(); result = { pluginId: plugin.pluginId }; }
else if (args[1] === 'remove') { state.installed = false; save(); result = { pluginId: plugin.pluginId }; }
else if (args[1] === 'marketplace' && args[2] === 'list') result = { marketplaces: marketplaces() };
else if (args[1] === 'marketplace' && args[2] === 'add') {
  const official = args[3] === 'openai/plugins';
  const name = official ? 'openai-api-curated' : 'custom-market';
  state.marketplaces.push({ name, root: args[3] });
  save();
  result = { marketplaceName: name };
}
else if (args[1] === 'marketplace' && args[2] === 'upgrade') result = { marketplaceName: args[3] };
else if (args[1] === 'marketplace' && args[2] === 'remove') { state.marketplaces = state.marketplaces.filter((item) => item.name !== args[3]); save(); result = { marketplaceName: args[3] }; }
else process.exit(3);
process.stdout.write(JSON.stringify(result));
`);
  fs.writeFileSync(oldFakeCli, `
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 0.129.0\\n'); process.exit(0); }
if (args[0] === 'plugin' && args[1] === '--help') { process.stdout.write('Commands:\\n  add  Install\\n  list  List\\n  remove  Remove\\n'); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
process.exit(3);
`);

  const service = createNativePluginService({
    root,
    resolveBinary: async () => process.execPath,
    binaryArgs: [fakeCli],
    envForHome: (_root, home) => ({ ...process.env, ...(home ? { CODEX_HOME: home } : {}) }),
    officialMarketplaceRoots: [officialMarketRoot],
  });

  let catalog = await service.list(userId);
  assert.deepEqual(catalog.capability, {
    supported: true,
    version: '0.145.0',
    source: 'system',
    minimumVersion: '0.144.3',
    error: '',
    code: '',
  });
  assert.equal(catalog.legacyMcpConflicts[0]?.name, 'github');
  assert.equal(catalog.legacyMcpConflicts[0]?.source, 'plugin_account');
  assert.equal(catalog.available[0]?.displayName, 'Demo Plugin');
  assert.equal(catalog.available[0]?.displayNameZhCn, '演示插件');
  assert.equal(catalog.available[0]?.descriptionEn, 'Fixture capability');
  assert.equal(catalog.available[0]?.descriptionZhCn, '测试扩展能力');
  assert.equal(catalog.installed.length, 0);
  assert.ok(catalog.marketplaces.some((item) => item.name === 'openai-api-curated'));
  const linkedOfficialRoot = path.join(nativePluginAccountHome(root, userId), '.tmp', 'plugins');
  assert.equal(fs.lstatSync(linkedOfficialRoot).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(linkedOfficialRoot), fs.realpathSync(officialMarketRoot));
  assert.equal(
    fs.readFileSync(path.join(nativePluginAccountHome(root, userId), '.tmp', 'plugins.sha'), 'utf8').trim(),
    officialSha,
  );

  catalog = await service.install(userId, 'demo@test-market');
  assert.equal(catalog.installed[0]?.pluginId, 'demo@test-market');
  assert.deepEqual(nativePluginAccountState(root, userId).pluginIds, ['demo@test-market']);
  assert.equal(nativePluginAccountState(root, userId).marketplaces['test-market']?.source_type, 'local');
  assert.equal(fs.existsSync(path.join(nativePluginAccountHome(root, userId), 'auth.json')), true);

  const firstSessionHome = path.join(root, 'session-a');
  const secondSessionHome = path.join(root, 'session-b');
  await prepareCodexHome(root, firstSessionHome, { nativePluginUserId: userId });
  await prepareCodexHome(root, secondSessionHome, { nativePluginUserId: userId });
  assert.match(fs.readFileSync(path.join(firstSessionHome, 'config.toml'), 'utf8'), /plugins\."demo@test-market"/);
  assert.match(fs.readFileSync(path.join(firstSessionHome, 'config.toml'), 'utf8'), /marketplaces\."test-market"/);
  assert.equal(fs.lstatSync(path.join(firstSessionHome, 'plugins')).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(firstSessionHome, 'plugins')), fs.realpathSync(path.join(nativePluginAccountHome(root, userId), 'plugins')));
  assert.match(fs.readFileSync(path.join(secondSessionHome, 'config.toml'), 'utf8'), /plugins\."demo@test-market"/);

  const sharedConfigPath = path.join(root, 'config', 'codex', 'config.toml');
  fs.appendFileSync(sharedConfigPath, '\n[mcp_servers.github]\nurl = "https://api.githubcopilot.com/mcp/"\n');
  catalog = await service.list(userId);
  assert.ok(catalog.legacyMcpConflicts.some((conflict) => conflict.source === 'janus_config'));

  assert.deepEqual(nativePluginAccountState(root, 'another-user').pluginIds, []);
  await assert.rejects(service.addMarketplace(userId, { source: marketRoot }), (error) => error.code === 'codex_marketplace_confirmation_required');
  await assert.rejects(service.removeMarketplace(userId, 'test-market'), (error) => error.code === 'codex_marketplace_in_use');
  await assert.rejects(service.removeMarketplace(userId, 'openai-api-curated'), (error) => error.code === 'codex_official_marketplace_required');
  catalog = await service.addMarketplace(userId, { source: marketRoot, confirmed: true });
  assert.ok(catalog.marketplaces.some((item) => item.name === 'custom-market'));

  catalog = await service.remove(userId, 'demo@test-market');
  assert.equal(catalog.installed.length, 0);
  catalog = await service.removeMarketplace(userId, 'custom-market');
  assert.equal(catalog.marketplaces.some((item) => item.name === 'custom-market'), false);
  await prepareCodexHome(root, firstSessionHome, { nativePluginUserId: userId });
  assert.doesNotMatch(fs.readFileSync(path.join(firstSessionHome, 'config.toml'), 'utf8'), /demo@test-market/);

  const oldService = createNativePluginService({
    root,
    resolveBinary: async () => process.execPath,
    binaryArgs: [oldFakeCli],
    envForHome: (_root, home) => ({ ...process.env, ...(home ? { CODEX_HOME: home } : {}) }),
  });
  const oldCatalog = await oldService.list(userId);
  assert.equal(oldCatalog.capability.supported, false);
  assert.equal(oldCatalog.capability.version, '0.129.0');
  assert.equal(oldCatalog.capability.minimumVersion, '0.144.3');
  assert.equal(oldCatalog.capability.code, 'codex_plugin_runtime_upgrade_required');
  assert.match(oldCatalog.capability.error, /升级或重新安装 Janus/);
  await assert.rejects(
    oldService.install(userId, 'demo@test-market'),
    (error) => error.code === 'codex_plugin_runtime_upgrade_required',
  );

  console.log('native Codex plugin smoke passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
