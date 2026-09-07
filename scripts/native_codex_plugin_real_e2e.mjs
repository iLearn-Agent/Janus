import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundledCodexBinary } from '../src/main/codex.js';
import { createNativePluginService } from '../src/main/nativePluginService.js';
import { nativePluginAccountHome } from '../src/main/nativePluginState.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-native-plugin-real-'));
const snapshotRoot = path.join(root, 'shared-codex-home', '.tmp', 'plugins');
const pluginRoot = path.join(snapshotRoot, 'plugins', 'zotero');
const marketplaceRoot = path.join(snapshotRoot, '.agents', 'plugins');
const userId = 'real-codex-plugin-user';
const sha = '0123456789abcdef0123456789abcdef01234567';

try {
  const codexBinary = bundledCodexBinary();
  assert.ok(codexBinary && fs.existsSync(codexBinary), 'bundled Codex binary is required');

  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'skills', 'zotero'), { recursive: true });
  fs.mkdirSync(marketplaceRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'zotero',
    version: '0.1.2',
    description: 'Zotero literature tools',
    interface: {
      displayName: 'Zotero',
      shortDescription: 'Find papers and add citations from Zotero',
      developerName: 'OpenAI',
      category: 'Education & Research',
    },
  }));
  fs.writeFileSync(path.join(pluginRoot, 'skills', 'zotero', 'SKILL.md'), [
    '---',
    'name: zotero',
    'description: Search and cite a local Zotero library.',
    '---',
    '',
    '# Zotero',
    '',
    'Use the local Zotero API for literature tasks.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(marketplaceRoot, 'marketplace.json'), JSON.stringify({
    name: 'openai-curated',
    interface: { displayName: 'Codex official' },
    plugins: [{
      name: 'zotero',
      source: { source: 'local', path: './plugins/zotero' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      category: 'Education & Research',
    }],
  }));
  fs.writeFileSync(path.join(path.dirname(snapshotRoot), 'plugins.sha'), `${sha}\n`);

  const service = createNativePluginService({
    root,
    resolveBinary: async () => codexBinary,
    officialMarketplaceRoots: [snapshotRoot],
  });

  let catalog = await service.list(userId);
  const available = catalog.available.find((item) => item.name === 'zotero');
  assert.equal(available?.pluginId, 'zotero@openai-curated');
  assert.equal(available?.installed, false);
  assert.equal(
    fs.readFileSync(path.join(nativePluginAccountHome(root, userId), '.tmp', 'plugins.sha'), 'utf8').trim(),
    sha,
  );

  catalog = await service.install(userId, available.pluginId);
  const installed = catalog.installed.find((item) => item.pluginId === available.pluginId);
  assert.equal(installed?.installed, true);
  assert.equal(installed?.enabled, true);
  assert.ok(fs.existsSync(path.join(
    nativePluginAccountHome(root, userId),
    'plugins', 'cache', 'openai-curated', 'zotero', sha.slice(0, 8),
  )));

  catalog = await service.remove(userId, available.pluginId);
  assert.equal(catalog.installed.some((item) => item.pluginId === available.pluginId), false);
  console.log('native Codex plugin real E2E passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
