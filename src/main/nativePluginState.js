import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseSimpleToml } from './codexConfig.js';
import { dataDir } from './paths.js';
import { ensureDir } from './utils.js';

export function nativePluginAccountHome(root, userId = '') {
  const owner = String(userId || '').trim();
  if (!owner) return '';
  const digest = crypto.createHash('sha256').update(owner, 'utf8').digest('hex').slice(0, 32);
  return path.join(dataDir(root), 'codex_plugin_accounts', digest);
}

export function nativePluginAccountState(root, userId = '') {
  const home = nativePluginAccountHome(root, userId);
  if (!home) return { home: '', pluginIds: [], marketplaces: {} };
  let config = {};
  try {
    config = parseSimpleToml(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const pluginIds = Object.entries(config.plugins || {})
    .filter(([pluginId, value]) => pluginId && value?.enabled === true)
    .map(([pluginId]) => pluginId)
    .sort((left, right) => left.localeCompare(right));
  return { home, pluginIds, marketplaces: config.marketplaces && typeof config.marketplaces === 'object' ? config.marketplaces : {} };
}

export function nativePluginConfigOverlay(pluginIds = [], marketplaces = {}) {
  const unique = [...new Set((pluginIds || []).map((item) => String(item || '').trim()).filter(Boolean))].sort();
  const marketplaceTables = Object.entries(marketplaces || {})
    .filter(([name, value]) => name && value && typeof value === 'object' && !Array.isArray(value))
    .map(([name, value]) => {
      const fields = Object.entries(value)
        .filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item)
          || (Array.isArray(item) && item.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry))))
        .map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`);
      return fields.length ? `[marketplaces.${JSON.stringify(name)}]\n${fields.join('\n')}\n` : '';
    })
    .filter(Boolean);
  if (!unique.length && !marketplaceTables.length) return '';
  return `\n${[
    ...marketplaceTables,
    ...unique.map((pluginId) => `[plugins.${JSON.stringify(pluginId)}]\nenabled = true\n`),
  ].join('\n')}`;
}

function tomlKey(value = '') {
  const key = String(value || '');
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  throw new TypeError('Unsupported Codex marketplace config value.');
}

export async function linkNativePluginCache(codexHome, accountHome) {
  if (!codexHome || !accountHome) return;
  const sharedPlugins = path.join(accountHome, 'plugins');
  const sessionPlugins = path.join(codexHome, 'plugins');
  await ensureDir(sharedPlugins);
  try {
    const stat = await fs.promises.lstat(sessionPlugins);
    if (stat.isSymbolicLink()) {
      const current = await fs.promises.realpath(sessionPlugins).catch(() => '');
      const expected = await fs.promises.realpath(sharedPlugins).catch(() => sharedPlugins);
      if (current === expected) return;
    }
    await fs.promises.rm(sessionPlugins, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.promises.symlink(sharedPlugins, sessionPlugins, process.platform === 'win32' ? 'junction' : 'dir');
}
